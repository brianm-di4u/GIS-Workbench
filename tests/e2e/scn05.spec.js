// SCN-05 (stereo pair set-up and 3-D measurement) on FX-02: pair metrics against the truth
// (AT-05.2), y-parallax after on-the-fly epipolar resampling at 20 checkpoints (AT-05.1), the
// floating cursor's parallax gain and Z steps (REQ-STR-08), snap to ground and box heights within
// 1 m with LE90 shown (AT-05.4, REQ-STR-09, REQ-MEN-12), the anaglyph composite (REQ-STR-04) and
// Stereo Align (REQ-SNS-10).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx02');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx02_truth.json'), 'utf8'));

test('SCN-05 REQ-STR-01 REQ-STR-03 REQ-STR-04 REQ-STR-08 REQ-STR-09 REQ-MEN-12 REQ-SNS-10 FX-02 stereo set-up and 3-D measurement', async ({ page }) => {
  test.setTimeout(240000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, truth.images.map((i) => resolve(DIR, i.file)));
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 2, null, { timeout: 60000 });
  const r = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].sort((a, b) => String(a.info.iid).localeCompare(String(b.info.iid)));
    const s = app.stereo.open(ls[0], ls[1]);
    await new Promise((x) => setTimeout(x, 600));
    const m = app.stereo.metrics(ls[0], ls[1]);
    const ypar = s.yParallaxRms(truth.checkpoints);
    const gain = s.gain();
    // Shift+wheel: one notch = ¼ screen px of parallax.
    const z0 = s.z;
    s.wheelZ({ deltaY: -100, ctrlKey: false });
    const dz = s.z - z0;
    const expectDz = 0.25 / (gain * app.activePane().view.zoom);
    // Box heights: snap on the roof centre and on the ground just outside a corner.
    const boxes = [];
    for (const b of truth.boxes) {
      s.setCursor({ lat: b.roofCentre.lat, lon: b.roofCentre.lon, h: b.topHae - 3 });
      const roof = await s.snapToGround();
      const top = { ...s.cursor };
      // Base: on the sunlit east side, across the north–south baseline (no layover or shadow).
      const cLat = b.footprint.reduce((a, q) => a + q.lat, 0) / 4;
      const cLon = b.footprint.reduce((a, q) => a + q.lon, 0) / 4;
      const dist = Math.hypot(...b.sizeM) / 2 + 9;
      s.setCursor({ lat: cLat, lon: cLon + dist / (111320 * Math.cos((cLat * Math.PI) / 180)), h: b.baseHae + 2 });
      const base = await s.snapToGround();
      const bot = { ...s.cursor };
      const row = app.stereo.log('height', [bot, top]);
      boxes.push({ id: b.id, truth: b.height, measured: row.value, le90: row.le90, ok: roof.ok && base.ok, roof, base, topT: b.topHae, baseT: b.baseHae });
    }
    // The anaglyph composite: the centre pixel is coloured from both eyes.
    s.setCursorMode('image');
    app.renderer.invalidate();
    await new Promise((x) => setTimeout(x, 300));
    const cap = app.renderer.capture();
    const bb = app.activePane().el.getBoundingClientRect();
    const px = (fx, fy) => {
      const i = (Math.round((bb.top + fy * bb.height) * cap.dpr) * cap.width + Math.round((bb.left + fx * bb.width) * cap.dpr)) * 4;
      return [cap.data[i], cap.data[i + 1], cap.data[i + 2]];
    };
    const sample = [px(0.3, 0.3), px(0.6, 0.5), px(0.45, 0.7)];
    // Stereo Align on the pair: the right image gets an affine; y-parallax stays small.
    await app.commands.run('stereo.align');
    s.key = '';
    app.renderer.invalidate();
    await new Promise((x) => setTimeout(x, 400));
    const yparAfter = s.yParallaxRms(truth.checkpoints);
    return { m, ypar, gain, s: s.s, dz, expectDz, boxes, sample, yparAfter, ctx: app.ribbonContext(app.activeMp()).stereo, rightModel: ls[1].modelName, status: s.statusEl.textContent };
  }, truth);
  // AT-05.2
  expect(Math.abs(r.m.convergenceDeg - truth.pair.convergenceDeg)).toBeLessThan(0.5);
  expect(Math.abs(r.m.bieDeg - truth.pair.bieDeg)).toBeLessThan(0.5);
  expect(Math.abs(r.m.bOverHEffective - truth.pair.bOverH)).toBeLessThan(0.02);
  expect(r.m.warnings).toEqual([]);
  // AT-05.1
  expect(r.ypar).toBeLessThanOrEqual(0.5);
  // REQ-STR-08: gain = (B/H) / GSD in display px per metre; one notch = ¼ px.
  expect(Math.abs(r.gain * r.s - truth.pair.bOverH)).toBeLessThan(0.02); // display px = the left image's ground GSD
  expect(Math.abs(r.dz - r.expectDz) / r.expectDz).toBeLessThan(0.02);
  // AT-05.4
  for (const b of r.boxes) {
    expect(b.ok, JSON.stringify(r.boxes)).toBe(true);
    expect(Math.abs(b.measured - b.truth), `${b.id}: ${b.measured} vs ${b.truth}`).toBeLessThanOrEqual(1);
    expect(b.le90).toBeGreaterThan(0);
  }
  // REQ-STR-04: the composite has red from the left eye and cyan from the right.
  expect(r.sample.some(([red, g, bl]) => red > 0 && (g > 0 || bl > 0))).toBe(true);
  expect(r.ctx).toBe(true);
  expect(r.status).toMatch(/HAE.*x-parallax.*y-parallax/);
  // REQ-SNS-10
  expect(r.rightModel).toContain('triangulated');
  expect(r.yparAfter).toBeLessThanOrEqual(0.5);
  expect(logs).toEqual([]);
});
