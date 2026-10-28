// Shared harness for the GUI campaign sweeps (docs/validation/GUI-findings.md): the three built
// files, the data states, boot, observation of everything a user can see go wrong after one
// action, and settling whatever the action opened. Used by gui-sweep.spec.js (Classic layout)
// and gui-modern.spec.js (Modern layout, the 2.0 default).

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApp, openFiles, ROOT } from './helpers.js';

/** GW_DIST=dist-gui sweeps a scratch build instead of the released files. */
const DIST = process.env.GW_DIST ?? 'dist';
export const BUILDS = {
  full: join(ROOT, DIST, 'gis-workbench.html'),
  lite: join(ROOT, DIST, 'gis-workbench-lite.html'),
  airgap: join(ROOT, DIST, 'gis-workbench-airgap.html'),
};
export const FX = (...p) => join(ROOT, 'fixtures', ...p);
/** Refusals that are the build working as designed, not an error. */
export const LITE_MSG = /GIS Workbench Lite leaves out/;
export const AIRGAP_MSG = /air-gapped file/;

/**
 * Data states. `setup` runs after the files open (commands only to reach a mode the GUI
 * reaches by the same command). `main` also sweeps the seven main tabs in that state.
 */
export const STATES = [
  { id: 's0-empty', files: [], main: true },
  { id: 's1-image', files: [FX('fx01', 'fx01.ntf')], main: true },
  // The DEM is made terrain the way Use as Terrain… does (its dialog's OK), which brings up Surface Tools.
  { id: 's2-dem', files: [FX('fx05', 'fx05_dem_hae.tif')], terrain: 'hae' },
  { id: 's3-msi', files: [FX('fx08', 'fx08.tif')] },
  { id: 's4-sar', files: [FX('fx07', 'fx07_a.nitf')], lite: 'sar' },
  { id: 's5-pair', files: [FX('fx06', 'fx06_date1.tif'), FX('fx06', 'fx06_date2.tif')] },
  { id: 's6-stereo', files: [FX('fx02', 'fx02_a.ntf'), FX('fx02', 'fx02_b.ntf')], setup: ['stereo.open'] },
  { id: 's7-cloud', files: [FX('fx09', 'fx09_ftus.las')], lite: 'skip' },
  { id: 's8-video', files: [FX('fx10', 'fx10.ts')], lite: 'video' },
  { id: 's9-vector', files: [FX('fx12', 'fx12.geojson')] },
  { id: 's10-detect', files: [FX('fx08', 'fx08.tif'), FX('products', 'fx08_detections.csv')] },
];

/** Commands with window-level side effects; exercised by their own tests. */
export const SEPARATE = new Set(['win.new', 'win.clone', 'win.separate', 'win.close', 'display.fullscreen', 'file.print', 'stereo.xr', 'cmp.record', '3d.record']);
/** Commands that end the state's mode; run last so the rest is swept first. */
export const ENDS_MODE = /^(stereo\.open|3d\.open|3d\.close|pc\.close|fmv\.close|aoi\.clear)$/;

export const MP = 'section.multiport';

export function reportDir(name) {
  return join(ROOT, 'reports', name);
}

/** Open a built file with the toast recorder; native pickers, downloads and print are stubbed. */
export async function boot(page, build, { prefs, keepDownloads = false } = {}) {
  const app = await openApp(page, 'file', { htmlPath: BUILDS[build], ...(prefs ? { prefs } : {}) });
  page.on('filechooser', (fc) => fc.setFiles([]).catch(() => {}));
  if (!keepDownloads) page.on('download', (d) => d.cancel().catch(() => {}));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  await app.frame.evaluate(() => {
    // Record every toast as it appears (they fade after a few seconds).
    window.__toasts = [];
    new MutationObserver((ms) => {
      for (const m of ms)
        for (const n of m.addedNodes)
          if (n.classList?.contains('toast')) window.__toasts.push({ kind: [...n.classList].find((c) => c.startsWith('toast-'))?.slice(6), text: n.textContent });
    }).observe(document.body, { childList: true, subtree: true });
    window.print = () => {};
  });
  app.build = build;
  return app;
}

export async function enterState(page, build, st, opts) {
  const app = await boot(page, build, opts);
  if (st.files.length) {
    await openFiles(app.frame, st.files);
    await app.frame
      .waitForFunction(() => {
        const a = window.gisworkbench;
        const ls = [...a.layers.values()];
        return (ls.length && ls.every((l) => l.error || (l.lutTex && !l.tiles?.loading))) || a.store.all('vlayer').length || a.store.all('pointcloud').length || a.fmv?.clips?.size;
      }, null, { timeout: 60_000 })
      .catch(() => {});
  }
  if (st.terrain) await app.frame.evaluate((v) => window.gisworkbench.useAsTerrain(window.gisworkbench.activeLayer(), v), st.terrain);
  for (const c of st.setup ?? []) await app.frame.evaluate((c) => window.gisworkbench.commands.run(c), c);
  await page.waitForTimeout(800);
  return app;
}

/** Everything a user can see go wrong after one action, since `mark`. */
export async function observe(page, app, mark, build) {
  const problems = [];
  const toasts = await page.evaluate((n) => window.__toasts.slice(n), mark.toasts);
  for (const t of toasts) {
    if (t.kind !== 'error') continue;
    if (build === 'lite' && LITE_MSG.test(t.text)) continue;
    if (build === 'airgap' && AIRGAP_MSG.test(t.text)) continue;
    problems.push(`error toast: ${t.text}`);
  }
  for (const l of app.logs.slice(mark.logs)) problems.push(`console: ${l.slice(0, 300)}`);
  const csp = await app.csp();
  for (const c of csp.slice(mark.csp)) problems.push(`csp: ${c}`);
  return { problems, toasts: toasts.map((t) => `${t.kind}: ${t.text}`) };
}

export async function markNow(page, app) {
  return { toasts: await page.evaluate(() => window.__toasts.length), logs: app.logs.length, csp: (await app.csp()).length };
}

/**
 * Close whatever the action opened: dialogs (Esc, then ×), menus, the palette, the radial
 * menu, tools, the whiteboard. `layout` is the layout the sweep is covering: a control that
 * switches layout is switched back.
 */
export async function settle(page, { layout = 'classic' } = {}) {
  const seen = { dialogs: [], menus: 0, problems: [] };
  await page.waitForTimeout(350);
  for (let i = 0; i < 6; i++) {
    const st = await page.evaluate(() => {
      const d = [...document.querySelectorAll('.dlg[role="dialog"]')];
      const top = d.at(-1);
      let fit = true;
      let overflow = false;
      let unnamed = [];
      if (top) {
        const r = top.getBoundingClientRect();
        fit = r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        const b = top.querySelector('.dlg-body');
        overflow = !!b && b.scrollWidth > b.clientWidth + 2;
        // Every visible control needs an accessible name (WCAG 4.1.2).
        const named = (e) => e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.labels?.length || e.title || (e.tagName === 'BUTTON' && e.textContent.trim()) || e.closest('label');
        unnamed = [...top.querySelectorAll('input:not([type="hidden"]), select, textarea, button')].filter((e) => e.getClientRects().length && !named(e)).map((e) => `${e.tagName.toLowerCase()}${e.type ? `[${e.type}]` : ''}${e.className ? `.${String(e.className).split(' ')[0]}` : ''}`);
      }
      return { dlg: top?.getAttribute('aria-label') ?? null, id: top?.dataset.id ?? null, fit, overflow, unnamed, menu: !!document.querySelector('.menu-host'), wb: !!document.querySelector('.wb-overlay:not([hidden])'), palette: !!document.querySelector('[data-id="palette"]'), radial: !!document.querySelector('[data-id="radial"]'), welcome: !!document.querySelector('[data-id^="welcome:"]') };
    });
    // The radial menu (REQ-SHL-10) closes with Esc.
    if (st.radial) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      if (await page.locator('[data-id="radial"]').count()) seen.problems.push('the radial menu ignores Esc');
      continue;
    }
    // The command palette (REQ-SHL-05) closes with Esc like a dialog.
    if (st.palette) {
      seen.dialogs.push('palette');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      if (await page.locator('[data-id="palette"]').count()) seen.problems.push('the command palette ignores Esc');
      continue;
    }
    if (st.dlg) {
      seen.dialogs.push(st.id ?? st.dlg);
      if (!st.fit) seen.problems.push(`dialog "${st.dlg}" does not fit the window`);
      if (st.overflow) seen.problems.push(`dialog "${st.dlg}" body scrolls sideways`);
      if (st.unnamed.length) seen.problems.push(`dialog "${st.dlg}" has controls without a name: ${[...new Set(st.unnamed)].join(', ')}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      const still = await page.evaluate((l) => [...document.querySelectorAll('.dlg[role="dialog"]')].some((d) => d.getAttribute('aria-label') === l), st.dlg);
      if (still) {
        seen.problems.push(`dialog "${st.dlg}" ignores Esc`);
        await page.locator('.dlg .dlg-x').last().click().catch(() => {});
        await page.waitForTimeout(200);
      }
      continue;
    }
    if (st.menu) {
      seen.menus++;
      await page.keyboard.press('Escape');
      await page.mouse.click(2, 2);
      continue;
    }
    if (st.wb) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      continue;
    }
    break;
  }
  // In the Modern layout modeless editors dock as tool panels (REQ-SHL-09): note and close them.
  const tools = await page.evaluate(() => {
    const out = [];
    for (const mp of window.gisworkbench.desktop.multiports)
      for (const [id, p] of mp.docks.registry)
        if (id.startsWith('tool:') && (p.area || p.floatWin)) {
          out.push(id);
          mp.docks.close(p);
        }
    return out;
  });
  seen.dialogs.push(...tools);
  // View ▸ Display ▸ Interface Layout switches layout at once (REQ-SHL-01): switch back.
  if (await page.evaluate((l) => document.documentElement.dataset.layout !== l, layout)) await page.evaluate((l) => window.gisworkbench.setLayout(l), layout);
  // View ▸ Workspace Window folds the Workspace window (and its menu bar) into a rail: in the
  // Classic sweep open it again so the sweep keeps its menus (REQ-SHL-02).
  if (layout === 'classic' && (await page.locator('[data-id="ws:rail"]').count())) await page.locator('[data-id="ws:rail"]').click();
  // A tool left active keeps capturing the panel: Esc cancels it (keys.js).
  const tool = await page.evaluate(() => !!window.gisworkbench.tools?.current);
  if (tool) {
    await page.locator('.pane').first().focus().catch(() => {});
    await page.keyboard.press('Escape');
  }
  return seen;
}

export function report(dir, name, rows) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(rows, null, 1));
  return rows.filter((r) => r.problems?.length).map((r) => `${r.tab ?? ''} ${r.id}: ${r.problems.join(' | ')}`);
}

export function progress(dir, line) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'progress.log'), `${line}\n`);
}
