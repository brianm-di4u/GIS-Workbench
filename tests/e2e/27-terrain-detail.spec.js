// REG-010 (2.7.0 I3, #58) on the built file: a projected DEM used as terrain keeps its posts. A
// DEM not in EPSG:4326 used to be resampled to at most 2,048 posts a side, so a 1 m DEM larger than
// 2 km lost detail. A synthetic 1 m DEM in UTM 13N, 3,000 × 2,600 posts, with 8 m ripples, is used
// as terrain; the terrain grid must keep about 1 m posts and its heights must follow the ripples.
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import proj4 from 'proj4';
import { writeGeoTiff } from '../../app/src/formats/geotiff-writer.js';
import { openApp, openFiles } from './helpers.js';

const TMP = mkdtempSync(join(tmpdir(), 'gw27terrain-'));
test.afterAll(() => rmSync(TMP, { recursive: true, force: true }));
test.describe.configure({ timeout: 300000 });

const [W, H, X0, Y0] = [3000, 2600, 480000, 4405000]; // UTM 13N, north-west corner of the first post's pixel
const f = (e, n) => 1800 + 0.01 * (e - X0) + 2 * Math.sin((2 * Math.PI * (e - X0)) / 8) * Math.cos((2 * Math.PI * (Y0 - n)) / 8);

test('REG-010 a projected 1 m DEM used as terrain keeps its posts', async ({ page }) => {
  const z = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) z[j * W + i] = f(X0 + i + 0.5, Y0 - j - 0.5);
  const bytes = await writeGeoTiff({ width: W, height: H, bands: 1, type: 'f32', data: z }, { epsg: 26913, geotransform: [X0, 1, 0, Y0, 0, -1], nodata: NaN, description: 'REG-010 ripples' });
  const file = join(TMP, 'ripples_utm13_1m.tif');
  writeFileSync(file, bytes);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [file]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 120000 });
  // Sample points inside the DEM (away from its rotated edges), as geographic positions.
  const toGeo = proj4('+proj=utm +zone=13 +ellps=GRS80 +units=m +no_defs', 'EPSG:4326');
  const pts = [];
  for (let k = 0; k < 400; k++) {
    const e = X0 + 50 + ((k * 7919) % (W - 100)) + 0.37;
    const n = Y0 - 50 - ((k * 104729) % (H - 100)) - 0.61;
    const [lon, lat] = toGeo.forward([e, n]);
    pts.push({ lat, lon, want: f(e, n) });
  }
  const r = await frame.evaluate(async (pts) => {
    const app = window.gisworkbench;
    const g = await app.useAsTerrain([...app.layers.values()][0], 'egm96');
    const d = app.terrain.dems[0];
    const G = d.grid;
    const H = d.current ?? G.heights;
    // Bilinear on the terrain grid itself (what every terrain tool reads).
    const at = (lat, lon) => {
      const x = (lon - G.lon0) / G.dlon;
      const y = (G.lat0 - lat) / G.dlat;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const v = (a, b) => H[b * G.width + a];
      return (v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx) * (1 - fy) + (v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx) * fy;
    };
    const err = pts.map((p) => Math.abs(at(p.lat, p.lon) - p.want)).sort((a, b) => a - b);
    const lat = G.lat0 - (G.height * G.dlat) / 2;
    return { width: g.width, height: g.height, resampled: !!g.resampled, postM: [G.dlon * app.core.inverse(lat, 0, lat, 1).distance, G.dlat * app.core.inverse(lat - 0.5, 0, lat + 0.5, 0).distance], p50: err[200], p95: err[380], max: err.at(-1) };
  }, pts);
  console.log(JSON.stringify(r));
  expect(r.resampled).toBe(true);
  expect(r.width).toBeGreaterThan(2900);
  expect(r.height).toBeGreaterThan(2500);
  expect(r.postM[0]).toBeLessThan(1.05);
  expect(r.postM[1]).toBeLessThan(1.05);
  // 2 m ripples on an 8 m wavelength, read back bilinearly from the terrain grid: with the 2,048-post
  // cap (1.47 × 1.27 m posts) the 95th-percentile error was 0.55 m; at about 1 m posts it is 0.41 m.
  expect(r.p95).toBeLessThan(0.48);
  expect(logs).toEqual([]);
});
