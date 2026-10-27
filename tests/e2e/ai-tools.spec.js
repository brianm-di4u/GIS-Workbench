// REQ-AI-08 GIS tools for the assistant: jump to a coordinate, query and create features, square
// a building, measure, make a chip and outline the report. Read tools compute every number in
// the core; write tools only propose, and nothing changes until the analyst accepts.
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import geodesicPkg from 'geographiclib-geodesic';
import { openApp, openFiles } from './helpers.js';

const geod = geodesicPkg.Geodesic.WGS84;

test('REQ-AI-08 navigation, feature, mensuration and product tools', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx01/fx01.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const reg = app.registry;
    const call = async (n, a) => {
      const x = await reg.call(n, a, { source: 'test', connection: 'test', model: 'test' });
      if (x.isError) throw new Error(`${n}: ${x.content}`);
      return x;
    };
    const names = reg.listTools().map((t) => t.name);
    const jump = JSON.parse((await call('gw_jump_to', { coordinate: '11SNU4590117710' })).content);
    const p = app.activePane();
    const centre = p.geoLayer().groundAt(p.view.cx, p.view.cy);
    // Write tools propose; nothing changes until accepted.
    const lon = jump.lon;
    const lat = jump.lat;
    const ring = [[lon, lat], [lon + 0.0002, lat + 0.00001], [lon + 0.00019, lat + 0.00012], [lon - 0.00001, lat + 0.00011]];
    const prop = await call('gw_create_feature', { type: 'Polygon', coordinates: ring, name: 'Hangar', attrs: { class_code: 'AL013' } });
    const before = app.store.all('feature').length;
    app.proposals.accept(prop.proposal.id);
    const f = app.store.all('feature').at(-1);
    const q = JSON.parse((await call('gw_query_features', { field: 'class_code', op: '=', value: 'AL013' })).content);
    const sq = await call('gw_square_feature', { feature: f.id });
    app.proposals.accept(sq.proposal.id);
    const g = app.store.get(f.id).geom;
    const n = g.xyz.length / 3;
    const pts = Array.from({ length: n }, (_, i) => app.core.enu(g.xyz[3 * i + 1], g.xyz[3 * i], g.xyz[3 * i + 2], g.xyz[1], g.xyz[0], g.xyz[2]));
    const ang = pts.map((b, i) => {
      const a = pts[(i + n - 1) % n];
      const c = pts[(i + 1) % n];
      const u = [a[0] - b[0], a[1] - b[1]];
      const v = [c[0] - b[0], c[1] - b[1]];
      return (Math.acos((u[0] * v[0] + u[1] * v[1]) / Math.hypot(...u) / Math.hypot(...v)) * 180) / Math.PI;
    });
    const dist = JSON.parse((await call('gw_measure', { kind: 'distance', coordinates: [[lon, lat], [lon + 0.01, lat + 0.005]] })).content);
    const area = JSON.parse((await call('gw_measure', { kind: 'area', coordinates: ring })).content);
    const chip = JSON.parse((await call('gw_make_chip', { width: 512, height: 384 })).content);
    const outline = JSON.parse((await call('gw_report_outline', {})).content);
    return { names, jump, centre, before, q, ang, dist, area, chip, outline, measurements: app.store.all('measurement').length, chips: app.store.all('chip').length };
  });
  expect(r.names).toEqual(expect.arrayContaining(['gw_jump_to', 'gw_query_features', 'gw_create_feature', 'gw_square_feature', 'gw_measure', 'gw_make_chip', 'gw_report_outline']));
  expect(r.jump.mgrs).toBe('11SNU4590117710');
  expect(Math.abs(r.centre.lat - r.jump.lat)).toBeLessThan(2e-5);
  expect(r.before).toBe(0);
  expect(r.q.count).toBe(1);
  expect(r.q.features[0].name).toBe('Hangar');
  for (const a of r.ang) expect(Math.abs(a - 90)).toBeLessThan(0.1);
  const ref = geod.Inverse(r.jump.lat, r.jump.lon, r.jump.lat + 0.005, r.jump.lon + 0.01);
  expect(Math.abs(r.dist.distanceM - ref.s12)).toBeLessThan(0.001);
  expect(r.area.areaM2).toBeGreaterThan(0);
  expect(r.chip.marking.text).toBe('UNCLASSIFIED');
  expect(r.chip.centreMgrs).toMatch(/^11SNU/);
  expect(r.outline.banner).toBe('UNCLASSIFIED');
  expect(r.outline.sections).toContain('Mensuration table');
  // Read tools wrote nothing.
  expect(r.measurements).toBe(0);
  expect(r.chips).toBe(0);
  expect(logs).toEqual([]);
});
