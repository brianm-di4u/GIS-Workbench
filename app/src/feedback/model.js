// Whiteboard data model (REQ-WB-02/03/07/09/11), DOM-free for unit tests: marks with their own
// 200-step undo/redo (never mixed with the project history), pages with type, summary, pin
// notes, general notes, reporter and context, and the versioned JSON exchange format.
//
// Page types and triage values are data (the JSON keeps them in English); they are marked with
// N_ and shown through tr().

import { t, N_, tr, gwError } from '../i18n/index.js';
export const KIND = 'gisworkbench-feedback';
export const FORMAT_VERSION = 1;
export const TOOLS = { V: 'interact', P: 'pen', H: 'highlight', A: 'arrow', R: 'rect', O: 'ellipse', T: 'text', N: 'pin', E: 'erase' };
export const COLOURS = ['#e53935', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#ffffff'];
export const WIDTHS = [2, 4, 8];
export const PAGE_TYPES = [N_('bug'), N_('suggestion'), N_('question')];

let seq = 0;
const id = (p) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export class Marks {
  constructor(limit = 200) {
    this.limit = limit;
    this.items = [];
    this.undoStack = [];
    this.redoStack = [];
  }

  _push(action) {
    this.undoStack.push(action);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  add(mark) {
    const m = { id: id('mk'), ...mark };
    if (m.tool === 'pin') m.n = this.items.filter((x) => x.tool === 'pin').length + 1;
    this.items.push(m);
    this._push({ do: 'add', mark: m });
    return m;
  }

  remove(markId) {
    const i = this.items.findIndex((m) => m.id === markId);
    if (i < 0) return null;
    const [m] = this.items.splice(i, 1);
    this._push({ do: 'remove', mark: m, index: i });
    return m;
  }

  update(markId, patch) {
    const m = this.items.find((x) => x.id === markId);
    if (!m) return;
    const before = { ...m };
    Object.assign(m, patch);
    this._push({ do: 'update', id: markId, before, after: { ...m } });
  }

  clear() {
    if (!this.items.length) return;
    this._push({ do: 'clear', items: this.items.slice() });
    this.items = [];
  }

  _apply(a, undo) {
    switch (a.do) {
      case 'add':
        if (undo) this.items = this.items.filter((m) => m.id !== a.mark.id);
        else this.items.push(a.mark);
        break;
      case 'remove':
        if (undo) this.items.splice(a.index, 0, a.mark);
        else this.items = this.items.filter((m) => m.id !== a.mark.id);
        break;
      case 'update': {
        const m = this.items.find((x) => x.id === a.id);
        if (m) Object.assign(m, undo ? a.before : a.after);
        break;
      }
      case 'clear':
        this.items = undo ? a.items.slice() : [];
        break;
      default:
        break;
    }
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return false;
    this._apply(a, true);
    this.redoStack.push(a);
    return true;
  }

  redo() {
    const a = this.redoStack.pop();
    if (!a) return false;
    this._apply(a, false);
    this.undoStack.push(a);
    return true;
  }

  pins() {
    return this.items.filter((m) => m.tool === 'pin');
  }

  snapshot() {
    return structuredClone(this.items);
  }
}

/** Constrain a drag (Shift): arrows to 45°, rectangles and ellipses to squares and circles. */
export function constrain(tool, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (tool === 'arrow') {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const r = Math.hypot(dx, dy);
    return { x: a.x + r * Math.cos(ang), y: a.y + r * Math.sin(ang) };
  }
  if (tool === 'rect' || tool === 'ellipse') {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + Math.sign(dx || 1) * s, y: a.y + Math.sign(dy || 1) * s };
  }
  return b;
}

/** A captured page. */
export function newPage({ image, width, height, marks, context, reporter = '', capture = 'snapshot' }) {
  return {
    id: id('pg'),
    type: 'bug',
    summary: '',
    notes: '',
    reporter,
    created: new Date().toISOString(),
    capture,
    image, // PNG data URL
    width,
    height,
    marks: structuredClone(marks),
    pins: marks.filter((m) => m.tool === 'pin').map((m) => ({ n: m.n, note: m.note ?? '', target: m.target ?? null })),
    context,
    triage: { status: 'new', priority: '', assignee: '' },
  };
}

/** Triage values (REQ-WB-12). */
export const TRIAGE_STATUS = [N_('new'), N_('triaged'), N_('in progress'), N_('done'), N_("won't fix")];
export const TRIAGE_PRIORITY = ['', N_('low'), N_('medium'), N_('high'), N_('critical')];

/** Pages matching a triage filter {status, priority, assignee} (empty fields match all). */
export function filterPages(pages, f = {}) {
  const a = String(f.assignee ?? '').trim().toLowerCase();
  return pages.filter((p) => {
    const t = { status: 'new', priority: '', assignee: '', ...(p.triage ?? {}) };
    return (!f.status || t.status === f.status) && (!f.priority || t.priority === f.priority) && (!a || t.assignee.toLowerCase().includes(a));
  });
}

/**
 * The observation a page becomes (REQ-WB-13): text from its summary, notes and pin notes,
 * linked to the pinned items that are store records (layers, measurements, graphics).
 */
export function pageToObservation(page) {
  const pins = (page.pins ?? []).filter((p) => p.note || p.target);
  const text = [page.summary, page.notes, ...pins.map((p) => (p.target ? t('Pin {n} ({target}): {note}', { n: p.n, target: p.target.label, note: p.note ?? '' }) : t('Pin {n}: {note}', { n: p.n, note: p.note ?? '' })).trim())].filter(Boolean).join('\n');
  const links = pins
    .map((p) => p.target?.id)
    .filter(Boolean)
    .map((id) => ({ kind: id.split(':')[0], id: id.slice(id.indexOf(':') + 1).split(':')[0], ref: id }))
    .filter((l) => ['layer', 'measurement', 'graphic', 'feature', 'pane'].includes(l.kind));
  return { text: text || t('(no text)'), confidence: page.type === 'question' ? 'low' : 'moderate', category: page.type, image: page.context?.image ?? null, position: page.context?.centre ?? null, links, fromPage: page.id, created: new Date().toISOString(), label: N_('from feedback page') };
}

/** Versioned exchange document (REQ-WB-09). */
export function toJson(session) {
  return {
    kind: KIND,
    version: FORMAT_VERSION,
    project: session.project ?? '',
    build: session.build ?? '',
    exported: new Date().toISOString(),
    pages: session.pages,
  };
}

/** Parse a feedback JSON (or the JSON block of an HTML report) for import/merge (REQ-WB-11). */
export function fromJson(text) {
  const doc = JSON.parse(text, (k, v) => (k === '__proto__' || k === 'constructor' ? undefined : v));
  if (!doc || doc.kind !== KIND) throw new Error('not a GIS Workbench feedback file');
  if (doc.version > FORMAT_VERSION) throw gwError('feedback format {version} is newer than this build reads ({max})', { version: String(doc.version), max: String(FORMAT_VERSION) }, 'E_FEEDBACK_NEWER');
  if (!Array.isArray(doc.pages)) throw new Error('feedback file has no pages');
  const pages = doc.pages.filter((p) => p && typeof p === 'object').map((p) => ({
    ...p,
    id: typeof p.id === 'string' ? p.id : id('pg'),
    type: PAGE_TYPES.includes(p.type) ? p.type : 'bug',
    image: typeof p.image === 'string' && p.image.startsWith('data:image/png;base64,') ? p.image : null,
    pins: Array.isArray(p.pins) ? p.pins : [],
    marks: Array.isArray(p.marks) ? p.marks : [],
  }));
  return { ...doc, pages };
}

export function extractJsonFromHtml(html) {
  const m = /<script type="application\/json" id="feedback-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('this HTML file is not a GIS Workbench feedback report');
  return m[1].replace(/\\u003c/g, '<');
}

/** Merge imported pages into a session, skipping duplicates by id. */
export function merge(pages, incoming) {
  const have = new Set(pages.map((p) => p.id));
  const added = incoming.filter((p) => !have.has(p.id));
  return { pages: [...pages, ...added], added: added.length, skipped: incoming.length - added.length };
}

/** Plain-text e-mail body (REQ-WB-09), in the UI language. */
export function emailBody(session) {
  const lines = [t('GIS Workbench feedback — {project}', { project: session.project ?? '' }), t('Build {build}; {n, plural, one {# page} other {# pages}}', { build: session.build ?? '', n: session.pages.length }), ''];
  session.pages.forEach((p, i) => {
    lines.push(`${i + 1}. [${tr(p.type)}] ${p.summary || t('(no summary)')}`);
    if (p.notes) lines.push(`   ${p.notes}`);
    for (const pin of p.pins) lines.push(`   ${pin.target ? t('Pin {n} → {target}: {note}', { n: pin.n, target: pin.target.label ?? pin.target.id, note: pin.note || '' }) : t('Pin {n}: {note}', { n: pin.n, note: pin.note || '' })}`);
    const c = p.context ?? {};
    lines.push(`   ${t('Context: {context}', { context: [c.image, c.centre?.mgrs, c.zoom ? t('zoom {zoom}', { zoom: c.zoom }) : '', c.model].filter(Boolean).join(' · ') })}`);
    lines.push('');
  });
  lines.push(t('The full report with screenshots is attached as an HTML file.'));
  return lines.join('\n');
}
