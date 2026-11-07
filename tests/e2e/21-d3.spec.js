// SDP-2.1 group d3 (SCN-29): Draco and KTX2 glTF (REQ-FMT-34), 3D Tiles pnts / i3dm / cmpt /
// implicit tiling from local files and folders (REQ-FMT-36), local and Web Mercator quantized-mesh
// (REQ-FMT-38), and the writers (REQ-FMT-35, 37, 39). Corpus samples (TE-corpus) where present;
// FX-21 fixtures (build/fixtures/fxformats21.mjs --only=d3) otherwise. D3_DIST picks the build.
import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { openApp, openFiles, DIST_DIR } from './helpers.js';

const DIST = process.env.D3_DIST ? resolve(process.env.D3_DIST) : undefined;
const TE = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const FX = resolve('fixtures', 'fx21', 'd3');
const te = (...p) => join(TE, ...p);
const open = (page) => openApp(page, 'file', DIST ? { htmlPath: DIST } : {});
test.describe.configure({ timeout: 180_000 });

/** Upload a folder (webkitdirectory input: files keep their relative paths) and open it. */
async function openFolder(frame, dir) {
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.webkitdirectory = true;
    i.style.display = 'none';
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles(dir);
  return frame.evaluate(async (i) => {
    const files = [...i.files];
    i.remove();
    const app = window.gisworkbench;
    const before = app.importLog.length;
    await app.openFiles(files);
    return app.importLog.slice(before);
  }, input);
}

const tilesets = (frame) =>
  frame.evaluate(() => {
    const v = window.gisworkbench.activePane()?.view3d;
    return (v?.tilesets ?? []).map((t) => ({ name: t.name, local: !!t.local, stats: { ...t.stats }, contents: t.contents.map((c) => ({ ...c, min: c.min && [...c.min], max: c.max && [...c.max] })), errors: t.errors }));
  });
const models = (frame) =>
  frame.evaluate(() => {
    const v = window.gisworkbench.activePane()?.view3d;
    const out = [];
    for (const m of v?.models ?? []) {
      let tris = 0;
      let textured = 0;
      m.object.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some((x) => x?.map)) textured++;
      });
      out.push({ name: m.name, meshes: m.meshes, tris, textured, stats: m.stats ? { ...m.stats } : null });
    }
    return out;
  });
const files = (dir, re) => readdirSync(dir).filter((n) => re.test(n)).map((n) => join(dir, n));

test('REQ-FMT-34 Draco glTF decodes with the inline decoder (Khronos samples)', async ({ page }) => {
  const dir = te('3d-gltf-draco-khronos', 'Duck', 'glTF-Draco');
  test.skip(!existsSync(dir), 'corpus not on disk');
  const { frame, logs, requests } = await open(page);
  const log = await openFiles(frame, files(dir, /\.(gltf|bin|png)$/i));
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  const m = await models(frame);
  expect(m.length).toBe(1);
  expect(m[0].tris).toBeGreaterThan(1000); // Duck: 4212 triangles
  expect(m[0].textured).toBeGreaterThan(0);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

test('REQ-FMT-34 KTX2 / Basis Universal textures decode (KTX2 glTF and meshopt+KTX2 GLB)', async ({ page }) => {
  const glb = te('3d-gltf-threejs-meshopt-ktx2', 'coffeemat.glb');
  test.skip(!existsSync(glb), 'corpus not on disk');
  const { frame, logs, requests } = await open(page);
  const log = await openFiles(frame, [glb]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  const dir = te('3d-gltf-khronos-ktx2', 'ChronographWatch', 'glTF-KTX-BasisU');
  if (existsSync(dir)) {
    const log2 = await openFiles(frame, files(dir, /\.(gltf|bin|png|jpe?g|ktx2)$/i));
    expect(log2.flatMap((r) => r.errors)).toEqual([]);
  }
  const m = await models(frame);
  expect(m.every((x) => x.textured > 0)).toBe(true);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

test('REQ-FMT-36 single pnts, i3dm and cmpt tiles open as one-tile tilesets', async ({ page }) => {
  const base = te('3d-tiles-cesiumjs-specs-i3dm-pnts-cmpt');
  test.skip(!existsSync(base), 'corpus not on disk');
  const { frame, logs, requests } = await open(page);
  for (const f of ['PointCloud/PointCloudRGB/pointCloudRGB.pnts', 'PointCloud/PointCloudQuantizedOctEncoded/pointCloudQuantizedOctEncoded.pnts', 'PointCloud/PointCloudDraco/pointCloudDraco.pnts', 'PointCloud/PointCloudWGS84/pointCloudWGS84.pnts']) {
    const log = await openFiles(frame, [join(base, f)]);
    expect(log.flatMap((r) => r.errors), f).toEqual([]);
  }
  const log = await openFiles(frame, [join(base, 'Instanced/InstancedOrientation/instancedOrientation.i3dm')]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  const log2 = await openFiles(frame, [join(base, 'Composite/CompositeOfInstanced/compositeOfInstanced.cmpt'), join(base, 'Composite/CompositeOfInstanced/box.glb')]);
  expect(log2.flatMap((r) => r.errors)).toEqual([]);
  const ts = await tilesets(frame);
  const pts = ts.filter((t) => /\.pnts$/.test(t.name));
  expect(pts.length).toBe(4);
  for (const t of pts) expect(t.stats.points, t.name).toBe(1000);
  const inst = ts.find((t) => /instancedOrientation/.test(t.name));
  expect(inst.stats.instances).toBe(25);
  const cmpt = ts.find((t) => /compositeOfInstanced/.test(t.name));
  expect(cmpt.stats.instances).toBeGreaterThan(0);
  expect(ts.every((t) => !t.local)).toBe(true);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

test('REQ-FMT-36 an implicit quadtree tileset folder loads its subtrees and content', async ({ page }) => {
  const dir = te('3d-tiles-implicit-octree-metadata', 'ImplicitTileMetadata');
  test.skip(!existsSync(dir), 'corpus not on disk');
  const { frame, logs, requests } = await open(page);
  const log = await openFolder(frame, dir);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  const ts = await tilesets(frame);
  expect(ts.length).toBe(1);
  expect(ts[0].stats.subtrees).toBeGreaterThan(0);
  expect(ts[0].stats.loaded).toBeGreaterThan(0);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

test('REQ-FMT-38 quantized-mesh from a local folder: EPSG:4326 with extensions', async ({ page }) => {
  const dir = te('derived-qmesh-geodetic', 'normals');
  test.skip(!existsSync(dir), 'corpus not on disk');
  const { frame, logs, requests } = await open(page);
  const log = await openFolder(frame, dir);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  const m = (await models(frame)).filter((x) => x.stats?.projection);
  expect(m.length).toBe(1);
  expect(m[0].stats.projection).toBe('EPSG:4326');
  expect(m[0].stats.tiles).toBeGreaterThan(0);
  expect(m[0].stats.extensions).toContain('octvertexnormals');
  for (const d of ['QuantizedMeshWithWaterMask', 'QuantizedMeshWithMetadataAvailability', 'QuantizedMeshWith32BitIndices']) {
    const sub = te('3d-qmesh-cesiumjs-specs-4326', d);
    if (!existsSync(sub)) continue;
    const l2 = await openFolder(frame, sub);
    expect(l2.flatMap((r) => r.errors), d).toEqual([]);
  }
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

test('REQ-FMT-38 quantized-mesh in Web Mercator (EPSG:3857) tiling', async ({ page }) => {
  const dir = [te('derived-qmesh-mercator-here', 'here-z10-12'), join(FX, 'qmesh-3857')].find(existsSync);
  test.skip(!dir, 'no EPSG:3857 tile set on disk');
  const { frame, logs, requests } = await open(page);
  const log = await openFolder(frame, dir);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  const m = (await models(frame)).filter((x) => x.stats?.projection);
  expect(m[0].stats.projection).toBe('EPSG:3857');
  expect(m[0].stats.tiles).toBeGreaterThan(0);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
  void statSync;
});

// ---- FX-21 fixtures through the app (every encoding) ----
test('REQ-FMT-36 FX-21: every pnts / i3dm / cmpt encoding and both implicit tilesets open with the generator counts', async ({ page }) => {
  test.skip(!existsSync(join(FX, 'truth.json')), 'run node build/fixtures/fxformats21.mjs --only=d3');
  const truth = JSON.parse(readFileSync(join(FX, 'truth.json'), 'utf8'));
  const { frame, logs, requests } = await open(page);
  for (const f of Object.keys(truth.pnts)) expect((await openFiles(frame, [join(FX, 'pnts', f)])).flatMap((r) => r.errors), f).toEqual([]);
  for (const f of Object.keys(truth.i3dm)) expect((await openFiles(frame, [join(FX, 'i3dm', f), join(FX, 'i3dm', 'box.glb')])).flatMap((r) => r.errors), f).toEqual([]);
  for (const f of Object.keys(truth.cmpt)) expect((await openFiles(frame, [join(FX, 'cmpt', f)])).flatMap((r) => r.errors), f).toEqual([]);
  expect((await openFolder(frame, join(FX, 'implicit-octree'))).flatMap((r) => r.errors)).toEqual([]);
  expect((await openFolder(frame, join(FX, 'implicit-quadtree'))).flatMap((r) => r.errors)).toEqual([]);
  const ts = await tilesets(frame);
  for (const [f, t] of Object.entries(truth.pnts)) {
    const s = ts.find((x) => x.name === f);
    expect(s.stats.points, f).toBe(t.points);
    const c = s.contents[0];
    for (let k = 0; k < 3; k++) expect(Math.abs(c.min[k] - t.min[k]), `${f} min`).toBeLessThan(t.tol ?? 0.01);
    if (t.stats) for (const [k, v] of Object.entries(t.stats)) expect(c.stats[k].mean, `${f} ${k}`).toBeCloseTo(v.mean, 6);
  }
  for (const [f, t] of Object.entries(truth.i3dm)) expect(ts.find((x) => x.name === f).stats.instances, f).toBe(t.instances);
  for (const [f, t] of Object.entries(truth.cmpt)) {
    const s = ts.find((x) => x.name === f);
    expect([s.stats.points, s.stats.instances], f).toEqual([t.points, t.instances]);
  }
  // Refine to the leaves: every point of the octree comes in.
  const all = await frame.evaluate(async () => {
    const v = window.gisworkbench.activePane().view3d;
    const t = v.tilesets.find((x) => x.stats.subtrees > 0 && x.stats.points > 0);
    t.maxSse = 1e-9;
    for (let i = 0; i < 40; i++) {
      await t.settle(20000);
      if (!t.loading && ![...t._expanding()].length && i > 2) break;
    }
    return { points: t.stats.points, subtrees: t.stats.subtrees, failed: t.stats.failed };
  });
  expect(all.points).toBe(truth.implicit.octree.points);
  expect(all.subtrees).toBe(truth.implicit.octree.subtrees);
  expect(all.failed).toBe(0);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

test('REQ-FMT-34 FX-21: Draco and KTX2 GLBs (and a Draco + KTX2 b3dm) from the app compressor decode', async ({ page }) => {
  test.skip(!existsSync(join(FX, 'gltf')), 'run the FX-21 generator');
  const { frame, logs, requests } = await open(page);
  for (const f of ['box-draco.glb', 'box-ktx2.glb', 'box-draco-ktx2.glb']) expect((await openFiles(frame, [join(FX, 'gltf', f)])).flatMap((r) => r.errors), f).toEqual([]);
  expect((await openFiles(frame, [join(FX, 'gltf', 'draco-ktx2.b3dm')])).flatMap((r) => r.errors)).toEqual([]);
  const m = await models(frame);
  expect(m.map((x) => x.tris)).toEqual([12, 12, 12]);
  expect(m.slice(1).every((x) => x.textured === 1)).toBe(true);
  const ts = await tilesets(frame);
  expect(ts[0].stats.triangles).toBe(12);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

test('REQ-FMT-38 FX-21: the Rust writer EPSG:4326 and EPSG:3857 sets open from folders', async ({ page }) => {
  test.skip(!existsSync(join(FX, 'qmesh-3857', 'layer.json')), 'run the FX-21 generator with the tiles bundle built');
  const { frame, logs, requests } = await open(page);
  for (const d of ['qmesh-4326', 'qmesh-3857']) expect((await openFolder(frame, join(FX, d))).flatMap((r) => r.errors), d).toEqual([]);
  const m = (await models(frame)).filter((x) => x.stats?.projection);
  expect(m.map((x) => x.stats.projection)).toEqual(['EPSG:4326', 'EPSG:3857']);
  for (const x of m) {
    expect(x.stats.failed).toBe(0);
    expect(x.stats.min).toBeGreaterThan(1470);
    expect(x.stats.max).toBeLessThan(1730);
  }
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

// ---- writers: the app writes, an independent tool reads, the app re-reads (c53 pattern) ----
const PACKS = DIST ? resolve(DIST, '..', 'packs') : join(DIST_DIR, 'packs');
const codecPack = () => (existsSync(PACKS) ? readdirSync(PACKS).find((n) => /^codec-3d-.*\.gwpack$/.test(n)) : null);
const TV = resolve('..', 'TE-tools', 'node-3dtv', 'node_modules', '3d-tiles-validator', 'build', 'main');
const b64ToBytes = (s) => new Uint8Array(Buffer.from(s, 'base64'));

test('REQ-FMT-35 Draco + KTX2 export with the codec pack passes glTF-Validator and re-opens', async ({ page }) => {
  const pack = codecPack();
  test.skip(!pack || !existsSync(join(FX, 'gltf', 'box.glb')), 'needs the codec-3d pack and FX-21');
  const { frame, logs, requests } = await open(page);
  expect((await openFiles(frame, [join(PACKS, pack)])).flatMap((r) => r.errors)).toEqual([]);
  const out = await frame.evaluate(async (s) => {
    const app = window.gisworkbench;
    const glb = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const z = await app.scene3d.codec.compressGlb(glb, { draco: true, ktx2: true });
    let bin = '';
    for (let i = 0; i < z.length; i += 0x8000) bin += String.fromCharCode(...z.subarray(i, i + 0x8000));
    return btoa(bin);
  }, readFileSync(join(FX, 'gltf', 'box.glb')).toString('base64'));
  const bytes = b64ToBytes(out);
  const { default: validator } = await import('gltf-validator');
  const r = await validator.validateBytes(bytes);
  expect(r.issues.numErrors).toBe(0);
  const jlen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true);
  expect(JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jlen))).extensionsRequired.sort()).toEqual(['KHR_draco_mesh_compression', 'KHR_texture_basisu']);
  const tmp = join(resolve('test-results'), 'd3-export-draco-ktx2.glb');
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, bytes);
  expect((await openFiles(frame, [tmp])).flatMap((x) => x.errors)).toEqual([]);
  const m = await models(frame);
  expect(m.at(-1).tris).toBe(12);
  expect(m.at(-1).textured).toBe(1);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

test('REQ-FMT-37 a point cloud exports as a pnts implicit octree (ZIP and .3tz): 3d-tiles-validator reads it, the app re-opens it', async ({ page }) => {
  const laz = resolve('fixtures/fx09/fx09.laz');
  test.skip(!existsSync(laz), 'fixture not on disk');
  const { frame, logs, requests } = await open(page);
  await openFiles(frame, [laz]);
  await frame.waitForFunction(() => window.gisworkbench.activePane()?.view3d?.clouds?.length > 0, null, { timeout: 60000 });
  const out = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const c = app.activePane().view3d.clouds[0].cloud;
    const enc = (u8) => {
      let bin = '';
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(bin);
    };
    const z = app.pc.exportTiles(c, { maxPoints: 20000 });
    const t = app.pc.exportTiles(c, { archive: true, maxPoints: 20000 });
    return { zip: enc(z.bytes), tz: enc(t.bytes), name: z.name, tzName: t.name, stats: z.stats, n: c.n };
  });
  expect(out.stats.points).toBe(out.n);
  const dir = join(resolve('test-results'), 'd3-pnts-export');
  mkdirSync(dir, { recursive: true });
  const { unzipSync } = await import('fflate');
  for (const [k, v] of Object.entries(unzipSync(b64ToBytes(out.zip)))) {
    if (k.endsWith('/')) continue;
    mkdirSync(dirname(join(dir, k)), { recursive: true });
    writeFileSync(join(dir, k), v);
  }
  const tz = join(dir, out.tzName);
  writeFileSync(tz, b64ToBytes(out.tz));
  if (existsSync(TV)) {
    for (const f of [join(dir, out.name.replace(/\.zip$/, ''), 'tileset.json'), tz]) {
      const r = spawnSync(process.execPath, [TV, '--tilesetFile', f], { encoding: 'utf8', timeout: 300000 });
      expect(/"numErrors":\s*0/.test(r.stdout), `${f}: ${r.stdout.slice(0, 1500)}`).toBe(true);
    }
  }
  // The app re-opens the .3tz and the ZIP.
  expect((await openFiles(frame, [tz])).flatMap((x) => x.errors)).toEqual([]);
  const zipPath = join(dir, out.name);
  writeFileSync(zipPath, b64ToBytes(out.zip));
  expect((await openFiles(frame, [zipPath])).flatMap((x) => x.errors)).toEqual([]);
  const ts = await tilesets(frame);
  expect(ts.length).toBe(2);
  expect(ts.every((t) => t.stats.points > 0 && !t.local)).toBe(true);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});

test('REQ-FMT-39 a DEM exports as quantized-mesh (4326 and 3857): @here/quantized-mesh-decoder reads every tile, the app re-opens the ZIP', async ({ page }) => {
  const dt2 = resolve('fixtures/fx05/w117_n34.dt2');
  test.skip(!existsSync(dt2), 'fixture not on disk');
  const { frame, logs, requests } = await open(page);
  await openFiles(frame, [dt2]);
  await frame.waitForFunction(() => window.gisworkbench.terrain?.dems?.length > 0, null, { timeout: 60000 });
  const { default: decode } = await import('@here/quantized-mesh-decoder');
  const { unzipSync } = await import('fflate');
  for (const mercator of [false, true]) {
    const out = await frame.evaluate(async (m) => {
      const app = window.gisworkbench;
      const r = await app.demQuantizedMesh(app.terrain.dems[0], { mercator: m, maxZoom: 9 });
      let bin = '';
      for (let i = 0; i < r.zip.length; i += 0x8000) bin += String.fromCharCode(...r.zip.subarray(i, i + 0x8000));
      return { zip: btoa(bin), tiles: r.tiles, folder: r.folder, layer: r.layer };
    }, mercator);
    expect(out.layer.projection).toBe(mercator ? 'EPSG:3857' : 'EPSG:4326');
    const files = unzipSync(b64ToBytes(out.zip));
    const tiles = Object.keys(files).filter((k) => k.endsWith('.terrain'));
    expect(tiles.length).toBe(out.tiles);
    for (const k of tiles) {
      const b = files[k];
      const d = (decode.default ?? decode)(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      expect(d.vertexData.length, k).toBeGreaterThan(0);
      expect(d.extensions.vertexNormals, k).toBeTruthy();
      // DTED w117 n34 (Mojave): heights between -200 m and 3,700 m above the ellipsoid.
      expect(d.header.minHeight, k).toBeGreaterThan(-200);
      expect(d.header.maxHeight, k).toBeLessThan(3700);
    }
    const zp = join(resolve('test-results'), `${out.folder}.zip`);
    mkdirSync(dirname(zp), { recursive: true });
    writeFileSync(zp, b64ToBytes(out.zip));
    expect((await openFiles(frame, [zp])).flatMap((x) => x.errors)).toEqual([]);
  }
  const m = (await models(frame)).filter((x) => x.stats?.projection);
  expect(m.map((x) => x.stats.projection)).toEqual(['EPSG:4326', 'EPSG:3857']);
  expect(m.every((x) => x.stats.tiles > 0 && x.stats.failed === 0)).toBe(true);
  expect(logs).toEqual([]);
  expect(requests).toEqual([]);
});
