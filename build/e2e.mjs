// The full e2e gate in two passes (PT-13): the browser suites with no sidecar running, then the
// sidecar suites with their test sidecar. One pass would let the browser sweeps, which run every
// command, reach the test sidecar and use up its pairing rate limit. Extra arguments go to both.
//
// It tests the bits it says it tests, with the data they need, and checks every prerequisite
// before the hours of tests rather than letting them find one gap per run: the Research samples,
// the module bundle (asked of a test sidecar: every module, the HDF4, MrSID and ECW plug-ins), the
// native stereo viewer beside the sidecar, and every pack. It builds the sidecar from this checkout
// into this checkout's own target and points the harness there, since the harness runs whatever
// binary sits in its target folder; cargo decides what is current. It builds dist/ (strict),
// unless GW_DIST or GWB_DIST points the suites at another build. And it records the app build id
// and the SHA-256 of each native binary in reports/e2e-bits.json and in its output, which verify
// keeps as the e2e evidence. A binary it didn't build (GWB_SIDECAR_EXE, the relay build) is marked
// there as outside this run's build.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cargoTargetDir } from './cargo-target.mjs';
import { pathToFileURL } from 'node:url';

/**
 * What a module bundle lacks for the sidecar suites, from the test sidecar's /v1/caps: every module
 * (not OpenH264, the user's own download), GDAL's HDF4 plug-ins, and on Windows the MrSID and ECW
 * plug-ins. On Linux only Core GDAL and HDF4: the vendor plug-ins are Windows only (P16).
 */
export function bundleProblems(caps, { linux = false } = {}) {
  if (!caps) return ['the test sidecar gave no caps'];
  const needed = (m) => (linux ? m.id === 'core-gdal' : m.id !== 'vendor-openh264');
  return [
    ...(caps.modules ?? []).filter((m) => needed(m) && !m.installed).map((m) => `module "${m.id}" is not installed`),
    ...['HDF4', 'HDF4Image'].filter((d) => !(caps.raster_drivers ?? []).some((r) => r.name === d)).map((d) => `GDAL has no ${d} driver (the HDF4 plug-ins)`),
    ...(linux ? [] : ['vendor-mrsid', 'vendor-ecw']).filter((id) => !caps.vendor?.find((v) => v.id === id)?.installed).map((id) => `the ${id} plug-ins are not loaded`),
  ];
}

/**
 * Start the test sidecar on its own port and ask it what the bundle provides. GDAL lists its
 * drivers some seconds after the sidecar starts (16 s on a busy machine), so wait for that list,
 * unless Core GDAL is missing and it will never come.
 */
export async function probeBundle() {
  const { startSidecar, stopSidecar, DATA_ROOT, MODULES } = await import('../tests/e2e/sidecar/harness.js');
  let s = null;
  try {
    s = await startSidecar({ dataDir: resolve(DATA_ROOT, 'preflight'), port: 47839 }); // a port no suite uses
    let caps = null;
    for (const until = Date.now() + 120_000; Date.now() < until; await new Promise((r) => setTimeout(r, 1000))) {
      caps = await fetch(`${s.base}/v1/caps`, { headers: { Origin: 'null', Authorization: `Bearer ${s.token}` } }).then((r) => r.json()).catch(() => null);
      if (caps?.raster_drivers?.length || caps?.modules?.some((m) => m.id === 'core-gdal' && !m.installed)) break;
    }
    return bundleProblems(caps, { linux: process.platform === 'linux' }).map((p) => `${p}, with the bundle at ${MODULES}`);
  } catch (error) {
    return [`the test sidecar would not start: ${error.message}`];
  } finally {
    if (s) stopSidecar(s.pid);
  }
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

/** Print every problem a preflight stage found, and say whether to stop. */
function refuse(problems) {
  if (problems.length === 0) return false;
  console.error(`e2e can't start:\n  - ${problems.join('\n  - ')}`);
  return true;
}

/** A native binary as the evidence records it: its SHA-256, and whether this run built it. */
export const binary = (file, built, outside) => ({ file, sha256: sha256(file), built, ...(built ? {} : { note: `outside this run's build: ${outside}` }) });

async function main() {
  // e2e builds the sidecar into this checkout's own target, and both passes find it there; the
  // harness reads GWB_SIDECAR_TARGET when first imported. A binary named in GWB_SIDECAR_EXE is the
  // caller's, tested as it is and recorded as outside this run's build.
  const ownSidecar = !process.env.GWB_SIDECAR_EXE;
  if (ownSidecar && !process.env.GWB_SIDECAR_TARGET) process.env.GWB_SIDECAR_TARGET = sidecarTarget();
  const { DIST, DIST_DIR, SAMPLES } = await import('../tests/e2e/helpers.js');
  const { DIST_DIR: sidecarDist, EXE, MODULES, RELAY_EXE } = await import('../tests/e2e/sidecar/harness.js');

  // The gate's prerequisites, checked before hours of tests rather than discovered by them, each
  // stage listing everything it found. First what takes seconds.
  const problems = [];
  if (!existsSync(SAMPLES)) problems.push(`the Research samples are not at ${SAMPLES}. Set GWB_SAMPLES.`);
  if (!existsSync(MODULES)) problems.push(`there is no module bundle at ${MODULES}. Set GWB_SIDECAR_MODULES.`);
  // GW_DIST or GWB_DIST points both passes at another build. GWB_DIST_DIR reaches only the sidecar
  // pass, so on its own it would split the two passes across two builds.
  if (sidecarDist !== DIST_DIR) problems.push(`the sidecar pass would serve ${sidecarDist} but the browser pass tests ${DIST_DIR}. Set GW_DIST to the same build.`);
  if (refuse(problems)) return 1;

  // Then the sidecar: cargo rebuilds only what changed, so this is quick when it is current.
  if (ownSidecar && buildSidecar(process.env.GWB_SIDECAR_TARGET) !== 0) return refuse(['the sidecar build failed, so there is no current sidecar to test.']) && 1;
  const noSidecar = !existsSync(EXE);
  if (noSidecar) problems.push(`there is no sidecar at ${EXE}.`);
  const viewer = join(dirname(EXE), 'gwb-stereo-viewer.exe');
  if (process.platform === 'win32' && !existsSync(viewer)) problems.push(`the native stereo viewer is not beside the sidecar, at ${viewer}.`);
  if (!noSidecar) problems.push(...(await probeBundle()));
  if (refuse(problems)) return 1;

  // Last the app, which takes minutes to build.
  const otherBuild = process.env.GW_DIST || process.env.GWB_DIST;
  if (!otherBuild && spawnSync(process.execPath, ['build/build.mjs', '--strict'], { stdio: 'inherit' }).status !== 0) return refuse(['the strict build failed, so there is nothing current to test.']) && 1;
  const manifestText = existsSync(DIST) ? /<script type="application\/json" id="build-manifest">([\s\S]*?)<\/script>/.exec(readFileSync(DIST, 'utf8'))?.[1] : null;
  const { PACKS } = await import('./packs.mjs');
  if (refuse(missingPacks({ manifest: manifestText ? JSON.parse(manifestText).packs : null, expected: PACKS, packsDir: join(DIST_DIR, 'packs') }).map((p) => `${DIST}: ${p}`))) return 1;
  const bits = {
    app: { file: DIST, build: /<meta name="gw-build" content="([^"]+)"/.exec(readFileSync(DIST, 'utf8'))?.[1] ?? null, rebuilt: !otherBuild },
    sidecar: binary(EXE, ownSidecar, 'named in GWB_SIDECAR_EXE'),
    // 26-native's shutdown tests run the test-only relay build, which e2e doesn't build.
    relay: existsSync(RELAY_EXE) ? binary(RELAY_EXE, false, 'the test-only relay build (GWB_SIDECAR_RELAY_EXE)') : null,
  };
  mkdirSync('reports', { recursive: true });
  writeFileSync(join('reports', 'e2e-bits.json'), `${JSON.stringify(bits, null, 2)}\n`);
  console.log(`e2e bits: app build ${bits.app.build} (${DIST}), sidecar sha256 ${bits.sidecar.sha256} (${EXE})`);
  for (const b of [bits.sidecar, bits.relay].filter((b) => b?.note)) console.log(`e2e bits: ${b.file} is ${b.note}; sha256 ${b.sha256}`);

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
