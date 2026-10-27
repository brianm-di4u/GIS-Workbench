// Exploitation report (REQ-PRD-11, REQ-AI-10, AT-02.4, Research/03 §5): an editable HTML
// report in the §5.1 order — banners rolled up from every portion, header block, BLUF, imagery
// used, location, numbered portion-marked observations, annotated chips, the §5.3 mensuration
// table, change summary, counts, comments and gaps, and an authority block only when entered.
// A RECCEXREP/IPIR/SUPIR-style default, not a STANAG 3377 conformant format.

import { highest, bannerText, portionMark, rank } from '../security/marking.js';
import { MENLOG_COLUMNS, menRow } from '../tools/menlog.js';
import { tokenValues, isoUtc } from './tokens.js';

export const REPORT_TYPES = ['First phase (IPIR-style)', 'Second phase (SUPIR-style)', 'Special', 'Reconnaissance exploitation (RECCEXREP-style)'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const NA = 'N/A';

/** A portion mark string "(C)", "(S//NF)", "C" or a marking object → marking object. */
export function parsePortion(p) {
  if (!p) return null;
  if (typeof p === 'object') return p.level ? p : null;
  const m = /^\(?\s*([URCST])\b(?:\/\/([^)]*))?\)?/.exec(String(p).trim().toUpperCase());
  return m ? { level: m[1] === 'T' ? 'T' : m[1], raw: m[1], codewords: m[2] ?? '', control: '', release: '' } : null;
}

/** Portion mark at the start of a paragraph, e.g. "(C) text" → {mark, text}. */
export function splitPortion(text) {
  const m = /^\s*(\([URCST](?:\/\/[^)]*)?\))\s*/.exec(String(text ?? ''));
  return m ? { mark: m[1], text: String(text).slice(m[0].length) } : { mark: null, text: String(text ?? '') };
}

/** Everything the report rests on, gathered from the store and the open images. */
export function reportInputs(app) {
  const layers = [...app.layers.values()].filter((l) => l.kind !== 'dem');
  const panes = app.desktop?.panes?.() ?? [];
  const images = layers.map((l) => {
    const pane = panes.find((p) => p.layers?.().includes(l)) ?? app.activePane();
    const v = tokenValues({ app, layer: l, view: pane?.geoLayer?.() === l ? pane : null });
    return { id: v.IMAGE_ID || l.rec.name, sensor: v.SENSOR || NA, time: v.ACQ_DATE || NA, gsd: v.GSD || NA, obliquity: v.OBLIQUITY || NA, sun: v.SUN || NA, niirs: l.rec.niirs ?? NA, model: l.modelName && l.modelName !== 'none' ? l.modelName : NA, marking: l.info.marking ?? null };
  });
  const obs = app.store.all('observation');
  return { images, observations: obs, measurements: app.store.all('measurement'), chips: app.store.all('chip'), changes: app.store.all('change'), graphics: app.store.all('graphic') };
}

/** Banner of the report: the highest of every portion (images, observations, chips, fields). */
export function reportMarking(app, inp, fields = {}) {
  const ms = [];
  for (const i of inp.images) if (i.marking) ms.push(i.marking);
  for (const o of inp.observations) ms.push(parsePortion(o.portion ?? o.marking ?? splitPortion(o.text).mark));
  for (const c of inp.chips) if (c.marking?.level) ms.push({ level: c.marking.level });
  for (const k of ['bluf', 'comments']) for (const para of String(fields[k] ?? '').split(/\n\s*\n/)) ms.push(parsePortion(splitPortion(para).mark));
  const pm = app.project?.()?.marking;
  if (pm) ms.push(pm);
  if (fields.raise) ms.push({ level: fields.raise });
  return highest(ms.filter(Boolean));
}

const paras = (text, fallbackMark) =>
  String(text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const s = splitPortion(p);
      return `<p>${esc(s.mark ?? fallbackMark)} ${esc(s.text)}</p>`;
    })
    .join('\n');

/**
 * The report as a standalone HTML document. fields: title, productId, type, tasking, producer,
 * bluf, location, comments, authority, raise, aiDrafted (sections drafted by AI), chipImages
 * (Map number → data URL).
 */
export function buildReport(app, fields = {}, inp = reportInputs(app)) {
  const marking = reportMarking(app, inp, fields);
  const banner = bannerText(marking);
  const unmarked = portionMark({ level: 'U' });
  const now = isoUtc(new Date());
  const ai = new Set(fields.aiDrafted ?? []);
  const aiTag = (k) => (ai.has(k) ? ' <span class="ai">AI-drafted — review before release</span>' : '');
  const p = app.activePane?.();
  const l = p?.geoLayer?.();
  const v = l ? tokenValues({ app, layer: l, view: p }) : {};
  const rows = (cells) => `<tr>${cells.map((c) => `<td>${esc(c === '' || c === null || c === undefined ? NA : c)}</td>`).join('')}</tr>`;
  const imgRows = inp.images.map((i) => rows([i.id, i.sensor, i.time, i.gsd, i.obliquity, i.sun, i.niirs, i.model, i.marking ? portionMark(i.marking) : NA])).join('');
  const obsHtml = inp.observations.length
    ? `<ol class="obs">${inp.observations
        .map((o, n) => {
          const s = splitPortion(o.text);
          const mark = o.portion ? portionMark(parsePortion(o.portion)) : s.mark ?? unmarked;
          const refs = [o.image ? `image ${o.image}` : null, o.chip ? `chip ${o.chip}` : null, ...(o.measurements ?? []).map((m) => m)].filter(Boolean).join('; ');
          return `<li value="${n + 1}">${esc(mark)} ${esc(s.text)} <span class="conf">Confidence: ${esc(o.confidence ?? NA)}</span>${refs ? ` <span class="refs">(${esc(refs)})</span>` : ''}${o.label === 'AI-drafted' ? ' <span class="ai">AI-drafted</span>' : ''}</li>`;
        })
        .join('')}</ol>`
    : `<p>${unmarked} No observations recorded.</p>`;
  const chipsHtml = inp.chips.length
    ? inp.chips
        .map((c) => {
          const src = fields.chipImages?.get?.(c.number);
          return `<figure>${src ? `<img src="${esc(src)}" alt="Chip ${esc(c.number)}">` : `<div class="noimg">Chip ${esc(c.number)} (image not kept in this session)</div>`}<figcaption>${esc(c.marking?.level ? `(${c.marking.level})` : unmarked)} ${esc(c.caption)}</figcaption></figure>`;
        })
        .join('')
    : `<p>${unmarked} No chips.</p>`;
  const menHtml = inp.measurements.length
    ? `<table><thead><tr>${MENLOG_COLUMNS.map(([, h]) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${inp.measurements
        .map((m) => {
          const r = menRow(m);
          return rows(MENLOG_COLUMNS.map(([k]) => r[k]));
        })
        .join('')}</tbody></table>`
    : `<p>${unmarked} No measurements.</p>`;
  const chg = inp.changes.filter((c) => c.status !== 'rejected');
  const chgHtml = chg.length ? `<table><thead><tr><th>#</th><th>Type</th><th>Status</th><th>Area (m²)</th><th>Before</th><th>After</th></tr></thead><tbody>${chg.map((c, i) => rows([i + 1, c.kind ?? c.type ?? 'change', c.status ?? 'candidate', c.areaM2 ? c.areaM2.toFixed(0) : NA, `${c.image1 ?? NA} ${c.date1 ?? ''}`, `${c.image2 ?? NA} ${c.date2 ?? ''}`])).join('')}</tbody></table>` : `<p>${unmarked} No change detection in this project.</p>`;
  const counts = {};
  for (const g of inp.graphics) if (g.countOf || g.shape === 'marker') counts[g.shape] = (counts[g.shape] ?? 0) + 1;
  const countHtml = Object.keys(counts).length ? `<table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${Object.entries(counts).map(([k, n]) => rows([k, n])).join('')}</tbody></table>` : `<p>${unmarked} No counts.</p>`;
  const lvl = marking.level ?? 'U';
  const colour = { U: '#007a33', R: '#5c2d91', C: '#0033a0', S: '#c8102e', T: '#ff8c00' }[lvl] ?? '#007a33';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(banner)} — ${esc(fields.title || 'Exploitation report')}</title>
<style>
@page { size: A4; margin: 18mm 14mm; }
body { font: 10.5pt/1.4 Arial, Helvetica, sans-serif; color: #111; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.banner { background: ${colour}; color: #fff; font-weight: bold; text-align: center; padding: 2mm 0; letter-spacing: .04em; }
@media print { .banner { position: fixed; left: 0; right: 0; } .banner.top { top: -12mm; } .banner.bottom { bottom: -12mm; } }
main { padding: 4mm 0; }
h1 { font-size: 16pt; margin: 2mm 0; } h2 { font-size: 12pt; border-bottom: 1px solid #888; margin-top: 6mm; }
table { border-collapse: collapse; width: 100%; font-size: 8.5pt; } th, td { border: 1px solid #999; padding: 1mm 1.5mm; text-align: left; vertical-align: top; } th { background: #eee; }
.hdr td:first-child { width: 32%; font-weight: bold; }
figure { margin: 3mm 0; break-inside: avoid; } figure img { max-width: 100%; } figcaption { font-size: 9pt; }
.ai { background: #fff3cd; border: 1px solid #c9a227; padding: 0 1mm; font-size: 8pt; }
.conf, .refs { color: #444; font-size: 9pt; } .noimg { border: 1px dashed #888; padding: 6mm; text-align: center; color: #666; }
.note { color: #555; font-size: 8.5pt; }
</style></head><body>
<div class="banner top" role="banner">${esc(banner)}</div>
<main>
<h1>${esc(unmarked)} ${esc(fields.title || 'Exploitation report')}</h1>
<table class="hdr"><tbody>
${rows(['Product ID', fields.productId || NA])}${rows(['Report date-time (UTC)', now])}${rows(['Producer', fields.producer || app.prefs.get('analyst') || NA])}${rows(['Type', fields.type || REPORT_TYPES[0]])}${rows(['Tasking reference', fields.tasking || NA])}
</tbody></table>
<h2>BLUF${aiTag('bluf')}</h2>
${paras(fields.bluf, unmarked) || `<p>${unmarked} ${NA}</p>`}
<h2>Imagery used</h2>
<table><thead><tr><th>Image ID</th><th>Sensor</th><th>Acquired (UTC)</th><th>GSD</th><th>Obliquity</th><th>Sun</th><th>NIIRS</th><th>Sensor model</th><th>Marking</th></tr></thead><tbody>${imgRows || rows([NA, NA, NA, NA, NA, NA, NA, NA, NA])}</tbody></table>
<h2>Location</h2>
<p>${esc(unmarked)} ${esc(fields.location || NA)} · MGRS ${esc(v.MGRS_CENTER || NA)} · ${esc(v.LATLON_CENTER || NA)} (WGS 84)</p>
<h2>Observations</h2>
${obsHtml}
<h2>Annotated chips</h2>
${chipsHtml}
${fields.media?.length ? `<h2>Motion and animation</h2>${fields.media.map((m) => `<figure>${m.kind === 'gif' ? `<img src="${esc(m.dataUrl)}" alt="${esc(m.caption)}">` : `<video controls muted loop playsinline src="${esc(m.dataUrl)}" width="${Math.min(640, m.width)}"></video>`}<figcaption>${esc(m.marking ? `(${m.marking})` : unmarked)} ${esc(m.caption)}</figcaption></figure>`).join('')}` : ''}
<h2>Mensuration table</h2>
${menHtml}
<h2>Change summary</h2>
${chgHtml}
<h2>Inventory and counts</h2>
${countHtml}
<h2>Analyst comments and gaps${aiTag('comments')}</h2>
${paras(fields.comments, unmarked) || `<p>${unmarked} ${NA}</p>`}
${fields.authority ? `<h2>Classification authority</h2><p>${esc(fields.authority)}</p>` : ''}
<p class="note">Banner rolled up from ${inp.images.length} image(s), ${inp.observations.length} observation(s), ${inp.chips.length} chip(s) and the report text. Produced with GIS Workbench, which is not an accredited marking system; this layout is an editable default, not a STANAG 3377 format.</p>
</main>
<div class="banner bottom" role="contentinfo">${esc(banner)}</div>
</body></html>`;
}

/** Prompt for an AI draft of BLUF and comments from the log, observations and chips (REQ-AI-10). */
export function draftPrompt(inp, fields) {
  const lines = [
    'Draft the BLUF (2–5 sentences) and the analyst comments and gaps for an imagery exploitation report.',
    'Start every paragraph with its portion mark in parentheses, e.g. "(U) ...". Never mark a paragraph lower than the highest portion of the facts it uses.',
    'Use only the facts below. Do not invent measurements, locations or classification authority.',
    'Reply with two sections headed exactly "BLUF:" and "COMMENTS:".',
    `Report type: ${fields.type || REPORT_TYPES[0]}. Tasking: ${fields.tasking || 'not given'}.`,
    `Images: ${JSON.stringify(inp.images.map((i) => ({ id: i.id, sensor: i.sensor, time: i.time, gsd: i.gsd, mark: i.marking ? portionMark(i.marking) : '(U)' })))}`,
    `Observations: ${JSON.stringify(inp.observations.map((o) => ({ text: o.text, confidence: o.confidence ?? null, portion: o.portion ?? splitPortion(o.text).mark ?? '(U)' })))}`,
    `Measurements: ${JSON.stringify(inp.measurements.slice(0, 40).map((m) => { const r = menRow(m); return { id: r.mid, type: r.type, value: r.value, ce90: r.ce90, coords: r.coordinates }; }))}`,
    `Chips: ${JSON.stringify(inp.chips.map((c) => ({ number: c.number, caption: c.caption, mark: c.marking?.level ? `(${c.marking.level})` : '(U)' })))}`,
  ];
  return lines.join('\n');
}

/**
 * Parse an AI reply into {bluf, comments, fixed}: paragraphs without a portion mark get the
 * highest input portion (never lower) and are counted in `fixed`.
 */
export function parseDraft(text, floor) {
  const t = String(text ?? '');
  const b = /BLUF:\s*([\s\S]*?)(?:\n\s*COMMENTS:|$)/i.exec(t)?.[1] ?? t;
  const c = /COMMENTS:\s*([\s\S]*)$/i.exec(t)?.[1] ?? '';
  let fixed = 0;
  const fix = (s) =>
    s
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const sp = splitPortion(p);
        const pm = parsePortion(sp.mark);
        if (pm && rank(pm.level) >= rank(floor.level)) return p;
        fixed++;
        return `${portionMark(floor)} ${sp.text}`;
      })
      .join('\n\n');
  return { bluf: fix(b), comments: fix(c), fixed };
}
