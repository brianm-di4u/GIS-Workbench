// GIS Workbench 2.0 local AI (2.0 plan P5): REQ-LAI-01 runtime and packs, REQ-LAI-02 SAM 2.1 with
// the orthogonal regularizer, REQ-LAI-03 OWLv2 detection into the review queue, REQ-LAI-05 DISK +
// LightGlue Auto Align, REQ-LAI-06 CLIP search, REQ-LAI-09 copilot routing, REQ-LAI-07 Auto
// Contrast. The models run on the CPU (WASM) here; the device used is recorded with each result.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openApp, openFiles, SAMPLES } from './helpers.js';

test.describe.configure({ timeout: 900000 });

const DIST = resolve('dist/packs');
const pk = (n) => resolve(DIST, readdirSync(DIST).find((f) => (n === 'ai' ? /^ai-\d/.test(f) : f.startsWith(`${n}-`))));
const VEGAS = join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_PS-RGB_img10.tif');
const VEGAS_TRUTH = join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_geojson_buildings_img10.geojson');
const LIBYA = resolve('..', 'TE-corpus', 'eo-maxar-libya-floods-wv3-prepost');
const PRE = join(LIBYA, '2023-08-01', '1040010087AB7E00-visual.tif');
const POST = join(LIBYA, '2023-09-15', '104001008B282A00-visual.tif');
const QUIET = { prefs: { welcomeDone: true } };

async function withImage(page, packs, image) {
  const { frame, logs } = await openApp(page, 'file', QUIET);
  await openFiles(frame, packs.map(pk));
  await frame.waitForFunction((n) => n.every((x) => window.gisworkbench.packs.loaded.has(x)), packs, { timeout: 120000 });
  if (image) {
    await openFiles(frame, Array.isArray(image) ? image : [image]);
    await frame.waitForFunction((k) => [...window.gisworkbench.layers.values()].filter((l) => l.stats && l.lutTex).length >= k, Array.isArray(image) ? image.length : 1, { timeout: 120000 });
  }
  return { frame, logs };
}

test('REQ-LAI-01 REQ-LAI-02 SAM 2.1 outlines Vegas buildings on this device; Square Corners gives right angles', async ({ page }) => {
  const truth = JSON.parse(readFileSync(VEGAS_TRUTH, 'utf8')).features.filter((f) => f.geometry?.type === 'Polygon');
  const { frame } = await withImage(page, ['ai', 'ai-sam2'], VEGAS);
  const r = await frame.evaluate(async (polys) => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    // The six largest truth buildings, in image pixels; a click at each centroid with Square Corners.
    const rings = polys.map((p) => p.coordinates[0].map(([lon, lat]) => l.imageAt(lat, lon)).map((q) => [q.x, q.y]));
    const area = (r) => Math.abs(r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0) / 2);
    const inside = (poly, x, y) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (poly[i][1] > y !== poly[j][1] > y && x < ((poly[j][0] - poly[i][0]) * (y - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
      return c;
    };
    const iouOf = (a, b) => {
      const xs = [...a, ...b].map((p) => p[0]);
      const ys = [...a, ...b].map((p) => p[1]);
      let inter = 0;
      let uni = 0;
      for (let y = Math.floor(Math.min(...ys)); y < Math.max(...ys); y++)
        for (let x = Math.floor(Math.min(...xs)); x < Math.max(...xs); x++) {
          const p = inside(a, x + 0.5, y + 0.5);
          const q = inside(b, x + 0.5, y + 0.5);
          if (p && q) inter++;
          if (p || q) uni++;
        }
      return inter / uni;
    };
    const cosMax = (poly) =>
      Math.max(
        ...poly.map((p, i) => {
          const q = poly[(i + 1) % poly.length];
          const w = poly[(i + 2) % poly.length];
          const d1 = [q[0] - p[0], q[1] - p[1]];
          const d2 = [w[0] - q[0], w[1] - q[1]];
          return Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) / (Math.hypot(...d1) * Math.hypot(...d2));
        }),
      );
    const ious = [];
    const clicks = [];
    let maxCos = 0;
    let first = null;
    for (const ring of rings.sort((a, b) => area(b) - area(a)).slice(0, 6)) {
      const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
      const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
      const t0 = performance.now();
      const s = await app.sam.select(l, cx, cy, { square: true });
      clicks.push({ ms: performance.now() - t0, enc: s.encoderMs });
      first ??= s;
      ious.push(iouOf(s.polygon, ring));
      if (s.polygon.length >= 4) maxCos = Math.max(maxCos, cosMax(s.polygon));
    }
    const g = app.store.all('graphic').find((x) => x.provenance?.kind === 'ai-sam');
    const sorted = [...ious].sort((a, b) => a - b);
    return { ious, median: (sorted[2] + sorted[3]) / 2, maxCos, model: first.model, device: first.device, clicks, prov: g?.provenance.model };
  }, truth.map((f) => f.geometry));
  console.log(`SAM 2.1 on ${r.device}: clicks ${r.clicks.map((c) => Math.round(c.ms)).join(', ')} ms; IoU ${r.ious.map((x) => x.toFixed(2)).join(', ')} (median ${r.median.toFixed(2)})`);
  expect(r.model).toBe('sam2');
  expect(r.prov).toMatch(/SAM 2\.1 hiera-tiny.*corners squared/);
  expect(r.median).toBeGreaterThan(0.6);
  expect(r.maxCos).toBeLessThan(1e-6);
  // The window is encoded once; every later click runs the decoder only (REQ-LAI-02: about 0.65 s
  // each on this machine when idle; the bound allows for the rest of the suite running beside it).
  expect(r.clicks.slice(1).every((c) => c.enc === 0)).toBe(true);
  expect([...r.clicks.slice(1)].map((c) => c.ms).sort((x, y) => x - y)[2]).toBeLessThan(2000);
});

test('REQ-LAI-03 Find objects (OWLv2) puts buildings and cars in the detections review queue', async ({ page }) => {
  const { frame } = await withImage(page, ['ai', 'ai-detect'], VEGAS);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const out = await app.aiLocal.find(['building', 'car'], { region: { x0: 0, y0: 0, w: l.width, h: l.height }, threshold: 0.12 });
    const dets = app.store.all('detection');
    return { counts: out.counts, device: out.device, tiles: out.tiles, n: dets.length, src: dets[0]?.source, status: dets[0]?.status, ring: dets[0]?.ring?.length, anchor: dets[0]?.anchor };
  });
  console.log(`OWLv2 on ${r.device}: ${JSON.stringify(r.counts)} in ${r.tiles} tile(s)`);
  expect(r.counts.building).toBeGreaterThanOrEqual(3);
  expect(r.n).toBe(r.counts.building + r.counts.car);
  expect(r.src).toBe('Find objects (AI): building, car');
  expect(r.status).toBe('pending');
  expect(r.anchor).toBe('image');
  expect(r.ring).toBe(4);
  // J steps through them (patrol over ring detections).
  const t = await frame.evaluate(() => window.gisworkbench.patrol.next());
  expect(t.kind).toBe('detection');
});

test('REQ-LAI-06 Search imagery (CLIP) ranks chips, outlines the best and centres the view', async ({ page }) => {
  const { frame } = await withImage(page, ['ai', 'ai-search'], VEGAS);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const a = await app.aiLocal.search('houses and streets', { chip: 128, k: 5 });
    const b = await app.aiLocal.search('open ocean', { chip: 128, k: 5, commit: false });
    const p = app.activePane();
    const best = a.hits[0];
    return { chips: a.chips, hits: a.hits.map((h) => h.score), ocean: b.hits[0].score, graphics: app.store.all('graphic').filter((g) => g.tag === 'aisearch').length, centred: Math.abs(p.view.cx - (best.x0 + best.size / 2)) < 1 && Math.abs(p.view.cy - (best.y0 + best.size / 2)) < 1, device: a.device, w: l.width };
  });
  console.log(`CLIP on ${r.device}: ${r.chips} chips, best ${r.hits[0]} (ocean ${r.ocean})`);
  expect(r.chips).toBeGreaterThanOrEqual(16);
  expect(r.hits).toHaveLength(5);
  expect([...r.hits].sort((x, y) => y - x)).toEqual(r.hits);
  expect(r.hits[0]).toBeGreaterThan(r.ocean);
  expect(r.graphics).toBe(5);
  expect(r.centred).toBe(true);
});

test('REQ-LAI-05 Auto Align (AI) registers the Libya post-flood image to the pre-flood one within 1 px RMS', async ({ page }) => {
  test.skip(!existsSync(PRE) || !existsSync(POST), 'the Libya pair is in the TE corpus only');
  const { frame } = await withImage(page, ['ai', 'ai-match'], [PRE, POST]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const t0 = performance.now();
    const a = await app.autoAlignAI({ size: 640, fine: 2, fineSize: 512 });
    return { used: a.used, rejected: a.rejected, rms: a.rms, ms: performance.now() - t0, method: app.activeLayer().rec.registration?.method ?? '' };
  });
  console.log(`LightGlue: ${r.used} tie points (${r.rejected} rejected), RMS ${r.rms.toFixed(3)} px in ${Math.round(r.ms / 1000)} s`);
  expect(r.used).toBeGreaterThanOrEqual(20);
  expect(r.rms).toBeLessThan(1);
});

test('REQ-LAI-09 REQ-LAI-07 the Copilot runs requests on local tools without a connection; Auto Contrast sets CLAHE and gamma', async ({ page }) => {
  const { frame } = await openApp(page, 'file', QUIET);
  await openFiles(frame, [VEGAS]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.stats && l.lutTex), null, { timeout: 60000 });
  await frame.evaluate(() => window.gisworkbench.commands.run('ai.assistant'));
  const input = frame.locator('.ai-input');
  await input.fill('auto contrast');
  await frame.locator('.ai-page button.btn-primary', { hasText: 'Send' }).click();
  await expect(frame.locator('.ai-transcript')).toContainText('Auto Contrast: local contrast (CLAHE');
  const c = await frame.evaluate(() => window.gisworkbench.activeLayer().chain);
  expect(c.clahe.on).toBe(true);
  expect(c.stretch).toBe('dra');
  expect(Math.abs(c.tone.gamma)).toBeLessThanOrEqual(60);
  await input.fill('what sensor took this image?');
  await frame.locator('.ai-page button.btn-primary', { hasText: 'Send' }).click();
  await expect(frame.locator('.ai-transcript')).toContainText('On this device I can');
  // A find request without the detection pack says what is missing.
  await input.fill('detect aircraft in view');
  await frame.locator('.ai-page button.btn-primary', { hasText: 'Send' }).click();
  await expect(frame.locator('.ai-transcript')).toContainText(/Could not do that here: .*(ai pack|OWLv2|data pack)/);
});
