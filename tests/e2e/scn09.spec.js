// SCN-09 (orthorectification and orthomosaic) on FX-04 with the FX-05 terrain, after the
// SCN-06 triangulation: checkpoint RMSE and CE90 of an ortho (AT-09.1), the checkpoint crosses
// found in the ortho, the COG structure (AT-09.3), roads continuous across mosaic seams (AT-09.2)
// and a seam edit that re-blends only the tiles it touches, quickly (AT-09.4).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx04');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx04_truth.json'), 'utf8'));
const GSD = truth.gsd;

test('SCN-09 REQ-SNS-17 REQ-SNS-18 FX-04/FX-05 ortho accuracy, COG structure, seams and seam edits', async ({ page }) => {
  test.setTimeout(420000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [...truth.images.map((i) => resolve(DIR, i.file)), resolve('fixtures/fx05/fx05_dem_hae.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length === 5, null, { timeout: 60000 });
  const csv = readFileSync(resolve(DIR, 'fx04_control.csv'), 'utf8');
  const r = await frame.evaluate(
    async ({ csv, truth }) => {
      const app = window.gisworkbench;
      const dem = [...app.layers.values()].find((l) => /fx05/i.test(l.rec.name));
      await app.useAsTerrain(dem, 'hae');
      const T = app.tri;
      T.importControl(csv);
      const byIid = new Map(T.blockLayers().map((l) => [l.info.iid, l]));
      const pts = new Map(T.points().map((p) => [p.name, p]));
      for (const im of truth.images) for (const o of im.control) T.measure(pts.get(o.id).id, byIid.get(im.id).id, o.x, o.y);
      await T.autoTiePoints();
      T.applySolution(await T.solve({ kind: 'shift' }));
      // AT-09.1: ortho of IMG1, checkpoint accuracy.
      const l1 = byIid.get('IMG1');
      const o = await app.ortho.orthorectify(l1, { res: 0.5 });
      const acc = app.ortho.accuracy(l1, o.grid);
      // The checkpoint crosses in the ortho: NCC of a synthetic cross template around the truth.
      const G = o.grid;
      const crossFound = [];
      for (const c of truth.control.filter((q) => q.kind === 'checkpoint')) {
        const u = app.core.utm(c.lat, c.lon, G.zone);
        const cx = (u.easting - G.e0) / G.res;
        const cy = (G.n0 - u.northing) / G.res;
        let best = null;
        for (let dy = -6; dy <= 6; dy += 0.5)
          for (let dx = -6; dx <= 6; dx += 0.5) {
            // Score: brightness along the cross arms minus the dark backing square.
            let s = 0;
            for (let t = -14; t <= 14; t++) {
              const a = o.bands[0][Math.round(cy + dy) * G.w + Math.round(cx + dx + t)];
              const b = o.bands[0][Math.round(cy + dy + t) * G.w + Math.round(cx + dx)];
              s += (a || 0) + (b || 0);
            }
            if (!best || s > best.s) best = { s, dx, dy };
          }
        crossFound.push(Math.hypot(best.dx, best.dy) * G.res);
      }
      // AT-09.3: COG structure.
      const bytes = await app.ortho.cogOf(o);
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const rd = (ifd) => {
        const n = dv.getUint16(ifd, true);
        const tags = {};
        for (let t = 0; t < n; t++) {
          const p = ifd + 2 + t * 12;
          const tag = dv.getUint16(p, true);
          const type = dv.getUint16(p + 2, true);
          const cnt = dv.getUint32(p + 4, true);
          const sz = { 3: 2, 4: 4, 12: 8 }[type] ?? 1;
          const off = cnt * sz > 4 ? dv.getUint32(p + 8, true) : p + 8;
          tags[tag] = Array.from({ length: Math.min(cnt, 64) }, (_, k) => (type === 3 ? dv.getUint16(off + 2 * k, true) : type === 4 ? dv.getUint32(off + 4 * k, true) : type === 12 ? dv.getFloat64(off + 8 * k, true) : dv.getUint8(off + k)));
        }
        return { tags, next: dv.getUint32(ifd + 2 + n * 12, true) };
      };
      const ifds = [];
      let p = dv.getUint32(4, true);
      while (p) {
        const x = rd(p);
        ifds.push({ off: p, ...x });
        p = x.next;
      }
      const firstTile = ifds.map((f) => f.tags[324]?.[0]);
      const cog = {
        ifds: ifds.length,
        tiled: ifds.every((f) => f.tags[322] && f.tags[323]),
        ifdsBeforeData: Math.max(...ifds.map((f) => f.off)) < Math.min(...firstTile),
        mainFirst: ifds.every((f, k) => !k || f.tags[256][0] < ifds[k - 1].tags[256][0]),
        overviewDataFirst: firstTile.every((t, k) => !k || t < firstTile[k - 1]),
        geoKeyHeader: ifds[0].tags[34735]?.slice(0, 3),
        projected: (ifds[0].tags[34735] ?? []).some((v, k) => k >= 4 && (k - 4) % 4 === 0 && v === 3072),
      };
      // Mosaic of the four images (AT-09.2): E–W roads crossing the seam between the west and east halves.
      const m = await app.ortho.mosaic(T.blockLayers(), { res: 0.5, feather: 8 });
      const MG = m.grid;
      const roadOffsets = [];
      for (const yRoad of [-200, 0, 200]) {
        // Road band y ∈ [yRoad, yRoad + 7] m (site ENU); its centre line.
        const off = [];
        for (const xSide of [-25, 25]) {
          const lat = 34.5 + (yRoad + 3.5) / 110940;
          const lon = -116.5 + xSide / (111320 * Math.cos((34.5 * Math.PI) / 180));
          const u = app.core.utm(lat, lon, MG.zone);
          const col = Math.round((u.easting - MG.e0) / MG.res);
          const rowT = (MG.n0 - u.northing) / MG.res;
          // Dark-band centroid along the column, ±12 m.
          let s = 0;
          let wsum = 0;
          for (let rr = Math.round(rowT - 24); rr <= Math.round(rowT + 24); rr++) {
            const v = m.bands[0][rr * MG.w + col];
            const wgt = Math.max(0, 90 - v);
            s += wgt * (rr + 0.5);
            wsum += wgt;
          }
          off.push((s / wsum - rowT) * MG.res);
        }
        roadOffsets.push(off);
      }
      // Labels on both sides of the seam really differ.
      const labelAt = (xSide) => {
        const lat = 34.5 + 100 / 110940;
        const lon = -116.5 + xSide / (111320 * Math.cos((34.5 * Math.PI) / 180));
        const u = app.core.utm(lat, lon, MG.zone);
        return m.labels[Math.round((MG.n0 - u.northing) / MG.res) * MG.w + Math.round((u.easting - MG.e0) / MG.res)];
      };
      await app.ortho.openProduct(m, 'ORTHOMOSAIC.tif');
      // AT-09.4: a seam edit 80 m across, given to another image.
      const c = { lat: 34.5 + 120 / 110940, lon: -116.5 - 120 / 92000 };
      const d = 40 / 110950;
      const e = 40 / 92000;
      const ring = [[c.lon - e, c.lat - d], [c.lon + e, c.lat - d], [c.lon + e, c.lat + d], [c.lon - e, c.lat + d]];
      const before = m.labels[0];
      const se = await app.ortho.seamEdit(m, ring, 3);
      return { acc, crossFound, ortho: { w: G.w, h: G.h, maxErr: o.stats.maxErrPx, worst: o.stats.worst, ms: o.stats.ms }, cog, roadOffsets, seamLabels: [labelAt(-25), labelAt(25)], mosaic: { w: MG.w, h: MG.h, ms: m.stats.ms, gains: m.gains }, se, before };
    },
    { csv, truth },
  );
  console.log(JSON.stringify(r));
  // AT-09.1
  expect(r.acc.n).toBeGreaterThanOrEqual(3);
  expect(r.acc.rmseR).toBeLessThanOrEqual(1.5 * GSD);
  expect(Number.isFinite(r.acc.rmseX) && Number.isFinite(r.acc.rmseY) && Number.isFinite(r.acc.ce90)).toBe(true);
  for (const d of r.crossFound) expect(d).toBeLessThanOrEqual(1.5 * GSD);
  expect(r.ortho.maxErr).toBeLessThanOrEqual(0.1);
  // AT-09.3
  expect(r.cog).toMatchObject({ tiled: true, ifdsBeforeData: true, mainFirst: true, overviewDataFirst: true, geoKeyHeader: [1, 1, 1], projected: true });
  expect(r.cog.ifds).toBeGreaterThan(1);
  // AT-09.2: road centres on both sides of the seam agree with the truth (and each other).
  expect(r.seamLabels[0]).not.toBe(r.seamLabels[1]);
  for (const [a, b] of r.roadOffsets) {
    expect(Math.abs(a)).toBeLessThanOrEqual(2 * GSD);
    expect(Math.abs(b)).toBeLessThanOrEqual(2 * GSD);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2 * GSD);
  }
  // AT-09.4
  expect(r.se.changed).toBeGreaterThan(1000);
  expect(r.se.tiles).toBeLessThan(r.se.of);
  expect(r.se.ms).toBeLessThan(5000);
  expect(logs).toEqual([]);
});
