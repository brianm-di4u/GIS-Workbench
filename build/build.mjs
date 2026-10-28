// GIS Workbench build (SDP §6.3): Rust bundles → esbuild bundles → inliner → gates →
// outputs. One HTML artifact that runs from file://, a hosted page or an embed (D26).
//
//   node build/build.mjs [--dev] [--skip-rust] [--out dist]

import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRust, BUNDLES } from './rust.mjs';
import { egm96Grid, encodePredicted, basemap, writeGeoidFixture } from './data.mjs';
import { tokensCss } from './tokens.mjs';
import { sizeGate, evalGate, licenceGate, manifestGate, cspGate } from './gates.mjs';
import { buildPacks } from './packs.mjs';
import { vendorFixes } from './vendor-fixes.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const DEV = args.has('--dev');
const SKIP_RUST = args.has('--skip-rust');
// --out <dir> or --out=<dir> (relative to the repo): build elsewhere without touching dist/ (T&E campaign).
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? (process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : null);
const outDir = join(root, outArg || 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const research = join(root, '..', 'Research');

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

function scriptSafe(js) {
  // Keep bundled code from closing its own element or opening a comment. The HTML parser also
  // rewrites NUL (to U+FFFD) and CR LF (to LF) in script text, which would break the CSP hash:
  // a NUL can only sit inside a string, template or regex literal, where \x00 means the same.
  const out = js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--').replace(/\u0000/g, '\\x00');
  if (/\r/.test(out)) throw new Error('an inline script contains a CR character; its CSP hash would not match');
  return out;
}

async function bundle(entry, { name, globalName, external = [] } = {}) {
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
    },
    loader: { '.css': 'text', '.svg': 'text', '.txt': 'text', '.wgsl': 'text', '.glsl': 'text' },
    logLevel: 'warning',
    plugins: [vendorFixes],
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

function css() {
  const parts = [tokensCss(join(root, 'app', 'src', 'data', 'ui-tokens.json'))];
  const dir = join(root, 'app', 'src', 'styles');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.css')).sort()) parts.push(readFileSync(join(dir, f), 'utf8'));
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
  lines.push('', '== Rust crates (linked into the WASM bundles) ==');
  const packNotes = Object.entries(packs);
  for (const c of rustCrates) lines.push(`${c.name} ${c.version} (${c.license}) ${c.repository}`);
  lines.push(
    '',
    '== Data ==',
    'Natural Earth 1:110m admin-0 countries — public domain. Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.',
    'EGM96 15′ geoid grid — NGA, public domain; packaged via egm96-universal 1.1.1 (MIT, © 2020 Nicolas Vanhoren).',
    'SQLite (public domain) with the R*Tree module, compiled to WebAssembly by sql.js / rtree-sql.js (MIT) — GeoPackage support.',
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
    'SICD Volume 3 image projections — ported from SARkit 1.12.0 (MIT, © 2024 Valkyrie Systems Corporation).',
    'SAR display remaps, radiometric derivation, sub-aperture and CSI logic — after sarpy 2.1.1 (MIT, © 2018–2021 National Geospatial-Intelligence Agency).',
  );
  return lines.join('\n');
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
    // Reuse the last cargo output.
    const { execFileSync } = await import('node:child_process');
    const tdir = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: join(root, 'crates'), encoding: 'utf8' })).target_directory;
    for (const b of BUNDLES) {
      const f = join(tdir, 'wasm32-unknown-unknown', 'release', `${b.crate.replace(/-/g, '_')}.wasm`);
      const bytes = readFileSync(f);
      rust.bundles.push({ ...b, bytes, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, licence: 'Apache-2.0' });
    }
  }

  // 2. Data
  writeGeoidFixture(root);
  const geoid = encodePredicted(egm96Grid(), 1440, 721);
  const base = basemap(research);
  if (!base) warnings.push('Natural Earth sample not found; the map view will show a grid only');

  // 3. esbuild
  const boot = await bundle('app/src/boot/boot.js', { name: 'boot' });
  const app = await bundle('app/src/main.js', { name: 'app' });
  const workerCore = await bundle('app/src/workers/worker-core.js', { name: 'worker-core' });
  const kindsDir = join(root, 'app', 'src', 'workers', 'kinds');
  const kinds = [];
  for (const f of readdirSync(kindsDir).filter((x) => x.endsWith('.worker.js')).sort()) {
    kinds.push(await bundle(`app/src/workers/kinds/${f}`, { name: `worker-${f.replace('.worker.js', '')}` }));
  }
  // Lazy main-thread libraries (three.js for the 3D pane): app/src/lazy/*.lazy.js → block js-<name>.
  const lazyDir = join(root, 'app', 'src', 'lazy');
  const libs = [];
  for (const f of readdirSync(lazyDir).filter((x) => x.endsWith('.lazy.js')).sort()) libs.push(await bundle(`app/src/lazy/${f}`, { name: f.replace('.lazy.js', ''), external: ['fs', 'path', 'crypto', 'https', 'image-size', 'node:fs', 'node:https'] })); // Emscripten glue and pptxgenjs name Node modules only on their Node paths
  // JSZip (inside pptxgenjs) carries a setImmediate polyfill that would eval a string callback;
  // JSZip only passes functions, so that branch becomes an error instead (no eval in any block).
  for (const l of libs) l.text = l.text.replace(/new Function\(\s*""\s*\+\s*([\w$]+)\s*\)/g, '(function(){throw new Error("setImmediate(string) is not supported")})');
  const packages = packagesFromMetafile([app.metafile, workerCore.metafile, ...kinds.map((k) => k.metafile), ...libs.map((l) => l.metafile)]);
  errors.push(...licenceGate(packages));
  const jsSources = [app, workerCore, ...kinds, ...libs, boot].map((b) => ({ name: b.name, text: b.text }));
  errors.push(...evalGate(jsSources, EVAL_ALLOW));

  // 4. Blocks
  const blocks = [];
  for (const b of rust.bundles) blocks.push(block({ name: `wasm-${b.name}`, kind: 'wasm', bytes: b.bytes, load: b.load, licence: b.licence, extra: { gzip: b.gzip } }));
  blocks.push(block({ name: 'js-worker-core', kind: 'js-worker', bytes: Buffer.from(workerCore.text), load: 'lazy' }));
  for (const k of kinds) blocks.push(block({ name: `js-${k.name}`, kind: 'js-worker', bytes: Buffer.from(k.text), load: 'lazy' }));
  for (const l of libs) blocks.push(block({ name: `js-${l.name}`, kind: 'js', bytes: Buffer.from(l.text), load: 'lazy' }));
  // SQLite with R*Tree (rtree-sql.js, C compiled to WASM) for GeoPackage (REQ-EXT-22).
  blocks.push(block({ name: 'wasm-sqlite', kind: 'wasm', bytes: readFileSync(join(root, 'node_modules', 'rtree-sql.js', 'dist', 'sql-wasm.wasm')), load: 'lazy', licence: 'SQLite public domain; sql.js / rtree-sql.js MIT' }));
  blocks.push(block({ name: 'data-egm96', kind: 'data', bytes: geoid, load: 'lazy', licence: 'public domain (NGA); egm96-universal MIT', extra: { width: 1440, height: 721, model: 'EGM96 15′' } }));
  if (base) blocks.push(block({ name: 'data-basemap', kind: 'data', bytes: Buffer.from(base), load: 'eager', licence: 'public domain (Natural Earth)' }));
  const tokensJson = readFileSync(join(root, 'app', 'src', 'data', 'ui-tokens.json'));
  blocks.push(block({ name: 'data-tokens', kind: 'data', bytes: tokensJson, load: 'lazy', licence: 'own' }));
  // The changelog behind Help ▸ What's New.
  blocks.push(block({ name: 'data-changelog', kind: 'data', bytes: readFileSync(join(root, 'CHANGELOG.md')), load: 'lazy', licence: 'own' }));

  // Data packs (REQ-ARC-14): built beside the HTML; their hashes go in the build manifest.
  const packs = await buildPacks({ outDir, esbuild, toolVersion: VERSION });
  warnings.push(...packs.warnings);
  errors.push(...evalGate(packs.code, EVAL_ALLOW));

  const styles = css();
  // The id covers everything shipped: loader, app, styles and every block.
  const buildId = sha256(Buffer.concat([Buffer.from(boot.text), Buffer.from(app.text), Buffer.from(styles), ...blocks.map((b) => Buffer.from(b.entry.sha256))])).slice(0, 16);
  const manifest = {
    format: 'gis-workbench-manifest',
    version: 1,
    build: { id: buildId, version: VERSION, date: BUILD_DATE, dev: DEV, defaultModel: DEFAULT_MODEL, profile: 'standard' },
    blocks: Object.fromEntries(blocks.map((b) => [b.name, b.entry])),
    csp: { origins: [] },
    packs: packs.manifest,
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
    'connect-src blob:',
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
    '<div id="app"></div>',
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
  const lite = liteHtml(stripForLite(html.replace(`"profile":"standard"`, `"profile":"lite"`)), csp);
  writeFileSync(join(outDir, 'gis-workbench-lite.html'), lite);
  writeFileSync(join(outDir, 'THIRD-PARTY-NOTICES.txt'), notices(packages, rust.rustNotices, packs.manifest));
  const kit = writeEmbedKit(html, lite, buildId);
  report.sizes.lite = Buffer.byteLength(lite);
  report.sizes.snippet = kit.snippet;
  report.sizes.snippetLite = kit.snippetLite;
  writeFileSync(join(outDir, 'build-report.json'), JSON.stringify(report, null, 2));
  const sums = ['gis-workbench.html', 'gis-workbench-lite.html', 'THIRD-PARTY-NOTICES.txt', 'build-report.json', 'embed/snippet.html', 'embed/snippet-lite.html', ...packs.files]
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
export const LITE_OMIT = ['js-three', 'js-mpegts', 'wasm-pointcloud', 'js-worker-pointcloud', 'wasm-sar'];
function stripForLite(html) {
  let out = html;
  for (const name of LITE_OMIT) {
    const re = new RegExp(`<script type="application/octet-stream" id="blk-${name}"[^>]*>[^<]*</script>\\n?`);
    if (!re.test(out)) throw new Error(`Lite: block ${name} not found`);
    out = out.replace(re, '');
  }
  return out.replace(/(<script type="application\/json" id="build-manifest">)([\s\S]*?)(<\/script>)/, (m, a, json, c) => {
    const man = JSON.parse(json);
    for (const name of LITE_OMIT) delete man.blocks[name];
    man.omitted = LITE_OMIT;
    return a + JSON.stringify(man) + c;
  });
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
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="generator" content="GIS Workbench ${VERSION} (Lite)">`,
    '<title>GIS Workbench</title>',
    '</head>',
    '<body>',
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
      'The Lite profile is the same application without the 3D, LiDAR, video and SAR modules, packed as one gzip payload behind a small loader; it starts a little slower.',
      '',
      '## What works where (REQ-HOST-08)',
      '| Attribute | Unlocks |',
      '|---|---|',
      '| `allow="fullscreen"` | Exploitation Fullscreen |',
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
