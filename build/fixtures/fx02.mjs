// FX-02 generator (Research/03 §1.1, Research/07 §3, SCN-05/08/10): a synthetic in-track stereo
// pair, two 2048 × 2048 NITF 2.1 images at 0.5 m GSD with RPC00B, B/H ≈ 0.6, over gently rolling
// ground with eight boxes of 5, 10, 20 and 40 m, sun shadows and USE00A sun angles. Truth: the
// pair metrics (from the sensors' azimuth and elevation, Research/07 closed forms), box
// footprints and heights, 20 ground checkpoints in both images, a 1 m DSM and an occlusion mask
// (posts hidden from either sensor). Dev-only. Usage: node build/fixtures/fx02.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';
import { camera, fitRpc, ecef, enuBasis, fromEnu, dot, sub, norm, cross, valueNoise, rng } from './synth.mjs';
import { writeNitf, use00a } from '../../app/src/formats/nitf-writer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(process.argv[2] ?? join(root, 'fixtures'), 'fx02');
const O = [34.56, -116.44, 700]; // local ENU origin; the ground is u = ground(e, n) metres
const W = Number(process.env.FX02_SIZE ?? 2048); // FX02_SIZE=4096 makes the PRF-06 pair
const H = W;
const GSD = 0.5;
const SUN = { azimuth: 140, elevation: 50 };
const D2R = Math.PI / 180;
// In-track pair: forward and backward looks, slightly asymmetric.
const SENSORS = [
  { id: 'A', offNadir: 17.5, fromAz: 8, roll: 2, idatim: '20260410101500' },
  { id: 'B', offNadir: 15.8, fromAz: 186, roll: -1.5, idatim: '20260410101545' },
];

/** Ground height above the ENU plane (m): gentle rolls and a tilt. */
const ground = (e, n) => 2.5 * Math.sin(e / 160) * Math.cos(n / 190) + 0.003 * e - 0.002 * n;

const boxes = [
  { id: 'B05a', cx: -260, cy: 210, w: 24, d: 16, h: 5, rot: 0 },
  { id: 'B05b', cx: 180, cy: -250, w: 18, d: 18, h: 5, rot: 30 },
  { id: 'B10a', cx: -90, cy: 300, w: 30, d: 20, h: 10, rot: 0 },
  { id: 'B10b', cx: 260, cy: 120, w: 22, d: 34, h: 10, rot: -20 },
  { id: 'B20a', cx: -280, cy: -160, w: 36, d: 26, h: 20, rot: 0 },
  { id: 'B20b', cx: 60, cy: 20, w: 28, d: 28, h: 20, rot: 45 },
  { id: 'B40a', cx: 130, cy: 300, w: 30, d: 24, h: 40, rot: 0 },
  { id: 'B40b', cx: -100, cy: -320, w: 26, d: 40, h: 40, rot: 15 },
].map((b) => ({ ...b, base: ground(b.cx, b.cy), c: Math.cos(b.rot * D2R), s: Math.sin(b.rot * D2R) }));

const B = enuBasis(O[0], O[1]);
const Oe = ecef(...O);
const toLocal = (v) => [dot(B[0], v), dot(B[1], v), dot(B[2], v)];
const sun = [Math.cos(SUN.elevation * D2R) * Math.sin(SUN.azimuth * D2R), Math.cos(SUN.elevation * D2R) * Math.cos(SUN.azimuth * D2R), Math.sin(SUN.elevation * D2R)];

/** Ray against one box (local ENU): {t, n, kind} or null. The box runs from 5 m below its base. */
function hitBox(b, o, d) {
  // Into the box frame: rotate about its centre by −rot.
  const ox = o[0] - b.cx;
  const oy = o[1] - b.cy;
  const lo = [b.c * ox + b.s * oy, -b.s * ox + b.c * oy, o[2]];
  const ld = [b.c * d[0] + b.s * d[1], -b.s * d[0] + b.c * d[1], d[2]];
  const mn = [-b.w / 2, -b.d / 2, b.base - 5];
  const mx = [b.w / 2, b.d / 2, b.base + b.h];
  let t0 = -Infinity;
  let t1 = Infinity;
  let axis = 0;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(ld[k]) < 1e-15) {
      if (lo[k] < mn[k] || lo[k] > mx[k]) return null;
      continue;
    }
    let a = (mn[k] - lo[k]) / ld[k];
    let c = (mx[k] - lo[k]) / ld[k];
    if (a > c) [a, c] = [c, a];
    if (a > t0) {
      t0 = a;
      axis = k;
    }
    t1 = Math.min(t1, c);
  }
  if (t0 > t1 || t1 <= 1e-6) return null;
  const nl = [0, 0, 0];
  nl[axis] = ld[axis] > 0 ? -1 : 1;
  const n = [b.c * nl[0] - b.s * nl[1], b.s * nl[0] + b.c * nl[1], nl[2]];
  return { t: t0 > 1e-6 ? t0 : t1, n, kind: axis === 2 ? 'roof' : 'wall', box: b };
}

function hitGround(o, d) {
  if (d[2] >= 0) return null;
  let t = (0 - o[2]) / d[2];
  for (let i = 0; i < 8; i++) {
    const f = o[2] + t * d[2] - ground(o[0] + t * d[0], o[1] + t * d[1]);
    t -= f / d[2];
  }
  if (t <= 1e-6) return null;
  const p = [o[0] + t * d[0], o[1] + t * d[1]];
  const e = 0.01;
  const gx = (ground(p[0] + e, p[1]) - ground(p[0] - e, p[1])) / (2 * e);
  const gy = (ground(p[0], p[1] + e) - ground(p[0], p[1] - e)) / (2 * e);
  return { t, n: norm([-gx, -gy, 1]), kind: 'ground' };
}

function hit(o, d, skipGround = false) {
  let best = skipGround ? null : hitGround(o, d);
  for (const b of boxes) {
    const h = hitBox(b, o, d);
    if (h && (!best || h.t < best.t)) best = h;
  }
  return best;
}

// Texture pinned to the ground and the roofs: fields, fine grain, roads.
const coarse = valueNoise(201, 70);
const mid = valueNoise(202, 9);
const fine = valueNoise(203, 2.2);
const roofTex = valueNoise(204, 1.6);
function shade(P, h, lit) {
  if (h.kind === 'ground') {
    let v = 85 + 55 * coarse(P[0], P[1]) + 30 * mid(P[0], P[1]) + 22 * fine(P[0], P[1]);
    const ry = Math.abs(P[1] - 60 - 0.25 * P[0]);
    if (ry < 3.5 || Math.abs(P[0] + 180) < 3.5) v = 52 + 10 * fine(P[0], P[1]); // two roads
    return v * (lit ? 1 : 0.45);
  }
  const lam = Math.max(0, dot(h.n, sun));
  if (h.kind === 'roof') return (lit ? 150 + 60 * lam : 70) + 28 * roofTex(P[0] * 1.3, P[1]);
  return 50 + 140 * (lit ? lam : 0.08) + 12 * fine(P[2] * 3, P[0] + P[1]);
}

mkdirSync(out, { recursive: true });
const truth = { fixture: 'FX-02', note: 'Local ENU origin at the given lat/lon/HAE; heights are HAE (WGS 84). Image coordinates use the app convention (first pixel centre at 0.5, 0.5).', origin: { lat: O[0], lon: O[1], hae: O[2] }, size: [W, H], gsd: GSD, sun: { ...SUN, source: 'USE00A' }, images: [] };
const cams = [];
const g0 = fromEnu(O, -620, -620, 0);
const g1 = fromEnu(O, 620, 620, 0);
for (const S of SENSORS) {
  const cam = camera({ target: O, range: 600000, offNadir: S.offNadir, fromAz: S.fromAz, gsd: GSD, W, H, roll: S.roll });
  cams.push(cam);
  const C = toLocal(sub(cam.C, Oe));
  const img = new Uint8Array(W * H);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      // 2 × 2 supersampling against aliasing of the fine texture.
      let acc = 0;
      for (const [dx, dy] of [
        [-0.25, -0.25],
        [0.25, -0.25],
        [-0.25, 0.25],
        [0.25, 0.25],
      ]) {
        const d = toLocal(cam.ray(c + dx, r + dy));
        const h = hit(C, d);
        if (!h) continue;
        const P = [C[0] + h.t * d[0], C[1] + h.t * d[1], C[2] + h.t * d[2]];
        const lit = !hit([P[0] + h.n[0] * 1e-3, P[1] + h.n[1] * 1e-3, P[2] + h.n[2] * 1e-3], sun, true);
        acc += shade(P, h, lit);
      }
      img[r * W + c] = Math.max(0, Math.min(255, Math.round(acc / 4)));
    }
  const fit = fitRpc((lat, lon, h) => cam.project(lat, lon, h), { lat: [g0[0], g1[0]], lon: [g0[1], g1[1]], h: [680, 760], W, H, errBias: 2, errRand: 0.3 });
  if (fit.maxResidualPx > 0.01) throw new Error(`RPC fit residual ${fit.maxResidualPx} px`);
  const corners = [
    [0, 0],
    [W - 1, 0],
    [W - 1, H - 1],
    [0, H - 1],
  ].map(([c, r]) => {
    const d = toLocal(cam.ray(c, r));
    const h = hitGround(C, d);
    const g = fromEnu(O, C[0] + h.t * d[0], C[1] + h.t * d[1], C[2] + h.t * d[2]);
    return [g[0], g[1]];
  });
  writeFileSync(
    join(out, `fx02_${S.id.toLowerCase()}.ntf`),
    writeNitf({ width: W, height: H, bands: 1, type: 'u8', planes: [img] }, { marking: { level: 'U', system: 'US' }, title: `FX-02 synthetic stereo image ${S.id} (UNCLASSIFIED test values)`, iid1: `FX02${S.id}`, iid2: `FX02 SYNTHETIC STEREO ${S.id}`, idatim: S.idatim, isorce: 'SYNTHETIC SAT', icat: 'VIS', irep: 'MONO', rpc: fit.rec, corners, tres: [['USE00A', use00a({ gsdM: GSD, obliquity: 90 - S.offNadir, sunEl: SUN.elevation, sunAz: SUN.azimuth })]] }),
  );
  truth.images.push({ id: S.id, file: `fx02_${S.id.toLowerCase()}.ntf`, offNadirDeg: S.offNadir, sensorAzimuthDeg: S.fromAz, sensorElevationDeg: 90 - S.offNadir, rollDeg: S.roll, idatim: S.idatim, rpcFitMaxResidualPx: fit.maxResidualPx, sensorEcef: cam.C });
  console.log(`FX-02 ${S.id}: rendered, RPC residual ${fit.maxResidualPx.toExponential(2)} px`);
}

// ---- Pair metrics from azimuth and elevation (Research/07 §3.1 closed forms) ----
const [s1, s2] = SENSORS.map((s) => ({ E: (90 - s.offNadir) * D2R, A: s.fromAz * D2R }));
const cosC = Math.sin(s1.E) * Math.sin(s2.E) + Math.cos(s1.E) * Math.cos(s2.E) * Math.cos(s1.A - s2.A);
const conv = Math.acos(cosC);
const bie = Math.asin((Math.sin(s1.E) + Math.sin(s2.E)) / Math.sqrt(2 + 2 * cosC));
// Vector forms in the target's ENU frame (asymmetry ISD-style and roll need them).
const u = [s1, s2].map((s) => [Math.cos(s.E) * Math.sin(s.A), Math.cos(s.E) * Math.cos(s.A), Math.sin(s.E)]);
const bis = norm([u[0][0] + u[1][0], u[0][1] + u[1][1], u[0][2] + u[1][2]]);
const pn = norm(cross(u[0], u[1]));
const up = [0, 0, 1];
const vproj = norm(sub(up, pn.map((x) => x * dot(up, pn))));
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b)))));
const asymIsd = ang(bis, vproj);
const roll = Math.asin(Math.abs(dot(up, pn)));
const CA = toLocal(sub(cams[0].C, Oe));
const CB = toLocal(sub(cams[1].C, Oe));
const base = sub(CB, CA);
const asymJk = Math.abs(ang(base, sub([0, 0, 0], CA)) - ang(sub([0, 0, 0], base), sub([0, 0, 0], CB))) / 2;
const bh = Math.hypot(...base) / ((CA[2] + CB[2]) / 2);
truth.pair = { convergenceDeg: conv / D2R, bieDeg: bie / D2R, asymmetryIsdDeg: asymIsd / D2R, asymmetryJkDeg: asymJk / D2R, rollDeg: roll / D2R, bOverH: bh, twoTanHalfC: 2 * Math.tan(conv / 2), deltaTimeS: 45, sunDifferenceDeg: 0, method: 'convergence and BIE from sensor azimuth/elevation; asymmetry and roll from ENU vectors' };

// ---- Boxes, checkpoints, DSM and occlusion truth ----
const pt = (e, n, h) => {
  const g = fromEnu(O, e, n, h);
  const xy = cams.map((cam) => cam.project(...g).map((v) => v + 0.5));
  return { lat: g[0], lon: g[1], hae: g[2], a: xy[0], b: xy[1] };
};
truth.boxes = boxes.map((b) => {
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const lx = (sx * b.w) / 2;
    const ly = (sy * b.d) / 2;
    return [b.cx + b.c * lx - b.s * ly, b.cy + b.s * lx + b.c * ly];
  });
  return { id: b.id, height: b.h, rotationDeg: b.rot, sizeM: [b.w, b.d], centreEnu: [b.cx, b.cy], baseHae: pt(b.cx, b.cy, b.base).hae, topHae: pt(b.cx, b.cy, b.base + b.h).hae, roofCentre: pt(b.cx, b.cy, b.base + b.h), footprint: corners.map(([e, n]) => pt(e, n, b.base)) };
});
const inBox = (e, n) => boxes.find((b) => {
  const lx = b.c * (e - b.cx) + b.s * (n - b.cy);
  const ly = -b.s * (e - b.cx) + b.c * (n - b.cy);
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.d / 2;
});
const surface = (e, n) => {
  const b = inBox(e, n);
  return b ? b.base + b.h : ground(e, n);
};
const visible = (P, cam) => {
  const d = toLocal(norm(sub(cam.C, ecef(...fromEnu(O, ...P)))));
  return !hit([P[0] + d[0] * 0.05, P[1] + d[1] * 0.05, P[2] + 0.02], d, true);
};
const R = rng(0xf02);
truth.checkpoints = [];
while (truth.checkpoints.length < 20) {
  const e = -450 + 900 * R.next();
  const n = -450 + 900 * R.next();
  if (boxes.some((b) => Math.hypot(e - b.cx, n - b.cy) < 45)) continue;
  const P = [e, n, ground(e, n)];
  if (!cams.every((cam) => visible(P, cam))) continue;
  truth.checkpoints.push({ id: `CP${String(truth.checkpoints.length + 1).padStart(2, '0')}`, ...pt(...P) });
}
// DSM truth: 1 m posts over ±500 m ENU, as a lat/lon GeoTIFF (HAE).
const POST = 1;
const N = 1001;
const ll0 = fromEnu(O, -500, 500, 0);
const ll1 = fromEnu(O, 500, -500, 0);
const dLat = (ll0[0] - ll1[0]) / (N - 1);
const dLon = (ll1[1] - ll0[1]) / (N - 1);
const dsm = new Float32Array(N * N);
const occ = new Uint8Array(N * N);
const geoToEnu = (lat, lon) => {
  const v = sub(ecef(lat, lon, O[2]), Oe);
  return [dot(B[0], v), dot(B[1], v)];
};
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    const lat = ll0[0] - j * dLat;
    const lon = ll0[1] + i * dLon;
    const [e, n] = geoToEnu(lat, lon);
    const z = surface(e, n);
    dsm[j * N + i] = fromEnu(O, e, n, z)[2];
    occ[j * N + i] = cams.every((cam) => visible([e, n, z], cam)) ? 0 : 1;
  }
const geo = { ModelPixelScale: [dLon, dLat, 0], ModelTiepoint: [0, 0, 0, ll0[1] - dLon / 2, ll0[0] + dLat / 2, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeogAngularUnitsGeoKey: 9102 };
writeFileSync(join(out, 'fx02_dsm_truth.tif'), Buffer.from(await writeArrayBuffer(dsm, { width: N, height: N, BitsPerSample: [32], SampleFormat: [3], ...geo, ImageDescription: 'FX-02 truth DSM (ground + box tops), HAE metres, 1 m posts' })));
writeFileSync(join(out, 'fx02_occlusion_truth.tif'), Buffer.from(await writeArrayBuffer(occ, { width: N, height: N, BitsPerSample: [8], SampleFormat: [1], ...geo, ImageDescription: 'FX-02 occlusion truth: 1 = post hidden from image A or B' })));
truth.dsm = { file: 'fx02_dsm_truth.tif', occlusion: 'fx02_occlusion_truth.tif', posts: [N, N], postM: POST, vertical: 'HAE', occludedFraction: occ.reduce((s, v) => s + v, 0) / occ.length };
truth.flatAreas = [{ centreEnu: [350, -380], radiusM: 60 }, { centreEnu: [-380, 30], radiusM: 50 }].map((a) => ({ ...a, centre: pt(a.centreEnu[0], a.centreEnu[1], ground(...a.centreEnu)) }));
writeFileSync(join(out, 'fx02_truth.json'), JSON.stringify(truth, null, 1));
console.log(`FX-02: C ${truth.pair.convergenceDeg.toFixed(2)}°, BIE ${truth.pair.bieDeg.toFixed(2)}°, B/H ${bh.toFixed(3)}, occluded ${(truth.dsm.occludedFraction * 100).toFixed(1)} %`);
