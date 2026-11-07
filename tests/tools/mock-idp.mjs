// Mock OpenID Connect provider and protected data services for the sign-in tests (S-61,
// REQ-GAP-09, REQ-GAP-10). Local test servers only; nothing here is shipped.
//
//   startMockIdp(opts)       discovery, device authorization (RFC 8628), authorization code with
//                            PKCE S256 only (RFC 7636 / OAuth 2.1), refresh with rotation and reuse
//                            detection, revocation (RFC 7009), RFC 9207 iss on the redirect.
//   startResource(idp, opts) a data origin that wants a bearer token from that IdP: JSON and a
//                            byte-range file, 401 with WWW-Authenticate otherwise.
//   startCookieServer(opts)  an https origin that reports whether a cookie reached it (the
//                            "use my sign-in" tests; a self-signed certificate made with openssl).
//
// CORS per server: 'star' (Access-Control-Allow-Origin: *), 'reflect' (the request's Origin,
// "null" from a file:// page, with Allow-Credentials) or 'none'. Every request is logged with its
// Origin header and whether it was a preflight, which the validation note reports.

import { createServer } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rnd = (p) => `${p}${b64url(randomBytes(24))}`;

function corsHeaders(mode, req, { methods = 'GET, POST, OPTIONS', headers = 'authorization, content-type, range', expose = 'content-range, content-length, www-authenticate' } = {}) {
  if (mode === 'none') return {};
  const o = req.headers.origin;
  const h = { 'access-control-allow-methods': methods, 'access-control-allow-headers': headers, 'access-control-expose-headers': expose, vary: 'Origin' };
  if (mode === 'star') h['access-control-allow-origin'] = '*';
  else if (mode === 'reflect' && o) {
    h['access-control-allow-origin'] = o;
    h['access-control-allow-credentials'] = 'true';
  }
  return h;
}

function readBody(req) {
  return new Promise((res) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => res(s));
  });
}

const listen = (srv, host = '127.0.0.1') => new Promise((r) => srv.listen(0, host, () => r(srv.address().port)));

/**
 * opts: clients {id: {redirectUris: [...]}} (default one public client "gw-test" whose redirect
 * URIs are any http(s)://127.0.0.1 page), accessTtl s, refreshTtl s, interval s, cors,
 * autoApprove (the /authorize page redirects at once), deviceTtl s.
 */
export async function startMockIdp(opts = {}) {
  const o = { accessTtl: 3600, interval: 1, deviceTtl: 600, cors: 'star', autoApprove: true, clients: null, ...opts };
  const state = {
    log: [],
    devices: new Map(), // device_code → {user_code, client, scope, status, exp, last}
    codes: new Map(), // code → {client, redirect, challenge, scope, used, family}
    access: new Map(), // token → {exp, scope, client, family, revoked}
    refresh: new Map(), // token → {client, scope, family, used}
    slowDowns: 0,
    pendings: 0, // device polls answered 400 authorization_pending
    revoked: [],
  };
  const clientOk = (id) => (o.clients ? !!o.clients[id] : id === 'gw-test');
  const redirectOk = (id, uri) => (o.clients?.[id] ? o.clients[id].redirectUris.includes(uri) : /^https?:\/\/127\.0\.0\.1:\d+\//.test(uri));
  let issuer;
  const issue = (client, scope, family = rnd('f.')) => {
    const at = rnd('at.');
    const rt = rnd('rt.');
    state.access.set(at, { exp: Date.now() + o.accessTtl * 1000, scope, client, family });
    state.refresh.set(rt, { client, scope, family, used: false });
    return { access_token: at, token_type: 'Bearer', expires_in: o.accessTtl, refresh_token: rt, scope };
  };
  const revokeFamily = (family) => {
    for (const [k, v] of state.access) if (v.family === family) v.revoked = true;
    for (const [k, v] of state.refresh) if (v.family === family) v.used = true;
  };
  const srv = createServer(async (req, res) => {
    const u = new URL(req.url, issuer);
    const cors = corsHeaders(o.cors, req);
    state.log.push({ method: req.method, path: u.pathname, query: u.search, origin: req.headers.origin ?? null, preflight: req.method === 'OPTIONS', cookie: !!req.headers.cookie });
    const json = (code, body, extra = {}) => {
      res.writeHead(code, { ...cors, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const body = new URLSearchParams(req.method === 'POST' ? await readBody(req) : '');
    if (u.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        device_authorization_endpoint: `${issuer}/device`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ['openid', 'offline_access', 'data.read'],
      });
    }
    if (u.pathname === '/device' && req.method === 'POST') {
      const client = body.get('client_id');
      if (!clientOk(client)) return json(400, { error: 'invalid_client' });
      const dc = rnd('dc.');
      const uc = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
      state.devices.set(dc, { user_code: uc, client, scope: body.get('scope') ?? '', status: 'pending', exp: Date.now() + o.deviceTtl * 1000, last: 0 });
      return json(200, { device_code: dc, user_code: uc, verification_uri: `${issuer}/activate`, verification_uri_complete: `${issuer}/activate?user_code=${encodeURIComponent(uc)}`, expires_in: o.deviceTtl, interval: o.interval });
    }
    if (u.pathname === '/activate') {
      // What the user does on another device: the test calls it with decision=approve|deny.
      const uc = u.searchParams.get('user_code') ?? body.get('user_code');
      const d = [...state.devices.values()].find((x) => x.user_code === uc);
      const decision = u.searchParams.get('decision') ?? body.get('decision');
      if (d && decision) d.status = decision === 'deny' ? 'denied' : 'approved';
      res.writeHead(d ? 200 : 404, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>Mock IdP</title><p>${d ? `Code ${uc}: ${d.status}` : 'unknown code'}</p>`);
    }
    if (u.pathname === '/authorize') {
      const q = u.searchParams;
      const client = q.get('client_id');
      const redirect = q.get('redirect_uri');
      if (!clientOk(client) || !redirectOk(client, redirect)) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end('invalid client or redirect_uri');
      }
      const back = new URL(redirect);
      back.searchParams.set('state', q.get('state') ?? '');
      back.searchParams.set('iss', issuer);
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        back.searchParams.set('error', 'invalid_request');
        back.searchParams.set('error_description', 'PKCE S256 is required');
      } else {
        const code = rnd('c.');
        state.codes.set(code, { client, redirect, challenge: q.get('code_challenge'), scope: q.get('scope') ?? '', used: false, exp: Date.now() + 60_000 });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      const g = body.get('grant_type');
      const client = body.get('client_id');
      if (!clientOk(client)) return json(401, { error: 'invalid_client' });
      if (body.get('client_secret')) return json(400, { error: 'invalid_request', error_description: 'public client: no secret expected' });
      if (g === 'urn:ietf:params:oauth:grant-type:device_code') {
        const d = state.devices.get(body.get('device_code'));
        if (!d || d.client !== client) return json(400, { error: 'invalid_grant' });
        const now = Date.now();
        if (now > d.exp) return json(400, { error: 'expired_token' });
        if (d.last && now - d.last < o.interval * 1000 - 150) {
          d.last = now;
          state.slowDowns++;
          return json(400, { error: 'slow_down' });
        }
        d.last = now;
        if (d.status === 'pending') {
          state.pendings++;
          return json(400, { error: 'authorization_pending' });
        }
        if (d.status === 'denied') return json(400, { error: 'access_denied' });
        if (d.status === 'used') return json(400, { error: 'invalid_grant' });
        d.status = 'used';
        return json(200, issue(client, d.scope));
      }
      if (g === 'authorization_code') {
        const c = state.codes.get(body.get('code'));
        if (!c || c.client !== client || c.redirect !== body.get('redirect_uri') || Date.now() > c.exp) return json(400, { error: 'invalid_grant' });
        if (c.used) {
          if (c.family) revokeFamily(c.family);
          return json(400, { error: 'invalid_grant', error_description: 'code reused' });
        }
        c.used = true;
        const v = body.get('code_verifier') ?? '';
        if (b64url(createHash('sha256').update(v).digest()) !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        const t = issue(client, c.scope);
        c.family = state.access.get(t.access_token).family;
        return json(200, t);
      }
      if (g === 'refresh_token') {
        const r = state.refresh.get(body.get('refresh_token'));
        if (!r || r.client !== client) return json(400, { error: 'invalid_grant' });
        if (r.used) {
          revokeFamily(r.family); // reuse of a rotated refresh token: the whole grant ends
          return json(400, { error: 'invalid_grant', error_description: 'refresh token reused' });
        }
        r.used = true;
        return json(200, issue(client, r.scope, r.family));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/revoke' && req.method === 'POST') {
      const tok = body.get('token');
      state.revoked.push(tok);
      const r = state.refresh.get(tok);
      if (r) revokeFamily(r.family);
      const a = state.access.get(tok);
      if (a) a.revoked = true;
      res.writeHead(200, cors);
      return res.end();
    }
    res.writeHead(404, cors);
    res.end();
  });
  const port = await listen(srv);
  issuer = `http://127.0.0.1:${port}`;
  return {
    issuer,
    origin: issuer,
    state,
    opts: o,
    /** Whether an access token is valid now (the resource server's introspection). */
    valid(tok) {
      const a = state.access.get(tok);
      return !!a && !a.revoked && Date.now() < a.exp;
    },
    /** End every access token now (refresh tokens stay): the next data request gets 401. */
    expireAccess() {
      for (const a of state.access.values()) a.exp = 0;
    },
    /** Every token the IdP has issued (the leak probes search for these). */
    tokens() {
      return [...state.access.keys(), ...state.refresh.keys()];
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}

/** A data origin protected by `idp`: /api/info (JSON), /data/file.bin and `files` {path: Buffer} (byte ranges). */
export async function startResource(idp, { cors = 'star', size = 4096, files = {} } = {}) {
  const synth = Buffer.alloc(size);
  for (let i = 0; i < size; i++) synth[i] = (i * 7) & 255;
  const served = { '/data/file.bin': synth, ...files };
  const log = [];
  let origin;
  const srv = createServer((req, res) => {
    const u = new URL(req.url, origin);
    const ch = corsHeaders(cors, req);
    const auth = req.headers.authorization ?? null;
    log.push({ method: req.method, path: u.pathname, query: u.search, origin: req.headers.origin ?? null, preflight: req.method === 'OPTIONS', auth, cookie: req.headers.cookie ?? null, url: req.url });
    if (req.method === 'OPTIONS') {
      res.writeHead(204, ch);
      return res.end();
    }
    const tok = /^Bearer (.+)$/.exec(auth ?? '')?.[1];
    if (!tok || !idp.valid(tok)) {
      res.writeHead(401, { ...ch, 'www-authenticate': `Bearer realm="mock", error="${tok ? 'invalid_token' : 'invalid_request'}"`, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    if (u.pathname === '/api/info') {
      res.writeHead(200, { ...ch, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, size }));
    }
    const bytes = served[u.pathname];
    if (bytes) {
      const size = bytes.length;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (!m) {
        res.writeHead(200, { ...ch, 'content-type': 'application/octet-stream', 'content-length': size });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      const a = Number(m[1]);
      const b = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      res.writeHead(206, { ...ch, 'content-type': 'application/octet-stream', 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': b - a + 1 });
      return res.end(bytes.subarray(a, b + 1));
    }
    res.writeHead(404, ch);
    res.end();
  });
  const port = await listen(srv);
  origin = `http://127.0.0.1:${port}`;
  return { origin, log, bytes: synth, close: () => new Promise((r) => srv.close(r)) };
}

/** A self-signed certificate for 127.0.0.1 and localhost made with openssl; null when openssl is missing. */
export function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), 'gw-auth-cert-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore', timeout: 30_000 });
  } catch {
    return null;
  }
  return existsSync(cert) ? { key: readFileSync(key), cert: readFileSync(cert) } : null;
}

/**
 * An https origin that reports what reached it: /whoami answers {cookie} with CORS that allows
 * credentials for the request's Origin; /star answers with Access-Control-Allow-Origin: * (which
 * a credentialed request may not read).
 */
export async function startCookieServer({ key, cert }) {
  const log = [];
  let origin;
  const srv = createHttps({ key, cert }, (req, res) => {
    const u = new URL(req.url, origin);
    log.push({ method: req.method, path: u.pathname, origin: req.headers.origin ?? null, cookie: req.headers.cookie ?? null, auth: req.headers.authorization ?? null, preflight: req.method === 'OPTIONS' });
    const ch = corsHeaders(u.pathname === '/star' ? 'star' : 'reflect', req);
    res.writeHead(req.method === 'OPTIONS' ? 204 : 200, { ...ch, 'content-type': 'application/json' });
    res.end(req.method === 'OPTIONS' ? undefined : JSON.stringify({ cookie: req.headers.cookie ?? null }));
  });
  const port = await listen(srv);
  origin = `https://127.0.0.1:${port}`;
  return { origin, log, close: () => new Promise((r) => srv.close(r)) };
}

// Run alone for manual checks: node tests/tools/mock-idp.mjs
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('mock-idp.mjs')) {
  const idp = await startMockIdp({ cors: process.env.CORS ?? 'star' });
  const rs = await startResource(idp);
  console.log(`issuer ${idp.issuer}\nresource ${rs.origin}\nclient_id gw-test`);
}
