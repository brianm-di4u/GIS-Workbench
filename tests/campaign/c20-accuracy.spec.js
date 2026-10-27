// TE-C20 Phase 3 accuracy — geolocation of every corpus raster against independent oracles:
//  • RPC models (NITF RPC00B, GeoTIFF RPC tag, .RPB) vs GDAL's RPC transformer on a 3×3 grid at
//    three heights (oracles/raster.py rpcGrid);
//  • map models (geotransform + CRS, GeoJP2/GMLJP2, world files) vs GDAL's corner coordinates;
//  • SICD models vs NGA sarpy image→ground on a 5×5 grid at the SCP height (oracles/sar.py).
// Image coordinates: the app and GDAL both put the first pixel's corner at (0, 0); sarpy indexes
// pixel centres, so its (row, col) is the app's (col + 0.5, row + 0.5).
// REQ-SNS-02/03/06, REQ-GEO-01, REQ-SAR-05, REQ-FMT-04, AT-03.x, AT-12.3, REQ-MEN-01.
import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { openApp, openFiles, settledAny, record, manifest, paths, truth } from './helpers.js';

const metres = (a, b) => {
  // Small-distance geodesic on WGS 84 (adequate below 10 km for a tolerance check).
  const R = 6378137;
  const dl = ((b.lat - a.lat) * Math.PI) / 180;
  const dn = ((b.lon - a.lon) * Math.PI) / 180;
  const m = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return R * Math.hypot(dl, dn * m);
};

// Files refused by name in c01 open no layer to geolocate (none at present; IMP-11 and IMP-16 closed).
const REFUSED = /^$/;
const cases = [];
for (const it of manifest.items) {
  if (it.area === 'robustness') continue; // malformed on purpose: c01 checks they fail by name
  const t = truth(it.id);
  if (!t?.files) continue;
  for (const [name, f] of Object.entries(t.files)) {
    if (f.error || REFUSED.test(name)) continue;
    const prim = paths(it, ['primary']).find((p) => p.split(/[\\/]/).pop() === name);
    if (!prim) continue;
    const side = paths(it, ['sidecar']).filter((s) => s.split(/[\\/]/).pop().toLowerCase().startsWith(name.replace(/\.[^.]+$/, '').toLowerCase() + '.'));
    if (Array.isArray(f.rpcGrid) && f.rpcGrid.length) cases.push({ kind: 'rpc', it, name, files: [prim, ...side], pts: f.rpcGrid });
    // GPKG tile sets: corner to corner (pixel grids differ by design); GDAL's 1×1 view of a set whose
    // contents and tile matrix use different CRSs (TE-027) is no oracle.
    else if (f.kind === 'raster' && f.driver === 'GPKG' && f.corners && f.width * f.height > 1) cases.push({ kind: 'tiles', it, name, files: [prim], f });
    else if (f.kind === 'raster' && f.corners && !f.rpc && f.driver !== 'PDF' && !f.subdatasets && f.driver !== 'GPKG') cases.push({ kind: 'map', it, name, files: [prim, ...side], f });
    if (f.kind === 'sar' && f.images?.[0]?.grid5) cases.push({ kind: 'sicd', it, name, files: [prim], img: f.images[0] });
  }
}

test.describe.configure({ mode: 'parallel' });

for (const c of cases) {
  test(`TE-C20 REQ-SNS-06 ${c.kind === 'rpc' ? 'REQ-SNS-02 ' : ''}${c.files.some((f) => /\.rpb$/i.test(f)) ? 'REQ-SNS-22 ' : ''}${/\.jp2$/i.test(c.name) ? 'REQ-FMT-18 ' : ''}${c.kind} geolocation ${c.it.id}/${c.name}`, async ({ page }, info) => {
    test.skip(!c.files.every(existsSync), 'not on disk');
    const { frame, logs } = await openApp(page, 'file');
    await openFiles(frame, c.files);
    await settledAny(frame);
    let pts;
    let gsd = null;
    if (c.kind === 'rpc') pts = c.pts.map((p) => ({ x: p.x, y: p.y, h: p.h, lat: p.lat, lon: p.lon }));
    else if (c.kind === 'tiles') {
      const k = c.f.corners;
      pts = [k.ul, k.ur, k.lr, k.ll].map((q, i) => ({ fx: [0, 1, 1, 0][i], fy: [0, 0, 1, 1][i], h: 0, ...ll(q) }));
      gsd = Math.abs(c.f.geotransform[1]) * (Math.abs(c.f.geotransform[1]) < 0.1 || /4326/.test(c.f.epsg ?? '') ? 111320 : 1);
    } else if (c.kind === 'map') {
      // NAD83 files: GDAL's corners on their own datum, which the app equates with WGS 84 (IMP-12),
      // so a NAD83 → WGS 84 transformation choice (~0.15 m here) is not scored as error.
      const { width: W, height: H, geotransform: gt } = c.f;
      const k = c.f.cornersNative ?? c.f.corners;
      pts = [
        { x: 0, y: 0, ...ll(k.ul) },
        { x: W, y: 0, ...ll(k.ur) },
        { x: W, y: H, ...ll(k.lr) },
        { x: 0, y: H, ...ll(k.ll) },
        { x: W / 2, y: H / 2, ...ll(k.c) },
      ].map((p) => ({ ...p, h: 0 }));
      // Pixel size in metres (geographic pixel sizes converted at the centre latitude).
      const geo = Math.abs(gt[1]) < 0.1;
      gsd = geo ? Math.abs(gt[1]) * 111320 * Math.cos((k.c[0] * Math.PI) / 180) : Math.abs(gt[1]);
    } else {
      const scpH = c.img.scp[2];
      pts = c.img.grid5.pixels.map(([row, col], i) => ({ x: col + 0.5, y: row + 0.5, h: scpH, lat: c.img.grid5.llh[i][0], lon: c.img.grid5.llh[i][1] }));
    }
    const got = await frame.evaluate(({ pp, kind }) => {
      const a = window.gisworkbench;
      const l = [...a.layers.values()].find((x) => x.modelId && !x.error);
      if (!l) return { error: 'no layer with a sensor model' };
      // RPC: ground → image is the model's own exact direction; compare in pixels (no iteration on
      // either side). Others: image → ground in metres.
      if (kind === 'rpc' && /RPC/.test(l.modelName ?? ''))
        return { model: l.modelName, px: pp.map((p) => { try { const q = a.core.g2i(l.modelId, p.lat, p.lon, p.h); return Math.hypot(q.x - p.x, q.y - p.y); } catch (e) { return Infinity; } }) };
      return { model: l.modelName ?? null, out: pp.map((p) => { try { return a.core.i2g(l.modelId, p.fx !== undefined ? p.fx * l.width : p.x, p.fy !== undefined ? p.fy * l.height : p.y, p.h); } catch (e) { return { error: e.message }; } }) };
    }, { pp: pts, kind: c.kind });
    let errs = [];
    let max = Infinity;
    let tol;
    if (got.px) {
      errs = got.px;
      max = Math.max(...errs);
      tol = 0.01; // pixels: both evaluate the same rational polynomials
    } else {
      errs = got.out ? got.out.map((g, i) => (g.error ? Infinity : metres(g, pts[i]))) : [];
      max = errs.length ? Math.max(...errs) : Infinity;
      // SICD: same equations — 5 cm; map models through a fitted CRS polynomial — a tenth of a pixel, at least 5 cm.
      tol = c.kind === 'map' ? Math.max(0.05, 0.1 * (gsd ?? 1)) : c.kind === 'tiles' ? 0.5 * gsd : 0.05;
      // Corner-only (IGEOLO) models are labelled approximate: 1.5 pixels (their four corners agree
      // exactly; the interior depends on how the quadrilateral is interpolated).
      if (/approximate/.test(got.model ?? '')) tol = Math.max(0.05, 1.5 * (gsd ?? 1));
    }
    record('c20-accuracy', info.project.name, { key: `${c.kind}-${c.it.id}/${c.name}`, kind: c.kind, model: got.model, error: got.error ?? null, unit: got.px ? 'px' : 'm', maxErrM: max, tolM: tol, gsd, errs });
    expect(logs).toEqual([]);
    expect(got.error ?? null, 'layer has a model').toBeNull();
    // A map-projected product that also carries RPCs (e.g. SpaceNet ortho tiles) rightly prefers its map model.
    if (c.kind === 'rpc' && !/RPC/.test(got.model ?? '')) test.skip(true, `active model is ${got.model} (ortho product); the RPC describes the source geometry`);
    if (c.kind === 'sicd') expect(got.model, 'the SICD model is active').toMatch(/SICD/);
    expect(max, `max geolocation difference vs oracle (${got.px ? 'px' : 'm'}), model ${got.model}`).toBeLessThanOrEqual(tol);
  });
}

function ll(latlon) {
  return { lat: latlon[0], lon: latlon[1] };
}
