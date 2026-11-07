// DEM edit kernels in JS (REQ-DEM-08/09, REQ-GAP-37/38): the edit log's operations on a height
// grid, the SMRF ground filter, the flat encoding read by the Rust kernels (crates/gw-terrain
// edit.rs) and block statistics. The app replays edits with the Rust kernels in an analysis
// worker; these functions are the fallback and the differential oracle (REQ-DEM-08). No DOM.

import { minOf, maxOf } from '../core/util.js';
import { gwError } from '../i18n/index.js';

export const TILE = 256;

// ---- grid helpers ----
export const idx = (g, i, j) => j * g.width + i;
export const postOf = (g, lat, lon) => ({ i: Math.round((lon - g.lon0) / g.dlon), j: Math.round((g.lat0 - lat) / g.dlat) });
export const latOf = (g, j) => g.lat0 - j * g.dlat;
export const lonOf = (g, i) => g.lon0 + i * g.dlon;

function inRing(ring, lon, lat) {
  let c = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [xa, ya] = ring[a];
    const [xb, yb] = ring[b];
    if (ya > lat !== yb > lat && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) c = !c;
  }
  return c;
}

/** Posts inside a ring (minus holes): [{i, j, k}] plus the bounding post box. */
export function postsIn(g, ring, holes = []) {
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const a = postOf(g, maxOf(lats), minOf(lons));
  const b = postOf(g, minOf(lats), maxOf(lons));
  const out = [];
  for (let j = Math.max(0, a.j - 1); j <= Math.min(g.height - 1, b.j + 1); j++)
    for (let i = Math.max(0, a.i - 1); i <= Math.min(g.width - 1, b.i + 1); i++) {
      const lon = lonOf(g, i);
      const lat = latOf(g, j);
      if (inRing(ring, lon, lat) && !holes.some((hh) => inRing(hh, lon, lat))) out.push({ i, j, k: idx(g, i, j) });
    }
  return { posts: out, box: { i0: Math.max(0, a.i - 1), i1: Math.min(g.width - 1, b.i + 1), j0: Math.max(0, a.j - 1), j1: Math.min(g.height - 1, b.j + 1) } };
}

/** Metres per post (x, y) near a latitude. */
export const cellM = (g, lat) => [g.dlon * 111320 * Math.cos((lat * Math.PI) / 180), g.dlat * 110950];

/** Distance (m) from a point to a ring's edges. */
function distToRing(ring, lon, lat, mx, my) {
  let d = Infinity;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
    const [x1, y1] = [(ring[b][0] - lon) * mx, (ring[b][1] - lat) * my];
    const [x2, y2] = [(ring[a][0] - lon) * mx, (ring[a][1] - lat) * my];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(x1 + t * dx, y1 + t * dy));
  }
  return d;
}

export const median = (v) => {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

/**
 * Apply one edit to heights (in place). Kinds: post {lat, lon, h}; raise {ring, dh, feather};
 * flatten {ring, h?}; plane {ring}; lake {ring, holes?, level?}; smooth {ring, radius};
 * interpolate {ring}; despike {ring?, threshold}; breakline {line [[lon, lat, h]…], width}.
 */
export function applyEdit(g, H, op) {
  const p = op.params ?? {};
  switch (op.kind) {
    case 'post': {
      const { i, j } = postOf(g, p.lat, p.lon);
      if (i >= 0 && j >= 0 && i < g.width && j < g.height) H[idx(g, i, j)] = p.h;
      return;
    }
    case 'raise': {
      const feather = Math.max(0, Number(p.feather) || 0);
      const lats = p.ring.map((q) => q[1]);
      const lat0 = (maxOf(lats) + minOf(lats)) / 2;
      const [cx, cy] = cellM(g, lat0);
      const mx = cx / g.dlon;
      const my = cy / g.dlat;
      const padI = Math.ceil(feather / cx) + 1;
      const padJ = Math.ceil(feather / cy) + 1;
      const { box } = postsIn(g, p.ring);
      for (let j = Math.max(0, box.j0 - padJ); j <= Math.min(g.height - 1, box.j1 + padJ); j++)
        for (let i = Math.max(0, box.i0 - padI); i <= Math.min(g.width - 1, box.i1 + padI); i++) {
          const lon = lonOf(g, i);
          const lat = latOf(g, j);
          const k = idx(g, i, j);
          if (!Number.isFinite(H[k])) continue;
          if (inRing(p.ring, lon, lat)) H[k] += p.dh;
          else if (feather > 0) {
            const d = distToRing(p.ring, lon, lat, mx, my);
            if (d < feather) {
              const t = d / feather;
              H[k] += p.dh * (1 - t * t * (3 - 2 * t));
            }
          }
        }
      return;
    }
    case 'flatten': {
      const { posts } = postsIn(g, p.ring);
      const level = Number.isFinite(p.h) ? p.h : posts.reduce((s, q) => s + (Number.isFinite(H[q.k]) ? H[q.k] : 0), 0) / Math.max(1, posts.filter((q) => Number.isFinite(H[q.k])).length);
      for (const q of posts) H[q.k] = level;
      return;
    }
    case 'plane': {
      // Least-squares plane h = a + b·i + c·j through the posts inside, then replace them.
      const { posts } = postsIn(g, p.ring);
      const n = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      const r = [0, 0, 0];
      for (const q of posts) {
        const v = H[q.k];
        if (!Number.isFinite(v)) continue;
        const row = [1, q.i, q.j];
        for (let a = 0; a < 3; a++) {
          r[a] += row[a] * v;
          for (let b = 0; b < 3; b++) n[a][b] += row[a] * row[b];
        }
      }
      const c = solve3(n, r);
      if (!c) return;
      for (const q of posts) H[q.k] = c[0] + c[1] * q.i + c[2] * q.j;
      return;
    }
    case 'lake': {
      const { posts } = postsIn(g, p.ring, p.holes ?? []);
      let level = p.level;
      if (!Number.isFinite(level)) {
        // The lowest post on the shoreline (posts just outside the ring).
        const ring = postsIn(g, p.ring).posts;
        const inside = new Set(ring.map((q) => q.k));
        let lo = Infinity;
        for (const q of ring)
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ii = q.i + di;
            const jj = q.j + dj;
            if (ii < 0 || jj < 0 || ii >= g.width || jj >= g.height) continue;
            const k = idx(g, ii, jj);
            if (!inside.has(k) && Number.isFinite(H[k])) lo = Math.min(lo, H[k]);
          }
        level = lo;
      }
      if (!Number.isFinite(level)) return;
      for (const q of posts) H[q.k] = level;
      return;
    }
    case 'smooth': {
      // Bounded by the grid: a window wider than the DEM reaches no further posts (a malformed
      // project must not hang the replay; same bounds in gw-terrain edit.rs).
      const rad = Math.min(Math.max(g.width, g.height), Math.max(1, Math.round(p.radius ?? 2)));
      const { posts } = postsIn(g, p.ring);
      const src = H.slice();
      for (const q of posts) {
        let s = 0;
        let c = 0;
        for (let dj = -rad; dj <= rad; dj++)
          for (let di = -rad; di <= rad; di++) {
            const ii = q.i + di;
            const jj = q.j + dj;
            if (ii < 0 || jj < 0 || ii >= g.width || jj >= g.height) continue;
            const v = src[idx(g, ii, jj)];
            if (Number.isFinite(v)) {
              s += v;
              c++;
            }
          }
        if (c) H[q.k] = s / c;
      }
      return;
    }
    case 'interpolate': {
      // Laplace relaxation of the posts inside from the posts around them.
      const { posts } = postsIn(g, p.ring);
      const inside = new Set(posts.map((q) => q.k));
      const nb = (q) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([di, dj]) => [q.i + di, q.j + dj]).filter(([ii, jj]) => ii >= 0 && jj >= 0 && ii < g.width && jj < g.height).map(([ii, jj]) => idx(g, ii, jj));
      const edgeVals = [];
      for (const q of posts) for (const k of nb(q)) if (!inside.has(k) && Number.isFinite(H[k])) edgeVals.push(H[k]);
      const start = edgeVals.length ? edgeVals.reduce((a, b) => a + b, 0) / edgeVals.length : 0;
      for (const q of posts) H[q.k] = start;
      for (let it = 0; it < 400; it++) {
        let change = 0;
        for (const q of posts) {
          const ks = nb(q);
          let s = 0;
          let c = 0;
          for (const k of ks)
            if (Number.isFinite(H[k])) {
              s += H[k];
              c++;
            }
          if (!c) continue;
          const v = s / c;
          change = Math.max(change, Math.abs(v - H[q.k]));
          H[q.k] = v;
        }
        if (change < 1e-4) break;
      }
      return;
    }
    case 'despike': {
      const thr = p.threshold ?? 5;
      const region = p.ring ? postsIn(g, p.ring).posts : null;
      const src = H.slice();
      const visit = (i, j) => {
        const k = idx(g, i, j);
        const v = src[k];
        if (!Number.isFinite(v)) return;
        const vals = [];
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di;
            const jj = j + dj;
            if (ii >= 0 && jj >= 0 && ii < g.width && jj < g.height) vals.push(src[idx(g, ii, jj)]);
          }
        const m = median(vals);
        if (Number.isFinite(m) && Math.abs(v - m) > thr) H[k] = m; // spike (up) or well (down)
      };
      if (region) for (const q of region) visit(q.i, q.j);
      else for (let j = 0; j < g.height; j++) for (let i = 0; i < g.width; i++) visit(i, j);
      return;
    }
    case 'breakline': {
      // Burn a 3-D line into the posts within width/2 of it (heights interpolated along it).
      const half = Math.max(0.5, (p.width ?? 1) / 2);
      const line = p.line;
      for (let s = 1; s < line.length; s++) {
        const [a, b] = [line[s - 1], line[s]];
        const [cx, cy] = cellM(g, (a[1] + b[1]) / 2);
        const len = Math.hypot((b[0] - a[0]) * (cx / g.dlon), (b[1] - a[1]) * (cy / g.dlat));
        const steps = Math.max(1, Math.ceil(len / Math.min(cx, cy)));
        // A segment longer than a million posts is not a breakline (malformed input): skipped.
        if (!(steps <= 1e6)) continue;
        for (let t = 0; t <= steps; t++) {
          const f = t / steps;
          const lon = a[0] + (b[0] - a[0]) * f;
          const lat = a[1] + (b[1] - a[1]) * f;
          const hh = a[2] + (b[2] - a[2]) * f;
          const c = postOf(g, lat, lon);
          const ri = Math.min(g.width, Math.ceil(half / cx));
          const rj = Math.min(g.height, Math.ceil(half / cy));
          for (let dj = -rj; dj <= rj; dj++)
            for (let di = -ri; di <= ri; di++) {
              const ii = c.i + di;
              const jj = c.j + dj;
              if (ii >= 0 && jj >= 0 && ii < g.width && jj < g.height && Math.hypot(di * cx, dj * cy) <= half) H[idx(g, ii, jj)] = hh;
            }
        }
      }
      return;
    }
    case 'bareearth': {
      // REQ-GAP-37: SMRF on the ring's post box padded by the largest window (+2 posts); the
      // posts inside the ring take the DTM.
      const { posts, box } = postsIn(g, p.ring);
      if (!posts.length) return;
      const o = { ...SMRF_DEFAULTS, ...pickSmrf(p) };
      const [cx, cy] = cellM(g, (latOf(g, box.j0) + latOf(g, box.j1)) / 2);
      const pi = Math.ceil(o.maxWindowM / cx) + 2;
      const pj = Math.ceil(o.maxWindowM / cy) + 2;
      const i0 = Math.max(0, box.i0 - pi);
      const i1 = Math.min(g.width - 1, box.i1 + pi);
      const j0 = Math.max(0, box.j0 - pj);
      const j1 = Math.min(g.height - 1, box.j1 + pj);
      const sub = { width: i1 - i0 + 1, height: j1 - j0 + 1, lat0: latOf(g, j0), lon0: lonOf(g, i0), dlat: g.dlat, dlon: g.dlon };
      const sz = new Float32Array(sub.width * sub.height);
      for (let j = j0; j <= j1; j++) sz.set(H.subarray(j * g.width + i0, j * g.width + i1 + 1), (j - j0) * sub.width);
      const { dtm } = smrf(sub, sz, o);
      for (const q of posts) {
        const v = dtm[(q.j - j0) * sub.width + (q.i - i0)];
        if (Number.isFinite(v)) H[q.k] = v;
      }
      return;
    }
    case 'recorrelate': {
      // REQ-GAP-38: a re-correlated surface patch (heights in the DEM's datum on its own grid),
      // bilinear at each post inside the ring; posts where the patch has no four matched
      // neighbours keep their height.
      const { posts } = postsIn(g, p.ring);
      const P = p.patch;
      for (const q of posts) {
        const fx = (lonOf(g, q.i) - P.lon0) / P.dlon;
        const fy = (P.lat0 - latOf(g, q.j)) / P.dlat;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        if (x0 < 0 || y0 < 0 || x0 + 1 >= P.nx || y0 + 1 >= P.ny) continue;
        const at = (x, y) => P.heights[y * P.nx + x] ?? NaN;
        const [a, b, c, d] = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)].map((v) => (v === null ? NaN : Math.fround(v)));
        if (![a, b, c, d].every(Number.isFinite)) continue;
        const tx = fx - x0;
        const ty = fy - y0;
        const top = a + (b - a) * tx;
        const bot = c + (d - c) * tx;
        H[q.k] = top + (bot - top) * ty;
      }
      return;
    }
    default:
      throw gwError('unknown DEM edit "{kind}"', { kind: op.kind }, 'E_DEM_EDIT_KIND');
  }
}

export const SMRF_DEFAULTS = { maxWindowM: 30, slope: 0.15, height: 0.5, scale: 1.25 };
const pickSmrf = (p) => Object.fromEntries(Object.keys(SMRF_DEFAULTS).filter((k) => Number.isFinite(p[k])).map((k) => [k, p[k]]));

const EDIT_CODE = { post: 1, raise: 2, flatten: 3, plane: 4, lake: 5, smooth: 6, interpolate: 7, despike: 8, breakline: 9, bareearth: 10, recorrelate: 11 };

/**
 * The edit log as the flat f64 list the Rust kernels read (gw-terrain edit.rs `parse`):
 * [count, (code, params…)…], rings as n, n × (lon, lat). Defaults are those of applyEdit.
 */
export function encodeEdits(ops) {
  const a = [ops.length];
  const ring = (r) => {
    a.push(r.length);
    for (const q of r) a.push(q[0], q[1]);
  };
  const num = (v, d = NaN) => (v === undefined || v === null ? d : Number(v));
  for (const op of ops) {
    const p = op.params ?? {};
    const code = EDIT_CODE[op.kind];
    if (!code) throw gwError('unknown DEM edit "{kind}"', { kind: op.kind }, 'E_DEM_EDIT_KIND');
    a.push(code);
    switch (op.kind) {
      case 'post':
        a.push(num(p.lat), num(p.lon), num(p.h));
        break;
      case 'raise':
        a.push(num(p.dh), Math.max(0, Number(p.feather) || 0));
        ring(p.ring);
        break;
      case 'flatten':
        a.push(num(p.h));
        ring(p.ring);
        break;
      case 'plane':
      case 'interpolate':
        ring(p.ring);
        break;
      case 'lake':
        a.push(num(p.level));
        ring(p.ring);
        a.push((p.holes ?? []).length);
        for (const hh of p.holes ?? []) ring(hh);
        break;
      case 'smooth':
        a.push(num(p.radius, 2));
        ring(p.ring);
        break;
      case 'despike':
        a.push(num(p.threshold, 5), p.ring ? 1 : 0);
        if (p.ring) ring(p.ring);
        break;
      case 'breakline':
        a.push(num(p.width, 1), p.line.length);
        for (const q of p.line) a.push(q[0], q[1], q[2]);
        break;
      case 'bareearth': {
        const o = { ...SMRF_DEFAULTS, ...pickSmrf(p) };
        a.push(o.maxWindowM, o.slope, o.height, o.scale);
        ring(p.ring);
        break;
      }
      case 'recorrelate': {
        const P = p.patch;
        a.push(P.lat0, P.lon0, P.dlat, P.dlon, P.nx, P.ny);
        ring(p.ring);
        for (let k = 0; k < P.nx * P.ny; k++) a.push(P.heights[k] ?? NaN);
        break;
      }
    }
  }
  return Float64Array.from(a, (v) => (v === null ? NaN : v));
}

function solve3(n, r) {
  const m = n.map((row, i) => [...row, r[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let k = c + 1; k < 3; k++) if (Math.abs(m[k][c]) > Math.abs(m[p][c])) p = k;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let k = 0; k < 3; k++) {
      if (k === c) continue;
      const f = m[k][c] / m[c][c];
      for (let j = c; j < 4; j++) m[k][j] -= f * m[c][j];
    }
  }
  return m.map((row, i) => row[3] / row[i]);
}

/** Sparse tiles (256² post blocks) where edited heights differ from the source. */
export function dirtyTiles(g, src, H) {
  const out = [];
  for (let ty = 0; ty < Math.ceil(g.height / TILE); ty++)
    for (let tx = 0; tx < Math.ceil(g.width / TILE); tx++) {
      const x0 = tx * TILE;
      const y0 = ty * TILE;
      const w = Math.min(TILE, g.width - x0);
      const hh = Math.min(TILE, g.height - y0);
      let diff = false;
      for (let y = 0; y < hh && !diff; y++)
        for (let x = 0; x < w; x++) {
          const k = (y0 + y) * g.width + x0 + x;
          const a = src[k];
          const b = H[k];
          if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) {
            diff = true;
            break;
          }
        }
      if (!diff) continue;
      const data = new Float32Array(w * hh);
      for (let y = 0; y < hh; y++) data.set(H.subarray((y0 + y) * g.width + x0, (y0 + y) * g.width + x0 + w), y * w);
      out.push({ x0, y0, w, h: hh, data });
    }
  return out;
}

/** Block status rows (the JS form of gw-terrain edit.rs blocks): per tile² post block, posts, voids, edited posts, largest |Δh|. */
export function blockRows(g, src, cur, tile = TILE) {
  const rows = [];
  for (let ty = 0; ty < Math.ceil(g.height / tile); ty++)
    for (let tx = 0; tx < Math.ceil(g.width / tile); tx++) {
      let posts = 0;
      let voids = 0;
      let edited = 0;
      let maxChange = 0;
      for (let y = ty * tile; y < Math.min(g.height, (ty + 1) * tile); y++)
        for (let x = tx * tile; x < Math.min(g.width, (tx + 1) * tile); x++) {
          const k = y * g.width + x;
          posts++;
          const a = src[k];
          const b = cur[k];
          if (!Number.isFinite(b)) voids++;
          if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) {
            edited++;
            const dd = Math.abs(b - a);
            if (Number.isFinite(dd) && dd > maxChange) maxChange = dd;
          }
        }
      rows.push({ tx, ty, posts, voids, edited, maxChange });
    }
  return rows;
}

// ---- SMRF ground filter (Pingel et al. 2013) ----
/**
 * DTM from a DSM grid: progressive morphological openings with windows up to maxWindowM, slope
 * threshold `slope` (rise per run), elevation threshold `height` (m) and scaling; non-ground
 * posts are refilled by Laplace interpolation from the ground. Returns {dtm, ground (Uint8)}.
 */
export function smrf(g, H, { maxWindowM = 30, slope = 0.15, height = 0.5, scale = 1.25 } = {}) {
  const [cx] = cellM(g, g.lat0 - (g.height * g.dlat) / 2);
  const W = g.width;
  const n = W * g.height;
  const erode = (a, r) => {
    // Square min filter (separable).
    const t = new Float32Array(n);
    const o = new Float32Array(n);
    for (let j = 0; j < g.height; j++)
      for (let i = 0; i < W; i++) {
        let m = Infinity;
        for (let d = -r; d <= r; d++) {
          const ii = i + d;
          if (ii >= 0 && ii < W) {
            const v = a[j * W + ii];
            if (Number.isFinite(v) && v < m) m = v;
          }
        }
        t[j * W + i] = m === Infinity ? NaN : m;
      }
    for (let j = 0; j < g.height; j++)
      for (let i = 0; i < W; i++) {
        let m = Infinity;
        for (let d = -r; d <= r; d++) {
          const jj = j + d;
          if (jj >= 0 && jj < g.height) {
            const v = t[jj * W + i];
            if (Number.isFinite(v) && v < m) m = v;
          }
        }
        o[j * W + i] = m === Infinity ? NaN : m;
      }
    return o;
  };
  const dilate = (a, r) => {
    const neg = a.map((v) => -v);
    return erode(neg, r).map((v) => -v);
  };
  let surf = H.slice();
  const object = new Uint8Array(n);
  // At most the grid size (malformed input must not run for ever; same bound in edit.rs).
  const maxR = Math.min(Math.max(g.width, g.height), Math.max(1, Math.round(maxWindowM / cx / 2)));
  for (let r = 1; r <= maxR; r++) {
    const opened = dilate(erode(surf, r), r);
    const thr = slope * r * cx * 2;
    for (let k = 0; k < n; k++) if (Number.isFinite(surf[k]) && surf[k] - opened[k] > thr) object[k] = 1;
    surf = opened;
  }
  // Provisional DTM from the opened surface; ground = posts within the elevation threshold of it
  // (scaled by the local slope).
  const ground = new Uint8Array(n);
  for (let j = 1; j < g.height - 1; j++)
    for (let i = 1; i < W - 1; i++) {
      const k = j * W + i;
      if (!Number.isFinite(H[k]) || !Number.isFinite(surf[k])) continue;
      const gx = (surf[k + 1] - surf[k - 1]) / (2 * cx);
      const gy = (surf[k + W] - surf[k - W]) / (2 * cx);
      const s = Math.hypot(gx, gy);
      ground[k] = !object[k] && Math.abs(H[k] - surf[k]) <= height + scale * s * cx ? 1 : 0;
    }
  const dtm = new Float32Array(n);
  for (let k = 0; k < n; k++) dtm[k] = ground[k] ? H[k] : NaN;
  // Laplace fill of the non-ground posts (start from the opened surface).
  for (let k = 0; k < n; k++) if (!ground[k]) dtm[k] = Number.isFinite(surf[k]) ? surf[k] : NaN;
  const free = [];
  for (let k = 0; k < n; k++) if (!ground[k] && Number.isFinite(dtm[k])) free.push(k);
  for (let it = 0; it < 200; it++) {
    let ch = 0;
    for (const k of free) {
      const i = k % W;
      const j = (k / W) | 0;
      let s = 0;
      let c = 0;
      for (const kk of [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, j > 0 ? k - W : -1, j < g.height - 1 ? k + W : -1])
        if (kk >= 0 && Number.isFinite(dtm[kk])) {
          s += dtm[kk];
          c++;
        }
      if (!c) continue;
      const v = s / c;
      ch = Math.max(ch, Math.abs(v - dtm[k]));
      dtm[k] = v;
    }
    if (ch < 1e-3) break;
  }
  return { dtm, ground };
}

