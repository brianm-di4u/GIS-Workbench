// REQ-GAP-24 (spike S-60): the pinned usgscsm WebAssembly module against native usgscsm.
//
// Oracle: usgscsm 2.1.0 built natively with g++ (build/csm/oracle: build-oracle.sh, run-oracle.sh)
// from the same sources, in two variants — "upstream" (ALE's own Eigen Rotation.cpp and usgscsm's
// Eigen EigenUtilities.cpp, as usgscsm ships) and "gw" (the Eigen-free replacements the wasm module
// uses). Both ran on every usgscsm test ISD plus a WGS 84 frame ISD (earthFramer.json, made by
// build/csm/oracle/make-earth-isd.mjs); their answers are in fixtures/fx25/csm/oracle. Here the wasm
// module is fed the same inputs (a 9 × 9 pixel grid at two heights, then the oracle's own ground
// points back) and every answer is compared. Worst differences go to reports/csm-diff.json.
//
// Thresholds: image coordinates within 1e-6 px for frame, line-scanner and push-frame ISDs (S-60);
// ground within 1e-6 m (or 1e-12 of the radius); SAR is reported with its own bound (its
// ground → image is usgscsm's 30-step Brent search, which stops above the requested precision).
// Also: the same CSM frame camera as GIS Workbench's own frame model (gw_sensor::frame) on WGS 84,
// through the Rust core's host model and the bridge — the path the measurement tools use.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Usgscsm, stateRecord } from '../../app/src/sensor/csm-wasm.js';
import { installCsmBridge } from '../../app/src/sensor/csm-host.js';
import { Core } from '../../app/src/wasm/core.js';

const FX = 'fixtures/fx25/csm';
const WASM = 'build/csm/usgscsm.wasm';
const have = existsSync(WASM);
const csm = have ? new Usgscsm(new WebAssembly.Module(readFileSync(WASM))) : null;
const coreWasm = join(process.env.CARGO_TARGET_DIR ?? 'crates/target', 'wasm32-unknown-unknown', 'release', 'gw_bundle_core.wasm');
const isds = existsSync(`${FX}/isd`) ? readdirSync(`${FX}/isd`).filter((f) => f.endsWith('.json')).sort() : [];
const oracle = (variant, f) => JSON.parse(gunzipSync(readFileSync(`${FX}/oracle/${variant}/${f}.gz`)).toString('utf8'));
const nanOf = (a) => Float64Array.from(a, (v) => (v === null ? NaN : v));
const report = {};

/** Worst |a − b| over finite pairs, and whether the NaN patterns agree. */
function worst(a, b, stride = 1, pick = null) {
  let w = 0;
  let mask = 0;
  for (let i = 0; i < a.length; i++) {
    if (pick && !pick.includes(i % stride)) continue;
    const fa = Number.isFinite(a[i]);
    const fb = Number.isFinite(b[i]);
    if (fa !== fb) mask++;
    else if (fa) w = Math.max(w, Math.abs(a[i] - b[i]));
  }
  return { w, mask };
}

afterAll(() => {
  if (!Object.keys(report).length) return;
  mkdirSync('reports', { recursive: true });
  writeFileSync('reports/csm-diff.json', `${JSON.stringify(report, null, 2)}\n`);
});

describe.skipIf(!have)('REQ-GAP-24 usgscsm wasm against native usgscsm', () => {
  it('the module has no JS glue: WASI imports only, the C ABI exports, versions', () => {
    const mod = new WebAssembly.Module(readFileSync(WASM));
    for (const i of WebAssembly.Module.imports(mod)) expect(`${i.module}.${i.name}`).toMatch(/^wasi_snapshot_preview1\.|^env\.emscripten_notify_memory_growth$/);
    const ex = WebAssembly.Module.exports(mod).map((e) => e.name);
    for (const n of ['gwc_model_from_isd', 'gwc_i2g_ecef', 'gwc_g2i_ecef', 'gwc_sensor_partials', 'gwc_model_with_params', 'memory', '_initialize']) expect(ex).toContain(n);
    const man = JSON.parse(readFileSync('build/csm/usgscsm.json', 'utf8'));
    expect(man.output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(csm.version()).toMatchObject({ abi: 1 });
    expect(csm.version().usgscsm).toMatch(/^2\.1\.0/);
  });

  for (const f of isds) {
    it(`${f}: imageToGround and groundToImage over the grid match native usgscsm`, () => {
      const up = oracle('upstream', f);
      const gw = oracle('gw', f);
      const text = readFileSync(`${FX}/isd/${f}`, 'utf8');
      const t0 = performance.now();
      const { handle: h } = csm.fromIsd(text, { id: f.replace(/\.json$/, '') });
      const loadMs = performance.now() - t0;
      try {
        const info = csm.info(h);
        expect(info.model).toBe(up.info.model);
        expect(info.params.length).toBe(up.info.params.length);
        expect([info.lines, info.samples, info.a, info.b]).toEqual([up.info.lines, up.info.samples, up.info.a, up.info.b]);
        for (let i = 0; i < info.params.length; i++) expect(Math.abs(info.params[i].value - up.info.params[i].value)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(up.info.params[i].value)));
        const img = nanOf(up.img);
        const n = img.length / 3;
        let t = performance.now();
        const i2g = csm.i2gEcef(h, img);
        const i2gUs = ((performance.now() - t) * 1000) / n;
        t = performance.now();
        const g2i = csm.g2iEcef(h, nanOf(up.ecef));
        const g2iUs = ((performance.now() - t) * 1000) / n;
        // The same inputs as the native gw build (its own ground points): the compiler and libm alone.
        const g2iGw = csm.g2iEcef(h, nanOf(gw.ecef));
        const llh = csm.batch('gwc_i2g', h, nanOf(up.appImg), 3).v;
        const xy = csm.batch('gwc_g2i', h, nanOf(up.llh), 2).v;
        const r = {
          model: info.model,
          ecefUp: worst(i2g.v, nanOf(up.ecef)),
          ecefGw: worst(i2g.v, nanOf(gw.ecef)),
          pxUp: worst(g2i.v, nanOf(up.back), 3, [0, 1]),
          pxGw: worst(g2iGw.v, nanOf(gw.back), 3, [0, 1]),
          llhDegUp: worst(llh, nanOf(up.llh), 3, [0, 1]),
          hUp: worst(llh, nanOf(up.llh), 3, [2]),
          xyUp: worst(xy, nanOf(up.xy)),
          nativeUpVsGwPx: worst(nanOf(gw.back), nanOf(up.back), 3, [0, 1]),
          points: n,
          failed: i2g.bad,
          loadMs: +loadMs.toFixed(2),
          i2gUs: +i2gUs.toFixed(2),
          g2iUs: +g2iUs.toFixed(2),
          nativeI2gUs: up.i2gUs,
          nativeG2iUs: up.g2iUs,
          nativeLoadMs: up.loadMs,
        };
        // Sensor and ground partials at the image centre.
        if (up.sensorPartials.length && up.centre.every((v) => v !== null)) {
          const sp = csm.partials(h, up.centre[0], up.centre[1], up.centre[2], info.params.length);
          const ref = nanOf(up.sensorPartials);
          const scale = Math.max(1e-30, ...ref.map(Math.abs));
          r.partialsRel = worst(sp, ref).w / scale;
        }
        report[f] = r;
        // The failure patterns agree with native usgscsm.
        expect(r.ecefUp.mask).toBe(0);
        expect(r.pxUp.mask).toBe(0);
        expect(r.xyUp.mask).toBe(0);
        const a = up.info.a;
        expect(r.ecefUp.w).toBeLessThanOrEqual(Math.max(1e-6, 1e-12 * a));
        expect(r.hUp.w).toBeLessThanOrEqual(Math.max(1e-6, 1e-12 * a));
        expect(r.llhDegUp.w * (Math.PI / 180) * a).toBeLessThanOrEqual(Math.max(1e-6, 1e-12 * a));
        const pxBound = info.model === 'USGS_ASTRO_SAR_SENSOR_MODEL' ? 2e-3 : 1e-6;
        expect(r.pxUp.w).toBeLessThanOrEqual(pxBound);
        expect(r.pxGw.w).toBeLessThanOrEqual(pxBound);
        expect(r.xyUp.w).toBeLessThanOrEqual(pxBound);
        if (r.partialsRel !== undefined) expect(r.partialsRel).toBeLessThanOrEqual(info.model === 'USGS_ASTRO_SAR_SENSOR_MODEL' ? 1e-2 : 1e-6);
      } finally {
        csm.free(h);
      }
    });
  }

  it('states round-trip, parameter corrections and refusals by name', () => {
    const text = readFileSync(`${FX}/isd/orbitalLineScan.json`, 'utf8');
    const { handle: h } = csm.fromIsd(text, { id: 'orbitalLineScan' });
    const s = csm.state(h);
    const h2 = csm.fromState(s);
    const pts = [[8, 8, 0], [2.5, 13.25, 100]];
    expect(csm.i2g(h2, pts)).toEqual(csm.i2g(h, pts));
    // A record for the analysis worker carries the state exactly.
    const rec = stateRecord(s);
    const bytes = new Uint8Array(new Uint32Array(Float64Array.from(rec.subarray(1))).buffer).subarray(0, rec[0]);
    expect(new TextDecoder().decode(bytes)).toBe(s);
    // A parameter correction moves the image point as the partials say (first order).
    const g = csm.i2g(h, [[8, 8, 0]])[0];
    const n = csm.info(h).params.length;
    const p = csm.partials(h, g[0], g[1], g[2], n);
    const d = new Array(n).fill(0);
    d[0] = 0.5;
    const h3 = csm.withParams(h, d);
    const [x3, y3] = csm.g2i(h3, [g])[0];
    expect(Math.abs(x3 - (8 + 0.5 * p[0]))).toBeLessThan(1e-3);
    expect(Math.abs(y3 - (8 + 0.5 * p[1]))).toBeLessThan(1e-3);
    for (const k of [h, h2, h3]) csm.free(k);
    // Refusals: not JSON, an unknown model, a bad state, a freed handle.
    expect(() => csm.fromIsd('not json')).toThrow(/JSON/);
    expect(() => csm.fromIsd(JSON.stringify({ name_model: 'NO_SUCH_MODEL' }))).toThrow(/NO_SUCH_MODEL/);
    expect(() => csm.fromState('{"m_modelName": "USGS_ASTRO_FRAME_SENSOR_MODEL"}')).toThrow();
    expect(() => csm.info(h)).toThrow(/unknown CSM model handle/);
  });

  describe.skipIf(!existsSync(coreWasm))('through the Rust SensorModel trait (core host model and bridge)', () => {
    const core = existsSync(coreWasm) ? new Core(new WebAssembly.Module(readFileSync(coreWasm))) : null;

    it('without the bridge a host model is refused by name', () => {
      const saved = globalThis.__gwCsmBridge;
      delete globalThis.__gwCsmBridge;
      try {
        expect(() => core.hostModel(1)).toThrow(/usgscsm/);
      } finally {
        if (saved) globalThis.__gwCsmBridge = saved;
      }
    });

    it('the C ABI’s geodetic ↔ ECEF on a WGS 84 model matches the core’s (GeographicLib port)', () => {
      const { handle: h } = csm.fromIsd(readFileSync(`${FX}/isd/earthFramer.json`, 'utf8'), { id: 'earthFramer' });
      let wM = 0;
      let wDeg = 0;
      for (const lat of [-89.9, -60, -35.5, 0, 1e-9, 12.25, 45, 80, 89.99])
        for (const lon of [-179.5, -117, 0, 33.3, 180])
          for (const hh of [-400, 0, 1234.5, 600000]) {
            const a = csm.convert(h, 0, [lat, lon, hh]);
            const b = core.ecef(lat, lon, hh);
            wM = Math.max(wM, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
            const g = csm.convert(h, 1, b);
            const gc = core.geodetic(b[0], b[1], b[2]);
            wDeg = Math.max(wDeg, Math.abs(g[0] - gc[0]), Math.abs(((g[1] - gc[1] + 540) % 360) - 180), Math.abs(g[2] - gc[2]) / 111e3);
          }
      csm.free(h);
      report['geodetic-vs-core'] = { ecefM: wM, roundTripDeg: wDeg };
      expect(wM).toBeLessThan(1e-6);
      expect(wDeg).toBeLessThan(1e-11);
    });

    it('a CSM frame camera on WGS 84 agrees with GIS Workbench’s own frame model', () => {
      installCsmBridge(csm);
      const text = readFileSync(`${FX}/isd/earthFramer.json`, 'utf8');
      const isd = JSON.parse(text);
      const { handle: h } = csm.fromIsd(text, { id: 'earthFramer' });
      globalThis.__gwCsmBridge.adopt(h);
      const info = csm.info(h);
      // The CSM model's own parameters: sensor position (ECEF, m) and the sensor → body quaternion.
      const [X, Y, Z, qx, qy, qz, qw] = info.params.map((p) => p.value);
      const nq = Math.hypot(qx, qy, qz, qw);
      const [x, y, z, w] = [qx / nq, qy / nq, qz / nq, qw / nq];
      // usgscsm's calcRotationMatrix: columns are the sensor axes in the body frame.
      const M = [
        [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (w * y + x * z)],
        [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
        [2 * (x * z - w * y), 2 * (w * x + y * z), w * w - x * x - y * y + z * z],
      ];
      const col = (j) => [M[0][j], M[1][j], M[2][j]];
      // usgscsm: x_f = f·(c0·d)/(c2·d), y_f = f·(c1·d)/(c2·d); sample = cs + 100·x_f, line = cl + 100·y_f.
      // GIS Workbench: v = R(P − C); col = cx − f·v0/(v2·pixel), row = cy + f·v1/(v2·pixel). So R has
      // rows c0, −c1, −c2 (a proper rotation), pixel = 0.01 mm, (cx, cy) = the detector centre.
      const neg = (v) => v.map((a) => -a);
      const R = [col(0), neg(col(1)), neg(col(2))];
      const [clat, clon, chae] = csm.convert(h, 1, [X, Y, Z]);
      const f = isd.focal_length_model.focal_length;
      const prm = [3, f, 1 / isd.focal2pixel_samples[1], isd.detector_center.sample, isd.detector_center.line, 0, 0, 0, 0, 0, 0, 0, isd.image_samples, isd.image_lines, clat, clon, chae, ...R.flat(), 0];
      const app = core.frameModelEx(prm, 'Frame camera (EO import)');
      const host = core.hostModel(h);
      const mi = core.modelInfo(host);
      expect(mi.name).toBe('CSM frame camera (usgscsm)');
      expect(mi.params).toBe(7);
      let wG2i = 0;
      let wI2g = 0;
      let wHost = 0;
      for (let r = 0; r <= 6; r++)
        for (let c = 0; c <= 8; c++)
          for (const hae of [0, 1500]) {
            const px = 0.5 + (c * (isd.image_samples - 1)) / 8;
            const py = 0.5 + (r * (isd.image_lines - 1)) / 6;
            const g = core.i2g(host, px, py, hae); // CSM, through the core and the bridge
            const ga = core.i2g(app, px, py, hae); // GIS Workbench frame model
            wI2g = Math.max(wI2g, core.inverse(g.lat, g.lon, ga.lat, ga.lon).distance);
            const p = core.g2i(app, g.lat, g.lon, hae);
            wG2i = Math.max(wG2i, Math.hypot(p.x - px, p.y - py));
            const q = csm.g2i(h, [[g.lat, g.lon, hae]])[0];
            const ph = core.g2i(host, g.lat, g.lon, hae);
            wHost = Math.max(wHost, Math.hypot(ph.x - q[0], ph.y - q[1]));
          }
      report['earthFramer.json:gw-frame'] = { appVsCsmG2iPx: wG2i, appVsCsmI2gM: wI2g, coreHostVsDirectPx: wHost };
      expect(wHost).toBe(0); // the trait path returns usgscsm's own answer
      expect(wG2i).toBeLessThan(1e-4); // measured 9.5e-6 px (about 0.1 mm on the ground at 12 m pixels)
      expect(wI2g).toBeLessThan(1e-3); // measured 1.1e-4 m
      // CE90 from the CSM parameter covariance through J Σ Jᵀ (the measurement path).
      const e = core.pointError(host, 200, 150, 0, 0, 0);
      report['earthFramer.json:gw-frame'].ce90 = e.ce90;
      expect(e.modelErrorKnown).toBe(false); // the ISD states no covariance: "error not available"
      core.freeModel(host);
      core.freeModel(app);
    });
  });
});
