#!/usr/bin/env node
// Build the CSM plug-in host and its mock plug-ins for the tests (REQ-GAP-25). Test-time only: no
// package holds any of this (sidecar/installer/gates.mjs refuses a stage that does).
//
//   node sidecar/csmhost/build.mjs --csm <CSM API 3.0.x source folder> --out <folder>
//
// Linux: run it in WSL with --env <a conda prefix holding gxx_linux-64 and cmake, ninja>.

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { msvcEnv, run } from '../installer/native-build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const CSM = resolve(arg('--csm', 'D:/gwb26/data-csmhost/src/x/csm-3.0.4'));
const OUT = resolve(arg('--out', 'D:/gwb26/data-csmhost/build/csmhost-win-install'));
const BUILD = resolve(arg('--build', `${OUT}-obj`));
const win = process.platform === 'win32';
let env = process.env;
const defs = [];
if (win) env = msvcEnv();
else {
  const e = resolve(arg('--env', `${process.env.HOME}/gwb/deps/ossim-build-env`));
  env = { ...process.env, PATH: `${e}/bin:${process.env.PATH}`, CC: `${e}/bin/x86_64-conda-linux-gnu-gcc`, CXX: `${e}/bin/x86_64-conda-linux-gnu-g++` };
}
mkdirSync(BUILD, { recursive: true });
run('cmake', ['-G', 'Ninja', '-S', here, '-B', BUILD, '-DCMAKE_BUILD_TYPE=Release', `-DCSM_SRC=${CSM.replaceAll('\\', '/')}`, `-DCMAKE_INSTALL_PREFIX=${OUT.replaceAll('\\', '/')}`, ...defs], { env });
run('ninja', ['-C', BUILD, 'install'], { env });
if (win) {
  // The runtime a plug-in shares with the host: an AppContainer reads only what is granted to it,
  // and System32 is, but a machine with no VC++ redistributable has none there.
  const redist = join(env.VCToolsRedistDir ?? '', 'x64');
  const crt = existsSync(redist) ? readdirSync(redist).find((d) => /^Microsoft\.VC\d+\.CRT$/.test(d)) : null;
  if (crt) for (const f of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) if (existsSync(join(redist, crt, f))) copyFileSync(join(redist, crt, f), join(OUT, f));
}
console.log(`built ${OUT}: ${readdirSync(OUT).join(' ')}`);
