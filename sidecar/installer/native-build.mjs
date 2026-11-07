// Shared by the small native builds of the sidecar (sidecar/csmhost/build.mjs,
// sidecar/ossim/build.mjs): on Windows the MSVC environment taken from vcvars64.bat, cmake and
// ninja run with it. Linux needs nothing here: the caller gives a conda compiler environment.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VSWHERE = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe';

/** The environment of a VS x64 developer prompt. */
export function msvcEnv() {
  const root = execFileSync(VSWHERE, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
  const bat = join(root, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!existsSync(bat)) throw new Error(`no ${bat}: install the C++ tools of Visual Studio`);
  const dir = join(tmpdir(), `gwb-vcenv-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const cmd = join(dir, 'env.cmd');
  writeFileSync(cmd, `@echo off\r\ncall "${bat}" >nul\r\nset\r\n`);
  const out = execFileSync('cmd.exe', ['/d', '/c', cmd], { encoding: 'utf8', maxBuffer: 1 << 24 });
  const env = { ...process.env };
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
}

/** Run a program; its output goes to this process's, and a failure ends the build. */
export function run(exe, args, opts = {}) {
  const r = spawnSync(exe, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${exe} ${args.slice(0, 4).join(' ')} failed (${r.status ?? r.error})`);
}
