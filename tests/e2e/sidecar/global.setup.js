// Setup project of the `sidecar` Playwright projects: start one test sidecar for the run.
import { test as setup } from '@playwright/test';
import { resolve } from 'node:path';
import { startSidecar, saveState, DATA_ROOT } from './harness.js';

setup('start the test sidecar', async () => {
  setup.setTimeout(300_000); // the caps take minutes when the disk is busy
  // GWB_SIDECAR_PORT: another of the app's three ports, when something else holds the first.
  // GWB_SIDECAR_PICK: what "Pick in Sidecar" answers in this run, ; separated (26-csmhost.spec.js).
  const pick = (process.env.GWB_SIDECAR_PICK ?? '').split(';').filter(Boolean).flatMap((p) => ['--test-pick', p]);
  const s = await startSidecar({ dataDir: resolve(DATA_ROOT, 'sidecar-data'), port: Number(process.env.GWB_SIDECAR_PORT ?? 47821), extra: pick });
  saveState(s);
});
