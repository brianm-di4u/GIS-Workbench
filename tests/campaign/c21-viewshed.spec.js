// TE-C21 Phase 3 accuracy — viewshed against gdal_viewshed on real terrain (closes spike S-15,
// AT-18.2: ≥ 99 % of posts agree; -cc 0.87 curvature/refraction). The DEM is a 1025² UTM crop of
// Copernicus GLO-30 and the reference raster comes from build/campaign/derive.py.
// Each app post (lat, lon) is mapped to UTM 13N with the app's own core.utm, then to the GDAL
// raster's pixel, so the comparison does not depend on how the app grids the terrain.
// REQ-DEM-13, REQ-DEM-18, AT-18.2, AT-18.4.
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { openApp, openFiles, settledAny, record, item, paths } from './helpers.js';

const it = (() => {
  try {
    return item('derived-dem-utm13-viewshed');
  } catch {
    return null;
  }
})();

test('TE-C21 REQ-DEM-13 AT-18.2 S-15 viewshed agrees with gdal_viewshed on Copernicus GLO-30', async ({ page }, info) => {
  test.setTimeout(300_000);
  const dem = it && paths(it, ['primary'])[0];
  const [vsTif, vsJson] = it ? paths(it, ['truth']) : [];
  test.skip(!dem || !existsSync(dem) || !existsSync(vsTif), 'derived viewshed data missing (run build/campaign/derive.py)');
  const T = JSON.parse(readFileSync(vsJson, 'utf8'));
  const tiff = await fromArrayBuffer(readFileSync(vsTif).buffer.slice(0));
  const img = await tiff.getImage();
  const [ref] = await img.readRasters();
  const W = img.getWidth();
  const H = img.getHeight();
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution();
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [dem]);
  await settledAny(frame);
  const r = await frame.evaluate(async (t) => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    await app.useAsTerrain(l, 'hae');
    const d = app.terrain.entry(l.id);
    const out = {};
    for (const curvature of [true, false]) {
      const v = await app.terrainAnalysis.viewshed([{ lat: t.observer.lat, lon: t.observer.lon }], { observerH: t.observerH, targetH: t.targetH, cc: t.cc, curvature, d });
      const g = v.grid;
      const posts = [];
      for (let j = 0; j < g.height; j += 2)
        for (let i = 0; i < g.width; i += 2) {
          const val = v.vis[j * g.width + i];
          if (val === 255) continue;
          const lat = g.lat0 - j * g.dlat;
          const lon = g.lon0 + i * g.dlon;
          const u = app.core.utm(lat, lon, 13);
          posts.push([u.easting, u.northing, val > 0 ? 1 : 0]);
        }
      out[curvature ? 'cc' : 'flat'] = { posts, stats: v.stats };
    }
    return out;
  }, T);
  const score = (posts) => {
    let n = 0;
    let agree = 0;
    for (const [e, nn, vis] of posts) {
      const c = Math.floor((e - ox) / rx);
      const rr = Math.floor((nn - oy) / ry);
      if (c < 1 || rr < 1 || c >= W - 1 || rr >= H - 1) continue; // edge posts: resampling differs
      n++;
      if ((ref[rr * W + c] === 255 ? 1 : 0) === vis) agree++;
    }
    return { n, agree, frac: n ? agree / n : 0 };
  };
  const cc = score(r.cc.posts);
  const flat = score(r.flat.posts);
  record('c21-viewshed', info.project.name, { key: 'gdal-viewshed', cc, flatVsGdalCc: flat, stats: r.cc.stats, command: T.command });
  expect(logs).toEqual([]);
  expect(cc.n, 'posts compared').toBeGreaterThan(10_000);
  expect(cc.frac, `agreement with gdal_viewshed -cc 0.87 (${cc.agree}/${cc.n})`).toBeGreaterThanOrEqual(0.99);
});
