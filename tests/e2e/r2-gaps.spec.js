// R2 items closed in R3: gap validation between polygons (REQ-EXT-13), buildings textured from
// an image through its sensor model (REQ-EXT-15, FX-02 box B05a), a local .3tz archive and Sync
// Always between a 2D panel and the 3D view (REQ-STR-11/15), and quantized-mesh terrain from an
// allowed origin (REQ-ARC-16).
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { openApp, openFiles } from './helpers.js';
import { b3dmBox, qmTile } from './mock3d.js';

test.describe.configure({ timeout: 240000 });
const t02 = JSON.parse(readFileSync(resolve('fixtures/fx02/fx02_truth.json'), 'utf8'));
const B05 = t02.boxes.find((b) => b.id === 'B05a');

async function openFx02(page) {
  const o = await openApp(page, 'file');
  await openFiles(o.frame, [resolve('fixtures/fx02/fx02_a.ntf')]);
  await o.frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId), null, { timeout: 60000 });
  return o;
}

test('REQ-EXT-13 REQ-EXT-15 gaps between polygons are reported; B05a textured from FX-02 image a lands on the truth pixels', async ({ page }) => {
  const { frame, logs } = await openFx02(page);
  const r = await frame.evaluate(async (B05) => {
    const app = window.gisworkbench;
    const A = app.attribution;
    const p = app.activePane();
    const out = {};
    // Four rectangles around a 5 m × 10 m hole (50 m²), metres from (−116.45, 34.55).
    const m = 1 / 110940;
    const e = 1 / 91700;
    const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ lon: -116.45 + x * e, lat: 34.55 + y * m, h: 700, zsrc: 'constant' }));
    const gl = A.newSchemaLayer('AL013');
    for (const q of [[0, 0, 30, 10], [0, 20, 30, 30], [0, 10, 10, 20], [15, 10, 30, 20]]) app.commitFeature(p, 'Polygon', rect(...q));
    const v = await app.extractR2.validate(gl, { tol: 0.5 });
    out.gaps = v.issues.filter((i) => i.check === 'gap').map((i) => ({ value: i.value, x: (i.lon + 116.45) / e, y: (i.lat - 34.55) / m, ring: i.ring.length }));
    out.noGap = (await app.extractR2.validate(gl, { tol: 0.5, gapArea: 40 })).issues.filter((i) => i.check === 'gap').length;
    // B05a from the truth footprint at its base, 5 m high.
    const bl = A.newSchemaLayer('AL013');
    const id = app.commitFeature(p, 'Polygon', B05.footprint.map((c) => ({ lon: c.lon, lat: c.lat, h: B05.baseHae, zsrc: 'constant' })));
    A.setAttr(id, 'HGT', 5);
    const image = [...app.layers.values()].find((l) => l.modelId);
    const tm = await app.extractR2.texturedModels(bl, image);
    const w = tm.texture.window;
    const px = (vtx) => {
      const [u, vv] = tm.texture.uv(vtx[0], vtx[1], vtx[2]);
      return [w.x0 + u * w.w, w.y0 + vv * w.h];
    };
    const verts = tm.models[0].model.vertices;
    const base = verts.filter((x) => x[2] < 1).map(px);
    const roof = verts.filter((x) => x[2] > 4).map(px);
    out.base = B05.footprint.map((c) => Math.min(...base.map((q) => Math.hypot(q[0] - c.a[0], q[1] - c.a[1]))));
    const rc = [roof.reduce((s, q) => s + q[0], 0) / roof.length, roof.reduce((s, q) => s + q[1], 0) / roof.length];
    out.roof = Math.hypot(rc[0] - B05.roofCentre.a[0], rc[1] - B05.roofCentre.a[1]);
    out.uvIn = [...base, ...roof].every(([x, y]) => x >= w.x0 && x <= w.x0 + w.w && y >= w.y0 && y <= w.y0 + w.h);
    const glb = app.extractR2.writeGltf(tm.models, tm.origin, { glb: true, texture: tm.texture });
    const dv = new DataView(glb.buffer, glb.byteOffset);
    const jl = dv.getUint32(12, true);
    const gj = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jl)));
    const binAt = 20 + jl + 8;
    const iv = gj.bufferViews[gj.images[0].bufferView];
    const png = glb.subarray(binAt + iv.byteOffset, binAt + iv.byteOffset + 8);
    out.glb = { mime: gj.images[0].mimeType, textures: gj.textures.length, uv: !!gj.meshes[0].primitives[0].attributes.TEXCOORD_0, material: !!gj.materials[0].pbrMetallicRoughness.baseColorTexture, png: Array.from(png.subarray(1, 4)).map((c) => String.fromCharCode(c)).join(''), uvCount: gj.accessors[gj.meshes[0].primitives[0].attributes.TEXCOORD_0].count === gj.accessors[gj.meshes[0].primitives[0].attributes.POSITION].count };
    // The textured model loads into the 3D view.
    const v3 = await app.scene3d.ensureView();
    const g = await v3.addGltf(glb, 'B05a textured');
    let mapped = 0;
    (g.object ?? g).traverse?.((o) => {
      if (o.material?.map) mapped++;
    });
    out.mapped = mapped;
    return out;
  }, B05);
  expect(r.gaps).toHaveLength(1);
  expect(Math.abs(r.gaps[0].value - 50)).toBeLessThan(1);
  expect(Math.abs(r.gaps[0].x - 12.5)).toBeLessThan(0.5);
  expect(Math.abs(r.gaps[0].y - 15)).toBeLessThan(0.5);
  expect(r.noGap).toBe(0);
  for (const d of r.base) expect(d).toBeLessThan(1);
  expect(r.roof).toBeLessThan(1);
  expect(r.uvIn).toBe(true);
  expect(r.glb).toEqual({ mime: 'image/png', textures: 1, uv: true, material: true, png: 'PNG', uvCount: true });
  expect(r.mapped).toBeGreaterThan(0);
  expect(logs).toEqual([]);
});

test('REQ-STR-15 REQ-STR-11 a local .3tz opens with no network; Sync Always follows the 2D panel and back', async ({ page }) => {
  const { frame, logs } = await openFx02(page);
  const r0 = (d) => (d * Math.PI) / 180;
  const { lat, lon } = B05.roofCentre;
  const h = 0.001;
  const tileset = { asset: { version: '1.1' }, geometricError: 100, root: { boundingVolume: { region: [r0(lon - h), r0(lat - h), r0(lon + h), r0(lat + h), 690, 720] }, geometricError: 0, refine: 'REPLACE', content: { uri: 'tiles/box.b3dm' } } };
  const zip = zipSync({ 'tileset.json': new TextEncoder().encode(JSON.stringify(tileset)), 'tiles/box.b3dm': new Uint8Array(b3dmBox(lat, lon, 12, 5)) }, { level: 0 });
  const r = await frame.evaluate(async ({ b64, B05 }) => {
    const app = window.gisworkbench;
    const mp = app.desktop.multiports[0];
    mp.setLayout('1x2');
    const p2d = mp.panes[0];
    const p3d = mp.panes[1];
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const t = await app.scene3d.addTilesArchive(new File([bytes], 'b05.3tz'), { p: p3d });
    const v = p3d.view3d;
    v.lookAtLocal(0, 0, 700, 150);
    for (let i = 0; i < 80; i++) {
      v.invalidate();
      await new Promise((res) => requestAnimationFrame(res));
      if (!t.loading && t.stats.loaded > 0 && i > 5) break;
    }
    const out = { tiles: { ...t.stats }, net: app.netlog.entries.filter((x) => /3tz/.test(x.origin ?? x.url ?? '')).length };
    const pos = t.root.object.children[0].geometry.attributes.position;
    const [e0, n0] = v.toLocal(B05.roofCentre.lat, B05.roofCentre.lon);
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pos.count; i++) {
      cx += pos.getX(i) / pos.count;
      cy += pos.getY(i) / pos.count;
    }
    out.boxOff = Math.hypot(cx - e0, cy - n0);
    // Sync Always: the target follows the 2D centre at the target's height (no terrain), and back.
    app.setActivePane?.(p2d);
    v.controls.target.z = B05.roofCentre.hae;
    v.controls.update();
    app.scene3d.sync.set(true);
    p2d.setView({ cx: B05.roofCentre.a[0], cy: B05.roofCentre.a[1] });
    const tg = v.controls.target;
    out.to3d = { d: Math.hypot(tg.x - e0, tg.y - n0), z: tg.z, from: app.scene3d.sync.state.last?.from };
    const c0 = B05.footprint[0];
    const [e1, n1] = v.toLocal(c0.lat, c0.lon);
    tg.set(e1, n1, c0.hae);
    v.controls.update();
    v.controls.dispatchEvent({ type: 'change' });
    for (let i = 0; i < 5; i++) await new Promise((res) => requestAnimationFrame(res));
    out.to2d = { d: Math.hypot(p2d.view.cx - c0.a[0], p2d.view.cy - c0.a[1]), from: app.scene3d.sync.state.last?.from };
    app.scene3d.sync.set(false);
    p2d.setView({ cx: 100, cy: 100 });
    out.offStays = Math.hypot(v.controls.target.x - e1, v.controls.target.y - n1);
    return out;
  }, { b64: Buffer.from(zip).toString('base64'), B05 });
  expect(r.tiles.loaded).toBe(1);
  expect(r.net).toBe(0);
  expect(r.boxOff).toBeLessThan(0.3);
  expect(r.to3d.d).toBeLessThan(1);
  expect(Math.abs(r.to3d.z - B05.roofCentre.hae)).toBeLessThan(0.01);
  expect(r.to3d.from).toBe('2d');
  expect(r.to2d.d).toBeLessThan(1.5);
  expect(r.to2d.from).toBe('3d');
  expect(r.offStays).toBeLessThan(0.01);
  expect(logs).toEqual([]);
});

test('REQ-ARC-16 quantized-mesh terrain from an allowed origin: tiles over the box, heights at every vertex', async ({ page }) => {
  const hf = (la, lo) => 600 + 1000 * (la - 34.5) + 500 * (lo + 116.5);
  const z = 12;
  const s = 180 / 2 ** z;
  const box = [34.5, -116.51, 34.53, -116.47];
  const tiles = {};
  for (let x = Math.floor((box[1] + 180) / s); x <= Math.floor((box[3] + 180) / s); x++)
    for (let y = Math.floor((box[0] + 90) / s); y <= Math.floor((box[2] + 90) / s); y++) tiles[`/terrain/${z}/${x}/${y}.terrain`] = qmTile({ west: -180 + x * s, east: -180 + (x + 1) * s, south: -90 + y * s, north: -90 + (y + 1) * s }, 17, hf).bytes;
  const layer = { tilejson: '2.1.0', name: 'mock terrain', format: 'quantized-mesh-1.0', version: '1.0.0', scheme: 'tms', projection: 'EPSG:4326', tiles: ['{z}/{x}/{y}.terrain?v={version}'], minzoom: 0, maxzoom: 14 };
  const hits = [];
  const srv = createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits.push(path);
    const b = path === '/terrain/layer.json' ? Buffer.from(JSON.stringify(layer)) : tiles[path];
    res.writeHead(b ? 200 : 404, { 'access-control-allow-origin': '*', 'content-type': path.endsWith('.json') ? 'application/json' : 'application/vnd.quantized-mesh' });
    res.end(b ?? '');
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try {
    const { frame } = await openApp(page, 'file');
    const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins([o]), origin);
    const dir = join(tmpdir(), 'gw-qmesh');
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, 'gis-workbench-qmesh.html');
    writeFileSync(copy, html);
    const page2 = await page.context().newPage();
    const { frame: f2, logs } = await openApp(page2, 'file', { htmlPath: copy });
    const out = await f2.evaluate(async ({ o, box }) => {
      const app = window.gisworkbench;
      await app.scene3d.ensureView();
      const t = await app.scene3d.addQuantizedMesh(`${o}/terrain/layer.json`, { box, level: 12 });
      const v = app.activePane().view3d;
      let worst = 0;
      let n = 0;
      for (const mesh of t.object.children) {
        const p = mesh.geometry.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const g = v.toGeo(p.getX(i), p.getY(i), p.getZ(i));
          worst = Math.max(worst, Math.abs(g.hae - (600 + 1000 * (g.lat - 34.5) + 500 * (g.lon + 116.5))));
          n++;
        }
      }
      const net = app.netlog.entries.filter((x) => x.origin === o).map((x) => x.path);
      return { stats: t.stats, worst, n, net, query: net.some((x) => x.includes('?')) };
    }, { o: origin, box });
    const nt = Object.keys(tiles).length;
    expect(out.stats).toEqual({ tiles: nt, vertices: nt * 289, triangles: nt * 512, failed: 0 });
    expect(out.n).toBe(nt * 289);
    expect(out.worst).toBeLessThan(0.05);
    expect(out.net).toEqual(expect.arrayContaining(['/terrain/layer.json', ...Object.keys(tiles)]));
    expect(out.query).toBe(false);
    expect(hits.length).toBe(nt + 1);
    expect(logs).toEqual([]);
    await page2.close();
  } finally {
    srv.close();
  }
});
