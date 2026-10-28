// GIS Workbench 2.0 recipes (2.0 plan P6): REQ-PIP-01 recipes as files, REQ-PIP-02 the visible
// stepper with parameters and re-run, REQ-PIP-03 gates, REQ-PIP-04 built-in recipes and pinning.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { openApp, openFiles, SAMPLES } from './helpers.js';

test.describe.configure({ timeout: 600000 });

const DIST = resolve('dist/packs');
const pk = (n) => resolve(DIST, readdirSync(DIST).find((f) => (n === 'ai' ? /^ai-\d/.test(f) : f.startsWith(`${n}-`))));
const VEGAS = join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_PS-RGB_img10.tif');

async function ready(page, packs) {
  // Saves become downloads and opens go through a file input.
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
    delete window.showOpenFilePicker;
  });
  const { frame, logs } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  await openFiles(frame, packs.map(pk));
  await frame.waitForFunction((n) => n.every((x) => window.gisworkbench.packs.loaded.has(x)), packs, { timeout: 120000 });
  await openFiles(frame, [VEGAS]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.stats && l.lutTex), null, { timeout: 120000 });
  return { frame, logs };
}

test('REQ-PIP-01 REQ-PIP-02 REQ-PIP-03 a recipe runs as a stepper, pauses at its gate, exports the reviewed result, and re-runs from a changed step', async ({ page }) => {
  const { frame } = await ready(page, ['ai', 'ai-detect']);
  const recipe = { format: 'gw-recipe/1', id: 'vegas-test', name: 'Vegas test', steps: [{ op: 'contrast' }, { op: 'find', params: { objects: ['building'], threshold: 0.15 } }, { op: 'gate', params: { message: 'Review' } }, { op: 'exportGeojson', params: { what: 'accepted-detections' } }] };
  // Open it from a file through the Recipes dock.
  const file = join(tmpdir(), `vegas-${Date.now()}.gwrecipe.json`);
  writeFileSync(file, JSON.stringify(recipe));
  await frame.evaluate(() => window.gisworkbench.commands.run('rcp.open'));
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), frame.locator('[data-id="recipe:open"]').click()]);
  await chooser.setFiles(file);
  const steps = frame.locator('[data-id="recipe:steps"] li');
  await expect(steps).toHaveCount(4);
  await frame.locator('[data-id="recipe:run"]').click();
  await expect(steps.nth(2)).toHaveAttribute('data-status', 'waiting', { timeout: 300000 });
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'done');
  await expect(steps.nth(1)).toContainText(/\d+ building/);
  // The gate: the analyst accepts two candidates, rejects the rest, and presses Enter.
  const n = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const ds = app.store.all('detection');
    ds.forEach((d, i) => app.detections.setStatus(d.id, i < 2 ? 'accepted' : 'rejected'));
    return ds.length;
  });
  expect(n).toBeGreaterThanOrEqual(2);
  const [dl] = await Promise.all([page.waitForEvent('download'), frame.locator('.pane').first().press('Enter')]);
  const gj = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  expect(gj.features).toHaveLength(2);
  await expect(steps.nth(3)).toHaveAttribute('data-status', 'done');
  await expect(steps.nth(2)).toContainText('2 accepted');
  // Change a parameter in the drawer: that step and the later ones go stale; re-run from it.
  await steps.nth(1).click();
  const thr = frame.locator('[data-id="recipe:drawer"] [data-id="recipe:param:threshold"]');
  await thr.fill('0.3');
  await thr.dispatchEvent('change');
  await expect(steps.nth(1)).toHaveAttribute('data-status', 'stale');
  await expect(steps.nth(3)).toHaveAttribute('data-status', 'stale');
  await expect(steps.nth(0)).toHaveAttribute('data-status', 'done');
  await frame.locator('[data-id="recipe:rerun"]').click();
  await expect(steps.nth(2)).toHaveAttribute('data-status', 'waiting', { timeout: 300000 });
  await frame.locator('[data-id="recipe:stop"]').click();
  await expect(steps.nth(3)).toHaveAttribute('data-status', 'skipped');
  // Save: the edited parameter goes with the file.
  const [dl2] = await Promise.all([page.waitForEvent('download'), frame.locator('[data-id="recipe:save"]').click()]);
  const saved = JSON.parse(readFileSync(await dl2.path(), 'utf8'));
  expect(saved.format).toBe('gw-recipe/1');
  expect(saved.steps[1].params.threshold).toBe(0.3);
});

test('REQ-PIP-04 the Building extraction recipe outlines and squares the buildings it finds; built-ins are commands for the radial menu', async ({ page }) => {
  const { frame } = await ready(page, ['ai', 'ai-detect', 'ai-sam2']);
  const pinned = await frame.evaluate(() => {
    const app = window.gisworkbench;
    return { cmds: ['rcp.airfield-triage', 'rcp.damage-triage', 'rcp.folder-to-cog', 'rcp.building-extraction'].map((id) => !!app.commands.get(id)) };
  });
  expect(pinned.cmds).toEqual([true, true, true, true]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.recipes.open(app.recipes.builtin.find((x) => x.id === 'building-extraction'));
    const done = app.recipes.run(0);
    while (!app.recipes.runner.waiting) {
      if (!app.recipes.runner.running) break;
      await new Promise((s) => setTimeout(s, 200));
    }
    const outlines = app.store.all('graphic').filter((g) => g.tag === 'recipe-outline');
    const st = app.recipes.runner.state.map((s) => s.status);
    app.recipes.runner.stop();
    await done;
    return { n: outlines.length, st, prov: outlines[0]?.provenance?.model ?? '', summary: app.recipes.runner.state[1].summary };
  });
  console.log(`Building extraction: ${r.summary}`);
  expect(r.st.slice(0, 3)).toEqual(['done', 'done', 'waiting']);
  expect(r.n).toBeGreaterThanOrEqual(3);
  expect(r.prov).toMatch(/SAM 2\.1.*corners squared/);
});
