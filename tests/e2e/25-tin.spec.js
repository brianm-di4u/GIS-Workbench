// 2.5 gap wave T0b, group tin (GR-13): REQ-GAP-39 TIN editing on FX-02 (the truth DSM: flat ground
// with 5–12 m boxes), in the app:
// * a TIN from the DSM posts thinned to 0.25 m, every sampled post within the tolerance;
// * mass point add / move / delete, hard and soft breaklines, a drain cut through a box and a
//   ridge, an edge swap and an area re-triangulated, each one undoable and in the project; undo
//   back to the built TIN gives its heights exactly;
// * an interactive tool click adds a point; wireframe and shaded display draw on the pane;
// * TIN → DEM layer, LandXML export → import, Shapefile / GeoJSON / CSV export → import;
// * the TIN in the 3D view;
// * the five dialogs pass axe; other forms are refused by name;
// * FX-09: the New TIN dialog makes a TIN of the cloud's ground points, each one a vertex;
// * a project file carries a TIN and its edits into a fresh page (NaN heights included).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { openApp, openFiles } from './helpers.js';

const FX02 = resolve('fixtures/fx02');
const truth02 = JSON.parse(readFileSync(resolve(FX02, 'fx02_truth.json'), 'utf8'));
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axeOn(frame, sel) {
  return frame.evaluate(async ({ s, tags }) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), { s: sel, tags: AXE_TAGS });
}

test('REQ-GAP-39 FX-02 TIN: build, edits, ridge and drain, undo, display, TIN to DEM, import and export, 3D, dialogs', async ({ page }) => {
  test.setTimeout(600000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve(FX02, 'fx02_dsm_truth.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 90000 });
  await frame.evaluate(axeSource);
  const r = await frame.evaluate(
    async ({ boxes, flats }) => {
      const app = window.gisworkbench;
      const dsmL = [...app.layers.values()].find((l) => /dsm_truth/.test(l.rec.name));
      await app.useAsTerrain(dsmL, 'hae');
      const d = app.terrain.entry(dsmL.id);
      const g = d.grid;
      const T = app.tin;
      const t0 = performance.now();
      const id = await T.create({ from: 'dem', layer: dsmL.id, tolerance: 0.25 });
      const buildMs = performance.now() - t0;
      const i0 = await T.info(id);
      // Every 7th post: the TIN within 0.25 m of the DSM (independent of the TIN code: the DSM's own heights).
      const sample = [];
      const sampleZ = [];
      for (let k = 0; k < g.width * g.height; k += 7) {
        const z = g.heights[k];
        if (!Number.isFinite(z)) continue;
        sample.push([g.lon0 + (k % g.width) * g.dlon, g.lat0 - Math.floor(k / g.width) * g.dlat]);
        sampleZ.push(z);
      }
      const h0 = await T.heights(id, sample);
      const worst = h0.reduce((m, v, k) => Math.max(m, Math.abs(v - sampleZ[k])), 0);
      const P = (lat, lon) => T.toPlane(id, lon, lat);
      const at = async (lat, lon) => (await T.heights(id, [[lon, lat]]))[0];
      const m2 = (c, de, dn) => [c.lon + de / (111320 * Math.cos((c.lat * Math.PI) / 180)), c.lat + dn / 110950];
      // Mass points.
      const fa = flats[0].centre;
      const [px, py] = P(fa.lat, fa.lon);
      const base = await at(fa.lat, fa.lon);
      const add = await T.edit('addpoint', { x: px + 0.3, y: py + 0.2, z: base + 3 });
      const afterAdd = (await T.heights(id, [T.toGeo(id, px + 0.3, py + 0.2)]))[0];
      await T.edit('movepoint', { x: px + 0.3, y: py + 0.2, r: 0.01, nx: px + 5.3, ny: py + 0.2, nz: base + 4 });
      const afterMove = (await T.heights(id, [T.toGeo(id, px + 5.3, py + 0.2)]))[0];
      await T.edit('delpoint', { x: px + 5.3, y: py + 0.2, r: 0.01 });
      const afterDel = (await T.heights(id, [T.toGeo(id, px + 5.3, py + 0.2)]))[0];
      // A refused edit: nothing recorded.
      const before = app.store.all('tinedit').length;
      let refused = null;
      try {
        await T.edit('delpoint', { x: px + 999, y: py + 999, r: 0.01 });
      } catch (e) {
        refused = e.code;
      }
      const recordedAfterRefusal = app.store.all('tinedit').length - before;
      // A hard breakline 2 m above the ground across flat area 2; a soft one across flat area 1.
      const fb = flats[1].centre;
      const [bx, by] = P(fb.lat, fb.lon);
      const bz = await at(fb.lat, fb.lon);
      const hard = await T.edit('addline', { type: 'hard', closed: false, pts: [[bx - 30, by, bz + 2], [bx + 30, by, bz + 2]] });
      const onHard = (await T.heights(id, [T.toGeo(id, bx + 7.1, by)]))[0] - bz;
      const along = Array.from({ length: 41 }, (_, k) => T.toGeo(id, px - 40 + 2 * k, py - 15 + 0.5 * k));
      const softBefore = await T.heights(id, along);
      await T.edit('addline', { type: 'soft', closed: false, pts: [[px - 40, py - 15, NaN], [px + 40, py + 5, NaN]] });
      const softAfter = await T.heights(id, along);
      const softDiff = softAfter.reduce((m, v, k) => Math.max(m, Math.abs(v - softBefore[k])), 0);
      // A drain through box B05a, west to east across its roof.
      const b0 = boxes[0];
      const [rx, ry] = P(b0.roofCentre.lat, b0.roofCentre.lon);
      const roofBefore = await at(b0.roofCentre.lat, b0.roofCentre.lon);
      const drain = await T.edit('profile', { mode: 'drain', pts: [[rx - 30, ry], [rx + 30, ry]] });
      const roofAfter = await at(b0.roofCentre.lat, b0.roofCentre.lon);
      const lines = await T.lines(id);
      const dl = lines.find((l) => l.key === drain.key);
      const dz = Array.from({ length: dl.path.length / 3 }, (_, k) => dl.path[3 * k + 2]);
      const monotone = dz.every((v, k) => k === 0 || v <= dz[k - 1] + 1e-9);
      // A ridge across box B05b (filled: never lower than before along it).
      const b1 = boxes[1];
      const [sx2, sy2] = P(b1.roofCentre.lat, b1.roofCentre.lon);
      const ridgeLine = Array.from({ length: 21 }, (_, k) => T.toGeo(id, sx2 - 40 + 4 * k, sy2 + 1));
      const ridgeBefore = await T.heights(id, ridgeLine);
      const ridge = await T.edit('profile', { mode: 'ridge', pts: [[sx2 - 40, sy2 + 1], [sx2 + 40, sy2 + 1]] });
      const ridgeAfter = await T.heights(id, ridgeLine);
      const ridgeNeverLower = ridgeAfter.every((v, k) => v >= ridgeBefore[k] - 0.01);
      // Edge swap and re-triangulation in its area.
      await T.edit('swap', { x: px + 20.4, y: py - 20.2 });
      await T.edit('retri', { ring: [[px + 10, py - 30], [px + 30, py - 30], [px + 30, py - 10], [px + 10, py - 10]] });
      const edits = app.store.all('tinedit').filter((e) => e.tin === id).map((e) => e.kind);
      // Undo every edit: the built TIN's heights come back exactly; redo one.
      for (let k = 0; k < edits.length; k++) app.undo.undo();
      await T.sync();
      const hU = await T.heights(id, sample);
      const undone = hU.every((v, k) => v === h0[k] || (Number.isNaN(v) && Number.isNaN(h0[k])));
      app.undo.redo();
      await T.sync();
      const redone = Math.abs((await T.heights(id, [T.toGeo(id, px + 0.3, py + 0.2)]))[0] - (base + 3)) < 1e-6;
      const i1 = await T.info(id);
      return { buildMs, i0: { vertices: i0.vertices, triangles: i0.triangles, maxError: i0.report.maxError, posts: g.width * g.height }, worst, samples: sample.length, addMs: add.ms, afterAdd: afterAdd - base, afterMove: afterMove - base, afterDel: Math.abs(afterDel - base), refused, recordedAfterRefusal, onHard, softDiff, roofBefore, roofAfter, base0: b0.baseHae, monotone, drainChanged: drain.profile.changed, ridgeChanged: ridge.profile.changed, ridgeNeverLower, edits, undone, redone, i1: { vertices: i1.vertices, edits: i1.edits } };
    },
    { boxes: truth02.boxes, flats: truth02.flatAreas },
  );
  console.log(JSON.stringify(r));
  expect(r.worst).toBeLessThanOrEqual(0.25 + 1e-3);
  expect(r.i0.maxError).toBeLessThanOrEqual(0.25);
  expect(r.i0.vertices).toBeLessThan(r.i0.posts / 5);
  expect(r.afterAdd).toBeCloseTo(3, 6);
  expect(r.afterMove).toBeCloseTo(4, 6);
  expect(r.afterDel).toBeLessThan(0.3);
  expect(r.refused).toBe('E_TIN_REFUSED');
  expect(r.recordedAfterRefusal).toBe(0);
  expect(r.onHard).toBeCloseTo(2, 2);
  expect(r.softDiff).toBeLessThan(0.01);
  expect(r.roofBefore - r.base0).toBeGreaterThan(4);
  expect(r.roofAfter - r.base0).toBeLessThan(0.5);
  expect(r.monotone).toBe(true);
  expect(r.drainChanged).toBeGreaterThan(0);
  expect(r.ridgeChanged).toBeGreaterThan(0);
  expect(r.ridgeNeverLower).toBe(true);
  expect(r.edits).toEqual(['addpoint', 'movepoint', 'delpoint', 'addline', 'addline', 'profile', 'profile', 'swap', 'retri']);
  expect(r.undone).toBe(true);
  expect(r.redone).toBe(true);

  // An interactive tool: one click on the pane adds a mass point (one edit record).
  const n0 = await frame.evaluate(() => window.gisworkbench.store.all('tinedit').length);
  await frame.evaluate(() => window.gisworkbench.tools.select('tin.addpoint', { sticky: true }));
  const box = await frame.evaluate(() => {
    const r = window.gisworkbench.activePane().overlay.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  await page.mouse.click(box.x + box.width * 0.37, box.y + box.height * 0.41);
  await frame.waitForFunction((n) => window.gisworkbench.store.all('tinedit').length === n + 1, n0, { timeout: 30000 });
  await frame.evaluate(() => window.gisworkbench.tools.select(null));

  // The line tool: a double-click ends the line straight away, with every clicked vertex once.
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    Object.assign(app.tin.options, { lineType: 'soft', snap: false });
    app.tools.select('tin.line');
  });
  const at = (u, v) => [box.x + box.width * u, box.y + box.height * v];
  await page.mouse.click(...at(0.37, 0.45));
  await page.mouse.click(...at(0.45, 0.45));
  await page.mouse.dblclick(...at(0.45, 0.53));
  await frame.waitForFunction((n) => window.gisworkbench.store.all('tinedit').length === n + 2, n0, { timeout: 30000 });
  const drawnLine = await frame.evaluate(() => {
    const e = window.gisworkbench.store.all('tinedit').sort((a, b) => a.seq - b.seq).at(-1);
    return { kind: e.kind, n: e.params.pts.length };
  });
  expect(drawnLine).toEqual({ kind: 'addline', n: 3 });

  // The swap tool does not snap to a vertex: a click inside a triangle swaps its nearest edge.
  await frame.evaluate(() => window.gisworkbench.tools.select('tin.swap', { sticky: true }));
  let swapped = false;
  for (const [u, v] of [[0.6, 0.55], [0.62, 0.35], [0.3, 0.6], [0.55, 0.3], [0.65, 0.65], [0.35, 0.3]]) {
    await page.mouse.click(...at(u, v));
    swapped = await frame.waitForFunction((n) => window.gisworkbench.store.all('tinedit').length === n + 3, n0, { timeout: 2000 }).then(() => true, () => false);
    if (swapped) break;
  }
  await frame.evaluate(() => window.gisworkbench.tools.select(null));
  expect(swapped).toBe(true);

  // The rest of the editor by pointer: each gesture leaves one edit of its kind.
  const lastEdit = () =>
    frame.evaluate(() => {
      const a = window.gisworkbench.store.all('tinedit').sort((x, y) => x.seq - y.seq);
      const e = a.at(-1);
      return { n: a.length, kind: e.kind, pts: (e.params.pts ?? e.params.ring)?.length ?? 0 };
    });
  const gesture = async (tool, clicks, finish = null) => {
    const before = (await lastEdit()).n;
    await frame.evaluate((id) => window.gisworkbench.tools.select(id), tool);
    for (const [u, v] of clicks) {
      await page.mouse.click(...at(u, v));
      await page.waitForTimeout(250); // each click is picked asynchronously; a human is no faster
    }
    if (finish) await page.mouse.dblclick(...at(...finish));
    await frame.waitForFunction((n) => window.gisworkbench.store.all('tinedit').length === n + 1, before, { timeout: 30000 });
    await frame.evaluate(() => window.gisworkbench.tools.select(null));
    return lastEdit();
  };
  expect(await gesture('tin.profile', [[0.52, 0.6], [0.56, 0.6]], [0.6, 0.62])).toMatchObject({ kind: 'profile', pts: 3 });
  expect(await gesture('tin.movepoint', [[0.37, 0.41], [0.385, 0.425]])).toMatchObject({ kind: 'movepoint' });
  expect(await gesture('tin.delpoint', [[0.385, 0.425]])).toMatchObject({ kind: 'delpoint' });
  expect(await gesture('tin.editline', [[0.41, 0.45], [0.45, 0.45], [0.46, 0.46]])).toMatchObject({ kind: 'setline', pts: 3 });
  expect(await gesture('tin.delin', [[0.7, 0.7], [0.74, 0.7]], [0.72, 0.74])).toMatchObject({ kind: 'delin', pts: 3 });
  expect(await gesture('tin.retri', [[0.25, 0.7], [0.3, 0.7]], [0.28, 0.75])).toMatchObject({ kind: 'retri', pts: 3 });

  // Display: wireframe, then shaded, draw on the pane's overlay.
  const drawn = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const id = app.tin.active();
    const count = () => {
      const c = app.activePane().overlay;
      const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let k = 3; k < px.length; k += 16) if (px[k] > 0) n++;
      return n;
    };
    const frameDone = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    app.tin.setDisplay(id, 'off');
    app.activePane().invalidate();
    await frameDone();
    const off = count();
    app.tin.setDisplay(id, 'wireframe');
    await app.tin.sync();
    app.activePane().invalidate();
    await frameDone();
    const wire = count();
    app.tin.setDisplay(id, 'shaded');
    await app.tin.sync();
    app.activePane().invalidate();
    await frameDone();
    const shaded = count();
    return { off, wire, shaded };
  });
  expect(drawn.wire).toBeGreaterThan(drawn.off + 100);
  expect(drawn.shaded).toBeGreaterThan(drawn.wire);

  // TIN → DEM, LandXML and point-form round trips, 3D.
  const io = await frame.evaluate(async (b2) => {
    const app = window.gisworkbench;
    const T = app.tin;
    const id = T.active();
    const info = await T.info(id);
    const dem = await T.toDem(id, { postM: 2 });
    const te = app.terrain.entry(dem.layer.id);
    const gg = te.grid;
    const ll = [];
    const zz = [];
    for (let k = 0; k < gg.width * gg.height; k += 97) {
      if (!Number.isFinite(gg.heights[k])) continue;
      ll.push([gg.lon0 + (k % gg.width) * gg.dlon, gg.lat0 - Math.floor(k / gg.width) * gg.dlat]);
      zz.push(gg.heights[k]);
    }
    const th = await T.heights(id, ll);
    const demDiff = th.reduce((m, v, k) => (Number.isFinite(v) ? Math.max(m, Math.abs(v - zz[k])) : m), 0);
    const x = await T.exportFile(id, 'landxml', { save: false });
    const text = await x.blob.text();
    const epsg = Number(/epsgCode="(\d+)"/.exec(text)[1]);
    const back = await T.importFile(new File([text], 'roundtrip.xml'), { epsg, vertical: 'hae' });
    const bi = await T.info(back.id);
    // How much the imported surface differs, at every 3rd post of the DEM grid made above (OD-2.41:
    // the file's own faces are kept, so only the file's rounding to 0.1 mm and the 1 mm grid remain).
    const sll = [];
    for (let k = 0; k < gg.width * gg.height; k += 3) sll.push([gg.lon0 + (k % gg.width) * gg.dlon, gg.lat0 - Math.floor(k / gg.width) * gg.dlat]);
    const [s0, s1] = [await T.heights(id, sll), await T.heights(back.id, sll)];
    const sd = s0.map((v, k) => Math.abs(v - s1[k])).filter(Number.isFinite).sort((a, b) => a - b);
    const surface = { posts: sd.length, p50: sd[sd.length >> 1], p99: sd[Math.floor(sd.length * 0.99)], max: sd.at(-1), over10cm: sd.filter((v) => v > 0.1).length };
    // Edits first: mass points on a soft line or beside a swapped edge stay mass points, and a
    // drain's cut heights go out on every vertex of its path.
    const cx = (info.x0 + info.x1) / 2;
    const cy = (info.y0 + info.y1) / 2;
    const swapAt = [cx + 40.2, cy + 40.1];
    await T.edit('swap', { x: swapAt[0], y: swapAt[1] }, id).catch(() => null);
    await T.edit('addline', { type: 'soft', closed: false, pts: [[cx - 60, cy - 50, NaN], [cx + 60, cy - 45, NaN]] }, id);
    const [rx0, ry0] = T.toPlane(id, b2.roofCentre.lon, b2.roofCentre.lat);
    const dr = await T.edit('profile', { mode: 'drain', pts: [[rx0 - 30, ry0], [rx0 + 30, ry0]] }, id);
    const edited = await T.info(id);
    const drL = (await T.lines(id)).find((l) => l.key === dr.key);
    const drGeo = Array.from({ length: drL.path.length / 3 }, (_, k) => T.toGeo(id, drL.path[3 * k], drL.path[3 * k + 1]));
    const drZ = await T.heights(id, drGeo);
    const forms = {};
    for (const form of ['geojson', 'shapefile', 'csv']) {
      const o = await T.exportFile(id, form, { save: false });
      const f = new File([await o.blob.arrayBuffer()], o.name);
      const im = await T.importFile(f, { vertical: 'hae' });
      const zb = await T.heights(im.id, drGeo);
      forms[form] = { points: im.points, lines: im.lines, vertices: (await T.info(im.id)).vertices, drainDiff: zb.reduce((m, v, k) => Math.max(m, Math.abs(v - drZ[k])), 0) };
    }
    let refused = null;
    try {
      await T.importFile(new File(['0'], 'site.dwg'));
    } catch (e) {
      refused = e.message;
    }
    let refusedOut = null;
    try {
      await T.exportFile(id, 'dxf', { save: false });
    } catch (e) {
      refusedOut = e.message;
    }
    const v3 = await T.show3d(id);
    return { info: { vertices: info.vertices, lines: info.lines.length, mass: info.mass }, edited: { vertices: edited.vertices, drainChanged: dr.profile.changed }, dem: { w: gg.width, h: gg.height, demDiff }, landxml: { epsg, points: back.points, lines: back.lines, faces: back.agreement.faces, same: back.agreement.same, unmatched: back.agreement.unmatched, differ: back.agreement.differ.length, kept: back.kept, surface, vertices: bi.vertices, triangles: bi.triangles, before: info.triangles }, forms, refused, refusedOut, v3, has3d: !!app.activePane().view3d };
  }, truth02.boxes[2]);
  console.log(JSON.stringify(io));
  expect(io.dem.demDiff).toBeLessThan(1e-3);
  expect(io.landxml.vertices).toBe(io.info.vertices);
  expect(io.landxml.unmatched).toBe(0);
  // OD-2.41: every face comes back (2.5 kept 96.7 % and moved the surface by up to 1.24 m).
  expect(io.landxml.differ).toBe(0);
  expect(io.landxml.same).toBe(io.landxml.faces);
  expect(io.landxml.triangles).toBe(io.landxml.before);
  expect(io.landxml.kept).toMatchObject({ skipped: 0, kept: io.landxml.faces });
  expect(io.landxml.surface.max).toBeLessThan(0.002);
  expect(io.edited.drainChanged).toBeGreaterThan(0);
  for (const f of ['geojson', 'shapefile', 'csv']) {
    // Every vertex comes back; a soft line traced again may add one or two.
    expect(io.forms[f].vertices, f).toBeGreaterThanOrEqual(io.edited.vertices);
    expect(io.forms[f].vertices, f).toBeLessThan(io.edited.vertices + 10);
    expect(io.forms[f].lines, f).toBeGreaterThan(0);
    expect(io.forms[f].drainDiff, f).toBeLessThan(0.02);
  }
  expect(io.refused).toMatch(/CAD drawings/);
  expect(io.refusedOut).toMatch(/LandXML/);
  expect(io.v3.triangles).toBeGreaterThan(1000);

  // The dialogs pass axe.
  await frame.evaluate(() => {
    const p = [...document.querySelectorAll('.dlg')];
    p.forEach((d) => d.querySelector('.dlg-x')?.click());
  });
  for (const [cmd, id, close] of [['tin.new', 'tin-new', 'Cancel'], ['tin.editor', 'tin-editor', 'Close'], ['tin.export', 'tin-export', 'Cancel'], ['tin.raster', 'tin-raster', 'Cancel']]) {
    await frame.evaluate((c) => void window.gisworkbench.commands.run(c), cmd);
    const dlg = frame.locator(`[data-id="dialog:${id}"]`);
    await expect(dlg).toBeVisible();
    expect(await axeOn(frame, `[data-id="dialog:${id}"]`), cmd).toEqual([]);
    await dlg.locator('button.btn', { hasText: close }).click();
  }
  await frame.evaluate(() => void window.gisworkbench.tin.importDialog([new File(['x,y,z\n1,2,3\n'], 'pts.csv')]));
  const imp = frame.locator('[data-id="dialog:tin-import"]');
  await expect(imp).toBeVisible();
  expect(await axeOn(frame, '[data-id="dialog:tin-import"]')).toEqual([]);
  await imp.locator('button.btn', { hasText: 'Cancel' }).click();
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-GAP-39 FX-09 TIN from LiDAR ground points through the New TIN dialog', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx09/fx09.laz')]);
  await frame.waitForFunction(() => window.gisworkbench.pointClouds?.size > 0, null, { timeout: 120000 });
  await frame.evaluate(() => void window.gisworkbench.commands.run('tin.new'));
  const dlg = frame.locator('[data-id="dialog:tin-new"]');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Make TIN' }).click();
  await frame.waitForFunction(() => window.gisworkbench.store.all('tin').length === 1 && !!window.gisworkbench.tin.list()[0].info, null, { timeout: 120000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const T = app.tin;
    const id = T.active();
    const c = [...app.pointClouds.values()][0];
    const i = await T.info(id);
    const ground = [];
    for (let k = 0; k < c.n; k++) if (c.class[k] === 2) ground.push(k);
    // Heights at every 53rd ground point against the point's own z (HAE, the TIN's datum here).
    const ll = [];
    const zz = [];
    for (let k = 0; k < ground.length; k += 53) {
      const g = app.pc.toGeo(c, c.pos[3 * ground[k]], c.pos[3 * ground[k] + 1], c.pos[3 * ground[k] + 2]);
      ll.push([g.lon, g.lat]);
      zz.push(g.hae);
    }
    const hh = await T.heights(id, ll);
    const diff = hh.map((v, k) => Math.abs(v - zz[k])).sort((a, b) => a - b);
    return { vertices: i.vertices, triangles: i.triangles, duplicates: i.report.duplicates, ground: ground.length, vertical: T.list()[0].vertical, sampled: hh.length, nan: hh.filter(Number.isNaN).length, p50: diff[diff.length >> 1], p99: diff[Math.floor(diff.length * 0.99)], max: diff.filter(Number.isFinite).at(-1) };
  });
  console.log(JSON.stringify(r));
  expect(r.ground).toBeGreaterThan(1000);
  expect(r.vertices + r.duplicates).toBe(r.ground);
  expect(r.vertical).toBe('hae');
  expect(r.nan).toBe(0);
  expect(r.p99).toBeLessThan(0.01);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-GAP-39 a TIN and its edits come back from a project file in a fresh page', async ({ page }) => {
  test.setTimeout(180000);
  const { frame, logs } = await openApp(page, 'file');
  const saved = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const T = app.tin;
    const rows = ['lon,lat,z'];
    for (let j = 0; j < 12; j++) for (let i = 0; i < 15; i++) rows.push(`${(-105.3 + i * 2e-4 + (j % 3) * 3e-5).toFixed(9)},${(39.9 + j * 2e-4 + (i % 4) * 2e-5).toFixed(9)},${(1600 + 3 * Math.sin(i) + 2 * Math.cos(j * 1.7)).toFixed(3)}`);
    const { id } = await T.importFile(new File([rows.join('\n')], 'pts.csv'), { vertical: 'hae' });
    const i = await T.info(id);
    const [cx, cy] = [(i.x0 + i.x1) / 2, (i.y0 + i.y1) / 2];
    await T.edit('addpoint', { x: cx + 0.123, y: cy + 0.456, z: 1650.5 }, id);
    await T.edit('addline', { type: 'soft', closed: false, pts: [[cx - 40, cy - 30, NaN], [cx + 40, cy + 35, NaN]] }, id);
    await T.edit('addline', { type: 'hard', closed: false, pts: [[cx - 30, cy + 30, 1610], [cx + 30, cy + 28, 1611]] }, id);
    await T.edit('profile', { mode: 'drain', pts: [[cx - 50, cy + 5], [cx + 50, cy + 3]] }, id);
    await T.edit('movepoint', { x: cx + 0.123, y: cy + 0.456, r: 0.01, nx: cx + 1.5, ny: cy - 2.5, nz: NaN }, id);
    const probe = Array.from({ length: 60 }, (_, k) => T.toGeo(id, i.x0 + ((i.x1 - i.x0) * (k + 0.5)) / 60, i.y0 + ((i.y1 - i.y0) * ((k * 7) % 60 + 0.5)) / 60));
    const b = app.__test.serialiseProject(app);
    let bin = '';
    for (let k = 0; k < b.length; k += 8192) bin += String.fromCharCode(...b.subarray(k, k + 8192));
    return { id, b64: btoa(bin), probe, heights: await T.heights(id, probe), info: await T.info(id) };
  });
  const page2 = await page.context().newPage();
  const { frame: frame2, logs: logs2 } = await openApp(page2, 'file');
  const back = await frame2.evaluate(async ({ id, b64, probe }) => {
    const app = window.gisworkbench;
    const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.openProjectFile(new File([u8], 'tin.gwb'));
    const T = app.tin;
    await T.ready(id);
    const info = await T.info(id);
    const heights = await T.heights(id, probe);
    const stored = app.store.all('tinedit').length;
    return { info: { vertices: info.vertices, triangles: info.triangles, edits: info.edits, skipped: info.skipped, lines: info.lines.length }, heights, stored };
  }, saved);
  expect(back.info.edits).toBe(5);
  expect(back.stored).toBe(5);
  expect(back.info.skipped).toEqual([]);
  expect(back.info.vertices).toBe(saved.info.vertices);
  expect(back.info.triangles).toBe(saved.info.triangles);
  expect(back.info.lines).toBe(saved.info.lines.length);
  expect(back.heights).toEqual(saved.heights);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
  expect(logs2.filter((l) => !/favicon/.test(l))).toEqual([]);
});

// OD-2.41 (REQ-GAP-39 amended 2.7): Import TIN keeps a LandXML surface's own faces. The file is a
// sheared grid split on the long diagonal everywhere (none of it Delaunay), with a notch (concave
// outline), a hole and a hidden face; it goes in through the command and its file chooser, and
// comes back face for face from a project file in a fresh page.
function landXmlFixture() {
  const N = 9;
  const P = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) P.push([4400000 + 10 * j, 500000 + 10 * i + 3 * j, (1600 + 0.37 * i + 0.21 * j + ((i * 7 + j * 3) % 5) * 0.4).toFixed(3)]);
  const id = (i, j) => j * N + i + 1;
  const F = [];
  for (let j = 0; j < N - 1; j++)
    for (let i = 0; i < N - 1; i++) {
      if ((i === 4 && j === 4) || (i === N - 2 && j >= 2 && j <= 5)) continue;
      F.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)], [id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  const xml = `<?xml version="1.0"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Metric linearUnit="meter"/></Units><CoordinateSystem epsgCode="32613"/><Surfaces><Surface name="EG"><Definition surfType="TIN"><Pnts>${P.map((p, k) => `<P id="${k + 1}">${p.join(' ')}</P>`).join('')}</Pnts><Faces>${F.map((f, k) => `<F${k === 1 ? ' i="1"' : ''}>${f.join(' ')}</F>`).join('')}</Faces></Definition></Surface></Surfaces></LandXML>`;
  return { xml, P, F };
}

test('REQ-GAP-39 OD-2.41 Import TIN keeps a LandXML file\'s own faces, outline, hole and hidden face', async ({ page }) => {
  test.setTimeout(180000);
  const { frame, logs } = await openApp(page, 'file');
  const fx = landXmlFixture();
  await frame.evaluate(() => (window.gisworkbench.runMode.caps.fsaPicker = false));
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), frame.evaluate(() => void window.gisworkbench.commands.run('tin.import'))]);
  await fc.setFiles({ name: 'eg.xml', mimeType: 'application/xml', buffer: Buffer.from(fx.xml) });
  const dlg = frame.locator('[data-id="dialog:tin-import"]');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Import' }).click();
  await frame.waitForFunction(() => window.gisworkbench.store.all('tin').length === 1 && !!window.gisworkbench.tin.list()[0].info, null, { timeout: 60000 });
  await expect(frame.locator('.toast', { hasText: `${fx.F.length} of ${fx.F.length} of the file’s faces are in the TIN` })).toBeVisible();
  // The toast's count is the import's own face-by-face check (every file face is a TIN triangle).
  // Here: the hidden face is excluded and nothing else is; the heights are the file's.
  const faces = async (f) =>
    f.evaluate(async () => {
      const app = window.gisworkbench;
      const T = app.tin;
      const id = app.store.all('tin')[0].id;
      await T.ready(id);
      const m = await T.mesh(id);
      const key = (k) => [0, 1, 2].map((c) => `${m.xyz[3 * m.tris[3 * k + c]].toFixed(3)},${m.xyz[3 * m.tris[3 * k + c] + 1].toFixed(3)}`).sort().join(' ');
      const vis = [];
      const hid = [];
      for (let k = 0; k < m.tris.length / 3; k++) (m.excluded[k] ? hid : vis).push(key(k));
      const rec = app.store.all('tin')[0];
      return { visible: vis.sort(), hidden: hid.sort(), z: Array.from({ length: m.xyz.length / 3 }, (_, k) => m.xyz[3 * k + 2]).sort((x, y) => x - y), rings: (await T.lines(id)).filter((l) => l.type === 'outline').length, rec: { tris: rec.source.tris.length, hidden: rec.source.hidden } };
    });
  const a = await faces(frame);
  expect(a.visible).toHaveLength(fx.F.length - 1);
  expect(a.rec).toEqual({ tris: 3 * fx.F.length, hidden: [1] });
  expect(a.rings).toBe(2); // the notched outline (the hidden face is on it) and the hole
  // Excluded: the fill beside the notch (2 × 4), the hole (2), the hidden face, and slivers along the
  // straight sides (UTM lines are not quite straight in the TIN plane).
  expect(a.hidden.length).toBeGreaterThanOrEqual(11);
  expect(a.z).toEqual(fx.P.map((p) => Number(p[2])).sort((x, y) => x - y));
  // A project file brings the same faces back in a fresh page.
  const b64 = await frame.evaluate(() => {
    const b = window.gisworkbench.__test.serialiseProject(window.gisworkbench);
    let bin = '';
    for (let k = 0; k < b.length; k += 8192) bin += String.fromCharCode(...b.subarray(k, k + 8192));
    return btoa(bin);
  });
  const page2 = await page.context().newPage();
  const { frame: frame2, logs: logs2 } = await openApp(page2, 'file');
  await frame2.evaluate(async (b64) => {
    const app = window.gisworkbench;
    await app.openProjectFile(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'eg.gwb'));
  }, b64);
  expect(await faces(frame2)).toEqual(a);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
  expect(logs2.filter((l) => !/favicon/.test(l))).toEqual([]);
});
