#!/usr/bin/env node
// Builds the sidecar's release packages: Windows here, Linux in WSL.
//
//   node build/release/sidecar.mjs --version 0.3.0 [--dist dist] [--out D:/gwb-sidecar-deps/release]
//        [--skip-windows] [--skip-linux]
//
// Windows runs sidecar/installer/package.mjs into <out>/<version>. Linux runs wsl-package.sh in the
// default WSL distribution, which copies its packages to <out>/<version>/linux. Earlier output is
// moved aside to a timestamped folder first, never deleted. Then run stage.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const version = arg('--version');
if (!version) {
  console.error('Usage: node build/release/sidecar.mjs --version <v> [--dist dist] [--out <dir>] [--skip-windows] [--skip-linux]');
  process.exit(2);
}
const dist = arg('--dist', 'dist');
const out = resolve(arg('--out', 'D:/gwb-sidecar-deps/release'));
const windows = !process.argv.includes('--skip-windows');
const linux = !process.argv.includes('--skip-linux');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const aside = (dir) => {
  if (!existsSync(dir)) return;
  renameSync(dir, `${dir}-${stamp}`);
  console.log(`Moved earlier output to ${dir}-${stamp}`);
};
aside(windows ? join(out, version) : join(out, version, 'linux'));

if (windows) {
  console.log('Windows packages...');
  execFileSync('node', [join(ROOT, 'sidecar', 'installer', 'package.mjs'), '--version', version, '--dist', dist, '--out', out], { cwd: ROOT, stdio: 'inherit' });
}
if (linux) {
  console.log('Linux packages, in WSL...');
  const wsl = (p) => execFileSync('wsl.exe', ['-e', 'wslpath', '-a', p], { encoding: 'utf8' }).trim();
  const repo = wsl(ROOT);
  execFileSync('wsl.exe', ['-e', 'bash', `${repo}/build/release/wsl-package.sh`, repo, version, dist, wsl(join(out, version, 'linux'))], { stdio: 'inherit' });
}
console.log(`Done. Next: node build/release/stage.mjs --sidecar-version ${version} --out <new folder>`);
