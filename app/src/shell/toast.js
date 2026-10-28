// Snackbars (REQ-SHL-07): transient status messages with at most one action, announced to screen
// readers through an aria-live region. At most MAX_VISIBLE show at once, bottom centre above the
// status bar; the rest wait their turn, so messages never pile up over the image. A message that
// is already showing is refreshed instead of repeated.

import { h } from './dom.js';

let host;
let live;
const MAX_VISIBLE = 3;
const queue = [];
const showing = new Set();

function ensure() {
  if (host) return;
  host = h('div', { class: 'toasts' });
  live = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
  document.body.append(host, live);
}

/** Messages that ask the user to do something first (open, select, draw…): guidance, not failures (GUI-019). */
export const STEP_FIRST = /\bfirst\b|^(select|open|draw|give) |no AI connection is set up/i;

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

export function toast(message, { kind = 'info', ms = 3500, action } = {}) {
  if (kind === 'error' && STEP_FIRST.test(message)) kind = 'warn';
  ensure();
  // The same message already on screen or waiting: show it longer instead of twice.
  for (const t of [...showing, ...queue]) {
    if (t._message === message && t._kind === kind) {
      if (showing.has(t)) arm(t);
      return t;
    }
  }
  const t = h('div', { class: ['toast', `toast-${kind}`], role: kind === 'error' ? 'alert' : null }, h('span', {}, message));
  t._message = message;
  t._kind = kind;
  // A message with an action stays long enough to use it.
  t._ms = action ? Math.max(ms, 8000) : ms;
  if (action) {
    const b = h('button', { class: 'btn btn-small toast-action' }, action.label);
    b.addEventListener('click', () => {
      action.run();
      dismiss(t);
    });
    t.appendChild(b);
  }
  const x = h('button', { class: 'toast-x', 'aria-label': 'Dismiss', title: 'Dismiss' }, '×');
  x.addEventListener('click', () => dismiss(t));
  t.appendChild(x);
  // Hovering keeps it on screen.
  t.addEventListener('pointerenter', () => clearTimeout(t._timer));
  t.addEventListener('pointerleave', () => arm(t));
  queue.push(t);
  pump();
  return t;
}
