// PowerPoint export (REQ-PRD-05) through lazy pptxgenjs — the active product template's page and
// snapshots of panels, each slide with its marking as banner text and the record in the notes —
// and a Finishing Tool (REQ-PRD-06): a multi-panel product canvas of chips, text and arrows with
// the highest marking of its chips on top and bottom, kept as an undoable `finishing` record and
// exported as PNG, PDF or PPTX.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { highest, bannerText, bannerColorVar } from '../security/marking.js';
import { renderPage } from '../products/template.js';

export const name = 'finishing';

const toDataUrl = (canvas) => canvas.toDataURL('image/png');
/** {text, colour} of a marking object or a product record's marking. */
function markOf(m) {
  if (!m) return null;
  const text = m.text || bannerText(m);
  let colour = m.colour ?? null;
  if (!colour && m.level) {
    try {
      colour = getComputedStyle(document.documentElement).getPropertyValue(bannerColorVar(m)).trim() || null;
    } catch {}
  }
  return { text, colour: colour ?? '#007a33' };
}
const MM_PER_IN = 25.4;

/** One canvas from a rendered page's strips. */
function pageCanvas(page) {
  const [W, H] = page.pagePx;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  let y = 0;
  for (const s of page.strips) {
    g.drawImage(s.canvas, 0, y);
    y += s.h;
  }
  return c;
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const hasImage = () => !!pane()?.layers().length;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };
  let Pptx = null;
  const loadPptx = async () => (Pptx ??= (await app.gw.runScript('js-pptx')).PptxGenJS);

  /**
   * A PPTX from slides [{image: canvas, wIn, hIn, title, marking, notes}] (one layout: the first
   * slide's size). Returns Uint8Array.
   */
  async function writePptx(slides, { title = 'GIS Workbench product', template = app.pptxTemplate ?? null } = {}) {
    const P = await loadPptx();
    const pptx = new P();
    // An imported template (REQ-PRD-09) sets the slide size, fonts, background and logos.
    const w = template?.size?.w ?? slides[0]?.wIn ?? 13.333;
    const hh = template?.size?.h ?? slides[0]?.hIn ?? 7.5;
    pptx.defineLayout({ name: 'GW', width: w, height: hh });
    pptx.layout = 'GW';
    pptx.title = title;
    pptx.author = app.prefs.get('analyst') ?? '';
    pptx.company = 'GIS Workbench';
    const font = template?.fonts?.title ?? 'Arial';
    const tcol = template?.titleColour ?? '202020';
    if (template) {
      pptx.theme = { headFontFace: template.fonts.title, bodyFontFace: template.fonts.body };
      pptx.defineSlideMaster({ title: 'GW_TEMPLATE', background: template.background ?? { color: 'FFFFFF' }, objects: template.pictures.map((p) => ({ image: { x: p.x, y: p.y, w: p.w, h: p.h, data: p.data } })) });
    }
    for (const s of slides) {
      const sl = template ? pptx.addSlide({ masterName: 'GW_TEMPLATE' }) : pptx.addSlide();
      if (s.media) {
        // Short clips and animated GIFs (REQ-PRD-12): a GIF is a picture PowerPoint animates; a
        // video is embedded media.
        const mo = markOf(s.marking);
        if (mo?.text) {
          sl.addText(mo.text, { x: 0, y: 0, w, h: 0.25, fontSize: 10, bold: true, align: 'center', color: 'FFFFFF', fill: { color: (mo.colour ?? '#007a33').replace('#', '').slice(0, 6) }, fontFace: 'Arial' });
          sl.addText(mo.text, { x: 0, y: hh - 0.25, w, h: 0.25, fontSize: 10, bold: true, align: 'center', color: 'FFFFFF', fill: { color: (mo.colour ?? '#007a33').replace('#', '').slice(0, 6) }, fontFace: 'Arial' });
        }
        if (s.title) sl.addText(s.title, { x: 0.2, y: 0.25, w: w - 0.4, h: 0.3, fontSize: 14, bold: true, color: tcol, fontFace: font });
        const ar = s.media.width / s.media.height;
        let iw = w - 0.4;
        let ih = iw / ar;
        if (ih > hh - 1.1) [ih, iw] = [hh - 1.1, (hh - 1.1) * ar];
        const box = { x: (w - iw) / 2, y: 0.6, w: iw, h: ih };
        if (s.media.kind === 'gif') sl.addImage({ data: s.media.dataUrl, ...box });
        else sl.addMedia({ type: 'video', data: s.media.dataUrl, ...box, ...(s.media.cover ? { cover: s.media.cover } : {}) });
        if (s.notes) sl.addNotes(s.notes);
        continue;
      }
      const ar = s.image.width / s.image.height;
      // Fit the image under a title line and between the marking lines.
      const top = s.title ? 0.55 : 0.3;
      const availH = hh - top - 0.3;
      let iw = w - 0.4;
      let ih = iw / ar;
      if (ih > availH) {
        ih = availH;
        iw = ih * ar;
      }
      const mo = markOf(s.marking);
      const mk = mo?.text ?? '';
      const mcol = (mo?.colour ?? '#007a33').replace('#', '').slice(0, 6);
      if (mk) {
        sl.addText(mk, { x: 0, y: 0, w, h: 0.25, fontSize: 10, bold: true, align: 'center', color: 'FFFFFF', fill: { color: mcol }, fontFace: 'Arial' });
        sl.addText(mk, { x: 0, y: hh - 0.25, w, h: 0.25, fontSize: 10, bold: true, align: 'center', color: 'FFFFFF', fill: { color: mcol }, fontFace: 'Arial' });
      }
      if (s.title) sl.addText(s.title, { x: 0.2, y: 0.25, w: w - 0.4, h: 0.3, fontSize: 14, bold: true, color: tcol, fontFace: font });
      sl.addImage({ data: toDataUrl(s.image), x: (w - iw) / 2, y: top, w: iw, h: ih });
      if (s.notes) sl.addNotes(s.notes);
    }
    return pptx.write({ outputType: 'uint8array' });
  }

  /** Slide from the active product template (REQ-PRD-05 "from templates"). */
  async function templateSlide(p = pane()) {
    const page = await renderPage(app, app.productTemplate(), p);
    const c = pageCanvas(page);
    return { image: c, wIn: page.pageMm[0] / MM_PER_IN, hIn: page.pageMm[1] / MM_PER_IN, title: '', marking: page.record.marking, notes: `Source: ${page.record.image}\nRecord: ${JSON.stringify(page.record).slice(0, 4000)}` };
  }
  /** Slide from a snapshot of a panel (REQ-PRD-05 "snapshot of the current panel"). */
  async function snapshotSlide(p = pane()) {
    const chip = await app.makeChip({ number: 0 });
    const r = chip.record;
    return { image: chip.canvas, wIn: 13.333, hIn: 7.5, title: `${r.image} — ${new Date().toISOString().slice(0, 10)}`, marking: chip.marking, notes: `Image: ${r.image}\nCentre: ${r.centre ? `${r.centre.lat?.toFixed?.(6)}, ${r.centre.lon?.toFixed?.(6)}` : ''}\nGenerated by GIS Workbench` };
  }

  C.implement('snap.pptx', {
    enabled: hasImage,
    run: run(async () => {
      const mode = h('select', { class: 'inp', 'aria-label': 'Content' }, h('option', { value: 'snapshot' }, 'Snapshot of each panel'), h('option', { value: 'template' }, `Active product template (${app.productTemplate?.()?.name ?? 'default'})`));
      if ((await modal({ title: 'Export PowerPoint', body: field('Slides', mode), id: 'snap-pptx' })) !== 'OK') return;
      const slides = [];
      if (mode.value === 'template') slides.push(await templateSlide());
      else for (const p of app.activeMp().panes.filter((x) => x.layers().length && !x.view3d)) slides.push(await withPane(p, () => snapshotSlide(p)));
      const bytes = await writePptx(slides);
      await saveBlob(app, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), { name: 'product.pptx', types: ['.pptx'], description: 'PowerPoint' });
    }),
  });
  async function withPane(p, fn) {
    const prev = app.activePane();
    if (prev !== p) p.mp.setActivePane(p);
    try {
      return await fn();
    } finally {
      if (prev && prev !== p) prev.mp.setActivePane(prev);
    }
  }

  // ---- Finishing Tool (REQ-PRD-06) ----
  const PAGE = { w: 1600, h: 1000 };
  const chipCanvases = new Map(); // chip item id → canvas (chips are re-rendered from their record views)

  /** Compose a layout: {items: [{kind: 'chip'|'text'|'arrow', …}]} → {canvas, marking}. */
  function compose(layout, { w = PAGE.w, h: hh = PAGE.h } = {}) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = hh;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, hh);
    const marks = [];
    for (const it of layout.items) {
      if (it.kind === 'chip') {
        const cv = chipCanvases.get(it.id);
        if (cv) g.drawImage(cv, it.x, it.y, it.w, it.h);
        else {
          g.fillStyle = '#ddd';
          g.fillRect(it.x, it.y, it.w, it.h);
        }
        g.strokeStyle = '#000';
        g.lineWidth = 2;
        g.strokeRect(it.x, it.y, it.w, it.h);
        if (it.marking) marks.push(it.marking);
      } else if (it.kind === 'text') {
        g.fillStyle = it.colour ?? '#000';
        g.font = `${it.bold ? 'bold ' : ''}${it.size ?? 24}px Arial, sans-serif`;
        String(it.text ?? '').split('\n').forEach((t, i) => g.fillText(t, it.x, it.y + i * (it.size ?? 24) * 1.25));
      } else if (it.kind === 'arrow') {
        const ang = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
        g.strokeStyle = it.colour ?? '#e00000';
        g.fillStyle = it.colour ?? '#e00000';
        g.lineWidth = it.width ?? 5;
        g.beginPath();
        g.moveTo(it.x1, it.y1);
        g.lineTo(it.x2, it.y2);
        g.stroke();
        g.beginPath();
        g.moveTo(it.x2, it.y2);
        g.lineTo(it.x2 - 22 * Math.cos(ang - 0.4), it.y2 - 22 * Math.sin(ang - 0.4));
        g.lineTo(it.x2 - 22 * Math.cos(ang + 0.4), it.y2 - 22 * Math.sin(ang + 0.4));
        g.closePath();
        g.fill();
      }
    }
    // The page carries the highest marking of its chips (REQ-SEC), top and bottom.
    const m = marks.length ? highest(marks) : null;
    const mo = markOf(m);
    if (mo?.text) {
      g.fillStyle = mo.colour;
      g.fillRect(0, 0, w, 32);
      g.fillRect(0, hh - 32, w, 32);
      g.fillStyle = '#fff';
      g.font = 'bold 20px Arial, sans-serif';
      g.textAlign = 'center';
      g.fillText(mo.text, w / 2, 23);
      g.fillText(mo.text, w / 2, hh - 9);
      g.textAlign = 'left';
    }
    return { canvas: c, marking: m };
  }

  /** Add a chip of a panel to a layout record (created when null). Returns {id, item}. */
  async function addChip(recId, p = pane(), at = null) {
    const chip = await withPane(p, () => app.makeChip({ number: 0 }));
    const id = `fc-${Math.random().toString(36).slice(2, 10)}`;
    chipCanvases.set(id, chip.canvas);
    const rec = recId ? S.get(recId) : null;
    const n = rec?.items.filter((x) => x.kind === 'chip').length ?? 0;
    const w = 760;
    const hh = Math.round((w * chip.canvas.height) / chip.canvas.width);
    const item = { kind: 'chip', id, x: at?.x ?? 30 + (n % 2) * 790, y: at?.y ?? 60 + Math.floor(n / 2) * (hh + 30), w, h: hh, image: chip.record.image, marking: chip.marking };
    let rid = recId;
    S.transact('Finishing: add chip', (tx) => {
      if (!rid) rid = tx.create('finishing', { name: 'Product', page: PAGE, items: [item], created: new Date().toISOString() });
      else tx.set(rid, 'items', [...S.get(rid).items, item]);
    });
    return { id: rid, item };
  }
  function addItem(recId, item) {
    S.transact(`Finishing: add ${item.kind}`, (tx) => tx.set(recId, 'items', [...S.get(recId).items, item]));
  }
  function moveItem(recId, index, dx, dy) {
    const items = S.get(recId).items.map((it, i) => (i !== index ? it : it.kind === 'arrow' ? { ...it, x1: it.x1 + dx, y1: it.y1 + dy, x2: it.x2 + dx, y2: it.y2 + dy } : { ...it, x: it.x + dx, y: it.y + dy }));
    S.transact('Finishing: move', (tx) => tx.set(recId, 'items', items), { mergeKey: `fin-move-${recId}-${index}` });
  }
  async function exportFinishing(recId, fmt) {
    const rec = S.get(recId);
    const { canvas, marking } = compose(rec);
    if (fmt === 'png') return new Blob([await new Promise((r) => canvas.toBlob((b) => b.arrayBuffer().then(r), 'image/png'))], { type: 'image/png' });
    if (fmt === 'pptx') return new Blob([await writePptx([{ image: canvas, wIn: 13.333, hIn: 13.333 * (PAGE.h / PAGE.w), title: '', marking, notes: rec.items.filter((x) => x.kind === 'chip').map((x) => x.image).join('\n') }])], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const page = { strips: [{ canvas, h: canvas.height }], pagePx: [canvas.width, canvas.height], pageMm: [297, 297 * (canvas.height / canvas.width)], record: { marking: markOf(marking), image: 'Finishing Tool' } };
    return new Blob([await app.pagesToPdf([page], { title: `${markOf(marking)?.text ?? ''} — GIS Workbench product`, subject: markOf(marking)?.text ?? '', author: app.prefs.get('analyst') ?? '' })], { type: 'application/pdf' });
  }
  app.finishing = { markOf, compose, addChip, addItem, moveItem, exportFinishing, writePptx, templateSlide, snapshotSlide };

  C.implement('prod.finishing', {
    enabled: hasImage,
    run: run(async () => {
      let rid = S.all('finishing').at(-1)?.id ?? null;
      if (!rid) rid = (await addChip(null)).id;
      const cv = h('canvas', { width: String(PAGE.w), height: String(PAGE.h), class: 'finishing-canvas', 'aria-label': 'Product canvas' });
      cv.style.width = '800px';
      cv.style.height = '500px';
      const redraw = () => {
        const { canvas } = compose(S.get(rid));
        cv.getContext('2d').drawImage(canvas, 0, 0);
      };
      let drag = null;
      const hit = (x, y) => S.get(rid).items.findLastIndex((it) => (it.kind === 'arrow' ? Math.hypot(x - it.x2, y - it.y2) < 30 : x >= it.x && y >= it.y - (it.kind === 'text' ? it.size ?? 24 : 0) && x <= it.x + (it.w ?? 300) && y <= it.y + (it.h ?? 10)));
      const local = (e) => {
        const r = cv.getBoundingClientRect();
        return [((e.clientX - r.left) / r.width) * PAGE.w, ((e.clientY - r.top) / r.height) * PAGE.h];
      };
      cv.addEventListener('pointerdown', (e) => {
        const [x, y] = local(e);
        const i = hit(x, y);
        if (i >= 0) drag = { i, x, y };
      });
      cv.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const [x, y] = local(e);
        moveItem(rid, drag.i, x - drag.x, y - drag.y);
        drag = { ...drag, x, y };
        redraw();
      });
      cv.addEventListener('pointerup', () => (drag = null));
      const bChip = h('button', { class: 'btn btn-small' }, 'Add Chip of Panel');
      const bText = h('button', { class: 'btn btn-small' }, 'Add Text');
      const bArrow = h('button', { class: 'btn btn-small' }, 'Add Arrow');
      bChip.addEventListener('click', async () => {
        await addChip(rid);
        redraw();
      });
      bText.addEventListener('click', () => {
        addItem(rid, { kind: 'text', text: 'Annotation', x: 80, y: 900, size: 32, bold: true });
        redraw();
      });
      bArrow.addEventListener('click', () => {
        addItem(rid, { kind: 'arrow', x1: 700, y1: 880, x2: 820, y2: 700 });
        redraw();
      });
      redraw();
      const r = await modal({ title: 'Finishing Tool', body: h('div', {}, h('div', { class: 'tb-row' }, bChip, bText, bArrow), cv, h('p', { class: 'hint' }, 'Drag items to move them. The page takes the highest marking of its chips.')), buttons: ['PNG…', 'PDF…', 'PowerPoint…', 'Close'], width: 860, id: 'prod-finishing' });
      const fmt = { 'PNG…': 'png', 'PDF…': 'pdf', 'PowerPoint…': 'pptx' }[r];
      if (fmt) await saveBlob(app, await exportFinishing(rid, fmt), { name: `product.${fmt}`, types: [`.${fmt}`], description: fmt.toUpperCase() });
    }),
  });
}
