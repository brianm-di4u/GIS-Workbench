// SCN-70 REQ-GAP-82 automatic endmembers, through the command: a hyperspectral ENVI cube mixed
// from six USGS splib07 minerals (the embedded starter library) opens; Automatic Endmembers finds
// every mineral, pins the spectra to the Spectral Plot, opens a pixel-purity layer, adds the
// spectra to the library and unmixes the image with them. The Cuprite run against the library and
// the independent Python reference is offline (tests/tools/endmember_cuprite.mjs).
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const STARTER = JSON.parse(readFileSync(resolve('app/src/data/splib07-starter.json'), 'utf8'));
const MINERALS = ['Alunite GDS84', 'Buddingtonite GDS85', 'Calcite WS272 BECKa', 'Kaolinite CM9 BECKb', 'Muscovite GDS107', 'Hematite GDS27'];

/** A BSQ float32 ENVI cube: smooth abundances, a pure 3 × 3 patch per mineral, 0.3 % noise. */
function writeCube(dir) {
  const ends0 = MINERALS.map((n) => STARTER.spectra.find((s) => s.name.startsWith(n)));
  const keep = STARTER.wavelengths.map((_, b) => b).filter((b) => ends0.every((s) => s.values[b] !== null));
  const ends = ends0.map((s) => keep.map((b) => s.values[b]));
  const [w, h, nb, m] = [96, 72, keep.length, ends.length];
  let seed = 11;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const pure = [[4, 4], [44, 6], [86, 10], [10, 58], [52, 40], [80, 62]];
  const v = new Float32Array(w * h * nb);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = Array.from({ length: m }, (_, i) => Math.exp(1.4 * Math.sin((i + 1) * 2.3 * (x / w) + i) * Math.cos((m - i) * 1.9 * (y / h) + 0.5 * i)));
      const e = pure.findIndex(([px, py]) => x >= px && x < px + 3 && y >= py && y < py + 3);
      if (e >= 0) a = a.map((_, i) => (i === e ? 1 : 0));
      const s = a.reduce((q, r) => q + r, 0);
      for (let b = 0; b < nb; b++) {
        const g = Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
        v[b * w * h + y * w + x] = a.reduce((q, ai, i) => q + (ai / s) * ends[i][b], 0) + 0.003 * g;
      }
    }
  const img = join(dir, 'minerals.img');
  writeFileSync(img, Buffer.from(v.buffer));
  const wl = keep.map((b) => STARTER.wavelengths[b]);
  writeFileSync(join(dir, 'minerals.hdr'), `ENVI\ndescription = {six splib07 minerals, mixed}\nsamples = ${w}\nlines = ${h}\nbands = ${nb}\nheader offset = 0\nfile type = ENVI Standard\ndata type = 4\ninterleave = bsq\nbyte order = 0\nwavelength units = Micrometers\nwavelength = {${wl.join(', ')}}\n`);
  return { files: [img, join(dir, 'minerals.hdr')], ends, nb };
}

test('SCN-70 REQ-GAP-82 Automatic Endmembers finds the minerals, pins them, adds them to the library and unmixes', async ({ page }, info) => {
  test.setTimeout(300000);
  const dir = info.outputPath('cube');
  mkdirSync(dir, { recursive: true });
  const cube = writeCube(dir);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, cube.files);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 90000 });
  const before = await frame.evaluate(() => ({ layers: window.gisworkbench.layers.size, library: window.gisworkbench.msi.libraries.length, bands: window.gisworkbench.activeLayer().bands }));
  expect(before.bands).toBe(cube.nb);

  // The command, through its dialog.
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('msi.endmembers'); // resolves when the dialog closes
  });
  const dlg = frame.locator('[data-id="dialog:msi-endmembers"]');
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Endmembers', { exact: true }).fill('6');
  await dlg.getByLabel('Add them to the spectral library').check();
  await expect(dlg.getByLabel('Unmix with them')).toBeChecked();
  await dlg.getByRole('button', { name: 'Run' }).click();
  await frame.waitForFunction((n) => window.gisworkbench.layers.size >= n + 2, before.layers, { timeout: 240000 });

  const r = await frame.evaluate((ends) => {
    const app = window.gisworkbench;
    const angle = (a, b) => {
      let d = 0;
      let x = 0;
      let y = 0;
      for (let i = 0; i < a.length; i++) {
        d += a[i] * b[i];
        x += a[i] * a[i];
        y += b[i] * b[i];
      }
      return Math.acos(Math.min(1, Math.max(-1, d / Math.sqrt(x * y))));
    };
    const pinned = app.msi.plot.pinned;
    const layers = [...app.layers.values()];
    const ppi = layers.find((l) => l.msi?.kind === 'ppi');
    const ab = layers.find((l) => l.msi?.transform === 'unmix');
    const added = app.msi.libraries.slice(-pinned.length);
    return {
      labels: pinned.map((s) => s.label),
      best: ends.map((e) => Math.min(...pinned.map((s) => angle(e, s.values)))),
      ppiBands: ppi?.bands ?? 0,
      abBands: ab?.bands ?? 0,
      abNames: ab ? app.msi.bandsOf(ab).map((b) => b.name) : [],
      library: app.msi.libraries.length,
      addedWl: added.every((s) => Array.isArray(s.wl) && s.wl.length === s.values.length),
      addedQuantity: [...new Set(added.map((s) => s.quantity))],
    };
  }, cube.ends);
  console.log(JSON.stringify(r));
  expect(r.labels).toHaveLength(6);
  expect(r.labels[0]).toMatch(/^EM 1 \(\d+, \d+\)$/);
  for (const a of r.best) expect(a).toBeLessThan(0.05);
  expect(r.ppiBands).toBe(1);
  expect(r.abBands).toBe(7);
  expect(r.abNames.at(-1)).toBe('RMS residual');
  expect(r.library).toBe(before.library + 6);
  expect(r.addedWl).toBe(true);
  expect(logs).toEqual([]);
});
