// TE-C52 pointer tools (2.0.4 campaign): every command that selects a pointer tool (drawing,
// mensuration, AOI, selection, tracing, editing, profiles, navigation by mouse) is driven with real
// mouse input on the panel — a click, a drag, and a three-vertex polyline ended by a double-click —
// on one representative of each data kind (RPC image, GeoTIFF, DEM in use as terrain, SICD, point
// cloud, vectors). Each gesture must leave no console/page error and no error toast; a new record,
// measurement, view change or message is recorded as its effect.
//
//   TE_DIST=dist-cx5/gis-workbench.html TE_RUN=cx-tools npx playwright test -c playwright.campaign.config.js c52-interactive --project=chrome
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { item, paths } from './helpers.js';
import { session, recordWriter, outDir, excluded } from './cross-lib.js';
import { isRefusal } from '../../build/campaign/verdict.mjs';

const RUN = process.env.TE_RUN ?? 'cx-tools';
const OUT = outDir(RUN);
const R = (id, file) => paths(item(id), ['primary', 'sidecar']).filter((p) => !file || p.split(/[\\/]/).pop() === file || p.split(/[\\/]/).pop().startsWith(file.replace(/\.[^.]+$/, '') + '.'));
const KINDS = [
  ['rpc-image', () => R('rs-nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf'), []],
  ['geotiff', () => R('naip-co-golden-x48y441-2023').slice(0, 1), []],
  ['dem-terrain', () => [...R('rs-nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf'), ...R('rs-dem-derived-s35w059', 'S35W059_crop1201_float32_cog.tif')], ['terrain']],
  ['sicd', () => R('rs-sicd-umbra-chip'), []],
  ['pointcloud', () => R('rs-lidar-las-laz-copc', 'autzen_trim.laz'), []],
  ['vectors-on-image', () => [...R('rs-nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf'), ...R('rs-vector-fx12-synthetic', 'fx12.geojson')], ['select-feature']],
];

const snap = (frame) =>
  frame.evaluate(() => {
    const a = window.gisworkbench;
    return {
      records: ['graphic', 'feature', 'measurement', 'aoi', 'observation', 'pcedit', 'demedit', 'tripoint'].map((t) => a.store.all(t).length).join(','),
      view: JSON.stringify(a.activePane()?.view ?? null),
      undo: a.undo.undoStack.length,
      toasts: a.toastLog?.length ?? 0,
      tool: a.tools.current?.id ?? null,
    };
  });

test.describe.configure({ mode: 'parallel' });
for (const [kind, files, steps] of KINDS) {
  test(`TE-C52 REQ-IMG-31 REQ-MEN-01 REQ-EXT-01 pointer tools on ${kind}`, async ({ page }, info) => {
    test.setTimeout(1800_000);
    const fs = files();
    test.skip(!fs.length || !fs.every(existsSync), 'not on disk');
    mkdirSync(OUT, { recursive: true });
    const rec = { spec: 'c52-interactive', project: info.project.name, key: kind, files: fs.map((p) => p.split(/[\\/]/).pop()), cells: {} };
    const save = recordWriter(join(OUT, `c52-${info.project.name}-${kind}.json`), rec);
    const s = await session(page, { files: fs, setupSteps: ['ai-mock', ...steps] });
    await s.open();
    // The tool commands enabled here: commands whose id is a registered pointer tool.
    const tools = await s.frame.evaluate(() => {
      const a = window.gisworkbench;
      return [...a.tools.defs.keys()].filter((id) => a.commands.map.has(id) && a.commands.enabled(id));
    });
    rec.tools = tools.filter((t) => !excluded(t));
    const box = await s.frame.locator('.multiport .pane').first().boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const id of rec.tools) {
      const logStart = s.logs.length;
      const before = await snap(s.frame);
      const t0 = Date.now();
      await s.frame.evaluate((c) => window.gisworkbench.commands.run(c), id);
      // Click, drag, then a polyline: three clicks and a double-click.
      await page.mouse.click(cx, cy);
      await page.waitForTimeout(150);
      await page.mouse.move(cx - 60, cy - 40);
      await page.mouse.down();
      await page.mouse.move(cx + 20, cy + 10, { steps: 6 });
      await page.mouse.move(cx + 60, cy + 40, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(150);
      await s.frame.evaluate((c) => window.gisworkbench.commands.enabled(c) && window.gisworkbench.commands.run(c), id);
      await page.mouse.click(cx - 50, cy + 30);
      await page.mouse.click(cx + 40, cy + 35);
      await page.mouse.click(cx + 45, cy - 30);
      await page.mouse.dblclick(cx - 20, cy - 35);
      await page.waitForTimeout(400);
      // Dialogs a tool opens at the end of a gesture are confirmed with their defaults, then closed.
      const ok = s.frame.locator('.dlg .dlg-buttons button', { hasText: /^(OK|Apply|Save|Create|Add|Done|Close)$/ }).first();
      if (await ok.count()) await ok.click({ timeout: 2000 }).catch(() => {});
      for (let i = 0; i < 3 && (await s.frame.locator('.dlg[role="dialog"]').count()); i++) await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await s.frame.waitForFunction(() => { const st = window.gisworkbench.pool?.stats?.(); return !st || (st.running === 0 && st.queued === 0); }, null, { timeout: 60_000 }).catch(() => {});
      const after = await snap(s.frame);
      const toasts = await s.frame.evaluate((n) => (window.gisworkbench.toastLog ?? []).slice(n).map((t) => `toast-${t.kind}: ${t.message}`), before.toasts);
      const errors = [...s.logs.slice(logStart), ...toasts.filter((t) => t.startsWith('toast-error'))];
      const changed = ['records', 'view', 'undo'].filter((k) => before[k] !== after[k]);
      const verdict = errors.length ? (isRefusal(errors) ? 'refused' : 'fail') : changed.length || toasts.length ? 'pass' : 'silent';
      rec.cells[id] = { verdict, ms: Date.now() - t0, changed, toasts: toasts.slice(0, 4), errors: errors.slice(0, 4) };
      // Back to the opened state for the next tool.
      await s.frame.evaluate((u) => {
        const a = window.gisworkbench;
        a.tools.select(null);
        while (a.undo.undoStack.length > u) a.undo.undo();
      }, before.undo);
      save();
    }
    save();
    const bad = Object.entries(rec.cells).filter(([, c]) => c.verdict === 'fail').map(([id, c]) => `${id}: ${c.errors.join(' | ').slice(0, 300)}`);
    expect(bad, `${kind}: every pointer tool takes mouse input cleanly`).toEqual([]);
  });
}
