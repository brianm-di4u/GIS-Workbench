// FX-05 DSM variant (Appendix E fixture change for SCN-18, REQ-DEM-14): the FX-05 analytic
// terrain around the flat pad with obstructions on it — a 15 m building (20 × 20 m) inside the
// pad and a group of 8 m trees at its edge — as a float32 GeoTIFF of heights above the ellipsoid
// at 1 m posts. Truth: the pad, the obstruction footprints. Dev-only.
// Usage: node build/fixtures/fx05dsm.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';
import { SITE, terrain } from './site.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(process.argv[2] ?? join(root, 'fixtures'), 'fx05');
const kx = 111320 * Math.cos((SITE[0] * Math.PI) / 180);
const ky = 110940;
const enu = (lat, lon) => [(lon - SITE[1]) * kx, (lat - SITE[0]) * ky];
const pad = { e: -300, n: 300, r: 150 };
const building = { e: pad.e + 60, n: pad.n, half: 10, h: 15 };
const trees = [
  [pad.e - 110, pad.n + 70],
  [pad.e - 118, pad.n + 82],
  [pad.e - 100, pad.n + 88],
  [pad.e - 126, pad.n + 64],
].map(([e, n]) => ({ e, n, r: 4, h: 8 }));

function dsm(lat, lon) {
  const [e, n] = enu(lat, lon);
  let h = terrain(lat, lon);
  if (Math.abs(e - building.e) <= building.half && Math.abs(n - building.n) <= building.half) h += building.h;
  for (const t of trees) {
    const d = Math.hypot(e - t.e, n - t.n);
    if (d < t.r) h += t.h * (1 - (d / t.r) ** 2) ** 0.5;
  }
  return h;
}

const post = 1 / ky; // ≈ 1 m in latitude
const dlon = 1 / kx; // ≈ 1 m in longitude
const lat1 = SITE[0] + 700 / ky;
const lon0 = SITE[1] - 900 / kx;
const W = 1200;
const H = 1200;
const z = new Float32Array(W * H);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) z[j * W + i] = dsm(lat1 - (j + 0.5) * post, lon0 + (i + 0.5) * dlon);
mkdirSync(out, { recursive: true });
const tif = await writeArrayBuffer(z, { width: W, height: H, BitsPerSample: [32], SampleFormat: [3], ModelPixelScale: [dlon, post, 0], ModelTiepoint: [0, 0, 0, lon0, lat1, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeogAngularUnitsGeoKey: 9102, ImageDescription: 'FX-05 DSM: analytic terrain with a building and trees, HAE metres, 1 m posts' });
writeFileSync(join(out, 'fx05_dsm_hae.tif'), Buffer.from(tif));
const ll = (e, n) => ({ lat: SITE[0] + n / ky, lon: SITE[1] + e / kx });
writeFileSync(join(out, 'fx05_dsm_truth.json'), JSON.stringify({ fixture: 'FX-05 DSM', vertical: 'HAE', postM: 1, pad: { ...pad, centre: ll(pad.e, pad.n), hae: 640 }, building: { ...building, centre: ll(building.e, building.n) }, trees: trees.map((t) => ({ ...t, centre: ll(t.e, t.n) })), site: { lat: SITE[0], lon: SITE[1] } }, null, 1));
console.log(`FX-05 DSM: ${W}×${H} posts`);
