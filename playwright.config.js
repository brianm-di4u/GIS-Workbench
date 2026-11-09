import { defineConfig } from '@playwright/test';
import { grepInvert, readQuarantine } from './build/check-quarantine.mjs';

// Linux (P16): Playwright's own Chromium stands in for Chrome; there is no Edge project.
const LINUX = process.platform === 'linux';
const chrome = LINUX ? {} : { channel: 'chrome' };
const CI = Boolean(process.env.CI);

// Tests that measure real time. A shared runner with no GPU can't run them fairly, so they stay in
// the local gate.
const TIMED = /REQ-FMT-52 FC-22|REQ-GAP-47 playback|REQ-GAP-48 (MPEG-2|S-58)|REQ-GAP-49 (SCN-55|AES-128|live sliding window)|REQ-PRF-01 interactive within|SCN-12 AT-12\.2|SCN-14 AT-14\.1|SCN-15 AT-15\.3|REQ-HOST-05 gestures|REQ-ING-04 a 100 000-feature layer/;
const QUARANTINED = CI ? grepInvert(readQuarantine()) : undefined;
const ON_RUNNERS = [TIMED, QUARANTINED].filter(Boolean);

// What `verify full` leaves to the nightly run and the release gate: the long sweeps, and the
// suites that need a real GPU.
const NOT_ON_PRS = ['**/sidecar/**', '**/gui-modern.spec.js', '**/gui-sweep.spec.js', '**/i18n.spec.js', '**/24-extai.spec.js', '**/perf.spec.js', '**/perf-r2.spec.js'];

// E2E on the BUILT file (SDP §6.4 Full stage): installed Chrome and Edge, 1440×900.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 4,
  // Flake policy: one retry in CI only, and known flakes are listed in tests/quarantine.json.
  // A local run never retries, so a flake stays visible to whoever is working on it.
  retries: CI ? 1 : 0,
  grepInvert: QUARANTINED,
  // GW_E2E_JSON: the sidecar pass of test:e2e writes its own report beside the browser one.
  reporter: [['list'], ['json', { outputFile: process.env.GW_E2E_JSON ?? 'reports/e2e.json' }]],
  use: {
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  projects: [
    // Every suite but the sidecar ones runs with no sidecar (PT-13).
    { name: 'chrome', use: chrome, testIgnore: '**/sidecar/**' },
    { name: 'ci', use: chrome, testIgnore: NOT_ON_PRS, grepInvert: ON_RUNNERS },
    { name: 'nightly', use: chrome, testIgnore: '**/sidecar/**', grepInvert: ON_RUNNERS },
    ...(LINUX ? [] : [{ name: 'edge', use: { channel: 'msedge' }, testIgnore: '**/sidecar/**' }]),
    // The optional sidecar (SDP-2.1 §7.5): a setup project starts a test sidecar with a test
    // pairing token; the teardown project stops it. Run: npx playwright test --project=sidecar
    { name: 'sidecar-setup', testMatch: /e2e[\\/]sidecar[\\/]global\.setup\.js$/, teardown: 'sidecar-teardown' },
    { name: 'sidecar-teardown', testMatch: /e2e[\\/]sidecar[\\/]global\.teardown\.js$/ },
    { name: 'sidecar', use: chrome, testMatch: /e2e[\\/]sidecar[\\/][^\\/]+\.spec\.js$/, dependencies: ['sidecar-setup'], workers: 1 },
    ...(LINUX ? [] : [{ name: 'sidecar-edge', use: { channel: 'msedge' }, testMatch: /e2e[\\/]sidecar[\\/][^\\/]+\.spec\.js$/, dependencies: ['sidecar-setup', 'sidecar'], workers: 1 }]), // one test sidecar: never beside the Chrome run
  ],
});
