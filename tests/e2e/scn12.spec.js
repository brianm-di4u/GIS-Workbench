// SCN-12 SAR complex exploitation, amplitude change and CCD on FX-07 (Appendix E AT-12.1..12.5)
// and the public Umbra SICD chip, plus the R3 SAR Shoulds/Coulds: pixel types, calibrated views,
// speckle filters, the pair finder, sub-apertures, CSI, Pauli and SIDD.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles, SAMPLES } from './helpers.js';

const DIR = resolve('fixtures/fx07');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx07_truth.json'), 'utf8'));
const oracle = (n) => JSON.parse(readFileSync(resolve(DIR, `oracle_${n}.json`), 'utf8'));
const UMBRA = resolve(SAMPLES, 'sicd-umbra-chip/umbra_sicd_chip_1024.nitf');

test.describe.configure({ timeout: 300000 });

test('SCN-12 AT-12.1 AT-12.3 REQ-SAR-01 REQ-SAR-02 REQ-SAR-05 REQ-FMT-08 FX-07 a public SICD loads; corners match SARkit; R/Rdot round trip', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [UMBRA]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex), null, { timeout: 60000 });
  const ou = oracle('umbra');
  const r = await frame.evaluate(async (ou) => {
    const app = window.gisworkbench;
    const l = app.activeLayer();
    const m = l.info.sar;
    const rows = Object.fromEntries(app.sar.summaryRows(l));
    // SARkit reference points: the oracle's corner and SCP rows (the last five per HAE).
    let worst = 0;
    for (const p of ou.i2hae) {
      const x = p.col - ou.firstCol + 0.5;
      const y = p.row - ou.firstRow + 0.5;
      const g = l.groundAt(x, y, p.hae);
      worst = Math.max(worst, app.core.inverse(g.lat, g.lon, p.lat, p.lon).distance);
    }
    // AT-12.3: image → ground (HAE) → image through R/Rdot.
    let rt = 0;
    for (let k = 0; k < 200; k++) {
      const x = 10 + ((k * 37) % 1000);
      const y = 10 + ((k * 91) % 1000);
      const g = l.groundAt(x, y, 0);
      const q = l.imageAt(g.lat, g.lon, g.h);
      rt = Math.max(rt, Math.hypot(q.x - x, q.y - y));
    }
    const done = app.sar.metadataDialog(l);
    await new Promise((res) => setTimeout(res, 300));
    const dlg = document.querySelector('[data-id="dialog:sar-metadata"]');
    const card = dlg?.querySelector('[data-id="sar-summary"]')?.textContent ?? '';
    const treeNodes = dlg?.querySelectorAll('details').length ?? 0;
    [...(dlg?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Close')?.click();
    await done;
    return { version: m.version, collector: m.collector, start: m.collectStart, model: l.modelName, worst, rt, card, treeNodes, corners: rows['Image corners vs projection'], format: l.info.format, bands: l.bands, radiometry: m.radiometry?.reason ?? null, views: ['sigma0', 'beta0'].map((v) => app.sar.viewAvailable(l, v)) };
  }, ou);
  console.log(JSON.stringify({ ...r, card: r.card.slice(0, 160) }));
  expect(r.version).toBe('1.3.0');
  expect(r.collector).toMatch(/UMBRA/i);
  expect(r.start).toMatch(/^2023-01-18T07:24/);
  expect(r.card).toContain('SICD 1.3.0');
  expect(r.card).toMatch(/UMBRA/i);
  expect(r.card).toMatch(/2023-01-18/);
  expect(r.card).toMatch(/RGAZIM \/ PFA/);
  expect(r.treeNodes).toBeGreaterThan(20);
  expect(r.model).toMatch(/SICD Vol\. 3/);
  expect(r.worst).toBeLessThan(0.01);
  expect(r.rt).toBeLessThan(0.05);
  // ImageCorners differ by ~14 m (producer convention): reported for information only.
  expect(r.corners).toMatch(/for information/);
  // The Umbra product has no Radiometric block: calibrated views are disabled with the reason.
  expect(r.radiometry).toMatch(/no Radiometric block/);
  expect(r.views.every((v) => !v.ok && /Radiometric/.test(v.reason))).toBe(true);
  expect(logs).toEqual([]);
});

test('SCN-12 AT-12.2 REQ-SAR-03 REQ-SAR-06 FX-07 views and remaps change without re-reading the file, under 200 ms on a 2k viewport; pixel types agree', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, ['a', 'c', 'd'].map((k) => resolve(DIR, truth.files[k])));
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 3, null, { timeout: 90000 });
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].sort((x, y) => x.rec.name.localeCompare(y.rec.name));
    const [la, lc, ld] = ls;
    const p = app.activePane();
    app.activeMp().setActivePane(p);
    app.store.transact('a', (tx) => tx.set(p.id, 'activeLayer', la.id), { kind: 'load' });
    for (const l of [lc, ld]) app.store.transact('hide', (tx) => tx.set(l.id, 'visible', false), { kind: 'load' });
    await new Promise((res) => setTimeout(res, 800));
    const io0 = await app.pool.run('iostats', {}, { affinity: la.affinity });
    const times = {};
    for (const [k] of app.sar.setRemap ? [['sar-density'], ['sar-brighter'], ['sar-darker'], ['sar-highcontrast'], ['sar-linear'], ['sar-log'], ['sar-pedf'], ['sar-nrl']] : []) {
      const t0 = performance.now();
      app.sar.setRemap(la, k);
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      times[k] = performance.now() - t0;
    }
    const io1 = await app.pool.run('iostats', {}, { affinity: la.affinity });
    // Views: magnitude, phase, I, Q, power, σ⁰ (FX-07 a has a Radiometric block with σ⁰ only).
    const views = {};
    for (const v of ['phase', 'i', 'q', 'power', 'sigma0', 'beta0', 'gamma0', 'rcs', 'magnitude']) {
      const ok = app.sar.viewAvailable(la, v);
      if (ok.ok) await app.sar.setView(la, v);
      views[v] = { ok: ok.ok, bands: la.chain.bands, stretch: la.chain.stretch, palette: la.chain.colour.palette };
    }
    // The same pixel through the three pixel types (amplitude; AMP8I is quantised).
    const px = async (l) => (await app.pool.run('pixels', { handle: l.handle, x: 300, y: 310, w: 4, h: 4, bands: [0, 6] }, { affinity: l.affinity })).values;
    const [va, vc, vd] = [await px(la), await px(lc), await px(ld)];
    const ratio = (u, v) => u.map((x, i) => v[i] / x);
    return { times, io: [io0, io1], views, ampA: va[0], ratioC: ratio(va[0], vc[0]), ratioD: ratio(va[0], vd[0]), sigma0: va[1], viewport: [innerWidth, innerHeight], formats: ls.map((l) => l.info.format), rad: la.info.sar.radiometry?.derived };
  }, truth);
  console.log(JSON.stringify({ times: r.times, io: r.io, formats: r.formats, rad: r.rad, ratioC: r.ratioC.slice(0, 3), ratioD: r.ratioD.slice(0, 3) }));
  expect(Object.keys(r.times).length).toBeGreaterThanOrEqual(4);
  for (const t of Object.values(r.times)) expect(t).toBeLessThan(200);
  // No byte-range read happened while the remaps changed (AC-12.2).
  expect(r.io[1].reads ?? r.io[1].count).toBe(r.io[0].reads ?? r.io[0].count);
  expect(r.views.phase.palette).toBe('cyclic');
  expect(r.views.i.stretch).toBe('symmetric');
  expect(r.views.sigma0.ok && r.views.beta0.ok && r.views.gamma0.ok && r.views.rcs.ok).toBe(true);
  expect(r.rad.sigma0).toBe('file');
  expect(r.rad.beta0).toBe('derived');
  expect(r.formats).toEqual(['SICD 1.4.0 (RE32F_IM32F)', 'SICD 1.4.0 (RE16I_IM16I)', 'SICD 1.4.0 (AMP8I_PHS8I)']);
  // RE16I is a scaled copy of the float data; AMP8I is quantised (square-root companding).
  const sc = r.ratioC[0];
  for (const v of r.ratioC) expect(Math.abs(v / sc - 1)).toBeLessThan(0.02);
  for (const v of r.ratioD) expect(Math.abs(v - 1)).toBeLessThan(0.25);
  // σ⁰ (dB) = 10·log10(SF·|z|²) with SF ≈ 2 at the SCP.
  for (let i = 0; i < r.ampA.length; i++) expect(Math.abs(r.sigma0[i] - 10 * Math.log10(2 * r.ampA[i] ** 2))).toBeLessThan(0.05);
  expect(logs).toEqual([]);
});

test('SCN-12 AT-12.4 REQ-SAR-08 REQ-SAR-09 REQ-SAR-10 REQ-SAR-14 FX-07 CCD coherence, amplitude change, pair finder', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, ['a', 'b'].map((k) => resolve(DIR, truth.files[k])));
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 2, null, { timeout: 90000 });
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const [la, lb] = [...app.layers.values()].sort((x, y) => x.rec.name.localeCompare(y.rec.name));
    const p = app.activePane();
    app.store.transact('a', (tx) => tx.set(p.id, 'activeLayer', la.id), { kind: 'load' });
    const N = truth.size;
    const chip = { x0: 0, y0: 0, w: N, h: N };
    const c = await app.sar.ccd(la, lb, { chip, win: 5, products: ['coherence', 'mtc', 'masked', 'interferogram'] });
    const d = truth.regions.disturbed;
    const w = truth.regions.water;
    const mean = (f) => {
      let s = 0;
      let n = 0;
      for (let y = 8; y < N - 8; y += 2)
        for (let x = 8; x < N - 8; x += 2) {
          const v = c.gamma[y * N + x];
          if (Number.isFinite(v) && f(x, y)) {
            s += v;
            n++;
          }
        }
      return { mean: s / n, n };
    };
    const inD = (x, y) => y >= d.row0 + 4 && y < d.row1 - 4 && x >= d.col0 + 4 && x < d.col1 - 4;
    const nearD = (x, y) => y >= d.row0 - 8 && y < d.row1 + 8 && x >= d.col0 - 8 && x < d.col1 + 8;
    const inW = (x, y) => y >= w.row0 && x >= w.col0;
    const stable = mean((x, y) => !nearD(x, y) && !(y >= w.row0 - 8 && x >= w.col0 - 8));
    const disturbed = mean(inD);
    let waterNoDecision = 0;
    let waterN = 0;
    for (let y = w.row0 + 6; y < N - 6; y += 3)
      for (let x = w.col0 + 6; x < N - 6; x += 3) {
        waterN++;
        if (!Number.isFinite(c.gamma[y * N + x])) waterNoDecision++;
      }
    // Without registration the 0.3/−0.2 px misregistration costs coherence.
    const raw = await app.sar.ccd(la, lb, { chip: { x0: 100, y0: 100, w: 256, h: 256 }, win: 5, register: false, products: [] });
    let rs = 0;
    let rn = 0;
    for (const v of raw.gamma) if (Number.isFinite(v)) {
      rs += v;
      rn++;
    }
    const acd = await app.sar.acd(la, lb, { chip, threshold: 3, win: 5 });
    const pairs = await app.sar.findPairs([la, lb]);
    return { warp: c.warp, rms: c.rms, ties: c.ties, fringe: c.fringe, stable, disturbed, water: waterNoDecision / waterN, unregistered: rs / rn, ms: c.ms, layers: Object.keys(c.layers), poly: acd.polygons.map((q) => ({ kind: q.kind, px: q.pixels, x: q.ring.reduce((s, v) => s + v.x, 0) / q.ring.length, y: q.ring.reduce((s, v) => s + v.y, 0) / q.ring.length })), pairs: pairs.map((q) => ({ ok: q.ok, matched: q.matched, overlap: q.overlap, days: q.days, reasons: q.reasons })), comp: app.sar.compatibility(la, lb) };
  }, truth);
  console.log(JSON.stringify({ ...r, poly: r.poly.slice(0, 6) }));
  // Registration recovers the injected shift (image 2 content sits at +0.3 rows, −0.2 columns).
  expect(Math.abs(r.warp[3] - truth.shiftB.row)).toBeLessThan(0.05);
  expect(Math.abs(r.warp[0] - truth.shiftB.col)).toBeLessThan(0.05);
  // Flat-earth fringe found: the interferogram f·g* carries −ramp.
  expect(Math.abs(r.fringe[0] + truth.rampB.row)).toBeLessThan(0.002);
  expect(Math.abs(r.fringe[1] + truth.rampB.col)).toBeLessThan(0.002);
  // AT-12.4 (5 × 5): ≥ 0.8 stable, ≤ 0.4 disturbed.
  expect(r.stable.mean).toBeGreaterThanOrEqual(0.8);
  expect(r.disturbed.mean).toBeLessThanOrEqual(0.4);
  expect(r.water).toBeGreaterThan(0.9); // CNR mask: no decision over the water
  expect(r.unregistered).toBeLessThan(r.stable.mean);
  expect(r.layers).toEqual(['coherence', 'mtc', 'masked', 'interferogram']);
  // Amplitude change: the vehicle that left (decrease) and the one that arrived (increase).
  const near = (v, kind) => r.poly.some((q) => q.kind === kind && Math.abs(q.x - (v.col + v.w / 2)) < 8 && Math.abs(q.y - (v.row + v.h / 2)) < 8);
  expect(near(truth.vehicles.onlyA, 'decrease')).toBe(true);
  expect(near(truth.vehicles.onlyB, 'increase')).toBe(true);
  // Pair finder: compatible, MatchInfo-linked, 11 days apart, full overlap.
  expect(r.pairs[0].ok).toBe(true);
  expect(r.pairs[0].matched).toBe(true);
  expect(Math.abs(r.pairs[0].days - 11)).toBeLessThan(0.01);
  expect(r.pairs[0].overlap).toBeGreaterThan(0.99);
  expect(r.comp.ok && r.comp.matchInfo).toBe(true);
  expect(logs).toEqual([]);
});

test('SCN-12 AT-12.5 REQ-SAR-04 FX-07 anamorphic, ground plane, shadows-down and the overlay match the SICD geometry', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve(DIR, truth.files.a), UMBRA]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 2, null, { timeout: 90000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const out = {};
    for (const l of [...app.layers.values()]) {
      const p = app.activePane();
      app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', l.id), { kind: 'load' });
      for (const o of app.layers.values()) app.store.transact('vis', (tx) => tx.set(o.id, 'visible', o === l), { kind: 'load' });
      p.fitWhole();
      const m = l.info.sar;
      p.sar = { overlay: true };
      // The rigorous layover: a 100 m mast at the scene centre, projected into the image.
      const g = l.groundAt(l.width / 2, l.height / 2, m.scpHae);
      const top = l.imageAt(g.lat, g.lon, g.h + 100);
      const base = l.imageAt(g.lat, g.lon, g.h);
      const sa = p.screenPoint(base.x, base.y);
      const sb = p.screenPoint(top.x, top.y);
      const mastScreen = Math.atan2(sb.y - sa.y, sb.x - sa.x);
      const ov0 = app.sar.overlayState(p);
      // Anamorphic squaring: the screen distance of one row step over one column step = Row.SS/Col.SS.
      app.sar.displayMode(p, 'anamorphic');
      const s0 = p.screenPoint(100, 100);
      const sx = p.screenPoint(101, 100);
      const sy = p.screenPoint(100, 101);
      const aspect = Math.hypot(sy.x - s0.x, sy.y - s0.y) / Math.hypot(sx.x - s0.x, sx.y - s0.y);
      // Shadows down: the shadow arrow points down the screen.
      p.applyOrientation('shadows');
      const ov = app.sar.overlayState(p);
      // Ground plane: north up, one screen pixel the same ground distance both ways.
      app.sar.displayMode(p, 'ground');
      p.applyOrientation('north');
      const ovg = app.sar.overlayState(p);
      const c = { x: p.view.cx, y: p.view.cy };
      const s1 = p.screenPoint(c.x, c.y);
      const gx = l.groundAt(c.x + 50, c.y, m.scpHae);
      const gc = l.groundAt(c.x, c.y, m.scpHae);
      const ix = p.screenPoint(c.x + 50, c.y);
      const d1 = app.core.inverse(gc.lat, gc.lon, gx.lat, gx.lon);
      const scr = Math.hypot(ix.x - s1.x, ix.y - s1.y);
      // Screen azimuth of that step against its ground azimuth (north-up ground display).
      const scrAz = (Math.atan2(ix.x - s1.x, -(ix.y - s1.y)) * 180) / Math.PI;
      app.sar.displayMode(p, 'native');
      out[m.collector] = { layover: ov0.layover, mastScreen, aspect, ssRatio: m.rowSS / m.colSS, shadowDown: ov.shadow, northGround: ovg.north, residual: p.sar.groundResidual, azErr: ((scrAz - d1.azi1 + 540) % 360) - 180, scale: d1.distance / scr, layoverAng: m.layover };
    }
    return out;
  });
  console.log(JSON.stringify(r));
  const deg = (a) => (a * 180) / Math.PI;
  const diff = (a, b) => Math.abs(((deg(a - b) + 540) % 360) - 180);
  for (const v of Object.values(r)) {
    // The overlay's layover arrow follows SCPCOA LayoverAng and agrees with the rigorous mast lean.
    expect(diff(v.layover, v.mastScreen)).toBeLessThan(1.0);
    expect(Math.abs(v.aspect - v.ssRatio)).toBeLessThan(0.002);
    // Shadows-down: the shadow arrow points straight down (+y on the screen).
    expect(diff(v.shadowDown, Math.PI / 2)).toBeLessThan(0.5);
    // Ground plane north-up: north arrow up, azimuths true on the screen.
    expect(diff(v.northGround, -Math.PI / 2)).toBeLessThan(0.5);
    expect(Math.abs(v.azErr)).toBeLessThan(0.5);
  }
  expect(logs).toEqual([]);
});

test('REQ-SAR-07 REQ-SAR-11 REQ-SAR-12 REQ-SAR-13 FX-07 speckle preview and export, sub-apertures, CSI, Pauli, SIDD', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const quad = Object.values(truth.quadPol.files).map((f) => resolve(DIR, f));
  const sidd = resolve(SAMPLES, 'sidd-umbra/2023-10-24-03-19-54_UMBRA-04_SIDD.nitf');
  await openFiles(frame, [resolve(DIR, truth.files.a), ...quad, ...(existsSync(sidd) ? [sidd] : [])]);
  await frame.waitForFunction((n) => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === n, existsSync(sidd) ? 5 : 4, { timeout: 120000 });
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const all = [...app.layers.values()];
    const la = all.find((l) => /fx07_a/.test(l.rec.name));
    const p = app.activePane();
    app.store.transact('a', (tx) => tx.set(p.id, 'activeLayer', la.id), { kind: 'load' });
    // GPU preview of each filter, then a Lee export on a chip.
    const shots = {};
    for (const op of ['lee', 'kuan', 'gammamap', 'frost', 'refinedlee', 'mean', 'median']) {
      app.sar.setSpeckle(la, op, { win: 7, looks: 1, damping: 2 });
      app.renderer.invalidate();
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      shots[op] = app.renderer.stats.frameMs;
    }
    app.sar.setSpeckle(la, 'none');
    // One homogeneous field of FX-07 (no buildings, road or vehicles): speckle CV ≈ 1 for one look.
    const chip = { x0: 480, y0: 640, w: 160, h: 128 };
    const before = (await app.pool.run('window', { handle: la.handle, ...chip, bands: [0] }, { affinity: la.affinity })).planes[0];
    const fl = await app.sar.exportSpeckle(la, 'lee', { win: 7, looks: 1 }, chip);
    await fl.ensureStats();
    const after = (await app.pool.run('window', { handle: fl.handle, x0: 0, y0: 0, w: chip.w, h: chip.h, bands: [0] }, { affinity: fl.affinity })).planes[0];
    // Intensity coefficient of variation in the interior (away from the 7 × 7 window edge).
    const cv = (a) => {
      let s = 0;
      let s2 = 0;
      let n = 0;
      for (let y = 8; y < chip.h - 8; y++)
        for (let x = 8; x < chip.w - 8; x++) {
          const v = a[y * chip.w + x] ** 2;
          s += v;
          s2 += v * v;
          n++;
        }
      const m = s / n;
      return Math.sqrt(s2 / n - m * m) / m;
    };
    // The exported product keeps the SICD geometry (the chip offsets).
    const g1 = la.groundAt(chip.x0 + 64, chip.y0 + 64, 20);
    const g2 = fl.groundAt(64, 64, 20);
    const geo = app.core.inverse(g1.lat, g1.lon, g2.lat, g2.lon).distance;
    const sub = await app.sar.subaperture(la, { chip: { x0: 40, y0: 40, w: 256, h: 256 }, frames: 5, fraction: 0.25 });
    const csiL = await app.sar.csi(la, { chip: { x0: 40, y0: 40, w: 256, h: 256 } });
    const quads = all.filter((l) => /fx07_q/.test(l.rec.name));
    const pa = await app.sar.pauli(quads, { chip: { x0: 0, y0: 0, w: 512, h: 512 } });
    const at = (k, x, y) => pa.planes[k][y * 512 + x];
    const dih = [0, 1, 2].map((k) => at(k, 130, 130));
    const vol = [0, 1, 2].map((k) => at(k, 330, 330));
    const sl = all.find((l) => /SIDD/.test(l.rec.name));
    return { shots, cvBefore: cv(before), cvAfter: cv(after), geo, flModel: fl.modelName, subBands: sub.layer.bands, frames: sub.frames, csiBands: csiL.bands, dih, vol, sidd: sl ? { model: sl.modelName, format: sl.info.format, measurement: sl.info.sar.measurement, display: sl.info.sar.display.length, g: sl.groundAt(sl.width / 2, sl.height / 2, 400) } : null };
  }, truth);
  console.log(JSON.stringify(r));
  expect(r.cvBefore).toBeGreaterThan(0.8);
  expect(r.cvAfter).toBeLessThan(r.cvBefore * 0.6);
  expect(r.geo).toBeLessThan(0.05);
  expect(r.flModel).toMatch(/SICD/);
  expect(r.frames).toBe(5);
  expect(r.subBands).toBe(5);
  expect(r.csiBands).toBe(3);
  // Pauli: double bounce red (|HH − VV|), volume green (|HV|).
  expect(r.dih[0]).toBeGreaterThan(2 * Math.max(r.dih[1], r.dih[2]));
  expect(r.vol[1]).toBeGreaterThan(2 * Math.max(r.vol[0], r.vol[2]));
  if (r.sidd) {
    expect(r.sidd.measurement).toBe('PlaneProjection');
    expect(r.sidd.model).toMatch(/SIDD/);
    expect(r.sidd.display).toBeGreaterThan(2);
    expect(Math.abs(r.sidd.g.lat - 46.9)).toBeLessThan(1.5);
  }
  expect(logs).toEqual([]);
});
