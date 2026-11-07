// Feature catalogues beyond the built-in TDS 7.1 subset (REQ-GAP-52/53, GR-20): a user's own
// JSON catalogue (gw-catalog/1, see vector/schema.js) imported from the UI or the API, and full
// catalogues from data packs (entries named *.gwcatalog.json). An imported catalogue is kept in
// the project (a `catalog` record, saved in the .gwb) and in the settings (IndexedDB, so a large
// catalogue does not fill the preferences), as the user chooses; both come back on the next start
// or project open. Catalogues are data: they are checked by validateCatalog and never run.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { pickFiles } from '../storage/files.js';
import { validateCatalog, registerCatalog, getCatalog, listCatalogs, unregisterCatalog, DEFAULT_CATALOG } from '../vector/schema.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { int } from '../i18n/format.js';

const DB = 'gw-catalogs';
const STORE = 'catalogs';

function idb() {
  return new Promise((res, rej) => {
    if (!globalThis.indexedDB) return rej(new Error('IndexedDB is not available'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(out?.result ?? out);
      tx.onerror = () => rej(tx.error);
    });
  } finally {
    db.close();
  }
}

/** Parse catalogue text with no prototype keys. */
export function parseCatalogText(text) {
  let json;
  try {
    json = JSON.parse(text, (k, v) => (k === '__proto__' || k === 'constructor' ? undefined : v));
  } catch (e) {
    throw gwError('the file is not JSON ({msg})', { msg: e.message }, 'E_CATALOG_JSON');
  }
  return json;
}

export function installCatalogs(app) {
  const S = app.store;
  const C = app.commands;
  const source = new Map([[DEFAULT_CATALOG.id, 'builtin']]); // id → builtin | pack | user | geopackage
  const kept = new Map(); // id → Set('project' | 'settings')
  const keptOf = (id) => kept.get(id) ?? kept.set(id, new Set()).get(id);

  const info = (cat) => ({ id: cat.id, name: cat.name, version: cat.version ?? '', types: cat.types.length, attributes: Object.keys(cat.attributes).length, source: source.get(cat.id) ?? (String(cat.id).startsWith('gpkg:') ? 'geopackage' : 'user'), kept: [...(kept.get(cat.id) ?? [])] });

  /**
   * Import a catalogue (an object or JSON text) → its summary. keep: 'project', 'settings' or
   * 'both' (default). A catalogue with the id of a pack or the built-in one is refused.
   */
  async function importCatalog(json, { keep = 'both' } = {}) {
    const cat = validateCatalog(typeof json === 'string' ? parseCatalogText(json) : json);
    const was = source.get(cat.id);
    if (was === 'builtin' || was === 'pack') throw gwError('the catalogue id {id} belongs to a built-in or pack catalogue; give the file its own id', { id: cat.id }, 'E_CATALOG_ID_TAKEN');
    registerCatalog(cat);
    source.set(cat.id, 'user');
    if (keep === 'project' || keep === 'both') {
      S.transact(t('Import feature catalogue {name}', { name: cat.name }), (tx) => {
        for (const r of S.all('catalog')) if (r.catalogId === cat.id) tx.delete(r.id);
        tx.create('catalog', { catalogId: cat.id, name: cat.name, version: cat.version, catalog: cat, imported: new Date().toISOString() });
      });
      keptOf(cat.id).add('project');
    }
    if (keep === 'settings' || keep === 'both') {
      try {
        await idbDo('readwrite', (s) => s.put({ id: cat.id, catalog: cat, imported: new Date().toISOString() }));
        keptOf(cat.id).add('settings');
      } catch (e) {
        app.log('warn', `catalogue ${cat.id} is not kept in the settings (${e.message})`);
      }
    }
    app.emit('catalogs');
    return info(cat);
  }

  /** Remove a user catalogue from the project and the settings (layers keep their fields). */
  async function forgetCatalog(id) {
    if (source.get(id) !== 'user') throw gwError('only an imported catalogue can be removed', null, 'E_CATALOG_NOT_USER');
    const recs = S.all('catalog').filter((r) => r.catalogId === id);
    if (recs.length) S.transact(t('Remove feature catalogue'), (tx) => recs.forEach((r) => tx.delete(r.id)));
    try {
      await idbDo('readwrite', (s) => s.delete(id));
    } catch {}
    kept.delete(id);
    source.delete(id);
    unregisterCatalog(id);
    app.emit('catalogs');
  }

  // The catalogues of the project (on open, undo and redo).
  const syncProject = () => {
    for (const r of S.all('catalog')) {
      if (source.get(r.catalogId) === 'pack' || source.get(r.catalogId) === 'builtin') continue;
      if (!getCatalog(r.catalogId)) {
        try {
          registerCatalog(validateCatalog(r.catalog));
          source.set(r.catalogId, 'user');
        } catch (e) {
          app.log('warn', `project catalogue ${r.catalogId}: ${e.message}`);
          continue;
        }
      }
      keptOf(r.catalogId).add('project');
    }
    for (const [id, set] of kept) if (set.has('project') && !S.all('catalog').some((r) => r.catalogId === id)) set.delete('project');
  };
  let sig = '';
  const maybeSync = () => {
    const s = S.all('catalog').map((r) => r.id).join(',');
    if (s !== sig) {
      sig = s;
      syncProject();
    }
  };
  S.on('reset', () => {
    sig = '';
    maybeSync();
  });
  S.on('commit', maybeSync);

  // The catalogues kept in the settings.
  const restored = idbDo('readonly', (s) => s.getAll())
    .then((rows) => {
      for (const row of rows ?? []) {
        try {
          if (!getCatalog(row.id)) registerCatalog(validateCatalog(row.catalog));
          source.set(row.id, source.get(row.id) ?? 'user');
          keptOf(row.id).add('settings');
        } catch (e) {
          app.log('warn', `settings catalogue ${row.id}: ${e.message}`);
        }
      }
      app.emit('catalogs');
    })
    .catch(() => {});

  // Full catalogues from data packs (REQ-GAP-53): every *.gwcatalog.json entry of a loaded pack.
  const fromPack = (name) => {
    const p = app.packs?.loaded.get(name);
    if (!p) return;
    for (const [path, bytes] of p.entries) {
      if (!/\.gwcatalog\.json$/i.test(path)) continue;
      try {
        const cat = validateCatalog(parseCatalogText(new TextDecoder().decode(bytes)));
        registerCatalog(cat);
        source.set(cat.id, 'pack');
        app.log('info', `catalogue ${cat.id} (${cat.types.length} types) from pack ${name}`);
      } catch (e) {
        app.log('warn', `pack ${name}/${path}: ${e.message}`);
      }
    }
    app.emit('catalogs');
  };
  app.on('ready', () => {
    app.packs?.on(fromPack);
    for (const n of app.packs?.loaded.keys() ?? []) fromPack(n);
  });

  async function importDialog() {
    const [f] = await pickFiles(app, { multiple: false, accept: ['.json'], description: t('Feature catalogue (JSON)') });
    if (!f) return null;
    const json = parseCatalogText(await f.text());
    const cat = validateCatalog(json);
    const inProject = h('input', { type: 'checkbox', checked: true, 'data-id': 'catalog-import:project', 'aria-label': t('Keep it in this project') });
    const inSettings = h('input', { type: 'checkbox', checked: true, 'data-id': 'catalog-import:settings', 'aria-label': t('Keep it in my settings for every project') });
    const facts = t('{name} {version}: {types, plural, one {# feature type} other {# feature types}}, {attrs, plural, one {# attribute} other {# attributes}}, {rules, plural, one {# rule} other {# rules}}', { name: cat.name, version: cat.version, types: cat.types.length, attrs: Object.keys(cat.attributes).length, rules: (cat.rules?.length ?? 0) + cat.types.reduce((s, x) => s + (x.rules?.length ?? 0), 0) });
    const body = h('div', {}, h('p', {}, facts), h('label', { class: 'chk' }, inProject, ' ', t('Keep it in this project')), h('label', { class: 'chk' }, inSettings, ' ', t('Keep it in my settings for every project')), getCatalog(cat.id) ? h('p', { class: 'hint' }, t('A catalogue with this id is loaded; importing replaces it.')) : null);
    const r = await modal({ title: t('Import Feature Catalogue'), body, buttons: [{ label: t('Import'), value: 'import', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'catalog-import' });
    if (r !== 'import') return null;
    const keep = inProject.checked && inSettings.checked ? 'both' : inProject.checked ? 'project' : inSettings.checked ? 'settings' : 'none';
    const out = await importCatalog(cat, { keep });
    app.toast(t('Feature catalogue {name} imported: {types, plural, one {# feature type} other {# feature types}}. New Layer from Schema offers it.', { name: out.name, types: out.types }), { kind: 'info' });
    return out;
  }

  C.implement('ext.importcatalog', {
    run: async () => {
      try {
        await importDialog();
      } catch (e) {
        app.toast(t('Import Feature Catalogue: {msg}', { msg: msgOf(e) }), { kind: 'error', ms: 9000 });
      }
    },
  });
  C.implement('ext.catalogs', {
    run: async () => {
      const rows = listCatalogs().map((c) => {
        const i = info(c);
        const where = { builtin: t('built in'), pack: t('data pack'), user: t('imported'), geopackage: t('GeoPackage') }[i.source];
        const keptText = i.kept.map((k) => (k === 'project' ? t('project') : t('settings'))).join(', ');
        let act = '';
        if (i.source === 'user') {
          act = h('button', { class: 'btn', style: { minHeight: '24px' }, 'data-id': `catalogs:remove:${c.id}` }, t('Remove'));
          act.addEventListener('click', () => forgetCatalog(c.id).then(() => act.closest('tr')?.remove()));
        }
        return h('tr', {}, h('td', {}, c.name), h('td', {}, c.version ?? ''), h('td', {}, int(i.types)), h('td', {}, where), h('td', {}, keptText), h('td', {}, act));
      });
      const tbl = h('table', { class: 'tbl', 'aria-label': t('Feature catalogues') }, h('thead', {}, h('tr', {}, [t('Catalogue'), t('Version'), t('Types'), t('Source'), t('Kept in'), ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows));
      const r = await modal({ title: t('Feature Catalogues'), body: h('div', {}, tbl, field(t('Import'), h('span', { class: 'hint' }, t('Import… reads a gw-catalog/1 JSON file.')))), buttons: [{ label: t('Import…'), value: 'import', primary: true }, { label: t('Close'), value: 'close' }], id: 'catalogs', width: 680 });
      if (r === 'import') await C.run('ext.importcatalog');
    },
  });

  app.catalogs = { import: importCatalog, forget: forgetCatalog, list: () => listCatalogs().map(info), info: (id) => (getCatalog(id) ? info(getCatalog(id)) : null), restored, sourceOf: (id) => source.get(id) ?? null };
}
