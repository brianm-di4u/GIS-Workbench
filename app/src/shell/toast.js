// Snackbars (REQ-SHL-07): transient status messages with at most one action, announced to screen
// readers through an aria-live region. At most MAX_VISIBLE show at once, bottom centre above the
// status bar; the rest wait their turn, so messages never pile up over the image. A message that
// is already showing is refreshed instead of repeated.

import { h } from './dom.js';
import { t, locale, PSEUDO } from '../i18n/index.js';

let host;
let live;
const MAX_VISIBLE = 3;
const queue = [];
const showing = new Set();
/** Every message as issued (kind after the step-first downgrade), newest last, 500 kept: for
 * diagnostics and the T&E harness, which must see a message even while it waits its turn. */
export const toastLog = [];

function ensure() {
  if (host) return;
  host = h('div', { class: 'toasts' });
  live = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
  document.body.append(host, live);
}

/** Messages that ask the user to do something first (open, select, draw…): guidance, not failures (GUI-019). */
// A data pack to open or the Standard file to use is a step too, not a failure (TE 2.0.4 cross).
export const STEP_FIRST = /\bfirst\b|^(select|open|draw|give) |no AI connection is set up|File ▸ Open ▸ Open Data Pack|leaves out: open the Standard file/i;

function dismiss(t) {
  if (!showing.has(t)) return;
  clearTimeout(t._timer);
  t.classList.add('out');
  setTimeout(() => {
    t.remove();
    showing.delete(t);
    pump();
  }, 300);
}

function arm(t) {
  clearTimeout(t._timer);
  t._timer = setTimeout(() => dismiss(t), t._ms);
}

function pump() {
  while (showing.size < MAX_VISIBLE && queue.length) {
    const t = queue.shift();
    host.appendChild(t);
    showing.add(t);
    live.textContent = t._message;
    arm(t);
  }
}

/**
 * STEP_FIRST reads English text, so it is only a fallback while the UI is English (or a
 * pseudo-locale, whose text is English underneath): in another language the caller's explicit
 * kind stands. Callers pass { kind: 'warn' } for "do this first" messages (DN-62); commands.js
 * also tests the English message of a thrown error, which works in every locale.
 */
const englishUi = () => locale() === 'en' || !!PSEUDO[locale()];

export function toast(message, { kind = 'info', ms = 3500, action } = {}) {
  if (kind === 'error' && englishUi() && STEP_FIRST.test(message)) kind = 'warn';
  toastLog.push({ t: Date.now(), kind, message: String(message) });
  if (toastLog.length > 500) toastLog.shift();
  ensure();
  // The same message already on screen or waiting: show it longer instead of twice.
  for (const node of [...showing, ...queue]) {
    if (node._message === message && node._kind === kind) {
      if (showing.has(node)) arm(node);
      return node;
    }
  }
  const node = h('div', { class: ['toast', `toast-${kind}`], role: kind === 'error' ? 'alert' : null }, h('span', {}, message));
  node._message = message;
  node._kind = kind;
  // A message with an action stays long enough to use it.
  node._ms = action ? Math.max(ms, 8000) : ms;
  if (action) {
    const b = h('button', { class: 'btn btn-small toast-action' }, action.label);
    b.addEventListener('click', () => {
      action.run();
      dismiss(node);
    });
    node.appendChild(b);
  }
  const x = h('button', { class: 'toast-x', 'aria-label': t('Dismiss'), title: t('Dismiss') }, '×');
  x.addEventListener('click', () => dismiss(node));
  node.appendChild(x);
  // Hovering keeps it on screen.
  node.addEventListener('pointerenter', () => clearTimeout(node._timer));
  node.addEventListener('pointerleave', () => arm(node));
  queue.push(node);
  pump();
  return node;
}
