// NetCDF-3 classic (CDF-1, CDF-2 64-bit offset, CDF-5 64-bit data) raster sources (FC-04,
// REQ-FMT-26). The header is parsed in the `legacy` WASM bundle (crates/gw-parse/src/netcdf3.rs);
// pixels are read by byte range from each variable's `begin` (record variables: begin + record ×
// recSize), big-endian. Every gridded variable (≥ 2 dimensions, the last two the grid) is a
// raster; its leading dimensions (time, level, record) are bands, as GDAL presents them.
// Georeferencing and packing use the CF logic shared with the NetCDF-4 reader (cf.js).

import { att, num, nums, packing, axisOf, unitScale, geotransform, gridMapping, unrotate, gcpGrid, cfTime } from './cf.js';
import { gwError } from '../../i18n/index.js';
import { wasmError, nested } from '../errors.js';

const SIZE = { byte: 1, char: 1, short: 2, int: 4, float: 4, double: 8, ubyte: 1, ushort: 2, uint: 4, int64: 8, uint64: 8 };
const OUT = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array };
const MAX_RASTERS = 32;

async function bytes(f, a, b) {
  if (a < 0 || b > f.size || b < a) throw gwError('the file is cut short or damaged: it ends at {size} bytes, before the data at {a}–{b} it describes', { size: String(f.size), a: String(a), b: String(b) });
  return new Uint8Array(await f.slice(a, b).arrayBuffer());
}

/**
 * Byte ranges [[start, length], …] (ascending) → one view each. A file read costs a round trip of a
 * few milliseconds in a browser, so ranges less than 256 KB apart are read together, up to 16 MB a
 * read, eight reads in flight (a 512-row tile of a strided level was 512 reads; now a handful).
 */
const GAP = 256 << 10; // measured on a 12 000² float grid: 2 MB read 288 MB for a level-4 tile (859 ms); 256 KB, 624 ms
async function ranges(f, list) {
  const out = new Array(list.length);
  const runs = [];
  for (let i = 0; i < list.length; i++) {
    const [a, n] = list[i];
    const r = runs.at(-1);
    if (r && a - r.end <= GAP && a + n - r.start <= 16e6 && a >= r.start) {
      r.end = Math.max(r.end, a + n);
      r.items.push(i);
    } else runs.push({ start: a, end: a + n, items: [i] });
  }
  for (let k = 0; k < runs.length; k += 8)
    await Promise.all(runs.slice(k, k + 8).map(async (r) => {
      const buf = await bytes(f, r.start, r.end);
      for (const i of r.items) out[i] = buf.subarray(list[i][0] - r.start, list[i][0] - r.start + list[i][1]);
    }));
  return out;
}

/** Big-endian values of nc type `t` from `b` (n values) into `dst` at `at` (step 1). */
function decodeInto(b, t, n, dst, at, unsigned) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (t) {
    case 'byte':
      if (unsigned) for (let i = 0; i < n; i++) dst[at + i] = b[i];
      else for (let i = 0; i < n; i++) dst[at + i] = dv.getInt8(i);
      break;
    case 'ubyte':
    case 'char':
      for (let i = 0; i < n; i++) dst[at + i] = b[i];
      break;
    case 'short':
      if (unsigned) for (let i = 0; i < n; i++) dst[at + i] = dv.getUint16(i * 2);
      else for (let i = 0; i < n; i++) dst[at + i] = dv.getInt16(i * 2);
      break;
    case 'ushort':
      for (let i = 0; i < n; i++) dst[at + i] = dv.getUint16(i * 2);
      break;
    case 'int':
      if (unsigned) for (let i = 0; i < n; i++) dst[at + i] = dv.getUint32(i * 4);
      else for (let i = 0; i < n; i++) dst[at + i] = dv.getInt32(i * 4);
      break;
    case 'uint':
      for (let i = 0; i < n; i++) dst[at + i] = dv.getUint32(i * 4);
      break;
    case 'float':
      for (let i = 0; i < n; i++) dst[at + i] = dv.getFloat32(i * 4);
      break;
    case 'double':
      for (let i = 0; i < n; i++) dst[at + i] = dv.getFloat64(i * 8);
      break;
    case 'int64':
      for (let i = 0; i < n; i++) dst[at + i] = Number(dv.getBigInt64(i * 8));
      break;
    case 'uint64':
      for (let i = 0; i < n; i++) dst[at + i] = Number(dv.getBigUint64(i * 8));
      break;
    default:
      throw gwError('NetCDF type {t} is not read', { t: String(t) });
  }
}

function sampleTypeOf(v, unsigned) {
  if (v.type === 'ubyte' || (v.type === 'byte' && unsigned)) return 'u8';
  if (v.type === 'byte') return 'i16';
  if (v.type === 'ushort' || (v.type === 'short' && unsigned)) return 'u16';
  if (v.type === 'short') return 'i16';
  return 'f32';
}

/** NetCDF-3 header through the bundle; the prefix read grows until it holds the whole header. */
export async function nc3Header(file, lx) {
  for (let n = 1 << 16; ; n *= 4) {
    const end = Math.min(file.size, n);
    const [p, len] = lx.put(await bytes(file, 0, end));
    let code;
    try {
      code = lx.x.gw_nc3_header(p, len, file.size);
    } finally {
      lx.free(p, len);
    }
    if (code === 0) return lx.outJson();
    const msg = nested(wasmError(lx));
    if (code !== 2 || end >= file.size || n > 1 << 28) throw code === 2 ? gwError('the NetCDF-3 header is cut short ({msg})', { msg }) : gwError('NetCDF-3: {msg}', { msg });
  }
}

/**
 * Open a NetCDF-3 file → {meta, sources: [{source, meta}]}. One source per gridded variable (up
 * to 32), the largest first.
 */
export async function openNetcdf3(file, lx) {
  const h = await nc3Header(file, lx);
  const recs = h.streaming ? h.recordsPresent : Math.min(h.numrecs, h.recordsPresent);
  const dimLen = (d) => (h.dims[d].unlimited ? recs : h.dims[d].len);
  const byName = new Map(h.vars.map((v) => [v.name, v]));
  /** Whole small variable (coordinates, ≤ 4 M values) as Float64Array. */
  const readAll = async (v) => {
    const shape = v.dims.map(dimLen);
    const count = shape.reduce((a, b) => a * b, 1);
    if (count > 1 << 22) return null;
    const out = new Float64Array(count);
    if (!v.record) decodeInto(await bytes(file, v.begin, v.begin + count * v.size), v.type, count, out, 0, false);
    else {
      const per = count / Math.max(1, recs);
      for (let r = 0; r < recs; r++) decodeInto(await bytes(file, v.begin + r * h.recSize, v.begin + r * h.recSize + per * v.size), v.type, per, out, r * per, false);
    }
    return out;
  };
  // Variables that describe others: coordinate variables, bounds, grid mappings, 2-D lat/lon.
  const aux = new Set();
  for (const v of h.vars) {
    if (v.dims.length === 1 && h.dims[v.dims[0]].name === v.name) aux.add(v.name);
    const b = att(v.attrs, 'bounds');
    if (b) aux.add(String(b));
    const gm = att(v.attrs, 'grid_mapping');
    if (gm) aux.add(String(gm).split(/[\s:]+/)[0]);
    for (const c of String(att(v.attrs, 'coordinates') ?? '').split(/\s+/).filter(Boolean)) if (byName.get(c)?.dims.length >= 2) aux.add(c);
  }
  const grids = h.vars.filter((v) => v.dims.length >= 2 && v.type !== 'char' && !aux.has(v.name) && dimLen(v.dims[v.dims.length - 1]) >= 1 && dimLen(v.dims[v.dims.length - 2]) >= 1);
  if (!grids.length) {
    const e = gwError('the NetCDF-3 file has no gridded variable (no variable with two or more dimensions): {vars}', { vars: h.vars.map((v) => `${v.name}(${v.dims.map((d) => h.dims[d].name).join(',')})`).slice(0, 8).join(', ') || 'no variables' });
    e.code = 4;
    throw e;
  }
  const area = (v) => dimLen(v.dims[v.dims.length - 1]) * dimLen(v.dims[v.dims.length - 2]);
  const order = [...grids.keys()].sort((a, b) => area(grids[b]) - area(grids[a]) || a - b);
  const sources = [];
  for (const gi of order.slice(0, MAX_RASTERS)) {
    const v = grids[gi];
    const nd = v.dims.length;
    const xd = v.dims[nd - 1];
    const yd = v.dims[nd - 2];
    const W = dimLen(xd);
    const H = dimLen(yd);
    const lead = v.dims.slice(0, nd - 2);
    const leadShape = lead.map(dimLen);
    const NB = leadShape.reduce((a, b) => a * b, 1);
    if (NB < 1) continue;
    if (NB > 4096) continue;
    const pk = packing(v.attrs);
    const sampleType = sampleTypeOf(v, pk.unsigned);
    const sz = v.size;
    // An unsigned variable's fill value and valid range are stored with the signed type (GDAL reads
    // them as unsigned); values outside valid_range/valid_min/valid_max read as the fill value, NaN
    // in a float variable with a finite fill value too, as GDAL presents them.
    const span = 2 ** (8 * sz);
    const uns = (x) => (pk.unsigned && Number.isFinite(x) && x < 0 && sz <= 4 ? x + span : x);
    const fill = pk.fill === null ? null : uns(pk.fill);
    const vr = nums(v.attrs, 'valid_range').map(uns);
    const vmin = vr.length === 2 ? vr[0] : uns(num(v.attrs, 'valid_min'));
    const vmax = vr.length === 2 ? vr[1] : uns(num(v.attrs, 'valid_max'));
    const mask = fill !== null && (Number.isFinite(vmin) || Number.isFinite(vmax) || (Number.isFinite(fill) && (v.type === 'float' || v.type === 'double')));
    // Coordinates: the variables named as the grid's dimensions.
    const xv = byName.get(h.dims[xd].name);
    const yv = byName.get(h.dims[yd].name);
    const xs = xv && xv.dims.length === 1 ? await readAll(xv) : null;
    const ys = yv && yv.dims.length === 1 ? await readAll(yv) : null;
    const xr = xv ? axisOf(xv.name, xv.attrs) : null;
    const yr = yv ? axisOf(yv.name, yv.attrs) : null;
    const gmName = String(att(v.attrs, 'grid_mapping') ?? '').split(/[\s:]+/)[0];
    const gmVar = gmName ? byName.get(gmName) : null;
    let crs = gmVar ? gridMapping(gmVar.attrs, { toMeters: xv ? unitScale(xv.attrs) : 1 }) : null;
    let gt = null;
    let gcps = null;
    // North up, as GDAL presents NetCDF: rows are flipped when the y coordinate increases, and when
    // there is no y coordinate at all (CF/COARDS grids run south to north); a y dimension that is a
    // longitude (swapped axes) keeps the file order.
    // (The first two values decide: unwritten coordinates read as the fill value.)
    const flip = H > 1 && yr !== 'lon' && yr !== 'x' && !(ys && ys.length > 1 && ys[1] < ys[0]);
    const geographic = (xr === 'lon' || /degree/i.test(String(att(xv?.attrs, 'units') ?? ''))) && (yr === 'lat' || /degree/i.test(String(att(yv?.attrs, 'units') ?? '')));
    if (xs && ys) {
      const km = (q) => (!geographic && unitScale(q.attrs) === 1000 ? 1000 : 1); // km coordinates in metres, as GDAL; feet stay feet (the CRS says so)
      const g = geotransform(xs, ys, km(xv), km(yv));
      if (crs?.rotated) {
        // Rotated pole: geographic positions of the grid through the pole rotation, as GCPs.
        gcps = gcpGrid((c, r) => unrotate(xs[c], ys[flip ? ys.length - 1 - r : r], crs.rotated), W, H, W, H, 12);
        crs = { ...crs, gcps: true };
      } else if (g && (yr === 'lon' || yr === 'x') && (xr === 'lat' || xr === 'y')) {
        // Swapped axes (rows are longitudes, columns latitudes): the transposed geotransform.
        const dx = (xs[xs.length - 1] - xs[0]) / Math.max(1, xs.length - 1);
        const dy = (ys[ys.length - 1] - ys[0]) / Math.max(1, ys.length - 1);
        gt = [ys[0] - dy / 2, 0, dy, xs[0] - dx / 2, dx, 0];
      } else if (g) gt = g.gt;
      else if (geographic) {
        // Irregular latitude or longitude spacing (Gaussian grids): GCPs from the coordinates.
        gcps = gcpGrid((c, r) => ({ lat: ys[flip ? ys.length - 1 - r : r], lon: xs[c] }), W, H, W, H, 12);
      }
      if (!crs && geographic && gt) crs = { epsg: 4326, proj4: '+proj=longlat +datum=WGS84 +no_defs', label: 'latitude/longitude (WGS 84 assumed)' };
    }
    // GDAL keeps its own geotransform beside the CF grid mapping (spatial_ref + GeoTransform).
    if (!gt && gmVar && att(gmVar.attrs, 'GeoTransform')) {
      const g = String(att(gmVar.attrs, 'GeoTransform')).trim().split(/\s+/).map(Number);
      if (g.length === 6 && g.every(Number.isFinite)) gt = g;
    }
    // 2-D latitude/longitude named in `coordinates` (curvilinear grids): geolocation GCPs.
    if (!gt && !gcps) {
      const cs = String(att(v.attrs, 'coordinates') ?? '').split(/\s+/).map((n) => byName.get(n)).filter((c) => c?.dims.length === 2);
      const la = cs.find((c) => axisOf(c.name, c.attrs) === 'lat');
      const lo = cs.find((c) => axisOf(c.name, c.attrs) === 'lon');
      if (la && lo) {
        const [A, B] = await Promise.all([readAll(la), readAll(lo)]);
        const lw = dimLen(la.dims[1]);
        const lh = dimLen(la.dims[0]);
        if (A && B) gcps = gcpGrid((c, r) => ({ lat: A[(flip ? lh - 1 - r : r) * lw + c], lon: B[(flip ? lh - 1 - r : r) * lw + c] }), lw, lh, W, H, 12);
      }
    }
    // Bands: names from the leading dimensions' coordinate values.
    const coords = await Promise.all(lead.map(async (d) => {
      const cv = byName.get(h.dims[d].name);
      if (!(cv && cv.dims.length === 1)) return { name: h.dims[d].name, vals: null, units: '' };
      const units = String(att(cv.attrs, 'units') ?? '');
      // A time axis keeps its dates (REQ-GAP-83): "days since …" in the coordinate's calendar.
      const time = axisOf(cv.name, cv.attrs) === 't' ? cfTime(units, att(cv.attrs, 'calendar')) : null;
      return { name: h.dims[d].name, vals: await readAll(cv), units, time, calendar: time ? String(att(cv.attrs, 'calendar') || 'standard').toLowerCase() : null };
    }));
    const bandsMeta = Array.from({ length: NB }, (_, b) => {
      let r = b;
      const idx = [];
      for (let k = leadShape.length - 1; k >= 0; k--) {
        idx[k] = r % leadShape[k];
        r = Math.floor(r / leadShape[k]);
      }
      let time;
      let calendar;
      const label = idx
        .map((i, k) => {
          const c = coords[k];
          const iso = c.vals && c.time ? c.time(c.vals[i]) : null;
          if (iso && !time) {
            time = iso;
            calendar = c.calendar;
          }
          return `${c.name}=${iso ?? (c.vals ? c.vals[i] : i)}`;
        })
        .join(' ');
      const c0 = coords[0];
      const wl = lead.length === 1 && c0.vals && /^(nm|nanomet|um|µm|micromet|microns?)/i.test(c0.units) ? (/^nm|nanomet/i.test(c0.units) ? c0.vals[idx[0]] / 1000 : c0.vals[idx[0]]) : NaN;
      return { name: label || v.name, cw: wl, fwhm: NaN, bad: false, ...(time ? { time, calendar } : {}) };
    });
    // A record variable of two dimensions has one row per record (its y is the unlimited dimension).
    const rowRec = v.record && lead.length === 0;
    const rowBytes = rowRec ? h.recSize : W * sz;
    const sliceBytes = W * H * sz;
    const inner = v.record ? leadShape.slice(1).reduce((a, b) => a * b, 1) : NB;
    const sliceAt = (b) => (rowRec ? v.begin : v.record ? v.begin + Math.floor(b / inner) * h.recSize + (b % inner) * sliceBytes : v.begin + b * sliceBytes);
    if (!v.record && v.begin + NB * sliceBytes > file.size) {
      const e = gwError('the NetCDF-3 file is cut short: variable {name} needs {need} bytes, the file has {size}', { name: v.name, need: String(v.begin + NB * sliceBytes), size: String(file.size) });
      e.code = 2;
      throw e;
    }
    const C = OUT[sampleType];
    const lo = Number.isFinite(vmin) ? vmin : -Infinity;
    const hi = Number.isFinite(vmax) ? vmax : Infinity;
    const masked = (out) => {
      if (mask) for (let i = 0; i < out.length; i++) {
        const x = out[i];
        if (x < lo || x > hi || (x !== x && fill === fill)) out[i] = fill;
      }
      return out;
    };
    const source = {
      kind: 'netcdf3',
      imageIndex: h.vars.indexOf(v),
      width: W,
      height: H,
      bands: NB,
      sampleType,
      nodata: fill,
      async readWindow(x0, y0, w, hh, sel) {
        return Promise.all(
          sel.map(async (b) => {
            const out = new C(w * hh);
            const base = sliceAt(b);
            // File rows of the window (reversed when the file runs south to north).
            const r0 = flip ? H - y0 - hh : y0;
            // The window's span of each file row, ascending (coalesced into a few reads).
            const list = Array.from({ length: hh }, (_, k) => [base + (r0 + k) * rowBytes + x0 * sz, w * sz]);
            const got = await ranges(file, list);
            for (let k = 0; k < hh; k++) decodeInto(got[k], v.type, w, out, (flip ? hh - 1 - k : k) * w, pk.unsigned);
            return masked(out);
          }),
        );
      },
      // Coarse levels without reading every pixel (the data are raw): each level sample is the
      // full-resolution pixel at the centre of its 2^L cell, one row read per level row.
      hasLevel: (L) => L >= 1 && L <= 12,
      async readLevel(L, x0, y0, w, hh, sel) {
        const sc = 2 ** L;
        const half = sc >> 1;
        const lw = Math.ceil(W / sc);
        const lh = Math.ceil(H / sc);
        const cw = Math.max(0, Math.min(w, lw - x0));
        const ch = Math.max(0, Math.min(hh, lh - y0));
        const X0 = Math.min(W - 1, x0 * sc + half);
        const X1 = Math.min(W - 1, (x0 + cw - 1) * sc + half);
        const span = X1 - X0 + 1;
        return Promise.all(
          sel.map(async (b) => {
            const out = new C(w * hh);
            if (fill !== null) out.fill(fill);
            if (!cw || !ch) return out;
            const base = sliceAt(b);
            const row = new C(span);
            const fileRow = (r) => {
              const Y = Math.min(H - 1, (y0 + r) * sc + half);
              return flip ? H - 1 - Y : Y;
            };
            // Level rows in file order (ascending offsets), each the span of its sampled columns.
            const order = Array.from({ length: ch }, (_, r) => r).sort((p, q) => fileRow(p) - fileRow(q));
            const got = await ranges(file, order.map((r) => [base + fileRow(r) * rowBytes + X0 * sz, span * sz]));
            order.forEach((r, k) => {
              decodeInto(got[k], v.type, span, row, 0, pk.unsigned);
              for (let c = 0; c < cw; c++) out[r * w + c] = row[Math.min(W - 1, (x0 + c) * sc + half) - X0];
            });
            return masked(out);
          }),
        );
      },
    };
    const units = String(att(v.attrs, 'units') ?? '');
    const longName = String(att(v.attrs, 'long_name') ?? att(v.attrs, 'standard_name') ?? '');
    sources.push({
      source,
      meta: {
        format: `NetCDF-3 CDF-${h.version} ${v.name} (${v.type}${v.record ? ', record variable' : ''}${NB > 1 ? `, ${NB} bands` : ''})`,
        product: `NetCDF-3 ${v.name}`,
        variable: v.name,
        longName,
        units,
        dims: v.dims.map((d) => h.dims[d].name),
        geotransform: gt,
        flipped: flip,
        epsg: crs?.epsg ?? null,
        wkt: crs?.wkt ?? null,
        proj4: crs?.proj4 ?? null,
        crsLabel: crs?.label ?? null,
        crsError: crs?.error ?? (gmName && !gmVar ? `grid_mapping variable ${gmName} is missing` : null),
        gcps,
        bandsMeta,
        radiometry: pk.scale !== 1 || pk.offset !== 0 ? { state: 'scaled', gain: Array(NB).fill(pk.scale), offset: Array(NB).fill(pk.offset), unit: units || 'scaled (CF scale_factor/add_offset)', source: 'CF scale_factor/add_offset' } : null,
        fill,
      },
    });
  }
  if (!sources.length) throw new Error('the NetCDF-3 file has no readable gridded variable');
  const conv = String(att(h.attrs, 'Conventions') ?? '');
  const meta = {
    format: `NetCDF-3 CDF-${h.version}${conv ? ` (${conv})` : ''}`,
    version: h.version,
    conventions: conv,
    title: String(att(h.attrs, 'title') ?? ''),
    numrecs: h.numrecs,
    variables: grids.map((v) => ({ name: v.name, dims: v.dims.map((d) => h.dims[d].name), type: v.type })),
    skipped: Math.max(0, grids.length - MAX_RASTERS),
  };
  return { meta, sources };
}
