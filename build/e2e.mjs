// The full e2e gate in two passes (PT-13): the browser suites with no sidecar running, then the
// sidecar suites with their test sidecar. One pass would let the browser sweeps, which run every
// command, reach the test sidecar and use up its pairing rate limit. Extra arguments go to both.
//
// It tests the bits it says it tests. It builds dist/ first (strict), unless GW_DIST, GWB_DIST or
// GWB_DIST_DIR points the suites at another build. It refuses a sidecar binary older than the newest
// change to sidecar/, since the harness runs whatever binary sits in the target folder. And it
// records the app build id and the sidecar's SHA-256 in reports/e2e-bits.json and in its output,
// which verify keeps as the e2e evidence.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Why `exe` can't be the sidecar under test, or null. Times are in milliseconds. */
export function staleSidecar({ exe, exeTime, newestSource }) {
  if (exeTime == null) return `there is no sidecar at ${exe}. Build it with cargo build --release in sidecar/ (CARGO_TARGET_DIR as the harness expects), or set GWB_SIDECAR_EXE.`;
  if (newestSource != null && exeTime < newestSource) {
    return `the sidecar at ${exe} (${new Date(exeTime).toISOString()}) is older than the newest change to sidecar/ (${new Date(newestSource).toISOString()}). Build it again, or the sidecar suites would test old code.`;
  }
  return null;
}

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
};

/** The newest change to the sidecar's code: its last commit, or a later edit not yet committed. */
export function newestSidecarSource() {
  const committed = Number(git(['log', '-1', '--format=%ct', '--', 'sidecar']).trim()) * 1000 || null;
  const edited = git(['status', '--porcelain', '--', 'sidecar'])
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => path && existsSync(path))
    .map((path) => statSync(path).mtimeMs);
  return Math.max(committed ?? 0, ...edited) || null;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function main() {
  const otherBuild = process.env.GW_DIST || process.env.GWB_DIST || process.env.GWB_DIST_DIR;
  if (!otherBuild) {
    const built = spawnSync(process.execPath, ['build/build.mjs', '--strict'], { stdio: 'inherit' }).status;
    if (built !== 0) {
      console.error('e2e: the strict build failed, so there is nothing current to test.');
      return 1;
    }
  }
  const { DIST } = await import('../tests/e2e/helpers.js');
  const { EXE } = await import('../tests/e2e/sidecar/harness.js');
  const exeTime = existsSync(EXE) ? statSync(EXE).mtimeMs : null;
  const stale = staleSidecar({ exe: EXE, exeTime, newestSource: newestSidecarSource() });
  if (stale) {
    console.error(`e2e: ${stale}`);
    return 1;
  }
  const bits = {
    app: { file: DIST, build: /<meta name="gw-build" content="([^"]+)"/.exec(readFileSync(DIST, 'utf8'))?.[1] ?? null, rebuilt: !otherBuild },
    sidecar: { file: EXE, sha256: sha256(EXE), modified: new Date(exeTime).toISOString() },
  };
  mkdirSync('reports', { recursive: true });
  writeFileSync(join('reports', 'e2e-bits.json'), `${JSON.stringify(bits, null, 2)}\n`);
  console.log(`e2e bits: app build ${bits.app.build} (${DIST}), sidecar sha256 ${bits.sidecar.sha256} (${EXE})`);

  const cli = 'node_modules/@playwright/test/cli.js';
  const extra = process.argv.slice(2);
  const pass = (projects, env = {}) =>
    spawnSync(process.execPath, [cli, 'test', ...projects.flatMap((p) => ['--project', p]), ...extra], { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

  const browsers = process.platform === 'linux' ? ['chrome'] : ['chrome', 'edge'];
  const sidecars = process.platform === 'linux' ? ['sidecar'] : ['sidecar', 'sidecar-edge'];
  const a = pass(browsers);
  const b = pass(sidecars, { GW_E2E_JSON: `reports/sidecar/e2e-${process.platform === 'linux' ? 'linux' : 'win'}.json` });
  return a || b;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
