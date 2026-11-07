// 2.5 csm group (REQ-GAP-24, spike S-60) in the app: usgscsm compiled to WebAssembly behind a
// hand-written C ABI, CSM models attached to open images from usgscsm ISDs, answering through the
// Rust SensorModel trait (the core's host model and the page's bridge).
//  - Frame, line-scanner and push-frame ISDs (usgscsm's own test ISDs) and a WGS 84 frame ISD
//    attach to images of their size; the core's image ↔ ground through the CSM model agrees with
//    native usgscsm (fixtures/fx25/csm/oracle, g++ build) at floating-point level.
//  - A block adjustment through the CSM parameters (the analysis worker rebuilds the model from its
//    state) recovers a known position error of the WGS 84 frame camera.
//  - Refusals by name: a size mismatch (the SAR ISD on a small image), not JSON, an unknown model.
//  - The saved model state restores the model (the project reload path); no CSP violation (no
//    eval); Model Info with a CSM model passes axe. Load time and per-call cost are measured.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { openApp } from './helpers.js';

const FX = 'fixtures/fx25/csm';
const isd = (n) => readFileSync(`${FX}/isd/${n}.json`, 'utf8');
const oracle = (n) => JSON.parse(gunzipSync(readFileSync(`${FX}/oracle/upstream/${n}.json.gz`)).toString('utf8'));

test('REQ-GAP-24 CSM models from usgscsm ISDs answer through the sensor-model interface', async ({ page }, info) => {
  test.setTimeout(300000);
  const { frame, logs, csp } = await openApp(page, 'file');
  const names = ['orbitalFramer', 'orbitalLineScan', 'orbitalPushFrame', 'earthFramer'];
  const cases = names.map((n) => {
    const o = oracle(n);
    return { n, text: isd(n), lines: o.info.lines, samples: o.info.samples, a: o.info.a, appImg: o.appImg, llh: o.llh, xy: o.xy };
  });
  const sar = isd('orbitalSar');
  const r = await frame.evaluate(
    async ({ cases, sar }) => {
      const app = window.gisworkbench;
      const core = app.core;
      const png = async (w, h, name) => {
        const c = new OffscreenCanvas(w, h);
        const g = c.getContext('2d');
        g.fillStyle = '#808080';
        g.fillRect(0, 0, w, h);
        g.fillStyle = '#202020';
        g.fillRect(0, 0, Math.ceil(w / 2), Math.ceil(h / 2));
        return new File([await c.convertToBlob({ type: 'image/png' })], name);
      };
      const layerOf = (name) => [...app.layers.values()].find((x) => x.rec?.name?.startsWith(name));
      const out = { cases: {} };
      for (const k of cases) {
        await app.openFiles([await png(k.samples, k.lines, `${k.n}.png`)]);
        const l = layerOf(`${k.n}.png`);
        const t0 = performance.now();
        const res = await app.commands.run('model.csm', { file: new File([k.text], `${k.n}.json`), layer: l.id });
        const attachMs = performance.now() - t0;
        // The core's answers (Rust SensorModel trait → bridge → usgscsm) against native usgscsm.
        const D = Math.PI / 180;
        let dI2g = 0;
        let dG2i = 0;
        let bad = 0;
        const n = k.appImg.length / 3;
        for (let i = 0; i < n; i++) {
          const [x, y, h] = k.appImg.slice(3 * i, 3 * i + 3);
          const want = k.llh.slice(3 * i, 3 * i + 3);
          let g;
          try {
            g = core.i2g(l.modelId, x, y, h);
          } catch {
            g = { lat: NaN, lon: NaN };
          }
          if (want[0] === null) {
            if (Number.isFinite(g.lat)) bad++;
            continue;
          }
          dI2g = Math.max(dI2g, Math.abs(g.lat - want[0]) * D * k.a, Math.abs(g.lon - want[1]) * D * k.a * Math.cos(want[0] * D));
          const p = core.g2i(l.modelId, want[0], want[1], want[2]);
          dG2i = Math.max(dG2i, Math.abs(p.x - k.xy[2 * i]), Math.abs(p.y - k.xy[2 * i + 1]));
        }
        // Per-call cost through the core: ground → image and image → ground, 2000 each.
        const g0 = core.i2g(l.modelId, k.samples / 2, k.lines / 2, 0);
        let t = performance.now();
        for (let i = 0; i < 2000; i++) core.g2i(l.modelId, g0.lat, g0.lon, i % 7);
        const g2iUs = ((performance.now() - t) * 1000) / 2000;
        t = performance.now();
        for (let i = 0; i < 2000; i++) core.i2g(l.modelId, k.samples / 2 + (i % 5) * 0.1, k.lines / 2, 0);
        const i2gUs = ((performance.now() - t) * 1000) / 2000;
        const info = core.modelInfo(l.modelId);
        const pe = core.pointError(l.modelId, k.samples / 2, k.lines / 2, 0, 0.5);
        out.cases[k.n] = { res, attachMs, dI2gM: dI2g, dG2iPx: dG2i, bad, points: n, g2iUs, i2gUs, active: l.modelName, models: l.models.map((m) => m.name), params: info.params, paramNames: info.paramNames, hmin: info.hmin, hmax: info.hmax, ce90: pe.ce90, modelErrorKnown: pe.modelErrorKnown, saved: !!l.rec.csm?.state, recModel: l.rec.model };
      }
      out.stats = app.csmStats;
      // Refusals by name.
      const small = layerOf('orbitalFramer.png');
      out.refuse = {
        size: await app.commands.run('model.csm', { file: new File([sar], 'orbitalSar.json'), layer: small.id }),
        json: await app.commands.run('model.csm', { file: new File(['not an ISD'], 'bad.json'), layer: small.id }),
        model: await app.commands.run('model.csm', { file: new File([JSON.stringify({ name_model: 'USGS_ASTRO_PROJECTED_SENSOR_MODEL', image_lines: 16, image_samples: 16 })], 'proj.json'), layer: small.id }),
      };
      out.afterRefusal = small.modelName;
      // Block adjustment through the CSM parameters (analysis worker, type-9 records): GCPs from
      // the same camera displaced by (+200, −150, +100) m.
      const l = layerOf('earthFramer.png');
      const { csm, bridge } = await app.csm.module();
      const h0 = csm.fromState(l.rec.csm.state);
      const ht = bridge.adopt(csm.withParams(h0, [200, -150, 100]));
      csm.free(h0);
      const truth = core.hostModel(ht);
      app.store.transact('test GCPs', (tx) => {
        for (let j = 0; j < 3; j++)
          for (let i = 0; i < 3; i++) {
            const x = 40 + (i * 320) / 2;
            const y = 30 + (j * 240) / 2;
            const hae = [0, 400, 900][(i + j) % 3];
            const g = core.i2g(truth, x, y, hae);
            tx.create('tripoint', { name: `C${i}${j}`, kind: 'gcp', known: { lat: g.lat, lon: g.lon, hae }, sigmaH: 0.05, sigmaV: 0.05, obs: { [l.id]: { x, y, sigma: 0.1 } } });
          }
      });
      const gT = core.i2g(truth, 200, 150, 200);
      const before = core.g2i(l.modelId, gT.lat, gT.lon, 200);
      const t1 = performance.now();
      const rep = await app.tri.solve({ kind: 'sensor', layers: [l] });
      const solveMs = performance.now() - t1;
      const label = app.tri.applySolution(rep);
      await new Promise((res) => setTimeout(res, 50));
      const after = core.g2i(l.modelId, gT.lat, gT.lon, 200);
      out.block = { params: rep.images[0].params, names: rep.images[0].paramNames, sigma0: rep.sigma0, converged: rep.converged, iterations: rep.iterations, model: l.modelName, label, before: Math.hypot(before.x - 200, before.y - 150), after: Math.hypot(after.x - 200, after.y - 150), solveMs, gcpResiduals: rep.gcpResiduals };
      core.freeModel(truth);
      // The project reload path: the saved state rebuilds the model.
      const lf = layerOf('orbitalLineScan.png');
      const savedName = lf.modelName;
      lf.models = lf.models.filter((m) => !m.csm);
      const re = await app.restoreCsmModel(lf);
      const g1 = core.i2g(lf.modelId, 8, 8, 0);
      out.restore = { re, name: lf.modelName, savedName, g1 };
      out.storeHasState = /m_modelName/.test(JSON.stringify(app.store.get(lf.id)?.csm ?? null));
      return out;
    },
    { cases, sar },
  );
  const summary = Object.fromEntries(Object.entries(r.cases).map(([k, v]) => [k, { attachMs: Math.round(v.attachMs), dI2gM: v.dI2gM, dG2iPx: v.dG2iPx, g2iUs: +v.g2iUs.toFixed(2), i2gUs: +v.i2gUs.toFixed(2) }]));
  console.log(`[${info.project.name}] usgscsm ${JSON.stringify(r.stats)}; ${JSON.stringify(summary)}; block ${JSON.stringify({ before: r.block.before, after: r.block.after, ms: Math.round(r.block.solveMs), it: r.block.iterations, p: r.block.params?.slice(0, 3) })}`);
  // Each model attached, active, named, with its CSM parameters, and saved with the layer.
  const kinds = { orbitalFramer: 'CSM frame camera (usgscsm)', orbitalLineScan: 'CSM line scanner (usgscsm)', orbitalPushFrame: 'CSM push frame (usgscsm)', earthFramer: 'CSM frame camera (usgscsm)' };
  for (const [n, v] of Object.entries(r.cases)) {
    expect(v.res?.name, n).toBe(kinds[n]);
    expect(v.active, n).toBe(kinds[n]);
    expect(v.saved, n).toBe(true);
    expect(v.recModel, n).toBe(kinds[n]);
    expect(v.params, n).toBeGreaterThan(5);
    expect(v.bad, n).toBe(0);
    // Floating-point agreement with native usgscsm, through the core.
    expect(v.dI2gM, n).toBeLessThan(Math.max(1e-6, 1e-12 * oracle(n).info.a));
    expect(v.dG2iPx, n).toBeLessThan(1e-6);
    // No covariance is claimed from usgscsm's defaults: "error not available".
    expect(v.modelErrorKnown, n).toBe(false);
  }
  expect(r.cases.earthFramer.res.notes).toEqual([]); // WGS 84: no other-body note
  expect(r.cases.orbitalFramer.res.notes.join(' ')).toMatch(/not the Earth/);
  // Refusals, by name; the image keeps its model.
  expect(r.refuse.size.code).toBe('E_CSM_SIZE');
  expect(r.refuse.size.error).toMatch(/2,367 × 64,576/);
  expect(r.refuse.json.code).toBe('E_CSM_NOT_JSON');
  expect(r.refuse.model.code).toBe('E_CSM_MODEL');
  expect(r.afterRefusal).toBe('CSM frame camera (usgscsm)');
  // The adjustment through the CSM parameters recovers the displaced camera.
  expect(r.block.before).toBeGreaterThan(5);
  expect(r.block.after).toBeLessThan(0.05);
  expect(r.block.model).toMatch(/^CSM frame camera \(usgscsm\) \(triangulated: SOL-/);
  expect(r.block.names[0]).toMatch(/Sensor Position/);
  // Restore from the saved state.
  expect(r.restore.re?.name).toBe('CSM line scanner (usgscsm)');
  expect(r.restore.name).toBe(r.restore.savedName);
  expect(Number.isFinite(r.restore.g1.lat)).toBe(true);
  expect(r.storeHasState).toBe(true); // the project file carries the layer record
  // Strict CSP: no eval anywhere; no console errors.
  expect(await csp()).toEqual([]);
  expect(logs.filter((m) => !/Failed to load resource/.test(m))).toEqual([]);

  // Model Info with a CSM model active passes axe.
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  await frame.evaluate(axeSource);
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => x.rec?.name?.startsWith('orbitalPushFrame.png'));
    app.activePane()?.setActiveLayer?.(l.id);
    void app.commands.run('model.info');
  });
  const dlg = frame.locator('[data-id="dialog:model-info"]');
  await expect(dlg).toBeVisible();
  const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[data-id="dialog:model-info"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`));
  expect(v).toEqual([]);
});
