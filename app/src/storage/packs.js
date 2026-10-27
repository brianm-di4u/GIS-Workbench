// Data packs at run time (REQ-ARC-14; `Research/15` §2.3). A pack is a ZIP with pack.json. On
// open, every entry's SHA-256 is checked against pack.json; JS, WASM and model entries must also
// match the hashes in this build's manifest, otherwise the pack is refused: the tool never runs
// code that its own build did not list. Data-only packs from elsewhere (for example a basemap)
// are accepted with their own hashes. Hashes are checked again on every load from storage.
//
// Persistence: in Chromium the pack's FileSystemFileHandle is kept in IndexedDB (one permission
// prompt per session); elsewhere the pack file itself is kept as a Blob.

import { unzipSync, strFromU8 } from 'fflate';

const DB = 'gw-packs';
const STORE = 'packs';
const CODE = new Set(['js', 'wasm', 'model']);

async function hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function idb() {
  return new Promise((res, rej) => {
    if (!globalThis.indexedDB) return rej(new Error('IndexedDB is not available'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'name' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(mode, fn) {
  const db = await idb();
  try {
    return await new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out?.result ?? out);
      t.onerror = () => rej(t.error);
    });
  } finally {
    db.close();
  }
}

export class PackStore {
  constructor(app) {
    this.app = app;
    this.loaded = new Map(); // name → {name, version, title, json, entries Map(path → Uint8Array), source}
    this.stored = new Map(); // name → {name, version, handle | blob}
    this.listeners = new Set();
  }

  /** The build manifest's record for a pack (null for packs this build does not know). */
  known(name) {
    return this.app.gw?.manifest?.packs?.[name] ?? null;
  }

  /** Verify a pack's bytes → {json, entries}. Throws with the reason on any mismatch. */
  async verify(bytes, label = 'pack') {
    let files;
    try {
      files = unzipSync(bytes);
    } catch (e) {
      throw new Error(`${label}: not a ZIP pack (${e.message})`);
    }
    if (!files['pack.json']) throw new Error(`${label}: no pack.json`);
    const json = JSON.parse(strFromU8(files['pack.json']));
    if (json.format !== 'gw-pack/1' || !json.name || !Array.isArray(json.entries)) throw new Error(`${label}: pack.json is not a gw-pack/1 manifest`);
    const known = this.known(json.name);
    const entries = new Map();
    for (const e of json.entries) {
      const b = files[e.path];
      if (!b) throw new Error(`${label}: entry ${e.path} is missing`);
      const h = await hex(b);
      if (h !== e.sha256) throw new Error(`${label}: entry ${e.path} does not match its SHA-256 in pack.json`);
      if (CODE.has(e.kind) || known) {
        const k = known?.entries?.[e.path];
        if (!k) throw new Error(`${label}: ${e.kind} entry ${e.path} is not listed in this build's manifest; the tool runs no code from outside its build`);
        if (k.sha256 !== h) throw new Error(`${label}: entry ${e.path} differs from this build's manifest (pack ${json.version}, build expects ${known.version})`);
      }
      entries.set(e.path, b);
    }
    return { json, entries, licence: files['LICENCE.txt'] ? strFromU8(files['LICENCE.txt']) : json.licence ?? '' };
  }

  /** Open a pack file the user chose: verify, register, keep for later sessions. */
  async open(file) {
    const v = await this.verify(new Uint8Array(await file.arrayBuffer()), file.name);
    const rec = { name: v.json.name, version: v.json.version, title: v.json.title ?? v.json.name, json: v.json, entries: v.entries, licence: v.licence, source: file.name };
    this.loaded.set(rec.name, rec);
    try {
      const keep = file.__handle ? { name: rec.name, version: rec.version, file: file.name, handle: file.__handle } : { name: rec.name, version: rec.version, file: file.name, blob: file };
      await tx('readwrite', (s) => s.put(keep));
      this.stored.set(rec.name, keep);
    } catch (e) {
      this.app.log('info', `pack ${rec.name} is loaded for this session only (${e.message})`);
    }
    this._emit(rec.name);
    return rec;
  }

  /** Packs kept from earlier sessions (not yet read). */
  async restore() {
    try {
      const all = await tx('readonly', (s) => s.getAll());
      for (const r of all ?? []) this.stored.set(r.name, r);
    } catch {}
    return [...this.stored.values()];
  }

  /** A loaded pack, reading a kept one again (and checking its hashes) when needed. */
  async get(name, { prompt = true } = {}) {
    if (this.loaded.has(name)) return this.loaded.get(name);
    const kept = this.stored.get(name);
    if (!kept) return null;
    let file = kept.blob ?? null;
    if (kept.handle) {
      let perm = (await kept.handle.queryPermission?.({ mode: 'read' })) ?? 'granted';
      if (perm !== 'granted' && prompt) perm = await kept.handle.requestPermission?.({ mode: 'read' });
      if (perm !== 'granted') return null;
      file = await kept.handle.getFile();
    }
    if (!file) return null;
    const v = await this.verify(new Uint8Array(await file.arrayBuffer()), kept.file ?? name);
    const rec = { name: v.json.name, version: v.json.version, title: v.json.title ?? name, json: v.json, entries: v.entries, licence: v.licence, source: kept.file ?? name };
    this.loaded.set(name, rec);
    this._emit(name);
    return rec;
  }

  /** The pack or a clear instruction to load it. */
  async require(name, why = '') {
    const p = await this.get(name);
    if (p) return p;
    const k = this.known(name);
    throw new Error(`${why ? `${why} needs` : 'This needs'} the ${k?.title ?? name} data pack${k ? ` (${k.file})` : ''}: File ▸ Open ▸ Open Data Pack`);
  }

  async forget(name) {
    this.loaded.delete(name);
    this.stored.delete(name);
    try {
      await tx('readwrite', (s) => s.delete(name));
    } catch {}
    this._emit(name);
  }

  list() {
    const names = new Set([...Object.keys(this.app.gw?.manifest?.packs ?? {}), ...this.loaded.keys(), ...this.stored.keys()]);
    return [...names].map((n) => ({ name: n, known: this.known(n), loaded: this.loaded.get(n) ?? null, stored: this.stored.get(n) ?? null }));
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(name) {
    for (const f of this.listeners) f(name);
  }
}

/** A Blob URL for a pack entry (classic scripts and module glue are run from Blob URLs; CSP blob:). */
export function entryUrl(pack, path, type = 'text/javascript') {
  const b = pack.entries.get(path);
  if (!b) throw new Error(`pack ${pack.name} has no entry ${path}`);
  return URL.createObjectURL(new Blob([b], { type }));
}
