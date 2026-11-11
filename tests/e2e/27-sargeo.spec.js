// SCN-87 (part) REQ-GAP-90 REG-085: SAR ▸ Terrain Correction on a real Sentinel-1 IW SLC swath (the
// T&E corpus's Las Vegas scene; third-party data, so it is not in the repository and the test skips
// without it). The DEM is flat at the scene's height, so the radiometry has a closed form: γ⁰/β⁰ is
// tan θ on flat ground, and there is no layover or shadow. Geolocation against the product's own
// grid is the unit test's (tests/unit/sargeo.test.js); against a reference processor's product is
// SCN-87's remaining part. The dialog is then run with an orbit file.
import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { openApp, openFiles } from './helpers.js';
import { writeGeoTiff } from '../../app/src/formats/geotiff-writer.js';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axeOn = (frame, sel) => frame.evaluate(async ({ s, tags }) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), { s: sel, tags: AXE_TAGS });

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
    // A GRD product is refused: its ground-range path is not yet checked against a real product.
    const grd = await frame.evaluate(async () => {
      const app = window.gisworkbench;
      const sar = [...app.layers.values()].find((l) => l.info?.meta?.s1);
      const ann = sar.info.meta.s1.annotation;
      const was = ann.productType;
      ann.productType = 'GRD';
      try {
        return await app.sarTerrain.run({ layer: sar, dem: app.terrain.dems[0] }).then(() => 'ran', (e) => e.code);
      } finally {
        ann.productType = was;
      }
    });
    expect(grd).toBe('E_SAR_PRODUCT');
    // The dialog, with an orbit file read through the worker. No real POEORB is in the corpus, so
    // the file is written from the annotation's own state vectors: the same orbit, so the β⁰ it
    // gives matches the API run's, and the run reports the file's type. That checks the .EOF
    // parser, the mission check against a real annotation's missionId and the coverage rule.
    const ann = await frame.evaluate(() => {
      const a = [...window.gisworkbench.layers.values()].find((x) => x.info?.meta?.s1).info.meta.s1.annotation;
      return { t: a.orbit.t, p: a.orbit.p, v: a.orbit.v, t0: a.t0, t1: a.t1, mission: a.missionId };
    });
    expect(ann.mission).toBe('S1A');
    expect(ann.t[0]).toBeLessThanOrEqual(ann.t0 - 60);
    expect(ann.t[ann.t.length - 1]).toBeGreaterThanOrEqual(ann.t1 + 60);
    // To the microsecond, as an EOF has them: a millisecond is 7.5 m along the orbit.
    const utc = (s) => {
      const us = Math.round((s - Math.floor(s)) * 1e6);
      const sec = Math.floor(s) + (us === 1e6 ? 1 : 0);
      return `UTC=${new Date(Date.UTC(2000, 0, 1) + sec * 1000).toISOString().slice(0, 19)}.${String(us % 1e6).padStart(6, '0')}`;
    };
    const osv = ann.t.map((s, i) => `<OSV><UTC>${utc(s)}</UTC><X unit="m">${ann.p[3 * i]}</X><Y unit="m">${ann.p[3 * i + 1]}</Y><Z unit="m">${ann.p[3 * i + 2]}</Z><VX unit="m/s">${ann.v[3 * i]}</VX><VY unit="m/s">${ann.v[3 * i + 1]}</VY><VZ unit="m/s">${ann.v[3 * i + 2]}</VZ></OSV>`);
    const eof = join(dir, 'S1A_OPER_AUX_POEORB_TEST.EOF');
    writeFileSync(eof, `<?xml version="1.0"?><Earth_Explorer_File><Earth_Explorer_Header><Fixed_Header><Mission>Sentinel-1A</Mission><File_Type>AUX_POEORB</File_Type></Fixed_Header><Variable_Header><Ref_Frame>EARTH_FIXED</Ref_Frame></Variable_Header></Earth_Explorer_Header><Data_Block type="xml"><List_of_OSVs count="${osv.length}">${osv.join('')}</List_of_OSVs></Data_Block></Earth_Explorer_File>`);
    await frame.evaluate(axeSource);
    await frame.evaluate(() => {
      const app = window.gisworkbench;
      const id = [...app.layers.values()].find((x) => x.info?.meta?.s1).id;
      app.store.transact('Active layer', (tx) => tx.set(app.activePane().id, 'activeLayer', id));
      void app.commands.run('sar.terrain');
    });
    const dlg = frame.locator('[data-id="dialog:sar-terrain"]');
    await expect(dlg).toBeVisible();
    expect(await axeOn(frame, '[data-id="dialog:sar-terrain"]')).toEqual([]);
    await dlg.getByLabel('Output').selectOption('beta');
    await dlg.getByLabel('Layover and shadow mask').first().uncheck();
    await dlg.locator('input[type=file]').setInputFiles(eof);
    await expect(dlg).toContainText('S1A_OPER_AUX_POEORB_TEST.EOF');
    await dlg.getByRole('button', { name: 'Run' }).click();
    const betaCount = () => frame.evaluate(() => [...window.gisworkbench.layers.values()].filter((l) => /^BETA0_TC_/.test(l.rec?.name ?? '')).length);
    await expect.poll(betaCount, { timeout: 300_000 }).toBe(2);
    const f = await frame.evaluate(async () => {
      const app = window.gisworkbench;
      const [api, ui] = [...app.layers.values()].filter((l) => /^BETA0_TC_/.test(l.rec?.name ?? ''));
      const read = async (l) => (await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: 200, h: 166, bands: [0] }, { affinity: l.affinity })).planes[0];
      const [a, b] = [await read(api), await read(ui)];
      const d = [];
      let fa = 0;
      let fb = 0;
      for (let k = 0; k < a.length; k++) {
        fa += Number.isFinite(a[k]);
        fb += Number.isFinite(b[k]);
        if (Number.isFinite(a[k]) && Number.isFinite(b[k])) d.push(Math.abs(a[k] - b[k]));
      }
      d.sort((x, y) => x - y);
      return { orbit: app.sarTerrain.last.orbit, fa, fb, median: d[d.length >> 1], p99: d[Math.floor(d.length * 0.99)] };
    });
    console.log(JSON.stringify(f));
    expect(f.orbit).toBe('AUX_POEORB');
    expect(f.fb).toBe(f.fa);
    expect(f.median).toBeLessThan(1e-3);
    expect(f.p99).toBeLessThan(1e-3);
    expect(logs).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
