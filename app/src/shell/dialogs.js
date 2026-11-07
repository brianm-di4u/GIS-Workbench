// Uniform dialogs (REQ-UI-14): grey body, section rules, Help/Reset/Apply/OK/Cancel.
// Promise-based; Esc cancels, Enter confirms; focus returns to the opener.
//
// Buttons (DN-62 L0): give each a label and a value, { label: t('Jump'), value: 'jump' }, and
// compare the value the promise resolves with; the first button is the default (Enter), Esc and ×
// resolve with null. A plain string button still works while callers convert: it shows the
// string translated (tr) and resolves with the string as given, so `r === 'OK'` keeps working.

import { h, draggable } from './dom.js';
import { icon } from './icons.js';
import { t, tr } from '../i18n/index.js';

/** {label, value, primary} of a button given as a string or an object; the first is primary unless another says it is. */
export function buttonSpec(b, i, all = []) {
  const first = i === 0 && !all.some((x, k) => k > 0 && x && typeof x === 'object' && x.primary);
  if (typeof b === 'string') return { label: tr(b), value: b, primary: first };
  return { label: b.label, value: b.value ?? b.label, primary: b.primary ?? first };
}

const stack = [];
let toolHost = null;

/** In the Modern layout modeless tool editors open as docked panels (REQ-SHL-09); fn returns null to decline. */
export function setToolHost(fn) {
  toolHost = fn;
}

export function modal({ title, body, buttons = ['OK', 'Cancel'], width = 460, onHelp, onReset, onApply, modeless = false, id } = {}) {
  if (modeless && toolHost) {
    const hosted = toolHost({ title, body, buttons, id, onApply, onHelp, onReset, width });
    if (hosted) return hosted;
  }
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const btns = h('div', { class: 'dlg-buttons' });
    const backdrop = modeless ? null : h('div', { class: 'dlg-backdrop' });
    const dlg = h(
      'div',
      { class: 'dlg', role: 'dialog', 'aria-modal': modeless ? 'false' : 'true', 'aria-label': title, style: { width: `${width}px` }, 'data-id': id ? `dialog:${id}` : null },
      h('div', { class: 'dlg-title' }, h('span', { class: 'dlg-title-text' }, title), h('button', { class: 'dlg-x', 'aria-label': t('Close'), title: t('Close') }, icon('close'))),
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
    if (onHelp) add(t('Help'), onHelp, 'btn-left');
    if (onReset) add(t('Reset'), onReset, 'btn-left');
    const specs = buttons.map(buttonSpec);
    for (const s of specs) add(s.label, () => finish(s.value), s.primary ? 'btn-primary' : null);
    if (onApply) add(t('Apply'), onApply);
    dlg.querySelector('.dlg-x').addEventListener('click', () => finish(null));
    const onKey = (e) => {
      if (stack[stack.length - 1] !== dlg) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      } else if (e.key === 'Enter' && !e.target.matches('textarea, button, [contenteditable]')) {
        e.preventDefault();
        finish(specs[0]?.value ?? null);
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

export async function alertBox(title, message) {
  await modal({ title, body: h('p', { class: 'dlg-msg' }, message), buttons: [{ label: t('OK'), value: 'ok' }] });
}

/** true when the user chose ok. ok and cancel are labels in the UI language (default OK / Cancel). */
export async function confirmBox(title, message, { ok, cancel } = {}) {
  const r = await modal({ title, body: h('p', { class: 'dlg-msg' }, message), buttons: [{ label: ok ?? t('OK'), value: 'ok' }, { label: cancel ?? t('Cancel'), value: 'cancel' }] });
  return r === 'ok';
}

export async function promptBox(title, label, value = '', { placeholder = '', hint = '' } = {}) {
  const input = h('input', { type: 'text', class: 'inp', value, placeholder, spellcheck: 'true', 'aria-label': label });
  const r = await modal({ title, body: h('div', {}, h('label', { class: 'fld' }, h('span', {}, label), input), hint ? h('p', { class: 'hint' }, hint) : null), buttons: [{ label: t('OK'), value: 'ok' }, { label: t('Cancel'), value: 'cancel' }] });
  return r === 'ok' ? input.value : null;
}

/** A labelled form row. */
export function field(label, control, hint) {
  return h('label', { class: 'fld' }, h('span', {}, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
}

export function section(title, ...kids) {
  return h('fieldset', { class: 'sec' }, h('legend', {}, title), ...kids);
}
