// Which cargo target directory this checkout uses. A machine-wide CARGO_TARGET_DIR is shared by
// every worktree and session, so a build from one commit overwrites another's WASM and a test
// binary built in a deleted worktree gets reused (#42). By default the user's CARGO_TARGET_DIR is
// ignored and cargo uses the checkout's own `crates/target` and `sidecar/target` (both gitignored).
// GWB_CARGO_TARGET=<dir> opts in to keeping build output under <dir>, for example on another
// drive. Each checkout still gets its own subfolder there, named from its root, because two
// worktrees on different commits sharing one target reuse each other's crates (#220). Nothing
// removes those folders: delete one once its worktree is gone. Only this process and its children
// are changed; the user's environment is not.
//
//   node build/cargo-target.mjs cargo test -p gw-core    run a command with the scoped target
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** This checkout's folder under GWB_CARGO_TARGET: its name and a short hash of its root. */
function checkoutFolder(root) {
  const dir = resolve(root);
  const key = process.platform === 'win32' ? dir.toLowerCase() : dir; // C:\ and c:\ are one checkout
  return `${basename(dir)}-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
}

/** The CARGO_TARGET_DIR to export: this checkout's folder under GWB_CARGO_TARGET, or null to use cargo's per-workspace default. */
export function cargoTargetDir(env = process.env, root = ROOT) {
  return env.GWB_CARGO_TARGET ? join(resolve(env.GWB_CARGO_TARGET), checkoutFolder(root)) : null;
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
