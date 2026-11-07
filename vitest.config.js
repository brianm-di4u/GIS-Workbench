import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/golden/**/*.test.js'],
    environment: 'node',
    reporters: ['default', 'json'],
    outputFile: { json: 'reports/unit.json' },
  },
});
