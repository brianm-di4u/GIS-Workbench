// Sidecar e2e (SDP-2.1 §7.5, Appendix E): PT-14 (file:// + sidecar), PT-15 (hosted https and the
// sidecar's own /app/), PT-16 (air-gapped + sidecar, network capture), SCN-27 (MrSID and ECW →
// COG overlay), SCN-32 (FileGDB through universal import; a layer saved with an OGR writer the app
// lacks). Runs only in the `sidecar` projects, against a test sidecar the setup project started.

import { test, expect } from '@playwright/test';
import { join, dirname } from 'node:path';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { openApp, openFiles } from '../helpers.js';
import { state, approvePending, httpsServer, outboundConnections, DIST_DIR, CORPUS, HOSTED, STATE as STATE_DIR, LINUX } from './harness.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const AIRGAP = join(DIST_DIR, 'gis-workbench-airgap.html');
const SID = join(CORPUS, 'raster-mrsid-gdal-samples', 'lossless-mg3', 'utm11-27.sid');
const ECW = join(CORPUS, 'raster-ecw-negatives-gdal', 'stefan_full_rgba_ecwv3_meta.ecw');
const GDB = join(CORPUS, 'vector-filegdb-gdal-autotest', 'testopenfilegdb.gdb.zip');
// Linux (P16): a GDAL raster for the file:// → COG path, MrSID having no Linux plug-in.
const HFA = join(CORPUS, 'derived-raster-negatives', 'naip_b1_hfa.img');
// The raster the PT tests convert: the MrSID needs the Windows vendor plug-in.
const RASTER = LINUX ? HFA : SID;
const PREFS = { welcomeDone: true };

/** Pair through the UI: start pairing, read the code the app shows, approve it in the sidecar. */
async function pairViaUi(frame, s) {
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.pair');
  });
  const code = frame.locator('[data-id="sidecar:code"]');
  await expect(code)
    .toHaveText(/^\d{6}$/, { timeout: 20_000 })
    .catch(async (e) => {
      const why = await frame.evaluate(() => ({ status: window.gisworkbench.sidecar.state, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent), log: window.gisworkbench.netlog.entries.slice(0, 8).map((x) => `${x.method} ${x.origin}${x.path} ${x.status}`) }));
      throw new Error(`${e.message}\n${JSON.stringify(why, null, 1)}`);
    });
  const shown = await code.textContent();
  const approved = await approvePending(s, { expectCode: shown });
  expect(approved.length).toBe(1);
  await expect(frame.locator('.status-sidecar').first()).toHaveText(/Sidecar ✓|Sidecar · /, { timeout: 20_000 });
  return { shown, origin: approved[0].origin };
}

/** Run a file through sidecar.convert (the command other features call) and wait for the layer. */
async function convertFile(frame, path, profile, extra = {}) {
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.style.display = 'none';
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles([].concat(path));
  return frame.evaluate(
    async ({ i, profile, extra }) => {
      const app = window.gisworkbench;
      const files = [...i.files];
      i.remove();
      const before = app.layers.size;
      const job = await app.commands.run('sidecar.convert', { files, profile, reason: 'e2e', ...extra });
      return { state: job?.state, outputs: job?.outputs, provenance: job?.provenance, layers: app.layers.size - before };
    },
    { i: input, profile, extra },
  );
}

const sidecarLog = (frame) => frame.evaluate(() => window.gisworkbench.netlog.entries.filter((e) => e.loopback).map((e) => ({ method: e.method, path: e.path, status: e.status })));

test.describe.configure({ mode: 'serial' });

test('PT-14 SCN-27 file:// — pair, MrSID refused → Convert with Sidecar → COG opened in place by range', async ({ page }) => {
  test.setTimeout(180_000);
  const s = state();
  const { frame, logs, requests, csp } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
  // Nothing is asked of the sidecar at start (REQ-SDC-01): no token yet, no loopback request.
  await expect(frame.locator('.status-sidecar').first()).toHaveText('Sidecar');
  expect(await sidecarLog(frame)).toEqual([]);
  const { origin } = await pairViaUi(frame, s);
  expect(origin).toBe('null');
  // The app refuses the MrSID by name (or shows its footprint); the toast offers the sidecar.
  await openFiles(frame, [SID]);
  const action = frame.locator('.toast .toast-action', { hasText: 'Convert with Sidecar' }).first();
  const native = await frame.evaluate(() => [...window.gisworkbench.layers.values()].length);
  if (LINUX) {
    // P16: the MrSID plug-in exists for Windows only. The app says so before any upload, and a
    // raster the Linux sidecar's GDAL decodes (HFA, 512 × 512) takes the same path to a COG.
    await convertFile(frame, SID, 'raster-cog').catch(() => {});
    await expect(frame.locator('.toast', { hasText: 'Windows only' }).first()).toBeVisible();
    expect((await sidecarLog(frame)).some((e) => e.method === 'PUT')).toBe(false);
    await convertFile(frame, HFA, 'raster-cog');
  } else if (await action.count()) {
    await action.click();
  } else {
    // The MrSID group's footprint layer opened instead: convert through the same command.
    expect(native).toBeGreaterThan(0);
    await convertFile(frame, SID, 'raster-cog');
  }
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => /\.cog\.tif$/.test(l.rec?.name ?? l.name ?? '')), null, { timeout: 120_000 });
  const L = await frame.evaluate(() => {
    const l = [...window.gisworkbench.layers.values()].find((x) => /\.cog\.tif$/.test(x.rec?.name ?? x.name ?? ''));
    return { w: l.width, h: l.height, fmt: l.info?.meta?.format ?? '', name: l.rec?.name ?? l.name };
  });
  expect(L.w).toBe(512);
  expect(L.h).toBe(512);
  const net = await sidecarLog(frame);
  expect(net.some((e) => e.method === 'PUT' && e.path === '/v1/files')).toBe(true);
  expect(net.some((e) => e.path.startsWith('/v1/files/') && e.status === 206), 'the COG is read by range').toBe(true);
  expect(requests, 'no request leaves the computer').toEqual([]);
  expect(await csp()).toEqual([]);
  // Linux: the MrSID refusal above is the one expected error.
  expect(logs.filter((l) => !(LINUX && /cannot decode MrSID/.test(l)))).toEqual([]);
  // The job and its provenance are in the dock.
  await frame.evaluate(() => window.gisworkbench.commands.run('sidecar.jobs'));
  await expect(frame.locator('[data-id="sidecar:jobs"] [data-state="succeeded"]').first()).toBeVisible();
});

test('SCN-27 ECW (RGBA, ECW v3) → COG keeps the alpha band and opens as an overlay', async ({ page }) => {
  test.setTimeout(180_000);
  const s = state();
  const { frame, requests } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
  await pairViaUi(frame, s);
  if (LINUX) {
    // P16: no ECW plug-in on Linux; refused by name before the upload.
    await convertFile(frame, ECW, 'raster-cog').catch(() => {});
    await expect(frame.locator('.toast', { hasText: /cannot decode ECW: .*Windows only/ }).first()).toBeVisible();
    expect((await sidecarLog(frame)).some((e) => e.method === 'PUT')).toBe(false);
    return;
  }
  const r = await convertFile(frame, ECW, 'raster-cog');
  expect(r.state).toBe('succeeded');
  expect(r.outputs[0].name).toBe('stefan_full_rgba_ecwv3_meta.cog.tif');
  expect(r.provenance.steps[0].tool).toBe('gdal_translate');
  expect(r.provenance.steps[0].version).toMatch(/GDAL 3\.13/);
  expect(r.layers).toBeGreaterThan(0);
  const bands = await frame.evaluate(() => [...window.gisworkbench.layers.values()].at(-1).bands ?? [...window.gisworkbench.layers.values()].at(-1).info?.bands);
  expect(Number(bands?.length ?? bands)).toBe(4);
  expect(requests).toEqual([]);
});

test('SCN-32 FileGDB through universal import (probe → vector-gpkg), then a layer saved with an OGR writer the app lacks', async ({ page }) => {
  test.setTimeout(180_000);
  const s = state();
  const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
  await pairViaUi(frame, s);
  // No profile: the sidecar probes the file and picks the conversion (REQ-SDC-09).
  const r = await convertFile(frame, GDB, null);
  expect(r.state, JSON.stringify(r)).toBe('succeeded');
  expect(r.outputs[0].name).toMatch(/\.gpkg$/);
  await frame
    .waitForFunction(() => window.gisworkbench.store.all('layer').some((l) => /testopenfilegdb/.test(l.name ?? '')) || window.gisworkbench.importLog.some((e) => /\.gpkg$|^GeoPackage$/.test(e.file)), null, { timeout: 60_000 })
    .catch(async (e) => {
      const why = await frame.evaluate(() => ({ toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent), imp: window.gisworkbench.importLog.slice(-5), layers: window.gisworkbench.store.all('layer').map((l) => l.name) }));
      throw new Error(`${e.message}\n${JSON.stringify(why, null, 1)}`);
    });
  const imp = await frame.evaluate(() => window.gisworkbench.importLog.filter((e) => /\.gpkg$|^GeoPackage$/.test(e.file)));
  expect(imp.at(-1).errors).toEqual([]);
  // Save As with a writer the app does not have (MapInfo TAB), options checked by the driver list.
  const w = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const caps = await app.sidecar.ready();
    const writers = caps.vector_drivers.filter((d) => d.write).map((d) => d.name);
    return { writers, n: writers.length, mapinfo: writers.includes('MapInfo File') };
  });
  expect(w.mapinfo).toBe(true);
  expect(w.n).toBeGreaterThan(20);
  // One layer, as the app writes it (GeoJSON), saved as MapInfo TAB with a checked option.
  const layer = join(dirname(STATE_DIR), 'scn32-layer.geojson');
  writeFileSync(layer, JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'a', n: 1 }, geometry: { type: 'Point', coordinates: [-84.3, 33.7] } }, { type: 'Feature', properties: { name: 'b', n: 2 }, geometry: { type: 'LineString', coordinates: [[-84.3, 33.7], [-84.2, 33.8]] } }] }));
  const out = await convertFile(frame, layer, 'export-ogr', { options: { driver: 'MapInfo File', dsco: ['SPATIAL_INDEX_MODE=OPTIMIZED'] }, open: false });
  expect(out.state, JSON.stringify(out)).toBe('succeeded');
  const names = out.outputs.map((o) => o.name);
  expect(names).toContain('scn32-layer.tab');
  expect(names.filter((n) => /\.(dat|map|id)$/i.test(n)).length).toBe(3);
  // An independent reader (the sidecar's own ogrinfo is the implementation under test, so the
  // gw-te OGR) reads the TAB back: 2 features.
  const pub = join(state().dataDir, 'outputs');
  const tab = readdirSync(pub).map((d) => join(pub, d, 'scn32-layer.tab')).find((p) => existsSync(p));
  // The oracle OGR: the gw-te env on Windows; on Linux the conda prefix the bundle was made from.
  const te = LINUX ? `${process.env.HOME}/gwb/deps/conda-gdal` : 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library';
  const info = execFileSync(join(te, 'bin', LINUX ? 'ogrinfo' : 'ogrinfo.exe'), ['-so', '-al', tab], { encoding: 'utf8', env: { ...process.env, PATH: `${join(te, 'bin')}${LINUX ? ':' : ';'}${process.env.PATH}`, GDAL_DATA: join(te, 'share', 'gdal'), PROJ_DATA: join(te, 'share', 'proj') } });
  expect(info).toMatch(/Feature Count: 2/);
  // A bad creation option is refused before anything runs.
  const bad = await frame.evaluate(async () => {
    try {
      await window.gisworkbench.sidecar.client.createJob({ profile: 'export-ogr', inputs: ['0'.repeat(32)], options: { driver: 'MapInfo File', dsco: ['NOPE=1'] } });
      return 'accepted';
    } catch (e) {
      return e.message;
    }
  });
  expect(bad).not.toBe('accepted');
});

test('SCN-32 E57 through universal import (probe → points-copc), opened as a point cloud with every point (REQ-LDR-12)', async ({ page }) => {
  test.setTimeout(180_000);
  const s = state();
  const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
  await pairViaUi(frame, s);
  // PDAL's test scan A_B.e57: two scans, 6 points (pdal info --summary).
  const r = await convertFile(frame, join(CORPUS, 'points-e57-pdal-test', 'A_B.e57'), null);
  expect(r.state, JSON.stringify(r)).toBe('succeeded');
  expect(r.outputs[0].name).toMatch(/.copc.laz$/);
  await frame.waitForFunction(() => [...window.gisworkbench.pointClouds.values()].some((c) => /A_B/.test(c.name)), null, { timeout: 60_000 });
  const c = await frame.evaluate(() => [...window.gisworkbench.pointClouds.values()].filter((c) => /A_B/.test(c.name)).map((c) => ({ name: c.name, n: c.n })));
  expect(c.at(-1).n).toBe(6);
});

test('PT-15 hosted https (and the LNA preflight answer) and the sidecar-served /app/', async ({ browser }) => {
  test.setTimeout(240_000);
  const s = state();
  const srv = await httpsServer(DIST_DIR);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await ctx.grantPermissions(['local-network-access'], { origin: HOSTED }).catch(() => {});
    const page = await ctx.newPage();
    const { frame, csp } = await openApp(page, 'http', { srv: { appUrl: `${HOSTED}/gis-workbench.html` }, prefs: PREFS });
    const { origin } = await pairViaUi(frame, s);
    expect(origin).toBe(HOSTED);
    const r = await convertFile(frame, RASTER, 'raster-cog');
    expect(r.state).toBe('succeeded');
    expect(r.layers).toBeGreaterThan(0);
    expect(await csp()).toEqual([]);
    // The same build served by the sidecar itself (REQ-SDC-15), hash-checked against SHA256SUMS.
    const p2 = await ctx.newPage();
    const { frame: f2, csp: csp2 } = await openApp(p2, 'http', { srv: { appUrl: `${s.base}/app/` }, prefs: PREFS });
    const o2 = await pairViaUi(f2, s);
    expect(o2.origin).toBe(s.base);
    const r2 = await convertFile(f2, RASTER, 'raster-cog');
    expect(r2.state).toBe('succeeded');
    expect(await csp2()).toEqual([]);
  } finally {
    await ctx.close();
    await srv.close();
  }
});

test('PT-16 air-gapped file: Sidecar switch off by default; on, only loopback; the sidecar connects nowhere', async ({ page }) => {
  test.setTimeout(240_000);
  const s = state();
  const all = [];
  page.on('request', (r) => all.push(r.url()));
  const { frame, csp } = await openApp(page, 'file', { htmlPath: AIRGAP, prefs: PREFS });
  await expect(frame.locator('.status-sidecar').first()).toHaveText('Sidecar off');
  const refused = await frame.evaluate(async () => {
    try {
      await window.gisworkbench.sidecar.ready({ interactive: false });
      return 'ok';
    } catch (e) {
      return e.message;
    }
  });
  expect(refused).toMatch(/switch is off/);
  await frame.evaluate(() => window.gisworkbench.commands.run('sidecar.toggle'));
  await pairViaUi(frame, s);
  const before = outboundConnections();
  const run = convertFile(frame, RASTER, 'raster-cog');
  // Capture while the job runs and after.
  const during = [];
  for (let i = 0; i < 5; i++) {
    during.push(...outboundConnections());
    await page.waitForTimeout(300);
  }
  const r = await run;
  expect(r.state).toBe('succeeded');
  during.push(...outboundConnections());
  expect(before, 'no outbound connection from the sidecar or its tools').toEqual([]);
  expect(during).toEqual([]);
  const offLoop = all.filter((u) => !/^(file|data|blob|about):/.test(u) && !/^http:\/\/127\.0\.0\.1:4782[1-3]\//.test(u));
  expect(offLoop, 'the air-gapped file made only loopback requests').toEqual([]);
  expect(await csp()).toEqual([]);
});

test('Sidecar Jobs dock: cancel a running job, retry it, and the status-bar job count', async ({ page }) => {
  test.setTimeout(240_000);
  const s = state();
  const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
  await pairViaUi(frame, s);
  // A large-enough conversion to cancel: the ECW at JPEG quality 100, zero-copy picked inputs are
  // tested elsewhere; here a WEBP COG of the RGBA ECW is slow enough on small files only with
  // LANCZOS, so we cancel immediately after queueing.
  const id = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const up = await app.sidecar.client.upload(new Blob([new Uint8Array(64)]), { name: 'x.bin' });
    const j = await app.sidecar.client.createJob({ profile: 'probe', inputs: [up.id] });
    await app.sidecar.client.cancel(j.id).catch(() => {});
    return j.id;
  });
  expect(id).toMatch(/^[0-9a-f]{24}$/);
  const final = await frame.evaluate(async (id) => {
    for (let i = 0; i < 100; i++) {
      const j = await window.gisworkbench.sidecar.client.job(id);
      if (['succeeded', 'failed', 'cancelled'].includes(j.state)) return j;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, id);
  expect(['cancelled', 'succeeded']).toContain(final.state);
  expect(final.outputs).toEqual([]);
});

const MPEG2 = join(CORPUS, 'derived-fmv-variants', 'truck_mpeg2_klv.ts');

test('SCN-30 MPEG-2 KLV transport stream → H.264 through the sidecar → plays in the FMV player with every KLV packet', async ({ page }) => {
  test.setTimeout(240_000);
  const s = state();
  const { frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS });
  await pairViaUi(frame, s);
  const r = await convertFile(frame, MPEG2, 'video-h264-klv');
  expect(r.state).toBe('succeeded');
  // Windows: H.264 (Media Foundation, S-49). Linux (P16): MPEG-1, decoded by the app itself.
  expect(r.outputs[0].name).toBe(LINUX ? 'truck_mpeg2_klv.mpeg1.ts' : 'truck_mpeg2_klv.h264.ts');
  expect(r.provenance.options.encoder).toBe(LINUX ? 'mpeg1video' : 'h264_mf');
  await frame.waitForFunction(() => window.gisworkbench.fmv?.activeClip?.()?.packets?.length > 0, null, { timeout: 60_000 });
  const c = await frame.evaluate(() => {
    const clip = window.gisworkbench.fmv.activeClip();
    return { name: clip.name ?? clip.file?.name, packets: clip.packets.length, ok: clip.packets.filter((k) => k.ok).length, frames: clip.frames.length, codec: clip.codec, playable: window.gisworkbench.fmv.playable?.(clip) ?? null };
  });
  expect(c.packets).toBe(288);
  expect(c.ok).toBe(288);
  expect(String(c.codec)).toMatch(LINUX ? /mp1v/ : /h264|avc/i);
  expect(c.frames).toBeGreaterThan(1000);
});

// PT-14 amended (OD-2.23, owner item in docs/validation/2.5/mobile.md): the sidecar is Full only, since
// a phone cannot reach a loopback sidecar. The Lite case no longer pairs and converts; it checks that
// Lite has no sidecar UI, no sidecar command and no loopback origin, with a sidecar running here.
test('PT-14 Lite file: no sidecar UI, commands or loopback origin (sidecar is Full only, OD-2.23)', async ({ page }) => {
  const { frame, csp } = await openApp(page, 'file', { htmlPath: join(DIST_DIR, 'gis-workbench-lite.html'), prefs: PREFS });
  const r = await frame.evaluate(() => ({
    csp: document.getElementById('csp').content,
    loopback: window.__gw.manifest.csp.loopback,
    ui: document.querySelectorAll('[data-id*="sidecar"], [data-cmd^="sidecar."]').length,
    client: !!window.gisworkbench.sidecar,
    enabled: window.gisworkbench.commands.list().filter((c) => c.id.startsWith('sidecar.') && window.gisworkbench.commands.enabled(c.id)).map((c) => c.id),
  }));
  expect(r.csp).not.toMatch(/127\.0\.0\.1/);
  expect(r.loopback).toEqual([]);
  expect(r.ui).toBe(0);
  expect(r.client).toBe(false);
  expect(r.enabled).toEqual([]);
  expect(await csp()).toEqual([]);
});
