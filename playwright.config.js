import { defineConfig } from '@playwright/test';

// E2E on the BUILT file (SDP §6.4 Full stage): installed Chrome and Edge, 1440×900.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 4,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'reports/e2e.json' }]],
  use: {
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  projects: [
    { name: 'chrome', use: { channel: 'chrome' } },
    { name: 'edge', use: { channel: 'msedge' } },
  ],
});
