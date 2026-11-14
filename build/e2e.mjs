// The full e2e gate in two passes (PT-13): the browser suites with no sidecar running, then the
// sidecar suites with their test sidecar. One pass would let the browser sweeps, which run every
// command, reach the test sidecar and use up its pairing rate limit. Extra arguments go to both.
//
// It tests the bits it says it tests, with the data they need. It refuses at once when the Research
// samples are missing. It builds dist/ first (strict), unless GW_DIST or GWB_DIST points the suites
// at another build. It builds the sidecar from this checkout into this checkout's own target and
// points the harness there, since the harness runs whatever binary sits in its target folder (a
// binary named in GWB_SIDECAR_EXE is refused if older than this checkout's sidecar sources). It
// refuses a build that lacks a pack (its inputs weren't fetched) or whose manifest names a pack file
// not there. And it records the app build id and the sidecar's SHA-256 in reports/e2e-bits.json
// and in its output, which verify keeps as the e2e evidence.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cargoTargetDir } from './cargo-target.mjs';
import { pathToFileURL } from 'node:url';

/** Why `exe` can't be the sidecar under test, or null. Times are in milliseconds. */
export function staleSidecar({ exe, exeTime, newestSource }) {
  if (exeTime == null) return `there is no sidecar at ${exe}.`;
  if (newestSource != null && exeTime < newestSource) {
    return `the sidecar at ${exe} (${new Date(exeTime).toISOString()}) is older than this checkout's newest sidecar source (${new Date(newestSource).toISOString()}). Build it again, or leave GWB_SIDECAR_EXE unset to have e2e build it.`;
  }
  return null;
}

const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
};

/** Is `path` (repo-relative, forward slashes) an input of gwb-sidecar.exe: its crate's sources (not its other binaries), gwb-sidecar-api's, or a manifest? */
export const sidecarInput = (path) =>
  ['sidecar/Cargo.toml', 'sidecar/Cargo.lock', 'sidecar/gwb-sidecar/Cargo.toml', 'sidecar/gwb-sidecar-api/Cargo.toml'].includes(path) ||
  (/^sidecar\/gwb-sidecar(-api)?\/src\/.*\.rs$/.test(path) && !path.startsWith('sidecar/gwb-sidecar/src/bin/'));

/**
 * The newest change to this checkout's inputs of gwb-sidecar.exe, by file time, as cargo judges them:
 * a commit time says nothing about when the code reached this checkout. Used only for a binary named
 * in GWB_SIDECAR_EXE; a binary e2e built itself is as current as cargo made it.
 */
export function newestSidecarSource() {
  const inputs = git(['ls-files', '--', 'sidecar']).split('\n').filter((path) => sidecarInput(path) && existsSync(path));
  return Math.max(0, ...inputs.map((path) => statSync(path).mtimeMs)) || null;
}

const MUSL = 'x86_64-unknown-linux-musl';

/**
 * This checkout's own sidecar target: never the machine-wide one the harness defaults to, where
 * another worktree's build could pass for this one (#42, #220). Under GWB_CARGO_TARGET, this
 * checkout's folder there; else sidecar/target.
 */
function sidecarTarget() {
  const base = cargoTargetDir() ?? resolve('sidecar', 'target');
  return process.platform === 'linux' ? join(base, MUSL) : base;
}

/** Build the sidecar and its stereo viewer into GWB_SIDECAR_TARGET from this checkout. Cargo rebuilds only what changed. */
function buildSidecar(target) {
  const linux = process.platform === 'linux';
  // The viewer is built for Windows only in this release; the harness runs it from beside the sidecar.
  const args = ['build', '--locked', '--release', '-p', 'gwb-sidecar', ...(linux ? ['--target', MUSL] : ['-p', 'gwb-stereo'])];
  return spawnSync('cargo', args, { cwd: 'sidecar', stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: linux ? dirname(target) : target } }).status;
}

/** Why a build can't be tested in full: packs a full build makes that it lacks, or packs it names whose file isn't there. */
export function missingPacks({ manifest, expected, packsDir, exists = existsSync }) {
  if (!manifest) return ['the build has no manifest'];
  return [
    ...expected.filter((name) => !manifest[name]).map((name) => `pack "${name}" was not built (run node build/packs.mjs --fetch, then build again)`),
    ...Object.entries(manifest).filter(([, p]) => !exists(join(packsDir, p.file))).map(([name, p]) => `pack "${name}" is in the manifest but ${p.file} is not in ${packsDir}`),
  ];
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function main() {
  const { DIST, DIST_DIR, SAMPLES } = await import('../tests/e2e/helpers.js');
  if (!existsSync(SAMPLES)) {
    console.error(`e2e: the Research samples are not at ${SAMPLES}. Set GWB_SAMPLES, or the data tests would fail after hours.`);
    return 1;
  }
  // e2e builds the sidecar into this checkout's own target, and both passes find it there; the
  // harness reads GWB_SIDECAR_TARGET when first imported. A binary named in GWB_SIDECAR_EXE, or a
  // target named in GWB_SIDECAR_TARGET, is the caller's.
  const ownSidecar = !process.env.GWB_SIDECAR_EXE;
  if (ownSidecar && !process.env.GWB_SIDECAR_TARGET) process.env.GWB_SIDECAR_TARGET = sidecarTarget();
  // GW_DIST or GWB_DIST points both passes at another build. GWB_DIST_DIR reaches only the sidecar
  // pass, so on its own it would split the two passes across two builds.
  const otherBuild = process.env.GW_DIST || process.env.GWB_DIST;
  const { DIST_DIR: sidecarDist } = await import('../tests/e2e/sidecar/harness.js');
  if (sidecarDist !== DIST_DIR) {
    console.error(`e2e: the sidecar pass would serve ${sidecarDist} but the browser pass tests ${DIST_DIR}. Set GW_DIST to the same build.`);
    return 1;
  }
  if (!otherBuild) {
    const built = spawnSync(process.execPath, ['build/build.mjs', '--strict'], { stdio: 'inherit' }).status;
    if (built !== 0) {
      console.error('e2e: the strict build failed, so there is nothing current to test.');
      return 1;
    }
  }
  const manifestText = /<script type="application\/json" id="build-manifest">([\s\S]*?)<\/script>/.exec(readFileSync(DIST, 'utf8'))?.[1];
  const { PACKS } = await import('./packs.mjs');
  const lacking = missingPacks({ manifest: manifestText ? JSON.parse(manifestText).packs : null, expected: PACKS, packsDir: join(DIST_DIR, 'packs') });
  if (lacking.length > 0) {
    console.error(`e2e: ${DIST} can't be tested in full:\n  ${lacking.join('\n  ')}`);
    return 1;
  }
  const { EXE } = await import('../tests/e2e/sidecar/harness.js');
  if (ownSidecar && buildSidecar(process.env.GWB_SIDECAR_TARGET) !== 0) {
    console.error('e2e: the sidecar build failed, so there is no current sidecar to test.');
    return 1;
  }
  const exeTime = existsSync(EXE) ? statSync(EXE).mtimeMs : null;
  // Cargo has just made e2e's own binary current; a caller's binary is checked for its age.
  const stale = staleSidecar({ exe: EXE, exeTime, newestSource: ownSidecar ? null : newestSidecarSource() });
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
