// Data packs at run time (REQ-ARC-14; `Research/15` §2.3). A pack is a ZIP with pack.json. On
// open, every entry's SHA-256 is checked against pack.json; JS, WASM and model entries must also
// match the hashes in this build's manifest, otherwise the pack is refused: the tool never runs
// code that its own build did not list. Data-only packs from elsewhere (for example a basemap)
// are accepted with their own hashes. Hashes are checked again on every load from storage. A large
// pack is unpacked and hashed in a worker, with progress (OD-2.27); the rules stay here.
//
// Persistence: in Chromium the pack's FileSystemFileHandle is kept in IndexedDB (one permission
// prompt per session); elsewhere the pack file itself is kept as a Blob.

import { unzipSync, strFromU8 } from 'fflate';
import { gwError, t, tr } from '../i18n/index.js';
import { txDone } from './idb.js';

const DB = 'gw-packs';
const STORE = 'packs';
const CODE = new Set(['js', 'wasm', 'model']);
const WORKER_FROM = 4 * 1024 * 1024; // smaller packs (a locale) take moments on the main thread

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
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    return await txDone(t, () => out?.result ?? out);
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

  /** Show work on the pack's own file in the activity indicator. */
  track(label, work) {
    return this.app.activity ? this.app.activity.track(label, work) : work();
  }

  /**
   * Verify a pack's bytes → {json, entries}. Throws with the reason on any mismatch. With
   * `{ transfer: true }` the caller gives `bytes` away, and a large pack goes to a worker.
   */
  async verify(bytes, label = 'pack', { transfer = false } = {}) {
    let files;
    let hashes = null;
    try {
      if (transfer && this.app.pool && bytes.length >= WORKER_FROM) ({ files, hashes } = await this.app.pool.run('packUnzip', { bytes }, { kind: 'analysis', transfer: [bytes.buffer], timeout: 3600e3, label: t('Checking {file}…', { file: label }) }));
      else files = unzipSync(bytes);
    } catch (e) {
      if (e.cancelled) throw e;
      throw gwError('{file}: not a ZIP pack ({msg})', { file: label, msg: e.message }, 'E_PACK_NOT_ZIP');
    }
    if (!files['pack.json']) throw gwError('{file}: no pack.json', { file: label }, 'E_PACK_NO_MANIFEST');
    const json = JSON.parse(strFromU8(files['pack.json']));
    if (json.format !== 'gw-pack/1' || !json.name || !Array.isArray(json.entries)) throw gwError('{file}: pack.json is not a gw-pack/1 manifest', { file: label }, 'E_PACK_BAD_MANIFEST');
    const known = this.known(json.name);
    const entries = new Map();
    for (const e of json.entries) {
      const b = files[e.path];
      if (!b) throw gwError('{file}: entry {path} is missing', { file: label, path: e.path }, 'E_PACK_ENTRY_MISSING');
      const h = hashes?.[e.path] ?? (await hex(b));
      if (h !== e.sha256) throw gwError('{file}: entry {path} does not match its SHA-256 in pack.json', { file: label, path: e.path }, 'E_PACK_HASH');
      if (CODE.has(e.kind) || known) {
        const k = known?.entries?.[e.path];
        if (!k) throw gwError("{file}: {kind} entry {path} is not listed in this build's manifest; the tool runs no code from outside its build", { file: label, kind: String(e.kind), path: e.path }, 'E_PACK_UNLISTED');
        if (k.sha256 !== h) throw gwError("{file}: entry {path} differs from this build's manifest (pack {version}, build expects {expected})", { file: label, path: e.path, version: String(json.version), expected: String(known.version) }, 'E_PACK_BUILD_MISMATCH');
      }
      entries.set(e.path, b);
    }
    return { json, entries, licence: files['LICENCE.txt'] ? strFromU8(files['LICENCE.txt']) : json.licence ?? '' };
  }

  /**
   * REQ-GAP-16: on a hosted copy (secure origin with OPFS), keep a pack in the origin-private
   * file system: later sessions read it without a permission prompt, and it survives eviction
   * once the browser grants persistent storage. Returns false where OPFS is not available
   * (file://, older browsers); the pack is then kept as before.
   */
  async keepInOpfs(rec, file) {
    let dir = null;
    try {
      dir = await navigator.storage?.getDirectory?.();
    } catch {
      return false;
    }
    if (!dir) return false;
    try {
      const sub = await dir.getDirectoryHandle('gw-packs', { create: true });
      const fh = await sub.getFileHandle(`${rec.name}.gwpack`, { create: true });
      await this.track(t('Keeping {file}…', { file: rec.source }), async () => {
        const w = await fh.createWritable();
        await w.write(file);
        await w.close();
      });
      const keep = { name: rec.name, version: rec.version, file: rec.source, handle: fh, opfs: true };
      await tx('readwrite', (s) => s.put(keep));
      this.stored.set(rec.name, keep);
      await navigator.storage.persist?.().catch(() => false);
      return true;
    } catch (e) {
      this.app.log('info', `pack ${rec.name}: OPFS copy not kept (${e.message})`);
      return false;
    }
  }

  /** Open a pack file the user chose: verify, register, keep for later sessions. */
  async open(file) {
    const buf = await this.track(t('Reading {file}…', { file: file.name }), () => file.arrayBuffer());
    const v = await this.verify(new Uint8Array(buf), file.name, { transfer: true });
    const rec = { name: v.json.name, version: v.json.version, title: v.json.title ?? v.json.name, json: v.json, entries: v.entries, licence: v.licence, source: file.name };
    this.loaded.set(rec.name, rec);
    if (this.opfsFor?.(rec) && (await this.keepInOpfs(rec, file))) {
      this._emit(rec.name);
      return rec;
    }
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
    const buf = await this.track(t('Reading {file}…', { file: kept.file ?? name }), () => file.arrayBuffer());
    const v = await this.verify(new Uint8Array(buf), kept.file ?? name, { transfer: true });
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
    // The English instruction is unchanged (tests and support notes quote it); E_PACK_REQUIRED lets callers branch.
    // `why` is an English source (N_); e.message stays English, msgOf shows the reason and the
    // pack title (a build/packs.mjs title, in the catalogue) in the UI language.
    const pack = k?.title ?? name;
    const params = { why, pack, file: k?.file };
    const err = why
      ? k
        ? gwError('{why} needs the {pack} data pack ({file}): File ▸ Open ▸ Open Data Pack', params, 'E_PACK_REQUIRED')
        : gwError('{why} needs the {pack} data pack: File ▸ Open ▸ Open Data Pack', params, 'E_PACK_REQUIRED')
      : k
        ? gwError('This needs the {pack} data pack ({file}): File ▸ Open ▸ Open Data Pack', params, 'E_PACK_REQUIRED')
        : gwError('This needs the {pack} data pack: File ▸ Open ▸ Open Data Pack', params, 'E_PACK_REQUIRED');
    err.i18n.params = { ...params, why: tr(why), pack: k?.title ? tr(k.title) : name };
    err.pack = name;
    throw err;
  }

  async forget(name) {
    this.loaded.delete(name);
    if (this.stored.get(name)?.opfs) {
      try {
        const sub = await (await navigator.storage.getDirectory()).getDirectoryHandle('gw-packs');
        await sub.removeEntry(`${name}.gwpack`);
      } catch {}
    }
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
  if (!b) throw gwError('pack {pack} has no entry {path}', { pack: pack.name, path }, 'E_PACK_NO_ENTRY');
  return URL.createObjectURL(new Blob([b], { type }));
}
