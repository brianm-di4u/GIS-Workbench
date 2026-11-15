// Where the folders beside the main checkout are (Research, TE-tools, Docs). A worktree anywhere
// finds them through git's common dir (<main>/.git, two levels below the folder that holds them).
// GWB_SAMPLES overrides the samples folder. Shared by the e2e suites, the golden tests, the tools,
// the build scripts and the fixtures (#296, #299); crates/test-support/research.rs is the Rust
// twin and build/fixtures/fx07.py the Python one.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const gitCommonDir = () => execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8' }).trim();

/** The folder `name` beside the main checkout. */
export function siblingDir(name, commonDir = gitCommonDir) {
  try {
    return resolve(commonDir(), '..', '..', name);
  } catch {
    return resolve(REPO, '..', name);
  }
}

export function samplesDir(env = process.env, commonDir = gitCommonDir) {
  return env.GWB_SAMPLES ? resolve(env.GWB_SAMPLES) : resolve(siblingDir('Research', commonDir), 'samples');
}
