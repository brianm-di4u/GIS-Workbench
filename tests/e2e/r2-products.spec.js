// R2 products and symbology: GRG cells over the view (REQ-IMG-23), MIL-STD-2525 symbols from lazy
// milsymbol (REQ-IMG-32), a legacy-datum image whose CE90 carries the three-parameter shift σ
// (REQ-GEO-09), PowerPoint from a template and from panel snapshots (REQ-PRD-05) and the
// Finishing Tool page with the highest marking (REQ-PRD-06).
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { openApp, openFiles } from './helpers.js';

test('REQ-IMG-23 REQ-IMG-32 REQ-GEO-09 REQ-PRD-05 REQ-PRD-06 GRG, symbols, datum shift, PowerPoint and Finishing Tool', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx01/fx01.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const S = app.store;
    const p = app.activePane();
    const out = {};
    // GRG over a 300 m box at the FX-01 centre.
    const box = [34.4985, -116.5025, 34.5015, -116.4975];
    const g = app.grg.make({ p, box, cell: 100 });
    const cells = S.all('graphic').filter((x) => x.provenance?.kind === 'grg');
    const cellSize = (c) => {
      const [a, b, , d] = c.coords;
      return [app.core.inverse(a[1], a[0], b[1], b[0]).distance, app.core.inverse(a[1], a[0], d[1], d[0]).distance];
    };
    out.grg = { cols: g.cols, rows: g.rows, n: cells.length, first: cells[0].text, last: cells.at(-1).text, size: cellSize(cells[0]) };
    const m = app.grg.make({ p, box: [34.4985, -116.5025, 34.4994, -116.5014], cell: 90, micro: true });
    out.micro = { n: m.cells.length, labels: m.cells.slice(0, 3).map((c) => c.label) };
    // Symbols.
    await app.milsym.load();
    const sid = await app.milsym.place(p, { lat: 34.5, lon: -116.5, h: 650 }, '10031000001211000000', { modifiers: { uniqueDesignation: 'A/1-1' } });
    const sym = S.get(sid);
    const c = app.milsym.symbolCanvas('SFGPUCI----K---', 30);
    let bad = null;
    try {
      await app.milsym.place(p, { lat: 34.5, lon: -116.5, h: 650 }, 'NOT-A-SIDC');
    } catch (e) {
      bad = e.message;
    }
    out.symbol = { shape: sym.shape, standard: sym.provenance.standard, w: c.canvas.width, valid: c.valid, bad };
    // PowerPoint from a snapshot and from the template.
    const s1 = await app.finishing.snapshotSlide(p);
    const s2 = await app.finishing.templateSlide(p);
    const pptx = await app.finishing.writePptx([s1, s2], { title: 'test' });
    out.pptx = Array.from(pptx);
    // Finishing Tool: two chips, text, arrow; page marking; exports.
    const f1 = await app.finishing.addChip(null, p);
    await app.finishing.addChip(f1.id, p);
    app.finishing.addItem(f1.id, { kind: 'text', text: 'Annotation', x: 80, y: 900, size: 32 });
    app.finishing.addItem(f1.id, { kind: 'arrow', x1: 700, y1: 880, x2: 820, y2: 700 });
    app.finishing.moveItem(f1.id, 2, 10, -5);
    const comp = app.finishing.compose(S.get(f1.id));
    const top = comp.canvas.getContext('2d').getImageData(20, 10, 1, 1).data; // left of the centred banner text
    const png = await app.finishing.exportFinishing(f1.id, 'png');
    const pdf = await app.finishing.exportFinishing(f1.id, 'pdf');
    const pp = await app.finishing.exportFinishing(f1.id, 'pptx');
    const pdfHead = new TextDecoder().decode(new Uint8Array(await pdf.slice(0, 5).arrayBuffer()));
    out.finishing = { items: S.get(f1.id).items.length, moved: S.get(f1.id).items[2].x, marking: app.finishing.markOf(comp.marking)?.text, topPixel: Array.from(top), png: png.size, pdf: pdf.size, pdfHead, pptx: pp.size };
    app.commands.run('qat.undo');
    out.undo = S.get(f1.id).items[2].x;
    return out;
  });
  console.log(JSON.stringify({ ...r, pptx: r.pptx.length }));
  expect(r.grg.cols).toBe(5);
  expect(r.grg.rows).toBe(4);
  expect(r.grg.n).toBe(20);
  expect(r.micro.n).toBe(40);
  expect(r.grg.first).toBe('A1');
  expect(r.grg.size[0]).toBeGreaterThan(99);
  expect(r.grg.size[0]).toBeLessThan(101);
  expect(r.grg.size[1]).toBeGreaterThan(99);
  expect(r.grg.size[1]).toBeLessThan(101);
  expect(r.micro.labels).toEqual(['A1', 'A1-1', 'A1-2']);
  expect(r.symbol).toMatchObject({ shape: 'symbol', standard: 'MIL-STD-2525D/E', valid: true });
  expect(r.symbol.w).toBeGreaterThan(20);
  expect(r.symbol.bad).toMatch(/not a valid/);
  // PPTX: two slides, images, marking text.
  const z = unzipSync(Uint8Array.from(r.pptx));
  const slides = Object.keys(z).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
  expect(slides.length).toBe(2);
  expect(Object.keys(z).filter((k) => /^ppt\/media\//.test(k)).length).toBeGreaterThanOrEqual(2);
  expect(strFromU8(z['ppt/slides/slide1.xml'])).toMatch(/UNCLASSIFIED/);
  expect(Object.keys(z).some((k) => /notesSlide/.test(k))).toBe(true);
  // Finishing Tool
  expect(r.finishing.items).toBe(4);
  expect(r.finishing.marking).toMatch(/UNCLASSIFIED/);
  expect(r.finishing.topPixel[1]).toBeGreaterThan(r.finishing.topPixel[0]); // the green banner
  expect(r.finishing.png).toBeGreaterThan(10000);
  expect(r.finishing.pdfHead).toBe('%PDF-');
  expect(r.finishing.pptx).toBeGreaterThan(10000);
  expect(r.undo).toBe(80);
  expect(logs).toEqual([]);
});

test('REQ-GEO-09 a NAD27 image is flagged and its CE90 carries the datum-shift σ', async ({ page }) => {
  test.setTimeout(120000);
  const { frame, logs } = await openApp(page, 'file');
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const W = 512;
    const px = new Uint8Array(W * W).map((_, k) => ((k % W) ^ (k / W)) & 255);
    const bytes = await app.__test.writeGeoTiff({ width: W, height: W, bands: 1, type: 'u8', data: px }, { epsg: 26711, geotransform: [545000, 1, 0, 3818000, 0, -1] });
    await app.openFiles([new File([bytes], 'nad27_utm11.tif', { type: 'image/tiff' })]);
    for (let i = 0; i < 100 && ![...app.layers.values()].some((l) => l.lutTex); i++) await new Promise((res) => setTimeout(res, 100));
    const l = [...app.layers.values()][0];
    const m = l.models.find((x) => x.id === l.modelId);
    const p = app.activePane();
    const rect = p.el.getBoundingClientRect();
    p.el.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true }));
    await new Promise((res) => setTimeout(res, 300));
    return { model: m.name, datum: m.datum, note: m.info?.note, err: app.cursorError, ce: document.querySelector('[data-id="status:ce"]')?.textContent ?? null };
  });
  console.log(JSON.stringify(r));
  expect(r.datum.name).toMatch(/NAD27/);
  expect(r.datum.acc).toBe(5);
  expect(r.err.datumShift).toEqual({ name: r.datum.name, sigma: 5 });
  expect(r.err.ce90).toBeGreaterThan(2.146 * 5 - 0.01);
  expect(logs).toEqual([]);
});
