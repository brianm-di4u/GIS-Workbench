// ENVI raw images (REQ-MSI-01, REQ-FMT-09): the header is parsed by the Rust `parse` bundle;
// samples are read from the raw file by File.slice for the requested window only — BSQ reads
// one contiguous run per row and band, BIL one per row, BIP one per row for every band — for
// every data type (1, 2, 3, 4, 5, 6, 9, 12, 13, 14, 15) and either byte order. Complex types
// read as magnitude; 64-bit integers as float.

const LE = true;

function readerFor(dt, littleEndian) {
  switch (dt) {
    case 1:
      return { bps: 1, get: (v, o) => v.getUint8(o), type: 'u8' };
    case 2:
      return { bps: 2, get: (v, o) => v.getInt16(o, littleEndian), type: 'i16' };
    case 12:
      return { bps: 2, get: (v, o) => v.getUint16(o, littleEndian), type: 'u16' };
    case 3:
      return { bps: 4, get: (v, o) => v.getInt32(o, littleEndian), type: 'f32' };
    case 13:
      return { bps: 4, get: (v, o) => v.getUint32(o, littleEndian), type: 'f32' };
    case 4:
      return { bps: 4, get: (v, o) => v.getFloat32(o, littleEndian), type: 'f32' };
    case 5:
      return { bps: 8, get: (v, o) => v.getFloat64(o, littleEndian), type: 'f32' };
    case 14:
      return { bps: 8, get: (v, o) => Number(v.getBigInt64(o, littleEndian)), type: 'f32' };
    case 15:
      return { bps: 8, get: (v, o) => Number(v.getBigUint64(o, littleEndian)), type: 'f32' };
    case 6:
      return { bps: 8, get: (v, o) => Math.hypot(v.getFloat32(o, littleEndian), v.getFloat32(o + 4, littleEndian)), type: 'f32' };
    case 9:
      return { bps: 16, get: (v, o) => Math.hypot(v.getFloat64(o, littleEndian), v.getFloat64(o + 8, littleEndian)), type: 'f32' };
    default:
      throw new Error(`ENVI data type ${dt} is not supported`);
  }
}

/** Band metadata from the header: names, centre wavelengths and FWHM in µm, bad-band list. */
export function enviBands(hd) {
  const unit = String(hd.wavelengthUnits ?? '').toLowerCase();
  const k = /nano/.test(unit) ? 1e-3 : /micro|µm|um/.test(unit) ? 1 : /^m/.test(unit) && !/micro/.test(unit) ? 1e6 : null;
  // Units missing: values above 100 are nanometres, else micrometres.
  const scale = (v) => (Number.isFinite(v) ? v * (k ?? (v > 100 ? 1e-3 : 1)) : NaN);
  return Array.from({ length: hd.bands }, (_, i) => ({
    name: hd.bandNames[i] ?? `Band ${i + 1}`,
    cw: scale(hd.wavelength[i]),
    fwhm: scale(hd.fwhm[i]),
    bad: hd.bbl.length === hd.bands ? hd.bbl[i] === 0 : false,
  }));
}

/** A source over the raw ENVI file `file` described by header JSON `hd`. */
export function enviSource(file, hd) {
  const { samples: W, lines: H, bands: NB, headerOffset: off, interleave: il, byteOrder, dataType } = hd;
  if (!hd.sizeOk) throw new Error(`the ENVI data file is ${file.size} bytes; the header needs ${hd.needBytes}`);
  const rd = readerFor(dataType, byteOrder === 0 ? LE : !LE);
  const C = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array }[rd.type];
  const bps = rd.bps;
  const nodata = Number.isFinite(hd.ignore) ? hd.ignore : rd.type === 'f32' ? NaN : null;
  async function range(o, n) {
    return new DataView(await file.slice(o, o + n).arrayBuffer());
  }
  // A whole BIL line holds every band; when only a few are wanted (a 3-band display of a 425-band
  // cube) each band's run is read on its own, not the 1–2 MB line (TE archive: AVIRIS-NG).
  const wholeLine = (bands) => bands.length * 4 >= NB;
  /** Row y, columns xs…xe−1, for each band → reader(band) → (x) → value. */
  async function row(y, xs, xe, bands) {
    if (il === 'bip') {
      // One run per row: pixels xs…xe with every band.
      const v = await range(off + (y * W + xs) * NB * bps, (xe - xs) * NB * bps);
      return bands.map((b) => (x) => rd.get(v, ((x - xs) * NB + b) * bps));
    }
    if (il === 'bil' && wholeLine(bands)) {
      const v = await range(off + y * NB * W * bps, NB * W * bps);
      return bands.map((b) => (x) => rd.get(v, (b * W + x) * bps));
    }
    // BSQ, and BIL with few bands: one run per band.
    const at = (b) => off + (il === 'bil' ? (y * NB + b) * W + xs : (b * H + y) * W + xs) * bps;
    const vs = await Promise.all(bands.map((b) => range(at(b), (xe - xs) * bps)));
    return vs.map((v) => (x) => rd.get(v, (x - xs) * bps));
  }
  // Rows are read ROWS_IN_FLIGHT at a time: a read is latency-bound (≈43 ms one after another,
  // ≈4 ms each in parallel, from a USB disk), so a 1024-line window no longer waits a minute (TE 2.0.4 cross).
  const ROWS_IN_FLIGHT = 64;
  async function rows(keys, yOf, xs, xe, bands, job, put) {
    for (let i = 0; i < keys.length; i += ROWS_IN_FLIGHT) {
      job?.checkCancel?.();
      const batch = keys.slice(i, i + ROWS_IN_FLIGHT);
      const gets = await Promise.all(batch.map((k) => row(yOf(k), xs, xe, bands)));
      batch.forEach((k, n) => put(k, gets[n]));
    }
  }
  return {
    kind: 'envi',
    imageIndex: 0,
    width: W,
    height: H,
    bands: NB,
    sampleType: rd.type,
    nodata,
    // Coarse levels of a large cube read every 2^L-th line only (nearest, at the centre of each
    // cell), as uncompressed NITF does (TE-019): a 4.6 GB AVIRIS-NG cube's first view reads ~1/16 of
    // the lines it used to. Small images keep the averaged pyramid (faithful DRA histograms, TE-042).
    // Level 1 too above 1 GB: an averaged level-1 tile read a 1024-line full-resolution window.
    hasLevel: (L) => (L >= 2 && W * H * NB * bps > 256 * 2 ** 20) || (L === 1 && W * H * NB * bps > 2 ** 30),
    async readLevel(L, x0, y0, w, h, bands, job) {
      const sc = 2 ** L;
      const half = sc >> 1;
      const out = bands.map(() => new C(w * h).fill(nodata ?? 0));
      const xa = Math.min(W - 1, x0 * sc + half);
      const xb = Math.min(W - 1, (x0 + w - 1) * sc + half);
      const ys = [];
      for (let j = 0; j < h && (y0 + j) * sc + half < H; j++) ys.push(j);
      await rows(ys, (j) => (y0 + j) * sc + half, xa, xb + 1, bands, job, (j, get) => {
        for (let k = 0; k < bands.length; k++) {
          const dst = out[k];
          for (let i = 0; i < w; i++) {
            const X = (x0 + i) * sc + half;
            if (X < W) dst[j * w + i] = get[k](X);
          }
        }
      });
      return out;
    },
    async readWindow(x0, y0, w, h, bands, job) {
      const out = bands.map(() => new C(w * h));
      const xs = Math.max(0, x0);
      const xe = Math.min(W, x0 + w);
      if (xe <= xs) return out;
      const ys = [];
      for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) ys.push(y);
      await rows(ys, (y) => y, xs, xe, bands, job, (y, get) => {
        const dy = (y - y0) * w;
        for (let k = 0; k < bands.length; k++) {
          const dst = out[k];
          for (let x = xs; x < xe; x++) dst[dy + x - x0] = get[k](x);
        }
      });
      return out;
    },
  };
}

/** GDAL_METADATA per-band items (description, wavelength, fwhm, units, scale/offset) → bands. */
export function gdalBands(tree, nb) {
  const items = [];
  const walk = (n) => {
    if (n.n === 'Item') items.push(n);
    for (const c of n.c ?? []) walk(c);
  };
  if (tree) walk(tree);
  const out = Array.from({ length: nb }, (_, i) => ({ name: `Band ${i + 1}`, cw: NaN, fwhm: NaN, bad: false }));
  const units = [];
  let scale = null;
  let offset = null;
  for (const it of items) {
    const s = Number(it.a?.sample ?? NaN);
    const name = String(it.a?.name ?? '').toLowerCase();
    const role = String(it.a?.role ?? '').toLowerCase();
    const v = it.t ?? '';
    if (role === 'scale' || name === 'scale') scale = Number(v);
    if (role === 'offset' || name === 'offset') offset = Number(v);
    if (!Number.isInteger(s) || s < 0 || s >= nb) continue;
    if (role === 'description' || name === 'description') out[s].name = v || out[s].name;
    else if (name === 'wavelength' || name === 'central_wavelength') out[s].cw = Number(v);
    else if (name === 'fwhm' || name === 'bandwidth') out[s].fwhm = Number(v);
    else if (name === 'wavelength_units' || name === 'units' && role !== 'unittype') units[s] = v;
  }
  out.forEach((b, i) => {
    const u = String(units[i] ?? '').toLowerCase();
    const k = /nano/.test(u) ? 1e-3 : /micro/.test(u) ? 1 : b.cw > 100 ? 1e-3 : 1;
    b.cw *= k;
    b.fwhm *= k;
  });
  return { bands: out, scale: Number.isFinite(scale) ? scale : null, offset: Number.isFinite(offset) ? offset : null };
}
