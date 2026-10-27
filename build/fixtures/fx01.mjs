// FX-01 and FX-05 generator (Research/03 §1.1, Appendix E): a synthetic NITF 2.1, 4096 × 4096
// 8-bit pan image with RPC00B fitted to a pinhole satellite camera over an analytic terrain,
// UNCLASSIFIED test security fields and 50 truth points; and the same terrain as a float32
// GeoTIFF (heights above the ellipsoid) and a DTED Level 2 cell (EGM96 heights, whole metres).
// Dev-only; never shipped. Usage: node build/fixtures/fx01.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';
import mgrsPkg from 'mgrs';
import egmPkg from 'egm96-universal';

const mgrsForward = mgrsPkg.forward;
const { ellipsoidToEgm96 } = egmPkg;
import { camera, rayTerrain, fitRpc, rng, valueNoise, toEnu } from './synth.mjs';
import { SITE, terrain } from './site.mjs';
import { writeNitf, use00a } from '../../app/src/formats/nitf-writer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = process.argv[2] ?? join(root, 'fixtures');
const W = 4096;
const H = 4096;
const GSD = 0.5;

const cam = camera({ target: [SITE[0], SITE[1], terrain(SITE[0], SITE[1])], range: 600000, offNadir: 12, fromAz: 210, gsd: GSD, W, H, roll: 8 });

// Ground under a coarse pixel grid (exact ray casting), interpolated for the texture.
const STEP = 16;
const gw = W / STEP + 1;
const gh = H / STEP + 1;
const grid = new Float64Array(gw * gh * 3);
for (let j = 0; j < gh; j++)
  for (let i = 0; i < gw; i++) {
    const g = rayTerrain(cam, i * STEP, j * STEP, terrain, 650);
    grid.set(g, (j * gw + i) * 3);
  }
const groundAt = (c, r) => {
  const gx = c / STEP;
  const gy = r / STEP;
  const i = Math.min(gw - 2, Math.floor(gx));
  const j = Math.min(gh - 2, Math.floor(gy));
  const fx = gx - i;
  const fy = gy - j;
  const o = (a, b, k) => grid[(b * gw + a) * 3 + k];
  const v = (k) => o(i, j, k) * (1 - fx) * (1 - fy) + o(i + 1, j, k) * fx * (1 - fy) + o(i, j + 1, k) * (1 - fx) * fy + o(i + 1, j + 1, k) * fx * fy;
  return [v(0), v(1), v(2)];
};

// Truth points: 50 ground points inside the inner 80 % of the frame.
const R = rng(0xf01);
const truth = [];
for (let k = 0; k < 50; k++) {
  const c = W * (0.1 + 0.8 * R.next());
  const r = H * (0.1 + 0.8 * R.next());
  const g = rayTerrain(cam, c, r, terrain, 650);
  const [pc, pr] = cam.project(g[0], g[1], g[2]);
  truth.push({ id: `TP${String(k + 1).padStart(2, '0')}`, lat: g[0], lon: g[1], hae: g[2], mgrs: mgrsForward([g[1], g[0]], 5), x: pc + 0.5, y: pr + 0.5 });
}

// Texture: fields, a road grid, buildings and a white cross at each truth point.
const fields = valueNoise(11, 180);
const fine = valueNoise(12, 7);
const img = new Uint8Array(W * H);
const marks = truth.map((t) => [t.x - 0.5, t.y - 0.5]);
for (let r = 0; r < H; r++)
  for (let c = 0; c < W; c++) {
    const [lat, lon] = groundAt(c, r);
    const e = toEnu(SITE, lat, lon, 0);
    const x = e[0];
    const y = e[1];
    let v = 70 + 70 * fields(x, y) + 25 * fine(x, y);
    const rx = ((x % 200) + 200) % 200;
    const ry = ((y % 200) + 200) % 200;
    if (rx < 8 || ry < 8) v = 45; // roads every 200 m
    else if (rx > 40 && rx < 70 && ry > 40 && ry < 90) v = 210; // a building per block
    img[r * W + c] = Math.max(0, Math.min(255, Math.round(v)));
  }
for (const [mc, mr] of marks)
  for (let d = -6; d <= 6; d++)
    for (const [c, r] of [
      [Math.round(mc) + d, Math.round(mr)],
      [Math.round(mc), Math.round(mr) + d],
    ])
      if (c >= 0 && r >= 0 && c < W && r < H) img[r * W + c] = 255;

// RPC00B fitted over the footprint and the terrain's height range.
const lats = [];
const lons = [];
for (const [c, r] of [
  [0, 0],
  [W - 1, 0],
  [W - 1, H - 1],
  [0, H - 1],
]) {
  const g = rayTerrain(cam, c, r, terrain, 650);
  lats.push(g[0]);
  lons.push(g[1]);
}
const fit = fitRpc((lat, lon, h) => cam.project(lat, lon, h), { lat: [Math.min(...lats) - 0.001, Math.max(...lats) + 0.001], lon: [Math.min(...lons) - 0.001, Math.max(...lons) + 0.001], h: [550, 800], W, H, errBias: 3, errRand: 0.5 });
if (fit.maxResidualPx > 0.01) throw new Error(`RPC fit residual ${fit.maxResidualPx} px`);
const cornersAt = [
  [0, 0],
  [W - 1, 0],
  [W - 1, H - 1],
  [0, H - 1],
].map(([c, r]) => {
  const g = rayTerrain(cam, c, r, terrain, 650);
  return [g[0], g[1]];
});

mkdirSync(join(out, 'fx01'), { recursive: true });
const ntf = writeNitf(
  { width: W, height: H, bands: 1, type: 'u8', planes: [img] },
  { marking: { level: 'U', system: 'US', control: '' }, title: 'FX-01 synthetic test image (UNCLASSIFIED test values)', iid1: 'FX01', iid2: 'FX01 SYNTHETIC PAN 4096', idatim: '20260315183000', isorce: 'SYNTHETIC SAT', icat: 'VIS', irep: 'MONO', rpc: fit.rec, corners: cornersAt, tres: [['USE00A', use00a({ gsdM: GSD, obliquity: 78, sunEl: 52.5, sunAz: 148.0 })]] },
);
writeFileSync(join(out, 'fx01', 'fx01.ntf'), ntf);
writeFileSync(
  join(out, 'fx01', 'fx01_truth.json'),
  JSON.stringify({ fixture: 'FX-01', note: 'Image coordinates use the app convention (first pixel centre at 0.5, 0.5). Heights are HAE (WGS 84).', size: [W, H], gsd: GSD, rpcFitMaxResidualPx: fit.maxResidualPx, camera: { rangeM: 600000, offNadirDeg: 12, fromAzimuthDeg: 210, rollDeg: 8 }, sun: { elevation: 52.5, azimuth: 148.0, source: 'USE00A' }, security: { FSCLAS: 'U', FSCLSY: 'US', banner: 'UNCLASSIFIED' }, points: truth }, null, 1),
);

// ---- FX-05: the same terrain as a float32 GeoTIFF (HAE) and a DTED Level 2 cell (EGM96) ----
mkdirSync(join(out, 'fx05'), { recursive: true });
const dd = 2e-5; // ≈ 2 m posts
const lat1 = Math.max(...lats) + 0.004;
const lon0 = Math.min(...lons) - 0.004;
const GW = Math.ceil((Math.max(...lons) + 0.004 - lon0) / dd);
const GH = Math.ceil((lat1 - (Math.min(...lats) - 0.004)) / dd);
const dem = new Float32Array(GW * GH);
for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) dem[j * GW + i] = terrain(lat1 - (j + 0.5) * dd, lon0 + (i + 0.5) * dd);
const tif = await writeArrayBuffer(dem, {
  width: GW,
  height: GH,
  BitsPerSample: [32],
  SampleFormat: [3],
  ModelPixelScale: [dd, dd, 0],
  ModelTiepoint: [0, 0, 0, lon0, lat1, 0],
  GeographicTypeGeoKey: 4326,
  GTModelTypeGeoKey: 2,
  GTRasterTypeGeoKey: 1,
  GeogAngularUnitsGeoKey: 9102,
  ImageDescription: 'FX-05 synthetic DEM, heights above the WGS 84 ellipsoid (HAE), metres',
});
writeFileSync(join(out, 'fx05', 'fx05_dem_hae.tif'), Buffer.from(tif));

// DTED Level 2: 1″ posts, 3601 × 3601, cell N34 W117 (south-west corner), EGM96 metres.
const N = 3601;
const sp = (s, n) => String(s).padEnd(n, ' ').slice(0, n);
const uhl = `UHL11170000W0340000N00100010NA  U  ${sp('FX05', 12)}${String(N).padStart(4, '0')}${String(N).padStart(4, '0')}0${sp('', 24)}`;
const dsi = new Array(648).fill(' ');
const put = (o, s) => [...s].forEach((ch, i) => (dsi[o + i] = ch));
put(0, 'DSIU');
put(59, 'DTED2');
put(87, '01A');
put(126, 'PRF89020B');
put(141, 'E96WGS84');
put(185, '340000.0N1170000.0W');
put(273, '00100010');
put(281, '36013601');
put(289, '00');
const acc = new Array(2700).fill(' ');
'ACCNA  NA  NA  NA  '.split('').forEach((ch, i) => (acc[i] = ch));
const recLen = 8 + 2 * N + 4;
const dt = new Uint8Array(3428 + recLen * N);
dt.set(Buffer.from(uhl, 'latin1'), 0);
dt.set(Buffer.from(dsi.join(''), 'latin1'), 80);
dt.set(Buffer.from(acc.join(''), 'latin1'), 728);
const dv = new DataView(dt.buffer);
for (let c = 0; c < N; c++) {
  const o = 3428 + c * recLen;
  dt[o] = 0xaa;
  dt[o + 1] = (c >> 16) & 0xff;
  dt[o + 2] = (c >> 8) & 0xff;
  dt[o + 3] = c & 0xff;
  dv.setUint16(o + 4, c, false);
  dv.setUint16(o + 6, 0, false);
  const lon = -117 + c / 3600;
  for (let p = 0; p < N; p++) {
    const lat = 34 + p / 3600;
    const msl = Math.round(ellipsoidToEgm96(lat, lon, terrain(lat, lon)));
    dv.setUint16(o + 8 + 2 * p, msl < 0 ? 0x8000 | -msl : msl, false);
  }
  let sum = 0;
  for (let k = o; k < o + recLen - 4; k++) sum = (sum + dt[k]) >>> 0;
  dv.setUint32(o + recLen - 4, sum, false);
}
writeFileSync(join(out, 'fx05', 'w117_n34.dt2'), dt);
writeFileSync(join(out, 'fx05', 'fx05_truth.json'), JSON.stringify({ fixture: 'FX-05', terrain: 'analytic (build/fixtures/site.mjs terrain()): 650 m + 0.01·x + ridge 60 m + valley −30 m; flat pad 640 m HAE within 150 m of (−300 m E, +300 m N) from the site', site: { lat: SITE[0], lon: SITE[1] }, pad: { centreEnuM: [-300, 300], radiusM: 150, hae: 640 }, geotiff: { file: 'fx05_dem_hae.tif', vertical: 'HAE', posting: dd, size: [GW, GH], origin: [lon0, lat1] }, dted: { file: 'w117_n34.dt2', vertical: 'EGM96 (rounded to 1 m)', level: 2 } }, null, 1));
console.log(`FX-01: ${W}×${H}, RPC residual ${fit.maxResidualPx.toExponential(2)} px; FX-05: GeoTIFF ${GW}×${GH}, DTED L2 ${N}×${N}`);
