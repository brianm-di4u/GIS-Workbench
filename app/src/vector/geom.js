// Feature geometry (REQ-EXT-08, Research/13 §4.1): one flat lon, lat, HAE array per feature with
// part offsets (rings or lines) and polygon offsets (parts per polygon), WGS 84 with Z in metres
// above the ellipsoid. Records keep plain arrays so the store, undo and project files stay
// JSON; `typed(geom)` gives the Float64Array/Int32Array view the index and editing maths use.
//
//   Point            xyz [x,y,z]                 parts [0]          polys []
//   LineString       xyz n×3                     parts [0]          polys []
//   Polygon          xyz (rings, open)           parts ring starts  polys [0]
//   Multi*           members as above            parts per member   polys polygon → first part

export const TYPES = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon'];

const cache = new WeakMap();
/** Typed view of a geometry (memoised per object). */
export function typed(g) {
  let t = cache.get(g);
  if (!t) {
    t = { xyz: Float64Array.from(g.xyz), parts: Int32Array.from(g.parts), polys: Int32Array.from(g.polys ?? []) };
    cache.set(g, t);
  }
  return t;
}

export const vertexCount = (g) => g.xyz.length / 3;

/** [start, end) vertex range of each part. */
export function partRanges(g) {
  const n = vertexCount(g);
  return g.parts.map((s, i) => [s, i + 1 < g.parts.length ? g.parts[i + 1] : n]);
}

/** Vertices of each part as [[lon, lat, h], …]. */
export function parts(g) {
  return partRanges(g).map(([a, b]) => {
    const out = [];
    for (let i = a; i < b; i++) out.push([g.xyz[3 * i], g.xyz[3 * i + 1], g.xyz[3 * i + 2]]);
    return out;
  });
}

export const vertex = (g, i) => [g.xyz[3 * i], g.xyz[3 * i + 1], g.xyz[3 * i + 2]];

/** Index of the part holding vertex i. */
export function partOf(g, i) {
  let p = 0;
  while (p + 1 < g.parts.length && g.parts[p + 1] <= i) p++;
  return p;
}

export const isPolygonal = (g) => g.type === 'Polygon' || g.type === 'MultiPolygon';
export const isLinear = (g) => g.type === 'LineString' || g.type === 'MultiLineString';

/** Build a geometry from parts ([[lon, lat, h], …] each) and, for polygons, polygon groups. */
export function fromParts(type, ps, polys = null) {
  // Empty parts are dropped (a KML innerBoundaryIs without coordinates): every consumer reads a
  // ring's first vertex, and Validate Features failed on "reading '0'" (CX-083). A polygon whose
  // outer ring is empty goes with it.
  if (ps.some((p) => !p.length)) {
    if (type === 'Polygon' || type === 'MultiPolygon') {
      const P = polys?.length ? polys : [0];
      const rings = [];
      const groups = [];
      P.forEach((s, g) => {
        const grp = ps.slice(s, P[g + 1] ?? ps.length);
        if (!grp[0]?.length) return;
        groups.push(rings.length);
        rings.push(...grp.filter((r) => r.length));
      });
      ps = rings;
      polys = groups;
    } else ps = ps.filter((p) => p.length);
  }
  const xyz = [];
  const starts = [];
  for (const p of ps) {
    starts.push(xyz.length / 3);
    for (const v of p) xyz.push(v[0], v[1], v[2] ?? 0);
  }
  return { type, xyz, parts: starts, polys: polys ?? (type === 'Polygon' ? [0] : []) };
}

export function bbox(g) {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.xyz.length; i += 3) {
    const x = g.xyz[i];
    const y = g.xyz[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

const close = (a, b) => a[0] === b[0] && a[1] === b[1];
const openRing = (r) => (r.length > 1 && close(r[0], r.at(-1)) ? r.slice(0, -1) : r);

/** GeoJSON geometry → geometry (rings opened, Z default h0); GeometryCollection → array. */
export function fromGeoJSON(geo, h0 = 0) {
  if (!geo) return null;
  const P = (c) => [c[0], c[1], c[2] ?? h0];
  switch (geo.type) {
    case 'Point':
      return fromParts('Point', [[P(geo.coordinates)]]);
    case 'MultiPoint':
      return fromParts('MultiPoint', geo.coordinates.map((c) => [P(c)]));
    case 'LineString':
      return fromParts('LineString', [geo.coordinates.map(P)]);
    case 'MultiLineString':
      return fromParts('MultiLineString', geo.coordinates.map((l) => l.map(P)));
    case 'Polygon':
      return fromParts('Polygon', geo.coordinates.map((r) => openRing(r).map(P)), [0]);
    case 'MultiPolygon': {
      const ps = [];
      const polys = [];
      for (const poly of geo.coordinates) {
        polys.push(ps.length);
        for (const r of poly) ps.push(openRing(r).map(P));
      }
      return fromParts('MultiPolygon', ps, polys);
    }
    case 'GeometryCollection':
      return geo.geometries.map((x) => fromGeoJSON(x, h0));
    default:
      throw new Error(`unknown geometry type ${geo.type}`);
  }
}

/** Polygon groups: [[ring, ring…], …] of parts for (Multi)Polygon. */
export function polygonGroups(g) {
  const ps = parts(g);
  const starts = g.polys?.length ? g.polys : [0];
  return starts.map((s, i) => ps.slice(s, i + 1 < starts.length ? starts[i + 1] : ps.length));
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Geometry → RFC 7946 GeoJSON geometry: [lon, lat, h], closed rings, outer CCW, holes CW. */
export function toGeoJSON(g, digits = 9) {
  const P = (v) => [round(v[0], digits), round(v[1], digits), round(v[2], 3)];
  const ring = (r, outer) => {
    const c = r.map(P);
    const ccw = signedArea(r) > 0;
    const o = ccw === outer ? c : c.reverse();
    return [...o, o[0]];
  };
  switch (g.type) {
    case 'Point':
      return { type: 'Point', coordinates: P(vertex(g, 0)) };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: parts(g).map((p) => P(p[0])) };
    case 'LineString':
      return { type: 'LineString', coordinates: parts(g)[0].map(P) };
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: parts(g).map((l) => l.map(P)) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: parts(g).map((r, i) => ring(r, i === 0)) };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: polygonGroups(g).map((rs) => rs.map((r, i) => ring(r, i === 0))) };
    default:
      throw new Error(`unknown geometry type ${g.type}`);
  }
}

/** Signed area in degrees² (counter-clockwise positive), for orientation only. */
export function signedArea(r) {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Point in ring (lon/lat, even-odd). */
export function pointInRing(p, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygonal(p, g) {
  return polygonGroups(g).some((rs) => pointInRing(p, rs[0]) && !rs.slice(1).some((h) => pointInRing(p, h)));
}

// ---- vertex-level edits (return new geometries; the store keeps the old one for undo) ----

export function setVertex(g, i, v) {
  const xyz = g.xyz.slice();
  xyz.splice(3 * i, 3, v[0], v[1], v[2]);
  return { ...g, xyz };
}

/** Insert v before vertex index `at` of part p (at = part end appends). */
export function insertVertex(g, p, at, v) {
  const xyz = g.xyz.slice();
  xyz.splice(3 * at, 0, v[0], v[1], v[2]);
  const parts = g.parts.map((s, k) => (k > p ? s + 1 : s));
  return { ...g, xyz, parts };
}

export function deleteVertex(g, i) {
  const p = partOf(g, i);
  const [a, b] = partRanges(g)[p];
  const min = isPolygonal(g) ? 3 : isLinear(g) ? 2 : 1;
  if (b - a <= min) throw new Error(`a ${isPolygonal(g) ? 'ring' : 'line'} needs at least ${min} vertices`);
  const xyz = g.xyz.slice();
  xyz.splice(3 * i, 3);
  const parts = g.parts.map((s, k) => (k > p ? s - 1 : s));
  return { ...g, xyz, parts };
}

/** Vertices of every feature geometry coincident with v (to 1e-9°), for Snap Guard. */
export function coincident(g, v, tol = 1e-9) {
  const out = [];
  for (let i = 0; i < g.xyz.length; i += 3) if (Math.abs(g.xyz[i] - v[0]) <= tol && Math.abs(g.xyz[i + 1] - v[1]) <= tol) out.push(i / 3);
  return out;
}
