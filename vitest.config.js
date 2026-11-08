import { defineConfig } from 'vitest/config';
import { scopeCargoTarget } from './build/cargo-target.mjs';

// Tests find the built WASM through cargo, so they must see the same target the build used (#42).
scopeCargoTarget();

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
