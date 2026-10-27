// R1 mensuration on the WV3 chip (RPC00B with ERR_BIAS/ERR_RAND, USE00A sun angles): height
// by layover and by shadow against constructed truth (REQ-MEN-03, AT-04.1/2/4), bracket and
// relative CE90 (REQ-MEN-02, REQ-MEN-07), targets and the Target Table (REQ-MEN-04),
// elevation profile and point-to-point LOS on the SRTM-derived DTED (REQ-DEM-12, REQ-MEN-10).
import { test, expect } from '@playwright/test';
import { openApp, openFiles, sample } from './helpers.js';

async function ready(page, withDem = false) {
  const { frame, logs } = await openApp(page, 'file');
  if (withDem) {
    await openFiles(frame, [sample('dem-derived-s35w059', 's35_w059_from_srtm.dt1')]);
    // The DEM stays loaded as terrain; hide its layer so the image is the reference.
    await frame.evaluate(() => {
      const app = window.gisworkbench;
      for (const l of app.layers.values()) app.store.transact('hide', (tx) => tx.set(l.id, 'visible', false));
    });
  }
  await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].every((l) => l.lutTex));
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = [...app.layers.values()].find((x) => x.kind !== 'dem');
    app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', l.id));
    p.setView({ cx: 768, cy: 768, zoom: 0.5, rot: 0, mode: 'native' });
  });
  return { frame, logs };
}

/** Screen position (page coordinates) of an image point in the active pane. */
const screenOf = (frame, x, y) =>
  frame.evaluate(([x, y]) => {
    const p = window.gisworkbench.activePane();
    const r = p.el.getBoundingClientRect();
    const s = p.screenPoint(x, y);
    return { x: r.left + s.x, y: r.top + s.y };
  }, [x, y]);

const lastRow = (frame) => frame.evaluate(() => window.gisworkbench.store.all('measurement').at(-1));

test('AT-04.1 AT-04.2 REQ-MEN-03 layover and shadow heights match constructed truth', async ({ page }) => {
  const { frame, logs } = await ready(page);
  // Truth: a 30 m object at the chip centre, built through the same sensor model.
  const t = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const base = l.groundAt(800, 760);
    const top = l.imageAt(base.lat, base.lon, base.h + 30);
    const sun = l.info.sun;
    const L = 30 / Math.tan((sun.elevation * Math.PI) / 180);
    const tipG = app.core.direct(base.lat, base.lon, (sun.azimuth + 180) % 360, L);
    const tip = l.imageAt(tipG.lat, tipG.lon, base.h);
    return { base: { x: 800, y: 760 }, top, tip, sun };
  });
  await frame.evaluate(() => window.gisworkbench.tools.select('men.height.layover'));
  let a = await screenOf(frame, t.base.x, t.base.y);
  let b = await screenOf(frame, t.top.x, t.top.y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y);
  await page.mouse.click(b.x, b.y);
  let r = await lastRow(frame);
  expect(r.mtype).toBe('Height');
  // Clicks land on whole screen pixels: at zoom 0.5 a click is within 1 image px of truth.
  expect(Math.abs(r.value - 30)).toBeLessThan(Math.max(0.5, 0.02 * 30) + 2 / r.extra.pxPerM);
  expect(r.method).toMatch(/layover/);
  expect(r.le90).toBeGreaterThan(0);

  await frame.evaluate(() => window.gisworkbench.tools.select('men.height.shadow'));
  a = await screenOf(frame, t.base.x, t.base.y);
  b = await screenOf(frame, t.tip.x, t.tip.y);
  await page.mouse.click(a.x, a.y);
  await page.mouse.move(b.x, b.y);
  await page.mouse.click(b.x, b.y);
  r = await lastRow(frame);
  const gsd = await frame.evaluate(() => window.gisworkbench.store.all('measurement')[0].extra ? 0.37 : 0.37);
  expect(Math.abs(r.value - 30)).toBeLessThan(Math.max(0.5, 0.03 * 30) + 2 * gsd * Math.tan((t.sun.elevation * Math.PI) / 180));
  expect(r.extra.sun.source).toBe('USE00A');
  // USE00A carries the sun angles to 0.1° (the truth file has the product value 64.451°).
  expect(r.method).toMatch(/sun az 71\.70°, el 64\.50°/);
  expect(logs).toEqual([]);
});

test('AT-04.4 shadow height is refused when the sun is below 5°', async ({ page }) => {
  const { frame } = await ready(page);
  await frame.evaluate(() => {
    const l = window.gisworkbench.activeLayer();
    l.info.sun = { azimuth: 100, elevation: 3, source: 'test' };
    window.gisworkbench.tools.select('men.height.shadow');
  });
  const a = await screenOf(frame, 700, 700);
  await page.mouse.click(a.x, a.y);
  await expect(frame.locator('.toast', { hasText: 'below 5°' })).toBeVisible();
  expect(await frame.evaluate(() => window.gisworkbench.store.all('measurement').length)).toBe(0);
});

test('REQ-MEN-02 REQ-MEN-07 bracket and range-bearing carry relative CE90 (shared bias cancels)', async ({ page }) => {
  const { frame } = await ready(page);
  await frame.evaluate(() => window.gisworkbench.tools.select('men.bracket'));
  const [a, b, d] = [await screenOf(frame, 600, 600), await screenOf(frame, 900, 700), await screenOf(frame, 760, 560)];
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  await page.mouse.click(d.x, d.y);
  const r = await lastRow(frame);
  const chk = await frame.evaluate((r) => {
    const app = window.gisworkbench;
    const [p, q] = r.geom;
    return app.core.inverse(p[1], p[0], q[1], q[0]).distance;
  }, r);
  expect(r.mtype).toBe('Bracket');
  expect(Math.abs(r.value - chk)).toBeLessThan(1e-3);
  expect(r.tag).toBe('relative');
  // ERR_BIAS 1.12 m dominates the absolute error; the relative error drops it.
  expect(r.ce90).toBeLessThan(r.extra.absoluteCE90[0]);
  const sig = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const e = app.core.pointError(l.modelId, 600, 600, l.groundAt(600, 600).h, 0.5);
    return { bias: e.sigmaBias, rand: e.sigmaRand };
  });
  expect(sig.bias).toBeCloseTo(1.12, 6);
  expect(sig.rand).toBeCloseTo(0.17, 6);
});

test('REQ-MEN-04 targets with range rings and an exportable Target Table', async ({ page }) => {
  const { frame } = await ready(page);
  await frame.evaluate(() => window.gisworkbench.tools.select('men.target'));
  const a = await screenOf(frame, 768, 768);
  await page.mouse.click(a.x, a.y);
  const r = await lastRow(frame);
  expect(r.mtype).toBe('Target');
  expect(r.object).toBe('T01');
  expect(r.rings).toEqual([500, 1000, 2000]);
  await frame.evaluate(() => {
    Object.assign(window.gisworkbench.runMode.caps, { fsaSave: false });
    void window.gisworkbench.commands.run('men.targettable');
  });
  const dlg = frame.locator('[data-id="dialog:target-table"]');
  await expect(dlg).toContainText('T01');
  await expect(dlg).toContainText(r.coords.mgrs);
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Export CSV' }).click()]);
  const text = await (await import('node:fs')).promises.readFile(await dl.path(), 'utf8');
  expect(text.split('\n')[1]).toMatch(/^T01,21H/);
});

test('REQ-DEM-12 REQ-MEN-10 elevation profile and line of sight on the DTED under the chip', async ({ page }) => {
  const { frame, logs } = await ready(page, true);
  const prof = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const a = l.groundAt(300, 300);
    const b = l.groundAt(1300, 1200);
    const p = app.measureLos.profile([a, b], 64);
    const ok = p.pts.filter((q) => Number.isFinite(q.hae)).length;
    // SRTM is a surface model: a 60 m mast sees over the roofs and trees.
    const visible = app.measureLos.lineOfSight(p, 60, 0, 0.13).visible;
    const under = app.measureLos.lineOfSight(p, -40, -40, 0.13).visible;
    return { total: p.total, ok, n: p.pts.length, src: p.pts[0].src, visible, under, range: [Math.min(...p.pts.map((q) => q.hae)), Math.max(...p.pts.map((q) => q.hae))] };
  });
  expect(prof.ok).toBe(prof.n);
  expect(prof.src).toMatch(/MSL EGM96/);
  // Flat ground near Buenos Aires: HAE within a few tens of metres.
  expect(prof.range[0]).toBeGreaterThan(0);
  expect(prof.range[1]).toBeLessThan(60);
  expect(prof.visible).toBe(true);
  expect(prof.under).toBe(false);
  // Through the UI: LOS tool logs a row and opens the profile window.
  await frame.evaluate(() => {
    window.gisworkbench.prefs.set('los', { hA: 60, hB: 0, k: 0.13 });
    window.gisworkbench.tools.select('los.p2p');
  });
  const a = await screenOf(frame, 300, 300);
  const b = await screenOf(frame, 1300, 1200);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  const r = await lastRow(frame);
  expect(r.mtype).toBe('LOS');
  expect(r.value).toBe('visible');
  await expect(frame.locator('[data-id="dialog:los"] canvas')).toBeVisible();
  // The profile cursor is linked to the image.
  const box = await frame.locator('[data-id="dialog:los"] canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  expect(logs).toEqual([]);
});
