// Which cargo target directory this checkout uses. A machine-wide CARGO_TARGET_DIR is shared by
// every worktree and session, so a build from one commit overwrites another's WASM and a test
// binary built in a deleted worktree gets reused (#42). By default the user's CARGO_TARGET_DIR is
// ignored and cargo uses the checkout's own `crates/target` and `sidecar/target` (both gitignored).
// GWB_CARGO_TARGET=<dir> opts in to a shared directory. Only this process and its children are
// changed; the user's environment is not.
//
//   node build/cargo-target.mjs cargo test -p gw-core    run a command with the scoped target
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The CARGO_TARGET_DIR to export: the opted-in shared directory, or null to use cargo's per-workspace default. */
export function cargoTargetDir(env = process.env) {
  return env.GWB_CARGO_TARGET ? resolve(env.GWB_CARGO_TARGET) : null;
}

/** Applies cargoTargetDir to `env` (process.env by default) and returns it, for children to inherit. */
export function scopeCargoTarget(env = process.env) {
  const dir = cargoTargetDir(env);
  if (dir === null) delete env.CARGO_TARGET_DIR;
  else env.CARGO_TARGET_DIR = dir;
  return env;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const { status } = spawnSync(command, args, { stdio: 'inherit', cwd: process.cwd(), env: scopeCargoTarget({ ...process.env }) });
  process.exitCode = status ?? 1;
}
