// 2.5 aero group (REQ-GAP-22): the JavaScript side of the aerial triangulation. The job record
// (analysis/aero.js) against the Rust decoder and solver (the photo bundle, built for wasm32 by
// cargo: run with the build's CARGO_TARGET_DIR), on a synthetic block whose measurements come from
// the core bundle's own frame models (an independent projection path); the film camera and
// fiducial reader on the text of USGS report OSL/3707; the resection and fiducial jobs.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Photo } from '../../app/src/wasm/photo.js';
import { Core } from '../../app/src/wasm/core.js';
import { aeroJob, resectJob, fiducialJob, cameraOfRecord, cameraKey, parseFilmReport, summarize } from '../../app/src/analysis/aero.js';
import { frameParams } from '../../app/src/sensor/camera.js';

const target = (() => {
  try {
    return join(JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory, 'wasm32-unknown-unknown', 'release');
  } catch {
    return null;
  }
})();
const photoWasm = target && join(target, 'gw_bundle_photo.wasm');
const coreWasm = target && join(target, 'gw_bundle_core.wasm');
const have = !!target && existsSync(photoWasm) && existsSync(coreWasm);

const REPORT = readFileSync(resolve('fixtures/fx25/aero/usgs-osl3707.txt'), 'utf8');

function lcg(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

describe('REQ-GAP-22 film camera and fiducials from a USGS calibration report', () => {
  it('reads OSL/3707: focal length, principal point of symmetry, distortion and the eight fiducials', () => {
    const c = parseFilmReport(REPORT);
    expect(c.fiducials.map((f) => f.id)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(c.fiducials[4]).toEqual({ id: '5', x: -111.994, y: 0.003 });
    expect(c.x0).toBe(-0.004);
    expect(c.y0).toBe(0.006);
    expect(c.p).toEqual([-0.2112e-7, -0.1301e-7]);
    // K0 scales the focal length; the refitted radial reproduces the report's polynomial
    // Δr = K0·r + K1·r³ + K2·r⁵ within 0.05 µm. The report's own table at the field angles is the
    // NEGATIVE of that polynomial (within its 1 µm rounding): one of the two is the correction, not
    // the distortion. The reader follows the polynomial (as the 2.4 USGS reader); the sign is
    // [unverified] (docs/validation/2.5/aero.md).
    expect(Math.abs(c.focalMm - 153.313 * (1 + 0.6598e-4)) < 2e-3).toBe(true);
    const K = [0.6598e-4, -0.148e-7, 0.662e-12];
    const table = [[7.5, -1], [15, -2], [22.7, -1], [30, 1], [35, 2], [40, 0]];
    for (const [deg, um] of table) {
      // The report's Δr is relative to the ideal radius at the calibrated focal length; the core
      // projects at the scaled focal length F and distorts there.
      const r = 153.313 * Math.tan((deg * Math.PI) / 180);
      const rp = (r * c.focalMm) / 153.313;
      const rd = rp * (1 + c.k[0] * rp ** 2 + c.k[1] * rp ** 4 + c.k[2] * rp ** 6);
      const d = rd - r;
      const poly = K[0] * r + K[1] * r ** 3 + K[2] * r ** 5;
      expect(Math.abs(d - poly) * 1000 < 0.05, `${deg}°: ${d * 1000} µm vs the polynomial ${poly * 1000}`).toBe(true);
      expect(Math.abs(-poly * 1000 - um) < 0.5, `${deg}°: the table's ${um} µm is −(polynomial ${poly * 1000})`).toBe(true);
    }
    expect(() => parseFilmReport('no focal length here')).toThrow(/calibrated focal length/);
  });

  it('builds the job record with the layout the solver decodes', () => {
    const rec = frameParams({ focalMm: 24, pixelMm: 0.004, cx: 3010, cy: 1995, k: [6e-5, 0, 0], p: [0, 0], aff: [0, 0], width: 6000, height: 4000 }, { lat: 41, lon: -83, hae: 400 }, { kind: 'opk', omega: 0, phi: 0, kappa: 90 });
    const cam = cameraOfRecord(rec);
    expect(cam.io[1]).toBeCloseTo(0.04, 12);
    expect(cam.io[2]).toBeCloseTo(0.02, 12);
    expect(cameraKey(cam)).toBe(cameraKey(cameraOfRecord(rec.slice())));
    const job = aeroJob({ cameras: [{ ...cam, free: [true] }], images: [{ camera: 0, record: rec, gnss: [1, 1, 2] }], points: [{ kind: 'gcp', known: { lat: 41, lon: -83, hae: 250 }, sigmaH: 0.1, sigmaV: 0.2 }], obs: [{ image: 0, point: 0, x: 3000, y: 2000, sigma: 0.5 }] });
    // Header 12 + camera 56 + image 19 + record + point 6 + measurement 5.
    expect(job.length).toBe(12 + 56 + 19 + rec.length + 6 + 5);
    expect([...job.slice(0, 6)]).toEqual([31, 1, 1, 1, 1, 1]);
    expect(() => aeroJob({ cameras: [], images: [], points: [], obs: [] })).toThrow();
  });
});

describe.skipIf(!have)('REQ-GAP-22 the photo bundle solves a synthetic block built by the core bundle', () => {
  const core = have ? new Core(new WebAssembly.Module(readFileSync(coreWasm))) : null;
  const photo = have ? new Photo(new WebAssembly.Module(readFileSync(photoWasm))) : null;
  const truthCam = { focalMm: 24, pixelMm: 0.004, cx: 3003, cy: 1998, k: [6.5e-5, -1.2e-7, 0], p: [1.5e-5, -1e-5], aff: [0, 0], width: 6000, height: 4000 };
  const nominal = { ...truthCam, focalMm: 24.1, cx: 3000, cy: 2000, k: [0, 0, 0], p: [0, 0] };
  const rnd = lcg(7);
  const lat0 = 41.03;
  const lon0 = -83.3;
  const mN = 1 / 111000;
  const mE = 1 / (111000 * Math.cos((lat0 * Math.PI) / 180));
  // Three strips of eight, 150 m above rolling ground, alternating headings.
  const truth = [];
  for (let s = 0; s < 3; s++)
    for (let k = 0; k < 8; k++) {
      const e = (k - 3.5) * 20;
      const n = (s - 1) * 55;
      truth.push({ lat: lat0 + n * mN, lon: lon0 + e * mE, hae: 400 + 2 * rnd(), opk: [2 * rnd(), 2 * rnd(), (s % 2 ? -90 : 90) + 3 * rnd()] });
    }
  const models = truth.map((t) => core.frameModelEx(frameParams(truthCam, t, { kind: 'opk', omega: t.opk[0], phi: t.opk[1], kappa: t.opk[2] }), 'truth'));
  const points = [];
  const obs = [];
  for (let e = -120; e <= 120; e += 9)
    for (let n = -90; n <= 90; n += 9) {
      const g = { lat: lat0 + (n + 3 * rnd()) * mN, lon: lon0 + (e + 3 * rnd()) * mE, hae: 250 + 25 * Math.sin(e / 90) * Math.cos(n / 70) };
      const mine = [];
      models.forEach((id, i) => {
        const p = core.g2i(id, g.lat, g.lon, g.hae);
        if (p && p.x > 5 && p.y > 5 && p.x < 5995 && p.y < 3995) mine.push({ image: i, x: p.x + 0.3 * rnd(), y: p.y + 0.3 * rnd(), sigma: 0.3 });
      });
      if (mine.length < 2) continue;
      const j = points.length;
      const kind = j % 37 === 0 ? 'gcp' : j % 23 === 0 ? 'check' : 'tie';
      points.push({ kind, known: kind === 'tie' ? null : g, sigmaH: 0.01, sigmaV: 0.01 });
      for (const m of mine) obs.push({ ...m, point: j });
    }
  // Approximations: the truth perturbed by 3 m and 1°, weighted as GNSS at 5 cm.
  const images = truth.map((t) => ({ camera: 0, gnss: [0.05, 0.05, 0.05], record: frameParams(nominal, { lat: t.lat + 0.05 * rnd() * mN, lon: t.lon + 0.05 * rnd() * mE, hae: t.hae + 0.05 * rnd() }, { kind: 'opk', omega: t.opk[0] + rnd(), phi: t.opk[1] + rnd(), kappa: t.opk[2] + rnd() }) }));
  const io = cameraOfRecord(images[0].record);

  it('recovers the calibration within 4σ, with the check points within their σ, stepping to the end', () => {
    const free = [true, true, true, true, true, false, false, true, true, false, false];
    const job = aeroJob({ cameras: [{ ...io, free }], images, points, obs, options: { maxIterations: 40 } });
    const setup = photo.aeroBegin(job);
    expect(setup.parameters).toBe(24 * 6 + 7);
    const steps = [];
    for (let k = 0; k < 60; k++) {
      const p = photo.aeroStep();
      steps.push(p);
      if (p.done) break;
    }
    expect(steps.at(-1).done).toBe(true);
    expect(steps.length).toBeLessThan(40);
    // The cost falls monotonically.
    for (let k = 1; k < steps.length; k++) expect(steps[k].cost <= steps[k - 1].cost * (1 + 1e-12)).toBe(true);
    const rep = photo.aeroReport();
    photo.aeroEnd();
    expect(rep.converged).toBe(true);
    expect(Math.abs(rep.sigma0 - 1)).toBeLessThan(0.1);
    const c = rep.cameras[0];
    const want = cameraOfRecord(frameParams(truthCam, truth[0], { kind: 'opk' })).io;
    for (const q of c.free) expect(Math.abs(c.io[q] - want[q]) / c.sigma[q], `parameter ${q}`).toBeLessThan(4);
    expect(rep.checkMulti.n).toBeGreaterThan(3);
    expect(rep.checkMulti.rmseR).toBeLessThan(0.03);
    // Every image's solved record re-projects through the core like the truth (< 0.5 px).
    let worst = 0;
    rep.images.forEach((im, i) => {
      const id = core.frameModelEx(im.record, 'solved');
      for (const o of obs.filter((m) => m.image === i).slice(0, 20)) {
        const p = rep.points[o.point];
        const a = core.g2i(id, p[0], p[1], p[2]);
        const b = core.g2i(models[i], p[0], p[1], p[2]);
        worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
      }
    });
    expect(worst).toBeLessThan(0.5);
    const s = summarize(rep);
    expect(s.measurements).toBe(obs.length);
    expect(s.gnssRms.every((v) => v < 0.1)).toBe(true);
  });

  it('refuses a block without a datum, by name', () => {
    const job = aeroJob({ cameras: [io], images: images.map((im) => ({ ...im, gnss: null })), points: points.map((p) => ({ ...p, kind: 'tie', known: null })), obs });
    expect(() => photo.aeroBegin(job)).toThrow(/no datum/);
    expect(() => photo.aeroStep()).toThrow(/no solve/);
  });

  it('resects one image from its GCPs and checkpoints and fits fiducials', () => {
    const i = 9;
    const pts = [];
    points.forEach((p, j) => {
      if (!p.known) return;
      const o = obs.find((m) => m.point === j && m.image === i);
      if (o) pts.push({ lat: p.known.lat, lon: p.known.lon, hae: p.known.hae, x: o.x, y: o.y, sigma: 0.3 });
    });
    // Too few control points in one image: add tie points at their true ground position.
    for (const o of obs.filter((m) => m.image === i)) {
      if (pts.length >= 30) break;
      const g = core.i2g(models[i], o.x, o.y, 250);
      if (g) pts.push({ lat: g.lat, lon: g.lon, hae: 250, x: o.x, y: o.y, sigma: 0.3 });
    }
    const tc = cameraOfRecord(frameParams(truthCam, truth[i], { kind: 'opk' }));
    const r = photo.resect(resectJob(tc, { points: pts }));
    expect(['DLT', 'homography']).toContain(r.method);
    const d = Math.hypot((r.lat - truth[i].lat) / mN, (r.lon - truth[i].lon) / mE);
    expect(d).toBeLessThan(0.3);
    expect(Math.abs(r.h - truth[i].hae)).toBeLessThan(0.3);
    // ω, φ, κ relative to ENU at the centre, as the frame model's own (gw_sensor::frame::rotation).
    r.opk.forEach((v, k) => expect(Math.abs(v - truth[i].opk[k]), `opk ${k}: ${v} vs ${truth[i].opk[k]}`).toBeLessThan(0.05));
    expect(() => photo.resect(resectJob(tc, { points: pts.slice(0, 3) }))).toThrow(/at least 4/);
    // Fiducials of OSL/3707 scanned at 20 µm, rotated 0.5°.
    const fid = parseFilmReport(REPORT).fiducials;
    const a = (0.5 * Math.PI) / 180;
    const marks = fid.map((f) => ({ x: f.x, y: f.y, col: 5750 + (Math.cos(a) * f.x - Math.sin(a) * f.y) / 0.02, row: 5750 - (Math.sin(a) * f.x + Math.cos(a) * f.y) / 0.02 }));
    const io2 = photo.fiducialIo(fiducialJob('affine', marks));
    expect(io2.rmsUm).toBeLessThan(1e-6);
    expect(io2.pixelUm[0]).toBeCloseTo(20, 6);
    expect(io2.rotationDeg).toBeCloseTo(0.5, 6);
    expect(() => photo.fiducialIo(fiducialJob('affine', marks.slice(0, 2)))).toThrow(/at least 3/);
  });
});
