#!/usr/bin/env node
// Writes block.json: one synthetic block that both bundle adjusters solve, the sidecar's
// (sidecar/gwb-sfm/src/ba.rs) and the app's (crates/gw-aero/src/aero.rs). Both minimise the same
// weighted least-squares cost, so they must reach the same optimum; expected.json holds it, and
// each adjuster's ba_cross_check test fails when its solution leaves it.
//
//   node tests/fixtures/ba-cross-check/make.mjs
//
// Deterministic: a fixed-seed PRNG (mulberry32, seed SEED) and Box-Muller normals, and values
// rounded where they are data (0.1 mm, 1e-4 px), so rerunning it rewrites the same file. If the
// script changes, expected.json must be regenerated (see the gw-aero test) and the other side
// shown to agree before it is committed.
//
// The block is in ba.rs's native terms: a local metric frame (x east, y north, z up, metres),
// world-to-camera poses p = R (X - C) in COLMAP's camera frame (x right, y down, z forward), and
// one SIMPLE_RADIAL lens [f, cx, cy, k1] in pixels with corner-origin pixel coordinates.
// `geodetic_origin` places that frame (as ENU) on the ellipsoid for gw-aero, which works in
// geodetic coordinates.
//
// What it exercises: 4 x 3 cameras 60 m up with up to about 2 degrees of tilt and 3 of heading;
// 40 tie points on 12 m of relief and 5 ground control points (with 4 m the focal length and the
// flying height trade along a valley so flat that ba.rs's stopping rule leaves 0.02 px of focal
// and 0.5 mm of height unresolved, which the tolerances would have to allow); the focal length
// free under a 3 % prior about its start (as ba.rs is used), k1 free, the principal point held
// (it is the format centre, so gw-aero's x0 = y0 = 0); observations with
// Gaussian noise at their stated sigma (tie 0.5 px, control marks 1 px); control surveys with
// noise at their sigma (0.02 m). Starting poses, points and lens are all off the truth.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SEED = 20020;
const W = 4000;
const H = 3000;
const TRUE_LENS = [3000, 2000, 1500, -0.06];
const START_LENS = [3045, 2000, 1500, -0.03];
const FOCAL_PRIOR = 0.03; // of the start
const TIE_SIGMA = 0.5; // px
const MARK_SIGMA = 1.0; // px
const GCP_SIGMA = 0.02; // m
const MARGIN = 20; // px kept clear of the image edge
const RELIEF = 12; // m of ground height range

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uniform = mulberry32(SEED);
const normal = () => {
  const u = 1 - uniform();
  const v = uniform();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

const matMul = (a, b) => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const matVec = (m, v) => m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
/** Rotation by the rotation vector w (radians). */
function rodrigues(w) {
  const t = Math.hypot(...w);
  if (t < 1e-300) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const [x, y, z] = w.map((v) => v / t);
  const k = [[0, -z, y], [z, 0, -x], [-y, x, 0]];
  const k2 = matMul(k, k);
  const s = Math.sin(t);
  const c = 1 - Math.cos(t);
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) + s * k[i][j] + c * k2[i][j]));
}
/** COLMAP SIMPLE_RADIAL pixel of world point x, or null behind the camera. */
function pixel(lens, cam, x) {
  const p = matVec(cam.r, [x[0] - cam.c[0], x[1] - cam.c[1], x[2] - cam.c[2]]);
  if (p[2] <= 1e-9) return null;
  const [f, cx, cy, k1] = lens;
  const u = p[0] / p[2];
  const v = p[1] / p[2];
  const d = 1 + k1 * (u * u + v * v);
  return [f * u * d + cx, f * v * d + cy];
}
const inside = (px) => px && px[0] > MARGIN && px[0] < W - MARGIN && px[1] > MARGIN && px[1] < H - MARGIN;

// Nadir: camera x east, camera y south (image down), camera z down.
const NADIR = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
const deg = Math.PI / 180;
const truthCams = [];
const startCams = [];
for (let i = 0; i < 4; i += 1) {
  for (let j = 0; j < 3; j += 1) {
    const w = [1.2 * deg * normal(), 1.2 * deg * normal(), 2 * deg * normal()];
    const r = matMul(rodrigues(w), NADIR);
    const c = [i * 18 - 27 + 0.5 * normal(), j * 18 - 18 + 0.5 * normal(), 60 + 0.8 * normal()];
    truthCams.push({ r, c });
    const dw = [0, 1, 2].map(() => 0.3 * deg * normal());
    startCams.push({ r: matMul(rodrigues(dw), r), c: c.map((v) => round(v + 0.3 * normal(), 4)) });
  }
}

const truthPts = [];
const gcpIndex = [];
// Ties: drawn until 40 are seen by two or more cameras.
while (truthPts.length < 40) {
  const x = [70 * (uniform() - 0.5), 50 * (uniform() - 0.5), RELIEF * uniform()];
  if (truthCams.filter((c) => inside(pixel(TRUE_LENS, c, x))).length >= 2) truthPts.push(x);
}
// Control: near the corners and the centre of the block, on the ground.
for (const [e, n] of [[-28, -20], [28, -20], [-28, 20], [28, 20], [2, 1]]) {
  gcpIndex.push(truthPts.length);
  truthPts.push([e + normal(), n + normal(), RELIEF * uniform()]);
}

const obs = [];
truthPts.forEach((x, pt) => {
  const sigma = gcpIndex.includes(pt) ? MARK_SIGMA : TIE_SIGMA;
  truthCams.forEach((c, cam) => {
    const px = pixel(TRUE_LENS, c, x);
    if (inside(px)) obs.push({ cam, pt, xy: [round(px[0] + sigma * normal(), 4), round(px[1] + sigma * normal(), 4)], sigma });
  });
});
for (let pt = 0; pt < truthPts.length; pt += 1) {
  if (obs.filter((o) => o.pt === pt).length < 2) throw new Error(`point ${pt} is seen fewer than twice`);
}
const gcps = gcpIndex.map((pt) => ({ pt, at: truthPts[pt].map((v) => round(v + GCP_SIGMA * normal(), 4)), sigma: GCP_SIGMA }));
const startPts = truthPts.map((x) => x.map((v) => round(v + 0.3 * normal(), 4)));

const block = {
  about: 'Synthetic block solved by both bundle adjusters (ba.rs and gw-aero); written by make.mjs, do not edit.',
  frame: 'local metric frame, x east, y north, z up (m); pose p = r (x - c), camera x right, y down, z forward (COLMAP)',
  geodetic_origin: { lat: 41.03, lon: -83.3, h: 250.0 },
  lens: {
    model: 'SIMPLE_RADIAL',
    width: W,
    height: H,
    start: START_LENS,
    focal_sigma: FOCAL_PRIOR * START_LENS[0],
  },
  cameras: startCams,
  points: startPts,
  observations: obs,
  gcps,
  truth: { lens: TRUE_LENS, centres: truthCams.map((c) => c.c), points: truthPts },
};
const here = dirname(fileURLToPath(import.meta.url));
// One array element per line: readable, and a diff names the camera, point or observation.
const lines = Object.entries(block).map(([key, value]) => {
  if (!Array.isArray(value) && (typeof value !== 'object' || key === 'lens' || key === 'geodetic_origin')) return ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const items = Array.isArray(value) ? value.map((v) => `  ${JSON.stringify(v)}`) : Object.entries(value).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return ` ${JSON.stringify(key)}: ${open}\n${items.join(',\n')}\n ${close}`;
});
writeFileSync(join(here, 'block.json'), `{\n${lines.join(',\n')}\n}\n`);
console.log(`block.json: ${startCams.length} cameras, ${truthPts.length} points (${gcps.length} control), ${obs.length} observations`);
