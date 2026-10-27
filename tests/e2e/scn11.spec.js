// SCN-11 on FX-06 (AT-11.2/11.3/11.4): two dates in one panel, the two-colour legend names the
// dates, change detection through the UI finds ≥ 10 of 12 changes with ≤ 5 false polygons,
// and a confirmed change stores both image IDs and dates.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const FX = (f) => resolve('fixtures', 'fx06', f);

test('SCN-11 change detection, review and confirmation on FX-06', async ({ page }) => {
  const truth = JSON.parse(readFileSync(FX('fx06_truth.json'), 'utf8'));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [FX('fx06_date1.tif')]);
  await openFiles(frame, [FX('fx06_date2.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length === 2 && [...window.gisworkbench.layers.values()].every((l) => l.lutTex));
  // AT-11.2: date 1 red, date 2 cyan, legend with the dates.
  const legend = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.commands.run('cmp.twocolour');
    const p = app.activePane();
    const g = p.overlay.getContext('2d');
    const seen = [];
    const o = g.fillText.bind(g);
    g.fillText = (t, ...a) => (seen.push(t), o(t, ...a));
    p.invalidate();
    await new Promise((r) => setTimeout(r, 200));
    g.fillText = o;
    app.commands.run('cmp.twocolour');
    return seen;
  });
  expect(legend).toContain('Date 1: fx06_date1.tif — 2024-05-01 10:30:00');
  expect(legend).toContain('Date 2: fx06_date2.tif — 2025-05-01 10:30:00');

  await frame.evaluate(() => void window.gisworkbench.commands.run('chg.detect'));
  await frame.locator('[data-id="dialog:change-detect"]').getByRole('button', { name: 'Detect' }).click();
  await frame.waitForFunction(() => window.gisworkbench.store.all('change').length > 0, null, { timeout: 30_000 });
  const cs = await frame.evaluate(() => window.gisworkbench.store.all('change').map((c) => ({ id: c.id, g: window.gisworkbench.store.get(c.graphic).coords, m: c.method })));
  expect(cs[0].m.sameGrid).toBe(true);
  // Compare in ground coordinates with the truth polygons.
  const box = (ring) => ({ w: Math.min(...ring.map((p) => p[0])), e: Math.max(...ring.map((p) => p[0])), s: Math.min(...ring.map((p) => p[1])), n: Math.max(...ring.map((p) => p[1])) });
  const overlap = (a, b) => !(a.e < b.w || b.e < a.w || a.n < b.s || b.n < a.s);
  const tb = truth.changes.map((c) => box(c.polygon));
  const cb = cs.map((c) => box(c.g));
  const found = tb.filter((t) => cb.some((c) => overlap(c, t))).length;
  const falses = cb.filter((c) => !tb.some((t) => overlap(c, t))).length;
  expect(found).toBeGreaterThanOrEqual(10);
  expect(falses).toBeLessThanOrEqual(5);
  // Review: confirm the first candidate from the list.
  const list = frame.locator('[data-id="dialog:change-list"]');
  await expect(list).toBeVisible();
  await list.getByRole('button', { name: 'Confirm' }).first().click();
  const c = await frame.evaluate(() => window.gisworkbench.store.all('change').find((x) => x.status === 'confirmed'));
  expect(c.image1).toMatchObject({ name: 'fx06_date1.tif', date: '2024:05:01 10:30:00' });
  expect(c.image2).toMatchObject({ name: 'fx06_date2.tif', date: '2025:05:01 10:30:00' });
  expect(c.decided.at).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(logs).toEqual([]);
});
