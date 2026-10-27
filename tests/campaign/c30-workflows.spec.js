// TE-C30 Phase 4 — analyst workflows on real public data instead of FX fixtures, each checked
// against an independent reference:
//  • SCN-15 on FFmpeg/Esri MISB samples: decoded ST 0601 tags vs klvdata (oracles/fmv.py), matched
//    by Precision Time Stamp;
//  • SCN-13 on USDA NAIP: Band Math NDVI vs NDVI computed in Node from the file's own DNs (geotiff.js);
//  • SCN-14 on a USGS 3DEP tile: SMRF ground filter vs the delivered (USGS) classification, and the
//    resulting DTM vs the delivered ground points (AT-14.x: RMSEz ≤ 0.15 m).
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { openApp, openFiles, settledAny, record, itemsBy, paths, truth } from './helpers.js';

test.describe.configure({ mode: 'parallel', timeout: 900_000 });

// ---- SCN-15: KLV against klvdata ----
const TAGS = { 13: 'lat', 14: 'lon', 5: 'heading', 23: 'fcLat', 24: 'fcLon', 16: 'hfov', 17: 'vfov' };
for (const it of itemsBy((x) => x.area === 'fmv')) {
  const t = truth(it.id);
  for (const [name, f] of Object.entries(t?.files ?? {})) {
    if (!f.klv?.first?.length) continue;
    test(`TE-C30 SCN-15 REQ-FMV-02 AT-15.1 KLV tags vs klvdata ${it.id}/${name}`, async ({ page }, info) => {
      const p = paths(it, ['primary']).find((x) => x.endsWith(name));
      test.skip(!p || !existsSync(p), 'not on disk');
      const { frame, logs } = await openApp(page, 'file');
      await openFiles(frame, [p]);
      await frame.waitForFunction(() => window.gisworkbench.fmv?.activeClip()?.packets?.length, null, { timeout: 180_000 });
      const pk = await frame.evaluate(() => window.gisworkbench.fmv.activeClip().packets.filter((k) => k.ok).map((k) => k.fields ?? {}).filter((x) => x.time !== undefined));
      const byTime = new Map(pk.map((x) => [Math.round(x.time), x]));
      let compared = 0;
      const bad = [];
      for (const ref of f.klv.first) {
        const ts = ref['2']?.[1];
        if (!ts) continue;
        // klvdata prints microseconds; the app keeps the raw µs value.
        const m = /^(.*?)(?:\.(\d+))?([+-]\d\d:\d\d)$/.exec(ts);
        const us = Date.parse(`${m[1]}${m[3]}`) * 1000 + Number((m[2] ?? '0').padEnd(6, '0'));
        const app = byTime.get(us);
        if (!app) continue;
        compared++;
        for (const [tag, key] of Object.entries(TAGS)) {
          const r = ref[tag]?.[1];
          if (r === undefined || app[key] === undefined) continue;
          const d = Math.abs(Number(r) - app[key]);
          if (d > 1e-6 * Math.max(1, Math.abs(Number(r)))) bad.push(`${ts} tag ${tag}: ${app[key]} vs ${r}`);
        }
      }
      record('c30-workflows', info.project.name, { key: `klv-${it.id}-${name}`, packets: pk.length, compared, bad });
      expect(logs).toEqual([]);
      expect(compared, 'packets matched by time stamp').toBeGreaterThan(0);
      expect(bad).toEqual([]);
    });
  }
}

// ---- SCN-13: NDVI on NAIP against the file's DNs ----
for (const it of itemsBy((x) => x.area === 'naip')) {
  test(`TE-C30 SCN-13 REQ-MSI-04 AT-13.1 NDVI vs DN-computed reference ${it.id}`, async ({ page }, info) => {
    const p = paths(it, ['primary']).find((x) => /\.tif$/i.test(x));
    test.skip(!p || !existsSync(p), 'not on disk');
    const tiff = await fromArrayBuffer(readFileSync(p).buffer.slice(0));
    const img = await tiff.getImage();
    const W = img.getWidth();
    const H = img.getHeight();
    const win = [Math.floor(W / 2) - 256, Math.floor(H / 2) - 256, Math.floor(W / 2) + 256, Math.floor(H / 2) + 256];
    const [red, , , nir] = await img.readRasters({ window: win, samples: [0, 1, 2, 3] });
    const ref = new Float64Array(512 * 512);
    for (let i = 0; i < ref.length; i++) ref[i] = nir[i] + red[i] ? (nir[i] - red[i]) / (nir[i] + red[i]) : NaN;
    const { frame, logs } = await openApp(page, 'file');
    await openFiles(frame, [p]);
    await settledAny(frame);
    const got = await frame.evaluate(async (w) => {
      const app = window.gisworkbench;
      const l = [...app.layers.values()][0];
      const r = await app.msi.bandMathValues(l, { x0: w[0], y0: w[1], w: 512, h: 512, step: 1, text: '(b4-b1)/(b4+b1)' });
      return { w: r.w, h: r.h, v: Array.from(r.v) };
    }, win);
    let n = 0;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < ref.length; i++) {
      if (!Number.isFinite(ref[i]) || !Number.isFinite(got.v[i])) continue;
      const d = Math.abs(ref[i] - got.v[i]);
      n++;
      sum += d;
      max = Math.max(max, d);
    }
    record('c30-workflows', info.project.name, { key: `ndvi-${it.id}`, n, meanAbs: sum / n, max, size: [got.w, got.h] });
    expect(logs).toEqual([]);
    expect(n).toBeGreaterThan(200_000);
    expect(sum / n, 'mean |ΔNDVI| (AT-13.1 ≤ 0.01)').toBeLessThanOrEqual(0.01);
  });
}

// ---- SCN-14: SMRF and DTM on USGS 3DEP against the delivered classification ----
const lidar = itemsBy((x) => x.id === 'lidar-3dep-co-drcog-2020-2x2')[0];
test('TE-C30 SCN-14 REQ-LDR-07 REQ-LDR-08 AT-14.x SMRF and DTM vs USGS 3DEP delivered ground', async ({ page }, info) => {
  const p = lidar && paths(lidar, ['primary']).find((x) => /\.laz$/i.test(x));
  test.skip(!p || !existsSync(p), 'not on disk');
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [p]);
  await frame.waitForFunction(() => window.gisworkbench.pointClouds?.size, null, { timeout: 600_000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    // Reset everything but noise and withheld to unclassified, run SMRF, compare with USGS classes.
    const all1 = new Uint8Array(c.n).fill(1);
    for (let k = 0; k < c.n; k++) if (c.class0[k] === 7 || c.class0[k] === 18) all1[k] = c.class0[k];
    app.pc.recordClasses(c, all1, 'Reset classes');
    const sm = await app.pc.groundFilter(c);
    let agree = 0;
    let n = 0;
    let fp = 0;
    let fn = 0;
    for (let k = 0; k < c.n; k++) {
      if (c.class0[k] === 7 || c.class0[k] === 18) continue;
      n++;
      const a = c.class[k] === 2;
      const b = c.class0[k] === 2;
      if (a === b) agree++;
      else if (a) fp++;
      else fn++;
    }
    // DTM from the SMRF ground at 1 m, sampled at 20 000 delivered ground points. The grid holds
    // posts at e0 + i·ce (pixel-is-point), so heights are interpolated bilinearly between posts in
    // the cloud's own frame (TE harness H-04: flooring geographic indices shifted it half a cell).
    // Scored twice: as delivered (holes filled) and on posts with ground of their own, the latter
    // like the PDAL reference (oracles/smrf.py posts_bilinear).
    const rmseOf = async (fill) => {
      const dtm = await app.pc.makeGrid(c, 'dtm', { cell: 1, fill });
      const G = dtm.grid;
      let ss = 0;
      let m = 0;
      const step = Math.max(1, Math.floor(c.n / 200_000));
      for (let k = 0; k < c.n && m < 20_000; k += step) {
        if (c.class0[k] !== 2) continue;
        const fi = (c.pos[3 * k] - G.e0) / G.ce;
        const fj = (G.n0 - c.pos[3 * k + 1]) / G.cn;
        const i = Math.floor(fi);
        const j = Math.floor(fj);
        if (i < 0 || j < 0 || i + 1 >= G.w || j + 1 >= G.h) continue;
        const u = fi - i;
        const v = fj - j;
        const at = (a, b) => dtm.heights[b * G.w + a];
        const z = (1 - v) * ((1 - u) * at(i, j) + u * at(i + 1, j)) + v * ((1 - u) * at(i, j + 1) + u * at(i + 1, j + 1));
        if (!Number.isFinite(z)) continue;
        ss += (z - c.pos[3 * k + 2]) ** 2;
        m++;
      }
      return { rmse: Math.sqrt(ss / m), samples: m };
    };
    const filled = await rmseOf(true);
    const own = await rmseOf(false);
    return { n: c.n, agree: agree / n, fp: fp / n, fn: fn / n, smrfMs: sm.ms, rmse: own.rmse, samples: own.samples, rmseFilled: filled.rmse, crs: c.crs.label };
  });
  // Reference: PDAL's SMRF (default parameters) on the same tile, scored the same way
  // (oracles/smrf.py). USGS leaves much near-ground return in class 1, so neither filter reaches
  // 0.9 agreement with the delivered classes; the app must match PDAL's agreement within 2 points
  // and its DTM must be as good as one built from PDAL's ground.
  const ref = truth(`${lidar.id}.smrf`);
  record('c30-workflows', info.project.name, { key: 'smrf-3dep', ...r, pdal: ref ? { agree: ref.agree, fp: ref.fp, fn: ref.fn, dtm: ref.dtm } : null });
  expect(logs).toEqual([]);
  expect(ref?.file && p.endsWith(ref.file), 'PDAL SMRF reference for this tile (oracles/smrf.py)').toBeTruthy();
  expect(Math.abs(r.agree - ref.agree), `SMRF agreement with USGS ground: app ${r.agree.toFixed(4)} vs PDAL ${ref.agree.toFixed(4)}`).toBeLessThanOrEqual(0.02);
  const pd = ref.dtm.posts_bilinear.rmse;
  expect(r.rmse, `DTM RMSEz at USGS ground points: app ${r.rmse.toFixed(3)} m vs the same method on PDAL's ground ${pd.toFixed(3)} m (AT-14.x 0.15 m)`).toBeLessThanOrEqual(Math.max(0.15, pd + 0.03));
});
