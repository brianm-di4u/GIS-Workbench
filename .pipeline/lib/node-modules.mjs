// Whether node_modules matches package-lock.json (issue 169). Each worktree has its own node_modules,
// and one rebased onto a main that moved a dependency still has the old one installed. verify then
// fails deep into a long queued run, for a reason that is the environment and not the change.
// npm records what it installed in node_modules/.package-lock.json, with the same `packages` keys.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Packages the lockfile wants that the install doesn't have, or has at another version. A package the
// lockfile marks optional, peer, or limited to some os or cpu may be legitimately absent, so only a
// version difference counts for those.
export function staleModules(lock, installed, limit = 5) {
  const have = installed?.packages ?? {};
  const out = [];
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (!path.startsWith('node_modules/') || entry.link) continue;
    const found = have[path];
    const optional = entry.optional || entry.devOptional || entry.peer || entry.os || entry.cpu;
    if (found ? found.version !== entry.version : !optional) out.push({ path, want: entry.version, have: found?.version ?? null });
    if (out.length >= limit) break;
  }
  return out;
}

// A message for the caller to print, or null when node_modules matches, or when there is nothing to compare.
export function installProblem(root = '.') {
  const lockFile = join(root, 'package-lock.json');
  if (!existsSync(lockFile)) return null;
  const record = join(root, 'node_modules', '.package-lock.json');
  const fix = 'Run: npm ci --ignore-scripts';
  if (!existsSync(record)) return `node_modules has no install record, so it can't match package-lock.json. ${fix}`;
  let stale;
  try {
    stale = staleModules(JSON.parse(readFileSync(lockFile, 'utf8')), JSON.parse(readFileSync(record, 'utf8')));
  } catch {
    return null; // Unreadable: say nothing rather than block a run on a check that can't tell.
  }
  if (stale.length === 0) return null;
  const list = stale.map((s) => `  ${s.path}: lockfile ${s.want ?? 'any'}, installed ${s.have ?? 'nothing'}`).join('\n');
  return `node_modules is out of date against package-lock.json:\n${list}\n${fix}`;
}
