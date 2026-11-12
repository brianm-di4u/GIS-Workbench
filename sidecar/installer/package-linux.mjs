#!/usr/bin/env node
// Sidecar release packaging for Linux x86-64 (P16, REQ-SDC-16), run in Linux (or WSL).
//
//   node sidecar/installer/package-linux.mjs [--version 0.3.0] [--dist dist] [--out ~/gwb/release]
//                                            [--target ~/gwb/target] [--appimagetool PATH]
//
// The same gates as package.mjs (Windows): the composed modules pass compose.mjs's licence gate
// (with the library stand-ins of stubs/), every Rust crate of the service has an allow-listed
// licence, and no vendor SDK file is shipped (the MrSID and ECW plug-ins are Windows only).
// Artefacts, all with every module:
//   GWB-Sidecar-<v>-amd64.deb               /opt/gis-workbench-sidecar, menu entry, user service
//   GWB-Sidecar-<v>-x86_64.AppImage         one file, runs from anywhere (needs FUSE, or
//                                           --appimage-extract-and-run)
//   GWB-Sidecar-<v>-linux-x86_64.tar.gz     unpack anywhere and run ./gwb-sidecar
// plus SHA256SUMS, sbom.cdx.json and package-report.json. Builds are unsigned previews.
import { execFileSync } from 'node:child_process';
import { GLIBC_FLOOR, csmHostProblems, elfGlibcNeeds, glibcFloorProblems, mediaLibraryPathProblems, mediaNeedsProblems, mediaOpenH264Problems, runtimeProblems, stageGlibc, stagePathProblems } from './gates.mjs';
import { elfNeeded, elfVersions } from './elf.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, classifyLicence, setAllowed } from './compose.mjs';
import { makeWheel } from '../python/make-wheel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const HOME = process.env.HOME ?? '/tmp';
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const MANIFEST = join(ROOT, 'sidecar', 'Cargo.toml');
const VERSION = arg('--version', JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', MANIFEST], { encoding: 'utf8' })).packages.find((p) => p.name === 'gwb-sidecar').version);
const DIST = resolve(ROOT, arg('--dist', 'dist'));
const OUT = resolve(arg('--out', join(HOME, 'gwb', 'release')), VERSION);
const TARGET = arg('--target', join(HOME, 'gwb', 'target'));
const BIN = join(TARGET, 'x86_64-unknown-linux-musl', 'release');
const APPIMAGETOOL = arg('--appimagetool', join(HOME, 'gwb', 'bin', 'appimagetool-x86_64.AppImage'));
const PKG = 'gis-workbench-sidecar';
// Cisco's binary counts under its patent licence only if it is not shipped with a package (REQ-GAP-51).
const VENDOR_FILES = /^(gdal_MrSID|gdal_ECW_JP2ECW|libltidsdk|liblti_|libNCSEcw|libopenh264)/i;

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const size = (d) => (existsSync(d) ? walk(d).reduce((a, f) => a + statSync(f).size, 0) : 0);
const licences = JSON.parse(readFileSync(join(HERE, 'licences.json'), 'utf8'));
setAllowed(licences.allowed);

function rustCrates() {
  const m = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', 'x86_64-unknown-linux-musl', '--manifest-path', MANIFEST], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  const byId = new Map(m.packages.map((p) => [p.id, p]));
  const nodes = new Map(m.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = ['gwb-sidecar', 'gwb-sfm', 'gwb-nospatialite', 'gwb-nolzo'].map((n) => m.packages.find((p) => p.name === n).id);
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
  }
  return [...seen].map((id) => byId.get(id)).map((p) => ({ name: p.name, version: p.version, license: (p.license ?? '?').replace(/\//g, ' OR ') }));
}

/**
 * Owner-only write everywhere: 0755 for folders, ELF files and scripts, 0644 for the rest. Files
 * copied from a Windows drive (WSL /mnt/c) arrive as 0777, and a root-owned package must not
 * install anything others can change (the sidecar serves app/ to the browser).
 */
function normaliseModes(dir) {
  const visit = (d) => {
    chmodSync(d, 0o755);
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) visit(p);
      else {
        const b = Buffer.alloc(4);
        const fd = openSync(p, 'r');
        readSync(fd, b, 0, 4, 0);
        closeSync(fd);
        const exec = b.readUInt32BE(0) === 0x7f454c46 || (b[0] === 0x23 && b[1] === 0x21);
        chmodSync(p, exec ? 0o755 : 0o644);
      }
    }
  };
  visit(dir);
  const bad = walk(dir).filter((f) => !lstatSync(f).isSymbolicLink() && (statSync(f).mode & 0o022));
  if (bad.length) throw new Error(`group/world-writable files remain: ${bad.slice(0, 5).join(', ')}`);
}

import { relayGate } from './shipped-gate.mjs';

async function main() {
  const work = join(OUT, 'stage');
  const stage = join(work, PKG);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const problems = [];
  for (const exe of ['gwb-sidecar', 'gwb-sidecar-setup', 'gwb-run']) {
    copyFileSync(join(BIN, exe), join(stage, exe));
    chmodSync(join(stage, exe), 0o755);
  }
  problems.push(...relayGate(['gwb-sidecar', 'gwb-sidecar-setup', 'gwb-run'].map((e) => join(stage, e))));
  // Modules (licence gate inside; the stand-ins come from the gnu target's release folder).
  process.env.GWB_SIDECAR_STUBS ??= join(TARGET, 'release');
  const comp = await compose({ out: join(stage, 'modules'), platform: 'linux' });
  // The full grid set is about 800 MB of data few users need: a tar.gz of its own, in none of the
  // packages. It unpacks into the modules folder (or one named by modules_dir in config.toml).
  const extra = join(OUT, 'stage-extra');
  rmSync(extra, { recursive: true, force: true });
  mkdirSync(extra, { recursive: true });
  if (existsSync(join(stage, 'modules', 'proj-grids'))) renameSync(join(stage, 'modules', 'proj-grids'), join(extra, 'proj-grids'));
  // Structure from motion (REQ-GAP-29) is off the default install in the same way.
  if (existsSync(join(stage, 'modules', 'sfm'))) renameSync(join(stage, 'modules', 'sfm'), join(extra, 'sfm'));
  problems.push(...comp.problems);
  // OD-2.30: no OpenH264 in the Media module but Cisco's own, loaded at run time by ffmpeg-h264; and
  // the module keeps what profiles and tests use.
  const media = join(stage, 'modules', 'media');
  if (!existsSync(media)) problems.push(`media: not composed (${JSON.stringify(comp.report.media)})`);
  else {
    problems.push(...mediaOpenH264Problems(media, { needed: (f) => elfNeeded(f).needed }), ...mediaLibraryPathProblems(media, elfNeeded), ...mediaNeedsProblems(media, 'linux'));
    if (!existsSync(join(media, 'bin', 'ffmpeg-h264'))) problems.push('media: no bin/ffmpeg-h264 (REQ-GAP-51)');
  }
  // The released HTML for /app/ (REQ-SDC-15), with the release SHA256SUMS lines for those files.
  mkdirSync(join(stage, 'app'), { recursive: true });
  const names = ['gis-workbench.html', 'gis-workbench-lite.html', 'gis-workbench-airgap.html'];
  const sums = readFileSync(join(DIST, 'SHA256SUMS'), 'utf8').split(/\r?\n/).filter((l) => names.some((n) => l.trim().endsWith(` ${n}`) || l.trim().endsWith(`*${n}`)));
  for (const n of names) {
    copyFileSync(join(DIST, n), join(stage, 'app', n));
    const line = sums.find((l) => l.includes(n));
    if (!line || !line.startsWith(sha256(join(DIST, n)))) problems.push(`app/${n} does not match ${DIST}/SHA256SUMS`);
  }
  writeFileSync(join(stage, 'app', 'SHA256SUMS'), sums.join('\n') + '\n');
  // The Python client (REQ-GAP-02): the user installs the wheel into their own Python.
  makeWheel(join(stage, 'python'));
  const crates = rustCrates().filter((c) => !c.name.startsWith('gwb-'));
  for (const c of crates) {
    const k = classifyLicence(c.license);
    if (!k.ok) problems.push(`rust crate ${c.name} ${c.version}: ${k.why}`);
  }
  for (const f of walk(stage)) if (VENDOR_FILES.test(basename(f))) problems.push(`vendor file in the package: ${relative(stage, f)}`);
  // SBOM, NOTICES, source offer, licence, README (as package.mjs).
  const sbom = JSON.parse(readFileSync(join(stage, 'modules', 'sbom.cdx.json'), 'utf8'));
  sbom.metadata.component = { type: 'application', name: 'gwb-sidecar', version: VERSION, licenses: [{ expression: 'Apache-2.0' }], properties: [{ name: 'gwb:platform', value: 'linux-x86_64' }] };
  sbom.serialNumber = `urn:uuid:${randomUUID()}`;
  sbom.metadata.timestamp = new Date().toISOString();
  for (const c of crates) sbom.components.push({ type: 'library', name: c.name, version: c.version, purl: `pkg:cargo/${c.name}@${c.version}`, licenses: [{ expression: c.license }], properties: [{ name: 'gwb:module', value: 'service' }] });
  writeFileSync(join(stage, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2));
  const notices = readFileSync(join(stage, 'modules', 'NOTICES.txt'), 'utf8');
  for (const f of ['sbom.cdx.json', 'NOTICES.txt', 'compose-report.json']) rmSync(join(stage, 'modules', f), { force: true });
  // Cisco's condition 4: its licence text wherever licensing information is shown (REQ-GAP-51).
  writeFileSync(join(stage, 'NOTICES.txt'), `${notices}\n${crates.map((c) => `[service] ${c.name} ${c.version} — ${c.license}`).join('\n')}\n\n${readFileSync(join(HERE, 'linux', 'OPENH264-NOTICE.txt'), 'utf8')}`);
  const offer = [
    'Written offer for source code (LGPL-2.1/LGPL-3.0, MPL-1.1/MPL-2.0)',
    '',
    `For at least three years from the release of GIS Workbench Sidecar ${VERSION}, the GIS Workbench project`,
    'provides, on request through https://github.com/brianm-di4u/GIS-Workbench/issues, the complete',
    'corresponding source code of the components below, as built into this package. They are separate',
    'dynamically linked libraries; you may replace them with your own builds of the same versions.',
    '',
    ...comp.components.filter((c) => c.lgpl || (licences.sourceOffer ?? []).includes(c.name)).map((c) => `- ${c.name} ${c.version} (${c.license})${c.url ? ` — ${c.url}` : ''}`),
    '',
    'The upstream sources: conda-forge feedstocks (https://github.com/conda-forge/<name>-feedstock), the wheels on',
    'PyPI (their sdists), and FFmpeg 8.1.3 (https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz, unchanged, built by',
    'sidecar/installer/build-ffmpeg.sh and, for ffmpeg-h264, build-ffmpeg-h264.sh; the configure line of the libraries',
    'is in modules/media/licenses/BUILD.txt).',
    'OSSIM 2.12.1 (https://github.com/ossimlabs/ossim/archive/refs/tags/v2.12.1.tar.gz) and ossim-plugins OrchidIsland-2.11.1',
    '(https://github.com/ossimlabs/ossim-plugins/archive/refs/tags/OrchidIsland-2.11.1.tar.gz), with the edits in sidecar/ossim/build.mjs.',
    'IfcOpenShell 0.9.0post1 (https://github.com/IfcOpenShell/IfcOpenShell/archive/refs/tags/ifcopenshell-python-0.9.0post1.tar.gz,',
    'built by sidecar/installer/build-ifcopenshell.sh, which edits one line of its CMake install list and no code).',
    'Eigen 5.0.1, MPL-2.0 (https://gitlab.com/libeigen/eigen/-/tree/5.0.1), headers compiled into the sfm module and the IfcOpenShell libraries.',
  ].filter((l, i, a) => !(l.startsWith('- ') && a.indexOf(l) !== i));
  writeFileSync(join(stage, 'SOURCE-OFFER.txt'), offer.join('\n') + '\n');
  copyFileSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE.txt'));
  writeFileSync(
    join(stage, 'README.txt'),
    [
      `GIS Workbench Sidecar ${VERSION} for Linux x86-64 (preview, unsigned)`,
      '',
      'An optional local helper for GIS Workbench: it converts FileGDB, E57, MPEG-2 video and every other',
      'GDAL, OGR, PDAL or FFmpeg format into formats the app reads. It listens on 127.0.0.1 only and never connects out.',
      '',
      'Start ./gwb-sidecar (or "GIS Workbench Sidecar" in the menu); starting it again opens its window (pairing,',
      'modules, jobs, log) in your browser. As a user service: systemctl --user enable --now gwb-sidecar (.deb).',
      'MrSID and ECW: the vendor decode plug-ins exist for Windows only; convert those files with the Windows sidecar.',
      'MPEG-2 video becomes MPEG-1 in MPEG-TS with every KLV stream kept, or H.264 once the OpenH264 Video Codec provided by Cisco Systems, Inc. is downloaded (Add or remove modules).',
      'Tools run in their own process group with memory and CPU caps; with Landlock (Linux 5.13+) they write only in',
      'their job folder and (Linux 6.7+) open no TCP connection. Data: ~/.local/share/gis-workbench-sidecar.',
      '',
    ].join('\n'),
  );
  problems.push(...csmHostProblems(stage, join(stage, 'gwb-sidecar')));
  // A skipped module (its tree was not there) would pass everything below by not being looked at.
  for (const id of ['core-gdal', 'points', 'media', 'sar', 'model3d', 'ossim']) if (!existsSync(join(stage, 'modules', id))) problems.push(`${id}: not composed (${JSON.stringify(comp.report[id])})`);
  // The floor, on every ELF file of the stage. The .deb's dependency is what they really ask for.
  const needs = elfGlibcNeeds(stage, elfVersions);
  problems.push(...glibcFloorProblems(needs, GLIBC_FLOOR), ...runtimeProblems(needs), ...stagePathProblems(needs, elfNeeded));
  // The sfm module ships apart from the packages, so it is outside the stage but under the same floor.
  if (!existsSync(join(extra, 'sfm'))) problems.push(`sfm: not composed (${JSON.stringify(comp.report.sfm)})`);
  else {
    const extraNeeds = elfGlibcNeeds(extra, elfVersions);
    problems.push(...glibcFloorProblems(extraNeeds, GLIBC_FLOOR), ...runtimeProblems(extraNeeds), ...stagePathProblems(extraNeeds, elfNeeded));
  }
  if (problems.length) {
    console.error(`packaging gate failed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  normaliseModes(stage);
  const glibc = stageGlibc(needs);
  const sizes = Object.fromEntries(['core-gdal', 'points', 'media', 'sar', 'model3d', 'ossim'].map((m) => [m, size(join(stage, 'modules', m))]));
  sizes.service = size(stage) - Object.values(sizes).reduce((a, b) => a + b, 0);
  sizes['proj-grids (separate)'] = size(join(extra, 'proj-grids'));
  sizes['sfm (separate)'] = size(join(extra, 'sfm'));
  const art = [];

  // 0. The grids, alone.
  const grids = join(OUT, `gwb-sidecar-module-proj-grids-${VERSION}.tar.gz`);
  rmSync(grids, { force: true });
  execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', grids, '-C', extra, 'proj-grids']);
  art.push(grids);
  if (existsSync(join(extra, 'sfm'))) {
    const sfm = join(OUT, `gwb-sidecar-module-sfm-${VERSION}.tar.gz`);
    rmSync(sfm, { force: true });
    execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', sfm, '-C', extra, 'sfm']);
    art.push(sfm);
  }

  // 1. Portable tar.gz.
  const tgz = join(OUT, `GWB-Sidecar-${VERSION}-linux-x86_64.tar.gz`);
  rmSync(tgz, { force: true });
  execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', tgz, '-C', work, PKG]);
  art.push(tgz);

  // 2. .deb: /opt/gis-workbench-sidecar, /usr/bin links, menu entry, icon, user service.
  const deb = join(work, 'deb');
  const opt = join(deb, 'opt', PKG);
  mkdirSync(dirname(opt), { recursive: true });
  cpSync(stage, opt, { recursive: true });
  mkdirSync(join(deb, 'usr', 'bin'), { recursive: true });
  for (const exe of ['gwb-sidecar', 'gwb-sidecar-setup', 'gwb-run']) symlinkSync(`/opt/${PKG}/${exe}`, join(deb, 'usr', 'bin', exe));
  mkdirSync(join(deb, 'usr', 'share', 'applications'), { recursive: true });
  copyFileSync(join(HERE, 'linux', 'gwb-sidecar.desktop'), join(deb, 'usr', 'share', 'applications', 'gwb-sidecar.desktop'));
  mkdirSync(join(deb, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps'), { recursive: true });
  copyFileSync(join(HERE, 'linux', 'gwb-sidecar.svg'), join(deb, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps', 'gwb-sidecar.svg'));
  mkdirSync(join(deb, 'usr', 'lib', 'systemd', 'user'), { recursive: true });
  copyFileSync(join(HERE, 'linux', 'gwb-sidecar.service'), join(deb, 'usr', 'lib', 'systemd', 'user', 'gwb-sidecar.service'));
  mkdirSync(join(deb, 'usr', 'share', 'doc', PKG), { recursive: true });
  writeFileSync(join(deb, 'usr', 'share', 'doc', PKG, 'copyright'), `GIS Workbench Sidecar ${VERSION}: Apache-2.0 (/opt/${PKG}/LICENSE.txt).\nThird-party components: /opt/${PKG}/NOTICES.txt; source offer: /opt/${PKG}/SOURCE-OFFER.txt; SBOM: /opt/${PKG}/sbom.cdx.json.\n`);
  normaliseModes(deb);
  mkdirSync(join(deb, 'DEBIAN'), { recursive: true });
  const kib = Math.ceil(size(join(deb, 'opt')) / 1024);
  writeFileSync(
    join(deb, 'DEBIAN', 'control'),
    [
      `Package: ${PKG}`,
      `Version: ${VERSION}`,
      'Section: science',
      'Priority: optional',
      'Architecture: amd64',
      `Depends: libc6 (>= ${glibc}), libgcc-s1 | libgcc1`,
      'Recommends: curl, bzip2, libstdc++6, xdg-utils',
      'Suggests: zenity | kdialog, libnotify-bin',
      `Installed-Size: ${kib}`,
      'Maintainer: GIS Workbench <https://github.com/brianm-di4u/GIS-Workbench/issues>',
      'Homepage: https://www.gisworkbench.com',
      'Description: GIS Workbench Sidecar (preview): local conversion helper',
      ' An optional loopback-only helper for GIS Workbench with GDAL, PDAL, FFmpeg (LGPL build) and',
      ' Python. It converts formats the browser cannot read into ones GIS Workbench opens.',
      ' This build is an unsigned preview.',
      '',
    ].join('\n'),
  );
  // Stop running copies before an upgrade or removal (their tools die with them).
  writeFileSync(join(deb, 'DEBIAN', 'prerm'), `#!/bin/sh\nset -e\n[ -x /opt/${PKG}/gwb-sidecar-setup ] && /opt/${PKG}/gwb-sidecar-setup stop --quiet || true\n`);
  chmodSync(join(deb, 'DEBIAN', 'prerm'), 0o755);
  const debFile = join(OUT, `GWB-Sidecar-${VERSION}-amd64.deb`);
  rmSync(debFile, { force: true });
  execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', deb, debFile], { stdio: 'inherit' });
  art.push(debFile);

  // 3. AppImage (squashfs + the AppImage runtime, from appimagetool).
  if (!process.argv.includes('--no-appimage')) {
    const appdir = join(work, 'AppDir');
    cpSync(stage, join(appdir, 'usr', 'lib', PKG), { recursive: true });
    writeFileSync(join(appdir, 'AppRun'), `#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/usr/lib/${PKG}/gwb-sidecar" "$@"\n`);
    chmodSync(join(appdir, 'AppRun'), 0o755);
    copyFileSync(join(HERE, 'linux', 'gwb-sidecar.desktop'), join(appdir, 'gwb-sidecar.desktop'));
    copyFileSync(join(HERE, 'linux', 'gwb-sidecar.svg'), join(appdir, 'gwb-sidecar.svg'));
    copyFileSync(join(HERE, 'linux', 'gwb-sidecar.svg'), join(appdir, '.DirIcon'));
    normaliseModes(appdir);
    const img = join(OUT, `GWB-Sidecar-${VERSION}-x86_64.AppImage`);
    rmSync(img, { force: true });
    execFileSync(APPIMAGETOOL, ['--appimage-extract-and-run', '--no-appstream', appdir, img], { stdio: 'inherit', env: { ...process.env, ARCH: 'x86_64' } });
    art.push(img);
  }
  writeFileSync(join(OUT, 'SHA256SUMS'), art.map((a) => `${sha256(a)}  ${basename(a)}`).join('\n') + '\n');
  writeFileSync(join(OUT, 'sbom.cdx.json'), readFileSync(join(stage, 'sbom.cdx.json')));
  const report = { version: VERSION, platform: 'linux-x86_64', glibc, glibcFloor: GLIBC_FLOOR, sizes, artefacts: art.map((a) => ({ name: basename(a), bytes: statSync(a).size, sha256: sha256(a) })), components: sbom.components.length };
  writeFileSync(join(OUT, 'package-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
