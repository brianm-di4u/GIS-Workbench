// REG-081 (#163) in the built file: a SICD with no ErrorStatistics has no stated horizontal error, not
// an error of 0, so its point error is "not available"; a SICD that states CompositeSCP reads it as
// before. FX-07 states Rg 2 m, Az 3 m in the slant plane at 50° grazing. Its copy with the
// ErrorStatistics tags renamed (same length, so the NITF stays valid) states nothing.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const FX07 = resolve('fixtures', 'fx07', 'fx07_a.nitf');

test('REG-081 REQ-SAR-05 a SICD with no stated error has no point error; one that states CompositeSCP reads it as before', async ({ page }, info) => {
  const bytes = readFileSync(FX07);
  const text = bytes.toString('latin1');
  expect(text.split('ErrorStatistics>').length - 1).toBe(2);
  const none = info.outputPath('fx07_none.nitf');
  writeFileSync(none, Buffer.from(text.replaceAll('ErrorStatistics>', 'XrrorStatistics>'), 'latin1'));

  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  await openFiles(frame, [FX07]);
  await openFiles(frame, [none]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId).length === 2, null, { timeout: 60000 });
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const of = (re) => {
      const l = [...app.layers.values()].find((x) => re.test(x.rec.name));
      const e = app.core.pointError(l.modelId, l.width / 2, l.height / 2, 0, 0.5);
      return { sigmaH: app.core.modelInfo(l.modelId).sigmaH ?? null, ce90: Number.isFinite(e.ce90) ? e.ce90 : null };
    };
    return { stated: of(/fx07_a/), none: of(/fx07_none/) };
  });
  // Slant-plane range σ to the ground through 1/cos(graze); σH is the RMS of the two axes.
  const expected = Math.sqrt(((2 / Math.cos((50 * Math.PI) / 180)) ** 2 + 3 ** 2) / 2);
  expect(r.stated.sigmaH).toBeCloseTo(expected, 6);
  expect(r.stated.ce90).toBeGreaterThan(0);
  expect(r.none).toEqual({ sigmaH: null, ce90: null });
});
