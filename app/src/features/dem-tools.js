// DEM tools (R2.4): non-destructive DEM editing (REQ-DEM-08/09), contour lines with index lines
// and labels (REQ-DEM-11), Save DEM As GeoTIFF/COG with vertical keys and DTED Level 1/2 full
// cells (REQ-DEM-16), the DEM accuracy report (REQ-DEM-17), the SMRF ground filter
// (REQ-DEM-07) and multi-pair DSM fusion (REQ-DEM-05).
//
// Edits: the source DEM is never changed. Each edit is a 'demedit' record in the store (the
// command log), so undo, redo and project files carry it; the edited surface is the source with
// the log replayed, pushed to the core terrain and, as sparse 256² tiles, to the decode worker
// for display.

import { minOf, maxOf } from '../core/util.js';
import { h } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { parseDelimited } from './workspace-tools.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { fromParts } from '../vector/geom.js';
import { groundOf, poly } from '../tools/tools.js';
import { openImageFile } from '../formats/open.js';
import { dtedCell, hgtCell } from '../formats/dem-writers.js';

export const name = 'dem-tools';

const TILE = 256;

// ---- grid helpers ----
const idx = (g, i, j) => j * g.width + i;
const postOf = (g, lat, lon) => ({ i: Math.round((lon - g.lon0) / g.dlon), j: Math.round((g.lat0 - lat) / g.dlat) });
const latOf = (g, j) => g.lat0 - j * g.dlat;
const lonOf = (g, i) => g.lon0 + i * g.dlon;

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
function postsIn(g, ring, holes = []) {
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
const cellM = (g, lat) => [g.dlon * 111320 * Math.cos((lat * Math.PI) / 180), g.dlat * 110950];

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

const median = (v) => {
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
      const feather = Math.max(0, p.feather ?? 0);
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
      const rad = Math.max(1, Math.round(p.radius ?? 2));
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
        for (let t = 0; t <= steps; t++) {
          const f = t / steps;
          const lon = a[0] + (b[0] - a[0]) * f;
          const lat = a[1] + (b[1] - a[1]) * f;
          const hh = a[2] + (b[2] - a[2]) * f;
          const c = postOf(g, lat, lon);
          const ri = Math.ceil(half / cx);
          const rj = Math.ceil(half / cy);
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
    default:
      throw new Error(`unknown DEM edit "${op.kind}"`);
  }
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

// ---- contours (marching squares) ----
/** Contour polylines [{level, index, pts: [[lon, lat, h]…]}] of a grid at an interval. */
export function contourLines(g, H, interval, { indexEvery = 5, maxLines = 20000, levels = null } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of H)
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  if (!Number.isFinite(lo)) return [];
  const out = [];
  // Explicit levels (a 0/1 mask is traced at 0.5 only), else every multiple of the interval.
  const levs = levels ?? [];
  if (!levels) for (let lev = Math.ceil(lo / interval) * interval; lev <= hi; lev += interval) levs.push(lev);
  for (const lev of levs) {
    // Segments per cell, keyed by edge for joining.
    const segs = [];
    for (let j = 0; j < g.height - 1; j++)
      for (let i = 0; i < g.width - 1; i++) {
        const v = [H[idx(g, i, j)], H[idx(g, i + 1, j)], H[idx(g, i + 1, j + 1)], H[idx(g, i, j + 1)]];
        if (!v.every(Number.isFinite)) continue;
        const code = (v[0] >= lev ? 8 : 0) | (v[1] >= lev ? 4 : 0) | (v[2] >= lev ? 2 : 0) | (v[3] >= lev ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const e = (a, b, pa, pb) => {
          const t = (lev - v[a]) / (v[b] - v[a]);
          return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
        };
        const P = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
        const top = () => e(0, 1, P[0], P[1]);
        const right = () => e(1, 2, P[1], P[2]);
        const bottom = () => e(3, 2, P[3], P[2]);
        const left = () => e(0, 3, P[0], P[3]);
        const T = {
          1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[top, right]], 5: [[left, top], [bottom, right]], 6: [[top, bottom]], 7: [[left, top]],
          8: [[left, top]], 9: [[top, bottom]], 10: [[top, right], [left, bottom]], 11: [[top, right]], 12: [[left, right]], 13: [[bottom, right]], 14: [[left, bottom]],
        }[code];
        for (const [fa, fb] of T) segs.push([fa(), fb()]);
      }
    // Join segments into polylines by shared end points.
    const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    const ends = new Map();
    segs.forEach((s, k) => {
      for (const e of [0, 1]) {
        const kk = key(s[e]);
        if (!ends.has(kk)) ends.set(kk, []);
        ends.get(kk).push(k);
      }
    });
    const used = new Uint8Array(segs.length);
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const line = [segs[s0][0], segs[s0][1]];
      for (const dir of [1, 0]) {
        for (;;) {
          const endp = dir ? line.at(-1) : line[0];
          const next = (ends.get(key(endp)) ?? []).find((k) => !used[k]);
          if (next === undefined) break;
          used[next] = 1;
          const s = segs[next];
          const other = key(s[0]) === key(endp) ? s[1] : s[0];
          if (dir) line.push(other);
          else line.unshift(other);
        }
      }
      if (line.length >= 3) out.push({ level: lev, index: Math.round(lev / interval) % indexEvery === 0, pts: line.map(([fi, fj]) => [g.lon0 + fi * g.dlon, g.lat0 - fj * g.dlat, lev]) });
      if (out.length >= maxLines) return out;
    }
  }
  return out;
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
  const maxR = Math.max(1, Math.round(maxWindowM / cx / 2));
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

// ---- accuracy (REQ-DEM-17) ----
/** Residuals e = DEM − checkpoint; [{id, e, class}] → statistics and the ASPRS statement. */
export function accuracyStats(res) {
  const all = res.filter((r) => Number.isFinite(r.e));
  const stats = (rs) => {
    if (!rs.length) return null;
    const e = rs.map((r) => r.e);
    const n = e.length;
    const mean = e.reduce((a, b) => a + b, 0) / n;
    const rmse = Math.sqrt(e.reduce((a, b) => a + b * b, 0) / n);
    const sd = Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    const abs = e.map(Math.abs).sort((a, b) => a - b);
    const q = (p) => abs[Math.min(n - 1, Math.ceil(p * n) - 1)];
    const med = median(e);
    const nmad = 1.4826 * median(e.map((v) => Math.abs(v - med)));
    return { n, mean, bias: mean, sd, rmse, le90: 1.6449 * rmse, le90Empirical: q(0.9), p95: q(0.95), nmad, min: Math.min(...e), max: Math.max(...e) };
  };
  const nva = stats(all.filter((r) => !/^v|veg/i.test(r.class ?? '')));
  const vva = stats(all.filter((r) => /^v|veg/i.test(r.class ?? '')));
  const total = stats(all);
  const warnings = [];
  if (all.length < 30) warnings.push(`Only ${all.length} checkpoints: ASPRS Positional Accuracy Standards Edition 2 (2023) ask for at least 30.`);
  const cm = (v) => (v * 100).toFixed(1);
  const statement = nva
    ? `This data set was tested to meet ASPRS Positional Accuracy Standards for Digital Geospatial Data, Edition 2 (2023), for a ${cm(nva.rmse)} cm RMSEz vertical accuracy class. Actual NVA accuracy was found to be RMSEz = ${cm(nva.rmse)} cm${vva ? `; VVA RMSEz = ${cm(vva.rmse)} cm` : ''}, from ${all.length} checkpoints.`
    : 'No non-vegetated checkpoints: no ASPRS statement.';
  return { total, nva, vva, warnings, statement };
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const toast = (m, o) => app.toast(m, o);

  /** The terrain entry being edited: the active layer's, else the first editable one. */
  const target = () => {
    const al = pane()?.activeLayer();
    const e = (al && app.terrain.entry(al.id)) || app.terrain.dems.find((d) => d.aligned);
    return e && e.aligned ? e : null;
  };

  // ---- the command log drives the edited surface ----
  const sigs = new Map();
  async function sync() {
    for (const d of app.terrain.dems) {
      if (!d.aligned || !d.grid) continue;
      const ops = S.all('demedit').filter((o) => o.layer === d.layerId).sort((a, b) => a.seq - b.seq);
      const sig = JSON.stringify(ops.map((o) => [o.id, o.seq]));
      if ((sigs.get(d.layerId) ?? '[]') === sig) continue;
      sigs.set(d.layerId, sig);
      const src = d.grid.heights;
      const H = src.slice();
      for (const op of ops) applyEdit(d.grid, H, op);
      app.terrain.setHeights(d.layerId, ops.length ? H : src);
      d.current = ops.length ? H : null;
      const l = app.layers.get(d.layerId);
      if (l?.handle) {
        const tiles = ops.length ? dirtyTiles(d.grid, src, H) : [];
        await app.pool.run('overlay', { handle: l.handle, tiles }, { affinity: l.affinity, transfer: tiles.map((t) => t.data.buffer) });
        l.tiles.reset?.();
        l.stats = l.stats; // display statistics stay those of the source
        app.renderer?.invalidate();
      }
    }
  }
  S.on('change', () => sync().catch((e) => toast(`DEM edit: ${e.message}`, { kind: 'error' })));
  const heightsOf = (d) => d.current ?? d.grid.heights;

  /** Record one edit (undoable). */
  function edit(kind, params, d = target()) {
    if (!d) throw new Error('no editable DEM: use a DTED cell or a geographic GeoTIFF as terrain');
    const seq = S.all('demedit').filter((o) => o.layer === d.layerId).reduce((m, o) => Math.max(m, o.seq), 0) + 1;
    let id;
    S.transact(`DEM ${kind}`, (tx) => (id = tx.create('demedit', { layer: d.layerId, seq, kind, params, created: new Date().toISOString(), analyst: app.prefs.get('analyst') ?? 'analyst' })));
    return sync().then(() => id);
  }
  app.demEdit = { edit, sync, target, heightsOf, applyEdit, log: (d = target()) => S.all('demedit').filter((o) => o.layer === d?.layerId).sort((a, b) => a.seq - b.seq) };

  // ---- DEM Edit dialog and tools (REQ-DEM-09) ----
  let pending = null; // {kind, params} waiting for an area
  app.tools.register({
    id: 'dem.area',
    cue: 'DEM edit area: click the corners; Enter or a double-click applies the edit.',
    onDown(p, e, sx, sy) {
      const g = groundOf(app, p, sx, sy);
      if (!g) return true;
      (this.state.pts ??= []).push([g.lon, g.lat, g.h, sx, sy]);
      p.invalidate();
      return true;
    },
    onDblClick(p) {
      this.onEnter(p);
      return true;
    },
    onEnter() {
      const pts = this.state.pts ?? [];
      this.state = {};
      app.tools.done();
      if (!pending) return;
      const job = pending;
      pending = null;
      if (job.kind === 'breakline') {
        if (pts.length < 2) return;
        edit('breakline', { ...job.params, line: pts.map((q) => [q[0], q[1], Number.isFinite(job.params.h) ? job.params.h : q[2]]) }).catch((e) => toast(e.message, { kind: 'error' }));
        return;
      }
      if (pts.length < 3) return;
      edit(job.kind, { ...job.params, ring: pts.map((q) => [q[0], q[1]]) }).catch((e) => toast(e.message, { kind: 'error' }));
    },
    draw(p, g, w, hh, s) {
      const pts = (s.pts ?? []).map((q) => ({ x: q[3], y: q[4] }));
      if (!pts.length) return;
      g.strokeStyle = '#00e5ff';
      g.setLineDash([5, 3]);
      poly(g, pts, true);
      g.stroke();
      g.setLineDash([]);
    },
  });
  app.tools.register({
    id: 'dem.query',
    cue: 'Post Query: click a post to see its source and edited heights and the edits that touched it.',
    onDown(p, e, sx, sy) {
      const d = target();
      const g = groundOf(app, p, sx, sy);
      if (!d || !g) return true;
      const { i, j } = postOf(d.grid, g.lat, g.lon);
      const k = idx(d.grid, i, j);
      const src = d.grid.heights[k];
      const cur = heightsOf(d)[k];
      toast(`Post (${i}, ${j}): source ${Number.isFinite(src) ? src.toFixed(2) : 'void'} m, now ${Number.isFinite(cur) ? cur.toFixed(2) : 'void'} m (${d.vertical === 'hae' ? 'HAE' : 'MSL'})${src !== cur ? ' — edited' : ''}`);
      return true;
    },
  });
  C.implement('dem.edit', {
    enabled: () => !!target(),
    run: async () => {
      const d = target();
      if (!d) return toast('No editable DEM', { kind: 'warn' });
      const kinds = { raise: 'Raise / lower (feathered)', flatten: 'Flatten', plane: 'Plane fit', lake: 'Lake fill (islands kept)', smooth: 'Smooth', interpolate: 'Interpolate from the edge', despike: 'Remove spikes and wells', breakline: 'Breakline', post: 'Post edit (at the stereo cursor or a height)' };
      const sel = h('select', { class: 'inp', 'aria-label': 'Edit' }, ...Object.entries(kinds).map(([k, v]) => h('option', { value: k }, v)));
      const num = (lab, v) => h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: v, 'aria-label': lab });
      const dh = num('Height change (m)', '2');
      const fe = num('Feather (m)', '5');
      const lv = num('Height or level (m, empty = automatic)', '');
      const rad = num('Radius (posts)', '2');
      const thr = num('Threshold (m)', '5');
      const whole = h('input', { type: 'checkbox', 'aria-label': 'Whole DEM' });
      const body = h('div', {}, field('Edit', sel), field('Height change (m)', dh), field('Feather (m)', fe), field('Height or level (m)', lv, 'Flatten, lake level, breakline or post height; empty: mean, lowest shoreline post, or the clicked heights.'), field('Smoothing radius (posts)', rad), field('Spike threshold (m)', thr), h('label', { class: 'fld fld-inline' }, whole, h('span', {}, 'Whole DEM (spike removal)')), h('p', { class: 'hint' }, `Editing ${d.name}. The source file is never changed; edits are in the project and undo with Ctrl+Z.`));
      const r = await modal({ title: 'DEM Edit', body, buttons: ['Draw Area', 'Query Posts', 'Cancel'], id: 'dem-edit' });
      const level = lv.value === '' ? NaN : Number(lv.value);
      if (r === 'Query Posts') return app.tools.select('dem.query');
      if (r !== 'Draw Area') return;
      const params = { raise: { dh: Number(dh.value), feather: Number(fe.value) }, flatten: { h: level }, plane: {}, lake: { level }, smooth: { radius: Number(rad.value) }, interpolate: {}, despike: { threshold: Number(thr.value) }, breakline: { h: level, width: 1 } }[sel.value];
      if (sel.value === 'post') {
        const st = pane()?.stereo;
        const c = st?.cursor;
        if (!c && !Number.isFinite(level)) return toast('Post edit needs the stereo cursor or a height', { kind: 'warn' });
        const g = c ?? (await new Promise((res) => {
          app.tools.register({ id: 'dem.pick', cue: 'Click the post to set.', onDown(p, e, sx, sy) {
            res(groundOf(app, p, sx, sy));
            app.tools.done();
            return true;
          } });
          app.tools.select('dem.pick');
        }));
        if (g) await edit('post', { lat: g.lat, lon: g.lon, h: c ? c.h : level });
        return;
      }
      if (sel.value === 'despike' && whole.checked) return edit('despike', { threshold: Number(thr.value) });
      pending = { kind: sel.value, params };
      app.tools.select('dem.area');
    },
  });

  // ---- contour lines (REQ-DEM-11) ----
  app.contourLines = (interval, { indexEvery = 5, d = target() ?? app.terrain.dems[0] } = {}) => {
    if (!d?.grid) throw new Error('contour lines need a DEM loaded as terrain');
    const lines = contourLines(d.grid, heightsOf(d), interval, { indexEvery });
    const toHae = d.vertical === 'hae' ? (lat, lon, hh) => hh : (lat, lon, hh) => hh + app.core.undulation(lat, lon);
    let id;
    S.transact(`Contours ${interval} m`, (tx) => {
      id = tx.create('vlayer', { name: `Contours ${interval} m (${d.vertical === 'hae' ? 'HAE' : 'MSL'})`, visible: true, style: { stroke: '#d8a040', width: 1, fill: '#00000000', labelField: 'ELEV', labelWhen: 'INDEX', stereo: true }, fields: [{ name: 'ELEV', type: 'real' }, { name: 'INDEX', type: 'integer' }], source: { format: 'contours', dem: d.name }, created: new Date().toISOString() });
      for (const c of lines) tx.create('feature', { vlayer: id, geom: fromParts('LineString', [c.pts.map(([lon, lat, hh]) => [lon, lat, toHae(lat, lon, hh)])]), attrs: { ELEV: c.level, INDEX: c.index ? 1 : 0 }, style: c.index ? { width: 2.2, stroke: '#ffcc66' } : null, name: `${c.level} m`, prov: { kind: 'contour', dem: d.name } });
    });
    return { layer: id, lines: lines.length, index: lines.filter((c) => c.index).length };
  };
  C.implement('dem.contourlines', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const inp = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', step: 'any', value: '5', 'aria-label': 'Interval (m)' });
      const ix = h('input', { class: 'inp inp-num', type: 'number', min: '2', step: '1', value: '5', 'aria-label': 'Index every' });
      if ((await modal({ title: 'Contour Lines', body: h('div', {}, field('Interval (m)', inp), field('Index line every', ix, 'Index lines are thicker and labelled with their height.')), buttons: ['OK', 'Cancel'], id: 'contour-lines' })) !== 'OK') return;
      try {
        const r = app.contourLines(Number(inp.value) || 5, { indexEvery: Number(ix.value) || 5 });
        toast(`${r.lines} contour lines (${r.index} index lines); they also show in stereo panels`);
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    },
  });

  // ---- Save DEM As (REQ-DEM-16) ----
  /** GeoTIFF/COG bytes of a terrain entry (current heights, its vertical datum). */
  app.demGeoTiff = async (d = target() ?? app.terrain.dems[0]) => {
    const g = d.grid;
    return writeGeoTiff({ width: g.width, height: g.height, bands: 1, type: 'f32', data: heightsOf(d) }, { epsg: 4326, vertical: d.vertical === 'hae' ? 'hae' : d.vertical === 'egm2008' ? 'egm2008' : 'egm96', geotransform: [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], nodata: NaN, overviews: true, tile: 256, description: `GIS Workbench DEM (${d.vertical === 'hae' ? 'heights above the WGS 84 ellipsoid' : 'orthometric heights'}, metres) from ${d.name}` });
  };
  /** DTED Level 1/2 cells (MSL EGM96, whole metres) covering the terrain: [{name, bytes}]. */
  app.demDted = (level = 2, d = target() ?? app.terrain.dems[0]) => {
    const g = d.grid;
    const H = heightsOf(d);
    const south = g.lat0 - g.dlat * (g.height - 1);
    const east = g.lon0 + g.dlon * (g.width - 1);
    const cells = [];
    for (let la = Math.floor(south); la <= Math.floor(g.lat0 - 1e-9); la++) for (let lo = Math.floor(g.lon0); lo <= Math.floor(east - 1e-9); lo++) cells.push([la, lo]);
    return cells.map(([la, lo]) => ({ name: `${lo < 0 ? 'w' : 'e'}${String(Math.abs(lo)).padStart(3, '0')}_${la < 0 ? 's' : 'n'}${String(Math.abs(la)).padStart(2, '0')}.dt${level}`, bytes: dtedCell(app, g, H, d.vertical, la, lo, level) }));
  };
  /** SRTM HGT tiles (1″ 3601² or 3″ 1201², MSL EGM96, whole metres) covering the terrain: [{name, bytes}]. */
  app.demHgt = (arcsec = 1, d = target() ?? app.terrain.dems[0]) => {
    const g = d.grid;
    const H = heightsOf(d);
    const south = g.lat0 - g.dlat * (g.height - 1);
    const east = g.lon0 + g.dlon * (g.width - 1);
    const cells = [];
    for (let la = Math.floor(south); la <= Math.floor(g.lat0 - 1e-9); la++) for (let lo = Math.floor(g.lon0); lo <= Math.floor(east - 1e-9); lo++) cells.push([la, lo]);
    return cells.map(([la, lo]) => ({ name: `${la < 0 ? 'S' : 'N'}${String(Math.abs(la)).padStart(2, '0')}${lo < 0 ? 'W' : 'E'}${String(Math.abs(lo)).padStart(3, '0')}.hgt`, bytes: hgtCell(app, g, H, d.vertical, la, lo, arcsec) }));
  };
  C.implement('dem.save', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const d = target() ?? app.terrain.dems[0];
      const fmt = h('select', { class: 'inp', 'aria-label': 'Format' }, h('option', { value: 'tif' }, 'GeoTIFF / COG (float32, vertical keys)'), h('option', { value: 'dt2' }, 'DTED Level 2 (full cells, MSL)'), h('option', { value: 'dt1' }, 'DTED Level 1 (full cells, MSL)'), h('option', { value: 'hgt1' }, 'SRTM HGT 1″ (3601 × 3601 tiles, MSL)'), h('option', { value: 'hgt3' }, 'SRTM HGT 3″ (1201 × 1201 tiles, MSL)'));
      if ((await modal({ title: `Save DEM As — ${d.name}`, body: field('Format', fmt), buttons: ['Save', 'Cancel'], id: 'dem-save' })) !== 'Save') return;
      try {
        if (fmt.value === 'tif') {
          const bytes = await app.demGeoTiff(d);
          await saveBlob(app, new Blob([bytes], { type: 'image/tiff' }), { name: `${(app.layers.get(d.layerId)?.rec?.name ?? 'dem').replace(/\.[^.]+$/, '')}_edited.tif`, description: 'GeoTIFF' });
        } else if (fmt.value.startsWith('hgt')) {
          for (const c of app.demHgt(fmt.value === 'hgt1' ? 1 : 3, d)) await saveBlob(app, new Blob([c.bytes]), { name: c.name, description: 'SRTM HGT' });
        } else {
          for (const c of app.demDted(fmt.value === 'dt2' ? 2 : 1, d)) await saveBlob(app, new Blob([c.bytes]), { name: c.name, description: 'DTED' });
        }
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    },
  });

  // ---- DEM accuracy (REQ-DEM-17) ----
  /** Checkpoints [{id, lat, lon, h, vertical: 'hae'|'msl', class}] against a terrain → report. */
  app.demAccuracy = (points, d = target() ?? app.terrain.dems[0]) => {
    const res = points.map((p) => {
      const t = app.core.demHae(d.coreId, p.lat, p.lon);
      const hae = p.vertical === 'msl' ? p.h + app.core.undulation(p.lat, p.lon) : p.h;
      return { id: p.id, class: p.class ?? '', dem: t, check: hae, e: t - hae };
    });
    return { dem: d.name, residuals: res, ...accuracyStats(res) };
  };
  C.implement('dem.accuracy', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const [f] = await pickFiles(app, { multiple: false, accept: ['.csv', '.txt'], description: 'Checkpoints (id, lat, lon, h, class)' });
      if (!f) return;
      const { rows } = parseDelimited(await f.text());
      const head = rows[0].map((c) => c.trim().toLowerCase());
      const col = (...n) => head.findIndex((c) => n.includes(c));
      const ci = { id: col('id', 'name'), lat: col('lat', 'latitude'), lon: col('lon', 'long', 'longitude'), h: col('h', 'hae', 'height', 'z', 'elev', 'msl'), cls: col('class', 'landcover', 'type'), v: col('vertical', 'datum') };
      const msl = head[ci.h] === 'msl';
      const pts = rows.slice(1).map((r) => ({ id: r[ci.id], lat: +r[ci.lat], lon: +r[ci.lon], h: +r[ci.h], class: ci.cls >= 0 ? r[ci.cls] : '', vertical: ci.v >= 0 ? (/msl|egm/i.test(r[ci.v]) ? 'msl' : 'hae') : msl ? 'msl' : 'hae' })).filter((p) => [p.lat, p.lon, p.h].every(Number.isFinite));
      const rep = app.demAccuracy(pts);
      const fmt = (s) => (s ? `n ${s.n} · bias ${s.bias.toFixed(3)} m · RMSEz ${s.rmse.toFixed(3)} m · LE90 ${s.le90.toFixed(3)} m (1.6449·RMSE) / ${s.le90Empirical.toFixed(3)} m (empirical 90th percentile) · NMAD ${s.nmad.toFixed(3)} m` : '—');
      await modal({ title: `DEM Accuracy — ${rep.dem}`, body: h('div', { 'data-id': 'dem:accuracy' }, ...rep.warnings.map((w) => h('p', { class: 'warn' }, w)), h('p', {}, `All: ${fmt(rep.total)}`), h('p', {}, `NVA (non-vegetated): ${fmt(rep.nva)}`), h('p', {}, `VVA (vegetated): ${fmt(rep.vva)}`), h('p', { class: 'hint' }, rep.statement)), buttons: ['Close'], width: 640, id: 'dem-accuracy' });
    },
  });

  // ---- ground filter (REQ-DEM-07) ----
  app.groundFilter = async (opts = {}, d = target() ?? app.terrain.dems[0]) => {
    const g = d.grid;
    const { dtm, ground } = smrf(g, heightsOf(d), opts);
    const bytes = await writeGeoTiff({ width: g.width, height: g.height, bands: 1, type: 'f32', data: dtm }, { epsg: 4326, vertical: d.vertical === 'hae' ? 'hae' : 'egm96', geotransform: [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], nodata: NaN, description: `GIS Workbench DTM (SMRF ground filter) from ${d.name}` });
    const file = new File([bytes], `DTM_${(app.layers.get(d.layerId)?.rec?.name ?? 'dem').replace(/\.[^.]+$/, '')}.tif`, { type: 'image/tiff' });
    const { layers } = await openImageFile(app, file);
    await app.useAsTerrain(layers[0], d.vertical === 'hae' ? 'hae' : 'egm96');
    const te = app.terrain.entry(layers[0].id);
    if (te) te.kind = 'DTM';
    return { layer: layers[0], groundFraction: ground.reduce((a, b) => a + b, 0) / ground.length, dtm };
  };
  C.implement('dem.groundfilter', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const num = (v) => h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: v });
      const win = num('30');
      const sl = num('0.15');
      const ht = num('0.5');
      const body = h('div', {}, field('Largest object width (m)', win, 'The widest building or tree group to remove (the opening window).'), field('Slope threshold (rise/run)', sl), field('Height threshold (m)', ht, 'Posts within this height of the ground surface (plus the slope allowance) are ground.'));
      if ((await modal({ title: 'Ground Filter (SMRF)', body, buttons: ['Run', 'Cancel'], id: 'ground-filter' })) !== 'Run') return;
      try {
        const r = await app.groundFilter({ maxWindowM: +win.value, slope: +sl.value, height: +ht.value });
        toast(`DTM ${r.layer.rec.name}: ${(r.groundFraction * 100).toFixed(0)} % of posts are ground`);
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    },
  });

  // ---- multi-pair fusion (REQ-DEM-05) ----
  /** Median of several DSMs from extractDsm on the first one's grid. */
  app.fuseDsms = (dsms) => {
    const base = dsms[0];
    const g = base.grid;
    const n = g.nx * g.ny;
    const heights = new Float32Array(n).fill(NaN);
    const fom = new Uint8Array(n);
    const vals = [];
    for (let k = 0; k < n; k++) {
      const iy = Math.floor(k / g.nx);
      const ix = k % g.nx;
      const lat = g.lat0 - iy * g.dlat;
      const lon = g.lon0 + ix * g.dlon;
      vals.length = 0;
      let best = 0;
      for (const d of dsms) {
        const jx = Math.round((lon - d.grid.lon0) / d.grid.dlon);
        const jy = Math.round((d.grid.lat0 - lat) / d.grid.dlat);
        if (jx < 0 || jy < 0 || jx >= d.grid.nx || jy >= d.grid.ny) continue;
        const kk = jy * d.grid.nx + jx;
        if (d.fom[kk] >= 4 && Number.isFinite(d.heights[kk])) vals.push(d.heights[kk]);
        best = Math.max(best, d.fom[kk]);
      }
      if (vals.length) heights[k] = median(vals);
      fom[k] = vals.length ? best : Math.max(...dsms.map(() => 0));
    }
    return { ...base, heights, fom, pair: [...new Set(dsms.flatMap((d) => d.pair))], stats: { ...base.stats, fused: dsms.length } };
  };
  void section;
}
