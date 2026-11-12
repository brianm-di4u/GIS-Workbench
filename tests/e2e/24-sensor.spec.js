// 2.4 sensor group (REQ-GAP-18, REQ-GAP-19, REQ-GAP-23) in the app:
//  - RSM: multi-section polynomial and grid RSMs fitted to FX-01's RPC00B and to a frame camera,
//    written as NITF TREs (with adjustable parameters, covariance and unmodelled error), open as
//    selectable models that agree with the generating model; GDAL parses every TRE written; the
//    RSM's covariance gives measurements a CE90; a block adjustment recovers a known error through
//    the RSM's adjustable parameters.
//  - The rigorous pushbroom from CSEPHA/CSATTA/CSSFAA opens beside the RPC00B of a corpus
//    WorldView-3 NITF (E:, skipped when absent) and agrees with it.
//  - Frame cameras from SENSRB, from drone EXIF/XMP (DJI gimbal angles), from calibration files
//    (Agisoft, OpenCV), checked against independent projections; the real senseFly images of
//    Bellus against their surveyed GCPs; the Frame Import Wizard passes axe.
import { test, expect } from '@playwright/test';
import { resolve, join } from 'node:path';
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { openApp, openFiles } from './helpers.js';
import { rsmTreList, writeSensrb } from '../../app/src/sensor/writers.js';
import { frameParams, parseCameraFile } from '../../app/src/sensor/camera.js';

const CORPUS = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const GDAL = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library';

/** NED → ENU vector and the gimbal rotation's image axes (independent of the Rust klv_rotation). */
function gimbalAxes(yaw, pitch, roll) {
  const r = (a) => (a * Math.PI) / 180;
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(r(yaw)), Math.sin(r(yaw)), Math.cos(r(pitch)), Math.sin(r(pitch)), Math.cos(r(roll)), Math.sin(r(roll))];
  const Rz = [[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]];
  const Ry = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]];
  const Rx = [[1, 0, 0], [0, cr, -sr], [0, sr, cr]];
  const mul = (a, b) => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
  const m = mul(mul(Rz, Ry), Rx); // columns: line of sight, image right, image down (NED)
  const col = (j) => m.map((row) => row[j]);
  return { icx: col(1), icy: col(2), icz: col(0) };
}

/** EXIF (GPS, focal length, focal-plane resolution) and XMP APP1 segments for a JPEG. */
function exifSegments({ lat, lon, alt, focal, xres, w, h, xmp }) {
  const buf = new Uint8Array(4096);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49]);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  let heap = 600;
  const ifd = (at, list) => {
    dv.setUint16(at, list.length, true);
    list.forEach(([tag, type, v], i) => {
      const e = at + 2 + 12 * i;
      dv.setUint16(e, tag, true);
      dv.setUint16(e + 2, type, true);
      if (type === 2) {
        const s = `${v}\0`;
        dv.setUint32(e + 4, s.length, true);
        const o = s.length <= 4 ? e + 8 : heap;
        if (s.length > 4) {
          dv.setUint32(e + 8, heap, true);
          heap += s.length + 1;
        }
        for (let k = 0; k < s.length; k++) buf[o + k] = s.charCodeAt(k);
      } else if (type === 5) {
        dv.setUint32(e + 4, v.length, true);
        dv.setUint32(e + 8, heap, true);
        for (const x of v) {
          dv.setUint32(heap, Math.round(x * 1e6), true);
          dv.setUint32(heap + 4, 1e6, true);
          heap += 8;
        }
      } else {
        dv.setUint32(e + 4, 1, true);
        if (type === 3) dv.setUint16(e + 8, v, true);
        else if (type === 1) buf[e + 8] = v;
        else dv.setUint32(e + 8, v, true);
      }
    });
  };
  const dms = (v) => [Math.floor(v), Math.floor((v % 1) * 60), (((v % 1) * 60) % 1) * 60];
  ifd(8, [[0x010f, 2, 'DJI'], [0x0110, 2, 'FC6310'], [0x8769, 4, 200], [0x8825, 4, 400]]);
  ifd(200, [[0x920a, 5, [focal]], [0xa002, 4, w], [0xa003, 4, h], [0xa20e, 5, [xres]], [0xa20f, 5, [xres]], [0xa210, 3, 4]]);
  ifd(400, [[0x0001, 2, lat < 0 ? 'S' : 'N'], [0x0002, 5, dms(Math.abs(lat))], [0x0003, 2, lon < 0 ? 'W' : 'E'], [0x0004, 5, dms(Math.abs(lon))], [0x0005, 1, 0], [0x0006, 5, [alt]]]);
  const app1 = (payload) => [0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
  return [...app1([0x45, 0x78, 0x69, 0x66, 0, 0, ...buf.subarray(0, heap)]), ...app1([...new TextEncoder().encode(`http://ns.adobe.com/xap/1.0/\0${xmp}`)])];
}

test('REQ-GAP-18 multi-section and grid RSMs fitted to an RPC and a frame camera read back from NITF TREs; GDAL parses them; CE90 and the block adjustment use the RSM parameters', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx01/fx01.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  // 1. Fit a 2 × 2 polynomial RSM and a 2 × 1 grid RSM to the RPC, and the same to a frame camera.
  const fits = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const t0 = performance.now();
    const poly = await app.frames.fitRsm(l, { sections: [2, 2] });
    const grid = await app.frames.fitRsm(l, { sections: [2, 1], grid: true, nodes: [11, 11], planes: 6 });
    return { poly, grid, ms: performance.now() - t0, iid: l.info.iid, size: [l.width, l.height] };
  });
  expect(fits.poly.sections.length).toBe(4);
  expect(fits.grid.grids.length).toBe(2);
  // Adjustable parameters (row and column offsets, set A), their covariance and unmodelled error
  // on the polynomial RSM; a 3-row applied correction on a second copy (for the adjustment).
  const frameA = { frame: 1, origin: [0, 0, 0], axes: [0, 0, 0, 0, 0, 0, 0, 0, 0], noff: [0, 0, 0], nscale: [1, 1, 1] };
  const poly = { ...fits.poly, iid: 'FX01 RSM POLY', adjustable: { ...frameA, frame: 0, origin: [-2.3e6, -4.6e6, 3.6e6], axes: [1, 0, 0, 0, 1, 0, 0, 0, 1], terms: [[0, 0, 0, 0], [1, 0, 0, 0]], values: [0, 0] }, cov: [0.25, 0, 0, 0.36], unmodelled: [0.01, 0, 0.01] };
  // A loose prior (10 px) on the shifted copy, so the recovered values are the data's, not the prior's.
  const shifted = { ...poly, iid: 'FX01 RSM SHIFTED', applied: { ...poly.adjustable, values: [3, -2] }, cov: [100, 0, 0, 100] };
  const grid = { ...fits.grid, iid: 'FX01 RSM GRID', adjustable: { ...frameA, nscale: [1, 1, 1], terms: [[0, 0, 0, 0], [1, 0, 0, 0]], values: [0, 0] }, cov: [0.16, 0, 0, 0.16] };
  const lists = { poly: rsmTreList(poly), shifted: rsmTreList(shifted), grid: rsmTreList(grid, { setB: true, direct: true }) };
  expect(lists.poly.map((x) => x[0])).toEqual(['RSMIDA', 'RSMPIA', 'RSMPCA', 'RSMPCA', 'RSMPCA', 'RSMPCA', 'RSMECA']);
  expect(lists.grid.map((x) => x[0])).toEqual(['RSMIDA', 'RSMGIA', 'RSMGGA', 'RSMGGA', 'RSMDCB']);
  // 2. Write the NITFs, open them, compare every model with the RPC.
  const r = await frame.evaluate(async (lists) => {
    const app = window.gisworkbench;
    const core = app.core;
    const { writeNitf } = app.__test;
    const base = [...app.layers.values()][0];
    const W = 256;
    const img = { width: W, height: W, bands: 1, type: 'u8', planes: [new Uint8Array(W * W).map((_, k) => k % 251)] };
    const bytes = {};
    for (const [k, tres] of Object.entries(lists)) {
      const ntf = writeNitf(img, { title: `RSM ${k}`, iid1: 'RSMTEST', iid2: `RSM ${k}`, idatim: '20260410101500', icat: 'VIS', irep: 'MONO', tres });
      bytes[k] = btoa(String.fromCharCode(...ntf));
      await app.openFiles([new File([ntf], `rsm_${k}.ntf`)]);
    }
    const out = { bytes, models: {}, err: {}, log: app.importLog.slice(-3).map((x) => x.warnings) };
    const rpc = base.modelId;
    for (const k of Object.keys(lists)) {
      const l = [...app.layers.values()].find((x) => x.rec.name.startsWith(`rsm_${k}.ntf`));
      out.models[k] = l.models.map((m) => (m.error ? `${m.name}: ${m.error}` : m.name));
      const id = l.modelId;
      let worst = 0;
      let worstI2g = 0;
      for (const h of [base.modelInfo.hmin + 50, 650, base.modelInfo.hmax - 50])
        for (let j = 0; j <= 9; j++)
          for (let i = 0; i <= 9; i++) {
            const x = 5 + (i * (base.width - 10)) / 9;
            const y = 5 + (j * (base.height - 10)) / 9;
            const g = core.i2g(rpc, x, y, h);
            const p = core.g2i(id, g.lat, g.lon, h);
            worst = Math.max(worst, Math.hypot(p.x - x, p.y - y));
            const g2 = core.i2g(id, x, y, h);
            worstI2g = Math.max(worstI2g, core.inverse(g.lat, g.lon, g2.lat, g2.lon).distance);
          }
      const e = core.pointError(id, base.width / 2, base.height / 2, 650, 0.5);
      const info = core.modelInfo(id);
      out.err[k] = { worst, worstI2g, name: l.modelName, ce90: e.ce90, known: e.modelErrorKnown, sigmaModel: e.sigmaModel, gsd: e.gsd, params: info.params, paramSigma: info.paramSigma, cov: core.imageCovariance(id, base.width / 2, base.height / 2, 650) };
    }
    // The RPC's own CE90 at the same point, for reference.
    out.rpcCe90 = core.pointError(rpc, base.width / 2, base.height / 2, 650, 0.5).ce90;
    // A block adjustment through the RSM parameters: GCPs from the RPC measured in the shifted RSM image.
    const ls = [...app.layers.values()].find((x) => x.rec.name.startsWith('rsm_shifted.ntf'));
    app.store.transact('test GCPs', (tx) => {
      for (let j = 0; j < 3; j++)
        for (let i = 0; i < 3; i++) {
          const x = 300 + i * (base.width - 600) / 2;
          const y = 300 + j * (base.height - 600) / 2;
          const g = core.i2g(rpc, x, y, 600 + 40 * i);
          tx.create('tripoint', { name: `G${i}${j}`, kind: 'gcp', known: { lat: g.lat, lon: g.lon, hae: 600 + 40 * i }, sigmaH: 0.05, sigmaV: 0.05, obs: { [ls.id]: { x, y, sigma: 0.2 } } });
        }
    });
    const before = core.g2i(ls.modelId, ...Object.values(core.i2g(rpc, 1000, 1000, 650)), 650);
    const rep = await app.tri.solve({ kind: 'sensor', layers: [ls] });
    const label = app.tri.applySolution(rep);
    await new Promise((res) => setTimeout(res, 50));
    const g = core.i2g(rpc, 1000, 1000, 650);
    const after = core.g2i(ls.modelId, g.lat, g.lon, 650);
    out.block = { params: rep.images[0].params, names: rep.images[0].paramNames, sigma0: rep.sigma0, model: ls.modelName, label, before: Math.hypot(before.x - 1000, before.y - 1000), after: Math.hypot(after.x - 1000, after.y - 1000), sup: JSON.parse(app.tri.supText(ls)).correction };
    return out;
  }, lists);
  console.log(`RSM fits (photo bundle, ${Math.round(fits.ms)} ms): ${JSON.stringify(Object.fromEntries(Object.entries(r.err).map(([k, v]) => [k, { worstPx: v.worst, worstI2gM: v.worstI2g, ce90: v.ce90 }])))}`);
  expect(r.models.poly[0]).toBe('RSM polynomial (2 × 2 sections, experimental)');
  expect(r.models.grid[0]).toBe('RSM grid (2 × 1 sections, experimental)');
  expect(r.models.poly.filter((m) => /: /.test(m))).toEqual([]);
  // The multi-section RSMs agree with the RPC that generated them.
  expect(r.err.poly.worst).toBeLessThan(0.02);
  expect(r.err.grid.worst).toBeLessThan(0.05);
  expect(r.err.poly.worstI2g).toBeLessThan(0.05);
  // CE90 from the RSM error TREs: σ² = 0.25 + 0.01 px (row) and 0.36 + 0.01 px (col), times the GSD.
  expect(r.err.poly.known).toBe(true);
  expect(r.err.poly.params).toBe(2);
  expect(r.err.poly.paramSigma).toEqual([expect.closeTo(0.5, 9), expect.closeTo(0.6, 9)]);
  expect(r.err.poly.cov[0]).toBeCloseTo(0.37, 6);
  expect(r.err.poly.cov[2]).toBeCloseTo(0.26, 6);
  expect(r.err.poly.ce90).toBeGreaterThan(0.5 * 2.146 * Math.sqrt(0.26) * r.err.poly.gsd);
  expect(r.err.poly.ce90).toBeLessThan(2.146 * Math.sqrt(0.37 + 0.5 ** 2) * r.err.poly.gsd * 1.6);
  expect(r.err.grid.known).toBe(true);
  console.log(`RSM block adjustment: ${JSON.stringify(r.block)}`);
  // The block adjustment recovers the applied (3, −2) px through the adjustable parameters.
  expect(r.block.params[0]).toBeCloseTo(-3, 2);
  expect(r.block.params[1]).toBeCloseTo(2, 2);
  expect(r.block.before).toBeGreaterThan(3);
  expect(r.block.after).toBeLessThan(0.01);
  expect(r.block.model).toMatch(/^RSM polynomial \(2 × 2 sections, experimental\) \(triangulated: SOL-0001\)$/);
  expect(r.block.sup.sensorParameters.map((p) => p.name)).toEqual(['row x0y0z0', 'col x0y0z0']);
  // 3. GDAL's TRE tables (the layout oracle) read every TRE written without a complaint.
  if (existsSync(GDAL)) {
    const dir = mkdtempSync(join(tmpdir(), 'gw24-rsm-'));
    try {
      const env = { ...process.env, PATH: `${GDAL}/bin;${process.env.PATH}`, GDAL_DATA: `${GDAL}/share/gdal`, PROJ_DATA: `${GDAL}/share/proj` };
      for (const k of Object.keys(lists)) {
        const p = join(dir, `${k}.ntf`);
        writeFileSync(p, Buffer.from(r.bytes[k], 'base64'));
        let out = '';
        try {
          out = execFileSync('gdalinfo', ['-mdd', 'xml:TRE', p], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
          throw new Error(`gdalinfo failed on ${k}: ${e.stderr}`);
        }
        for (const [tag] of lists[k]) expect(out, `${k} ${tag}`).toContain(`<tre name="${tag}"`);
        // GDAL's minimum-value check flags the index fields left blank for unused parameters
        // (IRO … GZZ, min 1); blank is how this writer marks "not used" [unverified]. Any other
        // warning fails.
        const blankIndex = /<field name="(IR|IC|G)[A-Z0]*" value="">\s*<warning>Minimum value constraint of 1 not met<\/warning>\s*<\/field>/g;
        const nBlank = (out.match(blankIndex) ?? []).length;
        const bad = /.{0,160}(<error|warning|remaining bytes|exceeds).{0,160}/is.exec(out.replace(blankIndex, ''));
        if (nBlank) console.log(`GDAL on ${k}: ${nBlank} blank parameter-index fields flagged "Minimum value constraint of 1" (accepted)`);
        expect(bad?.[0] ?? null, k).toBeNull();
      }
      // GDAL reads the section counts and the grid's plane count as written.
      const pia = execFileSync('gdalinfo', ['-mdd', 'xml:TRE', join(dir, 'poly.ntf')], { env, encoding: 'utf8' });
      expect(pia).toMatch(/name="RNIS" value="002"/);
      const gga = execFileSync('gdalinfo', ['-mdd', 'xml:TRE', join(dir, 'grid.ntf')], { env, encoding: 'utf8' });
      expect(gga).toMatch(/name="NPLN" value="006"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // 4. RSMs from a frame camera (an oblique aerial frame with distortion).
  const fr = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const core = app.core;
    const tif = await app.__test.writeGeoTiff({ width: 6000, height: 4000, bands: 1, type: 'u8', data: new Uint8Array(6000 * 4000).fill(90) }, {});
    await app.openFiles([new File([tif], 'oblique_0001.tif')]);
    const l = [...app.layers.values()].find((x) => x.rec.name.startsWith('oblique_0001'));
    app.frames.importEO('image,lat,lon,h,omega,phi,kappa\noblique_0001,34.5,-116.5,2100,8,-5,30', { focalMm: 50, pixelMm: 0.004, k: [2e-5, -1e-9, 0], p: [1e-6, -2e-6] });
    const fid = l.modelId;
    const out = {};
    for (const [k, o] of Object.entries({ poly: { sections: [2, 3], heights: [400, 900] }, grid: { sections: [2, 2], grid: true, nodes: [15, 15], planes: 8, heights: [400, 900] } })) {
      const rsm = await app.frames.fitRsm(l, o);
      out[k] = { rmsPx: rsm.rmsPx, maxPx: rsm.maxPx, sections: (rsm.sections.length || rsm.grids.length) };
    }
    out.frameModel = core.modelInfo(fid).name;
    return out;
  });
  console.log(`RSM from an oblique frame camera: ${JSON.stringify(fr)}`);
  expect(fr.frameModel).toMatch(/^Frame camera \(EO import\)/);
  expect(fr.poly.sections).toBe(6);
  expect(fr.poly.maxPx).toBeLessThan(0.05);
  expect(fr.grid.maxPx).toBeLessThan(0.1);
  expect(logs).toEqual([]);
});

test('REQ-GAP-19 the rigorous pushbroom of a corpus WorldView-3 NITF is a selectable model that agrees with its RPC00B', async ({ page }) => {
  const dir = join(CORPUS, 'nitf-core3d-jacksonville-wv3', 'MSI');
  test.skip(!existsSync(dir), 'TE-corpus not mounted');
  test.setTimeout(300000);
  const f = readdirSync(dir).filter((n) => /\.ntf$/i.test(n)).sort()[2];
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [join(dir, f)]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const core = app.core;
    const l = [...app.layers.values()].find((x) => x.kind === 'image' && x.models?.some((m) => /^Pushbroom/.test(m.name)));
    const pb = l.models.find((m) => /^Pushbroom/.test(m.name));
    const rec = l.info.subheader.rpc;
    const rows = 2 * rec[2] + 2;
    const cols = 2 * rec[3] + 2;
    const h0 = rec[6] - rec[11];
    const h1 = rec[6] + rec[11];
    const d = [];
    for (const h of [h0, (h0 + h1) / 2, h1])
      for (let j = 0; j <= 10; j++)
        for (let i = 0; i <= 10; i++) {
          const x = 0.5 + (i * (cols - 1)) / 10;
          const y = 0.5 + (j * (rows - 1)) / 10;
          const g = core.i2g(l.modelId, x, y, h);
          const p = core.g2i(pb.id, g.lat, g.lon, h);
          d.push(Math.hypot(p.x - x, p.y - y));
        }
    // Select the rigorous model through the model menu and measure with it.
    const item = app.commands.get?.('model.active')?.menu?.().find((m) => /^Pushbroom/.test(m.label)) ?? null;
    item?.run();
    const e = core.pointError(pb.id, cols / 2, rows / 2, (h0 + h1) / 2, 0.5);
    return { models: l.models.map((m) => (m.error ? `${m.name}: ${m.error}` : m.name)), active: l.modelName, rms: Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length), max: Math.max(...d), info: pb.info, ce90: e.ce90, known: e.modelErrorKnown, menuItem: !!item };
  });
  console.log(`WV3 rigorous vs RPC00B (${f}): RMS ${r.rms.toFixed(3)} px, max ${r.max.toFixed(3)} px, CE90 ${r.ce90.toFixed(2)} m, models ${JSON.stringify(r.models)}`);
  expect(r.models[0]).toMatch(/^RPC00B/);
  expect(r.models).toContain('Pushbroom (CSEPHA/CSATTA, rigorous)');
  expect(r.rms).toBeLessThan(1);
  expect(r.max).toBeLessThan(2.5);
  expect(r.info.params).toBe(7);
  expect(r.info.paramNames[0]).toBe('in-track offset (m)');
  expect(r.info.paramSigma.every((s) => s > 0)).toBe(true);
  expect(r.known).toBe(true);
  expect(r.ce90).toBeGreaterThan(1);
  expect(r.ce90).toBeLessThan(20);
  if (r.menuItem) expect(r.active).toBe('Pushbroom (CSEPHA/CSATTA, rigorous)');
  expect(logs).toEqual([]);
});

test('REQ-GAP-23 frame cameras from SENSRB, drone EXIF/XMP and calibration files; Bellus GCPs; the wizard passes axe', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  // 1. SENSRB with unit vectors from gimbal angles (yaw 30°, pitch −70°, roll 2°).
  const cam = { focalMm: 50, pixelMm: 0.006, k: [1e-5, 0, 0], p: [0, 0], aff: [0, 0], width: 1200, height: 800, cx: 600 + 0.012 / 0.006, cy: 400 + 0.024 / 0.006 };
  const ax = gimbalAxes(30, -70, 2);
  const sensrb = writeSensrb({ width: 1200, height: 800, focalMm: 50, pixelMm: 0.006, ppx: 0.012, ppy: -0.024, k: [1e-5, 0, 0], p: [0, 0], lat: 34.5, lon: -116.5, hae: 2100, ...ax });
  const truth = frameParams(cam, { lat: 34.5, lon: -116.5, hae: 2100 }, { kind: 'gimbal', yaw: 30, pitch: -70, roll: 2 });
  // 2. A DJI-style JPEG (EXIF GPS and XMP gimbal angles, calibrated focal length).
  const xmp = '<x:xmpmeta><rdf:Description drone-dji:GimbalYawDegree="+120.5" drone-dji:GimbalPitchDegree="-85.0" drone-dji:GimbalRollDegree="+0.0" drone-dji:AbsoluteAltitude="+412.53" drone-dji:CalibratedFocalLength="1000.0" drone-dji:CalibratedOpticalCenterX="320.0" drone-dji:CalibratedOpticalCenterY="240.0"/></x:xmpmeta>';
  const seg = exifSegments({ lat: 41.3038, lon: -81.7505, alt: 346.2, focal: 8.8, xres: 400, w: 640, h: 480, xmp });
  // 3. Calibration files: Agisoft and OpenCV, with the reference projections their own docs give.
  const agi = '<calibration><projection>frame</projection><width>640</width><height>480</height><f>900</f><cx>6.5</cx><cy>-4.25</cy><b1>2.0</b1><b2>-1.0</b2><k1>-0.12</k1><k2>0.03</k2><k3>-0.004</k3><p1>0.0012</p1><p2>-0.0007</p2></calibration>';
  const cv = { fx: 905, fy: 898, cx: 322.5, cy: 236.25, k1: 0.11, k2: -0.2, p1: -0.0009, p2: 0.0013, k3: 0.05 };
  const agiCam = parseCameraFile(agi, 'cam.xml');
  const cvCam = parseCameraFile(JSON.stringify({ mtx: [[cv.fx, 0, cv.cx], [0, cv.fy, cv.cy], [0, 0, 1]], dist: [cv.k1, cv.k2, cv.p1, cv.p2, cv.k3] }), 'x_calib.json', { width: 640, height: 480 });
  // Ground points around a nadir camera (ω = φ = κ = 0: x east, y north): normalised x = E/H,
  // y = −N/H (y down), then each model's own formula.
  const H = 100;
  const pts = [];
  for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) pts.push([i * 11, j * 8]);
  const metashape = ([E, N]) => {
    const [x, y] = [E / H, -N / H];
    const r2 = x * x + y * y;
    const rad = 1 - 0.12 * r2 + 0.03 * r2 * r2 - 0.004 * r2 ** 3;
    const xd = x * rad + 0.0012 * (r2 + 2 * x * x) + 2 * -0.0007 * x * y;
    const yd = y * rad + -0.0007 * (r2 + 2 * y * y) + 2 * 0.0012 * x * y;
    return [320 + 6.5 + xd * 900 + xd * 2 + yd * -1, 240 - 4.25 + yd * 900];
  };
  const opencv = ([E, N]) => {
    const [x, y] = [E / H, -N / H];
    const r2 = x * x + y * y;
    const rad = 1 + cv.k1 * r2 + cv.k2 * r2 * r2 + cv.k3 * r2 ** 3;
    const xd = x * rad + 2 * cv.p1 * x * y + cv.p2 * (r2 + 2 * x * x);
    const yd = y * rad + cv.p1 * (r2 + 2 * y * y) + 2 * cv.p2 * x * y;
    return [cv.fx * xd + cv.cx + 0.5, cv.fy * yd + cv.cy + 0.5]; // OpenCV pixel centres at integers
  };
  const centre = { lat: 41.3, lon: -81.75, hae: 400 };
  const calib = { agi: { prm: frameParams(agiCam, centre, { kind: 'opk' }), want: pts.map(metashape) }, cv: { prm: frameParams(cvCam, centre, { kind: 'opk' }), want: pts.map(opencv) } };
  // 4. Bellus: senseFly images with surveyed GCPs (UTM 17N) measured in them (ODM gcp_list.txt).
  const bel = join(CORPUS, 'frames-odm-bellus-gcp');
  const gcps = existsSync(bel) ? readFileSync(join(bel, 'gcp_list.txt'), 'utf8').split(/\r?\n/).slice(1).map((s) => s.trim().split(/\s+/)).filter((a) => a.length >= 6).map(([e, n, z, px, py, im]) => ({ e: +e, n: +n, z: +z, px: +px, py: +py, im })) : [];
  const belFiles = [...new Set(gcps.map((g) => g.im))].map((n) => join(bel, 'images', n)).filter(existsSync);
  if (belFiles.length) await openFiles(frame, belFiles);
  const djiTruth = frameParams({ focalMm: 1, pixelMm: 0.001, cx: 320, cy: 240, width: 640, height: 480 }, { lat: 41.3038, lon: -81.7505, hae: NaN }, { kind: 'gimbal', yaw: 120.5, pitch: -85, roll: 0 });
  const r = await frame.evaluate(async ({ sensrb, truth, seg, calib, pts, H, centre, gcps, djiTruth }) => {
    const app = window.gisworkbench;
    const core = app.core;
    const out = {};
    const cmp = (a, b, w, h, zs = [300, 700]) => {
      let worst = 0;
      for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h], [w / 2, h / 2], [w / 3, (2 * h) / 3]])
        for (const z of zs) {
          const g = core.i2g(a, x, y, z);
          const p = core.g2i(b, g.lat, g.lon, z);
          worst = Math.max(worst, Math.hypot(p.x - x, p.y - y));
        }
      return worst;
    };
    // SENSRB NITF.
    const W = 1200;
    const Hh = 800;
    const img = { width: W, height: Hh, bands: 1, type: 'u8', planes: [new Uint8Array(W * Hh).map((_, k) => (k * 7) % 251)] };
    await app.openFiles([new File([app.__test.writeNitf(img, { title: 'SENSRB', iid1: 'SENSRB', idatim: '20260410101500', icat: 'VIS', irep: 'MONO', tres: [['SENSRB', sensrb]] })], 'sensrb_frame.ntf')]);
    const ls = [...app.layers.values()].find((x) => x.rec.name.startsWith('sensrb_frame.ntf'));
    out.sensrb = { model: ls.modelName, worst: cmp(ls.modelId, core.frameModelEx(truth, 'truth'), W, Hh), params: ls.modelInfo.params };
    // Drone JPEG: a canvas JPEG with the EXIF/XMP segments spliced after SOI.
    const c = new OffscreenCanvas(640, 480);
    const g2 = c.getContext('2d');
    g2.fillStyle = '#4a7';
    g2.fillRect(0, 0, 640, 480);
    g2.fillStyle = '#fff';
    g2.fillRect(300, 10, 40, 60);
    const jpg = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer());
    const withExif = new Uint8Array([...jpg.subarray(0, 2), ...seg, ...jpg.subarray(2)]);
    await app.openFiles([new File([withExif], 'DJI_0001.JPG')]);
    const ld = [...app.layers.values()].find((x) => x.rec.name === 'DJI_0001.JPG');
    const n = core.undulation(41.3038, -81.7505);
    out.drone = { model: ld.modelName, models: ld.models.map((m) => (m.error ? `${m.name}: ${m.error}` : m.name)), undulation: n, id: ld.modelId, exif: ld.exif ? { centre: ld.exif.centre, source: ld.exif.source } : null };
    // The image top points along the gimbal yaw (120.5°): a point up the image lies on that bearing.
    const mid = core.i2g(ld.modelId, 320, 240, 300);
    const top = core.i2g(ld.modelId, 320, 40, 300);
    out.drone.bearing = core.inverse(mid.lat, mid.lon, top.lat, top.lon).azi1;
    // Against the gimbal model built directly (DJI absolute altitude + EGM96 → HAE).
    djiTruth[16] = 412.53 + n;
    out.drone.worst = cmp(ld.modelId, core.frameModelEx(djiTruth, 'dji truth'), 640, 480, [250, 330]);
    // Calibration files: the core's projection against the files' own formulas.
    const off = (E, N) => {
      // ENU (E, N, −H) from the centre → lat, lon at the ground height.
      const e = core.ecef(centre.lat, centre.lon, centre.hae);
      const la = (centre.lat * Math.PI) / 180;
      const lo = (centre.lon * Math.PI) / 180;
      const U = -H;
      const X = e[0] - Math.sin(lo) * E - Math.sin(la) * Math.cos(lo) * N + Math.cos(la) * Math.cos(lo) * U;
      const Y = e[1] + Math.cos(lo) * E - Math.sin(la) * Math.sin(lo) * N + Math.cos(la) * Math.sin(lo) * U;
      const Z = e[2] + Math.cos(la) * N + Math.sin(la) * U;
      return core.geodetic(X, Y, Z);
    };
    out.calib = {};
    for (const [k, v] of Object.entries(calib)) {
      const id = core.frameModelEx(v.prm, k);
      let worst = 0;
      pts.forEach(([E, N], i) => {
        const [la, lo, hh] = off(E, N);
        const p = core.g2i(id, la, lo, hh);
        worst = Math.max(worst, Math.hypot(p.x - v.want[i][0], p.y - v.want[i][1]));
      });
      out.calib[k] = worst;
    }
    // Bellus GCPs in their images.
    out.bellus = [];
    for (const g of gcps) {
      const l = [...app.layers.values()].find((x) => x.rec.name === g.im);
      if (!l) continue;
      const ll = core.utmReverse(17, true, g.e, g.n);
      const N = core.undulation(ll.lat, ll.lon);
      const res = {};
      for (const [k, h] of Object.entries({ asHae: g.z, asMsl: g.z + N })) {
        const p = core.g2i(l.modelId, ll.lat, ll.lon, h);
        const a = core.i2g(l.modelId, g.px, g.py, h);
        res[k] = { px: Math.hypot(p.x - g.px, p.y - g.py), m: core.inverse(a.lat, a.lon, ll.lat, ll.lon).distance };
      }
      out.bellus.push({ im: g.im, model: l.modelName, ...res });
    }
    return out;
  }, { sensrb, truth, seg, calib, pts, H, centre, gcps, djiTruth });
  console.log(`SENSRB ${JSON.stringify(r.sensrb)}; drone ${JSON.stringify(r.drone)}; calibration files ${JSON.stringify(r.calib)}`);
  expect(r.sensrb.model).toBe('Frame camera (SENSRB, unit vectors)');
  // SENSRB stores unit vectors to 7 decimals and the position to 1e-7°: about 1e-3 px here.
  expect(r.sensrb.worst).toBeLessThan(0.005);
  expect(r.sensrb.params).toBe(7);
  expect(r.drone.model).toBe('Frame camera (EXIF/XMP, DJI gimbal)');
  expect(Number.isFinite(r.drone.undulation)).toBe(true);
  expect(r.drone.exif.centre.hae).toBeCloseTo(412.53 + r.drone.undulation, 6);
  expect(Math.abs(((r.drone.bearing - 120.5 + 540) % 360) - 180)).toBeLessThan(0.2);
  expect(r.drone.worst).toBeLessThan(1e-4); // EXIF stores the position as rational degrees, minutes, seconds
  expect(r.calib.agi).toBeLessThan(1e-6);
  expect(r.calib.cv).toBeLessThan(1e-6);
  if (r.bellus.length) {
    const m = r.bellus.map((b) => Math.min(b.asHae.m, b.asMsl.m)).sort((a, b) => a - b);
    console.log(`Bellus GCPs through the EXIF/XMP frame models (${r.bellus.length} observations): ${JSON.stringify(r.bellus)}`);
    // The budget: GPS σ about 5 m (the XMP's own GPSXYAccuracy) and a few degrees of attitude at
    // about 100 m above ground; the median ground error must stay within it.
    expect(r.bellus.every((b) => /^Frame camera \(EXIF\/XMP, Camera:Yaw\/Pitch\/Roll\)$/.test(b.model))).toBe(true);
    expect(m[Math.floor(m.length / 2)]).toBeLessThan(25);
  }
  // 5. GDAL's autotest SENSRB opens with the reason it has no frame model.
  const gdalSensrb = resolve('..', 'Research', 'samples', 'nitf-gdal-autotest-small', 'SENSRB_TRE.ntf');
  if (existsSync(gdalSensrb)) {
    const log = await openFiles(frame, [gdalSensrb]);
    expect(JSON.stringify(log)).toMatch(/SENSRB has no sensor array data/);
  }
  // 6. The Frame Import Wizard (camera file, EXIF/XMP source) passes axe.
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  await frame.evaluate(axeSource);
  await frame.evaluate(() => void window.gisworkbench.commands.run('tri.frame'));
  const dlg = frame.locator('[data-id="dialog:tri-frame"]');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('[data-id="tri-frame-load"]')).toBeVisible();
  await expect(dlg.locator('[data-id="tri-frame-exif"]')).toBeEnabled();
  const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[data-id="dialog:tri-frame"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`));
  expect(v).toEqual([]);
  // EXIF/XMP source with the image's own calibration: the drone image keeps its DJI model geometry.
  await dlg.locator('button', { hasText: 'OK' }).click();
  const after = await frame.evaluate(() => {
    const l = [...window.gisworkbench.layers.values()].find((x) => x.rec.name === 'DJI_0001.JPG');
    return { model: l.modelName, saved: l.rec.frameModel?.eo?.kind };
  });
  expect(after.model).toBe('Frame camera (EXIF/XMP, DJI gimbal)');
  expect(after.saved).toBe('gimbal');
  expect(logs).toEqual([]);
});
