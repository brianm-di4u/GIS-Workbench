// FX-04 generator (Research/03 §1.1, Research/06 §4, SCN-06/07/09): a block of four overlapping
// 2048 × 2048 NITF 2.1 images at 0.5 m GSD over the FX-05 terrain, seen from four directions,
// with RPC00B fitted to each camera and then biased by a known image-space shift (so the
// 3-D checkpoint RMSE before adjustment is well over 10 m). Six GCPs and three checkpoints are painted
// as crosses; a GCP file lists them with σ. Truth: the unbiased RPC00B records, the biases and
// every control point's true image position in each image. Dev-only.
// Usage: node build/fixtures/fx04.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { camera, rayTerrain, fitRpc, fromEnu, toEnu, valueNoise } from './synth.mjs';
import { SITE, terrain } from './site.mjs';
import { writeNitf, use00a } from '../../app/src/formats/nitf-writer.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(process.argv[2] ?? join(root, 'fixtures'), 'fx04');
const W = 2048;
const H = 2048;
const GSD = 0.5;
const SUN = { azimuth: 150, elevation: 55 };
const at = (e, n) => {
  const g = fromEnu([SITE[0], SITE[1], 0], e, n, 0);
  return [g[0], g[1], terrain(g[0], g[1])];
};

// Four looks; footprints centred ±250 m from the site so all four overlap in the middle.
// bias: [line, sample] pixels added to the true RPC (LINE_OFF / SAMP_OFF).
const IMAGES = [
  { id: 'IMG1', centre: [-250, 250], offNadir: 10, fromAz: 45, roll: 3, bias: [52, -30], idatim: '20260502170000' },
  { id: 'IMG2', centre: [250, 250], offNadir: 21, fromAz: 160, roll: -4, bias: [-40, 64], idatim: '20260502170030' },
  { id: 'IMG3', centre: [-250, -250], offNadir: 16, fromAz: 250, roll: 6, bias: [72, 35], idatim: '20260519165500' },
  { id: 'IMG4', centre: [250, -250], offNadir: 25, fromAz: 330, roll: -2, bias: [-60, -48], idatim: '20260519165530' },
];

// Control: 6 GCPs around the block, 3 checkpoints inside the four-way overlap. σ in metres.
const CONTROL = [
  { id: 'GCP1', kind: 'gcp', en: [-600, 560] },
  { id: 'GCP2', kind: 'gcp', en: [580, 590] },
  { id: 'GCP3', kind: 'gcp', en: [-620, -540] },
  { id: 'GCP4', kind: 'gcp', en: [600, -600] },
  { id: 'GCP5', kind: 'gcp', en: [-20, 620] },
  { id: 'GCP6', kind: 'gcp', en: [30, -630] },
  { id: 'CHK1', kind: 'checkpoint', en: [-110, 90] },
  { id: 'CHK2', kind: 'checkpoint', en: [130, 60] },
  { id: 'CHK3', kind: 'checkpoint', en: [10, -140] },
].map((p) => {
  const g = at(...p.en);
  return { ...p, lat: g[0], lon: g[1], hae: g[2], sigmaH: 0.1, sigmaV: 0.2 };
});

// Texture pinned to the ground (ENU from the site): fields, grain, a road grid, painted roofs,
// and white crosses (8 m arms, 1 m wide) on the control points.
const fields = valueNoise(41, 160);
const mid = valueNoise(42, 11);
const grain = valueNoise(43, 1.9);
function albedo(x, y) {
  let v = 70 + 70 * fields(x, y) + 30 * mid(x, y) + 24 * grain(x, y);
  const rx = ((x % 200) + 200) % 200;
  const ry = ((y % 200) + 200) % 200;
  if (rx < 7 || ry < 7) v = 48 + 8 * grain(x, y);
  else if (rx > 40 && rx < 72 && ry > 40 && ry < 88) v = 200 + 20 * grain(x, y);
  for (const p of CONTROL) {
    const dx = Math.abs(x - p.en[0]);
    const dy = Math.abs(y - p.en[1]);
    if ((dx <= 0.5 && dy <= 8) || (dy <= 0.5 && dx <= 8)) return 250;
    if (dx <= 9 && dy <= 9) v = 30; // a dark backing square for contrast
  }
  return v;
}

mkdirSync(out, { recursive: true });
const truth = { fixture: 'FX-04', note: 'Terrain = FX-05 (build/fixtures/site.mjs). Heights HAE (WGS 84). Image coordinates use the app convention (first pixel centre at 0.5, 0.5). The NITF RPC00B records carry the biased models; truth.images[].rpcTrue is the unbiased record.', site: { lat: SITE[0], lon: SITE[1] }, size: [W, H], gsd: GSD, sun: SUN, control: CONTROL, images: [] };
const STEP = 8;
for (const I of IMAGES) {
  const target = at(...I.centre);
  const cam = camera({ target, range: 600000, offNadir: I.offNadir, fromAz: I.fromAz, gsd: GSD, W, H, roll: I.roll });
  // Ground under a coarse pixel grid (exact ray casting), bilinear in between.
  const gw = W / STEP + 1;
  const gh = H / STEP + 1;
  const grid = new Float64Array(gw * gh * 2);
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const g = rayTerrain(cam, i * STEP, j * STEP, terrain, 650);
      const e = toEnu(SITE, g[0], g[1], 0);
      grid[(j * gw + i) * 2] = e[0];
      grid[(j * gw + i) * 2 + 1] = e[1];
    }
  const img = new Uint8Array(W * H);
  for (let r = 0; r < H; r++)
    for (let c = 0; c < W; c++) {
      let acc = 0;
      for (const [dx, dy] of [
        [-0.25, -0.25],
        [0.25, -0.25],
        [-0.25, 0.25],
        [0.25, 0.25],
      ]) {
        const gx = Math.max(0, Math.min(gw - 1.0001, (c + dx) / STEP));
        const gy = Math.max(0, Math.min(gh - 1.0001, (r + dy) / STEP));
        const i = Math.floor(gx);
        const j = Math.floor(gy);
        const fx = gx - i;
        const fy = gy - j;
        const o = (a, b, k) => grid[(b * gw + a) * 2 + k];
        const v = (k) => o(i, j, k) * (1 - fx) * (1 - fy) + o(i + 1, j, k) * fx * (1 - fy) + o(i, j + 1, k) * (1 - fx) * fy + o(i + 1, j + 1, k) * fx * fy;
        acc += albedo(v(0), v(1));
      }
      img[r * W + c] = Math.max(0, Math.min(255, Math.round(acc / 4)));
    }
  const corners = [
    [0, 0],
    [W - 1, 0],
    [W - 1, H - 1],
    [0, H - 1],
  ].map(([c, r]) => rayTerrain(cam, c, r, terrain, 650));
  const lats = corners.map((g) => g[0]);
  const lons = corners.map((g) => g[1]);
  const fit = fitRpc((lat, lon, h) => cam.project(lat, lon, h), { lat: [Math.min(...lats) - 0.001, Math.max(...lats) + 0.001], lon: [Math.min(...lons) - 0.001, Math.max(...lons) + 0.001], h: [560, 780], W, H, errBias: 35, errRand: 0.5 });
  if (fit.maxResidualPx > 0.01) throw new Error(`RPC fit residual ${fit.maxResidualPx} px`);
  const biased = fit.rec.slice();
  biased[2] += I.bias[0]; // LINE_OFF
  biased[3] += I.bias[1]; // SAMP_OFF
  const obs = CONTROL.map((p) => {
    const [c, r] = cam.project(p.lat, p.lon, p.hae);
    return { id: p.id, x: c + 0.5, y: r + 0.5, inside: c >= 0 && r >= 0 && c <= W - 1 && r <= H - 1 };
  }).filter((o) => o.inside);
  writeFileSync(
    join(out, `fx04_${I.id.toLowerCase()}.ntf`),
    writeNitf({ width: W, height: H, bands: 1, type: 'u8', planes: [img] }, { marking: { level: 'U', system: 'US' }, title: `FX-04 synthetic block image ${I.id} (UNCLASSIFIED test values)`, iid1: I.id, iid2: `FX04 SYNTHETIC BLOCK ${I.id}`, idatim: I.idatim, isorce: 'SYNTHETIC SAT', icat: 'VIS', irep: 'MONO', rpc: biased, corners: corners.map((g) => [g[0], g[1]]), tres: [['USE00A', use00a({ gsdM: GSD, obliquity: 90 - I.offNadir, sunEl: SUN.elevation, sunAz: SUN.azimuth })]] }),
  );
  truth.images.push({ id: I.id, file: `fx04_${I.id.toLowerCase()}.ntf`, offNadirDeg: I.offNadir, sensorAzimuthDeg: I.fromAz, biasPx: { line: I.bias[0], sample: I.bias[1] }, rpcTrue: fit.rec, rpcFitMaxResidualPx: fit.maxResidualPx, sensorEcef: cam.C, control: obs });
  console.log(`FX-04 ${I.id}: ${obs.length} control points inside, RPC residual ${fit.maxResidualPx.toExponential(2)} px`);
}
writeFileSync(join(out, 'fx04_truth.json'), JSON.stringify(truth, null, 1));
// The GCP file the analyst loads (SCN-06): ID, lat, lon, HAE, σH, σV, role.
writeFileSync(join(out, 'fx04_control.csv'), ['id,lat,lon,hae,sigma_h,sigma_v,role', ...CONTROL.map((p) => [p.id, p.lat.toFixed(9), p.lon.toFixed(9), p.hae.toFixed(3), p.sigmaH, p.sigmaV, p.kind].join(','))].join('\n') + '\n');
