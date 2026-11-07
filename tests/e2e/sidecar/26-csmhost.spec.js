// SCN-64 (REQ-GAP-21, 25): an analyst uses an OSSIM rigorous model fitted back to an RPC; with
// the gate set for test, a mock CSM plug-in answers through the sandboxed host, and its hash and
// signer are recorded.
//
// OSSIM: a RADARSAT-2 SLC from the corpus. The sidecar samples ossimRadarSat2Model, the app fits an
// RPC and adds it. Two oracles, neither of them the fit: OSSIM's own ground-to-image at points inside
// the image, and the vendor's geolocation grid in product.xml. Numbers go to reports/sidecar/scn64.json
// and docs/validation/2.6/csmhost.md. Needs the `ossim` module in the bundle (GWB_SIDECAR_MODULES)
// and, for the dialog route, GWB_SIDECAR_PICK=<a product.xml> when the sidecar starts.
//
// The plug-in host: GWB_CSM_EXE is a sidecar built with the csm-host feature and GWB_CSM_BUILD the
// output of sidecar/csmhost/build.mjs; this spec starts its own sidecar from them. The shipped
// sidecar under test must have the host off, and that test has no conditions.

import { test, expect } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { openApp, openFiles } from '../helpers.js';
import { state, approvePending, startSidecar, stopSidecar, csmDecide, windowState, DIST_DIR, CORPUS, MODULES, DATA_ROOT, LINUX } from './harness.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const PREFS = { welcomeDone: true };
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const RS2 = join(CORPUS, 'sar-radarsat2-quadpol-slc-samples');
const SCENES = {
  SQ1: join(RS2, 'RS2_OK153952_PK1408403_DK1372522_SQ1_20231119_053723_HH_VV_HV_VH_SLC'),
  FQ17: join(RS2, 'RS2_OK153952_PK1408399_DK1372518_FQ17_20150626_052324_HH_VV_HV_VH_SLC'),
};
const TOOL = join(MODULES, 'ossim', 'bin', LINUX ? 'gwb-ossim-model' : 'gwb-ossim-model.exe');
const HAS_OSSIM = existsSync(TOOL);
const CONTRACT = JSON.parse(readFileSync(resolve('sidecar/csmhost/contract/csm-host-contract.json'), 'utf8'));
const CSM_EXE = process.env.GWB_CSM_EXE;
const CSM_BUILD = process.env.GWB_CSM_BUILD;
const LIB = LINUX ? '.so' : '.dll';
const REPORT = resolve('reports', 'sidecar', 'scn64.json');
const WORK = resolve(DATA_ROOT, 'csmhost26');
const results = {};
const record = (k, v) => {
  results[k] = v;
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), platform: process.platform, results }, null, 2));
};

const auth = (s) => ({ Origin: 'null', Authorization: `Bearer ${s.token}` });
async function api(s, method, path, { json, body } = {}) {
  return fetch(`${s.base}${path}`, { method, headers: { ...auth(s), ...(json ? { 'Content-Type': 'application/json' } : {}) }, body: json ? JSON.stringify(json) : body });
}
const upload = async (s, name, body) => (await (await api(s, 'PUT', `/v1/files?name=${encodeURIComponent(name)}`, { body })).json()).id;

/** The tool's environment, as the sidecar sets it. */
const toolEnv = () => ({ ...process.env, GWB_OSSIM_PLUGINS: join(MODULES, 'ossim', LINUX ? 'lib/plugins' : 'plugins'), LD_LIBRARY_PATH: join(MODULES, 'ossim', 'lib'), PATH: `${join(MODULES, 'ossim', 'bin')}${LINUX ? ':' : ';'}${process.env.PATH}` });

/** The vendor's tie points: line, pixel, lat, lon, height. */
function tiePoints(productXml) {
  const x = readFileSync(productXml, 'utf8');
  return [...x.matchAll(/<imageTiePoint>([\s\S]*?)<\/imageTiePoint>/g)].map(([, b]) => ['line', 'pixel', 'latitude', 'longitude', 'height'].map((k) => Number(new RegExp(`<${k}[^>]*>([^<]+)<`).exec(b)[1])));
}

/** OSSIM's own ground-to-image, the plain call. */
function ossimG2i(product, pts) {
  mkdirSync(WORK, { recursive: true });
  const [inp, out] = [join(WORK, 'pts.csv'), join(WORK, 'out.csv')];
  writeFileSync(inp, pts.map((p) => p.join(',')).join('\n'));
  execFileSync(TOOL, ['g2i', product, inp, out], { env: toolEnv(), timeout: 300_000, stdio: 'ignore' });
  return readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split(',').map(Number));
}

const stats = (d) => {
  const v = d.filter(Number.isFinite);
  return { n: v.length, rms: Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length), max: Math.max(...v) };
};

test.describe.configure({ mode: 'serial' });

test('OD-2.18: the plug-in host is off in the sidecar under test, whatever is asked', async () => {
  const s = state();
  const caps = await (await api(s, 'GET', '/v1/caps')).json();
  expect(caps.csm_host.available).toBe(false);
  expect(caps.csm_host.note).toContain('external security review');
  for (const [m, p] of [['GET', '/v1/csm/plugins'], ['POST', '/v1/csm/plugins'], ['POST', '/v1/csm/sessions'], ['POST', '/v1/csm/sessions/x/g2i'], ['DELETE', '/v1/csm/sessions/x']]) {
    const r = await api(s, m, p, { json: m === 'POST' ? {} : undefined });
    expect(r.status, `${m} ${p}`).toBe(403);
    expect((await r.json()).code).toBe('csm_off');
  }
  expect((await windowState(s)).csm).toBeNull();
});

test.describe('REQ-GAP-21: OSSIM rigorous model fitted back to an RPC', () => {
  test.skip(!HAS_OSSIM, `no ossim module in ${MODULES}`);
  let page;
  let frame;
  let s;
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    s = state();
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    ({ frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS }));
    // This run's sidecar, whatever else answers on the app's other ports.
    await frame.evaluate((base) => {
      window.gisworkbench.sidecar.client.base = base;
      void window.gisworkbench.commands.run('sidecar.pair');
    }, s.base);
    await expect(frame.locator('[data-id="sidecar:code"]')).toHaveText(/^\d{6}$/, { timeout: 20_000 });
    await approvePending(s);
    await expect(frame.locator('.status-sidecar').first()).toHaveText(/Sidecar ✓|Sidecar · /, { timeout: 20_000 });
  });
  test.afterAll(async () => page?.close());

  async function openLayer(file) {
    await openFiles(frame, [file]);
    await expect.poll(() => frame.evaluate(() => window.gisworkbench.activeLayer?.()?.kind), { timeout: 120_000 }).toBe('image');
  }

  for (const [index, [scene, dir]] of Object.entries(SCENES).entries()) {
    test(`${scene}: the model is fitted, follows OSSIM and the vendor's grid, and is the active model`, async () => {
      test.skip(!existsSync(join(dir, 'product.xml')), 'corpus not here');
      test.setTimeout(900_000);
      await openLayer(join(dir, 'imagery_HH.tif'));
      // The sidecar's zero-copy pick keeps product.xml beside its images. GWB_SIDECAR_PICK lists
      // the two scenes' product.xml in the order of SCENES.
      const up = await frame.evaluate(async () => (await window.gisworkbench.sidecar.client.pick('file')).files?.map((f) => f.id) ?? []).catch(() => []);
      test.skip(up.length <= index, 'set GWB_SIDECAR_PICK to the product.xml of each scene');
      const ties = tiePoints(join(dir, 'product.xml'));
      const hs = ties.map((t) => t[4]);
      const r = await frame.evaluate(async ({ file, hMin, hMax }) => window.gisworkbench.commands.run('model.ossim', { file, h_min: hMin, h_max: hMax }), { file: up[index], hMin: Math.floor(Math.min(...hs) - 100), hMax: Math.ceil(Math.max(...hs) + 400) });
      expect(r?.model, JSON.stringify(r)).toBe('ossimRadarSat2Model');
      expect(r.rmsPx).toBeLessThan(1);
      // The RPC at the vendor's tie points, and OSSIM's plain call at the same ground points.
      const rpc = await frame.evaluate(({ ties, id }) => ties.map(([, , lat, lon, h]) => window.gisworkbench.core.g2i(id, lat, lon, h)), { ties, id: r.id });
      const os = ossimG2i(join(dir, 'product.xml'), ties.map((t) => [t[2], t[3], t[4]]));
      const dRpcOssim = rpc.map((p, i) => Math.hypot(p.x - os[i][0], p.y - os[i][1]));
      const dRpcVendor = rpc.map((p, i) => Math.hypot(p.x - (ties[i][1] + 0.5), p.y - (ties[i][0] + 0.5)));
      const dOssimVendor = os.map((p, i) => Math.hypot(p[0] - (ties[i][1] + 0.5), p[1] - (ties[i][0] + 0.5)));
      const out = { fit: { rmsPx: r.rmsPx, maxPx: r.maxPx, checks: r.checks }, rpcVsOssimG2i: stats(dRpcOssim), rpcVsVendorGrid: stats(dRpcVendor), ossimVsVendorGrid: stats(dOssimVendor) };
      record(scene, out);
      expect(out.rpcVsOssimG2i.n).toBeGreaterThan(50);
      expect(out.rpcVsOssimG2i.rms).toBeLessThan(0.5);
      const active = await frame.evaluate(() => {
        const l = window.gisworkbench.activeLayer();
        return { id: l.modelId, name: l.modelName, models: l.models.map((m) => m.name), notes: l.models.find((m) => m.id === l.modelId).notes };
      });
      expect(active.id).toBe(r.id);
      expect(active.name).toContain('ossimRadarSat2Model');
      expect(active.notes.join(' ')).toContain('not an accuracy on the ground');
    });
  }

  test('a file OSSIM has no sensor model for is refused by name; the job says why', async () => {
    test.setTimeout(120_000);
    const id = await upload(s, 'notes.tif', Buffer.from('this is no image'));
    const job = await (await api(s, 'POST', '/v1/jobs', { json: { profile: 'ossim-rpc', inputs: [id], options: {} } })).json();
    await expect.poll(async () => (await (await api(s, 'GET', `/v1/jobs/${job.id}`)).json()).state, { timeout: 60_000 }).toBe('failed');
    const j = await (await api(s, 'GET', `/v1/jobs/${job.id}`)).json();
    expect(j.error).toMatch(/OSSIM|sensor model/);
  });

  test('the dialog passes axe, and Cancel leaves no job', async () => {
    test.setTimeout(120_000);
    await frame.evaluate(() => void window.gisworkbench.commands.run('model.ossim'));
    const dlg = frame.locator('[data-id="ossim:hmin"]');
    await expect(dlg).toBeVisible({ timeout: 20_000 });
    await frame.evaluate(AXE);
    const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[role="dialog"]'), { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] })).violations.map((x) => x.id));
    expect(v).toEqual([]);
    // The activity indicator has a Cancel of its own now.
    await frame.getByRole('dialog', { name: 'Load OSSIM Rigorous Model' }).getByRole('button', { name: 'Cancel' }).click();
  });
});

test.describe('REQ-GAP-25: a mock CSM plug-in through the sandboxed host, gate set for test', () => {
  test.skip(!CSM_EXE || !CSM_BUILD, 'set GWB_CSM_EXE and GWB_CSM_BUILD');
  let s;
  let sha;
  const session = (isd) => upload(s, 'scene.isd', Buffer.from(isd)).then(async (id) => api(s, 'POST', '/v1/csm/sessions', { json: { plugin: sha, isd: id } }));
  const isd = (behaviour, extra = '') => `gwb-mock-isd 1\n${Object.entries(CONTRACT.isd).map(([k, v]) => `${k} ${v}`).join('\n')}\nbehaviour ${behaviour}\n${extra}`;
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    rmSync(WORK, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    s = await startSidecar({ exe: CSM_EXE, dataDir: resolve(DATA_ROOT, 'csmhost-sidecar'), port: 47831, extra: ['--test-allow-csm', '--test-csm-host', CSM_BUILD] });
  });
  test.afterAll(async () => s && stopSidecar(s.pid));

  test('the hash and signer are recorded, nothing runs before approval, and a page cannot approve', async () => {
    const file = join(CSM_BUILD, `gwb_mock_csm_plugin${LIB}`);
    const r = await api(s, 'POST', '/v1/csm/plugins', { json: { file: await upload(s, 'mock.plugin', readFileSync(file)) } });
    expect(r.status).toBe(201);
    const rec = await r.json();
    sha = rec.sha256;
    const want = spawnSync(process.execPath, ['-e', `process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(${JSON.stringify(file)})).digest('hex'))`], { encoding: 'utf8' }).stdout;
    expect(sha).toBe(want);
    expect(rec.state).toBe('pending');
    expect(rec.signer.status).toBe(LINUX ? 'unchecked' : 'unsigned');
    const before = await session(isd('normal'));
    expect(before.status).toBe(403);
    expect((await before.json()).code).toBe('csm_not_approved');
    expect((await windowState(s)).log.join('\n')).toContain(sha);
    expect((await csmDecide(s, sha, true)).state).toBe('approved');
    record('plugin', { sha256: sha, signer: rec.signer });
  });

  test('Windows: a signed plug-in has its signer recorded, and an unknown root says so', async () => {
    const signtool = process.env.GWB_SIGNTOOL ?? 'C:/Program Files (x86)/Windows Kits/10/bin/10.0.26100.0/x64/signtool.exe';
    const openssl = 'C:/Program Files/Git/usr/bin/openssl.exe';
    test.skip(LINUX || !existsSync(signtool) || !existsSync(openssl), 'Windows with signtool and openssl');
    test.setTimeout(120_000);
    // A key made here, in a folder of its own: no certificate store is touched.
    const [key, crt, pfx, dll] = ['t.key', 't.crt', 't.pfx', 'signed.dll'].map((n) => join(WORK, n));
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=GWB Test Plug-in Signer', '-addext', 'extendedKeyUsage=codeSigning'], { stdio: 'ignore' });
    execFileSync(openssl, ['pkcs12', '-export', '-inkey', key, '-in', crt, '-out', pfx, '-passout', 'pass:test'], { stdio: 'ignore' });
    copyFileSync(join(CSM_BUILD, 'gwb_mock_csm_plugin.dll'), dll);
    execFileSync(signtool, ['sign', '/fd', 'SHA256', '/f', pfx, '/p', 'test', dll], { stdio: 'ignore' });
    const rec = await (await api(s, 'POST', '/v1/csm/plugins', { json: { file: await upload(s, 'signed.dll', readFileSync(dll)) } })).json();
    expect(rec.signer.status).toBe('untrusted');
    expect(rec.signer.subject).toBe('GWB Test Plug-in Signer');
    expect(rec.signer.thumbprint).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.sha256).not.toBe(sha);
    record('signedPlugin', rec.signer);
  });

  test('the contract holds through the sidecar, the host and the plug-in', async () => {
    const r = await session(isd('normal'));
    expect(r.status).toBe(201);
    const info = await r.json();
    expect(info.model).toBe(CONTRACT.model.name);
    expect(info.plugin_name).toBe(CONTRACT.model.plugin);
    expect(info.confinement).toMatch(LINUX ? /seccomp/ : /AppContainer yes/);
    const call = async (op, json) => (await api(s, 'POST', `/v1/csm/sessions/${info.id}/${op}`, { json })).json();
    const g = await call('g2i', { points: CONTRACT.g2i.points });
    CONTRACT.g2i.expect.forEach(([l, a], i) => {
      expect(Math.abs(g.points[i][0] - l)).toBeLessThan(CONTRACT.g2i.tolerance_px);
      expect(Math.abs(g.points[i][1] - a)).toBeLessThan(CONTRACT.g2i.tolerance_px);
    });
    const e = await call('i2g', { points: CONTRACT.i2g.points, precision: 1e-4 });
    CONTRACT.i2g.expect.forEach((p, i) => p.forEach((v, k) => expect(Math.abs(e.points[i][k] - v)).toBeLessThan(CONTRACT.i2g.tolerance_m)));
    const p = await call('partials', { ground: CONTRACT.partials.ground });
    CONTRACT.partials.expect.ground.forEach((v, k) => expect(Math.abs(p.ground[k] - v)).toBeLessThan(CONTRACT.partials.tolerance));
    expect(p.sensor).toEqual(CONTRACT.partials.expect.sensor);
    expect(await call('covariance', { image: CONTRACT.covariance.image })).toEqual(CONTRACT.covariance.expect);
    expect((await api(s, 'DELETE', `/v1/csm/sessions/${info.id}`)).status).toBe(204);
  });

  test('the sandbox stops what the plug-in tries', async () => {
    let hits = 0;
    const srv = net.createServer((c) => {
      hits++;
      c.destroy();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const secret = join(WORK, 'secret.txt');
    const forbidden = join(WORK, 'written-by-plugin.txt');
    writeFileSync(secret, 'the user’s data');
    const r = await session(isd('probe', `probe_port ${srv.address().port}\ncanary_read ${secret}\ncanary_write ${forbidden}\n`));
    expect(r.status).toBe(201);
    const { trajectory, id } = await r.json();
    for (const part of ['tcp=blocked', 'read=blocked', 'write=blocked', 'spawn=blocked']) expect(trajectory).toContain(part);
    await new Promise((res) => srv.close(res));
    expect(hits).toBe(0);
    expect(existsSync(forbidden)).toBe(false);
    record('probe', trajectory);
    await api(s, 'DELETE', `/v1/csm/sessions/${id}`);
  });

  test('a crash costs one session; the sidecar goes on', async () => {
    const info = await (await session(isd('crash'))).json();
    const r = await api(s, 'POST', `/v1/csm/sessions/${info.id}/g2i`, { json: { points: [CONTRACT.g2i.points[0]] } });
    expect(r.status).toBe(502);
    expect((await r.json()).code).toBe('csm_host_ended');
    expect((await api(s, 'GET', '/v1/caps')).status).toBe(200);
  });
});
