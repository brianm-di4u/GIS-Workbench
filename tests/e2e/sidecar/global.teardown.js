// Teardown project: stop the test sidecar (its tools die with it: Job Objects, kill on close).
import { test as teardown } from '@playwright/test';
import { existsSync } from 'node:fs';
import { STATE, state, stopSidecar } from './harness.js';

teardown('stop the test sidecar', async () => {
  if (existsSync(STATE)) stopSidecar(state().pid);
});
