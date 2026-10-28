// Opening files (REQ-HOST-02, REQ-ARC-07/08): pickers or drag-and-drop, sidecar grouping,
// decode in a worker, fingerprints for relink, sensor models in the Rust core, marking.

import { fromNitf, highest, checkConsistency } from '../security/marking.js';
import { autoChain } from '../render/chain.js';
import { ImageLayer } from '../layers/image-layer.js';
import { newId } from '../core/util.js';
import { crsOf, converter, fittedMapModel } from '../geo/crs.js';

const IMAGE_EXT = /\.(ntf|nitf|nsf|r\d+|tif|tiff|gtiff|sid|jpg|jpeg|png|gif|bmp|webp|dt0|dt1|dt2|hgt|gz|img|dat|bsq|bil|bip|raw|h5|he5|hdf5|nc|pdf|jp2|jpx|j2k|j2c|jpf|gn[0-9a-j]|jn[0-9a-j]|on[0-9a-j]|tp[0-9a-j]|lf[0-9a-j]|ja[0-9a-j]|jr[0-9a-j]|tc[0-9a-j]|tl[0-9a-j]|i[1-5][0-9a-j])$/i;
const SIDECAR_EXT = /\.(jgw|pgw|tfw|tifw|sdw|wld|gfw|bpw|j2w|aux\.xml|prj|ovr|rpb|imd|til|att|eph|geo|clr|xml|hdr)$/i;

/** SHA-256 of the first and last 1 MiB plus the size (D1, REQ-ARC-08). */
export async function fingerprint(file) {
  const M = 1 << 20;
  const a = new Uint8Array(await file.slice(0, Math.min(M, file.size)).arrayBuffer());
  const b = file.size > M ? new Uint8Array(await file.slice(Math.max(M, file.size - M), file.size).arrayBuffer()) : new Uint8Array(0);
  const size = new TextEncoder().encode(String(file.size));
  const all = new Uint8Array(a.length + b.length + size.length);
  all.set(a);
  all.set(b, a.length);
  all.set(size, a.length + b.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Split a dropped/picked file list into primaries and their sidecars. */
export function groupFiles(files) {
  const byBase = new Map();
  const primaries = [];
  for (const f of files) {
    if (SIDECAR_EXT.test(f.name)) {
      const base = f.name.replace(/\.aux\.xml$/i, '').replace(/\.[^.]+$/, '').toLowerCase();
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(f);
    } else primaries.push(f);
  }
  return primaries.map((f) => {
    const base = f.name.replace(/\.[^.]+$/, '').toLowerCase();
    const full = f.name.toLowerCase();
    // A DIMAP volume's DIM_<stem>.XML describes IMG_<stem>[_RnCm].TIF (IMP-22).
    const dim = /^img_(.+?)(_r\d+c\d+)?$/.exec(base);
    const side = [...(byBase.get(base) ?? []), ...(byBase.get(full) ?? []), ...(dim ? byBase.get(`dim_${dim[1]}`) ?? [] : [])];
    return { file: f, sidecars: side };
  });
}

function parseWorldFile(text) {
  const v = text.trim().split(/\s+/).map(Number);
  if (v.length < 6 || v.some((x) => !Number.isFinite(x))) return null;
  // A B D E C F → GDAL geotransform with centre-of-pixel origin shifted to the corner.
  const [A, D, B, E, C, F] = v;
  return [C - A / 2 - B / 2, A, B, F - D / 2 - E / 2, D, E];
}

function parseAux(text) {
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    const gt = doc.querySelector('GeoTransform')?.textContent;
    const srs = doc.querySelector('SRS')?.textContent ?? doc.querySelector('WKT')?.textContent ?? '';
    const epsg = /AUTHORITY\["EPSG","(\d+)"\]\]\s*$/.exec(srs)?.[1] ?? /ID\["EPSG",(\d+)\]\]\s*$/.exec(srs)?.[1] ?? (/WGS 84|WGS_1984/.test(srs) && !/PROJCS|PROJCRS/.test(srs) ? '4326' : null);
    const utm = /UTM zone (\d+)([NS])/i.exec(srs);
    return {
      geotransform: gt ? gt.split(',').map(Number) : null,
      epsg: epsg ? Number(epsg) : utm ? (utm[2].toUpperCase() === 'N' ? 32600 : 32700) + Number(utm[1]) : null,
      srs: srs.slice(0, 2000),
    };
  } catch {
    return null;
  }
}

function epsgFromPrj(text) {
  if (/UTM[ _]zone[ _](\d+)([NS])/i.test(text)) {
    const m = /UTM[ _]zone[ _](\d+)([NS])/i.exec(text);
    return (m[2].toUpperCase() === 'N' ? 32600 : 32700) + Number(m[1]);
  }
  if (/GEOGCS\[/.test(text) && !/PROJCS\[/.test(text)) return 4326;
  if (/Pseudo-Mercator|Popular_Visualisation|3857/.test(text)) return 3857;
  return null;
}

function nitfBandRoles(ish) {
  return ish.bands.map((b) => b.IREPBAND);
}

/**
 * A map model from a geotransform: the core's native CRSs first (EPSG 4326, WGS 84 UTM/UPS,
 * 3857); any other EPSG code or WKT goes through proj4js and a fitted polynomial model whose
 * residual and datum accuracy are stated in the model note (REQ-GEO-04).
 */
function addMapModel(core, models, { gt, epsg, wkt, width, height, prefix }) {
  const label = `${prefix} (${epsg ? `EPSG:${epsg}` : 'WKT'})`;
  if (epsg) {
    try {
      const id = core.geotransformModel(gt, epsg);
      models.push({ name: label, id, info: core.modelInfo(id) });
      return;
    } catch (e) {
      if (!/not built in/i.test(e.message)) {
        models.push({ name: label, error: e.message });
        return;
      }
    }
  }
  const crs = crsOf({ epsg, wkt });
  if (!crs) {
    models.push({ name: label, error: `${epsg ? `EPSG:${epsg}` : 'the CRS'} is not in the embedded EPSG table and no usable WKT came with the file` });
    return;
  }
  try {
    const f = fittedMapModel(core, gt, crs, width, height, `${prefix} (${crs.label})`);
    const info = core.modelInfo(f.id);
    const shift = Number.isFinite(crs.note.acc) && crs.note.acc > 0 ? ` (datum shift good to about ${crs.note.acc} m)` : Number.isNaN(crs.note.acc) ? ' (datum unknown: treated as WGS 84)' : '';
    info.note = `${crs.label} through ${crs.conv ? 'PROJ (data pack)' : 'proj4js'}; datum ${crs.note.name}${shift}; polynomial fit residual ≤ ${f.residualMax.toFixed(3)} m`;
    models.push({ name: `${prefix} (${crs.label}, fitted)`, id: f.id, info, crs: crs.label, datum: crs.note, residual: f.residualMax });
  } catch (e) {
    models.push({ name: label, error: e.message });
  }
}

/**
 * MIE4NITF frame timing from an image segment's MTIMSA TRE (REQ-FMT-14): {segment, time (ISO),
 * timeMs, frames, frameRate, camera, layer}, or null. The segment's first frame is at
 * BASE_TIMESTAMP + DT[0] × DT_MULTIPLIER (nanoseconds).
 */
export function mieOf(ish) {
  const t = ish?.tres?.find((x) => x.tag === 'MTIMSA');
  if (!t?.fields) return null;
  const f = Object.fromEntries(t.fields);
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.(\d+))?$/.exec(String(f.BASE_TIMESTAMP ?? '').trim());
  if (!m) return null;
  const frac = (m[7] ?? '').padEnd(9, '0').slice(0, 9);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + Number(frac) / 1e6;
  const mult = Number(f.DT_MULTIPLIER ?? 0);
  const dt0 = Number(t.fields.find(([k]) => /^DT(\b|\[|_?0)/.test(k) && !/^DT_(SIZE|MULTIPLIER)$/.test(k))?.[1] ?? 0);
  const offMs = Number.isFinite(dt0 * mult) ? (dt0 * mult) / 1e6 : 0;
  return { segment: Number(f.IMAGE_SEG_INDEX), time: new Date(ms + offMs).toISOString(), timeMs: ms + offMs, frames: Number(f.NUMBER_FRAMES) || 1, frameRate: Number(f.NOMINAL_FRAME_RATE) || null, camera: String(f.CAMERA_ID ?? '').trim(), layer: String(f.LAYER_ID ?? '').trim() };
}

/**
 * IGEOLO corners in the order UL, UR, LR, LL. Some producers (CADRG test frames among them) list
 * them column by column or across the antimeridian: longitudes are unwrapped (east of 180°
 * becomes > 180) and a self-intersecting quadrilateral is reordered by position.
 */
export function orderCorners(corners) {
  let pts = corners.map(([la, lo]) => [la, lo]);
  const notes = [];
  const lons = pts.map((p) => p[1]);
  if (Math.max(...lons) - Math.min(...lons) > 180) {
    pts = pts.map(([la, lo]) => [la, lo < 0 ? lo + 360 : lo]);
    notes.push('antimeridian unwrapped');
  }
  const cross = (a, b, c, d) => {
    const o = (p, q, r) => Math.sign((q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]));
    return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
  };
  const simple = (q) => !cross(q[0], q[1], q[2], q[3]) && !cross(q[1], q[2], q[3], q[0]);
  if (!simple(pts)) {
    // By position: north edge first (UL west of UR), then the south edge east to west.
    const byLat = [...pts].sort((a, b) => b[0] - a[0]);
    const [n1, n2] = byLat.slice(0, 2).sort((a, b) => a[1] - b[1]);
    const [s1, s2] = byLat.slice(2).sort((a, b) => b[1] - a[1]);
    pts = [n1, n2, s1, s2];
    notes.push('corner order repaired');
  }
  return { pts, note: notes.join(', ') };
}

/**
 * RPF (CADRG/CIB) frame georeferencing (IMP-14, TE-031). IGEOLO gives the frame's outer corners in
 * file order (UL, UR, LR, LL), i.e. pixel edges, not corner-pixel centres. Frames of ARC zones 1–8
 * and 10–17 are equal-arc, so latitude/longitude are affine in the pixels; the polar zones 9 and 18
 * use the ARC azimuthal equidistant projection on a sphere of radius 6 378 137 m centred on the pole,
 * in which the frame is affine. Returns [label, model factory] for buildModels' add().
 */
export function rpfFrameModel(core, corners, W, H, edges) {
  let pts = corners.map(([la, lo]) => [la, lo]);
  if (Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1])) > 180) pts = pts.map(([la, lo]) => [la, lo < 0 ? lo + 360 : lo]);
  // Coverage-section corners bound the frame (pixel edges); IGEOLO's are corner-pixel centres.
  const e = edges ? 0 : 0.5;
  const edge = [
    [e, e],
    [W - e, e],
    [W - e, H - e],
    [e, H - e],
  ];
  if (!isPolarQuad(pts)) {
    const label = edges ? 'RPF frame (coverage section)' : 'RPF frame (IGEOLO, approximate)';
    return [label, () => core.gcpModel(pts.map(([lat, lon], i) => ({ x: edge[i][0], y: edge[i][1], lat, lon })), 4, label)];
  }
  const north = pts[0][0] > 0;
  const R = 6378137;
  const d2r = Math.PI / 180;
  const fwd = (lat, lon) => {
    const rho = R * (Math.PI / 2 - Math.abs(lat) * d2r);
    return [rho * Math.sin(lon * d2r), (north ? -1 : 1) * rho * Math.cos(lon * d2r)];
  };
  // Least-squares affine pixel → (x, y) through the four projected corners.
  const P = pts.map(([la, lo]) => fwd(la, lo));
  const solve = (k) => {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    edge.forEach(([c, r], i) => {
      const v = [1, c, r];
      for (let a = 0; a < 3; a++) {
        b[a] += v[a] * P[i][k];
        for (let q = 0; q < 3; q++) A[a][q] += v[a] * v[q];
      }
    });
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(A);
    return [0, 1, 2].map((col) => det(A.map((row, i) => row.map((v, j) => (j === col ? b[i] : v)))) / D);
  };
  const [gx, gy] = [solve(0), solve(1)];
  const label = `RPF frame, ARC zone ${north ? 9 : 18} (polar azimuthal equidistant${edges ? '' : '; IGEOLO, approximate'})`;
  // The exact projection in the core (internal code 990009 north / 990018 south): an order-3
  // polynomial in latitude/longitude misses a polar frame by kilometres.
  return [label, () => core.geotransformModel([gx[0], gx[1], gx[2], gy[0], gy[1], gy[2]], north ? 990009 : 990018)];
}

/** A corner quadrilateral of an ARC polar zone: not an equal-arc rectangle, at high latitude. */
function isPolarQuad(pts) {
  const rect = Math.abs(pts[0][0] - pts[1][0]) < 1e-6 && Math.abs(pts[3][0] - pts[2][0]) < 1e-6 && Math.abs(pts[0][1] - pts[3][1]) < 1e-6 && Math.abs(pts[1][1] - pts[2][1]) < 1e-6;
  return !rect && Math.min(...pts.map((p) => Math.abs(p[0]))) >= 60 && pts.every((p) => Math.sign(p[0]) === Math.sign(pts[0][0]));
}

/** RPF coverage section corners [[lat, lon] UL, UR, LR, LL] from the RPFIMG location table. */
async function rpfCoverage(file, tre) {
  const t = new DataView(await file.slice(tre.offset, tre.offset + tre.length).arrayBuffer());
  const sec = t.getUint32(2);
  const n = t.getUint16(6);
  if (t.getUint16(8) !== 10) return null;
  for (let k = 0; k < n; k++) {
    if (t.getUint16(sec + 10 * k) !== 130) continue;
    const off = t.getUint32(sec + 10 * k + 6);
    const c = new DataView(await file.slice(off, off + 64).arrayBuffer());
    if (c.byteLength < 64) return null;
    const v = Array.from({ length: 8 }, (_, i) => c.getFloat64(8 * i));
    const [nwLat, nwLon, swLat, swLon, neLat, neLon, seLat, seLon] = v;
    const pts = [[nwLat, nwLon], [neLat, neLon], [seLat, seLon], [swLat, swLon]];
    return pts.every(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 360) ? pts : null;
  }
  return null;
}

/** Build the sensor model(s) for a raster and pick the active one (REQ-SNS-06). */
function buildModels(app, kind, res, raster, ish, side) {
  const core = app.core;
  const models = [];
  const add = (name, fn) => {
    try {
      const id = fn();
      models.push({ name, id, info: core.modelInfo(id) });
    } catch (e) {
      models.push({ name, error: e.message });
    }
  };
  // SICD Volume 3 / SIDD PlaneProjection (REQ-SAR-05, REQ-SAR-12): the rigorous SAR model.
  const sar = raster.sar;
  if (sar) {
    if (sar.record) add(sar.kind === 'SICD' ? `SICD Vol. 3 (${sar.gridType}/${sar.ifa})` : 'SIDD PlaneProjection', () => core.sicdModel(sar.record, sar.kind === 'SICD' ? `SICD ${sar.gridType}` : 'SIDD plane'));
    else if (sar.recordError) models.push({ name: `${sar.kind} projection`, error: sar.recordError });
  }
  if (kind === 'nitf' && ish) {
    if (ish.rpc) {
      const rec = ish.rpc.slice(0, 92);
      // ICHIPB chip → full image affine (corner-origin both sides).
      rec.push(...(ish.ichipb ?? [0, 0, 0, 0, 0, 0]));
      add(ish.rpcKind === 'RPC00A' ? 'RPC00A (remapped)' : 'RPC00B', () => core.rpcModel(rec));
    }
    if (ish.rsmTres) add('RSM polynomial (experimental)', () => core.rsmModel(app.rsmFromSubheader(ish)));
    if (ish.corners?.length === 4) {
      // IGEOLO corners are pixel centres of the corner pixels.
      const W = ish.NCOLS;
      const H = ish.NROWS;
      const px = [
        [0.5, 0.5],
        [W - 0.5, 0.5],
        [W - 0.5, H - 0.5],
        [0.5, H - 0.5],
      ];
      const rpf = ish.tres?.some((t) => /^RPF(HDR|IMG)$/.test(t.tag)) || /^(CADRG|CIB)/.test(ish.IID1 ?? '');
      if (rpf && ish.rpfCoverage) add(...rpfFrameModel(core, ish.rpfCoverage, W, H, true));
      else if (rpf && isPolarQuad(ish.corners)) add(...rpfFrameModel(core, ish.corners, W, H, false));
      else {
        const cc = orderCorners(ish.corners);
        const label = `IGEOLO corners (approximate${cc.note ? `; ${cc.note}` : ''})`;
        add(label, () => core.gcpModel(cc.pts.map(([lat, lon], i) => ({ x: px[i][0], y: px[i][1], lat, lon })), 4, label));
      }
    } else if ((ish.ICORDS === 'U' || ish.ICORDS === 'N' || ish.ICORDS === 'S') && /[1-9]/.test(ish.IGEOLO ?? '')) {
      try {
        const g = ish.IGEOLO;
        const W = ish.NCOLS;
        const H = ish.NROWS;
        const pts = [0, 1, 2, 3].map((i) => {
          const s = g.slice(i * 15, i * 15 + 15);
          let ll;
          if (ish.ICORDS === 'U') ll = core.mgrsToLatLon(s.trim());
          else {
            const zone = Number(s.slice(0, 2));
            const e = Number(s.slice(2, 8));
            const n = Number(s.slice(8, 15));
            ll = core.parse(`${zone}${ish.ICORDS === 'N' ? 'n' : 's'} ${e} ${n}`);
          }
          return ll;
        });
        const px = [
          [0.5, 0.5],
          [W - 0.5, 0.5],
          [W - 0.5, H - 0.5],
          [0.5, H - 0.5],
        ];
        add('IGEOLO corners (approximate)', () => core.gcpModel(pts.map((p, i) => ({ x: px[i][0], y: px[i][1], lat: p.lat, lon: p.lon })), 4, 'IGEOLO corners (approximate)'));
      } catch (e) {
        models.push({ name: 'IGEOLO', error: e.message });
      }
    }
  }
  if (side.rpc && !(kind === 'nitf' && ish?.rpc) && !(kind === 'tiff' && res.meta?.rpc)) {
    // .RPB sidecar (TE-004); a tile of a multi-tile product is offset into the full image (.TIL).
    const off = side.tiles?.[String(side.fileName ?? '').toLowerCase()] ?? side.tiles?.[Object.keys(side.tiles ?? {})[0]] ?? [0, 0];
    const chip = off[0] || off[1] ? [off[0], 1, 0, off[1], 0, 1] : [0, 0, 0, 0, 0, 0];
    add(`RPC (.RPB sidecar${off[0] || off[1] ? `, tile at ${off[0]},${off[1]}` : ''})`, () => core.rpcModel([...side.rpc, ...chip]));
  }
  if (kind === 'jp2') {
    // Standalone JPEG 2000 (TE-003): GeoJP2 / GMLJP2 geotransform, or a .j2w world file.
    const m = res.meta;
    const gt = m.geotransform ?? side.world;
    const epsg = m.epsg ?? side.aux?.epsg ?? side.epsg;
    if (gt && (epsg || side.prj)) addMapModel(core, models, { gt, epsg, wkt: side.prj || null, width: raster.width, height: raster.height, prefix: 'Map' });
    else if (gt) models.push({ name: 'geotransform', error: 'the JPEG 2000 file has a geotransform but no CRS' });
  }
  if (kind === 'tiff') {
    const m = res.meta;
    if (m.rpc) add('RPC (GeoTIFF tag)', () => core.rpcModel([...m.rpc, 0, 0, 0, 0, 0, 0]));
    const geographic = !m.epsg || m.epsg === 4326 || m.epsg === 4979;
    if (m.gcps?.length >= 3 && geographic) add(`GCPs (${m.gcps.length}, GeoTIFF)`, () => core.gcpModel(m.gcps, m.gcps.length >= 10 ? 2 : 1, 'GeoTIFF GCPs'));
    else if (m.gcps?.length >= 3) {
      // Projected GCPs (TE campaign): GeoTIFF stores them as X/Y in the file's CRS; convert to WGS 84.
      const crs = crsOf({ epsg: m.epsg, wkt: side.aux?.srs || side.prj || null });
      if (!crs) models.push({ name: 'GCPs', error: `GCPs in EPSG:${m.epsg}: the CRS is not known to this build (open the PROJ pack)` });
      else
        add(`GCPs (${m.gcps.length}, ${crs.label})`, () => {
          const conv = converter(crs);
          const g = m.gcps.map((q) => {
            const [lon, lat] = conv.toLonLat(q.lon, q.lat);
            return { ...q, lat, lon };
          });
          return core.gcpModel(g, g.length >= 10 ? 2 : 1, `GeoTIFF GCPs (${crs.label})`);
        });
    }
    const aux = side.aux;
    const gt = m.geotransform ?? aux?.geotransform ?? side.world;
    const epsg = m.epsg && m.epsg !== 32767 ? m.epsg : aux?.epsg ?? side.epsg;
    const wkt = aux?.srs || side.prj || null;
    if (gt && (epsg || wkt)) addMapModel(core, models, { gt, epsg, wkt, width: raster.width, height: raster.height, prefix: 'Map' });
    else if (gt) models.push({ name: 'geotransform', error: 'the file has a geotransform but no CRS (no EPSG code, .prj or .aux.xml)' });
  }
  if (kind === 'pdf' && res.meta.gcps?.length >= 4) {
    // GeoPDF viewport: GPTS are latitude/longitude in the GCS's datum whatever the projection
    // (ISO 32000-2 §12.10). NAD83 and WGS 84 differ by about 1 m; other datums are shifted
    // through the CRS when this build knows it (TE-001: US Topo uses NAD83 / UTM).
    const gcs = res.meta.epsg && res.meta.epsg !== 4326 ? crsOf({ epsg: res.meta.epsg, wkt: res.meta.wkt }) ?? crsOf({ wkt: res.meta.wkt }) : null;
    const nad83 = /NAD83|North American 1983|GRS 1980|GRS80/i.test(`${gcs?.label ?? ''} ${res.meta.wkt ?? ''}`) || [4269, 26900].some((b) => res.meta.epsg === b || (res.meta.epsg > 26900 && res.meta.epsg < 26961));
    const label = !gcs || nad83 ? (nad83 ? 'NAD83 taken as WGS 84, about 1 m' : 'WGS 84') : `${gcs.label}, datum shifted`;
    add(`GeoPDF viewport (${res.meta.gcps.length} points, ${label})`, () => {
      let g = res.meta.gcps;
      if (gcs && !nad83) {
        // Shift lat/lon from the GCS datum: geographic form of the CRS definition.
        const geog = typeof gcs.def === 'string' && /\+proj=/.test(gcs.def) ? gcs.def.replace(/\+proj=\S+/, '+proj=longlat').replace(/\+(zone|south|lat_\d|lon_0|lat_0|k(_0)?|x_0|y_0|units)=?\S*/g, '') : null;
        if (geog) {
          const conv = converter({ def: geog });
          g = g.map((q) => {
            const [lon, lat] = conv.toLonLat(q.lon, q.lat);
            return { ...q, lat, lon };
          });
        }
      }
      return core.gcpModel(g, 4, 'GeoPDF viewport (projective)');
    });
  }
  if (kind === 'pdf' && !res.meta.gcps && res.meta.lgi?.gcps?.length >= 3) {
    // Pre-ISO GeoPDF (LGIDict): projected control points; UTM zones on NAD83, WGS 84 or NAD27.
    const pj = res.meta.lgi.projection ?? {};
    const zone = Number(pj.Zone);
    const south = /^S/i.test(pj.Hemisphere ?? '');
    const datum = String(pj.Datum ?? '').toUpperCase();
    // Datum as an LGIDict code (NAR, WE, NAS) or a description ("North_American_Datum_1983").
    const nad83 = /^NAR|NAD_?83|NORTH_AMERICAN_DATUM_1983|NORTH AMERICAN 1983/.test(datum);
    const nad27 = /^NAS|NAD_?27|NORTH_AMERICAN_DATUM_1927|NORTH AMERICAN 1927/.test(datum);
    const wgs84 = /^WE|WGS_?(19)?84/.test(datum) || !datum;
    const base = nad83 ? 26900 : nad27 ? 26700 : wgs84 ? (south ? 32700 : 32600) : null;
    const epsg = pj.ProjectionType === 'UT' && zone >= 1 && zone <= 60 && base ? base + zone : null;
    const crs = epsg ? crsOf({ epsg }) : null;
    if (!crs) models.push({ name: 'GeoPDF LGIDict', error: `LGIDict projection ${pj.ProjectionType ?? '?'} / datum ${pj.Datum ?? '?'} is not read yet (UTM on NAD83, WGS 84 or NAD27 is)` });
    else
      add(`GeoPDF LGIDict (${crs.label}${datum ? '' : ', no datum stated: WGS 84 assumed'}, ${res.meta.lgi.gcps.length} points)`, () => {
        const conv = converter(crs);
        const g = res.meta.lgi.gcps.map((q) => {
          const [lon, lat] = conv.toLonLat(q.X, q.Y);
          return { x: q.x, y: q.y, lat, lon };
        });
        return core.gcpModel(g, g.length >= 6 ? 2 : 1, `GeoPDF LGIDict (${crs.label})`);
      });
  }
  if (kind === 'hdf5' && res.meta.gcps?.length >= 6) {
    // Swath geolocation grids (PRISMA Latitude/Longitude, EMIT location/lat, lon): a polynomial fit.
    add(`Geolocation grid (${res.meta.gcps.length} points, ${res.meta.product})`, () => core.gcpModel(res.meta.gcps, 3, `${res.meta.product} geolocation`));
  }
  if (kind === 'envi') {
    const mi = res.meta?.header?.mapInfo ?? [];
    const gt = enviGeotransform(mi);
    const wkt = res.meta.header.crs || side.prj || null;
    if (gt && (gt.epsg || wkt)) addMapModel(core, models, { gt: gt.gt, epsg: gt.epsg, wkt, width: raster.width, height: raster.height, prefix: 'Map' });
    else if (mi.length) models.push({ name: 'map info', error: `ENVI map info "${mi[0]}"${gt ? ` on datum "${mi[9]}"` : ''} is not read` });
  }
  if (kind === 'dem') {
    const g = res.gridInfo;
    add('Map (EPSG:4326)', () => core.geotransformModel([g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], 4326));
  }
  if (kind === 'picture') {
    const gt = side.aux?.geotransform ?? side.world;
    let epsg = side.aux?.epsg ?? side.epsg;
    if (gt && !epsg && Math.abs(gt[0]) <= 180 && Math.abs(gt[3]) <= 90 && Math.abs(gt[1]) < 1) epsg = 4326;
    const wkt = side.aux?.srs || side.prj || null;
    if (gt && (epsg || wkt)) addMapModel(core, models, { gt, epsg, wkt, width: raster.width, height: raster.height, prefix: 'World file' });
  }
  // Rigorous model first, then map models, then approximate corners (REQ-SNS-06 default).
  const order = (m) => (m.error ? 9 : /^SICD|^SIDD/.test(m.name) ? -1 : /^RPC/.test(m.name) ? 0 : /^RSM/.test(m.name) ? 0.5 : /^Map|World/.test(m.name) ? 1 : 2);
  models.sort((a, b) => order(a) - order(b));
  return models;
}

/** ENVI map info {proj, ref x, ref y, easting/lon, northing/lat, dx, dy, zone, N/S, datum} → geotransform. */
function enviGeotransform(mi) {
  if (mi.length < 7) return null;
  const v = mi.map((x) => Number(x));
  const [rx, ry, e, n, dx, dy] = [v[1], v[2], v[3], v[4], v[5], v[6]];
  if (![rx, ry, e, n, dx, dy].every(Number.isFinite)) return null;
  // TE-025: "rotation=θ" (AVIRIS ortho products) rotates the grid; same convention as GDAL's ENVI
  // driver: [x0, dx·cosθ, dy·sinθ, y0, dx·sinθ, −dy·cosθ], reference pixel offset along the axes.
  const rot = Number(/rotation\s*=\s*([-+0-9.eE]+)/i.exec(mi.join(','))?.[1] ?? 0);
  const t = (rot * Math.PI) / 180;
  const [a, b, c, d] = [dx * Math.cos(t), dy * Math.sin(t), dx * Math.sin(t), -dy * Math.cos(t)];
  const gt = [e - (rx - 1) * a - (ry - 1) * b, a, b, n - (rx - 1) * c - (ry - 1) * d, c, d];
  if (/^utm/i.test(mi[0])) {
    const zone = Number(mi[7]);
    const north = !/south/i.test(mi[8] ?? 'North');
    if (!Number.isInteger(zone) || zone < 1 || zone > 60) return null;
    // TE-048: the datum names ENVI writes ("North America 1983", "NAD 27", …), not WGS-84 only.
    // Another datum keeps the grid and leaves the CRS to the header's coordinate system string.
    const datum = mi[9] ?? 'WGS-84';
    if (/wgs.?84/i.test(datum)) return { gt, epsg: (north ? 32600 : 32700) + zone };
    if (/north america.?1983|nad.?83/i.test(datum) && north && zone <= 23) return { gt, epsg: 26900 + zone };
    if (/north america.?1927|nad.?27/i.test(datum) && north && zone <= 22) return { gt, epsg: 26700 + zone };
    return { gt, epsg: null };
  }
  if (/geographic/i.test(mi[0])) return { gt, epsg: 4326 };
  return null;
}

/**
 * Band names, centre wavelengths and FWHM (µm) and the radiometric state from the file
 * (REQ-MSI-01/05, AC-13.4): NITF BANDSB (or a numeric ISUBCAT in nm), GeoTIFF GDAL_METADATA,
 * the ENVI header.
 */
export function bandMetadata(kind, res, ish, nb) {
  let bands = null;
  let radiometry = { state: 'DN', gain: null, offset: null, unit: 'DN', source: 'file' };
  if (kind === 'nitf' && ish?.bandsb?.bands?.length) {
    const b = ish.bandsb;
    bands = b.bands.slice(0, nb).map((x, i) => ({ name: x.id || `Band ${i + 1}`, cw: x.cw, fwhm: x.fwhm, bad: x.bad }));
    const q = String(b.quantity ?? '').toUpperCase();
    const sc = Number.isFinite(b.scale) && b.scale !== 0 ? b.scale : 1;
    const of = Number.isFinite(b.offset) ? b.offset : 0;
    if (/REFL/.test(q)) radiometry = { state: 'reflectance', gain: Array(nb).fill(sc), offset: Array(nb).fill(of), unit: 'reflectance', source: 'BANDSB' };
    else if (/RADIANCE/.test(q)) radiometry = { state: 'radiance', gain: Array(nb).fill(sc), offset: Array(nb).fill(of), unit: 'W m⁻² sr⁻¹ µm⁻¹', source: 'BANDSB' };
  } else if (kind === 'nitf' && ish?.bands?.some((x) => /^\d{3,5}$/.test(String(x.ISUBCAT ?? '').trim()))) {
    bands = ish.bands.map((x, i) => {
      const n = Number(String(x.ISUBCAT).trim());
      return { name: `Band ${i + 1}${x.IREPBAND?.trim() ? ` (${x.IREPBAND.trim()})` : ''}`, cw: Number.isFinite(n) ? n / 1000 : NaN, fwhm: NaN, bad: false };
    });
  } else if (kind === 'tiff' && res.meta?.bandsMeta) {
    bands = res.meta.bandsMeta;
    if (Number.isFinite(res.meta.gdalScale) && res.meta.gdalScale !== 1) radiometry = { state: 'scaled', gain: Array(nb).fill(res.meta.gdalScale), offset: Array(nb).fill(res.meta.gdalOffset ?? 0), unit: 'scaled (GDAL SCALE)', source: 'GDAL_METADATA' };
  } else if (kind === 'hdf5') {
    bands = res.meta.bandsMeta;
    const r = res.meta.radiometry;
    if (r?.state && r.state !== 'DN') radiometry = { state: r.state, gain: r.gain ?? Array(nb).fill(1), offset: r.offset ?? Array(nb).fill(0), unit: r.unit, source: r.source };
  } else if (kind === 'envi') {
    const hd = res.meta.header;
    bands = res.meta.bandsMeta;
    if (Number.isFinite(hd.reflectanceScale) && hd.reflectanceScale > 0) radiometry = { state: 'reflectance', gain: Array(nb).fill(1 / hd.reflectanceScale), offset: Array(nb).fill(0), unit: 'reflectance', source: 'ENVI reflectance scale factor' };
    else if (hd.gain?.length === nb) radiometry = { state: 'radiance', gain: hd.gain, offset: hd.offset?.length === nb ? hd.offset : Array(nb).fill(0), unit: 'radiance (ENVI data gain values)', source: 'ENVI header' };
  }
  return { bands, radiometry };
}

/**
 * DigitalGlobe/Maxar .RPB (RPC00B as key = value text) → the 92-value record order used by the
 * GeoTIFF RPC tag (TE-004: Level-1B products carry their sensor model only in this sidecar).
 */
export function parseRpb(text) {
  const num = (k) => Number(new RegExp(`\\b${k}\\s*=\\s*([-+0-9.eE]+)`, 'i').exec(text)?.[1]);
  const list = (k) => {
    const m = new RegExp(`\\b${k}\\s*=\\s*\\(([^)]*)\\)`, 'i').exec(text);
    return m ? m[1].split(/[,\s]+/).filter(Boolean).map(Number) : [];
  };
  const head = ['errBias', 'errRand', 'lineOffset', 'sampOffset', 'latOffset', 'longOffset', 'heightOffset', 'lineScale', 'sampScale', 'latScale', 'longScale', 'heightScale'].map(num);
  const coef = ['lineNumCoef', 'lineDenCoef', 'sampNumCoef', 'sampDenCoef'].map(list);
  if (head.slice(2).some((v) => !Number.isFinite(v)) || coef.some((c) => c.length !== 20)) return null;
  return [...head.map((v) => (Number.isFinite(v) ? v : 0)), ...coef.flat()];
}

/** .TIL tile list → {file → [colOffset, rowOffset]} (tiles of one product image share its RPB). */
function parseTil(text) {
  const out = {};
  for (const m of text.matchAll(/BEGIN_GROUP\s*=\s*TILE_\d+([\s\S]*?)END_GROUP/gi)) {
    const f = /filename\s*=\s*"([^"]+)"/i.exec(m[1])?.[1];
    const c = Number(/ULColOffset\s*=\s*(-?\d+)/i.exec(m[1])?.[1] ?? 0);
    const r = Number(/ULRowOffset\s*=\s*(-?\d+)/i.exec(m[1])?.[1] ?? 0);
    if (f) out[f.toLowerCase()] = [c, r];
  }
  return out;
}

/**
 * Airbus DIMAP v2 product metadata (Pléiades, SPOT 6/7, Pléiades Neo; IMP-22): mission, processing
 * level, scene-centre time and sun/viewing angles, and the band display order (file bands are
 * B0 blue, B1 green, B2 red, B3 NIR, so RGB is B2 B1 B0).
 */
export function parseDimap(text) {
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror') || doc.documentElement.nodeName !== 'Dimap_Document') return null;
    const t = (sel, root = doc) => root.querySelector(sel)?.textContent?.trim() ?? null;
    const centre = [...doc.querySelectorAll('Located_Geometric_Values')].find((n) => t('LOCATION_TYPE', n) === 'Center') ?? null;
    const num = (sel) => {
      const v = centre ? Number(t(sel, centre)) : NaN;
      return Number.isFinite(v) ? v : null;
    };
    const band = (c) => /^B(\d+)$/.exec(t(`Band_Display_Order ${c}`) ?? '')?.[1];
    const order = ['RED_CHANNEL', 'GREEN_CHANNEL', 'BLUE_CHANNEL'].map(band);
    const time = (centre && t('TIME', centre)) || [t('IMAGING_DATE'), t('IMAGING_TIME')].filter(Boolean).join('T') || null;
    return {
      mission: [t('MISSION'), t('MISSION_INDEX')].filter(Boolean).join(' ') || null,
      level: t('PROCESSING_LEVEL'),
      spectral: t('SPECTRAL_PROCESSING'),
      time,
      sun: num('SUN_AZIMUTH') !== null && num('SUN_ELEVATION') !== null ? { azimuth: num('SUN_AZIMUTH'), elevation: num('SUN_ELEVATION'), source: 'DIMAP' } : null,
      viewing: num('VIEWING_ANGLE'),
      incidence: num('INCIDENCE_ANGLE'),
      rgb: order.every((x) => x !== undefined) ? order.map(Number) : null,
    };
  } catch {
    return null;
  }
}

async function readSidecars(sidecars) {
  const out = { aux: null, world: null, epsg: null, prj: null, rpc: null, tiles: null, dimap: null };
  for (const f of sidecars) {
    if (f.size > 4 << 20) continue;
    const text = await f.text();
    if (/\.aux\.xml$/i.test(f.name)) out.aux = parseAux(text);
    else if (/^DIM_.*\.xml$/i.test(f.name)) out.dimap = parseDimap(text);
    else if (/\.(jgw|pgw|tfw|tifw|sdw|wld|gfw|bpw|j2w)$/i.test(f.name)) out.world = parseWorldFile(text);
    else if (/\.rpb$/i.test(f.name)) out.rpc = parseRpb(text);
    else if (/\.til$/i.test(f.name)) out.tiles = parseTil(text);
    else if (/\.prj$/i.test(f.name)) {
      out.epsg = epsgFromPrj(text);
      out.prj = text.slice(0, 20000);
    }
  }
  return out;
}

/** Decode a file in a worker and describe its rasters (no store changes). */
export async function describe(app, file, sidecars = [], { merge = false } = {}) {
  const t0 = performance.now();
  // An ENVI .hdr sidecar makes the file an ENVI raw image (REQ-MSI-01).
  const hdr = sidecars.find((s) => /\.hdr$/i.test(s.name)) ?? null;
  const job = app.pool.run('open', { file, name: file.name, merge, hdr }, { label: `open ${file.name}`, timeout: 120000 });
  const [res, fp, side] = await Promise.all([job, fingerprint(file), readSidecars(sidecars)]);
  side.fileName = file.name;
  const affinity = app.pool.lastAffinity?.(job.jobId);
  const kind = res.kind;
  // EPSG codes outside the embedded table: the PROJ data pack defines them first (REQ-GEO-12).
  const pk = await app.proj?.prepare?.([res.meta?.epsg, side?.epsg, side?.aux?.epsg].map(Number));
  for (const d of pk ?? []) (res.header ??= {}).warnings = [...(res.header.warnings ?? []), `EPSG:${d.code} (${d.name}) defined by the PROJ data pack`];
  const fileMarking = kind === 'nitf' ? fromNitf(res.header.security, 'FS') : null;
  const segMarks = [];
  const report = { file: file.name, kind, warnings: [...(res.header?.warnings ?? [])], errors: [] };
  if (kind === 'nitf') for (const im of res.images) if (im.error) report.errors.push(`image segment ${im.index + 1}: ${im.error}`);
  const rasters = [];
  for (const raster of res.rasters) {
    const im = kind === 'nitf' ? res.images.find((i) => i.index === raster.imageIndex) : null;
    const ish = im?.subheader ?? null;
    // RSM TREs (REQ-SNS-03) are not in the TRE catalogue: read their text by offset.
    if (ish?.tres?.some((t) => t.tag === 'RSMPCA')) {
      const text = async (t) => (t ? new TextDecoder('latin1').decode(await file.slice(t.offset, t.offset + t.length).arrayBuffer()) : null);
      ish.rsmTres = { RSMIDA: await text(ish.tres.find((t) => t.tag === 'RSMIDA')), RSMPCA: await text(ish.tres.find((t) => t.tag === 'RSMPCA')) };
    }
    // RPF frames: the coverage section (MIL-STD-2411 location 130) holds the frame's outer corners
    // as IEEE doubles, more precise than IGEOLO's whole arc-seconds (IMP-14).
    const rpfimg = ish?.tres?.find((t) => t.tag === 'RPFIMG');
    if (rpfimg) {
      try {
        ish.rpfCoverage = await rpfCoverage(file, rpfimg);
      } catch {
        /* no usable coverage section: IGEOLO is used */
      }
    }
    const segMarking = ish ? fromNitf(ish.security, 'IS') : null;
    const spectral = bandMetadata(kind, res, ish, raster.bands);
    if (segMarking) segMarks.push(segMarking);
    const name = kind === 'nitf' ? `${file.name}${res.rasters.length > 1 ? ` [${raster.imageIndex + 1}]` : ''}${ish?.IID1 ? ` ${ish.IID1}` : ''}` : file.name;
    const info = {
      format: kind === 'nitf' ? `${res.header.format} ${res.header.version}` : res.meta?.format ?? kind,
      kind,
      fileName: file.name,
      header: kind === 'nitf' ? res.header : null,
      subheader: ish,
      others: kind === 'nitf' ? res.others : null,
      meta: res.meta ?? null,
      marking: segMarking ?? fileMarking,
      fileMarking,
      corners: null,
      sun: ish?.sun ?? null,
      icat: ish?.ICAT ?? (kind === 'dem' ? 'DTEM' : ''),
      irep: ish?.IREP ?? '',
      iid: ish?.IID1 || ish?.IID2 || file.name,
      datetime: String(ish?.IDATIM || res.header?.FDT || res.meta?.dateTime || '').replace(/\u0000/g, '').trim(),
      mie: mieOf(ish),
      affinity,
      heightOffset: ish?.rpc ? ish.rpc[6] : NaN,
      gridInfo: res.gridInfo ?? null,
      mosaic: res.merged ?? null,
      mergeable: !!res.mergeable,
      mergeNote: res.mergeNote ?? null,
      vertical: kind === 'dem' ? res.meta?.verticalDatum ?? 'EGM96' : null,
      bandsMeta: spectral.bands,
      radiometry: spectral.radiometry,
    };
    // SICD/SIDD metadata from the XML DES (REQ-SAR-01/02/12).
    if (raster.sar) {
      info.sar = raster.sar;
      if (raster.sar.kind === 'Complex GeoTIFF') {
        info.format = `Complex GeoTIFF (${raster.sar.pixelType} SLC)`;
        info.icat = 'SAR';
      } else if (raster.sar.kind === 'SICD' && !raster.sar.complex) info.format = `SAR product (SICD ${raster.sar.version} geometry)`;
      else if (raster.sar.kind === 'SICD') {
        info.format = `SICD ${raster.sar.version} (${raster.sar.pixelType})`;
        info.icat = 'SAR';
        info.datetime = raster.sar.collectStart ?? info.datetime;
      } else info.format = `SIDD ${raster.sar.version} (${raster.sar.pixelType ?? ''})`;
    }
    const chain = autoChain({ bands: raster.bands, sampleType: raster.sampleType, abpp: ish?.ABPP ?? raster.abpp, irep: info.irep, icat: info.icat, bandRoles: ish ? nitfBandRoles(ish) : null, kind: kind === 'dem' ? 'dem' : 'image', sar: (raster.sar?.kind === 'SICD' || raster.sar?.kind === 'Complex GeoTIFF') && raster.sar.complex });
    // DIMAP (IMP-22): sun angles and the scene-centre time for shadow tools and Shadows Down, and
    // the product's own RGB band order (file order is blue first).
    const dm = side.dimap;
    if (dm) {
      info.dimap = dm;
      if (dm.sun) info.sun = dm.sun;
      const ts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)/.exec(dm.time ?? '');
      if (ts && !info.datetime) info.datetime = ts.slice(1).join('');
      if (dm.rgb && raster.bands > Math.max(...dm.rgb) && chain.bands?.length === 3) chain.bands = dm.rgb;
      report.warnings.push(`DIMAP ${[dm.mission, dm.level, dm.spectral].filter(Boolean).join(' ')}${dm.time ? `, ${dm.time}` : ''}${dm.sun ? `, sun azimuth ${dm.sun.azimuth.toFixed(1)}° elevation ${dm.sun.elevation.toFixed(1)}°` : ''}`);
    }
    rasters.push({ raster, info, chain, name });
  }
  report.warnings.push(...checkConsistency(fileMarking, segMarks));
  if (res.merged) report.warnings.push(res.mergeNote);
  report.ms = Math.round(performance.now() - t0);
  return { res, fp, side, kind, rasters, report };
}

/** Create the runtime for a layer record from a described raster. */
export function makeRuntime(app, rec, r, d) {
  const layer = new ImageLayer(app, rec, r.raster, r.info);
  const models = buildModels(app, d.kind, d.res, r.raster, r.info.subheader, d.side);
  layer.models = models;
  const active = models.find((m) => !m.error && (!rec.model || m.name === rec.model)) ?? models.find((m) => !m.error);
  if (active) {
    layer.modelId = active.id;
    layer.modelName = active.name;
    layer.modelInfo = active.info;
  }
  for (const m of models) if (m.error) d.report.warnings.push(`${m.name}: ${m.error}`);
  if (rec.frameModel) app.restoreFrameModel?.(layer); // a frame camera from the EO import (REQ-SNS-14)
  if (rec.registration && app.registrationModel) {
    app.registrationModel(layer, rec.registration); // a registered or GCP model saved in the project (REQ-SNS-09)
    layer._regSig = JSON.stringify(rec.registration);
  }
  if (d.kind === 'dem') app.terrain.addFromLayer(layer, d.res);
  app.layers.set(rec.id, layer);
  layer.ensureStats().then(
    () => {
      layer.updateLut(true);
      app.renderer.invalidate();
      app.emit('state');
    },
    (e) => {
      // The layer stays listed with its reason (Layer Manager shows it); other layers render.
      layer.error = e.message;
      app.importLog.push({ file: rec.name, errors: [`${rec.name}: ${e.message}`], warnings: [], layer: rec.id });
      app.toast(`${rec.name} cannot be displayed: ${e.message}`, { kind: 'error', ms: 8000 });
      app.emit('layers');
    },
  );
  return layer;
}

/**
 * Open one file (with sidecars) into a pane. Creates the fileref and layer records in one
 * undoable transaction and the runtime layers. Returns the created layers and the report.
 */
export async function openImageFile(app, file, { sidecars = [], handle = null, pane, merge = app.prefs.get('mergeSegments') === true } = {}) {
  const d = await describe(app, file, sidecars, { merge });
  if (!d.rasters.length) throw new Error(d.report.errors[0] ?? 'the file has no displayable image');
  const p = pane ?? app.activePane();
  const refId = newId('file');
  const ids = d.rasters.map(() => newId('lyr'));
  app.store.transact(`Open ${file.name}`, (tx) => {
    tx.create('fileref', { merged: !!d.res.merged, name: file.name, size: file.size, lastModified: file.lastModified, fingerprint: d.fp, kind: d.kind, pathHint: file.webkitRelativePath || file.name, sidecars: sidecars.map((s) => s.name) }, refId);
    d.rasters.forEach((r, i) => {
      tx.create('layer', { pane: p.id, kind: r.info.kind === 'dem' ? 'dem' : 'image', name: r.name, file: refId, imageIndex: r.raster.imageIndex, chain: r.chain, visible: true, opacity: 1, saved: false, model: null }, ids[i]);
      tx.set(p.id, 'layers', [...(tx.get(p.id).layers ?? []), ids[i]]);
      tx.set(p.id, 'activeLayer', ids[i]);
    });
  });
  app.files.set(refId, { file, handle, sidecars, result: d.res });
  const layers = d.rasters.map((r, i) => makeRuntime(app, app.store.get(ids[i]), r, d));
  for (const l of layers) l.rec && app.store.transact('Set model', (tx) => tx.set(l.id, 'model', l.modelName), { kind: 'load' });
  app.importLog.push(d.report);
  for (const w of d.report.warnings) app.log('warn', `${file.name}: ${w}`);
  app.emit('layers');
  app.emit('state');
  p.fitWhole?.();
  return { layers, report: d.report };
}

/** Re-open a relinked file for existing layer records (project load). */
/** Runtimes for new layer records of an already-open file (a cloned multiport): a fresh decode. */
export async function attachLayers(app, fref, recs) {
  const f = app.files.get(fref.id);
  if (!f) throw new Error(`${fref.name} is not linked`);
  const d = await describe(app, f.file, f.sidecars ?? []);
  const out = [];
  for (const rec of recs) {
    const r = d.rasters.find((x) => x.raster.imageIndex === (rec.imageIndex ?? 0));
    if (r) out.push(makeRuntime(app, rec, r, d));
  }
  return out;
}

export async function attachFile(app, fref, file, sidecars = []) {
  const d = await describe(app, file, sidecars, { merge: !!fref.merged });
  app.files.set(fref.id, { file, handle: file.__handle ?? null, sidecars, result: d.res });
  const out = [];
  for (const rec of app.store.all('layer').filter((l) => l.file === fref.id)) {
    const r = d.rasters.find((x) => x.raster.imageIndex === (rec.imageIndex ?? 0));
    if (!r) continue;
    out.push(makeRuntime(app, rec, r, d));
  }
  app.importLog.push(d.report);
  return out;
}

export function isImageName(name) {
  return IMAGE_EXT.test(name);
}

export { highest };

/**
 * An in-memory product layer over (a window of) a parent layer's pixel grid (classification,
 * detector and index products, REQ-MSI-08..12): the planes live in the decode worker and can be
 * replaced (live thresholds) with `layer.updatePlanes(planes)`. The geometry is the parent's
 * model, offset by the window origin. `chain` patches the automatic first display.
 */
export async function openMemoryLayer(app, parent, { name, bands, sampleType, planes, nodata = null, x0 = 0, y0 = 0, width = parent.width, height = parent.height, chain = {}, pane = app.activePane(), select = true, info = {} }) {
  // Copies go to the worker: callers keep their arrays (labels and scores for live thresholds).
  const sent = planes.map((p) => p.slice());
  const job = app.pool.run('memopen', { width, height, bands, sampleType, nodata, planes: sent }, { label: `product ${name}`, transfer: sent.map((p) => p.buffer) });
  const raster = await job;
  const affinity = app.pool.lastAffinity?.(job.jobId);
  const id = newId('lyr');
  const base = autoChain({ bands, sampleType, kind: 'image' });
  const ch = { ...base, ...chain, colour: { ...base.colour, ...(chain.colour ?? {}) } };
  app.store.transact(`Product ${name}`, (tx) => {
    tx.create('layer', { pane: pane.id, kind: 'image', name, file: null, memory: true, derivedFrom: parent.id, window: [x0, y0, width, height], imageIndex: 0, chain: ch, visible: true, opacity: 1, saved: false, model: null }, id);
    tx.set(pane.id, 'layers', [...(tx.get(pane.id).layers ?? []), id]);
    if (select) tx.set(pane.id, 'activeLayer', id);
  });
  const rec = app.store.get(id);
  const layer = new ImageLayer(app, rec, raster, { format: 'In-memory product', kind: 'memory', fileName: name, marking: parent.info.marking, fileMarking: parent.info.fileMarking, iid: name, affinity, datetime: parent.info.datetime, icat: parent.info.icat, irep: '', ...info });
  if (parent.modelId) {
    const mid = x0 || y0 ? app.core.offsetModel(parent.modelId, x0, y0) : parent.modelId;
    layer.modelId = mid;
    layer.modelName = parent.modelName;
    layer.modelInfo = parent.modelInfo;
    layer.models = [{ name: parent.modelName, id: mid, info: parent.modelInfo }];
  }
  layer.updatePlanes = async (next) => {
    const copy = next.map((p) => p.slice());
    await app.pool.run('memupdate', { handle: layer.handle, planes: copy }, { affinity, transfer: copy.map((p) => p.buffer) });
    layer.tiles?.reset?.();
    layer.stats = null;
    await layer.ensureStats();
    layer.updateLut(true);
    app.renderer.invalidate();
  };
  app.layers.set(id, layer);
  await layer.ensureStats();
  layer.updateLut(true);
  app.emit('layers');
  app.emit('state');
  app.renderer.invalidate();
  return layer;
}
