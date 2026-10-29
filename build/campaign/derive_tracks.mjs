// Derived STANAG 4607 GMTI and STANAG 4676 track files from real vessel kinematics: one day of U.S.
// AIS (support-ais-marinecadastre-20230601) is cut to 20 minutes over three harbours, each moving
// vessel is interpolated to a dwell every 10 s, and a stand-off airborne radar 40 km away "observes"
// them. No public real 4607/4676 data exists (TE-owner-decisions OD-05), so these replace purely
// synthetic kinematics. The 4607 encoder follows build/fixtures/fx11.mjs (same field layout and
// BA32/SA32 convention); truth JSON records every target position. Two 4676 encodings per harbour:
// schema-style (<items xsi:type="TrackPoint">, trackItemTime, trackPointPosition) and the simple
// trackPoint/time/latitude/longitude form. Registers the item in sources/archive-derived.json.
//
//   node build/campaign/derive_tracks.mjs

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { CORPUS, HERE } from './corpus-lib.mjs';

const AIS = join(CORPUS, 'support-ais-marinecadastre-20230601', 'AIS_2023_06_01.csv');
const ID = 'derived-gmti-tracks-ais';
const OUT = join(CORPUS, ID);
const T0 = Date.parse('2023-06-01T14:00:00Z');
const MINUTES = 20;
const STEP = 10; // s between dwells
const AREAS = [
  { tag: 'la_longbeach', name: 'Los Angeles / Long Beach', s: 33.55, n: 33.8, w: -118.35, e: -118.05, sensor: { dlat: -0.05, dlon: -0.45 } },
  { tag: 'sf_bay', name: 'San Francisco Bay', s: 37.7, n: 37.9, w: -122.55, e: -122.25, sensor: { dlat: 0, dlon: -0.5 } },
  { tag: 'houston_galveston', name: 'Houston Ship Channel / Galveston Bay', s: 29.3, n: 29.8, w: -95.1, e: -94.65, sensor: { dlat: -0.4, dlon: 0 } },
];
const rad = Math.PI / 180;

if (!existsSync(AIS)) throw new Error(`missing ${AIS}: fetch support-ais-marinecadastre-20230601 (extract) first`);
mkdirSync(OUT, { recursive: true });

// ---- read AIS: positions inside the areas within T0 − 2 min … T0 + 22 min ----
const tracks = Object.fromEntries(AREAS.map((a) => [a.tag, new Map()]));
const rl = createInterface({ input: createReadStream(AIS), crlfDelay: Infinity });
let header = true;
for await (const line of rl) {
  if (header) {
    header = false;
    continue;
  }
  const c = line.split(',');
  const t = Date.parse(`${c[1]}Z`);
  if (t < T0 - 120e3 || t > T0 + (MINUTES + 2) * 60e3) continue;
  const lat = +c[2];
  const lon = +c[3];
  for (const a of AREAS) {
    if (lat < a.s || lat > a.n || lon < a.w || lon > a.e) continue;
    const m = tracks[a.tag];
    if (!m.has(c[0])) m.set(c[0], { mmsi: c[0], name: c[7], type: +c[10] || 0, pts: [] });
    m.get(c[0]).pts.push({ t, lat, lon, sog: +c[4], cog: +c[5] });
  }
}

function interp(pts, t) {
  if (t < pts[0].t || t > pts.at(-1).t) return null;
  let i = 1;
  while (pts[i].t < t) i++;
  const a = pts[i - 1];
  const b = pts[i];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return { lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon), sog: a.sog + f * (b.sog - a.sog), cog: b.cog };
}

// ---- 4607 big-endian writer (as build/fixtures/fx11.mjs) ----
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
  sa32(d) {
    return this.i32(Math.round((d / 90) * 2 ** 30));
  }
  ba32(d) {
    return this.u32(Math.round(((((d % 360) + 360) % 360) / 90) * 2 ** 30) >>> 0);
  }
  ba16(d) {
    return this.u16(Math.round(((((d % 360) + 360) % 360) / 90) * 2 ** 14) & 0xffff);
  }
}
const segment = (type, body) => {
  const w = new W().u8(type).u32(body.length + 5);
  w.b.push(...body);
  return w.b;
};
const packet = (segs, platform) => {
  const body = segs.flat();
  const w = new W().text('30', 2).u32(32 + body.length).text('US', 2).u8(5).text('US', 2).u16(0).u8(0).text(platform, 10).u32(7).u32(4607);
  w.b.push(...body);
  return w.b;
};
const FIELDS = [0, 1, 2, 3, 4, 5, 6, 7, 13, 14, 19, 22, 23, 24, 25, 30, 31, 32, 35, 36, 38, 39, 40];
const MASK = FIELDS.reduce((m, i) => m | (1n << BigInt(63 - i)), 0n);
const DAY0 = Date.UTC(2023, 5, 1);

const files = [];
const recipe = [];
const summary = [];
for (const a of AREAS) {
  const moving = [...tracks[a.tag].values()].filter((v) => v.pts.length >= 3 && v.pts.some((p) => p.sog > 2)).map((v) => ({ ...v, pts: v.pts.sort((x, y) => x.t - y.t) }));
  const cLat = (a.s + a.n) / 2;
  const cLon = (a.w + a.e) / 2;
  const sensor = { lat: cLat + a.sensor.dlat, lon: cLon + a.sensor.dlon, alt: 8000 };
  const mLat = 110_946;
  const mLon = 111_320 * Math.cos(cLat * rad);
  const ids = new Map(moving.map((v, i) => [v.mmsi, i]));
  // 4607
  const mission = new W().text(`AIS ${a.tag}`.slice(0, 12), 12).text('DERIVED', 12).u8(19).text('STANDOFF', 10).u16(2023).u8(6).u8(1).b;
  const job = (() => {
    const w = new W().u32(4607).u8(255).text('AISRDR', 6).u8(0).u8(1);
    for (const [la, lo] of [[a.n, a.w], [a.n, a.e], [a.s, a.e], [a.s, a.w]]) w.sa32(la).ba32(lo);
    w.u8(1).u16(5).u16(10).u16(10).u16(10).u8(0).u16(0).u16(0).ba16(0).u16(0).u8(5).u8(90).u8(10).u8(1).u8(2);
    return w.b;
  })();
  const platform = `GW-${a.tag.slice(0, 7).toUpperCase()}`;
  const packets = [packet([segment(1, mission), segment(5, job)], platform)];
  const dwells = [];
  const n = (MINUTES * 60) / STEP;
  for (let k = 0; k < n; k++) {
    const t = T0 + k * STEP * 1000;
    const ms = t - DAY0;
    const tg = [];
    for (const v of moving) {
      const p = interp(v.pts, t);
      if (!p) continue;
      const dn = (p.lat - sensor.lat) * mLat;
      const de = (p.lon - sensor.lon) * mLon;
      const r = Math.hypot(dn, de, sensor.alt);
      const vn = p.sog * 0.514444 * Math.cos(p.cog * rad);
      const ve = p.sog * 0.514444 * Math.sin(p.cog * rad);
      tg.push({ index: ids.get(v.mmsi), mmsi: v.mmsi, lat: p.lat, lon: p.lon, h: 0, vlos: Math.round(((vn * dn + ve * de) / r) * 100) / 100, snr: 15, cls: 3, prob: 90 });
    }
    const w = new W().u64(MASK).u16(1).u16(k).u8(k === n - 1 ? 1 : 0).u16(tg.length).u32(ms).sa32(sensor.lat).ba32(sensor.lon).i32(sensor.alt * 100);
    w.ba16(0).u32(150_000).ba16(0);
    w.sa32(cLat).ba32(cLon).u16(Math.round(((a.n - a.s) * mLat) / 2000 * 128)).ba16(30);
    for (const x of tg) w.u16(x.index).sa32(x.lat).ba32(x.lon).i16(0).i16(Math.round(x.vlos * 100)).i8(x.snr).u8(x.cls).u8(x.prob);
    const plat = new W().u32(ms).sa32(sensor.lat).ba32(sensor.lon).i32(sensor.alt * 100).ba16(0).u32(150_000).i8(0).b;
    packets.push(packet([segment(13, plat), segment(2, w.b)], platform));
    dwells.push({ dwell: k, utcMs: t, timeMs: ms, targets: tg.map(({ index, mmsi, lat, lon, vlos }) => ({ index, mmsi, lat, lon, vlos })) });
  }
  const g = `${a.tag}_ais_20230601.4607`;
  writeFileSync(join(OUT, g), Uint8Array.from(packets.flat()));
  writeFileSync(join(OUT, `${a.tag}_ais_20230601_truth.json`), JSON.stringify({ area: a, sensor, startUtc: new Date(T0).toISOString(), stepS: STEP, dwells }, null, 0));
  files.push([g, 'primary'], [`${a.tag}_ais_20230601_truth.json`, 'truth']);
  // 4676, two encodings
  const iso = (t) => new Date(t).toISOString();
  const pointsOf = (v) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      const t = T0 + k * STEP * 1000;
      const p = interp(v.pts, t);
      if (p) out.push({ t, ...p });
    }
    return out;
  };
  const head = (ns) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<TrackMessage xmlns="urn:int:nato:stanag4676:0.14"${ns ? ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' : ''}>\n  <stanagVersion>0.14</stanagVersion>\n  <messageSecurity><policyName>NATO</policyName><classification>UNCLASSIFIED</classification></messageSecurity>\n  <msgCreatedTime>${iso(T0 + MINUTES * 60e3)}</msgCreatedTime>\n  <senderId><stationId>GISWORKBENCH-TE</stationId></senderId>\n  <tracks>\n`;
  const schema = [head(true)];
  const simple = [head(false)];
  for (const v of moving) {
    const pts = pointsOf(v);
    if (pts.length < 2) continue;
    const tn = String(ids.get(v.mmsi) + 1);
    schema.push(`    <track>\n      <trackUUID>00000000-0000-4000-8000-${v.mmsi.padStart(12, '0')}</trackUUID>\n      <trackNumber>${tn}</trackNumber>\n      <trackStatus>ACTIVE</trackStatus>\n      <trackComment>AIS MMSI ${v.mmsi} ${v.name.replace(/[<&>]/g, '')}</trackComment>\n`);
    simple.push(`    <track>\n      <trackNumber>${tn}</trackNumber>\n`);
    for (const p of pts) {
      schema.push(
        `      <items xsi:type="TrackPoint"><trackItemTime>${iso(p.t)}</trackItemTime><trackPointPosition><latitude>${p.lat.toFixed(6)}</latitude><longitude>${p.lon.toFixed(6)}</longitude><elevation>0</elevation></trackPointPosition><trackPointVelocity><speed>${(p.sog * 0.514444).toFixed(2)}</speed><course>${p.cog.toFixed(1)}</course></trackPointVelocity><trackPointType>MEASURED</trackPointType></items>\n`,
      );
      simple.push(`      <trackPoint><time>${iso(p.t)}</time><latitude>${p.lat.toFixed(6)}</latitude><longitude>${p.lon.toFixed(6)}</longitude></trackPoint>\n`);
    }
    schema.push('    </track>\n');
    simple.push('    </track>\n');
  }
  for (const [arr, kind] of [[schema, 'schema'], [simple, 'simple']]) {
    arr.push('  </tracks>\n</TrackMessage>\n');
    const f = `${a.tag}_ais_20230601_${kind}.4676.xml`;
    writeFileSync(join(OUT, f), arr.join(''));
    files.push([f, 'primary']);
  }
  recipe.push(`${a.name}: ${moving.length} moving vessels, ${n} dwells every ${STEP} s from ${iso(T0)}; stand-off sensor ${sensor.lat.toFixed(3)}, ${sensor.lon.toFixed(3)}, 8 km`);
  summary.push(`${a.tag}: ${moving.length} tracks, ${packets.length} packets`);
}

const entry = {
  id: ID,
  area: 'gmti',
  title: 'STANAG 4607 GMTI and STANAG 4676 tracks derived from real AIS vessel kinematics (Los Angeles/Long Beach, San Francisco Bay, Houston/Galveston; 2023-06-01 14:00–14:20 UTC)',
  source: 'Derived from support-ais-marinecadastre-20230601',
  landing: 'build/campaign/derive_tracks.mjs',
  licence: 'Public domain (MarineCadastre.gov AIS); derived encodings free to use',
  attribution: 'BOEM and NOAA, MarineCadastre.gov',
  tier: 'A',
  origin: 'derived',
  format: 'STANAG 4607 (.4607) / STANAG 4676 XML (.4676.xml)',
  profile: 'Dwell every 10 s, high-resolution target reports with radial velocity; 4676 in schema-style and simple encodings',
  files: files.map(([name, role]) => ({ name, url: null, role })),
  sign: null,
  derivation: recipe.join('; '),
  notes: 'Generated by build/campaign/derive_tracks.mjs. Truth JSON lists every target per dwell (MMSI, lat, lon, radial velocity).',
  feeds: ['fmv.gmti', 'fmv.gmticolour', 'tracks'],
  covers: ['fmt:gmti.4607', 'fmt:tracks.4676'],
  pairs: [],
};
const srcFile = join(HERE, 'sources', 'archive-derived.json');
const all = existsSync(srcFile) ? JSON.parse(readFileSync(srcFile, 'utf8')) : [];
const i = all.findIndex((e) => e.id === ID);
if (i >= 0) all[i] = entry;
else all.push(entry);
writeFileSync(srcFile, JSON.stringify(all, null, 1));
console.log(`${ID}: ${summary.join('; ')}`);
