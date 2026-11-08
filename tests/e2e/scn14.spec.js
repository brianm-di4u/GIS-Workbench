// SCN-14 LiDAR exploration and DSM/DTM generation on FX-09 (REQ-LDR-01..10, REQ-FMT-10):
// LAZ decoded in parallel workers and equal to the LAS (AT-14.1 second half), the header panel and
// class counts against the truth (AT-14.2), the DTM against the analytic terrain, from the file's
// classes and from SMRF (AT-14.3), nDSM building heights (AT-14.4), the profile swath and point-
// snapped vertical picks (AT-14.5), US-feet GeoTIFF keys (REQ-LDR-03), class edits with undo, profile
// edits (SCN-69: select, delete, withhold, undo, export),
// colourising from FX-01, LAS 1.4 export round trips, and the 5 M-point frame rate (AT-14.1).
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';
import { terrain } from '../../build/fixtures/site.mjs';

const truth = JSON.parse(readFileSync(resolve('fixtures/fx09/fx09_truth.json'), 'utf8'));

/** RMSE of a geographic grid against the analytic terrain, away from the edges. */
function dtmRmse(G, heights, margin = 3) {
  let ss = 0;
  let n = 0;
  let worst = 0;
  for (let j = margin; j < G.ny - margin; j++)
    for (let i = margin; i < G.nx - margin; i++) {
      const z = heights[j * G.nx + i];
      if (!Number.isFinite(z)) continue;
      const d = z - terrain(G.lat0 - j * G.dlat, G.lon0 + i * G.dlon);
      ss += d * d;
      n++;
      worst = Math.max(worst, Math.abs(d));
    }
  return { rmse: Math.sqrt(ss / n), n, worst };
}

test('SCN-14 REQ-LDR-01 REQ-LDR-03 REQ-LDR-05 REQ-LDR-07 REQ-LDR-08 REQ-LDR-09 REQ-LDR-10 FX-09 LiDAR exploration, grids, classification and export', async ({ page }) => {
  test.setTimeout(600000);
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, [resolve('fixtures/fx09/fx09.laz')]);
  expect(log[0].errors).toEqual([]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    const v = app.pc.view();
    const rows = Object.fromEntries(app.pc.headerRows(c));
    const workers = app.pool.workers.get('pointcloud')?.length ?? 0;
    return { n: c.n, rows, classes: c.stats.classes, returns: c.stats.returns, ms: c.ms, workers, crs: c.crs, drawn: v.drawn, tiles: c.tiles.length };
  });
  console.log(JSON.stringify({ n: r.n, ms: r.ms, workers: r.workers, tiles: r.tiles, drawn: r.drawn }));
  // AT-14.1 (decode half): LAZ in workers, several of them.
  expect(r.ms.jobs).toBeGreaterThan(1);
  expect(r.workers).toBeGreaterThan(1);
  // AT-14.2: header and class counts.
  const H = truth.header;
  expect(r.n).toBe(H.n);
  expect(r.rows['LAS version']).toBe('1.4');
  expect(r.rows['Point data record format']).toBe('6 (LAZ)');
  expect(r.rows['Points']).toBe(String(H.n));
  expect(r.rows['Points by return']).toBe(H.byReturn.filter((v, k) => v || k < 5).join(', '));
  expect(r.rows['File source ID']).toBe(String(H.fileSourceId));
  expect(r.rows['System identifier']).toBe(H.systemId);
  expect(r.rows['Generating software']).toBe(H.software);
  expect(r.rows['Creation day/year']).toBe(`${H.day}/${H.year}`);
  expect(r.rows['Scale']).toBe(H.scale.join(', '));
  expect(r.rows['Min X, Y, Z']).toBe(H.min.map((v) => v.toFixed(3)).join(', '));
  expect(r.rows['Max X, Y, Z']).toBe(H.max.map((v) => v.toFixed(3)).join(', '));
  expect(r.rows['Horizontal CRS']).toMatch(/UTM zone 11N|32611/);
  expect(r.crs.vertical).toBe('egm96');
  expect(r.classes).toEqual(Object.fromEntries(Object.entries(truth.classes).map(([k, v]) => [k, v])));
  expect(r.returns).toEqual(truth.returns);
  expect(r.drawn).toBeGreaterThan(0);

  // LAS equals LAZ; the US-feet subset converts to the truth (REQ-LDR-03).
  await openFiles(frame, [resolve('fixtures/fx09/fx09.las'), resolve('fixtures/fx09/fx09_ftus.las')]);
  const eq = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const [laz, las, ft] = [...app.pointClouds.values()];
    let same = laz.n === las.n;
    for (let k = 0; same && k < laz.pos.length; k += 7) if (laz.pos[k] !== las.pos[k]) same = false;
    for (let k = 0; same && k < laz.n; k += 3) if (laz.class[k] !== las.class[k] || laz.intensity[k] !== las.intensity[k] || laz.time[k] !== las.time[k]) same = false;
    // ftUS: find each truth point by its file index.
    const inv = new Int32Array(ft.n);
    for (let k = 0; k < ft.n; k++) inv[ft.order[k]] = k;
    let dh = 0;
    let dz = 0;
    for (const p of truth.ftus.points) {
      const k = inv[p.k];
      const g = app.pc.toGeo(ft, ft.pos[3 * k], ft.pos[3 * k + 1], ft.pos[3 * k + 2]);
      dh = Math.max(dh, app.core.inverse(g.lat, g.lon, p.lat, p.lon).distance);
      dz = Math.max(dz, Math.abs(g.hae - p.hae));
    }
    return { same, lasN: las.n, ftN: ft.n, ftRows: Object.fromEntries(app.pc.headerRows(ft)), ftCrs: ft.crs, dh, dz, nPts: truth.ftus.points.length };
  }, truth);
  console.log(JSON.stringify({ ftus: { dh: eq.dh, dz: eq.dz, crs: eq.ftCrs.label, vertical: eq.ftCrs.vertical, hUnit: eq.ftCrs.hUnit, vUnit: eq.ftCrs.vUnit } }));
  expect(eq.same).toBe(true);
  expect(eq.ftN).toBe(truth.ftus.n);
  expect(eq.ftRows['LAS version']).toBe('1.2');
  expect(eq.ftCrs.hUnit).toBeCloseTo(0.3048006096, 9);
  expect(eq.ftCrs.vUnit).toBeCloseTo(0.3048006096, 9);
  expect(eq.ftCrs.vertical).toBe('navd88');
  expect(eq.dh).toBeLessThan(0.01);
  expect(eq.dz).toBeLessThan(0.01);

  // Grids, profile, picks, SMRF, edits, colourising and export on the LAZ cloud.
  const g = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    const out = {};
    // AT-14.3 from the file's classes.
    const dtm = await app.pc.makeGrid(c, 'dtm', { cell: 1 });
    out.dtm = { G: dtm.grid.geo, h: Array.from(dtm.heights) };
    // AT-14.4 nDSM at building centres (median of the 5 × 5 posts around).
    const nd = await app.pc.makeGrid(c, 'ndsm', { cell: 1 });
    const G = nd.grid.geo;
    out.buildings = truth.buildings.map((b) => {
      const lat = b.ringLatLon.reduce((s, p) => s + p[0], 0) / b.ringLatLon.length;
      const lon = b.ringLatLon.reduce((s, p) => s + p[1], 0) / b.ringLatLon.length;
      const i = Math.round((lon - G.lon0) / G.dlon);
      const j = Math.round((G.lat0 - lat) / G.dlat);
      const v = [];
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) v.push(nd.heights[(j + dj) * G.nx + i + di]);
      v.sort((a, b) => a - b);
      return { id: b.id, truth: b.height, got: v[12] };
    });
    // Generated layers open as terrain (DSM kind) and images.
    const gen = await app.pc.generate(c, 'dsm', { cell: 1 });
    out.dsmLayer = { name: gen.layer?.rec.name, kind: app.terrain.entry(gen.layer.id)?.kind };
    const dens = await app.pc.generate(c, 'density', { cell: 2, open: false });
    let ds = 0;
    let dn = 0;
    for (const x of dens.heights) if (x > 0) ((ds += x), dn++);
    out.density = ds / dn;
    // AT-14.5 profile across building B04.
    const b4 = truth.buildings.find((b) => b.id === 'B04');
    const [ce, cn] = app.pc.toLocal(c, b4.ringLatLon.reduce((s, p) => s + p[0], 0) / 4, b4.ringLatLon.reduce((s, p) => s + p[1], 0) / 4);
    const a = [ce - 40, cn - 30];
    const bb = [ce + 40, cn + 30];
    const pr = await app.pc.profile(c, a, bb, 1.5);
    const L = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
    const ux = (bb[0] - a[0]) / L;
    const uy = (bb[1] - a[1]) / L;
    let outside = 0;
    for (const k of pr.index) {
      const px = c.pos[3 * k] - a[0];
      const py = c.pos[3 * k + 1] - a[1];
      if (Math.abs(-px * uy + py * ux) > 1.5 + 1e-4) outside++;
    }
    let brute = 0;
    for (let k = 0; k < c.n; k++) {
      const px = c.pos[3 * k] - a[0];
      const py = c.pos[3 * k + 1] - a[1];
      const t = px * ux + py * uy;
      if (t >= 0 && t <= L && Math.abs(-px * uy + py * ux) <= 1.5) brute++;
    }
    out.profile = { n: pr.index.length, outside, brute };
    // Point-snapped pick on the roof: the picked point's height is the stored point's.
    const v = app.pc.view();
    v.lookDown(ce, cn, 250);
    v.render();
    const s = v.project([ce, cn, b4.roofHae]);
    const pk = v.pick(s.sx, s.sy, 10);
    out.pick = pk ? { z: pk.pos[2], stored: c.pos[3 * pk.index + 2], roof: b4.roofHae, cls: c.class[pk.index] } : null;
    // 3D measurement between two roof corners is the roof diagonal-ish, Δh ≈ 0.
    // SMRF from scratch: all unclassified → ground filter → agreement and DTM.
    const all1 = new Uint8Array(c.n).fill(1);
    for (let k = 0; k < c.n; k++) if (c.class0[k] === 7 || c.class0[k] === 18) all1[k] = c.class0[k];
    app.pc.recordClasses(c, all1, 'Reset classes');
    const sm = await app.pc.groundFilter(c);
    let agree = 0;
    let n = 0;
    for (let k = 0; k < c.n; k++) {
      if (c.class0[k] === 7 || c.class0[k] === 18) continue;
      n++;
      if ((c.class[k] === 2) === (c.class0[k] === 2)) agree++;
    }
    out.smrf = { agree: agree / n, ms: sm.ms, changed: sm.changed };
    const dtm2 = await app.pc.makeGrid(c, 'dtm', { cell: 1 });
    out.dtm2 = { G: dtm2.grid.geo, h: Array.from(dtm2.heights) };
    // Undo twice restores the file's classes.
    app.commands.run('qat.undo');
    app.commands.run('qat.undo');
    let same = true;
    for (let k = 0; k < c.n; k++) if (c.class[k] !== c.class0[k]) same = false;
    out.undo = same;
    // Polygon reclassification from a top view (REQ-LDR-09): B04's roof to class 17 and back by undo.
    v.lookDown(ce, cn, 250);
    v.render();
    const ring = b4.ringLatLon.map(([la, lo]) => v.project([...app.pc.toLocal(c, la, lo), b4.roofHae])).map((q) => [q.sx, q.sy]);
    const rc = app.pc.reclassPolygon(c, v, ring, 17, { from: 6 });
    out.reclass = { changed: rc.changed, classes17: c.stats.classes[17] ?? 0 };
    app.commands.run('qat.undo');
    out.reclassUndone = !c.stats.classes[17];
    // Export LAS 1.4 (LAZ) and read it again.
    const ex = await app.pc.exportLas(c, { compress: true });
    const f = new File([ex.bytes], ex.name);
    const [back] = await app.openPointClouds([f]);
    out.export = { name: ex.name, format: ex.format, epsg: ex.epsg, n: back.n, classes: back.stats.classes, minZ: back.stats.min[2], maxZ: back.stats.max[2], srcMinZ: c.stats.min[2], srcMaxZ: c.stats.max[2], dMin: Math.max(...[0, 1].map((a) => Math.abs(app.pc.toGeo(back, ...back.stats.min).lat - app.pc.toGeo(c, ...c.stats.min).lat) * 111000)), rows: Object.fromEntries(app.pc.headerRows(back)) };
    // Colour modes and class visibility are uniforms; shaving hides points from picks.
    for (const m of ['elevation', 'intensity', 'class', 'return', 'source', 'time', 'hag']) v.setColour(m);
    v.setColour('class');
    v.setShave(1, b4.roofHae - 2);
    v.render();
    out.shavedPick = !!v.pick(s.sx, s.sy, 3) && v.pick(s.sx, s.sy, 3).pos[2] > b4.roofHae - 2;
    v.setShave(0, 0);
    return out;
  }, truth);
  const d1 = dtmRmse(g.dtm.G, g.dtm.h);
  const d2 = dtmRmse(g.dtm2.G, g.dtm2.h);
  console.log(JSON.stringify({ dtmFile: d1, dtmSmrf: d2, buildings: g.buildings, profile: g.profile, pick: g.pick, smrf: g.smrf, density: g.density, export: { ...g.export, rows: undefined }, reclass: g.reclass }));
  // AT-14.3
  expect(d1.rmse).toBeLessThanOrEqual(0.15);
  expect(d2.rmse).toBeLessThanOrEqual(0.15);
  expect(g.smrf.agree).toBeGreaterThanOrEqual(0.97);
  // AT-14.4
  for (const b of g.buildings) expect(Math.abs(b.got - b.truth), b.id).toBeLessThanOrEqual(0.5);
  expect(g.dsmLayer.kind).toBe('DSM');
  expect(g.density).toBeGreaterThan(3.5);
  expect(g.density).toBeLessThan(5);
  // AT-14.5
  expect(g.profile.n).toBeGreaterThan(100);
  expect(g.profile.outside).toBe(0);
  expect(g.profile.n).toBe(g.profile.brute);
  expect(g.pick).not.toBeNull();
  expect(Math.abs(g.pick.z - g.pick.stored)).toBeLessThan(0.01);
  expect(Math.abs(g.pick.z - g.pick.roof)).toBeLessThan(0.15);
  // Edits and undo (REQ-LDR-09)
  expect(g.undo).toBe(true);
  expect(g.reclass.changed).toBeGreaterThan(1000);
  expect(g.reclass.classes17).toBe(g.reclass.changed);
  expect(g.reclassUndone).toBe(true);
  // REQ-LDR-10 export round trip
  expect(g.export.format).toBe(6);
  expect(g.export.epsg).toBe(32611);
  expect(g.export.n).toBe(r.n);
  expect(g.export.classes).toEqual(r.classes);
  expect(Math.abs(g.export.minZ - g.export.srcMinZ)).toBeLessThan(0.002);
  expect(Math.abs(g.export.maxZ - g.export.srcMaxZ)).toBeLessThan(0.002);
  expect(g.export.dMin).toBeLessThan(0.01);
  expect(g.export.rows['Point data record format']).toBe('6 (LAZ)');
  expect(g.shavedPick).toBe(false);
  expect(logs).toEqual([]);
});

test('SCN-14 REQ-LDR-10 FX-09 FX-01 colourise from an image and export point format 7', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx01/fx01.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  await openFiles(frame, [resolve('fixtures/fx09/fx09.laz')]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    const l = [...app.layers.values()].find((x) => x.kind === 'image' && x.modelId);
    const col = await app.pc.colourise(c, l);
    app.pc.view().setColour('rgb');
    const ex = await app.pc.exportLas(c, { compress: false, heights: 'egm96' });
    const [back] = await app.openPointClouds([new File([ex.bytes], ex.name)]);
    let diff = 0;
    // Same positions sorted the same way: compare colour sums.
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    diff = Math.abs(sum(back.rgb) - sum(c.rgb)) / sum(c.rgb);
    return { inside: col.inside, n: c.n, format: ex.format, backRgb: !!back.rgb, diff, vertical: back.crs.vertical, zMin: [back.stats.min[2], c.stats.min[2]] };
  });
  console.log(JSON.stringify(r));
  expect(r.inside / r.n).toBeGreaterThan(0.99);
  expect(r.format).toBe(7);
  expect(r.backRgb).toBe(true);
  expect(r.diff).toBeLessThan(1e-6);
  expect(r.vertical).toBe('egm96');
  expect(Math.abs(r.zMin[0] - r.zMin[1])).toBeLessThan(0.01);
  expect(logs).toEqual([]);
});

test('SCN-14 AT-14.1 REQ-PRF-05 REQ-LDR-04 FX-09 5 M points render at 30 fps or more with a 3 M budget', async ({ page }) => {
  test.skip(!existsSync(resolve('fixtures/fx09/fx09_5m.laz')), 'fx09_5m.laz not generated');
  test.setTimeout(600000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx09/fx09_5m.laz')]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    const v = app.pc.view();
    v.setColour('elevation');
    await v.measureFps(30);
    const f = await v.measureFps(180);
    const info = v.renderer.getContext().getParameter(v.renderer.getContext().RENDERER);
    return { n: c.n, ms: c.ms, workers: app.pool.workers.get('pointcloud').length, ...f, budget: v.settings.budget, gpu: info };
  });
  console.log(JSON.stringify(r));
  expect(r.n).toBeGreaterThan(5_000_000);
  expect(r.workers).toBeGreaterThan(1);
  expect(r.drawn).toBeLessThanOrEqual(r.budget);
  expect(r.drawn).toBeGreaterThan(2_000_000);
  expect(r.fps).toBeGreaterThanOrEqual(30);
  expect(logs).toEqual([]);
});

// SCN-69 (REQ-GAP-81): clean noise from a lidar strip in the profile view, undo it, and export.
// Through the commands: Select in Profile (two clicks on the 3D view), a box dragged on the
// profile around the high-noise points, Delete Points; then Set Withheld on a selection; undo,
// redo and LAS export. Deleted points leave the view's picks, the profile, the grids and the file.
test('SCN-69 REQ-GAP-81 FX-09 clean noise in the profile view: select, delete, withhold, undo, export', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx09/fx09.laz')]);
  await frame.waitForFunction(() => window.gisworkbench.pointClouds?.size > 0, null, { timeout: 120000 });
  // A high-noise point (class 18), two ground points 30 m either side of it, seen from above.
  const s = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    const v = app.pc.view();
    let k18 = -1;
    for (let k = 0; k < c.n && k18 < 0; k++) if (c.class[k] === 18) k18 = k;
    const [x, y] = [c.pos[3 * k18], c.pos[3 * k18 + 1]];
    const near = (tx, ty) => {
      let best = -1;
      let bd = Infinity;
      for (let k = 0; k < c.n; k++) {
        if (c.class[k] !== 2) continue;
        const d = (c.pos[3 * k] - tx) ** 2 + (c.pos[3 * k + 1] - ty) ** 2;
        if (d < bd) [best, bd] = [k, d];
      }
      return best;
    };
    v.lookDown(x, y, 120);
    v.render();
    v.canvas.dataset.testid = 'v3d';
    const at = (k) => v.project([c.pos[3 * k], c.pos[3 * k + 1], c.pos[3 * k + 2]]);
    return { n: c.n, k18, ends: [at(near(x - 30, y)), at(near(x + 30, y))] };
  });
  const v3d = frame.locator('[data-testid="v3d"]');
  await frame.evaluate(() => void window.gisworkbench.commands.run('pc.profileselect'));
  for (const e of s.ends) await v3d.click({ position: { x: e.sx, y: e.sy } });
  const dlg = frame.locator('[data-id="dialog:pc-profile"]');
  await expect(dlg).toBeVisible({ timeout: 60000 });
  await expect(dlg.locator('[data-id="pc:profile-mode"]')).toHaveValue('box');
  // The box: round every profile point at least 10 m above the profile's median height.
  const box = await frame.evaluate(() => {
    const pr = window.gisworkbench.pc.lastProfile;
    const zs = Array.from(pr.z).sort((a, b) => a - b);
    const cut = zs[zs.length >> 1] + 10;
    const hi = [];
    for (let i = 0; i < pr.index.length; i++) if (pr.z[i] > cut) hi.push([pr.along[i], pr.z[i], pr.cloud.class[pr.index[i]]]);
    const xs = hi.map((p) => pr.toCanvas(p[0], p[1]));
    const pad = 6;
    return { hi: hi.length, classes: [...new Set(hi.map((p) => p[2]))], x0: Math.min(...xs.map((p) => p[0])) - pad, y0: Math.min(...xs.map((p) => p[1])) - pad, x1: Math.max(...xs.map((p) => p[0])) + pad, y1: Math.max(...xs.map((p) => p[1])) + pad, profile: pr.index.length };
  });
  expect(box.hi).toBeGreaterThan(0);
  expect(box.classes).toEqual([18]);
  const cv = await dlg.locator('[data-id="pc:profile-canvas"]').boundingBox();
  const sc = cv.width / 600;
  await page.mouse.move(cv.x + box.x0 * sc, cv.y + box.y0 * sc);
  await page.mouse.down();
  await page.mouse.move(cv.x + ((box.x0 + box.x1) / 2) * sc, cv.y + ((box.y0 + box.y1) / 2) * sc, { steps: 4 });
  await page.mouse.move(cv.x + box.x1 * sc, cv.y + box.y1 * sc, { steps: 4 });
  await page.mouse.up();
  await expect(dlg.locator('[data-id="pc:profile-count"]')).toHaveText(new RegExp(`^${box.hi} point`));
  // Delete through the command (the ribbon's Delete Points), not the dialog button.
  await frame.evaluate(() => void window.gisworkbench.commands.run('pc.delete'));
  const del = await frame.evaluate(async (k18) => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    const v = app.pc.view();
    const p = v.project([c.pos[3 * k18], c.pos[3 * k18 + 1], c.pos[3 * k18 + 2]]);
    const pick = v.pick(p.sx, p.sy, 2);
    const pr = await app.pc.profile(c, app.pc.lastProfile.a, app.pc.lastProfile.b, 1);
    const ex = await app.pc.exportLas(c);
    const [back] = await app.openPointClouds([new File([ex.bytes], 'clean.las')]);
    return { nDeleted: c.nDeleted, deleted18: c.deleted[k18], picked: pick?.index === k18, profile: pr.index.length, dialogProfile: app.pc.lastProfile.index.length, zmax: Math.max(...pr.z), zmax0: Math.max(...app.pc.lastProfile.z), export: back.n, export18: back.stats.classes[18] ?? 0, classes18: c.stats.classes[18] ?? 0, edits: app.pc.edits(c).map((e) => e.params.field ?? 'class') };
  }, s.k18);
  console.log(JSON.stringify({ box, del }));
  expect(del.nDeleted).toBe(box.hi);
  expect(del.deleted18).toBe(1);
  expect(del.picked).toBe(false);
  expect(del.profile).toBe(box.profile - box.hi); // a new profile leaves it out, and its height axis drops
  expect(del.zmax).toBeLessThan(del.zmax0 - 5);
  expect(del.dialogProfile).toBe(box.profile); // the open dialog keeps it undrawn, so undo shows it again
  expect(del.export).toBe(s.n - box.hi);
  expect(del.classes18).toBe(10 - box.hi);
  expect(del.export18).toBe(10 - box.hi);
  expect(del.edits).toEqual(['deleted']);
  // Withhold: Select all in the profile, then the Set Withheld command; the LAS file carries the flag.
  await dlg.locator('[data-id="pc:profile-all"]').click();
  await frame.evaluate(() => void window.gisworkbench.commands.run('pc.withheld'));
  const wh = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    let n = 0;
    for (let k = 0; k < c.n; k++) if (c.flags[k] & 4) n++;
    const ex = await app.pc.exportLas(c);
    const [back] = await app.openPointClouds([new File([ex.bytes], 'withheld.las')]);
    let m = 0;
    for (let k = 0; k < back.n; k++) if (back.flags[k] & 4) m++;
    return { withheld: n, exported: m, profile: app.pc.lastProfile.index.filter((k) => !c.deleted?.[k]).length };
  });
  expect(wh.withheld).toBe(wh.profile);
  expect(wh.exported).toBe(wh.withheld);
  // Undo both: every point is back, nothing withheld, and the export is the whole cloud. Redo the deletion.
  const un = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    app.commands.run('qat.undo');
    const afterOne = { deleted: c.nDeleted, withheld: c.flags.reduce((s, f) => s + (f & 4 ? 1 : 0), 0) };
    app.commands.run('qat.undo');
    const all = await app.pc.exportLas(c);
    const [back] = await app.openPointClouds([new File([all.bytes], 'undone.las')]);
    const undone = { deleted: c.nDeleted, mask: c.deleted, export: back.n, classes18: c.stats.classes[18] };
    app.commands.run('qat.redo');
    return { afterOne, undone, redone: c.nDeleted };
  });
  expect(un.afterOne).toEqual({ deleted: box.hi, withheld: 0 });
  expect(un.undone).toEqual({ deleted: 0, mask: null, export: s.n, classes18: 10 });
  expect(un.redone).toBe(box.hi);
  // The other consumers of the one mask: a clip, a BPF and 3D Tiles leave the deleted point out, and
  // a TIN of the ground points has five fewer vertices once five ground points are deleted.
  const more = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    const st = c.stats;
    const ring = [[st.min[0] - 1, st.min[1] - 1], [st.max[0] + 1, st.min[1] - 1], [st.max[0] + 1, st.max[1] + 1], [st.min[0] - 1, st.max[1] + 1]];
    const sub = await app.pc.clip(c, ring, { p: null });
    const bpf = await app.pc.exportBpf(c, { coordType: 1 });
    const [bb] = await app.openPointClouds([new File([bpf.bytes], 'clean.bpf')]);
    const tiles = app.pc.exportTiles(c);
    const g5 = [];
    for (let k = 0; k < c.n && g5.length < 5; k++) if (c.class[k] === 2 && !c.deleted?.[k]) g5.push(k);
    const n0 = c.nDeleted;
    app.pc.deleteSelection(c, Uint32Array.from(g5));
    let ground = 0;
    for (let k = 0; k < c.n; k++) if (c.class[k] === 2 && !c.deleted[k]) ground++;
    const id = await app.tin.create({ from: 'lidar', pc: c.id });
    return { n: c.n, n0, clip: sub.n, bpf: bb.n, tiles: tiles.stats.points, deleted: c.nDeleted, ground, tin: (await app.tin.info(id)).vertices };
  });
  expect([more.clip, more.bpf, more.tiles]).toEqual([more.n - more.n0, more.n - more.n0, more.n - more.n0]);
  expect(more.deleted).toBe(more.n0 + 5);
  expect(more.tin).toBe(more.ground);
  expect(logs).toEqual([]);
});
