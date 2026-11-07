// GeoPDF vector layers (REQ-GAP-66, SDP-2.3 §2 GR-24): the decode worker's `pdfVectors` read-out
// (crates/gw-parse/src/pdfvec.rs: features in PDF user space, structure-tree attributes or one
// feature per painted path of each optional-content layer) georeferenced through the page's
// viewports, as GDAL's PDF driver does it:
//   * a viewport's LPTS (unit square of its BBox) and GPTS (latitude, longitude in the datum of
//     its GCS) give control points; with a projected GCS (PROJCS: EPSG code or WKT) they become
//     projected X/Y through that CRS's own geographic system, the page → X/Y affine is fitted to
//     them (exact for a page drawn in the projection) and every vertex goes through it, then to
//     WGS 84 longitude/latitude;
//   * with a geographic GCS the affine maps straight to longitude/latitude (a datum other than
//     WGS 84 shifted through its CRS);
//   * pre-ISO pages (LGIDict) map page → X/Y by the dictionary's CTM in its UTM zone.
// A feature goes to the viewport holding its first vertex, else to the one it crosses into (a road
// that starts in the collar); features with no vertex in any viewport (map collars, legends) are
// left out and counted.

//
// This module is part of the lazy js-geopdf block: the app's own modules it uses (the i18n state,
// the CRS registry with the PROJ pack's definitions, proj4js, the vector readers) are handed in by
// init() from features/geopdf.js, so the block never carries second copies of them.

import { N_ } from '../i18n/index.js'; // only the marker: t() and the rest come from init()

let proj4, crsOf, converter, sameDatumGeographic, layerCrs, wkt1, unitsToMeters, forWorker, readGeoJSON, t, gwError, msgOf;

/** Hand in the app's modules (features/geopdf.js; tests pass the same modules). */
export function init(d) {
  ({ proj4, crsOf, converter, sameDatumGeographic, layerCrs, wkt1, unitsToMeters, forWorker, readGeoJSON, t, gwError, msgOf } = d);
}

/** Read-out note kinds (shown through t()). */
export const NOTE_KIND = { filter: N_('a content stream with the filter {filter} is not read'), objstm: N_('an object stream with the filter {filter} is not read') };

/** Least-squares affine [a, b, c, d, e, f] with X = a x + b y + c, Y = d x + e y + f, and its largest residual. */
export function fitAffine(pts) {
  // Normal equations of each output on (x, y, 1), centred for conditioning.
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const x = p.x - mx;
    const y = p.y - my;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-12)) return null;
  const solve = (k) => {
    const mv = pts.reduce((s, p) => s + p[k], 0) / n;
    let sxv = 0, syv = 0;
    for (const p of pts) {
      sxv += (p.x - mx) * (p[k] - mv);
      syv += (p.y - my) * (p[k] - mv);
    }
    const a = (sxv * syy - syv * sxy) / det;
    const b = (syv * sxx - sxv * sxy) / det;
    return [a, b, mv - a * mx - b * my];
  };
  const [a, b, c] = solve('X');
  const [d, e, f] = solve('Y');
  let res = 0;
  for (const p of pts) res = Math.max(res, Math.hypot(a * p.x + b * p.y + c - p.X, d * p.x + e * p.y + f - p.Y));
  return { m: [a, b, c, d, e, f], residual: res };
}

function isGeographic(crs) {
  try {
    return proj4.Proj(crs.def).projName === 'longlat';
  } catch {
    return /^\s*(GEOGCS|GEOGCRS)\[/i.test(String(crs?.def ?? ''));
  }
}

/** UTM zone (WGS 84) of a longitude/latitude. */
export const utmEpsg = (lon, lat) => (lat >= 0 ? 32600 : 32700) + Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));

/** The CRS of a GeoPDF frame: {epsg, crs, projected, wkt, fwd, inv, toLatLon, units, label}. */
export function frameCrs(epsg) {
  const crs = crsOf({ epsg });
  if (!crs) throw gwError('EPSG:{code} is not known to this build (open the PROJ pack)', { code: String(epsg) }, 'E_CRS_UNKNOWN');
  const lc = layerCrs({ info: { meta: { epsg } } });
  const projected = !!lc?.P && lc.kind !== 'longlat';
  const conv = converter(crs);
  let local = null;
  try {
    local = projected ? sameDatumGeographic(crs.def) : null;
  } catch {
    local = null;
  }
  return {
    epsg,
    crs,
    projected,
    label: crs.label,
    wkt: lc?.P ? wkt1(lc) : null,
    units: projected ? unitsToMeters(lc.P) : null,
    fwd: (lon, lat) => conv.fromLonLat(lon, lat),
    inv: (X, Y) => conv.toLonLat(X, Y),
    // GPTS: latitude/longitude in the CRS's own datum (no datum shift).
    toLatLon: projected ? (X, Y) => (local ? local.forward([X, Y]) : conv.toLonLat(X, Y)).slice(0, 2).reverse() : (X, Y) => [Y, X],
  };
}

/** The EPSG code of an LGIDict projection (UTM on NAD83, NAD27 or WGS 84), or null. */
export function lgiEpsg(pj = {}) {
  const zone = Number(pj.Zone);
  const south = /^S/i.test(pj.Hemisphere ?? '');
  const datum = String(pj.Datum ?? '').toUpperCase();
  // Datum as an LGIDict code (NAR, WE, NAS) or a description ("North_American_Datum_1983").
  const nad83 = /^NAR|NAD_?83|NORTH_AMERICAN_DATUM_1983|NORTH AMERICAN 1983/.test(datum);
  const nad27 = /^NAS|NAD_?27|NORTH_AMERICAN_DATUM_1927|NORTH AMERICAN 1927/.test(datum);
  const wgs84 = /^WE|WGS_?(19)?84/.test(datum) || !datum;
  const base = nad83 ? 26900 : nad27 ? 26700 : wgs84 ? (south ? 32700 : 32600) : null;
  return pj.ProjectionType === 'UT' && zone >= 1 && zone <= 60 && base ? base + zone : null;
}

/**
 * Page → WGS 84 transform of a viewport: {bbox, toLonLat(x, y) → [lon, lat], crs, residual}, or
 * {error} when its CRS is not known to this build.
 */
export function viewportTransform(vp) {
  const b = vp.bbox;
  const bbox = [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  const cps = [];
  for (let k = 0; k + 1 < vp.lpts.length && k + 1 < vp.gpts.length; k += 2) {
    const [lat, lon] = [vp.gpts[k], vp.gpts[k + 1]];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // LPTS are relative to the BBox as written (US Topo 2022 writes it top first; GDAL reads it so).
    cps.push({ x: b[0] + vp.lpts[k] * (b[2] - b[0]), y: b[1] + vp.lpts[k + 1] * (b[3] - b[1]), lat, lon });
  }
  if (cps.length < 3) return { bbox, error: gwError('a GeoPDF viewport has fewer than three control points') };
  const crs = vp.epsg && vp.epsg !== 4326 ? (crsOf({ epsg: vp.epsg, wkt: vp.wkt }) ?? crsOf({ wkt: vp.wkt })) : vp.wkt && !vp.epsg ? crsOf({ wkt: vp.wkt }) : null;
  if ((vp.epsg && vp.epsg !== 4326 && !crs) || (!vp.epsg && vp.wkt && !crs && /PROJCS|PROJCRS/i.test(vp.wkt))) return { bbox, error: gwError("a GeoPDF viewport's CRS ({crs}) is not known to this build (open the PROJ pack)", { crs: vp.epsg ? `EPSG:${vp.epsg}` : 'WKT' }) };
  if (crs && !isGeographic(crs)) {
    // GPTS are in the projection's own datum: to X/Y without a datum shift.
    let fwd;
    try {
      const local = sameDatumGeographic(crs.def);
      fwd = (lon, lat) => local.inverse([lon, lat]);
    } catch {
      const c = converter(crs);
      fwd = (lon, lat) => c.fromLonLat(lon, lat);
    }
    const pts = cps.map((p) => {
      const [X, Y] = fwd(p.lon, p.lat);
      return { x: p.x, y: p.y, X, Y };
    });
    const fit = fitAffine(pts);
    if (!fit) return { bbox, error: gwError("a GeoPDF viewport's control points are degenerate") };
    const [a, bb, c, d, e, f] = fit.m;
    const conv = converter(crs);
    return { bbox, crs, residual: fit.residual, toXY: (x, y) => [a * x + bb * y + c, d * x + e * y + f], toLonLat: (x, y) => conv.toLonLat(a * x + bb * y + c, d * x + e * y + f) };
  }
  const fit = fitAffine(cps.map((p) => ({ x: p.x, y: p.y, X: p.lon, Y: p.lat })));
  if (!fit) return { bbox, error: gwError("a GeoPDF viewport's control points are degenerate") };
  const [a, bb, c, d, e, f] = fit.m;
  const shift = crs ? converter(crs) : null; // a geographic GCS on another datum
  const ll = (x, y) => [a * x + bb * y + c, d * x + e * y + f];
  return { bbox, crs, residual: fit.residual, toXY: ll, toLonLat: shift ? (x, y) => shift.toLonLat(...ll(x, y)) : ll };
}

/** Page → WGS 84 of an LGIDict (CTM to UTM X/Y), or {error}. */
export function lgiTransform(lgi) {
  const epsg = lgiEpsg(lgi.projection);
  const crs = epsg ? crsOf({ epsg }) : null;
  const reg = (lgi.registration ?? []).filter((r) => r.length >= 4);
  if (!crs || (lgi.ctm?.length !== 6 && reg.length < 3)) return { error: gwError('LGIDict projection {proj} / datum {datum} is not read yet (UTM on NAD83, WGS 84 or NAD27 is)', { proj: String(lgi.projection?.ProjectionType ?? '?'), datum: String(lgi.projection?.Datum ?? '?') }) };
  // Registration points when there are three or more (as GDAL and the raster reader use them), else the CTM.
  const fit = reg.length >= 3 ? fitAffine(reg.map(([x, y, X, Y]) => ({ x, y, X, Y }))) : null;
  const [a, c, e, b, d, f] = fit ? fit.m : [lgi.ctm[0], lgi.ctm[2], lgi.ctm[4], lgi.ctm[1], lgi.ctm[3], lgi.ctm[5]];
  const nl = lgi.neatline?.length >= 8 ? lgi.neatline : null;
  const xs = nl ? nl.filter((_, i) => i % 2 === 0) : [-Infinity, Infinity];
  const ys = nl ? nl.filter((_, i) => i % 2 === 1) : [-Infinity, Infinity];
  const conv = converter(crs);
  return { bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], crs, residual: fit?.residual ?? 0, toXY: (x, y) => [a * x + c * y + e, b * x + d * y + f], toLonLat: (x, y) => conv.toLonLat(a * x + c * y + e, b * x + d * y + f) };
}

const firstVertex = (g) => {
  let c = g.coordinates;
  while (Array.isArray(c?.[0])) c = c[0];
  return c;
};

const allPoints = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(allPoints));

function mapCoords(c, f) {
  if (typeof c[0] === 'number') return f(c[0], c[1]);
  return c.map((x) => mapCoords(x, f));
}

/**
 * The read-out of one file → {layers: [{name, path, structured, features: GeoJSON Feature[]}],
 * outside (features outside every viewport), noGeometry, truncated, notes, errors}. `scan` is the
 * file's gw_pdf_scan result (viewports and LGIDict per page). xy: coordinates in the viewport's own
 * CRS (projected X/Y or degrees) instead of WGS 84 (comparisons with GDAL).
 */
export function geoPdfLayers(vec, scan, { xy = false } = {}) {
  const out = { layers: [], outside: 0, noGeometry: 0, truncated: 0, notes: [...(vec.notes ?? [])], errors: [] };
  for (const pg of vec.pages ?? []) {
    out.truncated += pg.truncated ?? 0;
    for (const n of pg.notes ?? []) if (!out.notes.includes(n)) out.notes.push(n);
    const sp = scan.pages.find((p) => p.object === pg.object);
    const tfs = (sp?.viewports ?? []).filter((v) => v.bbox?.length === 4 && v.gpts?.length >= 6).map(viewportTransform);
    if (!tfs.length && sp?.lgi?.length) tfs.push(lgiTransform(sp.lgi[0]));
    for (const v of tfs) if (v.error && !out.errors.some((e) => e.message === v.error.message)) out.errors.push(v.error);
    const ok = tfs.filter((v) => !v.error);
    // Smallest viewport first: an inset inside the main map owns what it draws.
    ok.sort((a, b) => (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]) - (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]));
    const layers = pg.layers.map((l) => ({ name: l.name, path: l.path, structured: !!pg.structured, features: [] }));
    for (const f of pg.features) {
      const L = layers[f.l];
      if (!L) continue;
      const props = { ...(f.a ?? {}) };
      const style = { stroke: f.s ?? null, fill: f.f ? `${f.f}80` : null, width: f.w > 0 ? Math.max(1, Math.min(8, f.w)) : 1 };
      if (!f.g) {
        out.noGeometry++;
        L.features.push({ type: 'Feature', geometry: null, properties: props, style });
        continue;
      }
      // The viewport holding the first vertex (insets first), else the one the feature crosses into.
      const [x, y] = firstVertex(f.g);
      const inBox = (q, px, py) => px >= q.bbox[0] - 1e-6 && px <= q.bbox[2] + 1e-6 && py >= q.bbox[1] - 1e-6 && py <= q.bbox[3] + 1e-6;
      let v = ok.find((q) => inBox(q, x, y));
      if (!v) {
        const pts = allPoints(f.g.coordinates);
        v = ok.findLast((q) => pts.some(([px, py]) => inBox(q, px, py)));
      }
      if (!v) {
        out.outside++;
        continue;
      }
      L.features.push({ type: 'Feature', geometry: { type: f.g.type, coordinates: mapCoords(f.g.coordinates, xy ? v.toXY : v.toLonLat) }, properties: props, style });
    }
    for (const L of layers) if (L.features.length) out.layers.push(L);
  }
  return out;
}

// Notes of the read-out → user-facing text (DN-62: every message through t()).
function noteText(n) {
  const i = n.indexOf(':');
  const kind = NOTE_KIND[n.slice(0, i)];
  return kind ? t(kind, { filter: n.slice(i + 1) }) : t('vector content: {note}', { note: n });
}

/** The most common value of a key over features (a layer's style). */
const mode = (xs) => {
  const m = new Map();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

/**
 * Read a GeoPDF's vector layers into the app (REQ-GAP-66) after `wait` (the raster's first tile:
 * the read-out does not hold it up). Returns the new vector layer ids; notes and refusals go to
 * the import log and one toast.
 */
export async function openGeoPdfVectors(app, file, { wait = null, report = null } = {}) {
  if (!app.addVectorLayer || !app.pool) return [];
  await wait;
  const rep = report ?? { file: file.name, kind: 'pdf', warnings: [], errors: [] };
  let got;
  try {
    got = await app.pool.run('pdfVectors', { file: forWorker(file) }, { label: t('GeoPDF vector layers of {file}', { file: file.name }) });
  } catch (e) {
    rep.warnings.push(t('GeoPDF vector layers not read: {msg}', { msg: msgOf(e) }));
    if (!report) app.importLog?.push(rep);
    return [];
  }
  const g = geoPdfLayers(got.vec, got.scan);
  for (const e of g.errors) rep.warnings.push(msgOf(e));
  for (const n of g.notes) rep.warnings.push(noteText(n));
  if (g.outside) rep.warnings.push(t('{n, plural, one {# feature outside the map frames (collar, legend) is} other {# features outside the map frames (collar, legend) are}} not read', { n: g.outside }));
  if (g.noGeometry) rep.warnings.push(t('{n, plural, one {# feature draws nothing and is} other {# features draw nothing and are}} left out', { n: g.noGeometry }));
  if (g.truncated) rep.warnings.push(t('{n, plural, one {# more path is} other {# more paths are}} not read (feature or vertex limit)', { n: g.truncated }));
  const ids = [];
  let total = 0;
  for (const L of g.layers) {
    const feats = L.features.filter((f) => f.geometry);
    if (!feats.length) continue;
    const { layer, report: lr } = readGeoJSON({ type: 'FeatureCollection', features: feats }, { name: L.path?.length > 1 ? L.path.join(' / ') : L.name });
    // The layer takes the most common drawing style; features drawn otherwise keep their own.
    const st = (f) => `${f.style.stroke ?? ''}|${f.style.fill ?? ''}|${f.style.width}`;
    const common = mode(feats.map(st));
    layer.features.forEach((f, i) => {
      if (st(feats[i]) !== common) f.style = { ...feats[i].style, stroke: feats[i].style.stroke ?? feats[i].style.fill?.slice(0, 7) ?? '#000000' };
    });
    lr.format = 'GeoPDF';
    const id = app.addVectorLayer(layer, { format: 'GeoPDF', file: file.name, report: lr });
    const s0 = feats.find((f) => st(f) === common).style;
    app.store?.transact?.('Style', (tx) => tx.set(id, 'style', { ...(app.store.get(id)?.style ?? {}), stroke: s0.stroke ?? s0.fill?.slice(0, 7) ?? '#000000', fill: s0.fill, width: s0.width }), { kind: 'load' });
    ids.push(id);
    total += layer.features.length;
  }
  // A map's worth of features (US Topo: 7,000-10,000) drawn on every frame would stop roaming
  // (3 fps measured): above SHOWN_MAX the layers open hidden, to be shown one by one.
  const hidden = total > SHOWN_MAX;
  if (hidden) app.store?.transact?.('Hide', (tx) => ids.forEach((id) => tx.set(id, 'visible', false)), { kind: 'load' });
  if (!report) app.importLog?.push(rep);
  if (ids.length) {
    const msg = hidden
      ? t('{file}: {n, plural, one {# vector layer} other {# vector layers}} ({count, plural, one {# feature} other {# features}}) from the GeoPDF, hidden: show the ones you need in the Layers panel', { file: file.name, n: ids.length, count: total })
      : t('{file}: {n, plural, one {# vector layer} other {# vector layers}} ({count, plural, one {# feature} other {# features}}) from the GeoPDF', { file: file.name, n: ids.length, count: total });
    app.toast?.(msg, { kind: 'info', ms: hidden ? 9000 : undefined });
    app.emit?.('state');
  }
  return ids;
}

/** Features above which a GeoPDF's vector layers open hidden. */
export const SHOWN_MAX = 2000;
