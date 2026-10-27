// FX-03 generator (Research/03 §1.1, SCN-04): one 2048 × 2048 image 20° off nadir over flat
// ground, ray-cast with four buildings and three poles and their sun shadows, RPC00B fitted to
// the camera, USE00A sun angles; truth bases, tops and shadow tips with heights. Dev-only.
// Usage: node build/fixtures/fx03.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { camera, fitRpc, ecef, geodetic, enuBasis, toEnu, fromEnu, dot, sub, valueNoise } from './synth.mjs';
import { writeNitf, use00a } from '../../app/src/formats/nitf-writer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(process.argv[2] ?? join(root, 'fixtures'), 'fx03');
const O = [34.53, -116.47, 600]; // ground plane: the ENU plane u = 0 at 600 m HAE
const W = 2048;
const H = 2048;
const GSD = 0.3;
const SUN = { azimuth: 135, elevation: 40 };
const SENSOR = { offNadir: 20, fromAz: 300 };

const boxes = [
  { id: 'B1', cx: -120, cy: 80, w: 30, d: 20, h: 8 },
  { id: 'B2', cx: 60, cy: 100, w: 40, d: 25, h: 15 },
  { id: 'B3', cx: -80, cy: -90, w: 25, d: 25, h: 24 },
  { id: 'B4', cx: 110, cy: -60, w: 20, d: 35, h: 40 },
];
const poles = [
  { id: 'P1', cx: 0, cy: 0, r: 0.5, h: 10 },
  { id: 'P2', cx: -30, cy: 160, r: 0.5, h: 20 },
  { id: 'P3', cx: 150, cy: 40, r: 0.5, h: 30 },
];

const cam = camera({ target: O, range: 600000, offNadir: SENSOR.offNadir, fromAz: SENSOR.fromAz, gsd: GSD, W, H, roll: -12 });
const B = enuBasis(O[0], O[1]);
const Oe = ecef(...O);
const toLocal = (v) => [dot(B[0], v), dot(B[1], v), dot(B[2], v)];
const C = toLocal(sub(cam.C, Oe));
const D2R = Math.PI / 180;
const sun = [Math.cos(SUN.elevation * D2R) * Math.sin(SUN.azimuth * D2R), Math.cos(SUN.elevation * D2R) * Math.cos(SUN.azimuth * D2R), Math.sin(SUN.elevation * D2R)];

/** Nearest hit of a ray (local ENU) with the scene: {t, n, kind}. */
function hit(o, d, skipGround = false) {
  let best = null;
  const take = (t, n, kind) => {
    if (t > 1e-6 && (!best || t < best.t)) best = { t, n, kind };
  };
  if (!skipGround && d[2] < 0) take(-o[2] / d[2], [0, 0, 1], 'ground');
  for (const b of boxes) {
    const lo = [b.cx - b.w / 2, b.cy - b.d / 2, 0];
    const hi = [b.cx + b.w / 2, b.cy + b.d / 2, b.h];
    let t0 = -Infinity;
    let t1 = Infinity;
    let axis = 0;
    let ok = true;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-15) {
        if (o[k] < lo[k] || o[k] > hi[k]) ok = false;
        continue;
      }
      let a = (lo[k] - o[k]) / d[k];
      let c = (hi[k] - o[k]) / d[k];
      if (a > c) [a, c] = [c, a];
      if (a > t0) {
        t0 = a;
        axis = k;
      }
      t1 = Math.min(t1, c);
    }
    if (ok && t0 <= t1 && t1 > 1e-6) {
      const n = [0, 0, 0];
      n[axis] = d[axis] > 0 ? -1 : 1;
      take(t0 > 1e-6 ? t0 : t1, n, axis === 2 ? 'roof' : 'wall');
    }
  }
  for (const p of poles) {
    const ox = o[0] - p.cx;
    const oy = o[1] - p.cy;
    const a = d[0] ** 2 + d[1] ** 2;
    const bq = 2 * (ox * d[0] + oy * d[1]);
    const c = ox * ox + oy * oy - p.r * p.r;
    const disc = bq * bq - 4 * a * c;
    if (a > 0 && disc >= 0) {
      const t = (-bq - Math.sqrt(disc)) / (2 * a);
      const z = o[2] + t * d[2];
      if (z >= 0 && z <= p.h) take(t, [(ox + t * d[0]) / p.r, (oy + t * d[1]) / p.r, 0], 'pole');
    }
  }
  return best;
}

const noise = valueNoise(31, 6);
const coarse = valueNoise(32, 60);
const img = new Uint8Array(W * H);
for (let r = 0; r < H; r++)
  for (let c = 0; c < W; c++) {
    const d = toLocal(cam.ray(c, r));
    const h = hit(C, d);
    let v = 0;
    if (h) {
      const P = [C[0] + h.t * d[0], C[1] + h.t * d[1], C[2] + h.t * d[2]];
      const lit = !hit([P[0] + h.n[0] * 1e-4, P[1] + h.n[1] * 1e-4, P[2] + h.n[2] * 1e-4], sun, true);
      const lam = Math.max(0, dot(h.n, sun));
      if (h.kind === 'ground') v = (110 + 40 * coarse(P[0], P[1]) + 20 * noise(P[0], P[1])) * (lit ? 1 : 0.42);
      else if (h.kind === 'roof') v = (lit ? 170 : 80) + 10 * noise(P[0], P[1]);
      else v = 60 + 150 * (lit ? lam : 0.1);
    }
    img[r * W + c] = Math.max(0, Math.min(255, Math.round(v)));
  }

// Truth: bases, tops and shadow tips (ENU → geodetic → image).
const pt = (e, n, u) => {
  const g = fromEnu(O, e, n, u);
  const [c, r] = cam.project(...g);
  return { lat: g[0], lon: g[1], hae: g[2], x: c + 0.5, y: r + 0.5 };
};
const anti = [-Math.sin(SUN.azimuth * D2R), -Math.cos(SUN.azimuth * D2R)];
const toSensor = [Math.sin(SENSOR.fromAz * D2R), Math.cos(SENSOR.fromAz * D2R)];
const L = (h) => h / Math.tan(SUN.elevation * D2R);
const objects = [
  ...poles.map((p) => ({ id: p.id, kind: 'pole', height: p.h, base: pt(p.cx, p.cy, 0), top: pt(p.cx, p.cy, p.h), shadowTip: pt(p.cx + anti[0] * L(p.h), p.cy + anti[1] * L(p.h), 0) })),
  ...boxes.map((b) => {
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([sx, sy]) => [b.cx + (sx * b.w) / 2, b.cy + (sy * b.d) / 2]);
    // Layover: the base corner facing the sensor and the roof corner above it.
    const near = corners.reduce((a, q) => (q[0] * toSensor[0] + q[1] * toSensor[1] > a[0] * toSensor[0] + a[1] * toSensor[1] ? q : a));
    // Shadow: the roof corner farthest down-sun casts the shadow tip.
    const far = corners.reduce((a, q) => (q[0] * anti[0] + q[1] * anti[1] > a[0] * anti[0] + a[1] * anti[1] ? q : a));
    return { id: b.id, kind: 'building', height: b.h, base: pt(near[0], near[1], 0), top: pt(near[0], near[1], b.h), shadowBase: pt(far[0], far[1], 0), shadowTip: pt(far[0] + anti[0] * L(b.h), far[1] + anti[1] * L(b.h), 0) };
  }),
];

const g0 = fromEnu(O, -400, -400, 0);
const g1 = fromEnu(O, 400, 400, 0);
const fit = fitRpc((lat, lon, h) => cam.project(lat, lon, h), { lat: [g0[0], g1[0]], lon: [g0[1], g1[1]], h: [590, 660], W, H, errBias: 2, errRand: 0.4 });
if (fit.maxResidualPx > 0.01) throw new Error(`RPC fit residual ${fit.maxResidualPx} px`);
const corners = [
  [0, 0],
  [W - 1, 0],
  [W - 1, H - 1],
  [0, H - 1],
].map(([c, r]) => {
  const d = toLocal(cam.ray(c, r));
  const t = -C[2] / d[2];
  const g = fromEnu(O, C[0] + t * d[0], C[1] + t * d[1], 0);
  return [g[0], g[1]];
});
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, 'fx03.ntf'),
  writeNitf({ width: W, height: H, bands: 1, type: 'u8', planes: [img] }, { marking: { level: 'U', system: 'US' }, title: 'FX-03 synthetic oblique image (UNCLASSIFIED test values)', iid1: 'FX03', iid2: 'FX03 SYNTHETIC OBLIQUE 20 DEG', idatim: '20260601154500', isorce: 'SYNTHETIC SAT', icat: 'VIS', irep: 'MONO', rpc: fit.rec, corners, tres: [['USE00A', use00a({ gsdM: GSD, obliquity: 90 - SENSOR.offNadir, sunEl: SUN.elevation, sunAz: SUN.azimuth })]] }),
);
writeFileSync(join(out, 'fx03_truth.json'), JSON.stringify({ fixture: 'FX-03', note: 'Flat ground: the ENU plane at the origin (600 m HAE). Image coordinates use the app convention (first pixel centre at 0.5, 0.5).', origin: { lat: O[0], lon: O[1], hae: O[2] }, size: [W, H], gsd: GSD, sun: { ...SUN, source: 'USE00A' }, sensor: SENSOR, rpcFitMaxResidualPx: fit.maxResidualPx, objects }, null, 1));
console.log(`FX-03: ${W}×${H}, RPC residual ${fit.maxResidualPx.toExponential(2)} px, ${objects.length} objects`);
