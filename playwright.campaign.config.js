import { defineConfig } from '@playwright/test';

// T&E campaign (docs/validation/TE-master-plan.md): the BUILT file against the real public corpus
// (build/campaign/corpus.json, TE_CORPUS). Separate from playwright.config.js so ci:full is unaffected.
//   npx playwright test -c playwright.campaign.config.js [c01-ingest] [--project=chrome]
export default defineConfig({
  testDir: 'tests/campaign',
  testMatch: /c\d\d-.*\.spec\.js$/,
  timeout: 180_000,
  workers: Number(process.env.TE_WORKERS ?? 4),
  retries: 0,
  reporter: [['list'], ['json', { outputFile: process.env.TE_JSON ?? 'reports/campaign/playwright.json' }]],
  use: {
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] },
  },
  projects: [
    { name: 'chrome', use: { channel: 'chrome' } },
    { name: 'edge', use: { channel: 'msedge' } },
    { name: 'firefox', use: { browserName: 'firefox' }, grep: /@best-effort/ },
  ],
});
