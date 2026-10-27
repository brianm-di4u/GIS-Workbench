// Boot (after the hashed boot loader): detect the run mode, compile the core WASM bundle,
// start the renderer and worker pool, build the shell, load features, then set
// data-ready="1" (the E2E tests wait for it). A failing feature never stops the tool.

import { App } from './app.js';
import { Core } from './wasm/core.js';
import { WorkerPool } from './workers/pool.js';
import { Renderer } from './render/renderer.js';
import { detectRunMode } from './host/runmode.js';
import { Desktop } from './shell/desktop.js';
import { Keys } from './input/keys.js';
import { h } from './shell/dom.js';
import { FEATURES } from './features/index.js';
import { captureTemplate } from './storage/selfsave.js';

async function boot() {
  const marks = [];
  const mark = (what) => marks.push([what, Math.round(performance.now())]);
  captureTemplate(); // before the app changes the DOM (self-save keeps hashed scripts intact)
  const gw = globalThis.__gw;
  const root = document.getElementById('app');
  const runMode = await detectRunMode();
  mark('run mode');
  document.documentElement.dataset.runmode = runMode.mode;
  if (!runMode.caps.webgl2 || !runMode.caps.wasm) {
    root.appendChild(h('div', { class: 'boot-fail', role: 'alert' }, h('h1', {}, 'GIS Workbench cannot start here'), h('ul', {}, runMode.problems.map((p) => h('li', {}, p))), h('p', {}, 'Use Google Chrome or Microsoft Edge 120 or later with WebGL2 enabled.')));
    document.body.dataset.ready = 'fail';
    return;
  }
  const coreModule = await gw.wasm('wasm-core');
  const core = new Core(coreModule);
  const app = new App({ gw, runMode, core });
  globalThis.gisworkbench = app; // automation console (REQ-ARC-17, R1 for the full API)
  document.documentElement.dataset.theme = app.prefs.get('theme') ?? 'grey';

  const canvas = h('canvas', { id: 'gl', 'aria-hidden': 'true' });
  document.body.prepend(canvas);
  app.renderer = new Renderer(app, canvas);
  app.pool = new WorkerPool({ gw, modules: { core: coreModule, parse: gw.wasm('wasm-parse') }, lazyModules: { j2k: () => gw.wasm('wasm-j2k'), photo: () => gw.wasm('wasm-photo'), raster: () => gw.wasm('wasm-raster'), terrain: () => gw.wasm('wasm-terrain'), pointcloud: () => gw.wasm('wasm-pointcloud'), vector: () => gw.wasm('wasm-vector'), sar: () => gw.wasm('wasm-sar'), spectral: () => gw.wasm('wasm-spectral') } });
  app.keys = new Keys(app);
  app.desktop = new Desktop(app, root);

  const mpId = app.newProject();
  app.desktop.init();
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
  app.emit('state');
  mark('first state');
  app.bootMarks = marks; // Help ▸ About & Diagnostics and REQ-PRF-01 checks
  app.ensureGeoid().catch((e) => app.log('warn', `geoid: ${e.message}`));
  for (const p of runMode.problems) app.log('warn', p);
  if (runMode.problems.length) app.toast(runMode.problems.join(' '), { kind: 'warn', ms: 8000 });
  app.bootMs = Math.round(performance.now() - gw.bootStart);
  document.body.dataset.ready = '1';
}

boot().catch((e) => {
  console.error(e);
  document.body.dataset.ready = 'fail';
  const root = document.getElementById('app');
  root.textContent = `GIS Workbench failed to start: ${e.message}`;
});
