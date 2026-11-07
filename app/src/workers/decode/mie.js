// MIE4NITF frame sequences in the decode worker (REQ-GAP-47). A MIE4NITF file opens as one image
// per camera set and layer (formats/mie4nitf.js): its frames are not opened at file open; a frame's
// image segments (one per camera, placed in the set's mosaic) are opened on the first request for
// that frame, kept in a small LRU, and read through the usual NITF sources, so a large JPEG 2000
// frame decodes only the tiles and resolution a view needs (workers/decode/j2ktiles.js, nitf.js).
// Multi-frame temporal blocks (IMODE F and T, uncompressed) are read frame by frame from their
// blocks. Each frame has its own tile pyramid; tile requests name their frame, so a frame change
// never mixes tiles. On the hosted copy, tiles of long sequences are also kept in OPFS
// (workers/decode/mie-cache.js).

import { mieCollection, MIE_FILE_TAGS, isoNs, msOf, encodeMTIMSA, encodeCAMSDA, encodeMIMCSA, encodeMTIMFA, encodeTMINTA } from '../../formats/mie4nitf.js';
import { writeNitfSegments } from '../../formats/nitf-writer.js';
import { makeImageSource, segmentLayout } from './nitf.js';
import { Pyramid, LRU, ctorFor } from './pyramid.js';
import { TileStore } from './mie-cache.js';
import { gwError } from '../../i18n/index.js';
import { wasmError, nested } from '../errors.js';

const PV = { INT: 0, SI: 1, R: 2, C: 3, B: 4 };
const SOURCES = 48; // open segment sources kept per sequence
const PYRAMIDS = 12; // frame pyramids kept per sequence
export const LONG_SEQUENCE = 32; // frames from which the OPFS tile store is used (hosted copy)

export const isMieImage = (im) => !!im.ish?.tres?.some((t) => t.tag === 'MTIMSA');

async function bytesAt(file, off, len) {
  return new Uint8Array(await file.slice(off, off + len).arrayBuffer());
}

/** A key cache over a shared LRU: one segment's blocks under its own prefix. */
const prefixed = (lru, p) => ({ get: (k) => lru.get(p + k), set: (k, v, n) => lru.set(p + k, v, n), delete: (k) => lru.delete(p + k) });

/**
 * Frame k of an uncompressed multi-frame temporal block (IMODE F: one band, T: several): every block
 * holds the block's pixels of each frame in turn, band by band (rows, then columns), as NFX writes
 * and reads them (github.com/mdegan2020/NFX, tests/nfx/helpers/decodeMotion.m).
 */
export function multiFrameSource(file, parse, im, k, nframes, cache) {
  const s = im.ish;
  const { NROWS: height, NCOLS: width, NBPR, NBPC, NPPBH: bw, NPPBV: bh, NBPP, ABPP } = s;
  const nb = s.NBANDS;
  if (s.IC !== 'NC') throw gwError('MIE4NITF temporal blocks of several frames are read uncompressed only (IC NC); image segment {n} has IC {ic}', { n: String(im.index + 1), ic: String(s.IC) }, 'E_MIE_BLOCK_CODEC');
  if ((bw * bh * NBPP) % 8) throw gwError('image segment {n}: a frame block of {w} × {h} pixels at {bits} bits does not end on a byte', { n: String(im.index + 1), w: String(bw), h: String(bh), bits: String(NBPP) }, 'E_MIE_BLOCK_ALIGN');
  const pv = PV[s.PVTYPE] ?? 0;
  const { sampleType } = segmentLayout(parse, s);
  const C = ctorFor(sampleType);
  const bandBytes = (bw * bh * NBPP) / 8;
  const frameBlock = nb * bandBytes;
  const blockBytes = nframes * frameBlock;
  if (im.seg.dataLength < NBPR * NBPC * blockBytes) throw gwError('image segment {n}: {have} bytes of data, {need} needed for {frames} frames', { n: String(im.index + 1), have: String(im.seg.dataLength), need: String(NBPR * NBPC * blockBytes), frames: String(nframes) }, 'E_MIE_BLOCK_SHORT');
  const tcode = parse.x.gw_nitf_sample_type(NBPP, pv);
  async function block(br, bc) {
    const key = `f${k}:${br},${bc}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const raw = await bytesAt(file, im.seg.dataOffset + (br * NBPR + bc) * blockBytes + k * frameBlock, frameBlock);
    const [p, n] = parse.put(raw);
    let planes;
    try {
      if (parse.x.gw_nitf_unpack(p, n, bw, bh, nb, NBPP, ABPP, s.PJUST === 'L' ? 1 : 0, pv, 'B'.charCodeAt(0)) !== 0) throw gwError('image segment {n}, frame {k}, block {br},{bc}: {msg}', { n: String(im.index + 1), k: String(k + 1), br: String(br), bc: String(bc), msg: nested(wasmError(parse)) });
      const out = parse.outBytes();
      const bpe = { 1: 1, 2: 2, 3: 2, 6: 4 }[tcode] ?? 4;
      planes = [];
      for (let b = 0; b < nb; b++) planes.push(new C(out.buffer.slice(out.byteOffset + b * bw * bh * bpe, out.byteOffset + (b + 1) * bw * bh * bpe)));
    } finally {
      parse.free(p, n);
    }
    const v = { planes };
    cache.set(key, v, frameBlock);
    return v;
  }
  return {
    kind: 'nitf-frame',
    imageIndex: im.index,
    width,
    height,
    bands: nb,
    sampleType,
    nodata: null,
    abpp: ABPP,
    async readWindow(x0, y0, w, h, bands, job) {
      const out = bands.map(() => new C(w * h));
      for (let br = Math.floor(y0 / bh); br <= Math.floor((y0 + h - 1) / bh); br++) {
        for (let bc = Math.floor(x0 / bw); bc <= Math.floor((x0 + w - 1) / bw); bc++) {
          job?.checkCancel?.();
          const b = await block(br, bc);
          const ys = Math.max(y0, br * bh);
          const ye = Math.min(y0 + h, br * bh + bh, height);
          const xs = Math.max(x0, bc * bw);
          const xe = Math.min(x0 + w, bc * bw + bw, width);
          for (let i = 0; i < bands.length; i++) {
            const src = b.planes[Math.min(bands[i], nb - 1)];
            for (let y = ys; y < ye; y++) out[i].set(src.subarray((y - br * bh) * bw + (xs - bc * bw), (y - br * bh) * bw + (xe - bc * bw)), (y - y0) * w + (xs - x0));
          }
        }
      }
      return out;
    },
  };
}

/** One camera set and layer of a MIE4NITF file, its frames opened on demand. */
export class MieSequence {
  constructor(file, parse, images, seq, { fileKey, tileCache }) {
    this.file = file;
    this.parse = parse;
    this.images = new Map(images.map((im) => [im.index, im]));
    this.seq = seq;
    this.width = seq.width;
    this.height = seq.height;
    this.bands = seq.bands;
    this.sampleType = seq.sampleType;
    this.tileCache = tileCache;
    this.blocks = new LRU(160 << 20);
    this.coarse = new LRU(48 << 20);
    this.sources = new Map(); // `${seg}:${k}` → Promise<source>
    this.pyramids = new Map(); // frame → Promise<Pyramid>
    this.key = `mie:${fileKey}:${seq.id}`;
    this.current = 0;
    this.stats = { framesOpened: 0, sourcesOpened: 0, store: null };
    this.store = null;
    this.nodata = null;
    this.abpp = null;
  }

  /** Open frame 0 (sizes, nodata) and, for long sequences on the hosted copy, the OPFS store. */
  async init() {
    const p = await this.pyramid(0);
    const src = p.src;
    this.nodata = src.nodata;
    this.abpp = src.abpp;
    this.levels = p.levels;
    if (this.seq.frames.length >= LONG_SEQUENCE) {
      this.store = await TileStore.open(this.key);
      this.stats.store = this.store ? this.store.info() : TileStore.unavailable();
    } else this.stats.store = { enabled: false, reason: `${this.seq.frames.length} frames (the tile store starts at ${LONG_SEQUENCE})` };
    return this;
  }

  partSource(seg, k) {
    const key = `${seg}:${k}`;
    let p = this.sources.get(key);
    if (p) {
      this.sources.delete(key);
      this.sources.set(key, p);
      return p;
    }
    const im = this.images.get(seg);
    if (!im) return Promise.reject(gwError('image segment {n} is missing', { n: String(seg + 1) }, 'E_MIE_SEGMENT'));
    const nframes = this.seq.framesPerSegment?.[seg] ?? 1;
    const cache = prefixed(this.blocks, `${seg}|`);
    p = nframes > 1 || /^[FT]$/.test(im.ish.IMODE) ? Promise.resolve().then(() => multiFrameSource(this.file, this.parse, im, k, nframes, cache)) : makeImageSource(this.file, this.parse, im, { cache });
    p.catch(() => this.sources.delete(key));
    this.sources.set(key, p);
    this.stats.sourcesOpened++;
    while (this.sources.size > SOURCES) this.sources.delete(this.sources.keys().next().value);
    return p;
  }

  /** The frame's mosaic as a pixel source: its cameras' segments drawn by display level. */
  async frameSource(f) {
    const fr = this.seq.frames[f];
    if (!fr) throw gwError('no frame {n} in this sequence', { n: String(f + 1) }, 'E_MIE_FRAME');
    const parts = await Promise.all(fr.parts.map(async (p) => ({ cam: this.seq.cameras[p.camera], src: await this.partSource(p.seg, p.k) })));
    for (const p of parts) {
      if (p.src.bands !== this.bands || p.src.sampleType !== this.sampleType) throw gwError('frame {f}: image segment {n} has {bands} {type} bands, the sequence {sbands} {stype}', { f: String(f + 1), n: String(p.src.imageIndex + 1), bands: String(p.src.bands), type: p.src.sampleType, sbands: String(this.bands), stype: this.sampleType }, 'E_MIE_LAYOUT');
    }
    const W = this.width;
    const H = this.height;
    const single = parts.length === 1 && parts[0].cam.x === 0 && parts[0].cam.y === 0 && parts[0].src.width === W && parts[0].src.height === H;
    const nodata = single ? parts[0].src.nodata : (parts[0]?.src.nodata ?? (this.seq.gappy || parts.length < this.seq.cameras.length ? 0 : null));
    const C = ctorFor(this.sampleType);
    const compose = async (L, x0, y0, w, h, bands, job, read) => {
      const f = 2 ** L;
      const out = bands.map(() => new C(w * h).fill(nodata ?? 0));
      for (const p of parts) {
        const px = p.cam.x / f;
        const py = p.cam.y / f;
        const pw = Math.ceil(p.src.width / f);
        const ph = Math.ceil(p.src.height / f);
        const xs = Math.max(x0, px);
        const ys = Math.max(y0, py);
        const xe = Math.min(x0 + w, px + pw);
        const ye = Math.min(y0 + h, py + ph);
        if (xe <= xs || ye <= ys) continue;
        const r = await read(p.src, xs - px, ys - py, xe - xs, ye - ys, bands, job);
        const sw = xe - xs;
        for (let k = 0; k < bands.length; k++) for (let y = ys; y < ye; y++) out[k].set(r[k].subarray((y - ys) * sw, (y - ys + 1) * sw), (y - y0) * w + (xs - x0));
      }
      return out;
    };
    if (single) return { ...parts[0].src, kind: 'mie-frame', frame: f, width: W, height: H };
    return {
      kind: 'mie-frame',
      frame: f,
      imageIndex: parts[0].src.imageIndex,
      width: W,
      height: H,
      bands: this.bands,
      sampleType: this.sampleType,
      nodata,
      abpp: parts[0].src.abpp,
      // A coarse level comes from the cameras' own levels when every camera starts on that level's grid.
      hasLevel: (L) => parts.every((p) => p.src.hasLevel?.(L) && p.cam.x % 2 ** L === 0 && p.cam.y % 2 ** L === 0),
      readLevel: (L, x0, y0, w, h, bands, job) => compose(L, x0, y0, w, h, bands, job, (s, ...a) => s.readLevel(L, ...a)),
      readWindow: (x0, y0, w, h, bands, job) => compose(0, x0, y0, w, h, bands, job, (s, ...a) => s.readWindow(...a)),
    };
  }

  pyramid(f) {
    let p = this.pyramids.get(f);
    if (p) {
      this.pyramids.delete(f);
      this.pyramids.set(f, p);
      return p;
    }
    p = this.frameSource(f).then((src) => {
      const pyr = new Pyramid(src, this.tileCache);
      // Stable keys: a pyramid made again for a frame finds its tiles still in the caches.
      pyr.key = `${this.key}#${f}`;
      pyr.coarse = this.coarse;
      this.stats.framesOpened++;
      return pyr;
    });
    p.catch(() => this.pyramids.delete(f));
    this.pyramids.set(f, p);
    while (this.pyramids.size > PYRAMIDS) this.pyramids.delete(this.pyramids.keys().next().value);
    return p;
  }

  /** A display tile of frame f, through the OPFS store when it is open. */
  async tile(f, L, tx, ty, bands, job) {
    const key = `${f}/${L}/${tx}/${ty}/${bands.join('.')}`;
    if (this.store) {
      const hit = await this.store.get(key);
      if (hit) return hit;
    }
    const pyr = await this.pyramid(f);
    const t = await pyr.tile(L, tx, ty, bands, job);
    if (this.store) this.store.put(key, t);
    return t;
  }

  info() {
    return { frames: this.seq.frames.length, current: this.current, openSources: this.sources.size, framesOpened: this.stats.framesOpened, sourcesOpened: this.stats.sourcesOpened, store: this.store ? this.store.info() : this.stats.store };
  }
}

/**
 * The MIE4NITF part of an opened NITF (openNitf with MIE segments deferred) → {collection,
 * sequences: [MieSequence]}; null when no segment carries MTIMSA.
 */
export async function openMie(file, r, parse, { tileCache }) {
  const deferred = r.images.filter((im) => im.deferred);
  if (!deferred.length) return null;
  const fileTres = [];
  for (const t of [...(r.header.tres ?? []), ...(r.header.extTres ?? [])]) if (MIE_FILE_TAGS.includes(t.tag)) fileTres.push({ tag: t.tag, bytes: await bytesAt(file, t.offset, t.length) });
  const segments = [];
  for (const im of deferred) {
    const t = im.ish.tres.find((x) => x.tag === 'MTIMSA');
    const lay = segmentLayout(parse, im.ish);
    segments.push({ index: im.index, mtimsa: await bytesAt(file, t.offset, t.length), width: im.ish.NCOLS, height: im.ish.NROWS, bands: lay.bands, sampleType: lay.sampleType, ic: im.ish.IC, imode: im.ish.IMODE });
  }
  const col = mieCollection({ fileTres, segments });
  // Frames per segment (multi-frame temporal blocks).
  const per = {};
  for (const s of col.sequences) for (const fr of s.frames) for (const p of fr.parts) per[p.seg] = Math.max(per[p.seg] ?? 0, p.k + 1);
  const fileKey = `${file.name}|${file.size}|${file.lastModified ?? 0}`;
  const sequences = [];
  for (const s of col.sequences) {
    s.framesPerSegment = per;
    sequences.push(await new MieSequence(file, parse, r.images, s, { fileKey, tileCache }).init());
  }
  return { collection: col, sequences };
}

/** What the main thread gets for a sequence: everything but the BigInt times, as numbers and text. */
export function describeSequence(s) {
  const q = s.seq;
  return {
    id: q.id,
    set: q.set,
    layer: q.layer,
    layerInfo: q.layerInfo,
    cameras: q.cameras,
    rate: q.rate,
    decoder: q.decoder,
    segments: [...new Set(q.frames.flatMap((f) => f.parts.map((p) => p.seg)))].sort((a, b) => a - b),
    frames: q.frames.map((f) => ({ ns: String(f.ns), ms: msOf(f.ns), iso: isoNs(f.ns), parts: f.parts })),
    gaps: q.gaps.map((g) => ({ camera: g.camera, interval: g.interval, start: isoNs(g.start), end: g.end === null ? null : isoNs(g.end) })),
    store: s.info().store,
  };
}

/**
 * A WAMI chip (REQ-GAP-47): window x0, y0, w, h of frames `frames` (indices) at level L (1/2^L),
 * written as a MIE4NITF file: one image segment per frame (IMODE B) when there are at most 999, else
 * temporal blocks of several frames (IMODE F/T), each with MTIMSA; CAMSDA, MIMCSA, MTIMFA and TMINTA
 * in the file header. `corners[i]`: the chip's IGEOLO corners for frame i (from the main thread's
 * frame models), or null. → Uint8Array.
 */
export async function writeChip(s, { x0, y0, w, h, L = 0, frames, corners = [], bands = null, security, title, camera, layer, job }) {
  if (!frames.length) throw gwError('no frames to write', null, 'E_MIE_CHIP_EMPTY');
  const f = 2 ** L;
  const lx = Math.floor(x0 / f);
  const ly = Math.floor(y0 / f);
  const lw = Math.max(1, Math.min(Math.ceil(w / f), Math.ceil(s.width / f) - lx));
  const lh = Math.max(1, Math.min(Math.ceil(h / f), Math.ceil(s.height / f) - ly));
  const bs = bands ?? Array.from({ length: s.bands }, (_, i) => i);
  const type = { u8: 'u8', u16: 'u16', i16: 'i16' }[s.sampleType] ?? 'f32';
  const per = Math.ceil(frames.length / 999);
  const q = s.seq;
  const rate = q.rate ?? null;
  const cam = camera ?? '00000000-0000-4000-8000-000000000001';
  const lay = layer ?? (q.layer || 'GW-CHIP');
  const list = [];
  const blocks = [];
  for (let b = 0; b * per < frames.length; b++) {
    const idx = frames.slice(b * per, (b + 1) * per);
    const planes = [];
    for (const fi of idx) {
      job?.checkCancel?.();
      const pyr = await s.pyramid(fi);
      const src = pyr.src;
      const r = L === 0 ? await src.readWindow(lx, ly, lw, lh, bs, job) : src.hasLevel?.(L) ? await src.readLevel(L, lx, ly, lw, lh, bs, job) : await pyramidWindow(pyr, L, lx, ly, lw, lh, bs, job);
      planes.push(r.map((p) => (type === 'f32' && !(p instanceof Float32Array) ? Float32Array.from(p) : p)));
      job?.progress?.((list.length * per + planes.length) / frames.length);
    }
    const ns = idx.map((fi) => BigInt(q.frames[fi].ns));
    const base = ns[0];
    // One DT per frame from the first (T(1) = base): DT_1 = 0, DT_i = t_i − t_{i−1} in ns.
    const dts = idx.length > 1 ? ns.map((t, i) => (i ? t - ns[i - 1] : 0n)) : [];
    const mtimsa = encodeMTIMSA({ segment: b + 1, layer: lay, set: 1, camera: cam, interval: 1, block: b + 1, rate, refFrame: q.frames[idx[0]].refFrame ?? frames[b * per] + 1, base, mult: 1n, dts, frames: idx.length });
    const fc = corners[b * per] ?? null;
    const img = idx.length === 1 ? { width: lw, height: lh, bands: bs.length, type, planes: planes[0] } : { width: lw, height: lh, bands: bs.length, type, frames: planes };
    list.push({ img, opts: { iid1: `MIE${String(b + 1).padStart(3, '0')}`, iid2: `chip frame ${frames[b * per] + 1}`, idatim: isoNs(base).replace(/[-:T]/g, '').slice(0, 14), icat: 'VIS', corners: fc, imode: idx.length > 1 ? (bs.length === 1 ? 'F' : 'T') : 'B', tres: [['MTIMSA', mtimsa]] } });
    blocks.push({ start: base, end: ns.at(-1) + (rate ? BigInt(Math.round(1e9 / rate)) : 1n), segment: b + 1 });
  }
  const start = blocks[0].start;
  const end = blocks.at(-1).end;
  const fileTres = [
    ['CAMSDA', encodeCAMSDA([{ cameras: [{ id: cam, desc: 'GIS Workbench WAMI chip', layer: lay, idlvl: 1, ialvl: 0, iloc: [0, 0], nrows: lh, ncols: lw }] }])],
    ['MIMCSA', encodeMIMCSA({ layer: lay, rate, decoder: 'NC' })],
    ['TMINTA', encodeTMINTA([{ index: 1, start, end }])],
    ['MTIMFA', encodeMTIMFA({ layer: lay, set: 1, interval: 1, cameras: [{ id: cam, blocks }] })],
  ];
  return writeNitfSegments(list, { security, title: title ?? 'GIS Workbench MIE4NITF chip', fileTres });
}

/** Window of pyramid level L assembled from its display tiles' cores (no native level). */
async function pyramidWindow(pyr, L, x0, y0, w, h, bands, job) {
  const C = ctorFor(pyr.src.sampleType);
  const out = bands.map(() => new C(w * h));
  const T = 512;
  for (let ty = Math.floor(y0 / T); ty <= Math.floor((y0 + h - 1) / T); ty++) {
    for (let tx = Math.floor(x0 / T); tx <= Math.floor((x0 + w - 1) / T); tx++) {
      const cores = await pyr.coreGroup(L, tx, ty, bands, job);
      cores.forEach((c, k) => {
        for (let y = Math.max(y0, ty * T); y < Math.min(y0 + h, ty * T + c.h); y++) {
          const xs = Math.max(x0, tx * T);
          const xe = Math.min(x0 + w, tx * T + c.w);
          out[k].set(c.data.subarray((y - ty * T) * c.w + (xs - tx * T), (y - ty * T) * c.w + (xe - tx * T)), (y - y0) * w + (xs - x0));
        }
      });
    }
  }
  return out;
}
