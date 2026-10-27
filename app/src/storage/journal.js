// IndexedDB recovery journal and small key-value cache (REQ-ARC-11, REQ-SEC-06, REQ-HOST-07).
// Namespaced per project; journals only ops (never pixels); can be turned off; tolerates
// blocked or partitioned storage with a visible warning and no crash. This is recovery,
// not storage: the project file on disk is the system of record.

const DB = 'gisworkbench';
const STORES = ['journal', 'kv', 'feedback'];

export class Journal {
  constructor(app) {
    this.app = app;
    this.db = null;
    this.queue = [];
    this.timer = 0;
    this.enabled = app.prefs.get('journal') !== 'off';
    this.available = false;
    this.key = null; // AES-GCM key from the session passphrase (REQ-SEC-06); never stored
    this.salt = null;
  }

  /** Encrypt the journal with a passphrase for this session (PBKDF2 → AES-GCM 256). */
  async setPassphrase(pass) {
    if (!pass) {
      this.key = null;
      this.salt = null;
      return;
    }
    this.salt = crypto.getRandomValues(new Uint8Array(16));
    this.key = await deriveKey(pass, this.salt);
    // Re-write the current journal under the key.
    const pid = this.projectKey();
    const prev = await this.get('journal', pid);
    if (prev && !prev.enc) await this.put('journal', pid, await this.seal(prev));
  }

  async seal(value) {
    if (!this.key) return value;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, new TextEncoder().encode(JSON.stringify(value))));
    return { enc: 'AES-GCM/PBKDF2-SHA256', salt: this.salt, iv, data, updated: value.updated ?? Date.now(), count: value.changesets?.length ?? 0 };
  }

  /** Open an encrypted journal record with a passphrase; throws on a wrong one. */
  async unseal(rec, pass) {
    if (!rec?.enc) return rec;
    const key = await deriveKey(pass, rec.salt);
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.data);
      return JSON.parse(new TextDecoder().decode(plain));
    } catch {
      throw new Error('wrong passphrase');
    }
  }

  async open() {
    if (!this.app.runMode.caps.indexedDB) return false;
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open(DB, 2);
        r.onupgradeneeded = () => {
          for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.onblocked = () => rej(new Error('IndexedDB is blocked by another tab'));
      });
      this.available = true;
    } catch (e) {
      this.app.log('warn', `IndexedDB unavailable: ${e.message}`);
      this.available = false;
    }
    return this.available;
  }

  _tx(store, mode, fn) {
    if (!this.db) return Promise.resolve(null);
    return new Promise((res, rej) => {
      try {
        const t = this.db.transaction(store, mode);
        const s = t.objectStore(store);
        const out = fn(s);
        t.oncomplete = () => res(out?.result ?? null);
        t.onerror = () => rej(t.error);
      } catch (e) {
        rej(e);
      }
    });
  }

  async get(store, key) {
    if (!this.db) return null;
    return new Promise((res) => {
      try {
        const r = this.db.transaction(store).objectStore(store).get(key);
        r.onsuccess = () => res(r.result ?? null);
        r.onerror = () => res(null);
      } catch {
        res(null);
      }
    });
  }

  put(store, key, value) {
    return this._tx(store, 'readwrite', (s) => s.put(value, key)).catch((e) => this.app.log('warn', `storage write failed: ${e.message}`));
  }

  del(store, key) {
    return this._tx(store, 'readwrite', (s) => s.delete(key)).catch(() => {});
  }

  /** Journal a committed change set (batched every 500 ms or 50 ops). */
  record(cs) {
    if (!this.enabled || !this.available) return;
    this.queue.push({ label: cs.label, kind: cs.kind, ts: cs.ts, ops: cs.ops });
    if (this.queue.length >= 50) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 500);
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = 0;
    if (!this.queue.length || !this.available) return;
    const pid = this.projectKey();
    let prev = (await this.get('journal', pid)) ?? { changesets: [], snapshot: null };
    if (prev.enc) {
      // Encrypted earlier in this session: open with the session key, else start afresh.
      try {
        prev = this.key ? JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: prev.iv }, this.key, prev.data))) : { changesets: [], snapshot: null };
      } catch {
        prev = { changesets: [], snapshot: null };
      }
    }
    prev.changesets.push(...this.queue.splice(0));
    // Snapshot every 200 change sets so recovery stays fast.
    if (prev.changesets.length >= 200) {
      prev.snapshot = this.app.store.snapshot();
      prev.changesets = [];
    }
    prev.updated = Date.now();
    await this.put('journal', pid, await this.seal(prev));
  }

  projectKey() {
    return `gw/${this.app.project()?.created ?? 'none'}`;
  }

  /** A clean save clears the journal. */
  async clear() {
    this.queue.length = 0;
    await this.del('journal', this.projectKey());
  }

  async recoverable() {
    if (!this.available) return null;
    return new Promise((res) => {
      try {
        const out = [];
        const r = this.db.transaction('journal').objectStore('journal').openCursor();
        r.onsuccess = () => {
          const c = r.result;
          if (!c) return res(out.sort((a, b) => b.updated - a.updated)[0] ?? null);
          if (c.value?.changesets?.length || c.value?.snapshot || c.value?.enc) out.push({ key: c.key, ...c.value });
          c.continue();
        };
        r.onerror = () => res(null);
      } catch {
        res(null);
      }
    });
  }

  setEnabled(on) {
    this.enabled = on;
    this.app.prefs.set('journal', on ? 'on' : 'off');
    if (!on) {
      // Off means off: every project's journal goes, not only this one's (REQ-SEC-06).
      this.queue.length = 0;
      this._tx('journal', 'readwrite', (s) => s.clear()).catch(() => {});
    }
  }
}

async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
