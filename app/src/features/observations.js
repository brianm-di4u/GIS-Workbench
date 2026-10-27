// Observations (REQ-EXT-20): structured observations linked to graphics, chips and features, an
// observation table to edit them, and an activity report (HTML, DOCX, CSV) in time order with
// positions, links and chip thumbnails. The banner rolls up the portion marks like the report.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { bannerText, highest, portionMark } from '../security/marking.js';
import { parsePortion, splitPortion } from '../products/report.js';
import { docxFromHtml, DOCX_TYPE } from '../products/docx.js';
import { isoUtc } from '../products/tokens.js';

export const name = 'observations';

export const CATEGORIES = ['vehicle activity', 'construction', 'military equipment', 'personnel', 'infrastructure', 'maritime', 'aircraft', 'environmental', 'other'];
const CONF = ['low', 'moderate', 'high'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };

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
   * Create an observation. o: {text, category, confidence, portion, graphics [ids], chips
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
    S.transact('Add observation', (tx) => {
      id = tx.create('observation', { text: o.text ?? '', category: o.category ?? 'other', confidence: o.confidence ?? 'moderate', portion: o.portion ?? null, graphics, features, chips, chip: chips[0] ?? null, image: l?.info.iid ?? l?.rec?.name ?? null, layer: l?.id ?? null, time: o.time ?? l?.info?.datetimeIso ?? null, lat: pos?.[0] ?? null, lon: pos?.[1] ?? null, analyst: app.prefs.get('analyst') ?? '', created: new Date().toISOString(), label: o.label ?? null });
    });
    redraw();
    return S.get(id);
  }

  function update(id, fields) {
    S.transact('Edit observation', (tx) => {
      for (const [k, v] of Object.entries(fields)) tx.set(id, k, v);
    });
    redraw();
  }

  async function toolbox() {
    const text = h('textarea', { rows: 4, 'data-id': 'obs-text', placeholder: '(U) What you see, where and when' });
    const cat = h('select', { 'data-id': 'obs-category' }, ...CATEGORIES.map((c) => h('option', { value: c }, c)));
    const conf = h('select', { 'data-id': 'obs-confidence' }, ...CONF.map((c) => h('option', { value: c, selected: c === 'moderate' }, c)));
    const chipSel = h('select', { multiple: true, 'data-id': 'obs-chips', size: 4 }, ...S.all('chip').map((c) => h('option', { value: String(c.number) }, `Chip ${c.number} ${c.caption ?? ''}`.slice(0, 60))));
    const sel = [...(app.selection ?? [])].map((x) => S.get(x)).filter(Boolean);
    const b = await modal({ title: 'Observation Toolbox', body: h('div', {}, field('Observation', text), field('Category', cat), field('Confidence', conf), field('Chips', chipSel), h('p', { class: 'hint' }, `Links: ${sel.filter((r) => r.type === 'graphic').length} selected graphic(s), ${sel.filter((r) => r.type === 'feature').length} feature(s). Start the text with a portion mark such as (U).`)), buttons: ['Add', 'Cancel'], id: 'obs-toolbox' });
    if (b !== 'Add') return null;
    return add({ text: text.value, category: cat.value, confidence: conf.value, chips: [...chipSel.selectedOptions].map((o) => Number(o.value)) });
  }

  // ---- table dock ----
  let dockEl = null;
  function redraw() {
    if (!dockEl?.isConnected) return;
    const obs = S.all('observation');
    const cell = (o, k, opts) => {
      if (opts) {
        const s = h('select', { 'data-id': `obs-${k}:${o.id}` }, ...opts.map((v) => h('option', { value: v, selected: v === o[k] }, v)));
        s.addEventListener('change', () => update(o.id, { [k]: s.value }));
        return h('td', {}, s);
      }
      const td = h('td', { contenteditable: 'true', 'data-id': `obs-${k}:${o.id}` }, o[k] ?? '');
      td.addEventListener('blur', () => td.textContent !== (o[k] ?? '') && update(o.id, { [k]: td.textContent }));
      return td;
    };
    const links = (o) => [o.graphics?.length ? `${o.graphics.length} graphic(s)` : '', o.chips?.length ? `chip ${o.chips.join(', ')}` : '', o.features?.length ? `${o.features.length} feature(s)` : ''].filter(Boolean).join(' · ') || '–';
    dockEl.replaceChildren(
      h('div', { class: 'btn-row' }, (() => {
        const b = h('button', { class: 'btn', type: 'button' }, 'Activity report…');
        b.addEventListener('click', run(() => reportDialog()));
        return b;
      })()),
      h('table', { class: 'tbl obs-table', 'data-id': 'obs-table' }, h('thead', {}, h('tr', {}, ...['#', 'Time (UTC)', 'Category', 'Observation', 'Confidence', 'Links'].map((t) => h('th', {}, t)))), h('tbody', {}, ...obs.map((o, i) => h('tr', { 'data-obs': o.id }, h('td', {}, String(i + 1)), h('td', {}, (o.time ?? o.created ?? '').replace('T', ' ').slice(0, 19)), cell(o, 'category', CATEGORIES), cell(o, 'text'), cell(o, 'confidence', CONF), h('td', {}, links(o)))))),
    );
  }
  app.on('ready', (mp) => mp.docks.register({ id: 'observations', title: 'Observation Table', icon: 'table', home: 'bottom', create: (a, m, el) => ((dockEl = el), redraw(), { onShow: redraw }) }));
  S.on('commit', () => redraw());

  // ---- activity report ----
  function activityHtml({ title = 'Activity report', from = null, to = null } = {}) {
    const obs = S.all('observation')
      .filter((o) => (!from || (o.time ?? o.created) >= from) && (!to || (o.time ?? o.created) <= to))
      .sort((a, b) => String(a.time ?? a.created).localeCompare(String(b.time ?? b.created)));
    const marks = obs.map((o) => parsePortion(o.portion ?? splitPortion(o.text).mark));
    if (app.project?.()?.marking) marks.push(app.project().marking);
    const m = highest(marks.filter(Boolean));
    const banner = bannerText(m);
    const colour = { U: '#007a33', R: '#5c2d91', C: '#0033a0', S: '#c8102e', T: '#ff8c00' }[m.level ?? 'U'];
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
        const s = splitPortion(o.text);
        const mark = o.portion ? portionMark(parsePortion(o.portion)) : s.mark ?? '(U)';
        return `<tr><td>${i + 1}</td><td>${esc((o.time ?? o.created ?? '').replace('T', ' ').slice(0, 19))}Z</td><td>${esc(o.category)}</td><td>${esc(mark)} ${esc(s.text)}</td><td>${esc(o.confidence)}</td><td>${esc(mgrs(o))}</td><td>${esc([o.graphics?.length ? `${o.graphics.length} graphic(s)` : '', o.chips?.length ? `chip ${o.chips.join(', ')}` : '', o.features?.length ? `${o.features.length} feature(s)` : ''].filter(Boolean).join('; ') || '–')}</td></tr>`;
      })
      .join('');
    const chips = [...new Set(obs.flatMap((o) => o.chips ?? []))].filter((n) => chipImg(n));
    const figs = chips.map((n) => `<figure><img src="${esc(chipImg(n))}" alt="Chip ${n}"><figcaption>(U) Chip ${n} — observation(s) ${obs.map((o, i) => ((o.chips ?? []).includes(n) ? i + 1 : null)).filter(Boolean).join(', ')}</figcaption></figure>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(banner)} — ${esc(title)}</title><style>
body { font: 10.5pt/1.4 Arial, sans-serif; margin: 0; } .banner { background: ${colour}; color: #fff; font-weight: bold; text-align: center; padding: 2mm 0; }
main { padding: 4mm; } table { border-collapse: collapse; width: 100%; font-size: 9pt; } th, td { border: 1px solid #999; padding: 1mm 1.5mm; vertical-align: top; } th { background: #eee; } figure { display: inline-block; margin: 1mm; } figure img { max-width: 240px; }
</style></head><body><div class="banner top">${esc(banner)}</div><main>
<h1>(U) ${esc(title)}</h1>
<p>(U) ${obs.length} observation(s) from ${esc((obs[0]?.time ?? obs[0]?.created ?? '–').slice(0, 19))} to ${esc((obs.at(-1)?.time ?? obs.at(-1)?.created ?? '–').slice(0, 19))} (UTC). Produced ${esc(isoUtc(new Date()))} by ${esc(app.prefs.get('analyst') || 'the analyst')}.</p>
<h2>Summary by category</h2><table><thead><tr><th>Category</th><th>Observations</th></tr></thead><tbody>${Object.entries(byCat).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table>
<h2>Activity</h2><table><thead><tr><th>#</th><th>Time (UTC)</th><th>Category</th><th>Observation</th><th>Confidence</th><th>MGRS</th><th>Links</th></tr></thead><tbody>${rows}</tbody></table>
${figs ? `<h2>Linked chips</h2>${figs}` : ''}
<p>(U) GIS Workbench is not an accredited marking system; the banner rolls up the observations' portion marks.</p>
</main><div class="banner bottom">${esc(banner)}</div></body></html>`;
  }

  function activityCsv() {
    const q = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    return ['time_utc,category,confidence,text,lat,lon,graphics,chips,features,image', ...S.all('observation').map((o) => [o.time ?? o.created, o.category, o.confidence, o.text, o.lat, o.lon, (o.graphics ?? []).length, (o.chips ?? []).join(' '), (o.features ?? []).length, o.image].map(q).join(','))].join('\n') + '\n';
  }

  async function reportDialog() {
    const title = h('input', { type: 'text', value: 'Activity report', spellcheck: 'true', 'data-id': 'act-title' });
    const b = await modal({ title: 'Activity Report', body: h('div', {}, field('Title', title), h('p', { class: 'hint' }, `${S.all('observation').length} observation(s), in time order.`)), buttons: ['Save HTML…', 'Save DOCX…', 'Save CSV…', 'Cancel'], id: 'activity-report' });
    const html = activityHtml({ title: title.value });
    if (b === 'Save HTML…') await saveBlob(app, new Blob([html], { type: 'text/html' }), { name: 'activity-report.html' });
    if (b === 'Save DOCX…') await saveBlob(app, new Blob([docxFromHtml(html, { title: title.value })], { type: DOCX_TYPE }), { name: 'activity-report.docx' });
    if (b === 'Save CSV…') await saveBlob(app, new Blob([activityCsv()], { type: 'text/csv' }), { name: 'activity-report.csv' });
  }

  C.implement('obs.toolbox', { run: run(() => toolbox()) });
  C.implement('obs.table', { run: run(() => app.activeMp().docks.show('observations')) });
  app.observations = { add, update, toolbox, activityHtml, activityCsv, activityDocx: (o) => docxFromHtml(activityHtml(o), { title: o?.title ?? 'Activity report' }), positionOf, CATEGORIES };
}
