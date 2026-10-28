// Two-line tooltips (REQ-SHL-06): the command name and key, then what it does in plain words,
// then why it cannot run now (if so) and how to get help. The tooltip never takes the pointer, so
// it cannot cover the control the analyst reaches for next. One delegated listener serves every
// command control (Ribbon, QAT, Workspace toolbar, toolbox, palette pill…): any element whose
// data-id is "cmd:<id>", "qat:<id>" or "ws:<id>", or that carries data-tip-cmd="<id>". The
// element's native title is parked while the tooltip shows, so the browser does not show both.

import { h } from './dom.js';
import { metaOf, needOf } from './command-meta.js';
import { chordsByCommand } from './palette.js';

const SHOW_MS = 450;
const HIDE_MS = 120;
const ID_RE = /^(?:cmd|qat|ws):(.+?)(?::menu)?$/;

export function commandIdOf(el) {
  if (el.dataset.tipCmd) return el.dataset.tipCmd;
  const m = ID_RE.exec(el.dataset.id ?? '');
  return m ? m[1] : null;
}

export class Tooltips {
  constructor(app) {
    this.app = app;
    this.tip = h('div', { class: 'tip2', role: 'tooltip', id: 'tip2', hidden: true });
    document.body.appendChild(this.tip);
    const sel = '[data-id^="cmd:"],[data-id^="qat:"],[data-id^="ws:"],[data-tip-cmd]';
    document.addEventListener('pointerover', (e) => {
      const el = e.target.closest?.(sel);
      if (el && el !== this.target) this.schedule(el);
      else if (!el) this.scheduleHide();
    });
    document.addEventListener('focusin', (e) => {
      const el = e.target.closest?.(sel);
      if (el && e.target.matches(':focus-visible')) this.schedule(el, 0);
      else this.hide();
    });
    document.addEventListener('pointerdown', () => this.hide(), true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    }, true);
  }

  schedule(el, ms = SHOW_MS) {
    clearTimeout(this.showT);
    clearTimeout(this.hideT);
    if (this.target && this.target !== el) this.restoreTitle();
    this.target = el;
    this.park(el);
    this.showT = setTimeout(() => this.show(el), this.tip.hidden ? ms : 0);
  }

  scheduleHide() {
    clearTimeout(this.showT);
    clearTimeout(this.hideT);
    this.hideT = setTimeout(() => this.hide(), HIDE_MS);
  }

  park(el) {
    if (el.hasAttribute('title')) {
      el.dataset.tipTitle = el.getAttribute('title');
      el.removeAttribute('title');
    }
  }

  restoreTitle() {
    const el = this.target;
    if (el?.dataset.tipTitle !== undefined) {
      el.setAttribute('title', el.dataset.tipTitle);
      delete el.dataset.tipTitle;
    }
  }

  /** {label, key, outcome, status} for a command id. */
  content(id) {
    const C = this.app.commands;
    const c = C.get(id);
    if (!c) return null;
    const key = chordsByCommand(this.app).get(id) ?? c.key ?? '';
    const outcome = metaOf(id).out ?? c.tip ?? '';
    let status = '';
    const gap = C.liteGap(id);
    if (gap) status = gap;
    else if (!c.implemented) status = `Planned for ${c.rel} (${c.req}).`;
    else if (!C.enabled(id)) status = `Not available now: ${needOf(this.app, id)}.`;
    return { label: c.label.replace(/…$/, ''), key, outcome, status };
  }

  show(el) {
    if (!el.isConnected) return;
    const id = commandIdOf(el);
    const t = id && this.content(id);
    if (!t) return;
    // replaceChildren() would turn a null into the text "null": drop the empty lines first.
    const lines = [
      h('div', { class: 'tip2-head' }, h('strong', {}, t.label), t.key ? h('kbd', {}, t.key) : null),
      t.outcome ? h('div', { class: 'tip2-out' }, t.outcome) : null,
      t.status ? h('div', { class: 'tip2-status' }, t.status) : null,
      h('div', { class: 'tip2-foot' }, 'F1: help'),
    ];
    this.tip.replaceChildren(...lines.filter(Boolean));
    this.tip.dataset.cmd = id;
    this.tip.hidden = false;
    el.setAttribute('aria-describedby', 'tip2');
    // Place below the control, inside the window.
    const r = el.getBoundingClientRect();
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    let x = Math.min(Math.max(4, r.left), window.innerWidth - tw - 4);
    let y = r.bottom + 6;
    if (y + th > window.innerHeight - 4) y = Math.max(4, r.top - th - 6);
    this.tip.style.left = `${x}px`;
    this.tip.style.top = `${y}px`;
  }

  hide() {
    clearTimeout(this.showT);
    clearTimeout(this.hideT);
    if (this.target) {
      this.target.removeAttribute('aria-describedby');
      this.restoreTitle();
    }
    this.target = null;
    this.tip.hidden = true;
  }
}
