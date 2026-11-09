// GeographicLib GeoidEval as an oracle (REG-024, SCN-71): undulations from GeographicLib's own
// grids and cubic interpolation. GW_GEOGRAPHICLIB: the folder holding GeoidEval (default: the
// gw-geographiclib conda env, conda-forge geographiclib-cpp 2.6); GW_GEOIDS: the folder holding
// GeographicLib's geoid grids (egm2008-1.pgm, egm2008-2_5.pgm; default .cache/geoids).
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = process.env.GW_GEOGRAPHICLIB ?? 'C:/GIS Workbench/TE-tools/mamba/envs/gw-geographiclib/Library/bin';
const DIR = resolve(process.env.GW_GEOIDS ?? '.cache/geoids');
const EXE = join(BIN, process.platform === 'win32' ? 'GeoidEval.exe' : 'GeoidEval');

/** True when GeoidEval and the named grid (egm2008-1, egm2008-2_5 …) are present. */
export const haveGeoidEval = (name) => existsSync(EXE) && existsSync(join(DIR, `${name}.pgm`));

/** N (m, to 0.1 mm as GeoidEval prints it) at [lat, lon] points, cubic unless `linear`. */
export function geoidEval(name, pts, { linear = false } = {}) {
  // Fixed notation: GeoidEval refuses some numbers JS prints with an exponent ("1e-9 164.999999999").
  const input = pts.map(([lat, lon]) => `${lat.toFixed(12)} ${lon.toFixed(12)}`).join('\n') + '\n';
  const env = { ...process.env, PATH: `${BIN}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
  const out = execFileSync(EXE, ['-n', name, '-d', DIR, ...(linear ? ['-l'] : [])], { input, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  return out.trim().split(/\r?\n/).map(Number);
}

/** `n` points uniform on the sphere, deterministic (seeded LCG), as [lat, lon]. */
export function randomPoints(n, seed = 7) {
  let s = seed;
  const r = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: n }, () => [(Math.asin(2 * r() - 1) * 180) / Math.PI, r() * 360 - 180]);
}
