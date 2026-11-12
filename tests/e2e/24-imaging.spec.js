// 2.4 imaging group (SDP-2.3 GR-04, GR-12):
//   REQ-GAP-34 COLLADA, STL, PLY and model KMZ from buildings and terrain, read back by three.js's
//              ColladaLoader, KMZLoader, STLLoader and PLYLoader (independent readers) and by the app;
//              a third-party COLLADA (libkml's SketchUp model) read by the app and by ColladaLoader.
//   REQ-GAP-14 the pan-sharpened COG of the SpaceNet Las Vegas WorldView-3 pair: weighted Brovey
//              against GDAL's gdal_pansharpen over a 2048² window, Gram–Schmidt with its Wald figures,
//              GDAL's COG validator; the display-only fusion still turns on.
// Data from the T&E corpus (skipped when absent); temporary files on E: (GW_TMP).
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { unzipSync, strFromU8 } from 'fflate';
import { openApp, openFiles, SAMPLES } from './helpers.js';

test.describe.configure({ timeout: 600000 });

const CORPUS = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const C = (...p) => join(CORPUS, ...p);
const ENV = process.env.GW_TE_ENV ?? resolve('..', 'TE-tools/mamba/envs/gw-te');
const LIB = join(ENV, 'Library');
const genv = { ...process.env, PATH: `${LIB}/bin;${process.env.PATH}`, GDAL_DATA: `${LIB}/share/gdal`, PROJ_DATA: `${LIB}/share/proj`, GDAL_PAM_ENABLED: 'NO' };
const gdal = (tool, args) => execFileSync(join(LIB, 'bin', `${tool}.exe`), args, { env: genv, maxBuffer: 1 << 30 }).toString();
const py = (args) => execFileSync(join(ENV, 'python.exe'), ['-I', ...args], { env: genv, maxBuffer: 1 << 30 }).toString();
const HAVE_GDAL = existsSync(join(ENV, 'python.exe'));
const TMP = process.env.GW_TMP ?? (existsSync('E:/') ? 'E:/gwb24/data-imaging/tmp' : resolve('test-results'));
const tmp = (name) => {
  const d = join(TMP, `e2e24-${name}-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
};
const ready = (frame, n = 1) => frame.waitForFunction((k) => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex || l.error).length >= k, n, { timeout: 300000 });
const b64 = (u8) => Buffer.from(u8).toString('base64');

// ---- three.js as an oracle: a page on a routed origin with an import map onto node_modules/three ----
async function threeOracle(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const three = resolve('node_modules', 'three');
  await page.route('http://oracle.test/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>oracle</title><script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>' });
    const p = join(three, decodeURIComponent(u.pathname.replace(/^\/three\//, '')));
    if (!existsSync(p)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', body: readFileSync(p) });
  });
  await page.goto('http://oracle.test/');
  return { page, close: () => ctx.close() };
}
/** Triangles and the bounding box (z-up metres after the loader's own up-axis rotation) of a three.js load. */
const OBSERVE = `(o) => { o.updateMatrixWorld(true); let tris = 0; const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; const v = new T.Vector3(); o.traverse((m) => { if (!m.isMesh) return; const g = m.geometry; const p = g.attributes.position; tris += (g.index ? g.index.count : p.count) / 3; for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], v.getComponent(k)); b.max[k] = Math.max(b.max[k], v.getComponent(k)); } } }); return { tris, b }; }`;

async function vegasBuildings(page) {
  await page.addInitScript(() => delete window.showSaveFilePicker); // saves become downloads
  const { frame, logs } = await openApp(page, 'file', { prefs: { welcomeDone: true, network: 'online' } });
  await openFiles(frame, [join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_PS-RGB_img10.tif')]);
  await ready(frame);
  const bl = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    const bl = app.attribution.newSchemaLayer('AL013');
    for (const [x, y, hgt] of [[200, 200, 12], [420, 260, 25]]) {
      const ring = [[x, y], [x + 60, y], [x + 60, y + 30], [x + 30, y + 30], [x + 30, y + 60], [x, y + 60]].map(([a, b]) => l.groundAt(a, b));
      const fid = app.commitFeature(p, 'Polygon', ring.map((g) => ({ lon: g.lon, lat: g.lat, h: 0, zsrc: 'test' })));
      app.attribution.setAttr(fid, 'HGT', hgt);
    }
    return bl;
  });
  return { frame, logs, bl };
}

test('REQ-GAP-34 buildings as COLLADA, STL, PLY and KMZ: three.js reads each as written; the app reads its COLLADA and KMZ back', async ({ page, browser }) => {
  const { frame, logs, bl } = await vegasBuildings(page);
  const out = await frame.evaluate(async (bl) => {
    const app = window.gisworkbench;
    const enc = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const r = {};
    for (const f of ['dae', 'stl', 'ply', 'kmz', 'glb']) {
      const x = app.extractR2.export3d(bl, f);
      r[f] = { name: x.name, b64: enc(x.bytes) };
    }
    r.origin = app.extractR2.export3d(bl, 'glb').m.origin;
    // Back into the app's 3D view.
    const back = [];
    for (const f of ['dae', 'kmz']) {
      const x = app.extractR2.export3d(bl, f);
      const file = new File([x.bytes], x.name);
      await app.openFiles([file]);
      back.push(app.importLog.at(-1));
    }
    const v = app.scene3d.view?.() ?? (await app.scene3d.ensureView());
    r.back = back;
    r.models = v.models.map((m) => ({ name: m.name, meshes: m.meshes, placedBy: m.placedBy }));
    return r;
  }, bl);
  expect(out.back.map((b) => b.errors)).toEqual([[], []]);
  expect(out.models.filter((m) => /\.(dae|kmz)$/.test(m.name)).map((m) => [m.meshes, m.placedBy])).toEqual([[2, 'origin'], [2, 'origin']]);
  // The L blocks: 2 × (ground 4 + roof 4 triangles + 6 walls × 2) = 40 triangles.
  const o = await threeOracle(browser);
  try {
    const got = await o.page.evaluate(async ([files, OBSERVE]) => {
      const T = await import('three');
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      const { KMZLoader } = await import('three/addons/loaders/KMZLoader.js');
      const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
      const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
      globalThis.T = T;
      const obs = eval(OBSERVE);
      const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const dae = new ColladaLoader().parse(new TextDecoder().decode(bytes(files.dae.b64)), '');
      const kmz = new KMZLoader().parse(bytes(files.kmz.b64).buffer);
      const stl = new STLLoader().parse(bytes(files.stl.b64).buffer);
      const ply = new PLYLoader().parse(bytes(files.ply.b64).buffer);
      const g = (geo) => obs(new T.Mesh(geo));
      return { dae: obs(dae.scene), kmz: obs(kmz.scene), stl: g(stl), ply: g(ply), up: dae.scene.rotation.x };
    }, [out, OBSERVE]);
    for (const k of ['dae', 'kmz', 'stl', 'ply']) expect(got[k].tris, k).toBe(40);
    // ColladaLoader turns Z_UP to three's Y_UP (rotation.x −π/2): heights are y; 25 m tall at most.
    expect(got.up).toBeCloseTo(-Math.PI / 2, 6);
    expect(got.dae.b.max[1] - got.dae.b.min[1]).toBeCloseTo(25, 3);
    expect(got.stl.b.max[2] - got.stl.b.min[2]).toBeCloseTo(25, 3);
    for (const k of ['kmz', 'stl', 'ply']) expect(Math.abs(got[k].b.max[0] - got[k].b.min[0] - (got.dae.b.max[0] - got.dae.b.min[0]))).toBeLessThan(1e-3);
  } finally {
    await o.close();
  }
  // The KML Model sits at the origin; its altitude is above mean sea level (HAE − EGM96 undulation, ≈ −27 m at Las Vegas).
  const z = unzipSync(Buffer.from(out.kmz.b64, 'base64'));
  const kml = strFromU8(z['doc.kml']);
  const alt = Number(/<altitude>([-\d.]+)<\/altitude>/.exec(kml)[1]);
  expect(Number(/<longitude>([-\d.]+)</.exec(kml)[1])).toBeCloseTo(out.origin.lon, 6);
  expect(alt - out.origin.h).toBeGreaterThan(20);
  expect(alt - out.origin.h).toBeLessThan(35);
  expect(logs).toEqual([]);
});

test('REQ-GAP-34 terrain as COLLADA (with its texture) and KMZ; a SketchUp COLLADA from a KMZ opens in 3D at the ColladaLoader size', async ({ page, browser }) => {
  const { frame, logs } = await vegasBuildings(page);
  const dls = [];
  page.on('download', async (d) => dls.push({ name: d.suggestedFilename(), bytes: readFileSync(await d.path()) }));
  for (const c of ['hub.dae', 'hub.kmz3d', 'hub.stl', 'hub.ply']) await frame.evaluate((c) => window.gisworkbench.commands.run(c), c);
  await expect.poll(() => dls.length, { timeout: 60000 }).toBe(6); // dae + png, kmz, stl, ply + png
  const by = (re) => dls.find((d) => re.test(d.name));
  const macky = C('vector-kml-kmz-test-set', 'libkml', 'model-macky.kmz');
  const o = await threeOracle(browser);
  try {
    const got = await o.page.evaluate(async ([dae, png, kmz, mk, OBSERVE]) => {
      const T = await import('three');
      const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
      const { KMZLoader } = await import('three/addons/loaders/KMZLoader.js');
      globalThis.T = T;
      const obs = eval(OBSERVE);
      const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const d = new ColladaLoader().parse(new TextDecoder().decode(bytes(dae)), '');
      let tex = null;
      d.scene.traverse((m) => m.isMesh && (tex = tex || !!m.material.map));
      const k = new KMZLoader().parse(bytes(kmz).buffer);
      const m = mk ? new KMZLoader().parse(bytes(mk).buffer) : null;
      return { dae: obs(d.scene), tex: !!tex, kmz: obs(k.scene), macky: m ? obs(m.scene) : null };
    }, [b64(by(/\.dae$/).bytes), b64(by(/terrain\.png$/).bytes), b64(by(/\.kmz$/).bytes), existsSync(macky) ? b64(readFileSync(macky)) : null, OBSERVE]);
    // A 96 × 96 grid: 2 × 95² triangles, textured.
    expect(got.dae.tris).toBe(2 * 95 * 95);
    expect(got.kmz.tris).toBe(2 * 95 * 95);
    expect(got.tex).toBe(true);
    if (got.macky) {
      // The app's reader on the same SketchUp model (inches, Z_UP, nested nodes): the same triangle count and size.
      const app = await frame.evaluate(async (s) => {
        const f = new File([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))], 'model-macky.kmz');
        await window.gisworkbench.openFiles([f]);
        const v = await window.gisworkbench.scene3d.ensureView();
        const m = v.models.at(-1);
        const T = v.T;
        let tris = 0;
        m.object.traverse((x) => x.isMesh && (tris += (x.geometry.index ? x.geometry.index.count : x.geometry.attributes.position.count) / 3));
        const b = new T.Box3().setFromObject(m.object);
        return { log: window.gisworkbench.importLog.at(-1), tris, size: [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z], placedBy: m.placedBy };
      }, b64(readFileSync(macky)));
      expect(app.log.errors).toEqual([]);
      expect(app.placedBy).toBe('origin'); // the KML Location
      expect(app.tris).toBe(got.macky.tris);
      // three: Y up; the app: Z up. Same extents to 1 mm.
      const t = got.macky.b;
      const ts = [t.max[0] - t.min[0], t.max[2] - t.min[2], t.max[1] - t.min[1]];
      app.size.forEach((s, i) => expect(Math.abs(s - ts[i]), `axis ${i}`).toBeLessThan(1e-3));
    }
  } finally {
    await o.close();
  }
  // STL: binary, 2 × 95² facets; PLY: binary with texture coordinates.
  const stl = by(/\.stl$/).bytes;
  expect(stl.readUInt32LE(80)).toBe(2 * 95 * 95);
  expect(stl.length).toBe(84 + 50 * 2 * 95 * 95);
  const ply = by(/\.ply$/).bytes.toString('latin1', 0, 400);
  expect(ply).toMatch(/format binary_little_endian 1\.0[\s\S]*element vertex 9216[\s\S]*property float texture_u[\s\S]*element face 18050/);
  expect(logs).toEqual([]);
});

const VEGAS = C('eo-spacenet-vegas-wv3-pan-ms-r1c1');
const PAN = join(VEGAS, '15OCT22183656-P2AS_R1C1-055649178030_01_P001.TIF');
const MS = join(VEGAS, '15OCT22183656-M2AS_R1C1-055649178030_01_P001.TIF');
const WIN = { x0: 6144, y0: 6144, w: 2048, h: 2048 };

test('REQ-GAP-14 a pan-sharpened COG of the WorldView-3 Vegas pair: Brovey equals gdal_pansharpen; Gram–Schmidt with Wald figures; a valid COG', async ({ page }) => {
  test.skip(!existsSync(PAN) || !HAVE_GDAL, 'the Vegas pair or the gw-te GDAL is absent');
  await page.addInitScript(() => delete window.showSaveFilePicker);
  const { frame, logs } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  // With their DigitalGlobe XML (SATID WV03 names the sensor).
  await openFiles(frame, [MS, PAN, MS.replace(/\.TIF$/, '.XML'), PAN.replace(/\.TIF$/, '.XML')]);
  await ready(frame, 2);
  const dir = tmp('ps');
  const runs = {};
  // Brovey with the weights GDAL is given (the WorldView-3 band-pass table to 4 decimals), GDAL's integer work buffer.
  const W3 = [0, 0.2, 0.2333, 0.1333, 0.2, 0.1333, 0.1, 0];
  for (const [method, extra] of [['brovey', { kernel: 'cubic', roundMs: true, weights: W3 }], ['gs', {}]]) {
    const dl = page.waitForEvent('download', { timeout: 600000 });
    const rep = await frame.evaluate(async ([method, extra, win]) => {
      const app = window.gisworkbench;
      const ls = [...app.layers.values()];
      const ms = ls.find((l) => l.bands === 8);
      const pan = ls.find((l) => l.bands === 1);
      const t0 = performance.now();
      const r = await app.pansharpen.product({ ms: ms.id, pan: pan.id, method, window: win, open: method === 'gs', ...extra });
      const { blob, cleanup, params, ...rest } = r;
      return { ...rest, seconds: (performance.now() - t0) / 1000, layers: app.layers.size };
    }, [method, extra, WIN]);
    const d = await dl;
    const path = join(dir, `${method}.tif`);
    await d.saveAs(path);
    runs[method] = { rep, path };
  }
  const br = runs.brovey.rep;
  expect(br).toMatchObject({ sensor: 'WorldView-3', ratio: 4, type: 'u16', bits: 11, bands: 8, weightsFrom: 'given', registration: 'geotransform' });
  expect(runs.gs.rep).toMatchObject({ sensor: 'WorldView-3', weightsFrom: 'sensor' });
  // GDAL's weighted Brovey of the same window (the same weights, cubic, 11 bits).
  const pw = join(dir, 'pan.tif');
  const mw = join(dir, 'ms.tif');
  gdal('gdal_translate', ['-q', '-srcwin', String(WIN.x0), String(WIN.y0), String(WIN.w), String(WIN.h), PAN, pw]);
  gdal('gdal_translate', ['-q', '-srcwin', String(WIN.x0 / 4), String(WIN.y0 / 4), String(WIN.w / 4), String(WIN.h / 4), MS, mw]);
  const ref = join(dir, 'gdal.tif');
  py([join(ENV, 'Scripts', 'gdal_pansharpen.py'), pw, mw, ref, ...W3.flatMap((w) => ['-w', String(w)]), '-r', 'cubic', '-bitdepth', '11']);
  const cmp = JSON.parse(py(['-c', `import json,sys,numpy as np
from osgeo import gdal
a=gdal.Open(sys.argv[1]).ReadAsArray().astype(int); b=gdal.Open(sys.argv[2]).ReadAsArray().astype(int)
d=np.abs(a-b); i=d[:,8:-8,8:-8]
print(json.dumps({'shape':list(a.shape),'identical':float((i==0).mean()),'within1':float((i<=1).mean()),'max':int(i.max()),'allIdentical':float((d==0).mean())}))`, runs.brovey.path, ref]));
  // (GDAL sees only the window: its kernels renormalise at the window edges, so 8 px of border are left out.)
  expect(cmp.shape).toEqual([8, 2048, 2048]);
  expect(cmp.identical).toBeGreaterThan(0.999);
  expect(cmp.within1).toBeGreaterThan(0.9999);
  expect(cmp.max).toBeLessThanOrEqual(10); // a handful of dark pixels whose pseudo-pan is near zero
  // The products: COGs at the pan grid, UInt16, 8 bands; GDAL's COG validator passes.
  for (const m of ['brovey', 'gs']) {
    const info = JSON.parse(gdal('gdalinfo', ['-json', runs[m].path]));
    expect(info.size).toEqual([2048, 2048]);
    expect(info.bands.map((b) => b.type)).toEqual(Array(8).fill('UInt16'));
    const pinfo = JSON.parse(gdal('gdalinfo', ['-json', pw]));
    info.geoTransform.forEach((v, i) => expect(v).toBeCloseTo(pinfo.geoTransform[i], 9));
    const v = py([join(ENV, 'Lib', 'site-packages', 'osgeo_utils', 'samples', 'validate_cloud_optimized_geotiff.py'), runs[m].path]);
    expect(v).toMatch(/is a valid cloud optimized GeoTIFF/);
  }
  const gs = runs.gs.rep;
  // Wald: the product degraded back against the MS, and the fusion at the reduced scale against the MS.
  for (const q of [gs.consistency, gs.synthesis]) {
    expect(q.ergas).toBeGreaterThan(0);
    expect(q.ergas).toBeLessThan(6);
    expect(q.sam).toBeLessThan(6);
    expect(q.q).toBeGreaterThan(0.7);
    expect(q.q4).toBeGreaterThan(0.7);
  }
  expect(gs.consistency.ergas).toBeLessThan(br.consistency.ergas); // GS keeps the spectra better than Brovey here
  expect(gs.layers).toBe(3); // the product opened as a layer
  writeFileSync(join(dir, 'reports.json'), JSON.stringify({ brovey: br, gs, gdal: cmp }, null, 1));
  console.log(JSON.stringify({ brovey: { consistency: br.consistency, synthesis: br.synthesis, seconds: br.seconds }, gs: { consistency: gs.consistency, synthesis: gs.synthesis, seconds: gs.seconds, fit: gs.simulatedPanCorrelation }, gdal: cmp }));
  // The display-only fusion still works on the pair.
  const disp = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const ls = [...app.layers.values()];
    const ms = ls.find((l) => l.bands === 8 && /M2AS/.test(l.rec.name));
    const pan = ls.find((l) => l.bands === 1);
    app.setPanSharpen(p, { ms: ms.id, pan: pan.id, method: 'gs' });
    return p.rec.pansharpen;
  });
  expect(disp).toMatchObject({ on: true, method: 'gs' });
  expect(logs).toEqual([]);
});

test('REQ-GAP-14 the Pan-Sharpened Product dialog passes axe and refuses a pan that is not finer by a whole ratio', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  await openFiles(frame, [join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_MS_img10.tif'), join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_PS-RGB_img10.tif')]);
  await ready(frame, 2);
  const axe = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  await frame.evaluate(axe);
  void frame.evaluate(() => window.gisworkbench.commands.run('enh.pansharpenproduct'));
  const dlg = frame.locator('[data-id="dialog:pansharpen-product"]');
  await expect(dlg).toBeVisible();
  const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[data-id="dialog:pansharpen-product"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => x.id));
  expect(v).toEqual([]);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  // The SpaceNet chips: an 8-band 163 px MS and a 650 px pan-sharpened RGB (ratio 3.99, three bands as "pan").
  const err = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()];
    try {
      await app.pansharpen.product({ ms: ls[0].id, pan: ls[0].id, save: false, open: false });
    } catch (e) {
      return e.code;
    }
    return null;
  });
  expect(err).toBe('E_STEP_FIRST');
});
