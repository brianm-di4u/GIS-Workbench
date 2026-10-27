// SCN-18 R2 parts (viewshed and HLZ) on FX-05: the viewshed against independent sight lines
// (AT-18.2 proxy: gdal_viewshed is not available here, spike S-15), curvature on/off (AT-18.4),
// inverse and overlap, the HLZ on the FX-05 DSM with a building and trees (AT-18.3), the DTM
// warning (AT-18.5), raster-to-vector (REQ-DEM-18) and the DEM difference (REQ-DEM-15).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const truth = JSON.parse(readFileSync(resolve('fixtures/fx05/fx05_dsm_truth.json'), 'utf8'));

test('SCN-18 REQ-DEM-13 REQ-DEM-14 REQ-DEM-15 REQ-DEM-18 REQ-PRF-07 FX-05 viewshed, HLZ, raster to vector, DEM difference', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx05/fx05_dem_hae.tif'), resolve('fixtures/fx05/fx05_dsm_hae.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length === 2, null, { timeout: 60000 });
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()];
    const demL = ls.find((l) => /dem/i.test(l.rec.name));
    const dsmL = ls.find((l) => /dsm/i.test(l.rec.name));
    await app.useAsTerrain(demL, 'hae');
    await app.useAsTerrain(dsmL, 'hae');
    const dem = app.terrain.entry(demL.id);
    const dsm = app.terrain.entry(dsmL.id);
    const TA = app.terrainAnalysis;
    // Viewshed from the ridge-side valley, 2 m mast, over 1 km.
    const obs = { lat: 34.5 - 200 / 110940, lon: -116.5 + 150 / 92000 };
    const v = await TA.viewshed([obs], { observerH: 2, targetH: 1.8, maxDist: 1000, d: dem });
    const vf = await TA.viewshed([obs], { observerH: 2, targetH: 1.8, maxDist: 1000, curvature: false, d: dem });
    const curvDiff = v.vis.reduce((n, x, k) => n + (x !== vf.vis[k] ? 1 : 0), 0);
    // Independent sight lines (the R1 LOS tool's profile with the same heights) at 300 posts.
    const g = v.grid;
    let agree = 0;
    let n = 0;
    for (let k = 0; k < 300; k++) {
      const i = Math.floor(((k * 7919) % 997) / 997 * g.width);
      const j = Math.floor(((k * 104729) % 991) / 991 * g.height);
      const val = v.vis[j * g.width + i];
      if (val === 255) continue;
      const lat = g.lat0 - j * g.dlat;
      const lon = g.lon0 + i * g.dlon;
      const prof = app.measureLos.profile([{ lat: obs.lat, lon: obs.lon }, { lat, lon }], 1024);
      const los = app.measureLos.lineOfSight(prof, 2, 1.8, 0.13);
      n++;
      if (los.visible === (val === 1)) agree++;
    }
    // Inverse and overlap.
    const inv = await TA.viewshed([obs], { observerH: 2, targetH: 1.8, maxDist: 1000, inverse: true, d: dem });
    const obs2 = { lat: obs.lat + 300 / 110940, lon: obs.lon - 300 / 92000 };
    const ov = await TA.viewshed([obs, obs2], { observerH: 2, targetH: 1.8, d: dem });
    const maxCount = ov.vis.reduce((m, x) => (x !== 255 ? Math.max(m, x) : m), 0);
    // HLZ on the DSM (AT-18.3).
    const hz = await TA.hlz({ doctrine: 'light', d: dsm });
    const G = hz.grid;
    const post = (lat, lon) => Math.round((G.lat0 - lat) / G.dlat) * G.width + Math.round((lon - G.lon0) / G.dlon);
    const kx = 111320 * Math.cos((truth.site.lat * Math.PI) / 180);
    const ky = 110940;
    let padOk = 0;
    let padN = 0;
    let nearBad = 0;
    let nearN = 0;
    const b = truth.building;
    for (let dn = -140; dn <= 140; dn += 4)
      for (let de = -140; de <= 140; de += 4) {
        const e = truth.pad.e + de;
        const nn = truth.pad.n + dn;
        const lat = truth.site.lat + nn / ky;
        const lon = truth.site.lon + e / kx;
        const k = post(lat, lon);
        const rPad = Math.hypot(de, dn);
        const dB = Math.max(Math.abs(e - b.e) - b.half, Math.abs(nn - b.n) - b.half, 0);
        const trees = Math.min(...truth.trees.map((t) => Math.hypot(e - t.e, nn - t.n) - t.r));
        if (rPad < truth.pad.r - 25 && dB > 12.5 + 10 + 6 && trees > 12.5 + 10 + 6) {
          padN++;
          if (hz.classes[k] === 2) padOk++;
        }
        if (dB < 12.5 + 10 - 2) {
          nearN++;
          if (hz.classes[k] === 0) nearBad++;
        }
      }
    // AT-18.5: a DTM-tagged input warns.
    dem.kind = 'DTM';
    const hzDtm = await TA.hlz({ doctrine: 'light', d: dem });
    // REQ-DEM-18: suitable areas as polygons; the pad centre lies in one.
    const rings = TA.rasterToPolygons(G, hz.classes, 2, { minArea: 100 });
    const inRing = (ring, lon, lat) => {
      let c = false;
      for (let a = 0, bb = ring.length - 1; a < ring.length; bb = a++) if (ring[a][1] > lat !== ring[bb][1] > lat && lon < ((ring[bb][0] - ring[a][0]) * (lat - ring[a][1])) / (ring[bb][1] - ring[a][1]) + ring[a][0]) c = !c;
      return c;
    };
    const pc = { lat: truth.site.lat + (truth.pad.n - 80) / ky, lon: truth.site.lon + (truth.pad.e - 40) / kx };
    const inside = rings.filter((rg) => inRing(rg, pc.lon, pc.lat)).length;
    // REQ-DEM-15: DSM − DEM shows the building.
    const df = TA.demDifference(dsm, dem, {});
    // PRF-07 on this machine: a 1025² viewshed in the worker and with WebGPU (warm, then timed).
    const big = await TA.viewshed([obs], { observerH: 2, targetH: 1.8, maxDist: 1024, engine: 'worker', d: dem });
    let gpu = null;
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) {
      await TA.viewshed([obs], { observerH: 2, targetH: 1.8, maxDist: 1024, engine: 'gpu', d: dem });
      const gb = await TA.viewshed([obs], { observerH: 2, targetH: 1.8, maxDist: 1024, engine: 'gpu', d: dem });
      let same = 0;
      for (let k = 0; k < gb.vis.length; k++) if (gb.vis[k] === big.vis[k]) same++;
      // Two observers with a fan and curvature: counts agree too.
      const o2 = await TA.viewshed([obs, obs2], { observerH: 2, targetH: 1.8, azStart: 300, azEnd: 60, engine: 'gpu', d: dem });
      const w2 = await TA.viewshed([obs, obs2], { observerH: 2, targetH: 1.8, azStart: 300, azEnd: 60, engine: 'worker', d: dem });
      let same2 = 0;
      for (let k = 0; k < o2.vis.length; k++) if (o2.vis[k] === w2.vis[k]) same2++;
      gpu = { ms: gb.stats.ms, engine: gb.stats.engine, agree: same / gb.vis.length, agree2: same2 / o2.vis.length, w: gb.grid.width };
    }
    return { gpu, vis: v.stats, curvDiff, agree, n, invVisible: inv.stats.visibleFraction, maxCount, padOk, padN, nearBad, nearN, warnDtm: hzDtm.warnings, warnDsm: hz.warnings, rings: rings.length, inside, diff: df.stats, big: { w: big.grid.width, h: big.grid.height, ms: big.stats.ms } };
  }, truth);
  console.log(JSON.stringify(r));
  // AT-18.2 (proxy) and AT-18.4
  expect(r.n).toBeGreaterThan(200);
  expect(r.agree / r.n).toBeGreaterThanOrEqual(0.97);
  expect(r.vis.visibleFraction).toBeGreaterThan(0.05);
  expect(r.curvDiff).toBeGreaterThan(0);
  expect(r.invVisible).toBeGreaterThan(0);
  expect(r.maxCount).toBe(2);
  // AT-18.3
  expect(r.padOk / r.padN).toBeGreaterThanOrEqual(0.95);
  expect(r.nearBad / r.nearN).toBeGreaterThanOrEqual(0.95);
  expect(r.warnDsm).toEqual([]);
  // AT-18.5
  expect(r.warnDtm.join(' ')).toMatch(/DTM/);
  // REQ-DEM-18 and REQ-DEM-15
  expect(r.inside).toBeGreaterThanOrEqual(1);
  expect(r.diff.max).toBeGreaterThan(14);
  expect(Math.abs(r.diff.mean)).toBeLessThan(0.5);
  // PRF-07 (≤ 2 s in a worker)
  expect(r.big.ms).toBeLessThan(2000);
  if (r.gpu) {
    expect(r.gpu.engine).toBe('webgpu');
    expect(r.gpu.w).toBe(r.big.w);
    expect(r.gpu.agree).toBeGreaterThanOrEqual(0.999);
    expect(r.gpu.agree2).toBeGreaterThanOrEqual(0.999);
    expect(r.gpu.ms).toBeLessThan(250);
  }
  expect(logs).toEqual([]);
});
