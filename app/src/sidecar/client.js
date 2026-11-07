// Sidecar client (REQ-SDC-02/03/05/06/07, SDP-2.1 §3.2–§3.5). Plain HTTP to 127.0.0.1 on the
// three sidecar ports, always through the logged fetch (NetLog.fetchFor('sidecar')), progress as a
// streamed NDJSON response read from a ReadableStream (no WebSocket, no new CSP source kind).
// Nothing here runs at start-up unless a token from an earlier pairing exists.

import { N_, en } from '../i18n/index.js';
export const PORTS = [47821, 47822, 47823];
/** The API level this app needs (REQ-SDC-13: warn when the sidecar is older). */
export const API_NEEDED = 1;
export const LOOPBACK_ORIGINS = PORTS.map((p) => `http://127.0.0.1:${p}`);
export const DOWNLOAD_URL = 'https://github.com/brianm-di4u/GIS-Workbench/releases';

export function isLoopbackOrigin(o) {
  return LOOPBACK_ORIGINS.includes(o);
}

export class SidecarError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A SidecarError that keeps its message key (REQ-L10N-05): msgOf(e) shows it in the UI language. Mark `src` with N_(). */
export function sidecarError(src, params, opts) {
  const e = new SidecarError(en(src, params), opts);
  e.i18n = { src, params: params ?? null };
  return e;
}

/** Token store: IndexedDB for this origin when available, else memory only. */
export class TokenStore {
  constructor(name = 'gwb-sidecar') {
    this.name = name;
    this.mem = null;
  }
  _db() {
    return new Promise((res, rej) => {
      if (!globalThis.indexedDB) return rej(new Error('no IndexedDB'));
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async _op(mode, fn) {
    const db = await this._db();
    try {
      return await new Promise((res, rej) => {
        const t = db.transaction('kv', mode);
        const q = fn(t.objectStore('kv'));
        t.oncomplete = () => res(q?.result);
        t.onerror = () => rej(t.error);
      });
    } finally {
      db.close();
    }
  }
  async get() {
    if (this.mem) return this.mem;
    try {
      this.mem = (await this._op('readonly', (s) => s.get('pair'))) ?? null;
    } catch {
      /* memory only */
    }
    return this.mem;
  }
  async set(v) {
    this.mem = v;
    try {
      await this._op('readwrite', (s) => s.put(v, 'pair'));
    } catch {
      /* memory only */
    }
  }
  async clear() {
    this.mem = null;
    try {
      await this._op('readwrite', (s) => s.delete('pair'));
    } catch {
      /* memory only */
    }
  }
}

export class SidecarClient {
  /** `fetch`: the logged fetch; `store`: a TokenStore; `ports`: override for tests. */
  constructor({ fetch, store = new TokenStore(), ports = PORTS, base = null } = {}) {
    this.fetch = fetch;
    this.store = store;
    this.ports = ports;
    this.base = base;
    this.token = null;
    this.hello = null;
  }

  async load() {
    const s = await this.store.get();
    if (s?.token && /^[0-9a-f]{64}$/.test(s.token)) {
      this.token = s.token;
      if (s.base && LOOPBACK_ORIGINS.includes(s.base)) this.base ??= s.base;
    }
    return !!this.token;
  }

  headers(extra = {}) {
    return this.token ? { ...extra, Authorization: `Bearer ${this.token}` } : extra;
  }

  /** Find the sidecar: the remembered port first, then 47821–47823. Resolves null if none answers. */
  async discover({ timeout = 1500 } = {}) {
    const order = [...new Set([this.base, ...this.ports.map((p) => `http://127.0.0.1:${p}`)].filter(Boolean))];
    for (const base of order) {
      const ac = new AbortController();
      // The sidecar this page last spoke to may be slow to answer while it runs a heavy job: give it
      // longer than a port nobody may be listening on.
      const t = setTimeout(() => ac.abort(), base === this.base ? Math.max(timeout, 6000) : timeout);
      try {
        const r = await this.fetch(`${base}/v1/hello`, { headers: this.headers(), signal: ac.signal, credentials: 'omit' });
        const j = await r.json().catch(() => null);
        if (j?.service === 'gwb-sidecar') {
          this.base = base;
          this.hello = j;
          // A token the sidecar no longer knows was revoked in the sidecar window: drop it.
          if (!j.paired && this.token) {
            this.token = null;
            await this.store.clear();
          }
          return j;
        }
      } catch {
        /* not this port */
      } finally {
        clearTimeout(t);
      }
    }
    this.hello = null;
    return null;
  }

  get paired() {
    return !!(this.hello?.paired && this.token);
  }

  get outdated() {
    return !!this.hello && this.hello.api < API_NEEDED;
  }

  async request(method, path, { json, body, headers = {}, signal, raw = false } = {}) {
    if (!this.base) throw sidecarError(N_('the sidecar is not running'), null, { code: 'absent' });
    const init = { method, headers: this.headers(headers), signal, credentials: 'omit' };
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers['Content-Type'] = 'application/json';
    } else if (body !== undefined) init.body = body;
    let r;
    try {
      r = await this.fetch(`${this.base}${path}`, init);
    } catch (e) {
      throw sidecarError(N_('the sidecar did not answer ({msg})'), { msg: e.message }, { code: 'unreachable' });
    }
    if (raw) return r;
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw new SidecarError(j?.error ?? `HTTP ${r.status}`, { status: r.status, code: j?.code ?? '' });
    }
    if (r.status === 204) return null;
    const ct = r.headers.get('content-type') ?? '';
    return ct.includes('json') ? r.json() : r.text();
  }

  /**
   * Pair this origin (REQ-SDC-03): `onCode(code)` shows the six digits; resolves when the user
   * allows it in the sidecar window. `signal` stops waiting.
   */
  async pair({ client = 'GIS Workbench', onCode = () => {}, signal, interval = 1000 } = {}) {
    if (!this.base && !(await this.discover())) throw sidecarError(N_('no sidecar is running on this computer'), null, { code: 'absent' });
    const s = await this.request('POST', '/v1/pair', { json: { client } });
    onCode(s.code, s);
    const deadline = Date.now() + s.expires_in * 1000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw sidecarError(N_('pairing was cancelled'), null, { code: 'cancelled' });
      await new Promise((r) => setTimeout(r, interval));
      const st = await this.request('GET', `/v1/pair/${s.pairing_id}`);
      if (st.state === 'approved' && st.token) {
        this.token = st.token;
        await this.store.set({ token: st.token, base: this.base, at: new Date().toISOString() });
        await this.discover();
        return true;
      }
      if (st.state === 'denied') throw sidecarError(N_('the pairing was denied in the sidecar window'), null, { code: 'denied' });
      if (st.state === 'expired') break;
    }
    throw sidecarError(N_('the pairing request expired'), null, { code: 'expired' });
  }

  /** "Forget sidecar": revoke this token there and drop it here. */
  async forget() {
    try {
      if (this.token && this.base) await this.request('DELETE', '/v1/pair');
    } finally {
      this.token = null;
      if (this.hello) this.hello.paired = false;
      await this.store.clear();
    }
  }

  caps() {
    return this.request('GET', '/v1/caps');
  }
  driver(name, kind = 'dataset') {
    return this.request('GET', `/v1/caps/drivers/${encodeURIComponent(name)}?kind=${kind}`);
  }

  /** Stream a File to the sidecar (PUT /v1/files). `group` puts companions beside it. */
  upload(file, { group = null, signal, name = file.name } = {}) {
    const q = new URLSearchParams({ name });
    if (group) q.set('group', group);
    return this.request('PUT', `/v1/files?${q}`, { body: file, signal, headers: { 'Content-Type': 'application/octet-stream' } });
  }

  /** Upload a main file and its companions (.sdw, .aux.xml, .shx…) as one group. */
  async uploadSet(main, companions = [], { signal } = {}) {
    const m = await this.upload(main, { signal });
    for (const c of companions) await this.upload(c, { group: m.group, signal });
    return m;
  }

  pick(mode = 'file', title) {
    return this.request('POST', '/v1/pick', { json: title ? { mode, title } : { mode } });
  }

  createJob(req) {
    return this.request('POST', '/v1/jobs', { json: req });
  }
  batch(req) {
    return this.request('POST', '/v1/batch', { json: req });
  }
  job(id) {
    return this.request('GET', `/v1/jobs/${id}`);
  }
  jobs() {
    return this.request('GET', '/v1/jobs');
  }
  cancel(id) {
    return this.request('DELETE', `/v1/jobs/${id}`);
  }
  retry(id) {
    return this.request('POST', `/v1/jobs/${id}/retry`, { json: {} });
  }
  log(id) {
    return this.request('GET', `/v1/jobs/${id}/log`);
  }
  saveFile(id) {
    return this.request('POST', `/v1/files/${id}/save`, { json: {} });
  }
  deleteFile(id) {
    return this.request('DELETE', `/v1/files/${id}`);
  }

  /** Job events as an async iterator over the NDJSON stream; ends after the `done` event. */
  async *events(id, { signal } = {}) {
    const r = await this.request('GET', `/v1/jobs/${id}/events`, { raw: true, signal });
    if (!r.ok || !r.body) throw new SidecarError(`events: HTTP ${r.status}`, { status: r.status });
    yield* ndjson(r.body, signal);
  }

  fileUrl(id) {
    return `${this.base}/v1/files/${id}`;
  }

  /** A view of a MrSID or ECW file (REQ-GAP-70): a TIFF the sidecar decodes as its ranges are read. */
  openView(file, { signal } = {}) {
    return this.request('POST', '/v1/views', { json: { file }, signal });
  }
  closeView(id) {
    return this.request('DELETE', `/v1/views/${id}`);
  }
  viewUrl(id) {
    return `${this.base}/v1/views/${id}`;
  }

  /** For connectors/remote.js remoteFile(): adds the bearer token to every range request. */
  signer() {
    return async (url, init = {}) => ({ url, init: { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.token}` } } });
  }
}

/** Lines of a ReadableStream of NDJSON, parsed; blank keep-alive lines are skipped. */
export async function* ndjson(stream, signal) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        yield ev;
        if (ev.type === 'done') return;
      }
    }
    const last = buf.trim();
    if (last) {
      try {
        yield JSON.parse(last);
      } catch {
        /* a cut line */
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/** Which profile converts a file the app refused, from its name (before any probe). */
export function profileForName(name) {
  const n = String(name).toLowerCase();
  if (/\.(sid|ecw|jp2|j2k|img|nc|hdf|h5|grd|dem|ers|adf|asc|bil|bip|bsq|rst|kap|ntf|nitf|vrt|xyz|ter|gsb)$/.test(n)) return 'raster-cog';
  if (/\.(gdb|mdb|tab|mif|dxf|dgn|gml|e00|sqlite|osm|pbf|ods|xlsx?|fgb|gpx|kml)$/.test(n) || n.endsWith('.gdb.zip')) return 'vector-gpkg';
  if (/\.(e57|bpf|ply|pts|ptx|pcd|xyz|las|laz)$/.test(n)) return 'points-copc';
  if (/\.(ts|m2ts|mts|mpg|mpeg|vob|m2v)$/.test(n)) return 'video-h264-klv';
  return null;
}
