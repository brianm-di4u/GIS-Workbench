// REQ-GAP-94, REG-075: the ground-control marking dialog on a synthetic block, with the sidecar's
// answers mocked in the page, so it runs on every PR. SCN-82 (tests/e2e/sidecar/28-sfm-gcp.spec.js)
// runs the same dialog on a real block, where the data is.
//
// Two nadir photographs 400 x 300 px, 100 m above 3 control points; no sidecar job ever starts.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp } from './helpers.js';
import { MAGIC, VERSION, controlCsv } from '../../app/src/features/sfm-gcp.js';

const OFF = [500000, 900000, 0];
const NADIR = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
];
const HEADER = {
  format: 'gwb-sfm-model',
  version: VERSION,
  cameras: [{ id: 1, model: 0, width: 400, height: 300, params: [300, 200, 150] }],
  images: [
    { id: 1, name: 'A.JPG', camera: 1, r: NADIR, c: [0, 0, 100] },
    { id: 2, name: 'B.JPG', camera: 1, r: NADIR, c: [20, 0, 100] },
  ],
  georef: { epsg: 32630, offset: OFF },
  ground: [],
  files: [],
};
const MODEL = `${MAGIC} ${VERSION}\n${JSON.stringify(HEADER)}\n`;
const CONTROL = controlCsv({
  epsg: 32630,
  points: [
    ['G1', 0, 0],
    ['G2', 10, 10],
    ['G3', -10, -10],
  ].map(([id, dx, dy]) => ({ id, xyz: [OFF[0] + dx, OFF[1] + dy, 0], sigma: 0.02, check: false, marks: [] })),
});
const profile = (id) => ({ id, title: id, module: 'sfm', available: true, options: [], inputs: [] });
const CAPS = { api: 1, version: 'test', profiles: [profile('sfm-model'), profile('sfm-control')], modules: [], raster_drivers: [], vector_drivers: [] };

/** A sidecar that knows this page, with the two profiles, the control file and the model file. */
async function mockSidecar(page) {
  await page.route(/^http:\/\/127\.0\.0\.1:4782[123]\//, async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': req.headers()['access-control-request-headers'] ?? 'authorization, content-type' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (u.port !== '47821') return route.abort();
    const json = (b) => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    if (u.pathname === '/v1/hello') return json({ service: 'gwb-sidecar', api: 1, paired: true, version: 'test' });
    if (u.pathname === '/v1/caps') return json(CAPS);
    if (u.pathname === '/v1/pick') return json({ files: [{ id: 'model', name: 'block.sfm-model' }] });
    if (u.pathname === '/v1/files') return json([{ id: 'other', name: 'other.tif', size: 10, origin: 'output' }, { id: 'model', name: 'block.sfm-model', size: 2e6, origin: 'output' }]);
    if (u.pathname === '/v1/files/ctl') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/csv' }, body: CONTROL });
    if (u.pathname === '/v1/files/model') return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/octet-stream' }, body: MODEL });
    return route.fulfill({ status: 404, headers: { ...cors, 'content-type': 'application/json' }, body: '{"error":"not in this mock"}' });
  });
}

/** Start the command with two photographs drawn in the page; `model` false starts from the first dialog's reuse button. */
async function start(frame, model) {
  await frame.evaluate(async (model) => {
    const g = window.gisworkbench;
    const S = g.sidecar;
    Object.assign(S.client, { base: 'http://127.0.0.1:47821', token: 'test', ports: [47821] });
    await S.refresh({ quiet: true });
    const photo = async (name) => {
      const c = new OffscreenCanvas(400, 300);
      const x = c.getContext('2d');
      x.fillStyle = '#7a8a5a';
      x.fillRect(0, 0, 400, 300);
      return new File([await c.convertToBlob({ type: 'image/jpeg' })], name, { type: 'image/jpeg' });
    };
    const photos = [await photo('A.JPG'), await photo('B.JPG')];
    const args = { folder: { id: 'dir', name: 'block', entries: ['A.JPG', 'B.JPG'] }, control: { id: 'ctl', name: 'gcp.csv' }, photos };
    if (model) args.model = { id: 'model', name: 'block.sfm-model' };
    window.__sfm = g.commands.run('sidecar.sfmcontrol', args);
  }, model);
}

test('the marking dialog: a click, the arrow keys and Enter mark a point without running the second stage', async ({ page }) => {
  await mockSidecar(page);
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  await start(frame, true);
  await frame.locator('[data-id="dialog:sidecar-sfm-gcp"]').getByRole('button', { name: 'Run the first stage' }).click();
  const dlg = frame.locator('[data-id="dialog:sidecar-sfm-mark"]');
  const caption = dlg.locator('[data-id="sfm:photo"]');
  await expect(caption).toContainText('G1 in A.JPG', { timeout: 30_000 });
  // The model puts G1 at the centre of A.JPG (200, 150), drawn at the centre of the 640 x 440 view:
  // the view starts at (200 - 320, 150 - 220) in the photograph. Click at (200, 155).
  const canvas = dlg.locator('[data-id="sfm:canvas"]');
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: ((200 + 120) * box.width) / 640, y: ((155 + 70) * box.height) / 440 } });
  await expect(caption).toContainText('marked at');
  const got = /marked at (-?[\d.]+), (-?[\d.]+)\./.exec(await caption.textContent()).slice(1).map(Number);
  // Within a pixel: the canvas is scaled to the dialog.
  expect(Math.abs(got[0] - 200)).toBeLessThan(1.5);
  expect(Math.abs(got[1] - 155)).toBeLessThan(1.5);
  // Enter places the mark from the keyboard and leaves the dialog open (it once pressed the run button).
  await canvas.focus();
  for (let i = 0; i < 3; i++) await canvas.press('ArrowRight');
  await canvas.press('Enter');
  const moved = `marked at ${(got[0] + 3).toFixed(1)}, ${got[1].toFixed(1)}.`;
  await expect(caption).toContainText(moved);
  await expect(dlg).toBeVisible();
  // One point in one photograph is not enough: the dialog comes back with the mark kept.
  await dlg.getByRole('button', { name: 'Run with these marks' }).click();
  await expect(frame.locator('.toast').filter({ hasText: 'at least 3 are needed' }).first()).toBeVisible();
  await expect(dlg).toBeVisible();
  await expect(caption).toContainText(moved);
  // Cancelled after marking: the marks are saved as a control file, beside the note that the model is kept.
  const saved = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  const csv = await saved;
  expect(csv.suggestedFilename()).toBe('block.gcp.csv');
  expect(readFileSync(await csv.path(), 'utf8')).toContain('G1,500000,900000,0,EPSG:32630,0.02,gcp,A.JPG,');
  expect(await frame.evaluate(() => window.__sfm)).toBeNull();
  await expect(frame.locator('.toast').filter({ hasText: 'block.sfm-model' }).first()).toBeVisible();
});

test('a model from an earlier first stage starts the run again at the marking', async ({ page }) => {
  await mockSidecar(page);
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  await start(frame, false);
  await frame.locator('[data-id="dialog:sidecar-sfm-gcp"]').getByRole('button', { name: 'Use a model from an earlier run' }).click();
  // The models the sidecar kept are offered by name, not through a file picker.
  const models = frame.locator('[data-id="dialog:sidecar-sfm-models"]');
  await expect(models.locator('[data-id="sfm:models"] option')).toHaveText(['block.sfm-model (2 MB)']);
  await models.getByRole('button', { name: 'Use this model' }).click();
  const dlg = frame.locator('[data-id="dialog:sidecar-sfm-mark"]');
  await expect(dlg.locator('[data-id="sfm:photo"]')).toContainText('G1 in A.JPG', { timeout: 30_000 });
  // One click, then Cancel straight away: the mark is saved all the same.
  const canvas = dlg.locator('[data-id="sfm:canvas"]');
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(dlg.locator('[data-id="sfm:photo"]')).toContainText('marked at');
  const saved = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  expect(readFileSync(await (await saved).path(), 'utf8')).toMatch(/^G1,.*,gcp,A\.JPG,/m);
  expect(await frame.evaluate(() => window.__sfm)).toBeNull();
});
