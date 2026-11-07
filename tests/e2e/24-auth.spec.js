// 2.4 auth (GR-03): REQ-GAP-09 OIDC sign-in for allow-listed data origins (device grant from
// file://, PKCE with a redirect from the hosted copy, memory-only tokens that are refreshed) and
// REQ-GAP-10 per-origin "use my sign-in" (OD-2.19), against the mock IdP of S-61
// (tests/tools/mock-idp.mjs). Security probes: a token never appears in an exported project, a
// self-saved file, storage, the DOM, logs or any URL; browser credentials never reach an unmarked
// origin; an origin an imported project introduces waits for confirmation.
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { openApp, sample } from './helpers.js';
import { startMockIdp, startResource, startCookieServer, selfSignedCert } from '../tools/mock-idp.mjs';

test.describe.configure({ timeout: 180_000 });

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const TIF = sample('geotiff-gdal-small', 'utm.tif');

const made = [];
test.afterAll(() => made.forEach((p) => rmSync(p, { force: true })));

/** A copy of the built file whose CSP allows `origins` (add → save → reload, REQ-ARC-16). */
async function copyWithOrigins(page, origins, name) {
  const { frame } = await openApp(page, 'file');
  const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins(o), origins);
  const dir = join(tmpdir(), 'gw-24-auth');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${process.pid}-${Date.now()}-${name}`); // Chrome and Edge workers run at once: one file each
  writeFileSync(p, html);
  made.push(p);
  return p;
}

async function axe(frame, sel) {
  if (!(await frame.evaluate(() => !!window.axe))) await frame.evaluate(AXE);
  return frame.evaluate(async (s) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), sel);
}

/** Set up an origin in the Sign-In for Data Origins dialog (left open). */
async function setUp(frame, { origin, browser = false, issuer = '', client = '', grant = 'auto', scope = 'openid offline_access' }) {
  if (!(await frame.locator('[data-id="dialog:signin"]').count())) {
    await frame.evaluate(() => {
      window.gisworkbench.commands.run('net.signin');
    });
    await frame.waitForSelector('[data-id="dialog:signin"]');
  }
  await frame.fill('[data-id="signin:origin"]', origin);
  await frame.setChecked('[data-id="signin:browser"]', browser);
  await frame.fill('[data-id="signin:issuer"]', issuer);
  await frame.fill('[data-id="signin:client"]', client);
  await frame.fill('[data-id="signin:scope"]', scope);
  await frame.selectOption('[data-id="signin:grant"]', grant);
  await frame.click('[data-id="signin:add"]');
}

/** Everything a token could leak into, as one string per place (checked in Node). */
async function leakProbe(frame) {
  return frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ls = Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n');
    const ss = Object.keys(sessionStorage).map((k) => `${k}=${sessionStorage.getItem(k)}`).join('\n');
    const bytes = app.__test.serialiseProject(app);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    const snap = await app.snapshotHtml();
    return {
      localStorage: ls,
      sessionStorage: ss,
      dom: document.documentElement.outerHTML,
      netlog: JSON.stringify(app.netlog.entries),
      store: JSON.stringify(app.store.snapshot()),
      auth: JSON.stringify(app.auth),
      selfSaved: app.__test.htmlWithOrigins(['https://example.org']),
      snapshot: snap.html,
      projectB64: btoa(bin),
      importLog: JSON.stringify(app.importLog),
    };
  });
}

function expectNoTokens(where, tokens) {
  const project = unzipSync(Buffer.from(where.projectB64, 'base64'));
  const places = { ...where, project: Object.values(project).map((u) => strFromU8(u)).join('\n') };
  delete places.projectB64;
  for (const [place, text] of Object.entries(places)) for (const tk of tokens) expect(text.includes(tk), `token in ${place}`).toBe(false);
  return places;
}

test('REQ-GAP-09 device grant from file://: sign in, open a protected COG by range with a bearer token, refresh after expiry, no token anywhere', async ({ page }) => {
  test.skip(!existsSync(TIF), 'sample utm.tif missing');
  const idp = await startMockIdp({ interval: 1, accessTtl: 3600 });
  const rs = await startResource(idp, { files: { '/data/utm.tif': readFileSync(TIF) } });
  const urls = [];
  try {
    const copy = await copyWithOrigins(page, [idp.origin, rs.origin], 'gw-auth-device.html');
    const page2 = await page.context().newPage();
    page2.on('request', (r) => urls.push(r.url()));
    const { frame, logs } = await openApp(page2, 'file', { htmlPath: copy });
    // Before sign-in the protected service says where to set it up.
    const before = await frame.evaluate((u) => window.gisworkbench.openUrl(u).then(() => 'opened', (e) => e.code), `${rs.origin}/data/utm.tif`);
    expect(before).toBe('E_REMOTE_SIGNIN');

    await setUp(frame, { origin: rs.origin, issuer: idp.issuer, client: 'gw-test', scope: 'openid offline_access data.read' });
    await frame.waitForSelector(`[data-id="signin:row:${rs.origin}"]`);
    expect(await axe(frame, '[data-id="dialog:signin"]')).toEqual([]);
    await frame.click(`[data-id="signin:in:${rs.origin}"]`);
    const codeEl = await frame.waitForSelector('[data-id="signin:user-code"]');
    const userCode = (await codeEl.textContent()).trim();
    expect(userCode).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(await frame.textContent('[data-id="signin:verify-uri"]')).toBe(`${idp.issuer}/activate`);
    expect(await axe(frame, '[data-id="dialog:signin-device"]')).toEqual([]);
    // The user signs in on "another device", which takes longer than one poll: RFC 8628 §3.5 answers
    // that poll 400 authorization_pending and the browser logs it. Approving straight away raced
    // the poll at +1 s, so the console check below failed whenever the steps above took too long.
    await expect.poll(() => idp.state.pendings, { timeout: 10_000 }).toBeGreaterThan(0);
    await fetch(`${idp.issuer}/activate?user_code=${encodeURIComponent(userCode)}&decision=approve`);
    await frame.waitForSelector('[data-id="dialog:signin-device"]', { state: 'detached', timeout: 20_000 });
    await frame.waitForSelector(`[data-id="signin:out:${rs.origin}"]`);
    await frame.click('[data-id="dialog:signin"] .dlg-buttons .btn-primary');
    expect(idp.state.slowDowns).toBe(0);

    // The protected COG opens by range; every request carries the bearer token in its header.
    const opened = await frame.evaluate(async (u) => {
      const app = window.gisworkbench;
      const n = app.netlog.entries.length;
      const r = await app.openUrl(u);
      const fresh = app.netlog.entries.slice(0, app.netlog.entries.length - n);
      return { layers: r.layers?.length ?? 0, auth: fresh.filter((e) => e.path === '/data/utm.tif').map((e) => e.auth) };
    }, `${rs.origin}/data/utm.tif`);
    expect(opened.layers).toBe(1);
    expect(opened.auth.length).toBeGreaterThan(1);
    expect(opened.auth.every((a) => a === 'bearer')).toBe(true);
    const tifReqs = rs.log.filter((x) => x.path === '/data/utm.tif' && !x.preflight).slice(1); // the first is the refused one before sign-in
    expect(tifReqs.every((x) => /^Bearer at\./.test(x.auth ?? ''))).toBe(true);
    // The indicator.
    const pill = frame.locator('[data-id^="status:signin:"]').first();
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText(/Sign-in: 1 origin/);

    // The server ends the access token: the next request is refused once, refreshed and repeated.
    idp.expireAccess();
    const after = await frame.evaluate(async (u) => {
      const app = window.gisworkbench;
      const r = await app.netlog.fetchFor('test')(u);
      return { status: r.status, refreshed: app.auth.vault.info(new URL(u).origin).refreshed, entries: app.netlog.entries.slice(0, 2).map((e) => [e.status, e.retried ?? false]) };
    }, `${rs.origin}/api/info`);
    expect(after).toEqual({ status: 200, refreshed: 1, entries: [[200, true], [401, false]] });

    // Probes: nothing the IdP issued is in the project, a snapshot, a self-saved copy, storage, DOM, logs or URLs.
    const tokens = idp.tokens();
    expect(tokens.length).toBeGreaterThanOrEqual(4);
    expectNoTokens(await leakProbe(frame), tokens);
    const seen = [...urls, ...rs.log.map((x) => x.url), ...idp.state.log.map((x) => x.path + x.query)].join('\n');
    for (const tk of tokens) expect(seen.includes(tk)).toBe(false);
    for (const tk of tokens) expect(logs.join('\n').includes(tk)).toBe(false);
    // CORS as measured (S-61 note): file:// sends Origin: null; the IdP calls are simple requests (no preflight).
    const idpCalls = idp.state.log.filter((x) => ['/device', '/token', '/.well-known/openid-configuration'].includes(x.path));
    expect(idpCalls.every((x) => x.origin === 'null' && !x.preflight)).toBe(true);
    expect(rs.log.some((x) => x.preflight && x.origin === 'null')).toBe(true); // Authorization needs a preflight
    console.log(`S-61 file:// device: IdP calls ${idpCalls.length} (preflights 0, Origin null); data preflights ${rs.log.filter((x) => x.preflight).length} of ${rs.log.length}`);
    // The 401s are the protected service asking for the token; each 400 must be a pending poll the IdP answered.
    expect(logs.filter((l) => /status of 400/.test(l)).length).toBe(idp.state.pendings);
    expect(logs.filter((l) => !/status of 40[01]/.test(l))).toEqual([]);
    await page2.close();
  } finally {
    await idp.close();
    await rs.close();
  }
});

test('REQ-GAP-09 file:// against an IdP without CORS: the failure names the cross-origin cause', async ({ page }) => {
  const idp = await startMockIdp({ cors: 'none' });
  const rs = await startResource(idp);
  try {
    const copy = await copyWithOrigins(page, [idp.origin, rs.origin], 'gw-auth-nocors.html');
    const page2 = await page.context().newPage();
    const { frame } = await openApp(page2, 'file', { htmlPath: copy });
    const r = await frame.evaluate(async ({ o, iss }) => {
      const app = window.gisworkbench;
      app.auth.policy.set({ origin: o, oidc: { issuer: iss, clientId: 'gw-test' } });
      try {
        await app.auth.signIn(o);
        return 'signed in';
      } catch (e) {
        return e.code;
      }
    }, { o: rs.origin, iss: idp.issuer });
    expect(r).toBe('E_FETCH_FAILED');
    expect(idp.state.log.some((x) => x.path === '/.well-known/openid-configuration' && x.origin === 'null')).toBe(true);
    await page2.close();
  } finally {
    await idp.close();
    await rs.close();
  }
});

test('REQ-GAP-09 PKCE with a redirect from the hosted copy: the sign-in window hands the code back and closes', async ({ page }) => {
  const idp = await startMockIdp({ cors: 'star' });
  const rs = await startResource(idp);
  const copy = await copyWithOrigins(page, [idp.origin, rs.origin], 'gw-auth-hosted.html');
  const html = readFileSync(copy);
  const host = createServer((req, res) => {
    if (req.url.startsWith('/gis-workbench.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${host.address().port}/gis-workbench.html`;
  try {
    const page2 = await page.context().newPage();
    const { frame, logs } = await openApp(page2, 'http', { srv: { appUrl } });
    await setUp(frame, { origin: rs.origin, issuer: idp.issuer, client: 'gw-test', grant: 'auto' });
    await frame.waitForSelector(`[data-id="signin:row:${rs.origin}"]`);
    await frame.evaluate(AXE);
    // The mock IdP answers at once, so hold the sign-in window's /authorize request until the PKCE
    // dialog has been checked: otherwise the flow can finish (and the dialog close) before axe runs.
    let release;
    const held = new Promise((r) => (release = r));
    await page.context().route((u) => u.href.startsWith(`${idp.issuer}/authorize`), async (route) => {
      await held;
      await route.continue();
    });
    // Playwright reports the popup only once its first navigation (the held request) commits.
    const popupP = page2.waitForEvent('popup');
    await frame.click(`[data-id="signin:in:${rs.origin}"]`);
    await frame.waitForSelector('[data-id="dialog:signin-pkce"]');
    const pkce = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[data-id="dialog:signin-pkce"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => x.id));
    release();
    const popup = await popupP;
    expect(pkce).toEqual([]);
    await popup.waitForEvent('close', { timeout: 90_000 });
    await frame.waitForSelector('[data-id="dialog:signin-pkce"]', { state: 'detached', timeout: 20_000 });
    await frame.waitForSelector(`[data-id="signin:out:${rs.origin}"]`, { timeout: 20_000 });
    const auth = idp.state.log.find((x) => x.path === '/authorize');
    const q = new URLSearchParams(auth.query);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe(appUrl);
    expect(q.has('code_verifier')).toBe(false);
    const tokenCall = idp.state.log.find((x) => x.path === '/token');
    expect(tokenCall.origin).toBe(new URL(appUrl).origin);
    const r = await frame.evaluate((u) => window.gisworkbench.netlog.fetchFor('test')(u).then((x) => x.status), `${rs.origin}/api/info`);
    expect(r).toBe(200);
    expect(rs.log.at(-1).auth).toMatch(/^Bearer at\./);
    expectNoTokens(await leakProbe(frame), idp.tokens());
    expect(logs.filter((l) => !/status of 401/.test(l))).toEqual([]); // the 401s are the protected service asking for the token
    console.log(`S-61 hosted PKCE: /authorize then /token from Origin ${tokenCall.origin}, preflight ${idp.state.log.some((x) => x.preflight)}`);
    await page2.close();
  } finally {
    host.close();
    await idp.close();
    await rs.close();
  }
});

test.describe('REQ-GAP-10 use my sign-in (https origin with a cookie)', () => {
  test.use({ ignoreHTTPSErrors: true });

  test('credentials go only to a marked https origin; http is refused; an imported project needs confirmation; indicator shown', async ({ page }) => {
    const cert = selfSignedCert();
    test.skip(!cert, 'openssl is not available to make a test certificate');
    const cs = await startCookieServer(cert);
    try {
      const copy = await copyWithOrigins(page, [cs.origin], 'gw-auth-cookie.html');
      await page.context().addCookies([{ name: 'sso', value: 'cookie-123', url: `${cs.origin}/`, secure: true, sameSite: 'None' }]);
      const page2 = await page.context().newPage();
      const { frame, logs } = await openApp(page2, 'file', { htmlPath: copy });
      const call = (path, credentials = 'include') =>
        frame.evaluate(
          async ({ u, credentials }) => {
            try {
              const r = await window.gisworkbench.netlog.fetchFor('test')(u, { credentials });
              return { status: r.status, body: await r.json(), auth: window.gisworkbench.netlog.entries[0].auth ?? null };
            } catch (e) {
              return { error: e.code };
            }
          },
          { u: `${cs.origin}${path}`, credentials },
        );
      // Unmarked: even a caller asking for 'include' sends nothing (and may read an ACAO:* reply).
      const n0 = cs.log.length;
      expect(await call('/whoami')).toMatchObject({ status: 200, body: { cookie: null }, auth: null });
      expect(await call('/star')).toMatchObject({ status: 200 });
      expect(cs.log.slice(n0).every((x) => x.cookie === null)).toBe(true);
      await expect(frame.locator('[data-id^="status:signin:"]').first()).toBeHidden();

      // http is refused for marking.
      await setUp(frame, { origin: 'http://127.0.0.1:9', browser: true });
      expect(await frame.evaluate(() => window.gisworkbench.auth.policy.list().length)).toBe(0);
      // Mark the https origin.
      await setUp(frame, { origin: cs.origin, browser: true });
      await frame.waitForSelector(`[data-id="signin:row:${cs.origin}"]`);
      expect(await axe(frame, '[data-id="dialog:signin"]')).toEqual([]);
      await frame.click('[data-id="dialog:signin"] .dlg-buttons .btn-primary');
      const n1 = cs.log.length;
      const marked = await call('/whoami');
      expect(marked).toMatchObject({ status: 200, auth: 'browser' });
      // A credentialed request cannot read an ACAO:* reply: proof the mode changed to 'include'.
      expect(await call('/star')).toEqual({ error: 'E_FETCH_FAILED' });
      const cookieReached = cs.log.slice(n1).some((x) => x.cookie?.includes('sso=cookie-123'));
      console.log(`S-61 use-my-sign-in from file://: cookie reached the marked origin: ${cookieReached}; whoami saw ${JSON.stringify(marked.body)}`);
      const pill = frame.locator('[data-id^="status:signin:"]').first();
      await expect(pill).toBeVisible();
      await expect(pill).toHaveText(/Sign-in: 1 origin/);
      await expect(pill).toHaveAttribute('title', new RegExp(cs.origin.replace(/[.:/]/g, '\\$&')));
      // An imported project that introduces the origin: nothing is sent until the user confirms.
      const bytesB64 = await frame.evaluate((o) => {
        const app = window.gisworkbench;
        app.store.transact('share', (tx) => tx.set('project', 'signIn', [{ origin: o, browser: true, oidc: null }]));
        const b = app.__test.serialiseProject(app);
        app.auth.policy.remove(o); // this browser has not marked it
        let s = '';
        for (const x of b) s += String.fromCharCode(x);
        return btoa(s);
      }, cs.origin);
      const manifest = JSON.parse(strFromU8(unzipSync(Buffer.from(bytesB64, 'base64'))['records.json']));
      expect(JSON.stringify(manifest)).toContain(cs.origin); // the setup is shared (settings only)
      await frame.evaluate(async (b64) => {
        const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        await window.gisworkbench.openProjectFile(new File([u8], 'shared.gwb'));
      }, bytesB64);
      await expect(frame.locator('.toast', { hasText: 'This project asks to use sign-in for 1 origin' })).toBeVisible();
      await expect(pill).toHaveText(/1 origin to confirm/);
      const n2 = cs.log.length;
      expect(await call('/whoami')).toMatchObject({ status: 200, body: { cookie: null }, auth: null });
      expect(await call('/star')).toMatchObject({ status: 200 });
      expect(cs.log.slice(n2).every((x) => x.cookie === null)).toBe(true);
      // Confirm it in the dialog.
      await frame.evaluate(() => {
        window.gisworkbench.commands.run('net.signin');
      });
      await frame.waitForSelector(`[data-id="signin:confirm:${cs.origin}"]`);
      expect(await axe(frame, '[data-id="dialog:signin"]')).toEqual([]);
      await frame.click(`[data-id="signin:confirm:${cs.origin}"]`);
      await frame.waitForSelector(`[data-id="signin:row:${cs.origin}"]`);
      await frame.click('[data-id="dialog:signin"] .dlg-buttons .btn-primary');
      expect(await call('/whoami')).toMatchObject({ status: 200, auth: 'browser' });
      expect(await frame.evaluate((o) => window.gisworkbench.auth.policy.get(o).via, cs.origin)).toBe('project');
      expect(logs.filter((l) => !/ERR_FAILED|CORS policy|Failed to fetch/.test(l))).toEqual([]);
      await page2.close();
    } finally {
      await cs.close();
    }
  });
});
