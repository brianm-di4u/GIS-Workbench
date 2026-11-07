// Observations (REQ-EXT-20): structured observations linked to graphics, chips and features, an
// observation table to edit them, and an activity report (HTML, DOCX, CSV) in time order with
// positions, links and chip thumbnails.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { docxFromHtml, DOCX_TYPE } from '../products/docx.js';
import { isoUtc } from '../products/tokens.js';
import { t, N_, msgOf, locale, dirOf, PSEUDO } from '../i18n/index.js';
import { int } from '../i18n/format.js';

export const name = 'observations';

// Stored values are these English keys (project data, CSV, AI tools); the UI and the report show them translated.
export const CATEGORIES = [N_('vehicle activity'), N_('construction'), N_('personnel'), N_('infrastructure'), N_('maritime'), N_('aircraft'), N_('environmental'), N_('other')];
const CONF = [N_('low'), N_('moderate'), N_('high')];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A category or confidence for display: the known keys translated, anything else as it is. */
const label = (v) => (CATEGORIES.includes(v) || CONF.includes(v) ? t(v) : v);
/** The report's lang tag: the UI locale (a pseudo-locale reports as its base language, as the document does). */
const langTag = () => (PSEUDO[locale()] ? (dirOf(locale()) === 'rtl' ? 'ar' : 'en') : locale());

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(msgOf(e), { kind: 'error', ms: 8000 });
    }
  };
  /** Links of an observation, as a short phrase per kind. */
  const linkParts = (o) => [o.graphics?.length ? t('{n, plural, one {# graphic} other {# graphics}}', { n: o.graphics.length }) : '', o.chips?.length ? t('{n, plural, one {chip {list}} other {chips {list}}}', { n: o.chips.length, list: o.chips.join(', ') }) : '', o.features?.length ? t('{n, plural, one {# feature} other {# features}}', { n: o.features.length }) : ''].filter(Boolean);

  /** Ground centroid of a linked record (graphic, feature or chip). */
  function positionOf(rec) {
    if (!rec) return null;
    if (rec.type === 'graphic' && rec.anchor === 'ground' && rec.coords?.length) {
      const n = rec.coords.length;
      return [rec.coords.reduce((s, c) => s + c[1], 0) / n, rec.coords.reduce((s, c) => s + c[0], 0) / n];
    }
    if (rec.type === 'feature' && rec.geom?.xyz?.length) {
      const v = rec.geom.xyz;
      const n = v.length / 3;
      let la = 0;
      let lo = 0;
      for (let i = 0; i < n; i++) [lo, la] = [lo + v[3 * i], la + v[3 * i + 1]];
      return [la / n, lo / n];
    }
    if (rec.type === 'chip' && Number.isFinite(rec.centre?.lat)) return [rec.centre.lat, rec.centre.lon];
    return null;
  }

  /**
   * Create an observation. o: {text, category, confidence, graphics [ids], chips
   * [numbers], features [ids], time (ISO), lat, lon}. Links default to the current selection.
   */
  function add(o = {}) {
    const sel = [...(app.selection ?? [])].map((id) => S.get(id)).filter(Boolean);
    const graphics = o.graphics ?? sel.filter((r) => r.type === 'graphic').map((r) => r.id);
    const features = o.features ?? sel.filter((r) => r.type === 'feature').map((r) => r.id);
    const chips = o.chips ?? [];
    const l = app.activeLayer();
    let pos = Number.isFinite(o.lat) ? [o.lat, o.lon] : null;
    for (const id of [...graphics, ...features]) pos ??= positionOf(S.get(id));
    for (const n of chips) pos ??= positionOf(S.all('chip').find((c) => c.number === n));
    if (!pos) {
      const p = app.activePane();
      const g = p?.geoLayer?.()?.groundAt?.(p.view.cx, p.view.cy);
      if (g) pos = [g.lat, g.lon];
    }
    let id;
    S.transact(t('Add observation'), (tx) => {
      id = tx.create('observation', { text: o.text ?? '', category: o.category ?? 'other', confidence: o.confidence ?? 'moderate', graphics, features, chips, chip: chips[0] ?? null, image: l?.info.iid ?? l?.rec?.name ?? null, layer: l?.id ?? null, time: o.time ?? l?.info?.datetimeIso ?? null, lat: pos?.[0] ?? null, lon: pos?.[1] ?? null, analyst: app.prefs.get('analyst') ?? '', created: new Date().toISOString(), label: o.label ?? null });
    });
    redraw();
    return S.get(id);
  }

  function update(id, fields) {
    S.transact(t('Edit observation'), (tx) => {
      for (const [k, v] of Object.entries(fields)) tx.set(id, k, v);
    });
    redraw();
  }

  async function toolbox() {
    const text = h('textarea', { rows: 4, 'data-id': 'obs-text', placeholder: t('What you see, where and when') });
    const cat = h('select', { 'data-id': 'obs-category' }, ...CATEGORIES.map((c) => h('option', { value: c }, label(c))));
    const conf = h('select', { 'data-id': 'obs-confidence' }, ...CONF.map((c) => h('option', { value: c, selected: c === 'moderate' }, label(c))));
    const chipSel = h('select', { multiple: true, 'data-id': 'obs-chips', size: 4 }, ...S.all('chip').map((c) => h('option', { value: String(c.number) }, t('Chip {n} {caption}', { n: c.number, caption: c.caption ?? '' }).slice(0, 60))));
    const sel = [...(app.selection ?? [])].map((x) => S.get(x)).filter(Boolean);
    const hint = t('Links: {g, plural, one {# selected graphic} other {# selected graphics}}, {f, plural, one {# feature} other {# features}}.', { g: sel.filter((r) => r.type === 'graphic').length, f: sel.filter((r) => r.type === 'feature').length });
    const b = await modal({ title: t('Observation Toolbox'), body: h('div', {}, field(t('Observation'), text), field(t('Category'), cat), field(t('Confidence'), conf), field(t('Chips'), chipSel), h('p', { class: 'hint' }, hint)), buttons: [{ label: t('Add'), value: 'add', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'obs-toolbox' });
    if (b !== 'add') return null;
    return add({ text: text.value, category: cat.value, confidence: conf.value, chips: [...chipSel.selectedOptions].map((o) => Number(o.value)) });
  }

  // ---- table dock ----
  let dockEl = null;
  function redraw() {
    if (!dockEl?.isConnected) return;
    const obs = S.all('observation');
    const cell = (o, k, opts) => {
      if (opts) {
        const s = h('select', { 'data-id': `obs-${k}:${o.id}`, 'aria-label': k === 'category' ? t('Category') : t('Confidence') }, ...opts.map((v) => h('option', { value: v, selected: v === o[k] }, label(v))));
        s.addEventListener('change', () => update(o.id, { [k]: s.value }));
        return h('td', {}, s);
      }
      const td = h('td', { contenteditable: 'true', 'data-id': `obs-${k}:${o.id}` }, o[k] ?? '');
      td.addEventListener('blur', () => td.textContent !== (o[k] ?? '') && update(o.id, { [k]: td.textContent }));
      return td;
    };
    const links = (o) => linkParts(o).join(' · ') || '–';
    dockEl.replaceChildren(
      h('div', { class: 'btn-row' }, ...[[t('New observation…'), () => toolbox()], [t('Activity report…'), () => reportDialog()]].map(([text, fn]) => {
        const b = h('button', { class: 'btn', type: 'button' }, text);
        b.addEventListener('click', run(fn));
        return b;
      })),
      h('table', { class: 'tbl obs-table', 'data-id': 'obs-table' }, h('thead', {}, h('tr', {}, ...['#', t('Time (UTC)'), t('Category'), t('Observation'), t('Confidence'), t('Links')].map((x) => h('th', {}, x)))), h('tbody', {}, ...obs.map((o, i) => h('tr', { 'data-obs': o.id }, h('td', {}, String(i + 1)), h('td', {}, (o.time ?? o.created ?? '').replace('T', ' ').slice(0, 19)), cell(o, 'category', CATEGORIES), cell(o, 'text'), cell(o, 'confidence', CONF), h('td', {}, links(o)))))),
    );
  }
  app.on('ready', (mp) => mp.docks.register({ id: 'observations', title: t('Observation Table'), icon: 'table', home: 'bottom', create: (a, m, el) => ((dockEl = el), redraw(), { onShow: redraw }) }));
  S.on('commit', () => redraw());

  // ---- activity report ----
  function activityHtml({ title = t('Activity report'), from = null, to = null } = {}) {
    const obs = S.all('observation')
      .filter((o) => (!from || (o.time ?? o.created) >= from) && (!to || (o.time ?? o.created) <= to))
      .sort((a, b) => String(a.time ?? a.created).localeCompare(String(b.time ?? b.created)));
    const byCat = {};
    for (const o of obs) byCat[o.category ?? 'other'] = (byCat[o.category ?? 'other'] ?? 0) + 1;
    const mgrs = (o) => {
      try {
        return Number.isFinite(o.lat) ? app.core.mgrs(o.lat, o.lon, 5) : '–';
      } catch {
        return '–';
      }
    };
    const chipImg = (n) => app.chipImages?.get?.(n);
    const rows = obs
      .map((o, i) => {
        return `<tr><td>${i + 1}</td><td>${esc((o.time ?? o.created ?? '').replace('T', ' ').slice(0, 19))}Z</td><td>${esc(label(o.category))}</td><td>${esc(o.text)}</td><td>${esc(label(o.confidence))}</td><td>${esc(mgrs(o))}</td><td>${esc(linkParts(o).join('; ') || '–')}</td></tr>`;
      })
      .join('');
    const chips = [...new Set(obs.flatMap((o) => o.chips ?? []))].filter((n) => chipImg(n));
    const figs = chips
      .map((n) => {
        const at = obs.map((o, i) => ((o.chips ?? []).includes(n) ? i + 1 : null)).filter(Boolean);
        return `<figure><img src="${esc(chipImg(n))}" alt="${esc(t('Chip {n}', { n }))}"><figcaption>${esc(t('Chip {n} — {k, plural, one {observation} other {observations}} {list}', { n, k: at.length, list: at.join(', ') }))}</figcaption></figure>`;
      })
      .join('');
    const analyst = app.prefs.get('analyst');
    const span = { n: obs.length, from: (obs[0]?.time ?? obs[0]?.created ?? '–').slice(0, 19), to: (obs.at(-1)?.time ?? obs.at(-1)?.created ?? '–').slice(0, 19), when: isoUtc(new Date()), analyst };
    const intro = analyst ? t('{n, plural, one {# observation} other {# observations}} from {from} to {to} (UTC). Produced {when} by {analyst}.', span) : t('{n, plural, one {# observation} other {# observations}} from {from} to {to} (UTC). Produced {when} by the analyst.', span);
    return `<!doctype html><html lang="${esc(langTag())}" dir="${dirOf(locale())}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body { font: 10.5pt/1.4 Arial, sans-serif; margin: 0; }
main { padding: 4mm; } table { border-collapse: collapse; width: 100%; font-size: 9pt; } th, td { border: 1px solid #999; padding: 1mm 1.5mm; vertical-align: top; } th { background: #eee; } figure { display: inline-block; margin: 1mm; } figure img { max-width: 240px; }
</style></head><body><main>
<h1>${esc(title)}</h1>
<p>${esc(intro)}</p>
<h2>${esc(t('Summary by category'))}</h2><table><thead><tr><th>${esc(t('Category'))}</th><th>${esc(t('Observations'))}</th></tr></thead><tbody>${Object.entries(byCat).map(([k, v]) => `<tr><td>${esc(label(k))}</td><td>${esc(int(v))}</td></tr>`).join('')}</tbody></table>
<h2>${esc(t('Activity'))}</h2><table><thead><tr><th>#</th><th>${esc(t('Time (UTC)'))}</th><th>${esc(t('Category'))}</th><th>${esc(t('Observation'))}</th><th>${esc(t('Confidence'))}</th><th>MGRS</th><th>${esc(t('Links'))}</th></tr></thead><tbody>${rows}</tbody></table>
${figs ? `<h2>${esc(t('Linked chips'))}</h2>${figs}` : ''}
</main></body></html>`;
  }

  function activityCsv() {
    const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    return ['time_utc,category,confidence,text,lat,lon,graphics,chips,features,image', ...S.all('observation').map((o) => [o.time ?? o.created, o.category, o.confidence, o.text, o.lat, o.lon, (o.graphics ?? []).length, (o.chips ?? []).join(' '), (o.features ?? []).length, o.image].map(q).join(','))].join('\n') + '\n';
  }

  async function reportDialog() {
    const title = h('input', { type: 'text', value: t('Activity report'), spellcheck: 'true', 'data-id': 'act-title' });
    const buttons = [{ label: t('Save HTML…'), value: 'html', primary: true }, { label: t('Save DOCX…'), value: 'docx' }, { label: t('Save CSV…'), value: 'csv' }, { label: t('Cancel'), value: 'cancel' }];
    const b = await modal({ title: t('Activity Report'), body: h('div', {}, field(t('Title'), title), h('p', { class: 'hint' }, t('{n, plural, one {# observation} other {# observations}}, in time order.', { n: S.all('observation').length }))), buttons, id: 'activity-report' });
    if (b !== 'html' && b !== 'docx' && b !== 'csv') return;
    const html = activityHtml({ title: title.value });
    if (b === 'html') await saveBlob(app, new Blob([html], { type: 'text/html' }), { name: 'activity-report.html' });
    if (b === 'docx') await saveBlob(app, new Blob([docxFromHtml(html, { title: title.value })], { type: DOCX_TYPE }), { name: 'activity-report.docx' });
    if (b === 'csv') await saveBlob(app, new Blob([activityCsv()], { type: 'text/csv' }), { name: 'activity-report.csv' });
  }

  C.implement('obs.toolbox', { run: run(() => toolbox()) });
  C.implement('obs.table', { run: run(() => app.activeMp().docks.show('observations')) });
  app.observations = { add, update, toolbox, activityHtml, activityCsv, activityDocx: (o) => docxFromHtml(activityHtml(o), { title: o?.title ?? t('Activity report') }), positionOf, CATEGORIES };
}
