// Size of one Rust bundle as the build ships it (cargo release wasm32 + wasm-opt with
// build/rust.mjs's passes and features, gzip -9), for size work on a single bundle:
//   node tests/tools/wasm-size.mjs photo
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { BUNDLES, remapCargoHome } from '../../build/rust.mjs';

const b = BUNDLES.find((x) => x.name === process.argv[2]);
if (!b) throw new Error(`no bundle ${process.argv[2]}`);
const crates = resolve('crates');
const env = { ...process.env, CARGO_PROFILE_RELEASE_OPT_LEVEL: b.opt };
const r = spawnSync('cargo', [...remapCargoHome(), 'build', '--release', '--target', 'wasm32-unknown-unknown', '-p', b.crate], { cwd: crates, env, stdio: ['ignore', 'inherit', 'inherit'] });
if (r.status !== 0) process.exit(1);
const meta = JSON.parse(spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: crates, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout);
const file = join(meta.target_directory, 'wasm32-unknown-unknown', 'release', `${b.crate.replace(/-/g, '_')}.wasm`);
const features = ['--enable-simd', '--disable-relaxed-simd', '--enable-bulk-memory', '--enable-bulk-memory-opt', '--enable-nontrapping-float-to-int', '--enable-sign-ext', '--enable-mutable-globals', '--enable-multivalue', '--enable-reference-types'];
const out = `${file}.size.wasm`;
const o = spawnSync('wasm-opt', [`-O${b.opt === 'z' ? 'z' : '3'}`, ...features, ...(b.wasmSkip ?? []).map((p) => `--skip-pass=${p}`), '--strip-debug', '--strip-producers', file, '-o', out], { encoding: 'utf8' });
const bytes = readFileSync(o.status === 0 ? out : file);
console.log(`${b.name}: ${bytes.length} B raw, ${gzipSync(bytes, { level: 9 }).length} B gzip${o.status === 0 ? '' : ' (wasm-opt failed)'}`);
