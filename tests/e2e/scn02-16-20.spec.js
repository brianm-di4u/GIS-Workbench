// SCN-02 (second-phase report with annotated chips), SCN-16 (products from templates) and
// SCN-20 (AI-assisted report, mock provider) on the FX fixtures: AC-02.2, AC-02.3, AC-02.5,
// AT-16.1, AT-16.2, AT-16.4, and the SCN-20 flow with provenance labels.
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const FX01 = resolve('fixtures/fx01/fx01.ntf');
const FX03 = resolve('fixtures/fx03/fx03.ntf');
const FX05 = resolve('fixtures/fx05/fx05_dem_hae.tif');

async function withTerrain(frame) {
  await openFiles(frame, [FX05]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => /fx05/.test(l.rec.name) && l.stats));
  await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const dem = [...app.layers.values()].find((l) => /fx05/.test(l.rec.name));
    await app.useAsTerrain(dem, 'hae');
    const img = [...app.layers.values()].find((l) => /fx01/.test(l.rec.name));
    app.store.transact('hide dem', (tx) => {
      tx.set(dem.id, 'visible', false);
      tx.set(app.activePane().id, 'activeLayer', img.id);
    });
  });
}

test('SCN-02 AC-02.2 AC-02.3 AC-02.5 chips, autolabels moved between images, table and report', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  await frame.evaluate(() => window.gisworkbench.activeMp().setLayout('1x2'));
  await frame.evaluate(() => window.gisworkbench.activeMp().setActivePane(window.gisworkbench.activeMp().panes[1]));
  await openFiles(frame, [FX03]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length === 2 && [...window.gisworkbench.layers.values()].every((l) => l.lutTex));
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const mp = app.activeMp();
    const [a, b] = mp.panes;
    mp.setActivePane(a);
    // AC-02.3: an autolabel on panel A, then moved to panel B (another image).
    const tpl = '{IMAGE_ID} {ACQ_DAY|no date}';
    let gid;
    app.store.transact('label', (tx) => {
      const gl = tx.create('glayer', { pane: a.id, name: 'Graphics', visible: true, saved: false });
      tx.set(a.id, 'graphicsLayer', gl);
      gid = tx.create('graphic', { glayer: gl, pane: a.id, shape: 'text', anchor: 'screen', coords: [[0.05, 0.1]], template: tpl, text: '', style: { stroke: '#fff', fill: '#fff', fontSize: 13 } });
    });
    const onA = app.resolveLabel(a, tpl);
    const seen = [];
    const g = b.overlay.getContext('2d');
    const orig = g.fillText.bind(g);
    g.fillText = (t, ...rest) => (seen.push(String(t)), orig(t, ...rest));
    app.store.transact('move label', (tx) => tx.set(gid, 'pane', b.id));
    b.invalidate();
    await new Promise((res) => setTimeout(res, 300));
    g.fillText = orig;
    // AC-02.2: a measured point fills every §5.3 column; empty values say N/A.
    const la = a.geoLayer();
    const gp = la.groundWithTerrain(2000, 2000);
    const row = app.measureApi.pointRow(la, { ...gp, x: 2000, y: 2000 }, gp, app.measureApi.errorFor(la, 2000, 2000, gp));
    app.measureApi.logRow(row, a);
    const m = app.store.all('measurement').at(-1);
    // Chips: an overview and three detail chips.
    for (const [x, y, z] of [[2048, 2048, 0.15], [1500, 1500, 1], [2500, 1800, 1], [2200, 2600, 1]]) {
      a.setView({ cx: x, cy: y, zoom: z, rot: 0, mode: 'native' });
      const c = await app.makeChip({ width: 640, height: 480 });
      app.store.transact('chip', (tx) => tx.create('chip', { ...c.record, pane: a.id }));
      app.chipImages.set(c.record.number, c.canvas.toDataURL('image/jpeg', 0.7));
    }
    const html = app.buildReport({ title: 'Facility report', type: 'Second phase (SUPIR-style)', bluf: '(U) Test values only.' });
    return { onA, seen, m, figures: (html.match(/<figure>/g) ?? []).length, menRows: (html.match(/<h2>Mensuration table<\/h2>\s*<table>[\s\S]*?<\/table>/)?.[0].match(/<tr>/g) ?? []).length };
  });
  expect(r.onA).toBe('FX01 SYNTHETIC PAN 4096 2026-03-15'); // IID2, then the acquisition day
  expect(r.seen).toContain('FX03 SYNTHETIC OBLIQUE 20 DEG 2026-06-01');
  expect(r.seen.some((t) => /FX01/.test(t))).toBe(false);
  expect(r.figures).toBe(4);
  expect(r.menRows).toBe(2); // header + one row
  const cols = await frame.evaluate((m) => window.gisworkbench.menRowOf(m), r.m);
  for (const [k, v] of Object.entries(cols)) expect(String(v), k).not.toBe('');
  expect(cols.object).toBe('N/A');
  // AC-02.5: graphics GeoJSON re-imports with the same coordinates and style.
  const gj = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activeMp().panes[0];
    const l = p.geoLayer();
    const pts = [[1800, 1800], [2100, 1850], [2000, 2150]].map(([x, y]) => l.groundAt(x, y));
    app.store.transact('poly', (tx) => tx.create('graphic', { glayer: p.rec.graphicsLayer, pane: p.id, shape: 'polygon', anchor: 'ground', coords: pts.map((q) => [q.lon, q.lat, q.h]), style: { stroke: '#12ab34', width: 3, fill: '#12ab3440', dash: 'dashed' }, text: 'AOI' }));
    const src = app.store.all('graphic').filter((g) => g.anchor === 'ground');
    return { text: JSON.stringify(app.graphicsGeoJson(src)), src: src.map((g) => ({ coords: g.coords, style: g.style })) };
  });
  const dir = mkdtempSync(join(tmpdir(), 'gw-scn02-'));
  writeFileSync(join(dir, 'graphics.geojson'), gj.text);
  const back = await frame.evaluate(async (text) => {
    const app = window.gisworkbench;
    const before = app.store.all('graphic').length;
    await app.loadGraphicsFile(new File([text], 'graphics.geojson', { type: 'application/geo+json' }), app.activeMp().panes[0]);
    return app.store.all('graphic').slice(before).map((g) => ({ coords: g.coords, style: g.style }));
  }, gj.text);
  expect(back).toHaveLength(gj.src.length);
  back.forEach((b, i) => {
    b.coords.forEach((c, k) => {
      expect(Math.abs(c[0] - gj.src[i].coords[k][0])).toBeLessThan(1e-9);
      expect(Math.abs(c[1] - gj.src[i].coords[k][1])).toBeLessThan(1e-9);
    });
    expect(b.style).toMatchObject(gj.src[i].style);
  });
  expect(logs).toEqual([]);
});

test('SCN-16 AT-16.1 AT-16.2 AT-16.4 map sheet at 1:5 000 with an MGRS grid on FX-01', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  await withTerrain(frame);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    p.setView({ cx: 2048, cy: 2048, zoom: 0.4, rot: 0, mode: 'native' });
    const t = { ...app.productTemplate(), scale: 5000, grid: 'mgrs', gridInterval: 100, page: { size: 'A4', orientation: 'landscape', dpi: 150, marginMm: 8 } };
    // Record the frame's grid strokes and labels.
    const P = CanvasRenderingContext2D.prototype;
    const orig = { moveTo: P.moveTo, lineTo: P.lineTo, beginPath: P.beginPath, stroke: P.stroke, fillText: P.fillText };
    const lines = [];
    const texts = [];
    let cur = [];
    P.beginPath = function (...a) {
      cur = [];
      return orig.beginPath.apply(this, a);
    };
    P.moveTo = function (x, y) {
      cur.push([x, y, 'M']);
      return orig.moveTo.call(this, x, y);
    };
    P.lineTo = function (x, y) {
      cur.push([x, y, 'L']);
      return orig.lineTo.call(this, x, y);
    };
    P.stroke = function (...a) {
      if (String(this.strokeStyle).toLowerCase() === '#00e5ff' && cur.length > 4) lines.push({ w: this.canvas.width, pts: cur.slice() });
      return orig.stroke.apply(this, a);
    };
    P.fillText = function (s, ...a) {
      texts.push(String(s));
      return orig.fillText.call(this, s, ...a);
    };
    let pg;
    try {
      pg = await app.renderProductPage(t);
    } finally {
      Object.assign(P, orig);
    }
    const cv = pg.view;
    const l = cv.geoLayer();
    // AT-16.1: 100 mm on paper at the frame centre is 500 m on the ground.
    const pxmm = pg.dpi / 25.4;
    const A = cv.imagePoint(cv.width / 2 - 50 * pxmm, cv.height / 2);
    const B = cv.imagePoint(cv.width / 2 + 50 * pxmm, cv.height / 2);
    // Scale is defined on the horizontal plane at the centre's terrain height.
    const hc = l.groundWithTerrain(cv.view.cx, cv.view.cy).h;
    const ga = app.core.i2g(l.modelId, A.x, A.y, hc);
    const gb = app.core.i2g(l.modelId, B.x, B.y, hc);
    const d = app.core.inverse(ga.lat, ga.lon, gb.lat, gb.lon).distance;
    // AT-16.2: every grid line keeps one UTM easting or northing, on a multiple of the step.
    const c = l.groundWithTerrain(cv.view.cx, cv.view.cy);
    // One stroke may hold several grid lines: split each path at its moveTo commands.
    const frameLines = lines
      .filter((x) => x.w === cv.width)
      .flatMap((x) => {
        const out = [];
        for (const q of x.pts) {
          if (q[2] === 'M' || !out.length) out.push({ pts: [] });
          out.at(-1).pts.push(q);
        }
        return out;
      })
      .filter((x) => x.pts.length > 4);
    const checks = frameLines.map((ln) => {
      const en = ln.pts.map(([x, y]) => {
        const q = cv.imagePoint(x, y);
        const g = app.core.i2g(l.modelId, q.x, q.y, c.h);
        return app.core.utm(g.lat, g.lon);
      });
      const E = en.map((u) => u.easting);
      const N = en.map((u) => u.northing);
      const spread = (v) => Math.max(...v) - Math.min(...v);
      const [k, v] = spread(E) < spread(N) ? ['E', E] : ['N', N];
      const mean = v.reduce((s, x) => s + x, 0) / v.length;
      return { k, spread: spread(v), mean };
    });
    // AT-16.4: an A3 page at 300 dpi renders in strips; the first and last carry the banners.
    const big = await app.renderProductPage({ ...t, scale: null, grid: 'off', raise: 'S', page: { size: 'A3', orientation: 'landscape', dpi: 300, marginMm: 8 } });
    const top = big.strips[0].canvas.getContext('2d').getImageData(4, 3, 1, 1).data;
    const last = big.strips.at(-1);
    const bot = last.canvas.getContext('2d').getImageData(4, last.h - 3, 1, 1).data;
    return { d, scale: pg.record.frame.scale, checks, texts: texts.filter((s) => /^[A-Z]{2} \d+$|^MGRS \d+$/.test(s)), strips: big.strips.length, top: [...top], bot: [...bot], mark: big.record.marking };
  });
  expect(Math.abs(r.d - 500) / 500).toBeLessThan(0.005);
  expect(r.scale).toBeGreaterThan(4975);
  expect(r.scale).toBeLessThan(5025);
  expect(r.checks.length).toBeGreaterThan(3);
  const steps = [100];
  for (const ck of r.checks) {
    expect(ck.spread).toBeLessThan(1); // straight UTM lines, within a metre along their length
    expect(steps.some((s) => Math.abs(ck.mean / s - Math.round(ck.mean / s)) * s < 1)).toBe(true);
  }
  expect(r.texts.some((t) => /^NU \d+$/.test(t))).toBe(true); // FX-01 lies in 11S NU
  expect(r.texts).toContain('MGRS 11');
  expect(r.strips).toBeGreaterThan(1);
  for (const px of [r.top, r.bot]) expect(px[0]).toBeGreaterThan(px[1] + 60); // red SECRET banner (raised)
  expect(r.mark.level).toBe('S');
  expect(logs).toEqual([]);
});

test('SCN-20 AI-assisted first-phase report: consent, proposals accepted and rejected, labelled draft', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.prefs.set('aiConnections', [{ id: 'conn_mock', name: 'Mock', provider: 'mock', baseURL: '', model: 'mock-model', effort: 'medium' }]);
    app.prefs.set('aiActive', 'conn_mock');
    app.emit('ai');
    // A measurement made by the analyst (the AI has no tool that writes measurements).
    const p = app.activePane();
    const l = p.geoLayer();
    const g = l.groundWithTerrain(2048, 2048);
    app.measureApi.logRow(app.measureApi.pointRow(l, { ...g, x: 2048, y: 2048 }, g, app.measureApi.errorFor(l, 2048, 2048, g)), p);
    void app.commands.run('ai.assistant');
  });
  const dock = frame.locator('.ai-page').first();
  const input = dock.getByLabel('Message to the assistant');
  // Two proposals, scripted: two gw_create_graphic calls, then a short answer.
  await frame.evaluate(() => {
    const m = window.gisworkbench.ai.mock;
    const call = (id, name, input) => ({ id: `m_${id}`, role: 'assistant', model: 'mock-model', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage: {} });
    m.script.push(
      call('tu1', 'gw_get_view', {}),
      (req) => {
        const view = JSON.parse(req.messages.at(-1).content[0].content);
        const c = view.centre;
        return { id: 'm2', role: 'assistant', model: 'mock-model', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'gw_create_graphic', input: { shape: 'point', coordinates: [[c.lon, c.lat]], text: 'Activity A' } }, { type: 'tool_use', id: 'tu3', name: 'gw_create_graphic', input: { shape: 'point', coordinates: [[c.lon + 0.0005, c.lat]], text: 'Activity B' } }], usage: {} };
      },
      { id: 'm3', role: 'assistant', model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'I proposed two points for review and drafted no measurements.' }], usage: {} },
    );
  });
  await input.fill('Draft a first-phase report for this image');
  await dock.getByRole('button', { name: 'Send' }).click();
  await frame.locator('.dlg').getByRole('button', { name: 'Agree and send' }).click();
  await frame.waitForFunction(() => !window.gisworkbench.ai.assistant.busy);
  const ids = await frame.evaluate(() => window.gisworkbench.proposals.pending().map((p) => p.id));
  expect(ids).toHaveLength(2);
  const out = await frame.evaluate(async (ids) => {
    const app = window.gisworkbench;
    // Reject first: accepting one proposal makes its siblings (same base) stale.
    app.proposals.reject(ids[1]);
    app.proposals.accept(ids[0]);
    app.ai.mock.script.push({ id: 'm4', role: 'assistant', model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'BLUF:\n(U) One activity point is marked for review (test value).\n\nCOMMENTS:\n(U) Cloud-free; single image.' }], usage: {} });
    const d = await app.draftReport({ type: 'First phase (IPIR-style)' });
    const html = app.buildReport({ title: 'AI-assisted quick report', bluf: d.bluf, comments: d.comments, aiDrafted: ['bluf', 'comments'] });
    const g = app.store.all('graphic');
    return { status: ids.map((id) => app.proposals.items.find((p) => p.id === id).status), graphics: g.map((x) => x.provenance?.kind), measurements: app.store.all('measurement').map((m) => m.provenance?.kind ?? m.source ?? 'analyst'), ai: (html.match(/AI-drafted/g) ?? []).length, tools: app.ai.mock.requests[0].tools, writers: app.registry.listTools().filter((t) => !t.annotations.readOnlyHint).map((t) => t.name), bluf: d.bluf };
  }, ids);
  expect(out.status).toEqual(['accepted', 'rejected']);
  expect(out.graphics).toEqual(['ai']);
  expect(out.ai).toBeGreaterThanOrEqual(2);
  expect(out.bluf).toMatch(/^\(U\) /);
  // No measurement came from the AI: no write tool touches the Mensuration Log (gw_measure only
  // computes), and the one row is the analyst's.
  expect(out.writers.some((t) => /measure|mensuration/.test(t))).toBe(false);
  expect(out.measurements).toHaveLength(1);
  expect(out.measurements[0]).not.toBe('ai');
  expect(logs).toEqual([]);
});
