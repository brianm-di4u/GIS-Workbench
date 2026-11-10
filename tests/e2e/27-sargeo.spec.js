// SCN-87 (part) REQ-GAP-90 REG-085: SAR ▸ Terrain Correction on a real Sentinel-1 IW SLC swath (the
// T&E corpus's Las Vegas scene; third-party data, so it is not in the repository and the test skips
// without it). The DEM is flat at the scene's height, so the radiometry has a closed form: γ⁰/β⁰ is
// tan θ on flat ground, and there is no layover or shadow. Geolocation against the product's own
// grid is the unit test's (tests/unit/sargeo.test.js); against a reference processor's product is
// SCN-87's remaining part.
import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openApp, openFiles } from './helpers.js';
import { writeGeoTiff } from '../../app/src/formats/geotiff-writer.js';

const CORPUS = process.env.TE_CORPUS ?? 'C:/GIS Workbench/TE-corpus';
const SAFE = join(CORPUS, 'sar-s1-iw-slc-vegas-20240626-20240708', 'S1A_IW_SLC__1SDV_20240626T134404_20240626T134432_054495_06A1B9_6F14.SAFE');

test('SCN-87 REQ-GAP-90 Terrain Correction of a Sentinel-1 IW SLC swath: γ⁰ on flat ground is β⁰·tan θ, no layover or shadow', async ({ page }) => {
  test.skip(!existsSync(join(SAFE, 'measurement')), 'T&E corpus absent (Sentinel-1 scene)');
  test.setTimeout(600_000);
  const pick = (dir, re) => join(SAFE, dir, readdirSync(join(SAFE, dir)).find((f) => re.test(f)));
  const files = [join(SAFE, 'manifest.safe'), pick('annotation', /^s1a-iw1-slc-vv-.*\.xml$/), pick('annotation/calibration', /^calibration-s1a-iw1-slc-vv-/), pick('annotation/calibration', /^noise-s1a-iw1-slc-vv-/), pick('measurement', /^s1a-iw1-slc-vv-.*\.tiff$/)];
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, files);
  expect(log.flatMap((x) => x.errors)).toEqual([]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.info?.meta?.s1 && l.lutTex), null, { timeout: 180_000 });
  // A 0.05° × 0.06° patch in the middle of the swath, at the mean height of the grid points in it.
  const box = await frame.evaluate(() => {
    const l = [...window.gisworkbench.layers.values()].find((x) => x.info?.meta?.s1);
    const g = l.info.meta.s1.annotation.grid;
    const nx = g.pixels.length;
    const k = Math.floor(g.lines.length / 2) * nx + Math.floor(nx / 2);
    const lat = g.lat[k];
    const lon = g.lon[k];
    const near = g.height.filter((_, i) => Math.abs(g.lat[i] - lat) < 0.2 && Math.abs(g.lon[i] - lon) < 0.3);
    return { lat, lon, h: near.reduce((s, x) => s + x, 0) / near.length, inc: g.incidence[k], orbit: l.info.meta.s1.annotation.orbit.t.length };
  });
  expect(box.orbit).toBe(17);
  const [w, h, d] = [200, 166, 0.0003];
  const lat0 = box.lat + 0.025;
  const lon0 = box.lon - 0.03;
  const dir = mkdtempSync(join(tmpdir(), 'gw-sargeo-'));
  try {
    const dem = join(dir, 'flat_dem_hae.tif');
    const bytes = await writeGeoTiff({ width: w, height: h, bands: 1, type: 'f32', data: new Float32Array(w * h).fill(box.h) }, { epsg: 4326, vertical: 'hae', geotransform: [lon0 - d / 2, d, 0, lat0 + d / 2, 0, -d], nodata: NaN });
    writeFileSync(dem, bytes);
    expect((await openFiles(frame, [dem])).flatMap((x) => x.errors)).toEqual([]);
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => /flat_dem_hae/.test(l.rec?.name ?? '') && l.lutTex), null, { timeout: 60_000 });
    const r = await frame.evaluate(async () => {
      const app = window.gisworkbench;
      const ls = [...app.layers.values()];
      const demL = ls.find((l) => /flat_dem_hae/.test(l.rec.name));
      await app.useAsTerrain(demL, 'hae');
      const sar = ls.find((l) => l.info?.meta?.s1);
      const dem = app.terrain.entry(demL.id);
      const gamma = await app.sarTerrain.run({ layer: sar, dem, flatten: true, masks: true });
      const beta = await app.sarTerrain.run({ layer: sar, dem, flatten: false, masks: false });
      const read = async (l) => (await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: 200, h: 166, bands: [0] }, { affinity: l.affinity })).planes[0];
      const [gv, bv, mv] = [await read(gamma.layer), await read(beta.layer), await read(gamma.maskLayer)];
      const diff = [];
      for (let k = 0; k < gv.length; k++) if (Number.isFinite(gv[k]) && Number.isFinite(bv[k])) diff.push(gv[k] - bv[k]);
      diff.sort((a, b) => a - b);
      const finite = Array.from(gv).filter(Number.isFinite).sort((a, b) => a - b);
      return { stats: gamma.stats, diffMedian: diff[diff.length >> 1], n: diff.length, gammaMedian: finite[finite.length >> 1], masked: Array.from(mv).filter((v) => v > 0).length, names: [gamma.layer.rec.name, gamma.maskLayer.rec.name] };
    });
    // Every post has a value but a rim a look's footprint wide, where the look is partly off the DEM.
    expect(r.stats.valued).toBeGreaterThan(0.85 * w * h);
    expect(r.stats.valued).toBeLessThan(w * h);
    expect(r.n).toBe(r.stats.valued);
    expect(r.stats.orbit).toBe('annotation');
    // Flat ground: γ⁰ − β⁰ = 10 log10(tan θ) dB, θ the ellipsoid incidence (the grid's, ±0.3 dB:
    // the DEM sits on the grid point's mean height, and θ changes across the patch).
    const want = 10 * Math.log10(Math.tan((box.inc * Math.PI) / 180));
    console.log(JSON.stringify({ ...r, want, inc: box.inc, h: box.h }));
    expect(Math.abs(r.diffMedian - want), `γ⁰ − β⁰ ${r.diffMedian} dB, tan θ ${want} dB`).toBeLessThan(0.3);
    // Desert scrub and city at C-band: γ⁰ between −25 and 0 dB.
    expect(r.gammaMedian).toBeGreaterThan(-25);
    expect(r.gammaMedian).toBeLessThan(0);
    expect(r.stats.layover + r.stats.shadow).toBe(0);
    expect(r.masked).toBe(0);
    expect(r.names[0]).toMatch(/^GAMMA0_TC_/);
    expect(logs).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
