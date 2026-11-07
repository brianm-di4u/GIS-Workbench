import { defineConfig } from '@playwright/test';
import { grepInvert, readQuarantine } from './build/check-quarantine.mjs';

// Linux (P16): Playwright's own Chromium stands in for Chrome; there is no Edge project.
const LINUX = process.platform === 'linux';
const chrome = LINUX ? {} : { channel: 'chrome' };
const CI = Boolean(process.env.CI);

// What `verify full` leaves to the nightly run and the release gate: the long sweeps, and the
// suites that need a real GPU or measure timing, which a shared runner can't do fairly.
const NOT_ON_PRS = ['**/sidecar/**', '**/gui-modern.spec.js', '**/gui-sweep.spec.js', '**/i18n.spec.js', '**/24-extai.spec.js', '**/perf.spec.js', '**/perf-r2.spec.js'];

// E2E on the BUILT file (SDP §6.4 Full stage): installed Chrome and Edge, 1440×900.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 4,
  // Flake policy: one retry in CI only, and known flakes are listed in tests/quarantine.json.
  // A local run never retries, so a flake stays visible to whoever is working on it.
  retries: CI ? 1 : 0,
  grepInvert: CI ? grepInvert(readQuarantine()) : undefined,
  // GW_E2E_JSON: the sidecar pass of test:e2e writes its own report beside the browser one.
  reporter: [['list'], ['json', { outputFile: process.env.GW_E2E_JSON ?? 'reports/e2e.json' }]],
  use: {
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  projects: [
    // Every suite but the sidecar ones runs with no sidecar (PT-13).
    { name: 'chrome', use: chrome, testIgnore: '**/sidecar/**' },
    { name: 'ci', use: chrome, testIgnore: NOT_ON_PRS },
    ...(LINUX ? [] : [{ name: 'edge', use: { channel: 'msedge' }, testIgnore: '**/sidecar/**' }]),
    // The optional sidecar (SDP-2.1 §7.5): a setup project starts a test sidecar with a test
    // pairing token; the teardown project stops it. Run: npx playwright test --project=sidecar
    { name: 'sidecar-setup', testMatch: /e2e[\\/]sidecar[\\/]global\.setup\.js$/, teardown: 'sidecar-teardown' },
    { name: 'sidecar-teardown', testMatch: /e2e[\\/]sidecar[\\/]global\.teardown\.js$/ },
    { name: 'sidecar', use: chrome, testMatch: /e2e[\\/]sidecar[\\/][^\\/]+\.spec\.js$/, dependencies: ['sidecar-setup'], workers: 1 },
    ...(LINUX ? [] : [{ name: 'sidecar-edge', use: { channel: 'msedge' }, testMatch: /e2e[\\/]sidecar[\\/][^\\/]+\.spec\.js$/, dependencies: ['sidecar-setup', 'sidecar'], workers: 1 }]), // one test sidecar: never beside the Chrome run
  ],
});
