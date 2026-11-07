// SCN-08 (DEM extraction and edit) on FX-02/FX-05: SGM terrain extraction from the FX-02 pair,
// checked against the truth DSM and occlusion mask (AT-08.1, AT-08.2), the SMRF ground filter;
// then DEM edits with undo (AT-08.3), the GeoTIFF and DTED writers (AT-08.4), the accuracy report
// (AT-08.5) and contour lines on FX-05.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx02');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx02_truth.json'), 'utf8'));
const GSD = truth.gsd;

async function raster(file) {
  const b = readFileSync(resolve(DIR, file));
  const t = await fromArrayBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const im = await t.getImage();
  const [x0, y0] = im.getOrigin();
  const [dx, dy] = im.getResolution();
  const [band] = await im.readRasters();
  return { w: im.getWidth(), h: im.getHeight(), x0, y0, dx, dy, v: band };
}

test('SCN-08 REQ-DEM-04 REQ-DEM-06 REQ-DEM-07 FX-02 SGM DSM: flat RMSE, box tops, figure of merit, ground filter', async ({ page }) => {
  test.setTimeout(420000);
  const dsmT = await raster('fx02_dsm_truth.tif');
  const occT = await raster('fx02_occlusion_truth.tif');
  const at = (r, i, j) => ({ lat: r.y0 + (j + 0.5) * r.dy, lon: r.x0 + (i + 0.5) * r.dx });
  // Flat-area truth posts (every 2nd post within the circles), occluded posts.
  const flat = [];
  for (const a of truth.flatAreas) {
    for (let j = 0; j < dsmT.h; j += 2)
      for (let i = 0; i < dsmT.w; i += 2) {
        const p = at(dsmT, i, j);
        const dn = (p.lat - a.centre.lat) * 110940;
        const de = (p.lon - a.centre.lon) * 111320 * Math.cos((a.centre.lat * Math.PI) / 180);
        if (Math.hypot(de, dn) <= a.radiusM - 5) flat.push({ ...p, h: dsmT.v[j * dsmT.w + i] });
      }
  }
  const occluded = [];
  for (let j = 0; j < occT.h; j++) for (let i = 0; i < occT.w; i++) if (occT.v[j * occT.w + i]) occluded.push(at(occT, i, j));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, truth.images.map((i) => resolve(DIR, i.file)));
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 2, null, { timeout: 60000 });
  const r = await frame.evaluate(
    async ({ flat, occluded, boxes }) => {
      const app = window.gisworkbench;
      const ls = [...app.layers.values()].sort((a, b) => String(a.info.iid).localeCompare(String(b.info.iid)));
      const dsm = await app.extractDsm(ls[0], ls[1], { hMin: 680, hMax: 760 });
      const g = dsm.grid;
      const post = (lat, lon) => {
        const ix = Math.round((lon - g.lon0) / g.dlon);
        const iy = Math.round((g.lat0 - lat) / g.dlat);
        return ix >= 0 && iy >= 0 && ix < g.nx && iy < g.ny ? iy * g.nx + ix : -1;
      };
      let ss = 0;
      let n = 0;
      for (const p of flat) {
        const i = post(p.lat, p.lon);
        if (i < 0 || !Number.isFinite(dsm.heights[i])) continue;
        ss += (dsm.heights[i] - p.h) ** 2;
        n++;
      }
      let flagged = 0;
      let occN = 0;
      for (const p of occluded) {
        const i = post(p.lat, p.lon);
        if (i < 0) continue;
        occN++;
        if (dsm.fom[i] < 4) flagged++;
      }
      // Box tops: posts inside each footprint shrunk by 1.5 m.
      let topN = 0;
      let topOk = 0;
      for (const b of boxes) {
        const cl = b.footprint.reduce((a, q) => a + q.lat, 0) / 4;
        const co = b.footprint.reduce((a, q) => a + q.lon, 0) / 4;
        for (let k = 0; k < 400; k++) {
          const s = (k % 20) / 19 - 0.5;
          const t = Math.floor(k / 20) / 19 - 0.5;
          const shrink = (q) => ({ lat: cl + (q.lat - cl) * (1 - 3 / Math.min(...b.sizeM)), lon: co + (q.lon - co) * (1 - 3 / Math.min(...b.sizeM)) });
          const [p0, p1, , p3] = b.footprint.map(shrink);
          const lat = p0.lat + (p1.lat - p0.lat) * (s + 0.5) + (p3.lat - p0.lat) * (t + 0.5);
          const lon = p0.lon + (p1.lon - p0.lon) * (s + 0.5) + (p3.lon - p0.lon) * (t + 0.5);
          const i = post(lat, lon);
          if (i < 0) continue;
          topN++;
          if (Number.isFinite(dsm.heights[i]) && Math.abs(dsm.heights[i] - b.topHae) <= 1.5) topOk++;
        }
      }
      const saved = await app.saveDsmLayer(dsm);
      // REQ-DEM-07: the SMRF ground filter removes the boxes (the DTM at a roof is the ground).
      const gf = await app.groundFilter({ maxWindowM: 50, slope: 0.15, height: 0.5 }, app.terrain.entry(saved.layer.id));
      const dtmErr = boxes.map((b) => app.core.demHae(app.terrain.entry(gf.layer.id).coreId, b.roofCentre.lat, b.roofCentre.lon) - b.baseHae);
      return { dtmErr, groundFraction: gf.groundFraction, stats: dsm.stats, rmse: Math.sqrt(ss / Math.max(1, n)), n, flatN: flat.length, occN, flagged, topN, topOk, layer: saved.layer.rec.name, terrain: app.terrain.available, sample: app.core.demHae(app.terrain.entry(saved.layer.id).coreId, boxes[0].roofCentre.lat, boxes[0].roofCentre.lon) };
    },
    { flat, occluded, boxes: truth.boxes },
  );
  console.log(JSON.stringify(r));
  // AT-08.1
  expect(r.n).toBeGreaterThan(0.9 * r.flatN);
  expect(r.rmse).toBeLessThanOrEqual(1.5 * GSD);
  expect(r.topOk / r.topN).toBeGreaterThanOrEqual(0.9);
  // AT-08.2
  expect(r.flagged / r.occN).toBeGreaterThanOrEqual(0.95);
  // REQ-DEM-07
  for (const e of r.dtmErr) expect(Math.abs(e)).toBeLessThan(1.5);
  // The product is terrain (HAE).
  expect(r.terrain).toBe(true);
  expect(Math.abs(r.sample - truth.boxes[0].topHae)).toBeLessThan(1.5);
  expect(logs).toEqual([]);
});

/** FX-05 analytic terrain (build/fixtures/site.mjs). */
function terrain(lat, lon) {
  const x = (lon + 116.5) * 111320 * Math.cos((34.5 * Math.PI) / 180);
  const y = (lat - 34.5) * 110940;
  const a = (25 * Math.PI) / 180;
  const u = x * Math.cos(a) + y * Math.sin(a);
  const v = -x * Math.sin(a) + y * Math.cos(a);
  let hh = 650 + 0.01 * x + 60 * Math.exp(-(((u - 300) / 150) ** 2)) - 30 * Math.exp(-(((v + 400) / 120) ** 2));
  const r = Math.hypot(x + 300, y - 300);
  if (r <= 150) hh = 640;
  else if (r < 250) {
    const t = (r - 150) / 100;
    const s = t * t * (3 - 2 * t);
    hh = 640 * (1 - s) + hh * s;
  }
  return hh;
}

test('SCN-08 REQ-DEM-08 REQ-DEM-09 REQ-DEM-11 REQ-DEM-16 REQ-DEM-17 FX-05 edits with undo, writers, accuracy and contours', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx05/fx05_dem_hae.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const pts = [];
  for (let k = 0; k < 40; k++) {
    const lat = 34.5 + (((k * 7919) % 97) / 97 - 0.5) * 0.012;
    const lon = -116.5 + (((k * 104729) % 89) / 89 - 0.5) * 0.014;
    pts.push({ id: `CP${k + 1}`, lat, lon, h: terrain(lat, lon), vertical: 'hae', class: k % 4 === 0 ? 'vegetated' : 'bare' });
  }
  const r = await frame.evaluate(async (pts) => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    await app.useAsTerrain(l, 'hae');
    const d = app.terrain.entry(l.id);
    const g = d.grid;
    const src = d.grid.heights.slice();
    const E = app.demEdit;
    // Accuracy of the unedited DEM: 20 then 40 checkpoints.
    const few = app.demAccuracy(pts.slice(0, 20), d);
    const all = app.demAccuracy(pts, d);
    // A ring on the ridge flank (sloping ground), 120 m across.
    const c = { lat: 34.5025, lon: -116.4985 };
    const dl = 60 / 110950;
    const dn = 60 / 92000;
    const ring = [[c.lon - dn, c.lat - dl], [c.lon + dn, c.lat - dl], [c.lon + dn, c.lat + dl], [c.lon - dn, c.lat + dl]];
    await E.edit('plane', { ring });
    const H = E.heightsOf(d);
    const inside = [];
    for (let j = 0; j < g.height; j++)
      for (let i = 0; i < g.width; i++) {
        const lat = g.lat0 - j * g.dlat;
        const lon = g.lon0 + i * g.dlon;
        if (lat > c.lat - dl * 0.98 && lat < c.lat + dl * 0.98 && lon > c.lon - dn * 0.98 && lon < c.lon + dn * 0.98) inside.push({ i, j, k: j * g.width + i });
      }
    // Residual to a plane refitted (least squares) on the edited posts inside the ring.
    const n = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const rv = [0, 0, 0];
    for (const q of inside) {
      const row = [1, q.i, q.j];
      for (let a = 0; a < 3; a++) {
        rv[a] += row[a] * H[q.k];
        for (let b = 0; b < 3; b++) n[a][b] += row[a] * row[b];
      }
    }
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const cr = (k) => det(n.map((row, i) => row.map((x, j) => (j === k ? rv[i] : x))));
    const D = det(n);
    const pl = [cr(0) / D, cr(1) / D, cr(2) / D];
    const planeResidual = Math.max(...inside.map((q) => Math.abs(H[q.k] - (pl[0] + pl[1] * q.i + pl[2] * q.j))));
    const changed = inside.filter((q) => H[q.k] !== src[q.k]).length;
    // Undo restores the posts exactly.
    app.undo.undo();
    await E.sync();
    const H2 = E.heightsOf(d);
    const restored = inside.every((q) => H2[q.k] === src[q.k]);
    // Other edits: raise with feather, a spike then despike, lake fill.
    await E.edit('raise', { ring, dh: 3, feather: 20 });
    const raised = E.heightsOf(d)[inside[10].k] - src[inside[10].k];
    await E.edit('post', { lat: c.lat, lon: c.lon, h: 900 });
    await E.edit('despike', { ring, threshold: 5 });
    const pc = Math.round((g.lat0 - c.lat) / g.dlat) * g.width + Math.round((c.lon - g.lon0) / g.dlon);
    const despiked = E.heightsOf(d)[pc];
    await E.edit('lake', { ring });
    const lakeVals = new Set(inside.map((q) => E.heightsOf(d)[q.k]));
    const logLen = E.log(d).length;
    // GeoTIFF/COG: the VerticalCSTypeGeoKey (4096) in the GeoKey directory.
    const tif = await app.demGeoTiff(d);
    const dv = new DataView(tif.buffer, tif.byteOffset, tif.byteLength);
    const le = dv.getUint16(0, true) === 0x4949;
    const ifd = dv.getUint32(4, le);
    const nTags = dv.getUint16(ifd, le);
    let keys = null;
    for (let t = 0; t < nTags; t++) {
      const o = ifd + 2 + t * 12;
      if (dv.getUint16(o, le) === 34735) {
        const cnt = dv.getUint32(o + 4, le);
        const off = dv.getUint32(o + 8, le);
        keys = Array.from({ length: cnt }, (_, k) => dv.getUint16(off + 2 * k, le));
      }
    }
    let vval = null;
    if (keys) for (let k = 4; k < keys.length; k += 4) if (keys[k] === 4096) vval = keys[k + 3];
    // DTED Level 2, cell N34 W117 (zone I: 3601 × 3601 posts).
    const dted = app.demDted(2, d).find((x) => x.name === 'w117_n34.dt2');
    const tb = dted.bytes;
    const txt = (o, len) => String.fromCharCode(...tb.slice(o, o + len));
    const recLen = 8 + 2 * 3601 + 4;
    let sum = 0;
    for (let k = 3428; k < 3428 + recLen - 4; k++) sum = (sum + tb[k]) >>> 0;
    const dvd = new DataView(tb.buffer, tb.byteOffset, tb.byteLength);
    const ck = dvd.getUint32(3428 + recLen - 4, false);
    const pLat = 34.5;
    const pLon = -116.5;
    const col = Math.round((pLon + 117) * 3600);
    const row = Math.round((pLat - 34) * 3600);
    const raw = dvd.getUint16(3428 + col * recLen + 8 + 2 * row, false);
    const dtedMsl = raw & 0x8000 ? -(raw & 0x7fff) : raw;
    const demMsl = app.core.demHae(d.coreId, pLat, pLon) - app.core.undulation(pLat, pLon);
    // Contours.
    const ct = app.contourLines(10);
    const feats = app.store.all('feature').filter((f) => f.vlayer === ct.layer);
    return {
      planeResidual, changed, restored, raised, despiked, lakeSize: lakeVals.size, logLen, vval,
      dted: { uhl: txt(0, 4), dsi: txt(80, 4), acc: txt(728, 3), size: tb.byteLength, expect: 3428 + recLen * 3601, ck, sum, lonN: txt(47, 4), latN: txt(51, 4), dtedMsl, demMsl },
      few: { warnings: few.warnings, n: few.total.n },
      all: { warnings: all.warnings, total: all.total, nva: all.nva?.n, vva: all.vva?.n, statement: all.statement },
      contours: { lines: ct.lines, index: ct.index, z: feats[0]?.geom.xyz[2], labelled: feats.filter((f) => f.attrs.INDEX).length },
    };
  }, pts);
  console.log(JSON.stringify(r));
  // AT-08.3
  expect(r.changed).toBeGreaterThan(100);
  expect(r.planeResidual).toBeLessThan(1e-3);
  expect(r.restored).toBe(true);
  // REQ-DEM-09
  expect(Math.abs(r.raised - 3)).toBeLessThan(1e-4);
  expect(r.despiked).toBeLessThan(800);
  expect(r.lakeSize).toBe(1);
  expect(r.logLen).toBe(4);
  // AT-08.4: the GeoTIFF vertical key (5030 = WGS 84 ellipsoid); DTED records, checksum and posts.
  expect(r.vval).toBe(5030);
  expect(r.dted).toMatchObject({ uhl: 'UHL1', dsi: 'DSIU', acc: 'ACC', lonN: '3601', latN: '3601' });
  expect(r.dted.size).toBe(r.dted.expect);
  expect(r.dted.ck).toBe(r.dted.sum);
  expect(Math.abs(r.dted.dtedMsl - r.dted.demMsl)).toBeLessThanOrEqual(0.51);
  // AT-08.5 and REQ-DEM-17
  expect(r.few.warnings.join(' ')).toMatch(/at least 30/);
  expect(r.all.warnings).toEqual([]);
  expect(r.all.total.n).toBe(40);
  expect(r.all.total.rmse).toBeLessThan(0.5);
  expect(r.all.total.le90).toBeCloseTo(1.6449 * r.all.total.rmse, 6);
  expect(r.all.nva + r.all.vva).toBe(40);
  expect(r.all.statement).toMatch(/ASPRS/);
  // REQ-DEM-11
  expect(r.contours.lines).toBeGreaterThan(5);
  expect(r.contours.index).toBeGreaterThan(0);
  expect(r.contours.labelled).toBe(r.contours.index);
  expect(Number.isFinite(r.contours.z)).toBe(true);
  expect(logs).toEqual([]);
});
