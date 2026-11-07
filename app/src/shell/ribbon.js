// Ribbon (REQ-UI-03/04): File tab, main tabs, colour-captioned contextual tab sets, groups
// with large/small buttons, combos, sliders, inputs, galleries, split buttons and dialog
// launchers; KeyTips on Alt; minimise caret. Built from ribbon-data.js.

import { h, clear, keyLabel } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { MAIN_TABS, CONTEXT_SETS, FILE_MENU, localMenu } from './ribbon-data.js';
import { N_, t, tc, tr } from '../i18n/index.js';
import { keyTipLetters, keyTipOf } from '../input/keys.js';

/** A tab's or group's label in the UI language (ribbon-data.js labels are N_ sources; the user's own are kept). */
const shown = (x) => (x.own ? x.label : tr(x.label));

export class Ribbon {
  constructor(app, mp) {
    this.app = app;
    this.mp = mp; // the owning Multiport
    this.active = 'home';
    this.minimised = false;
    this.el = h('div', { class: 'ribbon', role: 'region', 'aria-label': t('Ribbon') });
    this.captions = h('div', { class: 'ribbon-captions', 'aria-hidden': 'true' });
    this.strip = h('div', { class: 'ribbon-tabs', role: 'tablist', 'aria-label': t('Ribbon tabs') });
    this.body = h('div', { class: 'ribbon-body', role: 'tabpanel' });
    // The minimise caret sits beside the tablist, not in it (a tablist holds only tabs).
    this.caret = h('button', { class: 'rtab-min', title: t('Minimise the Ribbon (Ctrl+F1)'), 'aria-label': t('Minimise the Ribbon'), 'aria-pressed': 'false' }, icon('caret'));
    this.caret.addEventListener('click', () => this.toggleMinimise());
    this.el.append(h('div', { class: 'ribbon-tabrow' }, this.strip, this.caret), this.body);
    this.controls = new Map();
    this.render();
    new ResizeObserver(() => this.fitTabs()).observe(this.el);
    // A Ribbon wider than its window scrolls sideways under the mouse wheel (GUI-017).
    this.body.addEventListener(
      'wheel',
      (e) => {
        const b = this.body;
        if (b.scrollWidth <= b.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY) || e.target.closest('select, input[type="range"]')) return;
        b.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
    app.on('state', () => this.refresh());
    app.on('ribbon', () => this.render());
    app.commands.on('change', () => this.refresh());
  }

  /** Ribbon customization (REQ-UI-24): {hidden: ['tab:group', …], tab: {label, items: [cmd ids]}}. */
  custom() {
    const c = this.app.prefs?.get('ribbonCustom') ?? {};
    return { hidden: new Set(c.hidden ?? []), tab: c.tab?.items?.length ? c.tab : null };
  }

  contexts() {
    const ctx = this.app.ribbonContext(this.mp);
    return CONTEXT_SETS.filter((s) => {
      try {
        return s.when(ctx);
      } catch {
        return false;
      }
    });
  }

  allTabs() {
    const tabs = MAIN_TABS.map((x) => ({ ...x, set: null }));
    const { tab } = this.custom();
    // The user's own tab keeps the name they gave it (own: shown as it is, never translated).
    const own = !!tab?.label;
    if (tab) tabs.push({ id: 'custom', label: tab.label || N_('My Commands'), own, set: null, groups: [{ label: tab.label || N_('My Commands'), own, items: tab.items.map((cmd) => ({ cmd, size: 'S' })) }] });
    for (const s of this.contexts()) for (const x of s.tabs) tabs.push({ ...x, set: s });
    return tabs;
  }

  render() {
    clear(this.strip);
    clear(this.captions);
    const tabs = this.allTabs();
    if (!tabs.find((x) => x.id === this.active)) this.active = 'home';
    const fileLabel = tc('ribbon tab', 'File');
    // KeyTips for the File button and the tabs that have one, unique in the strip.
    const keyed = [{ en: 'F', label: fileLabel }, ...tabs.filter((x) => x.key).map((x) => ({ en: x.key, label: shown(x) }))];
    const letters = keyTipLetters(keyed);
    const tipOf = new Map(tabs.filter((x) => x.key).map((x, i) => [x.id, letters[i + 1]]));
    const file = h('button', { class: 'rtab rtab-file', role: 'tab', 'aria-selected': 'false', 'aria-haspopup': 'menu', 'data-id': 'ribbon:file', 'data-keytip': letters[0] ?? 'F' }, fileLabel);
    file.addEventListener('click', () => openMenu(localMenu(FILE_MENU), this.app, { anchor: file }));
    this.strip.appendChild(file);
    let lastSet = null;
    let host = this.strip;
    for (const tb of tabs) {
      const b = h(
        'button',
        {
          class: ['rtab', tb.set && 'rtab-ctx', tb.id === this.active && 'active'],
          role: 'tab',
          'aria-selected': String(tb.id === this.active),
          'data-id': `ribbon:tab:${tb.id}`,
          'data-keytip': tipOf.get(tb.id) ?? null,
          style: tb.set ? { '--ctx': `var(${tb.set.color})` } : null,
        },
        shown(tb),
      );
      if (tb.set !== lastSet) {
        if (tb.set) {
          // Contextual set: its tabs sit under one coloured caption in the QAT row.
          host = h('div', { class: 'rtab-set', role: 'presentation', 'data-caption': tr(tb.set.label), title: tr(tb.set.label), style: { '--ctx': `var(${tb.set.color})` }, 'data-id': `ribbon:set:${tb.set.id}` });
          this.strip.appendChild(host);
        } else host = this.strip;
      }
      lastSet = tb.set;
      b.addEventListener('click', () => {
        if (this.active === tb.id && !this.minimised) return;
        this.active = tb.id;
        this.minimised = false;
        this.render();
      });
      b.addEventListener('dblclick', () => this.toggleMinimise());
      b.addEventListener('keydown', (e) => {
        const all = [...this.strip.querySelectorAll('.rtab:not(.rtab-file)')];
        const i = all.indexOf(b);
        if (e.key === 'ArrowRight') all[(i + 1) % all.length].focus();
        else if (e.key === 'ArrowLeft') all[(i - 1 + all.length) % all.length].focus();
        else return;
        e.preventDefault();
      });
      host.appendChild(b);
    }
    this.caret.setAttribute('aria-pressed', String(this.minimised));
    this.renderBody(tabs.find((x) => x.id === this.active));
    this.fitTabs();
  }

  /** Tighten the tab strip in steps until every tab fits (GUI-014). */
  fitTabs() {
    const s = this.strip;
    s.classList.remove('compact', 'tight');
    if (!s.isConnected) return;
    for (const c of ['compact', 'tight']) {
      if (s.scrollWidth <= s.clientWidth + 1) break;
      s.classList.add(c);
    }
  }

  toggleMinimise() {
    this.minimised = !this.minimised;
    this.render();
    this.app.emit('layout');
  }

  renderBody(tab) {
    clear(this.body);
    this.controls.clear();
    this.body.hidden = this.minimised;
    this.el.classList.toggle('min', this.minimised);
    if (!tab || this.minimised) return;
    if (tab.set) this.body.style.setProperty('--ctx', `var(${tab.set.color})`);
    else this.body.style.removeProperty('--ctx');
    const { hidden } = this.custom();
    for (const g of tab.groups) {
      if (hidden.has(`${tab.id}:${g.label}`)) continue;
      const items = h('div', { class: ['rgroup-items', g.kind === 'gallery' && 'gallery'] });
      const smalls = [];
      const flush = () => {
        if (!smalls.length) return;
        for (let i = 0; i < smalls.length; i += 3) items.appendChild(h('div', { class: 'rcol' }, smalls.slice(i, i + 3)));
        smalls.length = 0;
      };
      for (const raw of g.items) {
        const it = typeof raw === 'string' ? { cmd: raw, size: g.kind === 'gallery' ? 'G' : 'S' } : raw;
        const ctl = this.control(it);
        if (!ctl) continue;
        if (it.size === 'L' || it.kind === 'input' || it.kind === 'slider') {
          flush();
          items.appendChild(ctl);
        } else if (it.size === 'G') items.appendChild(ctl);
        else smalls.push(ctl);
      }
      flush();
      const name = shown(g);
      const caption = h('div', { class: 'rgroup-caption' }, h('span', {}, name));
      if (g.launcher) {
        const l = h('button', { class: 'rlauncher', title: this.app.commands.get(g.launcher) ? this.app.commands.labelOf(g.launcher) : name, 'aria-label': t('{group} settings', { group: name }), 'data-id': `cmd:${g.launcher}` }, '⌟');
        l.addEventListener('click', () => this.app.commands.run(g.launcher));
        caption.appendChild(l);
      }
      this.body.appendChild(h('div', { class: 'rgroup', role: 'group', 'aria-label': name }, items, caption));
    }
    this.refresh();
  }

  tip(c) {
    // A list of separate facts, each its own message: name, key, what it does, availability.
    const C = this.app.commands;
    const parts = [C.labelOf(c.id)];
    if (c.key) parts.push(`(${keyLabel(c.key)})`); // Ctrl or ⌘, not the stored 'Mod'
    if (c.tip) parts.push(`— ${C.tipOf(c.id)}`);
    if (!c.implemented) parts.push(`· ${t('planned {rel}, {req}', { rel: c.rel, req: c.req })}`);
    if (C.liteGap(c.id)) parts.push(`· ${t('not in GIS Workbench Lite: open the Standard file')}`);
    return parts.join(' ');
  }

  control(it) {
    const c = this.app.commands.get(it.cmd);
    if (!c) return null;
    const did = `cmd:${c.id}`;
    const label = this.app.commands.labelOf(c.id);
    const itLabel = tr(it.label) ?? label;
    let el;
    if (it.kind === 'combo') {
      const sel = h('select', { class: 'rcombo', 'aria-label': label, title: this.tip(c), 'data-id': did });
      sel.addEventListener('change', () => c.setValue?.(sel.value));
      el = h('label', { class: 'rbtn rbtn-s rcombo-wrap' }, icon(c.icon), sel);
      this.controls.set(c.id, { el, c, kind: 'combo', sel });
    } else if (it.kind === 'input') {
      const inp = h('input', { class: 'rinput', type: 'text', placeholder: itLabel, 'aria-label': itLabel, title: this.tip(c), 'data-id': did, spellcheck: 'false' });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.app.commands.run(c.id, inp.value);
        }
        e.stopPropagation();
      });
      el = h('div', { class: 'rinput-wrap' }, h('span', { class: 'rinput-label' }, itLabel), inp);
      this.controls.set(c.id, { el, c, kind: 'input', inp });
    } else if (it.kind === 'slider') {
      const rng = h('input', { type: 'range', class: 'rslider', min: '-100', max: '100', step: '1', value: '0', 'aria-label': label, title: this.tip(c), 'data-id': did });
      rng.addEventListener('input', () => c.setValue?.(Number(rng.value)));
      rng.addEventListener('change', () => this.app.undo.seal());
      rng.addEventListener('dblclick', () => c.setValue?.(0));
      el = h('label', { class: 'rslider-wrap' }, h('span', { class: 'rslider-label' }, icon(c.icon), label), rng);
      this.controls.set(c.id, { el, c, kind: 'slider', rng });
    } else {
      const large = it.size === 'L';
      const b = h(
        'button',
        { class: ['rbtn', large ? 'rbtn-l' : it.size === 'G' ? 'rbtn-g' : 'rbtn-s', !c.implemented && 'planned'], title: this.tip(c), 'aria-label': label, 'data-id': did, type: 'button' },
        icon(c.icon, large ? 32 : 16),
        it.size === 'G' ? null : h('span', { class: 'rbtn-label' }, label),
      );
      b.addEventListener('click', () => this.app.commands.run(c.id));
      b.addEventListener('dblclick', () => c.sticky && c.sticky());
      if (it.kind === 'split') {
        const caret = h('button', { class: 'rsplit-caret', 'aria-label': t('{cmd} options', { cmd: label }), 'data-id': `${did}:menu` }, icon('caret', 12));
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          const name = this.app.commands.labelOf(c.id);
          let items = c.menu?.() ?? [{ label: c.implemented ? name : t('{cmd} — planned {rel}', { cmd: name, rel: c.rel }), run: () => this.app.commands.run(c.id) }];
          if (!items.length) items = [{ label: t('Nothing to choose for the active image'), disabled: true }];
          openMenu(items, this.app, { anchor: caret });
        });
        el = h('div', { class: ['rsplit', large ? 'rsplit-l' : 'rsplit-s'] }, b, caret);
        this.controls.set(c.id, { el, c, kind: it.kind ?? 'button', b, caret });
      } else el = b;
      if (!this.controls.has(c.id)) this.controls.set(c.id, { el, c, kind: it.kind ?? 'button', b });
    }
    return el;
  }

  refresh() {
    for (const { c, kind, b, sel, rng, inp, caret } of this.controls.values()) {
      const en = this.app.commands.enabled(c.id);
      if (b) {
        b.disabled = !en && c.implemented;
        if (caret) caret.disabled = b.disabled;
        if (c.checked || kind === 'toggle') {
          const on = this.app.commands.checked(c.id);
          b.setAttribute('aria-pressed', String(on));
          b.classList.toggle('on', on);
        }
      }
      if (sel) {
        const opts = c.options?.() ?? [{ value: '', label: c.implemented ? this.app.commands.labelOf(c.id) : t('planned {rel}', { rel: c.rel }) }];
        const cur = c.value?.() ?? '';
        if (sel.dataset.sig !== JSON.stringify(opts)) {
          clear(sel);
          for (const o of opts) sel.appendChild(h('option', { value: o.value }, o.label));
          sel.dataset.sig = JSON.stringify(opts);
        }
        sel.value = cur;
        sel.disabled = !en || !c.implemented;
      }
      if (rng) {
        const v = c.value?.();
        if (Number.isFinite(v) && document.activeElement !== rng) rng.value = String(v);
        rng.disabled = !en || !c.implemented;
      }
      if (inp) inp.disabled = !en && c.implemented;
    }
  }

  /** Re-render when the contextual sets change (active layer). */
  update() {
    const sig = this.contexts().map((s) => s.id).join(',');
    if (sig !== this._sig) {
      this._sig = sig;
      this.render();
    } else this.refresh();
  }

  // ---- KeyTips (Alt) ----
  showKeyTips() {
    this.hideKeyTips();
    this.el.classList.add('keytips');
    const tabs = [...this.strip.querySelectorAll('[data-keytip]')];
    this._tips = tabs.map((tb) => {
      const tip = h('span', { class: 'keytip' }, tb.dataset.keytip);
      tb.appendChild(tip);
      return tip;
    });
    const onKey = (e) => {
      const k = keyTipOf(e);
      const tab = k && tabs.find((x) => x.dataset.keytip === k);
      this.hideKeyTips();
      document.removeEventListener('keydown', onKey, true);
      if (tab) {
        e.preventDefault();
        tab.click();
        tab.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    this._off = () => document.removeEventListener('keydown', onKey, true);
  }

  hideKeyTips() {
    this.el.classList.remove('keytips');
    for (const tip of this._tips ?? []) tip.remove();
    this._tips = [];
    this._off?.();
  }
}
