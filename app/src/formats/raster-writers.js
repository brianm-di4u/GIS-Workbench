// ERDAS Imagine HFA and NetCDF-3 (CF-1.8) writers for image layers (REQ-FMT-25, REQ-FMT-27).
// Pixels come from the decode workers ('window' reads, one strip of rows at a time); the format
// metadata is laid out by the legacy WASM bundle (crates/gw-parse/src/{hfa,netcdf3}.rs) and the
// data are placed at the offsets it returns. Output: a Blob made of the parts, no copy of the
// whole image in one buffer.
//
// HFA: one Eimg_Layer per band, 64 × 64 uncompressed blocks, Map_Info + Eprj_ProParameters +
// Eprj_Datum, Eimg_NonInitializedValue, Esta_Statistics (exact min/max/mean/σ, median and mode
// from a 256-bin histogram) and internal Eimg_Layer_SubSample overviews (nearest) down to one block.
// NetCDF-3: CDF-2 (64-bit offset), CF-1.8: x/y (or lon/lat) coordinate variables, a grid_mapping
// variable with the CF parameters, crs_wkt and GDAL's spatial_ref/GeoTransform, _FillValue,
// _Unsigned for unsigned samples; rows north first with decreasing y.

import { layerCrs, wkt1, cfAttrs, hfaProjection, cfUnits } from './raster-crs.js';
import { t, gwError } from '../i18n/index.js';

const HFA_TYPE = { Uint8Array: 3, Uint16Array: 5, Int16Array: 6, Float32Array: 9 };
const NC_TYPE = { Uint8Array: 'byte', Uint16Array: 'short', Int16Array: 'short', Float32Array: 'float' };
const BLOCK = 64;

const stemOf = (l) => (l.rec?.name ?? 'image').replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_');
const num = (v) => (Number.isFinite(v) ? String(+v.toPrecision(17)) : 'NaN');

/** Bands written: all, or the displayed ones of a complex SAR image (as the COG writer). */
const writeBands = (l) => (l.info?.sar && l.bands > 3 ? [...new Set(l.chain?.bands ?? [0])] : [...Array(l.bands).keys()]);

async function probe(app, l, bands) {
  const r = await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: 2, h: 2, step: 1, bands }, { affinity: l.affinity, label: t('Save: sample type') });
  return r.planes[0].constructor;
}

/** Rows [y0, y0 + h) of level `step` (nearest), every band, full width at that level. */
async function strip(app, l, bands, step, y0, w, h) {
  const r = await app.pool.run('window', { handle: l.handle, x0: 0, y0: y0 * step, w, h, step, bands, maxSamples: Math.max(64e6, w * h * bands.length) }, { affinity: l.affinity, timeout: 600000, label: t('Save: rows {from}–{to}', { from: String(y0), to: String(y0 + h) }) });
  return r;
}

async function spec(app, kind, text) {
  return app.pool.run('rasterSpec', { kind, spec: text }, { kind: 'decode', label: t('Save: {kind} metadata', { kind }) });
}

/** Running statistics of one band (no-data excluded). */
function stats() {
  return { n: 0, min: Infinity, max: -Infinity, sum: 0, sq: 0, coarse: [] };
}
function addStats(s, a, nodata) {
  const nd = Number.isFinite(nodata);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (Number.isNaN(v) || (nd && v === nodata)) continue;
    s.n++;
    if (v < s.min) s.min = v;
    if (v > s.max) s.max = v;
    s.sum += v;
    s.sq += v * v;
    if ((i & 15) === 0 && s.coarse.length < 1 << 20) s.coarse.push(v);
  }
}
function finishStats(s) {
  if (!s.n) return [0, 0, 0, 0, 0, 0];
  const mean = s.sum / s.n;
  const sd = Math.sqrt(Math.max(0, s.sq / s.n - mean * mean));
  const c = Float64Array.from(s.coarse).sort();
  const median = c.length ? c[c.length >> 1] : mean;
  // Mode: the fullest of 256 bins over [min, max], reported at the bin centre.
  const bins = new Uint32Array(256);
  const span = s.max - s.min || 1;
  for (const v of c) bins[Math.min(255, Math.floor(((v - s.min) / span) * 256))]++;
  let m = 0;
  for (let i = 1; i < 256; i++) if (bins[i] > bins[m]) m = i;
  const mode = s.max === s.min ? s.min : s.min + ((m + 0.5) * span) / 256;
  return [s.min, s.max, mean, median, mode, sd];
}

/**
 * ERDAS Imagine .img of layer `l` → {name, blob, note}. Projections without an HFA parameter form
 * are refused by name; the image keeps its geotransform only when it has a CRS the writer maps.
 */
export async function encodeHfa(app, l, { onProgress = () => {}, overviews = true } = {}) {
  const bands = writeBands(l);
  const nb = bands.length;
  const W = l.width;
  const H = l.height;
  const Arr = await probe(app, l, bands);
  const pt = HFA_TYPE[Arr.name];
  if (pt === undefined) throw gwError('no ERDAS Imagine pixel type for {type} samples', { type: Arr.name }, 'E_HFA_TYPE');
  const bitsBytes = Arr.BYTES_PER_ELEMENT;
  if (W * H * nb * bitsBytes * 1.34 > 4e9) throw new Error(`an ERDAS Imagine file of more than 4 GB needs an .ige spill file, which this writer does not make; save it as a Cloud-Optimized GeoTIFF`);
  const gt = l.info?.meta?.geotransform;
  const crs = layerCrs(l);
  const notes = [];
  let proj = null;
  if (gt && (gt[2] || gt[4])) notes.push(t('the geotransform is rotated: map information is not written'));
  else if (gt && crs?.P) {
    proj = hfaProjection(crs);
    if (proj.error) throw new Error(proj.error);
  } else if (gt) notes.push(t('the CRS is not known: map information is written without a projection'));
  const nodata = Number.isFinite(l.nodata) ? l.nodata : null;
  const levels = [];
  if (overviews) for (let L = 1; Math.max(Math.ceil(W / 2 ** L), Math.ceil(H / 2 ** L)) >= BLOCK / 2 && L <= 16; L++) levels.push(L);
  const names = bands.map((b, i) => String(l.info?.bandsMeta?.[b]?.name ?? `Layer_${i + 1}`).replace(/[^\w.-]+/g, '_').slice(0, 60) || `Layer_${i + 1}`);
  const uniq = names.map((n, i) => (names.indexOf(n) === i ? n : `${n}_${i + 1}`));
  const lines = (st) => {
    const o = [`size ${W} ${H}`];
    bands.forEach((_, i) => {
      o.push(`band ${uniq[i]} ${pt}${l.info?.meta?.thematic ? ' thematic' : ''}`);
      if (nodata !== null) o.push(`nodata ${num(nodata)}`);
      o.push(`stats ${(st[i] ?? [0, 0, 0, 0, 0, 0]).map(num).join(' ')}`);
      for (const L of levels) o.push(`overview ${Math.ceil(W / 2 ** L)} ${Math.ceil(H / 2 ** L)}`);
    });
    if (gt && !gt[2] && !gt[4]) {
      const pw = gt[1];
      const ph = -gt[5];
      const ul = [gt[0] + pw / 2, gt[3] - ph / 2];
      const lr = [gt[0] + (W - 0.5) * pw, gt[3] - (H - 0.5) * ph];
      o.push(`mapinfo ${proj?.mapProName ?? 'Unknown'}|${proj?.units ?? 'meters'}|${[...ul, ...lr, pw, ph].map(num).join(' ')}`);
      if (proj) {
        const p = proj.pro;
        o.push(`pro ${p.number} ${p.zone} ${num(p.a)} ${num(p.b)}|${p.proName}|${p.sphereName}|${p.params.map(num).join(' ')}`);
        o.push(`datum ${proj.datum.name}|${proj.datum.params.map(num).join(' ')}`);
      }
    }
    return o.join('\n');
  };
  // Pass 1: the layout (statistics do not change any size).
  const first = await spec(app, 'hfa', lines([]));
  const lay = first.layout.layers;
  const parts = lay.map(() => []);
  const st = bands.map(() => stats());
  const per = levels.length + 1;
  let done = 0;
  const total = lay.reduce((s, x) => s + x.blocksY, 0);
  for (let li = 0; li < per; li++) {
    const L = li === 0 ? 0 : levels[li - 1];
    const step = 2 ** L;
    const g = lay.filter((x) => x.level === li);
    const { width: lw, height: lh, blocksX, blocksY } = g[0];
    for (let by = 0; by < blocksY; by++) {
      const rows = Math.min(BLOCK, lh - by * BLOCK);
      const r = await strip(app, l, bands, step, by * BLOCK, lw, rows);
      for (let k = 0; k < nb; k++) {
        const a = r.planes[k];
        if (L === 0) addStats(st[k], a, nodata);
        const bufs = new Arr(blocksX * BLOCK * BLOCK);
        if (nodata !== null) bufs.fill(nodata);
        for (let bx = 0; bx < blocksX; bx++) {
          const o = bx * BLOCK * BLOCK;
          const x0 = bx * BLOCK;
          const cw = Math.min(BLOCK, r.w - x0);
          for (let y = 0; y < Math.min(rows, r.h); y++) bufs.set(a.subarray(y * r.w + x0, y * r.w + x0 + cw), o + y * BLOCK);
        }
        parts[lay.findIndex((x) => x.band === k && x.level === li)].push(new Uint8Array(bufs.buffer));
      }
      onProgress(++done / (total / nb));
    }
  }
  // Pass 2: the same layout with the statistics in place.
  const fin = await spec(app, 'hfa', lines(st.map(finishStats)));
  if (fin.layout.dataStart !== first.layout.dataStart) throw new Error('HFA layout changed between passes');
  // Blocks in layout order (layers are consecutive from dataStart).
  const order = [...lay.keys()].sort((a, b) => lay[a].offset - lay[b].offset);
  const blob = new Blob([fin.bytes, ...order.flatMap((i) => parts[i])], { type: 'application/octet-stream' });
  if (blob.size !== fin.layout.fileSize) throw gwError('HFA writer: {got} bytes written, {want} laid out', { got: String(blob.size), want: String(fin.layout.fileSize) }, 'E_WRITER_SIZE');
  return { name: `${stemOf(l)}.img`, blob, types: ['.img'], description: 'ERDAS Imagine', note: [`${nb} band${nb > 1 ? 's' : ''}, ${levels.length} overview level${levels.length === 1 ? '' : 's'}`, ...notes].join('; ') };
}

/** Big-endian bytes of nc type `t` from a typed array (unsigned samples kept by bit pattern). */
function beBytes(a, t) {
  const sz = t === 'byte' ? 1 : t === 'short' ? 2 : t === 'double' ? 8 : 4;
  const out = new Uint8Array(a.length * sz);
  const dv = new DataView(out.buffer);
  if (t === 'byte') out.set(a);
  else if (t === 'short') for (let i = 0; i < a.length; i++) dv.setUint16(i * 2, a[i] & 0xffff);
  else if (t === 'float') for (let i = 0; i < a.length; i++) dv.setFloat32(i * 4, a[i]);
  else if (t === 'double') for (let i = 0; i < a.length; i++) dv.setFloat64(i * 8, a[i]);
  else for (let i = 0; i < a.length; i++) dv.setInt32(i * 4, a[i]);
  return out;
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** NetCDF-3 (CDF-2, CF-1.8) of layer `l` → {name, blob, note}. */
export async function encodeNetcdf3(app, l, { onProgress = () => {} } = {}) {
  const bands = writeBands(l);
  const nb = bands.length;
  const W = l.width;
  const H = l.height;
  const Arr = await probe(app, l, bands);
  const nct = NC_TYPE[Arr.name];
  if (!nct) throw gwError('no NetCDF-3 type for {type} samples', { type: Arr.name }, 'E_NETCDF_TYPE');
  const unsigned = Arr === Uint8Array || Arr === Uint16Array;
  const sz = Arr.BYTES_PER_ELEMENT;
  if (W * H * nb * sz > 2 ** 32 - 4) throw new Error(`one NetCDF-3 variable holds at most 4 GB (CDF-2); save it as a Cloud-Optimized GeoTIFF`);
  const gt = l.info?.meta?.geotransform;
  const crs = layerCrs(l);
  const geo = gt && !gt[2] && !gt[4];
  const notes = [];
  if (gt && !geo) notes.push(t('the geotransform is rotated: coordinates are not written'));
  const geographic = crs?.kind === 'longlat';
  const xn = geographic ? 'lon' : 'x';
  const pu = crs?.P ? cfUnits(crs.P) : 'm';
  const yn = geographic ? 'lat' : 'y';
  const data = nb > 1 ? 'band_data' : 'Band1';
  const nodata = Number.isFinite(l.nodata) || Number.isNaN(l.nodata) ? l.nodata : null;
  const o = ['cdf 2'];
  if (nb > 1) o.push(`dim band ${nb}`);
  o.push(`dim ${yn} ${H}`, `dim ${xn} ${W}`);
  o.push('gatt Conventions char CF-1.8', `gatt title char ${esc(l.rec?.name ?? 'image')}`, `gatt history char ${esc(`${new Date().toISOString()} written by GIS Workbench (NetCDF-3 CDF-2 writer)`)}`, 'gatt source char GIS Workbench');
  const hasCrs = geo && crs;
  if (hasCrs) {
    o.push('var crs int');
    const wkt = crs.wkt || (crs.P ? wkt1(crs) : null);
    if (crs.P) for (const a of cfAttrs(crs)) o.push(`att ${a.name} ${a.type} ${a.type === 'char' ? esc(a.value) : a.value.map(num).join(' ')}`);
    if (wkt) o.push(`att crs_wkt char ${esc(wkt)}`, `att spatial_ref char ${esc(wkt)}`);
    o.push(`att GeoTransform char ${gt.map(num).join(' ')}`, 'att long_name char CRS definition');
  }
  if (geo) {
    o.push(`var ${xn} double ${xn}`);
    o.push(geographic ? 'att standard_name char longitude' : 'att standard_name char projection_x_coordinate', geographic ? 'att units char degrees_east' : `att units char ${pu}`, `att long_name char ${geographic ? 'longitude' : 'x coordinate of projection'}`, 'att axis char X');
    o.push(`var ${yn} double ${yn}`);
    o.push(geographic ? 'att standard_name char latitude' : 'att standard_name char projection_y_coordinate', geographic ? 'att units char degrees_north' : `att units char ${pu}`, `att long_name char ${geographic ? 'latitude' : 'y coordinate of projection'}`, 'att axis char Y');
  }
  if (nb > 1) o.push('var band int band', 'att long_name char band number');
  o.push(`var ${data} ${nct} ${nb > 1 ? 'band ' : ''}${yn} ${xn}`);
  o.push(`att long_name char ${esc(nb > 1 ? `${l.rec?.name ?? 'image'} bands` : l.info?.bandsMeta?.[bands[0]]?.name ?? 'GDAL Band Number 1')}`);
  if (unsigned) o.push('att _Unsigned char true', `att valid_range ${nct === 'byte' ? 'short 0 255' : 'int 0 65535'}`);
  if (nodata !== null) {
    // The fill value in the variable's stored type (an unsigned value by its bit pattern).
    const fv = Number.isNaN(nodata) ? 'NaN' : nct === 'byte' && nodata > 127 ? num(nodata - 256) : nct === 'short' && unsigned && nodata > 32767 ? num(nodata - 65536) : num(nodata);
    o.push(`att _FillValue ${nct} ${fv}`);
  }
  if (hasCrs) o.push('att grid_mapping char crs');
  const r = l.info?.radiometry;
  if (r?.gain?.length && r.state !== 'DN' && r.gain[0] !== 1) o.push(`att scale_factor float ${num(r.gain[0])}`, `att add_offset float ${num(r.offset?.[0] ?? 0)}`);
  const { layout, bytes } = await spec(app, 'nc3', o.join('\n'));
  const at = Object.fromEntries(layout.vars.map((v) => [v.name, v]));
  const parts = [bytes];
  let pos = bytes.length;
  const put = (name, u8) => {
    const v = at[name];
    if (v.begin > pos) parts.push(new Uint8Array(v.begin - pos));
    parts.push(u8);
    pos = v.begin + u8.length;
  };
  if (hasCrs) put('crs', new Uint8Array(4));
  if (geo) {
    put(xn, beBytes(Float64Array.from({ length: W }, (_, i) => gt[0] + (i + 0.5) * gt[1]), 'double'));
    put(yn, beBytes(Float64Array.from({ length: H }, (_, j) => gt[3] + (j + 0.5) * gt[5]), 'double'));
  }
  if (nb > 1) put('band', beBytes(Int32Array.from({ length: nb }, (_, i) => i + 1), 'int'));
  // The data variable: band-major, rows north first, strips of up to 16 M samples.
  const v = at[data];
  if (v.begin > pos) parts.push(new Uint8Array(v.begin - pos));
  pos = v.begin;
  const rowsPer = Math.max(1, Math.min(H, Math.floor(16e6 / Math.max(1, W * nb))));
  const perBand = bands.map(() => []);
  for (let y0 = 0; y0 < H; y0 += rowsPer) {
    const h = Math.min(rowsPer, H - y0);
    const s = await strip(app, l, bands, 1, y0, W, h);
    for (let k = 0; k < nb; k++) perBand[k].push(beBytes(s.planes[k], nct));
    onProgress((y0 + h) / H);
  }
  for (const p of perBand) for (const u of p) {
    parts.push(u);
    pos += u.length;
  }
  if (layout.fileSize > pos) parts.push(new Uint8Array(layout.fileSize - pos));
  const blob = new Blob(parts, { type: 'application/x-netcdf' });
  if (blob.size !== layout.fileSize) throw gwError('NetCDF writer: {got} bytes written, {want} laid out', { got: String(blob.size), want: String(layout.fileSize) }, 'E_WRITER_SIZE');
  if (!hasCrs && geo) notes.push(t('the CRS is not known: coordinates are written without a grid mapping'));
  return { name: `${stemOf(l)}.nc`, blob, types: ['.nc'], description: 'NetCDF-3 (CF-1.8)', note: [`CDF-2, ${nb} band${nb > 1 ? 's' : ''}${hasCrs ? `, ${crs.label}` : ''}`, ...notes].join('; ') };
}
