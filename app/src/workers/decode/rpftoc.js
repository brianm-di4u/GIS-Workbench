// RPF table of contents (A.TOC, MIL-STD-2411; REQ-FMT-40): the TOC is parsed by the Rust `legacy`
// bundle (gw-parse rpf_toc); each boundary rectangle (one product, scale and ARC zone) becomes one
// raster source whose frames (CADRG VQ or CIB, read by nitf.js) sit on the TOC's frame grid. Frames
// open on first use and missing ones read as nodata. Equal-arc zones are georeferenced from the TOC
// corners and intervals (as GDAL's RPFTOC driver does); the polar zones 9 and J (18) from the first
// frame's coverage section in the ARC azimuthal equidistant plane.

import { openNitf } from './nitf.js';
import { gwError } from '../../i18n/index.js';
import { wasmError, nested } from '../errors.js';

const FRAME = 1536; // CADRG and CIB frames are 1536 × 1536 (MIL-C-89038 / MIL-C-89041 §3.5.2)

/** Parse an A.TOC (whole file) → {boundaries: [...]}. */
export async function readToc(file, legacy) {
  if (file.size > 64 << 20) throw gwError('an A.TOC of {mb} MB is not plausible (RPF tables of contents are kilobytes)', { mb: (file.size / 2 ** 20).toFixed(0) });
  const bytes = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
  const [p, n] = legacy.put(bytes);
  try {
    if (legacy.x.gw_rpf_toc(p, n) !== 0) throw gwError('RPF table of contents: {msg}', { msg: nested(wasmError(legacy)) });
    return legacy.outJson();
  } finally {
    legacy.free(p, n);
  }
}

const key = (dir, name) => `${String(dir ?? '').replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '').toLowerCase()}|${String(name).toLowerCase()}`;
const pathOf = (f) => String(f.webkitRelativePath || f.relPath || f.name).replace(/\\/g, '/');

/** Frame files by TOC entry: the file whose path ends with dir/name, else the only one so named. */
export function matchFrames(toc, files) {
  const byName = new Map();
  for (const f of files) {
    const n = pathOf(f).split('/').pop().toLowerCase();
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(f);
  }
  const out = new Map();
  for (const b of toc.boundaries)
    for (const fr of b.frames) {
      const cands = byName.get(fr.file.toLowerCase()) ?? [];
      const want = `${fr.dir ? `${fr.dir}/` : ''}${fr.file}`.toLowerCase();
      const hit = cands.find((f) => pathOf(f).toLowerCase().endsWith(want)) ?? (cands.length === 1 ? cands[0] : cands[0] ?? null);
      if (hit) out.set(key(fr.dir, fr.file), hit);
    }
  return out;
}

/** RPF coverage-section corners [[lat, lon] NW, NE, SE, SW] of an opened frame (location 130). */
async function frameCorners(file, ish) {
  const tre = (ish?.tres ?? []).find((t) => t.tag === 'RPFIMG');
  if (!tre) return null;
  const t = new DataView(await file.slice(tre.offset, tre.offset + tre.length).arrayBuffer());
  if (t.byteLength < 10 || t.getUint16(8) !== 10) return null;
  const sec = t.getUint32(2);
  const n = t.getUint16(6);
  for (let k = 0; k < n && sec + 10 * k + 10 <= t.byteLength; k++) {
    if (t.getUint16(sec + 10 * k) !== 130) continue;
    const off = t.getUint32(sec + 10 * k + 6);
    const c = new DataView(await file.slice(off, off + 64).arrayBuffer());
    if (c.byteLength < 64) return null;
    const [nwLat, nwLon, swLat, swLon, neLat, neLon, seLat, seLon] = Array.from({ length: 8 }, (_, i) => c.getFloat64(8 * i));
    const pts = [[nwLat, nwLon], [neLat, neLon], [seLat, seLon], [swLat, swLon]];
    return pts.every(([la, lo]) => Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 360) ? pts : null;
  }
  return null;
}

/** Affine pixel → ARC polar plane (sphere R = 6 378 137 m on the pole) through four frame corners. */
export function polarAffine(corners, W, H) {
  const north = corners[0][0] > 0;
  const R = 6378137;
  const d2r = Math.PI / 180;
  const P = corners.map(([lat, lon]) => {
    const rho = R * (Math.PI / 2 - Math.abs(lat) * d2r);
    return [rho * Math.sin(lon * d2r), (north ? -1 : 1) * rho * Math.cos(lon * d2r)];
  });
  const px = [[0, 0], [W, 0], [W, H], [0, H]];
  const solve = (k) => {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const b = [0, 0, 0];
    px.forEach(([c, r], i) => {
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
  return { gt: [gx[0], gx[1], gx[2], gy[0], gy[1], gy[2]], code: north ? 990009 : 990018 };
}

/**
 * Open an A.TOC with the frame files given beside it → {toc, sources, missing, used}. One source per
 * boundary rectangle with at least one frame present (overviews and legends are listed, not opened).
 */
export async function openRpfToc(file, frames, { legacy, parse }) {
  const toc = await readToc(file, legacy);
  const found = matchFrames(toc, frames);
  const sources = [];
  const notes = [];
  let missing = 0;
  for (const b of toc.boundaries) {
    const have = b.frames.filter((fr) => found.has(key(fr.dir, fr.file)));
    missing += b.frames.length - have.length;
    if (b.overview) {
      if (b.frames.length) notes.push(`boundary ${b.id + 1} (${b.product} ${b.scale}, zone ${b.zone}) is an overview or legend: not opened`);
      continue;
    }
    if (!have.length) {
      if (b.frames.length) notes.push(`boundary ${b.id + 1} (${b.product} 1:${b.scale}, zone ${b.zone}): none of its ${b.frames.length} frame files was given`);
      continue;
    }
    try {
      sources.push(await boundarySource(b, have, found, { parse, notes }));
    } catch (e) {
      notes.push(`boundary ${b.id + 1} (${b.product} 1:${b.scale}, zone ${b.zone}): ${e.message}`);
    }
  }
  return { toc, sources, missing, notes, used: [...found.values()].map((f) => f.name) };
}

async function boundarySource(b, have, found, { parse, notes }) {
  const cache = new Map(); // "row,col" → Promise<{src, ish}>
  const order = []; // LRU of opened frames (each holds its own block cache)
  const fileOf = (fr) => found.get(key(fr.dir, fr.file));
  const cell = new Map(have.map((fr) => [`${fr.row},${fr.col}`, fr]));
  const openFrame = (fr) => {
    const k = `${fr.row},${fr.col}`;
    if (!cache.has(k)) {
      const p = (async () => {
        const f = fileOf(fr);
        const r = await openNitf(f, parse);
        const src = r.sources[0];
        if (!src) throw gwError('{file}: {msg}', { file: fr.file, msg: r.images[0]?.error ?? 'no image segment' });
        return { src, ish: r.images.find((im) => im.index === src.imageIndex)?.ish ?? null, file: f };
      })();
      p.catch(() => {});
      cache.set(k, p);
      order.push(k);
      while (order.length > 48) cache.delete(order.shift());
    }
    return cache.get(k);
  };
  const first = await openFrame(have[0]);
  const fw = first.src.width;
  const fh = first.src.height;
  const W = /^(CADRG|CIB)$/i.test(b.product) ? FRAME : fw;
  const H = /^(CADRG|CIB)$/i.test(b.product) ? FRAME : fh;
  if (fw !== W || fh !== H) notes.push(`boundary ${b.id + 1}: its first frame is ${fw}×${fh}, not ${W}×${H}`);
  const polar = b.zone === '9' || b.zone === 'J';
  let georef;
  if (polar) {
    const corners = await frameCorners(first.file, first.ish);
    if (!corners) throw new Error('the polar frame has no coverage section to place it');
    const a = polarAffine(corners, fw, fh);
    const [g0, g1, g2, g3, g4, g5] = a.gt;
    const cx = have[0].col * W;
    const cy = have[0].row * H;
    georef = { gt: [g0 - g1 * cx - g2 * cy, g1, g2, g3 - g4 * cx - g5 * cy, g4, g5], code: a.code, label: `RPF A.TOC zone ${b.zone} (ARC polar azimuthal equidistant, from frame ${have[0].file})` };
  } else {
    georef = { gt: [b.nw[1], b.horizInterval, 0, b.nw[0], 0, -b.vertInterval], code: 4326, label: `RPF A.TOC zone ${b.zone} (equal-arc, TOC corners)` };
  }
  const { bands, sampleType } = first.src;
  const C = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array }[sampleType] ?? Float32Array;
  const width = b.cols * W;
  const height = b.rows * H;
  return {
    kind: 'rpftoc',
    imageIndex: b.id,
    width,
    height,
    bands,
    sampleType,
    nodata: 0,
    boundary: { ...b, frames: undefined, frameCount: b.frames.length, present: have.length },
    georef,
    frameSize: [W, H],
    // Reduced levels from each frame's own (VQ: cell-centre samples of decoded subframes), so an
    // overview of an 80-frame TOC never assembles the full-resolution mosaic (REQ-FMT-40 first tile).
    hasLevel: (L) => L >= 1 && W % 2 ** L === 0 && H % 2 ** L === 0 && !!first.src.hasLevel?.(L),
    async readLevel(L, x0, y0, w, h, bandList, job) {
      const s = 2 ** L;
      const [lw, lh] = [W / s, H / s];
      const out = bandList.map(() => new C(w * h));
      for (let r = Math.max(0, Math.floor(y0 / lh)); r <= Math.min(b.rows - 1, Math.floor((y0 + h - 1) / lh)); r++)
        for (let c = Math.max(0, Math.floor(x0 / lw)); c <= Math.min(b.cols - 1, Math.floor((x0 + w - 1) / lw)); c++) {
          job?.checkCancel?.();
          const fr = cell.get(`${r},${c}`);
          if (!fr) continue;
          let fsrc;
          try {
            fsrc = (await openFrame(fr)).src;
          } catch {
            continue;
          }
          const fx0 = c * lw;
          const fy0 = r * lh;
          const xs = Math.max(x0, fx0);
          const ys = Math.max(y0, fy0);
          const xe = Math.min(x0 + w, fx0 + lw);
          const ye = Math.min(y0 + h, fy0 + lh);
          if (xe <= xs || ye <= ys) continue;
          const bl = bandList.map((k) => Math.min(k, fsrc.bands - 1));
          const part = fsrc.hasLevel?.(L) ? await fsrc.readLevel(L, xs - fx0, ys - fy0, xe - xs, ye - ys, bl, job) : null;
          if (!part) continue;
          const pw = xe - xs;
          for (let k = 0; k < bandList.length; k++)
            for (let y = ys; y < ye; y++) out[k].set(part[k].subarray((y - ys) * pw, (y - ys + 1) * pw), (y - y0) * w + (xs - x0));
        }
      return out;
    },
    async readWindow(x0, y0, w, h, bandList, job) {
      const out = bandList.map(() => new C(w * h));
      const c0 = Math.max(0, Math.floor(x0 / W));
      const c1 = Math.min(b.cols - 1, Math.floor((x0 + w - 1) / W));
      const r0 = Math.max(0, Math.floor(y0 / H));
      const r1 = Math.min(b.rows - 1, Math.floor((y0 + h - 1) / H));
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          job?.checkCancel?.();
          const fr = cell.get(`${r},${c}`);
          if (!fr) continue;
          let fsrc;
          try {
            fsrc = (await openFrame(fr)).src;
          } catch {
            continue; // an unreadable frame reads as nodata; the import log has the first error
          }
          const fx0 = c * W;
          const fy0 = r * H;
          const xs = Math.max(x0, fx0);
          const ys = Math.max(y0, fy0);
          const xe = Math.min(x0 + w, fx0 + Math.min(W, fsrc.width));
          const ye = Math.min(y0 + h, fy0 + Math.min(H, fsrc.height));
          if (xe <= xs || ye <= ys) continue;
          const part = await fsrc.readWindow(xs - fx0, ys - fy0, xe - xs, ye - ys, bandList.map((k) => Math.min(k, fsrc.bands - 1)), job);
          const pw = xe - xs;
          for (let k = 0; k < bandList.length; k++)
            for (let y = ys; y < ye; y++) out[k].set(part[k].subarray((y - ys) * pw, (y - ys + 1) * pw), (y - y0) * w + (xs - x0));
        }
      return out;
    },
  };
}
