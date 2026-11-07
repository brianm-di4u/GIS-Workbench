// SCN-04 height by layover and by shadow on FX-03 (AC-04.1, AC-04.2): every pole and building
// measured by clicking its base and top (layover) and its base and shadow tip (shadow), through
// the UI tools on a 20° off-nadir image with USE00A sun angles.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const FX03 = resolve('fixtures/fx03/fx03.ntf');
const truth = JSON.parse(readFileSync(resolve('fixtures/fx03/fx03_truth.json'), 'utf8'));

const screenOf = (frame, x, y) =>
  frame.evaluate(([x, y]) => {
    const p = window.gisworkbench.activePane();
    const r = p.el.getBoundingClientRect();
    const s = p.screenPoint(x, y);
    return { x: r.left + s.x, y: r.top + s.y };
  }, [x, y]);
const lastRow = (frame) => frame.evaluate(() => window.gisworkbench.store.all('measurement').at(-1));

async function measure(page, frame, tool, a, b) {
  await frame.evaluate(([x, y]) => window.gisworkbench.activePane().setView({ cx: x, cy: y, zoom: 4, rot: 0, mode: 'native' }), [(a.x + b.x) / 2, (a.y + b.y) / 2]);
  await frame.evaluate((t) => window.gisworkbench.tools.select(t), tool);
  const sa = await screenOf(frame, a.x, a.y);
  const sb = await screenOf(frame, b.x, b.y);
  await page.mouse.click(sa.x, sa.y);
  await page.mouse.move(sb.x, sb.y);
  await page.mouse.click(sb.x, sb.y);
  return lastRow(frame);
}

test('SCN-04 AC-04.1 AC-04.2 layover and shadow heights on FX-03', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [FX03]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex && !l.tiles.loading));
  const sun = await frame.evaluate(() => [...window.gisworkbench.layers.values()][0].info.sun);
  expect(sun).toMatchObject({ azimuth: truth.sun.azimuth, elevation: truth.sun.elevation });
  const results = [];
  for (const o of truth.objects) {
    const lay = await measure(page, frame, 'men.height.layover', o.base, o.top);
    expect(lay.mtype).toBe('Height');
    expect(lay.method).toMatch(/layover/);
    const sh = await measure(page, frame, 'men.height.shadow', o.shadowBase ?? o.base, o.shadowTip);
    expect(sh.method).toMatch(/shadow/);
    expect(sh.extra.sun.source).toBe('USE00A');
    results.push({ id: o.id, truth: o.height, layover: lay.value, shadow: sh.value, le90: lay.le90 });
  }
  // A click lands on a whole screen pixel: at zoom 4 that is within 1/8 image px of truth.
  const click = (o) => (0.125 * truth.gsd) / Math.tan((truth.sensor.offNadir * Math.PI) / 180);
  for (const r of results) {
    expect(Math.abs(r.layover - r.truth), `${r.id} layover ${r.layover}`).toBeLessThan(Math.max(0.5, 0.02 * r.truth) + click(r));
    expect(Math.abs(r.shadow - r.truth), `${r.id} shadow ${r.shadow}`).toBeLessThan(Math.max(0.5, 0.03 * r.truth) + 0.125 * truth.gsd * Math.tan((truth.sun.elevation * Math.PI) / 180));
    expect(r.le90).toBeGreaterThan(0);
  }
  expect(logs).toEqual([]);
});
