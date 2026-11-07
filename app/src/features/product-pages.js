// Products ▸ Templates, Snapshot and Reports (REQ-PRD-02/03/04/07/11, REQ-AI-10): JSON page
// templates (new, edit, apply, save, Product Properties), PDF from page strips, printing at
// scale, KMZ chip overlays (LatLonQuad) with the graphics, and the report with an
// optional AI draft.

import { h } from '../shell/dom.js';
import { docxFromHtml, DOCX_TYPE } from '../products/docx.js';
import { modal, field, section, promptBox } from '../shell/dialogs.js';
import { saveBlob, textBlob, pickFiles } from '../storage/files.js';
import { zipSync, strToU8 } from 'fflate';
import { BUILTIN_TEMPLATES, PAGES, PAGE_NAMES, normalizeTemplate, renderPage, stitch } from '../products/template.js';
import { makeChip } from '../products/chip.js';
import { writePdf } from '../formats/pdf-writer.js';
import { buildReport, reportInputs, draftPrompt, parseDraft, REPORT_TYPES, reportType } from '../products/report.js';
import { toKml } from './graphics.js';
import { t, tr, msgOf } from '../i18n/index.js';
import { num, int } from '../i18n/format.js';

export const name = 'product-pages';

/** OK / Cancel with values (L0: code compares values, never labels). */
const okCancel = () => [
  { label: t('OK'), value: 'ok', primary: true },
  { label: t('Cancel'), value: 'cancel' },
];

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
export function chipKml(rec, imageName, graphicsKml = '') {
  const [ul, ur, lr, ll] = rec.cornersGround;
  const q = [ll, lr, ur, ul].map((c) => `${c[0].toFixed(9)},${c[1].toFixed(9)}`).join(' ');
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const placemarks = (/<Document>([\s\S]*)<\/Document>/.exec(graphicsKml)?.[1] ?? '').replace(/<name>[^<]*<\/name>\s*/, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
<name>Chip ${esc(rec.number)}</name>
<description>${esc(rec.caption)}. Image ${esc(rec.image)}; created ${esc(rec.created)} with GIS Workbench.</description>
<GroundOverlay>
<name>${esc(rec.caption)}</name>
<Icon><href>${esc(imageName)}</href></Icon>
<gx:LatLonQuad><coordinates>${q}</coordinates></gx:LatLonQuad>
</GroundOverlay>
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
      app.store.transact(t('Edit template'), (tx) => (nid = tx.create('template', { name: body.name, body })));
      app.prefs.set('templateActive', nid);
    } else app.store.transact(t('Edit template'), (tx) => tx.set(id, 'body', body));
  };
  app.productTemplate = activeTemplate;
  app.renderProductPage = (tpl = activeTemplate(), o) => renderPage(app, tpl, pane(), o);
  /** A .gwt.json product template (Apply Template ▸ From a file…, or a drop): added to the project and made active. */
  async function loadTemplateFile(f) {
    const body = normalizeTemplate(JSON.parse(await f.text()));
    let id;
    app.store.transact(t('Load template'), (tx) => (id = tx.create('template', { name: body.name, body })));
    app.prefs.set('templateActive', id);
    return body;
  }
  app.loadTemplateFile = loadTemplateFile;

  C.implement('tpl.new', {
    run: async () => {
      const n = await promptBox(t('New Template'), t('Name'), t('My map sheet'));
      if (!n) return;
      const body = { ...structuredClone(BUILTIN_TEMPLATES.sheet), name: n };
      let id;
      app.store.transact(t('New template'), (tx) => (id = tx.create('template', { name: n, body })));
      app.prefs.set('templateActive', id);
      app.toast(t('Template "{name}" created; Edit Template and Product Properties change it', { name: n }), { kind: 'info' });
    },
  });

  /** Product Properties (REQ-PRD-04): page, DPI, margins, scale; save-image options. */
  C.implement('tpl.props', {
    run: async () => {
      const tp = activeTemplate();
      // The value is the template's page size key; the option shows its name in the UI language.
      const size = h('select', { class: 'inp', 'aria-label': t('Page size') }, ...Object.keys(PAGES).map((k) => h('option', { value: k }, PAGE_NAMES[k] ? tr(PAGE_NAMES[k]) : k)));
      size.value = tp.page.size;
      const orient = h('select', { class: 'inp', 'aria-label': t('Orientation') }, h('option', { value: 'landscape' }, t('Landscape')), h('option', { value: 'portrait' }, t('Portrait')));
      orient.value = tp.page.orientation;
      const dpi = h('input', { class: 'inp', type: 'number', min: '72', max: '600', step: '1', value: String(tp.page.dpi), 'aria-label': t('DPI') });
      const margin = h('input', { class: 'inp', type: 'number', min: '0', max: '40', step: '0.5', value: String(tp.page.marginMm), 'aria-label': t('Margins (mm)') });
      const scale = h('input', { class: 'inp', type: 'number', min: '100', step: '1', value: tp.scale ? String(tp.scale) : '', placeholder: t('fit the view'), 'aria-label': t('Scale denominator (1:n)') });
      const fmt = h('select', { class: 'inp', 'aria-label': t('Image format') }, h('option', { value: 'png' }, t('PNG (8-bit RGB)')), h('option', { value: 'jpeg' }, t('JPEG (8-bit RGB)')), h('option', { value: 'tif-display' }, t('GeoTIFF (8-bit RGB, GCPs)')), h('option', { value: 'tif-source' }, t('GeoTIFF (source bit depth)')), h('option', { value: 'nitf-source' }, t('NITF (source bit depth)')));
      fmt.value = app.prefs.get('chipFormat') ?? 'png';
      const body = h(
        'div',
        {},
        section(t('Page'), field(t('Size'), size), field(t('Orientation'), orient), field(t('Resolution (dpi)'), dpi), field(t('Margins (mm)'), margin)),
        section(t('Map frame'), field(t('Scale 1 :'), scale, t('Blank fits the panel view. A fixed scale uses the page geometry: ground width = frame width × n.'))),
        section(t('Save image options'), field(t('Chip format and bit depth'), fmt, t('PNG and JPEG carry a world file and .prj; GeoTIFF and NITF carry GCPs or RPCs.'))),
      );
      if ((await modal({ title: t('Product Properties'), body, buttons: okCancel(), id: 'tpl-props' })) !== 'ok') return;
      const next = { ...tp, page: { size: size.value, orientation: orient.value, dpi: +dpi.value, marginMm: +margin.value }, scale: scale.value ? +scale.value : null };
      try {
        normalizeTemplate(next);
      } catch (e) {
        return app.toast(msgOf(e), { kind: 'error' });
      }
      setActiveBody(next);
      app.prefs.set('chipFormat', fmt.value);
    },
  });

  /** Edit Template: title, legend, grid, inset and metadata block, or the JSON. */
  C.implement('tpl.edit', {
    run: async () => {
      const tp = activeTemplate();
      const title = h('input', { class: 'inp', value: tp.title, 'aria-label': t('Title') });
      // Grid systems (UTM, MGRS…) are standard names.
      const grid = h('select', { class: 'inp', 'aria-label': t('Grid') }, ...['off', 'latlon', 'utm', 'mgrs'].map((g) => h('option', { value: g }, g === 'off' ? t('None') : g.toUpperCase())));
      grid.value = tp.grid;
      const gridStep = h('input', { class: 'inp', type: 'number', min: '0', step: 'any', value: String(tp.gridInterval ?? 0), 'aria-label': t('Grid interval (0 = automatic)') });
      const chk = (v, label) => h('input', { type: 'checkbox', checked: !!v, 'aria-label': label });
      const legend = chk(tp.legend, t('Legend'));
      const inset = chk(tp.inset, t('Inset'));
      const meta = chk(tp.metadata, t('Metadata block'));
      const north = chk(tp.northArrow, t('North arrow'));
      const sbar = chk(tp.scaleBar, t('Scale bar'));
      const source = h('input', { class: 'inp', value: tp.source, 'aria-label': t('Source line') });
      const json = h('textarea', { class: 'inp mono', rows: '10', spellcheck: 'false', 'aria-label': t('Template JSON') }, JSON.stringify(tp, null, 1));
      const body = h(
        'div',
        {},
        field(t('Name'), h('span', {}, tp.name)),
        field(t('Title'), title),
        field(t('Grid'), grid),
        field(t('Grid interval (m or degrees; 0 = automatic)'), gridStep),
        field(t('Marginalia'), h('span', {}, h('label', {}, legend, ` ${t('Legend')} `), h('label', {}, inset, ` ${t('Inset')} `), h('label', {}, meta, ` ${t('Metadata block')} `), h('label', {}, north, ` ${t('North arrow')} `), h('label', {}, sbar, ` ${t('Scale bar')}`))),
        field(t('Source line'), source),
        h('details', {}, h('summary', {}, t('JSON (advanced; overrides the fields above when changed)')), json),
      );
      const orig = json.value;
      if ((await modal({ title: t('Edit Template'), body, buttons: okCancel(), width: 640, id: 'tpl-edit' })) !== 'ok') return;
      let next;
      try {
        next = json.value !== orig ? normalizeTemplate(JSON.parse(json.value)) : normalizeTemplate({ ...tp, title: title.value, grid: grid.value, gridInterval: Number(gridStep.value) || 0, legend: legend.checked, inset: inset.checked, metadata: meta.checked, northArrow: north.checked, scaleBar: sbar.checked, source: source.value });
      } catch (e) {
        return app.toast(t('Template not changed: {msg}', { msg: msgOf(e) }), { kind: 'error' });
      }
      setActiveBody(next);
    },
  });

  C.implement('tpl.saveas', {
    run: async () => {
      const tp = activeTemplate();
      await saveBlob(app, textBlob(JSON.stringify(tp, null, 1), 'application/json'), { name: `${tp.name.replace(/[^\w.-]+/g, '_')}.gwt.json`, types: ['.json'], description: t('Template') });
    },
  });

  /** Apply Template: pick one (built-in, project or a file), preview the page and export it. */
  C.implement('tpl.apply', {
    enabled: hasImage,
    run: async () => {
      const list = h('select', { class: 'inp', size: '6', 'aria-label': t('Templates') }, ...Object.entries(BUILTIN_TEMPLATES).map(([k, b]) => h('option', { value: `builtin:${k}` }, b.name)), ...userTemplates().map((r) => h('option', { value: r.id }, t('{name} (project)', { name: r.name }))), h('option', { value: 'file' }, t('From a file…')));
      list.value = app.prefs.get('templateActive') ?? 'builtin:sheet';
      if ((await modal({ title: t('Apply Template'), body: h('div', {}, field(t('Template'), list)), buttons: [{ label: t('Apply'), value: 'apply', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'tpl-apply' })) !== 'apply') return;
      if (list.value === 'file') {
        const [f] = await pickFiles(app, { multiple: false, accept: ['.json'], description: t('Template') });
        if (!f) return;
        try {
          await loadTemplateFile(f);
        } catch (e) {
          return app.toast(t('Not a template: {msg}', { msg: msgOf(e) }), { kind: 'error' });
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
      return app.toast(t('Product failed: {msg}', { msg: msgOf(e) }), { kind: 'error' });
    }
    const prev = document.createElement('canvas');
    const k = Math.min(1, 680 / page.pagePx[0]);
    prev.width = Math.round(page.pagePx[0] * k);
    prev.height = Math.round(page.pagePx[1] * k);
    const g = prev.getContext('2d');
    for (const s of page.strips) g.drawImage(s.canvas, 0, s.y0 * k, s.canvas.width * k, s.h * k);
    prev.setAttribute('role', 'img');
    prev.setAttribute('aria-label', t('Page preview, {template}', { template: page.record.template }));
    const r = page.record;
    const orientation = { landscape: t('landscape'), portrait: t('portrait') }[r.page.orientation] ?? r.page.orientation;
    // Separate facts joined by a middle dot (each phrase is whole).
    const bits = [t('{size} {orientation}, {dpi} dpi ({w} × {h} px)', { size: r.page.size, orientation, dpi: num(r.page.dpi, 0), w: num(r.page.px[0], 0), h: num(r.page.px[1], 0) })];
    if (r.frame.scale) bits.push(t('frame 1:{scale}', { scale: int(r.frame.scale) }));
    const info = h('p', { class: 'hint' }, bits.join(' · '));
    const res = await modal({
      title: t('Product'),
      body: h('div', {}, h('div', { class: 'chip-preview', tabindex: '0', role: 'region', 'aria-label': t('Page preview (scrolls)') }, prev), info),
      buttons: [
        { label: t('Save PDF…'), value: 'pdf', primary: true },
        { label: t('Save PNG…'), value: 'png' },
        { label: t('Print…'), value: 'print' },
        { label: t('Close'), value: 'close' },
      ],
      width: 720,
      id: 'product-page',
    });
    try {
      if (res === 'pdf') await savePdf(page);
      else if (res === 'png') {
        const c = stitch(page);
        const b = await new Promise((ok) => c.toBlob(ok, 'image/png'));
        await saveBlob(app, b, { name: 'product.png', types: ['.png'], description: 'PNG' });
      } else if (res === 'print') printPage(page);
    } catch (e) {
      app.toast(msgOf(e), { kind: 'error' });
    }
    return page;
  }
  app.productPageDialog = pageDialog;

  async function savePdf(page) {
    const u8 = await pagesToPdf([page], { title: page.record.image, author: app.prefs.get('analyst') ?? '', keywords: 'GIS Workbench product' });
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
        app.toast(t('PDF failed: {msg}', { msg: msgOf(e) }), { kind: 'error' });
      }
    },
  });
  C.implement('snap.geopdf', {
    enabled: () => hasImage() && !!pane()?.geoLayer()?.modelId,
    run: async () => {
      try {
        const page = await renderPage(app, activeTemplate(), pane());
        if (!page.record?.frame?.corners) throw new Error('the template has no map frame with ground corners');
        const u8 = await pagesToPdf([page], { title: page.record.image, author: app.prefs.get('analyst') ?? '', keywords: 'GIS Workbench GeoPDF' });
        await saveBlob(app, new Blob([u8], { type: 'application/pdf' }), { name: 'product-geo.pdf', types: ['.pdf'], description: 'GeoPDF' });
      } catch (e) {
        app.toast(t('GeoPDF failed: {msg}', { msg: msgOf(e) }), { kind: 'error' });
      }
    },
  });
  C.implement('file.print', {
    enabled: hasImage,
    run: async () => {
      try {
        printPage(await renderPage(app, activeTemplate(), pane()));
      } catch (e) {
        app.toast(t('Print failed: {msg}', { msg: msgOf(e) }), { kind: 'error' });
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
    img.getContext('2d').drawImage(chip.canvas, 0, 0, W, H, 0, 0, W, H);
    const png = async (c) => new Uint8Array(await (await new Promise((ok) => c.toBlob(ok, 'image/png'))).arrayBuffer());
    const gk = toKml(app.store.all('graphic').filter((g) => g.anchor === 'ground' && g.pane === p.id), msl, 'Graphics');
    const kml = chipKml(rec, 'chip.png', gk);
    const zip = zipSync({ 'doc.kml': strToU8(kml), 'chip.png': await png(img) }, { level: 0 });
    return { zip, kml, record: rec };
  };
  C.implement('snap.kmz', {
    enabled: () => !!pane()?.geoLayer?.()?.modelId,
    run: async () => {
      try {
        const r = await app.chipKmz();
        await saveBlob(app, new Blob([r.zip], { type: 'application/vnd.google-earth.kmz' }), { name: `chip${r.record.number}.kmz`, types: ['.kmz'], description: 'KMZ' });
      } catch (e) {
        app.toast(t('KMZ failed: {msg}', { msg: msgOf(e) }), { kind: 'error' });
      }
    },
  });

  // ---- reports (REQ-PRD-11, REQ-AI-10) ----
  const reportFields = () => app.prefs.get('reportFields') ?? { title: t('Report'), type: REPORT_TYPES[0], tasking: '', productId: '', location: '', bluf: '', comments: '', aiDrafted: [] };
  app.buildReport = (fields = reportFields()) => buildReport(app, { ...fields, chipImages: app.chipImages, media: app.media?.items ?? [] });

  async function reportDialog(fields = reportFields()) {
    const inp = reportInputs(app);
    const f = { ...fields };
    const title = h('input', { class: 'inp', value: f.title, 'aria-label': t('Title') });
    // The value stays the report type's English name (stored and written into the report).
    const type = h('select', { class: 'inp', 'aria-label': t('Type') }, ...REPORT_TYPES.map((ty) => h('option', { value: ty }, tr(ty))));
    type.value = reportType(f.type);
    const pid = h('input', { class: 'inp', value: f.productId, 'aria-label': t('Product ID') });
    const tasking = h('input', { class: 'inp', value: f.tasking, 'aria-label': t('Tasking reference') });
    const location = h('input', { class: 'inp', value: f.location, 'aria-label': t('Site name and ID') });
    const bluf = h('textarea', { class: 'inp', rows: '4', 'aria-label': t('BLUF') }, f.bluf);
    const comments = h('textarea', { class: 'inp', rows: '4', 'aria-label': t('Analyst comments and gaps') }, f.comments);
    const read = () => ({ ...f, title: title.value, type: type.value, productId: pid.value, tasking: tasking.value, location: location.value, bluf: bluf.value, comments: comments.value });
    const aiBtn = h('button', { class: 'btn' }, t('Draft with AI…'));
    const aiNote = h('p', { class: 'hint', 'aria-live': 'polite' });
    aiBtn.addEventListener('click', async () => {
      aiNote.textContent = t('Drafting…');
      try {
        const d = await draftReport(read());
        if (!d) return (aiNote.textContent = t('Cancelled.'));
        bluf.value = d.bluf;
        comments.value = d.comments;
        f.aiDrafted = ['bluf', 'comments'];
        aiNote.textContent = t('AI-drafted by {model}. Review and edit before release.', { model: d.model });
      } catch (e) {
        aiNote.textContent = t('AI draft failed: {msg}', { msg: msgOf(e) });
      }
    });
    const body = h('div', {}, field(t('Title'), title), field(t('Type'), type), field(t('Product ID'), pid), field(t('Tasking'), tasking), field(t('Location'), location), field(t('BLUF'), bluf), field(t('Comments and gaps'), comments), h('div', {}, aiBtn, aiNote));
    const res = await modal({
      title: t('Report Template'),
      body,
      buttons: [
        { label: t('Save HTML…'), value: 'html', primary: true },
        { label: t('Save DOCX…'), value: 'docx' },
        { label: t('Print…'), value: 'print' },
        { label: t('Close'), value: 'close' },
      ],
      width: 680,
      id: 'report',
    });
    const fields2 = read();
    app.prefs.set('reportFields', fields2);
    if (res === null || res === 'close') return fields2;
    const html = app.buildReport(fields2);
    if (res === 'html') await saveBlob(app, textBlob(html, 'text/html'), { name: 'report.html', types: ['.html'], description: t('HTML report') });
    if (res === 'docx') await saveBlob(app, new Blob([docxFromHtml(html, { title: fields2.title, creator: app.prefs.get('analyst') || 'GIS Workbench' })], { type: DOCX_TYPE }), { name: 'report.docx', types: ['.docx'], description: t('Word report') });
    if (res === 'print') printHtml(html);
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
    const r = await app.ai.complete({ system: 'You draft imagery analysis report text for an analyst who will review it.', text: draftPrompt(inp, fields) });
    if (!r) return null;
    return { ...parseDraft(r.text), model: r.model };
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
        app.toast(t('AI draft failed: {msg}', { msg: msgOf(e) }), { kind: 'error' });
      }
    },
  });
}
