// FX-10 fixtures for SCN-15 (Appendix E AT-15.1..15.4). The seed clip (Research/samples/
// mpegts-klv-synthetic: 10 s H.264 640×360 @ 30 fps, synchronous ST 0601 KLV with full corners)
// is copied as fx10.ts. Two variants re-write only the KLV PES of the seed; the video is untouched:
//
//   fx10_b.ts  asynchronous KLV (stream type 0x06 + "KLVA" registration, PES stream_id 0xBD, no
//              PTS): offset corners (Items 26–33) instead of full corners, a nested ST 0102
//              Security Local Set (Item 48), a nested ST 0903 VMTI Local Set (Item 74) with two
//              moving targets, Item 136 (leap seconds), an unknown Item 150 and two packets with a
//              broken checksum (frames 100 and 101).
//   fx10_c.ts  synchronous KLV with no corner items: the footprint must be computed from the
//              platform/sensor angles and FOV (REQ-FMV-07, REQ-SNS-20).
//
// The KLV encoder and the frame model here are written independently of the Rust decoder.
// Truth (fx10_truth.json) adds, per frame, the pinhole footprint at the frame-centre HAE on the
// WGS 84 ellipsoid (for fx10_c) and the VMTI targets' ground positions and pixel boxes.
//
//   node build/fixtures/fx10.mjs [outdir]

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED = join(ROOT, '..', 'Research', 'samples', 'mpegts-klv-synthetic');
const OUT = process.argv[2] ? join(process.argv[2], 'fx10') : join(ROOT, 'fixtures', 'fx10');
mkdirSync(OUT, { recursive: true });

const seed = readFileSync(join(SEED, 'fx10_synthetic_klv.ts'));
const truth = JSON.parse(readFileSync(join(SEED, 'fx10_truth.json'), 'utf8'));
copyFileSync(join(SEED, 'fx10_synthetic_klv.ts'), join(OUT, 'fx10.ts'));
const [W, H] = truth.video.size;

// ---- WGS 84 and the pinhole frame model ----
const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const rad = Math.PI / 180;
function ecef(lat, lon, h) {
  const sl = Math.sin(lat * rad);
  const n = A / Math.sqrt(1 - E2 * sl * sl);
  return [(n + h) * Math.cos(lat * rad) * Math.cos(lon * rad), (n + h) * Math.cos(lat * rad) * Math.sin(lon * rad), (n * (1 - E2) + h) * sl];
}
function geodetic([x, y, z]) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 10; i++) {
    const sl = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * sl * sl);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return { lat: lat / rad, lon: lon / rad, h };
}
const enuAxes = (lat, lon) => {
  const [sl, cl, so, co] = [Math.sin(lat * rad), Math.cos(lat * rad), Math.sin(lon * rad), Math.cos(lon * rad)];
  return { e: [-so, co, 0], n: [-sl * co, -sl * so, cl], u: [cl * co, cl * so, sl] };
};
const add = (a, b, k = 1) => a.map((v, i) => v + k * b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// Rotation of a vector by angle a (deg) about axis 'x' | 'y' | 'z' in a right-handed NED-like frame.
function rot(axis, a, v) {
  const [s, c] = [Math.sin(a * rad), Math.cos(a * rad)];
  const [x, y, z] = v;
  if (axis === 'z') return [c * x - s * y, s * x + c * y, z];
  if (axis === 'y') return [c * x + s * z, y, -s * x + c * z];
  return [x, c * y - s * z, s * y + c * z];
}
/** Sensor axes (line of sight, right, down) in ECEF from KLV angles at the sensor position. */
function sensorAxes(pos, hpr, aer) {
  const toNed = (v) => {
    let w = rot('x', aer[2], v);
    w = rot('y', aer[1], w);
    w = rot('z', aer[0], w);
    w = rot('x', hpr[2], w);
    w = rot('y', hpr[1], w);
    return rot('z', hpr[0], w);
  };
  const { e, n, u } = enuAxes(pos.lat, pos.lon);
  const toEcef = ([vn, ve, vd]) => add(add(n.map((x) => x * vn), e, ve), u, -vd);
  return { los: toEcef(toNed([1, 0, 0])), right: toEcef(toNed([0, 1, 0])), down: toEcef(toNed([0, 0, 1])) };
}
function frameModel(pos, hpr, aer, hfov) {
  const f = W / 2 / Math.tan((hfov * rad) / 2);
  const c = ecef(pos.lat, pos.lon, pos.h);
  const ax = sensorAxes(pos, hpr, aer);
  return {
    ray(x, y) {
      return add(add(ax.los.map((v) => v * f), ax.right, x - W / 2), ax.down, y - H / 2);
    },
    toGround(x, y, h) {
      const d = this.ray(x, y);
      const nd = Math.hypot(...d);
      const dn = d.map((v) => v / nd);
      let t = (pos.h - h) / 0.7;
      for (let i = 0; i < 50; i++) {
        const g = geodetic(add(c, dn, t));
        const up = enuAxes(g.lat, g.lon).u;
        const step = (g.h - h) / dot(dn, up);
        t -= step;
        if (Math.abs(step) < 1e-7) break;
      }
      return geodetic(add(c, dn, t));
    },
    toImage(g) {
      const v = add(ecef(g.lat, g.lon, g.h), c, -1);
      const z = dot(v, ax.los);
      return { x: W / 2 + (f * dot(v, ax.right)) / z, y: H / 2 + (f * dot(v, ax.down)) / z };
    },
  };
}

// ---- KLV encoder ----
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
const uMap = (x, a, b, n) => beBytes(Math.round(((x - a) / (b - a)) * (2 ** (8 * n) - 1)), n);
const sMap = (x, b, n) => beBytes(Math.round((x / b) * (2 ** (8 * n - 1) - 1)), n);
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
function uasPacket(items, { breakChecksum = false } = {}) {
  const body = [...tlv(items), 0x01, 0x02];
  const pkt = [...UAS_KEY, ...berLen(body.length + 2), ...body];
  const cs = checksum(pkt);
  pkt.push(cs >> 8, cs & 255);
  if (breakChecksum) pkt[UAS_KEY.length + 12] ^= 0x04;
  return pkt;
}

const SECURITY = tlv([
  [1, [1]],
  [2, [7]],
  [3, utf8('//XN')],
  [6, utf8('XN')],
  [12, [7]],
  [13, utf8('XN')],
  [22, [0, 12]],
]);

// VMTI targets: two vehicles on the ground near the scene centre (10 m HAE).
const T0 = truth.frames[0];
const vehicles = [
  { id: 1, lat: T0.frame_center.lat - 0.0012, lon: T0.frame_center.lon - 0.0006, vn: 9, ve: 0 },
  { id: 2, lat: T0.frame_center.lat + 0.0010, lon: T0.frame_center.lon + 0.0012, vn: 0, ve: -7 },
];
const mPerDegLat = 110_946;
const mPerDegLon = 111_320 * Math.cos(T0.frame_center.lat * rad);
function vehicleAt(v, t) {
  return { lat: v.lat + (v.vn * t) / mPerDegLat, lon: v.lon + (v.ve * t) / mPerDegLon, h: 10 };
}

const frames = truth.frames.map((fr) => {
  const pos = { lat: fr.platform.lat, lon: fr.platform.lon, h: fr.platform.alt_hae_m };
  const hpr = [fr.platform.heading_deg, 0, 0];
  const aer = [fr.sensor.rel_az_deg, fr.sensor.rel_el_deg, 0];
  const m = frameModel(pos, hpr, aer, fr.sensor.hfov_deg);
  const hc = fr.frame_center.h_hae_m;
  const computed = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ].map(([x, y]) => {
    const g = m.toGround(x, y, hc);
    return [g.lat, g.lon];
  });
  const centre = m.toGround(W / 2, H / 2, hc);
  const vmti = vehicles.map((v) => {
    const g = vehicleAt(v, fr.t_s);
    const p = m.toImage(g);
    const col = Math.round(p.x - 0.5);
    const row = Math.round(p.y - 0.5);
    return { id: v.id, lat: g.lat, lon: g.lon, h: g.h, col, row, box: [col - 12, row - 8, col + 12, row + 8] };
  });
  return { m, pos, hpr, aer, computed, centre: [centre.lat, centre.lon], vmti };
});

function common(fr) {
  return [
    [2, beBytes(fr.precision_time_us, 8)],
    [3, utf8('FX10-SYNTH')],
    [5, uMap(fr.platform.heading_deg, 0, 360, 2)],
    [10, utf8('GW Synthetic')],
    [11, utf8('EO')],
    [13, sMap(fr.platform.lat, 90, 4)],
    [14, sMap(fr.platform.lon, 180, 4)],
    [75, uMap(fr.platform.alt_hae_m, -900, 19000, 2)],
    [16, uMap(fr.sensor.hfov_deg, 0, 180, 2)],
    [17, uMap(fr.sensor.vfov_deg, 0, 180, 2)],
    [18, uMap(fr.sensor.rel_az_deg, 0, 360, 4)],
    [19, sMap(fr.sensor.rel_el_deg, 180, 4)],
    [20, uMap(0, 0, 360, 4)],
    [21, uMap(fr.sensor.slant_range_m, 0, 5e6, 4)],
    [23, sMap(fr.frame_center.lat, 90, 4)],
    [24, sMap(fr.frame_center.lon, 180, 4)],
    [78, uMap(fr.frame_center.h_hae_m, -900, 19000, 2)],
    [65, [17]],
  ];
}

function vmtiSet(k) {
  const f = frames[k];
  const series = f.vmti.flatMap((v) => {
    const pix = (c, r) => {
      const n = r * W + c + 1;
      return beBytes(n, 3);
    };
    const loc = [...imapb(v.lat, -90, 90, 4), ...imapb(v.lon, -180, 180, 4), ...imapb(v.h, -900, 19000, 2)];
    const pack = [...berOid(v.id), ...tlv([[1, pix(v.col, v.row)], [2, pix(v.box[0], v.box[1])], [3, pix(v.box[2], v.box[3])], [5, [90]], [17, loc]])];
    return [...berLen(pack.length), ...pack];
  });
  return tlv([
    [3, utf8('GW-VMTI')],
    [4, [0, 5]],
    [5, [2]],
    [6, [2]],
    [7, beBytes(k, 3)],
    [8, beBytes(W, 2)],
    [9, beBytes(H, 2)],
    [101, series],
  ]);
}

const klvB = truth.frames.map((fr, k) => {
  const c = fr.frame_center;
  const offs = fr.corners_ul_ur_lr_ll.flatMap(([la, lo], i) => [
    [26 + 2 * i, sMap(la - c.lat, 0.075, 2)],
    [27 + 2 * i, sMap(lo - c.lon, 0.075, 2)],
  ]);
  const items = [...common(fr), ...offs, [48, SECURITY], [74, vmtiSet(k)], [136, [37]], [150, [0xde, 0xad, 0xbe, 0xef]]];
  // Item 2 first (ST 0601): `common` starts with it.
  return uasPacket(items, { breakChecksum: k === 100 || k === 101 });
});
const klvC = truth.frames.map((fr) => uasPacket([...common(fr), [90, sMap(0, 90, 4)], [91, sMap(0, 90, 4)]]));

// ---- TS rewrite ----
const P = 188;
function crc32(b) {
  let c = 0xffffffff;
  for (const x of b) {
    c ^= x << 24;
    for (let i = 0; i < 8; i++) c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0;
  }
  return c >>> 0;
}
function packets(buf) {
  const out = [];
  for (let i = 0; i + P <= buf.length; i += P) out.push(buf.subarray(i, i + P));
  return out;
}
const pidOf = (p) => ((p[1] & 0x1f) << 8) | p[2];
const payloadOf = (p) => {
  const afc = (p[3] >> 4) & 3;
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
function rewrite(klv, { async }) {
  const pk = packets(seed);
  const pmtPid = (() => {
    const pl = payloadOf(pk.find((p) => pidOf(p) === 0));
    const s = pl.subarray(1 + pl[0]);
    return ((s[10] & 0x1f) << 8) | s[11];
  })();
  // Find the KLV PID from the PMT (stream type 0x15).
  const pmtPkt = pk.find((p) => pidOf(p) === pmtPid);
  const pl = payloadOf(pmtPkt);
  const sec = pl.subarray(1 + pl[0]);
  const slen = ((sec[1] & 0x0f) << 8) | sec[2];
  const pil = ((sec[10] & 0x0f) << 8) | sec[11];
  const es = [];
  for (let q = 12 + pil; q < 3 + slen - 4; ) {
    const il = ((sec[q + 3] & 0x0f) << 8) | sec[q + 4];
    es.push({ type: sec[q], pid: ((sec[q + 1] & 0x1f) << 8) | sec[q + 2], desc: sec.subarray(q + 5, q + 5 + il) });
    q += 5 + il;
  }
  const klvPid = es.find((e) => e.type === 0x15).pid;
  let newPmt = null;
  if (async) {
    const body = [...sec.subarray(3, 12 + pil)];
    for (const e of es) {
      const desc = e.pid === klvPid ? [0x05, 4, ...utf8('KLVA')] : [...e.desc];
      body.push(e.pid === klvPid ? 0x06 : e.type, 0xe0 | (e.pid >> 8), e.pid & 255, 0xf0 | (desc.length >> 8), desc.length & 255, ...desc);
    }
    const len = body.length + 4;
    const s = [sec[0], 0xb0 | (len >> 8), len & 255, ...body];
    const crc = crc32(s);
    s.push(crc >>> 24, (crc >> 16) & 255, (crc >> 8) & 255, crc & 255);
    newPmt = new Uint8Array([0, ...s]);
  }
  const out = [];
  const cc = { cc: 0 };
  const pmtCc = { cc: 0 };
  let k = 0;
  for (const p of pk) {
    const pid = pidOf(p);
    if (pid === pmtPid && newPmt) {
      out.push(...tsPackets(pmtPid, newPmt, pmtCc));
      continue;
    }
    if (pid !== klvPid) {
      out.push(p);
      continue;
    }
    if (!(p[1] & 0x40)) continue;
    const pes = payloadOf(p);
    const pts = pes.subarray(9, 14);
    const pkt = klv[Math.min(k, klv.length - 1)];
    k++;
    let data;
    if (async) {
      const len = pkt.length + 3;
      data = new Uint8Array([0, 0, 1, 0xbd, len >> 8, len & 255, 0x80, 0x00, 0x00, ...pkt]);
    } else {
      const cell = [0x00, k & 255, 0xdf, pkt.length >> 8, pkt.length & 255, ...pkt];
      const len = cell.length + 8;
      data = new Uint8Array([0, 0, 1, 0xfc, len >> 8, len & 255, 0x80, 0x80, 5, ...pts, ...cell]);
    }
    out.push(...tsPackets(klvPid, data, cc));
  }
  const b = new Uint8Array(out.length * P);
  out.forEach((p, i) => b.set(p, i * P));
  return { bytes: b, count: k };
}

const B = rewrite(klvB, { async: true });
const Cc = rewrite(klvC, { async: false });
writeFileSync(join(OUT, 'fx10_b.ts'), B.bytes);
writeFileSync(join(OUT, 'fx10_c.ts'), Cc.bytes);

const out = {
  description: 'FX-10 truth: the seed truth (per-frame platform, sensor, frame centre, corners) plus, per frame, the pinhole footprint on the WGS 84 ellipsoid at the frame-centre HAE (fx10_c) and the two VMTI targets (fx10_b).',
  seed: 'Research/samples/mpegts-klv-synthetic (see its SOURCE.txt)',
  video: truth.video,
  timeBasisNote: 'Precision Time Stamps are MISP Time per ST 0603 for the GIS Workbench default basis (D9); UTC = MISP − 37 s + 8.000082 s.',
  variants: {
    'fx10.ts': { carriage: 'sync 0x15', corners: 'full (82–89)', klvPackets: truth.frames.length },
    'fx10_b.ts': { carriage: 'async 0x06 KLVA, no PTS', corners: 'offset (26–33)', security: 'UNCLASSIFIED, REL XN', vmti: 2, unknownTag: 150, badChecksumFrames: [100, 101], leapSeconds: 37, klvPackets: B.count },
    'fx10_c.ts': { carriage: 'sync 0x15', corners: 'none (computed)', klvPackets: Cc.count },
  },
  frames: truth.frames.map((fr, k) => ({ ...fr, computed_corners: frames[k].computed, computed_centre: frames[k].centre, vmti: frames[k].vmti })),
};
writeFileSync(join(OUT, 'fx10_truth.json'), JSON.stringify(out));
console.log(`FX-10: fx10.ts (seed), fx10_b.ts ${B.bytes.length} B (${B.count} KLV), fx10_c.ts ${Cc.bytes.length} B (${Cc.count} KLV) → ${OUT}`);
