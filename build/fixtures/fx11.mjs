// FX-11: synthetic STANAG 4607 GMTI for SCN-15 (Appendix E AT-15.5). No public 4607 sample
// exists (`Research/12` §16.3), so this generator writes one from the field list, independently
// of the Rust reader. A stand-off radar 30 km west of the FX-10 scene at 8 km altitude revisits
// the scene every 0.5 s; six vehicles move on straight tracks (vehicle 1 is FX-10's VMTI target 1).
//
// Timing: FX-10's first Precision Time Stamp is MISP Time 1761436800.000000 s, i.e. UTC
// 2025-10-25T23:59:31.000082Z under the default basis (D9: UTC = MISP − 37 s + 8.000082 s). Dwells
// run from 5 s before the clip to its end; dwell times are milliseconds after midnight of the
// mission reference date 2025-10-25.
//
// Packet 1: mission + job definition. Then one packet per dwell: platform location + dwell with
// high-resolution target reports (D32.2/3; BA32/SA32 resolution ≈ 9 mm) so AT-15.5's 1 m test
// is meaningful; a final packet carries a free-text segment.
//
//   node build/fixtures/fx11.mjs [outdir]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] ? join(process.argv[2], 'fx11') : join(ROOT, 'fixtures', 'fx11');
mkdirSync(OUT, { recursive: true });

const rad = Math.PI / 180;
const SCENE = { lat: -34.51, lon: -58.59375673061305 };
const mLat = 110_946;
const mLon = 111_320 * Math.cos(SCENE.lat * rad);
const SENSOR = { lat: SCENE.lat, lon: SCENE.lon - 30_000 / mLon, alt: 8000 };
const MISP0 = 1761436800; // FX-10 first Precision Time Stamp (s, MISP)
const UTC0 = MISP0 - 37 + 8.000082; // its UTC under the default basis
const DAY0 = Date.UTC(2025, 9, 25) / 1000;
const DWELL_STEP = 0.5;
const DWELLS = 30; // −5 s … +9.5 s

const vehicles = [
  { id: 1, lat: SCENE.lat - 0.0012, lon: SCENE.lon - 0.0006, vn: 9, ve: 0, cls: 2 },
  { id: 2, lat: SCENE.lat + 0.001, lon: SCENE.lon + 0.0012, vn: 0, ve: -7, cls: 2 },
  { id: 3, lat: SCENE.lat - 0.004, lon: SCENE.lon + 0.003, vn: 12, ve: 12, cls: 1 },
  { id: 4, lat: SCENE.lat + 0.003, lon: SCENE.lon - 0.004, vn: -15, ve: 3, cls: 2 },
  { id: 5, lat: SCENE.lat + 0.0055, lon: SCENE.lon + 0.0045, vn: -4, ve: -18, cls: 1 },
  { id: 6, lat: SCENE.lat - 0.006, lon: SCENE.lon - 0.0015, vn: 20, ve: -2, cls: 2 },
];
const at = (v, t) => ({ lat: v.lat + (v.vn * t) / mLat, lon: v.lon + (v.ve * t) / mLon, h: 10 });

// ---- big-endian writer ----
class W {
  constructor() {
    this.b = [];
  }
  u8(v) {
    this.b.push(v & 255);
    return this;
  }
  i8(v) {
    return this.u8(v < 0 ? 256 + v : v);
  }
  u16(v) {
    return this.u8(v >> 8).u8(v);
  }
  i16(v) {
    return this.u16(v < 0 ? 65536 + v : v);
  }
  u32(v) {
    v = v >>> 0;
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  i32(v) {
    return this.u32(v | 0);
  }
  u64(v) {
    return this.u32(Number(BigInt(v) >> 32n)).u32(Number(BigInt(v) & 0xffffffffn));
  }
  text(s, n) {
    for (let i = 0; i < n; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0x20);
    return this;
  }
  // SA32/BA32 with 2^30 = 90° (BA16/SA16: 2^14 = 90°).
  sa32(d) {
    return this.i32(Math.round((d / 90) * 2 ** 30));
  }
  ba32(d) {
    return this.u32(Math.round((((d % 360) + 360) % 360 / 90) * 2 ** 30) >>> 0);
  }
  ba16(d) {
    return this.u16(Math.round((((d % 360) + 360) % 360 / 90) * 2 ** 14) & 0xffff);
  }
}
function segment(type, body) {
  const w = new W().u8(type).u32(body.length + 5);
  w.b.push(...body);
  return w.b;
}
function packet(segs) {
  const body = segs.flat();
  const w = new W().text('30', 2).u32(32 + body.length).text('XN', 2).u8(5).text('XN', 2).u16(0).u8(0).text('GW-GMTI-01', 10).u32(7).u32(42);
  w.b.push(...body);
  return w.b;
}

const mission = new W().text('FX11 MISSION', 12).text('FX11 FLIGHT', 12).u8(19).text('SYNTH RDR', 10).u16(2025).u8(10).u8(25).b;
const area = [
  [SCENE.lat + 0.02, SCENE.lon - 0.025],
  [SCENE.lat + 0.02, SCENE.lon + 0.025],
  [SCENE.lat - 0.02, SCENE.lon + 0.025],
  [SCENE.lat - 0.02, SCENE.lon - 0.025],
];
const job = (() => {
  const w = new W().u32(42).u8(255).text('SYNRDR', 6).u8(0).u8(1);
  for (const [la, lo] of area) w.sa32(la).ba32(lo);
  w.u8(1).u16(5).u16(10).u16(10).u16(10).u8(0).u16(0).u16(0).ba16(0).u16(0).u8(5).u8(90).u8(10).u8(1).u8(2);
  return w.b;
})();

// Dwell existence mask: D2–D9, D15, D16, D21, D24–D27, D32.1, D32.2, D32.3, D32.6, D32.7, D32.9, D32.10, D32.11.
const FIELDS = [0, 1, 2, 3, 4, 5, 6, 7, 13, 14, 19, 22, 23, 24, 25, 30, 31, 32, 35, 36, 38, 39, 40];
const MASK = FIELDS.reduce((m, i) => m | (1n << BigInt(63 - i)), 0n);

function losUnit(t) {
  const dn = (t.lat - SENSOR.lat) * mLat;
  const de = (t.lon - SENSOR.lon) * mLon;
  const du = t.h - SENSOR.alt;
  const r = Math.hypot(dn, de, du);
  return [dn / r, de / r, du / r];
}

const dwells = [];
const packets = [packet([segment(1, mission), segment(5, job)])];
for (let k = 0; k < DWELLS; k++) {
  const tRel = -5 + k * DWELL_STEP; // seconds from the clip start
  const utc = UTC0 + tRel;
  const ms = Math.round((utc - DAY0) * 1000);
  const tgts = vehicles.map((v, i) => {
    const p = at(v, tRel);
    const u = losUnit(p);
    // Radial velocity: the target velocity along the line of sight (positive = receding).
    const vlos = Math.round((v.vn * u[0] + v.ve * u[1]) * 100) / 100;
    const snr = 12 + ((i * 7 + k * 3) % 9);
    return { id: v.id, index: i, ...p, vlos, snr, cls: v.cls, prob: 80 + i };
  });
  const w = new W().u64(MASK).u16(1).u16(k).u8(k === DWELLS - 1 ? 1 : 0).u16(tgts.length).u32(ms).sa32(SENSOR.lat).ba32(SENSOR.lon).i32(SENSOR.alt * 100);
  w.ba16(0).u32(150_000).ba16(0); // D15 track (north), D16 speed 150 m/s (mm/s), D21 platform heading
  w.sa32(SCENE.lat).ba32(SCENE.lon).u16(Math.round(3 * 128)).ba16(4);
  for (const t of tgts) {
    w.u16(t.index).sa32(t.lat).ba32(t.lon).i16(Math.round(t.h)).i16(Math.round(t.vlos * 100)).i8(t.snr).u8(t.cls).u8(t.prob);
  }
  const plat = new W().u32(ms).sa32(SENSOR.lat).ba32(SENSOR.lon).i32(SENSOR.alt * 100).ba16(0).u32(150_000).i8(0).b;
  packets.push(packet([segment(13, plat), segment(2, w.b)]));
  dwells.push({ dwell: k, tRelS: tRel, utcMs: Math.round(utc * 1000), timeMs: ms, mispUs: Math.round((MISP0 + tRel) * 1e6), targets: tgts.map((t) => ({ id: t.id, lat: t.lat, lon: t.lon, h: t.h, vlos: t.vlos, snr: t.snr, class: t.cls })) });
}
packets.push(packet([segment(6, new W().text('FX11 GEN', 10).text('ANALYST', 10).b.concat([...Buffer.from('Synthetic GMTI for SCN-15 (GIS Workbench fixture).', 'latin1')]))]));
const bytes = Uint8Array.from(packets.flat());
writeFileSync(join(OUT, 'fx11.4607'), bytes);
writeFileSync(
  join(OUT, 'fx11_truth.json'),
  JSON.stringify({
    description: 'FX-11 truth: STANAG 4607 dwells (every 0.5 s from 5 s before FX-10 to its end) with six vehicles as high-resolution target reports.',
    encoding: 'BA32/SA32 with 2^30 = 90° (Wireshark convention); dwell time = ms after midnight of 2025-10-25 (UTC).',
    timeBasis: 'FX-10 Precision Time Stamps read as MISP Time (D9 default): UTC = MISP − 37 + 8.000082 s.',
    packets: packets.length,
    sensor: SENSOR,
    scene: SCENE,
    area,
    dwells,
  }),
);
console.log(`FX-11: fx11.4607 ${bytes.length} B, ${packets.length} packets, ${DWELLS} dwells → ${OUT}`);
