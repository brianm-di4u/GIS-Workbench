// Where the Research samples are. They sit beside the main checkout, so a worktree anywhere finds
// them through git's common dir (<main>/.git, two levels below the folder that holds Research).
// GWB_SAMPLES overrides. Shared by the e2e suites, the golden tests, the tools and the fixtures (#296).
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

export function samplesDir(env = process.env, commonDir = () => execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim()) {
  if (env.GWB_SAMPLES) return resolve(env.GWB_SAMPLES);
  try {
    return resolve(commonDir(), '..', '..', 'Research', 'samples');
  } catch {
    return resolve(REPO, '..', 'Research', 'samples');
  }
}
