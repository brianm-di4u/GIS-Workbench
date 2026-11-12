// SCN-76 REQ-GAP-83 time series, through the commands: a ten-year monthly NDVI stack (CF NetCDF-3,
// fixtures/timeseries) opens with a date on every band; the Time Series panel's slider shows a
// date; the temporal profile at a pixel and over a rectangle matches the file; Temporal Trend gives
// scipy's slope, p-value and date count at every pixel and Temporal Anomaly the reference anomaly
// (tests/tools/timeseries_ref.py); Time Stack orders two dated ENVI images on different grids and
// resamples one onto the other; the recipe op runs the trend headless.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const NC = resolve('fixtures/timeseries/ndvi-2010-2019.nc');
const REF = JSON.parse(readFileSync(resolve('fixtures/timeseries/ndvi-2010-2019.ref.json'), 'utf8'));
const { width: W, height: H, dates } = REF;
const NT = dates.length;

/** The file's values at pixel p, one per date (NaN for the fill value): ndvi ends the file. */
function fileSeries() {
  const b = readFileSync(NC);
  const dv = new DataView(b.buffer, b.byteOffset + b.length - NT * H * W * 4, NT * H * W * 4);
  return (p) => Array.from({ length: NT }, (_, k) => {
    const x = dv.getFloat32((k * W * H + p) * 4, false);
    return x === -9999 ? NaN : x;
  });
}

/** A one-band float ENVI image on a lat/lon grid: value = 100 × column + row. */
function enviImage(dir, name, { w, h, lon0, lat0, d, geo = true }) {
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[y * w + x] = 100 * x + y;
  writeFileSync(join(dir, `${name}.img`), Buffer.from(v.buffer));
  writeFileSync(join(dir, `${name}.hdr`), `ENVI\nsamples = ${w}\nlines = ${h}\nbands = 1\nheader offset = 0\nfile type = ENVI Standard\ndata type = 4\ninterleave = bsq\nbyte order = 0\n${geo ? `map info = {Geographic Lat/Lon, 1, 1, ${lon0}, ${lat0}, ${d}, ${d}, WGS-84, units=Degrees}\n` : ''}`);
  return [join(dir, `${name}.img`), join(dir, `${name}.hdr`)];
}

test('SCN-76 REQ-GAP-83 a NetCDF NDVI stack: dates, slider, profile, trend and anomaly against the reference', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.__saved = [];
    app.saveCapture = (blob, name) => app.__saved.push({ blob, name });
  });
  await openFiles(frame, [NC]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 90000 });
  const got = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    return { bands: l.bands, dates: app.timeseries.datesOf(l), names: app.msi.bandsOf(l).slice(0, 2).map((b) => b.name), trendOn: app.commands.get('ts.trend').enabled() };
  });
  expect(got.bands).toBe(NT);
  expect(got.dates).toEqual(dates);
  expect(got.names[0]).toBe('time=2010-01-16T00:00:00Z');
  expect(got.trendOn).toBe(true);

  // The panel and its slider.
  await frame.evaluate(() => window.gisworkbench.commands.run('ts.panel'));
  const slider = frame.locator('.ts-slider');
  await expect(slider).toBeVisible();
  await slider.fill('60');
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.activeLayer().chain.bands[0])).toBe(60);
  await expect(frame.locator('.ts-date')).toContainText('2015');
  // A model run's year 1 is labelled year 1, not 1901; 30 February is shown as written.
  const early = await frame.evaluate(() => [window.gisworkbench.timeseries.label('0001-07-15T00:00:00Z'), window.gisworkbench.timeseries.label('0001-02-30T00:00:00Z')]);
  expect(early[0]).not.toContain('19');
  expect(early[0]).toMatch(/\b1\b/);
  expect(early[1]).toBe('0001-02-30');
  // The slider keeps keyboard focus while it steps, and the rate keeps its value through a redraw.
  await slider.focus();
  await slider.press('ArrowRight');
  await slider.press('ArrowRight');
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.activeLayer().chain.bands[0])).toBe(62);
  expect(await slider.evaluate((s) => document.activeElement === s)).toBe(true);
  const rate = frame.getByLabel('Dates per second');
  await rate.selectOption('16');
  await frame.evaluate(() => window.gisworkbench.emit('state'));
  await expect(rate).toHaveValue('16');
  // Stopping a recording part way saves it and ends the pass.
  const rec = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    if (typeof VideoEncoder !== 'function') return { skipped: true };
    const n = app.__saved.length;
    const pass = app.timeseries.play(app.activeLayer(), { rate: 16, record: true });
    await new Promise((r) => setTimeout(r, 300));
    const during = !!app.compareRecording();
    app.timeseries.stop();
    await pass;
    for (let i = 0; i < 100 && app.__saved.length === n; i++) await new Promise((r) => setTimeout(r, 100));
    return { during, after: !!app.compareRecording(), saved: app.__saved.length - n };
  });
  if (!rec.skipped) expect(rec).toEqual({ during: true, after: false, saved: 1 });

  // The temporal profile: at a pixel, and per date over a rectangle with its missing values left out.
  const series = fileSeries();
  const prof = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const point = await app.timeseries.profile(l, { x: 7.4, y: 3.6 });
    const region = await app.timeseries.profile(l, { rect: { x0: 0, y0: 0, w: 4, h: 2 } });
    await app.timeseries.exportProfile(l, { rect: { x0: 0, y0: 0, w: 4, h: 2 } });
    const f = app.__saved.at(-1);
    return { point: point.mean, region: { mean: region.mean, n: region.n }, csvName: f.name, csv: (await f.blob.text()).split('\r\n').slice(0, 2) };
  });
  const expPoint = series(3 * W + 7);
  prof.point.forEach((v, k) => (Number.isNaN(expPoint[k]) ? expect(v).toBeNaN() : expect(v).toBeCloseTo(expPoint[k], 6)));
  // The same profile through the panel: point at the pixel, pin it, and export it with the panel's button.
  const at = await frame.evaluate(([x, y]) => ((x, y) => {
    const p = window.gisworkbench.activePane();
    const s = p.screenPoint(x, y);
    const r = p.el.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  })(x, y), [7.4, 3.6]);
  await page.mouse.move(at.x, at.y);
  await expect(frame.locator('[data-id="ts-chart"]')).toBeVisible();
  await frame.getByRole('button', { name: 'Pin the cursor' }).click();
  await expect(frame.getByLabel('Profile of')).toHaveValue('pinned');
  const nSaved = await frame.evaluate(() => window.gisworkbench.__saved.length);
  await frame.getByRole('button', { name: 'Export CSV…' }).click();
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.__saved.length)).toBe(nSaved + 1);
  const pinned = (await frame.evaluate(async () => window.gisworkbench.__saved.at(-1).blob.text())).split('\r\n').filter(Boolean);
  expect(pinned[0]).toBe('date,value');
  pinned.slice(1).forEach((row, k) => {
    const v = Number(row.split(',')[1]);
    if (Number.isNaN(expPoint[k])) expect(v).toBeNaN();
    else expect(v).toBeCloseTo(expPoint[k], 6);
  });
  for (let k = 0; k < NT; k++) {
    const vals = [0, 1, 2, 3, W, W + 1, W + 2, W + 3].map((p) => series(p)[k]).filter(Number.isFinite);
    expect(prof.region.n[k]).toBe(vals.length);
    expect(prof.region.mean[k]).toBeCloseTo(vals.reduce((a, b) => a + b, 0) / vals.length, 5);
  }
  expect(prof.csvName).toMatch(/_profile\.csv$/);
  expect(prof.csv[0]).toBe('date,mean,std,pixels');
  expect(prof.csv[1]).toMatch(/^2010-01-16T00:00:00Z,0\.\d+,/);

  // Temporal Trend through its dialog: scipy's slope, p-value and date count at every pixel.
  const n0 = await frame.evaluate(() => window.gisworkbench.layers.size);
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('ts.trend');
  });
  const dlg = frame.locator('[data-id="dialog:ts-trend"]');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Run' }).click();
  await frame.waitForFunction((n) => window.gisworkbench.layers.size > n, n0, { timeout: 120000 });
  const tr = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const c = await app.msi.cube(l);
    return { bands: l.bands, w: c.w, h: c.h, names: app.msi.bandsOf(l).map((b) => b.name), v: Array.from(c.v) };
  });
  expect([tr.bands, tr.w, tr.h]).toEqual([3, W, H]);
  expect(tr.names[1]).toBe('p-value');
  let worstSlope = 0;
  let worstLogP = 0;
  for (let p = 0; p < W * H; p++) {
    expect(tr.v[p * 3 + 2]).toBe(REF.trend.n[p]);
    worstSlope = Math.max(worstSlope, Math.abs(tr.v[p * 3] - REF.trend.slope[p]));
    worstLogP = Math.max(worstLogP, Math.abs(Math.log10(tr.v[p * 3 + 1]) - Math.log10(REF.trend.pvalue[p])));
  }
  console.log(JSON.stringify({ worstSlope, worstLogP }));
  expect(worstSlope).toBeLessThan(2e-6);
  expect(worstLogP).toBeLessThan(1e-4);

  // Temporal Anomaly headless (as a recipe or script would run it), by calendar month against 2010-2014.
  const an = await frame.evaluate(async (samples) => {
    const app = window.gisworkbench;
    const ser = [...app.layers.values()].find((l) => l.bands === 120 && !l.rec?.memory);
    app.store.transact('select', (tx) => tx.set(app.activePane().id, 'activeLayer', ser.id));
    const r = await app.commands.run('ts.anomaly', { headless: true, from: '2010-01-01', to: '2014-12-31', by: 'month' });
    const l = app.layers.get(r.id);
    const out = [];
    for (const s of samples) out.push(Array.from((await app.msi.cube(l, { x0: s.x, y0: s.y, w: 1, h: 1 })).v));
    return { bands: l.bands, dates: app.timeseries.datesOf(l).length, out };
  }, REF.anomaly);
  expect(an.bands).toBe(NT);
  expect(an.dates).toBe(NT);
  REF.anomaly.forEach((s, i) => s.anomaly.forEach((e, k) => (e === null ? expect(an.out[i][k]).toBeNaN() : expect(Math.abs(an.out[i][k] - e)).toBeLessThan(2e-6))));

  // The recipe op runs the trend with no dialog.
  const op = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ser = [...app.layers.values()].find((l) => l.bands === 120 && !l.rec?.memory);
    app.store.transact('select', (tx) => tx.set(app.activePane().id, 'activeLayer', ser.id));
    const n = app.layers.size;
    const r = await app.recipes.runOp('timeTrend', {});
    return { summary: r.summary, added: app.layers.size - n };
  });
  expect(op.added).toBe(1);
  expect(op.summary).toMatch(/768/);

  // Inside an AOI: the trend and the anomaly cover its pixel window, and the anomaly keeps the calendar.
  const aoi = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ser = [...app.layers.values()].find((l) => l.bands === 120 && !l.rec?.memory);
    app.store.transact('select', (tx) => tx.set(app.activePane().id, 'activeLayer', ser.id));
    app.setAoi([[2.3, 3.7], [10.2, 3.7], [10.2, 8.1], [2.3, 8.1]], 'image');
    const tr = app.layers.get((await app.commands.run('ts.trend', { headless: true })).id);
    const c = await app.msi.cube(tr);
    app.store.transact('select', (tx) => tx.set(app.activePane().id, 'activeLayer', ser.id));
    // The series on its eighth date; the anomaly opens on its first, and the panel must say so.
    app.timeseries.show(ser, 7);
    const an = app.layers.get((await app.commands.run('ts.anomaly', { headless: true, from: '2010-01-01', to: '2014-12-31' })).id);
    await new Promise((res) => setTimeout(res, 200));
    const shown = { text: document.querySelector('.ts-date')?.textContent, want: app.timeseries.label(app.timeseries.datesOf(an)[an.chain.bands[0]]), band: an.chain.bands[0] };
    return { w: c.w, h: c.h, slope: Array.from({ length: c.w * c.h }, (_, i) => c.v[i * 3]), an: [an.width, an.height, app.timeseries.datesOf(an)?.length], cal: [app.msi.bandsOf(an)[0].calendar, app.msi.bandsOf(ser)[0].calendar], shown };
  });
  expect(aoi.shown.band).toBe(0);
  expect(aoi.shown.text).toBe(aoi.shown.want);
  // floor(2.3)..ceil(10.2) by floor(3.7)..ceil(8.1): 9 by 6 pixels from (2, 3).
  expect([aoi.w, aoi.h]).toEqual([9, 6]);
  aoi.slope.forEach((s, i) => expect(Math.abs(s - REF.trend.slope[(3 + Math.floor(i / 9)) * W + 2 + (i % 9)])).toBeLessThan(2e-6));
  expect(aoi.an).toEqual([9, 6, NT]);
  expect(aoi.cal[0]).toBe(aoi.cal[1] ?? 'standard');

  // A series longer than the bundle takes is refused with a message that says so.
  const long = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ser = [...app.layers.values()].find((l) => l.bands === 120 && !l.rec?.memory);
    const n = 1025;
    const day = (i) => new Date(Date.UTC(2000, 0, 1 + i)).toISOString().replace('.000', '');
    const l = await app.openMemoryLayer(ser, { name: 'daily', bands: n, sampleType: 'f32', planes: Array.from({ length: n }, () => new Float32Array([1])), nodata: NaN, width: 1, height: 1, info: { bandsMeta: Array.from({ length: n }, (_, i) => ({ name: String(i), cw: NaN, fwhm: NaN, bad: false, time: day(i) })) } });
    app.store.transact('select', (tx) => tx.set(app.activePane().id, 'activeLayer', l.id));
    await app.commands.run('aoi.clear');
    try {
      await app.timeseries.trend(l);
      return null;
    } catch (e) {
      return { code: e.code, msg: e.message };
    }
  });
  expect(long?.code).toBe('E_NEED_SERIES');
  expect(long?.msg).toMatch(/1[,.\s]?025 dates/);
  expect(logs).toEqual([]);
});

test('SCN-76 REQ-GAP-83 Time Stack orders dated images and resamples one on another grid', async ({ page }, info) => {
  test.setTimeout(180000);
  const dir = info.outputPath('stack');
  mkdirSync(dir, { recursive: true });
  // The later image is first on disk, on a grid 2.5 times as fine over the same place (no reference
  // pixel centre falls on one of its pixel edges, so nearest neighbour has one answer).
  const files = [
    ...enviImage(dir, 'LC08_L2SP_044034_20200715_20200912_02_T1_NDVI', { w: 50, h: 25, lon0: -105, lat0: 40, d: 0.004 }),
    ...enviImage(dir, 'LC08_L2SP_044034_20190713_20200827_02_T1_NDVI', { w: 20, h: 10, lon0: -105, lat0: 40, d: 0.01 }),
  ];
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, files);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length >= 2, null, { timeout: 90000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ids = [...app.layers.values()].map((l) => l.id);
    const s = await app.commands.run('ts.stack', { layers: ids });
    const l = app.layers.get(s.id);
    const c = await app.msi.cube(l);
    return { ...s, w: l.width, h: l.height, v: Array.from(c.v), panelOn: app.commands.get('ts.trend').enabled() };
  });
  expect(r.dates).toEqual(['2019-07-13T00:00:00Z', '2020-07-15T00:00:00Z']);
  expect(r.resampled).toBe(1);
  // The 2019 grid (20 × 10, 0.01°) is the reference; the 2020 image is read at its pixel centres:
  // the centre of reference pixel x is at 2.5x + 1.25 fine pixels.
  expect([r.w, r.h]).toEqual([20, 10]);
  for (const [x, y] of [[0, 0], [7, 3], [19, 9]]) {
    const p = y * 20 + x;
    expect(r.v[p * 2]).toBe(100 * x + y);
    expect(r.v[p * 2 + 1]).toBe(100 * Math.floor(2.5 * x + 1.25) + Math.floor(2.5 * y + 1.25));
  }
  // Dates given with the layers go with the layer named in the same place, whatever the open order:
  // the fine 2020 image dated first becomes the reference grid.
  const given = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].filter((l) => !l.rec?.memory);
    const coarse = ls.find((l) => l.width === 20);
    const fine = ls.find((l) => l.width === 50);
    const run = (layers, dates) => app.commands.run('ts.stack', { layers, dates }).then((s) => [app.layers.get(s.id).width, app.layers.get(s.id).height]);
    const a = await run([coarse.id, fine.id], ['2021-01-01T00:00:00Z', '2018-01-01T00:00:00Z']);
    const b = await run([fine.id, coarse.id], ['2018-01-01T00:00:00Z', '2021-01-01T00:00:00Z']);
    // One date for two images: the command warns and makes nothing.
    const n = app.layers.size;
    const short = await app.commands.run('ts.stack', { layers: [coarse.id, fine.id], dates: ['2021-01-01T00:00:00Z'] });
    return { a, b, short: [short ?? null, app.layers.size - n] };
  });
  expect(given.a).toEqual([50, 25]);
  expect(given.b).toEqual([50, 25]);
  expect(given.short).toEqual([null, 0]);
  expect(logs).toEqual([]);
});

test('SCN-76 REQ-GAP-83 Time Stack of frames with no georeference: one grid by size, refused when sizes differ', async ({ page }, info) => {
  test.setTimeout(180000);
  const dir = info.outputPath('frames');
  mkdirSync(dir, { recursive: true });
  const files = [
    ...enviImage(dir, 'frame_20200101', { w: 12, h: 8, geo: false }),
    ...enviImage(dir, 'frame_20200201', { w: 12, h: 8, geo: false }),
    ...enviImage(dir, 'frame_20200301', { w: 6, h: 4, geo: false }),
  ];
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, files);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length >= 3, null, { timeout: 90000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()];
    const same = ls.filter((l) => l.width === 12);
    const s = await app.commands.run('ts.stack', { layers: same.map((l) => l.id) });
    const c = await app.msi.cube(app.layers.get(s.id));
    let refused = null;
    try {
      await app.timeseries.stack(ls);
    } catch (e) {
      refused = e.code;
    }
    return { resampled: s.resampled, dates: s.dates, v: Array.from(c.v.slice(0, 4)), nan: Array.from(c.v).some(Number.isNaN), refused };
  });
  expect(r.dates).toEqual(['2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z']);
  expect(r.resampled).toBe(0);
  expect(r.nan).toBe(false);
  // Pixel (0, 0) and (1, 0), both dates: 100x + y.
  expect(r.v).toEqual([0, 0, 100, 100]);
  expect(r.refused).toBe('E_NEED_DATES');
  expect(logs).toEqual([]);
});
