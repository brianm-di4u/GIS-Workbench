// Products ▸ Templates, Snapshot and Reports (REQ-PRD-02/03/04/07/11, REQ-AI-10): JSON page
// templates (new, edit, apply, save, Product Properties), PDF from page strips, printing at
// scale, KMZ chip overlays (LatLonQuad) with the graphics, and the exploitation report with an
// optional AI draft that keeps portion marks.

import { h } from '../shell/dom.js';
import { docxFromHtml, DOCX_TYPE } from '../products/docx.js';
import { modal, field, section, promptBox } from '../shell/dialogs.js';
import { saveBlob, textBlob, pickFiles } from '../storage/files.js';
import { zipSync, strToU8 } from 'fflate';
import { BUILTIN_TEMPLATES, PAGES, normalizeTemplate, renderPage, stitch } from '../products/template.js';
import { makeChip, drawBanner } from '../products/chip.js';
import { writePdf } from '../formats/pdf-writer.js';
import { buildReport, reportInputs, reportMarking, draftPrompt, parseDraft, REPORT_TYPES } from '../products/report.js';
import { LEVELS, LEVEL_NAME, bannerText, portionMark } from '../security/marking.js';
import { toKml } from './graphics.js';

export const name = 'product-pages';

const jpegOf = (canvas, q = 0.92) => new Promise((res, rej) => canvas.toBlob(async (b) => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('JPEG encoding failed'))), 'image/jpeg', q));

/** PDF bytes of rendered pages (each a renderPage result). */
export async function pagesToPdf(pages, info) {
  const out = [];
  for (const p of pages) {
    const strips = [];
    for (const s of p.strips) strips.push({ jpeg: await jpegOf(s.canvas), width: s.canvas.width, height: s.canvas.height, yMm: (s.y0 / p.pagePx[1]) * p.pageMm[1], hMm: (s.h / p.pagePx[1]) * p.pageMm[1] });
    // GeoPDF (ISO 32000-2 geospatial): the map frame as a viewport with its ground corners.
    const fr = p.record?.frame;
    const geo = fr?.corners ? { frameMm: fr.mm, corners: fr.corners } : null;
    out.push({ widthMm: p.pageMm[0], heightMm: p.pageMm[1], strips, geo });
  }
  return writePdf(out, info);
}

/** KML of a chip overlay: LatLonQuad (KML 2.3 / gx) corners LL, LR, UR, LL order, plus graphics. */
export function chipKml(rec, imageName, marking, graphicsKml = '') {
  const [ul, ur, lr, ll] = rec.cornersGround;
  const q = [ll, lr, ur, ul].map((c) => `${c[0].toFixed(9)},${c[1].toFixed(9)}`).join(' ');
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const placemarks = (/<Document>([\s\S]*)<\/Document>/.exec(graphicsKml)?.[1] ?? '').replace(/<name>[^<]*<\/name>\s*/, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
<name>${esc(marking)} — Chip ${esc(rec.number)}</name>
<description>${esc(marking)}. ${esc(rec.caption)}. Image ${esc(rec.image)}; created ${esc(rec.created)} with GIS Workbench.</description>
<GroundOverlay>
<name>${esc(marking)} — ${esc(rec.caption)}</name>
<Icon><href>${esc(imageName)}</href></Icon>
<gx:LatLonQuad><coordinates>${q}</coordinates></gx:LatLonQuad>
</GroundOverlay>
<ScreenOverlay>
<name>${esc(marking)} banner (top)</name>
<Icon><href>banner.png</href></Icon>
<overlayXY x="0.5" y="1" xunits="fraction" yunits="fraction"/><screenXY x="0.5" y="1" xunits="fraction" yunits="fraction"/><size x="1" y="0" xunits="fraction" yunits="pixels"/>
</ScreenOverlay>
<ScreenOverlay>
<name>${esc(marking)} banner (bottom)</name>
<Icon><href>banner.png</href></Icon>
<overlayXY x="0.5" y="0" xunits="fraction" yunits="fraction"/><screenXY x="0.5" y="0" xunits="fraction" yunits="fraction"/><size x="1" y="0" xunits="fraction" yunits="pixels"/>
</ScreenOverlay>
${placemarks}
</Document>
</kml>
`;
}

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const hasImage = () => (pane()?.visibleLayers?.().length ?? 0) > 0;
  app.chipImages ??= new Map();

  // ---- templates ----
  const userTemplates = () => app.store.all('template');
  const activeTemplate = () => {
    const id = app.prefs.get('templateActive') ?? 'builtin:sheet';
    if (id.startsWith('builtin:')) return structuredClone(BUILTIN_TEMPLATES[id.slice(8)] ?? BUILTIN_TEMPLATES.sheet);
    const r = app.store.get(id);
    return r ? normalizeTemplate(r.body) : structuredClone(BUILTIN_TEMPLATES.sheet);
  };
  const setActiveBody = (body) => {
    const id = app.prefs.get('templateActive') ?? 'builtin:sheet';
    if (id.startsWith('builtin:')) {
      // Editing a built-in makes a project copy.
      let nid;
      app.store.transact('Edit template', (tx) => (nid = tx.create('template', { name: body.name, body })));
      app.prefs.set('templateActive', nid);
    } else app.store.transact('Edit template', (tx) => tx.set(id, 'body', body));
  };
  app.productTemplate = activeTemplate;
  app.renderProductPage = (t = activeTemplate(), o) => renderPage(app, t, pane(), o);
  /** A .gwt.json product template (Apply Template ▸ From a file…, or a drop): added to the project and made active. */
  async function loadTemplateFile(f) {
    const body = normalizeTemplate(JSON.parse(await f.text()));
    let id;
    app.store.transact('Load template', (tx) => (id = tx.create('template', { name: body.name, body })));
    app.prefs.set('templateActive', id);
    return body;
  }
  app.loadTemplateFile = loadTemplateFile;

  C.implement('tpl.new', {
    run: async () => {
      const n = await promptBox('New Template', 'Name', 'My map sheet');
      if (!n) return;
      const body = { ...structuredClone(BUILTIN_TEMPLATES.sheet), name: n };
      let id;
      app.store.transact('New template', (tx) => (id = tx.create('template', { name: n, body })));
      app.prefs.set('templateActive', id);
      app.toast(`Template "${n}" created; Edit Template and Product Properties change it`);
    },
  });

  /** Product Properties (REQ-PRD-04): page, DPI, margins, marking, scale; save-image options. */
  C.implement('tpl.props', {
    run: async () => {
      const t = activeTemplate();
      const size = h('select', { class: 'inp', 'aria-label': 'Page size' }, ...Object.keys(PAGES).map((k) => h('option', { value: k }, k)));
      size.value = t.page.size;
      const orient = h('select', { class: 'inp', 'aria-label': 'Orientation' }, h('option', { value: 'landscape' }, 'Landscape'), h('option', { value: 'portrait' }, 'Portrait'));
      orient.value = t.page.orientation;
      const dpi = h('input', { class: 'inp', type: 'number', min: '72', max: '600', step: '1', value: String(t.page.dpi), 'aria-label': 'DPI' });
      const margin = h('input', { class: 'inp', type: 'number', min: '0', max: '40', step: '0.5', value: String(t.page.marginMm), 'aria-label': 'Margins (mm)' });
      const scale = h('input', { class: 'inp', type: 'number', min: '100', step: '1', value: t.scale ? String(t.scale) : '', placeholder: 'fit the view', 'aria-label': 'Scale denominator (1:n)' });
      const raise = h('select', { class: 'inp', 'aria-label': 'Marking' }, h('option', { value: '' }, 'From the inputs'), ...LEVELS.map((lv) => h('option', { value: lv }, `Raise to ${LEVEL_NAME[lv]}`)));
      raise.value = t.raise ?? '';
      const fmt = h('select', { class: 'inp', 'aria-label': 'Image format' }, h('option', { value: 'png' }, 'PNG (8-bit RGB)'), h('option', { value: 'jpeg' }, 'JPEG (8-bit RGB)'), h('option', { value: 'tif-display' }, 'GeoTIFF (8-bit RGB, GCPs)'), h('option', { value: 'tif-source' }, 'GeoTIFF (source bit depth)'), h('option', { value: 'nitf-source' }, 'NITF (source bit depth)'));
      fmt.value = app.prefs.get('chipFormat') ?? 'png';
      const body = h(
        'div',
        {},
        section('Page', field('Size', size), field('Orientation', orient), field('Resolution (dpi)', dpi), field('Margins (mm)', margin)),
        section('Map frame', field('Scale 1 :', scale, 'Blank fits the panel view. A fixed scale uses the page geometry: ground width = frame width × n.')),
        section('Marking', field('Banner', raise, 'The banner comes from the inputs; it can be raised, never lowered.')),
        section('Save image options', field('Chip format and bit depth', fmt, 'PNG and JPEG carry a world file and .prj; GeoTIFF and NITF carry GCPs or RPCs.')),
      );
      if ((await modal({ title: 'Product Properties', body, buttons: ['OK', 'Cancel'], id: 'tpl-props' })) !== 'OK') return;
      const next = { ...t, page: { size: size.value, orientation: orient.value, dpi: +dpi.value, marginMm: +margin.value }, scale: scale.value ? +scale.value : null, raise: raise.value || null };
      try {
        normalizeTemplate(next);
      } catch (e) {
        return app.toast(e.message, { kind: 'error' });
      }
      setActiveBody(next);
      app.prefs.set('chipFormat', fmt.value);
    },
  });

  /** Edit Template: title, legend, grid, inset, metadata block and marking, or the JSON. */
  C.implement('tpl.edit', {
    run: async () => {
      const t = activeTemplate();
      const title = h('input', { class: 'inp', value: t.title, 'aria-label': 'Title' });
      const grid = h('select', { class: 'inp', 'aria-label': 'Grid' }, ...['off', 'latlon', 'utm', 'mgrs'].map((g) => h('option', { value: g }, g === 'off' ? 'None' : g.toUpperCase())));
      grid.value = t.grid;
      const gridStep = h('input', { class: 'inp', type: 'number', min: '0', step: 'any', value: String(t.gridInterval ?? 0), 'aria-label': 'Grid interval (0 = automatic)' });
      const chk = (v, label) => h('input', { type: 'checkbox', checked: !!v, 'aria-label': label });
      const legend = chk(t.legend, 'Legend');
      const inset = chk(t.inset, 'Inset');
      const meta = chk(t.metadata, 'Metadata block');
      const north = chk(t.northArrow, 'North arrow');
      const sbar = chk(t.scaleBar, 'Scale bar');
      const source = h('input', { class: 'inp', value: t.source, 'aria-label': 'Source line' });
      const raise = h('select', { class: 'inp', 'aria-label': 'Marking' }, h('option', { value: '' }, 'From the inputs'), ...LEVELS.map((lv) => h('option', { value: lv }, `Raise to ${LEVEL_NAME[lv]}`)));
      raise.value = t.raise ?? '';
      const json = h('textarea', { class: 'inp mono', rows: '10', spellcheck: 'false', 'aria-label': 'Template JSON' }, JSON.stringify(t, null, 1));
      const body = h(
        'div',
        {},
        field('Name', h('span', {}, t.name)),
        field('Title', title),
        field('Grid', grid),
        field('Grid interval (m or degrees; 0 = automatic)', gridStep),
        field('Marginalia', h('span', {}, h('label', {}, legend, ' Legend '), h('label', {}, inset, ' Inset '), h('label', {}, meta, ' Metadata block '), h('label', {}, north, ' North arrow '), h('label', {}, sbar, ' Scale bar'))),
        field('Source line', source),
        field('Marking', raise),
        h('details', {}, h('summary', {}, 'JSON (advanced; overrides the fields above when changed)'), json),
      );
      const orig = json.value;
      if ((await modal({ title: 'Edit Template', body, buttons: ['OK', 'Cancel'], width: 640, id: 'tpl-edit' })) !== 'OK') return;
      let next;
      try {
        next = json.value !== orig ? normalizeTemplate(JSON.parse(json.value)) : normalizeTemplate({ ...t, title: title.value, grid: grid.value, gridInterval: Number(gridStep.value) || 0, legend: legend.checked, inset: inset.checked, metadata: meta.checked, northArrow: north.checked, scaleBar: sbar.checked, source: source.value, raise: raise.value || null });
      } catch (e) {
        return app.toast(`Template not changed: ${e.message}`, { kind: 'error' });
      }
      setActiveBody(next);
    },
  });

  C.implement('tpl.saveas', {
    run: async () => {
      const t = activeTemplate();
      await saveBlob(app, textBlob(JSON.stringify(t, null, 1), 'application/json'), { name: `${t.name.replace(/[^\w.-]+/g, '_')}.gwt.json`, types: ['.json'], description: 'Template' });
    },
  });

  /** Apply Template: pick one (built-in, project or a file), preview the page and export it. */
  C.implement('tpl.apply', {
    enabled: hasImage,
    run: async () => {
      const list = h('select', { class: 'inp', size: '6', 'aria-label': 'Templates' }, ...Object.entries(BUILTIN_TEMPLATES).map(([k, t]) => h('option', { value: `builtin:${k}` }, t.name)), ...userTemplates().map((r) => h('option', { value: r.id }, `${r.name} (project)`)), h('option', { value: 'file' }, 'From a file…'));
      list.value = app.prefs.get('templateActive') ?? 'builtin:sheet';
      if ((await modal({ title: 'Apply Template', body: h('div', {}, field('Template', list)), buttons: ['Apply', 'Cancel'], id: 'tpl-apply' })) !== 'Apply') return;
      if (list.value === 'file') {
        const [f] = await pickFiles(app, { multiple: false, accept: ['.json'], description: 'Template' });
        if (!f) return;
        try {
          await loadTemplateFile(f);
        } catch (e) {
          return app.toast(`Not a template: ${e.message}`, { kind: 'error' });
        }
      } else app.prefs.set('templateActive', list.value);
      return pageDialog();
    },
  });

  async function pageDialog() {
    let page;
    try {
      page = await renderPage(app, activeTemplate(), pane());
    } catch (e) {
      return app.toast(`Product failed: ${e.message}`, { kind: 'error' });
    }
    const prev = document.createElement('canvas');
    const k = Math.min(1, 680 / page.pagePx[0]);
    prev.width = Math.round(page.pagePx[0] * k);
    prev.height = Math.round(page.pagePx[1] * k);
    const g = prev.getContext('2d');
    for (const s of page.strips) g.drawImage(s.canvas, 0, s.y0 * k, s.canvas.width * k, s.h * k);
    prev.setAttribute('role', 'img');
    prev.setAttribute('aria-label', `Page preview, ${page.record.template}`);
    const r = page.record;
    const info = h('p', { class: 'hint' }, `${r.page.size} ${r.page.orientation}, ${r.page.dpi} dpi (${r.page.px[0]} × ${r.page.px[1]} px)${r.frame.scale ? ` · frame 1:${r.frame.scale.toLocaleString('en-GB')}` : ''} · ${r.marking.text}`);
    const res = await modal({ title: 'Product', body: h('div', {}, h('div', { class: 'chip-preview', tabindex: '0', role: 'region', 'aria-label': 'Page preview (scrolls)' }, prev), info), buttons: ['Save PDF…', 'Save PNG…', 'Print…', 'Close'], width: 720, id: 'product-page', marking: r.marking.text });
    try {
      if (res === 'Save PDF…') await savePdf(page);
      else if (res === 'Save PNG…') {
        const c = stitch(page);
        const b = await new Promise((ok) => c.toBlob(ok, 'image/png'));
        await saveBlob(app, b, { name: 'product.png', types: ['.png'], description: 'PNG' });
      } else if (res === 'Print…') printPage(page);
    } catch (e) {
      app.toast(e.message, { kind: 'error' });
    }
    return page;
  }
  app.productPageDialog = pageDialog;

  async function savePdf(page) {
    const u8 = await pagesToPdf([page], { title: `${page.record.marking.text} — ${page.record.image}`, subject: page.record.marking.text, author: app.prefs.get('analyst') ?? '', keywords: 'GIS Workbench product' });
    await saveBlob(app, new Blob([u8], { type: 'application/pdf' }), { name: 'product.pdf', types: ['.pdf'], description: 'PDF' });
  }
  app.pagesToPdf = pagesToPdf;

  /** Print at the page's size (no fit-to-page), from images of the strips. */
  function printPage(page) {
    document.getElementById('print-root')?.remove();
    const [w, hgt] = page.pageMm;
    const root = h('div', { id: 'print-root', 'aria-hidden': 'true' });
    for (const s of page.strips) {
      const img = new Image();
      img.src = s.canvas.toDataURL('image/png');
      img.style.width = `${w}mm`;
      img.style.height = `${(s.h / page.pagePx[1]) * hgt}mm`;
      root.appendChild(img);
    }
    const st = h('style', { id: 'print-page-style' });
    st.textContent = `@page { size: ${w}mm ${hgt}mm; margin: 0; }`;
    document.head.appendChild(st);
    document.body.appendChild(root);
    document.body.classList.add('printing');
    const done = () => {
      document.body.classList.remove('printing');
      root.remove();
      st.remove();
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    if (app.__test?.noPrint) return { root };
    window.print();
    return { root };
  }

  C.implement('snap.pdf', {
    enabled: hasImage,
    run: async () => {
      try {
        await savePdf(await renderPage(app, activeTemplate(), pane()));
      } catch (e) {
        app.toast(`PDF failed: ${e.message}`, { kind: 'error' });
      }
    },
  });
  C.implement('snap.geopdf', {
    enabled: () => hasImage() && !!pane()?.geoLayer()?.modelId,
    run: async () => {
      try {
        const page = await renderPage(app, activeTemplate(), pane());
        if (!page.record?.frame?.corners) throw new Error('the template has no map frame with ground corners');
        const u8 = await pagesToPdf([page], { title: `${page.record.marking.text} — ${page.record.image}`, subject: page.record.marking.text, author: app.prefs.get('analyst') ?? '', keywords: 'GIS Workbench GeoPDF' });
        await saveBlob(app, new Blob([u8], { type: 'application/pdf' }), { name: 'product-geo.pdf', types: ['.pdf'], description: 'GeoPDF' });
      } catch (e) {
        app.toast(`GeoPDF failed: ${e.message}`, { kind: 'error' });
      }
    },
  });
  C.implement('file.print', {
    enabled: hasImage,
    run: async () => {
      try {
        printPage(await renderPage(app, activeTemplate(), pane()));
      } catch (e) {
        app.toast(`Print failed: ${e.message}`, { kind: 'error' });
      }
    },
  });

  // ---- KMZ (REQ-PRD-07) ----
  const msl = (lat, lon, hae) => {
    const N = app.core.undulation(lat, lon);
    return Number.isFinite(N) ? hae - N : hae;
  };
  app.chipKmz = async (p = pane()) => {
    const chip = await makeChip(app, p, { graphics: true });
    const rec = chip.record;
    if (!rec.cornersGround) throw new Error('the image has no geolocation');
    const [W, H] = rec.size;
    const img = document.createElement('canvas');
    img.width = W;
    img.height = H;
    img.getContext('2d').drawImage(chip.canvas, 0, chip.imageTop, W, H, 0, 0, W, H);
    const banner = document.createElement('canvas');
    banner.width = 800;
    banner.height = 22;
    drawBanner(banner.getContext('2d'), chip.marking, 0, 0, 800, 22);
    const png = async (c) => new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/png'))).arrayBuffer());
    const gk = toKml(app.store.all('graphic').filter((g) => g.anchor === 'ground' && g.pane === p.id), msl, 'Graphics');
    const kml = chipKml(rec, 'chip.png', bannerText(chip.marking), gk);
    const zip = zipSync({ 'doc.kml': strToU8(kml), 'chip.png': await png(img), 'banner.png': await png(banner) }, { level: 0 });
    return { zip, kml, record: rec };
  };
  C.implement('snap.kmz', {
    enabled: () => !!pane()?.geoLayer?.()?.modelId,
    run: async () => {
      try {
        const r = await app.chipKmz();
        await saveBlob(app, new Blob([r.zip], { type: 'application/vnd.google-earth.kmz' }), { name: `chip${r.record.number}.kmz`, types: ['.kmz'], description: 'KMZ' });
      } catch (e) {
        app.toast(`KMZ failed: ${e.message}`, { kind: 'error' });
      }
    },
  });

  // ---- reports (REQ-PRD-11, REQ-AI-10) ----
  const reportFields = () => app.prefs.get('reportFields') ?? { title: 'Exploitation report', type: REPORT_TYPES[0], tasking: '', productId: '', location: '', bluf: '', comments: '', authority: '', aiDrafted: [] };
  app.buildReport = (fields = reportFields()) => buildReport(app, { ...fields, chipImages: app.chipImages, media: app.media?.items ?? [] });

  async function reportDialog(fields = reportFields()) {
    const inp = reportInputs(app);
    const f = { ...fields };
    const title = h('input', { class: 'inp', value: f.title, 'aria-label': 'Title' });
    const type = h('select', { class: 'inp', 'aria-label': 'Type' }, ...REPORT_TYPES.map((t) => h('option', { value: t }, t)));
    type.value = f.type;
    const pid = h('input', { class: 'inp', value: f.productId, 'aria-label': 'Product ID' });
    const tasking = h('input', { class: 'inp', value: f.tasking, 'aria-label': 'Tasking reference' });
    const location = h('input', { class: 'inp', value: f.location, 'aria-label': 'Site name and ID' });
    const bluf = h('textarea', { class: 'inp', rows: '4', 'aria-label': 'BLUF' }, f.bluf);
    const comments = h('textarea', { class: 'inp', rows: '4', 'aria-label': 'Analyst comments and gaps' }, f.comments);
    const authority = h('input', { class: 'inp', value: f.authority, placeholder: 'Only if you enter it; never generated', 'aria-label': 'Classification authority block' });
    const banner = h('p', { class: 'hint', 'aria-live': 'polite' });
    const read = () => ({ ...f, title: title.value, type: type.value, productId: pid.value, tasking: tasking.value, location: location.value, bluf: bluf.value, comments: comments.value, authority: authority.value });
    const upd = () => (banner.textContent = `Banner: ${bannerText(reportMarking(app, inp, read()))} (rolled up from ${inp.images.length} image(s), ${inp.observations.length} observation(s), ${inp.chips.length} chip(s) and the text). Start paragraphs with portion marks such as (U).`);
    for (const el of [bluf, comments]) el.addEventListener('input', upd);
    upd();
    const aiBtn = h('button', { class: 'btn' }, 'Draft with AI…');
    const aiNote = h('p', { class: 'hint', 'aria-live': 'polite' });
    aiBtn.addEventListener('click', async () => {
      aiNote.textContent = 'Drafting…';
      try {
        const d = await draftReport(read());
        if (!d) return (aiNote.textContent = 'Cancelled.');
        bluf.value = d.bluf;
        comments.value = d.comments;
        f.aiDrafted = ['bluf', 'comments'];
        aiNote.textContent = `AI-drafted by ${d.model}${d.fixed ? `; ${d.fixed} paragraph(s) had no or a lower portion mark and were marked ${portionMark(d.floor)}` : ''}. Review and edit before release.`;
        upd();
      } catch (e) {
        aiNote.textContent = `AI draft failed: ${e.message}`;
      }
    });
    const body = h('div', {}, field('Title', title), field('Type', type), field('Product ID', pid), field('Tasking', tasking), field('Location', location), field('BLUF', bluf), field('Comments and gaps', comments), field('Authority block', authority), h('div', {}, aiBtn, aiNote), banner);
    const res = await modal({ title: 'Report Template', body, buttons: ['Save HTML…', 'Save DOCX…', 'Print…', 'Close'], width: 680, id: 'report' });
    const fields2 = read();
    app.prefs.set('reportFields', fields2);
    if (res === null || res === 'Close') return fields2;
    const html = app.buildReport(fields2);
    if (res === 'Save HTML…') await saveBlob(app, textBlob(html, 'text/html'), { name: 'report.html', types: ['.html'], description: 'HTML report' });
    if (res === 'Save DOCX…') await saveBlob(app, new Blob([docxFromHtml(html, { title: fields2.title, creator: app.prefs.get('analyst') || 'GIS Workbench' })], { type: DOCX_TYPE }), { name: 'report.docx', types: ['.docx'], description: 'Word report' });
    if (res === 'Print…') printHtml(html);
    return fields2;
  }
  app.reportDialog = reportDialog;
  app.reportDocx = (fields = reportFields()) => docxFromHtml(app.buildReport(fields), { title: fields.title });

  /** Print the report document in place of the app (the browser's Save as PDF is the PDF path). */
  function printHtml(html) {
    document.getElementById('print-root')?.remove();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = h('div', { id: 'print-root', class: 'print-report' });
    const st = h('style', { id: 'print-page-style' });
    st.textContent = [...doc.querySelectorAll('style')].map((x) => x.textContent).join('\n');
    root.append(...doc.body.childNodes);
    document.head.appendChild(st);
    document.body.appendChild(root);
    document.body.classList.add('printing');
    const done = () => {
      document.body.classList.remove('printing');
      root.remove();
      st.remove();
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    if (app.__test?.noPrint) return { root, done };
    window.print();
    return { root, done };
  }
  app.printReportHtml = printHtml;

  async function draftReport(fields) {
    const inp = reportInputs(app);
    const floor = reportMarking(app, inp, {});
    const r = await app.ai.complete({ system: 'You draft imagery exploitation report text for an analyst who will review it. Keep portion marks on every paragraph.', text: draftPrompt(inp, fields) });
    if (!r) return null;
    return { ...parseDraft(r.text, floor), model: r.model, floor };
  }
  app.draftReport = draftReport;

  C.implement('report.template', { run: () => reportDialog() });
  C.implement('report.ai', {
    run: async () => {
      try {
        const d = await draftReport(reportFields());
        if (!d) return;
        return reportDialog({ ...reportFields(), bluf: d.bluf, comments: d.comments, aiDrafted: ['bluf', 'comments'] });
      } catch (e) {
        app.toast(`AI draft failed: ${e.message}`, { kind: 'error' });
      }
    },
  });
}
