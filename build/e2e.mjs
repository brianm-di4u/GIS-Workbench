// The full e2e gate in two passes (PT-13): the browser suites with no sidecar running, then the
// sidecar suites with their test sidecar. One pass would let the browser sweeps, which run every
// command, reach the test sidecar and use up its pairing rate limit. Extra arguments go to both.
import { spawnSync } from 'node:child_process';

const cli = 'node_modules/@playwright/test/cli.js';
const extra = process.argv.slice(2);
const pass = (projects, env = {}) =>
  spawnSync(process.execPath, [cli, 'test', ...projects.flatMap((p) => ['--project', p]), ...extra], { stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;

const browsers = process.platform === 'linux' ? ['chrome'] : ['chrome', 'edge'];
const sidecars = process.platform === 'linux' ? ['sidecar'] : ['sidecar', 'sidecar-edge'];
const a = pass(browsers);
const b = pass(sidecars, { GW_E2E_JSON: `reports/sidecar/e2e-${process.platform === 'linux' ? 'linux' : 'win'}.json` });
process.exit(a || b);
