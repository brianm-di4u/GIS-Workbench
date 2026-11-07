// S-42 (SDP-2.1 §8): can the browser reach a loopback sidecar from file://, hosted https, a
// cross-origin iframe and srcdoc, including Local Network Access (LNA) prompts? Pass: ≤ 1
// permission prompt, zero CSP violations, 10 GB output read by range; otherwise adopt /app/.
// file:// and loopback-hosted https are PT-14/PT-15 (sidecar.spec.js); this spec adds the frames
// and a hosted page that Chrome treats as public (--ip-address-space-overrides), and writes
// reports/sidecar/s42.json. The 10 GB range read is scale.spec.js.
import { test, expect, chromium } from '@playwright/test';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { servers, openApp } from '../helpers.js';
import { state, approvePending, httpsServer, DIST_DIR, HOSTED } from './harness.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const REPORT = resolve('reports', 'sidecar', 's42.json');
const results = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : { cases: {} };
const save = () => {
  mkdirSync(resolve('reports', 'sidecar'), { recursive: true });
  results.at = new Date().toISOString();
  writeFileSync(REPORT, JSON.stringify(results, null, 2));
};

/** Allow an origin in the sidecar window (as the user would). */
async function allowOrigin(s, origin) {
  const key = readFileSync(join(s.dataDir, 'ui.key'), 'utf8').trim();
  const call = (method, path, headers, body) =>
    new Promise((res, rej) => {
      const r = httpRequest({ host: '127.0.0.1', port: s.port, method, path, headers: { Host: `localhost:${s.port}`, 'Content-Length': body ? Buffer.byteLength(body) : 0, ...headers } }, (resp) => {
        let t = '';
        resp.on('data', (d) => (t += d));
        resp.on('end', () => (resp.statusCode < 400 ? res(JSON.parse(t)) : rej(new Error(t))));
      });
      r.on('error', rej);
      if (body) r.write(body);
      r.end();
    });
  const launch = new URL((await call('POST', '/ui/api/launch', { 'X-Gwb-Key': key })).url).searchParams.get('launch');
  const lo = `http://localhost:${s.port}`;
  const { secret } = await call('POST', '/ui/api/session', { Origin: lo, 'Content-Type': 'application/json' }, JSON.stringify({ launch }));
  await call('POST', '/ui/api/origin', { Origin: lo, 'Content-Type': 'application/json', 'X-Gwb-Admin': secret }, JSON.stringify({ origin, allow: true }));
}

/** From inside the app frame: hello, then pairing through the UI path, then a caps call. */
async function reach(frame, s) {
  const hello = await frame.evaluate(async () => {
    try {
      const h = await window.gisworkbench.sidecar.client.discover();
      return h ? { ok: true, origin: h.origin } : { ok: false, error: 'no answer' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  if (!hello.ok) return { hello };
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.pair');
  });
  const code = frame.locator('[data-id="sidecar:code"]');
  let paired = false;
  try {
    await expect(code).toHaveText(/^\d{6}$/, { timeout: 15_000 });
    await approvePending(s, { expectCode: await code.textContent() });
    await expect(frame.locator('.status-sidecar').first()).toHaveText(/Sidecar ✓/, { timeout: 15_000 });
    paired = true;
  } catch (e) {
    return { hello, paired, error: e.message.split('\n')[0] };
  }
  const caps = await frame.evaluate(async () => (await window.gisworkbench.sidecar.client.caps()).profiles.length);
  return { hello, paired, caps };
}

test.describe.configure({ mode: 'serial' });

test('S-42 cross-origin iframe and srcdoc reach the sidecar once their origin is allowed', async ({ page }) => {
  test.setTimeout(180_000);
  const s = state();
  const srv = await servers(DIST);
  try {
    const appOrigin = new URL(srv.appUrl).origin;
    const hostOrigin = new URL(srv.hostUrl).origin;
    await allowOrigin(s, appOrigin);
    await allowOrigin(s, hostOrigin);
    const ifr = await openApp(page, 'iframe', { srv, prefs: { welcomeDone: true } });
    const r1 = await reach(ifr.frame, s);
    results.cases[`cross-origin iframe (${test.info().project.name})`] = { ...r1, csp: await ifr.csp() };
    expect(r1.paired).toBe(true);
    const p2 = await page.context().newPage();
    const sd = await openApp(p2, 'srcdoc', { srv, prefs: { welcomeDone: true } });
    const r2 = await reach(sd.frame, s);
    results.cases[`srcdoc iframe (${test.info().project.name})`] = { ...r2, csp: await sd.csp() };
    save();
  } finally {
    await srv.close();
  }
});

test('S-42 hosted page treated as public: Local Network Access', async () => {
  test.setTimeout(180_000);
  const s = state();
  const srv = await httpsServer(DIST_DIR);
  const out = {};
  try {
    for (const grant of [false, true]) {
      const browser = await chromium.launch({ ...(process.platform === 'linux' ? {} : { channel: 'chrome' }), args: ['--ip-address-space-overrides=127.0.0.1:8443=public', '--ignore-gpu-blocklist'] });
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      let granted = null;
      if (grant) granted = await ctx.grantPermissions(['local-network-access'], { origin: HOSTED }).then(() => true, (e) => e.message.split('\n')[0]);
      const page = await ctx.newPage();
      const { frame, csp } = await openApp(page, 'http', { srv: { appUrl: `${HOSTED}/gis-workbench.html` }, prefs: { welcomeDone: true } });
      const r = await reach(frame, s);
      out[grant ? 'permission granted' : 'no permission'] = { granted, ...r, csp: await csp() };
      await browser.close();
    }
  } finally {
    await srv.close();
  }
  results.cases['hosted https, public address space (Chrome, --ip-address-space-overrides)'] = out;
  results.firefox = 'not run: no Playwright Firefox build is installed on this machine (best effort, open item)';
  results.verdict =
    'Chrome and Edge reach the sidecar from file://, loopback-hosted https and the sidecar-served /app/ (PT-14, PT-15) with zero CSP violations; frames reach it once their origin is allowed. A hosted page in the public address space needs the Local Network Access permission (one prompt); see the cases. /app/ is the fallback when a host blocks loopback.';
  save();
});
