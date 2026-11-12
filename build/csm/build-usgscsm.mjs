#!/usr/bin/env node
// GIS Workbench: build the usgscsm WebAssembly module (REQ-GAP-24, spike S-60) and pin it.
//
//   node build/csm/build-usgscsm.mjs --src E:/gwb25/data-csm/src/usgscsm --emsdk E:/gwb25/emsdk
//
// Writes build/csm/usgscsm.wasm (checked in) and build/csm/usgscsm.json: the Emscripten version,
// the flags, the upstream commits and the SHA-256 of every source file compiled, and the output's
// SHA-256 and sizes. The normal build (build/build.mjs) only reads the pinned .wasm and checks it
// against the manifest; it never needs Emscripten. Re-running this script on the same sources and
// Emscripten version gives the same bytes (checked by --verify).
//
// The module: usgscsm 2.1.0 (frame, line scanner, push frame and SAR models; the projected model
// needs PROJ and is left out, as usgscsm's own Emscripten build does), ALE's interpolation code and
// the CSM API, all public domain; nlohmann/json (MIT, headers); and three GIS Workbench files
// (Apache-2.0): the C ABI (src/gw_csm.cpp) and Eigen-free replacements for the two Eigen users
// (src/gw_ale_rotation.cpp, src/gw_eigen_utilities.cpp), so no MPL-2.0 code is in the browser bundle.
// STANDALONE_WASM with native wasm exceptions: no embind, no JS glue, no eval; the page's own
// loader (app/src/sensor/csm-wasm.js) provides the few WASI imports.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const SRC = resolve(arg('--src', 'E:/gwb25/data-csm/src/usgscsm'));
const EMSDK = resolve(arg('--emsdk', 'E:/gwb25/emsdk'));
const OUT = resolve(arg('--out', join(here, 'usgscsm.wasm')));
const OBJ = resolve(arg('--obj', join(dirname(SRC), 'obj-wasm')));
const VERIFY = process.argv.includes('--verify');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const win = process.platform === 'win32';
const emxx = join(EMSDK, 'upstream', 'emscripten', win ? 'em++.exe' : 'em++');
if (!existsSync(emxx)) throw new Error(`em++ not found at ${emxx} (install and activate the emsdk)`);

const git = (dir) => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const SOURCES = [
  ...['UsgsAstroPlugin', 'UsgsAstroFrameSensorModel', 'UsgsAstroPushFrameSensorModel', 'UsgsAstroLsSensorModel', 'UsgsAstroSarSensorModel', 'Distortion', 'Utilities', 'VariantMap'].map((f) => join(SRC, 'src', `${f}.cpp`)),
  ...['InterpUtils', 'Orientations', 'States', 'Util', 'Vectors'].map((f) => join(SRC, 'ale', 'src', `${f}.cpp`)),
  ...['BundleGM', 'CorrelationModel', 'Ellipsoid', 'FourParameterCorrelationModel', 'GeometricModel', 'Isd', 'LinearDecayCorrelationModel', 'ModelIdentifier', 'Plugin', 'RasterGM', 'SettableEllipsoid', 'Version'].map((f) => join(SRC, 'csm', `${f}.cpp`)),
  ...['gw_csm', 'gw_ale_rotation', 'gw_eigen_utilities'].map((f) => join(here, 'src', `${f}.cpp`)),
];
const commits = { usgscsm: git(SRC), csm: git(join(SRC, 'csm')), ale: git(join(SRC, 'ale')), json: git(join(SRC, 'json')) };
const VERSION = { usgscsm: `2.1.0 (${commits.usgscsm.slice(0, 7)})`, csm: `3.0.3 (${commits.csm.slice(0, 7)})` };
const EXPORTS = ['alloc', 'free', 'last_error', 'out_ptr', 'out_len', 'version', 'model_from_isd', 'model_from_state', 'model_state', 'model_free', 'set_precision', 'model_with_params', 'model_info', 'i2g_ecef', 'g2i_ecef', 'i2g', 'g2i', 'convert', 'sensor_partials', 'ground_partials_ecef', 'unmodeled', 'locus'].map((n) => `_gwc_${n}`);
const CFLAGS = ['-std=c++17', '-Oz', '-fwasm-exceptions', '-sWASM_LEGACY_EXCEPTIONS=1', '-ffp-contract=off', '-fno-fast-math', '-DNDEBUG', `-DUSGSCSM_VERSION_TEXT="${VERSION.usgscsm}"`, `-DCSM_VERSION_TEXT="${VERSION.csm}"`];
const INCLUDES = [join(here, 'compat'), join(SRC, 'include', 'usgscsm'), join(SRC, 'include'), SRC, join(SRC, 'csm'), join(SRC, 'ale', 'include'), join(SRC, 'json', 'single_include')].map((d) => `-I${d}`);
const LDFLAGS = ['-Oz', '-fwasm-exceptions', '-sWASM_LEGACY_EXCEPTIONS=1', '-sSTANDALONE_WASM=1', '--no-entry', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=16MB', '-sMAXIMUM_MEMORY=1GB', '-sSTACK_SIZE=1MB', '-sFILESYSTEM=0', '-sDYNAMIC_EXECUTION=0', '-sSUPPORT_LONGJMP=0', `-sEXPORTED_FUNCTIONS=${EXPORTS.join(',')}`];

function em(args) {
  const r = spawnSync(emxx, args, { encoding: 'utf8', shell: false, windowsVerbatimArguments: false, maxBuffer: 64 << 20, env: { ...process.env, EMSDK } });
  if (r.status !== 0) throw new Error(`em++ ${args.slice(-3).join(' ')} failed:\n${(r.stderr || r.stdout || '').slice(-4000)}`);
  return r;
}
const q = (s) => s; // arguments go to em++ directly (no shell, no quoting)

mkdirSync(OBJ, { recursive: true });
const emVersion = em(['--version']).stdout.split('\n')[0].trim();
const objs = [];
const t0 = Date.now();
// Compile (in parallel through the shell's own job control would hide errors; sequential is fine).
for (const f of SOURCES) {
  const o = join(OBJ, `${basename(f, '.cpp')}.o`);
  em([...CFLAGS.map(q), ...INCLUDES.map(q), '-c', q(f), '-o', q(o)]);
  objs.push(o);
  process.stdout.write('.');
}
const tmp = join(OBJ, 'usgscsm.wasm');
em([...LDFLAGS, ...objs.map(q), '-o', q(tmp)]);
const bytes = readFileSync(tmp);
console.log(`\nbuilt in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${bytes.length} B, ${gzipSync(bytes, { level: 9 }).length} B gzip`);

// Gate: the module imports only WASI and the memory-growth notice, and exports the C ABI.
const mod = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
const bad = imports.filter((i) => !/^wasi_snapshot_preview1\.|^env\.emscripten_notify_memory_growth$/.test(i));
if (bad.length) throw new Error(`usgscsm.wasm imports ${bad.join(', ')}`);
const exports = WebAssembly.Module.exports(mod).map((e) => e.name);
for (const e of EXPORTS) if (!exports.includes(e.slice(1))) throw new Error(`usgscsm.wasm does not export ${e.slice(1)}`);

const manifest = {
  note: 'REQ-GAP-24: pinned usgscsm WebAssembly module; rebuild with node build/csm/build-usgscsm.mjs (see the header).',
  output: { file: 'usgscsm.wasm', sha256: sha(bytes), size: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length },
  emscripten: emVersion,
  upstream: {
    usgscsm: { repo: 'https://github.com/DOI-USGS/usgscsm', tag: '2.1.0', commit: commits.usgscsm, licence: 'public domain (USGS) / CC0-1.0; BAE files BSD-3-Clause' },
    csm: { repo: 'https://github.com/USGS-Astrogeology/csm', commit: commits.csm, licence: 'Unlicense (public domain)' },
    ale: { repo: 'https://github.com/DOI-USGS/ale', commit: commits.ale, licence: 'public domain (USGS) / CC0-1.0' },
    json: { repo: 'https://github.com/nlohmann/json', commit: commits.json, licence: 'MIT' },
  },
  cflags: CFLAGS,
  ldflags: LDFLAGS,
  imports,
  sources: Object.fromEntries(SOURCES.map((f) => [relative(f.startsWith(SRC) ? dirname(SRC) : join(here, '..', '..'), f).replace(/\\/g, '/'), sha(readFileSync(f))])),
  headers: {
    compat: sha(readFileSync(join(here, 'compat', 'emscripten.h'))),
    'nlohmann/json.hpp': sha(readFileSync(join(SRC, 'json', 'single_include', 'nlohmann', 'json.hpp'))),
  },
};
const manPath = OUT.replace(/\.wasm$/, '.json');
if (VERIFY) {
  const old = JSON.parse(readFileSync(manPath, 'utf8'));
  if (old.output.sha256 !== manifest.output.sha256) throw new Error(`rebuild differs: ${manifest.output.sha256} vs pinned ${old.output.sha256}`);
  console.log('verify: the rebuild matches the pinned module byte for byte');
} else {
  writeFileSync(OUT, bytes);
  writeFileSync(manPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${OUT} and ${manPath}`);
}
