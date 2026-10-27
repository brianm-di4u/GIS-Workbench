// Review window (REQ-WB-08) in two steps — review pages (edit notes, reorder, delete, copy)
// and send — plus every export (REQ-WB-09): PNG per page, self-contained HTML report,
// versioned JSON, plain-text e-mail body, clipboard image, Web Share and mail drafts.
// Nothing leaves the browser unless the user clicks a send action. Import (REQ-WB-11).

import { h, clear } from '../shell/dom.js';
import { modal } from '../shell/dialogs.js';
import { saveBlob, textBlob, pickFiles } from '../storage/files.js';
import { toJson, fromJson, extractJsonFromHtml, merge, emailBody, PAGE_TYPES, TRIAGE_STATUS, TRIAGE_PRIORITY, filterPages, pageToObservation } from './model.js';
import { bannerText } from '../security/marking.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function session(app, wb) {
  return { project: app.project()?.name ?? 'Untitled', build: app.build.id, marking: app.screenMarking(), markingText: bannerText(app.screenMarking()), pages: wb.pages };
}

/** Self-contained HTML report: images inline plus a JSON data block for re-import. */
export function reportHtml(s) {
  const json = JSON.stringify(toJson(s)).replace(/</g, '\\u003c');
  const banner = esc(s.markingText || 'UNCLASSIFIED');
  const pages = s.pages
    .map((p, i) => {
      const c = p.context ?? {};
      const pins = p.pins.map((pin) => `<li><b>Pin ${pin.n}</b>${pin.target ? ` → ${esc(pin.target.label)}` : ''}: ${esc(pin.note)}</li>`).join('');
      return `<section class="page"><h2>${i + 1}. <span class="type">${esc(p.type)}</span> ${esc(p.summary || '(no summary)')}</h2>
${p.image ? `<img alt="Page ${i + 1} screenshot" src="${p.image}">` : '<p><i>No image</i></p>'}
${p.notes ? `<p>${esc(p.notes)}</p>` : ''}${pins ? `<ul>${pins}</ul>` : ''}
<table><tr><th>Image</th><td>${esc(c.image)}</td><th>Centre</th><td>${esc(c.centre?.mgrs)} ${c.centre ? `(${c.centre.lat}, ${c.centre.lon})` : ''}</td></tr>
<tr><th>Zoom / rotation</th><td>${esc(c.zoom)} / ${esc(c.rotation)}° ${esc(c.orientation)}</td><th>Sensor model</th><td>${esc(c.model)}</td></tr>
<tr><th>Image chain</th><td colspan="3">${esc(c.chain)}</td></tr>
<tr><th>Reporter</th><td>${esc(p.reporter)}</td><th>Captured</th><td>${esc(p.created)} (${esc(p.capture)})</td></tr>
<tr><th>Build</th><td>${esc(c.version)} ${esc(c.build)}</td><th>Run mode / theme</th><td>${esc(c.runMode)} / ${esc(c.theme)}</td></tr></table></section>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>GIS Workbench feedback — ${esc(s.project)}</title>
<style>body{font:13px Segoe UI,system-ui,sans-serif;margin:0;background:#f4f4f4;color:#111}.banner{background:#007a33;color:#fff;text-align:center;font-weight:bold;padding:3px}main{max-width:1200px;margin:0 auto;padding:12px}.page{background:#fff;border:1px solid #ccc;margin:14px 0;padding:10px}.page img{max-width:100%;border:1px solid #999}.type{background:#444;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;text-transform:uppercase}table{border-collapse:collapse;width:100%;margin-top:6px}th,td{border:1px solid #ddd;padding:2px 6px;text-align:left;vertical-align:top}th{background:#eee;width:120px}</style>
</head><body><div class="banner">${banner}</div><main><h1>GIS Workbench feedback</h1>
<p>Project ${esc(s.project)} · build ${esc(s.build)} · ${s.pages.length} page(s) · exported ${new Date().toISOString()}</p>
${pages}
<p><small>Re-import this report in GIS Workbench with Add-Ins ▸ Import Feedback.</small></p></main><div class="banner">${banner}</div>
<script type="application/json" id="feedback-data">${json}</script></body></html>`;
}

function dataUrlToBlob(u) {
  const [head, b64] = u.split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: mime });
}

/** Turn a page into an undoable observation (REQ-WB-13), linked to its pinned items. */
export function pageToObservationRecord(app, page) {
  const o = pageToObservation(page);
  let id;
  app.store.transact('Observation from feedback page', (tx) => (id = tx.create('observation', o)));
  page.observation = id;
  return id;
}

/** Turn a page into an annotation: a ground text graphic at its view centre, linked likewise. */
export function pageToAnnotation(app, page) {
  const o = pageToObservation(page);
  const c = page.context?.centre;
  const p = app.activePane();
  if (!c || !p) throw new Error('the page has no ground position (no sensor model when it was captured)');
  let id;
  app.store.transact('Annotation from feedback page', (tx) => {
    let gl = p.rec.graphicsLayer;
    if (!gl) {
      gl = tx.create('glayer', { pane: p.id, name: 'Graphics', visible: true, saved: false });
      tx.set(p.id, 'graphicsLayer', gl);
    }
    const hh = app.terrain?.sample?.(c.lat, c.lon)?.hae ?? p.geoLayer()?.defaultHeight?.() ?? 0;
    id = tx.create('graphic', { glayer: gl, pane: p.id, shape: 'callout', anchor: 'ground', coords: [[c.lon, c.lat, hh], [c.lon + 0.0003, c.lat + 0.0002, hh]], text: page.summary || o.text.split(String.fromCharCode(10))[0], links: o.links, style: { stroke: '#e00000', width: 2, fill: '#ffffff' }, provenance: { kind: 'feedback', page: page.id } });
  });
  page.annotation = id;
  return id;
}

export async function openReview(app, wb) {
  let step = 1;
  const flt = { status: '', priority: '', assignee: '' };
  const body = h('div', { class: 'wb-review' });
  const render = () => {
    clear(body);
    if (!wb.pages.length) {
      body.appendChild(h('p', {}, 'No pages yet. Open the whiteboard (B), mark up the application and press Capture page.'));
      return;
    }
    body.appendChild(h('div', { class: 'wb-steps' }, h('span', { class: step === 1 ? 'on' : '' }, '1. Review pages'), ' › ', h('span', { class: step === 2 ? 'on' : '' }, '2. Send')));
    if (step === 1) {
      // Triage filter (REQ-WB-12).
      const fs = h('select', { class: 'inp inp-short', 'aria-label': 'Filter by status' }, h('option', { value: '' }, 'any status'), ...TRIAGE_STATUS.map((t) => h('option', { value: t }, t)));
      const fp = h('select', { class: 'inp inp-short', 'aria-label': 'Filter by priority' }, h('option', { value: '' }, 'any priority'), ...TRIAGE_PRIORITY.filter(Boolean).map((t) => h('option', { value: t }, t)));
      const fa = h('input', { class: 'inp inp-short', placeholder: 'assignee', 'aria-label': 'Filter by assignee' });
      fs.value = flt.status;
      fp.value = flt.priority;
      fa.value = flt.assignee;
      const apply = () => {
        Object.assign(flt, { status: fs.value, priority: fp.value, assignee: fa.value });
        render();
      };
      fs.addEventListener('change', apply);
      fp.addEventListener('change', apply);
      fa.addEventListener('change', apply);
      const shown = filterPages(wb.pages, flt);
      body.appendChild(h('div', { class: 'wb-filter btn-row', 'data-id': 'wb:filter' }, h('span', {}, 'Show:'), fs, fp, fa, h('span', { class: 'hint' }, `${shown.length} of ${wb.pages.length} page(s)`)));
      wb.pages.forEach((p, i) => {
        if (!shown.includes(p)) return;
        p.triage = { status: 'new', priority: '', assignee: '', ...(p.triage ?? {}) };
        const ts = h('select', { class: 'inp inp-short', 'aria-label': `Status of page ${i + 1}` }, ...TRIAGE_STATUS.map((t) => h('option', { value: t }, t)));
        ts.value = p.triage.status;
        ts.addEventListener('change', () => (p.triage.status = ts.value));
        const tp = h('select', { class: 'inp inp-short', 'aria-label': `Priority of page ${i + 1}` }, ...TRIAGE_PRIORITY.map((t) => h('option', { value: t }, t || 'no priority')));
        tp.value = p.triage.priority;
        tp.addEventListener('change', () => (p.triage.priority = tp.value));
        const ta = h('input', { class: 'inp inp-short', value: p.triage.assignee, placeholder: 'assignee', 'aria-label': `Assignee of page ${i + 1}` });
        ta.addEventListener('input', () => (p.triage.assignee = ta.value));
        const triage = h('div', { class: 'wb-row wb-triage' }, h('span', { class: 'hint' }, 'Triage:'), ts, tp, ta);
        const type = h('select', { class: 'inp inp-short', 'aria-label': `Type of page ${i + 1}` }, PAGE_TYPES.map((t) => h('option', { value: t }, t)));
        type.value = p.type;
        type.addEventListener('change', () => (p.type = type.value));
        const sum = h('input', { class: 'inp', value: p.summary, placeholder: 'Summary', spellcheck: 'true', 'aria-label': `Summary of page ${i + 1}` });
        sum.addEventListener('input', () => (p.summary = sum.value));
        const notes = h('textarea', { class: 'inp', rows: '2', placeholder: 'General notes', spellcheck: 'true', 'aria-label': `Notes for page ${i + 1}` }, p.notes);
        notes.addEventListener('input', () => (p.notes = notes.value));
        const pins = p.pins.map((pin) => {
          const pn = h('input', { class: 'inp', value: pin.note, placeholder: `Note for pin ${pin.n}`, spellcheck: 'true' });
          pn.addEventListener('input', () => (pin.note = pn.value));
          const jump = h('button', { class: 'btn btn-small', disabled: !pin.target }, pin.target ? (wb.targetExists(pin.target) ? `Go to ${pin.target.label}` : `${pin.target.label} (gone)`) : 'no linked item');
          jump.addEventListener('click', () => wb.jumpTo(pin.target));
          return h('div', { class: 'wb-pin' }, h('b', {}, `Pin ${pin.n}`), pn, jump);
        });
        const tools = h('div', { class: 'btn-row' });
        for (const [label, fn] of [
          ['Up', () => i > 0 && ([wb.pages[i - 1], wb.pages[i]] = [wb.pages[i], wb.pages[i - 1]])],
          ['Down', () => i < wb.pages.length - 1 && ([wb.pages[i + 1], wb.pages[i]] = [wb.pages[i], wb.pages[i + 1]])],
          ['Copy', () => wb.pages.splice(i + 1, 0, { ...structuredClone(p), id: `${p.id}c${Date.now().toString(36)}` })],
          ['Delete', () => wb.pages.splice(i, 1)],
          ['Make Observation', () => {
            pageToObservationRecord(app, p);
            app.toast(`Page ${i + 1} is now an observation (undo reverts it)`);
          }],
          ['Make Annotation', () => {
            try {
              pageToAnnotation(app, p);
              app.toast(`Page ${i + 1} is now an annotation on the image`);
            } catch (e) {
              app.toast(e.message, { kind: 'warn' });
            }
          }],
        ]) {
          const b = h('button', { class: 'btn btn-small' }, label);
          b.addEventListener('click', () => {
            fn();
            app.feedbackSession?.save(wb);
            render();
          });
          tools.appendChild(b);
        }
        body.appendChild(h('div', { class: 'wb-page', 'data-id': `wb:page:${p.id}` }, h('img', { class: 'wb-thumb', src: p.image ?? '', alt: `Page ${i + 1}` }), h('div', { class: 'wb-page-fields' }, h('div', { class: 'wb-row' }, h('b', {}, `${i + 1}.`), type, sum), triage, notes, ...pins, tools, h('small', { class: 'hint' }, `${p.context?.image ?? 'no image'} · ${p.context?.centre?.mgrs ?? ''} · ${p.capture}`))));
      });
    } else {
      const s = session(app, wb);
      const recipient = app.project()?.feedbackRecipient ?? '';
      const subject = `GIS Workbench feedback — ${s.project} (${wb.pages.length} page${wb.pages.length > 1 ? 's' : ''})`;
      const text = emailBody(s);
      const actions = [
        ['HTML report', 'Self-contained report with images and a JSON block', async () => saveBlob(app, textBlob(reportHtml(s), 'text/html'), { name: 'gisworkbench-feedback.html', types: ['.html'], description: 'HTML report' })],
        ['JSON', `kind "gisworkbench-feedback", version 1`, async () => saveBlob(app, textBlob(JSON.stringify(toJson(s), null, 1), 'application/json'), { name: 'gisworkbench-feedback.json', types: ['.json'], description: 'JSON' })],
        ['PNG per page', 'One PNG file per page', async () => {
          for (let i = 0; i < wb.pages.length; i++) if (wb.pages[i].image) await saveBlob(app, dataUrlToBlob(wb.pages[i].image), { name: `feedback-page-${i + 1}.png`, preferPicker: false });
        }],
        ['Copy image', 'Current first page to the clipboard', async () => {
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': dataUrlToBlob(wb.pages[0].image) })]);
            app.toast('Page 1 image copied');
          } catch {
            app.toast('The clipboard is blocked here; use PNG per page', { kind: 'warn' });
          }
        }],
        ['Copy e-mail text', 'Plain-text body for any mail client', async () => {
          try {
            await navigator.clipboard.writeText(text);
            app.toast('E-mail text copied');
          } catch {
            app.toast('The clipboard is blocked here', { kind: 'warn' });
          }
        }],
      ];
      const sendActions = [
        ['Share…', 'Web Share (where the browser offers it)', async () => {
          const file = new File([reportHtml(s)], 'gisworkbench-feedback.html', { type: 'text/html' });
          if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: subject, text, files: [file] });
          else app.toast('Web Share is not available here', { kind: 'warn' });
        }],
        ['Mail draft', 'Opens your mail client (mailto:) with the text; attach the HTML report', () => window.open(`mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`, '_blank', 'noopener')],
        ['Gmail draft', 'Opens a Gmail compose window in a new tab', () => window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(recipient)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`, '_blank', 'noopener')],
        ['Outlook draft', 'Opens an Outlook web compose window in a new tab', () => window.open(`https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(recipient)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`, '_blank', 'noopener')],
      ];
      body.appendChild(h('p', { class: 'hint' }, `Nothing is sent until you click a send action. Banner on every page: ${s.markingText}.`));
      body.appendChild(h('h4', {}, 'Export'));
      for (const [l, d, fn] of actions) {
        const b = h('button', { class: 'btn', title: d, 'data-id': `wb:export:${l}` }, l);
        b.addEventListener('click', fn);
        body.appendChild(h('div', { class: 'wb-action' }, b, h('span', { class: 'hint' }, d)));
      }
      body.appendChild(h('h4', {}, 'Send'));
      for (const [l, d, fn] of sendActions) {
        const b = h('button', { class: 'btn', title: d }, l);
        b.addEventListener('click', fn);
        body.appendChild(h('div', { class: 'wb-action' }, b, h('span', { class: 'hint' }, d)));
      }
      body.appendChild(h('details', {}, h('summary', {}, 'E-mail text preview'), h('pre', { class: 'mono small' }, text)));
    }
  };
  render();
  for (;;) {
    const r = await modal({ title: 'Review & Send Feedback', body, buttons: step === 1 ? ['Next: Send', 'Close'] : ['Back', 'Close'], width: 860, marking: app.markingSuffix(), id: 'wb-review' });
    await app.feedbackSession?.save(wb);
    if (r === 'Next: Send' && wb.pages.length) step = 2;
    else if (r === 'Back') step = 1;
    else break;
    render();
  }
  app.emit('state');
}

/** Import a feedback JSON or HTML report and merge its pages (REQ-WB-11). */
export async function importFeedback(app, wb) {
  const [f] = await pickFiles(app, { multiple: false, accept: ['.json', '.html', '.htm'], description: 'Feedback' });
  if (!f) return;
  if (f.size > 256 << 20) return app.toast('Feedback file is larger than 256 MB', { kind: 'warn' });
  try {
    const text = await f.text();
    const json = /\.html?$/i.test(f.name) || text.trimStart().startsWith('<') ? extractJsonFromHtml(text) : text;
    const doc = fromJson(json);
    const m = merge(wb.pages, doc.pages);
    wb.pages = m.pages;
    await app.feedbackSession?.save(wb);
    app.toast(`Imported ${m.added} page(s) from ${f.name}${m.skipped ? ` (${m.skipped} already present)` : ''}`);
    app.emit('state');
  } catch (e) {
    app.toast(`${f.name}: ${e.message}`, { kind: 'error' });
  }
}
