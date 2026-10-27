// Transient status messages, announced to screen readers through an aria-live region.

import { h } from './dom.js';

let host;
let live;

function ensure() {
  if (host) return;
  host = h('div', { class: 'toasts' });
  live = h('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
  document.body.append(host, live);
}

export function toast(message, { kind = 'info', ms = 3500, action } = {}) {
  ensure();
  const t = h('div', { class: ['toast', `toast-${kind}`], role: kind === 'error' ? 'alert' : null }, h('span', {}, message));
  if (action) {
    const b = h('button', { class: 'btn btn-small' }, action.label);
    b.addEventListener('click', () => {
      action.run();
      t.remove();
    });
    t.appendChild(b);
  }
  host.appendChild(t);
  live.textContent = message;
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
  return t;
}
