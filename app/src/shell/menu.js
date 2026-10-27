// Cascading drop-down and context menus. Items are data:
//   { label, icon?, key?, run?, cmd?, checked?, disabled?, items?: [...] } or '-' for a rule.
// Keyboard: arrows, Enter/Space, Esc; focus returns to the opener.

import { h, clear, keyLabel } from './dom.js';
import { icon } from './icons.js';

let open = null;

export function closeMenus() {
  if (open) {
    const { el, onClose, returnFocus } = open;
    open = null;
    el.remove();
    onClose?.();
    returnFocus?.focus?.();
  }
}

function resolve(item, app) {
  if (typeof item === 'string') return item;
  if (item.cmd && app) {
    const c = app.commands.get(item.cmd);
    if (c) {
      return {
        ...item,
        label: item.label ?? c.label,
        icon: item.icon ?? c.icon,
        key: item.key ?? c.key,
        disabled: item.disabled ?? (c.enabled ? !c.enabled() : false),
        checked: item.checked ?? (c.checked ? c.checked() : undefined),
        run: () => app.commands.run(item.cmd, item.args),
        id: item.cmd,
      };
    }
  }
  return item;
}

function build(items, app, level, close) {
  const ul = h('div', { class: 'menu', role: 'menu', tabindex: '-1' });
  let sub = null;
  const rows = [];
  for (const raw of items) {
    const it = resolve(raw, app);
    if (it === '-') {
      ul.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (it.hidden) continue;
    const hasSub = Array.isArray(it.items) && it.items.length;
    const row = h(
      'div',
      {
        class: ['menu-item', it.disabled && 'disabled'],
        role: it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': it.checked !== undefined ? String(!!it.checked) : null,
        'aria-disabled': it.disabled ? 'true' : null,
        'aria-haspopup': hasSub ? 'menu' : null,
        tabindex: '-1',
        'data-id': it.id ?? it.cmd ?? null,
      },
      h('span', { class: 'menu-check' }, it.checked ? '✓' : ''),
      h('span', { class: 'menu-icon' }, it.icon ? icon(it.icon) : ''),
      h('span', { class: 'menu-label' }, it.label),
      h('span', { class: 'menu-key' }, hasSub ? '▸' : keyLabel(it.key)),
    );
    const openSub = () => {
      if (sub) sub.remove();
      sub = null;
      if (!hasSub) return;
      sub = build(it.items, app, level + 1, close);
      // In the menu host, so closing the menu also closes its open submenus (GUI-025).
      (ul.parentElement ?? document.body).appendChild(sub);
      const r = row.getBoundingClientRect();
      place(sub, r.right - 2, r.top - 3, r.left);
    };
    row.addEventListener('pointerenter', () => {
      row.focus();
      openSub();
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) return;
      if (hasSub) return openSub();
      close();
      try {
        it.run?.();
      } catch (err) {
        console.error(err);
      }
    });
    row.addEventListener('keydown', (e) => {
      const i = rows.indexOf(row);
      if (e.key === 'ArrowDown') rows[(i + 1) % rows.length]?.focus();
      else if (e.key === 'ArrowUp') rows[(i - 1 + rows.length) % rows.length]?.focus();
      else if (e.key === 'ArrowRight' && hasSub) {
        openSub();
        sub?.querySelector('.menu-item')?.focus();
      } else if (e.key === 'ArrowLeft' && level > 0) {
        ul.remove();
      } else if (e.key === 'Enter' || e.key === ' ') row.click();
      else if (e.key === 'Escape') close();
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    rows.push(row);
    ul.appendChild(row);
  }
  ul._rows = rows;
  ul._cleanup = () => sub?.remove();
  return ul;
}

function place(el, x, y, altX) {
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + r.width > window.innerWidth - 4) left = altX !== undefined ? altX - r.width + 2 : window.innerWidth - r.width - 4;
  if (top + r.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - r.height - 4);
  el.style.left = `${Math.max(2, left)}px`;
  el.style.top = `${Math.max(2, top)}px`;
}

/** Open a menu at a point (context menu) or under an element (drop-down). */
export function openMenu(items, app, { x, y, anchor, onClose, focusFirst = true } = {}) {
  closeMenus();
  const host = h('div', { class: 'menu-host' });
  const close = () => closeMenus();
  const m = build(items, app, 0, close);
  host.appendChild(m);
  document.body.appendChild(host);
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    place(m, r.left, r.bottom);
  } else place(m, x, y);
  open = { el: host, onClose, returnFocus: anchor ?? document.activeElement };
  if (focusFirst) setTimeout(() => m._rows[0]?.focus(), 0);
  return host;
}

document.addEventListener(
  'pointerdown',
  (e) => {
    if (open && !e.target.closest('.menu')) closeMenus();
  },
  true,
);
// Esc closes an open menu wherever focus is (after a right-click it stays on the panel) (GUI-026).
document.addEventListener(
  'keydown',
  (e) => {
    if (!open || e.target.closest?.('.menu')) return;
    if (e.key === 'Escape') closeMenus();
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') open.el.querySelector('.menu-item')?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);
window.addEventListener('blur', () => closeMenus());
window.addEventListener('resize', () => closeMenus());

export function menuBar(menus, app) {
  // menus: [{label, items}] ; Alt-key menu bar for the Workspace window.
  const bar = h('div', { class: 'menubar', role: 'menubar' });
  for (const m of menus) {
    const b = h('button', { class: 'menubar-item', role: 'menuitem', 'aria-haspopup': 'menu', 'data-id': `menu:${m.label}` }, m.label);
    b.addEventListener('click', () => openMenu(typeof m.items === 'function' ? m.items() : m.items, app, { anchor: b }));
    b.addEventListener('pointerenter', () => {
      if (open && open.el && document.activeElement?.closest?.('.menu')) b.click();
    });
    bar.appendChild(b);
  }
  return bar;
}

export { clear };
