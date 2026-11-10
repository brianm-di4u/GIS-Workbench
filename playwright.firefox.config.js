import { defineConfig } from '@playwright/test';
import { grepInvert, readQuarantine } from './build/check-quarantine.mjs';

// A non-blocking Firefox run (OD-2.31 D24): Playwright's own Firefox build over a core set of specs.
// Firefox is not a release target and this config is no release gate: playwright.config.js and the
// gates do not read it. Run by hand, with the browser under PLAYWRIGHT_BROWSERS_PATH:
//   PLAYWRIGHT_BROWSERS_PATH=D:/gwb26/tools-oracles/pw-browsers GW_DIST=dist-oracles \
//     npx playwright test -c playwright.firefox.config.js
// What it finds is in docs/validation/2.6/oracles.md.
export default defineConfig({
  testDir: 'tests',
  testMatch: /(e2e[\\/](scn01-03|scn04|scn05|scn08|scn09|scn10|scn11|nav|measure|imaging|graphics|look|compare|extract|products|packs|platform|pages|register|activity)|firefox[\\/]boot)\.spec\.js$/,
  // Checks only Chrome's protocol can run, and a boot budget the release gates own.
  grepInvert: [/REQ-PRF-01 interactive within|PT-01 REQ-ARC-01/, grepInvert(readQuarantine())].filter(Boolean),
  timeout: 240_000,
  workers: Number(process.env.FX_WORKERS ?? 2),
  retries: 0,
  outputDir: 'test-results/firefox',
  reporter: [['list'], ['json', { outputFile: process.env.GW_E2E_JSON ?? 'reports/oracles/e2e-firefox.json' }]],
  // With no display (a CI runner), Firefox makes no WebGL context through GLX: EGL with Mesa's
  // llvmpipe does, when Firefox is told to use it and not to block the software renderer. A runner
  // on ubuntu-26.04 failed every test at boot without this (#48); in WSL with no display it fails
  // the same way, and passes with it.
  use: {
    browserName: 'firefox',
    viewport: { width: 1440, height: 900 },
    launchOptions: { env: { ...process.env, MOZ_WEBGL_FORCE_EGL: '1' }, firefoxUserPrefs: { 'webgl.force-enabled': true } },
  },
  projects: [{ name: 'firefox' }],
});
