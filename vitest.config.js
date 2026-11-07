import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/golden/**/*.test.js'],
    environment: 'node',
    // Some tests start GDAL or a large decoder, and a cold first start takes well over the default.
    testTimeout: 120_000,
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/unit.json' },
  },
});
