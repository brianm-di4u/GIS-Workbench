// Streaming Cloud-Optimized GeoTIFF writer (REQ-CNV-01, spike S-32; DN-59): converts images of
// any size within a fixed memory ceiling. Each resolution level is read in strips of one tile
// row (`read(level, x0, y0, w, h)` → chunky samples of that level), its tiles compressed and
// appended to a temporary file of their own (OPFS when the browser has it, memory otherwise).
// The COG is then assembled as a Blob of the header and those files — header and IFDs first,
// tiles from the smallest overview to full resolution — without copying the tile data into
// memory. Past 4 GB the file is BigTIFF. Overviews are read from the source at 2^k steps
// (the decoder's own reduced reads), not cascaded from the full resolution, so nothing larger
// than one strip is ever held.

import { TYPE, BPS, FMT, ARR, deflate, predict2, predict3, geoKeys } from './geotiff-writer.js';

const LONG8 = 16;

/** Temporary storage: OPFS files when available, else in-memory chunks. → {create(name) → {write(u8), size, done() → Blob}, cleanup()} */
export async function tempStore() {
  let dir = null;
  try {
    dir = await navigator.storage?.getDirectory?.();
  } catch {}
  const made = [];
  return {
    opfs: !!dir,
    async create(name) {
      if (dir) {
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        made.push(name);
        let size = 0;
        return {
          async write(u8) {
            await w.write(u8);
            size += u8.length;
          },
          get size() {
            return size;
          },
          async done() {
            await w.close();
            return fh.getFile();
          },
        };
      }
      const parts = [];
      let size = 0;
      return {
        async write(u8) {
          parts.push(u8);
          size += u8.length;
        },
        get size() {
          return size;
        },
        async done() {
          return new Blob(parts);
        },
      };
    },
    async cleanup() {
      for (const n of made) await dir?.removeEntry(n).catch(() => {});
    },
  };
}

/** Level sizes: full resolution, then halved until the level fits one tile. */
export function cogLevels(width, height, tile, overviews = true) {
  const out = [{ width, height, step: 1 }];
  while (overviews && (out.at(-1).width > tile || out.at(-1).height > tile)) {
    const p = out.at(-1);
    out.push({ width: Math.ceil(p.width / 2), height: Math.ceil(p.height / 2), step: p.step * 2 });
  }
  return out;
}

/** IFD bytes for classic TIFF or BigTIFF at `at`; out-of-line values follow the entries. */
function ifdBytes(tags, at, next, big) {
  const SZ = { [TYPE.BYTE]: 1, [TYPE.ASCII]: 1, [TYPE.SHORT]: 2, [TYPE.LONG]: 4, [TYPE.DOUBLE]: 8, [LONG8]: 8 };
  const inline = big ? 8 : 4;
  const entry = big ? 20 : 12;
  const head = (big ? 8 : 2) + tags.length * entry + (big ? 8 : 4);
  let extra = 0;
  for (const [, t, v] of tags) {
    const nb = v.length * SZ[t];
    if (nb > inline) extra += nb + (nb & 1);
  }
  const buf = new ArrayBuffer(head + extra);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  if (big) dv.setBigUint64(p, BigInt(tags.length), true);
  else dv.setUint16(p, tags.length, true);
  p += big ? 8 : 2;
  let x = head;
  for (const [tag, t, v] of tags) {
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, t, true);
    if (big) dv.setBigUint64(p + 4, BigInt(v.length), true);
    else dv.setUint32(p + 4, v.length, true);
    const nb = v.length * SZ[t];
    let q = nb > inline ? x : p + (big ? 12 : 8);
    if (nb > inline) {
      if (big) dv.setBigUint64(p + 12, BigInt(at + x), true);
      else dv.setUint32(p + 8, at + x, true);
    }
    if (t === TYPE.ASCII || t === TYPE.BYTE) u8.set(v, q);
    else
      for (const val of v) {
        if (t === TYPE.SHORT) dv.setUint16(q, val, true);
        else if (t === TYPE.LONG) dv.setUint32(q, val, true);
        else if (t === TYPE.DOUBLE) dv.setFloat64(q, val, true);
        else dv.setBigUint64(q, BigInt(val), true);
        q += SZ[t];
      }
    if (nb > inline) x += nb + (nb & 1);
    p += entry;
  }
  if (big) dv.setBigUint64(p, BigInt(next), true);
  else dv.setUint32(p, next, true);
  return u8;
}

/**
 * Write a COG by streaming. src = {width, height, bands, type, read(level, x0, y0, w, h) →
 * typed chunky array}; opts as writeGeoTiff (tile 512, compress, predictor, epsg,
 * geotransform | gcps, nodata, photometric, description). onProgress(fraction). → Blob.
 */
export async function writeCogStream(src, opts = {}, onProgress = () => {}) {
  const tile = opts.tile ?? 512;
  const { bands: n, type } = src;
  const compress = opts.compress ?? 'deflate';
  const predictor = compress === 'none' ? 1 : opts.predictor ?? (type === 'f32' ? 3 : 2);
  const fill = opts.nodata ?? 0;
  const levels = cogLevels(src.width, src.height, tile, opts.overviews !== false);
  const totalTiles = levels.reduce((s, l) => s + Math.ceil(l.width / tile) * Math.ceil(l.height / tile), 0);
  const store = await tempStore();
  let done = 0;
  const parts = [];
  try {
    // Only full resolution is read. Each overview is every other sample of the level above, taken
    // from the tile rows as they are written (one tile row buffered per level), so the source is
    // decoded once instead of once per level: a 16k² JPEG GeoTIFF took 130 s (TE 2.0.4 cross).
    // The samples are those a read with step 2^k gave.
    const lv = await Promise.all(
      levels.map(async (l, k) => ({
        ...l,
        out: await store.create(`gw-cog-${Date.now()}-${k}.bin`),
        offs: [],
        counts: [],
        buf: k ? new ARR[type](tile * l.width * n).fill(fill) : null,
        y0: 0, // first row of the buffered tile row (overviews)
      })),
    );
    /** Compress and write the tiles of a strip of level k (columns x0…x0+w, rows y0…y0+h). */
    const writeTiles = async (k, data, w, x0, y0, h) => {
      const L = lv[k];
      const jobs = [];
      for (let ox = 0; ox < w; ox += tile) {
        const t = new ARR[type](tile * tile * n);
        if (fill !== 0) t.fill(fill);
        const cw = Math.min(tile, w - ox);
        for (let y = 0; y < h; y++) t.set(data.subarray((y * w + ox) * n, (y * w + ox + cw) * n), y * tile * n);
        let b = new Uint8Array(t.buffer);
        if (predictor === 2) predict2(b, type, tile, tile, n);
        else if (predictor === 3) b = predict3(b, tile, tile, n);
        jobs.push(compress === 'deflate' ? deflate(b) : Promise.resolve(b));
      }
      for (const c of await Promise.all(jobs)) {
        L.offs.push(L.out.size);
        L.counts.push(c.length);
        await L.out.write(c);
      }
      done += jobs.length;
      onProgress(done / totalTiles);
      // Even rows and columns go to the next level's tile row.
      const N = lv[k + 1];
      if (!N) return;
      for (let y = y0 + (y0 & 1); y < y0 + h; y += 2) {
        const r = y / 2 - N.y0;
        for (let x = x0 + (x0 & 1); x < x0 + w; x += 2) {
          const s = ((y - y0) * w + (x - x0)) * n;
          N.buf.set(data.subarray(s, s + n), (r * N.width + x / 2) * n);
        }
      }
    };
    /** Level k's rows are complete up to `rows`: write the next level's full tile rows. */
    const flush = async (k, rows) => {
      const N = lv[k + 1];
      if (!N) return;
      const ready = Math.min(N.height, Math.ceil(rows / 2));
      while (N.y0 < N.height && (ready >= N.y0 + tile || ready >= N.height)) {
        const h = Math.min(tile, N.height - N.y0);
        await writeTiles(k + 1, N.buf, N.width, 0, N.y0, h);
        await flush(k + 1, N.y0 + h);
        N.y0 += tile;
        N.buf.fill(fill);
      }
    };
    const span = Math.max(1, Math.floor(16384 / tile)) * tile; // a read strip ≤ 16 384 px wide
    // `src.parallel` strips are read ahead (the caller spreads them over several decoders) and
    // written in order: a whole WorldView strip decoded one J2K strip at a time took over 300 s.
    const strips = [];
    for (let y0 = 0; y0 < src.height; y0 += tile)
      for (let x0 = 0; x0 < src.width; x0 += span) strips.push({ x0, y0, w: Math.min(span, src.width - x0), h: Math.min(tile, src.height - y0), last: x0 + span >= src.width });
    const ahead = Math.max(1, src.parallel ?? 1);
    const reads = new Map();
    let next = 0;
    for (let i = 0; i < strips.length; i++) {
      while (next < strips.length && reads.size < ahead) {
        const s = strips[next];
        const p = src.read(0, s.x0, s.y0, s.w, s.h);
        p.catch(() => {}); // surfaced when awaited in order
        reads.set(next++, p);
      }
      const s = strips[i];
      const data = await reads.get(i);
      reads.delete(i);
      await writeTiles(0, data, s.w, s.x0, s.y0, s.h);
      if (s.last) await flush(0, s.y0 + s.h);
    }
    for (const L of lv) parts.push({ lv: { width: L.width, height: L.height, step: L.step }, offs: L.offs, counts: L.counts, blob: await L.out.done() });
    // Layout: header, IFDs (full resolution first), then tiles from the smallest overview up.
    const dataBytes = parts.reduce((s, p) => s + p.blob.size, 0);
    const big = opts.bigTiff ?? dataBytes + 1e6 > 0xffffffff;
    const ascii = (s) => new TextEncoder().encode(`${s}\0`);
    const tagsOf = (p, k, offsets) => {
      const t = [
        ...(k ? [[254, TYPE.LONG, [1]]] : []),
        [256, TYPE.LONG, [p.lv.width]],
        [257, TYPE.LONG, [p.lv.height]],
        [258, TYPE.SHORT, Array(n).fill(BPS[type])],
        [259, TYPE.SHORT, [compress === 'deflate' ? 8 : 1]],
        [262, TYPE.SHORT, [opts.photometric === 'rgb' ? 2 : 1]],
        ...(k === 0 && opts.description ? [[270, TYPE.ASCII, ascii(opts.description)]] : []),
        [277, TYPE.SHORT, [n]],
        [284, TYPE.SHORT, [1]],
        ...(k === 0 ? [[305, TYPE.ASCII, ascii(opts.software ?? 'GIS Workbench')]] : []),
        ...(predictor > 1 ? [[317, TYPE.SHORT, [predictor]]] : []),
        [322, TYPE.SHORT, [tile]],
        [323, TYPE.SHORT, [tile]],
        [324, big ? LONG8 : TYPE.LONG, offsets],
        [325, TYPE.LONG, p.counts],
        ...(opts.photometric === 'rgb' && n === 4 ? [[338, TYPE.SHORT, [2]]] : n > 1 && opts.photometric !== 'rgb' ? [[338, TYPE.SHORT, Array(n - 1).fill(0)]] : []),
        [339, TYPE.SHORT, Array(n).fill(FMT[type])],
      ];
      if (k === 0 && opts.epsg) {
        if (opts.geotransform) {
          const [x0, dx, , y0, , dy] = opts.geotransform;
          t.push([33550, TYPE.DOUBLE, [dx, Math.abs(dy), 0]], [33922, TYPE.DOUBLE, [0, 0, 0, x0, y0, 0]]);
        } else if (opts.gcps?.length) t.push([33922, TYPE.DOUBLE, opts.gcps.flatMap((g) => [g.x, g.y, 0, g.lon, g.lat, g.h ?? 0])]);
        t.push([34735, TYPE.SHORT, geoKeys({ epsg: opts.epsg, vertical: opts.vertical })]);
      }
      if (k === 0 && opts.nodata !== undefined && opts.nodata !== null) t.push([42113, TYPE.ASCII, ascii(Number.isNaN(opts.nodata) ? 'nan' : String(opts.nodata))]);
      return t.sort((a, b) => a[0] - b[0]);
    };
    // Two passes: sizes with placeholder offsets, then the real offsets.
    const headLen = big ? 16 : 8;
    const zeros = parts.map((p, k) => tagsOf(p, k, p.offs.map(() => 0)));
    const lens = zeros.map((t) => ifdBytes(t, 0, 0, big).length);
    const ifdAt = [];
    let at = headLen;
    for (const l of lens) {
      ifdAt.push(at);
      at += l + (l & 1);
    }
    const base = [];
    let cur = at;
    for (let k = parts.length - 1; k >= 0; k--) {
      base[k] = cur;
      cur += parts[k].blob.size;
    }
    const ifds = parts.map((p, k) => ifdBytes(tagsOf(p, k, p.offs.map((o) => base[k] + o)), ifdAt[k], k + 1 < parts.length ? ifdAt[k + 1] : 0, big));
    const head = new Uint8Array(at);
    const dv = new DataView(head.buffer);
    dv.setUint16(0, 0x4949, true);
    if (big) {
      dv.setUint16(2, 43, true);
      dv.setUint16(4, 8, true);
      dv.setBigUint64(8, BigInt(ifdAt[0]), true);
    } else {
      dv.setUint16(2, 42, true);
      dv.setUint32(4, ifdAt[0], true);
    }
    ifds.forEach((b, k) => head.set(b, ifdAt[k]));
    return { blob: new Blob([head, ...[...parts].reverse().map((p) => p.blob)], { type: 'image/tiff' }), bigTiff: big, levels: levels.length, cleanup: () => store.cleanup(), opfs: store.opfs };
  } catch (e) {
    await store.cleanup();
    throw e;
  }
}
