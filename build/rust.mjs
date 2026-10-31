// Build every Rust bundle for wasm32-unknown-unknown (Appendix D §4): cargo release build
// with SIMD128, optional wasm-opt, then size, import and licence checks. Returns one entry
// per bundle for the inliner.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { wasmGate, crateLicenceGate, determinismGate, WASM_TOTAL_BUDGET } from './gates.mjs';

export const BUNDLES = [
  { name: 'core', crate: 'gw-bundle-core', load: 'eager', budget: 250 * 1024, opt: '3' },
  { name: 'parse', crate: 'gw-bundle-parse', load: 'lazy', budget: 200 * 1024, opt: 'z' },
  { name: 'j2k', crate: 'gw-bundle-j2k', load: 'lazy', budget: 300 * 1024, opt: '3' },
  { name: 'photo', crate: 'gw-bundle-photo', load: 'lazy', budget: 150 * 1024, opt: '3' },
  { name: 'raster', crate: 'gw-bundle-raster', load: 'lazy', budget: 150 * 1024, opt: '3' },
  { name: 'terrain', crate: 'gw-bundle-terrain', load: 'lazy', budget: 80 * 1024, opt: '3' },
  { name: 'pointcloud', crate: 'gw-bundle-pointcloud', load: 'lazy', budget: 120 * 1024, opt: 's' },
  { name: 'vector', crate: 'gw-bundle-vector', load: 'lazy', budget: 80 * 1024, opt: 's' },
  { name: 'sar', crate: 'gw-bundle-sar', load: 'lazy', budget: 100 * 1024, opt: 's' },
  { name: 'spectral', crate: 'gw-bundle-spectral', load: 'lazy', budget: 100 * 1024, opt: 's' },
];
export const TOTAL_BUDGET = WASM_TOTAL_BUDGET;

function targetDir(cratesDir) {
  const out = execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: cratesDir, encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out).target_directory;
}

export function buildRust(root, { log = console.log } = {}) {
  const crates = join(root, 'crates');
  const results = [];
  const errors = [];
  for (const b of BUNDLES) {
    const env = { ...process.env, CARGO_PROFILE_RELEASE_OPT_LEVEL: b.opt };
    const r = spawnSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '-p', b.crate], { cwd: crates, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cargo build ${b.crate} failed:\n${r.stderr}`);
  }
  const tdir = join(targetDir(crates), 'wasm32-unknown-unknown', 'release');
  const wasmOpt = spawnSync('wasm-opt', ['--version'], { encoding: 'utf8' }).status === 0;
  if (!wasmOpt) log('rust: wasm-opt not found; shipping cargo output unoptimised by binaryen (install binaryen to enable)');
  let total = 0;
  for (const b of BUNDLES) {
    const file = join(tdir, `${b.crate.replace(/-/g, '_')}.wasm`);
    if (!existsSync(file)) throw new Error(`missing ${file}`);
    let bytes = readFileSync(file);
    if (wasmOpt) {
      const out = `${file}.opt.wasm`;
      // The features rustc's wasm32 target emits by default (bulk memory, non-trapping float-to-int,
      // sign extension, mutable globals, multivalue, reference types) plus SIMD128 (REQ-RUST-11) and
      // not relaxed SIMD. With SIMD alone binaryen validated against the MVP and refused every module
      // (memory.copy), so wasm-opt had never run on a release.
      const features = ['--enable-simd', '--disable-relaxed-simd', '--enable-bulk-memory', '--enable-bulk-memory-opt', '--enable-nontrapping-float-to-int', '--enable-sign-ext', '--enable-mutable-globals', '--enable-multivalue', '--enable-reference-types'];
      const r = spawnSync('wasm-opt', [`-O${b.opt === 'z' ? 'z' : '3'}`, ...features, '--strip-debug', '--strip-producers', file, '-o', out], { encoding: 'utf8' });
      if (r.status === 0) bytes = readFileSync(out);
      else errors.push(`rust: wasm-opt rejected ${b.name}: ${(r.stderr || '').trim().split('\n')[0]}`);
    }
    const mod = new WebAssembly.Module(bytes);
    const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
    const gz = gzipSync(bytes, { level: 9 }).length;
    total += gz;
    results.push({ ...b, bytes, raw: bytes.length, gzip: gz, imports, exports: WebAssembly.Module.exports(mod).length, licence: 'Apache-2.0' });
  }
  errors.push(...wasmGate(results));
  errors.push(...determinismGate(results.map((r) => ({ name: r.name, bytes: r.bytes }))));
  // REQ-RUST-09: licence gate, when cargo-deny is installed.
  const deny = spawnSync('cargo', ['deny', '--all-features', 'check', 'licenses'], { cwd: crates, encoding: 'utf8' });
  const licenceGate = deny.error ? 'not run (cargo-deny unavailable)' : deny.status === 0 ? 'pass' : 'fail';
  if (licenceGate === 'fail') errors.push(`REQ-RUST-09: cargo-deny licences failed:\n${deny.stderr.slice(-2000)}`);
  const notices = rustNotices(crates);
  errors.push(...crateLicenceGate(notices));
  return { bundles: results, totalGzip: total, licenceGate, errors, rustNotices: notices };
}

/** Licence summary of third-party crates linked into the bundles (for the notices block). */
function rustNotices(crates) {
  try {
    const out = execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown'], { cwd: crates, encoding: 'utf8', maxBuffer: 64 << 20 });
    const meta = JSON.parse(out);
    const ws = new Set(meta.workspace_members);
    return meta.packages.filter((p) => !ws.has(p.id)).map((p) => ({ name: p.name, version: p.version, license: p.license ?? 'unknown', repository: p.repository ?? '' }));
  } catch {
    return [];
  }
}
