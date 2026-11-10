// Build steps whose output must depend only on the commit, not on the machine or the files left
// in the cargo target directory: the same commit builds the same HTML on Windows and Linux (#31).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * gzip at level 9 with the header's OS byte set to 255, "unknown" (RFC 1952). zlib writes the
 * build machine's own code there (10 on Windows, 3 on Unix), so the bytes differed by platform (#34).
 */
export function gzipStable(bytes) {
  const z = gzipSync(bytes, { level: 9 });
  z[9] = 255;
  return z;
}

/** Forget what a wasm-opt output was made from: call before wasm-opt rewrites it. */
export function unstampOptimised(opt) {
  rmSync(`${opt}.src`, { force: true });
}

/** Record, beside a finished wasm-opt output, the cargo bytes it was made from and its own bytes. */
export function stampOptimised(raw, opt) {
  writeFileSync(`${opt}.src`, `${sha256(readFileSync(raw))} ${sha256(readFileSync(opt))}\n`);
}

/**
 * The module to ship from a cargo output: its wasm-opt output when the record beside it names these
 * exact cargo bytes and these exact optimised bytes, else the cargo output itself. Chosen by
 * content, not file times, which a checkout, a copy or an interrupted build can reorder (#35).
 * `warn` hears why an optimised file that exists was not used.
 */
export function shippedWasm(raw, warn = () => {}) {
  const opt = `${raw}.opt.wasm`;
  if (!existsSync(opt)) return raw;
  const stamp = `${opt}.src`;
  const [src, out] = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim().split(' ') : [];
  if (src === sha256(readFileSync(raw)) && out === sha256(readFileSync(opt))) return opt;
  warn(existsSync(stamp) ? 'it was made from other cargo output, or changed after wasm-opt wrote it' : 'nothing records what it was made from');
  return raw;
}
