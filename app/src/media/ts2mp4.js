// MPEG-TS → fragmented MP4 for Media Source Extensions (REQ-GAP-49): the video PES of an HLS
// segment are demultiplexed (PAT, PMT, PES with 33-bit PTS/DTS), H.264 access units are turned
// from Annex B into length-prefixed samples with their SPS and PPS moved into an avcC box, and
// each segment becomes one moof + mdat on a timeline the caller chooses. KLV is not handled here:
// the file player's Rust demuxer (decode worker `tsindex`) reads it from the same bytes, so a
// stream's KLV is decoded exactly as a file's. DOM-free; runs in the decode worker and in Node.

const PACKET = 188;
const WRAP = 2 ** 33;

/** Stream types (ISO/IEC 13818-1 Table 2-34) the player knows by name. */
export const VIDEO_TYPES = { 0x01: 'mp1v', 0x02: 'mp2v', 0x10: 'mp4v', 0x1b: 'avc1', 0x24: 'hvc1', 0x42: 'avs' };

const pts33 = (b, i) => (b[i] & 0x0e) * 2 ** 29 + b[i + 1] * 2 ** 22 + (b[i + 2] & 0xfe) * 2 ** 14 + b[i + 3] * 2 ** 7 + (b[i + 4] >> 1);

/** Unwrap a 33-bit time stamp to the one nearest `ref`. */
export function unwrap33(v, ref) {
  if (ref === null || ref === undefined || !Number.isFinite(ref)) return v;
  let x = v + Math.round((ref - v) / WRAP) * WRAP;
  if (x - ref > WRAP / 2) x -= WRAP;
  if (ref - x > WRAP / 2) x += WRAP;
  return x;
}

function sectionBody(b, p, end) {
  // p: first byte of the section (after the pointer field)
  if (p + 3 > end) return null;
  const len = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
  const e = Math.min(end, p + 3 + len - 4); // CRC excluded
  return { table: b[p], s: p, e };
}

/**
 * Demultiplex the video of one transport stream segment → {video: {pid, type, codec}, pes:
 * [{pts, dts, data}], streams, errors}. Packets that are not 188-byte aligned are found again by
 * their sync byte; transport-error packets are dropped.
 */
export function demuxVideo(b) {
  const out = { video: null, streams: [], pes: [], errors: { resync: 0, transport: 0, cc: 0 } };
  let pmtPid = -1;
  let vpid = -1;
  let cur = null;
  let cc = -1;
  const flush = () => {
    if (!cur) return;
    const n = cur.chunks.reduce((a, c) => a + c.length, 0);
    const d = new Uint8Array(n);
    let k = 0;
    for (const c of cur.chunks) {
      d.set(c, k);
      k += c.length;
    }
    cur = null;
    if (n < 9 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return;
    const flags = d[7] >> 6;
    const hl = d[8];
    const pts = flags & 2 && n >= 14 ? pts33(d, 9) : null;
    const dts = flags === 3 && n >= 19 ? pts33(d, 14) : pts;
    if (9 + hl > n) return;
    out.pes.push({ pts, dts, data: d.subarray(9 + hl) });
  };
  let o = 0;
  while (o < b.length && b[o] !== 0x47) o++;
  for (; o + PACKET <= b.length; o += PACKET) {
    if (b[o] !== 0x47) {
      out.errors.resync++;
      let q = o + 1;
      while (q + PACKET <= b.length && !(b[q] === 0x47 && (q + PACKET >= b.length || b[q + PACKET] === 0x47))) q++;
      o = q - PACKET;
      continue;
    }
    if (b[o + 1] & 0x80) {
      out.errors.transport++;
      continue;
    }
    const pusi = b[o + 1] & 0x40;
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    const afc = (b[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc & 2) p += 1 + b[p];
    if (!(afc & 1) || p >= o + PACKET) continue;
    const end = o + PACKET;
    if (pid === 0 && pusi) {
      const s = sectionBody(b, p + 1 + b[p], end);
      if (s?.table === 0x00) {
        for (let q = s.s + 8; q + 4 <= s.e; q += 4) {
          const prog = (b[q] << 8) | b[q + 1];
          if (prog !== 0) {
            pmtPid = ((b[q + 2] & 0x1f) << 8) | b[q + 3];
            break;
          }
        }
      }
    } else if (pid === pmtPid && pusi) {
      const s = sectionBody(b, p + 1 + b[p], end);
      if (s?.table === 0x02 && s.s + 12 <= s.e) {
        const pil = ((b[s.s + 10] & 0x0f) << 8) | b[s.s + 11];
        const streams = [];
        for (let q = s.s + 12 + pil; q + 5 <= s.e; ) {
          const type = b[q];
          const epid = ((b[q + 1] & 0x1f) << 8) | b[q + 2];
          const il = ((b[q + 3] & 0x0f) << 8) | b[q + 4];
          streams.push({ pid: epid, type });
          q += 5 + il;
        }
        out.streams = streams;
        if (vpid < 0) {
          const v = streams.find((x) => VIDEO_TYPES[x.type]);
          if (v) {
            vpid = v.pid;
            out.video = { pid: v.pid, type: v.type, codec: VIDEO_TYPES[v.type] };
          }
        }
      }
    } else if (pid === vpid) {
      const c = b[o + 3] & 0x0f;
      if (cc >= 0 && c !== ((cc + 1) & 15) && c !== cc) out.errors.cc++;
      cc = c;
      if (pusi) {
        flush();
        cur = { chunks: [] };
      }
      if (cur) cur.chunks.push(b.subarray(p, end));
    }
  }
  flush();
  return out;
}

/** NAL units of an Annex B buffer (start codes removed, trailing zero bytes dropped). */
export function nalUnits(d) {
  const out = [];
  const n = d.length;
  let i = 0;
  let start = -1;
  while (i + 2 < n) {
    if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) {
      if (start >= 0) out.push(trimZeros(d, start, i));
      i += 3;
      start = i;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < n) out.push(trimZeros(d, start, n));
  return out.filter((x) => x.length);
}

function trimZeros(d, s, e) {
  while (e > s && d[e - 1] === 0) e--;
  return d.subarray(s, e);
}

/** Remove emulation-prevention bytes (00 00 03). */
export function rbsp(n) {
  const o = new Uint8Array(n.length);
  let k = 0;
  let z = 0;
  for (let i = 0; i < n.length; i++) {
    const x = n[i];
    if (z >= 2 && x === 3) {
      z = 0;
      continue;
    }
    o[k++] = x;
    z = x === 0 ? z + 1 : 0;
  }
  return o.subarray(0, k);
}

class Bits {
  constructor(b) {
    this.b = b;
    this.p = 0;
  }
  bit() {
    if (this.p >= this.b.length * 8) throw new RangeError('SPS ends early');
    const v = (this.b[this.p >> 3] >> (7 - (this.p & 7))) & 1;
    this.p++;
    return v;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue() {
    let z = 0;
    while (!this.bit()) if (++z > 31) throw new RangeError('bad Exp-Golomb code');
    return 2 ** z - 1 + this.bits(z);
  }
  se() {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -k / 2;
  }
}

/** H.264 SPS (ITU-T H.264 §7.3.2.1.1) → {profile, compat, level, chroma, bitDepth, width, height}. */
export function parseSps(nal) {
  const r = new Bits(rbsp(nal.subarray(1)));
  const profile = r.bits(8);
  const compat = r.bits(8);
  const level = r.bits(8);
  r.ue(); // seq_parameter_set_id
  let chroma = 1;
  let bitDepthLuma = 8;
  let bitDepthChroma = 8;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    chroma = r.ue();
    if (chroma === 3) r.bit();
    bitDepthLuma = r.ue() + 8;
    bitDepthChroma = r.ue() + 8;
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
        if (!r.bit()) continue;
        const size = i < 6 ? 16 : 64;
        let last = 8;
        let next = 8;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const n = r.ue();
    if (n > 255) throw new RangeError('bad SPS');
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit();
  const wMbs = r.ue() + 1;
  const hMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit(); // direct_8x8_inference_flag
  let crop = [0, 0, 0, 0];
  if (r.bit()) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  const subW = chroma === 1 || chroma === 2 ? 2 : 1;
  const subH = chroma === 1 ? 2 : 1;
  const cx = chroma === 0 ? 1 : subW;
  const cy = (chroma === 0 ? 1 : subH) * (2 - frameMbsOnly);
  const width = wMbs * 16 - cx * (crop[0] + crop[1]);
  const height = (2 - frameMbsOnly) * hMapUnits * 16 - cy * (crop[2] + crop[3]);
  return { profile, compat, level, chroma, bitDepthLuma, bitDepthChroma, width, height };
}

const hex2 = (v) => v.toString(16).padStart(2, '0').toUpperCase();
/** The RFC 6381 codec string of an SPS: avc1.PPCCLL. */
export const avcCodec = (s) => `avc1.${hex2(s.profile)}${hex2(s.compat)}${hex2(s.level)}`;

const keyOf = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
};

/**
 * H.264 PES → samples: {samples: [{pts, dts, key, size}], data (length-prefixed NAL units, one
 * sample after another), sps, pps (arrays of NAL units), info (parsed SPS), sei}. PES without a
 * time stamp continue the previous access unit. Time stamps are unwrapped within the segment.
 */
export function h264Samples(pes) {
  const samples = [];
  const parts = [];
  const sps = new Map();
  const pps = new Map();
  let total = 0;
  let ref = null;
  let cur = null;
  const push = () => {
    if (!cur || !cur.nals.length) return;
    let size = 0;
    for (const n of cur.nals) size += 4 + n.length;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    let k = 0;
    for (const n of cur.nals) {
      dv.setUint32(k, n.length);
      buf.set(n, k + 4);
      k += 4 + n.length;
    }
    parts.push(buf);
    samples.push({ pts: cur.pts, dts: cur.dts, key: cur.key, size });
    total += size;
  };
  for (const p of pes) {
    if (p.pts !== null) {
      push();
      const pts = unwrap33(p.pts, ref);
      ref = pts;
      const dts = p.dts === null ? pts : unwrap33(p.dts, pts);
      cur = { pts, dts, key: false, nals: [] };
    } else if (!cur) continue; // data before the first time stamp cannot be placed
    for (const n of nalUnits(p.data)) {
      const type = n[0] & 0x1f;
      if (type === 7) sps.set(keyOf(n), n.slice());
      else if (type === 8) pps.set(keyOf(n), n.slice());
      else if (type === 9 || type === 12) continue; // access unit delimiter, filler
      else {
        if (type === 5) cur.key = true;
        cur.nals.push(n);
      }
    }
  }
  push();
  const data = new Uint8Array(total);
  let k = 0;
  for (const b of parts) {
    data.set(b, k);
    k += b.length;
  }
  const spsList = [...sps.values()];
  let info = null;
  for (const s of spsList) {
    try {
      info = parseSps(s);
      break;
    } catch {
      /* the next one */
    }
  }
  return { samples, data, sps: spsList, pps: [...pps.values()], info };
}

// ---------------------------------------------------------------- ISO BMFF boxes

const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const u16 = (v) => [(v >> 8) & 255, v & 255];
const u64 = (v) => {
  const hi = Math.floor(v / 2 ** 32);
  return [...u32(hi >>> 0), ...u32(v >>> 0)];
};
const fourcc = (s) => [...s].map((c) => c.charCodeAt(0));

function box(type, ...payload) {
  let n = 8;
  for (const p of payload) n += p.length;
  const o = new Uint8Array(n);
  o.set(u32(n), 0);
  o.set(fourcc(type), 4);
  let k = 8;
  for (const p of payload) {
    o.set(p, k);
    k += p.length;
  }
  return o;
}
const full = (type, version, flags, ...payload) => box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...payload);
const bytes = (a) => new Uint8Array(a);
const MATRIX = bytes([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0]);

/** avcC (ISO/IEC 14496-15 §5.3.3.1). */
export function avcC(sps, pps, info) {
  const s0 = sps[0];
  const a = [1, s0[1], s0[2], s0[3], 0xff, 0xe0 | sps.length];
  for (const s of sps) a.push(...u16(s.length), ...s);
  a.push(pps.length);
  for (const p of pps) a.push(...u16(p.length), ...p);
  if (info && ![66, 77, 88].includes(info.profile)) a.push(0xfc | (info.chroma & 3), 0xf8 | ((info.bitDepthLuma - 8) & 7), 0xf8 | ((info.bitDepthChroma - 8) & 7), 0);
  return box('avcC', bytes(a));
}

/** The init segment (ftyp + moov) for one H.264 track at a 90 kHz time scale. */
export function initSegment({ sps, pps, info, timescale = 90000, trackId = 1 }) {
  if (!sps?.length || !pps?.length) throw new Error('no SPS or PPS in the segment');
  const w = info?.width ?? 0;
  const h = info?.height ?? 0;
  const ftyp = box('ftyp', bytes([...fourcc('isom'), 0, 0, 2, 0, ...fourcc('isom'), ...fourcc('iso6'), ...fourcc('avc1'), ...fourcc('mp41')]));
  const mvhd = full('mvhd', 0, 0, bytes([...u32(0), ...u32(0), ...u32(1000), ...u32(0), 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), MATRIX, new Uint8Array(24), bytes(u32(trackId + 1)));
  const tkhd = full('tkhd', 0, 3, bytes([...u32(0), ...u32(0), ...u32(trackId), ...u32(0), ...u32(0), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), MATRIX, bytes([...u16(w), 0, 0, ...u16(h), 0, 0]));
  const mdhd = full('mdhd', 0, 0, bytes([...u32(0), ...u32(0), ...u32(timescale), ...u32(0), 0x55, 0xc4, 0, 0]));
  const hdlr = full('hdlr', 0, 0, bytes([0, 0, 0, 0, ...fourcc('vide'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...fourcc('VideoHandler'), 0]));
  const vmhd = full('vmhd', 0, 1, new Uint8Array(8));
  const dinf = box('dinf', full('dref', 0, 0, bytes(u32(1)), full('url ', 0, 1)));
  const avc1 = box('avc1', new Uint8Array(6), bytes([0, 1]), new Uint8Array(16), bytes([...u16(w), ...u16(h), 0, 0x48, 0, 0, 0, 0x48, 0, 0, 0, 0, 0, 0, 0, 1]), new Uint8Array(32), bytes([0, 0x18, 0xff, 0xff]), avcC(sps, pps, info));
  const stsd = full('stsd', 0, 0, bytes(u32(1)), avc1);
  const empty = (t) => full(t, 0, 0, bytes(u32(0)));
  const stbl = box('stbl', stsd, empty('stts'), empty('stsc'), full('stsz', 0, 0, bytes([...u32(0), ...u32(0)])), empty('stco'));
  const minf = box('minf', vmhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const trak = box('trak', tkhd, mdia);
  const mvex = box('mvex', full('trex', 0, 0, bytes([...u32(trackId), ...u32(1), ...u32(0), ...u32(0), ...u32(0)])));
  const moov = box('moov', mvhd, trak, mvex);
  return concatBytes([ftyp, moov]);
}

export function concatBytes(list) {
  const n = list.reduce((a, b) => a + b.length, 0);
  const o = new Uint8Array(n);
  let k = 0;
  for (const b of list) {
    o.set(b, k);
    k += b.length;
  }
  return o;
}

/**
 * One fragment (moof + mdat). `samples` carry `dts`/`pts` on the output timeline (≥ 0, in
 * `timescale` units) and `duration`; `data` is their bytes in order.
 */
export function fragment({ seq, samples, data, trackId = 1 }) {
  const n = samples.length;
  if (!n) throw new Error('a fragment needs at least one sample');
  const base = samples[0].dts;
  if (!(base >= 0)) throw new Error('fragment decode time before zero');
  const tr = new Uint8Array(12 + 4 + 4 + 16 * n);
  const dv = new DataView(tr.buffer);
  tr.set([0, 0, 0, 0, ...fourcc('trun'), 1, 0, 0x0f, 0x01]);
  dv.setUint32(12, n);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const o = 20 + 16 * i;
    dv.setUint32(o, Math.max(0, Math.round(s.duration)));
    dv.setUint32(o + 4, s.size);
    dv.setUint32(o + 8, s.key ? 0x02000000 : 0x01010000);
    dv.setInt32(o + 12, Math.round(s.pts - s.dts));
  }
  dv.setUint32(0, tr.length);
  const tfhd = full('tfhd', 0, 0x020000, bytes(u32(trackId)));
  const tfdt = full('tfdt', 1, 0, bytes(u64(Math.round(base))));
  const mfhd = full('mfhd', 0, 0, bytes(u32(seq >>> 0)));
  const moofLen = 8 + mfhd.length + 8 + tfhd.length + tfdt.length + tr.length;
  dv.setUint32(16, moofLen + 8); // data offset: from the moof's first byte to the mdat payload
  const traf = box('traf', tfhd, tfdt, tr);
  const moof = box('moof', mfhd, traf);
  const mdat = concatBytes([bytes([...u32(8 + data.length), ...fourcc('mdat')]), data]);
  return concatBytes([moof, mdat]);
}

/**
 * Per-sample durations from the decode times: the gap to the next sample; the last one gets
 * `nextDts - dts` when the next segment's first decode time is known, else the median.
 */
export function withDurations(samples, nextDts = null) {
  const d = [];
  for (let i = 0; i + 1 < samples.length; i++) d.push(samples[i + 1].dts - samples[i].dts);
  const pos = d.filter((x) => x > 0).sort((a, b) => a - b);
  const med = pos.length ? pos[pos.length >> 1] : 3000;
  return samples.map((s, i) => ({ ...s, duration: i + 1 < samples.length ? (d[i] > 0 ? d[i] : med) : nextDts !== null && nextDts > s.dts ? nextDts - s.dts : med }));
}

/** The whole worker step: a TS segment → its video samples ready for fragment(). */
export function transmuxSegment(b) {
  const dm = demuxVideo(b);
  if (!dm.video) return { codec: null, streams: dm.streams, errors: dm.errors, samples: [], data: new Uint8Array(0), sps: [], pps: [], info: null };
  if (dm.video.codec !== 'avc1') return { codec: dm.video.codec, streams: dm.streams, errors: dm.errors, samples: [], data: new Uint8Array(0), sps: [], pps: [], info: null };
  const s = h264Samples(dm.pes);
  return { codec: 'avc1', mime: s.info ? avcCodec(s.info) : null, streams: dm.streams, errors: dm.errors, ...s };
}
