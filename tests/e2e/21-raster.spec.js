// 2.1 raster group (FC-03/FC-04; REQ-FMT-24..27, SCN-28): ERDAS Imagine and NetCDF-3 open natively in
// the built file — an HFA with its .ige spill file and an .rrd, a multi-variable NetCDF-3 with record
// variables and a CF grid mapping — then Save Image As writes each in its own format and the app
// reopens it with the same size, bands, pixels and georeferencing.
//
//   GW_DIST=dist-21-raster/gis-workbench.html npx playwright test tests/e2e/21-raster.spec.js --workers=2
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles, DIST as HELPERS_DIST } from './helpers.js';

const DIST = HELPERS_DIST; // GW_DIST (helpers.js): a build folder or its .html
const FX = (n) => resolve('fixtures/fx21/raster', n);
test.describe.configure({ timeout: 300000 });

const settle = (frame, n = 1) => frame.waitForFunction((k) => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex || l.error).length >= k, n, { timeout: 60000 });

/** The active layer: size, bands, model, format, a pixel row and the first tile's time. */
const facts = (frame) =>
  frame.evaluate(async () => {
    const a = window.gisworkbench;
    const l = a.activeLayer();
    const t0 = performance.now();
    await a.pool.run('tile', { handle: l.handle, level: 0, tx: 0, ty: 0, bands: [0] }, { affinity: l.affinity });
    const tileMs = performance.now() - t0;
    const row = (await a.pool.run('pixels', { handle: l.handle, x: 0, y: Math.floor(l.height / 2), w: Math.min(64, l.width), h: 1, bands: [0] }, { affinity: l.affinity })).values[0];
    const g = l.groundAt?.(l.width / 2, l.height / 2);
    return { name: l.rec.name, w: l.width, h: l.height, bands: l.bands, model: l.modelName, format: l.info.format, row, tileMs, centre: g ? [g.lat, g.lon] : null, layers: [...a.layers.values()].map((x) => ({ name: x.rec.name, visible: x.rec.visible !== false })) };
  });

async function saveAs(page, frame, fmt) {
  await frame.evaluate(() => void window.gisworkbench.commands.run('cnv.saveimage'));
  const dlg = frame.locator('[data-id="dialog:save-image"]');
  await dlg.locator('select').first().selectOption(fmt);
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.getByRole('button', { name: 'Save' }).click()]);
  return { path: await dl.path(), name: dl.suggestedFilename() };
}

/** Open a saved file alone (renamed back to its suggested name) in a new project. */
async function reopen(frame, out) {
  const bytes = [...readFileSync(out.path)];
  return frame.evaluate(
    async ({ bytes, name }) => {
      const a = window.gisworkbench;
      a.dirty = false;
      for (const mp of [...a.desktop.multiports]) a.desktop.removeMultiport(mp);
      a.desktop.addMultiport(a.newProject());
      await a.openFiles([new File([new Uint8Array(bytes)], name)]);
      const l = [...a.layers.values()][0];
      const row = (await a.pool.run('pixels', { handle: l.handle, x: 0, y: Math.floor(l.height / 2), w: Math.min(64, l.width), h: 1, bands: [0] }, { affinity: l.affinity })).values[0];
      const g = l.groundAt?.(l.width / 2, l.height / 2);
      return { w: l.width, h: l.height, bands: l.bands, model: l.modelName, format: l.info.format, row, centre: g ? [g.lat, g.lon] : null, error: l.error ?? null };
    },
    { bytes, name: out.name },
  );
}

test('REQ-FMT-24 REQ-FMT-25 SCN-28 ERDAS Imagine with an .ige spill file and .rrd overviews opens, and Save Image As writes an .img that reopens the same', async ({ page }) => {
  await page.addInitScript(() => delete window.showSaveFilePicker); // saves become downloads
  const { frame, logs } = await openApp(page, 'file', { htmlPath: DIST });
  await frame.evaluate(() => Object.assign(window.gisworkbench.runMode.caps, { fsaSave: false }));
  await openFiles(frame, [FX('hfa_spill.img'), FX('hfa_spill.ige')]);
  await settle(frame);
  const s = await facts(frame);
  expect([s.w, s.h, s.bands]).toEqual([300, 220, 2]);
  expect(s.format).toMatch(/ERDAS Imagine HFA \(u16, spill file hfa_spill\.ige/);
  expect(s.model).toMatch(/^Map \(EPSG:32611/);
  expect(s.tileMs, 'first tile ≤ 1 s').toBeLessThan(1000);
  // Overviews from an .rrd: native pyramid levels.
  await openFiles(frame, [FX('hfa_ovr_rrd.img'), FX('hfa_ovr_rrd.rrd')]);
  await settle(frame, 2);
  const o = await frame.evaluate(() => {
    const l = window.gisworkbench.activeLayer();
    return { name: l.rec.name, format: l.info.format };
  });
  expect(o.format).toMatch(/2 overview levels/);
  // Save Image As → ERDAS Imagine, reopened.
  await frame.evaluate(() => {
    const a = window.gisworkbench;
    const l = [...a.layers.values()].find((x) => /hfa_spill/.test(x.rec.name));
    a.store.transact('TE active layer', (tx) => tx.set(a.activePane().id, 'activeLayer', l.id));
  });
  const out = await saveAs(page, frame, 'hfa');
  expect(out.name).toBe('hfa_spill.img');
  expect(readFileSync(out.path).subarray(0, 15).toString('latin1')).toBe('EHFA_HEADER_TAG');
  const r = await reopen(frame, out);
  expect(r.error).toBeNull();
  expect([r.w, r.h, r.bands]).toEqual([s.w, s.h, s.bands]);
  expect(r.row).toEqual(s.row);
  expect(r.format).toMatch(/overview level/);
  expect(r.model).toMatch(/^Map \(EPSG:32611/);
  expect(r.centre[0]).toBeCloseTo(s.centre[0], 7);
  expect(r.centre[1]).toBeCloseTo(s.centre[1], 7);
  expect(logs).toEqual([]);
});

test('REQ-FMT-26 REQ-FMT-27 SCN-28 NetCDF-3 variables open as layers (record bands, CF grid mapping), and Save Image As writes a CF-1.8 NetCDF-3 that reopens the same', async ({ page }) => {
  await page.addInitScript(() => delete window.showSaveFilePicker); // saves become downloads
  const { frame, logs } = await openApp(page, 'file', { htmlPath: DIST });
  await frame.evaluate(() => Object.assign(window.gisworkbench.runMode.caps, { fsaSave: false }));
  await openFiles(frame, [FX('nc_cdf2_lcc_records.nc')]);
  await settle(frame, 2);
  const s = await facts(frame);
  expect([s.w, s.h, s.bands]).toEqual([33, 25, 3]);
  expect(s.format).toMatch(/NetCDF-3 CDF-2 (temp|pres) \((float|short), record variable, 3 bands\)/);
  expect(s.model).toMatch(/^Map \(.*fitted\)/);
  expect(s.layers.map((l) => l.visible)).toEqual([true, false]);
  expect(s.layers.map((l) => l.name)).toEqual(['nc_cdf2_lcc_records.nc [temp]', 'nc_cdf2_lcc_records.nc [pres]']);
  expect(s.tileMs, 'first tile ≤ 1 s').toBeLessThan(1000);
  const out = await saveAs(page, frame, 'nc3');
  expect(out.name).toMatch(/\.nc$/);
  expect([...readFileSync(out.path).subarray(0, 4)]).toEqual([0x43, 0x44, 0x46, 2]);
  const r = await reopen(frame, out);
  expect(r.error).toBeNull();
  expect([r.w, r.h, r.bands]).toEqual([s.w, s.h, s.bands]);
  expect(r.row).toEqual(s.row);
  expect(r.model).toMatch(/^Map/);
  expect(r.centre[0]).toBeCloseTo(s.centre[0], 6);
  expect(r.centre[1]).toBeCloseTo(s.centre[1], 6);
  // CDF-5 (64-bit data) with unsigned and 64-bit integer variables opens too.
  await openFiles(frame, [FX('nc_cdf5_polar_types.nc')]);
  await settle(frame, 2);
  const c5 = await frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => l.info.format));
  expect(c5.some((f) => /CDF-5 u16 \(ushort, record variable, 2 bands\)/.test(f))).toBe(true);
  expect(logs).toEqual([]);
});
