// GIS Workbench 2.0 hub bridges (2.0 plan P7): REQ-HUB-01 Photoshop, REQ-HUB-02 Illustrator
// (layered PDF and SVG), REQ-HUB-03 GLB and USDZ terrain, REQ-HUB-04 CoT and ATAK data package,
// REQ-HUB-06 the Google Sheets relay (answered by a route handler). Every file is parsed back
// by an independent reader (ag-psd, fflate, the GLB layout, XML text).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { readPsd } from 'ag-psd';
import { openApp, openFiles, SAMPLES } from './helpers.js';

test.describe.configure({ timeout: 300000 });

const VEGAS = join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_PS-RGB_img10.tif');

async function ready(page) {
  await page.addInitScript(() => delete window.showSaveFilePicker); // saves become downloads
  const { frame, logs } = await openApp(page, 'file', { prefs: { welcomeDone: true, network: 'online' } });
  await openFiles(frame, [VEGAS]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.stats && l.lutTex), null, { timeout: 60000 });
  // A marker, an outline, an observation and an accepted detection to send.
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const g = (x, y) => l.groundAt(x, y);
    const c = g(325, 325);
    app.api.createGraphic({ shape: 'marker', coordinates: [[c.lon, c.lat]], text: 'Target 1' });
    app.api.createGraphic({ shape: 'polygon', coordinates: [[200, 200], [300, 200], [300, 300], [200, 300]].map(([x, y]) => [g(x, y).lon, g(x, y).lat]), text: 'AOI', style: { stroke: '#ff0000', fill: '#ff000033', width: 2 } });
    app.detections.add([{ cls: 'car', confidence: 0.9, anchor: 'image', ring: [[100, 100], [120, 100], [120, 110], [100, 110]], props: {} }], { layer: l, source: 'test' });
    app.detections.setStatus(app.store.all('detection')[0].id, 'accepted');
    app.setChain((ch) => (ch.tone = { ...ch.tone, gamma: 20, curve: [[0.25, 0.2], [0.75, 0.85]] }), 'test look');
  });
  return { frame, logs };
}
const save = async (page, frame, cmd, n = 1) => {
  const dls = [];
  const got = new Promise((res) => {
    page.on('download', async (d) => {
      dls.push({ name: d.suggestedFilename(), bytes: readFileSync(await d.path()) });
      if (dls.length === n) res();
    });
  });
  await frame.evaluate((c) => window.gisworkbench.commands.run(c), cmd);
  await got;
  return dls;
};

test('REQ-HUB-01 Photoshop: raw base layer, Levels and Curves rebuilding the look, graphics on top, with a world file', async ({ page }) => {
  const { frame } = await ready(page);
  const [psdFile, world] = await save(page, frame, 'hub.psd', 2);
  expect(psdFile.name).toMatch(/\.psd$/);
  const psd = readPsd(psdFile.bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  const names = psd.children.map((c) => c.name);
  expect(names[0]).toMatch(/raw, full range/);
  expect(names).toEqual(expect.arrayContaining(['Stretch (Levels)', 'Tonal curve (Curves)', 'Graphics']));
  const lev = psd.children.find((c) => c.name === 'Stretch (Levels)').adjustment;
  expect(lev.type).toBe('levels');
  expect(lev.red.highlightInput).toBeGreaterThan(lev.red.shadowInput);
  expect(lev.red.midtoneInput).toBeCloseTo(2 ** (20 / 50), 1);
  const cur = psd.children.find((c) => c.name === 'Tonal curve (Curves)').adjustment;
  expect(cur.rgb.map((p) => p.input)).toEqual([0, 64, 191, 255]);
  expect(world.name).toMatch(/\.psw$/);
  expect(world.bytes.toString().trim().split('\n')).toHaveLength(6);
});

test('REQ-HUB-02 Illustrator: a layered PDF with optional-content groups and a layered SVG', async ({ page }) => {
  const { frame } = await ready(page);
  const [pdf] = await save(page, frame, 'hub.pdf');
  const text = pdf.bytes.toString('latin1');
  const groups = [...text.matchAll(/\/Type \/OCG \/Name \(([^)]*)\)/g)].map((m) => m[1]);
  expect(groups[0]).toBe('Imagery');
  expect(groups).toEqual(expect.arrayContaining(['Graphics', 'Accepted detections', 'Neatline', 'Scale bar']));
  expect(text).toContain('/Subtype /GEO');
  const [svg] = await save(page, frame, 'hub.svg');
  const s = svg.bytes.toString();
  expect([...s.matchAll(/inkscape:label="([^"]*)" inkscape:groupmode="layer"/g)].map((m) => m[1])).toEqual(['Imagery', ...groups.slice(1)]);
  expect(s).toContain('>AOI</text>');
});

test('REQ-HUB-03 3D terrain: a textured GLB at true scale and a USDZ for iOS', async ({ page }) => {
  const { frame } = await ready(page);
  const [glb] = await save(page, frame, 'hub.glb');
  const b = glb.bytes;
  expect(b.subarray(0, 4).toString()).toBe('glTF');
  const len = b.readUInt32LE(12);
  const gltf = JSON.parse(b.subarray(20, 20 + len).toString());
  expect(gltf.images).toHaveLength(1);
  expect(gltf.textures).toHaveLength(1);
  const pos = gltf.accessors[gltf.meshes[0].primitives[0].attributes.POSITION];
  const span = Math.max(pos.max[0] - pos.min[0], pos.max[2] - pos.min[2]);
  expect(span).toBeGreaterThan(120); // the SpaceNet chip is 650 px × 0.3 m ≈ 195 m (the view fits it)
  expect(span).toBeLessThan(400);
  const [usdz] = await save(page, frame, 'hub.usdz');
  const z = unzipSync(new Uint8Array(usdz.bytes));
  const files = Object.keys(z);
  expect(files.some((f) => /\.usda$/.test(f))).toBe(true);
  expect(files.some((f) => /textures\/.*\.(png|jpg)$/.test(f))).toBe(true);
});

test('REQ-HUB-04 TAK: CoT events and an ATAK data package with a version-2 manifest', async ({ page }) => {
  const { frame } = await ready(page);
  const [cot] = await save(page, frame, 'hub.cot');
  const x = cot.bytes.toString();
  expect((x.match(/<event /g) ?? []).length).toBe(3); // marker, AOI outline, accepted car
  expect(x).toContain('type="a-u-G-E-V"'); // the car
  expect(x).toContain('type="u-d-f"'); // the outline
  expect(x).toContain('callsign="Target 1"');
  const [pkg] = await save(page, frame, 'hub.atak');
  const z = unzipSync(new Uint8Array(pkg.bytes));
  const m = strFromU8(z['MANIFEST/manifest.xml']);
  expect(m).toContain('<MissionPackageManifest version="2">');
  expect(Object.keys(z).filter((k) => k.startsWith('cot/'))).toHaveLength(3);
});

test('REQ-HUB-06 Google Sheets relay: an HMAC-signed text/plain POST of the rows', async ({ page }) => {
  let got = null;
  await page.route('https://script.google.com/macros/s/TESTRELAY/exec', async (r) => {
    got = { type: r.request().headers()['content-type'], body: JSON.parse(r.request().postData()) };
    await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, rows: got.body.rows.length }) });
  });
  const { frame } = await ready(page);
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('hub.relay'); // not awaited: it waits for the dialog
  });
  const dlg = frame.locator('[data-id="dialog:hub-relay"]');
  await dlg.getByLabel('Relay URL').fill('https://script.google.com/macros/s/TESTRELAY/exec');
  await dlg.getByLabel('Shared secret').fill('s3cret');
  await dlg.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => got).not.toBe(null);
  expect(got.type).toMatch(/^text\/plain/);
  expect(got.body.columns).toEqual(['time', 'kind', 'name', 'lat', 'lon', 'mgrs', 'text', 'source']);
  expect(got.body.rows.map((r) => r[1]).sort()).toEqual(['detection', 'marker']);
  expect(got.body.sig).toBe(createHmac('sha256', 's3cret').update(JSON.stringify(got.body.rows)).digest('hex'));
});

test('REQ-HUB-01 16-bit TIFF with a Curves preset (.acv) for the same look', async ({ page }) => {
  const { frame } = await ready(page);
  const [tif, acv] = await save(page, frame, 'hub.tiff16', 2);
  const { fromArrayBuffer } = await import('geotiff');
  const t = await fromArrayBuffer(tif.bytes.buffer.slice(tif.bytes.byteOffset, tif.bytes.byteOffset + tif.bytes.length));
  const im = await t.getImage();
  expect(im.getBitsPerSample()).toBe(16);
  expect(im.getSamplesPerPixel()).toBe(3);
  const [r] = await im.readRasters();
  expect(r.reduce((m, v) => Math.max(m, v), 0)).toBeGreaterThan(30000); // rescaled to the full 16-bit range
  expect(acv.name).toMatch(/\.acv$/);
  const w = (i) => acv.bytes.readUInt16BE(2 * i);
  expect([w(0), w(1)]).toEqual([1, 5]); // version 1, composite + R, G, B + alpha
});
