import { defineConfig } from '@playwright/test';

// Lite in Playwright's WebKit build on this PC (OD-2.23, REQ-HOST-05): the WebKit half of what
// tests/e2e/25-mobile otherwise runs on Chromium with iPhone dimensions, plus tests/ios. This is
// not Safari on iOS: a failure is a real WebKit lead, a pass proves nothing about iOS. The iOS
// Simulator run is .github/workflows/lite-ios-sim.yml. Apart from the release gates:
// `npm run test:webkit` is run by hand. GW_DIST points it at another build's folder.
export default defineConfig({
  testDir: 'tests',
  testMatch: /(e2e[\/]25-mobile|ios[\/]lite\.webkit)\.spec\.js$/,
  timeout: 120_000,
  workers: 1,
  retries: 0,
  outputDir: 'test-results/ios',
  reporter: [['list'], ['json', { outputFile: 'reports/ios/e2e-webkit.json' }]],
  use: { browserName: 'webkit' },
  // Not here: the Full file and saved snapshots, which open from file:// and WebKit cannot read
  // files there. CPU throttling needs Chrome's CDP, and its test skips itself outside Chromium.
  grepInvert: /the Full Ribbon|Export Snapshot/,
  webServer: {
    command: `node tests/tools/serve.mjs --root ${process.env.GW_DIST ?? 'dist'} --port 8765`,
    url: 'http://127.0.0.1:8765/gis-workbench-lite.html',
    reuseExistingServer: true,
  },
});
