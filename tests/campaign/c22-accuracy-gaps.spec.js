// TE-C22 Phase 3 accuracy — the §5.2 checks the first pass planned but never ran, on real corpus
// data against build/campaign/oracles/accuracy.py:
//  • CCD coherence on the Umbra Bingham pair vs numpy (≥ 0.8 stable, ≤ 0.4 disturbed);
//  • chg.detect on the Maxar Derna pre/post pair (as delivered, and a co-located 2048² crop that
//    fits the 16 M-sample reader) vs the documented method in numpy/scipy on a
//    GDAL-warped pair (the corpus has one NAIP date, so no NAIP pair);
//  • msi.thermal on Landsat 8 B10/B11 with the MTL vs numpy K1/K2 brightness temperature;
//  • hillshade, slope and aspect vs gdaldem (±1 DN, ±0.1°, ±0.5°), read back from the GPU at one
//    DEM post per device pixel;
//  • TOA reflectance (Landsat MTL, Sentinel-2 MTD) and NDVI vs numpy (±0.01);
//  • Indian Pines supervised classification vs the delivered truth (OA ≥ 90 %, κ to 3 decimals).
// REQ-SAR-09, REQ-MSI-05/08/10/14, REQ-DEM-10, AT-11.3, AT-13.1.
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import { openApp, openFiles, settledAny, record, item, paths, truth, runCommand, CORPUS } from './helpers.js';

test.describe.configure({ mode: 'parallel', timeout: 900_000 });

const SPEC = 'c22-accuracy-gaps';
const file = (id, name) => paths(item(id), ['primary', 'sidecar', 'metadata']).find((p) => p.split(/[\\/]/).pop() === name);
async function raster(rel) {
  const tiff = await fromArrayBuffer(readFileSync(join(CORPUS, '_truth', rel)).buffer.slice(0));
  const img = await tiff.getImage();
  const [v] = await img.readRasters();
  return { v, w: img.getWidth(), h: img.getHeight() };
}
const amax = (arr) => arr.reduce((m, x) => (x > m ? x : m), -Infinity);
const pct = (arr, p) => {
  const s = Float64Array.from(arr).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
/** Metadata file bytes → a File in the page, then fromMetadata on the named layer. */
const metadata = (frame, layerName, p, opts) =>
  frame.evaluate(
    async ({ layerName, name, bytes, opts }) => {
      const app = window.gisworkbench;
      const l = [...app.layers.values()].find((x) => x.rec.name === layerName);
      const r = await app.msi.fromMetadata(l, new File([new Uint8Array(bytes)], name), opts);
      return { state: r.state, gain: r.gain, offset: r.offset, source: r.source };
    },
    { layerName, name: p.split(/[\\/]/).pop(), bytes: [...readFileSync(p)], opts },
  );
/** f32 values of a layer window with its radiometric state applied. */
const values = (frame, layerName, [x0, y0, w, h]) =>
  frame.evaluate(
    async ({ layerName, x0, y0, w, h }) => {
      const app = window.gisworkbench;
      const l = [...app.layers.values()].find((x) => x.rec.name === layerName);
      try {
        const c = await app.msi.cube(l, { x0, y0, w, h, bands: [0] });
        return Array.from(c.v);
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    },
    { layerName, x0, y0, w, h },
  );
function diffStats(app, ref, keep = () => true) {
  const d = [];
  for (let i = 0; i < ref.length; i++) if (Number.isFinite(ref[i]) && Number.isFinite(app[i]) && keep(i)) d.push(Math.abs(app[i] - ref[i]));
  return { n: d.length, max: d.length ? amax(d) : NaN, mean: d.reduce((s, x) => s + x, 0) / Math.max(1, d.length), p99: pct(d, 0.99), nanApp: app.filter((x) => !Number.isFinite(x)).length };
}

// ---- 1. CCD coherence vs numpy ----
test('TE-C22 REQ-SAR-09 CCD coherence vs numpy on the Umbra Bingham pair (≥ 0.8 stable, ≤ 0.4 disturbed)', async ({ page }, info) => {
  const T = truth('umbra-bingham-20230925-full.ccd');
  const a = file('umbra-bingham-20230925-full', 'umbra_20230925_SICD.nitf');
  const b = file('umbra-bingham-20230821-repeat', 'umbra_20230821_SICD.nitf');
  test.skip(!T || !existsSync(a) || !existsSync(b), 'oracle or data missing (oracles/accuracy.py ccd)');
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [a, b]);
  await settledAny(frame, 0, 300_000);
  const r = await frame.evaluate(async ({ chip, t }) => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()];
    const la = ls.find((l) => /20230925_SICD/.test(l.rec.name));
    const lb = ls.find((l) => /20230821_SICD/.test(l.rec.name));
    try {
      const out = await app.sar.ccd(la, lb, { chip, win: 5, products: [] });
      const { w, h } = out.chip;
      const n = w / t;
      const tiles = [];
      let nan = 0;
      for (let ty = 0; ty < h / t; ty++)
        for (let tx = 0; tx < n; tx++) {
          let s = 0;
          let k = 0;
          for (let y = ty * t; y < (ty + 1) * t; y++)
            for (let x = tx * t; x < (tx + 1) * t; x++) {
              const g = out.gamma[y * w + x];
              if (Number.isFinite(g)) (s += g), k++;
            }
          nan += t * t - k;
          tiles.push(k > (t * t) / 4 ? s / k : NaN);
        }
      let mean = 0;
      let m = 0;
      for (const g of out.gamma) if (Number.isFinite(g)) (mean += g), m++;
      return { chip: out.chip, chipB: out.chipB, warp: out.warp, rms: out.rms, ties: out.ties, fringe: out.fringe, ms: out.ms, warnings: out.warnings, baseline: out.baseline ?? null, tiles, nanFrac: nan / (w * h), mean: mean / m };
    } catch (e) {
      return { error: e.message };
    }
  }, { chip: T.chip, t: T.tile });
  let cmp = null;
  if (!r.error) {
    const ref = T.tiles.flat();
    const stable = [];
    const disturbed = [];
    const d = [];
    ref.forEach((g, i) => {
      if (!Number.isFinite(r.tiles[i])) return;
      d.push(Math.abs(r.tiles[i] - g));
      if (g >= 0.85) stable.push(r.tiles[i]);
      if (g <= 0.35) disturbed.push(r.tiles[i]);
    });
    cmp = {
      stableTiles: stable.length, stableOk: stable.filter((g) => g >= 0.8).length, stableMedianApp: pct(stable, 0.5),
      disturbedTiles: disturbed.length, disturbedOk: disturbed.filter((g) => g <= 0.4).length, disturbedMedianApp: pct(disturbed, 0.5),
      tileAbsDiffMedian: pct(d, 0.5), tileAbsDiffP90: pct(d, 0.9), meanApp: r.mean, meanNumpy: T.meanGamma,
    };
  }
  record(SPEC, info.project.name, { key: 'ccd-umbra-bingham', check: 'ccd', tol: '≥ 0.8 stable, ≤ 0.4 disturbed (32² tiles; stable/disturbed = numpy tile ≥ 0.85 / ≤ 0.35)', oracle: { chip: T.chip, meanGamma: T.meanGamma, p90Gamma: T.p90Gamma, stableTileFrac: T.stableTileFrac, disturbedTileFrac: T.disturbedTileFrac, fringe: T.fringe, geometry: T.geometry, method: T.method }, app: { ...r, tiles: undefined }, cmp, pass: !!cmp && cmp.stableTiles > 0 && cmp.disturbedTiles > 0 && cmp.stableOk >= 0.9 * cmp.stableTiles && cmp.disturbedOk >= 0.9 * cmp.disturbedTiles });
  expect(r.error ?? null, 'CCD runs on the pair').toBeNull();
  const g = T.geometry ?? {};
  // TE-051: where the reference finds no stable area (a geometrically incoherent pair), the app must say
  // so, with a baseline that matches the reference geometry; "≥ 0.8 in stable areas" is then not measurable.
  if (cmp.stableTiles === 0) {
    const bl = r.baseline ?? {};
    expect.soft(r.warnings.some((w) => /geometric decorrelation/.test(w)), `the app warns of geometric decorrelation (${r.warnings.join('; ')})`).toBe(true);
    expect.soft(Math.abs(bl.bPerp / g.bPerpM - 1), `app B⊥ ${bl.bPerp?.toFixed(0)} m vs reference ${g.bPerpM?.toFixed(0)} m (±10 %)`).toBeLessThanOrEqual(0.1);
    expect.soft(Math.abs(bl.overlap - g.spectralOverlap), `app spectral overlap ${bl.overlap?.toFixed(3)} vs reference ${g.spectralOverlap?.toFixed(3)} (±0.05)`).toBeLessThanOrEqual(0.05);
  } else
  expect.soft(cmp.stableTiles, `the numpy reference finds stable (γ ≥ 0.85) tiles in the chip (B⊥ ${g.bPerpM?.toFixed(0)} m, height of ambiguity ${g.heightOfAmbiguityM?.toFixed(2)} m, range spectral overlap ${g.spectralOverlap?.toFixed(2)})`).toBeGreaterThan(0);
  expect.soft(cmp.disturbedTiles, 'the numpy reference finds disturbed (γ ≤ 0.35) tiles in the chip').toBeGreaterThan(0);
  if (cmp.stableTiles) expect.soft(cmp.stableOk / cmp.stableTiles, `stable tiles with app γ ≥ 0.8 (median ${cmp.stableMedianApp?.toFixed(3)})`).toBeGreaterThanOrEqual(0.9);
  expect.soft(cmp.disturbedOk / cmp.disturbedTiles, `disturbed tiles with app γ ≤ 0.4 (median ${cmp.disturbedMedianApp?.toFixed(3)})`).toBeGreaterThanOrEqual(0.9);
  expect(logs).toEqual([]);
});

// ---- 2. chg.detect on a real pre/post pair ----
// As delivered (the 4137² pre image is over the 16 M-sample grid reader), and as a co-located crop
// of both dates (oracle gdal_translate -projWin, 2048² pre) so the method is measured on real imagery.
for (const [check, label] of [['change', 'pre/post pair'], ['change_crop', 'pre/post pair, co-located 2048² crop']])
test(`TE-C22 SCN-11 AT-11.3 chg.detect on the Maxar Derna WV3 ${label} vs the documented method in numpy`, async ({ page }, info) => {
  const T = truth(`eo-maxar-libya-floods-wv3-prepost.${check}`);
  const [pre, post] = T?.files ? T.files.map((rel) => join(CORPUS, '_truth', rel)) : [file('eo-maxar-libya-floods-wv3-prepost', T?.pre ?? ''), file('eo-maxar-libya-floods-wv3-prepost', T?.post ?? '')];
  test.skip(!T || !pre || !post || !existsSync(pre) || !existsSync(post), 'oracle or data missing (oracles/accuracy.py change)');
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [pre]);
  await openFiles(frame, [post]);
  await settledAny(frame, 0, 300_000);
  const setup = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const ls = app.activePane().layers();
    return ls.map((l) => ({ name: l.rec.name, w: l.width, h: l.height, band0: l.chain.bands[0], date: l.info.datetime ?? null }));
  });
  const run = await runCommand(page, frame, 'chg.detect', { logs, wait: 600_000 });
  const got = await frame.evaluate(() => window.gisworkbench.store.all('change').map((c) => ({ bbox: c.bbox, areaPx: c.areaPx, method: c.method, image1: c.image1.name, image2: c.image2.name })));
  const W = T.width;
  const H = T.height;
  const coverOf = (boxes) => {
    const m = new Uint8Array(W * H);
    for (const [x0, y0, x1, y1] of boxes) for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) m.fill(1, y * W + Math.max(0, x0), y * W + Math.min(W, x1));
    return m;
  };
  const appCover = coverOf(got.map((c) => c.bbox));
  const refCover = coverOf(T.boxes);
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < appCover.length; i++) {
    inter += appCover[i] & refCover[i];
    uni += appCover[i] | refCover[i];
  }
  const m = got[0]?.method ?? {};
  const cmp = {
    candidatesApp: got.length, candidatesRef: T.candidates, gainApp: m.gain, gainRef: T.gain, offsetApp: m.offset, offsetRef: T.offset, thresholdApp: m.threshold, thresholdRef: T.threshold,
    boxCoverIoU: uni ? inter / uni : NaN, sameGrid: m.sameGrid, image1: got[0]?.image1, image2: got[0]?.image2,
  };
  const tolTxt = 'gain ±1 %, offset ±5 DN, threshold ±2 %, candidates ±10 %, box-cover IoU ≥ 0.9';
  const pass = run.outcome === 'dialog' && got.length > 0 && Math.abs(m.gain / T.gain - 1) <= 0.01 && Math.abs(m.offset - T.offset) <= 5 && Math.abs(m.threshold / T.threshold - 1) <= 0.02 && Math.abs(got.length / T.candidates - 1) <= 0.1 && cmp.boxCoverIoU >= 0.9;
  record(SPEC, info.project.name, { key: `chg-detect-maxar-derna${check === 'change' ? '' : '-crop'}`, check: 'change', tol: tolTxt, setup, run: { outcome: run.outcome, toasts: run.toasts, errors: run.errors }, oracle: { band: T.band, method: T.method, changedPx: T.changedPx, crop: T.command ?? null }, cmp, note: 'The corpus holds one NAIP date (naip-ca-m3812157-sw-2022); no NAIP pre/post pair exists, so the Maxar WV3 pair is the real-data case.', pass });
  expect(run.errors, 'chg.detect runs without an error').toEqual([]);
  expect(setup[0]?.band0, 'the app compares the band the oracle used').toBe(T.band);
  expect(got.length, 'change candidates').toBeGreaterThan(0);
  expect(Math.abs(m.gain / T.gain - 1), `radiometric gain ${m.gain} vs ${T.gain.toFixed(4)}`).toBeLessThanOrEqual(0.01);
  expect(Math.abs(m.offset - T.offset), `radiometric offset ${m.offset} vs ${T.offset.toFixed(2)}`).toBeLessThanOrEqual(5);
  expect(Math.abs(m.threshold / T.threshold - 1), `threshold ${m.threshold} vs ${T.threshold.toFixed(2)}`).toBeLessThanOrEqual(0.02);
  expect(Math.abs(got.length / T.candidates - 1), `candidates ${got.length} vs ${T.candidates}`).toBeLessThanOrEqual(0.1);
  expect(cmp.boxCoverIoU, 'candidate box cover IoU').toBeGreaterThanOrEqual(0.9);
  expect(logs).toEqual([]);
});

// ---- 3. msi.thermal on Landsat 8 B10/B11 ----
test('TE-C22 REQ-MSI-14 msi.thermal on Landsat 8 B10/B11 with the MTL vs numpy K1/K2 brightness temperature', async ({ page }, info) => {
  const T = truth('landsat8-c1-l1tp-044034-20210508.thermal');
  const id = 'landsat8-c1-l1tp-044034-20210508';
  const mtl = T && file(id, T.mtl);
  test.skip(!T || !existsSync(mtl), 'oracle or data missing (oracles/accuracy.py thermal)');
  const { frame, logs } = await openApp(page, 'file');
  const out = {};
  for (const b of ['B10', 'B11']) {
    const f = T.bands[b];
    const p = file(id, f.file);
    await openFiles(frame, [p]);
    await settledAny(frame, 0, 300_000);
    await frame.evaluate((n) => {
      const app = window.gisworkbench;
      const l = [...app.layers.values()].find((x) => x.rec.name === n);
      app.activePane().setActive?.(l.id);
      app.setActiveLayer?.(l);
    }, f.file);
    // The analyst's path: Brightness Temperature on the DN band, and Radiometric Conversion first.
    // TE-054: the dialog asks for the MTL when the band is DN; the analyst picks it.
    const ui = await runCommand(page, frame, 'msi.thermal', { logs, wait: 120_000, pick: [mtl] });
    const radEnabled = await frame.evaluate(() => window.gisworkbench.commands.enabled('msi.radiometric'));
    // The function behind it, with the MTL applied to this band (bandMap: image band 1 = MTL band 10/11).
    const meta = await metadata(frame, f.file, mtl, { target: 'radiance', bandMap: [Number(b.slice(1))] });
    const bt = await frame.evaluate(async ({ n, win }) => {
      const app = window.gisworkbench;
      const l = [...app.layers.values()].find((x) => x.rec.name === n);
      try {
        const P = await app.msi.brightnessTemperature(l, 0, {});
        const c = await app.msi.cube(P, { x0: win[0], y0: win[1], w: win[2], h: win[3], bands: [0] });
        return { v: Array.from(c.v), source: P.info?.radiometry?.source ?? P.radiometry?.source ?? null, name: P.rec?.name };
      } catch (e) {
        return { error: e.message };
      }
    }, { n: f.file, win: T.window });
    const ref = (await raster(f.raster)).v;
    const s = bt.v ? diffStats(bt.v, ref) : null;
    out[b] = { ui: { outcome: ui.outcome, toasts: ui.toasts }, radiometricEnabled: radEnabled, meta: { state: meta.state, gain: meta.gain, offset: meta.offset }, btSource: bt.source, error: bt.error ?? null, diffK: s, k1: f.k1, k2: f.k2, refMeanK: f.meanK };
  }
  const uiOk = (u) => u.outcome !== 'error' && !u.toasts.some((t) => /toast-(error|warn)/.test(t));
  const pass = ['B10', 'B11'].every((b) => uiOk(out[b].ui) && out[b].diffK && out[b].diffK.max <= 0.1);
  record(SPEC, info.project.name, { key: 'thermal-landsat8-b10-b11', check: 'thermal', tol: 'UI path runs; max |ΔBT| ≤ 0.1 K', out, pass });
  for (const b of ['B10', 'B11']) {
    expect.soft(uiOk(out[b].ui), `${b}: Brightness Temperature from the ribbon (${out[b].ui.toasts.join('; ')})`).toBe(true);
    expect.soft(out[b].error, `${b}: brightness temperature after MTL radiance`).toBeNull();
    expect.soft(out[b].diffK?.max, `${b}: max |ΔBT| vs numpy K1/K2 (K)`).toBeLessThanOrEqual(0.1);
  }
});

// ---- 4. hillshade, slope, aspect vs gdaldem ----
test('TE-C22 REQ-DEM-10 hillshade, slope and aspect vs gdaldem on the UTM GLO-30 crop (±1 DN, ±0.1°, ±0.5°)', async ({ page }, info) => {
  test.setTimeout(600_000);
  const T = truth('derived-dem-utm13-viewshed.terrain');
  const dem = T && file('derived-dem-utm13-viewshed', T.file);
  test.skip(!T || !existsSync(dem), 'oracle or data missing (oracles/accuracy.py terrain)');
  const ref = {};
  for (const [k, rel] of Object.entries(T.rasters)) ref[k] = await raster(rel);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [dem]);
  await settledAny(frame);
  // One post per device pixel, with device-pixel centres on post centres (no blending between posts).
  const grab = (mode) =>
    frame.evaluate(async (mode) => {
      const app = window.gisworkbench;
      const p = app.activePane();
      const dpr = window.devicePixelRatio || 1;
      app.setChain((c) => (c.dem = { ...c.dem, mode, az: 315, el: 45, z: 1 }));
      let cx = 512.5;
      let cy = 512.5;
      let q;
      let X;
      let Y;
      let b;
      for (let it = 0; it < 3; it++) {
        p.setView({ cx, cy, zoom: 1 / dpr, rot: 0, mode: 'native' });
        await new Promise((r) => setTimeout(r, 300));
        b = p.el.getBoundingClientRect();
        X = Math.round((b.left + b.width / 2) * dpr);
        Y = Math.round((b.top + b.height / 2) * dpr);
        q = p.imagePoint((X + 0.5) / dpr - b.left, (Y + 0.5) / dpr - b.top);
        cx -= q.x - 0.5 - Math.round(q.x - 0.5);
        cy -= q.y - 0.5 - Math.round(q.y - 0.5);
      }
      await new Promise((r) => setTimeout(r, 600));
      const cap = app.renderer.capture();
      const l = p.layers()[0];
      const out = [];
      let worstFrac = 0;
      for (let y = Math.round(b.top * dpr) + 24; y < Math.round(b.bottom * dpr) - 24; y += 2)
        for (let x = Math.round(b.left * dpr) + 24; x < Math.round(b.right * dpr) - 24; x += 2) {
          const pt = p.imagePoint((x + 0.5) / dpr - b.left, (y + 0.5) / dpr - b.top);
          const fx = pt.x - 0.5;
          const fy = pt.y - 0.5;
          const ix = Math.round(fx);
          const iy = Math.round(fy);
          worstFrac = Math.max(worstFrac, Math.abs(fx - ix), Math.abs(fy - iy));
          if (ix < 2 || iy < 2 || ix > l.width - 3 || iy > l.height - 3) continue;
          const i = (y * cap.width + x) * 4;
          out.push(ix, iy, cap.data[i], cap.data[i + 1], cap.data[i + 2]);
        }
      return { px: out, worstFrac, cell: l.demCell(), dpr };
    }, mode);
  const res = {};
  // Hillshade: grey level vs gdaldem (grid-north azimuth, and the true-north-equivalent azimuth).
  const hs = await grab('hillshade');
  for (const k of ['hillshade', 'hillshade_truenorth']) {
    const d = [];
    let notGrey = 0;
    for (let i = 0; i < hs.px.length; i += 5) {
      const [ix, iy, r, g, bb] = hs.px.slice(i, i + 5);
      if (r !== g || g !== bb) notGrey++;
      const v = ref[k].v[iy * ref[k].w + ix];
      if (v === 0) continue; // gdaldem nodata (edges)
      d.push(Math.abs(r - v));
    }
    res[k] = { n: d.length, within: d.filter((x) => x <= 1).length / d.length, max: amax(d), p99: pct(d, 0.99), notGrey };
  }
  // Slope: invert the green → yellow → red ramp (0–45°, clamped) to degrees.
  const sl = await grab('slope');
  {
    const d = [];
    for (let i = 0; i < sl.px.length; i += 5) {
      const [ix, iy, r, g] = sl.px.slice(i, i + 5);
      const R = r / 255;
      const G = g / 255;
      const k1 = (R - 0.1) / 1.8; // first half: R 0.1 → 1, G 0.6 → 0.9
      const k2 = 0.5 + (0.9 - G) / 1.6; // second half: G 0.9 → 0.1, R 1 → 0.85
      const k = Math.abs(0.6 + 0.6 * k1 - G) <= Math.abs(1 - 0.3 * (k2 - 0.5) - R) && k1 <= 0.5 ? k1 : k2;
      const sd = 45 * k;
      const v = ref.slope.v[iy * ref.slope.w + ix];
      if (!(v >= 0) || v > 44 || sd > 44) continue; // nodata; the ramp clamps at 45°
      d.push(Math.abs(sd - v));
    }
    res.slope = { n: d.length, within: d.filter((x) => x <= 0.1).length / d.length, max: amax(d), p99: pct(d, 0.99), quantStepDeg: 45 / (255 * 1.8) };
  }
  // Aspect: hue of hsv(asp, 0.75, 0.95), flat (< 1°) drawn grey; vs gdaldem and gdaldem + grid-north angle.
  const as = await grab('aspect');
  {
    const raw = [];
    const tn = [];
    for (let i = 0; i < as.px.length; i += 5) {
      const [ix, iy, r, g, bb] = as.px.slice(i, i + 5);
      const v = ref.aspect.v[iy * ref.aspect.w + ix];
      const s = ref.slope.v[iy * ref.slope.w + ix];
      if (!(v >= 0) || !(s >= 2)) continue; // gdaldem -9999 (flat); app greys < 1°
      const mx = Math.max(r, g, bb);
      const mn = Math.min(r, g, bb);
      if (mx - mn < 10) continue;
      let hue = mx === r ? (g - bb) / (mx - mn) : mx === g ? 2 + (bb - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
      hue = ((hue * 60) % 360 + 360) % 360;
      const ang = (a, b2) => Math.abs((((a - b2) % 360) + 540) % 360 - 180);
      raw.push(ang(hue, v));
      tn.push(ang(hue, v + T.gridNorthDeg));
    }
    res.aspect = { n: raw.length, within: raw.filter((x) => x <= 0.5).length / raw.length, max: amax(raw), p99: pct(raw, 0.99), median: pct(raw, 0.5) };
    res.aspect_truenorth = { n: tn.length, within: tn.filter((x) => x <= 0.5).length / tn.length, max: amax(tn), p99: pct(tn, 0.99), median: pct(tn, 0.5) };
  }
  // The app measures aspect from true north (shader: + grid-north angle); gdaldem from grid north. The
  // pass uses gdaldem's aspect turned to true north by the oracle's geodesic grid-north angle; the raw
  // comparison is recorded beside it.
  const pass = res.hillshade.within >= 0.99 && res.slope.within >= 0.99 && res.aspect_truenorth.within >= 0.99;
  record(SPEC, info.project.name, { key: 'terrain-gdaldem', check: 'terrain', tol: '≥ 99 % of sampled posts within ±1 DN / ±0.1° / ±0.5° of gdaldem (Horn); aspect after turning gdaldem grid-north aspect to true north', gridNorthDeg: T.gridNorthDeg, cell: hs.cell, worstAlignPx: Math.max(hs.worstFrac, sl.worstFrac, as.worstFrac), commands: T.commands, res, pass });
  expect.soft(res.hillshade.within, `hillshade within ±1 DN of gdaldem (max ${res.hillshade.max}, p99 ${res.hillshade.p99})`).toBeGreaterThanOrEqual(0.99);
  expect.soft(res.slope.within, `slope within ±0.1° of gdaldem (max ${res.slope.max?.toFixed(3)}, p99 ${res.slope.p99?.toFixed(3)})`).toBeGreaterThanOrEqual(0.99);
  expect.soft(res.aspect_truenorth.within, `aspect within ±0.5° of gdaldem + grid-north angle ${T.gridNorthDeg.toFixed(3)}° (p99 ${res.aspect_truenorth.p99?.toFixed(3)}; raw vs gdaldem p99 ${res.aspect.p99?.toFixed(3)}, ${(100 * res.aspect.within).toFixed(1)} % within)`).toBeGreaterThanOrEqual(0.99);
  expect(logs).toEqual([]);
});

// ---- 5. TOA reflectance and NDVI vs numpy ----
for (const [id, label] of [['landsat8-c1-l1tp-044034-20210508', 'Landsat 8 MTL'], ['s2-l1c-jp2-safe-10seh-20240816', 'Sentinel-2 L1C MTD']]) {
  test(`TE-C22 REQ-MSI-05 REQ-MSI-04 TOA reflectance and NDVI vs numpy (${label}, ±0.01) ${id}`, async ({ page }, info) => {
    const T = truth(`${id}.toa`);
    const meta = T && file(id, T.mtl ?? T.mtd);
    test.skip(!T || !existsSync(meta), 'oracle or data missing (oracles/accuracy.py toa)');
    const { frame, logs } = await openApp(page, 'file');
    const keys = Object.keys(T.bands);
    const toa = {};
    const res = {};
    for (const k of keys) {
      const f = T.bands[k];
      await openFiles(frame, [file(id, f.file)]);
      await settledAny(frame, 0, 300_000);
      // Landsat: image band 1 is MTL band 4/5; Sentinel-2: MTD band_id 3/7.
      const bandMap = [T.mtl ? Number(k.slice(1)) : f.bandId];
      res[k] = { meta: await metadata(frame, f.file, meta, { target: 'reflectance', bandMap }) };
      toa[k] = await values(frame, f.file, T.window);
      if (toa[k].error) res[k].error = toa[k].error;
      else res[k].diff = diffStats(toa[k], (await raster(f.raster)).v);
    }
    const radEnabled = await frame.evaluate(() => window.gisworkbench.commands.enabled('msi.radiometric'));
    const bmEnabled = await frame.evaluate(() => window.gisworkbench.commands.enabled('msi.bandmath'));
    // NDVI from the app's TOA values (the app has no cross-file Band Math: each band file is its own layer).
    const [red, nir] = keys;
    if (!toa[red].error && !toa[nir].error) {
      const nd = toa[red].map((r, i) => (toa[nir][i] - r) / (toa[nir][i] + r));
      res.ndvi = diffStats(nd, (await raster(T.ndvi.raster)).v);
    } else res.ndvi = { error: 'no app TOA values' };
    // TE-056: the app's own NDVI, through Layer Stack (msi.stack) of the two band files and the NDVI index.
    const stacked = await frame.evaluate(async ({ names, win }) => {
      const app = window.gisworkbench;
      const ls = names.map((n) => [...app.layers.values()].find((x) => x.rec.name === n));
      try {
        const S = await app.msi.stack(ls, { window: { x0: win[0], y0: win[1], w: win[2], h: win[3] } });
        const avail = app.msi.indexAvailable(S, 'ndvi');
        const v = await app.msi.bandMathValues(S, { text: '(nir - red) / (nir + red)' });
        return { v: Array.from(v.v ?? v), avail, bands: S.bands };
      } catch (e) {
        return { error: e.message };
      }
    }, { names: keys.map((k) => T.bands[k].file), win: T.window });
    res.stackNdvi = stacked.error ? { error: stacked.error } : { ...diffStats(stacked.v, (await raster(T.ndvi.raster)).v), indexAvailable: stacked.avail };
    const pass = keys.every((k) => res[k].diff?.max <= 0.01) && res.ndvi.max <= 0.01 && res.stackNdvi.max <= 0.01;
    record(SPEC, info.project.name, { key: `toa-${id}`, check: 'toa', tol: 'max |Δρ| ≤ 0.01, max |ΔNDVI| ≤ 0.01', window: T.window, res, ui: { radiometricEnabledOnBandFile: radEnabled, bandMathEnabledOnBandFile: bmEnabled }, pass });
    expect.soft(res.stackNdvi.error ?? null, 'Layer Stack + NDVI in the app').toBeNull();
    expect.soft(res.stackNdvi.max, 'NDVI from Layer Stack + Band Math, max |Δ|').toBeLessThanOrEqual(0.01);
    expect.soft(radEnabled, 'Radiometric Conversion enabled on a band file').toBe(true);
    for (const k of keys) {
      expect.soft(res[k].error ?? null, `${k}: reading the converted band (app.msi.cube)`).toBeNull();
      expect.soft(res[k].diff?.max, `${k} TOA reflectance max |Δ| (state ${res[k].meta.state})`).toBeLessThanOrEqual(0.01);
    }
    expect.soft(res.ndvi.max, 'NDVI from the app TOA bands, max |Δ|').toBeLessThanOrEqual(0.01);
    expect(logs).toEqual([]);
  });
}

// ---- 6. Indian Pines classification vs truth ----
test('TE-C22 REQ-MSI-08 REQ-MSI-10 Indian Pines maximum-likelihood classification vs delivered truth (OA ≥ 90 %, κ to 3 decimals)', async ({ page }, info) => {
  const T = truth('rs-hsi-indian-pines.classify');
  const cube = T && file('rs-hsi-indian-pines', T.file);
  test.skip(!T || !existsSync(cube), 'oracle or data missing (oracles/accuracy.py classify)');
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [cube]);
  await settledAny(frame);
  const runs = {};
  for (const method of ['ml', 'md', 'sam']) {
    const r = await frame.evaluate(async ({ T, method }) => {
      const app = window.gisworkbench;
      const l = [...app.layers.values()].find((x) => x.rec.name === T.file);
      const W = l.width;
      const rect = (i) => ({ x0: i % W, y0: Math.floor(i / W), w: 1, h: 1 });
      app.msi.clearClasses(l);
      for (const k of T.classes) app.msi.addClass(l, { name: `C${k}`, regions: T.train[k].map(rect), validation: T.val[k].map(rect) });
      try {
        const t0 = performance.now();
        const P = await app.msi.classify(l, method);
        const ms = performance.now() - t0;
        const a = await app.msi.assess(P, l);
        const lab = [];
        for (const k of T.classes) for (const i of T.val[k]) lab.push(P.msi.labelsAll[i]);
        return { oa: a.oa, kappa: a.kappa, n: a.n, lab, ms, window: P.msi.window };
      } catch (e) {
        return { error: e.message };
      }
    }, { T, method });
    if (!r.error) {
      // Independent OA and Cohen's κ from the label map (rows reference, columns mapped).
      const ref = T.classes.flatMap((k, j) => T.val[k].map(() => j + 1));
      const K = T.classes.length;
      const cm = Array.from({ length: K + 1 }, () => new Array(K + 1).fill(0));
      ref.forEach((t, i) => cm[t][Math.min(r.lab[i], K + 1 - 1) || 0]++);
      const n = ref.length;
      let diag = 0;
      let pe = 0;
      for (let c = 1; c <= K; c++) {
        diag += cm[c][c];
        pe += cm[c].reduce((s, v) => s + v, 0) * cm.reduce((s, row) => s + row[c], 0);
      }
      const oa = diag / n;
      pe /= n * n;
      r.check = { oa, kappa: (oa - pe) / (1 - pe), n };
      delete r.lab;
    }
    runs[method] = r;
  }
  const ml = runs.ml;
  const pass = !ml.error && ml.oa >= 0.9 && Math.abs(ml.kappa - ml.check.kappa) < 0.0005;
  record(SPEC, info.project.name, { key: 'classify-indian-pines', check: 'classify', tol: 'ML OA ≥ 0.90; app κ = independent κ to 3 decimals', classes: T.classes, split: '50/50 stratified, seed 20261027', sklearn: T.sklearn, runs, pass });
  expect(ml.error ?? null, 'maximum likelihood runs').toBeNull();
  expect.soft(Math.abs(ml.kappa - ml.check.kappa), `app κ ${ml.kappa?.toFixed(4)} vs independent κ ${ml.check?.kappa.toFixed(4)}`).toBeLessThan(0.0005);
  expect.soft(ml.oa, `maximum-likelihood OA (sklearn refs: ${Object.entries(T.sklearn).map(([k, v]) => `${k} ${v.oa.toFixed(3)}`).join(', ')})`).toBeGreaterThanOrEqual(0.9);
  expect(logs).toEqual([]);
});
