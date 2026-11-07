// Synthetic imaging for fixtures (Research/03 §1.1, Appendix E): WGS 84 geodesy, a pinhole
// satellite camera, an analytic terrain, image → ground ray casting and an RPC00B fit with
// RPC00B field rounding. Written independently of the app's Rust core so fixture truth checks
// the product, not itself. Dev-only; never shipped.

export const A = 6378137;
export const F = 1 / 298.257223563;
export const E2 = F * (2 - F);
const D2R = Math.PI / 180;

export function ecef(lat, lon, h) {
  const p = lat * D2R;
  const l = lon * D2R;
  const N = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [(N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - E2) + h) * Math.sin(p)];
}

export function geodetic(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - (E2 * N) / (N + h)));
  }
  return [lat / D2R, lon / D2R, h];
}

/** ENU basis (rows e, n, u) at a point. */
export function enuBasis(lat, lon) {
  const p = lat * D2R;
  const l = lon * D2R;
  return [
    [-Math.sin(l), Math.cos(l), 0],
    [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)],
    [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)],
  ];
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const norm = (a) => mul(a, 1 / Math.hypot(...a));
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function toEnu(origin, lat, lon, h) {
  const [lat0, lon0, h0] = origin;
  const B = enuBasis(lat0, lon0);
  const d = sub(ecef(lat, lon, h), ecef(lat0, lon0, h0));
  return [dot(B[0], d), dot(B[1], d), dot(B[2], d)];
}

export function fromEnu(origin, e, n, u) {
  const [lat0, lon0, h0] = origin;
  const B = enuBasis(lat0, lon0);
  const o = ecef(lat0, lon0, h0);
  return geodetic(o[0] + B[0][0] * e + B[1][0] * n + B[2][0] * u, o[1] + B[0][1] * e + B[1][1] * n + B[2][1] * u, o[2] + B[0][2] * e + B[1][2] * n + B[2][2] * u);
}

/**
 * Pinhole camera looking at `target` (lat, lon, h) from `range` metres at off-nadir angle
 * `offNadir` (deg) towards azimuth `fromAz` (deg, the sensor's direction from the target), with
 * GSD `gsd` m at the target and image size W × H. Image rows run roughly with -north rotated by
 * `roll` (deg). Coordinates are pixel centres from 0 (RPC convention).
 */
export function camera({ target, range, offNadir, fromAz, gsd, W, H, roll = 0 }) {
  const B = enuBasis(target[0], target[1]);
  const up = B[2];
  const az = fromAz * D2R;
  const el = (90 - offNadir) * D2R;
  const dirToSensor = norm(add(add(mul(B[0], Math.cos(el) * Math.sin(az)), mul(B[1], Math.cos(el) * Math.cos(az))), mul(up, Math.sin(el))));
  const T = ecef(...target);
  const C = add(T, mul(dirToSensor, range));
  const fwd = mul(dirToSensor, -1); // boresight
  // Image axes: columns along the projection of east, rows along the projection of south, then rolled.
  let xAxis = norm(sub(B[0], mul(fwd, dot(B[0], fwd))));
  let yAxis = cross(fwd, xAxis);
  const r = roll * D2R;
  [xAxis, yAxis] = [add(mul(xAxis, Math.cos(r)), mul(yAxis, Math.sin(r))), add(mul(yAxis, Math.cos(r)), mul(xAxis, -Math.sin(r)))];
  const f = range / gsd;
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  return {
    C,
    f,
    W,
    H,
    xAxis,
    yAxis,
    fwd,
    /** Ground (lat, lon, h) → [col, row]. */
    project(lat, lon, h) {
      const d = sub(ecef(lat, lon, h), C);
      const z = dot(d, fwd);
      return [cx + (f * dot(d, xAxis)) / z, cy + (f * dot(d, yAxis)) / z];
    },
    /** Unit ray (ECEF) through pixel centre (col, row). */
    ray(col, row) {
      return norm(add(add(fwd, mul(xAxis, (col - cx) / f)), mul(yAxis, (row - cy) / f)));
    },
  };
}

/** Intersect a camera ray with the ellipsoid raised by h (metres). */
export function rayAtHeight(C, d, h) {
  // Solve |P| on the scaled sphere: (x² + y²)/(a+h)² + z²/(b+h)² = 1 (good to mm for h ≪ a).
  const a = A + h;
  const b = A * (1 - F) + h;
  const qa = (d[0] ** 2 + d[1] ** 2) / a ** 2 + d[2] ** 2 / b ** 2;
  const qb = 2 * ((C[0] * d[0] + C[1] * d[1]) / a ** 2 + (C[2] * d[2]) / b ** 2);
  const qc = (C[0] ** 2 + C[1] ** 2) / a ** 2 + C[2] ** 2 / b ** 2 - 1;
  const disc = qb * qb - 4 * qa * qc;
  if (disc < 0) return null;
  const t = (-qb - Math.sqrt(disc)) / (2 * qa);
  return add(C, mul(d, t));
}

/** Ray–terrain intersection by fixed-point iteration on height. */
export function rayTerrain(cam, col, row, terrain, h0 = 0) {
  // Iterate the surface parameter until the hit's true geodetic height equals the terrain's.
  const d = cam.ray(col, row);
  let hp = h0;
  let g = null;
  for (let i = 0; i < 40; i++) {
    const P = rayAtHeight(cam.C, d, hp);
    if (!P) return null;
    g = geodetic(...P);
    const err = g[2] - terrain(g[0], g[1]);
    if (Math.abs(err) < 1e-7) break;
    hp -= err;
  }
  return g;
}

// ---- RPC00B fit ----

/** RPC00B term order for normalised (L = lon, P = lat, H = height). */
export function terms(L, P, H) {
  return [1, L, P, H, L * P, L * H, P * H, L * L, P * P, H * H, P * L * H, L * L * L, L * P * P, L * H * H, L * L * P, P * P * P, P * H * H, L * L * H, P * P * H, H * H * H];
}

function solve(Mx, b) {
  const n = b.length;
  const M = Mx.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/** 7 significant digits (the RPC00B ±x.xxxxxxE±x field). */
const sig7 = (v) => Number(v.toExponential(6));
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Fit an RPC00B record to `project(lat, lon, h) → [col, row]` over a lat/lon box and height range.
 * Returns {rec (92 values), maxResidualPx} with the fields rounded as RPC00B stores them.
 */
export function fitRpc(project, { lat: [lat0, lat1], lon: [lon0, lon1], h: [h0, h1], W, H, errBias = 3, errRand = 0.5, lambda = 1e-6 }) {
  const off = { line: Math.round((H - 1) / 2), samp: Math.round((W - 1) / 2), lat: r4((lat0 + lat1) / 2), lon: r4((lon0 + lon1) / 2), h: Math.round((h0 + h1) / 2) };
  const sc = { line: Math.ceil(H / 2) + 1, samp: Math.ceil(W / 2) + 1, lat: r4(Math.max((lat1 - lat0) / 2, 1e-4) * 1.05), lon: r4(Math.max((lon1 - lon0) / 2, 1e-4) * 1.05), h: Math.max(1, Math.ceil(((h1 - h0) / 2) * 1.05)) };
  const pts = [];
  const n = 13;
  for (let k = 0; k < 7; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const lat = lat0 + ((lat1 - lat0) * j) / (n - 1);
        const lon = lon0 + ((lon1 - lon0) * i) / (n - 1);
        const h = h0 + ((h1 - h0) * k) / 6;
        const [c, r] = project(lat, lon, h);
        pts.push({ L: (lon - off.lon) / sc.lon, P: (lat - off.lat) / sc.lat, Hh: (h - off.h) / sc.h, c: (c - off.samp) / sc.samp, r: (r - off.line) / sc.line });
      }
  const fitOne = (key) => {
    // r·den − num = 0 with den[0] = 1: unknowns num[0..19], den[1..19].
    const N = 39;
    const M = Array.from({ length: N }, () => new Array(N).fill(0));
    const b = new Array(N).fill(0);
    for (const p of pts) {
      const t = terms(p.L, p.P, p.Hh);
      const v = p[key];
      const row = [...t, ...t.slice(1).map((x) => -v * x)];
      for (let i = 0; i < N; i++) {
        b[i] += row[i] * v;
        for (let j = 0; j < N; j++) M[i][j] += row[i] * row[j];
      }
    }
    // Ridge on the denominator terms only: over small boxes perspective is nearly affine and
    // unregularised denominators grow large, cancelling coefficients that RPC00B's 7 digits lose.
    const tr = M.reduce((s2, r, i) => s2 + r[i], 0) / N;
    for (let i = 0; i < N; i++) M[i][i] += i >= 20 ? lambda * tr : 1e-12;
    const x = solve(M, b);
    return { num: x.slice(0, 20).map(sig7), den: [1, ...x.slice(20)].map(sig7) };
  };
  const lineFit = fitOne('r');
  const sampFit = fitOne('c');
  const rec = [errBias, errRand, off.line, off.samp, off.lat, off.lon, off.h, sc.line, sc.samp, sc.lat, sc.lon, sc.h, ...lineFit.num, ...lineFit.den, ...sampFit.num, ...sampFit.den];
  // Residual of the rounded model on a fresh grid.
  let maxResidualPx = 0;
  const ev = (lat, lon, h) => {
    const t = terms((lon - off.lon) / sc.lon, (lat - off.lat) / sc.lat, (h - off.h) / sc.h);
    const s = (c) => c.reduce((acc, k, i) => acc + k * t[i], 0);
    return [(s(sampFit.num) / s(sampFit.den)) * sc.samp + off.samp, (s(lineFit.num) / s(lineFit.den)) * sc.line + off.line];
  };
  for (let j = 0; j < 9; j++)
    for (let i = 0; i < 9; i++)
      for (const h of [h0, (h0 + h1) / 2, h1]) {
        const lat = lat0 + ((lat1 - lat0) * (j + 0.37)) / 9;
        const lon = lon0 + ((lon1 - lon0) * (i + 0.61)) / 9;
        const a = project(lat, lon, h);
        const b = ev(lat, lon, h);
        maxResidualPx = Math.max(maxResidualPx, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
  return { rec, maxResidualPx, evaluate: ev };
}

/** Deterministic random numbers. */
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
  return { next, gauss: () => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next()) };
}

/** Smooth value noise over a plane (x, y in arbitrary units). */
export function valueNoise(seed, cell) {
  const R = rng(seed);
  const tbl = Float64Array.from({ length: 4096 }, () => R.next());
  const hash = (i, j) => tbl[((i * 73856093) ^ (j * 19349663)) & 4095];
  const s = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const gx = x / cell;
    const gy = y / cell;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = s(gx - i);
    const fy = s(gy - j);
    const a = hash(i, j);
    const b = hash(i + 1, j);
    const c = hash(i, j + 1);
    const d = hash(i + 1, j + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}
