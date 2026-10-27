// Deferred R1 Shoulds: REQ-UI-04 (QAT, recent projects), REQ-SEC-06 (journal off or encrypted),
// REQ-UI-19 (Image List), REQ-UI-25/REQ-FMT-13 (point files), REQ-IMG-30 (AOIs as scopes, legend),
// REQ-IMG-08 (CLAHE), REQ-IMG-10 (pan-sharpening), REQ-IMG-20 (merged image segments), REQ-IMG-17 and
// REQ-MEN-08 (linked cursors, medial axis), the AI and whiteboard Shoulds and REQ-FMT-17 (HTJ2K).
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';
import { writeGeoTiff } from '../../app/src/formats/geotiff-writer.js';
import { writeNitf, writeNitfSegments } from '../../app/src/formats/nitf-writer.js';

const FX01 = resolve('fixtures/fx01/fx01.ntf');
const dir = mkdtempSync(join(tmpdir(), 'gw-shoulds-'));

async function withFx01(page) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex && !l.tiles.loading));
  return { frame, logs };
}

/** Screen pixels (RGB) of the active pane at fractions of its size. */
const pixels = (frame, pts) =>
  frame.evaluate(async (pts) => {
    await new Promise((r) => setTimeout(r, 400));
    const app = window.gisworkbench;
    const cap = app.renderer.capture();
    const b = app.activePane().el.getBoundingClientRect();
    return pts.map(([fx, fy]) => {
      const i = (Math.round((b.top + fy * b.height) * cap.dpr) * cap.width + Math.round((b.left + fx * b.width) * cap.dpr)) * 4;
      return [cap.data[i], cap.data[i + 1], cap.data[i + 2]];
    });
  }, pts);

test('REQ-UI-04 REQ-SEC-06 QAT customisation, recent projects, encrypted journal recovery', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.setQat(['qat.undo', '-', 'tools.imagelist', 'nav.whole']);
    const qat = [...document.querySelectorAll('[data-id^="qat:"]')].map((e) => e.dataset.id);
    await app.noteRecent('a.gwb', null);
    await app.noteRecent('b.gwb', null);
    await app.noteRecent('a.gwb', null);
    const recent = (await app.recentProjects()).map((x) => x.name);
    await app.setJournalPassphrase('correct horse');
    app.store.transact('Secret edit', (tx) => tx.create('vlayer', { name: 'Encrypted journal layer', visible: true, fields: [], source: { format: 'new' } }));
    await app.journal.flush();
    const raw = await app.journal.recoverable();
    return { qat, recent, enc: raw.enc, plainLeak: JSON.stringify(Array.from(raw.data ?? [])).includes('Encrypted journal layer') };
  });
  expect(r.qat).toEqual(['qat:qat.undo', 'qat:tools.imagelist', 'qat:nav.whole', 'qat:qat.customize']);
  expect(r.recent).toEqual(['a.gwb', 'b.gwb']);
  expect(r.enc).toMatch(/AES-GCM/);
  expect(r.plainLeak).toBe(false);
  await page.reload();
  const f2 = page.mainFrame();
  await f2.waitForFunction(() => document.body.dataset.ready);
  const toast = f2.locator('.toast', { hasText: 'encrypted' });
  await expect(toast).toBeVisible({ timeout: 10000 });
  await toast.getByRole('button', { name: 'Recover' }).click();
  const dlg = f2.locator('.dlg', { hasText: 'Session passphrase' });
  await dlg.locator('input').fill('correct horse');
  await dlg.getByRole('button', { name: 'OK' }).click();
  await f2.waitForFunction(() => window.gisworkbench.store.all('vlayer').some((v) => v.name === 'Encrypted journal layer'));
  // Turning the journal off clears it.
  const off = await f2.evaluate(async () => {
    const app = window.gisworkbench;
    app.journal.setEnabled(false);
    await new Promise((res) => setTimeout(res, 100));
    app.store.transact('after off', (tx) => tx.create('vlayer', { name: 'x', visible: true, fields: [], source: { format: 'new' } }));
    await app.journal.flush();
    return await app.journal.recoverable();
  });
  expect(off).toBeNull();
});

test('REQ-UI-19 REQ-UI-25 REQ-FMT-13 Image List and point files', async ({ page }) => {
  const { frame } = await withFx01(page);
  await frame.evaluate(() => void window.gisworkbench.commands.run('tools.imagelist'));
  const table = frame.locator('[data-id="panel:imagelist"] table');
  await expect(table).toContainText('FX01 SYNTHETIC PAN 4096');
  await expect(table).toContainText('2026-03-15 18:30:00Z');
  await table.locator('tbody input[type=checkbox]').first().uncheck();
  expect(await frame.evaluate(() => [...window.gisworkbench.layers.values()][0].rec.footprint)).toBe(false);
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const csv = 'name,lat,lon,height,kind\n"Mast, north",34.501,-116.502,700.5,mast\nTower,34.499,-116.498,,tower\nBad,95,0,,x\n';
    const a = app.pointsFromText(csv, { lat: 1, lon: 2, coord: null, name: 0, height: 3 }, { name: 'pts' });
    const dms = app.pointsFromText("id;lat;lon\nP1;34°30'00\"N;116°30'00\"W\n", { lat: 1, lon: 2, coord: null, name: 0, height: -1 });
    const mg = app.pointsFromText('site\tmgrs\nS1\t11SNU4590117710\n', { lat: -1, lon: -1, coord: 1, name: 0, height: -1 });
    return { n: a.layer.features.length, errors: a.errors, first: a.layer.features[0], second: a.layer.features[1].geom.xyz, dms: dms.layer.features[0].geom.xyz, mg: mg.layer.features[0].geom.xyz, fields: a.layer.fields };
  });
  expect(r.n).toBe(2);
  expect(r.errors[0]).toMatch(/row 4/);
  expect(r.first.name).toBe('Mast, north');
  expect(r.first.geom.xyz).toEqual([-116.502, 34.501, 700.5]);
  expect(r.first.attrs.kind).toBe('mast');
  expect(r.dms[0]).toBeCloseTo(-116.5, 9);
  expect(r.dms[1]).toBeCloseTo(34.5, 9);
  expect(r.mg[1]).toBeCloseTo(34.5, 4);
});

test('REQ-IMG-30 AOI scopes DRA, chips, selection; the legend lists graphics and vectors', async ({ page }) => {
  const { frame, logs } = await withFx01(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    p.setView({ cx: 2048, cy: 2048, zoom: 0.25, rot: 0, mode: 'native' });
    const ring = [[300, 300], [900, 300], [900, 900], [300, 900]].map(([x, y]) => {
      const g = l.groundAt(x, y);
      return [g.lon, g.lat, g.h];
    });
    app.setAoi(ring);
    const box = app.aoiBox(p, l);
    // DRA scoped to the AOI differs from full-image DRA.
    app.setChain((c) => ((c.stretch = 'dra'), (c.dra.scope = 'full')), 'full');
    await new Promise((res) => setTimeout(res, 300));
    const full = [...l.lutParams.map((x) => [x.lo, x.hi])];
    app.setChain((c) => (c.dra.scope = 'aoi'), 'aoi');
    for (let i = 0; i < 20 && !l.viewHist; i++) {
      p.invalidate();
      await new Promise((res) => setTimeout(res, 150));
    }
    l.updateLut(true);
    const aoi = [...l.lutParams.map((x) => [x.lo, x.hi])];
    // Chip Current View frames the AOI.
    const opts = app.chipViewOpts(p);
    const chip = await app.makeChip(opts);
    const ci = chip.record.cornersImage;
    // Select by Location inside the AOI; legend entries.
    const inside = l.groundAt(600, 600);
    const outside = l.groundAt(2000, 2000);
    const ids = [inside, outside].map((g) => app.commitFeature(p, 'Point', [{ lon: g.lon, lat: g.lat, h: g.h, zsrc: 't' }]));
    const vl = app.store.get(ids[0]).vlayer;
    const n = app.selectByLocation(vl, 'aoi');
    app.store.transact('legend', (tx) => tx.set(p.id, 'legend', true));
    const legend = app.legendEntries(p);
    return { box, full, aoi, ci, n, legend: legend.map((e) => `${e.kind}:${e.label}:${e.n}`) };
  });
  expect(Math.round(r.box.x0)).toBe(300);
  expect(Math.round(r.box.x1)).toBe(900);
  expect(r.aoi).not.toEqual(r.full);
  // The chip covers the AOI with a 5 % margin: corners within ~ 10 % of the box.
  // The chip covers the AOI (wider than tall, so the margin is wider across).
  expect(Math.min(...r.ci.map((c) => c[0]))).toBeLessThanOrEqual(300);
  expect(Math.max(...r.ci.map((c) => c[0]))).toBeGreaterThanOrEqual(900);
  expect(Math.min(...r.ci.map((c) => c[1]))).toBeLessThanOrEqual(300);
  expect(Math.max(...r.ci.map((c) => c[1]))).toBeGreaterThanOrEqual(900);
  expect(Math.max(...r.ci.map((c) => c[1])) - Math.min(...r.ci.map((c) => c[1]))).toBeLessThan(700);
  expect(r.n).toBe(1);
  expect(r.legend).toContain('vector:Features:2');
  expect(logs).toEqual([]);
});

test('REQ-IMG-08 CLAHE: tile maps blended on the GPU raise local contrast', async ({ page }) => {
  test.setTimeout(240_000); // GPU read-backs: ~90 s under the 4-worker full run (TE-017)
  const { frame, logs } = await withFx01(page);
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ cx: 2048, cy: 2048, zoom: 0.2, rot: 0, mode: 'native' }));
  const grid = [];
  for (let j = 0; j < 9; j++) for (let i = 0; i < 9; i++) grid.push([0.1 + i * 0.1, 0.1 + j * 0.1]);
  const before = await pixels(frame, grid);
  await frame.evaluate(() => window.gisworkbench.setChain((c) => (c.clahe = { on: true, grid: 8, clip: 3 }), 'CLAHE'));
  await frame.waitForFunction(() => !!window.gisworkbench.activeLayer().claheTex);
  const after = await pixels(frame, grid);
  const r = await frame.evaluate(() => {
    const l = window.gisworkbench.activeLayer();
    const m = l.claheMaps;
    // Every map is monotonic (equalisation never inverts tones).
    let mono = true;
    for (let c = 0; c < m.length / 256; c++) for (let i = 1; i < 256; i++) if (m[c * 256 + i] < m[c * 256 + i - 1]) mono = false;
    return { mono, grid: l.claheGrid, kernel: l.kernelEffective, summary: l.chain.clahe };
  });
  const sd = (a) => {
    const v = a.map((p) => p[0]);
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
  };
  expect(r.mono).toBe(true);
  expect(r.grid).toBe(8);
  expect(after).not.toEqual(before);
  expect(sd(after)).toBeGreaterThan(sd(before) * 0.9);
  expect(logs).toEqual([]);
});

test('REQ-IMG-10 pan-sharpening: Brovey keeps band ratios, fast IHS adds one detail term', async ({ page }) => {
  // A 1024² pan and a 4× coarser 4-band MS of the same ground: MS_k = gain_k × block mean of pan.
  const W = 1024;
  const pan = new Uint16Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) pan[y * W + x] = 800 + Math.round(600 * (0.5 + 0.5 * Math.sin(x / 7) * Math.cos(y / 11))) + ((x >> 5) + (y >> 5)) % 2 * 400;
  const gains = [0.8, 1.0, 1.2, 0.9];
  const M = W / 4;
  const ms = new Uint16Array(M * M * 4);
  for (let y = 0; y < M; y++)
    for (let x = 0; x < M; x++) {
      let s = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) s += pan[(4 * y + dy) * W + 4 * x + dx];
      for (let b = 0; b < 4; b++) ms[(y * M + x) * 4 + b] = Math.round((gains[b] * s) / 16);
    }
  const dd = 1e-5;
  writeFileSync(join(dir, 'ps_pan.tif'), await writeGeoTiff({ width: W, height: W, bands: 1, type: 'u16', data: pan }, { epsg: 4326, geotransform: [-116.5, dd, 0, 34.5, 0, -dd] }));
  writeFileSync(join(dir, 'ps_ms.tif'), await writeGeoTiff({ width: M, height: M, bands: 4, type: 'u16', data: ms }, { epsg: 4326, geotransform: [-116.5, 4 * dd, 0, 34.5, 0, -4 * dd] }));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [join(dir, 'ps_pan.tif')]);
  await openFiles(frame, [join(dir, 'ps_ms.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length === 2 && [...window.gisworkbench.layers.values()].every((l) => l.lutTex && l.modelId));
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const [panL, msL] = app.activePane().layers();
    // One linear stretch for every band so displayed values are proportional to DN.
    for (const l of [panL, msL]) app.setChain((c) => ((c.stretch = 'manual'), (c.manual = { 0: { lo: 0, hi: 3000 }, 1: { lo: 0, hi: 3000 }, 2: { lo: 0, hi: 3000 }, 3: { lo: 0, hi: 3000 } }), (c.kernel = 'nearest')), 'lin', { layerId: l.id });
    app.setChain((c) => (c.bands = [0, 1, 2]), 'rgb', { layerId: msL.id });
    app.activePane().setView({ cx: 512, cy: 512, zoom: 1, rot: 0, mode: 'native' });
    app.setPanSharpen(app.activePane(), { ms: msL.id, pan: panL.id, method: 'brovey' });
  });
  const pts = [[0.3, 0.3], [0.45, 0.6], [0.6, 0.4], [0.7, 0.7]];
  const br = await pixels(frame, pts);
  for (const [R, G, B] of br) {
    expect(Math.abs(R / G - 0.8)).toBeLessThan(0.05);
    expect(Math.abs(B / G - 1.2)).toBeLessThan(0.06);
  }
  const align = await frame.evaluate(() => window.gisworkbench.activePane().layers()[1].rec.align);
  expect(align[1]).toBeCloseTo(4, 3); // the MS sits on the pan grid
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    app.store.transact('off', (tx) => tx.set(p.id, 'pansharpen', { ...p.rec.pansharpen, on: false }));
    app.store.transact('hide pan', (tx) => tx.set(p.layers()[0].id, 'visible', false));
  });
  const msOnly = await pixels(frame, pts);
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    app.store.transact('show pan', (tx) => tx.set(p.layers()[0].id, 'visible', true));
    app.setPanSharpen(p, { ...p.rec.pansharpen, method: 'ihs' });
  });
  const ihs = await pixels(frame, pts);
  ihs.forEach((p, i) => {
    const d = p.map((v, k) => v - msOnly[i][k]);
    expect(Math.abs(d[0] - d[1])).toBeLessThanOrEqual(3);
    expect(Math.abs(d[2] - d[1])).toBeLessThanOrEqual(3);
  });
  for (const m of ['ihsnir', 'gs']) {
    await frame.evaluate((m) => {
      const p = window.gisworkbench.activePane();
      window.gisworkbench.setPanSharpen(p, { ...p.rec.pansharpen, method: m, nir: 3 });
    }, m);
    const px = await pixels(frame, pts);
    expect(px.some((p) => p[0] + p[1] + p[2] > 0), m).toBe(true);
  }
  expect(logs).toEqual([]);
});

test('REQ-IMG-20 attached NITF segments merge into one image', async ({ page }) => {
  const seg = (w, h, v) => ({ width: w, height: h, bands: 1, type: 'u8', planes: [new Uint8Array(w * h).fill(v)] });
  const bytes = writeNitfSegments(
    [
      { img: seg(300, 200, 50), opts: { iid1: 'BASE', idlvl: 1, ialvl: 0, iloc: [0, 0] } },
      { img: seg(120, 100, 150), opts: { iid1: 'RIGHT', idlvl: 2, ialvl: 1, iloc: [40, 250] } },
      { img: seg(80, 60, 250), opts: { iid1: 'BELOW', idlvl: 3, ialvl: 2, iloc: [90, 10] } },
    ],
    { marking: { level: 'U' }, title: 'Segments test' },
  );
  const file = join(dir, 'segments.ntf');
  writeFileSync(file, bytes);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [file]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length === 3 && [...window.gisworkbench.layers.values()].every((l) => l.lutTex));
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const before = app.activePane().layers().length;
    const mergeable = app.activeLayer().info.mergeable;
    const res = await app.setSegmentsMerged(true);
    await new Promise((x) => setTimeout(x, 300));
    const l = app.activePane().layers()[0];
    const px = async (x, y) => (await app.pool.run('pixels', { handle: l.handle, x, y, w: 1, h: 1, bands: [0] }, { affinity: l.affinity })).values[0][0];
    return { before, mergeable, res, size: [l.width, l.height], vals: [await px(10, 10), await px(300, 60), await px(265, 140), await px(360, 190)] };
  });
  expect(r.before).toBe(3);
  expect(r.mergeable).toBe(true);
  expect(r.res).toMatchObject({ layers: 1, merged: true });
  expect(r.size).toEqual([370, 200]); // RIGHT ends at x = 250 + 120; BELOW spans y 130–190 inside the base height
  expect(r.vals).toEqual([50, 150, 250, 0]);
  expect(logs).toEqual([]);
});

test('REQ-MEN-08 REQ-IMG-17 medial axis, line centre point and linked cursors', async ({ page }) => {
  const { frame, logs } = await withFx01(page);
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    const c = l.groundAt(2048, 2048);
    // A 120 × 12 m strip rotated 30°, built with geodesics from the image centre.
    const at = (e, n) => {
      const d = Math.hypot(e, n);
      const az = (Math.atan2(e, n) * 180) / Math.PI;
      const q = d ? app.core.direct(c.lat, c.lon, az, d) : { lat: c.lat, lon: c.lon };
      return [q.lon, q.lat, c.h];
    };
    const rot = (x, y) => [x * Math.cos(0.52) - y * Math.sin(0.52), x * Math.sin(0.52) + y * Math.cos(0.52)];
    const ring = [[-60, -6], [60, -6], [60, 6], [-60, 6]].map(([x, y]) => at(...rot(x, y)));
    const fid = app.commitFeature(p, 'Polygon', ring.map(([lon, lat, h]) => ({ lon, lat, h, zsrc: 't' })));
    app.selection.clear();
    app.selection.add(fid);
    app.commands.run('men.medial');
    const row = app.store.all('measurement').at(-1);
    // Line centre: an L-shaped line 100 m east then 50 m north; the centre is 75 m along.
    const line = [at(0, 0), at(100, 0), at(100, 50)];
    const lid = app.commitFeature(p, 'LineString', line.map(([lon, lat, h]) => ({ lon, lat, h, zsrc: 't' })));
    app.selection.clear();
    app.selection.add(lid);
    app.commands.run('men.centre');
    const crow = app.store.all('measurement').at(-1);
    const expect75 = at(75, 0);
    const dc = app.core.inverse(crow.coords.lat, crow.coords.lon, expect75[1], expect75[0]).distance;
    return { row: { mtype: row.mtype, value: row.value, extra: row.extra }, dc, cobj: crow.object };
  });
  expect(r.row.mtype).toBe('Medial axis');
  expect(Math.abs(r.row.value - 120) / 120).toBeLessThan(0.02);
  expect(Math.abs(r.row.extra.meanWidth - 12)).toBeLessThan(1);
  expect(r.dc).toBeLessThan(0.05);
  expect(r.cobj).toMatch(/^centre of/);
  // Linked cursors: two linked panels on the same image.
  await frame.evaluate(() => window.gisworkbench.activeMp().setLayout('1x2'));
  await frame.evaluate(() => window.gisworkbench.activeMp().setActivePane(window.gisworkbench.activeMp().panes[1]));
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => window.gisworkbench.activeMp().panes.every((p) => p.layers().some((l) => l.lutTex)));
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const [a, b] = app.activeMp().panes;
    app.links.groups.set(a.id, 'A');
    app.links.groups.set(b.id, 'A');
    a.setView({ cx: 2000, cy: 2000, zoom: 0.5, rot: 0, mode: 'native' });
    b.setView({ cx: 2000, cy: 2000, zoom: 0.5, rot: 0, mode: 'native' });
  });
  const boxA = await frame.locator('.multiport .pane').nth(0).boundingBox();
  await page.mouse.move(boxA.x + boxA.width * 0.3, boxA.y + boxA.height * 0.4);
  await page.waitForTimeout(150);
  const lc = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const [a, b] = app.activeMp().panes;
    const s = app.linkedCursorIn(b);
    const ga = app.cursorGround;
    const q = b.geoLayer().imageAt(ga.lat, ga.lon, ga.h);
    const sb = b.screenPoint(q.x, q.y);
    return { s, sb, self: app.linkedCursorIn(a) };
  });
  expect(lc.self).toBeNull();
  expect(Math.hypot(lc.s.x - lc.sb.x, lc.s.y - lc.sb.y)).toBeLessThan(0.5);
  expect(logs).toEqual([]);
});

test('REQ-AI-09 REQ-AI-11 REQ-AI-14 REQ-AI-15 REQ-WB-13 Describe View, help tools, MCP client and bridge, page to observation', async ({ page }) => {
  const { frame, logs } = await withFx01(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    app.prefs.set('aiConnections', [{ id: 'conn_mock', name: 'Mock', provider: 'mock', baseURL: '', model: 'mock-model', effort: 'medium' }]);
    app.prefs.set('aiActive', 'conn_mock');
    app.ai.assistant.consented = true; // consent itself is PT-12
    app.ai.mock.script.push({ role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '(U) A paved apron with three parked aircraft. Measure the apron length. Confidence: high' }] });
    const d = await app.describeView();
    const req = app.ai.mock.requests.at(-1);
    const prop = app.proposals.pending().find((p) => p.id === d.proposal);
    const reg = app.registry;
    const help = JSON.parse((await reg.call('gw_help_search', { query: 'CE90 accuracy limits' })).content);
    const tres = JSON.parse((await reg.call('gw_explain_tres', {})).content);
    const budget = JSON.parse((await reg.call('gw_error_budget', {})).content);
    // MCP client against an in-page fake server.
    const fake = async (url, init) => {
      const m = init.body ? JSON.parse(init.body) : null;
      const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'S9' } });
      if (m?.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake' } } });
      if (m?.method === 'tools/list') return json({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { s: { type: 'string' } } }, annotations: { readOnlyHint: true } }] } });
      if (m?.method === 'tools/call') return json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo ${m.params.arguments.s}` }] } });
      return new Response('', { status: 202 });
    };
    const c = await app.connectMcp({ id: 'srv1', name: 'Fake', url: 'https://mcp.example/mcp', auth: 'none' }, { fetchFn: fake });
    const echo = await reg.call('mcp__srv1__echo', { s: 'hi' });
    let csp = null;
    try {
      await app.connectMcp({ id: 'srv2', name: 'Blocked', url: 'https://blocked.example/mcp', auth: 'none' });
    } catch (e) {
      csp = e.message;
    }
    // Server: console API and the postMessage bridge.
    const listed = await app.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const replies = [];
    window.addEventListener('message', (e) => e.data?.gwMcp && e.data.message?.result && replies.push(e.data.message));
    const ownOrigin = await new Promise((res) => {
      const f = (e) => e.data === 'probe' && (window.removeEventListener('message', f), res(e.origin));
      window.addEventListener('message', f);
      window.postMessage('probe', '*');
    });
    const ping = async () => {
      window.postMessage({ gwMcp: 1, message: { jsonrpc: '2.0', id: 7, method: 'ping' } }, '*');
      await new Promise((r) => setTimeout(r, 200));
    };
    app.setMcpBridge({ on: true, origins: ['https://agent.example'] });
    await ping();
    const before = replies.length;
    app.setMcpBridge({ on: true, origins: [ownOrigin] });
    await ping();
    const after = replies.length;
    app.setMcpBridge({ on: false });
    // REQ-WB-13: a feedback page becomes an observation and an annotation; both undo.
    const l = app.activePane().geoLayer();
    const g = l.groundAt(2000, 2000);
    const pg = { id: 'pg_t', type: 'bug', summary: 'Hangar door open', notes: 'Check the north side', pins: [{ n: 1, note: 'here', target: { id: `layer:${l.id}`, label: 'fx01' } }], context: { image: 'fx01', centre: { lat: g.lat, lon: g.lon } } };
    const nObs = app.store.all('observation').length;
    const oid = app.pageToObservation(pg);
    const obs = app.store.get(oid);
    app.undo.undo();
    const obsGone = !app.store.get(oid) && app.store.all('observation').length === nObs;
    const gid = app.pageToAnnotation(pg);
    const gr = app.store.get(gid);
    app.undo.undo();
    return {
      blocks: req.messages[0].content.map((b) => b.type),
      metaSent: /Metadata/.test(req.messages[0].content.at(-1).text),
      prop: { text: prop?.preview ?? null, source: prop?.provenance.source, conf: d.confidence },
      descText: d.text,
      help: help.length,
      helpSources: [...new Set(help.map((x) => x.source))],
      tres: Array.isArray(tres),
      budget: [typeof budget.ce90, budget.model],
      mcpTools: c.tools.length,
      echo: echo.content,
      csp,
      listedHas: listed.result.tools.some((t) => t.name === 'gw_help_search'),
      bridge: [before, after],
      obs: { text: obs.text, links: obs.links, fromPage: obs.fromPage },
      obsGone,
      gr: { shape: gr.shape, text: gr.text },
      grGone: !app.store.get(gid),
    };
  });
  expect(r.blocks).toEqual(['image', 'text']);
  expect(r.metaSent).toBe(true);
  expect(r.prop.source).toBe('describe view');
  expect(r.prop.conf).toBe('high');
  expect(r.descText).not.toMatch(/Confidence/);
  expect(r.help).toBeGreaterThan(0);
  expect(r.tres).toBe(true);
  expect(r.budget[0]).toBe('number');
  expect(r.mcpTools).toBe(1);
  expect(r.echo).toBe('echo hi');
  expect(r.csp).toMatch(/allow-list/);
  expect(r.listedHas).toBe(true);
  expect(r.bridge).toEqual([0, 1]);
  expect(r.obs.text).toContain('Hangar door open');
  expect(r.obs.text).toContain('Pin 1 (fx01): here');
  expect(r.obs.links[0].kind).toBe('layer');
  expect(r.obs.fromPage).toBe('pg_t');
  expect(r.obsGone).toBe(true);
  expect(r.gr).toEqual({ shape: 'callout', text: 'Hangar door open' });
  expect(r.grGone).toBe(true);
  expect(logs).toEqual([]);
});

test('REQ-FMT-17 an HTJ2K codestream in a NITF (IC=C8) opens and decodes losslessly', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const cs = new Uint8Array(readFileSync(resolve('fixtures/htj2k/ht_mono11_tiles.j2c')));
  const ref = new Uint16Array(new Uint8Array(readFileSync(resolve('fixtures/htj2k/ht_mono11_tiles.ref'))).buffer);
  const file = join(dir, 'htj2k.ntf');
  writeFileSync(file, writeNitf({ width: 517, height: 389, bands: 1, type: 'u16', planes: [] }, { codestream: cs, abpp: 11, iid1: 'HTJ2K', corners: [[34.01, -117.02], [34.01, -117.0], [34.0, -117.0], [34.0, -117.02]] }));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [file]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex && !l.tiles.loading), null, { timeout: 30000 });
  const pts = [[0, 0], [516, 0], [258, 129], [100, 300], [516, 388]];
  const r = await frame.evaluate(async (pts) => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const px = async (x, y) => (await app.pool.run('pixels', { handle: l.handle, x, y, w: 1, h: 1, bands: [0] }, { affinity: l.affinity })).values[0][0];
    const vals = [];
    for (const [x, y] of pts) vals.push(await px(x, y));
    return { size: [l.width, l.height], ic: l.info.subheader?.IC, vals };
  }, pts);
  expect(r.size).toEqual([517, 389]);
  expect(r.ic).toBe('C8');
  expect(r.vals).toEqual(pts.map(([x, y]) => ref[y * 517 + x]));
  expect(logs).toEqual([]);
});
