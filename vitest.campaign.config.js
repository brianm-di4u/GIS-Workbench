import { defineConfig } from 'vitest/config';

// T&E campaign Node-side accuracy suites: shipped WASM bundles vs oracle truth in TE-corpus/_truth.
//   npx vitest run -c vitest.campaign.config.js
export default defineConfig({
  test: {
    include: ['tests/campaign/golden/**/*.test.js'],
    environment: 'node',
    testTimeout: 120_000,
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/campaign/golden.json' },
  },
});
