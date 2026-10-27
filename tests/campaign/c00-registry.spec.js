// TE-C00: dump the live command registry of the built file (implemented flags, enabled state at
// start-up, coverage per release) for build/campaign/gen-matrix.mjs and the coverage exit gate.
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openApp } from './helpers.js';

test('TE-C00 REQ-UI-03 registry dump', async ({ page }, info) => {
  test.skip(info.project.name !== 'chrome', 'one dump is enough');
  const { frame, logs } = await openApp(page, 'file');
  const reg = await frame.evaluate(() => {
    const c = window.gisworkbench.commands;
    return { build: window.__gw?.build ?? null, coverage: c.coverage(), commands: c.list().map((x) => ({ id: x.id, label: x.label, req: x.req, rel: x.rel, implemented: !!x.implemented })) };
  });
  mkdirSync('reports/campaign', { recursive: true });
  writeFileSync('reports/campaign/registry.json', JSON.stringify({ when: new Date().toISOString(), ...reg }, null, 1));
  expect(logs).toEqual([]);
  expect(reg.commands.length).toBeGreaterThan(400);
});
