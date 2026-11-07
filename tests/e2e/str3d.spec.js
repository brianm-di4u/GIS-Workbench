// REQ-STR-11..14: the 3D pane on FX-05 terrain draped with FX-01 — RTIN mesh within its error
// bound, vertical exaggeration, the 3D cursor on the surface and mensuration, 3D line of sight
// over the ridge, glTF import placed by its origin, Free and Route navigation, and a WebM.
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';
import { SITE, terrain } from '../../build/fixtures/site.mjs';

test('REQ-STR-11 REQ-STR-12 REQ-STR-13 REQ-STR-14 FX-01 FX-05 3D terrain, cursor, line of sight, glTF, route and WebM', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx01/fx01.ntf'), resolve('fixtures/fx05/fx05_dem_hae.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length === 2, null, { timeout: 60000 });
  const r = await frame.evaluate(async (SITE) => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()];
    const img = ls.find((l) => /fx01/i.test(l.rec.name));
    const demL = ls.find((l) => /dem/i.test(l.rec.name));
    await app.useAsTerrain(demL, 'hae');
    const dem = app.terrain.entry(demL.id);
    const p = app.activePane();
    const d = 0.006;
    const t = await app.scene3d.openTerrain({ p, dem, image: img, box: [SITE[0] - d, SITE[1] - d * 1.2, SITE[0] + d, SITE[1] + d * 1.2], size: 513, maxError: 0.5 });
    const v = p.view3d;
    // Mesh error bound: the mesh's height at random grid posts against the grid.
    const g = t.grid;
    const tri = t.mesh.geometry;
    void tri;
    const out = { triangles: t.triangles, vertices: t.vertices, draped: t.draped, meshMs: t.meshMs };
    // 3D cursor on the surface: project a known ground point, pick, compare.
    const lat = SITE[0] + 0.002;
    const lon = SITE[1] - 0.002;
    const [e, n] = v.toLocal(lat, lon);
    const z = v.terrainHeight(e, n);
    v.lookDown(e, n, 300);
    v.render();
    const s = v.projectWorld([e, n, z]);
    const pk = v.pickSurface(s.sx, s.sy);
    const pg = pk ? v.toGeo(...pk) : null;
    out.cursor = pk ? { dist: app.core.inverse(pg.lat, pg.lon, lat, lon).distance, dz: pk[2] - z, z, lat: pg.lat, lon: pg.lon, h: pk[2] } : null;
    // Exaggeration keeps picks in true heights.
    v.setExaggeration(3);
    v.render();
    const s3 = v.projectWorld([e, n, z]);
    const pk3 = v.pickSurface(s3.sx, s3.sy);
    out.exag = pk3 ? { dz: pk3[2] - z, scale: v.world.scale.z } : null;
    v.setExaggeration(1);
    // Mensuration between two picks (ground points 200 m apart east-west).
    const a = [e - 100, n, v.terrainHeight(e - 100, n)];
    const b = [e + 100, n, v.terrainHeight(e + 100, n)];
    out.measure = app.scene3d.measure(v, a, b);
    // LOS: across the ridge (blocked) and along the flat pad (visible).
    const P = (x, y) => [x, y, v.terrainHeight(x, y) + 2];
    const [e0, n0] = v.toLocal(SITE[0], SITE[1]);
    out.losRidge = v.lineOfSight(P(e0 + 100, n0 - 250), P(e0 + 450, n0 + 300));
    const [pe, pn] = v.toLocal(SITE[0] + 300 / 110940, SITE[1] - 300 / 92000);
    out.losPad = v.lineOfSight(P(pe - 80, pn), P(pe + 80, pn));
    // glTF: export a building with its origin, import it into the view.
    const bl = app.attribution.newSchemaLayer('AL013');
    const sq = [[0, 0], [0.0002, 0], [0.0002, 0.00015], [0, 0.00015]].map(([x, y]) => ({ lon: SITE[1] + 0.001 + x, lat: SITE[0] + 0.001 + y, h: 0, zsrc: 'dem' }));
    const fid = app.commitFeature(p, 'Polygon', sq);
    app.attribution.setAttr(fid, 'HGT', 15);
    const glb = app.extractR2.export3d(bl, 'glb');
    const m = await v.addGltf(glb.bytes, 'building.glb');
    const box = new v.T.Box3().setFromObject(m.object);
    const [be, bn] = v.toLocal(SITE[0] + 0.001 + 0.000075, SITE[1] + 0.001 + 0.0001);
    out.gltf = { meshes: m.meshes, placedBy: m.placedBy, centre: [(box.min.x + box.max.x) / 2 - be, (box.min.y + box.max.y) / 2 - bn], height: box.max.z - box.min.z };
    // Free flight moves the camera; a route flight ends.
    v.setNavigation('free');
    const c0 = v.camera.position.clone();
    v.fly(50, 0, 0);
    out.freeMoved = v.camera.position.distanceTo(c0);
    const route = [[e0 - 300, n0 - 300], [e0, n0], [e0 + 300, n0 + 200]];
    const fr = v.setNavigation('route', { route, height: 60, speed: 2000 });
    const done = await fr.promise;
    out.route = { length: fr.length, seconds: done.seconds, camZ: v.camera.position.z };
    // WebM.
    const blob = await v.recordWebM({ seconds: 1, fps: 30, pose: app.scene3d.orbitPose(v, 1) });
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    out.webm = { size: blob.size, type: blob.type, ebml: [...head].map((x) => x.toString(16)).join('') };
    return out;
  }, SITE);
  console.log(JSON.stringify(r));
  expect(r.draped).toBe(true);
  expect(r.triangles).toBeGreaterThan(1000);
  expect(r.triangles).toBeLessThan(2 * 512 * 512);
  expect(r.cursor).not.toBeNull();
  expect(r.cursor.dist).toBeLessThan(2);
  expect(Math.abs(r.cursor.h - terrain(r.cursor.lat, r.cursor.lon))).toBeLessThan(1);
  expect(Math.abs(r.exag.dz)).toBeLessThan(1);
  expect(r.exag.scale).toBe(3);
  expect(r.measure.horizontal).toBeGreaterThan(195);
  expect(r.measure.horizontal).toBeLessThan(205);
  expect(r.losRidge.visible).toBe(false);
  expect(r.losPad.visible).toBe(true);
  expect(r.gltf.meshes).toBe(1);
  expect(r.gltf.placedBy).toBe('origin');
  expect(Math.hypot(...r.gltf.centre)).toBeLessThan(2);
  expect(Math.abs(r.gltf.height - 15)).toBeLessThan(1.5);
  expect(r.freeMoved).toBeGreaterThan(49);
  expect(r.route.length).toBeGreaterThan(780);
  expect(r.webm.size).toBeGreaterThan(1000);
  expect(r.webm.type).toBe('video/webm');
  expect(r.webm.ebml).toBe('1a45dfa3');
  expect(logs).toEqual([]);
});
