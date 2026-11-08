// Vector geoprocessing (REQ-GAP-79, SDP-2.7 §4.1): buffer, overlay, dissolve and spatial join on
// feature geometries (vector/geom.js records: lon, lat, h). DOM-free: the analysis worker runs it
// (workers/kinds/analysis.worker.js), and so do the unit tests.
//
// * Buffer and dissolve run in the `geoproc` WASM bundle (crates/gw-geoproc, i_overlay) on planar
//   coordinates. A buffer is made per feature: "planar" in a local equirectangular frame at the
//   feature, "geodesic" in an azimuthal equidistant frame at the feature built from WGS 84
//   geodesics (distances from the frame's centre are exact). Results cross the antimeridian as
//   pieces on either side of ±180°; a buffer that would reach a pole is refused.
// * Overlay and spatial join run here on polygon-clipping and rbush (S-62), pair by pair, so no
//   single call passes polygon-clipping's limit of 10⁶ sweep events. The frame of a layer pair is
//   an affine map of longitude and latitude, so overlay results are those of the input vertices.

import polygonClipping from 'polygon-clipping';
import RBush from 'rbush';
import { parts, polygonGroups, isPolygonal, isLinear, bbox, fromParts } from '../vector/geom.js';

const D2R = Math.PI / 180;
const A = 6378137;
const E2 = 6.69437999014e-3;

// ---- frames ----

/** lon − lon0 in (−180°, 180°], so a point at lon0 + 180° stays on its own side. */
function unwrapAbout(lon, lon0) {
  const d = lon - lon0;
  const w = d - 360 * Math.round(d / 360);
  return w === -180 && d > 0 ? 180 : w;
}

/** Local equirectangular frame about (lat0, lon0) in metres; longitudes are unwrapped about lon0. */
export function localFrame(lat0, lon0) {
  const s = Math.sin(lat0 * D2R);
  const w = Math.sqrt(1 - E2 * s * s);
  const kx = D2R * (A / w) * Math.cos(lat0 * D2R);
  const ky = D2R * ((A * (1 - E2)) / (w * w * w));
  return {
    kind: 'local',
    lat0,
    lon0,
    kx,
    ky,
    to: (lon, lat) => [unwrapAbout(lon, lon0) * kx, (lat - lat0) * ky],
    from: (x, y) => [lon0 + x / kx, lat0 + y / ky],
    // A ring is unwrapped vertex to vertex, so it is never torn across the frame's back meridian;
    // its first vertex goes within 180° of `anchor` (the frame centre, or its polygon's outer ring).
    ringTo(r, anchor = lon0) {
      let prev = anchor;
      return r.map((p) => {
        prev += unwrapAbout(p[0], prev);
        return [(prev - lon0) * kx, (p[1] - lat0) * ky];
      });
    },
  };
}

/** A geometry in frame F: {polys: [[ring …] …], lines: [line …], points: [[x, y] …]}, rings unwrapped whole. */
export function geomTo(g, F) {
  const ring = (r, anchor) => (F.ringTo ? F.ringTo(r, anchor) : r.map((p) => F.to(p[0], p[1])));
  if (isPolygonal(g))
    return {
      polys: polygonGroups(g).map((rs) => {
        const anchor = F.lon0 + unwrapAbout(rs[0][0][0], F.lon0);
        return rs.map((r) => ring(r, anchor));
      }),
      lines: [],
      points: [],
    };
  if (isLinear(g)) return { polys: [], lines: parts(g).map((l) => ring(l)), points: [] };
  return { polys: [], lines: [], points: parts(g).map((p) => F.to(p[0][0], p[0][1])) };
}

/**
 * Azimuthal equidistant frame about (lat0, lon0) from geodesics: `geo` = {inverse(lat1, lon1,
 * lat2, lon2) → {distance, azi1}, direct(lat1, lon1, azi1, s12) → {lat, lon}} (the core bundle).
 */
export function aeqdFrame(lat0, lon0, geo) {
  return {
    kind: 'aeqd',
    lat0,
    lon0,
    to(lon, lat) {
      const r = geo.inverse(lat0, lon0, lat, lon);
      const a = r.azi1 * D2R;
      return [r.distance * Math.sin(a), r.distance * Math.cos(a)];
    },
    from(x, y) {
      const r = geo.direct(lat0, lon0, Math.atan2(x, y) / D2R, Math.hypot(x, y));
      return [r.lon, r.lat];
    },
  };
}

/** Centre of a geometry's vertices, with longitudes unwrapped about its first vertex. */
export function centreOf(g) {
  const lon0 = g.xyz[0];
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.xyz.length; i += 3) {
    const x = lon0 + unwrapAbout(g.xyz[i], lon0);
    const y = g.xyz[i + 1];
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
  const lon = (x0 + x1) / 2;
  return { lat: (y0 + y1) / 2, lon: lon - 360 * Math.round(lon / 360) };
}

// ---- the geoproc encoding (crates/gw-geoproc) ----

/** Encode geometries in frame(s) for the bundle: `frameOf(i)` gives each one's frame. */
export function encodeGeoms(geoms, frameOf) {
  const v = [];
  const ring = (r) => {
    v.push(r.length);
    for (const p of r) v.push(p[0], p[1]);
  };
  geoms.forEach((g, i) => {
    const q = geomTo(g, frameOf(i));
    if (q.polys.length) {
      v.push(3, q.polys.length);
      for (const rs of q.polys) {
        v.push(rs.length);
        // The bundle unions with the non-zero rule: outer rings counter-clockwise and holes clockwise,
        // whatever order the source drew them in (KML, GML and digitised rings keep theirs).
        rs.forEach((r, k) => ring((planarArea(r) > 0) === (k === 0) ? r : [...r].reverse()));
      }
    } else if (q.lines.length) {
      v.push(2, q.lines.length);
      for (const l of q.lines) ring(l);
    } else {
      v.push(1, q.points.length);
      for (const p of q.points) v.push(p[0], p[1]);
    }
  });
  return Float64Array.from(v);
}

/** Signed area of a planar ring (counter-clockwise positive). */
function planarArea(r) {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const [p, q] = [r[i], r[(i + 1) % r.length]];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Decode the bundle's multipolygons: [[[[x, y] …] rings] polygons] per item. */
export function decodeShapes(v, count) {
  const out = [];
  let o = 0;
  for (let k = 0; k < count; k++) {
    const np = v[o++];
    const polys = [];
    for (let p = 0; p < np; p++) {
      const nr = v[o++];
      const rings = [];
      for (let r = 0; r < nr; r++) {
        const n = v[o++];
        const ring = new Array(n);
        for (let i = 0; i < n; i++) ring[i] = [v[o + 2 * i], v[o + 2 * i + 1]];
        o += 2 * n;
        rings.push(ring);
      }
      polys.push(rings);
    }
    out.push(polys);
  }
  return out;
}

/** Planar multipolygon → geometry record in lon, lat (height 0). Empty → null. */
export function toGeom(polys, F) {
  return lonLatGeom(polys.map((rs) => rs.map((r) => r.map(([x, y]) => F.from(x, y)))));
}

/** Lon, lat multipolygon (longitudes continuous, possibly past ±180°) → geometry record, cut at ±180°. */
function lonLatGeom(polys) {
  const pieces = splitAntimeridian(polys);
  if (!pieces.length) return null;
  const rings = [];
  const starts = [];
  for (const rs of pieces) {
    starts.push(rings.length);
    for (const r of rs) rings.push(r.map(([x, y]) => [x, y, 0]));
  }
  return fromParts(pieces.length === 1 ? 'Polygon' : 'MultiPolygon', rings, starts);
}

// ---- geodesic helpers ----

/** Split segments longer than `maxM` along their geodesics (lon, lat parts). */
function densify(ring, maxM, geo, closed) {
  const out = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    out.push(a);
    if (!closed && i === n - 1) break;
    const b = ring[(i + 1) % n];
    const r = geo.inverse(a[1], a[0], b[1], b[0]);
    const k = Math.ceil(r.distance / maxM);
    for (let j = 1; j < k; j++) {
      const q = geo.direct(a[1], a[0], r.azi1, (r.distance * j) / k);
      out.push([q.lon, q.lat, a[2] ?? 0]);
    }
  }
  return out;
}

/** The same geometry with long segments split along geodesics. */
export function densifyGeom(g, maxM, geo) {
  if (isPolygonal(g)) return fromParts(g.type, parts(g).map((r) => densify(r, maxM, geo, true)), g.polys);
  if (isLinear(g)) return fromParts(g.type, parts(g).map((l) => densify(l, maxM, geo, false)));
  return g;
}

/** Split planar edges longer than `maxM` (frame units) before mapping back. */
function densifyPlanar(polys, maxM) {
  return polys.map((rs) =>
    rs.map((r) => {
      const out = [];
      for (let i = 0; i < r.length; i++) {
        const a = r[i];
        const b = r[(i + 1) % r.length];
        out.push(a);
        const k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxM);
        for (let j = 1; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
      }
      return out;
    }),
  );
}

/**
 * Lon, lat multipolygon whose longitudes run continuously past ±180° → pieces within
 * [−180°, 180°], cut along the antimeridian.
 */
export function splitAntimeridian(polys) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const rs of polys) for (const r of rs) for (const p of r) [lo, hi] = [Math.min(lo, p[0]), Math.max(hi, p[0])];
  if (lo >= -180 && hi <= 180) return polys;
  const pc = polys.map((rs) => rs.map((r) => [...r.map((p) => [p[0], p[1]]), [r[0][0], r[0][1]]]));
  const out = [];
  for (const shift of [-360, 0, 360]) {
    const box = [[[-180 - shift, -90], [180 - shift, -90], [180 - shift, 90], [-180 - shift, 90], [-180 - shift, -90]]];
    for (const rs of polygonClipping.intersection(pc, box)) out.push(rs.map((r) => r.slice(0, -1).map(([x, y]) => [x + shift, y])));
  }
  return out;
}

// ---- buffer ----

/**
 * Buffer features by `distance` metres. `run(flat, d, cap, quadSegs)` is the bundle call
 * (decoded multipolygons, one per geometry); `geo` the geodesics for `geodesic: true`.
 * Returns one geometry (or null when nothing is left) per feature.
 */
export function bufferGeoms(geoms, { distance, cap = 'round', quadSegs = 8, geodesic = false, geo = null, run }) {
  const capCode = { round: 0, flat: 1, square: 2 }[cap];
  if (capCode === undefined) throw new Error(`unknown line end ${cap}`);
  if (geodesic && !geo) throw new Error('geodesic buffers need the geodesic functions');
  const frames = geoms.map((g) => {
    const c = centreOf(g);
    return geodesic ? aeqdFrame(c.lat, c.lon, geo) : localFrame(c.lat, c.lon);
  });
  // Long input segments follow their geodesics in the azimuthal frame.
  const input = geodesic ? geoms.map((g) => densifyGeom(g, 10000, geo)) : geoms;
  // A buffer that reaches a pole has no lon, lat polygon without a seam there. Vertices are at
  // most 10 km apart after densifying, so a margin of 5 km covers the points between them.
  if (geodesic)
    for (const g of input) {
      let maxLat = 0;
      for (let k = 1; k < g.xyz.length; k += 3) maxLat = Math.max(maxLat, Math.abs(g.xyz[k]));
      if ((90 - maxLat) * 110000 > Math.abs(distance) + 10000) continue;
      for (const pole of [90, -90]) {
        let near = Infinity;
        for (let k = 0; k < g.xyz.length; k += 3) near = Math.min(near, geo.inverse(pole, 0, g.xyz[k + 1], g.xyz[k]).distance);
        if (near <= Math.abs(distance) + 5000) throw Object.assign(new Error('a geodesic buffer that reaches a pole cannot be drawn as a polygon'), { code: 'E_BUFFER_POLE' });
      }
    }
  const shapes = run(encodeGeoms(input, (i) => frames[i]), distance, capCode, quadSegs);
  return shapes.map((polys, i) => {
    if (!polys.length) return null;
    const F = frames[i];
    if (!geodesic) return toGeom(polys, F);
    // Straight edges of the azimuthal frame are mapped back in steps of at most 1 km.
    const ll = densifyPlanar(polys, 1000).map((rs) => rs.map((r) => r.map(([x, y]) => F.from(x, y))));
    // Continuous longitudes about the centre, then cut at ±180°.
    return lonLatGeom(ll.map((rs) => rs.map((r) => r.map(([lon, lat]) => [F.lon0 + unwrapAbout(lon, F.lon0), lat]))));
  });
}

// ---- dissolve ----

/**
 * Dissolve polygons by the value of `field` (null: everything into one). Returns [{value, count,
 * geom}] in order of first appearance. `run(flat, groups)` is the bundle call.
 */
export function dissolveFeatures(features, { field = null, run }) {
  const polys = features.filter((f) => isPolygonal(f.geom));
  if (!polys.length) return [];
  const c = layerCentre(polys);
  const F = localFrame(c.lat, c.lon);
  const keys = new Map();
  const groups = polys.map((f) => {
    const v = field == null ? null : f.attrs?.[field] ?? null;
    const k = JSON.stringify(v);
    if (!keys.has(k)) keys.set(k, { value: v, count: 0, index: keys.size });
    const e = keys.get(k);
    e.count++;
    return e.index;
  });
  const shapes = run(encodeGeoms(polys.map((f) => f.geom), () => F), Float64Array.from(groups));
  return [...keys.values()].map((e) => ({ value: e.value, count: e.count, geom: toGeom(shapes[e.index], F) })).filter((r) => r.geom);
}

/** Centre of a layer's vertices, longitudes unwrapped about the first one, so a layer astride ±180° is centred there. */
function layerCentre(features) {
  const ref = features[0].geom.xyz[0];
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features)
    for (let i = 0; i < f.geom.xyz.length; i += 3) {
      const x = ref + unwrapAbout(f.geom.xyz[i], ref);
      const y = f.geom.xyz[i + 1];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  // A layer spanning more than 180° keeps the frame's seam at the antimeridian, where data is usually cut.
  const lon = x1 - x0 > 180 ? 0 : (x0 + x1) / 2;
  return { lat: (y0 + y1) / 2, lon: lon - 360 * Math.round(lon / 360) };
}

// ---- overlay ----

const toPC = (g, F) => geomTo(g, F).polys.map((rs) => rs.map((r) => [...r, r[0]]));
const fromPC = (mp, F) => (mp.length ? lonLatGeom(mp.map((rs) => rs.map((r) => r.slice(0, -1).map(([x, y]) => F.from(x, y))))) : null);
const boxOf = (g, F) => {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const q = geomTo(g, F);
  for (const p of [...q.polys.flat(2), ...q.lines.flat(), ...q.points]) [x0, y0, x1, y1] = [Math.min(x0, p[0]), Math.min(y0, p[1]), Math.max(x1, p[0]), Math.max(y1, p[1])];
  return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
};

/** Field names of B that clash with A's get a suffix: name → name_2. */
export function mergeFields(aFields, bFields) {
  const taken = new Set(aFields);
  const map = {};
  for (const f of bFields) {
    let n = f;
    for (let k = 2; taken.has(n); k++) n = `${f}_${k}`;
    taken.add(n);
    map[f] = n;
  }
  return map;
}

/**
 * Overlay of polygon layers A and B. op: 'intersect' (A ∩ B), 'union' (A ∩ B, A − B, B − A),
 * 'erase' (A − B) or 'symdiff' (A − B, B − A). Pieces carry A's attributes and B's (renamed by
 * mergeFields; absent where a piece has no B or no A). `job` = {progress(p), checkCancel()}.
 * Returns {features: [{geom, attrs}], failed: [{a, b, message}], bFieldMap}.
 */
export function overlay(aFeats, bFeats, op = 'intersect', { aFields = [], bFields = [], job = null, chunk = 64 } = {}) {
  if (!['intersect', 'union', 'erase', 'symdiff'].includes(op)) throw new Error(`unknown overlay ${op}`);
  const A = aFeats.filter((f) => isPolygonal(f.geom));
  const B = bFeats.filter((f) => isPolygonal(f.geom));
  const c = layerCentre([...A, ...B]);
  const F = localFrame(c.lat, c.lon);
  const pa = A.map((f) => toPC(f.geom, F));
  const pb = B.map((f) => toPC(f.geom, F));
  const tree = new RBush();
  tree.load(B.map((f, j) => ({ ...boxOf(f.geom, F), j })));
  const bMap = mergeFields(aFields, bFields);
  const bAttrs = (f) => Object.fromEntries(Object.entries(f.attrs ?? {}).map(([k, v]) => [bMap[k] ?? k, v]));
  const out = [];
  const failed = [];
  const hitsOfB = B.map(() => []);
  const safe = (fn, a, b) => {
    try {
      return fn();
    } catch (e) {
      failed.push({ a, b, message: String(e?.message ?? e) });
      return [];
    }
  };
  /** p − (all of qs), in chunks so no call passes the sweep limit. */
  const minus = (p, qs, a, b) => {
    let r = p;
    for (let k = 0; k < qs.length && r.length; k += chunk) r = safe(() => polygonClipping.difference(r, ...qs.slice(k, k + chunk)), a, b);
    return r;
  };
  const total = A.length + (op === 'union' || op === 'symdiff' ? B.length : 0);
  let done = 0;
  const tick = () => {
    if (job && ++done % 256 === 0) {
      job.checkCancel?.();
      job.progress?.(done / Math.max(1, total));
    }
  };
  A.forEach((fa, i) => {
    const cand = tree.search(boxOf(fa.geom, F)).map((h) => h.j);
    for (const j of cand) hitsOfB[j].push(i);
    if (op === 'intersect' || op === 'union')
      for (const j of cand) {
        const r = safe(() => polygonClipping.intersection(pa[i], pb[j]), i, j);
        if (r.length) out.push({ geom: fromPC(r, F), attrs: { ...fa.attrs, ...bAttrs(B[j]) } });
      }
    if (op !== 'intersect') {
      const r = minus(pa[i], cand.map((j) => pb[j]), i, null);
      if (r.length) out.push({ geom: fromPC(r, F), attrs: { ...fa.attrs } });
    }
    tick();
  });
  if (op === 'union' || op === 'symdiff')
    B.forEach((fb, j) => {
      const r = minus(pb[j], hitsOfB[j].map((i) => pa[i]), null, j);
      if (r.length) out.push({ geom: fromPC(r, F), attrs: bAttrs(fb) });
      tick();
    });
  return { features: out, failed, bFieldMap: bMap };
}

// ---- spatial join ----

function segs(q) {
  const s = [];
  for (const r of q.polys.flat()) for (let i = 0; i < r.length; i++) s.push([r[i], r[(i + 1) % r.length]]);
  for (const l of q.lines) for (let i = 0; i + 1 < l.length; i++) s.push([l[i], l[i + 1]]);
  return s;
}
const pts = (q) => [...q.polys.flat(2), ...q.lines.flat(), ...q.points];
function inRing(p, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolys = (p, ps) => ps.some((rs) => inRing(p, rs[0]) && !rs.slice(1).some((h) => inRing(p, h)));
function segDist(p, a, b) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const orient = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
/** Segments ab and cd share a point. */
function meets(a, b, c, d) {
  const [o1, o2, o3, o4] = [orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)];
  if (o1 !== o2 && o3 !== o4) return true;
  const on = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}
/** Segments ab and cd cross at a point inside both (not at an end, not along a shared line). */
const crossesProperly = (a, b, c, d) => orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;

/** Relation of geometries g and h in a frame: {intersects, within (g in h), contains (h in g), distance m}. */
export function relate(g, h, F) {
  const [gq, hq] = [geomTo(g, F), geomTo(h, F)];
  const [gs, hs] = [segs(gq), segs(hq)];
  const [gp, hp] = [pts(gq), pts(hq)];
  const [gP, hP] = [gq.polys, hq.polys];
  const onBoundary = (p, ss) => ss.some(([a, b]) => segDist(p, a, b) < 1e-6);
  const inOrOn = (p, P, ss) => inPolys(p, P) || onBoundary(p, ss);
  let touch = gs.some(([a, b]) => hs.some(([c, d]) => meets(a, b, c, d)));
  touch ||= gp.some((p) => inOrOn(p, hP, hs)) || hp.some((p) => inOrOn(p, gP, gs));
  // Points and point sets: a point on another point.
  if (!touch && !gs.length && !hs.length) touch = gp.some((p) => hp.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6));
  let distance = 0;
  if (!touch) {
    distance = Infinity;
    const hsP = hs.length ? hs : hp.map((q) => [q, q]);
    const gsP = gs.length ? gs : gp.map((q) => [q, q]);
    for (const p of gp) for (const [a, b] of hsP) distance = Math.min(distance, segDist(p, a, b));
    for (const p of hp) for (const [a, b] of gsP) distance = Math.min(distance, segDist(p, a, b));
  }
  // x within the polygons Y: every vertex of x in or on Y, and no edge of x crossing Y's boundary.
  // A hole of Y inside x also puts part of x outside Y.
  const inside = (xp, xs, XP, YP, ys) => YP.length > 0 && xp.every((p) => inOrOn(p, YP, ys)) && !xs.some(([a, b]) => ys.some(([c, d]) => crossesProperly(a, b, c, d))) && !YP.some((rs) => rs.slice(1).some((hole) => hole.some((q) => inPolys(q, XP))));
  return { intersects: touch, within: touch && inside(gp, gs, gP, hP, hs), contains: touch && inside(hp, hs, hP, gP, gs), distance };
}

/**
 * Spatial join: for every target, the join features that satisfy `predicate` ('intersects',
 * 'within' (the target within the join feature), 'contains' (the target contains it) or
 * 'nearest' (within `maxDistance` metres)), summarised as attributes: join_count, and for `field`
 * the sum, mean, min and max; with 'nearest' the nearest feature's attributes and join_distance.
 * Distances are taken in a frame at each target. Returns [{attrs}] per target, in order.
 */
export function spatialJoin(targets, joins, { predicate = 'intersects', field = null, maxDistance = Infinity, job = null, prefix = 'join' } = {}) {
  if (!['intersects', 'within', 'contains', 'nearest'].includes(predicate)) throw new Error(`unknown predicate ${predicate}`);
  const all = [...targets, ...joins];
  if (!all.length) return [];
  const c = layerCentre(all);
  const F0 = localFrame(c.lat, c.lon);
  const tree = new RBush();
  tree.load(joins.map((f, j) => ({ ...boxOf(f.geom, F0), j })));
  // Output names never overwrite a target field: a clash gets a suffix (join_count → join_count_2),
  // the same rule as overlay's mergeFields, decided once for the whole layer.
  const taken = new Set(targets.flatMap((t) => Object.keys(t.attrs ?? {})));
  const name = (n) => {
    let x = n;
    for (let k = 2; taken.has(x); k++) x = `${n}_${k}`;
    taken.add(x);
    return x;
  };
  const N = { count: name(`${prefix}_count`) };
  if (predicate === 'nearest') {
    N.distance = name(`${prefix}_distance`);
    N.attrs = Object.fromEntries([...new Set(joins.flatMap((f) => Object.keys(f.attrs ?? {})))].map((k) => [k, name(`${prefix}_${k}`)]));
  } else if (field != null) for (const st of ['sum', 'mean', 'min', 'max']) N[st] = name(`${prefix}_${field}_${st}`);
  return targets.map((t, i) => {
    if (job && i % 256 === 0) {
      job.checkCancel?.();
      job.progress?.(i / targets.length);
    }
    const ct = centreOf(t.geom);
    const F = localFrame(ct.lat, ct.lon);
    const box = boxOf(t.geom, F0);
    if (predicate === 'nearest') {
      // Grow the search box until a candidate is found and the box holds every closer one.
      let r = 50;
      let best = null;
      for (let k = 0; k < 40; k++) {
        // r true metres at the target, in the layer frame's units (they differ away from its latitude).
        const [rx, ry] = [(r * F0.kx) / F.kx, (r * F0.ky) / F.ky];
        const hits = tree.search({ minX: box.minX - rx, minY: box.minY - ry, maxX: box.maxX + rx, maxY: box.maxY + ry });
        for (const h of hits) {
          const d = relate(t.geom, joins[h.j].geom, F).distance;
          if (!best || d < best.d) best = { j: h.j, d };
        }
        if ((best && best.d <= r) || r > maxDistance) break;
        r *= 2;
      }
      if (!best || best.d > maxDistance) return { attrs: { ...t.attrs, [N.count]: 0, [N.distance]: null } };
      return { attrs: { ...t.attrs, ...Object.fromEntries(Object.entries(joins[best.j].attrs ?? {}).map(([k, v]) => [N.attrs[k], v])), [N.count]: 1, [N.distance]: best.d } };
    }
    const matched = tree.search(box).filter((h) => {
      const r = relate(t.geom, joins[h.j].geom, F);
      return predicate === 'intersects' ? r.intersects : predicate === 'within' ? r.within : r.contains;
    });
    const attrs = { ...t.attrs, [N.count]: matched.length };
    if (field != null) {
      // Missing values (null, empty, true / false) are left out, not counted as 0.
      const num = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
      const vals = matched.map((h) => num(joins[h.j].attrs?.[field])).filter(Number.isFinite);
      const sum = vals.reduce((s, v) => s + v, 0);
      Object.assign(attrs, { [N.sum]: vals.length ? sum : null, [N.mean]: vals.length ? sum / vals.length : null, [N.min]: vals.length ? Math.min(...vals) : null, [N.max]: vals.length ? Math.max(...vals) : null });
    }
    return { attrs };
  });
}
