// Mapbox Vector Tiles (FC-07, REQ-FMT-32): decode with @mapbox/vector-tile + pbf (BSD-3-Clause,
// vetted readers of untrusted bytes, REQ-SEC-02), draw a tile with the default style onto a 2D
// canvas (the S-46 renderer: tiles are rasterised once into bitmaps and then warped as textures,
// so panning and zooming run at the display rate), turn tile features into longitude/latitude
// GeoJSON (extraction to a vector layer) and find the features under a point (identify).
// DOM-free: runs in workers (OffscreenCanvas) and on the main thread.

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { paintFor, layerVisible, BACKGROUND, knownSchema } from './style.js';
import { gwError } from '../i18n/index.js';

/** Largest uncompressed tile accepted (MVT tiles are normally under 500 KB). */
export const MVT_MAX = 64 * 2 ** 20;

/** Decode an uncompressed tile; throws a named error for bytes that are not MVT. */
export function decodeMvt(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length > MVT_MAX) throw gwError('a vector tile of {size} MB is above the {limit} MB limit', { size: String(Math.round(u8.length / 2 ** 20)), limit: String(MVT_MAX / 2 ** 20) }, 'E_MVT_LIMIT');
  if (u8[0] === 0x1f && u8[1] === 0x8b) throw new Error('the vector tile is still gzip-compressed');
  try {
    const vt = new VectorTile(new PbfReader(u8));
    // Touch every layer so a damaged tile fails here, not halfway through drawing.
    for (const l of Object.values(vt.layers)) void l.length;
    return vt;
  } catch (e) {
    throw gwError('the vector tile is damaged ({detail})', { detail: e.message }, 'E_MVT_DAMAGED');
  }
}

const RAD = 180 / Math.PI;
/** Tile coordinate (x, y in 0..extent of tile z/tx/ty) → [lon, lat]. */
export function tileToLonLat(x, y, extent, z, tx, ty) {
  const n = 2 ** z;
  const wx = (tx + x / extent) / n;
  const wy = (ty + y / extent) / n;
  return [wx * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * RAD];
}

export { lonLatToWorld } from './merc.js';

function ringArea(r) {
  let s = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j].x - r[i].x) * (r[i].y + r[j].y);
  return s;
}

/** Rings → polygons (exterior + holes) by winding, as the MVT specification defines. */
export function classifyRings(rings) {
  const polys = [];
  let cur = null;
  let ccw;
  for (const r of rings) {
    const a = ringArea(r);
    if (a === 0) continue;
    if (ccw === undefined) ccw = a < 0;
    if (ccw === a < 0) {
      if (cur) polys.push(cur);
      cur = [r];
    } else if (cur) cur.push(r);
  }
  if (cur) polys.push(cur);
  return polys;
}

// ---- rectangle clipping (tile coordinates) ----

function clipRing(ring, x0, y0, x1, y1) {
  let pts = ring;
  const edges = [
    (p) => p.x >= x0, (p) => p.x <= x1, (p) => p.y >= y0, (p) => p.y <= y1,
  ];
  const cut = [
    (a, b) => ({ x: x0, y: a.y + ((x0 - a.x) * (b.y - a.y)) / (b.x - a.x) }),
    (a, b) => ({ x: x1, y: a.y + ((x1 - a.x) * (b.y - a.y)) / (b.x - a.x) }),
    (a, b) => ({ x: a.x + ((y0 - a.y) * (b.x - a.x)) / (b.y - a.y), y: y0 }),
    (a, b) => ({ x: a.x + ((y1 - a.y) * (b.x - a.x)) / (b.y - a.y), y: y1 }),
  ];
  for (let e = 0; e < 4 && pts.length; e++) {
    const inside = edges[e];
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia && ib) out.push(b);
      else if (ia) out.push(cut[e](a, b));
      else if (ib) out.push(cut[e](a, b), b);
    }
    pts = out;
  }
  return pts;
}

function clipLine(line, x0, y0, x1, y1) {
  const out = [];
  let cur = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, a.x - x0], [dx, x1 - a.x], [-dy, a.y - y0], [dy, y1 - a.y]]) {
      if (p === 0) {
        if (q < 0) ok = false;
      } else {
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (!ok || t0 > t1) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const p0 = { x: a.x + t0 * dx, y: a.y + t0 * dy };
    const p1 = { x: a.x + t1 * dx, y: a.y + t1 * dy };
    const last = cur.at(-1);
    if (!last || last.x !== p0.x || last.y !== p0.y) {
      if (cur.length > 1) out.push(cur);
      cur = [p0];
    }
    cur.push(p1);
    if (t1 < 1) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

/**
 * Geometry of a feature in tile coordinates, clipped to the tile square (its buffer removed) when
 * `clip`: {type: 'Point'|'LineString'|'Polygon', parts} or null when nothing is left.
 */
export function featureParts(f, extent, clip = true) {
  const g = f.loadGeometry();
  if (f.type === 1) {
    const pts = g.flat().filter((p) => !clip || (p.x >= 0 && p.x < extent && p.y >= 0 && p.y < extent));
    return pts.length ? { type: 'Point', parts: pts } : null;
  }
  if (f.type === 2) {
    const lines = clip ? g.flatMap((l) => clipLine(l, 0, 0, extent, extent)) : g.filter((l) => l.length > 1);
    return lines.length ? { type: 'LineString', parts: lines } : null;
  }
  if (f.type === 3) {
    const polys = [];
    for (const poly of classifyRings(g)) {
      const rings = clip ? poly.map((r) => clipRing(r, 0, 0, extent, extent)) : poly;
      if (rings[0].length < 3) continue;
      polys.push(rings.filter((r) => r.length >= 3));
    }
    return polys.length ? { type: 'Polygon', parts: polys } : null;
  }
  return null;
}

/** A tile's features as GeoJSON (longitude/latitude), per layer; `clip` removes the buffer. */
export function tileGeoJSON(vt, z, tx, ty, { layers = null, clip = true, bbox = null } = {}) {
  const out = {};
  for (const [name, l] of Object.entries(vt.layers)) {
    if (layers && !layers.has(name)) continue;
    const feats = (out[name] = []);
    const E = l.extent;
    const ll = (p) => tileToLonLat(p.x, p.y, E, z, tx, ty);
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      const g = featureParts(f, E, clip);
      if (!g) continue;
      let geometry;
      if (g.type === 'Point') geometry = g.parts.length === 1 ? { type: 'Point', coordinates: ll(g.parts[0]) } : { type: 'MultiPoint', coordinates: g.parts.map(ll) };
      else if (g.type === 'LineString') geometry = g.parts.length === 1 ? { type: 'LineString', coordinates: g.parts[0].map(ll) } : { type: 'MultiLineString', coordinates: g.parts.map((p) => p.map(ll)) };
      else {
        // GeoJSON rings are closed and counter-clockwise outside (RFC 7946 §3.1.6); tile y is down.
        const ring = (r) => {
          const c = r.map(ll);
          c.push(c[0]);
          return c;
        };
        geometry = g.parts.length === 1 ? { type: 'Polygon', coordinates: g.parts[0].map(ring) } : { type: 'MultiPolygon', coordinates: g.parts.map((p) => p.map(ring)) };
      }
      if (bbox && !intersects(geometry, bbox)) continue;
      feats.push({ type: 'Feature', id: f.id, geometry, properties: { ...f.properties } });
    }
  }
  return out;
}

function intersects(geometry, [w, s, e, n]) {
  let hit = false;
  const visit = (c) => {
    if (hit) return;
    if (typeof c[0] === 'number') {
      if (c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n) hit = true;
      return;
    }
    // A ring or line: its box against the area (good enough for "features in view").
    if (typeof c[0][0] === 'number') {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of c) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
      if (x0 <= e && x1 >= w && y0 <= n && y1 >= s) hit = true;
      return;
    }
    c.forEach(visit);
  };
  visit(geometry.coordinates);
  return hit;
}

// ---- drawing ----

/**
 * A line or polygon feature's geometry straight into a Path2D (tile units × k + offset), reading
 * the command stream as @mapbox/vector-tile's loadGeometry does (its `_pbf`/`_geometry`, pinned at
 * 3.0.0) without making a Point per vertex; vertices under half a pixel from the last are skipped.
 */
function pathOf(f, path, ox, oy, k, close) {
  if (f._geometry < 0) return;
  const pbf = f._pbf;
  pbf.pos = f._geometry;
  const end = pbf.readVarint() + pbf.pos;
  let cmd = 1;
  let length = 0;
  let x = 0;
  let y = 0;
  let lx = NaN;
  let ly = NaN;
  let pending = false; // a skipped vertex not yet drawn
  let px = 0;
  let py = 0;
  while (pbf.pos < end) {
    if (length <= 0) {
      const c = pbf.readVarint();
      cmd = c & 7;
      length = c >> 3;
      if (length === 0) continue;
    }
    length--;
    if (cmd === 1 || cmd === 2) {
      x += pbf.readSVarint();
      y += pbf.readSVarint();
      const sx = ox + x * k;
      const sy = oy + y * k;
      if (cmd === 1) {
        if (pending) path.lineTo(px, py);
        path.moveTo(sx, sy);
        lx = sx;
        ly = sy;
        pending = false;
      } else if (Math.abs(sx - lx) < 0.5 && Math.abs(sy - ly) < 0.5) {
        pending = true;
        px = sx;
        py = sy;
      } else {
        path.lineTo(sx, sy);
        lx = sx;
        ly = sy;
        pending = false;
      }
    } else if (cmd === 7) {
      if (pending) path.lineTo(px, py);
      pending = false;
      if (close) path.closePath();
    } else return;
  }
  if (pending) path.lineTo(px, py);
}

/**
 * Draw one data tile into a 2D context. `ox, oy`: where the tile's top-left lands in canvas
 * pixels; `scale`: canvas pixels per tile unit times the extent (so `scale` = drawn tile size);
 * `zoom`: the zoom the map is drawn at (for zoom-dependent paints).
 */
export function drawTile(g, vt, { ox = 0, oy = 0, size = 256, zoom = 0, dpr = 1 } = {}) {
  // Under-zoomed tiles (drawn smaller than 256 px) get thinner lines, so a coarse level is not all ink.
  const lw = dpr * Math.max(0.2, Math.min(1, size / (256 * dpr)));
  const groups = new Map(); // paint key → {paint, path, labels}
  const names = Object.keys(vt.layers);
  for (const name of names) {
    if (!layerVisible(name, zoom)) continue;
    const l = vt.layers[name];
    const k = size / l.extent;
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      const p = paintFor(name, f.properties, f.type, zoom);
      if (!p) continue;
      let grp = groups.get(p.key);
      if (!grp) groups.set(p.key, (grp = { p, path: new Path2D(), labels: [] }));
      if (f.type !== 1 && size < 512) {
        // Under-zoomed: a feature under a pixel is drawn as one (zip codes of a country at zoom 1).
        const bb = f.bbox();
        if ((bb[2] - bb[0]) * k < 1 && (bb[3] - bb[1]) * k < 1) {
          grp.path.rect(ox + bb[0] * k, oy + bb[1] * k, 1, 1);
          continue;
        }
      }
      if (f.type !== 1) {
        pathOf(f, grp.path, ox, oy, k, f.type === 3);
        continue;
      }
      const geom = f.loadGeometry();
      if (f.type === 1) {
        for (const ring of geom)
          for (const pt of ring) {
            const x = ox + pt.x * k;
            const y = oy + pt.y * k;
            if (p.label) {
              const t = f.properties.name ?? f.properties['name:en'] ?? f.properties.name_en;
              if (t) grp.labels.push([x, y, String(t)]);
            } else if (p.radius) {
              grp.path.moveTo(x + p.radius * lw, y);
              grp.path.arc(x, y, p.radius * lw, 0, 2 * Math.PI);
            }
          }
      }
    }
  }
  const list = [...groups.values()].sort((a, b) => a.p.order - b.p.order);
  // Road casings first, then fills and strokes, labels last.
  for (const { p, path } of list) {
    if (!p.casing || !p.stroke) continue;
    g.strokeStyle = p.casing;
    g.lineWidth = (p.width + 1) * lw;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.setLineDash([]);
    g.stroke(path);
  }
  for (const { p, path, labels } of list) {
    if (p.fill && !p.label) {
      g.globalAlpha = p.fillAlpha ?? 1;
      g.fillStyle = p.fill;
      g.fill(path); // nonzero: MVT holes wind the other way, and overlapping polygons of one paint stay filled
      g.globalAlpha = 1;
    }
    if (p.stroke && !p.label) {
      g.strokeStyle = p.stroke;
      g.lineWidth = (p.width ?? 1) * lw;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.setLineDash(p.dash ? p.dash.map((d) => d * dpr) : []);
      g.stroke(path);
    }
    if (p.label && labels.length) {
      g.setLineDash([]);
      // Place names are data in their own languages, centred on their points, drawn in the decode
      // worker: the style's generic family lets the browser pick a font per script, and the
      // direction stays the canvas default (each name's bidi runs still order themselves).
      g.font = p.font.replace(/(\d+)px/, (_, n) => `${Math.round(n * dpr)}px`);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 3 * dpr;
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.fillStyle = '#333';
      for (const [x, y, t] of labels) {
        g.strokeText(t, x, y);
        g.fillText(t, x, y);
      }
    }
  }
}

/** Background colour for a tile set: land colour for known basemap schemas, else transparent. */
export function backgroundFor(vt) {
  return knownSchema(Object.keys(vt.layers)) ? BACKGROUND : null;
}

// ---- identify ----

function distSeg(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + t * dx - px, a.y + t * dy - py);
}

function inRing(px, py, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if (r[i].y > py !== r[j].y > py && px < ((r[j].x - r[i].x) * (py - r[i].y)) / (r[j].y - r[i].y) + r[i].x) inside = !inside;
  }
  return inside;
}

/**
 * Features of a tile under a point (tile coordinates of the 0..1 square: u, v) within `tol`
 * (fraction of the tile): [{layer, id, type, properties}], points and lines first.
 */
export function queryTile(vt, u, v, tol = 0.01) {
  const hits = [];
  for (const [name, l] of Object.entries(vt.layers)) {
    const px = u * l.extent;
    const py = v * l.extent;
    const t = tol * l.extent;
    for (let i = 0; i < l.length; i++) {
      const f = l.feature(i);
      const g = f.loadGeometry();
      let d = Infinity;
      if (f.type === 1) for (const r of g) for (const p of r) d = Math.min(d, Math.hypot(p.x - px, p.y - py));
      else if (f.type === 2) for (const r of g) for (let j = 0; j + 1 < r.length; j++) d = Math.min(d, distSeg(px, py, r[j], r[j + 1]));
      else if (f.type === 3) {
        let inside = false;
        for (const r of g) if (inRing(px, py, r)) inside = !inside;
        d = inside ? t : Infinity;
      }
      if (d <= t) hits.push({ layer: name, id: f.id ?? null, type: ['Unknown', 'Point', 'LineString', 'Polygon'][f.type], properties: { ...f.properties }, rank: f.type === 3 ? 2 : f.type === 2 ? 1 : 0, d });
    }
  }
  return hits.sort((a, b) => a.rank - b.rank || a.d - b.d).map(({ rank, d, ...h }) => (void rank, void d, h));
}

/** Layer names, feature counts and geometry kinds of a tile (for metadata and identify). */
export function tileSummary(vt) {
  return Object.entries(vt.layers).map(([name, l]) => ({ name, extent: l.extent, features: l.length, version: l.version }));
}
