#!/usr/bin/env node
// Sidecar release packaging (REQ-SDC-11, REQ-SDC-12; SDP-2.1 §3.7).
//
//   node sidecar/installer/package.mjs [--version 0.1.0] [--dist dist-21-sidecar] [--out D:/gwb-sidecar-deps/release] [--no-msi]
//
// 1. Stage `GIS Workbench Sidecar/`: gwb-sidecar.exe, gwb-sidecar-setup.exe, the composed modules
//    (Core GDAL, Point cloud, Media, Python runtime; compose.mjs licence gate), the released HTML files with
//    their SHA256SUMS for /app/, NOTICES, SOURCE-OFFER, LICENSE, the CycloneDX SBOM.
// 2. Gates: no vendor SDK file is in the stage (they are fetched at install time after the
//    licence is accepted); every Rust crate and every module component has an allow-listed licence.
// 3. Artefacts: GWB-Sidecar-<v>-x64.msi (per-user, all modules as features: the full offline
//    installer), GWB-Sidecar-<v>-x64-portable.zip, gwb-sidecar-module-<id>-<v>.zip, SHA256SUMS.
//    Builds are unsigned previews (Authenticode signing is an open owner item).
import { execFileSync } from 'node:child_process';
import { csmHostProblems, mediaNeedsProblems, mediaOpenH264Problems } from './gates.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, classifyLicence, setAllowed } from './compose.mjs';
import { makeWheel } from '../python/make-wheel.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const VERSION = arg('--version', JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', join(ROOT, 'sidecar', 'Cargo.toml')], { encoding: 'utf8' })).packages.find((p) => p.name === 'gwb-sidecar').version);
const DIST = resolve(ROOT, arg('--dist', 'dist-21-sidecar'));
const OUT = resolve(arg('--out', 'D:/gwb-sidecar-deps/release'), VERSION);
const TARGET = arg('--target', process.env.GWB_SIDECAR_TARGET ?? join(homedir(), 'AppData', 'Local', 'qlab', 'ct21-sidecar'));
const WIX = arg('--wix', join(process.env.USERPROFILE ?? '', '.dotnet', 'tools', 'wix.exe'));
const TAR = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');
// A fixed UpgradeCode: every version of the per-user MSI upgrades the previous one.
const UPGRADE_CODE = '{6E3B7C2A-41D5-4F0B-9E37-2B1C5D8A9F10}';
const VENDOR_FILES = /^(gdal_MrSID\.dll|gdal_ECW_JP2ECW\.dll|lti_dsdk.*\.dll|lti_lidar_dsdk.*\.dll|NCSEcw\.dll|tbb\.dll|.*openh264.*)$/i;

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
import { relayGate } from './shipped-gate.mjs';
const licences = JSON.parse(readFileSync(join(HERE, 'licences.json'), 'utf8'));
setAllowed(licences.allowed);

function rustCrates() {
  const m = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', join(ROOT, 'sidecar', 'Cargo.toml')], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  const byId = new Map(m.packages.map((p) => [p.id, p]));
  // Normal (non-dev) dependencies reachable from gwb-sidecar and gwb-sfm.
  const nodes = new Map(m.resolve.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  const stack = ['gwb-sidecar', 'gwb-stereo', 'gwb-sfm'].map((n) => m.packages.find((p) => p.name === n).id);
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of nodes.get(id)?.deps ?? []) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
  }
  return [...seen].map((id) => byId.get(id)).map((p) => ({ name: p.name, version: p.version, license: (p.license ?? '?').replace(/\//g, ' OR ') }));
}

async function main() {
  // Install tests: an MSI of another version from an existing stage (upgrade/repair checks).
  const from = arg('--msi-from', null);
  if (from) {
    mkdirSync(join(OUT, 'stage'), { recursive: true });
    console.log(buildMsi(resolve(from)));
    return;
  }
  const stage = join(OUT, 'stage', 'GIS Workbench Sidecar');
  rmSync(join(OUT, 'stage'), { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const problems = [];
  // Binaries.
  for (const exe of ['gwb-sidecar.exe', 'gwb-sidecar-setup.exe', 'gwb-stereo-viewer.exe']) copyFileSync(join(TARGET, 'release', exe), join(stage, exe));
  problems.push(...relayGate(['gwb-sidecar.exe', 'gwb-sidecar-setup.exe', 'gwb-stereo-viewer.exe'].map((e) => join(stage, e))));
  // Modules (licence gate inside; the library stand-ins of stubs/ come from the same target folder).
  process.env.GWB_SIDECAR_STUBS ??= join(TARGET, 'release');
  const comp = await compose({ out: join(stage, 'modules'), platform: 'windows' });
  problems.push(...comp.problems);
  problems.push(...csmHostProblems(stage, join(stage, 'gwb-sidecar.exe')));
  // OD-2.30: no OpenH264 in the Media module; and it keeps what profiles and tests use.
  const media = join(stage, 'modules', 'media');
  if (!existsSync(media)) problems.push(`media: not composed (${JSON.stringify(comp.report.media)})`);
  else problems.push(...mediaOpenH264Problems(media), ...mediaNeedsProblems(media, 'windows'));
  // The full grid set is about 800 MB of data few users need: a module ZIP of its own, in neither
  // the portable ZIP nor the MSI (gwb-sidecar-setup module <zip>).
  const extra = join(OUT, 'stage-extra');
  rmSync(extra, { recursive: true, force: true });
  mkdirSync(extra, { recursive: true });
  if (existsSync(join(stage, 'modules', 'proj-grids'))) renameSync(join(stage, 'modules', 'proj-grids'), join(extra, 'proj-grids'));
  // Structure from motion (REQ-GAP-29) is off the default install in the same way.
  if (existsSync(join(stage, 'modules', 'sfm'))) renameSync(join(stage, 'modules', 'sfm'), join(extra, 'sfm'));
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
  // Rust crates of the service itself.
  const crates = rustCrates().filter((c) => !c.name.startsWith('gwb-sidecar'));
  for (const c of crates) {
    const k = classifyLicence(c.license);
    if (!k.ok) problems.push(`rust crate ${c.name} ${c.version}: ${k.why}`);
  }
  // No vendor SDK file may be shipped.
  const files = walk(stage);
  for (const f of files) if (VENDOR_FILES.test(basename(f))) problems.push(`vendor file in the package: ${relative(stage, f)}`);
  // SBOM: modules (from compose) + Rust crates + the service.
  const sbom = JSON.parse(readFileSync(join(stage, 'modules', 'sbom.cdx.json'), 'utf8'));
  sbom.metadata.component = { type: 'application', name: 'gwb-sidecar', version: VERSION, licenses: [{ expression: 'Apache-2.0' }] };
  sbom.serialNumber = `urn:uuid:${randomUUID()}`;
  sbom.metadata.timestamp = new Date().toISOString();
  for (const c of crates) sbom.components.push({ type: 'library', name: c.name, version: c.version, purl: `pkg:cargo/${c.name}@${c.version}`, licenses: [{ expression: c.license }], properties: [{ name: 'gwb:module', value: 'service' }] });
  writeFileSync(join(stage, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2));
  rmSync(join(stage, 'modules', 'sbom.cdx.json'));
  const notices = readFileSync(join(stage, 'modules', 'NOTICES.txt'), 'utf8');
  rmSync(join(stage, 'modules', 'NOTICES.txt'));
  rmSync(join(stage, 'modules', 'compose-report.json'));
  const rustLines = crates.map((c) => `[service] ${c.name} ${c.version} — ${c.license}`);
  writeFileSync(join(stage, 'NOTICES.txt'), `${notices}\n${rustLines.join('\n')}\n\nVendor plug-in notices (only if you installed them):\n- MrSID: Portions of this computer program are copyright (c) 1995-2018 Celartem, Inc., doing business as Extensis. All rights reserved.\n- ECW: This application supports the ECW data format and ECWP compression protocols. Portions of this computer program are Copyright 2007-2015 Intergraph Corporation. All rights reserved.\n`);
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
    'The upstream sources: conda-forge feedstocks (https://github.com/conda-forge/<name>-feedstock) and',
    'FFmpeg 8.1.3 (https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz, unchanged, built by sidecar/installer/build-ffmpeg.sh;',
    'its configure line is in modules/media/licenses/BUILD.txt).',
    'OSSIM 2.12.1 (https://github.com/ossimlabs/ossim/archive/refs/tags/v2.12.1.tar.gz) and ossim-plugins OrchidIsland-2.11.1',
    '(https://github.com/ossimlabs/ossim-plugins/archive/refs/tags/OrchidIsland-2.11.1.tar.gz), with the edits in sidecar/ossim/build.mjs.',
    'IfcOpenShell 0.9.0.post1 (PyPI wheel; its source is https://github.com/IfcOpenShell/IfcOpenShell/archive/refs/tags/ifcopenshell-python-0.9.0post1.tar.gz).',
    'Eigen 5.0.1, MPL-2.0 (https://gitlab.com/libeigen/eigen/-/tree/5.0.1), headers compiled into the sfm module.',
  ].filter((l, i, a) => !(l.startsWith('- ') && a.indexOf(l) !== i));
  writeFileSync(join(stage, 'SOURCE-OFFER.txt'), offer.join('\n') + '\n');
  copyFileSync(join(ROOT, 'LICENSE'), join(stage, 'LICENSE.txt'));
  writeFileSync(
    join(stage, 'README.txt'),
    [`GIS Workbench Sidecar ${VERSION} (preview, unsigned)`, '', 'An optional local helper for GIS Workbench: it converts MrSID, ECW, FileGDB, E57, MPEG-2 and every', 'other GDAL, OGR, PDAL or FFmpeg format into formats the app reads. It listens on 127.0.0.1 only.', '', 'Start gwb-sidecar.exe; its tray icon opens the sidecar window (pairing, modules, jobs, log).', 'MrSID/ECW plug-ins: gwb-sidecar-setup.exe vendor-prompt (shows each vendor licence first).', 'Offline: gwb-sidecar-setup.exe vendor mrsid --from <folder with the OSGeo4W package and licence files>.', 'Portable: unzip anywhere and run; no administrator rights. Data: %LOCALAPPDATA%\\GIS Workbench Sidecar.', ''].join('\r\n'),
  );
  if (problems.length) {
    console.error(`packaging gate failed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  // Sizes per module (installed), for the release notes.
  const size = (d) => (existsSync(d) ? walk(d).reduce((a, f) => a + statSync(f).size, 0) : 0);
  const sizes = Object.fromEntries(['core-gdal', 'points', 'media', 'sar', 'model3d', 'ossim'].map((m) => [m, size(join(stage, 'modules', m))]));
  sizes.service = size(stage) - Object.values(sizes).reduce((a, b) => a + b, 0);
  sizes['proj-grids (separate)'] = size(join(extra, 'proj-grids'));
  sizes['sfm (separate)'] = size(join(extra, 'sfm'));
  const art = [];
  // Portable ZIP and module ZIPs.
  const zip = join(OUT, `GWB-Sidecar-${VERSION}-x64-portable.zip`);
  rmSync(zip, { force: true });
  execFileSync(TAR, ['-a', '-c', '-f', zip, '-C', join(OUT, 'stage'), 'GIS Workbench Sidecar']);
  art.push(zip);
  for (const m of ['core-gdal', 'points', 'media', 'sar', 'model3d', 'ossim', 'proj-grids', 'sfm']) {
    const z = join(OUT, `gwb-sidecar-module-${m}-${VERSION}.zip`);
    rmSync(z, { force: true });
    execFileSync(TAR, ['-a', '-c', '-f', z, '-C', m === 'proj-grids' || m === 'sfm' ? extra : join(stage, 'modules'), m]);
    art.push(z);
  }
  if (!process.argv.includes('--no-msi')) art.push(buildMsi(stage));
  writeFileSync(join(OUT, 'SHA256SUMS'), art.map((a) => `${sha256(a)}  ${basename(a)}`).join('\n') + '\n');
  writeFileSync(join(OUT, 'sbom.cdx.json'), readFileSync(join(stage, 'sbom.cdx.json')));
  const report = { version: VERSION, sizes, artefacts: art.map((a) => ({ name: basename(a), bytes: statSync(a).size, sha256: sha256(a) })), components: sbom.components.length };
  writeFileSync(join(OUT, 'package-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

/** A per-user MSI (no administrator rights): one component per folder, HKCU key paths. */
function buildMsi(stage) {
  const wxs = join(OUT, 'stage', 'sidecar.wxs');
  const ids = new Map();
  let n = 0;
  const id = (p, pre) => {
    if (!ids.has(p)) ids.set(p, `${pre}${(n++).toString(36)}`);
    return ids.get(p);
  };
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  // Stable component GUIDs from the folder path (name-based, SHA-1, as UUID v5): upgrades need them.
  const guid = (key) => {
    const h = createHash('sha1').update(`gwb-sidecar|${key}`).digest('hex');
    return `{${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}}`.toUpperCase();
  };
  const feature = (rel) => {
    const m = /^modules[\\/]([^\\/]+)/.exec(rel);
    return m ? { 'core-gdal': 'CoreGdal', points: 'Points', media: 'Media', sar: 'Sar', model3d: 'Model3d', ossim: 'Ossim' }[m[1]] ?? 'Service' : 'Service';
  };
  const comps = { Service: [], CoreGdal: [], Points: [], Media: [], Sar: [], Model3d: [], Ossim: [] };
  const dirXml = (dir, rel) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    const filesHere = entries.filter((e) => e.isFile());
    let x = '';
    if (filesHere.length || rel === '') {
      const cid = id(`c:${rel}`, 'C');
      const f = feature(rel);
      comps[f].push(cid);
      x += `<Component Id="${cid}" Guid="${guid(rel || "root")}"><RegistryValue Root="HKCU" Key="Software\\GIS Workbench Sidecar\\Components" Name="${cid}" Type="integer" Value="1" KeyPath="yes"/>`;
      x += `<RemoveFolder Id="R${cid}" On="uninstall"/>`;
      for (const e of filesHere) x += `<File Id="${id(`f:${rel}/${e.name}`, 'F')}" Source="${esc(join(dir, e.name))}" Name="${esc(e.name)}"/>`;
      x += '</Component>';
    } else {
      const cid = id(`c:${rel}`, 'C');
      comps[feature(rel)].push(cid);
      x += `<Component Id="${cid}" Guid="${guid(rel || "root")}"><RegistryValue Root="HKCU" Key="Software\\GIS Workbench Sidecar\\Components" Name="${cid}" Type="integer" Value="1" KeyPath="yes"/><RemoveFolder Id="R${cid}" On="uninstall"/></Component>`;
    }
    for (const e of entries.filter((e) => e.isDirectory())) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      x += `<Directory Id="${id(`d:${r}`, 'D')}" Name="${esc(e.name)}">${dirXml(join(dir, e.name), r)}</Directory>`;
    }
    return x;
  };
  const tree = dirXml(stage, '');
  const rtf = join(OUT, 'stage', 'licence.rtf');
  const lic = readFileSync(join(stage, 'LICENSE.txt'), 'utf8');
  writeFileSync(rtf, `{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\fs18 GIS Workbench Sidecar ${VERSION} is a PREVIEW build and is NOT code-signed.\\par The vendor MrSID/ECW plug-ins are not part of this package; after installation you are asked whether to download each from OSGeo4W, after its own licence is shown.\\par Third-party components and their licences: NOTICES.txt; source offer: SOURCE-OFFER.txt.\\par\\par ${lic.replace(/[\\{}]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\par ')}}`);
  const featureXml = (fid, title, desc, level, extra = '') => `<Feature Id="${fid}" Title="${title}" Description="${desc}" Level="${level}" ${extra}>${comps[fid].map((c) => `<ComponentRef Id="${c}"/>`).join('')}${fid === 'Service' ? '<ComponentRef Id="MenuShortcuts"/>' : ''}</Feature>`;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">
  <Package Name="GIS Workbench Sidecar (preview)" Manufacturer="GIS Workbench" Version="${VERSION}" UpgradeCode="${UPGRADE_CODE}" Scope="perUser" Compressed="yes" InstallerVersion="500">
    <SummaryInformation Description="GIS Workbench Sidecar ${VERSION} (preview, unsigned)"/>
    <MajorUpgrade DowngradeErrorMessage="A newer GIS Workbench Sidecar is already installed." Schedule="afterInstallInitialize"/>
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" MaximumUncompressedMediaSize="512"/>
    <Property Id="ARPCOMMENTS" Value="Optional local conversion helper for GIS Workbench (127.0.0.1 only)."/>
    <Property Id="ARPNOMODIFY" Value="0"/>
    <WixVariable Id="WixUILicenseRtf" Value="${esc(rtf)}"/>
    <ui:WixUI Id="WixUI_FeatureTree"/>
    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="ProgramsDir" Name="Programs">
        <Directory Id="INSTALLFOLDER" Name="GIS Workbench Sidecar">${tree}</Directory>
      </Directory>
    </StandardDirectory>
    <StandardDirectory Id="ProgramMenuFolder">
      <Directory Id="MenuDir" Name="GIS Workbench Sidecar">
        <Component Id="MenuShortcuts" Guid="${guid('menu')}">
          <Shortcut Id="StartSidecar" Name="GIS Workbench Sidecar" Target="[INSTALLFOLDER]gwb-sidecar.exe" WorkingDirectory="INSTALLFOLDER"/>
          <Shortcut Id="Modules" Name="Sidecar modules and vendor plug-ins" Target="[INSTALLFOLDER]gwb-sidecar-setup.exe" Arguments="modules" WorkingDirectory="INSTALLFOLDER"/>
          <Shortcut Id="Update" Name="Check for sidecar updates" Target="[INSTALLFOLDER]gwb-sidecar-setup.exe" Arguments="check-update" WorkingDirectory="INSTALLFOLDER"/>
          <RemoveFolder Id="RemoveMenuDir" On="uninstall"/>
          <RegistryValue Root="HKCU" Key="Software\\GIS Workbench Sidecar" Name="menu" Type="integer" Value="1" KeyPath="yes"/>
        </Component>
      </Directory>
    </StandardDirectory>
    ${featureXml('Service', 'Sidecar service', 'The loopback service, its window and the setup program.', 1, 'AllowAbsent="no" Display="expand"')}
    ${featureXml('CoreGdal', 'Core GDAL', 'GDAL/OGR 3.13 (conda-forge libgdal-core, no GPL components): rasters, vectors, MrSID/ECW with the vendor plug-ins.', 1, 'AllowAbsent="no"')}
    ${featureXml('Points', 'Point cloud (PDAL)', 'E57, BPF and other PDAL readers to COPC.', 1)}
    ${featureXml('Media', 'Media (FFmpeg, LGPL)', 'MPEG-2 video to H.264 with KLV kept (Windows H.264 encoder).', 1)}
    ${featureXml('Sar', 'Python runtime', 'The Python that 3D model export uses.', 1)}
    ${featureXml('Model3d', '3D model export', 'Assimp and IfcOpenShell: FBX, multipatch and IFC export.', 1)}
    ${featureXml('Ossim', 'Rigorous sensor models (OSSIM)', 'OSSIM sensor models, fitted to an RPC for the browser.', 1)}
    <CustomAction Id="StopRunning" Directory="INSTALLFOLDER" ExeCommand="&quot;[INSTALLFOLDER]gwb-sidecar-setup.exe&quot; stop --quiet" Execute="immediate" Return="ignore" Impersonate="yes"/>
    <CustomAction Id="VendorPrompt" Directory="INSTALLFOLDER" ExeCommand="&quot;[INSTALLFOLDER]gwb-sidecar-setup.exe&quot; vendor-prompt" Execute="immediate" Return="asyncNoWait" Impersonate="yes"/>
    <CustomAction Id="Cleanup" Directory="INSTALLFOLDER" ExeCommand="&quot;[INSTALLFOLDER]gwb-sidecar-setup.exe&quot; uninstall-cleanup --quiet --data &quot;[LocalAppDataFolder]GIS Workbench Sidecar&quot;" Execute="deferred" Return="ignore" Impersonate="yes"/>
    <InstallExecuteSequence>
      <Custom Action="StopRunning" Before="InstallValidate" Condition="Installed"/>
      <Custom Action="Cleanup" Before="RemoveFiles" Condition="REMOVE~=&quot;ALL&quot; AND NOT UPGRADINGPRODUCTCODE"/>
      <Custom Action="VendorPrompt" After="InstallFinalize" Condition="NOT Installed AND UILevel &gt;= 5"/>
    </InstallExecuteSequence>
  </Package>
</Wix>
`;
  writeFileSync(wxs, xml);
  const msi = join(OUT, `GWB-Sidecar-${VERSION}-x64.msi`);
  execFileSync(WIX, ['build', '-arch', 'x64', '-ext', 'WixToolset.UI.wixext', '-o', msi, wxs], { stdio: 'inherit' });
  return msi;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
