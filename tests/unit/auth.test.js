// Security suite for sign-in to data origins (REQ-GAP-09, REQ-GAP-10, REQ-SEC-10; S-61) against
// the mock IdP (tests/tools/mock-idp.mjs): device grant, PKCE, refresh with rotation, and the
// per-origin "use my sign-in" policy as ai/netlog.js applies it to every request.
//   - a token never appears in URLs, logs, the vault's serialisation or the sign-in settings;
//   - browser credentials never go to an unmarked origin, whatever the caller asked;
//   - an origin an imported project introduces is not used until the user confirms it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { discover, chooseGrant, deviceAuthorize, pollDevice, beginPkce, finishPkce, parseCallback, stripCallback, refreshGrant, TokenVault, SignInPolicy, checkEntry, originKey, isSecureUrl, isHttps, relayCallback, STATE_PREFIX } from '../../app/src/connectors/auth.js';
import { NetLog } from '../../app/src/ai/netlog.js';
import { startMockIdp, startResource } from '../tools/mock-idp.mjs';

const memStore = (init = []) => {
  let v = init;
  return { get: () => v, set: (x) => (v = JSON.parse(JSON.stringify(x))), raw: () => v };
};
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: new Headers() });

let idp;
let rs;
beforeAll(async () => {
  idp = await startMockIdp({ interval: 1 });
  rs = await startResource(idp);
});
afterAll(async () => {
  await idp?.close();
  await rs?.close();
});

/** Device grant end to end against the mock: approve on "another device", poll, tokens. */
async function deviceTokens(meta, { approve = true } = {}) {
  const d = await deviceAuthorize(meta, { clientId: 'gw-test', scope: 'openid offline_access' }, fetch);
  setTimeout(() => fetch(`${d.verificationUri}?user_code=${encodeURIComponent(d.userCode)}&decision=${approve ? 'approve' : 'deny'}`), 1200);
  return pollDevice(meta, { clientId: 'gw-test', deviceCode: d.deviceCode, interval: d.interval, expiresIn: d.expiresIn }, fetch);
}

describe('helpers', () => {
  it('origins, https and loopback', () => {
    expect(originKey('wss://data.example.org:8443/x')).toBe('https://data.example.org:8443');
    expect(originKey('file:///C:/a.html')).toBeNull();
    expect(isSecureUrl('http://127.0.0.1:9/x')).toBe(true);
    expect(isSecureUrl('http://example.org/')).toBe(false);
    expect(isHttps('http://127.0.0.1:9/')).toBe(false);
    expect(isHttps('https://a.example/')).toBe(true);
  });

  it('entries: https only for browser credentials, no wildcards, a client id for OIDC', () => {
    expect(() => checkEntry({ origin: 'http://data.example.org', browser: true })).toThrow(/https/);
    expect(() => checkEntry({ origin: 'http://127.0.0.1:8080', browser: true })).toThrow(/https/);
    expect(() => checkEntry({ origin: 'https://*.example.org', browser: true })).toThrow();
    expect(() => checkEntry({ origin: 'https://a.example', oidc: { issuer: 'https://idp.example' } })).toThrow(/client ID/);
    expect(() => checkEntry({ origin: 'https://a.example', oidc: { issuer: 'http://idp.example', clientId: 'x' } })).toThrow(/issuer/);
    expect(() => checkEntry({ origin: 'https://a.example' })).toThrow();
    expect(checkEntry({ origin: 'https://a.example/path/x', browser: true })).toEqual({ origin: 'https://a.example', browser: true, oidc: null });
  });

  it('chooses the device grant from file:// and PKCE from the hosted copy', () => {
    const both = { device_authorization_endpoint: 'x', authorization_endpoint: 'y' };
    expect(chooseGrant(both, { protocol: 'file:' })).toBe('device');
    expect(chooseGrant(both, { protocol: 'https:' })).toBe('pkce');
    expect(chooseGrant(both, { protocol: 'https:', wanted: 'device' })).toBe('device');
    expect(chooseGrant(both, { protocol: 'file:', wanted: 'pkce' })).toBeNull();
    expect(chooseGrant({ authorization_endpoint: 'y' }, { protocol: 'file:' })).toBeNull();
    expect(chooseGrant({ authorization_endpoint: 'y', noS256: true }, { protocol: 'https:' })).toBeNull();
  });

  it('parses only our own callbacks and strips them from the address', () => {
    expect(parseCallback('https://gw.example/app.html?code=abc&state=other')).toBeNull();
    expect(parseCallback(`https://gw.example/app.html?code=abc&state=${STATE_PREFIX}1&iss=https%3A%2F%2Fidp`)).toMatchObject({ code: 'abc', state: `${STATE_PREFIX}1`, iss: 'https://idp' });
    expect(stripCallback(`https://gw.example/app.html?x=1&code=abc&state=${STATE_PREFIX}1#h`)).toBe('https://gw.example/app.html?x=1#h');
  });

  it('a sign-in window relays the code over the BroadcastChannel and replaces its address', () => {
    const sent = [];
    let replaced = null;
    const win = {
      location: { href: `https://gw.example/gis-workbench.html?code=C1&state=${STATE_PREFIX}s` },
      history: { replaceState: (_a, _b, u) => (replaced = u) },
      BroadcastChannel: class {
        postMessage(m) {
          sent.push(m);
        }
        close() {}
      },
    };
    expect(relayCallback(win)).toBe(true);
    expect(sent[0]).toMatchObject({ type: 'oidc-callback', code: 'C1', state: `${STATE_PREFIX}s` });
    expect(replaced).toBe('https://gw.example/gis-workbench.html');
    expect(relayCallback({ location: { href: 'https://gw.example/gis-workbench.html' } })).toBe(false);
  });
});

describe('OIDC against the mock IdP (S-61)', () => {
  it('discovers the metadata and refuses a mismatched issuer or an insecure endpoint', async () => {
    const meta = await discover(`${idp.issuer}/`, fetch);
    expect(meta.issuer).toBe(idp.issuer);
    expect(meta.device_authorization_endpoint).toBe(`${idp.issuer}/device`);
    const lying = async () => fakeRes(200, { issuer: 'https://evil.example', token_endpoint: 'https://evil.example/token' });
    await expect(discover('https://idp.example', lying)).rejects.toMatchObject({ code: 'E_AUTH_ISSUER_MISMATCH' });
    const insecure = async () => fakeRes(200, { issuer: 'https://idp.example', token_endpoint: 'http://idp.example/token' });
    await expect(discover('https://idp.example', insecure)).rejects.toMatchObject({ code: 'E_AUTH_INSECURE_ENDPOINT' });
    await expect(discover('http://idp.example', fetch)).rejects.toMatchObject({ code: 'E_AUTH_ISSUER' });
  });

  it('device grant: pending until approved, then tokens; denied is reported', async () => {
    const meta = await discover(idp.issuer, fetch);
    const t0 = Date.now();
    const tok = await deviceTokens(meta);
    expect(tok.access_token).toMatch(/^at\./);
    expect(tok.refresh_token).toMatch(/^rt\./);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(idp.state.slowDowns).toBe(0); // the client kept the server's interval
    await expect(deviceTokens(meta, { approve: false })).rejects.toMatchObject({ code: 'E_AUTH_DENIED' });
  }, 20000);

  it('device grant: slow_down adds 5 s, expired_token and cancel end the poll', async () => {
    const replies = [{ error: 'slow_down' }, { error: 'authorization_pending' }, { error: 'expired_token' }];
    const gaps = [];
    const f = async () => fakeRes(400, replies.shift());
    const meta = { token_endpoint: 'https://idp.example/token' };
    await expect(pollDevice(meta, { clientId: 'c', deviceCode: 'd', interval: 2, sleep: async (ms) => gaps.push(ms) }, f)).rejects.toMatchObject({ code: 'E_AUTH_EXPIRED' });
    expect(gaps).toEqual([2000, 7000, 7000]);
    const ac = new AbortController();
    const p = pollDevice(meta, { clientId: 'c', deviceCode: 'd', interval: 1, signal: ac.signal }, f);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'E_CANCELLED' });
  });

  it('PKCE: S256 challenge, redirect with state and iss, code exchanged once; a wrong verifier fails', async () => {
    const meta = await discover(idp.issuer, fetch);
    const redirectUri = 'http://127.0.0.1:1/gis-workbench.html';
    const go = async (p) => {
      const r = await fetch(p.url, { redirect: 'manual' });
      expect(r.status).toBe(302);
      return parseCallback(r.headers.get('location'));
    };
    const p = await beginPkce(meta, { clientId: 'gw-test', redirectUri, scope: 'openid' });
    const q = new URL(p.url).searchParams;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).not.toBe(p.verifier);
    expect(q.has('code_verifier')).toBe(false);
    const cb = await go(p);
    expect(cb.state).toBe(p.state);
    expect(cb.iss).toBe(idp.issuer);
    const tok = await finishPkce(meta, { code: cb.code, verifier: p.verifier, clientId: 'gw-test', redirectUri }, fetch);
    expect(tok.access_token).toMatch(/^at\./);
    // Replay of the code: refused (and the grant it produced is revoked by the server).
    await expect(finishPkce(meta, { code: cb.code, verifier: p.verifier, clientId: 'gw-test', redirectUri }, fetch)).rejects.toThrow();
    expect(idp.valid(tok.access_token)).toBe(false);
    const p2 = await beginPkce(meta, { clientId: 'gw-test', redirectUri });
    const cb2 = await go(p2);
    await expect(finishPkce(meta, { code: cb2.code, verifier: 'not-the-verifier', clientId: 'gw-test', redirectUri }, fetch)).rejects.toThrow();
  });

  it('refresh rotates the refresh token; reusing the old one ends the grant', async () => {
    const meta = await discover(idp.issuer, fetch);
    const tok = await deviceTokens(meta);
    const t2 = await refreshGrant(meta, { clientId: 'gw-test', refreshToken: tok.refresh_token }, fetch);
    expect(t2.refresh_token).not.toBe(tok.refresh_token);
    expect(idp.valid(t2.access_token)).toBe(true);
    await expect(refreshGrant(meta, { clientId: 'gw-test', refreshToken: tok.refresh_token }, fetch)).rejects.toMatchObject({ code: 'E_AUTH_REFUSED', oauth: 'invalid_grant' });
    expect(idp.valid(t2.access_token)).toBe(false);
  }, 20000);
});

describe('TokenVault (REQ-SEC-10: memory only, refreshed)', () => {
  it('refreshes ahead of expiry, once for concurrent callers, and never serialises a token', async () => {
    const meta = await discover(idp.issuer, fetch);
    const tok = await deviceTokens(meta);
    let now = Date.now();
    let refreshes = 0;
    const f = (u, init) => {
      if (String(init?.body ?? '').includes('grant_type=refresh_token')) refreshes++;
      return fetch(u, init);
    };
    const v = new TokenVault({ fetch: f, now: () => now });
    v.set(rs.origin, { ...tok, expires_in: 100 }, { meta, clientId: 'gw-test', scope: '' });
    expect(await v.bearer(rs.origin)).toBe(tok.access_token);
    now += 80_000; // inside the last quarter of its life
    const [a, b] = await Promise.all([v.bearer(rs.origin), v.bearer(rs.origin)]);
    expect(a).toBe(b);
    expect(a).not.toBe(tok.access_token);
    expect(refreshes).toBe(1);
    expect(v.info(rs.origin).refreshed).toBe(1);
    // structuredClone (postMessage to a worker) cannot carry the vault at all; JSON and spreads show no token.
    expect(() => structuredClone(v)).toThrow();
    const dump = [JSON.stringify(v), JSON.stringify(v.info(rs.origin)), JSON.stringify({ ...v }), Object.keys(v).join(',')].join('\n');
    expect(dump).not.toContain(a);
    expect(dump).not.toContain(tok.refresh_token);
    expect(v.appearsIn(`x${a}y`)).toBe(true);
    // A refresh the server refuses ends the session (the user signs in again).
    idp.expireAccess();
    for (const r of idp.state.refresh.values()) r.used = true;
    await expect(v.refresh(rs.origin)).rejects.toThrow();
    expect(v.has(rs.origin)).toBe(false);
    expect(await v.bearer(rs.origin)).toBeNull();
  }, 20000);

  it('a refresh that cannot reach the server (offline) keeps the session for a later try', async () => {
    let now = 0;
    let online = false;
    const meta = { issuer: 'https://idp.example', token_endpoint: 'https://idp.example/token' };
    const f = async () => {
      if (!online) throw Object.assign(new Error('offline'), { code: 'E_OFFLINE' });
      return fakeRes(200, { access_token: 'at.new', refresh_token: 'rt.new', expires_in: 100 });
    };
    const v = new TokenVault({ fetch: f, now: () => now });
    v.set('https://data.example', { access_token: 'at.old', refresh_token: 'rt.old', expires_in: 100 }, { meta, clientId: 'c' });
    now = 90_000;
    expect(await v.bearer('https://data.example')).toBe('at.old'); // still valid: used while the refresh fails
    now = 101_000;
    expect(await v.bearer('https://data.example')).toBeNull(); // expired and not refreshed: nothing sent
    expect(v.has('https://data.example')).toBe(true);
    online = true;
    expect(await v.bearer('https://data.example')).toBe('at.new');
  });

  it('signOut revokes the refresh token at the server', async () => {
    const meta = await discover(idp.issuer, fetch);
    const tok = await deviceTokens(meta);
    const v = new TokenVault({ fetch });
    v.set(rs.origin, tok, { meta, clientId: 'gw-test' });
    await v.signOut(rs.origin);
    expect(v.has(rs.origin)).toBe(false);
    expect(idp.state.revoked).toContain(tok.refresh_token);
    expect(idp.valid(tok.access_token)).toBe(false);
  }, 20000);
});

describe('SignInPolicy: credentials only to marked origins (REQ-GAP-10)', () => {
  const marked = 'https://sso.example.org';
  const policyWith = (entries = [], vault = new TokenVault({ fetch })) => new SignInPolicy({ store: memStore(entries.map(checkEntry)), vault });

  it('never sends browser credentials to an unmarked origin, whatever the caller asked', async () => {
    const p = policyWith([{ origin: marked, browser: true }]);
    for (const credentials of ['include', 'same-origin', undefined, 'omit']) {
      const r = await p.prepare('https://other.example.org/x', { credentials });
      expect(r.init.credentials).toBe('omit');
      expect(r.how).toBeNull();
    }
    expect((await p.prepare(`${marked}/a/b`, { credentials: 'omit' })).init.credentials).toBe('include');
    expect((await p.prepare(`${marked}/a/b`, {}, { auth: false })).init.credentials).toBe('omit');
    // Another port or scheme is another origin.
    expect((await p.prepare('https://sso.example.org:8443/a', {})).init.credentials).toBe('omit');
    expect((await p.prepare('http://sso.example.org/a', {})).init.credentials).toBe('omit');
    expect((await p.prepare(new Request('https://other.example.org/r', { credentials: 'include' }))).init.credentials).toBe('omit');
  });

  it('refuses to mark an http origin; an http entry smuggled into the store is not used', async () => {
    const p = policyWith();
    expect(() => p.set({ origin: 'http://data.example.org', browser: true })).toThrow(/https/);
    const forged = new SignInPolicy({ store: memStore([{ origin: 'http://data.example.org', browser: true }]) });
    expect(forged.browserSignIn('http://data.example.org/x')).toBe(false);
    expect((await forged.prepare('http://data.example.org/x', {})).init.credentials).toBe('omit');
  });

  it('the hosted copy keeps its own same-origin requests as they were', async () => {
    const p = new SignInPolicy({ store: memStore(), pageOrigin: 'https://gw.example.org' });
    expect((await p.prepare('https://gw.example.org/pack.bin', { credentials: 'same-origin' })).init.credentials).toBe('same-origin');
  });

  it('WebSocket clients must ask: refused unless marked', () => {
    const p = policyWith([{ origin: 'https://data.example.org:8443', browser: true }]);
    expect(p.assertBrowserSignIn('wss://data.example.org:8443/stream')).toBe(true);
    expect(() => p.assertBrowserSignIn('wss://other.example.org:8443/')).toThrow(expect.objectContaining({ code: 'E_SIGNIN_NOT_MARKED' }));
    expect(() => p.assertBrowserSignIn('ws://data.example.org:8443/')).toThrow(expect.objectContaining({ code: 'E_SIGNIN_NOT_HTTPS' }));
  });

  it("an imported project's origins wait for confirmation; malformed or http entries are dropped", async () => {
    const store = memStore([checkEntry({ origin: 'https://mine.example.org', browser: true })]);
    const p = new SignInPolicy({ store });
    const waiting = p.offer(
      [
        { origin: 'https://mine.example.org', browser: true }, // the user's own, unchanged: nothing to confirm
        { origin: 'https://theirs.example.org', browser: true },
        { origin: 'http://plain.example.org', browser: true },
        { origin: 'javascript:alert(1)', browser: true },
        null,
      ],
      'Shared project',
    );
    expect(waiting.map((e) => e.origin)).toEqual(['https://theirs.example.org']);
    expect(p.browserSignIn('https://theirs.example.org/x')).toBe(false);
    expect((await p.prepare('https://theirs.example.org/x', {})).init.credentials).toBe('omit');
    expect(() => p.assertBrowserSignIn('https://theirs.example.org/x')).toThrow(expect.objectContaining({ code: 'E_SIGNIN_UNCONFIRMED' }));
    expect(p.summary().pending).toEqual(['https://theirs.example.org']);
    p.decline('https://theirs.example.org');
    expect(p.browserSignIn('https://theirs.example.org/x')).toBe(false);
    p.offer([{ origin: 'https://theirs.example.org', browser: true }], 'Shared project');
    p.confirm('https://theirs.example.org');
    expect(p.browserSignIn('https://theirs.example.org/x')).toBe(true);
    expect(store.raw().find((e) => e.origin === 'https://theirs.example.org').via).toBe('project');
    // A project that changes a setup the user has (adds OIDC to it) waits again.
    expect(p.offer([{ origin: 'https://mine.example.org', browser: true, oidc: { issuer: 'https://idp.example', clientId: 'x' } }], 'P2').length).toBe(1);
    expect(p.get('https://mine.example.org').oidc).toBeNull();
  });

  it('a bearer token goes only to its own origin, in the header, and never replaces a caller-set Authorization', async () => {
    const meta = await discover(idp.issuer, fetch);
    const tok = await deviceTokens(meta);
    const vault = new TokenVault({ fetch });
    const p = new SignInPolicy({ store: memStore([checkEntry({ origin: rs.origin, oidc: { issuer: idp.issuer, clientId: 'gw-test' } })]), vault });
    vault.set(rs.origin, tok, { meta, clientId: 'gw-test' });
    const own = await p.prepare(`${rs.origin}/api/info`, {});
    expect(own.how).toBe('bearer');
    expect(own.init.headers.get('Authorization')).toBe(`Bearer ${tok.access_token}`);
    expect(own.init.credentials).toBe('omit'); // a token does not imply browser credentials
    const other = await p.prepare('https://elsewhere.example.org/api', {});
    expect(other.init.headers).toBeUndefined();
    const signed = await p.prepare(`${rs.origin}/api/info`, { headers: { Authorization: 'AWS4-HMAC-SHA256 Credential=x' } });
    expect(signed.how).toBeNull();
    expect(new Headers(signed.init.headers).get('Authorization')).toBe('AWS4-HMAC-SHA256 Credential=x');
    expect((await p.prepare(`${rs.origin}/api/info`, {}, { auth: false })).how).toBeNull();
    // Removing the origin ends its session.
    p.remove(rs.origin);
    expect(vault.has(rs.origin)).toBe(false);
  }, 20000);
});

describe('NetLog applies the policy to every request', () => {
  const realDoc = globalThis.document;
  afterAll(() => {
    globalThis.document = realDoc;
  });

  it('adds the token, refreshes after a 401 and repeats once; logs and URLs never hold a token', async () => {
    globalThis.document = { getElementById: () => ({ getAttribute: () => `default-src 'none'; connect-src blob: ${rs.origin} ${idp.origin}` }) };
    const events = [];
    const app = { emit: (e, d) => events.push([e, d]), network: { isOnline: () => true } };
    const log = new NetLog(app);
    const meta = await discover(idp.issuer, log.fetchFor('Sign-in', { auth: false }));
    const tok = await deviceTokens(meta);
    const vault = new TokenVault({ fetch: log.fetchFor('Sign-in', { auth: false }) });
    const policy = new SignInPolicy({ store: memStore([checkEntry({ origin: rs.origin, oidc: { issuer: idp.issuer, clientId: 'gw-test' } })]), vault });
    app.auth = { policy, vault };
    vault.set(rs.origin, tok, { meta, clientId: 'gw-test' });
    const f = log.fetchFor('Data');
    const r1 = await f(`${rs.origin}/api/info`, { credentials: 'include' });
    expect(r1.status).toBe(200);
    expect(rs.log.at(-1).auth).toBe(`Bearer ${tok.access_token}`);
    expect(log.entries[0].auth).toBe('bearer');
    // The server stops taking the token: one refresh, one repeat.
    idp.expireAccess();
    vault.set(rs.origin, { ...tok, expires_in: 3600 }, { meta, clientId: 'gw-test' }); // the client still thinks it is fresh
    const r2 = await f(`${rs.origin}/data/file.bin`, { headers: { Range: 'bytes=0-15' } });
    expect(r2.status).toBe(206);
    expect(log.entries[0]).toMatchObject({ status: 206, retried: true, auth: 'bearer' });
    expect(log.entries[1]).toMatchObject({ status: 401 });
    expect(rs.log.at(-1).auth).not.toBe(`Bearer ${tok.access_token}`);
    expect(events.some(([e]) => e === 'signin-used')).toBe(true);
    // The probes: nothing the IdP issued is in a URL any server saw, in the log, or in the vault's JSON.
    const urls = [...rs.log.map((x) => x.url), ...idp.state.log.map((x) => `${x.path}${x.query}`)].join('\n');
    const logged = JSON.stringify(log.entries);
    for (const t of idp.tokens()) {
      expect(urls).not.toContain(t);
      expect(logged).not.toContain(t);
      expect(JSON.stringify(vault)).not.toContain(t);
      expect(JSON.stringify(policy.store.get())).not.toContain(t);
    }
    // Requests to the IdP never carry the token (auth:false) and never browser credentials.
    expect(idp.state.log.every((x) => !x.cookie)).toBe(true);
  }, 30000);
});
