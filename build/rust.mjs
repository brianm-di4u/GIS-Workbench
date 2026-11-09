// Build every Rust bundle for wasm32-unknown-unknown (Appendix D §4): cargo release build
// with SIMD128, optional wasm-opt, then size, import and licence checks. Returns one entry
// per bundle for the inliner.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { wasmGate, crateLicenceGate, determinismGate, WASM_TOTAL_BUDGET } from './gates.mjs';
import { scopeCargoTarget } from './cargo-target.mjs';

// Every cargo call below, and build.mjs's, uses this checkout's target directory (#42).
scopeCargoTarget();

export const BUNDLES = [
  { name: 'core', crate: 'gw-bundle-core', load: 'eager', budget: 250 * 1024, opt: '3' },
  { name: 'parse', crate: 'gw-bundle-parse', load: 'lazy', budget: 200 * 1024, opt: 'z' },
  { name: 'j2k', crate: 'gw-bundle-j2k', load: 'lazy', budget: 300 * 1024, opt: '3' },
  // 2.5: + LiDAR registration and the joint adjustment (REQ-GAP-46, 160 KB), + the aerial triangulation (gw-aero, built for size: about 57 KB gzip; REQ-GAP-22).
  { name: 'photo', crate: 'gw-bundle-photo', load: 'lazy', budget: 240 * 1024, opt: '3' },
  { name: 'raster', crate: 'gw-bundle-raster', load: 'lazy', budget: 150 * 1024, opt: '3' },
  { name: 'terrain', crate: 'gw-bundle-terrain', load: 'lazy', budget: 80 * 1024, opt: '3' },
  { name: 'pointcloud', crate: 'gw-bundle-pointcloud', load: 'lazy', budget: 120 * 1024, opt: 's' },
  { name: 'vector', crate: 'gw-bundle-vector', load: 'lazy', budget: 80 * 1024, opt: 's' },
  { name: 'sar', crate: 'gw-bundle-sar', load: 'lazy', budget: 100 * 1024, opt: 's' },
  { name: 'spectral', crate: 'gw-bundle-spectral', load: 'lazy', budget: 100 * 1024, opt: 's' },
  // 2.1 format closure (Appendix D §2.2.1): legacy readers and tiled-format codecs, both lazy.
  { name: 'legacy', crate: 'gw-bundle-legacy', load: 'lazy', budget: 200 * 1024, opt: 's' },
  { name: 'tiles', crate: 'gw-bundle-tiles', load: 'lazy', budget: 140 * 1024, opt: 's' },
  // Brotli for PMTiles (FC-06): its RFC 7932 dictionary is most of it, so it loads only for Brotli archives.
  { name: 'brotli', crate: 'gw-bundle-brotli', load: 'lazy', budget: 110 * 1024, opt: 'z' },
  // MPEG program streams and MPEG-1 video (FC-22), split from legacy to keep both within budget;
  // MPEG-2 video (REQ-GAP-48) since 2.4. Speed-optimised: at opt 's' 1080p MPEG-2 decoded at
  // 0.43× real time, at opt 3 at 2.6× (S-58, docs/validation/2.4/motion.md); S-58 caps it at 300 KB.
  { name: 'mpeg', crate: 'gw-bundle-mpeg', load: 'lazy', budget: 96 * 1024, opt: '3' },
  // 2.4 (REQ-GAP-16): grid datum/height transformations and time-dependent frames, main thread,
  // loaded with the first grid pack or frame transformation.
  // binaryen 133 asserts in constraint-analysis (constraint.cpp:1223, inside inlining-optimizing)
  // on this module at -O3/-Os/-Oz; skipping that one pass keeps the rest of -Oz.
  // 2.5 (REQ-GAP-20): vendor sensor-metadata readers, analysis worker, loaded with the first vendor model.
  { name: 'vendor', crate: 'gw-bundle-vendor', load: 'lazy', budget: 64 * 1024, opt: 'z' },
  { name: 'geod', crate: 'gw-bundle-geod', load: 'lazy', budget: 72 * 1024, opt: 'z', wasmSkip: ['constraint-analysis'] },
  // 2.5 (REQ-GAP-39): TIN editing — constrained Delaunay, breaklines, ridge and drain profiles, TIN to
  // grid, LandXML and point-text readers. Main thread (edits, display) and analysis worker (builds).
  // Size-optimised: opt 3 was 130 KB gzip, 'z' 91 KB (docs/validation/2.5/tin.md).
  { name: 'tin', crate: 'gw-bundle-tin', load: 'lazy', budget: 96 * 1024, opt: 'z' },
  // 2.5 (REQ-GAP-73): airfield obstruction surfaces (FAA Part 77, ICAO Annex 14), analysis worker.
  // 2.7 (REQ-GAP-78, #60): Amendment 18's 2030 OFS/OES as a third regime; 64 KiB by OD-2.41. Kept at
  // opt 3: at 's' gw_obs_points64 over fx09.las (1.0 M points under HOU 13R) was 6 % (Part 77), 12 %
  // (Annex 14) and 9-41 % (Amendment 18) slower, against SDP-2.7 §4.6's 10 % allowance; 's' would
  // save 1.5 KB of 52 KB gzip.
  { name: 'aviation', crate: 'gw-bundle-aviation', load: 'lazy', budget: 64 * 1024, opt: '3' },
  // 2.7.0 vector geoprocessing (REQ-GAP-79): buffer and dissolve on i_overlay, which alone is about
  // 51 KB gzip with its boolean engine and 68 KB with offsets and strokes at opt z (validation/2.7).
  { name: 'geoproc', crate: 'gw-bundle-geoproc', load: 'lazy', budget: 96 * 1024, opt: 'z' },
];
export const TOTAL_BUDGET = WASM_TOTAL_BUDGET;

function targetDir(cratesDir) {
  const out = execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: cratesDir, encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out).target_directory;
}

export function buildRust(root, { log = console.log, strict = false } = {}) {
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
  // --strict: CI has to test what ships, so a missing tool is a failure rather than a note.
  if (strict && !wasmOpt) errors.push('rust: --strict needs wasm-opt');
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
      const r = spawnSync('wasm-opt', [`-O${b.opt === 'z' ? 'z' : '3'}`, ...features, ...(b.wasmSkip ?? []).map((p) => `--skip-pass=${p}`), '--strip-debug', '--strip-producers', file, '-o', out], { encoding: 'utf8' });
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
  if (strict && deny.error) errors.push('rust: --strict needs cargo-deny');
  const notices = rustNotices(crates);
  errors.push(...crateLicenceGate(notices));
  return { bundles: results, totalGzip: total, licenceGate, errors, rustNotices: notices };
}

/** Licence summary of third-party crates linked into the bundles (for the notices block). */
export function rustNotices(crates) {
  try {
    const out = execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', 'wasm32-unknown-unknown'], { cwd: crates, encoding: 'utf8', maxBuffer: 64 << 20 });
    const meta = JSON.parse(out);
    const ws = new Set(meta.workspace_members);
    return meta.packages.filter((p) => !ws.has(p.id)).map((p) => ({ name: p.name, version: p.version, license: p.license ?? 'unknown', repository: p.repository ?? '' }));
  } catch {
    return [];
  }
}
