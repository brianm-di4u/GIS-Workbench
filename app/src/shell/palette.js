// Command palette (REQ-SHL-05): Ctrl+K opens one search box over every command, layer, bookmark
// and recent project. A typed or pasted coordinate in any supported format flies the view there.
// Disabled commands stay listed with the reason they cannot run.
//
// Search in any UI language (REQ-L10N-13): a command is found by its translated and its English
// label, aliases, category and keywords, so an analyst can type the word they know in either
// language. Text is split into words with words() (Intl.Segmenter for scripts without spaces),
// accents are ignored, and ties are sorted with the locale's collator.

import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { metaOf, needOf, outcomeOf, categoryLabel, CATEGORY_LABEL } from './command-meta.js';
import { t, tc, tr, msgOf } from '../i18n/index.js';
import { words, collator } from '../i18n/format.js';
import { layoutKey } from '../input/keys.js';

const MAX = 60;

/** Human form of a chord ('Mod+Shift+KeyZ' → 'Ctrl+Shift+Z'). */
const KEY_NAMES = { Equal: '=', Minus: '−', NumpadAdd: 'Num +', NumpadSubtract: 'Num −', Space: 'Space', Backquote: '`', Delete: 'Del', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Comma: ',', Period: '.', Slash: '/' };
/** Key names printed on keyboards in words, in the UI language (Strg, Entf… on German keyboards). */
const KEY_WORDS = {
  Ctrl: () => tc('key', 'Ctrl'),
  Shift: () => tc('key', 'Shift'),
  Alt: () => tc('key', 'Alt'),
  Space: () => tc('key', 'Space'),
  Del: () => tc('key', 'Del'),
  Esc: () => tc('key', 'Esc'),
};
const keyWord = (s) => KEY_WORDS[s]?.() ?? s;

/**
 * Key names follow the user's keyboard layout where the browser tells it (a chord is stored by
 * physical key: KeyZ is "Y" on a German keyboard), and key words follow the UI language.
 */
export function chordLabel(c) {
  const mac = /Mac/.test(globalThis.navigator?.platform ?? '');
  return c
    .split('+')
    .map((p) => {
      if (p === 'Mod') return mac ? '⌘' : keyWord('Ctrl');
      if (/^Key[A-Z]$/.test(p)) return layoutKey(p) ?? p.slice(3);
      if (/^Numpad[0-9]$/.test(p)) return tc('key', 'Num {k}', { k: p.slice(6) });
      return keyWord(KEY_NAMES[p] ?? p.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num '));
    })
    .join('+');
}

/** Live key chord of every command (global and panel maps, user overrides included). */
export function chordsByCommand(app) {
  const out = new Map();
  const maps = app.keys?.keyMap?.() ?? {};
  for (const m of [maps.global ?? {}, maps.pane ?? {}]) for (const [ch, id] of Object.entries(m)) if (!out.has(id)) out.set(id, chordLabel(ch));
  return out;
}

/** Lower case, without accents on Latin, Greek and Cyrillic letters ("Préférences" → "preferences"). */
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');

/** The words of a text for matching, each with its offset in the joined text (to favour early matches). */
function tokens(text) {
  const ws = words(String(text).replace(/▸/g, ' ')).map(fold);
  let at = 0;
  return ws.map((w) => {
    const o = at;
    at += w.length + 1;
    return [w, o];
  });
}

/**
 * Score text against a query: every query word must match the start of a word or a substring;
 * word-start and early matches score higher. 0 = no match.
 */
export function score(text, q) {
  const tk = tokens(text);
  const whole = tk.map(([w]) => w).join(' ');
  let s = 0;
  for (const w of tokens(q).map(([x]) => x)) {
    const start = tk.find(([x]) => x.startsWith(w));
    if (start) {
      s += 10 + Math.max(0, 6 - start[1] / 8);
      continue;
    }
    const i = whole.indexOf(w);
    if (i < 0) {
      // Initials fallback for short words ("zi" → "Zoom In", "ndvi" stays a substring match).
      const initials = tk.map(([x]) => x[0] ?? '').join('');
      if (w.length >= 2 && w.length <= 4 && initials.includes(w)) {
        s += 6;
        continue;
      }
      return 0;
    }
    s += 4 + Math.max(0, 6 - i / 8);
  }
  return s;
}

/** A source and its translation, once when they are the same (English). */
const both = (src) => {
  if (!src) return '';
  const tx = tr(src);
  return tx && tx !== src ? `${tx} ${src}` : src;
};

/** What the palette searches for a command: translated first (it ranks earlier), then English. */
export function searchText(C, c) {
  const m = metaOf(c.id);
  return [both(c.label), both(m.alias), both(CATEGORY_LABEL[m.cat]), ...(m.kw ?? []).map(both), c.id].filter(Boolean).join(' ');
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
    label: t('Fly to {where}', { where }),
    detail: `${r.format}${r.notice ? ` · ${r.notice}` : ''}`,
    icon: 'jump',
    enabled: !!app.activePane()?.geoLayer()?.modelId,
    reason: t('open a georeferenced image first'),
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
  if (/^(https?|s3|gs):\/\/\S+$/i.test(q) && app.openUrl) items.push({ kind: 'url', id: 'url', label: t('Open {url}', { url: q.length > 60 ? `${q.slice(0, 57)}…` : q }), detail: t('Opens imagery from this address by range: only what is shown is read'), icon: 'network', enabled: true, run: () => app.openUrl(q), score: 1000 });
  for (const c of C.list()) {
    if (!c.implemented) continue;
    const m = metaOf(c.id);
    const cat = categoryLabel(m.cat);
    const label = C.labelOf(c.id);
    const sc = q ? score(searchText(C, c), q) + (score(both(c.label), q) ? 5 : 0) : 1;
    if (!sc) continue;
    const gap = C.liteGap(c.id);
    const enabled = !gap && C.enabled(c.id);
    items.push({
      kind: 'cmd',
      id: c.id,
      label: label.replace(/…$/, ''),
      detail: outcomeOf(C, c.id) || cat,
      cat,
      icon: c.icon,
      key: chords.get(c.id) ?? (c.key ? chordLabel(c.key) : ''),
      enabled,
      reason: gap ?? needOf(app, c.id),
      run: () => C.run(c.id),
      score: sc + (enabled ? 2 : 0),
    });
  }
  // Layers of the active panel (searchable by the word "layer" in English and the UI language).
  const pane = app.activePane();
  for (const l of pane?.layers() ?? []) {
    const nm = l.rec?.name ?? l.id;
    const sc = q ? score(`${nm} ${tc('search words', 'layer')} layer`, q) : 0.5;
    if (!sc) continue;
    items.push({ kind: 'layer', id: l.id, label: nm, detail: t('Layer: make it the active layer'), icon: 'layers', enabled: true, run: () => app.setActiveLayer?.(pane, l.id) ?? app.store.transact(t('Active layer'), (tx) => tx.set(pane.id, 'activeLayer', l.id)), score: sc });
  }
  // Bookmarks.
  for (const b of app.store.all('bookmark')) {
    const sc = q ? score(`${b.name} ${tc('search words', 'bookmark')} bookmark`, q) : 0.4;
    if (!sc) continue;
    items.push({ kind: 'bookmark', id: b.id, label: b.name, detail: t('Bookmark: go to its centre, scale and rotation'), icon: 'bookmark', enabled: !!pane, reason: t('open an image first'), run: () => app.goToBookmark?.(b), score: sc });
  }
  // Recent projects.
  for (const r of (await app.recentProjects?.().catch(() => [])) ?? []) {
    const sc = q ? score(`${r.name} ${tc('search words', 'recent project open')} recent project open`, q) : 0.3;
    if (!sc) continue;
    items.push({ kind: 'recent', id: r.name, label: r.name, detail: t('Recent project: open it'), icon: 'open', enabled: true, run: () => app.openRecent?.(r), score: sc });
  }
  const cmp = collator().compare;
  items.sort((a, b) => b.score - a.score || cmp(a.label, b.label));
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

  /** The ranked items for a query, as the palette lists them (automation, tests). */
  results(q) {
    return collect(this.app, q);
  }

  async open(initial = '') {
    if (this.el) return this.input.focus();
    this.prevFocus = document.activeElement;
    this.input = h('input', { class: 'pal-input', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: t('Type a command, layer or bookmark — or a coordinate to fly there'), 'aria-label': t('Search commands'), role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list', 'data-id': 'palette:input' });
    this.list = h('ul', { class: 'pal-list', id: 'pal-list', role: 'listbox', 'aria-label': t('Results') });
    this.hint = h('div', { class: 'pal-hint' }, t('↑↓ to move · Enter to run · Esc to close'));
    const box = h('div', { class: 'pal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Command palette'), 'data-id': 'palette' }, this.input, this.list, this.hint);
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
      this.list.appendChild(h('li', { class: 'pal-empty', role: 'option', 'aria-disabled': 'true' }, q ? t('Nothing matches "{q}".', { q }) : t('Start typing.')));
      return;
    }
    items.forEach((it, i) => {
      const li = h(
        'li',
        { class: ['pal-item', i === this.sel && 'sel', !it.enabled && 'off'], role: 'option', id: `pal-opt-${i}`, 'aria-selected': String(i === this.sel), 'aria-disabled': String(!it.enabled), 'data-id': `palette:${it.kind}:${it.id}` },
        h('span', { class: 'pal-ic', 'aria-hidden': 'true' }, icon(it.icon)),
        h('span', { class: 'pal-text' }, h('span', { class: 'pal-label' }, it.label, it.cat ? h('span', { class: 'pal-cat' }, ` · ${it.cat}`) : null), h('span', { class: 'pal-detail' }, it.enabled ? it.detail : t('Not now: {reason}', { reason: it.reason }))),
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
      this.app.toast(t('{cmd}: {msg}', { cmd: it.label, msg: it.reason }), { kind: 'warn' });
      return;
    }
    this.close();
    try {
      await it.run();
    } catch (e) {
      this.app.toast(t('{cmd}: {msg}', { cmd: it.label, msg: msgOf(e) }), { kind: 'error' });
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
