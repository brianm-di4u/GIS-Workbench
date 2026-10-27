// REQ-SNS-03/04/12/14: an RSM polynomial written as RSMIDA + RSMPCA TREs from FX-01's RPC reads back
// and agrees with the RPC; a NITF carrying only the RSM TREs opens with "RSM polynomial
// (experimental)"; the frame import wizard gives an image a frame-camera model from EO; a
// pushbroom model round-trips; image-space adjustment works over a frame model.
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

test('REQ-SNS-03 REQ-SNS-04 REQ-SNS-12 REQ-SNS-14 FX-01 RSM TREs, frame import, pushbroom, adjustment', async ({ page }) => {
  test.setTimeout(180000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx01/fx01.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const core = app.core;
    const { rsm, writeNitf, writeGeoTiff } = app.__test;
    const l = [...app.layers.values()][0];
    const rec = l.info.subheader.rpc.slice(0, 92);
    const out = {};
    // RSM from the RPC, through TRE text and back.
    const R = rsm.rsmFromRpc(rec, l.height, l.width);
    const tres = rsm.rsmTres(R);
    const back = rsm.rsmRecord(tres.RSMIDA, tres.RSMPCA);
    const id = core.rsmModel(back);
    let worst = 0;
    for (let j = 0; j <= 8; j++)
      for (let i = 0; i <= 8; i++) {
        const g = core.i2g(l.modelId, (i * l.width) / 8, (j * l.height) / 8, 650);
        const a = core.g2i(l.modelId, g.lat, g.lon, 650);
        const b = core.g2i(id, g.lat, g.lon, 650);
        worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
      }
    out.rsm = { lenIda: tres.RSMIDA.length, lenPca: tres.RSMPCA.length, worst, name: core.modelInfo(id).name };
    // A NITF that carries only the RSM TREs.
    const W = 256;
    const img = { width: W, height: W, bands: 1, type: 'u8', planes: [new Uint8Array(W * W).map((_, k) => k % 251)] };
    const rs = rsm.rsmFromRpc(rec, W, W);
    const t2 = rsm.rsmTres(rs);
    const ntf = writeNitf(img, { marking: { level: 'U', system: 'US' }, title: 'RSM test', iid1: 'RSMTEST', iid2: 'RSM TEST', idatim: '20260410101500', icat: 'VIS', irep: 'MONO', tres: [['RSMIDA', t2.RSMIDA], ['RSMPCA', t2.RSMPCA]] });
    await app.openFiles([new File([ntf], 'rsm_only.ntf')]);
    for (let i = 0; i < 100 && ![...app.layers.values()].some((x) => x.rec.name.startsWith('rsm_only') && x.lutTex); i++) await new Promise((res) => setTimeout(res, 100));
    const lr = [...app.layers.values()].find((x) => x.rec.name.startsWith('rsm_only'));
    const g0 = lr.groundAt(128, 128, 650);
    const gR = core.i2g(l.modelId, 128, 128, 650);
    out.rsmOpen = { model: lr.modelName, models: lr.models.map((m) => m.name), d: core.inverse(g0.lat, g0.lon, gR.lat, gR.lon).distance };
    // Frame import wizard: an image without a model named frame_001.tif.
    const FW = 1000;
    const FH = 700;
    const tif = await writeGeoTiff({ width: FW, height: FH, bands: 1, type: 'u8', data: new Uint8Array(FW * FH).map((_, k) => (k * 3) % 255) }, {});
    await app.openFiles([new File([tif], 'frame_001.tif')]);
    for (let i = 0; i < 100 && ![...app.layers.values()].some((x) => x.rec.name.startsWith('frame_001') && x.lutTex); i++) await new Promise((res) => setTimeout(res, 100));
    const lf = [...app.layers.values()].find((x) => x.rec.name.startsWith('frame_001'));
    const before = lf.modelId;
    const res = app.frames.importEO('image,lat,lon,h,omega,phi,kappa\nframe_001,34.5,-116.5,3650,0,0,0\nnot_open,1,2,3,0,0,0', { focalMm: 100, pixelMm: 0.005 });
    const c = lf.groundAt(FW / 2, FH / 2, 650);
    const e = lf.groundAt(FW / 2 + 100, FH / 2, 650);
    out.frame = { before, matched: res.length, model: lf.modelName, c, gsd: core.inverse(c.lat, c.lon, e.lat, e.lon).distance / 100, saved: !!lf.rec.frameModel, eastward: e.lon > c.lon };
    // SNS-12: an image-space correction over the frame model (the block adjustment's form).
    const adj = core.adjustedModel(lf.modelId, [2, 0, 0, -3, 0, 0], { centre: [FW / 2, FH / 2], half: [FW / 2, FH / 2], name: 'adjusted frame' });
    const pa = core.g2i(lf.modelId, c.lat, c.lon, 650);
    const pb = core.g2i(adj, c.lat, c.lon, 650);
    out.adjusted = { dx: pb.x - pa.x, dy: pb.y - pa.y };
    // Pushbroom round trip.
    const pb2 = core.pushbroomModel({ focalMm: 1000, pixelMm: 0.008, cx: 6000, cy: 0.5, width: 12000, height: 20000 }, { origin: { lat: 34.5, lon: -116.5, h: 0 }, p0: [-2000, -60000, 450000], v: [0, 7000, 0], a: [0, 0, 0], angles: [3, -1, 0.5], rates: [0.01, 0, 0.002], lineTime: 1e-3 }, 'test pushbroom');
    const gp = core.i2g(pb2, 3000, 12000, 650);
    const ip = core.g2i(pb2, gp.lat, gp.lon, 650);
    out.pushbroom = { d: Math.hypot(ip.x - 3000, ip.y - 12000), info: core.modelInfo(pb2) };
    return out;
  });
  console.log(JSON.stringify(r));
  expect(r.rsm.lenIda).toBe(1628);
  expect(r.rsm.worst).toBeLessThan(1e-6);
  expect(r.rsm.name).toMatch(/experimental/);
  expect(r.rsmOpen.model).toBe('RSM polynomial (experimental)');
  expect(r.rsmOpen.d).toBeLessThan(0.01);
  expect(r.frame.before).toBeFalsy();
  expect(r.frame.matched).toBe(1);
  expect(r.frame.model).toMatch(/^Frame camera/);
  expect(Math.abs(r.frame.c.lat - 34.5)).toBeLessThan(1e-6);
  expect(Math.abs(r.frame.c.lon + 116.5)).toBeLessThan(1e-6);
  expect(r.frame.gsd).toBeCloseTo(0.15, 3);
  expect(r.frame.eastward).toBe(true);
  expect(r.frame.saved).toBe(true);
  expect(r.adjusted.dx).toBeCloseTo(-3, 6);
  expect(r.adjusted.dy).toBeCloseTo(2, 6);
  expect(r.pushbroom.d).toBeLessThan(1e-3);
  expect(r.pushbroom.info.is3d).toBe(true);
  expect(logs).toEqual([]);
});
