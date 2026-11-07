// Sign-in for data origins (REQ-GAP-09, REQ-GAP-10, OD-2.19; S-61).
//
// Two routes, both per origin and both explicit:
//   - OIDC / OAuth 2.1 for a public client: the device-authorization grant (RFC 8628) from a
//     file:// page, which has no redirect target, and the authorization-code grant with PKCE S256
//     (RFC 7636, the code shared with the MCP client in ai/mcp-client.js) and a redirect back to
//     the hosted copy. No client secret exists anywhere. Tokens live in a TokenVault in memory
//     only (REQ-SEC-10): never in preferences, storage, the project, exports, logs or URLs. They
//     go out only in an Authorization header, only to the origin they were obtained for, and are
//     refreshed before they expire and once after a 401.
//   - "Use my sign-in": browser credentials (credentials:'include', so client certificates and
//     single sign-on cookies) reach an origin only when the user marked that origin. Marking is
//     separate from the network allow-list, needs https, and an origin introduced by an imported
//     project is not used until the user confirms it. Every other request leaves with
//     credentials:'omit', whatever its caller asked for.
//
// DOM-free, so it tests in Node; the app (features/signin.js) gives it the logged fetch, the
// preferences and the confirmation dialogs. ai/netlog.js calls prepare() on every request.

import { pkce, authorizeUrl, exchangeCode } from '../ai/mcp-client.js';
import { gwError } from '../i18n/index.js';

export const CALLBACK_CHANNEL = 'gw-oidc';
export const STATE_PREFIX = 'gwo.';
export const PREF_KEY = 'signInOrigins';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/** The origin a request goes to; ws(s) URLs count as their http(s) origin. */
export function originKey(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'wss:') return `https://${u.host}`;
    if (u.protocol === 'ws:') return `http://${u.host}`;
    return u.origin === 'null' ? null : u.origin;
  } catch {
    return null;
  }
}

/** https, or http to this computer (RFC 8252 §8.3): where a bearer token may go. */
export function isSecureUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'wss:' || ((u.protocol === 'http:' || u.protocol === 'ws:') && LOOPBACK.test(u.hostname));
  } catch {
    return false;
  }
}

/** https (or wss) only: where browser credentials may go (REQ-GAP-10). */
export function isHttps(url) {
  try {
    const p = new URL(String(url)).protocol;
    return p === 'https:' || p === 'wss:';
  } catch {
    return false;
  }
}

const form = (o) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return q;
};
const POST = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, credentials: 'omit' });
const json = async (r) => {
  try {
    return await r.json();
  } catch {
    return null;
  }
};

/** The error of an OAuth error response (RFC 6749 §5.2), with its code kept for the caller. */
function oauthError(j, status) {
  const code = String(j?.error ?? `HTTP ${status}`);
  const e = gwError('the sign-in server refused: {error}', { error: j?.error_description ? `${code}: ${String(j.error_description).slice(0, 200)}` : code }, 'E_AUTH_REFUSED');
  e.oauth = code;
  return e;
}

/**
 * OIDC discovery (OpenID Connect Discovery 1.0 §4), else RFC 8414 metadata. Checks the issuer
 * matches and every endpoint the app may call is https (or http to this computer).
 */
export async function discover(issuer, fetchFn) {
  const iss = String(issuer ?? '').trim().replace(/\/+$/, '');
  if (!isSecureUrl(iss)) throw gwError('the sign-in issuer must be an https address: {url}', { url: iss }, 'E_AUTH_ISSUER');
  const u = new URL(iss);
  const tries = [`${iss}/.well-known/openid-configuration`, `${u.origin}/.well-known/oauth-authorization-server${u.pathname === '/' ? '' : u.pathname}`];
  let meta = null;
  let failed = null;
  let answered = false;
  for (const url of tries) {
    meta = await fetchFn(url, { credentials: 'omit', headers: { Accept: 'application/json' } }).then(
      (r) => {
        answered = true;
        return r.ok ? json(r) : null;
      },
      (e) => {
        failed = e;
        return null;
      },
    );
    if (meta?.token_endpoint) break;
  }
  // No answer at all is a network or CORS failure (a server that does not allow Origin: null from a
  // local file, or the allow-list): report that, not "no metadata".
  if (!meta?.token_endpoint && !answered && failed) throw failed;
  if (!meta?.token_endpoint) throw gwError('{issuer} publishes no OpenID Connect or OAuth metadata', { issuer: iss }, 'E_AUTH_NO_METADATA');
  if (meta.issuer && String(meta.issuer).replace(/\/+$/, '') !== iss) throw gwError('the metadata names another issuer ({other})', { other: String(meta.issuer) }, 'E_AUTH_ISSUER_MISMATCH');
  for (const k of ['token_endpoint', 'device_authorization_endpoint', 'authorization_endpoint', 'revocation_endpoint']) if (meta[k] && !isSecureUrl(meta[k])) throw gwError('the sign-in endpoint {url} is not https', { url: String(meta[k]) }, 'E_AUTH_INSECURE_ENDPOINT');
  if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes('S256')) meta.noS256 = true;
  return { ...meta, issuer: meta.issuer ?? iss };
}

/** The out-of-band redirect: the sign-in page shows the code to paste (ArcGIS, for a file opened from disk). */
export const OOB_REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';

/**
 * OAuth 2.0 metadata of an ArcGIS portal (REQ-GAP-64), which publishes no discovery document:
 * PKCE (S256), the out-of-band redirect, revocation by auth_token. ArcGIS has no device grant.
 * `root`: https://www.arcgis.com, https://org.maps.arcgis.com or https://host/portal.
 */
export function arcgisMeta(root) {
  const iss = String(root ?? '').trim().replace(/\/+$/, '');
  if (!isSecureUrl(iss)) throw gwError('the sign-in issuer must be an https address: {url}', { url: iss }, 'E_AUTH_ISSUER');
  const r = `${iss}/sharing/rest`;
  return { issuer: iss, authorization_endpoint: `${r}/oauth2/authorize`, token_endpoint: `${r}/oauth2/token`, revocation_endpoint: `${r}/oauth2/revokeToken`, revocationParam: 'auth_token', code_challenge_methods_supported: ['S256'], oob: true, kind: 'arcgis' };
}

/** Which grant fits: the device grant from file:// (no redirect target), PKCE from https. */
export function chooseGrant(meta, { wanted = 'auto', protocol = 'file:' } = {}) {
  const device = !!meta.device_authorization_endpoint;
  const code = !!meta.authorization_endpoint && !meta.noS256;
  const hosted = protocol === 'https:' || protocol === 'http:';
  if (wanted === 'device') return device ? 'device' : null;
  // An ArcGIS portal (REQ-GAP-64) also takes PKCE from a file opened from disk: its out-of-band
  // redirect shows the code to paste back.
  if (wanted === 'pkce') return code && (hosted || meta.oob) ? 'pkce' : null;
  if ((hosted || meta.oob) && code) return 'pkce';
  return device ? 'device' : null;
}

/** RFC 8628 §3.1–3.2: the device and user codes. */
export async function deviceAuthorize(meta, { clientId, scope = '' }, fetchFn) {
  if (!meta.device_authorization_endpoint) throw gwError('this sign-in server does not offer the device sign-in a local file needs', null, 'E_AUTH_NO_DEVICE');
  const r = await fetchFn(meta.device_authorization_endpoint, POST(form({ client_id: clientId, scope })));
  const j = await json(r);
  if (!r.ok) throw oauthError(j, r.status);
  if (!j?.device_code || !j?.user_code || !j?.verification_uri) throw gwError('the device sign-in reply is incomplete', null, 'E_AUTH_DEVICE_REPLY');
  // Only a page the user can open safely is shown as a link (no javascript: or data: URLs).
  if (!isSecureUrl(j.verification_uri) || (j.verification_uri_complete && !isSecureUrl(j.verification_uri_complete))) throw gwError('the sign-in page {url} is not https', { url: String(j.verification_uri) }, 'E_AUTH_INSECURE_ENDPOINT');
  return { deviceCode: j.device_code, userCode: String(j.user_code), verificationUri: j.verification_uri, verificationUriComplete: j.verification_uri_complete ?? null, expiresIn: Number(j.expires_in) || 600, interval: Math.max(1, Number(j.interval) || 5) };
}

const wait = (ms, signal) =>
  new Promise((res, rej) => {
    if (signal?.aborted) return rej(gwError('the request was cancelled', null, 'E_CANCELLED'));
    const id = setTimeout(res, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(id);
      rej(gwError('the request was cancelled', null, 'E_CANCELLED'));
    }, { once: true });
  });

/**
 * RFC 8628 §3.4–3.5: poll the token endpoint until the user signs in, denies, or the code
 * expires; `slow_down` adds 5 s. `onWait({left})` reports progress; `signal` cancels.
 */
export async function pollDevice(meta, { clientId, deviceCode, interval = 5, expiresIn = 600, signal, onWait, sleep = wait, now = Date.now }, fetchFn) {
  const end = now() + expiresIn * 1000;
  let gap = interval;
  for (;;) {
    await sleep(gap * 1000, signal);
    if (now() > end) throw gwError('the sign-in code expired; start again', null, 'E_AUTH_EXPIRED');
    const r = await fetchFn(meta.token_endpoint, { ...POST(form({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId })), signal });
    const j = await json(r);
    if (r.ok && j?.access_token) return j;
    const err = j?.error;
    if (err === 'authorization_pending') {
      onWait?.({ left: Math.max(0, Math.round((end - now()) / 1000)) });
      continue;
    }
    if (err === 'slow_down') {
      gap += 5;
      continue;
    }
    if (err === 'access_denied') throw gwError('the sign-in was declined', null, 'E_AUTH_DENIED');
    if (err === 'expired_token') throw gwError('the sign-in code expired; start again', null, 'E_AUTH_EXPIRED');
    throw oauthError(j, r.status);
  }
}

/** RFC 6749 §6: a new access token from the refresh token (the server may rotate it). */
export async function refreshGrant(meta, { clientId, refreshToken, scope = '' }, fetchFn) {
  const r = await fetchFn(meta.token_endpoint, POST(form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, scope })));
  const j = await json(r);
  if (!r.ok || !j?.access_token) throw oauthError(j, r.status);
  return j;
}

/**
 * The PKCE half before the redirect: the authorisation URL (the MCP client's builder), with the
 * verifier and state the caller keeps in memory until the code comes back.
 */
export async function beginPkce(meta, { clientId, redirectUri, scope = '' }) {
  if (!meta.authorization_endpoint || meta.noS256) throw gwError('this sign-in server does not offer PKCE (S256)', null, 'E_AUTH_NO_PKCE');
  const { verifier, challenge } = await pkce();
  const state = `${STATE_PREFIX}${crypto.randomUUID()}`;
  return { url: authorizeUrl(meta, { clientId, redirectUri, scope, state, challenge }), verifier, state, redirectUri };
}

/** The PKCE half after the redirect (the MCP client's code exchange). */
export function finishPkce(meta, { code, verifier, clientId, redirectUri }, fetchFn) {
  return exchangeCode(meta, { code, verifier, clientId, redirectUri }, (u, init) => fetchFn(u, { ...init, credentials: 'omit' }));
}

/** The {code, state, error, iss} of a redirect back to this page, or null when it is not one of ours. */
export function parseCallback(href) {
  let u;
  try {
    u = new URL(String(href));
  } catch {
    return null;
  }
  const q = u.searchParams;
  const state = q.get('state');
  if (!state?.startsWith(STATE_PREFIX) || !(q.has('code') || q.has('error'))) return null;
  return { code: q.get('code'), state, error: q.get('error'), errorDescription: q.get('error_description'), iss: q.get('iss') };
}

/** The page URL without the sign-in parameters (so the code does not stay in the address bar or history). */
export function stripCallback(href) {
  const u = new URL(String(href));
  for (const k of ['code', 'state', 'error', 'error_description', 'iss', 'session_state']) u.searchParams.delete(k);
  return u.href;
}

/**
 * In a sign-in window the hosted copy opened: hand the code to the page that waits for it
 * (BroadcastChannel, same origin; window.opener may be cut by the server's COOP) and stop.
 * Returns true when this page load was a sign-in callback (the caller then does not boot).
 */
export function relayCallback(win = globalThis) {
  const cb = win.location ? parseCallback(win.location.href) : null;
  if (!cb) return false;
  try {
    win.history?.replaceState?.(null, '', stripCallback(win.location.href));
  } catch {
    /* keep the address */
  }
  try {
    const ch = new win.BroadcastChannel(CALLBACK_CHANNEL);
    ch.postMessage({ type: 'oidc-callback', ...cb });
    ch.close();
  } catch {
    /* no BroadcastChannel: the user pastes the code */
  }
  return true;
}

/**
 * Tokens per origin, in memory only. Private fields: JSON.stringify, structuredClone and
 * console inspection of the vault show no token. bearer() refreshes ahead of expiry, once
 * at a time per origin; refresh() after a 401.
 */
export class TokenVault {
  #s = new Map();
  #inflight = new Map();
  constructor({ fetch, now = Date.now, onChange = () => {} } = {}) {
    this.#fetch = fetch;
    this.now = now;
    this.onChange = onChange;
  }
  #fetch;

  /** Keep the tokens of a grant for `origin` (the data origin they are sent to). */
  set(origin, tok, { meta, clientId, scope = '' }) {
    if (!tok?.access_token) throw gwError('the token response has no access token', null, 'E_AUTH_NO_TOKEN');
    const prev = this.#s.get(origin);
    const life = Math.max(1, Number(tok.expires_in) || 3600) * 1000;
    this.#s.set(origin, { access: tok.access_token, refresh: tok.refresh_token ?? prev?.refresh ?? null, expiresAt: this.now() + life, life, meta, clientId, scope, issuer: meta?.issuer ?? null, refreshed: prev ? prev.refreshed + 1 : 0 });
    this.onChange(origin);
  }

  has(origin) {
    return this.#s.has(origin);
  }

  /** What may be shown about a session: no token. */
  info(origin) {
    const s = this.#s.get(origin);
    return s ? { origin, issuer: s.issuer, scope: s.scope, expiresAt: s.expiresAt, canRefresh: !!s.refresh, refreshed: s.refreshed } : null;
  }

  origins() {
    return [...this.#s.keys()];
  }

  /** The access token for `origin`, refreshed first when it is within a quarter of its life (≤ 60 s) of expiring. */
  async bearer(origin) {
    const s = this.#s.get(origin);
    if (!s) return null;
    const skew = Math.min(60_000, s.life / 4);
    if (this.now() >= s.expiresAt - skew) {
      if (!s.refresh) {
        if (this.now() < s.expiresAt) return s.access;
        this.clear(origin);
        return null;
      }
      await this.refresh(origin).catch(() => null);
      const n = this.#s.get(origin);
      return n && this.now() < n.expiresAt ? n.access : null;
    }
    return s.access;
  }

  /**
   * Refresh now (single flight). When the server refuses the refresh token the session ends and
   * the user signs in again; a network failure (offline, unreachable) keeps it for a later try.
   */
  refresh(origin) {
    const s = this.#s.get(origin);
    if (!s?.refresh) return Promise.reject(gwError('the session for {origin} has ended; sign in again', { origin }, 'E_AUTH_SESSION_ENDED'));
    if (this.#inflight.has(origin)) return this.#inflight.get(origin);
    const p = refreshGrant(s.meta, { clientId: s.clientId, refreshToken: s.refresh, scope: s.scope }, this.#fetch)
      .then((tok) => this.set(origin, tok, s))
      .catch((e) => {
        if (e?.code === 'E_AUTH_REFUSED') this.clear(origin);
        throw e;
      })
      .finally(() => this.#inflight.delete(origin));
    this.#inflight.set(origin, p);
    return p;
  }

  /** Forget the session (and revoke the refresh token where the server offers revocation, RFC 7009). */
  async signOut(origin) {
    const s = this.#s.get(origin);
    this.clear(origin);
    if (s?.refresh && s.meta?.revocation_endpoint) await this.#fetch(s.meta.revocation_endpoint, POST(form({ [s.meta.revocationParam ?? 'token']: s.refresh, token_type_hint: 'refresh_token', client_id: s.clientId }))).catch(() => null);
  }

  clear(origin) {
    if (this.#s.delete(origin)) this.onChange(origin);
  }

  /** True when `text` contains any token held here (the security tests' probe). */
  appearsIn(text) {
    const t = String(text);
    for (const s of this.#s.values()) if (t.includes(s.access) || (s.refresh && t.includes(s.refresh))) return true;
    return false;
  }

  toJSON() {
    return { sessions: this.origins().map((o) => this.info(o)) };
  }
}

/** Check and normalise one sign-in entry {origin, browser, oidc:{issuer, clientId, scope, grant}}. */
export function checkEntry(e) {
  const origin = originKey(e?.origin);
  if (!origin) throw gwError('"{text}" is not a URL', { text: String(e?.origin ?? '') }, 'E_NOT_A_URL');
  if (/[*]/.test(String(e.origin))) throw gwError('wildcard origins are refused', null, 'E_AUTH_WILDCARD');
  const browser = !!e.browser;
  if (browser && !isHttps(origin)) throw gwError('"use my sign-in" needs an https origin: {origin}', { origin }, 'E_SIGNIN_NOT_HTTPS');
  let oidc = null;
  if (e.oidc?.issuer) {
    if (!isSecureUrl(origin)) throw gwError('a token can only be sent to an https origin: {origin}', { origin }, 'E_AUTH_INSECURE_ORIGIN');
    const issuer = String(e.oidc.issuer).trim().replace(/\/+$/, '');
    if (!isSecureUrl(issuer)) throw gwError('the sign-in issuer must be an https address: {url}', { url: issuer }, 'E_AUTH_ISSUER');
    const clientId = String(e.oidc.clientId ?? '').trim();
    if (!clientId) throw gwError('a client ID is needed (register GIS Workbench as a public client)', null, 'E_AUTH_NO_CLIENT');
    oidc = { issuer, clientId, scope: String(e.oidc.scope ?? 'openid offline_access').trim(), grant: ['device', 'pkce'].includes(e.oidc.grant) ? e.oidc.grant : 'auto' };
    // An ArcGIS portal (REQ-GAP-64): OAuth 2.0 without discovery, the token in the header ArcGIS
    // reads, and the portal's hosting and federated servers the user confirmed one by one.
    if (e.oidc.kind === 'arcgis') {
      oidc.kind = 'arcgis';
      oidc.scope = String(e.oidc.scope ?? '').trim();
      oidc.header = 'X-Esri-Authorization';
      const also = [];
      for (const a of Array.isArray(e.oidc.alsoFor) ? e.oidc.alsoFor : []) {
        if (/[*]/.test(String(a))) throw gwError('wildcard origins are refused', null, 'E_AUTH_WILDCARD');
        const o = originKey(a);
        if (!o || !isSecureUrl(o)) throw gwError('a token can only be sent to an https origin: {origin}', { origin: String(a) }, 'E_AUTH_INSECURE_ORIGIN');
        if (o !== origin && !also.includes(o)) also.push(o);
      }
      oidc.alsoFor = also;
    }
  }
  if (!browser && !oidc) throw gwError('choose "use my sign-in", an OpenID Connect issuer, or both', null, 'E_SIGNIN_EMPTY');
  return { origin, browser, oidc };
}

const same = (a, b) => JSON.stringify([a.browser, a.oidc]) === JSON.stringify([b.browser, b.oidc]);

/**
 * The per-origin sign-in policy. `store` is {get(), set(list)} over the user's own preferences
 * (never the project). Entries a project brings wait in `pending` until confirm().
 */
export class SignInPolicy {
  constructor({ store, vault, pageOrigin = null, onChange = () => {} }) {
    this.store = store;
    this.vault = vault;
    this.pageOrigin = pageOrigin;
    this.onChange = onChange;
    this.pending = new Map(); // origin → {entry, from}
    this.used = new Map(); // origin → {how, at}: the indicator
  }

  /** The user's entries (confirmed by definition: only the user's own actions write them). */
  list() {
    const v = this.store.get();
    return Array.isArray(v) ? v.filter((e) => e && typeof e.origin === 'string') : [];
  }

  get(origin) {
    return this.list().find((e) => e.origin === origin) ?? null;
  }

  /** Add or change an entry by the user's own action. */
  set(entry, { via = 'user' } = {}) {
    const e = { ...checkEntry(entry), via, at: new Date().toISOString() };
    this.store.set([...this.list().filter((x) => x.origin !== e.origin), e]);
    this.pending.delete(e.origin);
    this.onChange(e.origin);
    return e;
  }

  remove(origin) {
    this.store.set(this.list().filter((x) => x.origin !== origin));
    this.vault?.clear(origin);
    this.onChange(origin);
  }

  /**
   * A project's sign-in setups (project.signIn). Those the user already has, unchanged, need
   * nothing; every other one waits for confirmation and is not used meanwhile. Returns the waiting ones.
   */
  offer(list, from) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      let e;
      try {
        e = checkEntry(raw);
      } catch {
        continue; // a malformed or non-https entry is dropped, never relaxed
      }
      const mine = this.get(e.origin);
      if (mine && same(mine, e)) continue;
      this.pending.set(e.origin, { entry: e, from });
      out.push(e);
    }
    if (out.length) this.onChange(null);
    return out;
  }

  confirm(origin) {
    const p = this.pending.get(origin);
    if (!p) return null;
    return this.set(p.entry, { via: 'project' });
  }

  decline(origin) {
    this.pending.delete(origin);
    this.onChange(origin);
  }

  /** Whether browser credentials may go to `url` (marked by the user, confirmed, https, exact origin). */
  browserSignIn(url) {
    const o = originKey(url);
    if (!o || !isHttps(url)) return false;
    return !!this.get(o)?.browser;
  }

  /** For a client that cannot choose its credentials mode (WebSocket handshakes send cookies and client certificates): refuse unless marked. */
  assertBrowserSignIn(url) {
    if (this.browserSignIn(url)) return true;
    const o = originKey(url) ?? String(url);
    if (!isHttps(url)) throw gwError('"use my sign-in" needs an https origin: {origin}', { origin: o }, 'E_SIGNIN_NOT_HTTPS');
    if (this.pending.has(o)) throw gwError('{origin} came with an imported project; confirm "use my sign-in" for it first', { origin: o }, 'E_SIGNIN_UNCONFIRMED');
    throw gwError('mark {origin} "use my sign-in" (Online ▸ Sign-In for Data Origins) to send your certificate or single sign-on to it', { origin: o }, 'E_SIGNIN_NOT_MARKED');
  }

  /** What the indicator shows: origins that are marked, signed in, or waiting for confirmation. */
  summary() {
    const marked = this.list().filter((e) => e.browser).map((e) => e.origin);
    const sessions = this.vault?.origins() ?? [];
    return { marked, sessions, pending: [...this.pending.keys()], used: [...this.used.keys()] };
  }

  /**
   * The init a request leaves with (ai/netlog.js). Browser credentials only to a marked https
   * origin, otherwise 'omit' (same-origin requests of a hosted copy keep the caller's choice);
   * the bearer token only to its own origin, in the Authorization header, unless the caller set
   * one (SigV4, a typed token). `auth:false` (the sign-in calls themselves) adds nothing.
   */
  async prepare(input, init = {}, { auth = true } = {}) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    const origin = originKey(url);
    const out = { ...init };
    let how = null;
    const sameOrigin = this.pageOrigin && origin === this.pageOrigin;
    if (!sameOrigin) {
      if (auth && this.browserSignIn(url)) {
        out.credentials = 'include';
        how = 'browser';
      } else out.credentials = 'omit';
    }
    // The session that serves this origin: its own, or an ArcGIS portal's whose servers the user
    // confirmed for it (oidc.alsoFor).
    const owner = origin && (this.get(origin)?.oidc ? origin : this.list().find((e) => e.oidc?.alsoFor?.includes(origin))?.origin);
    if (auth && owner && this.vault?.has(owner) && isSecureUrl(url)) {
      const headers = new Headers(init.headers ?? (typeof input === 'object' && input?.headers ? input.headers : undefined));
      const name = this.get(owner).oidc.header ?? 'Authorization';
      if (!headers.has('Authorization') && !headers.has(name)) {
        const tok = await this.vault.bearer(owner);
        if (tok) {
          headers.set(name, `Bearer ${tok}`);
          out.headers = headers;
          how = how ? 'browser+bearer' : 'bearer';
        }
      }
    }
    if (how) this.used.set(origin, { how, at: Date.now() });
    return { init: out, how, origin, owner: how?.includes('bearer') ? owner : null };
  }
}
