// Boot (after the hashed boot loader): detect the run mode, compile the core WASM bundle,
// start the renderer and worker pool, build the shell, load features, then set
// data-ready="1" (the E2E tests wait for it). A failing feature never stops the tool.

import { App, PREFS_KEY } from './app.js';
import { Core } from './wasm/core.js';
import { WorkerPool } from './workers/pool.js';
import { Renderer } from './render/renderer.js';
import { detectRunMode } from './host/runmode.js';
import { Desktop } from './shell/desktop.js';
import { applyTheme, watchSystemTheme } from './shell/theme.js';
import { Keys } from './input/keys.js';
import { Palette } from './shell/palette.js';
import { Tooltips } from './shell/tooltip.js';
import { AppShell } from './shell2/appshell.js';
import { Personas } from './shell2/personas.js';
import { setToolHost } from './shell/dialogs.js';
import { h } from './shell/dom.js';
import { FEATURES } from './features/index.js';
import { captureTemplate } from './storage/selfsave.js';
import { initI18n, availableLocales } from './i18n/load.js';
import { t, tr, msgOf } from './i18n/index.js';
import * as fmt from './i18n/format.js';
import { relayCallback } from './connectors/auth.js';
import { phoneNotice } from './shell/phone-notice.js';
import { Activity } from './shell/activity.js';

/** An error's message in the UI language; a thrown string as it is. */
const shown = (e) => (e && typeof e === 'object' ? msgOf(e) : String(e ?? ''));

/** The user's own preference, read before the App exists (for the start-up failure screen). */
function earlyPrefs() {
  return {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')?.[k];
      } catch {
        return undefined;
      }
    },
  };
}

async function boot() {
  const marks = [];
  const mark = (what) => marks.push([what, Math.round(performance.now())]);
  captureTemplate(); // before the app changes the DOM (self-save keeps hashed scripts intact)
  const gw = globalThis.__gw;
  const root = document.getElementById('app');
  // A sign-in window of the hosted copy coming back from the identity provider (REQ-GAP-09):
  // hand the code to the waiting page and stop; this window does not boot the app.
  if (relayCallback()) {
    await initI18n({ gw, prefs: earlyPrefs(), log: () => {} }).catch(() => {});
    root.appendChild(h('div', { class: 'boot-fail', role: 'status' }, h('h1', {}, t('Sign-in finished')), h('p', {}, t('You can close this window and return to GIS Workbench.'))));
    document.body.dataset.ready = 'signin';
    setTimeout(() => window.close(), 400);
    return;
  }
  const runMode = await detectRunMode();
  mark('run mode');
  document.documentElement.dataset.runmode = runMode.mode;
  if (!runMode.caps.webgl2 || !runMode.caps.wasm) {
    // This screen comes before the App: its locale is the user's preference or the browser's languages.
    await initI18n({ gw, prefs: earlyPrefs(), log: () => {} }).catch(() => {});
    root.appendChild(h('div', { class: 'boot-fail', role: 'alert' }, h('h1', {}, t('GIS Workbench cannot start here')), h('ul', {}, runMode.problems.map((p) => h('li', {}, tr(p)))), h('p', {}, t('Use Google Chrome or Microsoft Edge 120 or later with WebGL2 enabled.'))));
    document.body.dataset.ready = 'fail';
    return;
  }
  const coreModule = await gw.wasm('wasm-core');
  const core = new Core(coreModule);
  const app = new App({ gw, runMode, core });
  globalThis.gisworkbench = app; // automation console (REQ-ARC-17, R1 for the full API)
  // The UI locale comes before any chrome is built (REQ-L10N-01); English on any failure.
  app.i18n = await initI18n(app);
  app.fmt = fmt; // display formatters in the UI locale and units (automation, tests)
  mark('locale');
  // A failure outside a command (a timer, a listener, a promise nobody awaits) goes to the
  // message log for Copy Diagnostics and, once per message, to the user (GUI-037).
  const told = new Set();
  const unexpected = (what, err) => {
    if (err?.name === 'AbortError') return;
    const msg = err?.message ?? String(err ?? 'unknown error');
    const at = err?.stack?.split('\n').slice(1, 4).map((s) => s.trim()).join(' ← ');
    app.log('error', `${what}: ${msg}${at ? ` (${at})` : ''}`);
    if (told.has(msg) || !app.desktop) return;
    told.add(msg);
    app.toast(t('Something went wrong: {msg}. Help ▸ About & Diagnostics ▸ Copy Diagnostics has the details.', { msg: shown(err) || msg }), { kind: 'error', ms: 8000 });
  };
  addEventListener('error', (e) => e.error && unexpected('uncaught error', e.error));
  addEventListener('unhandledrejection', (e) => unexpected('unhandled promise', e.reason));
  document.documentElement.dataset.layout = app.layoutMode();
  applyTheme(app);
  watchSystemTheme(app);

  const canvas = h('canvas', { id: 'gl', 'aria-hidden': 'true' });
  document.body.prepend(canvas);
  app.renderer = new Renderer(app, canvas);
  app.pool = new WorkerPool({ gw, modules: { core: coreModule, parse: gw.wasm('wasm-parse') }, lazyModules: { j2k: () => gw.wasm('wasm-j2k'), photo: () => gw.wasm('wasm-photo'), raster: () => gw.wasm('wasm-raster'), terrain: () => gw.wasm('wasm-terrain'), pointcloud: () => gw.wasm('wasm-pointcloud'), vector: () => gw.wasm('wasm-vector'), sar: () => gw.wasm('wasm-sar'), spectral: () => gw.wasm('wasm-spectral'), legacy: () => gw.wasm('wasm-legacy'), tiles: () => gw.wasm('wasm-tiles'), brotli: () => gw.wasm('wasm-brotli'), mpeg: () => gw.wasm('wasm-mpeg'), vendor: () => gw.wasm('wasm-vendor'), sqlite: () => gw.wasm('wasm-sqlite'), tin: () => gw.wasm('wasm-tin'), usgscsm: () => gw.wasm('wasm-usgscsm') } });
  // MBTiles in the decode worker (FC-05): the same verified sql.js script the main thread runs.
  app.pool.libs = { ...(app.pool.libs ?? {}), 'js-sqlite': async () => (await gw.bytes('js-sqlite')).slice() };
  app.activity = new Activity(app); // what is running, for how long (OD-2.27)
  app.keys = new Keys(app);
  app.desktop = new Desktop(app, root);
  app.palette = new Palette(app); // Ctrl+K (REQ-SHL-05)
  app.personas = new Personas(app); // workspace presets (REQ-SHL-12)
  document.documentElement.dataset.statusRows = String(app.personas.current()?.statusRows ?? (app.layoutMode() === 'classic' ? 2 : 1));
  app.tooltips = new Tooltips(app); // two-line tooltips (REQ-SHL-06)

  const mpId = app.newProject();
  app.desktop.init();
  app.shell = new AppShell(app, root); // Modern chrome around the desktop (REQ-SHL-01)
  app.shell.mount();
  setToolHost((spec) => (app.layoutMode() === 'modern' && app.activeMp() ? app.activeMp().docks.hostTool(spec) : null));
  // Features register commands, dock panels, tools and dialogs.
  mark('shell');
  const results = await Promise.allSettled(
    FEATURES.map(async (f) => {
      await f.install(app);
      mark(`feature ${f.name}`);
    }),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      app.log('error', `feature ${FEATURES[i].name} failed to load: ${r.reason?.message ?? r.reason}`);
      console.error(r.reason);
    }
  });
  const mp = app.desktop.addMultiport(mpId);
  mark('multiport');
  app.emit('ready', mp);
  mark('ready handlers');
  // Every Multiport gets every dock panel, however it is made (New Project, Open Project, Window ▸
  // New Window): a later one gets the panels the first one registered (GUI-045).
  const panelSpecs = [...mp.docks.registry.values()].filter((p) => !p.transient).map((p) => p.spec);
  const addMp = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const m = addMp(id);
    for (const s of panelSpecs) if (!m.docks.registry.has(s.id)) m.docks.register(s);
    return m;
  };
  // A persona's docks open at start; the first start offers the choice (REQ-SHL-12).
  const per = app.personas.current();
  if (per) app.personas.apply(per.id, { quiet: true });
  else app.personas.welcome();
  app.emit('state');
  mark('first state');
  app.bootMarks = marks; // Help ▸ About & Diagnostics and REQ-PRF-01 checks
  app.ensureGeoid().catch((e) => app.log('warn', `geoid: ${e.message}`));
  for (const p of runMode.problems) app.log('warn', p);
  if (runMode.problems.length) app.toast(runMode.problems.map((p) => tr(p)).join(' '), { kind: 'warn', ms: 8000 });
  if (app.i18n?.needPack) {
    const l = availableLocales(gw).find((x) => x.pack === app.i18n.needPack);
    app.toast(t('{language} needs its language pack ({file}). Open it with File ▸ Open ▸ Open Data Pack, or choose another language in Preferences ▸ Language.', { language: l?.name ?? app.i18n.requested, file: gw.manifest?.packs?.[app.i18n.needPack]?.file ?? `${app.i18n.needPack}.gwpack` }), { kind: 'warn', ms: 15000, action: { label: t('Open language pack…'), run: () => app.openLanguagePack?.(app.i18n.needPack) } });
  }
  app.bootMs = Math.round(performance.now() - gw.bootStart);
  document.body.dataset.ready = '1';
  // Full is desktop only (OD-2.23): a phone or tablet is pointed to GIS Workbench Lite.
  app.phoneNotice = (o) => phoneNotice(app, o);
  phoneNotice(app).catch((e) => app.log('warn', `phone notice: ${e.message}`));
}

boot().catch((e) => {
  console.error(e);
  document.body.dataset.ready = 'fail';
  const root = document.getElementById('app');
  root.textContent = t('GIS Workbench failed to start: {msg}', { msg: shown(e) });
});
