// ERDAS Imagine HFA (.img) raster source (FC-03, REQ-FMT-24). The node tree is walked by byte
// range: each 128-byte entry header and each node's data are read on their own and decoded in the
// `legacy` WASM bundle by the file's own data dictionary (crates/gw-parse/src/hfa.rs). Bands are
// the root's Eimg_Layer nodes; blocks come from their Edms_State (uncompressed or RLE), or from an
// .ige spill file (ImgExternalRaster); Eimg_Layer_SubSample children (in the file or in an .rrd)
// become native pyramid levels. Map_Info + Projection/Datum give the geotransform and CRS. A
// complex layer (c64, c128) is two f32 bands, real then imaginary, as a complex GeoTIFF is.

import { gwError } from '../../i18n/index.js';
import { wasmError, nested } from '../errors.js';

const PIXEL = ['u1', 'u2', 'u4', 'u8', 's8', 'u16', 's16', 'u32', 's32', 'f32', 'f64', 'c64', 'c128'];
const BITS = [1, 2, 4, 8, 8, 16, 16, 32, 32, 32, 64, 64, 128];
const NATIVE = [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Float32Array, Float64Array];
const OUT = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array };
const sampleTypeOf = (pt) => (pt <= 3 ? 'u8' : pt === 5 ? 'u16' : pt === 4 || pt === 6 ? 'i16' : 'f32');
const isComplex = (pt) => pt === 11 || pt === 12;
const MAX_NODES = 20000;

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');

async function bytes(f, a, b) {
  if (a < 0 || b > f.size || b < a) throw gwError('the file is cut short or damaged: it ends at {size} bytes, before the data at {a}–{b} it describes', { size: String(f.size), a: String(a), b: String(b) });
  return new Uint8Array(await f.slice(a, b).arrayBuffer());
}

/** One HFA file (the .img, or an .rrd): header, dictionary, entry tree; node data on demand. */
async function hfaTree(file, lx) {
  const call = (fn, ...bufs) => {
    const ptrs = bufs.map((b) => (b instanceof Uint8Array ? lx.put(b) : null));
    try {
      const args = [];
      bufs.forEach((b, i) => (ptrs[i] ? args.push(...ptrs[i]) : args.push(b)));
      const r = lx.x[fn](...args);
      if (r !== 0) throw gwError('{file}: {msg}', { file: file.name, msg: nested(wasmError(lx)) });
    } finally {
      for (const p of ptrs) if (p) lx.free(...p);
    }
  };
  const head = await bytes(file, 0, Math.min(file.size, 4096));
  call('gw_hfa_file_header', head);
  const fh = lx.outJson();
  // The dictionary is text ending with "." (GDAL writes about 2 KB; read more if it is longer).
  let dict = null;
  for (let n = 8192; ; n *= 8) {
    const end = Math.min(file.size, fh.dictionary + n);
    const d = await bytes(file, fh.dictionary, end);
    const stop = d.indexOf(0);
    const dot = d.lastIndexOf(0x2e, stop < 0 ? d.length : stop);
    if (dot > 0 || end === file.size || n > 1 << 22) {
      dict = d.subarray(0, (stop < 0 ? d.length : stop) || d.length);
      break;
    }
  }
  const nodes = new Map();
  const node = async (pos, parent) => {
    if (nodes.has(pos) || nodes.size > MAX_NODES) throw gwError('{file}: the HFA entry tree has a loop or more than {max} entries', { file: file.name, max: String(MAX_NODES) });
    call('gw_hfa_entry', await bytes(file, pos, Math.min(file.size, pos + 128)));
    const e = { ...lx.outJson(), pos, parentNode: parent, children: [] };
    nodes.set(pos, e);
    return e;
  };
  const root = await node(fh.root, null);
  const stack = [root];
  while (stack.length) {
    const e = stack.pop();
    for (let p = e.child; p; ) {
      const c = await node(p, e);
      e.children.push(c);
      stack.push(c);
      p = c.next;
    }
  }
  const tb = (s) => enc.encode(s);
  const t = {
    file,
    root,
    dict,
    nodes,
    async raw(e) {
      if (!e?.data || !e.dataSize) return new Uint8Array(0);
      return bytes(file, e.data, e.data + e.dataSize);
    },
    /** A node's data decoded by the dictionary; arrays cut at `max` items. */
    async decode(e, max = 4096) {
      if (!e) return null;
      const d = await this.raw(e);
      call('gw_hfa_node', dict, tb(e.type), d, max);
      return lx.outJson();
    },
    async blocks(e) {
      const d = await this.raw(e);
      call('gw_hfa_blocks', dict, d);
      const o = lx.outBytes();
      return new Uint32Array(o.buffer, o.byteOffset, o.byteLength >> 2);
    },
    child: (e, name, type) => e?.children.find((c) => (!name || c.name === name) && (!type || c.type === type)) ?? null,
    childrenOf: (e, type) => e?.children.filter((c) => c.type === type) ?? [],
  };
  return t;
}

const baseName = (s) => String(s ?? '').split(/[\\/]/).pop().toLowerCase();

/** A layer's block reader: the Edms_State table (or an .ige spill), decoded through the bundle. */
async function layerReader(tree, layerNode, lx, sidecars, cache) {
  const info = await tree.decode(layerNode);
  const pt = PIXEL.indexOf(info.pixelType);
  if (pt < 0) throw gwError('HFA pixel type {type} is not read', { type: String(info.pixelType) });
  const parts = isComplex(pt) ? 2 : 1; // samples per pixel in a block (re, im)
  const W = info.width;
  const H = info.height;
  const bw = info.blockWidth;
  const bh = info.blockHeight;
  if (!(W > 0 && H > 0 && bw > 0 && bh > 0 && bw <= 1 << 16 && bh <= 1 << 16)) throw gwError('HFA layer {layer}: implausible size {w} × {h} / blocks {bw} × {bh}', { layer: layerNode.name, w: String(W), h: String(H), bw: String(bw), bh: String(bh) });
  const bx = Math.ceil(W / bw);
  const by = Math.ceil(H / bh);
  const n = bx * by;
  const offs = new Float64Array(n);
  const sizes = new Uint32Array(n);
  const flags = new Uint8Array(n);
  let src = tree.file;
  const dms = tree.child(layerNode, 'RasterDMS', 'Edms_State');
  const ext = tree.child(layerNode, 'ExternalRasterDMS', 'ImgExternalRaster');
  let spill = null;
  if (dms) {
    const t = await tree.blocks(dms);
    if (t.length < n * 3) throw gwError('HFA layer {layer}: the block table has {have} blocks, the layer needs {need}', { layer: layerNode.name, have: String(t.length / 3), need: String(n) });
    for (let i = 0; i < n; i++) {
      offs[i] = t[i * 3];
      sizes[i] = t[i * 3 + 1];
      flags[i] = t[i * 3 + 2];
    }
  } else if (ext) {
    // Spill file (.ige): blocks of every layer of the stack interleaved, never compressed; a validity
    // bitmap (20-byte header, one bit per block, rows padded to bytes) at layerStackValidFlagsOffset.
    const x = await tree.decode(ext);
    const name = baseName(x.fileName?.string ?? x.fileName);
    spill = name;
    src = sidecars.find((f) => baseName(f.name) === name) ?? sidecars.find((f) => /\.ige$/i.test(f.name) && baseName(f.name).replace(/\.ige$/, '') === baseName(tree.file.name).replace(/\.img$/, '')) ?? null;
    if (!src) {
      const e = gwError('the ERDAS Imagine image keeps its pixels in the spill file {name}, which was not opened with it: select the .img and the .ige together', { name: name || '(.ige)' });
      e.code = 4;
      throw e;
    }
    const big = (v) => (Array.isArray(v) ? v[0] + v[1] * 2 ** 32 : Number(v));
    const vf = big(x.layerStackValidFlagsOffset);
    const d0 = big(x.layerStackDataOffset);
    const count = Number(x.layerStackCount) || 1;
    const index = Number(x.layerStackIndex) || 0;
    const per = Math.ceil(bx / 8);
    const map = await bytes(src, vf, Math.min(src.size, vf + per * by + 20));
    const bb = Math.ceil((bw * bh * BITS[pt]) / 8);
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / bx);
      const c = i % bx;
      const bit = r * per * 8 + c + 160;
      flags[i] = (map[bit >> 3] >> (bit & 7)) & 1;
      offs[i] = d0 + bb * (i * count + index);
      sizes[i] = bb;
    }
  } else throw gwError('HFA layer {layer} has no RasterDMS or ExternalRasterDMS', { layer: layerNode.name });
  const Native = NATIVE[pt];
  const npx = bw * bh;
  const key = `${tree.file.name}|${layerNode.pos}`;
  /** One block as native samples (null = not written: the caller fills no-data). */
  const block = async (i, buf) => {
    if (!(flags[i] & 1) || !sizes[i]) return null;
    const ck = `${key}|${i}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    const b = buf ?? (await bytes(src, offs[i], offs[i] + sizes[i]));
    let out;
    if (flags[i] & 2 && parts > 1) throw gwError('HFA layer {layer}: run-length compressed complex blocks are not read', { layer: layerNode.name });
    if (!(flags[i] & 2) && BITS[pt] >= 8) {
      const need = npx * parts * Native.BYTES_PER_ELEMENT;
      if (b.length < need) throw gwError('HFA block {i} of {layer}: {have} bytes, {need} needed', { i: String(i), layer: layerNode.name, have: String(b.length), need: String(need) });
      out = new Native(b.slice(0, need).buffer);
    } else {
      const [p, len] = lx.put(b);
      try {
        if (lx.x.gw_hfa_block(p, len, pt, npx, flags[i] & 2 ? 1 : 0) !== 0) throw gwError('HFA block {i} of {layer}: {msg}', { i: String(i), layer: layerNode.name, msg: nested(wasmError(lx)) });
      } finally {
        lx.free(p, len);
      }
      const o = lx.outBytes();
      out = new Native(o.buffer, o.byteOffset, npx);
    }
    cache.set(ck, out, out.byteLength);
    return out;
  };
  /** Window of this layer into `dst` (typed array w × h), no-data `fill` where blocks are absent; `part` 1 is the imaginary part of complex samples. */
  const read = async (x0, y0, w, h, dst, fill, part = 0) => {
    const bx0 = Math.floor(x0 / bw);
    const bx1 = Math.floor((x0 + w - 1) / bw);
    const by0 = Math.floor(y0 / bh);
    const by1 = Math.floor((y0 + h - 1) / bh);
    for (let r = by0; r <= by1; r++) {
      // One read for a run of blocks that lie end to end in the file (the usual layout).
      const want = [];
      for (let c = bx0; c <= bx1; c++) want.push(r * bx + c);
      const bufs = new Map();
      for (let k = 0; k < want.length; ) {
        let j = k + 1;
        while (j < want.length && flags[want[j]] & 1 && offs[want[j]] === offs[want[j - 1]] + sizes[want[j - 1]] && !cache.get(`${key}|${want[j]}`)) j++;
        if (j - k > 1 && flags[want[k]] & 1 && !cache.get(`${key}|${want[k]}`)) {
          const a = offs[want[k]];
          const all = await bytes(src, a, offs[want[j - 1]] + sizes[want[j - 1]]);
          for (let q = k; q < j; q++) bufs.set(want[q], all.subarray(offs[want[q]] - a, offs[want[q]] - a + sizes[want[q]]));
        }
        k = j;
      }
      for (const i of want) {
        const c = i % bx;
        const blk = await block(i, bufs.get(i));
        const ix0 = Math.max(x0, c * bw);
        const ix1 = Math.min(x0 + w, (c + 1) * bw, W);
        const iy0 = Math.max(y0, r * bh);
        const iy1 = Math.min(y0 + h, (r + 1) * bh, H);
        for (let y = iy0; y < iy1; y++) {
          const o = (y - y0) * w;
          if (!blk) {
            dst.fill(fill, o + ix0 - x0, o + ix1 - x0);
            continue;
          }
          const s = (y - r * bh) * bw - c * bw;
          if (parts === 1) for (let x = ix0; x < ix1; x++) dst[o + x - x0] = blk[s + x];
          else for (let x = ix0; x < ix1; x++) dst[o + x - x0] = blk[(s + x) * 2 + part];
        }
      }
    }
  };
  return { width: W, height: H, pt, parts, layerType: info.layerType, blockWidth: bw, blockHeight: bh, read, spill, compressed: [...flags].some((f) => f & 2) };
}

/**
 * Projection → {epsg, proj4, label}. Eprj_ProParameters follows the GCTP conventions (angles in
 * radians in proParams); the same mapping as GDAL's HFAPCSStructToWKT for the common projections.
 */
/** A proj4 +title value (no + or =). */
const title = (s) => String(s).replace(/[+=]/g, ' ').trim() || 'HFA';

export function hfaCrs(pro, datum, mapInfo) {
  if (!pro && !/^(geographic|lat\/?lon)/i.test(String(mapInfo?.proName ?? ''))) return null;
  const R = 180 / Math.PI;
  const dn = String(datum?.datumname ?? pro?.proSpheroid?.sphereName ?? '');
  const sph = pro?.proSpheroid ?? {};
  const kind = /wgs.?84/i.test(dn) ? 'WGS84' : /nad.?83|north american (datum )?1983/i.test(dn) ? 'NAD83' : /nad.?27|north american (datum )?1927/i.test(dn) ? 'NAD27' : null;
  const units = String(mapInfo?.units ?? '').toLowerCase();
  const u = /feet|foot/.test(units) ? (/us/.test(units) ? ' +units=us-ft' : ' +units=ft') : /^(dd|degrees?)$/.test(units) ? '' : ' +units=m';
  const p = Array.from(pro?.proParams ?? [], Number);
  const P = (i) => Number(p[i] ?? 0);
  const deg = (i) => +(P(i) * R).toPrecision(15);
  let ell = '';
  if (kind === 'WGS84') ell = ' +datum=WGS84';
  else if (kind === 'NAD83') ell = ' +datum=NAD83';
  else if (sph.a > 0) ell = ` +a=${sph.a} +b=${sph.b > 0 ? sph.b : sph.a}`;
  else ell = ' +datum=WGS84';
  if (kind === 'NAD27') ell = ` +ellps=clrk66 +towgs84=-8,160,176,0,0,0,0`;
  const params = Array.from(datum?.params ?? [], Number);
  if (!/datum=/.test(ell) && datum?.type === 'EPRJ_DATUM_PARAMETRIC' && params.length >= 3 && params.some((v) => v !== 0)) {
    const s = 206264.80624709636;
    ell = ell.replace(/ \+towgs84=\S+/, '') + ` +towgs84=${params[0]},${params[1]},${params[2]},${-(params[3] ?? 0) * s},${-(params[4] ?? 0) * s},${-(params[5] ?? 0) * s},${(params[6] ?? 0) * 1e6}`;
  }
  const num = Number(pro?.proNumber ?? -1);
  const ext = pro?.proType === 'EPRJ_EXTERNAL' ? String(pro.proExeName || pro.proName || '').toLowerCase() : '';
  const name = String(pro?.proName || mapInfo?.proName || 'HFA');
  const fe = ` +x_0=${P(6)} +y_0=${P(7)}`;
  const label = `${name}${dn ? ` (${dn})` : ''}`;
  if (ext === 'nzmg' || /new zealand map grid/i.test(name)) return { epsg: /nzgd.?49|geodetic datum 1949/i.test(dn) ? 27200 : null, proj4: `+proj=nzmg +lat_0=-41 +lon_0=173 +x_0=2510000 +y_0=6023150 +ellps=intl +towgs84=59.47,-5.04,187.44,0.47,-0.1,1.024,-4.5993 +units=m +no_defs`, label };
  if (ext) return { epsg: null, proj4: null, label, error: `the external projection "${pro.proExeName || pro.proName}" is not read` };
  if (!pro || num === 0 || (num === -1 && /^geographic|lat\/?lon/i.test(name))) {
    const epsg = kind === 'WGS84' ? 4326 : kind === 'NAD83' ? 4269 : kind === 'NAD27' ? 4267 : null;
    return { epsg, proj4: `+proj=longlat${ell} +title=${title(label || 'Geographic')} +no_defs`, label: label || 'Geographic' };
  }
  let def = null;
  let epsg = null;
  switch (num) {
    case 1: {
      const zone = Number(pro.proZone);
      const south = P(3) < 0;
      if (zone >= 1 && zone <= 60) {
        if (kind === 'WGS84') epsg = (south ? 32700 : 32600) + zone;
        else if (kind === 'NAD83' && !south && zone <= 23) epsg = 26900 + zone;
        else if (kind === 'NAD27' && !south && zone <= 22) epsg = 26700 + zone;
      }
      def = `+proj=utm +zone=${zone}${south ? ' +south' : ''}`;
      break;
    }
    case 3:
      def = `+proj=aea +lat_1=${deg(2)} +lat_2=${deg(3)} +lat_0=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 4:
      def = `+proj=lcc +lat_1=${deg(2)} +lat_2=${deg(3)} +lat_0=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 5:
      def = `+proj=merc +lat_ts=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 6:
      def = `+proj=stere +lat_0=${P(5) < 0 ? -90 : 90} +lat_ts=${deg(5)} +lon_0=${deg(4)} +k=1${fe}`;
      break;
    case 7:
      def = `+proj=poly +lat_0=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 8:
      def = `+proj=eqdc +lat_1=${deg(2)} +lat_2=${P(8) ? deg(3) : deg(2)} +lat_0=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 9:
    case 36:
      def = `+proj=tmerc +lat_0=${deg(5)} +lon_0=${deg(4)} +k=${P(2) || 1}${fe}`;
      break;
    case 10:
      def = `+proj=stere +lat_0=${deg(5)} +lon_0=${deg(4)} +k=1${fe}`;
      break;
    case 11:
      def = `+proj=laea +lat_0=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 12:
      def = `+proj=aeqd +lat_0=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 13:
      def = `+proj=gnom +lat_0=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 14:
      def = `+proj=ortho +lat_0=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 16:
      def = `+proj=sinu +lon_0=${deg(4)}${fe}`;
      break;
    case 17:
      def = `+proj=eqc +lat_ts=${deg(5)} +lon_0=${deg(4)}${fe}`;
      break;
    case 18:
      def = `+proj=mill +lon_0=${deg(4)}${fe}`;
      break;
    case 19:
      def = `+proj=vandg +lon_0=${deg(4)}${fe}`;
      break;
    case 24:
      def = `+proj=robin +lon_0=${deg(4)}${fe}`;
      break;
    case 28:
      def = `+proj=moll +lon_0=${deg(4)}${fe}`;
      break;
    default:
      return { epsg: null, proj4: null, label, error: `HFA projection ${num} (${name}) is not read` };
  }
  return { epsg, proj4: `${def}${ell}${u} +title=${title(label)} +no_defs`, label };
}

/**
 * Open an HFA image → {meta, source}. `sidecars`: the files opened with it (.ige spill, .rrd
 * overviews); `lx` the `legacy` bundle.
 */
export async function openHfa(file, lx, sidecars = []) {
  const cache = new Map();
  let cached = 0;
  const lru = {
    get: (k) => {
      const v = cache.get(k);
      if (v) {
        cache.delete(k);
        cache.set(k, v);
      }
      return v;
    },
    set: (k, v, n) => {
      cache.set(k, v);
      cached += n;
      while (cached > 96 << 20 && cache.size > 1) {
        const [ok, ov] = cache.entries().next().value;
        cache.delete(ok);
        cached -= ov.byteLength;
      }
    },
  };
  const tree = await hfaTree(file, lx);
  const layers = tree.childrenOf(tree.root, 'Eimg_Layer');
  if (!layers.length) throw new Error('the ERDAS Imagine file has no raster layer (Eimg_Layer)');
  const readers = [];
  for (const l of layers) readers.push(await layerReader(tree, l, lx, sidecars, lru));
  const W = readers[0].width;
  const H = readers[0].height;
  const same = readers.filter((r) => r.width === W && r.height === H);
  const types = new Set(same.map((r) => sampleTypeOf(r.pt)));
  const sampleType = types.size === 1 ? [...types][0] : 'f32';
  const bandNodes = layers.filter((_, i) => readers[i].width === W && readers[i].height === H);
  const complex = bandNodes.some((b) => readers[layers.indexOf(b)].parts > 1);
  // Output bands: one per layer, two (re, im) per complex layer.
  const vb = bandNodes.flatMap((b, k) => (readers[layers.indexOf(b)].parts > 1 ? [[k, 0], [k, 1]] : [[k, 0]]));
  // Per band: no-data, statistics, colour table.
  const bandsMeta = [];
  let nodata = null;
  for (let i = 0; i < bandNodes.length; i++) {
    const b = bandNodes[i];
    const nd = await tree.decode(tree.child(b, null, 'Eimg_NonInitializedValue')).catch(() => null);
    const v = nd?.valueBD?.values?.[0];
    if (i === 0 && Number.isFinite(v)) nodata = v;
    const st = await tree.decode(tree.child(b, null, 'Esta_Statistics')).catch(() => null);
    let colours = null;
    const dt = tree.child(b, 'Descriptor_Table', 'Edsc_Table');
    if (dt) {
      const col = async (n) => {
        const c = tree.child(dt, n, 'Edsc_Column');
        if (!c) return null;
        const ci = await tree.decode(c);
        const rows = Math.min(Number(ci.numRows) || 0, 65536);
        if (!rows || ci.dataType !== 'real' || !ci.columnDataPtr) return null;
        const d = await bytes(file, ci.columnDataPtr, ci.columnDataPtr + rows * 8);
        return new Float64Array(d.buffer, 0, rows);
      };
      const [r, g, bl, a] = await Promise.all(['Red', 'Green', 'Blue', 'Opacity'].map((n) => col(n).catch(() => null)));
      if (r && g && bl) colours = Array.from(r, (_, k) => [Math.round(r[k] * 255), Math.round(g[k] * 255), Math.round(bl[k] * 255), a ? Math.round(a[k] * 255) : 255]);
    }
    for (const part of readers[layers.indexOf(b)].parts > 1 ? [' (real)', ' (imaginary)'] : ['']) bandsMeta.push({ name: b.name + part, cw: NaN, fwhm: NaN, bad: false, layerType: readers[layers.indexOf(b)].layerType, pixelType: PIXEL[readers[layers.indexOf(b)].pt], stats: st ? { min: st.minimum, max: st.maximum, mean: st.mean, median: st.median, mode: st.mode, std: st.stddev } : null, colours });
  }
  // Georeferencing (band 1's Map_Info and Projection).
  const b0 = bandNodes[0];
  const mi = await tree.decode(tree.child(b0, 'Map_Info', 'Eprj_MapInfo')).catch(() => null);
  const proNode = tree.child(b0, 'Projection', 'Eprj_ProParameters');
  const pro = await tree.decode(proNode).catch(() => null);
  const datum = await tree.decode(tree.child(proNode, null, 'Eprj_Datum')).catch(() => null);
  let geotransform = null;
  if (mi?.upperLeftCenter && mi?.pixelSize) {
    const { x, y } = mi.upperLeftCenter;
    const { width: pw, height: ph } = mi.pixelSize;
    if ([x, y, pw, ph].every(Number.isFinite) && pw > 0 && ph > 0) geotransform = [x - pw / 2, pw, 0, y + ph / 2, 0, -ph];
  }
  const crs = geotransform ? hfaCrs(pro, datum, mi) : null;
  // Overviews: Eimg_Layer_SubSample children (internal), or the .rrd named in RRDNamesList.
  const levels = bandNodes.map(() => new Map()); // L → reader
  const rrdTrees = new Map();
  const addLevel = async (bi, t, n) => {
    const r = await layerReader(t, n, lx, sidecars, lru);
    const L = Math.round(Math.log2(W / r.width));
    if (L >= 1 && Math.abs(r.width - W / 2 ** L) <= 1 + W / 2 ** L * 0.02 && Math.abs(r.height - H / 2 ** L) <= 1 + H / 2 ** L * 0.02 && !levels[bi].has(L)) levels[bi].set(L, r);
  };
  let ovNote = null;
  // The .rrd beside the image (same stem): GDAL's HFAGetDependent, used when the names list points
  // at another file name (a renamed copy) or when there is no names list at all.
  const stem = baseName(file.name).replace(/\.[^.]+$/, '');
  const ownRrd = sidecars.find((x) => baseName(x.name) === `${stem}.rrd`) ?? null;
  const treeOf = async (f) => {
    if (!rrdTrees.has(f)) rrdTrees.set(f, await hfaTree(f, lx).catch(() => null));
    return rrdTrees.get(f);
  };
  for (let i = 0; i < bandNodes.length; i++) {
    for (const s of tree.childrenOf(bandNodes[i], 'Eimg_Layer_SubSample')) await addLevel(i, tree, s).catch(() => {});
    const rrd = await tree.decode(tree.child(bandNodes[i], 'RRDNamesList', 'Eimg_RRDNamesList'), 64).catch(() => null);
    for (const nm of rrd?.nameList ?? []) {
      const m = /^(.*?)\(:([^:]+):([^)]+)\)$/.exec(nm?.string ?? '');
      if (!m) continue;
      // The list may name the image itself (internal overviews) or its .rrd.
      const own = baseName(m[1]) === baseName(file.name);
      const f = own ? null : sidecars.find((x) => baseName(x.name) === baseName(m[1])) ?? (/\.rrd$/i.test(m[1]) ? ownRrd : null);
      if (!own && !f) {
        ovNote = `overviews are in ${baseName(m[1])}, which was not opened with the image (they are built on the fly instead)`;
        continue;
      }
      const t = own ? tree : await treeOf(f);
      const ln = t && t.child(t.root, m[2]);
      const sn = ln && t.child(ln, m[3]);
      if (sn) await addLevel(i, t, sn).catch(() => {});
    }
    if (!levels[i].size && ownRrd) {
      const t = await treeOf(ownRrd);
      const ln = t && t.child(t.root, bandNodes[i].name);
      for (const s of t ? t.childrenOf(ln, 'Eimg_Layer_SubSample') : []) await addLevel(i, t, s).catch(() => {});
    }
  }
  if (levels.every((m) => m.size)) ovNote = null;
  const nb = vb.length;
  const C = OUT[sampleType];
  const fill = Number.isFinite(nodata) ? nodata : 0;
  const source = {
    kind: 'hfa',
    imageIndex: 0,
    width: W,
    height: H,
    bands: nb,
    sampleType,
    nodata: Number.isFinite(nodata) ? nodata : null,
    async readWindow(x0, y0, w, h, sel) {
      return Promise.all(
        sel.map(async (k) => {
          const out = new C(w * h);
          const [b, part] = vb[k];
          await readers[layers.indexOf(bandNodes[b])].read(x0, y0, w, h, out, fill, part);
          return out;
        }),
      );
    },
    hasLevel: (L) => levels.every((m) => m.has(L)),
    async readLevel(L, x0, y0, w, h, sel) {
      return Promise.all(
        sel.map(async (k) => {
          const [b, part] = vb[k];
          const r = levels[b].get(L);
          const out = new C(w * h).fill(fill);
          const cw = Math.max(0, Math.min(w, r.width - x0));
          const ch = Math.max(0, Math.min(h, r.height - y0));
          if (cw > 0 && ch > 0) {
            const win = new C(cw * ch);
            await r.read(x0, y0, cw, ch, win, fill, part);
            for (let y = 0; y < ch; y++) out.set(win.subarray(y * cw, y * cw + cw), y * w);
          }
          return out;
        }),
      );
    },
  };
  const r0 = readers[0];
  const ovs = Math.max(0, ...levels.map((m) => m.size));
  const meta = {
    format: `ERDAS Imagine HFA (${PIXEL[r0.pt]}${r0.compressed ? ', RLE' : ''}${r0.spill ? `, spill file ${r0.spill}` : ''}${ovs ? `, ${ovs} overview level${ovs > 1 ? 's' : ''}` : ''})`,
    product: 'HFA',
    complex,
    bandsMeta,
    geotransform,
    epsg: crs?.epsg ?? null,
    proj4: crs?.proj4 ?? null,
    crsLabel: crs?.label ?? null,
    crsError: crs?.error ?? null,
    mapInfo: mi ? { proName: mi.proName, units: mi.units } : null,
    projection: pro ? { number: pro.proNumber, name: pro.proName, zone: pro.proZone, type: pro.proType, datum: datum?.datumname ?? null } : null,
    palette: bandsMeta[0]?.colours ?? null,
    thematic: r0.layerType === 'thematic',
    spill: r0.spill,
    overviews: ovs,
    overviewNote: ovNote,
    skippedLayers: layers.length - nb,
  };
  return { meta, source };
}
