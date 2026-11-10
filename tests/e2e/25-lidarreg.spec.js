// 2.5 group lidarreg (REQ-GAP-46) in the app: Register Image to LiDAR on a synthetic site whose
// truth is known. A LAS 1.2 cloud (UTM 11N GeoKeys, ground class, intensity texture, terrain) and
// a GeoTIFF ortho of the same ground whose geotransform is 7 m east and 4 m south of the truth; the
// cloud's heights are 0.4 m low against six surveyed points. The run must find the image error
// from the cloud, the cloud's vertical datum shift from the survey, and report held-out checkpoints
// before and after; Apply must give the layer a model that puts the true ground on the true pixel.
// The dialog and the report pass axe.
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { openApp, openFiles } from './helpers.js';
import { writeGeoTiff } from '../../app/src/formats/geotiff-writer.js';

const E0 = 560000;
const N0 = 3818000;
const SIZE = 200; // cloud side (m)
const OFF = { e: 7, n: -4 }; // the image's georeferencing error (m)
const LOW = 0.4; // the cloud is this much too low (m)

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = rng(46);
const BLOBS = Array.from({ length: 4000 }, () => ({ x: E0 - 80 + (SIZE + 160) * r(), y: N0 - 80 + (SIZE + 160) * r(), s: 0.8 + 3 * r(), a: r() < 0.5 ? -1 : 1 }));
// Blobs by 10 m bucket (a blob reaches 4σ ≤ 15.2 m: two buckets around).
const BUCKET = new Map();
for (const b of BLOBS) {
  const k = Math.floor(b.x / 10) * 100000 + Math.floor(b.y / 10);
  if (!BUCKET.has(k)) BUCKET.set(k, []);
  BUCKET.get(k).push(b);
}
/** Texture (patches of several sizes) at UTM (e, n). */
function texture(e, n) {
  let v = 0;
  const ci = Math.floor(e / 10);
  const cj = Math.floor(n / 10);
  for (let dj = -2; dj <= 2; dj++)
    for (let di = -2; di <= 2; di++)
      for (const b of BUCKET.get((ci + di) * 100000 + cj + dj) ?? []) {
        const dx = e - b.x;
        const dy = n - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 16 * b.s * b.s) v += b.a * Math.exp(-d2 / (2 * b.s * b.s));
      }
  return v;
}
/** Terrain (orthometric metres as written in the LAS). */
const terrain = (e, n) => 1500 + 12 * Math.sin((e - E0) / 41) * Math.cos((n - N0) / 57) + 6 * Math.sin((e - E0 + 2 * (n - N0)) / 23);
/** Lambertian shading of the terrain under a sun at azimuth 150°, elevation 45°. */
function shade(e, n) {
  const gx = (terrain(e + 0.5, n) - terrain(e - 0.5, n)) / 1;
  const gy = (terrain(e, n + 0.5) - terrain(e, n - 0.5)) / 1;
  const az = (150 * Math.PI) / 180;
  const el = Math.PI / 4;
  const sun = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
  const nn = Math.hypot(gx, gy, 1);
  return Math.max(0, (-gx * sun[0] - gy * sun[1] + sun[2]) / nn);
}

/** LAS 1.2, point format 1, GeoKeys for EPSG:32611, every point ground (class 2). */
function lasFile() {
  const step = 0.5;
  const n1 = Math.round(SIZE / step) + 1;
  const pts = [];
  for (let j = 0; j < n1; j++)
    for (let i = 0; i < n1; i++) {
      const e = E0 + i * step + 0.13 * Math.sin(j);
      const n = N0 + j * step + 0.11 * Math.cos(i);
      pts.push([e, n, terrain(e, n) - LOW, Math.max(0, Math.min(65535, Math.round(1000 + 300 * texture(e, n))))]);
    }
  const keys = [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32611, 3076, 0, 1, 9001];
  const vlrLen = 54 + keys.length * 2;
  const offset = 227 + vlrLen;
  const buf = new ArrayBuffer(offset + pts.length * 28);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const str = (o, s, len) => {
    for (let k = 0; k < len; k++) u8[o + k] = k < s.length ? s.charCodeAt(k) : 0;
  };
  str(0, 'LASF', 4);
  u8[24] = 1;
  u8[25] = 2;
  str(26, 'GIS Workbench e2e', 32);
  str(58, '25-lidarreg.spec.js', 32);
  dv.setUint16(90, 1, true);
  dv.setUint16(92, 2026, true);
  dv.setUint16(94, 227, true);
  dv.setUint32(96, offset, true);
  dv.setUint32(100, 1, true);
  u8[104] = 1;
  dv.setUint16(105, 28, true);
  dv.setUint32(107, pts.length, true);
  dv.setUint32(111, pts.length, true);
  const scale = [0.001, 0.001, 0.001];
  const off = [E0, N0, 1000];
  scale.forEach((v, k) => dv.setFloat64(131 + 8 * k, v, true));
  off.forEach((v, k) => dv.setFloat64(155 + 8 * k, v, true));
  const mn = [0, 1, 2].map((k) => pts.reduce((m, p) => Math.min(m, p[k]), Infinity));
  const mx = [0, 1, 2].map((k) => pts.reduce((m, p) => Math.max(m, p[k]), -Infinity));
  [mx[0], mn[0], mx[1], mn[1], mx[2], mn[2]].forEach((v, k) => dv.setFloat64(179 + 8 * k, v, true));
  str(229, 'LASF_Projection', 16);
  dv.setUint16(245, 34735, true);
  dv.setUint16(247, keys.length * 2, true);
  str(249, 'GeoKeyDirectoryTag', 32);
  keys.forEach((v, k) => dv.setUint16(281 + 2 * k, v, true));
  pts.forEach((p, k) => {
    const o = offset + 28 * k;
    for (let a = 0; a < 3; a++) dv.setInt32(o + 4 * a, Math.round((p[a] - off[a]) / scale[a]), true);
    dv.setUint16(o + 12, p[3], true);
    u8[o + 14] = 0x09; // return 1 of 1
    u8[o + 15] = 2;
    dv.setFloat64(o + 20, k * 1e-4, true);
  });
  return { bytes: u8, minZ: mn[2] };
}

/** The ortho: 0.5 m pixels over the cloud plus 40 m; its geotransform is OFF away from the truth. */
async function orthoFile() {
  const px = 0.5;
  const w = Math.round((SIZE + 80) / px);
  const x0 = E0 - 40;
  const y0 = N0 + SIZE + 40;
  const data = new Uint8Array(w * w);
  for (let j = 0; j < w; j++)
    for (let i = 0; i < w; i++) {
      // The pixel the geotransform puts at (e, n) shows the ground at (e − OFF.e, n − OFF.n).
      const e = x0 + (i + 0.5) * px - OFF.e;
      const n = y0 - (j + 0.5) * px - OFF.n;
      data[j * w + i] = Math.max(0, Math.min(255, Math.round(70 + 60 * texture(e, n) + 90 * shade(e, n))));
    }
  return { bytes: await writeGeoTiff({ width: w, height: w, bands: 1, type: 'u8', data }, { epsg: 32611, geotransform: [x0, px, 0, y0, 0, -px], overviews: true }), x0, y0, px };
}

test('REQ-GAP-46 an ortho registered to a point cloud: image error, cloud datum shift, held-out checkpoints, Apply; dialog and report pass axe', async ({ page }) => {
  test.setTimeout(300000);
  const dir = mkdtempSync(join(tmpdir(), 'gw25-lidarreg-'));
  try {
    const las = lasFile();
    const tif = await orthoFile();
    writeFileSync(join(dir, 'site.las'), las.bytes);
    writeFileSync(join(dir, 'ortho.tif'), tif.bytes);
    const { frame, logs } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
    await openFiles(frame, [join(dir, 'ortho.tif')]);
    await openFiles(frame, [join(dir, 'site.las')]);
    await frame.waitForFunction(() => [...(window.gisworkbench.pointClouds?.values() ?? [])].length > 0 && [...window.gisworkbench.layers.values()].some((l) => l.modelId), null, { timeout: 120000 });
    // Six surveyed points: the truth is the terrain, in the app's vertical (its offset from the
    // file's heights is read from the cloud's lowest point).
    const rs = rng(7);
    const spots = Array.from({ length: 6 }, (_, k) => ({ id: `S${k + 1}`, e: E0 + 25 + 150 * rs(), n: N0 + 25 + 150 * rs(), check: k >= 4 }));
    const out = await frame.evaluate(
      async ({ spots, minZ, LOW, OFF, tif }) => {
        const app = window.gisworkbench;
        const c = [...app.pointClouds.values()][0];
        let zmin = Infinity;
        for (let k = 2; k < c.pos.length; k += 3) zmin = Math.min(zmin, c.pos[k]);
        const dz = zmin - minZ; // app height − file height
        const l = [...app.layers.values()].find((x) => x.modelId && x.kind !== 'dem');
        // UTM 11N → lat/lon through the app's own projection (the image model is the CRS).
        const toGeo = (e, n) => l.groundAt((e - tif.x0) / tif.px, (tif.y0 - n) / tif.px, 0);
        const survey = spots.map((s) => {
          const g = toGeo(s.e, s.n);
          return { id: s.id, lat: g.lat, lon: g.lon, h: s.zTrue + dz, check: s.check, sigma: 0.02 };
        });
        // The true ground shown by a few pixels (lat/lon taken now, through the unadjusted model).
        const probes = [[100, 100], [300, 250], [450, 420]].map(([i, j]) => ({ i, j, g: toGeo(tif.x0 + (i + 0.5) * tif.px - OFF.e, tif.y0 - (j + 0.5) * tif.px - OFF.n) }));
        const refused = await app.lidarreg.run({ layer: l.id, cloud: c, reference: 'sideways' }).then(() => null, (e) => e.code);
        const rep = await app.lidarreg.run({ layer: l.id, cloud: c, reference: 'both', cell: 0.5, tile: 32, maxOffset: 20, datum: 3, datumSigma: [0.05, 0.05, 1], survey, holdOut: 4 });
        const label = app.lidarreg.apply(rep);
        await new Promise((res) => setTimeout(res, 200));
        // Through the applied model the true ground lands on its pixel centre.
        const worst = probes.map(({ i, j, g }) => {
          const p = l.imageAt(g.lat, g.lon, 1500);
          return Math.hypot(p.x - (i + 0.5), p.y - (j + 0.5));
        });
        return { refused, rep, label, model: l.modelName, worst: Math.max(...worst) };
      },
      { spots: spots.map((s) => ({ ...s, zTrue: terrain(s.e, s.n) })), minZ: las.minZ, LOW, OFF, tif: { x0: tif.x0, y0: tif.y0, px: tif.px } },
    );
    const rep = out.rep;
    console.log(JSON.stringify({ registration: rep.registration, correction: rep.solution.correctionPx, metres: rep.solution.correctionM, datum: rep.datum.values, sigma: rep.datum.sigma, before: rep.heldOut.before.rmseR, after: rep.heldOut.after.rmseR, survey: rep.surveyChecks, gpm: rep.gpm, seconds: rep.seconds }));
    expect(out.refused).toBe('E_LREG_REF');
    // Matches from at least one reference, with held-out checkpoints.
    expect(rep.registration.some((x) => !x.error && x.inliers >= 20)).toBe(true);
    expect(rep.counts.heldOut).toBeGreaterThanOrEqual(5);
    // The image error: 7 m east, 4 m south = +14 px in x, +8 px in y at 0.5 m.
    expect(Math.abs(rep.solution.correctionPx.dx - 14)).toBeLessThan(0.5);
    expect(Math.abs(rep.solution.correctionPx.dy - 8)).toBeLessThan(0.5);
    expect(rep.heldOut.before.rmseR).toBeGreaterThan(6);
    // After: the noise of single 16 m tile matches between the intensity and the shaded image (about 0.6 m),
    // not the error of the correction (σ about 0.07 m).
    expect(rep.heldOut.after.rmseR).toBeLessThan(0.8);
    expect(rep.heldOut.after.rmseR).toBeLessThan(rep.heldOut.before.rmseR / 8);
    expect(Math.hypot(rep.solution.correctionPx.sx, rep.solution.correctionPx.sy)).toBeLessThan(0.5);
    // The cloud's vertical datum shift from the four control points; the two checkpoints agree.
    expect(Math.abs(rep.datum.values[2] - LOW)).toBeLessThan(0.05);
    expect(rep.surveyChecks.before.rmse[2]).toBeGreaterThan(0.3);
    // The checks keep the surface interpolation error of 0.5 m posts on this terrain (a few cm).
    expect(rep.surveyChecks.after.rmse[2]).toBeLessThan(0.1);
    expect(rep.gpm.ce90.every(Number.isFinite)).toBe(true);
    // Apply: a triangulated model that puts the true ground on its pixel.
    expect(out.label).toMatch(/^SOL-/);
    expect(out.model).toMatch(/triangulated/);
    expect(out.worst).toBeLessThan(0.6);
    // The dialog and the report pass axe.
    const axe = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
    await frame.evaluate(axe);
    const tags = { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } };
    void frame.evaluate(() => window.gisworkbench.commands.run('pc.registerimage'));
    const dlg = frame.locator('[data-id="dialog:lidar-register"]');
    await expect(dlg).toBeVisible();
    expect(await frame.evaluate(async (o) => (await window.axe.run(document.querySelector('[data-id="dialog:lidar-register"]'), o)).violations.map((x) => x.id), tags)).toEqual([]);
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    void frame.evaluate(() => window.gisworkbench.lidarreg.showReport(window.gisworkbench.lidarreg.last));
    const rd = frame.locator('[data-id="dialog:lidar-register-report"]');
    await expect(rd).toBeVisible();
    await expect(rd.locator('[data-id="lreg:after"]')).toContainText('Held-out checkpoints after');
    expect(await frame.evaluate(async (o) => (await window.axe.run(document.querySelector('[data-id="dialog:lidar-register-report"]'), o)).violations.map((x) => x.id), tags)).toEqual([]);
    await rd.locator('button.btn', { hasText: 'Close' }).click();
    expect(logs).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
