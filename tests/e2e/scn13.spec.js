// SCN-13 multispectral band combination and classification on FX-08 (Appendix E AT-13.1..13.5)
// plus the R3 MSI Shoulds/Coulds: IMODEs and ENVI, presets and Band Preview, radiometric
// corrections, K-means/ISODATA and clean-up, MF/ACE/CEM, PCA/MNF, thermal, Xport, change,
// template matching, and the Indian Pines HSI sample.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles, SAMPLES } from './helpers.js';

const DIR = resolve('fixtures/fx08');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx08_truth.json'), 'utf8'));
const F = (k) => resolve(DIR, truth.files[k]);

test.describe.configure({ timeout: 300000 });

async function ready(frame, n) {
  await frame.waitForFunction((n) => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length >= n, n, { timeout: 90000 });
}

test('SCN-13 AT-13.4 REQ-MSI-01 REQ-FMT-09 FX-08 band names and wavelengths from BANDSB, GeoTIFF metadata and ENVI; every IMODE reads the same pixels', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('nitf'), F('nitfS'), F('nitfP'), F('nitfR'), F('tif'), ...truth.files.envi.map((f) => resolve(DIR, f))]);
  await ready(frame, 6);
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const out = {};
    for (const l of app.layers.values()) {
      const px = await app.pool.run('pixels', { handle: l.handle, x: 300, y: 222, w: 2, h: 1, bands: [0, 3, 7] }, { affinity: l.affinity });
      out[l.info.fileName] = { bands: app.msi.bandsOf(l).map((b) => [b.name, Math.round(b.cw * 1000), Math.round(b.fwhm * 1000)]), px: px.values, radiometry: l.radiometry.state, model: l.modelName, imode: l.info.subheader?.IMODE ?? null };
    }
    // The band list dialog shows names and wavelengths.
    const l = [...app.layers.values()].find((x) => x.info.fileName === 'fx08.ntf');
    app.store.transact('a', (tx) => tx.set(app.activePane().id, 'activeLayer', l.id), { kind: 'load' });
    app.commands.run('bands.select');
    await new Promise((res) => setTimeout(res, 300));
    const dlg = document.querySelector('[data-id="dialog:band-select"]');
    const text = dlg?.querySelector('[data-id="band-list"]')?.textContent ?? '';
    [...(dlg?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Cancel')?.click();
    return { out, text };
  }, truth);
  const want = truth.bands.map((b) => [b.id, Math.round(b.cw * 1000), Math.round(b.fwhm * 1000)]);
  for (const [name, v] of Object.entries(r.out)) {
    expect(v.bands, name).toEqual(want);
    expect(v.px, name).toEqual(r.out['fx08.ntf'].px);
    expect(v.radiometry, name).toMatch(/reflectance|scaled/);
  }
  expect(Object.values(r.out).map((v) => v.imode).filter(Boolean).sort()).toEqual(['B', 'P', 'R', 'S']);
  expect(r.out['fx08.img'].model).toMatch(/EPSG:32611/);
  expect(r.text).toContain('Red Edge');
  expect(r.text).toContain('831.0');
  expect(logs).toEqual([]);
});

test('SCN-13 AT-13.1 REQ-MSI-03 REQ-MSI-04 FX-08 NDVI matches the truth per field; presets, Band Preview, Band Math on the GPU', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('tif')]);
  await ready(frame, 1);
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const cir = await app.msi.applyPreset(l, 'cir');
    let swir = null;
    try {
      await app.msi.applyPreset(l, 'swir');
    } catch (e) {
      swir = e.message;
    }
    await app.msi.bandPreview(l, true);
    await app.msi.showBand(l, 4);
    const prev = l.chain.bands.slice();
    app.msi.bandPreview(l, false);
    await app.msi.setIndex(l, 'ndvi');
    app.renderer.invalidate();
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    // Field means of NDVI from the CPU evaluation at full resolution.
    const v = await app.msi.bandMathValues(l);
    const fields = truth.ndvi.map((f) => {
      let s = 0;
      let n = 0;
      const a = truth.anomaly;
      for (let y = f.rect.y0; y < f.rect.y0 + f.rect.h; y++)
        for (let x = f.rect.x0; x < f.rect.x0 + f.rect.w; x++) {
          if (x >= a.x0 - 2 && x < a.x0 + a.w + 2 && y >= a.y0 - 2 && y < a.y0 + a.h + 2) continue;
          const q = v.v[y * v.w + x];
          if (Number.isFinite(q)) {
            s += q;
            n++;
          }
        }
      return { want: f.ndvi, got: s / n };
    });
    // The GPU draws the index: sample the canvas at a vegetation and a water field.
    const p = app.activePane();
    const px = (x, y) => {
      const s = p.screenPoint(x, y);
      return app.renderer.readPixel?.(p, s.x, s.y) ?? null;
    };
    // Divide by zero → no-data.
    const z = await app.msi.bandMathValues(l, { text: 'b1 / (b2 - b2)', w: 4, h: 4 });
    const sw = app.msi.indexAvailable(l, 'mndwi');
    return { cir, swir, prev, fields, glsl: l.chain.bandMath.glsl, bands: l.chain.bandMath.bands, veg: px(64, 200), water: px(448, 64), zeros: Array.from(z.v), mndwi: sw, lut: l.lutParams };
  }, truth);
  console.log(JSON.stringify({ fields: r.fields, cir: r.cir, swir: r.swir, mndwi: r.mndwi }));
  for (const f of r.fields) expect(Math.abs(f.got - f.want)).toBeLessThan(0.01);
  expect(r.cir).toEqual([6, 4, 2]);
  expect(r.swir).toMatch(/needs swir2, swir1/);
  expect(r.prev).toEqual([4]);
  expect(r.bands).toEqual([6, 4]);
  expect(r.glsl).toContain('bmDiv');
  expect(r.zeros.every((x) => Number.isNaN(x))).toBe(true);
  expect(r.mndwi.ok).toBe(false);
  expect(logs).toEqual([]);
});

test('SCN-13 AT-13.2 AT-13.3 REQ-MSI-08 REQ-MSI-09 REQ-MSI-10 FX-08 maximum likelihood ≥ 90 % OA; confusion matrix reconciles; κ to 3 decimals', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('nitf')]);
  await ready(frame, 1);
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    for (let k = 0; k < truth.classes.length; k++) app.msi.addClass(l, { name: truth.classes[k], regions: [truth.training[k].rect], validation: [truth.validation[k].rect] });
    const sep = await app.msi.separability(l);
    const out = {};
    for (const m of ['ml', 'md', 'mahalanobis', 'sam', 'sid']) {
      const P = await app.msi.classify(l, m);
      const a = await app.msi.assess(P);
      out[m] = { oa: a.oa, kappa: a.kappa, n: a.n, matrix: a.matrix, pa: a.producers, ua: a.users, q: a.quantity, al: a.allocation, oaArea: a.oaArea };
      if (m === 'ml') {
        // The accuracy dialog text (κ to 3 decimals).
        app.store.transact('a', (tx) => tx.set(app.activePane().id, 'activeLayer', P.id), { kind: 'load' });
        app.commands.run('msi.accuracy');
        await new Promise((res) => setTimeout(res, 500));
        const d = document.querySelector('[data-id="dialog:accuracy"]');
        out.summary = d?.querySelector('[data-id="accuracy-summary"]')?.textContent ?? '';
        [...(d?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Close')?.click();
        // Live SAM-like threshold on ML (χ²): stricter → more unclassified.
        const t0 = await app.msi.setThreshold(P, 2);
        let unc = 0;
        for (const v of P.msi.labelsAll) if (v === 0) unc++;
        const after = (await app.pool.run('stats', { handle: P.handle, bands: [0] }, { affinity: P.affinity })).bands[0];
        out.threshold = { ms: t0, zeroBin: after.bins[0], total: after.count };
        await app.msi.setThreshold(P, NaN);
        // Clean-up and vectors.
        await app.msi.post(P, 'majority', 3);
        await app.msi.post(P, 'sieve', 8);
        const vec = app.msi.classVectors(P);
        out.vectors = { count: vec.count, area: vec.features.reduce((s, f) => s + f.area, 0) };
      }
    }
    const km = await app.msi.cluster(l, 'kmeans', { k: 7, iters: 20, step: 4 });
    const iso = await app.msi.cluster(l, 'isodata', { kMin: 4, kMax: 10, iters: 10, step: 4 });
    return { sep: sep.jm, out, km: km.msi.names.length, iso: iso.msi.names.length };
  }, truth);
  console.log(JSON.stringify({ ml: { oa: r.out.ml.oa, kappa: r.out.ml.kappa }, md: r.out.md.oa, mah: r.out.mahalanobis.oa, sam: r.out.sam.oa, sid: r.out.sid.oa, summary: r.out.summary, threshold: r.out.threshold, vectors: r.out.vectors, km: r.km, iso: r.iso }));
  // Separability as designed (JM ≥ 1.8).
  for (let i = 0; i < r.sep.length; i++) for (let j = 0; j < r.sep.length; j++) if (i !== j) expect(r.sep[i][j]).toBeGreaterThanOrEqual(1.8);
  expect(r.out.ml.oa).toBeGreaterThanOrEqual(0.9);
  for (const m of ['md', 'mahalanobis']) expect(r.out[m].oa).toBeGreaterThanOrEqual(0.9);
  // AT-13.3: the totals reconcile (row and column sums, diagonal ↔ OA, κ formula, QD + AD = 1 − OA).
  const a = r.out.ml;
  const k = a.matrix.length;
  const tot = a.matrix.flat().reduce((s, v) => s + v, 0);
  expect(tot).toBe(a.n);
  const diag = a.matrix.reduce((s, row, i) => s + row[i], 0);
  expect(Math.abs(diag / tot - a.oa)).toBeLessThan(1e-12);
  const pe = a.matrix.reduce((s, row, i) => s + row.reduce((x, y) => x + y, 0) * a.matrix.reduce((x, rr) => x + rr[i], 0), 0) / (tot * tot);
  expect(Math.abs((a.oa - pe) / (1 - pe) - a.kappa)).toBeLessThan(1e-9);
  expect(Math.abs(a.q + a.al - (1 - a.oa))).toBeLessThan(1e-9);
  expect(a.matrix[0].length).toBe(k + 1);
  expect(r.out.summary).toMatch(/κ = \d\.\d{3}\b/);
  expect(r.out.summary).toMatch(/area-weighted OA/);
  expect(r.out.threshold.ms).toBeLessThan(1500);
  expect(r.out.vectors.count).toBeGreaterThanOrEqual(14);
  // The class polygons tile the 512 × 512 scene of 2 m pixels (± the pixel-centre contour inset).
  expect(Math.abs(r.out.vectors.area / (512 * 512 * 4) - 1)).toBeLessThan(0.05);
  expect(r.km).toBe(7);
  expect(r.iso).toBeGreaterThanOrEqual(4);
  expect(logs).toEqual([]);
});

test('SCN-13 AT-13.5 REQ-MSI-11 REQ-MSI-12 FX-08 RX flags the inserted anomaly; MF/ACE/CEM on its spectrum; PCA and MNF', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('tif')]);
  await ready(frame, 1);
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const a = truth.anomaly;
    const rx = await app.msi.detect(l, 'rx', { percentile: 0.9999 });
    const inside = (h) => h.x >= a.x0 - 1 && h.x <= a.x0 + a.w + 1 && h.y >= a.y0 - 1 && h.y <= a.y0 + a.h + 1;
    const local = await app.msi.detect(l, 'rxlocal', { percentile: 0.9999, window: { x0: 0, y0: 0, w: 128, h: 128 } });
    const gmm = await app.msi.detect(l, 'gmm', { percentile: 0.9999, k: 4 });
    const t = await app.msi.spectrumAt(l, { rect: { x0: a.x0, y0: a.y0, w: a.w, h: a.h } }, 'region');
    const mf = await app.msi.detect(l, 'ace', { percentile: 0.9999, target: t.values });
    const pca = await app.msi.components(l, 'pca', { k: 3 });
    const mnf = await app.msi.components(l, 'mnf', { k: 3 });
    const dst = await app.msi.components(l, 'dstretch', {});
    return { rxTop: rx.hits[0], rxIn: inside(rx.hits[0]), localIn: local.hits.some(inside), gmmIn: gmm.hits.slice(0, 3).some(inside), aceIn: inside(mf.hits[0]), pca: pca.values.slice(0, 4), mnf: mnf.values.slice(0, 4), dstBands: dst.layer.bands, reduced: rx.reduced };
  }, truth);
  console.log(JSON.stringify(r));
  expect(r.rxIn).toBe(true);
  expect(r.localIn).toBe(true);
  expect(r.gmmIn).toBe(true);
  expect(r.aceIn).toBe(true);
  expect(r.pca[0]).toBeGreaterThan(r.pca[1]);
  expect(r.mnf[0]).toBeGreaterThan(r.mnf[3]);
  expect(r.dstBands).toBe(8);
  expect(r.reduced).toBe(null);
  expect(logs).toEqual([]);
});

test('REQ-MSI-05 REQ-MSI-06 REQ-MSI-07 REQ-MSI-13 REQ-MSI-14 REQ-MSI-15 REQ-MSI-16 REQ-EXT-28 FX-08 radiometry, spectral plot, thermal, Xport, change and template matching', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('tif'), F('tifB')]);
  await ready(frame, 2);
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const [la, lb] = [...app.layers.values()].sort((x, y) => x.rec.name.localeCompare(y.rec.name));
    const p = app.activePane();
    app.store.transact('a', (tx) => tx.set(p.id, 'activeLayer', la.id), { kind: 'load' });
    // Radiometric state from the file: GDAL SCALE 1e-4 → reflectance-scaled values.
    const st0 = la.radiometry.state;
    // A Landsat-style MTL applied to FX-08 as if its bands were OLI 1…8 (exercise of the path).
    const mtl = ['GROUP = LANDSAT_METADATA_FILE', ' SPACECRAFT_ID = "LANDSAT_8"', ' PROCESSING_LEVEL = "L1TP"', ' SUN_ELEVATION = 30.0', ...Array.from({ length: 8 }, (_, k) => ` REFLECTANCE_MULT_BAND_${k + 1} = 2.0E-05\n REFLECTANCE_ADD_BAND_${k + 1} = -0.1\n RADIANCE_MULT_BAND_${k + 1} = 1.0E-02\n RADIANCE_ADD_BAND_${k + 1} = -50.0`), ' K1_CONSTANT_BAND_8 = 774.8853', ' K2_CONSTANT_BAND_8 = 1321.0789'].join('\n');
    await app.msi.fromMetadata(la, new File([mtl], 'LC08_TEST_MTL.txt'), { target: 'reflectance' });
    const toa = { state: la.radiometry.state, g: la.radiometry.gain[0], o: la.radiometry.offset[0] };
    await app.msi.fromMetadata(la, new File([mtl], 'LC08_TEST_MTL.txt'), { target: 'radiance' });
    const bt = await app.msi.brightnessTemperature(la, 7, {});
    const btv = (await app.pool.run('pixels', { handle: bt.handle, x: 10, y: 10, w: 1, h: 1, bands: [0] }, { affinity: bt.affinity })).values[0][0];
    const dn = (await app.pool.run('pixels', { handle: la.handle, x: 10, y: 10, w: 1, h: 1, bands: [7] }, { affinity: la.affinity })).values[0][0];
    app.msi.setRadiometry(la, la.info.radiometry);
    await app.msi.correction(la, 'dos', { percentile: 0.0001 });
    const dos = la.radiometry.dark.slice();
    await app.msi.correction(la, 'iarr');
    const iarr = la.radiometry.state;
    app.msi.setRadiometry(la, la.info.radiometry);
    // Spectral plot: a point, a pinned region, SAM between them.
    const s1 = await app.msi.spectrumAt(la, { x: 70, y: 200 }, 'point');
    app.msi.plot.last = s1;
    app.msi.pin(s1, 'veg point');
    const s2 = await app.msi.spectrumAt(la, { rect: { x0: 400, y0: 20, w: 40, h: 40 } }, 'region');
    app.msi.pin(s2, 'water field');
    app.activeMp().docks.show('spectral');
    await new Promise((res) => setTimeout(res, 200));
    const plotOk = !!document.querySelector('[data-id="spectral-plot"]');
    const samRow = document.querySelector('[data-id="spectral-sam"]')?.textContent ?? '';
    // The embedded USGS starter library resampled to FX-08 bands; SAM signatures classify.
    const lib = app.msi.libraries;
    const pick = (re) => lib.find((x) => re.test(x.name));
    const grass = await app.msi.resampled(la, pick(/^Lawn Grass/));
    const sea = await app.msi.resampled(la, pick(/^Seawater/));
    const conc = await app.msi.resampled(la, pick(/^Concrete/));
    // Cell (0, 0) is vegetation on both dates (away from the 4 × 4 anomaly at 60, 70).
    const sv = await app.msi.spectrumAt(la, { rect: { x0: 10, y0: 10, w: 30, h: 30 } }, 'region');
    const samVeg = app.msi.sam(grass.values, sv.values);
    const samWater = app.msi.sam(grass.values, s2.values);
    const P = await app.msi.classify(la, 'sam', { signatures: [grass, sea, conc] });
    const lbl = (x, y) => P.msi.labelsAll[y * 512 + x];
    const libCls = { veg: lbl(20, 20), water: lbl(448, 64), libSize: lib.length };
    // Two-date change: the changed fields stand out.
    const ch = await app.msi.spectralChange(la, lb);
    const mag = ch.msi.magnitude;
    const at = (x, y) => mag[y * 512 + x];
    const [c1] = truth.changed;
    const changed = at(c1.cell[0] * 128 + 64, c1.cell[1] * 128 + 64);
    const same = at(64, 300);
    // Template matching: a 12 × 12 template from a field corner finds its repeats (same layout).
    app.store.transact('a', (tx) => tx.set(p.id, 'activeLayer', la.id), { kind: 'load' });
    const tm = await app.msi.templateMatch(la, { x0: 122, y0: 122, w: 12, h: 12 }, { band: 6, threshold: 0.6 });
    // Xport: up to 16 linked panes.
    const xp = await app.msi.xport(la, [['preset', 'natural'], ['preset', 'cir'], ['index', 'ndvi'], ['index', 'ndwi'], ['index', 'savi'], ['band', 0], ['band', 7], ['preset', 'rededge'], ['preset', 'bathymetric']]);
    return { libCls, samVeg, samWater, st0, toa, btv, dn, dos, iarr, plotOk, samRow, changed, same, tm: tm.hits.length, xp: xp.length, panes: app.activeMp().panes.length, layout: app.activeMp().rec?.layout };
  }, truth);
  console.log(JSON.stringify(r));
  expect(r.libCls.libSize).toBeGreaterThanOrEqual(60);
  expect(r.samVeg).toBeLessThan(r.samWater);
  expect(r.libCls.veg).toBe(1);
  expect(r.libCls.water).toBe(2);
  expect(r.st0).toMatch(/scaled/);
  expect(r.toa.state).toBe('TOA reflectance');
  expect(Math.abs(r.toa.g - 2e-5 / 0.5)).toBeLessThan(1e-12);
  // BT = K2 / ln(K1/L + 1) with L = 0.01·DN − 50.
  const L = 0.01 * r.dn - 50;
  expect(Math.abs(r.btv - 1321.0789 / Math.log(774.8853 / L + 1))).toBeLessThan(0.01);
  expect(r.dos.every((d) => d >= 0)).toBe(true);
  expect(r.iarr).toMatch(/IARR/);
  expect(r.plotOk).toBe(true);
  expect(r.samRow).toMatch(/SAM \d\.\d{4} rad/);
  expect(r.changed).toBeGreaterThan(5 * r.same);
  expect(r.tm).toBeGreaterThanOrEqual(3);
  expect(r.xp).toBe(9);
  expect(r.panes).toBe(9);
  expect(logs).toEqual([]);
});

test('REQ-MSI-01 REQ-MSI-11 Indian Pines AVIRIS (220 bands ENVI BSQ): wavelengths, RX in PCA space above 32 bands', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve(SAMPLES, 'envi-hsi-indian-pines/indian_pines_220b.img'), resolve(SAMPLES, 'envi-hsi-indian-pines/indian_pines_220b.hdr')]);
  await ready(frame, 1);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const b = app.msi.bandsOf(l);
    const rx = await app.msi.detect(l, 'rx', { percentile: 0.999 });
    const ndvi = app.msi.indexAvailable(l, 'ndvi');
    return { nb: l.bands, first: b[0], last: b[219], rad: l.radiometry.state, reduced: rx.reduced, hits: rx.hits.length, ndvi };
  });
  console.log(JSON.stringify(r));
  expect(r.nb).toBe(220);
  expect(r.first.cw).toBeGreaterThan(0.35);
  expect(r.last.cw).toBeGreaterThan(2.4);
  expect(r.reduced).toMatchObject({ from: 220, to: 20 });
  expect(r.hits).toBeGreaterThan(0);
  expect(r.ndvi.ok).toBe(true);
  expect(logs).toEqual([]);
});
