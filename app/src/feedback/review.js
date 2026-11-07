// Review window (REQ-WB-08) in two steps — review pages (edit notes, reorder, delete, copy)
// and send — plus every export (REQ-WB-09): PNG per page, self-contained HTML report,
// versioned JSON, plain-text e-mail body, clipboard image, Web Share and mail drafts.
// Nothing leaves the browser unless the user clicks a send action. Import (REQ-WB-11).

import { h, clear } from '../shell/dom.js';
import { modal } from '../shell/dialogs.js';
import { saveBlob, textBlob, pickFiles } from '../storage/files.js';
import { toJson, fromJson, extractJsonFromHtml, merge, emailBody, PAGE_TYPES, TRIAGE_STATUS, TRIAGE_PRIORITY, filterPages, pageToObservation } from './model.js';
import { FEEDBACK_EMAIL } from './contact.js';
import { t, tc, tr, msgOf } from '../i18n/index.js';
import { htmlLangAttrs } from '../products/lang.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function session(app, wb) {
  return { project: app.project()?.name ?? t('Untitled'), build: app.build.id, pages: wb.pages };
}

/** Self-contained HTML report in the UI language: images inline plus a JSON data block for re-import. */
export function reportHtml(s) {
  const json = JSON.stringify(toJson(s)).replace(/</g, '\\u003c');
  const pages = s.pages
    .map((p, i) => {
      const c = p.context ?? {};
      const pins = p.pins.map((pin) => `<li><b>${esc(t('Pin {n}', { n: pin.n }))}</b>${pin.target ? ` → ${esc(pin.target.label)}` : ''}: ${esc(pin.note)}</li>`).join('');
      return `<section class="page"><h2>${i + 1}. <span class="type">${esc(tr(p.type))}</span> ${esc(p.summary || t('(no summary)'))}</h2>
${p.image ? `<img alt="${esc(t('Page {n} screenshot', { n: i + 1 }))}" src="${p.image}">` : `<p><i>${esc(t('No image'))}</i></p>`}
${p.notes ? `<p>${esc(p.notes)}</p>` : ''}${pins ? `<ul>${pins}</ul>` : ''}
<table><tr><th>${esc(t('Image'))}</th><td>${esc(c.image)}</td><th>${esc(t('Centre'))}</th><td>${esc(c.centre?.mgrs)} ${c.centre ? `(${c.centre.lat}, ${c.centre.lon})` : ''}</td></tr>
<tr><th>${esc(t('Zoom / rotation'))}</th><td>${esc(c.zoom)} / ${esc(c.rotation)}° ${esc(c.orientation)}</td><th>${esc(t('Sensor model'))}</th><td>${esc(c.model)}</td></tr>
<tr><th>${esc(t('Image chain'))}</th><td colspan="3">${esc(c.chain)}</td></tr>
<tr><th>${esc(t('Reporter'))}</th><td>${esc(p.reporter)}</td><th>${esc(t('Captured'))}</th><td>${esc(p.created)} (${esc(tr(p.capture))})</td></tr>
<tr><th>${esc(t('Build'))}</th><td>${esc(c.version)} ${esc(c.build)}</td><th>${esc(t('Run mode / theme'))}</th><td>${esc(c.runMode)} / ${esc(c.theme)}</td></tr></table></section>`;
    })
    .join('\n');
  return `<!DOCTYPE html><html${htmlLangAttrs()}><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(t('GIS Workbench feedback — {project}', { project: s.project }))}</title>
<style>body{font:13px Segoe UI,system-ui,sans-serif;margin:0;background:#f4f4f4;color:#111}main{max-width:1200px;margin:0 auto;padding:12px}.page{background:#fff;border:1px solid #ccc;margin:14px 0;padding:10px}.page img{max-width:100%;border:1px solid #999}.type{background:#444;color:#fff;padding:1px 6px;border-radius:3px;font-size:11px;text-transform:uppercase}table{border-collapse:collapse;width:100%;margin-top:6px}th,td{border:1px solid #ddd;padding:2px 6px;text-align:left;vertical-align:top}th{background:#eee;width:120px}</style>
</head><body><main><h1>${esc(t('GIS Workbench feedback'))}</h1>
<p>${esc(t('Project {project} · build {build} · {n, plural, one {# page} other {# pages}} · exported {time}', { project: s.project, build: s.build, n: s.pages.length, time: new Date().toISOString() }))}</p>
${pages}
<p><small>${esc(t('Re-import this report in GIS Workbench with Add-Ins ▸ Import Feedback.'))}</small></p></main>
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
  app.store.transact(t('Observation from feedback page'), (tx) => (id = tx.create('observation', o)));
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
  app.store.transact(t('Annotation from feedback page'), (tx) => {
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
      body.appendChild(h('p', {}, t('No pages yet. Open the whiteboard (B), mark up the application and press Capture page.')));
      return;
    }
    body.appendChild(h('div', { class: 'wb-steps' }, h('span', { class: step === 1 ? 'on' : '' }, t('1. Review pages')), ' › ', h('span', { class: step === 2 ? 'on' : '' }, t('2. Send'))));
    if (step === 1) {
      // Triage filter (REQ-WB-12). Option values stay the English data values; labels are translated.
      const fs = h('select', { class: 'inp inp-short', 'aria-label': t('Filter by status') }, h('option', { value: '' }, t('any status')), ...TRIAGE_STATUS.map((v) => h('option', { value: v }, tr(v))));
      const fp = h('select', { class: 'inp inp-short', 'aria-label': t('Filter by priority') }, h('option', { value: '' }, t('any priority')), ...TRIAGE_PRIORITY.filter(Boolean).map((v) => h('option', { value: v }, tr(v))));
      const fa = h('input', { class: 'inp inp-short', placeholder: t('assignee'), 'aria-label': t('Filter by assignee') });
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
      body.appendChild(h('div', { class: 'wb-filter btn-row', 'data-id': 'wb:filter' }, h('span', {}, t('Show:')), fs, fp, fa, h('span', { class: 'hint' }, t('{shown} of {n, plural, one {# page} other {# pages}}', { shown: shown.length, n: wb.pages.length }))));
      wb.pages.forEach((p, i) => {
        if (!shown.includes(p)) return;
        const n = i + 1;
        p.triage = { status: 'new', priority: '', assignee: '', ...(p.triage ?? {}) };
        const ts = h('select', { class: 'inp inp-short', 'aria-label': t('Status of page {n}', { n }) }, ...TRIAGE_STATUS.map((v) => h('option', { value: v }, tr(v))));
        ts.value = p.triage.status;
        ts.addEventListener('change', () => (p.triage.status = ts.value));
        const tp = h('select', { class: 'inp inp-short', 'aria-label': t('Priority of page {n}', { n }) }, ...TRIAGE_PRIORITY.map((v) => h('option', { value: v }, v ? tr(v) : t('no priority'))));
        tp.value = p.triage.priority;
        tp.addEventListener('change', () => (p.triage.priority = tp.value));
        const ta = h('input', { class: 'inp inp-short', value: p.triage.assignee, placeholder: t('assignee'), 'aria-label': t('Assignee of page {n}', { n }) });
        ta.addEventListener('input', () => (p.triage.assignee = ta.value));
        const triage = h('div', { class: 'wb-row wb-triage' }, h('span', { class: 'hint' }, t('Triage:')), ts, tp, ta);
        const type = h('select', { class: 'inp inp-short', 'aria-label': t('Type of page {n}', { n }) }, PAGE_TYPES.map((v) => h('option', { value: v }, tr(v))));
        type.value = p.type;
        type.addEventListener('change', () => (p.type = type.value));
        const sum = h('input', { class: 'inp', value: p.summary, placeholder: t('Summary'), spellcheck: 'true', 'aria-label': t('Summary of page {n}', { n }) });
        sum.addEventListener('input', () => (p.summary = sum.value));
        const notes = h('textarea', { class: 'inp', rows: '2', placeholder: t('General notes'), spellcheck: 'true', 'aria-label': t('Notes for page {n}', { n }) }, p.notes);
        notes.addEventListener('input', () => (p.notes = notes.value));
        const pins = p.pins.map((pin) => {
          const pn = h('input', { class: 'inp', value: pin.note, placeholder: t('Note for pin {n}', { n: pin.n }), spellcheck: 'true' });
          pn.addEventListener('input', () => (pin.note = pn.value));
          const jump = h('button', { class: 'btn btn-small', disabled: !pin.target }, pin.target ? (wb.targetExists(pin.target) ? t('Go to {target}', { target: pin.target.label }) : t('{target} (gone)', { target: pin.target.label })) : t('no linked item'));
          jump.addEventListener('click', () => wb.jumpTo(pin.target));
          return h('div', { class: 'wb-pin' }, h('b', {}, t('Pin {n}', { n: pin.n })), pn, jump);
        });
        const tools = h('div', { class: 'btn-row' });
        for (const [label, fn] of [
          [t('Up'), () => i > 0 && ([wb.pages[i - 1], wb.pages[i]] = [wb.pages[i], wb.pages[i - 1]])],
          [t('Down'), () => i < wb.pages.length - 1 && ([wb.pages[i + 1], wb.pages[i]] = [wb.pages[i], wb.pages[i + 1]])],
          [tc('verb', 'Copy'), () => wb.pages.splice(i + 1, 0, { ...structuredClone(p), id: `${p.id}c${Date.now().toString(36)}` })],
          [t('Delete'), () => wb.pages.splice(i, 1)],
          [t('Make Observation'), () => {
            pageToObservationRecord(app, p);
            app.toast(t('Page {n} is now an observation (undo reverts it)', { n }), { kind: 'info' });
          }],
          [t('Make Annotation'), () => {
            try {
              pageToAnnotation(app, p);
              app.toast(t('Page {n} is now an annotation on the image', { n }), { kind: 'info' });
            } catch (e) {
              app.toast(msgOf(e), { kind: 'warn' });
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
        body.appendChild(h('div', { class: 'wb-page', 'data-id': `wb:page:${p.id}` }, h('img', { class: 'wb-thumb', src: p.image ?? '', alt: t('Page {n}', { n }) }), h('div', { class: 'wb-page-fields' }, h('div', { class: 'wb-row' }, h('b', {}, `${n}.`), type, sum), triage, notes, ...pins, tools, h('small', { class: 'hint' }, `${p.context?.image ?? t('no image')} · ${p.context?.centre?.mgrs ?? ''} · ${tr(p.capture) ?? ''}`))));
      });
    } else {
      const s = session(app, wb);
      const recipient = app.project()?.feedbackRecipient || FEEDBACK_EMAIL;
      const subject = t('GIS Workbench feedback — {project} ({n, plural, one {# page} other {# pages}})', { project: s.project, n: wb.pages.length });
      const text = emailBody(s);
      // [id (data-id, English), label, description, action]
      const actions = [
        ['HTML report', t('HTML report'), t('Self-contained report with images and a JSON block'), async () => saveBlob(app, textBlob(reportHtml(s), 'text/html'), { name: 'gisworkbench-feedback.html', types: ['.html'], description: t('HTML report') })],
        ['JSON', 'JSON', t('kind "gisworkbench-feedback", version 1'), async () => saveBlob(app, textBlob(JSON.stringify(toJson(s), null, 1), 'application/json'), { name: 'gisworkbench-feedback.json', types: ['.json'], description: 'JSON' })],
        ['PNG per page', t('PNG per page'), t('One PNG file per page'), async () => {
          for (let i = 0; i < wb.pages.length; i++) if (wb.pages[i].image) await saveBlob(app, dataUrlToBlob(wb.pages[i].image), { name: `feedback-page-${i + 1}.png`, preferPicker: false });
        }],
        ['Copy image', t('Copy image'), t('Current first page to the clipboard'), async () => {
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': dataUrlToBlob(wb.pages[0].image) })]);
            app.toast(t('Page 1 image copied'), { kind: 'info' });
          } catch {
            app.toast(t('The clipboard is blocked here; use PNG per page'), { kind: 'warn' });
          }
        }],
        ['Copy e-mail text', t('Copy e-mail text'), t('Plain-text body for any mail client'), async () => {
          try {
            await navigator.clipboard.writeText(text);
            app.toast(t('E-mail text copied'), { kind: 'info' });
          } catch {
            app.toast(t('The clipboard is blocked here'), { kind: 'warn' });
          }
        }],
      ];
      const sendActions = [
        [t('Share…'), t('Web Share (where the browser offers it)'), async () => {
          const file = new File([reportHtml(s)], 'gisworkbench-feedback.html', { type: 'text/html' });
          if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: subject, text, files: [file] });
          else app.toast(t('Web Share is not available here'), { kind: 'warn' });
        }],
        [t('Mail draft'), t('Opens your mail client (mailto:) with the text; attach the HTML report'), () => window.open(`mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`, '_blank', 'noopener')],
        [t('Gmail draft'), t('Opens a Gmail compose window in a new tab'), () => window.open(`https://mail.google.com/mail/?view=cm&to=${encodeURIComponent(recipient)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`, '_blank', 'noopener')],
        [t('Outlook draft'), t('Opens an Outlook web compose window in a new tab'), () => window.open(`https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(recipient)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`, '_blank', 'noopener')],
      ];
      body.appendChild(h('p', { class: 'hint' }, t('Nothing is sent until you click a send action.')));
      body.appendChild(h('h4', {}, tc('noun', 'Export')));
      for (const [id, l, d, fn] of actions) {
        const b = h('button', { class: 'btn', title: d, 'data-id': `wb:export:${id}` }, l);
        b.addEventListener('click', fn);
        body.appendChild(h('div', { class: 'wb-action' }, b, h('span', { class: 'hint' }, d)));
      }
      body.appendChild(h('h4', {}, tc('noun', 'Send')));
      for (const [l, d, fn] of sendActions) {
        const b = h('button', { class: 'btn', title: d }, l);
        b.addEventListener('click', fn);
        body.appendChild(h('div', { class: 'wb-action' }, b, h('span', { class: 'hint' }, d)));
      }
      body.appendChild(h('details', {}, h('summary', {}, t('E-mail text preview')), h('pre', { class: 'mono small' }, text)));
    }
  };
  render();
  for (;;) {
    const buttons = step === 1 ? [{ label: t('Next: Send'), value: 'next', primary: true }, { label: t('Close'), value: 'close' }] : [{ label: t('Back'), value: 'back', primary: true }, { label: t('Close'), value: 'close' }];
    const r = await modal({ title: t('Review & Send Feedback'), body, buttons, width: 860, id: 'wb-review' });
    await app.feedbackSession?.save(wb);
    if (r === 'next' && wb.pages.length) step = 2;
    else if (r === 'back') step = 1;
    else break;
    render();
  }
  app.emit('state');
}

/** Import a feedback JSON or HTML report and merge its pages (REQ-WB-11). */
export async function importFeedback(app, wb) {
  const [f] = await pickFiles(app, { multiple: false, accept: ['.json', '.html', '.htm'], description: t('Feedback') });
  if (!f) return;
  if (f.size > 256 << 20) return app.toast(t('Feedback file is larger than 256 MB'), { kind: 'warn' });
  try {
    const text = await f.text();
    const json = /\.html?$/i.test(f.name) || text.trimStart().startsWith('<') ? extractJsonFromHtml(text) : text;
    const doc = fromJson(json);
    const m = merge(wb.pages, doc.pages);
    wb.pages = m.pages;
    await app.feedbackSession?.save(wb);
    app.toast(
      m.skipped
        ? t('Imported {n, plural, one {# page} other {# pages}} from {file} ({skipped} already present)', { n: m.added, file: f.name, skipped: m.skipped })
        : t('Imported {n, plural, one {# page} other {# pages}} from {file}', { n: m.added, file: f.name }),
      { kind: 'info' },
    );
    app.emit('state');
  } catch (e) {
    app.toast(t('{file}: {msg}', { file: f.name, msg: msgOf(e) }), { kind: 'error' });
  }
}
