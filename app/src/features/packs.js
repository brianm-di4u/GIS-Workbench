// Data packs in the UI (REQ-ARC-14) and their consumers: the EGM2008 geoid, PROJ for CRSs outside
// the embedded table (REQ-GEO-12), h5wasm for HDF5 hyperspectral products (REQ-MSI-02) and the
// local AI pack (SlimSAM smart select, REQ-EXT-18 / REQ-AI-18; see ai-sam.js).

import { PackStore, entryUrl } from '../storage/packs.js';
import { pickFiles } from '../storage/files.js';
import { modal } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { registerPackDef, crsOf } from '../geo/crs.js';
import { fmtBytes, errorText } from '../core/util.js';
import { t, N_, tr, msgOf, locale, PSEUDO } from '../i18n/index.js';
import { int } from '../i18n/format.js';
import { availableLocales } from '../i18n/load.js';

export const name = 'packs';

function runClassic(url) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = res;
    s.onerror = () => rej(new Error('pack script failed to run'));
    document.head.appendChild(s);
  });
}

export async function install(app) {
  const C = app.commands;
  const packs = new PackStore(app);
  app.packs = packs;
  packs.restore().then((kept) => {
    // Geoid packs kept from earlier sessions come back without a prompt when permission persists.
    if (kept.some((k) => k.name === 'geoid')) packs.get('geoid', { prompt: false }).then((p) => p && useGeoid(p)).catch(() => {});
  });
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(msgOf(e), { kind: 'error', ms: 9000 });
    }
  };

  async function openPackFiles(files) {
    const out = [];
    for (const f of files) {
      let p;
      try {
        p = await packs.open(f);
      } catch (e) {
        app.importLog.push({ file: f.name, errors: [errorText(e)], warnings: [] });
        throw e;
      }
      out.push(p);
      app.importLog.push({ file: f.name, errors: [], warnings: [] });
      app.toast(t('Data pack {title} {version} verified ({n, plural, one {# entry} other {# entries}}, SHA-256 checked)', { title: packTitle(p), version: p.version, n: p.entries.size }), { kind: 'info' });
      if (p.name === 'geoid') await useGeoid(p);
      if (p.name === 'proj') await proj.ensure();
    }
    // A locale pack opened from anywhere (File ▸ Open Data Pack, drag and drop) offers the restart
    // that switches the interface to it (OD-2.22).
    const lp = out.find((p) => p.name.startsWith('locale-'));
    if (lp) {
      const tag = lp.name.slice('locale-'.length);
      if ((app.prefs.get('locale') ?? 'auto') === 'auto' || app.prefs.get('locale') !== tag) app.prefs.set('locale', tag);
      app.toast(t('The {language} language pack is ready. The interface changes when GIS Workbench restarts.', { language: availableLocales(app.gw).find((l) => l.tag === tag)?.name ?? tag }), { kind: 'info', ms: 15000, action: { label: t('Restart now'), run: () => location.reload() } });
    }
    app.emit('state');
    return out;
  }

  // ---- EGM2008 ----
  async function useGeoid(p) {
    const pgm = p.entries.get('egm2008-5.pgm');
    app.core.loadGeoid(pgm, { kind: 1, name: 'EGM2008' });
    app._geoid = Promise.resolve('EGM2008');
    app._geoidLoaded = true;
    for (const mp of app.desktop?.multiports ?? []) mp.status?.set({ vdatum: 'MSL(EGM2008)' });
    app.emit('geoid');
  }
  async function useEgm96() {
    app._geoid = null;
    await app.ensureGeoid();
    for (const mp of app.desktop?.multiports ?? []) mp.status?.set({ vdatum: 'MSL(EGM96)' });
  }

  // ---- PROJ (REQ-GEO-12) ----
  const proj = {
    mod: null,
    ctx: 0,
    async ensure() {
      if (this.mod) return this.mod;
      const p = await packs.require('proj', 'PROJ');
      const url = entryUrl(p, 'proj.js');
      try {
        await runClassic(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const M = await globalThis.PROJModule({ wasmBinary: p.entries.get('proj.wasm'), locateFile: (f) => f, print: () => {}, printErr: (t) => app.log('info', `PROJ: ${t}`) });
      try {
        M.FS.mkdir('/gw-proj');
      } catch {
        /* exists */
      }
      M.FS.writeFile('/gw-proj/proj.db', p.entries.get('proj.db'));
      this.ctx = M._proj_context_create();
      M.ccall('proj_context_set_database_path', 'number', ['number', 'string', 'number', 'number'], [this.ctx, '/gw-proj/proj.db', 0, 0]);
      M._proj_context_set_enable_network(this.ctx, 0);
      // REQ-GAP-16: grid files go in /gw-proj too (mountGrids), so PROJ searches it.
      const dir = '/gw-proj';
      const n = M.lengthBytesUTF8(dir) + 1;
      const sp = M._malloc(n);
      M.stringToUTF8(dir, sp, n);
      const arr = M._malloc(4);
      new Uint32Array(M.HEAPF64.buffer, arr, 1)[0] = sp;
      M._proj_context_set_search_paths(this.ctx, 1, arr);
      this.mod = M;
      this.grids = new Set();
      return M;
    },
    /**
     * REQ-GAP-16: make grid files available to PROJ ([{file, bytes}]): written to its in-memory
     * file system, so proj_create_crs_to_crs picks grid-based operations from then on.
     */
    async mountGrids(list) {
      const M = await this.ensure();
      let added = 0;
      for (const g of list) {
        if (this.grids.has(g.file)) continue;
        M.FS.writeFile(`/gw-proj/${g.file}`, g.bytes);
        this.grids.add(g.file);
        added++;
      }
      // New pipelines from now on; the old ones stay alive (converters made earlier may hold them).
      if (added && this._pipes) this._pipes.clear();
      return added;
    },
    _create(text) {
      const M = this.mod;
      const pj = M.ccall('proj_create', 'number', ['number', 'string'], [this.ctx, text]);
      if (!pj) throw new Error(`PROJ does not know ${text}`);
      return pj;
    },
    /** EPSG code → {def (PROJ.4 string for proj4js), name, wkt}. */
    async describe(code) {
      const M = await this.ensure();
      const pj = this._create(`EPSG:${code}`);
      // Bound to WGS 84 (as GDAL does) so the PROJ.4 form carries +towgs84 for proj4js.
      const bound = M._proj_crs_create_bound_crs_to_WGS84(this.ctx, pj, 0);
      try {
        const sp = M.ccall('proj_as_proj_string', 'number', ['number', 'number', 'number', 'number'], [this.ctx, bound || pj, 1, 0]); // PJ_PROJ_4
        const np = M._proj_get_name(pj);
        const wp = M.ccall('proj_as_wkt', 'number', ['number', 'number', 'number', 'number'], [this.ctx, pj, 3, 0]); // PJ_WKT1_GDAL
        return { def: sp ? M.UTF8ToString(sp).replace(/\s*\+type=crs/, '') : null, name: np ? M.UTF8ToString(np) : '', wkt: wp ? M.UTF8ToString(wp) : '' };
      } finally {
        if (bound) M._proj_destroy(bound);
        M._proj_destroy(pj);
      }
    },
    /**
     * Register an EPSG code from the pack: the PROJ.4 form for display and export, and PROJ's own
     * transformation to WGS 84 for models (proj4js would miss datum shifts PROJ.4 strings omit).
     */
    async defineEpsg(code) {
      const d = await this.describe(code);
      if (!d.def) throw new Error(`PROJ has no PROJ.4 form for EPSG:${code}`);
      // The pipeline is looked up per call, so grids mounted later (REQ-GAP-16) take effect.
      const fwd = () => this.pipe(`EPSG:${code}`, 'EPSG:4326');
      fwd();
      const conv = {
        toLonLat: (x, y) => this.run(fwd(), [[x, y, 0]], 1)[0].slice(0, 2),
        fromLonLat: (lon, lat) => this.run(fwd(), [[lon, lat, 0]], -1)[0].slice(0, 2),
      };
      registerPackDef(code, d.def, d.name, conv);
      return d;
    },
    /** A normalised (x = lon/easting) transformation object, kept for reuse. */
    pipe(src, dst) {
      const M = this.mod;
      this._pipes ??= new Map();
      const k = `${src}|${dst}`;
      if (!this._pipes.has(k)) {
        const raw = M.ccall('proj_create_crs_to_crs', 'number', ['number', 'string', 'string', 'number'], [this.ctx, src, dst, 0]);
        if (!raw) throw new Error(`PROJ cannot transform ${src} → ${dst}`);
        const pj = M._proj_normalize_for_visualization(this.ctx, raw);
        M._proj_destroy(raw);
        this._pipes.set(k, pj);
      }
      return this._pipes.get(k);
    },
    /** Run a transformation on points (dir 1 forward, −1 inverse). */
    run(pj, pts, dir = 1) {
      const M = this.mod;
      const n = pts.length;
      const buf = M._malloc(n * 32);
      try {
        const f = new Float64Array(M.HEAPF64.buffer, buf, n * 4);
        pts.forEach((p, i) => f.set([p[0], p[1], p[2] ?? 0, 0], 4 * i));
        M._proj_trans_array(pj, dir, n, buf);
        const g = new Float64Array(M.HEAPF64.buffer, buf, n * 4);
        return pts.map((_, i) => [g[4 * i], g[4 * i + 1], g[4 * i + 2]]);
      } finally {
        M._free(buf);
      }
    },
    /** Transform points with PROJ itself (reference): pts [[x, y, z?]] from src to dst (axis order normalised to x=lon/easting). */
    async transform(src, dst, pts) {
      await this.ensure();
      return this.run(this.pipe(src, dst), pts, 1);
    },
    /** Before models are built for an opened file: define EPSG codes only the pack knows. */
    async prepare(codes) {
      if (!packs.loaded.has('proj') && !packs.stored.has('proj')) return [];
      const out = [];
      for (const c of new Set(codes.filter((x) => Number.isFinite(x) && x > 0 && x !== 32767))) {
        if (crsOf({ epsg: c })) continue;
        try {
          out.push({ code: c, ...(await this.defineEpsg(c)) });
        } catch (e) {
          app.log('info', `PROJ pack: EPSG:${c}: ${e.message}`);
        }
      }
      return out;
    },
  };
  app.proj = proj;

  // ---- pack libraries for workers: h5wasm (decode, REQ-MSI-02) and onnxruntime-web, WASM or WebGPU build (ai) ----
  app.pool.libs = {
    ...(app.pool.libs ?? {}),
    h5wasm: async () => (await packs.require('hdf5', N_('Reading HDF5'))).entries.get('h5wasm.js').slice(),
    ort: async () => (await packs.require('ai', N_('Local AI'))).entries.get('ort.wasm.min.js').slice(),
    ortgpu: async () => (await packs.require('ai', N_('Local AI'))).entries.get('ort.webgpu.min.js').slice(),
  };

  // ---- UI ----
  /**
   * A pack's title for display. Locale packs (locale-<tag>) are named from the locale registry in
   * the UI language ("German interface (Deutsch)" in English); this build's packs show their
   * build/packs.mjs title translated (build/i18n.mjs extracts them); any other pack keeps the
   * title its pack.json gives.
   */
  function packTitle(x) {
    const name = x.name ?? '';
    const tag = /^locale-(.+)$/.exec(name)?.[1];
    const known = x.known ?? (name ? packs.known(name) : null);
    const title = known?.title ?? x.loaded?.title ?? x.title ?? name;
    if (!tag) return known?.title ? tr(known.title) : title;
    const l = availableLocales(app.gw).find((r) => r.tag === tag);
    if (!l) return title;
    let language = l.english;
    const ui = locale();
    if (ui !== 'en' && !PSEUDO[ui]) {
      try {
        language = new Intl.DisplayNames([ui], { type: 'language' }).of(tag) ?? l.english;
      } catch {
        /* the English name */
      }
    }
    return l.name && l.name !== language ? t('{language} interface ({native})', { language, native: l.name }) : t('{language} interface', { language });
  }

  async function manage() {
    const rows = packs.list().map((x) => {
      const st = x.loaded ? t('loaded ({version}, {n, plural, one {# entry} other {# entries}} verified)', { version: x.loaded.version, n: x.loaded.entries.size }) : x.stored ? t('kept from an earlier session ({version})', { version: x.stored.version }) : t('not loaded');
      return h('tr', { 'data-pack': x.name }, h('td', {}, packTitle(x)), h('td', {}, x.known ? `${x.known.file} · ${fmtBytes(x.known.size)}` : t('not part of this build (data only)')), h('td', {}, st));
    });
    const geoidRow = h('p', { class: 'hint' }, app.core.geoidName ? t('Geoid in use: {geoid}.', { geoid: app.core.geoidName }) : t('Geoid in use: none loaded.'));
    const b = await modal({
      title: t('Data Packs'),
      body: h('div', {}, h('table', { class: 'tbl', 'data-id': 'packs-table' }, h('thead', {}, h('tr', {}, h('th', {}, t('Pack')), h('th', {}, t('File')), h('th', {}, t('Status')))), h('tbody', {}, ...rows)), geoidRow, h('p', { class: 'hint' }, t('A pack is verified entry by entry against its pack.json, and its code against this build\'s manifest, every time it is read.'))),
      buttons: [
        { label: t('Open Pack…'), value: 'open', primary: true },
        { label: t('Use EGM96'), value: 'egm96' },
        { label: t('Close'), value: 'close' },
      ],
      width: 760,
      id: 'packs',
    });
    if (b === 'open') await openPackFiles(await pickFiles(app, { accept: ['.gwpack', '.zip'], description: t('GIS Workbench data pack') }));
    if (b === 'egm96') await app.useEgm96();
  }

  C.implement('file.openpack', { run: run(async () => openPackFiles(await pickFiles(app, { accept: ['.gwpack', '.zip'], description: t('GIS Workbench data pack') }))) });
  C.implement('packs.manage', { run: run(() => manage()) });
  // The Add-Ins ▸ Packs ribbon buttons.
  C.implement('pack.load', { run: () => C.run('file.openpack') });
  C.implement('pack.list', { run: () => C.run('packs.manage') });
  app.openPackFiles = openPackFiles;
  /** Ask for a language pack file and keep it (Preferences ▸ Language and the start notice). */
  app.openLanguagePack = run(async (want) => {
    const files = await pickFiles(app, { multiple: false, accept: ['.gwpack'], description: t('GIS Workbench language pack') });
    if (!files?.length) return;
    const [p] = await openPackFiles(files);
    if (want && p && p.name !== want) app.toast(t('That file is the {title} pack, not the one asked for ({file}).', { title: packTitle(p), file: app.gw?.manifest?.packs?.[want]?.file ?? `${want}.gwpack` }), { kind: 'warn', ms: 9000 });
  });
  app.packTitle = packTitle;
  app.splitPackFiles = (files) => ({ packs: files.filter((f) => /\.gwpack$/i.test(f.name)), rest: files.filter((f) => !/\.gwpack$/i.test(f.name)) });
  app.useGeoidPack = async () => useGeoid(await packs.require('geoid', 'EGM2008'));
  app.useEgm96 = useEgm96;
}
