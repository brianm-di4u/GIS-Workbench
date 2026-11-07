// Report (REQ-PRD-11, REQ-AI-10, AT-02.4, Research/03 §5): an editable HTML
// report in the §5.1 order — header block, BLUF, imagery used, location, numbered observations,
// annotated chips, the §5.3 mensuration table, change summary, counts, comments and gaps.
// A general-purpose default, not a conformant format of any standard.

import { MENLOG_COLUMNS, menRow } from '../tools/menlog.js';
import { tokenValues, isoUtc } from './tokens.js';
import { t, N_, tr } from '../i18n/index.js';
import { num } from '../i18n/format.js';
import { htmlLangAttrs } from './lang.js';
import { languageLine } from '../ai/assistant.js';

/** Report types: data values (kept in English in the project), shown with tr(). */
export const REPORT_TYPES = [N_('General'), N_('Special')];

/** The report type to show: a type this version does not offer (an older saved report) reads as the first. */
export const reportType = (type) => (REPORT_TYPES.includes(type) ? type : REPORT_TYPES[0]);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// N/A inside reportInputs() stays English: the values also feed the AI draft prompt.
const NA = 'N/A';
/** Confidence terms of observations (data), shown with tr(). */
export const CONFIDENCE = [N_('low'), N_('moderate'), N_('high')];

/** Everything the report rests on, gathered from the store and the open images. */
export function reportInputs(app) {
  const layers = [...app.layers.values()].filter((l) => l.kind !== 'dem');
  const panes = app.desktop?.panes?.() ?? [];
  const images = layers.map((l) => {
    const pane = panes.find((p) => p.layers?.().includes(l)) ?? app.activePane();
    const v = tokenValues({ app, layer: l, view: pane?.geoLayer?.() === l ? pane : null });
    return { id: v.IMAGE_ID || l.rec.name, sensor: v.SENSOR || NA, time: v.ACQ_DATE || NA, gsd: v.GSD || NA, obliquity: v.OBLIQUITY || NA, sun: v.SUN || NA, niirs: l.rec.niirs ?? NA, model: l.modelName && l.modelName !== 'none' ? l.modelName : NA };
  });
  const obs = app.store.all('observation');
  return { images, observations: obs, measurements: app.store.all('measurement'), chips: app.store.all('chip'), changes: app.store.all('change'), graphics: app.store.all('graphic') };
}

const paras = (text) =>
  String(text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('\n');

/**
 * The report as a standalone HTML document. fields: title, productId, type, tasking, producer,
 * bluf, location, comments, aiDrafted (sections drafted by AI), chipImages
 * (Map number → data URL).
 */
export function buildReport(app, fields = {}, inp = reportInputs(app)) {
  const now = isoUtc(new Date());
  const ai = new Set(fields.aiDrafted ?? []);
  const aiTag = (k) => (ai.has(k) ? ` <span class="ai">${esc(t('AI-drafted — review before release'))}</span>` : '');
  const p = app.activePane?.();
  const l = p?.geoLayer?.();
  const v = l ? tokenValues({ app, layer: l, view: p }) : {};
  const na = t('N/A');
  const cell = (c) => (c === '' || c === null || c === undefined || c === NA ? na : c);
  const rows = (cells) => `<tr>${cells.map((c) => `<td>${esc(cell(c))}</td>`).join('')}</tr>`;
  const th = (...labels) => labels.map((s) => `<th>${esc(s)}</th>`).join('');
  const title = fields.title || t('Report');
  const imgRows = inp.images.map((i) => rows([i.id, i.sensor, i.time, i.gsd, i.obliquity, i.sun, i.niirs, i.model])).join('');
  const obsHtml = inp.observations.length
    ? `<ol class="obs">${inp.observations
        .map((o, n) => {
          const refs = [o.image ? t('image {id}', { id: o.image }) : null, o.chip ? t('chip {id}', { id: String(o.chip) }) : null, ...(o.measurements ?? []).map((m) => m)].filter(Boolean).join('; ');
          return `<li value="${n + 1}">${esc(o.text)} <span class="conf">${esc(t('Confidence: {confidence}', { confidence: o.confidence ? tr(o.confidence) : na }))}</span>${refs ? ` <span class="refs">(${esc(refs)})</span>` : ''}${o.label === 'AI-drafted' ? ` <span class="ai">${esc(t('AI-drafted'))}</span>` : ''}</li>`;
        })
        .join('')}</ol>`
    : `<p>${esc(t('No observations recorded.'))}</p>`;
  const chipsHtml = inp.chips.length
    ? inp.chips
        .map((c) => {
          const src = fields.chipImages?.get?.(c.number);
          return `<figure>${src ? `<img src="${esc(src)}" alt="${esc(t('Chip {n}', { n: String(c.number) }))}">` : `<div class="noimg">${esc(t('Chip {n} (image not kept in this session)', { n: String(c.number) }))}</div>`}<figcaption>${esc(c.caption)}</figcaption></figure>`;
        })
        .join('')
    : `<p>${esc(t('No chips.'))}</p>`;
  const menHtml = inp.measurements.length
    ? `<table><thead><tr>${MENLOG_COLUMNS.map(([, h]) => `<th>${esc(tr(h))}</th>`).join('')}</tr></thead><tbody>${inp.measurements
        .map((m) => {
          const r = menRow(m);
          return rows(MENLOG_COLUMNS.map(([k]) => r[k]));
        })
        .join('')}</tbody></table>`
    : `<p>${esc(t('No measurements.'))}</p>`;
  const chg = inp.changes.filter((c) => c.status !== 'rejected');
  const chgHtml = chg.length ? `<table><thead><tr><th>#</th>${th(t('Type'), t('Status'), t('Area (m²)'), t('Before'), t('After'))}</tr></thead><tbody>${chg.map((c, i) => rows([i + 1, tr(c.kind ?? c.type ?? N_('change')), tr(c.status ?? N_('candidate')), c.areaM2 ? num(c.areaM2, 0) : NA, `${c.image1 ?? na} ${c.date1 ?? ''}`, `${c.image2 ?? na} ${c.date2 ?? ''}`])).join('')}</tbody></table>` : `<p>${esc(t('No change detection in this project.'))}</p>`;
  const counts = {};
  for (const g of inp.graphics) if (g.countOf || g.shape === 'marker') counts[g.shape] = (counts[g.shape] ?? 0) + 1;
  const countHtml = Object.keys(counts).length ? `<table><thead><tr>${th(t('Category'), t('Count'))}</tr></thead><tbody>${Object.entries(counts).map(([k, n]) => rows([k, n])).join('')}</tbody></table>` : `<p>${esc(t('No counts.'))}</p>`;
  return `<!doctype html>
<html${htmlLangAttrs()}><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page { size: A4; margin: 18mm 14mm; }
body { font: 10.5pt/1.4 Arial, Helvetica, sans-serif; color: #111; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
main { padding: 4mm 0; }
h1 { font-size: 16pt; margin: 2mm 0; } h2 { font-size: 12pt; border-bottom: 1px solid #888; margin-top: 6mm; }
table { border-collapse: collapse; width: 100%; font-size: 8.5pt; } th, td { border: 1px solid #999; padding: 1mm 1.5mm; text-align: left; vertical-align: top; } th { background: #eee; }
.hdr td:first-child { width: 32%; font-weight: bold; }
figure { margin: 3mm 0; break-inside: avoid; } figure img { max-width: 100%; } figcaption { font-size: 9pt; }
.ai { background: #fff3cd; border: 1px solid #c9a227; padding: 0 1mm; font-size: 8pt; }
.conf, .refs { color: #444; font-size: 9pt; } .noimg { border: 1px dashed #888; padding: 6mm; text-align: center; color: #666; }
.note { color: #555; font-size: 8.5pt; }
</style></head><body>
<main>
<h1>${esc(title)}</h1>
<table class="hdr"><tbody>
${rows([t('Product ID'), fields.productId || NA])}${rows([t('Report date-time (UTC)'), now])}${rows([t('Producer'), fields.producer || app.prefs.get('analyst') || NA])}${rows([t('Type'), tr(reportType(fields.type))])}${rows([t('Tasking reference'), fields.tasking || NA])}
</tbody></table>
<h2>${esc(t('BLUF'))}${aiTag('bluf')}</h2>
${paras(fields.bluf) || `<p>${esc(na)}</p>`}
<h2>${esc(t('Imagery used'))}</h2>
<table><thead><tr>${th(t('Image ID'), t('Sensor'), t('Acquired (UTC)'), t('GSD'), t('Obliquity'), t('Sun'), t('NIIRS'), t('Sensor model'))}</tr></thead><tbody>${imgRows || rows([NA, NA, NA, NA, NA, NA, NA, NA])}</tbody></table>
<h2>${esc(t('Location'))}</h2>
<p>${esc(t('{location} · MGRS {mgrs} · {latlon} (WGS 84)', { location: fields.location || na, mgrs: v.MGRS_CENTER || na, latlon: v.LATLON_CENTER || na }))}</p>
<h2>${esc(t('Observations'))}</h2>
${obsHtml}
<h2>${esc(t('Annotated chips'))}</h2>
${chipsHtml}
${fields.media?.length ? `<h2>${esc(t('Motion and animation'))}</h2>${fields.media.map((m) => `<figure>${m.kind === 'gif' ? `<img src="${esc(m.dataUrl)}" alt="${esc(m.caption)}">` : `<video controls muted loop playsinline src="${esc(m.dataUrl)}" width="${Math.min(640, m.width)}"></video>`}<figcaption>${esc(m.caption)}</figcaption></figure>`).join('')}` : ''}
<h2>${esc(t('Mensuration table'))}</h2>
${menHtml}
<h2>${esc(t('Change summary'))}</h2>
${chgHtml}
<h2>${esc(t('Inventory and counts'))}</h2>
${countHtml}
<h2>${esc(t('Analyst comments and gaps'))}${aiTag('comments')}</h2>
${paras(fields.comments) || `<p>${esc(na)}</p>`}
<p class="note">${esc(t('Produced with GIS Workbench. This layout is an editable default.'))}</p>
</main>
</body></html>`;
}

/** Prompt for an AI draft of BLUF and comments from the log, observations and chips (REQ-AI-10). */
export function draftPrompt(inp, fields) {
  const lines = [
    'Draft the BLUF (2–5 sentences) and the analyst comments and gaps for an imagery analysis report.',
    'Use only the facts below. Do not invent measurements or locations.',
    'Reply with two sections headed exactly "BLUF:" and "COMMENTS:".',
    // REQ-L10N-19: the prompt stays English; the report text follows the UI language.
    ...(languageLine() ? [languageLine()] : []),
    `Report type: ${reportType(fields.type)}. Tasking: ${fields.tasking || 'not given'}.`,
    `Images: ${JSON.stringify(inp.images.map((i) => ({ id: i.id, sensor: i.sensor, time: i.time, gsd: i.gsd })))}`,
    `Observations: ${JSON.stringify(inp.observations.map((o) => ({ text: o.text, confidence: o.confidence ?? null })))}`,
    `Measurements: ${JSON.stringify(inp.measurements.slice(0, 40).map((m) => { const r = menRow(m, { machine: true }); return { id: r.mid, type: r.type, value: r.value, ce90: r.ce90, coords: r.coordinates }; }))}`,
    `Chips: ${JSON.stringify(inp.chips.map((c) => ({ number: c.number, caption: c.caption })))}`,
  ];
  return lines.join('\n');
}

/** Parse an AI reply into {bluf, comments}. */
export function parseDraft(text) {
  const t = String(text ?? '');
  const b = /BLUF:\s*([\s\S]*?)(?:\n\s*COMMENTS:|$)/i.exec(t)?.[1] ?? t;
  const c = /COMMENTS:\s*([\s\S]*)$/i.exec(t)?.[1] ?? '';
  const tidy = (s) =>
    s
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .join('\n\n');
  return { bluf: tidy(b), comments: tidy(c) };
}
