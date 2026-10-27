// R0–R2 Shoulds and Coulds closed in R3, geospatial side, on FX-02 with its truth: depth below a
// reference (REQ-MEN-09) and DEM volume (REQ-DEM-15), GPX (REQ-IMG-31), the terrain folder
// (REQ-DEM-03), the GeoPDF snapshot (REQ-PRD-08), the Ortho On-the-Fly projection (REQ-IMG-18)
// and the online source properties (REQ-UI-26), epipolar pairs as GeoTIFF (REQ-STR-16), true
// orthos with occlusion against the truth mask (REQ-SNS-19), the descriptor matcher (REQ-SNS-21),
// BPF and ASCII points with a DSM of Difference (REQ-LDR-11), and serial stereo mice (REQ-UI-22).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fromArrayBuffer } from 'geotiff';
import { openApp, openFiles } from './helpers.js';

test.describe.configure({ timeout: 300000 });
const DIR = resolve('fixtures/fx02');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx02_truth.json'), 'utf8'));
const B05 = truth.boxes.find((b) => b.id === 'B05a');
const b64 = (p) => readFileSync(p).toString('base64');

async function fx02(page, { both = false, dsm = false } = {}) {
  const o = await openApp(page, 'file');
  await openFiles(o.frame, [resolve(DIR, 'fx02_a.ntf'), ...(both ? [resolve(DIR, 'fx02_b.ntf')] : [])]);
  await o.frame.waitForFunction((n) => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === n, both ? 2 : 1, { timeout: 60000 });
  if (dsm) {
    await o.frame.evaluate(async (data) => {
      const app = window.gisworkbench;
      const p = app.activePane();
      const { openImageFile } = app.__test?.formats ?? {};
      void openImageFile;
      const f = new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'fx02_dsm_truth.tif', { type: 'image/tiff' });
      await app.openFiles([f], p);
      const l = [...app.layers.values()].find((x) => x.info.fileName === 'fx02_dsm_truth.tif');
      await app.useAsTerrain(l, 'hae');
      app.store.transact('hide dsm', (tx) => tx.set(l.id, 'visible', false), { kind: 'edit' });
      const img = [...app.layers.values()].find((x) => x.info.fileName === 'fx02_a.ntf');
      app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', img.id), { kind: 'edit' });
    }, b64(resolve(DIR, 'fx02_dsm_truth.tif')));
  }
  return o;
}

test('REQ-MEN-09 REQ-DEM-15 REQ-IMG-31 REQ-PRD-08 REQ-IMG-18 REQ-UI-26 REQ-UI-22 depth and volume on the FX-02 DSM, GPX in and out, GeoPDF, projection, sources, serial mice', async ({ page }) => {
  const { frame, logs } = await fx02(page, { dsm: true });
  const cp = truth.checkpoints[0];
  const r = await frame.evaluate(async ({ B05, cp }) => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const out = {};
    // MEN-09: reference on the B05a roof, bottom at a ground checkpoint.
    const click = (x, y) => {
      const s = p.screenPoint(x, y);
      app.tools.current.onDown(p, {}, s.x, s.y);
    };
    app.commands.run('men.depth');
    click(...B05.roofCentre.a);
    click(...cp.a);
    const row = app.store.all('measurement').at(-1);
    out.depth = { type: row.mtype, value: row.value, tag: row.tag, le90: row.le90 };
    // DEM-15: a polygon 3 m outside the footprint, against the plane through its vertices.
    const g0 = B05.footprint.map((c) => [c.lon, c.lat]);
    const cx = g0.reduce((s, q) => s + q[0], 0) / 4;
    const cy = g0.reduce((s, q) => s + q[1], 0) / 4;
    const grow = g0.map(([lon, lat]) => [cx + (lon - cx) * 1.3, cy + (lat - cy) * 1.4]);
    const v = app.measureVolume(grow.map(([lon, lat]) => [lon, lat, 0]), { reference: 'plane', cell: 0.25 });
    out.volume = { net: v.net, cut: v.cut, fill: v.fill, logged: app.store.all('measurement').at(-1).mtype };
    const id = app.api.createGraphic({ shape: 'polygon', coordinates: grow, text: 'pad' });
    app.selection = new Set([id]);
    out.volumeEnabled = app.commands.enabled('dem.volume');
    // IMG-31: GPX waypoints (one with an MSL elevation), a route and a two-segment track.
    const N = app.core.undulation(cp.lat, cp.lon);
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="t" xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="${cp.lat}" lon="${cp.lon}"><ele>${(cp.hae - N).toFixed(3)}</ele><name>CP</name></wpt>
      <wpt lat="${B05.roofCentre.lat}" lon="${B05.roofCentre.lon}"><name>Roof</name></wpt>
      <rte><name>R1</name><rtept lat="34.560" lon="-116.441"/><rtept lat="34.561" lon="-116.442"/><rtept lat="34.562" lon="-116.443"/></rte>
      <trk><name>T</name><trkseg><trkpt lat="34.559" lon="-116.440"/><trkpt lat="34.5595" lon="-116.4405"/></trkseg><trkseg><trkpt lat="34.558" lon="-116.439"/><trkpt lat="34.5585" lon="-116.4395"/></trkseg></trk></gpx>`;
    const res = await app.loadGpx(new File([gpx], 'walk.gpx'));
    const wp = app.store.all('graphic').find((g) => g.gps === 'waypoint' && g.text === 'CP');
    const roof = app.store.all('graphic').find((g) => g.gps === 'waypoint' && g.text === 'Roof');
    out.gpx = { ...res, hae: wp.coords[0][2] - cp.hae, roofFromTerrain: Math.abs(roof.coords[0][2] - B05.roofCentre.hae), layer: app.store.get(res.layer)?.name };
    const back = app.graphicsGpx(app.store.all('graphic').filter((g) => g.gps));
    out.gpxOut = { wpt: (back.match(/<wpt /g) ?? []).length, rte: (back.match(/<rte>/g) ?? []).length, ele: Number(/<wpt [^>]*>\s*<ele>([-\d.]+)<\/ele><name>CP/.exec(back)?.[1]) - (cp.hae - N) };
    app.commands.run('gps.route');
    out.routeTool = app.tools.current?.id;
    app.tools.done?.();
    // UI-22: serial lines become axes; a malformed line is ignored.
    const s1 = app.input.serialLine('50 -25 10 0', { scale: 100 });
    out.serial = { x: s1?.x, y: s1?.y, source: app.input.state.last.source, bad: app.input.serialLine('hello') };
    // IMG-18: Ortho On-the-Fly in a fixed UTM zone, then back to the zone at the view.
    await app.ootf.enable(p);
    const z0 = p.ootf.region.zone;
    await app.ootf.setProjection({ zone: 12, north: true }, p);
    const z1 = p.ootf.region.zone;
    await app.ootf.setProjection(null, p);
    out.ootf = { z0, z1, z2: p.ootf.region.zone };
    app.ootf.disable(p);
    // UI-26: the online source properties open the backgrounds dialog.
    void app.commands.run('bg.online');
    await new Promise((x) => setTimeout(x, 100));
    out.bgDialog = !!document.querySelector('[data-id="dialog:map-backgrounds"]');
    document.querySelector('[data-id="dialog:map-backgrounds"] .dlg-buttons button')?.click();
    Object.assign(app.runMode.caps, { fsaSave: false });
    return out;
  }, { B05, cp });
  expect(r.depth.type).toBe('Depth');
  expect(Math.abs(r.depth.value - (cp.hae - B05.roofCentre.hae))).toBeLessThan(0.5);
  expect(r.depth.tag).toMatch(/below the reference/);
  const box = B05.sizeM[0] * B05.sizeM[1] * B05.height;
  expect(Math.abs(r.volume.net - box) / box).toBeLessThan(0.1);
  expect(r.volume.logged).toBe('Volume');
  expect(r.volumeEnabled).toBe(true);
  expect(r.gpx).toMatchObject({ waypoints: 2, routes: 1, tracks: 2, layer: 'walk.gpx' });
  expect(Math.abs(r.gpx.hae)).toBeLessThan(0.01);
  expect(r.gpx.roofFromTerrain).toBeLessThan(0.5);
  expect(r.gpxOut.wpt).toBeGreaterThanOrEqual(2);
  expect(r.gpxOut.rte).toBeGreaterThanOrEqual(3);
  expect(Math.abs(r.gpxOut.ele)).toBeLessThan(0.01);
  expect(r.routeTool).toBe('gps.route');
  expect(r.serial.x).toBeGreaterThan(0.5);
  expect(r.serial.y).toBeLessThan(-0.2);
  expect(r.serial.source).toBe('serial:text');
  expect(r.serial.bad).toBeNull();
  expect(r.ootf).toEqual({ z0: 11, z1: 12, z2: 11 });
  expect(r.bgDialog).toBe(true);
  // PRD-08: the GeoPDF snapshot carries the map frame's /VP /GEO measure.
  const [dl] = await Promise.all([page.waitForEvent('download'), frame.evaluate(() => window.gisworkbench.commands.run('snap.geopdf'))]);
  const pdf = readFileSync(await dl.path()).toString('latin1');
  expect(dl.suggestedFilename()).toBe('product-geo.pdf');
  expect(pdf).toMatch(/\/VP \[<< \/Type \/Viewport/);
  expect(pdf).toMatch(/\/Subtype \/GEO/);
  expect(pdf).toMatch(/\/EPSG 4326/);
  expect(logs).toEqual([]);
});

test('REQ-DEM-03 a terrain folder indexes elevation files by name and header and loads the DEM under new imagery', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const r = await frame.evaluate(async (dsm) => {
    const app = window.gisworkbench;
    const T = app.terrainFolder;
    const f = new File([Uint8Array.from(atob(dsm), (c) => c.charCodeAt(0))], 'fx02_dsm_truth.tif', { type: 'image/tiff' });
    const far = new File([new Uint8Array(16)], 'N10E010.hgt');
    const idx = await T.setFolder([f, far, new File(['x'], 'notes.txt')]);
    return { n: idx.length, names: idx.map((e) => e.path).sort(), dted: T.boundsFromName('dted/w117/n34.dt2'), bounds: idx.find((e) => e.path === 'fx02_dsm_truth.tif').bounds };
  }, b64(resolve(DIR, 'fx02_dsm_truth.tif')));
  expect(r.n).toBe(2);
  expect(r.names).toEqual(['N10E010.hgt', 'fx02_dsm_truth.tif']);
  expect(r.dted).toEqual({ south: 34, north: 35, west: -117, east: -116 });
  expect(Math.abs((r.bounds.south + r.bounds.north) / 2 - truth.origin.lat)).toBeLessThan(0.001);
  expect(Math.abs((r.bounds.west + r.bounds.east) / 2 - truth.origin.lon)).toBeLessThan(0.001);
  await openFiles(frame, [resolve(DIR, 'fx02_a.ntf')]);
  await frame.waitForFunction(() => window.gisworkbench.terrain.dems.length === 1 && window.gisworkbench.terrain.dems[0].vertical === 'hae', null, { timeout: 60000 });
  const after = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const d = app.terrain.dems[0];
    const l = app.layers.get(d.layerId);
    const img = [...app.layers.values()].find((x) => x.info.fileName === 'fx02_a.ntf');
    const g = img.groundWithTerrain(img.width / 2, img.height / 2);
    return { name: d.name, hidden: l.rec.visible === false, folder: l.rec.terrainFolder, source: g.heightSource, active: app.activePane().rec.activeLayer === img.id, loaded: [...app.terrainFolder.state.loaded] };
  });
  expect(after.hidden).toBe(true);
  expect(after.folder).toBeTruthy();
  expect(after.source).toMatch(/fx02_dsm_truth/);
  expect(after.active).toBe(true);
  expect(after.loaded).toEqual(['fx02_dsm_truth.tif']);
  expect(logs).toEqual([]);
});

test('REQ-STR-16 REQ-SNS-19 REQ-SNS-21 FX-02 epipolar pair rows agree; occlusion against the truth mask; true ortho; ORB recovers the pair', async ({ page }) => {
  // Occlusion truth posts: every hidden one and a sample of visible ones.
  const ob = readFileSync(resolve(DIR, 'fx02_occlusion_truth.tif'));
  const tif = await fromArrayBuffer(ob.buffer.slice(ob.byteOffset, ob.byteOffset + ob.length));
  const im = await tif.getImage();
  const [occ] = await im.readRasters();
  const [ox, oy] = im.getOrigin();
  const [rx, ry] = im.getResolution();
  const W = im.getWidth();
  const posts = [];
  for (let k = 0; k < occ.length; k++) {
    const i = k % W;
    const j = Math.floor(k / W);
    if (i < 20 || j < 20 || i > W - 20 || j > W - 20) continue;
    if (occ[k] || k % 331 === 0) posts.push([oy + (j + 0.5) * ry, ox + (i + 0.5) * rx, occ[k]]);
  }
  const { frame, logs } = await fx02(page, { both: true, dsm: true });
  const r = await frame.evaluate(async ({ posts, cps }) => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].filter((l) => /fx02_[ab]\.ntf/.test(l.info.fileName)).sort((a, b) => a.info.fileName.localeCompare(b.info.fileName));
    const [A, B] = ls;
    const out = {};
    // STR-16: export the pair over the view; checkpoints fall on the same output row in both.
    const p = app.activePane();
    const s = app.stereo.open(A, B, p);
    s.fitWhole?.();
    const e = await app.stereo.exportEpipolar({ p, maxSize: 1024 });
    const inv = (a, x, y) => {
      const d = a[1] * a[5] - a[2] * a[4];
      const u = x - a[0];
      const v = y - a[3];
      return [(a[5] * u - a[2] * v) / d, (-a[4] * u + a[1] * v) / d];
    };
    const rows = cps.map((c) => [inv(e.left.outputToImage, ...c.a), inv(e.right.outputToImage, ...c.b)]).filter(([l, rr]) => l[0] > 0 && l[1] > 0 && l[0] < e.width && l[1] < e.height && rr[0] > 0 && rr[0] < e.width);
    out.epi = { n: rows.length, maxRowDiff: Math.max(...rows.map(([l, rr]) => Math.abs(l[1] - rr[1]))), w: e.width, h: e.height, xpar: Math.max(...rows.map(([l, rr]) => Math.abs(l[0] - rr[0]))) };
    const { layers } = await (async () => {
      const before = new Set(app.layers.keys());
      await app.openFiles([new File([e.left.bytes], e.left.name, { type: 'image/tiff' })], p);
      return { layers: [...app.layers.values()].filter((l) => !before.has(l.id)) };
    })();
    out.epiLayer = { model: layers[0]?.modelName, desc: JSON.parse(layers[0]?.info.meta?.imageDescription ?? '{}').epipolar ?? null };
    app.stereo.close(p);
    // SNS-19: visibility against the truth (hidden from A or from B).
    const dsm = app.terrain.dems[0];
    const fp = (l) => {
      const f = l.footprint();
      return { north: Math.max(...f.map((q) => q[0])), south: Math.min(...f.map((q) => q[0])), west: Math.min(...f.map((q) => q[1])), east: Math.max(...f.map((q) => q[1])) };
    };
    const box = { north: dsm.bounds.north, south: dsm.bounds.south, west: dsm.bounds.west, east: dsm.bounds.east };
    void fp;
    const va = app.ortho.visibility(A, dsm, box);
    const vb = app.ortho.visibility(B, dsm, box);
    let tp = 0;
    let fn = 0;
    let fpos = 0;
    let tn = 0;
    for (const [lat, lon, o] of posts) {
      const hid = va.hidden(lat, lon) || vb.hidden(lat, lon);
      if (o && hid) tp++;
      else if (o) fn++;
      else if (hid) fpos++;
      else tn++;
    }
    out.occ = { recall: tp / (tp + fn), falsePos: fpos / (fpos + tn), hidden: tp + fn, visible: fpos + tn };
    const t = await app.ortho.trueOrtho([A, B], { res: 1 });
    out.true = { holes: t.stats.holeFraction, occludedA: t.stats.images[0].occluded, fromB: t.stats.images[1].used, w: t.grid.w };
    // SNS-21: ORB on overviews, no sensor model; then tie points through the descriptor path.
    const d = await app.tri.descriptorAffine(A, B);
    const errs = cps.map((c) => {
      const q = [d.T[0] + d.T[1] * c.a[0] + d.T[2] * c.a[1], d.T[3] + d.T[4] * c.a[0] + d.T[5] * c.a[1]];
      return Math.hypot(q[0] - c.b[0], q[1] - c.b[1]);
    }).sort((x, y) => x - y);
    out.orb = { inliers: d.inliers, median: errs[Math.floor(errs.length / 2)] };
    const tie = await app.tri.autoTiePoints({ layers: [A, B], matcher: 'orb' });
    const pts = app.store.all('tripoint').filter((x) => x.matcher === 'ORB + NCC/LSM');
    const dev = pts.map((x) => {
      const pa = x.obs[A.id];
      const pb = x.obs[B.id];
      const g = A.groundWithTerrain(pa.x, pa.y);
      const q = B.imageAt(g.lat, g.lon, g.h);
      return Math.hypot(q.x - pb.x, q.y - pb.y);
    }).sort((x, y) => x - y);
    out.ties = { ...tie, n: pts.length, median: dev[Math.floor(dev.length / 2)] };
    return out;
  }, { posts, cps: truth.checkpoints });
  console.log(JSON.stringify(r));
  expect(r.epi.n).toBeGreaterThanOrEqual(10);
  expect(r.epi.maxRowDiff).toBeLessThan(0.75);
  expect(r.epiLayer.model).toMatch(/GCP/);
  expect(r.epiLayer.desc).toBe('left');
  expect(r.occ.hidden).toBeGreaterThan(1000);
  expect(r.occ.recall).toBeGreaterThanOrEqual(0.95);
  expect(r.occ.falsePos).toBeLessThan(0.005);
  expect(r.true.holes).toBeLessThan(0.01);
  expect(r.true.occludedA).toBeGreaterThan(0);
  expect(r.true.fromB).toBeGreaterThan(0);
  expect(r.orb.inliers).toBeGreaterThanOrEqual(20);
  expect(r.orb.median).toBeLessThan(25);
  expect(r.ties.descriptorPairs).toBe(1);
  expect(r.ties.n).toBeGreaterThanOrEqual(5);
  expect(r.ties.median).toBeLessThan(2);
  expect(logs).toEqual([]);
});

/** A BPF v3 file: UTM zone 11N, dims X, Y, Z, Classification; interleave 0 or 1, zlib optional. */
function bpf(points, { interleave = 0, zlib = false } = {}) {
  const nd = 4;
  const labels = ['X', 'Y', 'Z', 'Classification'];
  const off = [500000, 3800000, 0, 0];
  const n = points.length;
  const hdrLen = 176 + 24 * nd + 32 * nd;
  const h = Buffer.alloc(hdrLen);
  h.write('BPF!', 0);
  h.write('0003', 4);
  h.writeInt32LE(hdrLen, 8);
  h.writeUInt8(nd, 12);
  h.writeUInt8(interleave, 13);
  h.writeUInt8(zlib ? 1 : 0, 14);
  h.writeInt32LE(n, 16);
  h.writeInt32LE(1, 20);
  h.writeInt32LE(11, 24);
  h.writeFloatLE(1, 28);
  for (let k = 0; k < 16; k++) h.writeDoubleLE(k % 5 === 0 ? 1 : 0, 32 + 8 * k);
  for (let d = 0; d < nd; d++) {
    h.writeDoubleLE(off[d], 176 + 8 * d);
    h.writeDoubleLE(Math.min(...points.map((p) => p[d])), 176 + 8 * (nd + d));
    h.writeDoubleLE(Math.max(...points.map((p) => p[d])), 176 + 8 * (2 * nd + d));
    h.write(labels[d], 176 + 24 * nd + 32 * d);
  }
  const data = Buffer.alloc(4 * n * nd);
  points.forEach((p, k) => {
    for (let d = 0; d < nd; d++) data.writeFloatLE(p[d] - off[d], 4 * (interleave === 0 ? d * n + k : k * nd + d));
  });
  if (!zlib) return Buffer.concat([h, data]);
  const z = deflateSync(data);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(data.length, 0);
  bh.writeUInt32LE(z.length, 4);
  return Buffer.concat([h, bh, z]);
}

test('REQ-LDR-11 BPF (dimension- and point-major, zlib) and ASCII points agree; the DSM of Difference finds a 3 m rise over 100 m²; the block is extracted as a building', async ({ page }) => {
  const pts = [];
  for (let j = 0; j < 60; j++) for (let i = 0; i < 60; i++) pts.push([500100 + i * 0.5 + 0.25, 3800100 + j * 0.5 + 0.25, 600 + 0.01 * i, 2]);
  const later = pts.map(([x, y, z, c]) => (x > 500110 && x < 500120 && y > 3800110 && y < 3800120 ? [x, y, z + 3, 6] : [x, y, z, c]));
  const ascii = `x,y,z,class\n${pts.map((p) => p.map((v, k) => (k < 2 ? v.toFixed(3) : String(v))).join(',')).join('\n')}\n`;
  const files = { a: bpf(pts).toString('base64'), b: bpf(later, { interleave: 1, zlib: true }).toString('base64'), txt: Buffer.from(ascii).toString('base64') };
  const { frame, logs } = await openApp(page, 'file');
  const r = await frame.evaluate(async (files) => {
    const app = window.gisworkbench;
    const f = (b, n) => new File([Uint8Array.from(atob(b), (c) => c.charCodeAt(0))], n);
    const [a] = await app.openPointClouds([f(files.a, 'before.bpf')]);
    const [b] = await app.openPointClouds([f(files.b, 'after.bpf')]);
    const t = await app.pc.open(f(files.txt, 'before.xyz'), app.activePane(), { ascii: { columns: { x: 0, y: 1, z: 2, class: 3 }, skip: 1, epsg: 32611 } });
    // Same points through BPF and ASCII: compare geographic positions of the same file index.
    const geoOf = (c, k) => {
      const i = [...c.order].indexOf(k);
      return app.pc.toGeo(c, c.pos[3 * i], c.pos[3 * i + 1], c.pos[3 * i + 2]);
    };
    let worst = 0;
    for (const k of [0, 1234, 3599]) {
      const p = geoOf(a, k);
      const q = geoOf(t, k);
      worst = Math.max(worst, Math.abs(p.lat - q.lat) * 111000, Math.abs(p.lon - q.lon) * 92000, Math.abs(p.hae - q.hae));
    }
    const d = await app.pc.dod(a, b, { cell: 1, threshold: 1 });
    // Buildings from points: the raised 10 m × 10 m block in the later cloud.
    const ex = await app.pc.extractFromPoints(b, { cell: 0.5 });
    const bl = app.store.all('feature').filter((x) => x.vlayer === ex.buildingLayer);
    return { n: [a.n, b.n, t.n], classes: b.stats.classes, crs: a.crs.label, format: a.info.format, worst, dod: d.stats, buildings: ex.buildings, hgt: bl[0]?.attrs?.HGT };
  }, files);
  expect(r.n).toEqual([3600, 3600, 3600]);
  expect(r.classes).toEqual({ 2: 3200, 6: 400 });
  expect(r.crs).toMatch(/32611/);
  expect(r.format).toBe('BPF 3');
  expect(r.worst).toBeLessThan(0.01);
  expect(Math.abs(r.dod.raisedM2 - 100)).toBeLessThanOrEqual(25);
  expect(r.dod.loweredM2).toBe(0);
  expect(r.buildings).toBe(1);
  expect(Math.abs(r.hgt - 3)).toBeLessThan(0.5);
  expect(logs).toEqual([]);
});
