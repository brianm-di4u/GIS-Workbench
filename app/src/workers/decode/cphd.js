// CPHD phase history in the decode worker (FC-21, REQ-FMT-49). The `legacy` bundle parses and checks
// the header and XML (`gw_cphd_open`), decodes PVP records and support arrays; this module reads the
// blocks by range and serves each channel's signal array as a complex source (I, Q as f32; CI2, CI4 or
// CF8 big-endian, scaled by the AmpSF PVP when the file has it), which `sicdSource` turns into the SAR
// bands (amplitude, phase, I, Q, power). Rows are vectors (slow time), columns samples (fast time /
// frequency). Coarse levels of a large array read every 2^L-th vector only, as ENVI does.
// The subset writer (REQ-FMT-51) assembles a new file from Rust's header, XML and PVP and slices of
// the source signal block, so the signal is never copied into memory.

import { ecefToGeodeticJs } from '../../geo/ecef.js';
import { gwError } from '../../i18n/index.js';
import { wasmError } from '../errors.js';

const ROWS_IN_FLIGHT = 64;

function call(B, fn, bufs, extra = []) {
  const ptrs = bufs.map((b) => B.put(b));
  try {
    const args = [];
    let k = 0;
    for (const a of extra) {
      if (a === 'buf' || a === 'f64') {
        const [p, n] = ptrs[k++];
        args.push(p, a === 'f64' ? n / 8 : n); // 'f64': the length in f64 values
      } else args.push(a);
    }
    if (B.x[fn](...args) !== 0) throw wasmError(B);
  } finally {
    for (const [p, n] of ptrs) B.free(p, n);
  }
}

/** Header text → XML block extent, before Rust checks the whole header. */
function xmlExtent(head) {
  const t = new TextDecoder('latin1').decode(head);
  const o = /XML_BLOCK_BYTE_OFFSET\s*:=\s*(\d+)/.exec(t);
  const s = /XML_BLOCK_SIZE\s*:=\s*(\d+)/.exec(t);
  if (!o || !s) throw new Error('CPHD header has no XML block offset or size');
  return [Number(o[1]), Number(s[1])];
}

/** Open a CPHD file: {meta, channels: [{source, info}], ctx} (`ctx` is kept for PVP and subset calls). */
export async function openCphd(file, B) {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 65536)).arrayBuffer());
  const [xo, xs] = xmlExtent(head);
  if (xo + xs > file.size) throw gwError('CPHD XML block runs past the end of the file ({size} bytes): truncated', { size: String(file.size) });
  if (xs > 32 << 20) throw new Error('CPHD XML block is larger than 32 MiB');
  const xml = new Uint8Array(await file.slice(xo, xo + xs).arrayBuffer());
  const ctx = { file, head, xml, B };
  call(B, 'gw_cphd_open', [head, xml], ['buf', 'buf', file.size]);
  const meta = B.outJson();
  ctx.meta = meta;
  const channels = [];
  for (const [ci, ch] of meta.channels.entries()) {
    const cols = await pvpColumns(ctx, ci, 0, ch.nv);
    const amp = cols.AmpSF?.[0] ?? null;
    const info = { index: ci, id: ch.id, nv: ch.nv, ns: ch.ns, pol: `${ch.txPol ?? ''}${ch.rcvPol ? `/${ch.rcvPol}` : ''}`, series: series(cols, ch.nv), track: track(cols, ch.nv), ampSF: !!amp };
    const source = meta.compression ? null : signalSource(file, meta, ch, ci, amp);
    channels.push({ source, info });
  }
  // Support arrays (antenna patterns, dwell times, IAZ): small ones are decoded for the panel.
  meta.supportPreview = [];
  for (const [k, s] of (meta.supportArrays ?? []).entries()) {
    const bytes = s.rows * s.cols * s.bpe;
    if (bytes > 8 << 20 || !s.comps.length) {
      meta.supportPreview.push({ id: s.id, skipped: bytes > 8 << 20 ? 'larger than 8 MiB' : 'no ElementFormat' });
      continue;
    }
    const b = new Uint8Array(await file.slice(s.offset, s.offset + bytes).arrayBuffer());
    call(B, 'gw_cphd_support', [head, xml, b], ['buf', 'buf', file.size, k, 'buf']);
    const v = new Float32Array(B.outBytes().slice().buffer);
    const nc = s.comps.length;
    const stats = s.comps.map((name, c) => {
      let [lo, hi, sum, n] = [Infinity, -Infinity, 0, 0];
      for (let i = c; i < v.length; i += nc)
        if (Number.isFinite(v[i])) {
          lo = Math.min(lo, v[i]);
          hi = Math.max(hi, v[i]);
          sum += v[i];
          n++;
        }
      return { name: name || 'value', min: lo, max: hi, mean: n ? sum / n : NaN };
    });
    meta.supportPreview.push({ id: s.id, stats });
  }
  return { meta, channels, ctx };
}

/** PVP columns of vectors v0…v1 of channel `ci` → {field: [component arrays]}. */
export async function pvpColumns(ctx, ci, v0, v1) {
  const { meta, file, head, xml, B } = ctx;
  const ch = meta.channels[ci];
  const rec = meta.numBytesPVP;
  const b = new Uint8Array(await file.slice(ch.pvpOffset + v0 * rec, ch.pvpOffset + v1 * rec).arrayBuffer());
  call(B, 'gw_cphd_pvp', [head, xml, b], ['buf', 'buf', file.size, 'buf']);
  const all = new Float64Array(B.outBytes().slice().buffer);
  const n = v1 - v0;
  const out = {};
  let c = 0;
  for (const f of meta.pvp) {
    out[f.name] = f.comps.map((_, k) => all.subarray((c + k) * n, (c + k + 1) * n));
    c += f.comps.length;
  }
  return out;
}

/** Scalar PVP series decimated to ≤ 1024 points for the panel's plots. */
function series(cols, nv) {
  const step = Math.max(1, Math.ceil(nv / 1024));
  const idx = [];
  for (let v = 0; v < nv; v += step) idx.push(v);
  if (idx.at(-1) !== nv - 1) idx.push(nv - 1);
  const out = { vector: idx };
  for (const [name, comps] of Object.entries(cols)) {
    if (comps.length === 1) out[name] = idx.map((v) => comps[0][v]);
    else if (comps.length === 3 && /Pos$/.test(name)) out[`${name}|h`] = idx.map((v) => ecefToGeodeticJs(comps[0][v], comps[1][v], comps[2][v])[2]);
  }
  return out;
}

/** The aperture reference point track (mid-point of Tx and Rcv positions) as [lon, lat, h], ≤ 512 points. */
function track(cols, nv) {
  const t = cols.TxPos;
  const r = cols.RcvPos ?? t;
  if (!t) return null;
  const step = Math.max(1, Math.ceil(nv / 512));
  const out = [];
  for (let v = 0; v < nv; v += step) {
    const g = ecefToGeodeticJs((t[0][v] + r[0][v]) / 2, (t[1][v] + r[1][v]) / 2, (t[2][v] + r[2][v]) / 2);
    if (Number.isFinite(g[0])) out.push([g[1], g[0], g[2]]);
  }
  const srp = cols.SRPPos;
  const s = srp ? ecefToGeodeticJs(srp[0][0], srp[1][0], srp[2][0]) : null;
  return { arp: out, srp: s && Number.isFinite(s[0]) ? [s[1], s[0], s[2]] : null };
}

/** One channel's signal array as a two-band (I, Q) f32 source. */
function signalSource(file, meta, ch, ci, amp) {
  const W = ch.ns;
  const H = ch.nv;
  const bps = meta.bytesPerSample;
  const base = ch.signalOffset;
  const fmt = meta.signalFormat;
  const get = (dv, o) => (fmt === 'CI2' ? [dv.getInt8(o), dv.getInt8(o + 1)] : fmt === 'CI4' ? [dv.getInt16(o, false), dv.getInt16(o + 2, false)] : [dv.getFloat32(o, false), dv.getFloat32(o + 4, false)]);
  async function rowSpan(y, xs, xe) {
    return new DataView(await file.slice(base + (y * W + xs) * bps, base + (y * W + xe) * bps).arrayBuffer());
  }
  async function rows(list, put, job) {
    for (let i = 0; i < list.length; i += ROWS_IN_FLIGHT) {
      job?.checkCancel?.();
      const batch = list.slice(i, i + ROWS_IN_FLIGHT);
      const got = await Promise.all(batch.map(([y, xs, xe]) => rowSpan(y, xs, xe)));
      batch.forEach((r, k) => put(r, got[k]));
    }
  }
  const size = W * H * bps;
  return {
    kind: 'cphd',
    imageIndex: ci,
    width: W,
    height: H,
    bands: 2,
    sampleType: 'f32',
    nodata: NaN,
    hasLevel: (L) => (L >= 2 && size > 256 * 2 ** 20) || (L === 1 && size > 2 ** 30),
    async readLevel(L, x0, y0, w, h, bands, job) {
      const sc = 2 ** L;
      const half = sc >> 1;
      const re = new Float32Array(w * h).fill(NaN);
      const im = new Float32Array(w * h).fill(NaN);
      const xa = Math.min(W - 1, x0 * sc + half);
      const xb = Math.min(W - 1, (x0 + w - 1) * sc + half);
      const list = [];
      for (let j = 0; j < h && (y0 + j) * sc < H; j++) list.push([Math.min(H - 1, (y0 + j) * sc + half), xa, xb + 1, j]);
      await rows(list, ([y, , , j], dv) => {
        const k = amp ? amp[y] : 1;
        for (let i = 0; i < w; i++) {
          if ((x0 + i) * sc >= W) continue;
          const [a, b] = get(dv, (Math.min(W - 1, (x0 + i) * sc + half) - xa) * bps);
          re[j * w + i] = a * k;
          im[j * w + i] = b * k;
        }
      }, job);
      return bands.map((b) => (b === 0 ? re : im));
    },
    async readWindow(x0, y0, w, h, bands, job) {
      const re = new Float32Array(w * h);
      const im = new Float32Array(w * h);
      const xs = Math.max(0, x0);
      const xe = Math.min(W, x0 + w);
      const list = [];
      for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) list.push([y, xs, xe]);
      if (xe > xs)
        await rows(list, ([y], dv) => {
          const k = amp ? amp[y] : 1;
          const r = (y - y0) * w;
          for (let x = xs; x < xe; x++) {
            const [a, b] = get(dv, (x - xs) * bps);
            re[r + x - x0] = a * k;
            im[r + x - x0] = b * k;
          }
        }, job);
      return bands.map((b) => (b === 0 ? re : im));
    },
  };
}

/**
 * A CPHD subset (REQ-FMT-51) as a Blob: subs = [{ch, v0, v1, s0, s1}] (channel index, vectors, samples).
 * Header, XML and PVP come from Rust; the support block and the signal rows are slices of the source.
 */
export async function cphdSubset(ctx, subs) {
  const { meta, file, head, xml, B } = ctx;
  if (meta.compression) throw gwError('the CPHD signal is compressed ({compression}): a subset cannot be cut from it', { compression: String(meta.compression) });
  const rec = meta.numBytesPVP;
  const pv = [];
  for (const s of subs) {
    const ch = meta.channels[s.ch];
    if (!ch) throw gwError('no CPHD channel {ch}', { ch: String(s.ch) });
    pv.push(new Uint8Array(await file.slice(ch.pvpOffset + s.v0 * rec, ch.pvpOffset + s.v1 * rec).arrayBuffer()));
  }
  const pvp = new Uint8Array(pv.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of pv) {
    pvp.set(p, o);
    o += p.length;
  }
  const spec = new Float64Array([subs.length, ...subs.flatMap((s) => [s.ch, s.v0, s.v1, s.s0, s.s1])]);
  call(B, 'gw_cphd_subset', [head, xml, new Uint8Array(spec.buffer), pvp], ['buf', 'buf', file.size, 'f64', 'buf']);
  const out = B.outBytes().slice();
  const dv = new DataView(out.buffer);
  const pl = Number(dv.getBigUint64(0, true));
  const prefix = out.subarray(8, 8 + pl);
  const pad = Number(dv.getBigUint64(8 + pl, true));
  const newPvp = out.subarray(16 + pl);
  const parts = [prefix];
  if (meta.support) parts.push(file.slice(meta.support[0], meta.support[0] + meta.support[1]), new Uint8Array(pad));
  parts.push(newPvp);
  const bps = meta.bytesPerSample;
  for (const s of subs) {
    const ch = meta.channels[s.ch];
    if (s.s0 === 0 && s.s1 === ch.ns) parts.push(file.slice(ch.signalOffset + s.v0 * ch.ns * bps, ch.signalOffset + s.v1 * ch.ns * bps));
    else for (let v = s.v0; v < s.v1; v++) parts.push(file.slice(ch.signalOffset + (v * ch.ns + s.s0) * bps, ch.signalOffset + (v * ch.ns + s.s1) * bps));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
}
