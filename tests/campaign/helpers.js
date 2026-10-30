// T&E campaign helpers: corpus lookup, oracle truth, command execution with outcome capture, and
// tolerance assertions. Builds on the E2E helpers (run modes, console/CSP/network capture).

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { loadManifest, itemDir, filePath, CORPUS, REPO } from '../../build/campaign/corpus-lib.mjs';

import { openApp as openApp0, servers as servers0, DIST as DIST0 } from '../e2e/helpers.js';
import { resolve } from 'node:path';

export { openFiles, LEGACY_PREFS } from '../e2e/helpers.js';
export { CORPUS };
/** The build under test: dist/ by default; TE_DIST points at another (e.g. dist-te/ while fixing). */
export const DIST = process.env.TE_DIST ? resolve(process.env.TE_DIST) : DIST0;
export const openApp = (page, mode = 'file', opts = {}) => openApp0(page, mode, { htmlPath: DIST, ...opts });
export const servers = (htmlPath = DIST) => servers0(htmlPath);

/** A data pack from the build under test (a user opens it first, File ▸ Open Data Pack). */
export const packFile = (re) => {
  const dir = resolve(DIST, '..', 'packs');
  const f = existsSync(dir) && readdirSync(dir).find((n) => re.test(n));
  return f ? resolve(dir, f) : null;
};
// HDF5/NetCDF (EMIT, PRISMA) need the h5wasm data pack; state-plane CRSs need the PROJ pack.
export const HDF5_PACK = packFile(/^hdf5-.*\.gwpack$/);
export const PROJ_PACK = packFile(/^proj-.*\.gwpack$/);
// ASCII point clouds carry no CRS; tests answer the column dialog with the source's EPSG (from the
// LAS each was exported from, or the PDAL test's own notes). State-plane codes need the PROJ pack,
// which opens first. Files left out are local scanner coordinates or of unknown CRS.
export const ASCII_CRS = {
  'autzen.xyz': 2994, 'autzen.pts': 2994, 'autzen-point-format-3.txt': 2994, // NAD83(HARN) / Oregon GIC Lambert (ft)
  'test1_4.xyz': 2903, 'test1_4.pts': 2903, // NAD83(HARN) / New Mexico Central (ftUS)
  'houston_c1.xyz': 26915, 'houston_c1.pts': 26915, // DFC2018: UTM 15N
  'utm17_1.txt': 32617, 'utm17_2.txt': 32617, 'utm17_3.txt': 32617, 'crlf_test.txt': 32617,
};
export const isAscii = (it, f) => /\.(xyz|pts)$/i.test(f.name) || (it.area === 'lidar' && /\.txt$/i.test(f.name));

export const manifest = loadManifest();
const byId = new Map(manifest.items.map((it) => [it.id, it]));

export const item = (id) => {
  const it = byId.get(id);
  if (!it) throw new Error(`unknown corpus item ${id}`);
  return it;
};
export const itemsBy = (pred) => manifest.items.filter(pred);

/** Paths of an item's files (default: primary + sidecars, the set a user would drop together). */
export function paths(it, roles = ['primary', 'sidecar']) {
  return it.files.filter((f) => roles.includes(f.role ?? 'primary')).map((f) => filePath(it, f));
}
export const onDisk = (it, roles) => {
  const p = paths(it, roles);
  return p.length > 0 && p.every(existsSync);
};

export function truth(id) {
  const p = join(CORPUS, '_truth', `${id}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export const matrix = () => JSON.parse(readFileSync(join(REPO, 'reports/campaign/matrix.json'), 'utf8'));

/** |actual − expected| ≤ tol, with the oracle named in the message. */
export function assertWithin(actual, expected, tol, what) {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected} (tol ${tol})`).toBeLessThanOrEqual(tol);
}

/** Wait until every layer has rendered or failed (same rule as samples.spec.js). */
export function settled(frame, timeout = 60_000) {
  return frame
    .waitForFunction(() => {
      const ls = [...window.gisworkbench.layers.values()];
      return ls.length && ls.every((l) => l.error || (l.lutTex && !l.tiles?.loading));
    }, null, { timeout })
    .then(() => true, () => false);
}

/**
 * Wait until whatever the files became is ready: image layers rendered (or failed), or a point
 * cloud, vector layer or video clip registered, or an import error logged. Point clouds and video
 * never create image layers, so waiting on `settled` alone cost the full timeout for them.
 */
export function settledAny(frame, logBefore = 0, timeout = 120_000) {
  return frame
    .waitForFunction(
      (n0) => {
        const a = window.gisworkbench;
        const ls = [...a.layers.values()];
        if (ls.length && ls.every((l) => l.error || (l.lutTex && !l.tiles?.loading))) return true;
        if (a.store.all('pointcloud').length || a.store.all('vlayer').length || (a.fmv?.clips?.size ?? 0)) return !ls.length || ls.every((l) => l.error || l.lutTex);
        // Routes with no image layer (GPX graphics, glTF, packs, basemaps, recipes) are done once they
        // have logged their result: waiting on a layer that never comes cost the full timeout.
        if (!ls.length && a.importLog.length > n0) return true;
        return a.importLog.length > n0 && a.importLog.slice(n0).some((r) => r.errors?.length);
      },
      logBefore,
      { timeout, polling: 250 },
    )
    .then(() => true, () => false);
}

/** What the files became, by registry. */
export function registries(frame) {
  return frame.evaluate(() => {
    const a = window.gisworkbench;
    return { images: a.layers.size, vlayers: a.store.all('vlayer').length, features: a.store.all('feature').length, clouds: a.store.all('pointcloud').length, clips: a.fmv?.clips?.size ?? 0 };
  });
}

/** UI and model state that a command run is expected to change. */
export function snapshot(frame) {
  return frame.evaluate(() => {
    const app = window.gisworkbench;
    const q = (s) => [...document.querySelectorAll(s)];
    return {
      layers: app.layers.size,
      panes: q('[data-id^="pane:"], .pane').length,
      dialogs: q('[role="dialog"]').map((d) => d.getAttribute('aria-label')),
      toasts: q('.toasts .toast').map((t) => `${[...t.classList].find((c) => c.startsWith('toast-'))}: ${t.textContent}`),
      undo: app.undo?.undoStack?.length ?? null,
      active: app.activeLayer()?.id ?? null,
      chain: JSON.stringify(app.activeLayer()?.chain ?? null).length,
      body: document.body.innerHTML.length,
      // View, tool, toggles and open panels: navigation, display toggles and slider panels change only these.
      view: JSON.stringify(app.activePane()?.view ?? null),
      tool: app.tools?.current?.id ?? null,
      checked: [...app.commands.map.keys()].filter((c) => app.commands.checked(c)).join(','),
      panels: q('[role="region"].tool-panel, .tool-panel, .popover, [role="menu"]').length,
      records: ['graphic', 'feature', 'measurement', 'aoi', 'observation', 'chip', 'change', 'detection'].map((t) => app.store.all(t).length).join(','),
      selection: app.selection?.size ?? 0,
    };
  });
}

/**
 * Run a command the way the ribbon does and classify the outcome:
 *  'done' (settled), 'dialog' (opened UI; confirmed with defaults then closed), 'disabled',
 *  'stub' (planned toast), 'error' (threw / error toast / console error).
 * File pickers are answered with `pick` (or cancelled); downloads are saved under reports/campaign/out.
 */
export async function runCommand(page, frame, id, { pick = [], logs = [], confirm = true, wait = 15_000, settle = 0, outDir = join(REPO, 'reports/campaign/out') } = {}) {
  mkdirSync(outDir, { recursive: true });
  const downloads = [];
  const onDl = async (d) => {
    const p = join(outDir, `${id}-${d.suggestedFilename()}`);
    await d.saveAs(p).catch(() => {});
    downloads.push(p);
  };
  const onChooser = (fc) => fc.setFiles(pick.filter(existsSync)).catch(() => {});
  page.on('download', onDl);
  page.on('filechooser', onChooser);
  const before = await snapshot(frame);
  const logStart = logs.length;
  // Toasts as issued (app.toastLog, 2.0.4; else c50's window.__teToasts recorder) include ones that wait
  // their turn behind the 3-slot snackbar or were dismissed before the harness looked.
  const toastStart = await frame.evaluate(() => (window.gisworkbench.toastLog ? { t: Date.now() } : window.__teToasts ? { n: window.__teToasts.length } : null));
  const enabled = await frame.evaluate((c) => window.gisworkbench.commands.enabled(c), id);
  let outcome = enabled ? 'done' : 'disabled';
  const dialogs = [];
  if (enabled) {
    await frame.evaluate((c) => {
      window.__teRun = { state: 'pending' };
      Promise.resolve(window.gisworkbench.commands.run(c)).then(
        () => (window.__teRun.state = 'done'),
        (e) => Object.assign(window.__teRun, { state: 'error', error: String(e?.message ?? e) }),
      );
    }, id);
    const t0 = Date.now();
    let confirmed = false;
    while (Date.now() - t0 < wait) {
      const st = await frame.evaluate(() => ({ run: window.__teRun.state, dlg: [...document.querySelectorAll('.dlg[role="dialog"]')].map((d) => d.getAttribute('aria-label')) }));
      if (st.dlg.length) {
        dialogs.push(...st.dlg.filter((d) => !dialogs.includes(d)));
        outcome = 'dialog';
        // Confirm once with the dialog's defaults (exercises the function), then dismiss anything left.
        if (confirm && !confirmed) {
          confirmed = true;
          const ok = frame.locator('.dlg .dlg-buttons button', { hasText: /^(OK|Apply|Run|Start|Save|Export|Create|Open|Detect|Extract|Select|Chip|Load|Fit|Jump)$/ }).first();
          if (await ok.count()) await ok.click({ timeout: 2000 }).catch(() => {});
          await frame.waitForTimeout(500);
          continue;
        }
        await frame.locator('body').press('Escape').catch(() => {});
        await frame.waitForTimeout(200);
        continue;
      }
      if (st.run !== 'pending') break;
      await frame.waitForTimeout(150);
    }
    const run = await frame.evaluate(() => window.__teRun);
    if (run.state === 'error') outcome = 'error';
    if (run.state === 'pending' && outcome === 'done') outcome = 'pending';
    for (let i = 0; i < 4 && (await frame.locator('.dlg[role="dialog"]').count()); i++) await frame.locator('body').press('Escape').catch(() => {});
    // settle: jobs a dialog started outlive it; wait (bounded) for the worker pool to drain so their
    // errors land on this command, not the next one.
    if (settle) await frame.waitForFunction(() => { const s = window.gisworkbench.pool?.stats?.(); return !s || (s.running === 0 && s.queued === 0); }, null, { timeout: settle, polling: 250 }).catch(() => { if (outcome === 'done' || outcome === 'dialog') outcome = 'pending'; });
  }
  const after = await snapshot(frame);
  page.off('download', onDl);
  page.off('filechooser', onChooser);
  const newToasts = toastStart === null ? after.toasts.filter((t) => !before.toasts.includes(t)) : await frame.evaluate((s) => (s.t !== undefined ? window.gisworkbench.toastLog.filter((x) => x.t >= s.t).map((x) => `toast-${x.kind}: ${x.message}`) : window.__teToasts.slice(s.n)), toastStart);
  if (newToasts.some((t) => /planned for R\d/.test(t))) outcome = 'stub';
  const errors = [...logs.slice(logStart), ...newToasts.filter((t) => t.startsWith('toast-error'))];
  if (errors.length && outcome !== 'stub') outcome = 'error';
  const changed = Object.keys(before).filter((k) => k !== 'toasts' && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  return { id, enabled, outcome, dialogs, toasts: newToasts, errors, changed, downloads };
}

/** Append a JSON result line for the campaign report. */
export function record(spec, project, result) {
  // TE_RUN separates runs (e.g. a verification on dist-te/) from the phase results.
  const dir = join(REPO, 'reports/campaign/results', process.env.TE_RUN ?? '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${spec}-${project}-${String(result.key ?? result.id).replace(/[^\w.-]+/g, '_')}.json`), JSON.stringify({ spec, project, when: new Date().toISOString(), ...result }, null, 1));
}

export { itemDir };
