// 2.5 vendor group (REQ-GAP-20) in the app, on T&E corpus products (E:, skipped when absent):
//  - A WorldView-2 Level-1B GeoTIFF opened with its .IMD/.EPH/.ATT/.GEO/.RPB/.TIL gets the
//    rigorous DigitalGlobe line scanner beside the .RPB model, which stays active; the rigorous
//    model agrees with the RPB, is selectable in the model menu, states its sensor parameters and a
//    CE90; Model Info lists its notes and passes axe.
//  - A Landsat 8 C2 band and a Sentinel-2 L1C band get the map + line-of-sight model from their
//    ANG / MTD_TL through Load Vendor Model (app.vendorModels.loadFiles): on the reference surface
//    it is the map grid; above it the image point moves by h · tan(view zenith) away from the
//    satellite, as the USGS view-angle band states for the Landsat pixel.
import { test, expect } from '@playwright/test';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { openApp, openFiles } from './helpers.js';

const CORPUS = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const TE = existsSync(CORPUS) ? CORPUS : 'E:/TE-corpus';
const WV2 = join(TE, 'eo-spacenet-atlanta-wv2-l1b-rpc', 'nadir52_BDDC00_MUL');
const L8 = join(TE, 'landsat8-c2-l1tp-044034-20240820-tierb');
const S2 = join(TE, 's2-l1c-jp2-safe-10seh-20240816');
const AXE = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('REQ-GAP-20 DigitalGlobe EPH/ATT/GEO/IMD: the rigorous model opens beside the RPB, agrees with it and is selectable; Model Info passes axe', async ({ page }) => {
  test.skip(!existsSync(WV2), 'TE-corpus not mounted');
  test.setTimeout(240000);
  const files = readdirSync(WV2).filter((n) => /\.(TIF|IMD|EPH|ATT|GEO|RPB|TIL)$/i.test(n)).map((n) => join(WV2, n));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, files);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.models?.some((m) => /^Pushbroom \(DigitalGlobe/.test(m.name))), null, { timeout: 120000 });
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const core = app.core;
    const l = [...app.layers.values()].find((x) => x.models?.some((m) => /^Pushbroom \(DigitalGlobe/.test(m.name)));
    const dg = l.models.find((m) => /^Pushbroom \(DigitalGlobe/.test(m.name));
    const rpb = l.models.find((m) => /^RPC \(\.RPB/.test(m.name));
    const activeBefore = l.modelName;
    const rec = l.sideRpc.rpc;
    const [h0, h1] = [rec[6] - rec[11], rec[6] + rec[11]];
    const d = [];
    for (const h of [h0, (h0 + h1) / 2, h1])
      for (let j = 0; j <= 10; j++)
        for (let i = 0; i <= 10; i++) {
          const x = 0.5 + (i * (l.width - 1)) / 10;
          const y = 0.5 + (j * (l.height - 1)) / 10;
          const g = core.i2g(rpb.id, x, y, h);
          const p = core.g2i(dg.id, g.lat, g.lon, h);
          d.push(Math.hypot(p.x - x, p.y - y));
        }
    const item = app.commands.get('model.active').menu().find((m) => /^Pushbroom \(DigitalGlobe/.test(m.label));
    item.run();
    const e = core.pointError(dg.id, l.width / 2, l.height / 2, (h0 + h1) / 2, 0.5);
    const log = JSON.stringify(app.importLog);
    return { models: l.models.map((m) => (m.error ? `${m.name}: ${m.error}` : m.name)), activeBefore, active: l.modelName, rms: Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length), max: Math.max(...d), info: dg.info, notes: dg.notes, record: dg.record?.type, ce90: e.ce90, known: e.modelErrorKnown, logHasNote: /added beside the RPC/.test(log) };
  });
  console.log(`WV2 MUL 52.7° off nadir, rigorous vs RPB: RMS ${r.rms.toFixed(3)} px, max ${r.max.toFixed(3)} px, CE90 ${r.ce90.toFixed(2)} m; models ${JSON.stringify(r.models)}; notes ${JSON.stringify(r.notes)}`);
  expect(r.activeBefore).toMatch(/^RPC \(\.RPB sidecar/);
  expect(r.models).toContain('Pushbroom (DigitalGlobe EPH/ATT/GEO, rigorous)');
  // cargo vendor_dg_corpus: this product RMS 2.08 px, max 2.44 px (the RPB of the two 53° strips
  // implies about a quarter of the standard-atmosphere refraction; docs/validation/2.5/vendor.md).
  expect(r.rms).toBeLessThan(3);
  expect(r.max).toBeLessThan(4);
  expect(r.active).toBe('Pushbroom (DigitalGlobe EPH/ATT/GEO, rigorous)');
  expect(r.record).toBe(2);
  expect(r.info.params).toBe(7);
  expect(r.info.paramSigma.every((s) => s > 0)).toBe(true);
  expect(r.known).toBe(true);
  expect(r.ce90).toBeGreaterThan(1);
  expect(r.ce90).toBeLessThan(60);
  expect(r.notes.some((n) => /a priori σ from the EPH and ATT covariances/.test(n))).toBe(true);
  // Model Info lists the active model's notes and passes axe.
  await frame.evaluate(() => void window.gisworkbench.commands.run('model.info'));
  const dlg = frame.locator('[data-id="dialog:model-info"]');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('a priori σ from the EPH and ATT covariances');
  await frame.evaluate(readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
  const v = await frame.evaluate(async (tags) => (await window.axe.run(document.querySelector('[data-id="dialog:model-info"]'), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), AXE);
  expect(v).toEqual([]);
  expect(logs).toEqual([]);
});

/** Hand text files to the page as File objects and load them as vendor metadata for a layer. */
async function loadVendor(frame, layerName, files) {
  return frame.evaluate(
    async ({ layerName, files }) => {
      const app = window.gisworkbench;
      const l = [...app.layers.values()].find((x) => x.rec?.name === layerName);
      const r = await app.vendorModels.loadFiles(
        l,
        files.map((f) => new File([f.text], f.name)),
      );
      return { kind: r.kind, models: l.models.map((m) => (m.error ? `${m.name}: ${m.error}` : m.name)), active: l.modelName };
    },
    { layerName, files },
  );
}

test('REQ-GAP-20 Landsat 8 ANG and Sentinel-2 MTD_TL: map + line-of-sight models beside the map model', async ({ page }) => {
  test.skip(!existsSync(L8) || !existsSync(S2), 'TE-corpus not mounted');
  test.setTimeout(300000);
  const band = readdirSync(L8).find((n) => /_B4\.TIF$/.test(n));
  const ang = readdirSync(L8).find((n) => /_ANG\.txt$/.test(n));
  const mtl = readdirSync(L8).find((n) => /_MTL\.txt$/.test(n));
  const safe = readdirSync(S2).find((n) => /\.SAFE$/.test(n));
  const gran = join(S2, safe, 'GRANULE', readdirSync(join(S2, safe, 'GRANULE'))[0]);
  const b01 = readdirSync(join(gran, 'IMG_DATA')).find((n) => /_B01\.jp2$/.test(n));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [join(L8, band)]);
  await openFiles(frame, [join(gran, 'IMG_DATA', b01)]);
  const t0 = Date.now();
  const ls = await loadVendor(frame, band, [ang, mtl].map((n) => ({ name: n, text: readFileSync(join(L8, n), 'latin1') })));
  const msLandsat = Date.now() - t0;
  const s2 = await loadVendor(frame, b01, [{ name: 'MTD_TL.xml', text: readFileSync(join(gran, 'MTD_TL.xml'), 'utf8') }]);
  console.log(`Landsat: ${JSON.stringify(ls)} in ${msLandsat} ms; Sentinel-2: ${JSON.stringify(s2)}`);
  expect(ls.models).toContain('Map + line of sight (Landsat ANG)');
  expect(s2.models).toContain('Map + line of sight (Sentinel-2 MTD_TL)');
  // The map model stays the active one.
  expect(ls.active).not.toMatch(/line of sight/);
  expect(s2.active).not.toMatch(/line of sight/);
  // The oracle row nearest the Landsat scene centre: the USGS view zenith (0.01°) and azimuth.
  const csv = 'E:/gwb25/data-vendor/oracle/landsat8-c2-044034-20240820-vza-vaa.csv';
  const oracle = existsSync(csv)
    ? readFileSync(csv, 'utf8')
        .trim()
        .split('\n')
        .slice(1)
        .map((l) => l.split(',').map(Number))
        .reduce((b, r) => (Math.hypot(r[0] - 1000, r[1] - 1500) < Math.hypot(b[0] - 1000, b[1] - 1500) ? r : b))
    : null;
  const r = await frame.evaluate(
    ({ band, b01, oracle }) => {
      const app = window.gisworkbench;
      const core = app.core;
      const out = {};
      for (const [k, name, pt] of [['landsat', band, oracle ? [oracle[1] + 0.5, oracle[0] + 0.5] : [1500.5, 1000.5]], ['s2', b01, [900.5, 900.5]]]) {
        const l = [...app.layers.values()].find((x) => x.rec?.name === name);
        const los = l.models.find((m) => /line of sight/.test(m.name));
        const map = l.models.find((m) => m.id && !/line of sight/.test(m.name));
        const [x, y] = pt;
        const g = core.i2g(map.id, x, y, 0);
        const p0 = core.g2i(los.id, g.lat, g.lon, 0);
        const p1 = core.g2i(los.id, g.lat, g.lon, 1000);
        // The ground displacement (m) of a point 1000 m above the reference, and its azimuth.
        const gd = core.i2g(map.id, p1.x, p1.y, 0);
        const inv = core.inverse(g.lat, g.lon, gd.lat, gd.lon);
        out[k] = { onRef: Math.hypot(p0.x - x, p0.y - y), px: Math.hypot(p1.x - p0.x, p1.y - p0.y), metres: inv.distance, azi: inv.azi1, notes: los.notes };
      }
      return out;
    },
    { band, b01, oracle },
  );
  console.log(`map + line of sight, a point 1000 m above the reference: ${JSON.stringify(r)}`);
  for (const k of ['landsat', 's2']) {
    expect(r[k].onRef).toBeLessThan(1e-6);
    expect(r[k].metres).toBeGreaterThan(1);
    expect(r[k].metres).toBeLessThan(250);
  }
  if (oracle) {
    // h · tan(VZA), away from the satellite (VAA + 180°).
    const z = ((oracle[2] / 100) * Math.PI) / 180;
    const want = 1000 * Math.tan(z);
    expect(Math.abs(r.landsat.metres - want)).toBeLessThan(0.05 * want + 0.5);
    const az = (((r.landsat.azi - (oracle[3] / 100 + 180)) % 360) + 540) % 360 - 180;
    expect(Math.abs(az)).toBeLessThan(2);
  }
  expect(r.s2.notes.some((n) => /mean of the two/.test(n))).toBe(true);
  expect(logs).toEqual([]);
});
