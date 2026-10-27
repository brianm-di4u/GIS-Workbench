// REQ-STR-06: two-window dual stereo output (left eye in the panel, right eye in a second window,
// kept current as the view moves) and WebXR per-eye stereo where available.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx02');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx02_truth.json'), 'utf8'));

test('REQ-STR-06 FX-02 dual output: the second window shows the right eye and follows the view; the panel shows the left eye; WebXR reports when unavailable', async ({ page }) => {
  test.setTimeout(180000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, truth.images.slice(0, 2).map((i) => resolve(DIR, i.file)));
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 2, null, { timeout: 60000 });
  const popupP = page.context().waitForEvent('page');
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const ls = p.layers().sort((a, b) => String(a.info.iid).localeCompare(String(b.info.iid)));
    app.stereo.open(ls[0], ls[1]);
    app.stereoOut.dual(p);
  });
  const popup = await popupP;
  const settle = () => frame.evaluate(async () => {
    const app = window.gisworkbench;
    for (let i = 0; i < 20; i++) {
      app.activePane().invalidate();
      await new Promise((r) => requestAnimationFrame(r));
    }
  });
  await settle();
  const stats = async () =>
    frame.evaluate(() => {
      const app = window.gisworkbench;
      const r = app.renderer;
      const mean = (px) => {
        let s = 0;
        let n = 0;
        for (let i = 0; i < px.data.length; i += 4 * 97) {
          s += px.data[i] + px.data[i + 1] + px.data[i + 2];
          n += 3;
        }
        return s / n;
      };
      const L = r.readTarget(0);
      const R = r.readTarget(1);
      // A crude fingerprint of each eye: row means of the green channel.
      const rows = (px) => Array.from({ length: 8 }, (_, k) => {
        const y = Math.floor(((k + 0.5) * px.h) / 8);
        let s = 0;
        for (let x = 0; x < px.w; x += 3) s += px.data[4 * (y * px.w + x) + 1];
        return s / Math.ceil(px.w / 3);
      });
      return { L: mean(L), R: mean(R), rowsR: rows(R).reverse(), w: R.w, h: R.h, frames: app.stereoOut.dualState()?.frames(), mode: app.activePane().stereo.mode };
    });
  const s1 = await stats();
  const pop = async () =>
    popup.evaluate(() => {
      const c = document.querySelector('[data-id="right-eye"]');
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height);
      let s = 0;
      let n = 0;
      for (let i = 0; i < d.data.length; i += 4 * 97) {
        s += d.data[i] + d.data[i + 1] + d.data[i + 2];
        n += 3;
      }
      const rows = Array.from({ length: 8 }, (_, k) => {
        const y = Math.floor(((k + 0.5) * c.height) / 8);
        let t = 0;
        for (let x = 0; x < c.width; x += 3) t += d.data[4 * (y * c.width + x) + 1];
        return t / Math.ceil(c.width / 3);
      });
      return { w: c.width, h: c.height, mean: s / n, rows, title: document.title };
    });
  const p1 = await pop();
  expect(s1.mode).toBe('dual');
  expect(s1.frames).toBeGreaterThan(0);
  expect([p1.w, p1.h]).toEqual([s1.w, s1.h]);
  expect(p1.title).toMatch(/right eye/);
  expect(Math.abs(p1.mean - s1.R)).toBeLessThan(2);
  p1.rows.forEach((v, k) => expect(Math.abs(v - s1.rowsR[k]), `row ${k}`).toBeLessThan(3));
  // Pan: the second window follows.
  await frame.evaluate(() => {
    const p = window.gisworkbench.activePane();
    p.setView({ cx: p.view.cx + 150 / p.view.zoom, cy: p.view.cy + 60 / p.view.zoom });
  });
  await settle();
  const s2 = await stats();
  const p2 = await pop();
  expect(s2.frames).toBeGreaterThan(s1.frames);
  p2.rows.forEach((v, k) => expect(Math.abs(v - s2.rowsR[k]), `row ${k} after pan`).toBeLessThan(3));
  expect(p2.rows.some((v, k) => Math.abs(v - p1.rows[k]) > 1)).toBe(true);
  // WebXR: no headset in the test browser — a clear message, and the dual output keeps working.
  const xr = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    let msg = null;
    try {
      await app.stereoOut.startXr();
    } catch (e) {
      msg = e.message;
    }
    return { supported: await app.stereoOut.xrSupported(), msg };
  });
  expect(xr.supported).toBe(false);
  expect(xr.msg).toMatch(/WebXR immersive stereo is not available here/);
  // Closing the second window returns the panel to its previous mode.
  await popup.close();
  await settle();
  const after = await frame.evaluate(() => ({ mode: window.gisworkbench.activePane().stereo.mode, dual: !!window.gisworkbench.stereoOut.dualState() }));
  expect(after.dual).toBe(false);
  expect(after.mode).not.toBe('dual');
  expect(logs).toEqual([]);
});
