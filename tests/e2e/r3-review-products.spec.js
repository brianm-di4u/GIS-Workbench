// R3 review and product rows: automation through MCP proposals (REQ-ARC-18), ML detection review
// with assistant help (REQ-EXT-19, REQ-AI-12), observations and the activity report
// (REQ-EXT-20), DOCX export and PowerPoint templates (REQ-PRD-09), and GIF/video clips in HTML
// and PPTX products (REQ-PRD-12).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { openApp, openFiles } from './helpers.js';

const P = (n) => resolve('fixtures/products', n);
const truth = JSON.parse(readFileSync(P('products_truth.json'), 'utf8'));
test.describe.configure({ timeout: 300000 });

const b64 = (a) => Buffer.from(a).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

test('REQ-ARC-18 the automation API through the MCP registry: list commands, propose a run, nothing happens until the analyst accepts', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx08/fx08.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const srv = app.mcpServer ?? app.ai?.mcpServer;
    const call = async (name, args) => (await app.registry.call(name, args, { source: 'mcp:console', model: 'test agent' }));
    const list = JSON.parse((await call('gw_list_commands', { filter: 'dock.layers' })).content);
    let opened = 0;
    const off = app.commands.on('run', (e) => e.id === 'det.review' && opened++);
    const prop = await call('gw_run_command', { command: 'det.review', reason: 'open the review queue' });
    const before = opened;
    const p = app.proposals.items.find((x) => x.id === prop.proposal.id);
    app.proposals.accept(p.id);
    await p.result;
    off?.();
    const bad = await call('gw_run_command', { command: 'no.such.command' });
    return { list, before, after: opened, status: p.status, title: p.title, cs: p.cs, bad: bad.content, hasServer: !!srv };
  });
  expect(r.list[0]).toMatchObject({ id: 'dock.layers', implemented: true });
  expect(r.before).toBe(0);
  expect(r.after).toBe(1);
  expect(r.status).toBe('accepted');
  expect(r.title).toMatch(/Detection|Review/);
  expect(r.cs).toBeNull();
  expect(r.bad).toMatch(/no command/);
  expect(logs).toEqual([]);
});

test('REQ-EXT-19 REQ-AI-12 ML detections: GeoJSON and CSV import, confidence filter, accept / reject / edit, accepted features; the assistant summarises and proposes decisions', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx08/fx08.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  await openFiles(frame, [P('fx08_detections.geojson')]).catch(() => null);
  const r = await frame.evaluate(async ({ geo, csv }) => {
    const app = window.gisworkbench;
    const D = app.detections;
    const nGeo = await D.importFile(new File([geo], 'fx08_detections.geojson'));
    const nCsv = await D.importFile(new File([csv], 'fx08_detections.csv'));
    const all = app.store.all('detection');
    const ground = all.filter((d) => d.anchor === 'ground').length;
    const pixel = all.filter((d) => d.anchor === 'image').length;
    D.options.minConfidence = 0.5;
    const q = D.queue();
    const top = q[0];
    // Accept the most confident, reject one, edit one.
    D.setStatus(top.id, 'accepted');
    const low = all.find((d) => d.confidence < 0.5);
    D.setStatus(low.id, 'rejected');
    const mid = D.queue({ status: 'pending' })[0];
    D.setStatus(mid.id, 'accepted', { cls: 'renamed class', note: 'edited' });
    const feats = app.store.all('feature').filter((f) => app.store.get(f.vlayer)?.role === 'accepted-detections');
    // The assistant: summary, then a proposal that rejects the low-confidence pixel boxes.
    const sum = JSON.parse((await app.registry.call('gw_list_detections', { minConfidence: 0 }, { source: 'assistant' })).content);
    const rej = sum.queue.filter((d) => d.status === 'pending' && d.confidence < 0.5).map((d) => ({ id: d.id, status: 'rejected', reason: 'low confidence on a field border' }));
    const pr = await app.registry.call('gw_review_detections', { decisions: rej }, { source: 'assistant', model: 'mock' });
    const pending = app.store.all('detection').filter((d) => rej.some((x) => x.id === d.id) && d.status === 'pending').length;
    app.proposals.accept(pr.proposal.id);
    const after = app.store.all('detection').filter((d) => rej.some((x) => x.id === d.id)).map((d) => d.status);
    app.activeMp().docks.show('detections');
    await new Promise((res) => setTimeout(res, 300));
    const dock = document.querySelector('[data-id="det-summary"]')?.textContent ?? '';
    const rows = document.querySelectorAll('[data-id="det-queue"] tbody tr').length;
    return { nGeo, nCsv, ground, pixel, q: q.length, topConf: top.confidence, feats: feats.map((f) => ({ cls: f.attrs.CLASS, type: f.geom.type })), sum: sum.summary, rejN: rej.length, pending, after, dock, rows, csvOut: D.csv().split('\n').length };
  }, { geo: readFileSync(P('fx08_detections.geojson'), 'utf8'), csv: readFileSync(P('fx08_detections.csv'), 'utf8') });
  const n = truth.detections.length;
  expect(r.nGeo).toBe(n);
  expect(r.nCsv).toBe(n);
  expect(r.ground).toBe(n);
  expect(r.pixel).toBe(n);
  expect(r.q).toBe(2 * truth.detections.filter((d) => d.confidence >= 0.5).length);
  expect(r.topConf).toBeCloseTo(0.97, 5);
  expect(r.feats.length).toBe(2);
  expect(r.feats.map((f) => f.cls)).toContain('renamed class');
  expect(r.feats.every((f) => f.type === 'Polygon')).toBe(true);
  expect(r.sum.total).toBe(2 * n);
  expect(r.rejN).toBeGreaterThan(0);
  expect(r.pending).toBe(r.rejN); // nothing changed before the proposal was accepted
  expect(r.after.every((s) => s === 'rejected')).toBe(true);
  expect(r.dock).toMatch(/detections/);
  expect(r.rows).toBeGreaterThan(0);
  expect(r.csvOut).toBe(2 * n + 2);
  expect(logs).toEqual([]);
});

test('REQ-EXT-20 REQ-PRD-09 observations linked to graphics and chips; table editing; activity report as HTML, CSV and DOCX; the report as DOCX', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx08/fx08.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    // A graphic to link: a ground polygon over field (1, 1).
    const ring = [[128, 128], [256, 128], [256, 256], [128, 256]].map(([x, y]) => l.groundAt(x, y));
    let gid;
    app.store.transact('g', (tx) => {
      const gl = tx.create('glayer', { pane: p.id, name: 'Graphics', visible: true });
      tx.set(p.id, 'graphicsLayer', gl);
      gid = tx.create('graphic', { glayer: gl, pane: p.id, shape: 'polygon', anchor: 'ground', coords: ring.map((g) => [g.lon, g.lat, g.h]), style: { stroke: '#ff0' } });
    });
    app.selection = new Set([gid]);
    const chip = await app.makeChip({ number: 1 });
    // As a saved chip does: its image is kept for reports.
    app.chipImages.set(chip.record.number, chip.canvas.toDataURL('image/jpeg', 0.85));
    const o1 = app.observations.add({ text: '(U) Two vehicles parked at the field edge.', category: 'vehicle activity', confidence: 'high', chips: [chip.record.number], time: '2025-10-25T10:00:00Z' });
    app.selection = new Set();
    const o2 = app.observations.add({ text: '(U) Fresh ground disturbance.', category: 'construction', confidence: 'low', time: '2025-10-25T09:30:00Z', lat: 34.5, lon: -117.0 });
    app.activeMp().docks.show('observations');
    await new Promise((res) => setTimeout(res, 300));
    const sel = document.querySelector(`[data-id="obs-confidence:${o2.id}"]`);
    sel.value = 'moderate';
    sel.dispatchEvent(new Event('change'));
    const html = app.observations.activityHtml({ title: 'Activity test' });
    const docx = app.observations.activityDocx({ title: 'Activity test' });
    const csv = app.observations.activityCsv();
    const rep = app.reportDocx({ title: 'Report test', bluf: '(U) Bottom line.' });
    const enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
    return { o1: { graphics: o1.graphics.length, chips: o1.chips, lat: o1.lat }, o2conf: app.store.get(o2.id).confidence, rows: document.querySelectorAll('[data-id="obs-table"] tbody tr').length, html, csvLines: csv.trim().split('\n').length, docx: enc(docx), rep: enc(rep) };
  });
  expect(r.o1.graphics).toBe(1);
  expect(r.o1.chips).toEqual([1]);
  expect(Number.isFinite(r.o1.lat)).toBe(true);
  expect(r.o2conf).toBe('moderate');
  expect(r.rows).toBe(2);
  // Time order: the 09:30 observation first.
  expect(r.html.indexOf('Fresh ground disturbance')).toBeLessThan(r.html.indexOf('Two vehicles'));
  expect(r.html).toMatch(/UNCLASSIFIED/);
  expect(r.html).toMatch(/data:image\/(png|jpeg)/);
  expect(r.csvLines).toBe(3);
  for (const [k, bytes] of [['activity', r.docx], ['report', r.rep]]) {
    const z = unzipSync(fromB64(bytes));
    expect(Object.keys(z), k).toEqual(expect.arrayContaining(['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/header1.xml', 'word/footer1.xml', '_rels/.rels']));
    const doc = strFromU8(z['word/document.xml']);
    expect(doc, k).toMatch(/w:pStyle w:val="Heading1"/);
    expect(doc, k).toMatch(/<w:tbl>/);
    expect(strFromU8(z['word/header1.xml']), k).toMatch(/UNCLASSIFIED/);
    // Well-formed XML.
    for (const part of ['word/document.xml', 'word/styles.xml', 'word/header1.xml', '[Content_Types].xml']) expect(strFromU8(z[part]).startsWith('<?xml')).toBe(true);
  }
  const act = unzipSync(fromB64(r.docx));
  expect(Object.keys(act).some((k) => /^word\/media\/image1\.(png|jpeg)$/.test(k))).toBe(true);
  expect(strFromU8(act['word/document.xml'])).toMatch(/Two vehicles parked/);
  expect(strFromU8(unzipSync(fromB64(r.rep))['word/document.xml'])).toMatch(/Bottom line/);
  expect(logs).toEqual([]);
});

test('REQ-PRD-09 REQ-PRD-12 PowerPoint template import; animated GIF and a video clip from FX-10 in the HTML report and in PPTX slides', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx10/fx10.ts')]);
  await frame.waitForFunction(() => window.gisworkbench.fmv?.clips.size >= 1 && window.gisworkbench.fmv.viewOf(window.gisworkbench.fmv.activeClip()), null, { timeout: 90000 });
  const r = await frame.evaluate(async (tpl) => {
    const app = window.gisworkbench;
    const bin = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const t = await app.media.importTemplate(new File([bin(tpl)], 'template.pptx'));
    const clip = app.fmv.activeClip();
    const gif = await app.media.gifFromClip(clip, { from: 0, to: 30, step: 3, maxWidth: 320 });
    const vid = await app.media.videoFromClip(clip, { from: 0, to: 45 });
    const html = app.buildReport({ title: 'Media report' });
    const pptx = await app.media.pptx();
    const enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
    return { t: { size: t.size, fonts: t.fonts, background: t.background, pictures: t.pictures.map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h })) }, gif: { frames: gif.frames, w: gif.width, h: gif.height, bytes: enc(gif.bytes) }, vid: { mime: vid.mime, size: vid.bytes.length }, html: { gif: html.includes('data:image/gif;base64'), video: /<video[^>]+src="data:video\//.test(html) }, pptx: enc(pptx) };
  }, b64(readFileSync(P('template.pptx'))));
  expect(r.t.size).toEqual({ w: 10, h: 5.625 });
  expect(r.t.fonts).toEqual({ title: 'Georgia', body: 'Verdana' });
  expect(r.t.background).toEqual({ color: '1F3864' });
  expect(r.t.pictures[0]).toEqual({ x: 8.5, y: 0.2, w: 1.2, h: 0.6 });
  expect(r.gif.frames).toBe(11);
  expect([r.gif.w, r.gif.h]).toEqual([320, 180]);
  const g = fromB64(r.gif.bytes);
  expect(String.fromCharCode(...g.subarray(0, 6))).toBe('GIF89a');
  expect(r.vid.size).toBeGreaterThan(10000);
  expect(r.vid.mime).toMatch(/^video\/(mp4|webm)/);
  expect(r.html.gif && r.html.video).toBe(true);
  const z = unzipSync(fromB64(r.pptx));
  const names = Object.keys(z);
  expect(names.some((n) => /^ppt\/media\/.+\.gif$/.test(n))).toBe(true);
  expect(names.some((n) => /^ppt\/media\/.+\.(mp4|webm|m4v)$/.test(n))).toBe(true);
  // The template: slide size, theme fonts, background and the logo on the layout.
  const pres = strFromU8(z['ppt/presentation.xml']);
  expect(pres).toMatch(/<p:sldSz cx="9144000" cy="5143500"/);
  expect(strFromU8(z['ppt/theme/theme1.xml'])).toMatch(/typeface="Georgia"/);
  const layouts = names.filter((n) => /slideLayouts\/slideLayout\d+\.xml$/.test(n)).map((n) => strFromU8(z[n]));
  expect(layouts.some((x) => /1F3864/.test(x) && /<p:pic>/.test(x))).toBe(true);
  expect(logs).toEqual([]);
});
