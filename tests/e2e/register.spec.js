// Registration and GCP models (REQ-SNS-09, REQ-SNS-05): Auto Align recovers a known 5.3/−3.7 px
// misregistration of FX-06 date 2 on date 1 (gain-changed, with inserted changes) to 0.1 px;
// Glove Align follows a drag; an RPC layer keeps its 3-D model with the correction folded into
// ICHIPB, so its geolocation agrees with the reference; undo restores the original model; GCP
// models (affine, polynomial, projective) report their RMS.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles, sample } from './helpers.js';

const D1 = resolve('fixtures/fx06/fx06_date1.tif');
const D2 = resolve('fixtures/fx06/fx06_date2.tif');

async function pairIn(page, files) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [files[0]]);
  await openFiles(frame, [files[1]]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length === 2 && [...window.gisworkbench.layers.values()].every((l) => l.lutTex && l.modelId));
  return { frame, logs };
}

test('REQ-SNS-09 Auto Align recovers a known misregistration; the model follows; undo restores', async ({ page }) => {
  const { frame, logs } = await pairIn(page, [D1, D2]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const [master, slave] = p.layers();
    app.store.transact('active', (tx) => {
      tx.set(p.id, 'activeLayer', slave.id);
      tx.set(slave.id, 'align', [5.3, 1, 0, -3.7, 0, 1]); // a wrong starting alignment
    });
    const before = slave.modelName;
    const res = await app.autoAlign();
    const A = slave.rec.align;
    // Geolocation through the registered model agrees with the reference at aligned pixels.
    const errs = [];
    for (const [x, y] of [[200, 200], [512, 700], [900, 300]]) {
      const q = { x: A[0] + A[1] * x + A[2] * y, y: A[3] + A[4] * x + A[5] * y };
      const a = slave.groundAt(x, y);
      const b = master.groundAt(q.x, q.y);
      errs.push(app.core.inverse(a.lat, a.lon, b.lat, b.lon).distance);
    }
    const model = slave.modelName;
    app.commands.run('qat.undo'); // tie points
    app.commands.run('qat.undo'); // registration
    return { A, used: res.used, rejected: res.rejected, rms: res.rmsPx, errs, before, model, afterUndo: slave.modelName, alignAfterUndo: slave.rec.align };
  });
  expect(Math.abs(r.A[0])).toBeLessThan(0.1);
  expect(Math.abs(r.A[3])).toBeLessThan(0.1);
  expect(Math.abs(r.A[1] - 1)).toBeLessThan(1e-3);
  expect(Math.abs(r.A[5] - 1)).toBeLessThan(1e-3);
  expect(r.used).toBeGreaterThanOrEqual(8); // the road grid repeats: many matches are rejected as false
  expect(r.rms).toBeLessThan(0.2);
  for (const e of r.errs) expect(e).toBeLessThan(0.05);
  expect(r.model).toBe('Registered (polynomial 1)');
  expect(r.afterUndo).toBe(r.before);
  expect(r.alignAfterUndo).toEqual([5.3, 1, 0, -3.7, 0, 1]);
  expect(logs).toEqual([]);
});

test('REQ-SNS-09 Glove Align follows a drag and applies on Enter', async ({ page }) => {
  const { frame } = await pairIn(page, [D1, D2]);
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    p.setView({ cx: 512, cy: 512, zoom: 2, rot: 0, mode: 'native' });
    app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', p.layers()[1].id));
    void app.commands.run('align.glove');
  });
  const box = await frame.locator('.multiport .pane').first().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 - 10, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  const A = await frame.evaluate(() => window.gisworkbench.activePane().layers()[1].rec.align);
  expect(A[0]).toBeCloseTo(15, 1); // 30 screen px at zoom 2
  expect(A[3]).toBeCloseTo(-5, 1);
});

test('REQ-SNS-09 an RPC layer keeps its 3-D model with the correction in ICHIPB; Quick Align similarity', async ({ page }) => {
  const chip = sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf');
  const { frame } = await pairIn(page, [chip, chip]);
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const [master, slave] = p.layers();
    app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', slave.id));
    const A = [3.25, 1, 0, -2.5, 0, 1];
    app.applyRegistration(A, { method: 'test shift' });
    const errs = [];
    for (const [x, y] of [[300, 400], [800, 800], [1200, 300]])
      for (const h of [0, 50]) {
        const a = app.core.i2g(slave.modelId, x, y, slave.info.heightOffset + h);
        const b = app.core.i2g(master.modelId, x + 3.25, y - 2.5, master.info.heightOffset + h);
        errs.push(app.core.inverse(a.lat, a.lon, b.lat, b.lon).distance);
      }
    return { model: slave.modelName, errs, chip: slave.rec.registration.chip };
  });
  expect(r.model).toBe('RPC00B (registered)');
  for (const e of r.errs) expect(e).toBeLessThan(0.01); // at every height: the model stays 3-D
  // Quick Align through the tool: two from/to pairs give a similarity transform.
  const pts = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    p.setView({ cx: 768, cy: 768, zoom: 0.5, rot: 0, mode: 'native' });
    void app.commands.run('align.quick');
    const r0 = p.el.getBoundingClientRect();
    return [[600, 600], [610, 596], [900, 900], [910, 896]].map(([x, y]) => {
      const s = p.screenPoint(x, y);
      return [r0.left + s.x, r0.top + s.y];
    });
  });
  for (const [x, y] of pts) await page.mouse.click(x, y);
  const A2 = await frame.evaluate(() => window.gisworkbench.activePane().layers()[1].rec.align);
  // The second click of each pair is 10 px right and 4 px up of the first (screen px at zoom 0.5 → ±2 px rounding).
  expect(A2[1]).toBeCloseTo(1, 2);
  expect(A2[0] - 3.25 - 10).toBeLessThan(3);
});

test('REQ-SNS-05 GCP models: affine, polynomial and projective with RMS', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx01/fx01.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  const truth = JSON.parse(readFileSync(resolve('fixtures/fx01/fx01_truth.json'), 'utf8'));
  const r = await frame.evaluate((pts) => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const gcps = pts.map((t) => ({ x: t.x, y: t.y, lat: t.lat, lon: t.lon, h: t.hae }));
    return [1, 2, 3, 4].map((k) => {
      const m = app.gcpModelFor(l, gcps.slice(0, 30), k);
      // Check points not used in the fit.
      const chk = gcps.slice(30).map((g) => {
        const q = app.core.i2g(m.id, g.x, g.y, g.h);
        return app.core.inverse(q.lat, q.lon, g.lat, g.lon).distance;
      });
      return { name: m.name, rms: m.rmsM, chkMax: Math.max(...chk), active: l.modelName };
    });
  }, truth.points);
  expect(r.map((x) => x.name)).toEqual(['GCP (polynomial 1)', 'GCP (polynomial 2)', 'GCP (polynomial 3)', 'GCP (projective)']);
  for (const x of r) {
    expect(x.active).toBe(x.name);
    expect(Number.isFinite(x.rms)).toBe(true);
    // 2-D models ignore relief (±40 m on FX-01, 12° off nadir): a few metres is the honest limit.
    expect(x.chkMax).toBeLessThan(20);
  }
});
