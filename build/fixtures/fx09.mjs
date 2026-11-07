// FX-09 (Appendix E, SCN-14 and SCN-10): a synthetic airborne LiDAR survey of the FX-01/04/05 site
// — the analytic terrain with flat-roofed buildings (one L-shaped), trees with canopy and ground
// returns, a road (dark intensity), a few low- and high-noise points — as LAS 1.4 point format 6
// in WGS 84 / UTM 11N with EGM96 orthometric heights (compound WKT), the same points as LAZ, a
// 5 M-point LAZ for the rendering budget test (AT-14.1), and a LAS 1.2 format-3 subset in US
// survey feet with GeoTIFF keys (REQ-LDR-03). Truth: the header, class and return counts, the
// building footprints and heights, the trees. Dev-only.
// Usage: node build/fixtures/fx09.mjs [outDir] [--no-5m]
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import proj4 from 'proj4';
import { meanSeaLevel } from 'egm96-universal';
import { SITE, terrain } from './site.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const out = join(args.find((a) => !a.startsWith('--')) ?? join(root, 'fixtures'), 'fx09');
const kx = 111320 * Math.cos((SITE[0] * Math.PI) / 180);
const ky = 110940;
const ll = (e, n) => [SITE[0] + n / ky, SITE[1] + e / kx];
const AREA = { e0: 50, e1: 550, n0: -550, n1: -50 };
const toUtm = proj4('EPSG:4326', 'EPSG:32611');
const toSp = proj4('EPSG:4326', '+proj=lcc +lat_0=33.5 +lon_0=-118 +lat_1=35.4666666666667 +lat_2=34.0333333333333 +x_0=2000000.0001016 +y_0=500000.0001016 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

// Buildings: centre (site metres), size, rotation (degrees anticlockwise from east), height above
// the ground at the centre (flat roofs at one HAE).
const rect = (ce, cn, w, d, rot) => {
  const a = (rot * Math.PI) / 180;
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([x, y]) => [ce + x * Math.cos(a) - y * Math.sin(a), cn + x * Math.sin(a) + y * Math.cos(a)]);
};
const BUILDINGS = [
  { id: 'B01', ring: rect(90, -100, 24, 16, 0), h: 9 },
  { id: 'B02', ring: rect(150, -200, 30, 20, 15), h: 12 },
  { id: 'B03', ring: rect(250, -210, 18, 18, 0), h: 6 },
  { id: 'B04', ring: rect(330, -195, 40, 14, -20), h: 15 },
  { id: 'B05', ring: rect(400, -260, 20, 30, 30), h: 8 },
  {
    id: 'B06',
    ring: [
      [215, -485],
      [245, -485],
      [245, -470],
      [230, -470],
      [230, -455],
      [215, -455],
    ],
    h: 10,
  },
  { id: 'B07', ring: rect(300, -470, 16, 24, 0), h: 5 },
  { id: 'B08', ring: rect(180, -520, 26, 18, 10), h: 18 },
  { id: 'B09', ring: rect(350, -525, 22, 22, 45), h: 7 },
  { id: 'B10', ring: rect(100, -270, 20, 12, 0), h: 4 },
  { id: 'B11', ring: rect(480, -200, 14, 28, 0), h: 11 },
];
const inRing = (ring, x, y) => {
  let c = false;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) if (ring[a][1] > y !== ring[b][1] > y && x < ((ring[b][0] - ring[a][0]) * (y - ring[a][1])) / (ring[b][1] - ring[a][1]) + ring[a][0]) c = !c;
  return c;
};
const centroid = (ring) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
const ground = (e, n) => terrain(...ll(e, n));
for (const b of BUILDINGS) {
  const [ce, cn] = centroid(b.ring);
  b.groundHae = ground(ce, cn);
  b.roofHae = b.groundHae + b.h;
  const xs = b.ring.map((p) => p[0]);
  const ys = b.ring.map((p) => p[1]);
  b.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  let a = 0;
  for (let i = 0, j = b.ring.length - 1; i < b.ring.length; j = i++) a += (b.ring[j][0] + b.ring[i][0]) * (b.ring[j][1] - b.ring[i][1]);
  b.area = Math.abs(a) / 2;
}
const ROAD = { n: -380, half: 5 };
// Trees away from buildings (8 m) and the road.
const TREES = [];
{
  const r = rng(909);
  let guard = 0;
  while (TREES.length < 90 && guard++ < 20000) {
    const e = AREA.e0 + 10 + r() * (AREA.e1 - AREA.e0 - 20);
    const n = AREA.n0 + 10 + r() * (AREA.n1 - AREA.n0 - 20);
    const rad = 2 + r() * 3;
    if (Math.abs(n - ROAD.n) < ROAD.half + rad + 2) continue;
    if (BUILDINGS.some((b) => e > b.bbox[0] - rad - 8 && e < b.bbox[2] + rad + 8 && n > b.bbox[1] - rad - 8 && n < b.bbox[3] + rad + 8)) continue;
    if (TREES.some((t) => Math.hypot(t.e - e, t.n - n) < t.r + rad + 1)) continue;
    TREES.push({ e, n, r: rad, h: 6 + r() * 9 });
  }
  for (const t of TREES) t.groundHae = ground(t.e, t.n);
}
function surfaceAt(e, n) {
  for (const b of BUILDINGS) if (e >= b.bbox[0] && e <= b.bbox[2] && n >= b.bbox[1] && n <= b.bbox[3] && inRing(b.ring, e, n)) return { kind: 'building', b };
  for (const t of TREES) {
    const d = Math.hypot(e - t.e, n - t.n);
    if (d < t.r) return { kind: 'tree', t, d };
  }
  return { kind: 'ground' };
}

const WKT_UTM =
  'PROJCS["WGS 84 / UTM zone 11N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-117],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32611"]]';
const WKT = `COMPD_CS["WGS 84 / UTM zone 11N + EGM96 height",${WKT_UTM},VERT_CS["EGM96 height",VERT_DATUM["EGM96 geoid",2005,AUTHORITY["EPSG","5171"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Gravity-related height",UP],AUTHORITY["EPSG","5773"]]]`;


/** Simulate the survey: `density` first-return samples per m². Returns columns sorted by time. */
function survey(density, seed) {
  const r = rng(seed);
  const C = { e: [], n: [], hae: [], cls: [], rn: [], nr: [], inten: [], src: [], t: [], scan: [] };
  const push = (e, n, hae, cls, rn, nr, inten, src, t, scan) => {
    C.e.push(e);
    C.n.push(n);
    C.hae.push(hae);
    C.cls.push(cls);
    C.rn.push(rn);
    C.nr.push(nr);
    C.inten.push(inten);
    C.src.push(src);
    C.t.push(t);
    C.scan.push(scan);
  };
  const step = 1 / Math.sqrt(density);
  const lines = [150, 300, 450]; // flight lines (east, site metres), north-bound, 1000 m AGL
  for (let n = AREA.n0 + step / 2; n < AREA.n1; n += step) {
    for (let e = AREA.e0 + step / 2; e < AREA.e1; e += step) {
      const pe = e + (r() - 0.5) * step;
      const pn = n + (r() - 0.5) * step;
      const li = lines.reduce((b, x, i) => (Math.abs(pe - x) < Math.abs(pe - lines[b]) ? i : b), 0);
      const t = 1000 * li + (pn - AREA.n0) / 60 + ((pe - lines[li] + 100) / 200) * 0.002;
      const scan = Math.round((Math.atan((pe - lines[li]) / 1000) * 180) / Math.PI / 0.006);
      const src = li + 1;
      const s = surfaceAt(pe, pn);
      const g = ground(pe, pn);
      const noise = () => 0.03 * gauss(r);
      const roadI = Math.abs(pn - ROAD.n) <= ROAD.half;
      if (s.kind === 'building') {
        push(pe, pn, s.b.roofHae + noise(), 6, 1, 1, 600 + 40 * gauss(r), src, t, scan);
      } else if (s.kind === 'tree') {
        const crown = s.t.groundHae + s.t.h * (0.6 + 0.4 * Math.sqrt(Math.max(0, 1 - (s.d / s.t.r) ** 2)));
        if (r() < 0.75) {
          const through = r() < 0.6;
          push(pe, pn, crown - r() * 1.2 + noise(), 5, 1, through ? 2 : 1, 250 + 40 * gauss(r), src, t, scan);
          if (through) push(pe, pn, g + noise(), 2, 2, 2, 150 + 30 * gauss(r), src, t + 1e-7, scan);
        } else push(pe, pn, g + noise(), 2, 1, 1, 330 + 40 * gauss(r), src, t, scan);
      } else {
        push(pe, pn, g + noise(), 2, 1, 1, roadI ? 110 + 20 * gauss(r) : 350 + 50 * gauss(r), src, t, scan);
      }
    }
  }
  // Noise: low (class 7, 5–20 m under the ground) and high (class 18, 80–200 m up).
  for (let k = 0; k < 40; k++) {
    const e = AREA.e0 + r() * (AREA.e1 - AREA.e0);
    const n = AREA.n0 + r() * (AREA.n1 - AREA.n0);
    const low = k < 30;
    push(e, n, ground(e, n) + (low ? -(5 + 15 * r()) : 80 + 120 * r()), low ? 7 : 18, 1, 1, 50, 1, 3000 + k, 0);
  }
  const order = Array.from(C.t.keys()).sort((a, b) => C.t[a] - C.t[b]);
  const out = { length: order.length };
  for (const k of Object.keys(C)) out[k] = Float64Array.from(order, (i) => C[k][i]);
  return out;
}

const extent = (n, f) => {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < n; k++) {
    const v = f(k);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
};

/** Project: X, Y (UTM m or SP ftUS), Z (EGM96 m or NAVD88≈EGM96 ftUS), as Float64Array ×3n. */
function coords(P, sp) {
  const xyz = new Float64Array(3 * P.length);
  for (let k = 0; k < P.length; k++) {
    const [lat, lon] = ll(P.e[k], P.n[k]);
    const N = meanSeaLevel(lat, lon);
    const [x, y] = (sp ? toSp : toUtm).forward([lon, lat]);
    xyz[3 * k] = x;
    xyz[3 * k + 1] = y;
    xyz[3 * k + 2] = sp ? (P.hae[k] - N) / 0.3048006096012192 : P.hae[k] - N;
  }
  return xyz;
}

function quantise(P, xyz, scale) {
  const n = P.length;
  const ext = [0, 1, 2].map((a) => extent(n, (k) => xyz[3 * k + a]));
  const offset = ext.map(([lo]) => Math.floor(lo / 1000) * 1000);
  const q = new Int32Array(3 * n);
  for (let k = 0; k < 3 * n; k++) q[k] = Math.round((xyz[k] - offset[k % 3]) / scale[k % 3]);
  const min = [0, 1, 2].map((a) => extent(n, (k) => q[3 * k + a])[0] * scale[a] + offset[a]);
  const max = [0, 1, 2].map((a) => extent(n, (k) => q[3 * k + a])[1] * scale[a] + offset[a]);
  return { q, offset, min, max };
}

function lasHeader14({ n, byReturn, scale, offset, min, max, nvlr, pointOffset, format, recLen, encoding }) {
  const b = Buffer.alloc(375);
  b.write('LASF', 0, 'latin1');
  b.writeUInt16LE(909, 4);
  b.writeUInt16LE(encoding, 6);
  b.writeUInt8(1, 24);
  b.writeUInt8(4, 25);
  b.write('GIS Workbench FX-09', 26, 'latin1');
  b.write('fx09.mjs', 58, 'latin1');
  b.writeUInt16LE(299, 90);
  b.writeUInt16LE(2026, 92);
  b.writeUInt16LE(375, 94);
  b.writeUInt32LE(pointOffset, 96);
  b.writeUInt32LE(nvlr, 100);
  b.writeUInt8(format, 104);
  b.writeUInt16LE(recLen, 105);
  b.writeUInt32LE(0, 107);
  for (let a = 0; a < 3; a++) {
    b.writeDoubleLE(scale[a], 131 + 8 * a);
    b.writeDoubleLE(offset[a], 155 + 8 * a);
    b.writeDoubleLE(max[a], 179 + 16 * a);
    b.writeDoubleLE(min[a], 187 + 16 * a);
  }
  b.writeBigUInt64LE(0n, 227);
  b.writeBigUInt64LE(0n, 235);
  b.writeUInt32LE(0, 243);
  b.writeBigUInt64LE(BigInt(n), 247);
  for (let i = 0; i < 15; i++) b.writeBigUInt64LE(BigInt(byReturn[i]), 255 + 8 * i);
  return b;
}

function vlr(user, id, desc, payload) {
  const b = Buffer.alloc(54);
  b.write(user, 2, 'latin1');
  b.writeUInt16LE(id, 18);
  b.writeUInt16LE(payload.length, 20);
  b.write(desc, 22, 'latin1');
  return Buffer.concat([b, payload]);
}

function writeLas14(file, P) {
  const scale = [0.001, 0.001, 0.001];
  const { q, offset, min, max } = quantise(P, coords(P, false), scale);
  const byReturn = Array(15).fill(0);
  const recs = Buffer.alloc(P.length * 30);
  for (let k = 0; k < P.length; k++) {
    const o = k * 30;
    recs.writeInt32LE(q[3 * k], o);
    recs.writeInt32LE(q[3 * k + 1], o + 4);
    recs.writeInt32LE(q[3 * k + 2], o + 8);
    recs.writeUInt16LE(Math.max(0, Math.min(65535, Math.round(P.inten[k]))), o + 12);
    recs.writeUInt8(P.rn[k] | (P.nr[k] << 4), o + 14);
    recs.writeUInt8(0, o + 15);
    recs.writeUInt8(P.cls[k], o + 16);
    recs.writeUInt8(0, o + 17);
    recs.writeInt16LE(P.scan[k], o + 18);
    recs.writeUInt16LE(P.src[k], o + 20);
    recs.writeDoubleLE(1.3e9 + P.t[k], o + 22);
    byReturn[P.rn[k] - 1]++;
  }
  const v = vlr('LASF_Projection', 2112, 'OGC WKT coordinate system', Buffer.from(`${WKT}\0`, 'latin1'));
  const head = lasHeader14({ n: P.length, byReturn, scale, offset, min, max, nvlr: 1, pointOffset: 375 + v.length, format: 6, recLen: 30, encoding: 1 | 16 });
  writeFileSync(file, Buffer.concat([head, v, recs]));
  return { n: P.length, byReturn, scale, offset, min, max, pointOffset: 375 + v.length };
}

/** LAS 1.2, format 3 (RGB), GeoTIFF keys: NAD83 / California zone 5 (ftUS) + NAVD88 height (ftUS). */
function writeLas12Ft(file, P) {
  const scale = [0.01, 0.01, 0.01];
  const { q, offset, min, max } = quantise(P, coords(P, true), scale);
  const keys = [
    [1024, 0, 1, 1], // GTModelTypeGeoKey = projected
    [1025, 0, 1, 1], // GTRasterTypeGeoKey = PixelIsArea
    [3072, 0, 1, 2229], // ProjectedCSTypeGeoKey
    [3076, 0, 1, 9003], // ProjLinearUnitsGeoKey = US survey foot
    [4096, 0, 1, 5703], // VerticalCSTypeGeoKey = NAVD88 height
    [4099, 0, 1, 9003], // VerticalUnitsGeoKey
  ];
  const dir = Buffer.alloc(8 + 8 * keys.length);
  [1, 1, 0, keys.length].forEach((v, i) => dir.writeUInt16LE(v, 2 * i));
  keys.forEach((k, i) => k.forEach((v, j) => dir.writeUInt16LE(v, 8 + 8 * i + 2 * j)));
  const v = vlr('LASF_Projection', 34735, 'GeoKeyDirectoryTag', dir);
  const recLen = 34;
  const recs = Buffer.alloc(P.length * recLen);
  const byReturn = Array(5).fill(0);
  for (let k = 0; k < P.length; k++) {
    const o = k * recLen;
    for (let a = 0; a < 3; a++) recs.writeInt32LE(q[3 * k + a], o + 4 * a);
    recs.writeUInt16LE(Math.max(0, Math.round(P.inten[k])), o + 12);
    recs.writeUInt8(P.rn[k] | (P.nr[k] << 3), o + 14);
    recs.writeUInt8(Math.min(31, P.cls[k]), o + 15);
    recs.writeInt8(Math.round(P.scan[k] * 0.006), o + 16);
    recs.writeUInt8(0, o + 17);
    recs.writeUInt16LE(P.src[k], o + 18);
    recs.writeDoubleLE(1.3e9 + P.t[k], o + 20);
    const c = P.cls[k] === 6 ? [52000, 20000, 20000] : P.cls[k] === 5 ? [10000, 40000, 12000] : [30000, 28000, 22000];
    c.forEach((x, i) => recs.writeUInt16LE(x, o + 28 + 2 * i));
    byReturn[P.rn[k] - 1]++;
  }
  const b = Buffer.alloc(227);
  b.write('LASF', 0, 'latin1');
  b.writeUInt8(1, 24);
  b.writeUInt8(2, 25);
  b.write('GIS Workbench FX-09', 26, 'latin1');
  b.write('fx09.mjs', 58, 'latin1');
  b.writeUInt16LE(299, 90);
  b.writeUInt16LE(2026, 92);
  b.writeUInt16LE(227, 94);
  b.writeUInt32LE(227 + v.length, 96);
  b.writeUInt32LE(1, 100);
  b.writeUInt8(3, 104);
  b.writeUInt16LE(recLen, 105);
  b.writeUInt32LE(P.length, 107);
  byReturn.forEach((x, i) => b.writeUInt32LE(x, 111 + 4 * i));
  for (let a = 0; a < 3; a++) {
    b.writeDoubleLE(scale[a], 131 + 8 * a);
    b.writeDoubleLE(offset[a], 155 + 8 * a);
    b.writeDoubleLE(max[a], 179 + 16 * a);
    b.writeDoubleLE(min[a], 187 + 16 * a);
  }
  writeFileSync(file, Buffer.concat([b, v, recs]));
  return { n: P.length, scale, offset };
}

function las2laz(src, dst) {
  execFileSync('cargo', ['run', '--quiet', '--release', '-p', 'gw-pointcloud', '--example', 'las2laz', '--', src, dst], { cwd: join(root, 'crates'), stdio: 'inherit' });
}

mkdirSync(out, { recursive: true });
const P = survey(4, 9);
const hdr = writeLas14(join(out, 'fx09.las'), P);
las2laz(join(out, 'fx09.las'), join(out, 'fx09.laz'));
const pick = (src, idx) => {
  const o = { length: idx.length };
  for (const k of Object.keys(src)) if (k !== 'length') o[k] = Float64Array.from(idx, (i) => src[k][i]);
  return o;
};
const S = pick(P, Array.from({ length: Math.ceil(P.length / 50) }, (_, i) => i * 50));
const ft = writeLas12Ft(join(out, 'fx09_ftus.las'), S);
const classes = {};
const returns = {};
for (let k = 0; k < P.length; k++) {
  classes[P.cls[k]] = (classes[P.cls[k]] ?? 0) + 1;
  const key = `${P.rn[k]}/${P.nr[k]}`;
  returns[key] = (returns[key] ?? 0) + 1;
}
// Truth for the ftUS subset: some points with their lat/lon/HAE.
const subTruth = [];
for (let k = 0; k < S.length; k += 997) {
  const [lat, lon] = ll(S.e[k], S.n[k]);
  subTruth.push({ k, lat, lon, hae: S.hae[k] });
}
let big = null;
if (!args.includes('--no-5m')) {
  const P5 = survey(20.2, 55);
  const tmp = join(out, 'fx09_5m.tmp.las');
  writeLas14(tmp, P5);
  las2laz(tmp, join(out, 'fx09_5m.laz'));
  rmSync(tmp);
  big = { n: P5.length };
}
const truth = {
  fixture: 'FX-09',
  site: { lat: SITE[0], lon: SITE[1] },
  frame: { kx, ky, note: 'site metres: e = (lon − site.lon)·kx, n = (lat − site.lat)·ky' },
  area: AREA,
  crs: { horizontal: 'EPSG:32611', vertical: 'EGM96 height (EPSG:5773)', wkt: WKT },
  header: { version: '1.4', format: 6, recordLen: 30, ...hdr, systemId: 'GIS Workbench FX-09', software: 'fx09.mjs', day: 299, year: 2026, fileSourceId: 909, globalEncoding: 17 },
  classes,
  returns,
  noise: 0.03,
  road: ROAD,
  buildings: BUILDINGS.map((b) => ({ id: b.id, ring: b.ring, ringLatLon: b.ring.map(([e, n]) => ll(e, n)), height: b.h, groundHae: b.groundHae, roofHae: b.roofHae, area: b.area })),
  trees: TREES.map((t) => ({ ...t, centre: ll(t.e, t.n) })),
  ftus: { file: 'fx09_ftus.las', n: ft.n, crs: 'EPSG:2229 + NAVD88 height (ftUS); NAVD88 written as EGM96 heights', points: subTruth },
  big,
};
writeFileSync(join(out, 'fx09_truth.json'), JSON.stringify(truth, null, 1));
console.log(`FX-09: ${P.length} points (${JSON.stringify(classes)}), ftUS subset ${S.length}${big ? `, 5M LAZ ${big.n}` : ''}`);
