// Network rule (REQ-SEC-12, REQ-AI-05, PT-02): all network code goes through this fetch. It
// refuses origins the page CSP does not list (the meta CSP cannot be widened at runtime, so
// adding an origin means "add → save → reload"), logs every request, and turns failures
// into plain explanations.

import { gwError } from '../i18n/index.js';
export function cspConnectSources() {
  const meta = document.getElementById('csp')?.getAttribute('content') ?? '';
  const m = /connect-src([^;]*)/.exec(meta);
  return m ? m[1].trim().split(/\s+/).filter(Boolean) : [];
}

export function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The three loopback origins of the optional sidecar (build/origins.json "loopback"). */
export function isSidecarOrigin(o) {
  return o === 'http://127.0.0.1:47821' || o === 'http://127.0.0.1:47822' || o === 'http://127.0.0.1:47823';
}

/** Whether the running CSP lets this page connect to `url`. */
export function cspAllows(url) {
  const o = originOf(url);
  if (!o || o === 'null') return false;
  return cspConnectSources().some((s) => s === o || s === `${o}/` || (s.endsWith('/') && url.startsWith(s)));
}

/** Validate an origin the user wants to add: https (or http://localhost), no wildcards. */
export function normaliseOrigin(text) {
  const t = String(text).trim();
  if (/[*]/.test(t)) throw new Error('wildcard origins are refused');
  let u;
  try {
    u = new URL(t.includes('://') ? t : `https://${t}`);
  } catch {
    throw gwError('"{text}" is not a URL', { text: t }, 'E_NOT_A_URL');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname))) throw new Error('only https origins (or http://localhost) can be added');
  return u.origin;
}

export class NetLog {
  constructor(app) {
    this.app = app;
    this.entries = [];
  }

  record(e) {
    this.entries.unshift(e);
    if (this.entries.length > 500) this.entries.pop();
    this.app.emit('netlog');
  }

  /** One call through the CORS relay, in this log like any other. */
  async relayed(entry, url, init) {
    entry.relay = true;
    try {
      const r = await this.app.sidecar.corsRelay.fetch(url, init);
      entry.status = r.status;
      entry.received = Number(r.headers.get('content-length')) || 0;
      this.record(entry);
      return r;
    } catch (e) {
      entry.status = e.code || 'failed';
      this.record(entry);
      throw e;
    }
  }

  /**
   * A fetch for one purpose (e.g. "AI: Anthropic"); the SDK and MCP clients receive it.
   * `auth: false` (the sign-in calls themselves) sends no token and no browser credentials.
   */
  fetchFor(purpose, { auth = true } = {}) {
    return async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init.method ?? (typeof input === 'object' ? input.method : null) ?? 'GET').toUpperCase();
      const origin = originOf(url);
      const entry = { at: Date.now(), time: new Date().toISOString().slice(11, 19), method, origin, path: (() => { try { return new URL(url).pathname; } catch { return url; } })(), status: 'blocked', sent: init.body ? (typeof init.body === 'string' ? init.body.length : init.body.byteLength ?? init.body.size ?? '?') : 0, received: 0, purpose };
      // The local sidecar (REQ-SDC-02, REQ-SDC-14): loopback only, allowed while Offline (no data
      // leaves the device), gated by the Sidecar switch instead, and logged like everything else.
      const loopback = isSidecarOrigin(origin);
      if (loopback) {
        entry.loopback = true;
        if (!this.app.sidecar?.enabled?.()) {
          entry.status = 'sidecar off';
          this.record(entry);
          const err = new Error('the Sidecar switch is off (status bar ▸ Sidecar)');
          err.code = 'E_SIDECAR_SWITCH_OFF';
          err.offline = true;
          throw err;
        }
      }
      // The Online/Offline switch gates every request, whatever the CSP allows (REQ-NET-02).
      if (!loopback && this.app.network && !this.app.network.isOnline()) {
        entry.status = 'offline';
        this.record(entry);
        const err = this.app.network.airgap ? Object.assign(new Error('this is the air-gapped file: it makes no network requests'), { code: 'E_AIRGAP' }) : gwError('GIS Workbench is offline (status bar ▸ Offline). Go online to reach {origin}.', { origin: String(origin) }, 'E_OFFLINE');
        err.offline = true;
        throw err;
      }
      // The CORS relay (REQ-GAP-08): after the Online check, so it never runs Offline. It is on only
      // with a sidecar that reports it, and no shipped sidecar does (OD-2.17).
      if (!loopback && this.app.sidecar?.corsRelay?.covers(origin, method)) return this.relayed(entry, url, init);
      if (!cspAllows(url)) {
        entry.status = 'not allowed';
        this.record(entry);
        const err = gwError("{origin} is not in this file's network allow-list (CSP connect-src). Add it in Add-Ins ▸ Network Allow-List, save the file and reload it.", { origin: String(origin) }, 'E_NET_NOT_ALLOWED');
        err.notAllowed = true;
        throw err;
      }
      // Sign-in (REQ-GAP-09/10, connectors/auth.js): browser credentials only to an origin the user
      // marked, otherwise 'omit' whatever the caller asked; a bearer token only to its own origin.
      const signIn = this.app.auth?.policy;
      try {
        let sent = init;
        let owner = origin; // the session whose token went (an ArcGIS portal's for its servers)
        if (signIn) {
          const p = await signIn.prepare(input, init, { auth });
          sent = p.init;
          if (p.how) entry.auth = p.how;
          if (p.owner) owner = p.owner;
        }
        let r = await fetch(input, sent);
        // An access token the server no longer takes: refresh once and repeat (a body that is a stream cannot be repeated).
        const stream = typeof ReadableStream !== 'undefined' && sent.body instanceof ReadableStream;
        if (r.status === 401 && entry.auth?.includes('bearer') && !stream && (await signIn.vault.refresh(owner).then(() => true, () => false))) {
          this.record({ ...entry, status: 401 });
          sent = (await signIn.prepare(input, init, { auth })).init;
          r = await fetch(input, sent);
          entry.retried = true;
        }
        entry.status = r.status;
        entry.received = method === 'HEAD' ? 0 : Number(r.headers.get('content-length') ?? 0) || '?';
        this.record(entry);
        if (entry.auth) this.app.emit('signin-used', { origin, how: entry.auth });
        return r;
      } catch (e) {
        entry.status = 'failed';
        this.record(entry);
        throw fetchFailure(e, origin);
      }
    };
  }
}

/** The error for a failed fetch, keeping its message key (REQ-L10N-05). */
export function fetchFailure(e, origin) {
  if (e?.name === 'AbortError') return gwError('the request was cancelled', null, 'E_CANCELLED');
  return gwError('could not reach {origin}: {msg}. The network may be offline, the host may refuse cross-origin requests from a local file (Origin: null), or a proxy may block it.', { origin: String(origin), msg: String(e?.message ?? e) }, 'E_FETCH_FAILED');
}

/** The English explanation of a failed fetch. */
export function explainFetchFailure(e, origin) {
  return fetchFailure(e, origin).message;
}
