// Uniform dialogs (REQ-UI-14): grey body, section rules, Help/Reset/Apply/OK/Cancel.
// Promise-based; Esc cancels, Enter confirms; focus returns to the opener.

import { h, draggable } from './dom.js';
import { icon } from './icons.js';

const stack = [];

export function modal({ title, body, buttons = ['OK', 'Cancel'], width = 460, onHelp, onReset, onApply, marking, modeless = false, id } = {}) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const titleText = marking ? `${title} - ${marking}` : title;
    const btns = h('div', { class: 'dlg-buttons' });
    const backdrop = modeless ? null : h('div', { class: 'dlg-backdrop' });
    const dlg = h(
      'div',
      { class: 'dlg', role: 'dialog', 'aria-modal': modeless ? 'false' : 'true', 'aria-label': titleText, style: { width: `${width}px` }, 'data-id': id ? `dialog:${id}` : null },
      h('div', { class: 'dlg-title' }, h('span', { class: 'dlg-title-text' }, titleText), h('button', { class: 'dlg-x', 'aria-label': 'Close', title: 'Close' }, icon('close'))),
      h('div', { class: 'dlg-body' }, body),
      btns,
    );
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.remove();
      backdrop?.remove();
      stack.splice(stack.indexOf(dlg), 1);
      document.removeEventListener('keydown', onKey, true);
      opener?.focus?.();
      resolve(v);
    };
    const add = (label, fn, cls) => {
      const b = h('button', { class: ['btn', cls] }, label);
      b.addEventListener('click', fn);
      btns.appendChild(b);
      return b;
    };
    if (onHelp) add('Help', onHelp, 'btn-left');
    if (onReset) add('Reset', onReset, 'btn-left');
    for (const b of buttons) {
      const label = typeof b === 'string' ? b : b.label;
      const value = typeof b === 'string' ? b : b.value ?? b.label;
      const primary = typeof b === 'object' ? b.primary : label === buttons[0];
      add(label, () => finish(value), primary ? 'btn-primary' : null);
    }
    if (onApply) add('Apply', onApply);
    dlg.querySelector('.dlg-x').addEventListener('click', () => finish(null));
    const onKey = (e) => {
      if (stack[stack.length - 1] !== dlg) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === 'Enter' && !e.target.matches('textarea, button, [contenteditable]')) {
        e.preventDefault();
        finish(typeof buttons[0] === 'string' ? buttons[0] : buttons[0].value ?? buttons[0].label);
      }
    };
    document.addEventListener('keydown', onKey, true);
    if (backdrop) document.body.appendChild(backdrop);
    document.body.appendChild(dlg);
    stack.push(dlg);
    // Modeless dialogs cascade so several editors stay visible.
    const cascade = modeless ? 28 * (stack.filter((d) => d.getAttribute('aria-modal') === 'false').length - 1) : 0;
    dlg.style.left = `${Math.max(10, (window.innerWidth - dlg.offsetWidth) / 2 + cascade)}px`;
    dlg.style.top = `${Math.max(10, (window.innerHeight - dlg.offsetHeight) / 3 + cascade)}px`;
    draggable(dlg, dlg.querySelector('.dlg-title'));
    setTimeout(() => (dlg.querySelector('input,select,textarea,.dlg-body [tabindex]') ?? btns.querySelector('.btn-primary'))?.focus(), 0);
    dlg.finish = finish;
  });
}

export async function alertBox(title, message, marking) {
  await modal({ title, body: h('p', { class: 'dlg-msg' }, message), buttons: ['OK'], marking });
}

export async function confirmBox(title, message, { ok = 'OK', cancel = 'Cancel' } = {}) {
  const r = await modal({ title, body: h('p', { class: 'dlg-msg' }, message), buttons: [ok, cancel] });
  return r === ok;
}

export async function promptBox(title, label, value = '', { placeholder = '', hint = '' } = {}) {
  const input = h('input', { type: 'text', class: 'inp', value, placeholder, spellcheck: 'true', 'aria-label': label });
  const r = await modal({ title, body: h('div', {}, h('label', { class: 'fld' }, h('span', {}, label), input), hint ? h('p', { class: 'hint' }, hint) : null), buttons: ['OK', 'Cancel'] });
  return r === 'OK' ? input.value : null;
}

/** A labelled form row. */
export function field(label, control, hint) {
  return h('label', { class: 'fld' }, h('span', {}, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
}

export function section(title, ...kids) {
  return h('fieldset', { class: 'sec' }, h('legend', {}, title), ...kids);
}
