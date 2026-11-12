// 2.5 group models3d (gap wave T0b): REQ-GAP-35 I3S read (SLPK and service) in the 3D view with
// its node tree and LOD, SLPK and OpenFlight writing; REQ-GAP-68 the 3D PDF (PRC).
// Oracles at test time (never shipped): Esri's i3s_converter (-v) on the packages the app writes,
// the independent Python readers (tests/tools/slpk_ref.py, openflight_ref.py, prc_ref.py) and
// OpenSceneGraph's OpenFlight plug-in (osgconv) when installed on E:. Esri's sample SLPKs are read
// from E:\gwb25\data-models3d (Esri Master License Agreement: never committed); without them the
// tests use the app's own package (fixtures/fx25/models3d/b1.slpk).
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { zipSync, gzipSync, strToU8 } from 'fflate';
import { openApp, openFiles, SAMPLES } from './helpers.js';
import { mockServices } from './svc-mock.js';

test.describe.configure({ timeout: 600000 });

const DATA = 'E:/gwb25/data-models3d';
const S = (f) => `${DATA}/slpk/${f}`;
const CONVERTER = `${DATA}/i3s_converter/i3s_converter.exe`;
const PYENV = resolve('..', '..', 'GIS Workbench', 'TE-tools', 'mamba', 'envs', 'gw-te');
const PY = existsSync('C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe') ? 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te' : PYENV;
const pyEnv = { ...process.env, PATH: `${PY};${PY}/Library/bin;${process.env.PATH}` };
const py = (script, args) => JSON.parse(execFileSync(`${PY}/python.exe`, ['-I', resolve('tests/tools', script), ...args], { env: pyEnv, maxBuffer: 1 << 30, encoding: 'utf8' }));
const havePy = existsSync(`${PY}/python.exe`);
const OSG = 'E:/gwb25/envs/osg/Library/bin';
const WD = `${DATA}/work/prc-wd.txt`;
// One folder per worker: Chrome and Edge run the same test at once, and it writes fixed names
// (vegas_buildings.slpk, its converter log) that the other browser's run would delete.
const TMP = join(existsSync('E:/') ? `${DATA}/work/e2e` : resolve('test-results', 'e2e25'), `w${process.env.TEST_WORKER_INDEX ?? 0}`);
mkdirSync(TMP, { recursive: true });
const VEGAS = join(SAMPLES, 'msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_PS-RGB_img10.tif');
const FX = resolve('fixtures/fx25/models3d');

async function app(page) {
  await page.addInitScript(() => delete window.showSaveFilePicker); // saves become downloads
  return openApp(page, 'file', { prefs: { welcomeDone: true, network: 'online' } });
}
const quiet = (logs) => logs.filter((l) => !/ERR_CONNECTION_REFUSED|WebGL|GPU stall|GL Driver/.test(l));

/** The I3S layers of the 3D view after `settle`: stats and depth reached. */
const settle = (frame, ms = 120000) =>
  frame.evaluate(async (ms) => {
    const v = window.gisworkbench.activePane().view3d;
    const ls = v.tilesets.filter((l) => l.info?.layerType);
    const out = [];
    for (const l of ls) {
      await l.settle(ms);
      const vis = [...l.recs.values()].filter((r) => r.object?.visible);
      out.push({ name: l.name, type: l.info.layerType, stats: { ...l.stats }, depth: Math.max(0, ...vis.map((r) => r.depth)), warnings: [...l.warnings], errors: l.errors });
    }
    return out;
  }, ms);

/** Bytes from the page (base64 in chunks). */
async function pageBytes(frame, expr) {
  const n = await frame.evaluate(`(async () => { window.__bytes = await (${expr}); return window.__bytes.length; })()`);
  const parts = [];
  for (let o = 0; o < n; o += 8 << 20) parts.push(Buffer.from(await frame.evaluate(([o, e]) => { const u = window.__bytes.subarray(o, e); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }, [o, Math.min(n, o + (8 << 20))]), 'base64'));
  return Buffer.concat(parts);
}

test('REQ-GAP-35 an SLPK written by the app opens in the 3D view: node tree, geometry, attributes, identify', async ({ page }) => {
  const { frame, logs } = await app(page);
  const log = await openFiles(frame, [join(FX, 'b1.slpk')]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  const [l] = await settle(frame);
  expect(l.type).toBe('3DObject');
  expect(l.stats.loaded).toBe(1);
  expect(l.stats.vertices).toBe(l.stats.triangles * 3);
  expect(l.errors).toEqual([]);
  // Identify at the screen position of the building's centre.
  const f = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const v = app.activePane().view3d;
    const l = v.tilesets.find((x) => x.info);
    const obj = l.objects()[0];
    obj.geometry.computeBoundingSphere();
    const c = obj.geometry.boundingSphere.center.clone();
    v.lookAtLocal(c.x, c.y, c.z, 60);
    v.render();
    const p = v.project([c.x, c.y, c.z], v.world);
    return app.models3d.identifyAt(v, p.sx, p.sy);
  });
  expect(f.attributes.OBJECTID).toBe(1);
  expect(f.attributes.NAME).toBe('Building 0 — Здание');
  expect(quiet(logs)).toEqual([]);
});

test('REQ-GAP-35 Esri sample IntegratedMesh (textured, LOD refines as the camera comes closer); PCSL refused by name', async ({ page }) => {
  test.skip(!existsSync(S('Rancho_Mesh_v18.slpk')), 'the Esri sample SLPKs are not on E:');
  const { frame, logs } = await app(page);
  const t0 = Date.now();
  const log = await openFiles(frame, [S('Rancho_Mesh_v18.slpk')]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  const first = await frame.evaluate(async () => {
    const v = window.gisworkbench.activePane().view3d;
    const l = v.tilesets.find((x) => x.info);
    const t = performance.now();
    while (!l.objects().length && performance.now() - t < 60000) {
      l.update();
      await new Promise((r) => setTimeout(r, 20));
    }
    return { ms: performance.now() - t };
  });
  const far = await settle(frame);
  const tOpen = Date.now() - t0;
  // Closer: the camera at a tenth of the distance.
  await frame.evaluate(() => {
    const v = window.gisworkbench.activePane().view3d;
    const c = v.controls.target;
    v.camera.position.lerp(c, 0.9);
    v.controls.update();
  });
  const near = await settle(frame);
  expect(far[0].type).toBe('IntegratedMesh');
  expect(far[0].stats.textured).toBeGreaterThan(0);
  expect(near[0].depth).toBeGreaterThan(far[0].depth);
  expect(near[0].stats.loaded).toBeGreaterThan(far[0].stats.loaded);
  console.log('Rancho IM', JSON.stringify({ firstNodeMs: Math.round(first.ms), openToSettledMs: tOpen, far: far[0], near: near[0] }));
  // A point cloud scene layer package is refused by name.
  const pcsl = join(TMP, 'pcsl.slpk');
  writeFileSync(pcsl, zipSync({ '3dSceneLayer.json.gz': [gzipSync(strToU8(JSON.stringify({ layerType: 'PointCloud', id: 0 }))), { level: 0 }] }));
  const bad = await openFiles(frame, [pcsl]);
  expect(bad[0].errors.join(' ')).toMatch(/point cloud scene layers \(PCSL/);
  expect(quiet(logs)).toEqual([]);
});

test('REQ-GAP-35 Esri samples in New York: the 3DObject layer (5,883 nodes, 1 GB; only what is in view is read) and the Point layer (Draco points with feature ids)', async ({ page }) => {
  test.skip(!existsSync(S('Buildings_NewYork_v18.slpk')), 'the Esri New York SLPK is not on E:');
  const { frame, logs } = await app(page);
  // New York 3DObject (5,883 nodes, 1 GB): only the node pages and nodes in view are read.
  if (existsSync(S('Buildings_NewYork_v18.slpk'))) {
    const t1 = Date.now();
    const r = await openFiles(frame, [S('Buildings_NewYork_v18.slpk')]);
    expect(r.flatMap((x) => x.errors)).toEqual([]);
    const all = await settle(frame);
    const ny = all.find((x) => x.type === '3DObject');
    expect(ny.stats.loaded).toBeGreaterThan(0);
    expect(ny.stats.pages).toBeLessThan(93);
    console.log('NY 3DObject', JSON.stringify({ ms: Date.now() - t1, stats: ny.stats }));
  }
  // Point layer: Draco-compressed points with feature ids (the Draco worker).
  if (existsSync(S('2015_Street_Tree_Survey_v18.slpk'))) {
    const r = await openFiles(frame, [S('2015_Street_Tree_Survey_v18.slpk')]);
    expect(r.flatMap((x) => x.errors)).toEqual([]);
    const all = await settle(frame);
    const pts = all.find((x) => x.type === 'Point');
    expect(pts.stats.points).toBeGreaterThan(1000);
    expect(pts.errors).toEqual([]);
    console.log('NYC trees Point', JSON.stringify(pts.stats));
  }
  expect(quiet(logs)).toEqual([]);
});

test('REQ-GAP-35 Esri sample Building scene layer: its visible 3D object sublayers stream together', async ({ page }) => {
  test.skip(!existsSync(S('Admin_Building_v18.slpk')), 'the Esri Building SLPK is not on E:');
  const { frame, logs } = await app(page);
  const r = await openFiles(frame, [S('Admin_Building_v18.slpk')]);
  expect(r.flatMap((x) => x.errors)).toEqual([]);
  const all = await settle(frame);
  expect(all.filter((x) => x.type === '3DObject').length).toBeGreaterThan(5);
  expect(all.reduce((s, x) => s + x.stats.loaded, 0)).toBeGreaterThan(0);
  expect(all.flatMap((x) => x.errors)).toEqual([]);
  console.log('Admin BSL', JSON.stringify(all.map((x) => [x.name, x.stats.loaded, x.stats.triangles])));
  expect(quiet(logs)).toEqual([]);
});


test('REQ-GAP-35 an I3S scene service (mock SceneServer, allow-listed) streams into the 3D view', async ({ page }) => {
  const mock = mockServices();
  const origin = await mock.start();
  try {
    const { frame } = await openApp(page, 'file');
    const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins([o]), origin);
    const copy = join(TMP, `gw-i3s-${Date.now()}.html`);
    writeFileSync(copy, html);
    const page2 = await page.context().newPage();
    const r = await openApp(page2, 'file', { htmlPath: copy, prefs: { welcomeDone: true, network: 'online' } });
    const out = await r.frame.evaluate(async (o) => {
      const app = window.gisworkbench;
      const res = await app.models3d.openService(`${o}/arcgis/rest/services/Bldg/SceneServer`);
      const l = res.layers[0];
      // The mock's root box sits 350 m below its leaves: aim at the leaves (z 400–425 m).
      app.activePane().view3d.lookAtLocal(0, 0, 410, 150);
      await l.settle(30000);
      return { type: res.info.layerType, loaded: l.stats.loaded, vertices: l.stats.vertices, errors: l.errors };
    }, origin);
    expect(out).toMatchObject({ type: '3DObject', errors: [] });
    expect(out.loaded).toBeGreaterThan(0);
  } finally {
    await mock.close();
  }
});

test('REQ-GAP-35 buildings and terrain as SLPK (i3s_converter validates; the app reads them back) and OpenFlight (independent parser, OpenSceneGraph)', async ({ page }) => {
  test.skip(!existsSync(VEGAS), 'the Vegas sample image is not present');
  const { frame, logs } = await app(page);
  await openFiles(frame, [VEGAS]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.stats && l.lutTex), null, { timeout: 120000 });
  const bl = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    const bl = app.attribution.newSchemaLayer('AL013');
    for (const [x, y, hgt] of [[200, 200, 12], [420, 260, 25], [100, 400, 8]]) {
      const ring = [[x, y], [x + 60, y], [x + 60, y + 30], [x, y + 30]].map(([a, b]) => l.groundAt(a, b));
      const fid = app.commitFeature(p, 'Polygon', ring.map((g) => ({ lon: g.lon, lat: g.lat, h: 0, zsrc: 'test' })));
      app.attribution.setAttr(fid, 'HGT', hgt);
    }
    return bl;
  });
  const slpk = await pageBytes(frame, `window.gisworkbench.extractR2.export3dAsync(${JSON.stringify(bl)}, 'slpk').then((r) => r.bytes)`);
  const flt = await pageBytes(frame, `window.gisworkbench.extractR2.export3dAsync(${JSON.stringify(bl)}, 'flt').then((r) => r.bytes)`);
  const ps = join(TMP, 'vegas_buildings.slpk');
  const pf = join(TMP, 'vegas_buildings.flt');
  writeFileSync(ps, slpk);
  writeFileSync(pf, flt);
  // Hub ▸ 3D Terrain (SLPK) and (OpenFlight): downloads.
  const dl = async (cmd, n) => {
    const got = [];
    const done = new Promise((res) =>
      page.on('download', async (d) => {
        got.push({ name: d.suggestedFilename(), bytes: readFileSync(await d.path()) });
        if (got.length === n) res();
      }),
    );
    await frame.evaluate((c) => window.gisworkbench.commands.run(c), cmd);
    await done;
    page.removeAllListeners('download');
    return got;
  };
  const [tslpk] = await dl('hub.slpk', 1);
  // The two downloads can arrive in either order (#141).
  const terrainFlt = await dl('hub.flt', 2);
  const tflt = terrainFlt.find((f) => f.name.endsWith('.flt'));
  const tjpg = terrainFlt.find((f) => f.name.endsWith('.jpg'));
  expect(tslpk.name).toMatch(/_terrain\.slpk$/);
  expect(tflt?.name).toMatch(/_terrain\.flt$/);
  expect(tjpg?.name).toMatch(/_terrain\.jpg$/);
  const pts = join(TMP, tslpk.name);
  writeFileSync(pts, tslpk.bytes);
  writeFileSync(join(TMP, tflt.name), tflt.bytes);
  // Back into the app.
  const back = await openFiles(frame, [ps, pts]);
  expect(back.flatMap((r) => r.errors)).toEqual([]);
  const ls = await settle(frame);
  expect(ls.length).toBe(2);
  expect(ls.every((l) => l.stats.loaded > 0 && !l.errors.length)).toBe(true);
  expect(ls.find((l) => /terrain/i.test(l.name)).stats.textured).toBe(1);
  // Esri's validator.
  if (existsSync(CONVERTER) && process.platform === 'win32') {
    for (const f of [ps, pts]) {
      const stem = f.replace(/\.slpk$/, '');
      rmSync(`${stem}_v19.log.json`, { force: true });
      execFileSync(CONVERTER, ['-v', f, '-d', TMP], { cwd: TMP, encoding: 'utf8', maxBuffer: 1 << 26 });
      const lg = JSON.parse(readFileSync(`${stem}_v19.log.json`, 'utf8'));
      expect(lg.success, f).toBe(true);
      expect(lg.log.filter((m) => !/^Information/.test(m.message)).map((m) => m.message), f).toEqual([]);
    }
  }
  if (havePy) {
    const r = py('openflight_ref.py', [pf]);
    expect(r.errors).toEqual([]);
    expect(r.objects.length).toBe(3);
    const t = py('openflight_ref.py', [join(TMP, tflt.name)]);
    expect(t.errors).toEqual([]);
    expect(t.textures).toEqual([{ file: tjpg.name, index: 0 }]);
    expect(t.texturedFaces).toBe(t.faces);
    if (existsSync(`${OSG}/osgconv.exe`)) {
      const obj = join(TMP, 'vegas_buildings_osg.obj');
      execFileSync(`${OSG}/osgconv.exe`, [pf, obj], { env: { ...process.env, PATH: `${OSG};${process.env.PATH}` } });
      const faces = readFileSync(obj, 'utf8').split('\n').filter((x) => x.startsWith('f ')).length;
      expect(faces).toBeGreaterThanOrEqual(r.triangles / 3);
    }
  }
  expect(quiet(logs)).toEqual([]);
});

// The textured terrain case is in tests/unit/pdf3d.test.js; this one exports a scene layer building.
test('REQ-GAP-68 the 3D view as a 3D PDF: PRC with a scene layer building, a default view, the poster; dialogs pass axe', async ({ page }) => {
  const { frame, logs } = await app(page);
  await openFiles(frame, [join(FX, 'b1.slpk')]);
  await settle(frame);
  const pdf = await pageBytes(frame, `window.gisworkbench.models3d.export3dPdf({ save: false }).then((r) => r.bytes)`);
  const p = join(TMP, 'view3d.pdf');
  writeFileSync(p, pdf);
  expect(pdf.subarray(0, 8).toString()).toBe('%PDF-1.7');
  if (havePy && existsSync(WD)) {
    const o = py('prc_ref.py', [p, WD]);
    expect(o.prc.errors).toEqual([]);
    expect(o.pdf.stream).toEqual({ type: '/3D', subtype: '/PRC' });
    expect(o.pdf.extension.level).toBe(3);
    expect(o.prc.triangles).toBeGreaterThan(0);
    expect(o.pdf.view.orthonormal).toBeLessThan(1e-6);
    expect(Object.values(o.pdf.poster)[0]?.w).toBeGreaterThan(0);
  }
  // The command (toast) and the I3S dialogs, with axe.
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  await frame.evaluate(axeSource);
  const axe = (sel) => frame.evaluate(async (s) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), sel);
  frame.evaluate(() => window.gisworkbench.commands.run('3d.i3s'));
  await frame.waitForSelector('[data-id="dialog:3d-i3s"]');
  expect(await axe('[data-id="dialog:3d-i3s"]')).toEqual([]);
  await page.keyboard.press('Escape');
  const shown = frame.evaluate(async () => {
    const app = window.gisworkbench;
    const v = app.activePane().view3d;
    const l = v.tilesets.find((x) => x.info);
    const obj = l.objects()[0];
    obj.geometry.computeBoundingSphere();
    const c = obj.geometry.boundingSphere.center.clone();
    v.render();
    const p = v.project([c.x, c.y, c.z], v.world);
    // The command waits for a click: give it one at the building.
    await app.commands.run('3d.i3sidentify');
    const r = v.canvas.getBoundingClientRect();
    v.canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + p.sx, clientY: r.top + p.sy, bubbles: true }));
    return true;
  });
  await shown;
  await frame.waitForSelector('[data-id="dialog:3d-i3sfeature"]');
  expect(await frame.textContent('[data-id="dialog:3d-i3sfeature"]')).toContain('Building 0 — Здание');
  expect(await axe('[data-id="dialog:3d-i3sfeature"]')).toEqual([]);
  expect(quiet(logs)).toEqual([]);
});
