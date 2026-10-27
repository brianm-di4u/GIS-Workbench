// SCN-06 (multi-image triangulation with GCPs and tie points, AT-06.1..06.5) and SCN-07
// (multi-image point, AT-07.1, 07.2, 07.5) on FX-04: four images with biased RPC00B, six GCPs
// and three checkpoints measured at their true positions (+0.3 px noise), automatic tie points.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx04');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx04_truth.json'), 'utf8'));
const GSD = truth.gsd;

test('SCN-06 SCN-07 REQ-SNS-11 REQ-SNS-13 REQ-SNS-15 REQ-SNS-16 REQ-MEN-11 FX-04 block adjustment, solutions and the multi-image point', async ({ page }) => {
  test.setTimeout(240000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, truth.images.map((i) => resolve(DIR, i.file)));
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 4, null, { timeout: 60000 });
  const csv = readFileSync(resolve(DIR, 'fx04_control.csv'), 'utf8');
  const r = await frame.evaluate(
    async ({ csv, truth }) => {
      const app = window.gisworkbench;
      const T = app.tri;
      let seed = 4;
      const noise = () => {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const u = seed / 2 ** 32;
        seed = (seed * 1103515245 + 12345) >>> 0;
        return 0.3 * Math.sqrt(-2 * Math.log(u + 1e-12)) * Math.cos(2 * Math.PI * (seed / 2 ** 32));
      };
      const imported = T.importControl(csv);
      const byIid = new Map(T.blockLayers().map((l) => [l.info.iid, l]));
      const pts = new Map(T.points().map((p) => [p.name, p]));
      for (const im of truth.images) for (const o of im.control) T.measure(pts.get(o.id).id, byIid.get(im.id).id, o.x + noise(), o.y + noise());
      const ties = await T.autoTiePoints();
      const rep = await T.solve({ kind: 'shift' });
      // AT-06.2: plant a blunder, see it flagged, exclude it and solve again.
      const tie = T.points().find((p) => p.kind === 'tie');
      const [lid, o] = Object.entries(tie.obs)[0];
      T.measure(tie.id, lid, o.x + 9, o.y);
      const withBlunder = await T.solve({ kind: 'shift' });
      const flagged = withBlunder.residuals.find((v) => v.point === tie.id && v.layer === lid);
      const cleaned = await T.solve({ kind: 'shift', exclude: new Set([`${tie.id}:${lid}`]) });
      T.measure(tie.id, lid, o.x, o.y);
      // AT-06.4: apply, then undo restores the original model bit for bit.
      const l1 = byIid.get('IMG1');
      const probe = () => app.core.g2i(l1.modelId, 34.5, -116.5, 650);
      const before = probe();
      const beforeName = l1.modelName;
      const label = T.applySolution(rep);
      const after = probe();
      const afterName = l1.modelName;
      // AT-06.5: a later point measurement records the solution.
      const pane = app.activePane();
      app.measureApi.logRow(app.measureApi.pointRow(l1, { x: 1024, y: 1024 }, l1.groundWithTerrain(1024, 1024), null), pane);
      const row = app.store.all('measurement').at(-1);
      // SCN-07: multi-image point of each checkpoint from three adjusted images.
      const mip = truth.control
        .filter((c) => c.kind === 'checkpoint')
        .map((c) => {
          const meas = truth.images.slice(0, 3).map((im) => ({ layer: byIid.get(im.id).id, ...im.control.find((q) => q.id === c.id) }));
          const m = T.multiImagePoint(meas.map((q) => ({ layer: q.layer, x: q.x, y: q.y })));
          const d = app.core.enu(m.lat, m.lon, m.h, c.lat, c.lon, c.hae);
          return { id: c.id, dh: Math.hypot(d[0], d[1]), dv: Math.abs(d[2]), ce90: m.ce90, le90: m.le90, msl: m.msl, hae: m.h, N: m.undulation, mgrs: m.mgrs, minConv: m.minConvergenceDeg, warning: m.warning, images: m.images.length };
        });
      const sup = JSON.parse(T.supText(l1));
      const fit = await T.refitRpc(l1);
      app.undo.undo(); // the logged point
      app.undo.undo(); // the applied solution
      await new Promise((x) => setTimeout(x, 50));
      const undone = probe();
      return { imported, ties, rep: { counts: rep.counts, sigma0: rep.sigma0, before: rep.before, after: rep.after, flags: rep.residuals.filter((v) => v.flagged).length, cols: Object.keys(rep.residuals[0]) }, blunder: { flagged: flagged?.flagged, s1: withBlunder.sigma0, s2: cleaned.sigma0 }, before, after, undone, beforeName, afterName, label, rowModel: row.model, mip, sup: { family: sup.solution.family, a: sup.correction.a }, fit: { rms: fit.rmsPx, max: fit.maxPx, pole: fit.poleFree }, nameAfterUndo: l1.modelName };
    },
    { csv, truth },
  );
  expect(r.imported).toBe(9);
  expect(r.ties.points).toBeGreaterThanOrEqual(12);
  // AT-06.1
  expect(r.rep.before.rmse3d).toBeGreaterThan(10);
  expect(r.rep.after.rmseR).toBeLessThanOrEqual(1.5 * GSD);
  expect(r.rep.after.rmse[2]).toBeLessThanOrEqual(1.5 * GSD);
  // AT-06.2
  expect(r.blunder.flagged).toBe(true);
  expect(r.blunder.s2).toBeLessThan(r.blunder.s1);
  // AT-06.3
  expect(r.rep.counts).toMatchObject({ images: 4, gcps: 6, checkpoints: 3 });
  expect(r.rep.counts.ties).toBe(r.ties.points);
  expect(r.rep.cols).toEqual(expect.arrayContaining(['image', 'pointName', 'vx', 'vy', 'flagged']));
  expect(Number.isFinite(r.rep.after.ce90) && Number.isFinite(r.rep.after.le90)).toBe(true);
  // AT-06.4 and AT-06.5
  expect(r.label).toBe('SOL-0001');
  expect(r.afterName).toContain('triangulated: SOL-0001');
  expect(Math.hypot(r.after.x - r.before.x, r.after.y - r.before.y)).toBeGreaterThan(10);
  expect(r.undone).toEqual(r.before);
  expect(r.nameAfterUndo).toBe(r.beforeName);
  expect(r.rowModel).toContain('triangulated: SOL-0001');
  // AT-07.1, 07.2, 07.5
  for (const m of r.mip) {
    expect(m.images).toBe(3);
    expect(m.dh).toBeLessThanOrEqual(GSD);
    expect(m.dv).toBeLessThanOrEqual(1.5 * GSD);
    expect(m.ce90).toBeGreaterThan(0);
    expect(m.minConv).toBeGreaterThan(10);
    expect(m.warning).toBe('');
    expect(Math.abs(m.hae - m.msl - m.N)).toBeLessThan(1e-9);
  }
  // REQ-SNS-15/16: the sidecar and the refitted RPC00B.
  expect(r.sup.family).toBe('Shift');
  expect(r.fit.max).toBeLessThan(0.05);
  expect(r.fit.pole).toBe(true);
  expect(logs).toEqual([]);
});
