// Spatial indexes and snapping for features (REQ-EXT-04, REQ-EXT-08, Research/13 §2.3, §4.5):
// rbush over feature bounding boxes and kdbush over every vertex, rebuilt lazily after edits.
// Snap targets in priority order: vertex > intersection > edge; the tolerance is in screen
// pixels. A vertex snap copies X, Y and Z; an edge snap interpolates Z along the edge.

import RBush from 'rbush';
import KDBush from 'kdbush';
import { bbox, partRanges, isPolygonal } from './geom.js';

export class FeatureIndex {
  constructor(app) {
    this.app = app;
    this.dirty = true;
    this.tree = new RBush();
    this.kd = null;
    this.vtx = [];
    app.store.on?.('change', () => (this.dirty = true));
  }

  features() {
    return this.app.store.all('feature').filter((f) => this.app.store.get(f.vlayer)?.visible !== false);
  }

  build() {
    if (!this.dirty) return;
    const fs = this.features();
    this.tree.clear();
    this.tree.load(
      fs.map((f) => {
        const [minX, minY, maxX, maxY] = bbox(f.geom);
        return { minX, minY, maxX, maxY, id: f.id };
      }),
    );
    const n = fs.reduce((s, f) => s + f.geom.xyz.length / 3, 0);
    this.vtx = new Array(n);
    this.kd = new KDBush(Math.max(1, n));
    let k = 0;
    for (const f of fs)
      for (let i = 0; i < f.geom.xyz.length; i += 3) {
        this.kd.add(f.geom.xyz[i], f.geom.xyz[i + 1]);
        this.vtx[k++] = [f.id, i / 3];
      }
    if (!n) this.kd.add(1e9, 1e9);
    this.kd.finish();
    this.dirty = false;
  }

  /** Feature ids whose boxes meet [x0, y0, x1, y1] (degrees). */
  search(x0, y0, x1, y1) {
    this.build();
    return this.tree.search({ minX: x0, minY: y0, maxX: x1, maxY: y1 }).map((b) => b.id);
  }

  /** Vertices within r degrees of (lon, lat): [[featureId, vertexIndex], …]. */
  vertices(lon, lat, r) {
    this.build();
    return this.kd.within(lon, lat, r).map((i) => this.vtx[i]).filter(Boolean);
  }
}

const segPoint = (p, a, b) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return { t, x: a.x + t * dx, y: a.y + t * dy, d: Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) };
};

const segX = (a, b, c, d) => {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { t, u, x: a.x + t * r.x, y: a.y + t * r.y } : null;
};

/** Edges of a geometry as vertex index pairs (rings closed). */
export function edges(g) {
  const out = [];
  for (const [a, b] of partRanges(g)) {
    for (let i = a; i < b - 1; i++) out.push([i, i + 1]);
    if (isPolygonal(g) && b - a > 2) out.push([b - 1, a]);
  }
  return out;
}

/**
 * Snap the screen point (sx, sy) of a pane: {kind, lon, lat, h, fid, vi, label} or null.
 * `extra` are capture points [{lon, lat, h}] (the feature being drawn); `exclude` a feature id.
 */
export function snapAt(app, index, pane, sx, sy, { tol = 10, extra = [], exclude = null, toScreen }) {
  const l = pane.geoLayer?.();
  if (!l?.modelId) return null;
  const a = pane.imagePoint(sx, sy);
  const b = pane.imagePoint(sx + tol, sy + tol);
  const ga = l.groundAt(a.x, a.y);
  const gb = l.groundAt(b.x, b.y);
  if (!ga || !gb) return null;
  const r = Math.max(Math.abs(gb.lat - ga.lat), Math.abs(gb.lon - ga.lon)) * 2 + 1e-9;
  const p = { x: sx, y: sy };
  // Vertices.
  let best = null;
  const consider = (kind, pri, d, v) => {
    if (d > tol) return;
    if (!best || pri < best.pri || (pri === best.pri && d < best.d)) best = { kind, pri, d, ...v };
  };
  for (const [fid, vi] of index.vertices(ga.lon, ga.lat, r)) {
    if (fid === exclude) continue;
    const f = app.store.get(fid);
    if (!f) continue;
    const v = [f.geom.xyz[3 * vi], f.geom.xyz[3 * vi + 1], f.geom.xyz[3 * vi + 2]];
    const s = toScreen(v);
    if (s) consider('vertex', 0, Math.hypot(s.x - sx, s.y - sy), { lon: v[0], lat: v[1], h: v[2], fid, vi, label: `vertex ${vi + 1} of ${f.name || f.ufi?.slice(0, 8) || fid}` });
  }
  extra.forEach((q, i) => {
    const s = toScreen([q.lon, q.lat, q.h]);
    if (s) consider('vertex', 0, Math.hypot(s.x - sx, s.y - sy), { lon: q.lon, lat: q.lat, h: q.h, fid: null, vi: i, label: i === 0 ? 'first vertex (closes)' : `vertex ${i + 1} of this feature` });
  });
  if (best?.kind === 'vertex') return best;
  // Edges and intersections of nearby features.
  const segs = [];
  for (const fid of index.search(ga.lon - r, ga.lat - r, ga.lon + r, ga.lat + r)) {
    if (fid === exclude) continue;
    const f = app.store.get(fid);
    if (!f) continue;
    const xyz = f.geom.xyz;
    for (const [i, j] of edges(f.geom)) {
      const va = [xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2]];
      const vb = [xyz[3 * j], xyz[3 * j + 1], xyz[3 * j + 2]];
      const sa = toScreen(va);
      const sb = toScreen(vb);
      if (!sa || !sb) continue;
      const q = segPoint(p, sa, sb);
      if (q.d <= tol) segs.push({ f, va, vb, sa, sb, q });
    }
  }
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      if (segs[i].f.id === segs[j].f.id) continue;
      const x = segX(segs[i].sa, segs[i].sb, segs[j].sa, segs[j].sb);
      if (!x) continue;
      const s = segs[i];
      const lerp = (k) => s.va[k] + x.t * (s.vb[k] - s.va[k]);
      consider('intersection', 1, Math.hypot(x.x - sx, x.y - sy), { lon: lerp(0), lat: lerp(1), h: lerp(2), fid: s.f.id, vi: null, label: `intersection of ${s.f.name || 'feature'} and ${segs[j].f.name || 'feature'}` });
    }
  for (const s of segs) {
    const lerp = (k) => s.va[k] + s.q.t * (s.vb[k] - s.va[k]);
    consider('edge', 2, s.q.d, { lon: lerp(0), lat: lerp(1), h: lerp(2), fid: s.f.id, vi: null, label: `edge of ${s.f.name || s.f.ufi?.slice(0, 8) || 'feature'}` });
  }
  return best;
}
