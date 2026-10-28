// Command palette (REQ-SHL-05): Ctrl+K opens one search box over every command, layer, bookmark
// and recent project. A typed or pasted coordinate in any supported format flies the view there.
// Disabled commands stay listed with the reason they cannot run.

import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { metaOf, CATEGORY_LABEL } from './command-meta.js';

const MAX = 60;

/** Human form of a chord ('Mod+Shift+KeyZ' → 'Ctrl+Shift+Z'). */
const KEY_NAMES = { Equal: '=', Minus: '−', NumpadAdd: 'Num +', NumpadSubtract: 'Num −', Space: 'Space', Backquote: '`', Delete: 'Del', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Comma: ',', Period: '.', Slash: '/' };

export function chordLabel(c) {
  const mac = /Mac/.test(globalThis.navigator?.platform ?? '');
  return c
    .split('+')
    .map((p) => (p === 'Mod' ? (mac ? '⌘' : 'Ctrl') : KEY_NAMES[p] ?? p.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ')))
    .join('+');
}

/** Live key chord of every command (global and panel maps, user overrides included). */
export function chordsByCommand(app) {
  const out = new Map();
  const maps = app.keys?.keyMap?.() ?? {};
  for (const m of [maps.global ?? {}, maps.pane ?? {}]) for (const [ch, id] of Object.entries(m)) if (!out.has(id)) out.set(id, chordLabel(ch));
  return out;
}

/**
 * Score text against a query: every query word must match the start of a word or a substring;
 * word-start and early matches score higher. 0 = no match.
 */
export function score(text, q) {
  const t = text.toLowerCase();
  let s = 0;
  for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
    const i = t.indexOf(w);
    if (i < 0) {
      // Initials fallback for short words ("zi" → "Zoom In", "ndvi" stays a substring match).
      const initials = t.split(/[\s▸/(.-]+/).map((x) => x[0] ?? '').join('');
      if (w.length >= 2 && w.length <= 4 && initials.includes(w)) {
        s += 6;
        continue;
      }
      return 0;
    }
    const wordStart = i === 0 || /[\s▸/(.-]/.test(t[i - 1]);
    s += (wordStart ? 10 : 4) + Math.max(0, 6 - i / 8);
  }
  return s;
}

function coordinateItem(app, q) {
  if (!/\d/.test(q) || q.length < 3) return null;
  let r;
  try {
    r = app.core.parse(q);
  } catch {
    return null;
  }
  if (!Number.isFinite(r?.lat) || !Number.isFinite(r?.lon)) return null;
  const where = app.core.format(r.lat, r.lon, 0, 6);
  return {
    kind: 'coord',
    id: 'coord',
    label: `Fly to ${where}`,
    detail: `${r.format}${r.notice ? ` · ${r.notice}` : ''}`,
    icon: 'jump',
    enabled: !!app.activePane()?.geoLayer()?.modelId,
    reason: 'open a georeferenced image first',
    run: () => app.jumpTo(q),
    score: 1000,
  };
}

async function collect(app, q) {
  const C = app.commands;
  const chords = chordsByCommand(app);
  const items = [];
  const coord = coordinateItem(app, q);
  if (coord) items.push(coord);
  for (const c of C.list()) {
    if (!c.implemented) continue;
    const m = metaOf(c.id);
    const cat = CATEGORY_LABEL[m.cat] ?? '';
    const text = `${c.label} ${m.alias ?? ''} ${cat} ${(m.kw ?? []).join(' ')} ${c.id}`;
    const sc = q ? score(text, q) + (score(c.label, q) ? 5 : 0) : 1;
    if (!sc) continue;
    const gap = C.liteGap(c.id);
    const enabled = !gap && C.enabled(c.id);
    items.push({
      kind: 'cmd',
      id: c.id,
      label: c.label.replace(/…$/, ''),
      detail: m.out || c.tip || cat,
      cat,
      icon: c.icon,
      key: chords.get(c.id) ?? (c.key ? chordLabel(c.key) : ''),
      enabled,
      reason: gap ?? (m.need ? m.need : 'not available in the current state'),
      run: () => C.run(c.id),
      score: sc + (enabled ? 2 : 0),
    });
  }
  // Layers of the active panel.
  const pane = app.activePane();
  for (const l of pane?.layers() ?? []) {
    const nm = l.rec?.name ?? l.id;
    const sc = q ? score(`${nm} layer`, q) : 0.5;
    if (!sc) continue;
    items.push({ kind: 'layer', id: l.id, label: nm, detail: 'Layer: make it the active layer', icon: 'layers', enabled: true, run: () => app.setActiveLayer?.(pane, l.id) ?? app.store.transact('Active layer', (tx) => tx.set(pane.id, 'activeLayer', l.id)), score: sc });
  }
  // Bookmarks.
  for (const b of app.store.all('bookmark')) {
    const sc = q ? score(`${b.name} bookmark`, q) : 0.4;
    if (!sc) continue;
    items.push({ kind: 'bookmark', id: b.id, label: b.name, detail: 'Bookmark: go to its centre, scale and rotation', icon: 'bookmark', enabled: !!pane, reason: 'open an image first', run: () => app.goToBookmark?.(b), score: sc });
  }
  // Recent projects.
  for (const r of (await app.recentProjects?.().catch(() => [])) ?? []) {
    const sc = q ? score(`${r.name} recent project open`, q) : 0.3;
    if (!sc) continue;
    items.push({ kind: 'recent', id: r.name, label: r.name, detail: 'Recent project: open it', icon: 'open', enabled: true, run: () => app.openRecent?.(r), score: sc });
  }
  items.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return items.slice(0, MAX);
}

export class Palette {
  constructor(app) {
    this.app = app;
    this.el = null;
  }

  get isOpen() {
    return !!this.el;
  }

  async open(initial = '') {
    if (this.el) return this.input.focus();
    this.prevFocus = document.activeElement;
    this.input = h('input', { class: 'pal-input', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'Type a command, layer or bookmark — or a coordinate to fly there', 'aria-label': 'Search commands', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list', 'data-id': 'palette:input' });
    this.list = h('ul', { class: 'pal-list', id: 'pal-list', role: 'listbox', 'aria-label': 'Results' });
    this.hint = h('div', { class: 'pal-hint' }, '↑↓ to move · Enter to run · Esc to close');
    const box = h('div', { class: 'pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette', 'data-id': 'palette' }, this.input, this.list, this.hint);
    this.el = h('div', { class: 'pal-backdrop' }, box);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    document.body.appendChild(this.el);
    this.input.value = initial;
    this.input.focus();
    this.sel = 0;
    await this.refresh();
  }

  close() {
    if (!this.el) return;
    this.el.remove();
    this.el = null;
    this.prevFocus?.focus?.({ preventScroll: true });
  }

  async refresh() {
    const q = this.input.value.trim();
    const seq = (this.seq = (this.seq ?? 0) + 1);
    const items = await collect(this.app, q);
    if (seq !== this.seq || !this.el) return;
    this.items = items;
    this.sel = Math.min(this.sel ?? 0, Math.max(0, items.length - 1));
    clear(this.list);
    if (!items.length) {
      this.list.appendChild(h('li', { class: 'pal-empty', role: 'option', 'aria-disabled': 'true' }, q ? `Nothing matches "${q}".` : 'Start typing.'));
      return;
    }
    items.forEach((it, i) => {
      const li = h(
        'li',
        { class: ['pal-item', i === this.sel && 'sel', !it.enabled && 'off'], role: 'option', id: `pal-opt-${i}`, 'aria-selected': String(i === this.sel), 'aria-disabled': String(!it.enabled), 'data-id': `palette:${it.kind}:${it.id}` },
        h('span', { class: 'pal-ic', 'aria-hidden': 'true' }, icon(it.icon)),
        h('span', { class: 'pal-text' }, h('span', { class: 'pal-label' }, it.label, it.cat ? h('span', { class: 'pal-cat' }, ` · ${it.cat}`) : null), h('span', { class: 'pal-detail' }, it.enabled ? it.detail : `Not now: ${it.reason}`)),
        it.key ? h('kbd', { class: 'pal-key' }, it.key) : null,
      );
      li.addEventListener('pointerenter', () => this.select(i, false));
      li.addEventListener('click', () => this.runAt(i));
      this.list.appendChild(li);
    });
    this.input.setAttribute('aria-activedescendant', `pal-opt-${this.sel}`);
  }

  select(i, scroll = true) {
    if (!this.items?.length) return;
    this.sel = (i + this.items.length) % this.items.length;
    this.list.querySelectorAll('.pal-item').forEach((li, j) => {
      li.classList.toggle('sel', j === this.sel);
      li.setAttribute('aria-selected', String(j === this.sel));
      if (j === this.sel && scroll) li.scrollIntoView({ block: 'nearest' });
    });
    this.input.setAttribute('aria-activedescendant', `pal-opt-${this.sel}`);
  }

  async runAt(i) {
    const it = this.items?.[i];
    if (!it) return;
    if (!it.enabled) {
      this.app.toast(`${it.label}: ${it.reason}`, { kind: 'warn' });
      return;
    }
    this.close();
    try {
      await it.run();
    } catch (e) {
      this.app.toast(`${it.label}: ${e.message}`, { kind: 'error' });
    }
  }

  onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.select(this.sel + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.select(this.sel - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.runAt(this.sel);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      this.select(Math.min(this.items.length - 1, this.sel + 8));
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      this.select(Math.max(0, this.sel - 8));
    }
    e.stopPropagation(); // keep the app's hot keys out while typing
  }
}
