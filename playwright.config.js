import { defineConfig } from '@playwright/test';

// Linux (P16): Playwright's own Chromium stands in for Chrome; there is no Edge project.
const LINUX = process.platform === 'linux';
const chrome = LINUX ? {} : { channel: 'chrome' };

// E2E on the BUILT file (SDP §6.4 Full stage): installed Chrome and Edge, 1440×900.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 4,
  retries: 0,
  // GW_E2E_JSON: the sidecar pass of test:e2e writes its own report beside the browser one.
  reporter: [['list'], ['json', { outputFile: process.env.GW_E2E_JSON ?? 'reports/e2e.json' }]],
  use: {
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  projects: [
    // Every suite but the sidecar ones runs with no sidecar (PT-13).
    { name: 'chrome', use: chrome, testIgnore: '**/sidecar/**' },
    ...(LINUX ? [] : [{ name: 'edge', use: { channel: 'msedge' }, testIgnore: '**/sidecar/**' }]),
    // The optional sidecar (SDP-2.1 §7.5): a setup project starts a test sidecar with a test
    // pairing token; the teardown project stops it. Run: npx playwright test --project=sidecar
    { name: 'sidecar-setup', testMatch: /e2e[\\/]sidecar[\\/]global\.setup\.js$/, teardown: 'sidecar-teardown' },
    { name: 'sidecar-teardown', testMatch: /e2e[\\/]sidecar[\\/]global\.teardown\.js$/ },
    { name: 'sidecar', use: chrome, testMatch: /e2e[\\/]sidecar[\\/][^\\/]+\.spec\.js$/, dependencies: ['sidecar-setup'], workers: 1 },
    ...(LINUX ? [] : [{ name: 'sidecar-edge', use: { channel: 'msedge' }, testMatch: /e2e[\\/]sidecar[\\/][^\\/]+\.spec\.js$/, dependencies: ['sidecar-setup', 'sidecar'], workers: 1 }]), // one test sidecar: never beside the Chrome run
  ],
});
