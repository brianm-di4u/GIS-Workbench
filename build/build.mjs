// GIS Workbench build (SDP §6.3): Rust bundles → esbuild bundles → inliner → gates →
// outputs. One HTML artifact that runs from file://, a hosted page or an embed (D26).
//
//   node build/build.mjs [--dev] [--skip-rust] [--out dist]

import { airgapStrip } from './airgap.mjs';
import { d3DecoderBlocks } from './d3-decoders.mjs';
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRust, BUNDLES, rustNotices } from './rust.mjs';
import { egm96Grid, encodePredicted, basemap, writeGeoidFixture } from './data.mjs';
import { tokensCss } from './tokens.mjs';
import { sizeGate, liteSizeGate, evalGate, licenceGate, manifestGate, cspGate, modelLicenceGate } from './gates.mjs';
import { buildPacks } from './packs.mjs';
import { i18nBuild } from './i18n.mjs';
import { vendorFixes } from './vendor-fixes.mjs';
import { hostModules } from './host-modules.mjs';

/** Curated public origins (build/origins.json, REQ-NET-01). */
const CURATED = JSON.parse(readFileSync(new URL('./origins.json', import.meta.url), 'utf8')).origins;
/** The optional sidecar's loopback origins (REQ-SDC-02): in every file's CSP, air-gapped included. */
export const LOOPBACK = JSON.parse(readFileSync(new URL('./origins.json', import.meta.url), 'utf8')).loopback?.origins ?? [];
for (const o of LOOPBACK) if (!/^http:\/\/127\.0\.0\.1:4782[1-3]$/.test(o)) throw new Error(`origins.json: loopback "${o}" is not a sidecar port on 127.0.0.1`);
for (const o of CURATED) if (!/^https:\/\/[a-z0-9.-]+$/.test(o.origin)) throw new Error(`origins.json: "${o.origin}" is not an https origin`);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const SKIP_RUST = args.has('--skip-rust');
// --out <dir> or --out=<dir> (relative to the repo): build elsewhere without touching dist/ (T&E campaign).
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? (process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null);
const outDir = join(root, outArg || 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const VERSION = pkg.version;
const BUILD_DATE = new Date().toISOString();
const DEFAULT_MODEL = process.env.GW_DEFAULT_MODEL || 'claude-opus-5-5';
const TARGET = ['chrome120', 'edge120', 'safari16.4', 'firefox128'];

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sha256b64 = (b) => createHash('sha256').update(b).digest('base64');
const log = (...a) => console.log(...a);
const errors = [];
const warnings = [];

// Allow-list for dynamic-code patterns inside audited third-party code paths the tool never
// calls (REQ-ARC-04). Every entry names the bundle, the pattern, the count and the reason.
const EVAL_ALLOW = JSON.parse(readFileSync(join(root, 'build', 'eval-allowlist.json'), 'utf8'));

/** Shown from the first bytes of the file until the shell is ready (OD-2.27); styles/10-base.css hides it. */
const splash = (name) => `<div id="gw-splash" role="status" aria-label="${name} is starting"><b>${name}</b><span class="gw-splash-bar"><i></i></span></div>`;

function scriptSafe(js) {
  // Keep bundled code from closing its own element or opening a comment. The HTML parser also
  // rewrites NUL (to U+FFFD) and CR LF (to LF) in script text, which would break the CSP hash:
  // a NUL can only sit inside a string, template or regex literal, where \x00 means the same.
  const out = js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--').replace(/\u0000/g, '\\x00');
  if (/\r/.test(out)) throw new Error('an inline script contains a CR character; its CSP hash would not match');
  return out;
}

async function bundle(entry, { name, globalName, external = [], define = {}, plugins = [] } = {}) {
  const r = await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true,
    external,
    format: 'iife',
    globalName,
    target: TARGET,
    minify: !DEV,
    sourcemap: false,
    write: false,
    metafile: true,
    legalComments: 'none',
    charset: 'utf8',
    platform: 'browser',
    mainFields: ['browser', 'module', 'main'],
    conditions: ['browser'],
    define: {
      __APP_VERSION__: JSON.stringify(VERSION),
      __BUILD_DATE__: JSON.stringify(BUILD_DATE),
      __DEV__: String(DEV),
      __DEFAULT_MODEL__: JSON.stringify(DEFAULT_MODEL),
      'import.meta.url': '"about:blank"',
      'process.env.NODE_ENV': JSON.stringify(DEV ? 'development' : 'production'),
      ...define,
    },
    loader: { '.css': 'text', '.svg': 'text', '.txt': 'text', '.wgsl': 'text', '.glsl': 'text' },
    logLevel: 'warning',
    plugins: [vendorFixes, ...plugins],
  });
  // Library shims that find the global object through `Function("return this")()` (webpack's
  // global, es6-promise's vertx probe) are rewritten to `globalThis`, the same object, so no
  // bundle carries a dynamic-code call (REQ-ARC-04; the allow-list stays empty).
  const text = r.outputFiles[0].text.replace(/(?:new )?Function\(\s*(["'])return this\1\s*\)\(\)/g, 'globalThis');
  return { name, text, metafile: r.metafile };
}

function packagesFromMetafile(metafiles) {
  const pk = new Map();
  for (const mf of metafiles) {
    for (const input of Object.keys(mf.inputs)) {
      const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
      if (!m) continue;
      const name = m[1].replace(/\\/g, '/');
      if (pk.has(name)) continue;
      const dir = join(root, 'node_modules', name);
      let meta = {};
      try {
        meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      } catch {}
      let licenceText = '';
      try {
        const f = readdirSync(dir).find((x) => /^(licen[cs]e|copying|notice)/i.test(x));
        if (f) licenceText = readFileSync(join(dir, f), 'utf8');
      } catch {}
      pk.set(name, { name, version: meta.version ?? '?', license: typeof meta.license === 'string' ? meta.license : meta.license?.type ?? 'UNKNOWN', licenceText });
    }
  }
  return [...pk.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The style sheet: the tokens, then app/src/styles/*.css (Full), or `files` (paths under app/src) for Lite. */
function css(files = null) {
  const parts = [tokensCss(join(root, 'app', 'src', 'data', 'ui-tokens.json'))];
  const dir = join(root, 'app', 'src', 'styles');
  const list = files ? files.map((f) => join(root, 'app', 'src', f)) : readdirSync(dir).filter((x) => x.endsWith('.css')).sort().map((f) => join(dir, f));
  for (const f of list) parts.push(readFileSync(f, 'utf8'));
  let text = parts.join('\n');
  if (!DEV) text = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n/g, '\n');
  return text;
}

function notices(packages, rustCrates, packs = {}) {
  const lines = [
    'GIS Workbench — third-party notices',
    `Build ${VERSION} (${BUILD_DATE})`,
    '',
    'This file is generated from the build metafile (JavaScript), cargo metadata (Rust) and the data list below.',
    '',
    '== JavaScript packages ==',
  ];
  for (const p of packages) {
    lines.push('', `--- ${p.name} ${p.version} (${p.license}) ---`, p.licenceText.trim() || '(licence text not shipped with the package)');
  }
  lines.push('', ...readFileSync(join(root, 'build', 'csm', 'NOTICES.txt'), 'utf8').trimEnd().split(/\r?\n/)); // REQ-GAP-24
  lines.push('', '== Rust crates (linked into the WASM bundles) ==');
  const packNotes = Object.entries(packs);
  for (const c of rustCrates) lines.push(`${c.name} ${c.version} (${c.license}) ${c.repository}`);
  lines.push(
    '',
    '== Data ==',
    'Natural Earth 1:110m admin-0 countries — public domain. Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.',
    'EGM96 15′ geoid grid — NGA, public domain; packaged via egm96-universal 1.1.1 (MIT, © 2020 Nicolas Vanhoren).',
    'SQLite (public domain) with the R*Tree module, compiled to WebAssembly by sql.js / rtree-sql.js (MIT) — GeoPackage support.',
    'Draco 3D decoder (draco_decoder.wasm and draco_wasm_wrapper.js, Google, Apache-2.0) and Basis Universal transcoder (basis_transcoder.wasm/.js, Binomial LLC, Apache-2.0), as shipped in three.js examples/jsm/libs — Draco and KTX2 glTF / 3D Tiles (REQ-FMT-34).',
    'NITF TRE catalogue structure — compiled from GDAL nitf_spec.xml (MIT/X) and osml-imagery-io (MIT) by GIS Workbench research WS14.',
    'Starter spectral library — 80 spectra from the USGS Spectral Library Version 7 (Kokaly et al. 2017, USGS Data Series 1035, doi:10.5066/F7RR1WDJ), splib07b convolved to AVIRIS 2014. Spectra courtesy of the U.S. Geological Survey; subset and rounded to 4 decimals by GIS Workbench (USGS has not reviewed or approved these changes).',
    '',
    '== Data packs (separate .gwpack files; each carries its own LICENCE.txt) ==',
    ...(packNotes.length ? packNotes.map(([n, p]) => `${n} ${p.version}: ${p.title} — see LICENCE.txt inside ${p.file}.`) : ['(none built)']),
    '',
    '== Ported algorithms ==',
    'Transverse Mercator, polar stereographic, UTM/UPS/MGRS, geocentric conversions — ported from GeographicLib (MIT, © Charles Karney).',
    'Geodesics — geographiclib-rs (MIT), a port of GeographicLib.',
    'Sun position — NOAA solar calculator equations (Meeus, Astronomical Algorithms), public domain.',
    'usgscsm 2.1.0 (USGS Astrogeology; public domain in the U.S. and CC0-1.0; some files BSD-3-Clause, © BAE Systems), with ALE (USGS, public domain / CC0-1.0) and the CSM API (USGS-Astrogeology/csm, Unlicense), compiled to WebAssembly by GIS Workbench (build/csm) — CSM sensor models (REQ-GAP-24). nlohmann/json 3.11 (MIT, © 2013-2022 Niels Lohmann) inside it. Eigen is not included: GIS Workbench replaces the two files that used it.',
    'SICD Volume 3 image projections — ported from SARkit 1.12.0 (MIT, © 2024 Valkyrie Systems Corporation).',
    'SAR display remaps, radiometric derivation, sub-aperture and CSI logic — after sarpy 2.1.1 (MIT, © 2018–2021 National Geospatial-Intelligence Agency).',
  );
  return lines.join('\n');
}

/** The pinned usgscsm module (REQ-GAP-24), verified against build/csm/usgscsm.json. */
function usgscsmBytes(root, errors) {
  const bytes = readFileSync(join(root, 'build', 'csm', 'usgscsm.wasm'));
  const man = JSON.parse(readFileSync(join(root, 'build', 'csm', 'usgscsm.json'), 'utf8'));
  if (sha256(bytes) !== man.output.sha256) errors.push(`REQ-GAP-24: build/csm/usgscsm.wasm does not match its manifest (${sha256(bytes)} vs ${man.output.sha256})`);
  const bad = WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map((i) => `${i.module}.${i.name}`).filter((i) => !/^wasi_snapshot_preview1\.|^env\.emscripten_notify_memory_growth$/.test(i));
  if (bad.length) errors.push(`REQ-GAP-24: usgscsm.wasm imports ${bad.join(', ')}`);
  return bytes;
}

function block({ name, kind, bytes, gz = true, load = 'lazy', licence = 'see notices', extra = {} }) {
  const stored = gz ? gzipSync(bytes, { level: 9 }) : bytes;
  const b64 = Buffer.from(stored).toString('base64');
  const sha = sha256(bytes);
  return {
    name,
    entry: { kind, sha256: sha, size: bytes.length, stored: b64.length, gz, load, licence, ...extra },
    html: `<script type="application/octet-stream" id="blk-${name}" data-kind="${kind}" data-sha256="${sha}">${b64}</script>`,
  };
}

async function main() {
  const t0 = Date.now();
  mkdirSync(outDir, { recursive: true });

  // 1. Rust
  let rust = { bundles: [], totalGzip: 0, licenceGate: 'skipped', errors: [], rustNotices: [] };
  if (!SKIP_RUST) {
    rust = buildRust(root, { log });
    errors.push(...rust.errors);
    log(`rust: ${rust.bundles.map((b) => `${b.name} ${(b.gzip / 1024).toFixed(1)} KB gz`).join(', ')}; licences ${rust.licenceGate}`);
  } else {
    // Reuse the last cargo output, as the full build ships it: the wasm-opt output when it is not
    // older than the cargo output (else the size and boot figures are those of unoptimised modules).
    const { execFileSync } = await import('node:child_process');
    const tdir = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: join(root, 'crates'), encoding: 'utf8' })).target_directory;
    for (const b of BUNDLES) {
      const raw = join(tdir, 'wasm32-unknown-unknown', 'release', `${b.crate.replace(/-/g, '_')}.wasm`);
      const opt = `${raw}.opt.wasm`;
      const f = existsSync(opt) && statSync(opt).mtimeMs >= statSync(raw).mtimeMs ? opt : raw;
      const bytes = readFileSync(f);
      rust.bundles.push({ ...b, bytes, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, licence: 'Apache-2.0' });
    }
    rust.rustNotices = rustNotices(join(root, 'crates')); // the notices list the linked crates either way
  }

  // 2. Data
  writeGeoidFixture(root);
  const geoid = encodePredicted(egm96Grid(), 1440, 721);
  const base = basemap();
  if (!base) warnings.push('Natural Earth sample not found; the map view will show a grid only');

  // 3. esbuild
  const boot = await bundle('app/src/boot/boot.js', { name: 'boot' });
  const app = await bundle('app/src/main.js', { name: 'app' });
  // GIS Workbench Lite (OD-2.23): its own entry, the mobile shell and the Lite features only.
  const liteApp = await bundle('app/src/mobile/main.js', { name: 'app-lite' });
  const workerCore = await bundle('app/src/workers/worker-core.js', { name: 'worker-core' });
  const kindsDir = join(root, 'app', 'src', 'workers', 'kinds');
  const kinds = [];
  for (const f of readdirSync(kindsDir).filter((x) => x.endsWith('.worker.js')).sort()) {
    kinds.push(await bundle(`app/src/workers/kinds/${f}`, { name: `worker-${f.replace('.worker.js', '')}` }));
  }
  // Lazy main-thread libraries (three.js for the 3D pane): app/src/lazy/*.lazy.js → block js-<name>.
  const lazyDir = join(root, 'app', 'src', 'lazy');
  const libs = [];
  // three.js's DRACOLoader/KTX2Loader build default decoder URLs from import.meta.url when loaded: a
  // hierarchical base keeps that from throwing (those URLs are never fetched; gltf-ext.js sets blob: paths).
  for (const f of readdirSync(lazyDir).filter((x) => x.endsWith('.lazy.js')).sort()) libs.push(await bundle(`app/src/lazy/${f}`, { name: f.replace('.lazy.js', ''), external: ['fs', 'path', 'crypto', 'https', 'image-size', 'node:fs', 'node:https'], define: f === 'three.lazy.js' ? { 'import.meta.url': '"https://three.invalid/jsm/loaders/"' } : {}, plugins: [hostModules(root)] })); // Emscripten glue and pptxgenjs name Node modules only on their Node paths
  // JSZip (inside pptxgenjs) carries a setImmediate polyfill that would eval a string callback;
  // JSZip only passes functions, so that branch becomes an error instead (no eval in any block).
  for (const l of libs) l.text = l.text.replace(/new Function\(\s*""\s*\+\s*([\w$]+)\s*\)/g, '(function(){throw new Error("setImmediate(string) is not supported")})');
  const packages = packagesFromMetafile([app.metafile, liteApp.metafile, workerCore.metafile, ...kinds.map((k) => k.metafile), ...libs.map((l) => l.metafile)]);
  errors.push(...licenceGate(packages));
  const jsSources = [app, liteApp, workerCore, ...kinds, ...libs, boot].map((b) => ({ name: b.name, text: b.text }));
  errors.push(...evalGate(jsSources, EVAL_ALLOW));

  // 4. Blocks
  const blocks = [];
  for (const b of rust.bundles) blocks.push(block({ name: `wasm-${b.name}`, kind: 'wasm', bytes: b.bytes, load: b.load, licence: b.licence, extra: { gzip: b.gzip } }));
  blocks.push(block({ name: 'js-worker-core', kind: 'js-worker', bytes: Buffer.from(workerCore.text), load: 'lazy' }));
  for (const k of kinds) blocks.push(block({ name: `js-${k.name}`, kind: 'js-worker', bytes: Buffer.from(k.text), load: 'lazy' }));
  for (const l of libs) blocks.push(block({ name: `js-${l.name}`, kind: 'js', bytes: Buffer.from(l.text), load: 'lazy' }));
  // SQLite with R*Tree (rtree-sql.js, C compiled to WASM) for GeoPackage (REQ-EXT-22).
  blocks.push(block({ name: 'wasm-sqlite', kind: 'wasm', bytes: readFileSync(join(root, 'node_modules', 'rtree-sql.js', 'dist', 'sql-wasm.wasm')), load: 'lazy', licence: 'SQLite public domain; sql.js / rtree-sql.js MIT' }));
  // usgscsm (REQ-GAP-24, S-60): the pinned module build/csm/build-usgscsm.mjs made, checked against
  // its manifest (no Emscripten needed here). Lazy: js-csm and the analysis worker compile it on use.
  blocks.push(block({ name: 'wasm-usgscsm', kind: 'wasm', bytes: usgscsmBytes(root, errors), load: 'lazy', licence: 'usgscsm, ALE and the CSM API: public domain (USGS; CC0-1.0, Unlicense); nlohmann/json MIT; GIS Workbench C ABI Apache-2.0' }));
  // Draco and Basis Universal decoders for glTF / 3D Tiles (REQ-FMT-34, S-47): lazy, handed to
  // three.js's DRACOLoader / KTX2Loader as blob: URLs of the verified bytes (render/gltf-ext.js).
  const D3_LIC = 'Apache-2.0 (Draco: Google; Basis Universal: Binomial LLC), via three.js examples/jsm/libs';
  const d3 = d3DecoderBlocks(root);
  for (const [name, bytes] of Object.entries(d3)) blocks.push(block({ name, kind: name.startsWith('wasm-') ? 'wasm' : 'data', bytes, load: 'lazy', licence: D3_LIC }));
  errors.push(...evalGate([{ name: 'data-draco-glue', text: d3['data-draco-glue'].toString('utf8') }, { name: 'data-basis-glue', text: d3['data-basis-glue'].toString('utf8') }], EVAL_ALLOW));
  blocks.push(block({ name: 'data-egm96', kind: 'data', bytes: geoid, load: 'lazy', licence: 'public domain (NGA); egm96-universal MIT', extra: { width: 1440, height: 721, model: 'EGM96 15′' } }));
  if (base) blocks.push(block({ name: 'data-basemap', kind: 'data', bytes: Buffer.from(base), load: 'eager', licence: 'public domain (Natural Earth)' }));
  const tokensJson = readFileSync(join(root, 'app', 'src', 'data', 'ui-tokens.json'));
  blocks.push(block({ name: 'data-tokens', kind: 'data', bytes: tokensJson, load: 'lazy', licence: 'own' }));
  // The starter spectral library (features/spectral-analysis.js reads it while the tool starts): a
  // data block, so the app script does not carry it as a 113 KB object literal.
  blocks.push(block({ name: 'data-splib07', kind: 'data', bytes: Buffer.from(JSON.stringify(JSON.parse(readFileSync(join(root, 'app', 'src', 'data', 'splib07-starter.json'), 'utf8')))), load: 'lazy', licence: 'USGS Spectral Library Version 7 (U.S. public domain); subset by GIS Workbench' }));
  // The changelog behind Help ▸ What's New.
  blocks.push(block({ name: 'data-changelog', kind: 'data', bytes: readFileSync(join(root, 'CHANGELOG.md')), load: 'lazy', licence: 'own' }));
  // UI locales (REQ-L10N-14): wave 1 catalogues inline (lazy, hash-checked), every locale also as a
  // pack; the Lite file leaves the inline catalogues out and uses the packs.
  const i18n = i18nBuild({ root, version: VERSION });
  for (const b of i18n.blocks) blocks.push(block({ name: b.name, kind: 'data', bytes: b.bytes, load: 'lazy', licence: 'own (Apache-2.0)' }));
  warnings.push(...i18n.warnings);

  // Data packs (REQ-ARC-14): built beside the HTML; their hashes go in the build manifest.
  const packs = await buildPacks({ outDir, esbuild, toolVersion: VERSION, extra: i18n.packDefs });
  warnings.push(...packs.warnings);
  errors.push(...evalGate(packs.code, EVAL_ALLOW));
  errors.push(...modelLicenceGate(packs.models));

  const styles = css();
  // The id covers everything shipped: loader, app, styles and every block.
  const buildId = sha256(Buffer.concat([Buffer.from(boot.text), Buffer.from(app.text), Buffer.from(styles), ...blocks.map((b) => Buffer.from(b.entry.sha256))])).slice(0, 16);
  const manifest = {
    format: 'gis-workbench-manifest',
    version: 1,
    build: { id: buildId, version: VERSION, date: BUILD_DATE, dev: DEV, defaultModel: DEFAULT_MODEL, profile: 'standard' },
    blocks: Object.fromEntries(blocks.map((b) => [b.name, b.entry])),
    // Curated public origins (REQ-NET-01): allowed by the CSP, used only while Online (REQ-NET-02).
    csp: { origins: [], curated: CURATED.map((o) => o.origin), loopback: LOOPBACK },
    packs: packs.manifest,
    i18n: i18n.manifest,
  };
  errors.push(...manifestGate(manifest, blocks.map((b) => ({ name: b.name, sha256: b.entry.sha256 }))));

  // 5. Assemble
  const bootJs = scriptSafe(boot.text);
  const appJs = scriptSafe(app.text);
  const manifestJson = JSON.stringify(manifest).replace(/</g, '\\u003c');
  const noticesText = notices(packages, rust.rustNotices, packs.manifest).replace(/<\/script/gi, '<\\/script');
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${sha256b64(bootJs)}' 'sha256-${sha256b64(appJs)}' blob: 'wasm-unsafe-eval'`,
    'worker-src blob:',
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src blob: mediastream:',
    'font-src data:',
    `connect-src ${['blob:', ...CURATED.map((o) => o.origin), ...LOOPBACK].join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  errors.push(...cspGate(csp));
  const html = [
    '<!DOCTYPE html>',
    '<html lang="en" data-theme="grey">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" id="csp" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="GIS Workbench ${VERSION}">`,
    `<meta name="gw-build" content="${buildId}">`,
    '<title>GIS Workbench</title>',
    `<style id="app-css">${styles}</style>`,
    '</head>',
    '<body>',
    `<div id="app">${splash('GIS Workbench')}</div>`,
    `<script type="application/json" id="build-manifest">${manifestJson}</script>`,
    '<script type="application/json" id="project-data">null</script>',
    ...blocks.map((b) => b.html),
    `<script type="text/plain" id="notices">${noticesText}</script>`,
    `<script id="gw-boot">${bootJs}</script>`,
    `<script id="gw-app">${appJs}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');

  // 6. Gates
  const total = Buffer.byteLength(html);
  const eagerBlocks = blocks.filter((b) => b.entry.load === 'eager').reduce((s, b) => s + b.entry.stored, 0);
  const eager = Buffer.byteLength(bootJs) + Buffer.byteLength(appJs) + Buffer.byteLength(styles) + Buffer.byteLength(manifestJson) + eagerBlocks;
  const sg = sizeGate({ total, eager });
  errors.push(...sg.errors);
  warnings.push(...sg.warnings);

  // 7. Outputs
  const report = {
    build: manifest.build,
    sizes: {
      total,
      eager,
      css: Buffer.byteLength(styles),
      boot: Buffer.byteLength(bootJs),
      app: Buffer.byteLength(appJs),
      notices: Buffer.byteLength(noticesText),
      blocks: Object.fromEntries(blocks.map((b) => [b.name, { raw: b.entry.size, stored: b.entry.stored, load: b.entry.load }])),
      rust: Object.fromEntries(rust.bundles.map((b) => [b.name, { raw: b.raw, gzip: b.gzip, budget: b.budget }])),
      rustTotalGzip: rust.bundles.reduce((s, b) => s + b.gzip, 0),
    },
    gates: { errors, warnings, licence: rust.licenceGate },
    packages: packages.map((p) => ({ name: p.name, version: p.version, license: p.license })),
    rustCrates: rust.rustNotices,
    csp,
  };
  writeFileSync(join(outDir, 'build-report.json'), JSON.stringify(report, null, 2));
  if (errors.length) {
    console.error(`\nBUILD FAILED (${errors.length} gate error${errors.length > 1 ? 's' : ''}):`);
    for (const e of errors) console.error('  ✗ ' + e);
    process.exit(1);
  }
  const outFile = join(outDir, 'gis-workbench.html');
  writeFileSync(outFile, html);
  // Air-gapped variant (REQ-NET-03): the same file with no network origin in its CSP.
  const airgap = airgapHtml(html);
  writeFileSync(join(outDir, 'gis-workbench-airgap.html'), airgap);
  report.sizes.airgap = Buffer.byteLength(airgap);
  const liteBuild = liteFile({ boot, liteApp, blocks, manifest, noticesText });
  errors.push(...liteBuild.errors);
  const lite = liteBuild.html;
  const lg = liteSizeGate({ total: Buffer.byteLength(lite) });
  errors.push(...lg.errors);
  warnings.push(...lg.warnings);
  if (errors.length) {
    console.error(`\nBUILD FAILED (${errors.length} gate error${errors.length > 1 ? 's' : ''}):`);
    for (const e of errors) console.error('  ✗ ' + e);
    process.exit(1);
  }
  writeFileSync(join(outDir, 'gis-workbench-lite.html'), lite);
  Object.assign(report.sizes, { liteApp: Buffer.byteLength(liteBuild.appJs), liteCss: Buffer.byteLength(liteBuild.styles), liteInner: Buffer.byteLength(liteBuild.inner), liteEager: liteBuild.eager, liteBlocks: liteBuild.blocks });
  writeFileSync(join(outDir, 'THIRD-PARTY-NOTICES.txt'), notices(packages, rust.rustNotices, packs.manifest));
  const kit = writeEmbedKit(html, lite, buildId);
  report.sizes.lite = Buffer.byteLength(lite);
  report.sizes.snippet = kit.snippet;
  report.sizes.snippetLite = kit.snippetLite;
  writeFileSync(join(outDir, 'build-report.json'), JSON.stringify(report, null, 2));
  const sums = ['gis-workbench.html', 'gis-workbench-airgap.html', 'gis-workbench-lite.html', 'THIRD-PARTY-NOTICES.txt', 'build-report.json', 'embed/snippet.html', 'embed/snippet-lite.html', ...packs.files]
    .map((f) => `${sha256(readFileSync(join(outDir, f)))}  ${f}`)
    .join('\n');
  writeFileSync(join(outDir, 'SHA256SUMS'), sums + '\n');
  for (const w of warnings) log('  ! ' + w);
  log(`built ${basename(outFile)} ${(total / 1048576).toFixed(2)} MB (eager ${(eager / 1048576).toFixed(2)} MB) build ${buildId} in ${Date.now() - t0} ms`);
}

/**
 * Lite profile (REQ-HOST-05): a small loader stub that inflates a gzip payload of the full
 * file and writes it into the document. The stub's CSP is the app's CSP plus the stub's own
 * hash, so every inner script still needs its build hash and every block its SHA-256.
 */
/**
 * REQ-ARC-15: the Lite profile leaves out the lazy 3D (three.js), LiDAR (point-cloud WASM and
 * worker), video (mpegts.js) and SAR (SAR WASM) modules. Their blocks are removed and listed as
 * `omitted` in the manifest, so the app can say why a command is unavailable.
 */
/** The air-gapped file: connect-src blob: and the sidecar's loopback origins only, no curated origins, profile marked (REQ-NET-03, REQ-SDC-14). */
export function airgapHtml(html) {
  const out = airgapStrip(html)
    .replace(/(<meta[^>]*id="csp"[^>]*content="[^"]*?)connect-src [^;"]*/, `$1connect-src ${['blob:', ...LOOPBACK].join(' ')}`)
    .replace(/"curated":\[[^\]]*\]/, '"curated":[]')
    .replace('"profile":"standard"', '"profile":"airgap"');
  if (out === html || /connect-src blob: https/.test(out)) throw new Error('airgap: could not rewrite the CSP');
  return out;
}

/**
 * GIS Workbench Lite (OD-2.23, REQ-HOST-05): the mobile build. Its own app script (mobile/main.js:
 * the mobile shell and the Lite features), its own style sheet, and only the blocks it uses: the
 * decoders of the common imagery and vector formats, the geoid, the basemap and the field-tools
 * block. Every other block is listed as `omitted` in its manifest, so the loader refuses it by name.
 * No sidecar origin: the sidecar is Full only (a phone cannot reach a loopback sidecar).
 */
export const LITE_BLOCKS = ['wasm-core', 'wasm-parse', 'wasm-j2k', 'wasm-raster', 'wasm-vector', 'wasm-legacy', 'wasm-tiles', 'wasm-brotli', 'wasm-terrain', 'wasm-sqlite', 'js-sqlite', 'js-worker-core', 'js-worker-decode', 'js-worker-analysis', 'js-fgb', 'js-parquet', 'js-field', 'data-egm96', 'data-basemap', 'data-tokens', 'data-changelog'];
export const LITE_CSS = ['styles/10-base.css', 'styles/30-panes.css', 'styles/40-overlays.css', 'mobile/mobile.css'];

function liteFile({ boot, liteApp, blocks, manifest, noticesText }) {
  const errors = [];
  const keep = blocks.filter((b) => LITE_BLOCKS.includes(b.name));
  for (const n of LITE_BLOCKS) if (!keep.some((b) => b.name === n)) errors.push(`Lite: block ${n} is not in this build`);
  const styles = css(LITE_CSS);
  const bootJs = scriptSafe(boot.text);
  const appJs = scriptSafe(liteApp.text);
  const man = {
    ...manifest,
    build: { ...manifest.build, profile: 'lite' },
    blocks: Object.fromEntries(keep.map((b) => [b.name, b.entry])),
    omitted: blocks.filter((b) => !LITE_BLOCKS.includes(b.name)).map((b) => b.name),
    csp: { ...manifest.csp, loopback: [] },
  };
  errors.push(...manifestGate(man, keep.map((b) => ({ name: b.name, sha256: b.entry.sha256 }))));
  const manifestJson = JSON.stringify(man).replace(/</g, '\\u003c');
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${sha256b64(bootJs)}' 'sha256-${sha256b64(appJs)}' blob: 'wasm-unsafe-eval'`,
    'worker-src blob:',
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'media-src blob: mediastream:',
    'font-src data:',
    `connect-src ${['blob:', ...CURATED.map((o) => o.origin)].join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  errors.push(...cspGate(csp));
  const inner = [
    '<!DOCTYPE html>',
    '<html lang="en" data-theme="m3-light" data-edition="lite">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" id="csp" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">',
    '<meta name="color-scheme" content="light dark">',
    `<meta name="generator" content="GIS Workbench ${VERSION} (Lite)">`,
    `<meta name="gw-build" content="${manifest.build.id}">`,
    '<title>GIS Workbench Lite</title>',
    `<style id="app-css">${styles}</style>`,
    '</head>',
    '<body>',
    `<div id="app">${splash('GIS Workbench Lite')}</div>`,
    `<script type="application/json" id="build-manifest">${manifestJson}</script>`,
    '<script type="application/json" id="project-data">null</script>',
    ...keep.map((b) => b.html),
    `<script type="text/plain" id="notices">${noticesText}</script>`,
    `<script id="gw-boot">${bootJs}</script>`,
    `<script id="gw-app">${appJs}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
  const eager = Buffer.byteLength(bootJs) + Buffer.byteLength(appJs) + Buffer.byteLength(styles) + Buffer.byteLength(manifestJson) + keep.filter((b) => b.entry.load === 'eager').reduce((s, b) => s + b.entry.stored, 0);
  return { html: liteHtml(inner, csp), inner, appJs, styles, eager, blocks: keep.map((b) => b.name), errors };
}

function liteHtml(html, csp) {
  const payload = gzipSync(Buffer.from(html), { level: 9 }).toString('base64');
  const stub = [
    '(async () => {',
    "  const el = document.getElementById('gw-payload');",
    '  try {',
    '    const s = el.textContent;',
    '    const u8 = Uint8Array.fromBase64 ? Uint8Array.fromBase64(s) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0));',
    "    const text = await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).text();",
    '    document.open();',
    '    document.write(text);',
    '    document.close();',
    '  } catch (e) {',
    "    document.body.textContent = 'GIS Workbench Lite: the payload is damaged and cannot start (' + e.message + ').';",
    '  }',
    '})();',
  ].join('\n');
  const liteCsp = csp.replace('script-src ', `script-src 'sha256-${sha256b64(stub)}' `);
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${liteCsp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">',
    `<meta name="generator" content="GIS Workbench ${VERSION} (Lite)">`,
    '<title>GIS Workbench Lite</title>',
    // Unpacking takes a moment on a phone: the same splash, in the stub's own small style sheet.
    '<style>html,body{margin:0;height:100%}body{background:#fff;color:#1c1b1f;font:1.1rem system-ui,sans-serif}@media (prefers-color-scheme:dark){body{background:#1c1b1f;color:#e6e1e5}}#gw-splash{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}.gw-splash-bar{width:180px;height:3px;overflow:hidden;background:#8884}.gw-splash-bar i{display:block;width:40%;height:100%;background:currentColor;animation:s 1.1s linear infinite}@keyframes s{from{transform:translateX(-100%)}to{transform:translateX(250%)}}@media (prefers-reduced-motion:reduce){.gw-splash-bar i{animation:none;width:100%;opacity:.5}}</style>',
    '</head>',
    '<body>',
    splash('GIS Workbench Lite'),
    `<script type="application/octet-stream" id="gw-payload">${payload}</script>`,
    `<script>${stub}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** Embed kit (REQ-HOST-04, REQ-HOST-05): paste-ready iframe snippets and instructions. */
function writeEmbedKit(html, lite, buildId) {
  const dir = join(outDir, 'embed');
  mkdirSync(dir, { recursive: true });
  const allow = 'fullscreen; clipboard-read; clipboard-write; display-capture';
  const frame = (doc) => `<iframe title="GIS Workbench" style="width:100%;height:85vh;border:0" allow="${allow}" sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-modals" srcdoc="${doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe>\n`;
  const snippet = frame(html);
  const snippetLite = frame(lite);
  writeFileSync(join(dir, 'snippet.html'), snippet);
  writeFileSync(join(dir, 'snippet-lite.html'), snippetLite);
  writeFileSync(
    join(dir, 'README.md'),
    [
      `# GIS Workbench embed kit (build ${buildId})`,
      '',
      'Paste `snippet.html` into a hosting service\'s HTML/embed box, or host `gis-workbench.html` and embed it with',
      '`<iframe src="gis-workbench.html" allow="' + allow + '"></iframe>`.',
      '',
      `Snippet size: ${Buffer.byteLength(snippet)} bytes (snippet.html); Lite: ${Buffer.byteLength(snippetLite)} bytes (snippet-lite.html, REQ-HOST-05).`,
      'GIS Workbench Lite (OD-2.23) is the mobile edition: a touch interface for phones and tablets with the field features (open, view, enhance, coordinates, measure, AOI and GRG, observations with photos, export and share), packed as one gzip payload behind a small loader. It suits small embed boxes. GIS Workbench (Full) has every feature and the desktop interface.',
      '',
      '## What works where (REQ-HOST-08)',
      '| Attribute | Unlocks |',
      '|---|---|',
      '| `allow="fullscreen"` | Analysis Fullscreen |',
      '| `allow="clipboard-read; clipboard-write"` | Copy/paste of coordinates and graphics, export panel copy |',
      '| `allow="display-capture"` | Whiteboard tab capture (otherwise a rendered snapshot is used) |',
      '| `sandbox` with `allow-downloads` | Saving products and project files as downloads |',
      '| `sandbox` with `allow-same-origin` | IndexedDB recovery journal and whiteboard sessions |',
      '',
      'Without them the tool still runs and says what is unavailable (Help ▸ About & Diagnostics).',
      'The tool keeps its own strict CSP inside the frame and never relaxes it (REQ-HOST-06).',
      '',
    ].join('\n'),
  );
  return { snippet: Buffer.byteLength(snippet), snippetLite: Buffer.byteLength(snippetLite) };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
