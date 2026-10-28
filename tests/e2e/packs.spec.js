// Data packs (REQ-ARC-14): verification against pack.json and the build manifest, refusal of
// changed or foreign code, data-only foreign packs; the EGM2008 geoid pack; the HDF5 pack
// (REQ-MSI-02: EMIT and PRISMA layouts of FX-08); the PROJ pack (REQ-GEO-12: EPSG:31370).
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { openApp, openFiles } from './helpers.js';

const DIST = resolve('dist/packs');
const pk = (n) => resolve(DIST, readdirSync(DIST).find((f) => (n === 'ai' ? /^ai-\d/.test(f) : f.startsWith(`${n}-`))));
const TMP = resolve('fixtures/packs/tmp');
const sha = (b) => createHash('sha256').update(b).digest('hex');

test.describe.configure({ timeout: 300000 });

/** A copy of a pack with one entry changed (optionally with pack.json updated to match). */
function tampered(src, out, { fixJson = false, addJs = false } = {}) {
  const files = unzipSync(readFileSync(src));
  const pj = JSON.parse(strFromU8(files['pack.json']));
  const e = pj.entries.find((x) => x.kind === 'js') ?? pj.entries[0];
  const b = files[e.path].slice();
  b[Math.min(100, b.length - 1)] ^= 0x01;
  files[e.path] = b;
  if (fixJson) e.sha256 = sha(b);
  if (addJs) {
    files['extra.js'] = strToU8('globalThis.x = 1;');
    pj.entries.push({ path: 'extra.js', kind: 'js', size: 17, sha256: sha(files['extra.js']) });
  }
  files['pack.json'] = strToU8(JSON.stringify(pj));
  mkdirSync(TMP, { recursive: true });
  writeFileSync(out, zipSync(files));
  return out;
}

test('REQ-ARC-14 data packs: manifest hashes, SHA-256 checks, changed or foreign code refused, data-only foreign packs accepted', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const m = await frame.evaluate(() => window.gisworkbench.gw.manifest.packs);
  expect(Object.keys(m).sort()).toEqual(['ai', 'ai-detect', 'ai-match', 'ai-sam2', 'ai-search', 'geoid', 'hdf5', 'proj']);
  for (const [name, p] of Object.entries(m)) {
    expect(sha(readFileSync(pk(name))), name).toBe(p.sha256);
    expect(Object.keys(p.entries).length).toBeGreaterThan(0);
  }
  const bad1 = tampered(pk('hdf5'), join(TMP, 'bad-entry.gwpack'));
  const bad2 = tampered(pk('hdf5'), join(TMP, 'bad-code.gwpack'), { fixJson: true });
  mkdirSync(TMP, { recursive: true });
  const data = strToU8('{"type":"FeatureCollection","features":[]}');
  const foreign = { 'pack.json': strToU8(JSON.stringify({ format: 'gw-pack/1', name: 'basemap50', title: 'Test basemap', version: '1', entries: [{ path: 'land.geojson', kind: 'data', size: data.length, sha256: sha(data) }] })), 'land.geojson': data };
  writeFileSync(join(TMP, 'foreign-data.gwpack'), zipSync(foreign));
  const bad3 = tampered(join(TMP, 'foreign-data.gwpack'), join(TMP, 'foreign-code.gwpack'), { fixJson: true, addJs: true });
  for (const f of [bad1, bad2, bad3, join(TMP, 'foreign-data.gwpack'), pk('hdf5')]) await openFiles(frame, [f]);
  await frame.waitForFunction(() => window.gisworkbench.packs.loaded.has('hdf5') && window.gisworkbench.packs.loaded.has('basemap50'), null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const errs = app.importLog.filter((x) => /gwpack$/.test(x.file)).map((x) => [x.file, x.errors[0]]);
    const kept = await app.packs.restore();
    // A kept pack is read again and verified on use.
    app.packs.loaded.delete('hdf5');
    const again = await app.packs.get('hdf5');
    return { errs, loaded: [...app.packs.loaded.keys()].sort(), kept: kept.map((k) => k.name).sort(), again: again?.version, entries: again?.entries.size };
  });
  const msg = Object.fromEntries(r.errs);
  expect(msg['bad-entry.gwpack']).toMatch(/does not match its SHA-256 in pack.json/);
  expect(msg['bad-code.gwpack']).toMatch(/differs from this build's manifest/);
  expect(msg['foreign-code.gwpack']).toMatch(/not listed in this build's manifest/);
  expect(r.loaded).toEqual(['basemap50', 'hdf5']);
  expect(r.kept).toEqual(expect.arrayContaining(['basemap50', 'hdf5']));
  expect(r.again).toBe('0.10.3');
  expect(r.entries).toBe(1);
  expect(logs).toEqual([]);
});

test('REQ-ARC-14 geoid pack: EGM2008 from the pack agrees with the PGM grid; EGM96 matches the NGA test points; switch back', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  // Independent reference: bilinear interpolation of the pack's own PGM grid (Node side).
  const pgm = unzipSync(readFileSync(pk('geoid')))['egm2008-5.pgm'];
  const head = strFromU8(pgm.subarray(0, 2000));
  const m = /\n(\d+)\s+(\d+)\n(\d+)\n/.exec(head);
  const [W, H] = [Number(m[1]), Number(m[2])];
  const start = m.index + m[0].length;
  const off = Number(/# Offset (\S+)/.exec(head)[1]);
  const sc = Number(/# Scale (\S+)/.exec(head)[1]);
  const at = (r, c) => off + sc * ((pgm[start + 2 * (r * W + (c % W))] << 8) | pgm[start + 2 * (r * W + (c % W)) + 1]);
  const bil = (lat, lon) => {
    const fy = (90 - lat) / (180 / (H - 1));
    const fx = (((lon % 360) + 360) % 360) / (360 / W);
    const [r, c] = [Math.floor(fy), Math.floor(fx)];
    const [ty, tx] = [fy - r, fx - c];
    return (1 - ty) * ((1 - tx) * at(r, c) + tx * at(r, c + 1)) + ty * ((1 - tx) * at(r + 1, c) + tx * at(r + 1, c + 1));
  };
  // NGA's EGM96 interpolation test points (outintpt.dat): lat, lon, N (m) — for the embedded EGM96.
  const pts = [[38.628155, 269.779155, -31.628], [-14.621217, 305.021114, -2.969], [46.874319, 102.448729, -43.575], [-23.617446, 133.874712, 15.871], [38.625473, 359.9995, 50.066], [-0.466744, 0.0023, 17.329]];
  await openFiles(frame, [pk('geoid')]);
  await frame.waitForFunction(() => window.gisworkbench.core.geoidName === 'EGM2008', null, { timeout: 60000 });
  const r = await frame.evaluate(async (pts) => {
    const app = window.gisworkbench;
    const n2008 = pts.map(([la, lo]) => app.core.undulation(la, lo));
    const vd = document.querySelector('[data-id="status:vdatum"]')?.textContent;
    await app.useEgm96();
    const n96 = pts.map(([la, lo]) => app.core.undulation(la, lo));
    return { n2008, n96, vd, name: app.core.geoidName };
  }, pts);
  // The grid's stated maximum bilinear error is 0.478 m; smooth points agree to a few cm.
  pts.forEach(([la, lo], i) => expect(Math.abs(r.n2008[i] - bil(la, lo)), `EGM2008 point ${i}`).toBeLessThan(0.3));
  expect(Math.abs(r.n2008[0] - bil(pts[0][0], pts[0][1]))).toBeLessThan(0.05);
  pts.forEach(([, , n], i) => expect(Math.abs(r.n96[i] - n), `EGM96 point ${i}`).toBeLessThan(0.02));
  expect(r.vd).toBe('MSL(EGM2008)');
  expect(r.name).toBe('EGM96');
  // EGM2008 and EGM96 differ by decimetres in places (Mongolia, point 2).
  expect(Math.abs(r.n96[2] - r.n2008[2])).toBeGreaterThan(0.3);
  expect(logs).toEqual([]);
});

test('REQ-MSI-02 REQ-ARC-14 HDF5 pack: FX-08 as EMIT L2A (NetCDF-4) and PRISMA L2D (HDF5-EOS) — bands, wavelengths, reflectance and geolocation', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const fx = (n) => resolve('fixtures/fx08', n);
  // Without the pack the file is refused with an instruction.
  await openFiles(frame, [fx('fx08_emit.nc')]);
  await frame.waitForFunction(() => window.gisworkbench.importLog.some((x) => x.file === 'fx08_emit.nc'), null, { timeout: 60000 });
  const before = await frame.evaluate(() => window.gisworkbench.importLog.find((x) => x.file === 'fx08_emit.nc').errors.join(' '));
  expect(before).toMatch(/HDF5 reader \(h5wasm\) data pack/);
  await openFiles(frame, [pk('hdf5')]);
  await openFiles(frame, [fx('fx08_emit.nc'), fx('fx08_prisma.he5'), fx('fx08.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length >= 3, null, { timeout: 120000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const L = (n) => [...app.layers.values()].find((l) => l.info.fileName === n);
    const out = {};
    const tif = L('fx08.tif');
    const px = async (l, x, y) => (await app.pool.run('pixels', { handle: l.handle, x, y, w: 1, h: 1, bands: [0, 1, 2, 3, 4, 5, 6, 7] }, { affinity: l.affinity })).values.map((v) => v[0]);
    const ref = (await px(tif, 300, 222)).map((v) => v * 1e-4);
    for (const n of ['fx08_emit.nc', 'fx08_prisma.he5']) {
      const l = L(n);
      const bands = app.msi.bandsOf(l);
      const v = await px(l, 300, 222);
      const refl = v.map((x, b) => x * (l.radiometry.gain?.[b] ?? 1) + (l.radiometry.offset?.[b] ?? 0));
      const gs = [[10, 10], [256, 256], [500, 480]].map(([x, y]) => {
        const a = l.groundAt(x, y);
        const b = tif.groundAt(x, y);
        return app.core.inverse(a.lat, a.lon, b.lat, b.lon).distance;
      });
      out[n] = { w: l.width, h: l.height, nb: l.bands, cw: bands.map((b) => Math.round(b.cw * 1000)), state: l.radiometry.state, refl, model: l.modelName, geoErr: Math.max(...gs) };
    }
    return { out, ref, want: app.msi.bandsOf(tif).map((b) => Math.round(b.cw * 1000)) };
  });
  for (const [n, o] of Object.entries(r.out)) {
    expect([o.w, o.h, o.nb], n).toEqual([512, 512, 8]);
    expect(o.state, n).toBe('reflectance');
    expect(o.model, n).toMatch(/Geolocation grid/);
    expect(o.geoErr, `${n} geolocation (m)`).toBeLessThan(1);
    o.refl.forEach((v, b) => expect(Math.abs(v - r.ref[b]), `${n} band ${b}`).toBeLessThan(n.includes('prisma') ? 2e-5 : 1e-6));
  }
  // PRISMA stores VNIR in descending wavelength order; the reader presents bands ascending.
  expect(r.out['fx08_emit.nc'].cw).toEqual(r.want);
  expect(r.out['fx08_prisma.he5'].cw).toEqual(r.want);
  expect(logs).toEqual([]);
});

test('REQ-GEO-12 REQ-ARC-14 PROJ pack: EPSG:31370 outside the embedded table is defined by PROJ; the layer model agrees with PROJ itself', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const f = resolve('fixtures/packs/bl72.tif');
  await openFiles(frame, [f]);
  await frame.waitForFunction(() => window.gisworkbench.importLog.some((x) => x.file === 'bl72.tif'), null, { timeout: 60000 });
  const before = await frame.evaluate(() => [...window.gisworkbench.layers.values()][0]?.modelName ?? 'no layer');
  expect(before).not.toMatch(/31370/);
  await openFiles(frame, [pk('proj')]);
  await frame.waitForFunction(() => !!window.gisworkbench.proj.mod, null, { timeout: 60000 });
  const n0 = await frame.evaluate(() => window.gisworkbench.layers.size);
  await openFiles(frame, [f]);
  await frame.waitForFunction((n0) => window.gisworkbench.layers.size > n0, n0, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].at(-1);
    const gt = [148000, 10, 0, 172000, 0, -10];
    const corners = [[0, 0], [256, 0], [256, 256], [0, 256], [128, 128]];
    const xy = corners.map(([x, y]) => [gt[0] + gt[1] * x, gt[3] + gt[5] * y]);
    const ref = await app.proj.transform('EPSG:31370', 'EPSG:4326', xy);
    const err = corners.map(([x, y], i) => {
      const g = app.core.i2g(l.modelId, x, y, 0);
      return app.core.inverse(g.lat, g.lon, ref[i][1], ref[i][0]).distance;
    });
    const d = await app.proj.describe(31370);
    return { model: l.modelName, err, ref: ref[4], name: d.name, def: d.def };
  });
  expect(r.model).toMatch(/EPSG:31370.*PROJ pack/);
  expect(r.name).toBe('BD72 / Belgian Lambert 72');
  expect(r.def).toMatch(/\+proj=lcc/);
  expect(r.ref[1]).toBeGreaterThan(50.8);
  expect(r.ref[0]).toBeGreaterThan(4.3);
  expect(Math.max(...r.err), 'layer model vs PROJ (m)').toBeLessThan(1.5);
  expect(logs).toEqual([]);
});

test('REQ-EXT-18 REQ-AI-18 REQ-ARC-14 AI pack: SlimSAM smart select on this device — an FX-08 field on imagery and the FX-05 building on DSM hillshade', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [pk('ai')]);
  await openFiles(frame, [resolve('fixtures/fx08/fx08.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length >= 1, null, { timeout: 60000 });
  const iou = `(poly, x0, y0, x1, y1) => {
    const inside = (x, y) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i]; const [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
    const xs = poly.map((p) => p[0]); const ys = poly.map((p) => p[1]);
    const bx0 = Math.min(x0, ...xs), bx1 = Math.max(x1, ...xs), by0 = Math.min(y0, ...ys), by1 = Math.max(y1, ...ys);
    let inter = 0, uni = 0;
    for (let y = Math.floor(by0); y < by1; y++) for (let x = Math.floor(bx0); x < bx1; x++) { const a = inside(x + 0.5, y + 0.5); const b = x >= x0 && x < x1 && y >= y0 && y < y1; if (a && b) inter++; if (a || b) uni++; }
    return inter / uni; }`;
  const r = await frame.evaluate(async ({ iou }) => {
    const IOU = eval(iou);
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const t0 = performance.now();
    const a = await app.sam.select(l, 192, 192); // cell (1, 1): 128…256 px
    const ms = performance.now() - t0;
    const g = app.store.get(a.graphic);
    // A second click on the same window reuses the embedding (decoder only).
    const t1 = performance.now();
    const b = await app.sam.select(l, 320, 64, { commit: false }); // cell (0, 2)
    const ms2 = performance.now() - t1;
    return { iouA: IOU(a.polygon, 128, 128, 256, 256), iouB: IOU(b.polygon, 256, 0, 384, 128), samA: a.iou, ms, ms2, enc2: b.encoderMs, graphic: g && { shape: g.shape, anchor: g.anchor, prov: g.provenance.kind, n: g.coords.length } };
  }, { iou });
  expect(r.iouA).toBeGreaterThan(0.85);
  expect(r.iouB).toBeGreaterThan(0.85);
  expect(r.graphic).toEqual({ shape: 'polygon', anchor: 'ground', prov: 'ai-sam', n: expect.any(Number) });
  expect(r.enc2).toBe(0);
  expect(r.ms2).toBeLessThan(r.ms);
  // DSM hillshade (D12): the 20 m × 20 m building on its pad.
  await openFiles(frame, [resolve('fixtures/fx05/fx05_dsm_hae.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length >= 2, null, { timeout: 60000 });
  const d = await frame.evaluate(async ({ iou }) => {
    const IOU = eval(iou);
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => /dsm/i.test(x.rec.name));
    await app.useAsTerrain(l, 'hae');
    // The building centre from the truth (lat, lon) → image.
    const c = app.core.g2i(l.modelId, 34.502704164413196, -116.50261603969118, 655);
    const s = await app.sam.select(l, c.x, c.y, { size: 256 });
    // 1 m posts: the roof is 20 × 20 px around the centre.
    return { hs: s.window, iou: IOU(s.polygon, c.x - 10, c.y - 10, c.x + 10, c.y + 10), area: s.area };
  }, { iou });
  expect(d.iou).toBeGreaterThan(0.6);
  expect(logs).toEqual([]);
});
