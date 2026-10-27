// The App: one place that owns the store, undo, commands, preferences, the WASM core, the
// worker pool, the renderer, layers, terrain and the shell. Feature modules receive it.

import { Store } from './core/store.js';
import { UndoManager } from './core/undo.js';
import { Emitter, newId } from './core/util.js';
import { Commands } from './shell/commands.js';
import { toast } from './shell/toast.js';
import { highest, titleSuffix } from './security/marking.js';
import { Terrain } from './layers/terrain.js';

const PREFS_KEY = 'gisworkbench.prefs.v1';
const COMMON_KEY = 'gisworkbench.prefs.common.v1';

/**
 * Preferences (REQ-UI-11): User values over Common values (site defaults, which an
 * administrator can import as JSON); a locked Common value wins and the user cannot change it.
 */
class Prefs {
  constructor(storageOk) {
    this.ok = storageOk;
    this.mem = {};
    this.common = { values: {}, locked: [] };
    if (storageOk) {
      try {
        this.mem = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
      } catch {
        this.mem = {};
      }
      try {
        const c = JSON.parse(localStorage.getItem(COMMON_KEY) ?? 'null');
        if (c?.values) this.common = { values: c.values, locked: Array.isArray(c.locked) ? c.locked : [] };
      } catch {
        /* keep the empty Common set */
      }
    }
  }
  get(k) {
    if (this.isLocked(k)) return this.common.values[k];
    return this.mem[k] !== undefined ? this.mem[k] : this.common.values[k];
  }
  /** The user's own value (undefined when the Common value applies). */
  user(k) {
    return this.mem[k];
  }
  isLocked(k) {
    return this.common.locked.includes(k);
  }
  set(k, v) {
    if (this.isLocked(k)) return false;
    this.mem[k] = v;
    this.save(PREFS_KEY, this.mem);
    return true;
  }
  setCommon(k, v, { lock } = {}) {
    if (v === undefined) delete this.common.values[k];
    else this.common.values[k] = v;
    if (lock !== undefined) this.common.locked = lock ? [...new Set([...this.common.locked, k])] : this.common.locked.filter((x) => x !== k);
    this.save(COMMON_KEY, this.common);
  }
  /** Replace the Common set: {values, locked}. */
  importCommon(c) {
    if (!c || typeof c.values !== 'object') throw new Error('a Common preferences file holds {"values": {…}, "locked": […]}');
    this.common = { values: { ...c.values }, locked: Array.isArray(c.locked) ? c.locked.filter((x) => typeof x === 'string') : [] };
    this.save(COMMON_KEY, this.common);
  }
  save(key, v) {
    if (!this.ok) return;
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* storage blocked or full: keep the value in memory only */
    }
  }
}

export class App extends Emitter {
  constructor({ gw, runMode, core }) {
    super();
    this.gw = gw;
    this.build = gw.build;
    this.runMode = runMode;
    this.core = core;
    this.prefs = new Prefs(runMode.caps.localStorage);
    this.store = new Store();
    this.undo = new UndoManager(this.store);
    this.commands = new Commands(this);
    this.layers = new Map(); // layer id → runtime (ImageLayer)
    this.files = new Map(); // fileref id → {file, handle, sidecars, result}
    this.terrain = new Terrain(this);
    this.importLog = [];
    this.messages = [];
    this.selectedLayerId = null;
    this.softwareGl = !!runMode.caps.gl?.software;
    this.store.on('change', () => this.emit('state'));
    this.on('state', () => this.renderer?.invalidate());
  }

  toast(msg, opts) {
    return toast(msg, opts);
  }

  log(level, msg) {
    this.messages.push({ t: new Date().toISOString(), level, msg });
    if (this.messages.length > 500) this.messages.shift();
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(`[gw] ${msg}`);
  }

  project() {
    return this.store.all('project')[0];
  }

  /** Create the default project: one Multiport with one panel. */
  newProject() {
    this.store.load([]);
    this.undo.clear();
    for (const l of this.layers.values()) l.dispose();
    this.layers.clear();
    this.files.clear();
    const mpId = newId('mp');
    const paneId = newId('pane');
    this.store.transact(
      'New project',
      (tx) => {
        tx.create('project', { name: 'Untitled', created: new Date().toISOString(), marking: null, feedbackRecipient: '', origins: [], format: 1 }, 'project');
        tx.create('multiport', { name: 'Multiport_1', layout: '1x1', panes: [paneId] }, mpId);
        tx.create('pane', { multiport: mpId, layers: [], activeLayer: null }, paneId);
      },
      { kind: 'load' },
    );
    this.undo.clear();
    return mpId;
  }

  activeMp() {
    return this.desktop?.activeMp ?? this.desktop?.multiports[0];
  }

  activePane() {
    return this.activeMp()?.activePane;
  }

  activeLayer() {
    return this.activePane()?.activeLayer() ?? null;
  }

  /** Context for the contextual tab sets (REQ-UI-03). */
  ribbonContext(mp) {
    const p = mp?.activePane;
    const al = p?.activeLayer();
    return {
      activeLayer: al ? { kind: al.kind === 'dem' ? 'image' : al.kind, id: al.id } : p?.rec?.graphicsLayer ? { kind: 'graphics' } : null,
      imageLayerCount: p ? p.layers().filter((l) => l.kind === 'image').length : 0,
      hasDem: this.terrain.available || p?.layers().some((l) => l.kind === 'dem'),
      hasVectors: this.store.all('vlayer').length > 0,
      hasObservations: this.store.all('observation').length > 0 || this.store.all('detection').length > 0,
      stereo: !!p?.stereo,
      pointCloud: !!p?.view3d?.clouds.length,
      view3d: !!p?.view3d,
      video: !!p?.video,
      sar: !!p?.activeLayer?.()?.info?.sar,
      multiband: (p?.activeLayer?.()?.bands ?? 0) >= 3 && !p?.activeLayer?.()?.info?.sar,
    };
  }

  /** Highest marking on screen (all multiports), for exports, whiteboard and AI consent. */
  screenMarking() {
    const ms = [];
    for (const mp of this.desktop?.multiports ?? []) for (const p of mp.panes) ms.push(p.marking());
    const projectMark = this.project()?.marking;
    if (projectMark) ms.push(projectMark);
    return highest(ms);
  }

  markingSuffix(mp) {
    if (mp) return titleSuffix(highest(mp.panes.map((p) => p.marking())));
    return titleSuffix(this.screenMarking());
  }

  sunFor(layer, g) {
    // Sun from the image time and place when the metadata has no angles (REQ-GEO-11).
    const t = layer.info.datetime;
    if (!/^\d{14}$/.test(String(t ?? '').trim()) || !g) return null;
    const s = String(t).trim();
    const unix = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)) / 1000;
    const r = this.core.sun(unix, g.lat, g.lon);
    return { ...r, source: 'computed from IDATIM (NOAA/Meeus)' };
  }

  async ensureGeoid() {
    if (this._geoid) return this._geoid;
    this._geoid = (async () => {
      const bytes = await this.gw.bytes('data-egm96');
      const e = this.gw.manifest.blocks['data-egm96'];
      this.core.loadGeoid(bytes, { kind: 0, width: e.width, height: e.height, name: 'EGM96' });
      this.emit('geoid');
      return 'EGM96';
    })();
    return this._geoid;
  }
}
