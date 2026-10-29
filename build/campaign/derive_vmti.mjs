// Derived VMTI video (MISB ST 0903 inside ST 0601 Item 74) for fmv.vmti: three real KLV videos
// (Esri Truck, Esri Cheyenne inspection, OSH UAS sample stream) keep their video, audio and KLV untouched
// except that every ST 0601 packet gains a VMTI Local Set with three moving targets, and its checksum
// is recomputed. Targets move across the frame in pixel space; their ground positions come from the
// packet's own corners (Items 82–89, or offsets 26–33 + frame centre) by bilinear interpolation, at the
// frame-centre elevation (Item 25). No public video with real VMTI is anonymously available (OD-05).
// The KLV encoders follow build/fixtures/fx10.mjs; written independently of the Rust decoder. Writes a
// truth JSON per video and registers the item in sources/archive-derived.json.
//
//   node build/campaign/derive_vmti.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, HERE } from './corpus-lib.mjs';

const ID = 'derived-vmti-video';
const OUT = join(CORPUS, ID);
mkdirSync(OUT, { recursive: true });
const VIDEOS = [
  { tag: 'truck', item: 'fmv-esri-truck-tutorial', file: 'FMV tutorial data/Truck.ts', w: 1920, h: 1080 },
  { tag: 'cheyenne', item: 'fmv-esri-cheyenne-inspection', file: 'cheyenne-inspection/cheyenne-inspection.mpg', w: 1920, h: 1080 },
  { tag: 'osh_sample', item: 'fmv-osh-uas-sample-stream-st0604', file: 'sample-stream.ts', w: 640, h: 480 },
  // FFmpeg Day Flight / Night Flight IR carry only 6 / 18 KLV packets without corners: too sparse for VMTI.
];

// ---- KLV (as fx10.mjs) ----
const UAS_KEY = [0x06, 0x0e, 0x2b, 0x34, 0x02, 0x0b, 0x01, 0x01, 0x0e, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00];
const berLen = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
const berOid = (t) => {
  const out = [t & 0x7f];
  for (t >>>= 7; t > 0; t >>>= 7) out.unshift(0x80 | (t & 0x7f));
  return out;
};
const beBytes = (v, n) => {
  const out = [];
  let x = BigInt.asUintN(8 * n, BigInt(v));
  for (let i = 0; i < n; i++) {
    out.unshift(Number(x & 255n));
    x >>= 8n;
  }
  return out;
};
function imapb(x, a, b, l) {
  const dPow = 8 * l - 1;
  const bPow = Math.ceil(Math.log2(b - a));
  const sF = 2 ** (dPow - bPow);
  const z = a < 0 && b > 0 ? sF * a - Math.floor(sF * a) : 0;
  return beBytes(Math.trunc(sF * (x - a) + z), l);
}
const utf8 = (s) => [...Buffer.from(s, 'utf8')];
const tlv = (items) => items.flatMap(([t, v]) => [...berOid(t), ...berLen(v.length), ...v]);
function checksum(b) {
  let s = 0;
  for (let i = 0; i < b.length; i++) s = (s + (b[i] << (8 * ((i + 1) % 2)))) & 0xffff;
  return s;
}
const readBer = (b, o) => (b[o] < 128 ? [b[o], 1] : [[...b.subarray(o + 1, o + 1 + (b[o] & 0x7f))].reduce((v, x) => v * 256 + x, 0), 1 + (b[o] & 0x7f)]);
const readOid = (b, o) => {
  let v = 0;
  let n = 0;
  do v = v * 128 + (b[o + n] & 0x7f);
  while (b[o + n++] & 0x80);
  return [v, n];
};
const sDec = (v, bound) => {
  const n = v.length;
  let x = 0n;
  for (const y of v) x = (x << 8n) | BigInt(y);
  const i = Number(BigInt.asIntN(8 * n, x));
  return (i / (2 ** (8 * n - 1) - 1)) * bound;
};
const uDec = (v, a, b) => (v.reduce((s, x) => s * 256 + x, 0) / (2 ** (8 * v.length) - 1)) * (b - a) + a;

/** ST 0601 items → {tag: Uint8Array}; corners [[lat, lon] ×4] (UL, UR, LR, LL) when present. */
function geometry(items) {
  const g = (t) => items.get(t);
  const cLat = g(23) && sDec(g(23), 90);
  const cLon = g(24) && sDec(g(24), 180);
  const elev = g(25) ? uDec(g(25), -900, 19000) : 0;
  let corners = null;
  if ([82, 83, 84, 85, 86, 87, 88, 89].every((t) => g(t))) corners = [[82, 83], [84, 85], [86, 87], [88, 89]].map(([a, b]) => [sDec(g(a), 90), sDec(g(b), 180)]);
  else if (cLat !== undefined && [26, 27, 28, 29, 30, 31, 32, 33].every((t) => g(t))) corners = [[26, 27], [28, 29], [30, 31], [32, 33]].map(([a, b]) => [cLat + sDec(g(a), 0.075), cLon + sDec(g(b), 0.075)]);
  return { corners, elev, cLat, cLon };
}
const bilinear = (c, u, v) => [0, 1].map((k) => (1 - u) * (1 - v) * c[0][k] + u * (1 - v) * c[1][k] + u * v * c[2][k] + (1 - u) * v * c[3][k]);

function targetsAt(k, n, W, H, geo) {
  return [0, 1, 2].map((i) => {
    const f = ((k / Math.max(1, n - 1)) + i / 3) % 1;
    const col = Math.round(W * (0.2 + 0.6 * f));
    const row = Math.round(H * (0.3 + 0.2 * i));
    const bw = Math.round(W * 0.03);
    const bh = Math.round(H * 0.04);
    const box = [Math.max(0, col - bw), Math.max(0, row - bh), Math.min(W - 1, col + bw), Math.min(H - 1, row + bh)];
    const ground = geo.corners ? bilinear(geo.corners, col / (W - 1), row / (H - 1)) : null;
    return { id: i + 1, col, row, box, confidence: 60 + 15 * i, lat: ground?.[0] ?? null, lon: ground?.[1] ?? null, h: geo.elev };
  });
}
function vmtiSet(k, W, H, targets) {
  const pix = (c, r) => beBytes(r * W + c + 1, 4);
  const series = targets.flatMap((v) => {
    const items = [[1, pix(v.col, v.row)], [2, pix(v.box[0], v.box[1])], [3, pix(v.box[2], v.box[3])], [5, [v.confidence]]];
    if (v.lat !== null) items.push([17, [...imapb(v.lat, -90, 90, 4), ...imapb(v.lon, -180, 180, 4), ...imapb(v.h, -900, 19000, 2)]]);
    const pack = [...berOid(v.id), ...tlv(items)];
    return [...berLen(pack.length), ...pack];
  });
  return tlv([[3, utf8('GW-TE-VMTI')], [4, [0, 5]], [5, [targets.length]], [6, [targets.length]], [7, beBytes(k, 3)], [8, beBytes(W, 2)], [9, beBytes(H, 2)], [101, series]]);
}

/** Add Item 74 to every UAS packet in a KLV byte run; other keys pass through. */
function addVmti(buf, ctx) {
  const out = [];
  for (let o = 0; o + 17 <= buf.length; ) {
    const [len, ll] = readBer(buf, o + 16);
    const end = o + 16 + ll + len;
    if (end > buf.length) {
      out.push(...buf.subarray(o));
      break;
    }
    const isUas = UAS_KEY.every((x, i) => i === 7 || buf[o + i] === x); // byte 7 is the registry version
    if (!isUas) {
      out.push(...buf.subarray(o, end));
      o = end;
      continue;
    }
    const items = new Map();
    const raw = [];
    for (let q = o + 16 + ll; q < end; ) {
      const [t, tn] = readOid(buf, q);
      const [n, nn] = readBer(buf, q + tn);
      const v = buf.subarray(q + tn + nn, q + tn + nn + n);
      if (t !== 1 && t !== 74) raw.push([t, [...v]]);
      items.set(t, v);
      q += tn + nn + n;
    }
    const geo = geometry(items);
    const targets = targetsAt(ctx.k, ctx.n, ctx.W, ctx.H, geo);
    ctx.truth.push({ packet: ctx.k, pts: ctx.pts, corners: geo.corners, targets });
    const body = [...tlv([...raw, [74, vmtiSet(ctx.k, ctx.W, ctx.H, targets)]]), 0x01, 0x02];
    const pkt = [...buf.subarray(o, o + 16), ...berLen(body.length + 2), ...body];
    const cs = checksum(pkt);
    pkt.push(cs >> 8, cs & 255);
    out.push(...pkt);
    ctx.k++;
    o = end;
  }
  return new Uint8Array(out);
}

// ---- TS (as fx10.mjs, generalised to multi-packet PES) ----
const P = 188;
const pidOf = (p) => ((p[1] & 0x1f) << 8) | p[2];
const payloadOf = (p) => {
  const afc = (p[3] >> 4) & 3;
  if (!(afc & 1)) return p.subarray(P);
  return p.subarray(afc & 2 ? 5 + p[4] : 4);
};
function tsPackets(pid, data, ccRef) {
  const out = [];
  for (let o = 0, first = true; o < data.length || first; first = false) {
    const room = P - 4;
    const n = Math.min(room, data.length - o);
    const p = new Uint8Array(P).fill(0xff);
    p[0] = 0x47;
    p[1] = (first ? 0x40 : 0) | (pid >> 8);
    p[2] = pid & 255;
    if (n === room) {
      p[3] = 0x10 | ccRef.cc;
      p.set(data.subarray(o, o + n), 4);
    } else {
      const al = room - n - 1;
      p[3] = 0x30 | ccRef.cc;
      p[4] = al;
      if (al > 0) p[5] = 0;
      p.set(data.subarray(o, o + n), 5 + al);
    }
    ccRef.cc = (ccRef.cc + 1) & 15;
    out.push(p);
    o += n;
  }
  return out;
}
function streams(pk) {
  const pat = payloadOf(pk.find((p) => pidOf(p) === 0 && p[1] & 0x40));
  const s0 = pat.subarray(1 + pat[0]);
  const pmtPid = ((s0[10] & 0x1f) << 8) | s0[11];
  const pl = payloadOf(pk.find((p) => pidOf(p) === pmtPid && p[1] & 0x40));
  const sec = pl.subarray(1 + pl[0]);
  const slen = ((sec[1] & 0x0f) << 8) | sec[2];
  const pil = ((sec[10] & 0x0f) << 8) | sec[11];
  const es = [];
  for (let q = 12 + pil; q < 3 + slen - 4; ) {
    const il = ((sec[q + 3] & 0x0f) << 8) | sec[q + 4];
    const desc = sec.subarray(q + 5, q + 5 + il);
    es.push({ type: sec[q], pid: ((sec[q + 1] & 0x1f) << 8) | sec[q + 2], klva: Buffer.from(desc).includes('KLVA') });
    q += 5 + il;
  }
  return es;
}

function rewrite(v) {
  const src = readFileSync(join(CORPUS, v.item, ...v.file.split('/')));
  const pk = [];
  for (let i = 0; i + P <= src.length; i += P) pk.push(src.subarray(i, i + P));
  const es = streams(pk);
  const klv = es.find((e) => e.type === 0x15 || (e.type === 0x06 && e.klva));
  if (!klv) throw new Error(`${v.file}: no KLV stream`);
  const n = pk.filter((p) => pidOf(p) === klv.pid && p[1] & 0x40).length;
  const ctx = { k: 0, n, W: v.w, H: v.h, truth: [], pts: null };
  const out = [];
  const cc = { cc: 0 };
  let pes = null;
  const flush = () => {
    if (!pes) return;
    const b = Buffer.concat(pes.parts);
    const sid = b[3];
    const hdr = 9 + b[8];
    const ptsFlag = b[7] & 0x80;
    ctx.pts = ptsFlag ? ((b[9] & 0x0e) * 2 ** 29 + b[10] * 2 ** 22 + (b[11] & 0xfe) * 2 ** 14 + b[12] * 2 ** 7 + (b[13] >> 1)) : null;
    let payload;
    if (klv.type === 0x15) {
      const cells = [];
      for (let o = hdr; o + 5 <= b.length; ) {
        const len = (b[o + 3] << 8) | b[o + 4];
        const body = addVmti(b.subarray(o + 5, o + 5 + len), ctx);
        cells.push(b[o], b[o + 1], b[o + 2], body.length >> 8, body.length & 255, ...body);
        o += 5 + len;
      }
      payload = cells;
    } else payload = [...addVmti(b.subarray(hdr), ctx)];
    const head = [...b.subarray(6, hdr)];
    const len = head.length + payload.length;
    const data = new Uint8Array([0, 0, 1, sid, len > 0xffff ? 0 : len >> 8, len > 0xffff ? 0 : len & 255, ...head, ...payload]);
    out[pes.slot] = tsPackets(klv.pid, data, cc);
    pes = null;
  };
  for (const p of pk) {
    if (pidOf(p) !== klv.pid) {
      out.push([p]);
      continue;
    }
    if (p[1] & 0x40) {
      flush();
      pes = { slot: out.length, parts: [] };
      out.push(null);
    }
    if (pes) pes.parts.push(payloadOf(p));
  }
  flush();
  const flat = out.flat();
  const bytes = new Uint8Array(flat.length * P);
  flat.forEach((p, i) => bytes.set(p, i * P));
  return { bytes, truth: ctx.truth, pid: klv.pid, type: klv.type };
}

const files = [];
const recipe = [];
for (const v of VIDEOS) {
  const r = rewrite(v);
  const name = `${v.tag}_vmti.ts`;
  writeFileSync(join(OUT, name), r.bytes);
  writeFileSync(join(OUT, `${v.tag}_vmti_truth.json`), JSON.stringify({ source: `${v.item}/${v.file}`, video: { width: v.w, height: v.h }, klvPid: r.pid, streamType: r.type, pixelNumbering: 'ST 0903: n = row × width + col + 1', packets: r.truth }));
  files.push({ name, url: null, role: 'primary' }, { name: `${v.tag}_vmti_truth.json`, url: null, role: 'metadata' });
  recipe.push(`${v.item}/${v.file}: ${r.truth.length} ST 0601 packets on PID 0x${r.pid.toString(16)} + Item 74 (3 targets), checksum recomputed`);
  console.log(`${name}: ${r.truth.length} packets, ${r.truth.filter((t) => t.corners).length} with corners`);
}

const entry = {
  id: ID,
  area: 'fmv',
  title: 'Real KLV motion imagery with injected MISB ST 0903 VMTI (Esri Truck, Esri Cheyenne inspection, OSH UAS sample stream): three moving targets per packet, truth JSON',
  source: 'Derived from fmv-esri-truck-tutorial, fmv-esri-cheyenne-inspection, fmv-osh-uas-sample-stream-st0604',
  landing: 'build/campaign/derive_vmti.mjs',
  licence: 'Esri sample data terms; OSH sample stream (see its item) — test-only (OD-09): never bundled, published or used in marketing',
  attribution: 'Esri; Open Sensor Hub',
  tier: 'A',
  origin: 'derived',
  format: 'MPEG-TS H.264 + ST 0601 KLV with ST 0903 VMTI (Item 74)',
  profile: 'Video/audio packets byte-identical; KLV PES rebuilt; VMTI 0903.5 with centroid, bbox, confidence and location (from the packet corners at the frame-centre elevation)',
  files,
  sign: null,
  derivation: recipe.join('; '),
  notes: 'Generated by build/campaign/derive_vmti.mjs. Targets are synthetic tracks in pixel space; their ground positions agree with each packet\'s corners, so overlay tests compare the two.',
  feeds: ['fmv.vmti', 'fmv.open', 'det.review'],
  covers: ['fmt:fmv.ts', 'fmt:fmv.klv', 'fmt:fmv.vmti'],
  pairs: [{ role: 'vmti-video', with: [] }],
};
const srcFile = join(HERE, 'sources', 'archive-derived.json');
const all = existsSync(srcFile) ? JSON.parse(readFileSync(srcFile, 'utf8')) : [];
const i = all.findIndex((e) => e.id === ID);
if (i >= 0) all[i] = entry;
else all.push(entry);
writeFileSync(srcFile, JSON.stringify(all, null, 1));
console.log(`${ID}: ${files.map((f) => f.name).join(', ')}`);
