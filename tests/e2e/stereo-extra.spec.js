// REQ-STR-10 a stereo panel linked to a mono panel follows its ground centre; REQ-STR-02 the
// Stereo Model Manager lists the pair and Next Stereo Model reopens it; REQ-STR-05 spanned and
// row-interleaved modes draw.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx02');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx02_truth.json'), 'utf8'));

test('REQ-STR-10 REQ-STR-02 REQ-STR-05 FX-02 stereo linked to mono, model manager, spanned and interleaved modes', async ({ page }) => {
  test.setTimeout(180000);
  const { frame, logs } = await openApp(page, 'file');
  await frame.evaluate(() => window.gisworkbench.activeMp().setLayout('1x2'));
  await openFiles(frame, truth.images.map((i) => resolve(DIR, i.file)));
  await frame.evaluate(() => window.gisworkbench.activeMp().setActivePane(window.gisworkbench.activeMp().panes[1]));
  await openFiles(frame, [resolve(DIR, truth.images[0].file)]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 3, null, { timeout: 60000 });
  await frame.evaluate(() => window.gisworkbench.activeMp().setActivePane(window.gisworkbench.activeMp().panes[0]));
  const s0 = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activeMp().panes[0];
    const ls = p.layers().sort((a, b) => String(a.info.iid).localeCompare(String(b.info.iid)));
    app.stereo.open(ls[0], ls[1]);
    return { stereo: !!p.stereo };
  });
  expect(s0.stereo).toBe(true);
  await frame.evaluate(() => void window.gisworkbench.commands.run('link.manager'));
  const dlg = frame.locator('[data-id="dialog:link-manager"]');
  const selects = dlg.locator('select[aria-label^="Link group of"]');
  await selects.nth(0).selectOption('A');
  await selects.nth(1).selectOption('A');
  await dlg.getByRole('button', { name: 'OK' }).click();
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const [a, b] = app.activeMp().panes;
    const st = a.stereo;
    // Move the stereo view by 60 m east on the ground; the mono panel follows.
    const g0 = st.centreGround();
    st.centreOnGround(g0.lat, g0.lon + 60 / 91700, g0.h);
    a.setView({ ...a.view });
    await new Promise((res) => setTimeout(res, 300));
    const g1 = st.centreGround();
    const lb = b.geoLayer();
    const { w, h } = b.size();
    const q = b.imagePoint(w / 2, h / 2);
    const gb = lb.groundAt(q.x, q.y, g1.h);
    const follow = app.core.inverse(g1.lat, g1.lon, gb.lat, gb.lon).distance;
    const moved = app.core.inverse(g0.lat, g0.lon, g1.lat, g1.lon).distance;
    // Stereo Model Manager and Next Stereo Model.
    app.commands.run('stereo.manager');
    await new Promise((res) => setTimeout(res, 300));
    const mgr = document.querySelector('[data-id="dialog:stereo-manager"]');
    const rows = mgr ? mgr.querySelectorAll('tbody tr').length : 0;
    mgr?.querySelector('button')?.click();
    app.activeMp().setActivePane(a);
    app.commands.run('stereo.next');
    await new Promise((res) => setTimeout(res, 300));
    const afterNext = !!a.stereo;
    // Spanned and row-interleaved modes.
    const modes = {};
    for (const m of ['spanned', 'interleaved']) {
      app.commands.run(`stereo.mode.${m}`);
      app.renderer.invalidate();
      await new Promise((res) => setTimeout(res, 200));
      modes[m] = { mode: a.stereo?.mode, opts: a.stereo?.displayOpts?.().mode };
    }
    return { follow, moved, rows, afterNext, modes };
  });
  console.log(JSON.stringify(r));
  expect(r.moved).toBeGreaterThan(50);
  expect(r.follow).toBeLessThan(2);
  expect(r.rows).toBeGreaterThanOrEqual(1);
  expect(r.afterNext).toBe(true);
  expect(r.modes.spanned.mode).toBe('spanned');
  expect(r.modes.interleaved.mode).toBe('interleaved');
  expect(logs).toEqual([]);
});
