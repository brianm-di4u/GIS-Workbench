#!/usr/bin/env node
// Sidecar bundle composition (S-43, REQ-SDC-11, REQ-SDC-12).
//
//   node sidecar/installer/compose.mjs --out D:/gwb-sidecar-deps/bundle [--check]
//
// Builds the relocatable module folders from the tool trees on D: (never from git):
//   core-gdal  conda-forge libgdal-core + non-GPL plugins (D:/gwb-sidecar-deps/conda-gdal)
//   points     PDAL from the same conda env (shares core-gdal's DLLs through PATH)
//   media      FFmpeg, LGPL only, built from the ffmpeg.org source by build-ffmpeg.sh (D:/gwb-sidecar-deps/ffmpeg-26)
//   sar        python-build-standalone + numpy, for the 3D model export (D:/gwb-sidecar-deps/python)
//   proj-grids the full proj-data set, data only (D:/gwb-sidecar-deps/proj-data-26)
//   model3d    Assimp and the parser and Python layer of IfcOpenShell (2.6: assimp-26, ifc-subset-26;
//              on Linux ifc-subset-g217, built from source by build-ifcopenshell.sh)
//   sfm        COLMAP built by sfm/build-colmap.sh, statically, and gwb-sfm (2.6: colmap-26/stage)
// 2.6 adds to core-gdal without touching those trees: an overlay prefix with the FITS, KEA and
// PostGIS raster plug-ins (conda-gdal-26, the same builds as conda-gdal) and the PDFium plug-in
// built by pdf-plugin/ (gdal-pdf-26). fits-plugin/ (gdal-fits-26) replaces the overlay's FITS plug-in.
// For each module it walks the PE import closure of the module's tools (and plugins) so only DLLs
// that are actually loaded are copied, maps every DLL to the package it came from and that
// package's licence, and FAILS when a component is GPL/AGPL, LGPL without a source-offer entry,
// or not listed in licences.json (the build fails on an unlisted component). It writes
// <out>/<module>/MANIFEST.json, the CycloneDX SBOM (<out>/sbom.cdx.json) and NOTICES.txt.
//
// Linux (P16, `--platform linux`, run in Linux): the same modules from Linux trees under
// GWB_SIDECAR_DEPS (conda-forge prefix, build-ffmpeg.sh, python-build-standalone), laid
// out as the sidecar expects there (bin/, lib/, lib/gdalplugins; python/bin/python3). The closure
// follows ELF DT_NEEDED (elf.mjs) instead of PE imports; glibc is never shipped.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, rmSync, cpSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { peImports, isSystemDll } from './pe.mjs';
import { elfNeeded, isSystemSo } from './elf.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPS = process.env.GWB_SIDECAR_DEPS ?? 'D:/gwb-sidecar-deps';
let PLATFORM = process.env.GWB_SIDECAR_PLATFORM ?? (process.platform === 'win32' ? 'windows' : 'linux');
const linux = () => PLATFORM === 'linux';
// The Python tree on D: holds more than the module needs. An allow-list, so a new package stays out
// until it is reviewed: mesh_export.py imports IfcOpenShell, and IfcOpenShell imports numpy.
const PY_SITE = /^(?:Lib|lib\/python3\.\d+)\/site-packages\/([^/]+)/;
const PY_KEEP = /^numpy(\.libs|-[^/]+\.dist-info)?$/;
const pythonKept = (rel) => {
  const m = PY_SITE.exec(rel);
  return (m ? PY_KEEP.test(m[1]) : true) && !/^Scripts\//.test(rel) && !/^bin\/(?!python)/.test(rel);
};

/** Licence policy (REQ-SDC-12): allowed SPDX ids, LGPL needs a source offer, GPL/AGPL fail. */
let ALLOWED = null;
export function setAllowed(list) {
  ALLOWED = list ? new Set(list) : null;
}
export function classifyLicence(spdx) {
  const s = String(spdx ?? '').trim();
  if (!s || s === '?') return { ok: false, why: 'no licence recorded' };
  // "A OR B": acceptable if any alternative is acceptable (we elect that one).
  const alts = s.split(/\s+OR\s+/i).map((x) => x.replace(/^\(|\)$/g, '').trim());
  const results = alts.map((a) => classifyAll(a));
  const good = results.find((r) => r.ok);
  return good ?? results[0];
}
function classifyAll(expr) {
  const parts = expr.split(/\s+AND\s+/i).map((x) => x.replace(/^\(|\)$/g, '').trim());
  let lgpl = false;
  for (const p of parts) {
    if (/\bWITH\s+(GCC-exception|LLVM-exception|Classpath-exception)/i.test(p)) continue; // runtime exceptions
    if (/AGPL/i.test(p)) return { ok: false, why: `AGPL (${p})` };
    if (/^(L?GPL)/i.test(p) && !/^LGPL/i.test(p)) return { ok: false, why: `GPL (${p})` };
    if (/^GPL/i.test(p)) return { ok: false, why: `GPL (${p})` };
    if (/^LGPL/i.test(p)) lgpl = true;
    // Every term must be on the reviewed allow-list (licences.json "allowed"): unknown terms fail.
    const term = p.replace(/\s+WITH\s+.*$/i, '').replace(/[()]/g, '').trim();
    if (ALLOWED && !ALLOWED.has(term)) return { ok: false, why: `licence term "${term}" is not on the allow-list` };
  }
  return { ok: true, lgpl };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** conda env → Map(lower-case file path relative to prefix → {name, version, license, url}). */
function condaFiles(prefix, map = new Map()) {
  const meta = join(prefix, 'conda-meta');
  for (const f of readdirSync(meta).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(readFileSync(join(meta, f), 'utf8'));
    const pkg = { name: j.name, version: j.version, license: j.license ?? '?', url: j.url ?? '', channel: j.channel ?? '' };
    for (const p of j.files ?? []) map.set(p.replace(/\\/g, '/').toLowerCase(), pkg);
  }
  return map;
}

/** DLL (Windows) or shared-library (Linux) closure of `roots` resolved in `dirs` (search order). */
export function closure(roots, dirs, replace = {}) {
  const index = new Map();
  // Stand-ins (stubs/) take the place of a library of the same name (REQ-SDC-12).
  for (const [n, p] of Object.entries(replace)) index.set(n.toLowerCase(), p);
  for (const d of dirs) if (existsSync(d)) for (const f of readdirSync(d)) if (!index.has(f.toLowerCase())) index.set(f.toLowerCase(), join(d, f));
  const seen = new Map();
  const missing = [];
  const imports = (path) => {
    if (!linux()) return peImports(path);
    return { imports: elfNeeded(path).needed, delay: [] };
  };
  const system = (dk) => (linux() ? isSystemSo(dk, index.has(dk)) : isSystemDll(dk));
  const visit = (path, from, name = basename(path)) => {
    const k = name.toLowerCase();
    if (seen.has(k)) return;
    const im = imports(path);
    seen.set(k, { path, name, imports: im.imports, delay: im.delay, from });
    for (const d of [...im.imports, ...im.delay]) {
      const dk = d.toLowerCase();
      if (system(dk) || seen.has(dk)) continue;
      const p = index.get(dk);
      if (!p) {
        if (!im.delay.includes(d)) missing.push(`${d} (imported by ${basename(path)})`);
        continue;
      }
      visit(p, basename(path), d);
    }
  };
  for (const r of roots) visit(r, 'tool');
  return { files: [...seen.values()], missing };
}

const MODULES_WINDOWS = {
  'core-gdal': {
    title: 'Core GDAL',
    tree: 'conda',
    prefix: `${DEPS}/conda-gdal`,
    tools: ['gdal_translate', 'gdalinfo', 'ogrinfo', 'ogr2ogr', 'gdaladdo', 'gdalbuildvrt', 'gdalsrsinfo', 'gdalwarp', 'gdal'],
    bin: 'Library/bin',
    plugins: 'Library/lib/gdalplugins',
    overlay: { prefix: `${DEPS}/conda-gdal-26`, lib: 'Library/bin', plugins: 'Library/lib/gdalplugins' },
    extraPlugins: [`${DEPS}/gdal-pdf-26/gdal_PDF.dll`, `${DEPS}/gdal-fits-26/gdal_FITS.dll`],
    data: [['Library/share/gdal', 'share/gdal'], ['Library/share/proj', 'share/proj']],
    // conda-forge's spatialite.dll has librttopo (GPL) linked in statically.
    replace: { 'spatialite.dll': 'spatialite.dll' },
  },
  points: {
    title: 'Point cloud (PDAL)',
    tree: 'conda',
    prefix: `${DEPS}/conda-gdal`,
    tools: ['pdal'],
    bin: 'Library/bin',
    pdalPlugins: true,
    dependsOn: 'core-gdal',
    replace: { 'spatialite.dll': 'spatialite.dll' },
  },
  media: {
    title: 'Media (FFmpeg, LGPL)',
    tree: 'ffmpeg',
    prefix: `${DEPS}/ffmpeg-26`,
    tools: ['ffmpeg', 'ffprobe'],
    bin: 'bin',
    data: [['licenses', 'licenses']],
  },
  sar: {
    title: 'Python runtime',
    tree: 'python',
    prefix: `${DEPS}/python/python`,
  },
  'proj-grids': {
    title: 'PROJ grids (proj-data, full set)',
    tree: 'data',
    prefix: `${DEPS}/proj-data-26`,
    data: [['Library/share/proj', 'share/proj']],
  },
  model3d: {
    title: '3D model export (Assimp, IfcOpenShell)',
    tree: 'conda',
    prefix: `${DEPS}/assimp-26`,
    tools: [],
    bin: 'Library/bin',
    libs: ['assimp.dll'],
    // zlib and the C++ runtime it needs, which IfcOpenShell's libraries load too.
    overlay: { prefix: `${DEPS}/conda-gdal`, lib: 'Library/bin', plugins: 'Library/lib/no-plugins' },
    pythonTree: [`${DEPS}/ifc-subset-26/win`, 'python', 'ifcopenshell'],
  },
  // REQ-GAP-21: OSSIM, its CNES plug-in and the sampling tool (sidecar/ossim/build.mjs), their
  // libraries from the conda prefix they were built on.
  ossim: {
    title: 'Rigorous sensor models (OSSIM)',
    tree: 'conda',
    prefix: `${DEPS}/ossim-26`,
    tools: ['gwb-ossim-model'],
    bin: 'bin',
    overlay: { prefix: `${DEPS}/ossim-env-26`, lib: 'Library/bin', plugins: 'Library/lib/no-plugins' },
    extra: [{ from: `${DEPS}/ossim-26/plugins/ossim_cnes_plugin.dll`, to: 'plugins/ossim_cnes_plugin.dll', name: 'ossim-plugins (cnes)', version: 'OrchidIsland-2.11.1', license: 'LGPL-3.0-or-later' }],
  },
  sfm: {
    title: 'UAV structure from motion (COLMAP, gwb-sfm)',
    tree: 'sfm',
    prefix: `${DEPS}/colmap-26/stage`,
    tools: ['colmap', 'gwb-sfm'],
    conda: `${DEPS}/conda-gdal`,
    runtime: 'Library/bin',
  },
};

// The Linux trees (P16): conda prefix layout, build-ffmpeg.sh's bin/ + lib/, python-build-standalone.
// 2.6: conda-gdal-26 is a whole prefix here, solved afresh. The older tree mixes aws-c-s3 1.0 with
// a TileDB built for 1.1, which is why Sidecar 0.2.0 on Linux has no TileDB driver.
const CONDA_LINUX = existsSync(`${DEPS}/conda-gdal-26/bin/gdalinfo`) ? `${DEPS}/conda-gdal-26` : `${DEPS}/conda-gdal`;
const MODULES_LINUX = {
  'core-gdal': {
    title: 'Core GDAL',
    tree: 'conda',
    prefix: CONDA_LINUX,
    tools: ['gdal_translate', 'gdalinfo', 'ogrinfo', 'ogr2ogr', 'gdaladdo', 'gdalbuildvrt', 'gdalsrsinfo', 'gdalwarp', 'gdal'],
    bin: 'bin',
    lib: 'lib',
    plugins: 'lib/gdalplugins',
    // -rp: the same plug-ins with conda's build path taken out of their RUNPATH (docs/validation/2.6/glibc.md).
    extraPlugins: [`${DEPS}/gdal-pdf-26-rp/gdal_PDF.so`, `${DEPS}/gdal-fits-26-rp/gdal_FITS.so`],
    data: [['share/gdal', 'share/gdal'], ['share/proj', 'share/proj']],
    // libspatialite needs librttopo (GPL); libarchive needs liblzo2 (GPL) for lzop only.
    replace: { 'libspatialite.so.8': 'libspatialite.so', 'liblzo2.so.2': 'liblzo2.so' },
  },
  points: {
    title: 'Point cloud (PDAL)',
    tree: 'conda',
    prefix: CONDA_LINUX,
    tools: ['pdal'],
    bin: 'bin',
    lib: 'lib',
    pdalPlugins: true,
    dependsOn: 'core-gdal',
    replace: { 'libspatialite.so.8': 'libspatialite.so', 'liblzo2.so.2': 'liblzo2.so' },
  },
  media: {
    title: 'Media (FFmpeg, LGPL)',
    tree: 'ffmpeg',
    prefix: `${DEPS}/ffmpeg-26`,
    tools: ['ffmpeg', 'ffprobe'],
    bin: 'bin',
    lib: 'lib',
    data: [['licenses', 'licenses']],
    staticParts: 'mediaStatic',
    // REQ-GAP-51: needs libopenh264.so.8 at run time, which only Cisco's download supplies, so it
    // stays out of the closure walk (build-ffmpeg-h264.sh).
    extra: [{ from: `${DEPS}/ffmpeg-h264-26/bin/ffmpeg-h264`, to: 'bin/ffmpeg-h264', name: 'ffmpeg', version: '8.1.3 (ffmpeg-h264: decode MPEG-2, encode through OpenH264)', license: 'LGPL-2.1-or-later' }],
  },
  sar: {
    title: 'Python runtime',
    tree: 'python',
    prefix: `${DEPS}/python`,
    // Parts of the standard library no profile uses (tests, IDLE, Tk).
    skip: [/^lib\/python3\.\d+\/(test|idlelib|tkinter|turtledemo|ensurepip)\//, /^lib\/(tcl|tk|itcl|thread)[\d.]*\//, /^lib\/libtcl|^lib\/libtk/, /^share\//, /^include\//],
  },
  'proj-grids': {
    title: 'PROJ grids (proj-data, full set)',
    tree: 'data',
    prefix: `${DEPS}/proj-data-26`,
    data: [['share/proj', 'share/proj']],
  },
  model3d: {
    title: '3D model export (Assimp, IfcOpenShell)',
    tree: 'conda',
    prefix: `${DEPS}/assimp-26`,
    tools: [],
    bin: 'bin',
    lib: 'lib',
    libs: ['libassimp.so.6'],
    // Built from source with no geometry kernel, on a 2.17 sysroot (build-ifcopenshell.sh).
    pythonTree: [`${DEPS}/ifc-subset-g217/linux`, 'python', 'ifcopenshell-linux'],
  },
  ossim: {
    title: 'Rigorous sensor models (OSSIM)',
    tree: 'conda',
    // On a 2.17 sysroot (sidecar/ossim/build.mjs).
    prefix: `${DEPS}/ossim-g217`,
    tools: ['gwb-ossim-model'],
    bin: 'bin',
    lib: 'lib64',
    overlay: { prefix: `${DEPS}/ossim-env-g217`, lib: 'lib', plugins: 'lib/no-plugins' },
    extra: [{ from: `${DEPS}/ossim-g217/lib/plugins/libossim_cnes_plugin.so`, to: 'lib/plugins/libossim_cnes_plugin.so', name: 'ossim-plugins (cnes)', version: 'OrchidIsland-2.11.1', license: 'LGPL-3.0-or-later' }],
  },
  sfm: {
    title: 'UAV structure from motion (COLMAP, gwb-sfm)',
    tree: 'sfm',
    prefix: `${DEPS}/colmap-26/stage`,
    tools: ['colmap', 'gwb-sfm'],
    conda: `${DEPS}/sfmbuild-env`,
    runtime: 'lib',
  },
};

export async function compose({ out, check = false, only = null, platform = null } = {}) {
  if (platform) PLATFORM = platform;
  const MODULES = linux() ? MODULES_LINUX : MODULES_WINDOWS;
  const licences = JSON.parse(readFileSync(join(HERE, 'licences.json'), 'utf8'));
  setAllowed(licences.allowed);
  const problems = [];
  const components = [];
  const report = {};
  mkdirSync(out, { recursive: true });
  for (const [id, m] of Object.entries(MODULES)) {
    if (only && !only.includes(id)) continue;
    if (!existsSync(m.prefix)) {
      report[id] = { skipped: `${m.prefix} not present` };
      continue;
    }
    const dest = join(out, id);
    if (!check) {
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
    }
    let files = [];
    let byFile = null;
    if (m.tree === 'conda') byFile = condaFiles(m.prefix);
    const overlay = m.overlay && existsSync(m.overlay.prefix) ? m.overlay : null;
    if (overlay) condaFiles(overlay.prefix, byFile);
    // Stand-ins come from the sidecar's own build (stubs/: gwb-nospatialite, gwb-nolzo).
    const wanted = Object.entries(m.replace ?? {}).map(([n, f]) => [n, join(stubsDir(), f)]);
    for (const [n, f] of wanted) if (!existsSync(f)) problems.push(`${id}: the stand-in for ${n} is not built (${f}): cargo build --release -p gwb-nospatialite -p gwb-nolzo --config 'profile.release.panic="abort"'`);
    const replace = Object.fromEntries(wanted.filter(([, f]) => existsSync(f)));
    const isStub = (path) => Object.values(replace).includes(path);
    const owner = (path) => (isStub(path) ? { ...licences.stubs, name: `gwb-sidecar-stub (${basename(path)})` } : ownerOf(path, m, byFile, licences, overlay));
    if (m.tree === 'data') {
      // Data only: no code, one reviewed licence entry (licences.json "projData"), each grid's own
      // terms in the READMEs that travel with it.
      const e = licences.projData;
      const c = classifyLicence(e?.license);
      if (!c.ok) problems.push(`${id}: ${c.why}`);
      const files_ = (m.data ?? []).flatMap(([from]) => walk(join(m.prefix, from)));
      const size = files_.reduce((a, p) => a + statSync(p).size, 0);
      const missingReadme = (m.data ?? []).some(([from]) => !existsSync(join(m.prefix, from, 'README.DATA')));
      if (missingReadme) problems.push(`${id}: the licence READMEs are missing`);
      components.push({ module: id, name: e.name, version: e.version, license: e.license, lgpl: false, files: [] });
      report[id] = { files: files_.length, size };
      if (!check) {
        for (const [from, to] of m.data ?? []) cpSync(join(m.prefix, from), join(dest, to), { recursive: true });
        writeFileSync(join(dest, 'proj-data-licences.json'), JSON.stringify(e, null, 2));
        writeFileSync(join(dest, 'MANIFEST.json'), JSON.stringify({ id, title: m.title, size, version: e.version, components: [e] }, null, 2));
      }
      continue;
    }
    if (m.tree === 'sfm') {
      // Static binaries: their components come from licences.json "sfm", and each binary is
      // searched for the code that must not be in it. The C++ runtime sits beside them on Windows.
      const pk = licences.sfm ?? [];
      if (!pk.length) problems.push(`${id}: licences.json has no "sfm" list`);
      for (const p of pk) {
        const c = classifyLicence(p.license);
        if (!c.ok) problems.push(`${id}: ${p.name} ${p.version}: ${c.why}`);
        if (c.lgpl) problems.push(`${id}: ${p.name} is LGPL, and this module links statically`);
        components.push({ module: id, name: p.name, version: p.version, license: p.license, lgpl: false, files: [] });
      }
      const exe = linux() ? '' : '.exe';
      const bins = m.tools.map((t) => join(m.prefix, 'bin', `${t}${exe}`));
      const copied = [];
      for (const b of bins) {
        if (!existsSync(b)) {
          problems.push(`${id}: ${b} is not built`);
          continue;
        }
        for (const hit of sfmBarred(b)) problems.push(`${id}: ${basename(b)} contains ${hit}`);
        copied.push([b, join('bin', basename(b))]);
      }
      const cl = closure(bins.filter(existsSync), [join(m.conda, m.runtime)]);
      if (cl.missing.length) problems.push(`${id}: unresolved imports: ${[...new Set(cl.missing)].join(', ')}`);
      const byFile = condaFiles(m.conda);
      for (const f of cl.files) {
        if (bins.includes(f.path)) continue;
        const own = ownerOf(f.path, { prefix: m.conda }, byFile, licences);
        const c = classifyLicence(own.license);
        if (!c.ok) problems.push(`${id}: ${basename(f.path)}: ${c.why}`);
        components.push({ module: id, name: own.name, version: own.version, license: own.license, lgpl: false, files: [] });
        copied.push([f.path, join(linux() ? 'lib' : 'bin', basename(f.path))]);
      }
      if (!check) {
        for (const [src, rel] of copied) {
          mkdirSync(dirname(join(dest, rel)), { recursive: true });
          copyFileSync(src, join(dest, rel));
        }
      }
      const size = copied.reduce((a, [src]) => a + statSync(src).size, 0);
      report[id] = { files: copied.length, size, packages: pk.map((p) => p.name) };
      if (!check) writeFileSync(join(dest, 'MANIFEST.json'), JSON.stringify({ id, title: m.title, size, components: pk }, null, 2));
      continue;
    }
    if (m.tree === 'python') {
      // The interpreter tree, with numpy alone from its packages, is the module; its licences come
      // from licences.json "python".
      files = walk(m.prefix)
        .map((p) => ({ path: p, rel: relative(m.prefix, p) }))
        .filter((f) => !(m.skip ?? []).some((re) => re.test(f.rel.replace(/\\/g, '/'))) && pythonKept(f.rel.replace(/\\/g, '/')));
      for (const f of files) {
        if (!check) {
          mkdirSync(dirname(join(dest, 'python', f.rel)), { recursive: true });
          copyFileSync(f.path, join(dest, 'python', f.rel));
        }
      }
      const pkgs = licences.python ?? [];
      for (const p of pkgs) {
        const c = classifyLicence(p.license);
        if (!c.ok) problems.push(`sar: ${p.name} ${p.version}: ${c.why}`);
        components.push({ module: id, name: p.name, version: p.version, license: p.license, lgpl: c.lgpl, files: [] });
      }
      // Linux wheels carry their own shared libraries in <package>.libs/ (auditwheel): each must
      // match a reviewed entry in licences.json "pythonLibs" (file-name prefix → licence).
      if (linux()) {
        const libs = files.filter((f) => /\.libs\/[^/]+$/.test(f.rel.replace(/\\/g, '/')));
        const seenLib = new Set();
        for (const f of libs) {
          const name = basename(f.rel);
          const e = (licences.pythonLibs ?? []).find((x) => name.startsWith(x.prefix));
          if (!e) {
            problems.push(`sar: ${f.rel} is a wheel-bundled library with no "pythonLibs" entry`);
            continue;
          }
          const c = classifyLicence(e.license);
          if (!c.ok) problems.push(`sar: ${name} (${e.name}): ${c.why}`);
          if (c.lgpl && !(licences.sourceOffer ?? []).includes(e.name)) problems.push(`sar: ${e.name} is LGPL and has no source-offer entry in licences.json`);
          if (seenLib.has(e.name)) continue;
          seenLib.add(e.name);
          components.push({ module: id, name: e.name, version: e.version, license: e.license, lgpl: c.lgpl, files: [{ path: `python/${f.rel.replace(/\\/g, '/')}`, sha256: sha256(f.path), size: statSync(f.path).size }] });
        }
      }
      const size = files.reduce((a, f) => a + statSync(f.path).size, 0);
      report[id] = { files: files.length, size };
      if (!check) {
        // The model export script travels with the interpreter.
        mkdirSync(join(dest, 'scripts'), { recursive: true });
        for (const f of readdirSync(join(HERE, '..', 'sar')).filter((x) => x.endsWith('.py'))) copyFileSync(join(HERE, '..', 'sar', f), join(dest, 'scripts', f));
        writeFileSync(join(dest, 'MANIFEST.json'), JSON.stringify({ id, title: m.title, size, components: pkgs }, null, 2));
      }
      continue;
    }
    const binDir = join(m.prefix, m.bin);
    // Windows keeps DLLs beside the programs; Linux trees keep them in lib/.
    const libDir = join(m.prefix, m.lib ?? m.bin);
    const exe = linux() ? '' : '.exe';
    const so = linux() ? '.so' : '.dll';
    const roots = [...m.tools.map((t) => join(binDir, `${t}${exe}`)).filter(existsSync), ...(m.libs ?? []).map((l) => join(libDir, l)).filter(existsSync)];
    for (const l of m.libs ?? []) if (!existsSync(join(libDir, l))) problems.push(`${id}: ${l} is not in ${libDir}`);
    if (m.tools.some((t) => !existsSync(join(binDir, `${t}${exe}`)))) problems.push(`${id}: missing tools in ${binDir}: ${m.tools.filter((t) => !existsSync(join(binDir, `${t}${exe}`))).join(', ')}`);
    const pluginDir = m.plugins ? join(m.prefix, m.plugins) : null;
    const pluginFiles = pluginDir && existsSync(pluginDir) ? readdirSync(pluginDir).filter((f) => f.endsWith(so)).map((f) => join(pluginDir, f)) : [];
    const libDirs = [libDir];
    if (overlay) {
      libDirs.push(join(overlay.prefix, overlay.lib));
      const dir = join(overlay.prefix, overlay.plugins);
      if (existsSync(dir)) pluginFiles.push(...readdirSync(dir).filter((f) => f.endsWith(so)).map((f) => join(dir, f)));
    }
    // An extra plug-in of the same name takes the place of the packaged one.
    for (const x of (m.extraPlugins ?? []).filter(existsSync)) {
      const same = pluginFiles.findIndex((f) => basename(f) === basename(x));
      if (same >= 0) pluginFiles.splice(same, 1);
      pluginFiles.push(x);
    }
    report[`${id}:plugins-offered`] = pluginFiles.map((p) => basename(p));
    // GDAL plugins whose licence fails (e.g. a GPL dependency) are dropped, not shipped.
    const keptPlugins = [];
    for (const p of pluginFiles) {
      const cl = closure([p], libDirs, replace);
      const bad = cl.files.map((f) => owner(f.path)).filter((o) => !classifyLicence(o.license).ok);
      // A plug-in whose libraries are missing from the tree (a broken solve) would not load either.
      for (const miss of cl.missing) bad.push({ name: `missing ${miss}`, license: 'unresolved' });
      if (bad.length) report[`${id}:dropped-plugins`] = [...(report[`${id}:dropped-plugins`] ?? []), `${basename(p)}: ${bad.map((b) => `${b.name} (${b.license})`).join(', ')}`];
      else keptPlugins.push(p);
    }
    let pdalPlugins = [];
    if (m.pdalPlugins) pdalPlugins = readdirSync(libDir).filter((f) => (linux() ? /^libpdal_plugin_.*\.so$/ : /^libpdal_plugin_.*\.dll$/i).test(f)).map((f) => join(libDir, f));
    const keptPdal = [];
    for (const p of pdalPlugins) {
      const cl = closure([p], [libDir], replace);
      const bad = cl.files.map((f) => owner(f.path)).filter((o) => !classifyLicence(o.license).ok);
      // A plug-in whose libraries are missing from the tree (a broken solve) would not load either.
      for (const miss of cl.missing) bad.push({ name: `missing ${miss}`, license: 'unresolved' });
      if (bad.length) report[`${id}:dropped-plugins`] = [...(report[`${id}:dropped-plugins`] ?? []), `${basename(p)}: ${bad.map((b) => `${b.name} (${b.license})`).join(', ')}`];
      else keptPdal.push(p);
    }
    const cl = closure([...roots, ...keptPlugins, ...keptPdal], libDirs, replace);
    if (cl.missing.length) problems.push(`${id}: unresolved imports: ${[...new Set(cl.missing)].join(', ')}`);
    // A module that depends on another (points → core-gdal) does not copy DLLs the other ships.
    const shared = m.dependsOn && report[m.dependsOn]?.dlls ? new Set(report[m.dependsOn].dlls) : new Set();
    const pkgs = new Map();
    const copied = [];
    for (const f of cl.files) {
      const name = f.name ?? basename(f.path);
      if (shared.has(name.toLowerCase())) continue;
      const own = isStub(f.path) ? { ...licences.stubs, name: `gwb-sidecar-stub (${name})` } : owner(f.path);
      const c = classifyLicence(own.license);
      if (!c.ok) problems.push(`${id}: ${name} from ${own.name} ${own.version}: ${c.why} (needed by ${f.from})`);
      if (own.unlisted) problems.push(`${id}: ${name} is not from a listed package`);
      if (c.lgpl && !(licences.sourceOffer ?? []).includes(own.name)) problems.push(`${id}: ${own.name} is LGPL and has no source-offer entry in licences.json`);
      const key = `${own.name}@${own.version}`;
      if (!pkgs.has(key)) pkgs.set(key, { ...own, lgpl: !!c.lgpl, files: [] });
      const isPlugin = keptPlugins.includes(f.path);
      const isTool = roots.includes(f.path) && !(m.libs ?? []).includes(basename(f.path));
      const rel = linux() ? (isPlugin ? join('lib', 'gdalplugins', name) : isTool ? join('bin', name) : join('lib', name)) : isPlugin ? join('gdalplugins', name) : join('bin', name);
      pkgs.get(key).files.push({ path: rel.replace(/\\/g, '/'), sha256: sha256(f.path), size: statSync(f.path).size });
      copied.push([f.path, rel]);
    }
    if (!check) {
      for (const [src, rel] of copied) {
        mkdirSync(dirname(join(dest, rel)), { recursive: true });
        copyFileSync(src, join(dest, rel));
      }
      for (const [from, to] of m.data ?? []) cpSync(join(m.prefix, from), join(dest, to), { recursive: true });
    }
    for (const x of m.extra ?? []) {
      if (!existsSync(x.from)) {
        problems.push(`${id}: ${x.from} is not built`);
        continue;
      }
      if (!check) {
        mkdirSync(dirname(join(dest, x.to)), { recursive: true });
        copyFileSync(x.from, join(dest, x.to));
      }
      components.push({ module: id, name: x.name, version: x.version, license: x.license, lgpl: true, files: [{ path: x.to, sha256: sha256(x.from), size: statSync(x.from).size }] });
    }
    for (const p of pkgs.values()) components.push({ module: id, ...p });
    // Permissive code linked inside a library has no file of its own, but its licence still applies.
    for (const p of licences[m.staticParts] ?? []) {
      const c = classifyLicence(p.license);
      if (!c.ok || c.lgpl) problems.push(`${id}: ${p.name} is linked in statically and is ${p.license}`);
      components.push({ module: id, name: p.name, version: p.version, license: p.license, lgpl: false, url: p.url, files: [] });
    }
    // GPL code can hide inside a shipped library when its conda dependency was linked statically
    // (conda-forge's Windows spatialite.dll holds librttopo): for every shipped package with a
    // GPL dependency, look for that dependency's own strings in the files shipped.
    if (byFile) {
      for (const hit of staticGpl(m.prefix, [...pkgs.values()].filter((p) => !p.name.startsWith('gwb-sidecar-stub')), copied, overlay?.prefix)) problems.push(`${id}: ${hit}`);
    }
    let dataSize = (m.data ?? []).reduce((a, [from]) => a + dirSize(join(m.prefix, from)), 0);
    if (m.pythonTree) {
      // A reviewed subset of a wheel (build by subset-ifcopenshell.mjs), its licences from
      // licences.json "model3d"; the files beside it are checked against that entry's list.
      const [src, to, entry] = m.pythonTree;
      if (!existsSync(src)) problems.push(`${id}: ${src} is not present`);
      else {
        const pk = licences.model3d?.[entry] ?? [];
        if (!pk.length) problems.push(`${id}: licences.json has no "model3d" entry for ${entry}`);
        for (const p of pk) {
          const c = classifyLicence(p.license);
          if (!c.ok) problems.push(`${id}: ${p.name} ${p.version}: ${c.why}`);
          if (c.lgpl && !(licences.sourceOffer ?? []).includes(p.name)) problems.push(`${id}: ${p.name} is LGPL and has no source-offer entry in licences.json`);
          components.push({ module: id, name: p.name, version: p.version, license: p.license, lgpl: c.lgpl, files: [] });
        }
        const barred = walk(src).filter((p) => /cgal|gmp|mpfr|wgpu/i.test(relative(src, p)));
        for (const b of barred) problems.push(`${id}: ${relative(src, b)} must not be in the IfcOpenShell subset`);
        dataSize += dirSize(src);
        if (!check) cpSync(src, join(dest, to), { recursive: true });
      }
    }
    const size = copied.reduce((a, [src]) => a + statSync(src).size, 0) + dataSize;
    report[id] = { dlls: cl.files.map((f) => basename(f.path).toLowerCase()), files: copied.length, size, packages: [...pkgs.keys()] };
    if (!check) writeFileSync(join(dest, 'MANIFEST.json'), JSON.stringify({ id, title: m.title, size, packages: [...pkgs.values()] }, null, 2));
  }
  const sbom = cyclonedx(components);
  if (!check) {
    writeFileSync(join(out, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2));
    writeFileSync(join(out, 'NOTICES.txt'), notices(components, licences));
    writeFileSync(join(out, 'compose-report.json'), JSON.stringify({ problems, report }, null, 2));
  }
  return { problems, report, components };
}

/**
 * What must not be inside the sfm module's binaries (REQ-SEC-08). They are linked statically, so the
 * DLL closure sees nothing: the list of components is licences.json "sfm", and this proves the
 * excluded code is absent. Each pattern is a string that code leaves in a binary.
 */
export const SFM_BARRED = [
  // Class names from its code: COLMAP's own messages mention "SiftGPU" and "CGAL" in any build.
  ['SiftGPU (non-commercial)', /SiftMatchGPU|PyramidGL|PyramidCU|SiftPyramid|ProgramGLSL/],
  ['LSD (AGPL-3.0)', /LineSegmentDetection|line_segment_detection|ll_angle|nfa_image/],
  ['CHOLMOD (GPL modules)', /cholmod_|CHOLMOD/],
  ['CGAL (GPL-3.0)', /CGAL::|CGAL ERROR|CGAL error/],
  ['CUDA runtime (NVIDIA)', /cudaRegisterFatBinary|cudart|cudaGetDevice/],
  ['Qt (LGPL, not needed)', /QApplication|QCoreApplication/],
  ['libcurl (no network code)', /libcurl\/|curl_easy_/],
  ['Fortran runtime', /libgfortran|_gfortran_/],
];

/** Which SFM_BARRED entries a binary holds. */
export function sfmBarred(path) {
  const text = readFileSync(path).toString('latin1');
  return SFM_BARRED.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** Where the stand-ins were built (read when composing, so a packager may set it first). */
const stubsDir = () => process.env.GWB_SIDECAR_STUBS ?? join(process.platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'qlab', 'ct21-sidecar') : `${process.env.HOME}/gwb/target`, 'release');

/** Long printable strings (as `strings -n`), deduplicated. */
function strings(buf, min = 24) {
  const out = new Set();
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const c = i < buf.length ? buf[i] : 0;
    if (c >= 0x20 && c < 0x7f) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && i - start >= min) out.add(buf.toString('latin1', start, i));
      start = -1;
    }
  }
  return out;
}

/** Shipped packages whose files contain a GPL dependency's code (by its distinctive strings). */
function staticGpl(prefix, shipped, copied, overlay = null) {
  const pk = new Map();
  for (const pre of [prefix, overlay].filter(Boolean)) {
    const meta = join(pre, 'conda-meta');
    for (const f of readdirSync(meta).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(readFileSync(join(meta, f), 'utf8'));
      pk.set(j.name, j);
    }
  }
  const hits = [];
  const shippedNames = new Set(shipped.map((p) => p.name));
  // Toolchain boilerplate (C runtime imports, manifests, the DOS stub) is in nearly every binary:
  // a string found in three or more shipped files is not evidence of anything.
  const byFile = new Map(copied.map(([src]) => [src, strings(readFileSync(src))]));
  const freq = new Map();
  for (const set of byFile.values()) for (const x of set) freq.set(x, (freq.get(x) ?? 0) + 1);
  for (const p of shipped) {
    const j = pk.get(p.name);
    for (const dep of (j?.depends ?? []).map((d) => d.split(/[\s=<>!]/)[0])) {
      const d = pk.get(dep);
      if (!d || shippedNames.has(dep) || classifyLicence(d.license).ok) continue;
      const libs = (d.files ?? []).filter((f) => /\.(dll|so[.\d]*|dylib)$/i.test(f) && existsSync(join(prefix, f)));
      if (!libs.length) continue;
      const theirs = new Set();
      for (const l of libs) for (const s of strings(readFileSync(join(prefix, l)))) theirs.add(s);
      // Strings every toolchain emits are not evidence.
      const sample = [...theirs].filter((s) => (freq.get(s) ?? 0) < 3).slice(0, 400);
      if (sample.length < 10) continue;
      const files = copied.filter(([src]) => p.files.some((f) => basename(f.path) === basename(src))).map(([src]) => src);
      let found = 0;
      for (const f of files) {
        const mine = byFile.get(f) ?? strings(readFileSync(f));
        found = Math.max(found, sample.filter((s) => mine.has(s)).length);
      }
      if (found >= Math.max(5, sample.length * 0.1)) hits.push(`${p.name} ${p.version} contains ${dep} (${d.license}) code: ${found} of ${sample.length} of its strings are in the shipped files (statically linked)`);
    }
  }
  return hits;
}

function ownerOf(path, m, byFile, licences, overlay = null) {
  const base = overlay && !relative(overlay.prefix, path).startsWith('..') ? overlay.prefix : m.prefix;
  const rel = relative(base, path).replace(/\\/g, '/').toLowerCase();
  const own = byFile?.get(rel);
  if (own) return own;
  const extra = (licences.files ?? {})[basename(path).toLowerCase()];
  if (extra) return extra;
  return { name: basename(path), version: '?', license: '?', unlisted: true };
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
function dirSize(d) {
  return existsSync(d) ? walk(d).reduce((a, p) => a + statSync(p).size, 0) : 0;
}

function cyclonedx(components) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: { component: { type: 'application', name: 'gwb-sidecar', version: '0.1.0' } },
    components: components.map((c) => ({
      type: 'library',
      name: c.name,
      version: String(c.version),
      licenses: [{ expression: c.license }],
      properties: [{ name: 'gwb:module', value: c.module }, ...(c.lgpl ? [{ name: 'gwb:lgpl-dynamic', value: 'true' }] : [])],
      hashes: (c.files ?? []).slice(0, 1).map((f) => ({ alg: 'SHA-256', content: f.sha256 })),
      purl: !c.url ? undefined : c.url.includes('conda') ? `pkg:conda/${encodeURIComponent(c.name)}@${c.version}` : `pkg:generic/${encodeURIComponent(c.name)}@${c.version}?download_url=${encodeURIComponent(c.url)}`,
    })),
  };
}

function notices(components, licences) {
  const vendor = linux() ? ['The MrSID and ECW plug-ins are not part of this package: they are Windows only (OSGeo4W).'] : ['The MrSID and ECW plug-ins are not part of this package: the installer downloads them from', 'OSGeo4W only after you accept their licences.'];
  const lines = ['GIS Workbench sidecar: third-party components', '', 'Every component below is redistributed under its own licence. LGPL components are separate', 'dynamically linked libraries; their source is available as described in SOURCE-OFFER.txt.', ...vendor, ''];
  const seen = new Set();
  for (const c of components) {
    const k = `${c.module}|${c.name}|${c.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`[${c.module}] ${c.name} ${c.version} — ${c.license}${c.lgpl ? ' (LGPL, dynamically linked; source offer)' : ''}`);
  }
  lines.push('', ...(licences.noticeText ?? []));
  return lines.join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = i >= 0 ? args[i + 1] : `${DEPS}/bundle/modules`;
  const j = args.indexOf('--only');
  const only = j >= 0 ? args[j + 1].split(',') : null;
  const k = args.indexOf('--platform');
  const platform = k >= 0 ? args[k + 1] : null;
  compose({ out, check: args.includes('--check'), only, platform }).then(({ problems, report }) => {
    for (const [k, v] of Object.entries(report)) console.log(k, typeof v === 'object' && v.size ? `${(v.size / 1e6).toFixed(1)} MB, ${v.files} files` : JSON.stringify(v));
    if (problems.length) {
      console.error(`\n${problems.length} licence/composition problem(s):\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
  });
}
