// SCN-61 (REQ-GAP-02): a user pairs a Python script with the sidecar, drives the app through the
// loopback relay, and has a write held as a proposal. The real client package in a real Python
// process, the real sidecar, the real app in a browser. Runs in the `sidecar` projects; skips
// cleanly when no Python is found (GWB_PYTHON names one).

import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { openApp, openFiles } from '../helpers.js';
import { stopActivity, watchActivity } from '../activity-lib.js';
import { state, approvePending, windowUrl, DIST_DIR, LINUX } from './harness.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const PREFS = { welcomeDone: true };
const SRC = resolve('sidecar/python/src');
const PY = [process.env.GWB_PYTHON, 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe', LINUX ? 'python3' : 'python'].filter(Boolean).find((p) => {
  try {
    return /Python 3\.(9|\d\d)/.test(execFileSync(p, ['--version'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
});

const WORK = mkdtempSync(join(tmpdir(), 'gwb-py-'));
const TOKEN_FILE = join(WORK, 'token.json');

/** Run a Python snippet with the client on its path; the last line of stdout is its JSON result. */
function python(code, { args = [], wait = true } = {}) {
  const file = join(WORK, `s${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(file, `import json, sys\nsys.path.insert(0, ${JSON.stringify(SRC)})\nfrom gis_workbench_client import *\nTOKEN_FILE = ${JSON.stringify(TOKEN_FILE)}\n${code}\n`);
  const child = spawn(PY, ['-I', '-B', file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const done = new Promise((res, rej) =>
    child.on('close', (c) => {
      if (c) return rej(new Error(`python exited ${c}: ${err}`));
      try {
        res(JSON.parse(out.trim().split('\n').at(-1)));
      } catch {
        rej(new Error(`no JSON from python: ${out} ${err}`));
      }
    }),
  );
  return wait ? done : { done, child, out: () => out };
}

async function pairPage(frame, s) {
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.pair');
  });
  await expect(frame.locator('[data-id="sidecar:code"]')).toHaveText(/^\d{6}$/, { timeout: 60_000 }); // a busy disk can hold the sidecar's log for seconds
  await approvePending(s);
  await expect(frame.locator('.status-sidecar').first()).toHaveText(/Sidecar ✓|Sidecar · /, { timeout: 20_000 });
}

/** Turn the relay on through the dialog, as the analyst does. */
async function relayOn(frame) {
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.relay');
  });
  const box = frame.locator('[data-id="relay:on"]');
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.check();
  await expect(frame.locator('[data-id="relay:status"]'))
    .toHaveText(/^On\./, { timeout: 30_000 })
    .catch(async (e) => {
      const why = await frame.evaluate(() => {
        const r = window.gisworkbench.sidecar.relay;
        return { on: r?.on, session: r?.session, error: String(r?.error?.stack ?? r?.error), disabled: document.querySelector('[data-id="relay:on"]')?.disabled, log: window.gisworkbench.netlog.entries.slice(0, 6).map((x) => `${x.method} ${x.path} ${x.status}`) };
      });
      throw new Error(`${e.message}
${JSON.stringify(why, null, 1)}`);
    });
  await frame.locator('[data-id="dialog:python-relay"] button', { hasText: 'Close' }).click();
}

test.describe.configure({ mode: 'serial' });
test.skip(!PY, 'no Python 3.9+ here: set GWB_PYTHON');

let frame;
let shared;

test.afterAll(() => shared?.close());

test('REQ-GAP-02 SCN-61 pair a script, relay off by default, a read through the relay', async ({ browser }) => {
  test.setTimeout(180_000);
  const s = state();
  const page = await browser.newPage(); // one analyst session across these tests
  const { frame: f } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
  frame = f;
  shared = page;
  await pairPage(frame, s);

  // The script pairs: the code it prints is the code the sidecar window shows.
  const run = python(`Client.pair('scn61 script', token_file=TOKEN_FILE, on_code=lambda c: print(c, flush=True))\nprint(json.dumps({'paired': True}))`, { wait: false });
  await expect.poll(() => /\d{6}/.exec(run.out())?.[0] ?? null, { timeout: 20_000 }).not.toBeNull();
  const code = /\d{6}/.exec(run.out())[0];
  const seen = await approvePending(s, { expectCode: code });
  expect(seen.map((p) => [p.origin, p.client])).toEqual([['python-relay', 'scn61 script']]);
  expect(await run.done).toEqual({ paired: true });

  // Paired, but no page has the relay on: the script is told, and nothing reached the page.
  const off = await python(`
c = Client(find_port(), load_token(TOKEN_FILE))
try:
    c.initialize()
    print(json.dumps({'error': None}))
except NoApp as e:
    print(json.dumps({'error': e.code, 'hello': c.hello()}))`);
  expect(off.error).toBe('no_app');
  expect(off.hello).toMatchObject({ paired: true, app: false });

  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const toast = app.toast;
    window.__toasts = [];
    app.toast = (m, ...a) => (window.__toasts.push(m), toast.call(app, m, ...a));
  });
  await relayOn(frame);
  await expect(frame.locator('.status-sidecar').first()).toHaveText('Sidecar · Python relay');
  const r = await python(`
c = Client.connect(token_file=TOKEN_FILE)
tools = c.tools()
print(json.dumps({'server': c.server['serverInfo'], 'names': [t['name'] for t in tools], 'reads': [t['name'] for t in tools if t['annotations']['readOnlyHint']], 'version': c.v2.api.version(), 'layers': c.v2.layers.list(), 'parsed': c.v2.geo.parse(text='38SMB4488'), 'resource': c.read_resource('gw://project/summary'), 'cmds': len(c.call('gw_list_commands', filter='sidecar'))}))`);
  expect(r.server.name).toBe('gis-workbench');
  expect(r.names.length).toBeGreaterThan(60);
  expect(r.names.every((n) => /^gw2?_/.test(n))).toBe(true);
  expect(r.names).toContain('gw_proposal_status');
  expect(r.version.api ?? r.version.version).toBeTruthy();
  expect(r.layers).toEqual([]);
  expect(r.parsed.lat).toBeCloseTo(33.33, 1); // Baghdad: the value comes from the app's parser, through the relay
  expect(r.parsed.lon).toBeCloseTo(44.4, 0);
  expect(r.cmds).toBeGreaterThan(5);
  // The analyst is told a script is here (a toast fades, so its text is read as it is raised).
  expect(await frame.evaluate(() => window.__toasts)).toContainEqual(expect.stringContaining('scn61 script'));
});

test('REQ-GAP-02 SCN-61 a write is held as a proposal until the analyst decides', async () => {
  test.setTimeout(120_000);
  const before = await frame.evaluate(() => window.gisworkbench.store.all('graphic').length);
  const run = python(`
c = Client.connect(token_file=TOKEN_FILE)
p = c.call('gw_run_command', command='sidecar.jobs', reason='scn61')
print(json.dumps({'id': p.id, 'status': p.status}), flush=True)
final = p.wait(timeout=60, interval=0.2)
print(json.dumps({'id': p.id, 'status': p.status, 'final': final, 'outcome': p.outcome}))`, { wait: false });
  await expect.poll(() => run.out().includes('pending'), { timeout: 20_000 }).toBe(true);
  // Held: pending in the app, nothing run, with the script as its provenance.
  const held = await frame.evaluate(() => window.gisworkbench.proposals.pending().map((p) => ({ id: p.id, tool: p.tool, provenance: p.provenance })));
  expect(held).toHaveLength(1);
  expect(held[0].tool).toBe('gw_run_command');
  expect(held[0].provenance).toMatchObject({ source: 'mcp:python-relay', connection: 'python-relay', model: 'scn61 script' });
  expect(await frame.evaluate(() => window.gisworkbench.store.all('graphic').length)).toBe(before);
  // The analyst rejects: the script hears it and nothing ran.
  await frame.evaluate((id) => window.gisworkbench.proposals.reject(id), held[0].id);
  const out = await run.done;
  expect(out).toMatchObject({ id: held[0].id, status: 'rejected', final: 'rejected' });
});

test('REQ-GAP-02 SCN-61 an accepted write runs, an API v2 write and a save are proposals too', async () => {
  test.setTimeout(120_000);
  const run = python(`
c = Client.connect(token_file=TOKEN_FILE)
p = c.v2.observations.add(text='from python', lat=32.0, lon=-110.0)
print(json.dumps({'id': p.id}), flush=True)
s = c.v2.products.report(format='html', save=True)
print(json.dumps({'save': s.status}), flush=True)
print(json.dumps({'final': p.wait(timeout=60, interval=0.2), 'save': s.status}))`, { wait: false });
  await expect.poll(() => run.out().includes('"save"'), { timeout: 20_000 }).toBe(true);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const before = app.store.all('observation').length;
    const list = app.proposals.pending().map((p) => ({ id: p.id, tool: p.tool }));
    const obs = list.find((p) => p.tool === 'gw2_observations_add');
    const held = app.store.all('observation').length === before;
    app.proposals.accept(obs.id);
    await app.proposals.items.find((p) => p.id === obs.id).result;
    app.proposals.reject(list.find((p) => p.tool === 'gw2_products_report').id);
    return { tools: list.map((p) => p.tool).sort(), held, after: app.store.all('observation').length - before };
  });
  expect(r.tools).toEqual(['gw2_observations_add', 'gw2_products_report']);
  expect(r.held).toBe(true);
  expect(r.after).toBe(1);
  expect((await run.done).final).toBe('accepted');
});

test('REQ-GAP-02 SCN-61 no read-only tool changes the project', async () => {
  test.setTimeout(240_000);
  await openFiles(frame, [resolve('fixtures/fx06/fx06_date1.tif')]);
  // The fingerprint of the opened file commits a moment later: wait for it, or it counts below.
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.layers.size === 1 && window.gisworkbench.store.all('fileref').every((r) => r.fingerprint)), { timeout: 30_000 }).toBe(true);
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.__commits = [];
    app.store.on('commit', (cs) => app.__commits.push(cs?.label ?? cs?.changeSet?.label ?? JSON.stringify(cs)?.slice(0, 200)));
  });
  const r = await python(`
c = Client.connect(token_file=TOKEN_FILE)
done, failed = [], {}
for t in c.tools():
    if not t['annotations']['readOnlyHint'] or t['name'] == 'gw_proposal_status' or t['inputSchema'].get('required'):
        continue
    if t['name'] in ('gw_find_objects', 'gw_search_imagery'):
        continue
    try:
        c.call(t['name'], timeout=60)
    except (ToolError, TruncatedResult, RpcError) as e:
        failed[t['name']] = str(e)[:80]
    done.append(t['name'])
print(json.dumps({'done': done, 'failed': failed}))`);
  expect(r.done.length).toBeGreaterThan(20);
  console.log(`read-only tools called with no arguments: ${r.done.length}, of which refused by the tool: ${Object.keys(r.failed).length} (${Object.keys(r.failed).join(', ')})`);
  expect(r.done.length - Object.keys(r.failed).length).toBeGreaterThan(15);
  const after = await frame.evaluate(() => ({ commits: window.gisworkbench.__commits, pending: window.gisworkbench.proposals.pending().length, autoApply: window.gisworkbench.proposals.autoApply }));
  expect(after).toEqual({ commits: [], pending: 0, autoApply: false });
});

test('REQ-GAP-02 SCN-61 the assistant tools that commit results are proposals for a script', async () => {
  test.setTimeout(60_000);
  const r = await python(`
c = Client.connect(token_file=TOKEN_FILE)
print(json.dumps({'find': c.call('gw_find_objects', objects=['car']).status, 'search': c.call('gw_search_imagery', text='runway').status}))`);
  expect(r).toEqual({ find: 'pending', search: 'pending' });
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    for (const p of app.proposals.pending()) app.proposals.reject(p.id);
  });
});

test('REQ-GAP-02 SCN-61 the relay is on loopback only and refuses browsers', async () => {
  test.setTimeout(60_000);
  const s = state();
  // Nothing listens on another address of this computer.
  const lan = Object.values(networkInterfaces()).flat().filter((a) => a.family === 'IPv4' && !a.internal).map((a) => a.address);
  for (const ip of lan) {
    const open = await new Promise((res) => {
      const c = connect({ host: ip, port: s.port, timeout: 1500 });
      c.on('connect', () => (c.destroy(), res(true)));
      c.on('error', () => res(false));
      c.on('timeout', () => (c.destroy(), res(false)));
    });
    expect(open, `${ip}:${s.port}`).toBe(false);
  }
  if (!LINUX) {
    const listen = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${s.port} -State Listen).LocalAddress`], { encoding: 'utf8' }).trim().split(/\r?\n/);
    expect(listen).toEqual(['127.0.0.1']);
  }
  // A page cannot call the client side: the browser's own fetch, from the app's page.
  const r = await frame.evaluate(async (base) => {
    try {
      const x = await fetch(`${base}/relay/v1/hello`, { credentials: 'omit' });
      return { status: x.status, text: await x.text() };
    } catch (e) {
      return { failed: String(e) };
    }
  }, s.base);
  expect(r.failed ?? r.status).toBeTruthy();
  expect(r.status === undefined || r.status === 403).toBe(true);
  // The script has no host to name, and sends nothing a browser would.
  const sig = await python(`
import inspect
print(json.dumps(sorted(inspect.signature(Client.__init__).parameters)))`);
  expect(sig).not.toContain('host');
});

test('REQ-GAP-02 SCN-61 measured round trip, and a result larger than the assistant gets', async () => {
  test.setTimeout(120_000);
  await watchActivity(frame);
  const r = await python(`
import statistics, time
c = Client.connect(token_file=TOKEN_FILE)
times = []
for i in range(100):
    t = time.perf_counter()
    c.ping()
    times.append((time.perf_counter() - t) * 1000)
times.sort()
d = c.v2.api.describe()
t = time.perf_counter()
tools = c.tools()
print(json.dumps({'median': statistics.median(times), 'p95': times[94], 'max': times[-1], 'describe': len(json.dumps(d)), 'toolsMs': (time.perf_counter() - t) * 1000, 'toolsBytes': len(json.dumps(tools))}))`);
  console.log(`relay round trip, 100 pings: median ${r.median.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, max ${r.max.toFixed(1)} ms; tools/list ${r.toolsBytes} bytes in ${r.toolsMs.toFixed(0)} ms; api.describe ${r.describe} characters`);
  // OD-2.27: the long poll and these 100 calls are not work the user is waiting for.
  const seen = await stopActivity(frame);
  expect(seen.firstRunningMs).toBeNull();
  expect(seen.firstShownMs).toBeNull();
  expect(r.describe).toBeGreaterThan(20000); // the assistant's cap: this result would have been cut
  expect(r.median).toBeLessThan(2000); // a sanity bound: the machine may be busy; the figures are in the log
});

test('REQ-GAP-02 SCN-61 the sidecar window names the relay and the script', async ({ browser }) => {
  test.setTimeout(60_000);
  const s = state();
  const win = await browser.newPage();
  await win.goto(await windowUrl(s));
  await expect(win.locator('#relay')).toHaveText(/^On for GIS Workbench .*null \(a page opened from a local file\).*call\(s\), 0 waiting\.$/, { timeout: 20_000 });
  await expect(win.locator('#paired')).toContainText('a program on this computer (Python relay)');
  await expect(win.locator('#log')).toContainText('relay: scn61 script: tools/call gw2_layers_list');
  expect(await win.locator('#log').textContent()).not.toContain('from python'); // tools are logged, never their arguments
  await win.close();
});

test('REQ-GAP-02 SCN-61 the Python Relay dialog passes axe', async () => {
  test.setTimeout(60_000);
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.relay');
  });
  await expect(frame.locator('[data-id="relay:calls"] li').first()).toBeVisible({ timeout: 20_000 });
  const axe = await import('axe-core').then((m) => m.default ?? m);
  await frame.evaluate(axe.source);
  const v = await frame.evaluate(async () => {
    const r = await window.axe.run(document.querySelector('[data-id="dialog:python-relay"]'), { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] });
    return r.violations.map((x) => ({ id: x.id, nodes: x.nodes.map((n) => n.target) }));
  });
  expect(v).toEqual([]);
});

test('REQ-GAP-02 SCN-61 off in the app ends it; a reload leaves it off; a revoked token stops the script', async () => {
  test.setTimeout(120_000);
  await frame.locator('[data-id="relay:on"]').uncheck();
  await expect(frame.locator('[data-id="relay:status"]')).toHaveText(/^Off/);
  await frame.locator('[data-id="dialog:python-relay"] button', { hasText: 'Close' }).click();
  await expect(frame.locator('.status-sidecar').first()).toHaveText('Sidecar ✓');
  const script = `
c = Client.connect(token_file=TOKEN_FILE)
print(json.dumps({'ok': True}))`;
  await expect(python(script)).rejects.toThrow(/NoApp/);
  await relayOn(frame);
  // After a reload the relay is off again: nothing restores it.
  await shared.reload();
  const { frame: f } = await openApp(shared, 'file', { htmlPath: DIST, prefs: PREFS });
  await expect(f.locator('.status-sidecar').first()).toHaveText(/Sidecar ✓/, { timeout: 20_000 });
  expect(await f.evaluate(() => window.gisworkbench.sidecar.relay?.on ?? false)).toBe(false);
  // The script forgets its pairing: its token no longer works.
  const r = await python(`
c = Client(find_port(), load_token(TOKEN_FILE))
tok = c.token
c.forget(TOKEN_FILE)
after = Client(find_port(), tok).hello()
print(json.dumps({'after': after, 'file': load_token(TOKEN_FILE)}))`);
  expect(r.after.paired).toBe(false);
  expect(r.file).toBe(null);
  expect(existsSync(TOKEN_FILE)).toBe(false);
});
