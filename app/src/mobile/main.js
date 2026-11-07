// GIS Workbench Lite (OD-2.23): the boot of the mobile build. The same core as Full (the App,
// WASM core, worker pool, renderer, formats, geo, i18n, storage and security) with the mobile
// shell (mobile/shell.js) in place of the desktop, the Ribbon and the docks, and only the feature
// modules of mobile/features.js. The commands Lite offers are data/lite-commands.json; every other
// command is Full only and says so (shell/commands.js liteGap).

import { App, PREFS_KEY } from '../app.js';
import { Core } from '../wasm/core.js';
import { WorkerPool } from '../workers/pool.js';
import { Renderer } from '../render/renderer.js';
import { detectRunMode } from '../host/runmode.js';
import { applyTheme, watchSystemTheme } from '../shell/theme.js';
import { Keys } from '../input/keys.js';
import { h } from '../shell/dom.js';
import { setToolHost } from '../shell/dialogs.js';
import { NetLog } from '../ai/netlog.js';
import { captureTemplate } from '../storage/selfsave.js';
import { initI18n, availableLocales } from '../i18n/load.js';
import { t, tr, msgOf } from '../i18n/index.js';
import * as fmt from '../i18n/format.js';
import { MobileShell } from './shell.js';
import { LITE_FEATURES } from './features.js';
import { Activity } from '../shell/activity.js';

const shown = (e) => (e && typeof e === 'object' ? msgOf(e) : String(e ?? ''));

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
  captureTemplate();
  const gw = globalThis.__gw;
  const root = document.getElementById('app');
  const runMode = await detectRunMode();
  mark('run mode');
  document.documentElement.dataset.runmode = runMode.mode;
  document.documentElement.dataset.edition = 'lite';
  if (!runMode.caps.webgl2 || !runMode.caps.wasm) {
    await initI18n({ gw, prefs: earlyPrefs(), log: () => {} }).catch(() => {});
    root.appendChild(h('div', { class: 'boot-fail', role: 'alert' }, h('h1', {}, t('GIS Workbench cannot start here')), h('ul', {}, runMode.problems.map((p) => h('li', {}, tr(p)))), h('p', {}, t('Use Google Chrome, Microsoft Edge or Safari with WebGL2 enabled.'))));
    document.body.dataset.ready = 'fail';
    return;
  }
  const coreModule = await gw.wasm('wasm-core');
  const core = new Core(coreModule);
  const app = new App({ gw, runMode, core });
  globalThis.gisworkbench = app;
  // Lite has one layout (the mobile shell) and follows the system's light or dark setting.
  app.layoutMode = () => 'modern';
  app.edition = 'lite';
  app.i18n = await initI18n(app);
  app.fmt = fmt;
  mark('locale');
  const told = new Set();
  const unexpected = (what, err) => {
    if (err?.name === 'AbortError') return;
    const msg = err?.message ?? String(err ?? 'unknown error');
    const at = err?.stack?.split('\n').slice(1, 4).map((s) => s.trim()).join(' ← ');
    app.log('error', `${what}: ${msg}${at ? ` (${at})` : ''}`);
    if (told.has(msg) || !app.shell) return;
    told.add(msg);
    app.toast(t('Something went wrong: {msg}. Tools ▸ About has the diagnostics.', { msg: shown(err) || msg }), { kind: 'error', ms: 8000 });
  };
  addEventListener('error', (e) => e.error && unexpected('uncaught error', e.error));
  addEventListener('unhandledrejection', (e) => unexpected('unhandled promise', e.reason));
  document.documentElement.dataset.layout = 'modern';
  document.documentElement.dataset.statusRows = '1';
  applyTheme(app);
  watchSystemTheme(app);

  const canvas = h('canvas', { id: 'gl', 'aria-hidden': 'true' });
  document.body.prepend(canvas);
  app.renderer = new Renderer(app, canvas);
  // The decoders Lite carries; a block it leaves out is refused by name (boot.js, manifest.omitted).
  app.pool = new WorkerPool({ gw, modules: { core: coreModule, parse: gw.wasm('wasm-parse') }, lazyModules: { j2k: () => gw.wasm('wasm-j2k'), raster: () => gw.wasm('wasm-raster'), vector: () => gw.wasm('wasm-vector'), legacy: () => gw.wasm('wasm-legacy'), tiles: () => gw.wasm('wasm-tiles'), brotli: () => gw.wasm('wasm-brotli'), sqlite: () => gw.wasm('wasm-sqlite'), terrain: () => gw.wasm('wasm-terrain') } });
  app.pool.libs = { ...(app.pool.libs ?? {}), 'js-sqlite': async () => (await gw.bytes('js-sqlite')).slice() };
  app.activity = new Activity(app); // what is running, for how long (OD-2.27)
  app.netlog = new NetLog(app); // every request in a log, gated by Online/Offline (REQ-SEC-12)
  app.keys = new Keys(app); // a hardware keyboard on a tablet still works (Esc, Enter, arrows)

  const mpId = app.newProject();
  app.shell = new MobileShell(app, root);
  app.desktop = app.shell.desk; // the one view, in the shape the shared features expect
  app.shell.mount();
  setToolHost(() => null);
  mark('shell');
  const results = await Promise.allSettled(
    LITE_FEATURES.map(async (f) => {
      await f.install(app);
      mark(`feature ${f.name}`);
    }),
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      app.log('error', `feature ${LITE_FEATURES[i].name} failed to load: ${r.reason?.message ?? r.reason}`);
      console.error(r.reason);
    }
  });
  const mp = app.desktop.addMultiport(mpId);
  mark('view');
  app.emit('ready', mp);
  app._ready = true;
  app.shell.ready();
  app.emit('state');
  mark('first state');
  app.bootMarks = marks;
  app.ensureGeoid().catch((e) => app.log('warn', `geoid: ${e.message}`));
  for (const p of runMode.problems) app.log('warn', p);
  if (runMode.problems.length) app.toast(runMode.problems.map((p) => tr(p)).join(' '), { kind: 'warn', ms: 8000 });
  if (app.i18n?.needPack) {
    const l = availableLocales(gw).find((x) => x.pack === app.i18n.needPack);
    app.toast(t('{language} needs its language pack ({file}). Open it with Open ▸ Language or data pack, or choose another language in Preferences.', { language: l?.name ?? app.i18n.requested, file: gw.manifest?.packs?.[app.i18n.needPack]?.file ?? `${app.i18n.needPack}.gwpack` }), { kind: 'warn', ms: 15000, action: { label: t('Open language pack…'), run: () => app.openLanguagePack?.(app.i18n.needPack) } });
  }
  app.bootMs = Math.round(performance.now() - gw.bootStart);
  document.body.dataset.ready = '1';
}

boot().catch((e) => {
  console.error(e);
  document.body.dataset.ready = 'fail';
  const root = document.getElementById('app');
  root.textContent = t('GIS Workbench failed to start: {msg}', { msg: shown(e) });
});
