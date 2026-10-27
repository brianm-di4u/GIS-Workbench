// R2 platform: online sources by kind with tokens kept out of files (REQ-ARC-16, REQ-SEC-10), no
// request to an origin the user has not added, logged (REQ-SEC-12), the provenance notice and the
// redaction/split tool (REQ-SEC-11), streamed saves (REQ-ARC-21), and the input abstraction with
// gains, a SpaceMouse HID report and a gamepad (REQ-UI-20, REQ-UI-21).
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

test('REQ-ARC-16 REQ-SEC-10 REQ-SEC-12 online sources, tokens and the allow-list', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const o = app.online;
    const out = {};
    const xyz = o.addSource({ name: 'XYZ', kind: 'xyz', url: 'https://tiles.example.test/{z}/{x}/{y}.png', token: 'SECRET-123', tokenParam: 'access_token' });
    const wms = o.addSource({ name: 'WMS', kind: 'wms', url: 'https://maps.example.test/wms', layers: 'base,roads' });
    const wmts = o.addSource({ name: 'WMTS', kind: 'wmts', url: 'https://maps.example.test/wmts/1.0.0/base/default/GoogleMapsCompatible/{TileMatrix}/{TileRow}/{TileCol}.png' });
    const ags = o.addSource({ name: 'ArcGIS', kind: 'arcgis', url: 'https://services.example.test/arcgis/rest/services/World/MapServer/', token: 'KEEP-ME', rememberToken: true });
    out.urls = [o.tileUrl(xyz, 3, 2, 1), o.tileUrl(wms, 1, 0, 0), o.tileUrl(wmts, 5, 7, 9), o.tileUrl(ags, 4, 3, 2)];
    const errs = [];
    for (const bad of [{ kind: 'xyz', url: 'http://x/{z}/{x}/{y}' }, { kind: 'xyz', url: 'https://x/{z}/{x}' }, { kind: 'wms', url: 'https://x/wms' }, { kind: 'wmts', url: 'https://x/a/b' }]) {
      try {
        o.addSource(bad);
      } catch (e) {
        errs.push(e.message);
      }
    }
    out.errs = errs;
    out.prefsSources = JSON.stringify(app.prefs.get('mapSources'));
    out.prefsTokens = app.prefs.get('mapTokens');
    const proj = app.__test.serialiseProject(app);
    const z = new TextDecoder().decode(proj);
    out.projectHasToken = /SECRET-123|KEEP-ME/.test(z);
    // SEC-12: an origin not in the allow-list is refused and the attempt is logged.
    const before = app.netlog.entries.length;
    try {
      await app.netlog.fetchFor('test')('https://not-added.example.test/data.json');
      out.fetched = true;
    } catch (e) {
      out.fetchError = e.message;
    }
    out.logged = app.netlog.entries.length > before ? app.netlog.entries[0] : null;
    return out;
  });
  console.log(JSON.stringify(r));
  expect(r.urls[0]).toBe('https://tiles.example.test/3/2/1.png?access_token=SECRET-123');
  expect(r.urls[1]).toMatch(/SERVICE=WMS&REQUEST=GetMap&VERSION=1\.3\.0&LAYERS=base%2Croads&STYLES=&CRS=EPSG:3857&BBOX=-20037508\.343,0\.000,0\.000,20037508\.343&WIDTH=256&HEIGHT=256/);
  expect(r.urls[2]).toBe('https://maps.example.test/wmts/1.0.0/base/default/GoogleMapsCompatible/5/9/7.png');
  expect(r.urls[3]).toBe('https://services.example.test/arcgis/rest/services/World/MapServer/tile/4/2/3?token=KEEP-ME');
  expect(r.errs.length).toBe(4);
  expect(r.prefsSources).not.toMatch(/SECRET|KEEP/);
  expect(Object.values(r.prefsTokens)).toEqual(['KEEP-ME']);
  expect(r.projectHasToken).toBe(false);
  expect(r.fetched).toBeUndefined();
  expect(r.fetchError).toMatch(/allow-list|not allowed|origin/i);
  expect(r.logged).not.toBeNull();
  expect(logs.filter((l) => !/not-added\.example\.test|Content Security Policy|ERR_|Refused to connect/.test(l))).toEqual([]);
});

test('REQ-SEC-11 REQ-ARC-21 REQ-UI-20 REQ-UI-21 FX-01 provenance notice, redaction and split, streamed save, input devices', async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    // A fake gamepad pushing the left stick right (REQ-UI-20).
    let t = 0;
    navigator.getGamepads = () => [{ id: 'Test pad', index: 0, connected: true, axes: [0.8, 0, 0, 0], buttons: [], timestamp: t++ }];
  });
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx01/fx01.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const out = {};
    // Provenance notice on export.
    const chip = await app.makeChip({ number: 0 });
    await app.encodeProduct(chip, 'png');
    out.notice = app.lastProvenanceNotice?.message ?? null;
    // Redaction and split.
    const red = await app.redact.redactChip({ boxes: [[10, 40, 50, 30]], crop: [0, 0, 200, 120] });
    const px = red.canvas.getContext('2d').getImageData(30, 50, 1, 1).data;
    const parts = await app.redact.splitChip(2, 2);
    const head = new Uint8Array(await red.blob.slice(0, 64).arrayBuffer());
    out.redact = { w: red.canvas.width, h: red.canvas.height, px: Array.from(px), parts: parts.length, partW: parts[0].canvas.width, srcW: red.source.width, pngHasText: /tEXt|iTXt|zTXt/.test(String.fromCharCode(...head)) };
    // Streamed save (fallback path: gathered and downloaded).
    async function* gen() {
      for (let i = 0; i < 5; i++) yield new Uint8Array(1000).fill(i);
    }
    out.stream = await app.__test.saveStream?.(gen(), { name: 'stream.bin' });
    // Input devices.
    const v0 = { ...p.view };
    app.input.feed({ x: 1, y: 0, z: 0 }, 0.1);
    const v1 = { ...p.view };
    app.input.feed({ x: 0, y: 0, z: 0.5 }, 0.2);
    const v2 = { ...p.view };
    app.input.feed({ x: 0.05, y: 0.05 }, 0.1); // inside the dead zone
    const v3 = { ...p.view };
    app.prefs.set('inputGains', { x: 2 });
    app.input.feed({ x: 1 }, 0.1);
    const v4 = { ...p.view };
    const dv = new DataView(new ArrayBuffer(6));
    dv.setInt16(0, -300, true);
    app.input.hidReport(1, dv);
    const v5 = { ...p.view };
    window.dispatchEvent(new Event('gamepadconnected'));
    await new Promise((res) => setTimeout(res, 400));
    const v6 = { ...p.view };
    out.input = { pan1: v1.cx - v0.cx, zoom: v2.zoom / v1.zoom, dead: v3.cx - v2.cx, pan2: v4.cx - v3.cx, hid: v5.cx - v4.cx, pad: v6.cx - v5.cx, source: app.input.state.last?.source };
    return out;
  });
  console.log(JSON.stringify(r));
  expect(r.notice).toMatch(/Provenance: this PNG product carries a JSON record/);
  expect(r.redact.w).toBe(200);
  expect(r.redact.h).toBe(120);
  expect(r.redact.px.slice(0, 3)).toEqual([0, 0, 0]);
  expect(r.redact.parts).toBe(4);
  expect(r.redact.partW).toBe(Math.round(r.redact.srcW / 2));
  expect(r.redact.pngHasText).toBe(false);
  expect(r.stream).toMatchObject({ how: 'download', bytes: 5000 });
  expect(downloads).toContain('stream.bin');
  expect(r.input.pan1).toBeGreaterThan(0);
  expect(r.input.zoom).toBeLessThan(1);
  expect(r.input.dead).toBe(0);
  expect(r.input.pan2 * r.input.zoom).toBeCloseTo(2 * r.input.pan1, 4); // pans in screen pixels: twice the gain at the new zoom
  expect(r.input.hid).toBeLessThan(0);
  expect(r.input.pad).toBeGreaterThan(0);
  expect(r.input.source).toBe('gamepad:Test pad');
  expect(logs).toEqual([]);
});
