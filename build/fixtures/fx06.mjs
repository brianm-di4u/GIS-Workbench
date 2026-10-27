// FX-06 generator (REQ-FMT-15; Appendix E): a two-date EO pair on one pixel grid (co-registered
// to 0 px), 12 inserted changes and a global radiometric change, with machine-readable truth.
// Dev-only; never shipped. Usage: node build/fixtures/fx06.mjs [outDir]
import { writeArrayBuffer } from 'geotiff';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = process.argv[2] ?? join(root, 'fixtures', 'fx06');
const W = 1024;
const H = 1024;
// Geographic grid near the WV3 site: 0.5 m pixels.
const lon0 = -58.6;
const lat0 = -34.48;
const dlat = 0.5 / 110940;
const dlon = 0.5 / (111320 * Math.cos((lat0 * Math.PI) / 180));

let seed = 0x5eed06;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Base scene: smooth value noise (fields), a road grid and scattered static buildings.
function valueNoise(scale) {
  const gw = Math.ceil(W / scale) + 2;
  const gh = Math.ceil(H / scale) + 2;
  const grid = Float32Array.from({ length: gw * gh }, () => rnd());
  return (x, y) => {
    const gx = x / scale;
    const gy = y / scale;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fx = gx - i;
    const fy = gy - j;
    const s = (t) => t * t * (3 - 2 * t);
    const a = grid[j * gw + i];
    const b = grid[j * gw + i + 1];
    const c = grid[(j + 1) * gw + i];
    const d = grid[(j + 1) * gw + i + 1];
    return a + (b - a) * s(fx) + (c - a) * s(fy) + (a - b - c + d) * s(fx) * s(fy);
  };
}
const n1 = valueNoise(160);
const n2 = valueNoise(40);
const n3 = valueNoise(9);
const base = new Float32Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) base[y * W + x] = 60 + 70 * n1(x, y) + 25 * n2(x, y) + 10 * n3(x, y);
const rect = (img, x0, y0, w, h, v) => {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) img[y * W + x] = v;
};
for (let k = 96; k < W; k += 256) {
  rect(base, 0, k, W, 10, 175);
  rect(base, k, 0, 10, H, 175);
}
for (let k = 0; k < 60; k++) rect(base, Math.floor(rnd() * (W - 40)), Math.floor(rnd() * (H - 40)), 10 + Math.floor(rnd() * 26), 10 + Math.floor(rnd() * 26), 190 + rnd() * 50);

const d1 = base.slice();
const d2 = base.slice();
const changes = [];
const free = (x, y, w, h) => changes.every((c) => x + w + 12 < c.x || c.x + c.w + 12 < x || y + h + 12 < c.y || c.y + c.h + 12 < y);
const place = (w, h) => {
  for (;;) {
    const x = 30 + Math.floor(rnd() * (W - w - 60));
    const y = 30 + Math.floor(rnd() * (H - h - 60));
    if (free(x, y, w, h)) return { x, y };
  }
};
// 5 added, 5 removed, 1 moved (two polygons): 12 change polygons.
for (let k = 0; k < 5; k++) {
  const w = 10 + Math.floor(rnd() * 20);
  const h = 10 + Math.floor(rnd() * 20);
  const p = place(w, h);
  rect(d2, p.x, p.y, w, h, 215 + rnd() * 30);
  changes.push({ id: `C${changes.length + 1}`, kind: 'added', ...p, w, h });
}
for (let k = 0; k < 5; k++) {
  const w = 10 + Math.floor(rnd() * 20);
  const h = 10 + Math.floor(rnd() * 20);
  const p = place(w, h);
  rect(d1, p.x, p.y, w, h, 220 + rnd() * 25);
  changes.push({ id: `C${changes.length + 1}`, kind: 'removed', ...p, w, h });
}
{
  const w = 18;
  const h = 14;
  const a = place(w, h);
  changes.push({ id: `C${changes.length + 1}`, kind: 'moved (from)', ...a, w, h });
  const b = place(w, h);
  changes.push({ id: `C${changes.length + 1}`, kind: 'moved (to)', ...b, w, h });
  rect(d1, a.x, a.y, w, h, 230);
  rect(d2, b.x, b.y, w, h, 230);
}
// Radiometric change on date 2 (gain, offset) and sensor noise on both.
const GAIN = 1.08;
const OFFSET = 9;
const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const img1 = new Uint8Array(W * H);
const img2 = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  img1[i] = u8(d1[i] + 2 * gauss());
  img2[i] = u8(d2[i] * GAIN + OFFSET + 2 * gauss());
}

const meta = (date) => ({
  height: H,
  width: W,
  ModelPixelScale: [dlon, dlat, 0],
  ModelTiepoint: [0, 0, 0, lon0, lat0, 0],
  GeographicTypeGeoKey: 4326,
  GTModelTypeGeoKey: 2,
  GTRasterTypeGeoKey: 1,
  DateTime: date,
  ImageDescription: `FX-06 synthetic two-date pair (GIS Workbench test fixture), ${date}`,
});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'fx06_date1.tif'), Buffer.from(await writeArrayBuffer(img1, meta('2024:05:01 10:30:00'))));
writeFileSync(join(out, 'fx06_date2.tif'), Buffer.from(await writeArrayBuffer(img2, meta('2025:05:01 10:30:00'))));
const ll = (x, y) => [lon0 + x * dlon, lat0 - y * dlat];
writeFileSync(
  join(out, 'fx06_truth.json'),
  JSON.stringify(
    {
      fixture: 'FX-06',
      description: 'Two-date EO pair on one grid; 12 change polygons (5 added, 5 removed, 1 moved = from + to); date 2 = 1.08 · date 1 + 9 plus N(0, 2) noise on both.',
      grid: { width: W, height: H, lon0, lat0, dlon, dlat, epsg: 4326 },
      radiometric: { gain: GAIN, offset: OFFSET, noiseSigma: 2 },
      changes: changes.map((c) => ({ ...c, polygon: [ll(c.x, c.y), ll(c.x + c.w, c.y), ll(c.x + c.w, c.y + c.h), ll(c.x, c.y + c.h)] })),
    },
    null,
    1,
  ),
);
console.log(`FX-06 written to ${out}: ${changes.length} changes`);
