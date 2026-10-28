// Network rule (REQ-SEC-12, REQ-AI-05, PT-02): all network code goes through this fetch. It
// refuses origins the page CSP does not list (the meta CSP cannot be widened at runtime, so
// adding an origin means "add → save → reload"), logs every request, and turns failures
// into plain explanations.

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
    throw new Error(`"${t}" is not a URL`);
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

  /** A fetch for one purpose (e.g. "AI: Anthropic"); the SDK and MCP clients receive it. */
  fetchFor(purpose) {
    return async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init.method ?? (typeof input === 'object' ? input.method : null) ?? 'GET').toUpperCase();
      const origin = originOf(url);
      const entry = { time: new Date().toISOString().slice(11, 19), method, origin, path: (() => { try { return new URL(url).pathname; } catch { return url; } })(), status: 'blocked', sent: init.body ? (typeof init.body === 'string' ? init.body.length : init.body.byteLength ?? init.body.size ?? '?') : 0, received: 0, purpose };
      // The Online/Offline switch gates every request, whatever the CSP allows (REQ-NET-02).
      if (this.app.network && !this.app.network.isOnline()) {
        entry.status = 'offline';
        this.record(entry);
        const err = new Error(this.app.network.airgap ? 'this is the air-gapped file: it makes no network requests' : 'GIS Workbench is offline (status bar ▸ Offline). Go online to reach ' + origin + '.');
        err.offline = true;
        throw err;
      }
      if (!cspAllows(url)) {
        entry.status = 'not allowed';
        this.record(entry);
        const err = new Error(`${origin} is not in this file's network allow-list (CSP connect-src). Add it in Add-Ins ▸ Network Allow-List, save the file and reload it.`);
        err.notAllowed = true;
        throw err;
      }
      try {
        const r = await fetch(input, init);
        entry.status = r.status;
        entry.received = Number(r.headers.get('content-length') ?? 0) || '?';
        this.record(entry);
        return r;
      } catch (e) {
        entry.status = 'failed';
        this.record(entry);
        throw new Error(explainFetchFailure(e, origin));
      }
    };
  }
}

export function explainFetchFailure(e, origin) {
  if (e?.name === 'AbortError') return 'the request was cancelled';
  return `could not reach ${origin}: ${e?.message ?? e}. The network may be offline, the host may refuse cross-origin requests from a local file (Origin: null), or a proxy may block it.`;
}
