// R1 product pages, PDF, KMZ and reports (REQ-PRD-02/03/04/07/11, REQ-AI-10, AT-16.1, AT-16.4,
// AT-16.5, AT-02.4): a 1:5 000 frame puts 500 m on 100 mm of paper; every page has banners and a
// raised template raises them; the legend lists only visible layers; the PDF has the page's
// exact size and does not scale on print; the KMZ quad matches the chip corners; the report
// banner rolls up from a (C) portion; the AI draft keeps portion marks.
import { test, expect } from '@playwright/test';
import { openApp, openFiles, sample } from './helpers.js';

const WV3 = sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf');

async function ready(page) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [WV3]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex && !l.tiles.loading && l.modelId));
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.__test = { ...(app.__test ?? {}), noPrint: true };
    app.activePane().setView({ cx: 768, cy: 768, zoom: 0.5, rot: 0.2, mode: 'native' });
  });
  return { frame, logs };
}

test('REQ-PRD-02/03 AT-16.1 AT-16.4 AT-16.5 page at 1:5 000, banners, legend and PDF', async ({ page }) => {
  const { frame, logs } = await ready(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const t = { ...app.productTemplate(), scale: 5000, grid: 'mgrs', page: { size: 'A4', orientation: 'landscape', dpi: 150, marginMm: 8 } };
    const pg = await app.renderProductPage(t);
    // AT-16.1: 100 mm of paper at the frame centre, measured on the ground through the model.
    const cv = pg.view;
    const pxmm = pg.dpi / 25.4;
    const l = cv.geoLayer();
    const cx = cv.width / 2;
    const cy = cv.height / 2;
    const a = cv.imagePoint(cx - 50 * pxmm, cy);
    const b = cv.imagePoint(cx + 50 * pxmm, cy);
    const ga = l.groundAt(a.x, a.y);
    const gb = l.groundAt(b.x, b.y);
    const d = app.core.inverse(ga.lat, ga.lon, gb.lat, gb.lon).distance;
    // Banners: banner colour at the top and bottom rows of the page.
    const first = pg.strips[0].canvas.getContext('2d').getImageData(5, 3, 1, 1).data;
    const last = pg.strips.at(-1);
    const lastPx = last.canvas.getContext('2d').getImageData(5, last.h - 3, 1, 1).data;
    // A raised template raises every banner (AT-16.4).
    const raised = await app.renderProductPage({ ...t, raise: 'C', scale: null });
    const rTop = raised.strips[0].canvas.getContext('2d').getImageData(5, 3, 1, 1).data;
    // AT-16.5: hide nothing → one legend entry; add a hidden copy → still one.
    const pdf = await app.pagesToPdf([pg], { title: 'test', subject: pg.record.marking.text });
    const text = new TextDecoder('latin1').decode(pdf);
    return { d, rec: pg.record, first: [...first], last: [...lastPx], rTop: [...rTop], rMark: raised.record.marking, legend: pg.record.legend, pdfHead: text.slice(0, 8), media: /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text)?.slice(1).map(Number), print: /\/PrintScaling \/None/.test(text), pages: /\/Count (\d+)/.exec(text)?.[1], xref: /startxref\n(\d+)/.exec(text)?.[1], xrefAt: text.indexOf('xref\n'), images: (text.match(/\/Subtype \/Image/g) ?? []).length, strips: pg.strips.length, eof: text.trimEnd().endsWith('%%EOF') };
  });
  expect(Math.abs(r.d - 500) / 500).toBeLessThan(0.005);
  expect(r.rec.frame.scale).toBeGreaterThan(4975);
  expect(r.rec.frame.scale).toBeLessThan(5025);
  for (const p of [r.first, r.last]) expect(p[1]).toBeGreaterThan(p[0] + 40); // green UNCLASSIFIED
  expect(r.rMark.level).toBe('C');
  expect(r.rTop[2]).toBeGreaterThan(r.rTop[0] + 60); // blue CONFIDENTIAL
  expect(r.legend).toHaveLength(1);
  expect(r.pdfHead).toBe('%PDF-1.4');
  expect(r.media[0]).toBeCloseTo((297 / 25.4) * 72, 2);
  expect(r.media[1]).toBeCloseTo((210 / 25.4) * 72, 2);
  expect(r.print).toBe(true);
  expect(r.pages).toBe('1');
  expect(Number(r.xref)).toBe(r.xrefAt);
  expect(r.images).toBe(r.strips);
  expect(r.eof).toBe(true);
  expect(logs).toEqual([]);
});

test('AT-16.5 the legend lists only visible layers', async ({ page }) => {
  const { frame } = await ready(page);
  await openFiles(frame, [WV3]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length === 2 && [...window.gisworkbench.layers.values()].every((l) => l.lutTex));
  const n = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const both = (await app.renderProductPage({ ...app.productTemplate(), page: { size: 'A4', orientation: 'landscape', dpi: 96, marginMm: 8 } })).record.legend.length;
    app.store.transact('hide', (tx) => tx.set(p.layers()[1].id, 'visible', false));
    const one = (await app.renderProductPage({ ...app.productTemplate(), page: { size: 'A4', orientation: 'landscape', dpi: 96, marginMm: 8 } })).record.legend.length;
    return [both, one];
  });
  expect(n).toEqual([2, 1]);
});

test('REQ-PRD-07 KMZ overlay quad and banner name', async ({ page }) => {
  const { frame } = await ready(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const k = await app.chipKmz();
    const q = /<coordinates>([^<]+)<\/coordinates>/.exec(k.kml)[1].trim().split(' ').map((s) => s.split(',').map(Number));
    return { q, corners: k.record.cornersGround, name: /<name>([^<]+)<\/name>/.exec(k.kml)[1], zip: k.zip.length, pk: [k.zip[0], k.zip[1]] };
  });
  // LatLonQuad order: lower-left, lower-right, upper-right, upper-left.
  const [ul, ur, lr, ll] = r.corners;
  [ll, lr, ur, ul].forEach((c, i) => {
    expect(r.q[i][0]).toBeCloseTo(c[0], 8);
    expect(r.q[i][1]).toBeCloseTo(c[1], 8);
  });
  expect(r.name).toMatch(/^UNCLASSIFIED — Chip \d+$/);
  expect(r.pk).toEqual([0x50, 0x4b]);
});

test('REQ-PRD-11 AT-02.4 REQ-AI-10 report banner rolls up from a (C) portion; AI draft keeps portion marks', async ({ page }) => {
  const { frame } = await ready(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const plain = app.buildReport({ title: 'T', bluf: '(U) Nothing of note.' });
    // Test values only: one CONFIDENTIAL portion.
    app.store.transact('obs', (tx) => tx.create('observation', { text: '(C) Test value portion.', confidence: 'moderate', created: new Date().toISOString() }));
    const raised = app.buildReport({ title: 'T', bluf: '(U) Nothing of note.' });
    const order = ['BLUF', 'Imagery used', 'Location', 'Observations', 'Annotated chips', 'Mensuration table', 'Change summary', 'Inventory and counts', 'Analyst comments and gaps'].map((s) => raised.indexOf(`<h2>${s}`));
    app.prefs.set('aiConnections', [{ id: 'conn_mock', name: 'Mock', provider: 'mock', baseURL: '', model: 'mock-model', effort: 'medium' }]);
    app.prefs.set('aiActive', 'conn_mock');
    app.ai.assistant.consented = true;
    app.ai.mock.script.push({ id: 'm', role: 'assistant', model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'BLUF:\n(U) Activity is low.\n\nVehicles are present.\n\nCOMMENTS:\n(C) Cloud limits the view.' }], usage: {} });
    const d = await app.draftReport({ type: 'Special' });
    const prompt = app.ai.mock.requests.at(-1).messages[0].content;
    const html = app.buildReport({ title: 'T', bluf: d.bluf, comments: d.comments, aiDrafted: ['bluf', 'comments'] });
    const banners = (h) => [...h.matchAll(/<div class="banner (top|bottom)"[^>]*>([^<]+)<\/div>/g)].map((m) => m[2]);
    return { plain: banners(plain), raised: banners(raised), order, d, prompt, ai: (html.match(/AI-drafted/g) ?? []).length, na: /<td>N\/A<\/td>/.test(raised) };
  });
  expect(r.plain).toEqual(['UNCLASSIFIED', 'UNCLASSIFIED']);
  expect(r.raised).toEqual(['CONFIDENTIAL', 'CONFIDENTIAL']);
  for (let i = 1; i < r.order.length; i++) expect(r.order[i]).toBeGreaterThan(r.order[i - 1]);
  expect(r.prompt).toContain('(C)');
  // Paragraphs below the input's highest portion (C) are raised to it, never left unmarked.
  for (const p of `${r.d.bluf}\n\n${r.d.comments}`.split(/\n\s*\n/)) expect(p).toMatch(/^\(C\) /);
  expect(r.d.fixed).toBe(2);
  expect(r.ai).toBeGreaterThanOrEqual(2);
  expect(r.na).toBe(true);
});

test('REQ-PRD-01/02/04/11 product dialogs open, pass axe and close cleanly', async ({ page }) => {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  const { frame, logs } = await ready(page);
  await frame.evaluate(axeSource);
  for (const [cmd, id] of [
    ['chip.view', 'chip'],
    ['tpl.props', 'tpl-props'],
    ['tpl.edit', 'tpl-edit'],
    ['tpl.apply', 'tpl-apply'],
    ['report.template', 'report'],
    ['draw.autolabels', 'autolabels'],
    ['chip.preset', 'chip-preset'],
  ]) {
    await frame.evaluate((c) => void window.gisworkbench.commands.run(c), cmd);
    const dlg = frame.locator(`[data-id="dialog:${id}"]`);
    await expect(dlg).toBeVisible({ timeout: 20000 });
    const v = await frame.evaluate(async (sel) => (await window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`), `[data-id="dialog:${id}"]`);
    expect(v, cmd).toEqual([]);
    await dlg.locator('.dlg-x').click();
    await expect(dlg).toHaveCount(0);
  }
  // Auto map and an autolabel draw without errors.
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    void app.commands.run('draw.automap');
    const p = app.activePane();
    app.store.transact('lbl', (tx) => tx.create('graphic', { pane: p.id, glayer: p.rec.graphicsLayer, shape: 'text', anchor: 'screen', coords: [[0.05, 0.1]], template: '{IMAGE_ID}\n{MGRS_CENTER}', text: '', style: { stroke: '#fff', fill: '#fff', fontSize: 13 } }));
  });
  await page.waitForTimeout(500);
  expect(await frame.evaluate(() => window.gisworkbench.store.all('graphic').filter((g) => g.shape === 'automap').length)).toBe(1);
  expect(logs).toEqual([]);
});
