import { defineConfig } from '@playwright/test';

// Lite in real Android Chrome (tests/android): one device, so one worker. Needs an emulator or a
// phone on adb. Apart from the release gates: `npm run test:android` is run by hand, and its report
// is not one that traceability reads. GW_DIST points it at another build's folder.
// Start the device headless. The emulator hung or crashed in Chrome GPU start-up here (see
// docs/validation/2.5/android-emulator.md):
//   emulator -avd gwb-pixel7 -no-window -gpu host -no-audio -no-boot-anim -no-snapshot-load
export default defineConfig({
  testDir: 'tests/android',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  outputDir: 'test-results/android',
  reporter: [['list'], ['json', { outputFile: 'reports/android/e2e-android.json' }]],
  webServer: {
    command: `node tests/tools/serve.mjs --root ${process.env.GW_DIST ?? 'dist'} --port 8765`,
    url: 'http://127.0.0.1:8765/gis-workbench-lite.html',
    reuseExistingServer: true,
  },
});
