// Docks (REQ-UI-05, REQ-SHL-09): left, right and bottom dock areas with tabbed panels (left dock
// tabs at the bottom, as in the reference layout), dock title bars, floating windows and moving a
// panel between areas. 2.0 tiles them: drag a tab to any edge (or to the lower half of an open
// area to show two panels at once), collapse an area to a rail of icons, and the sizes are kept.
// In the Modern layout the modeless tool editors open as docked panels, never over the image.
// Layouts are saved with the project.

import { h, clear, draggable } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';
import { buttonSpec } from './dialogs.js';
import { t, tc } from '../i18n/index.js';

const DRAG_TYPE = 'application/x-gw-panel';

export class DockArea {
  constructor(dm, side) {
    this.dm = dm;
    this.side = side;
    this.panels = [];
    this.active = null;
    this.second = null; // a second panel shown beside the active one (split, REQ-SHL-09)
    this.collapsed = false;
    this.el = h('div', { class: `dock dock-${side}`, role: 'complementary', 'aria-label': t('{side, select, left {left dock} right {right dock} other {bottom dock}}', { side }), 'data-id': `dock:${side}` });
    this.titleBar = h('div', { class: 'dock-title' });
    this.content = h('div', { class: 'dock-content' });
    this.splitBar = h('div', { class: 'dock-split', role: 'separator', tabindex: '0', 'aria-label': t('Resize the two panels in the {side, select, left {left} right {right} other {bottom}} dock', { side }), hidden: true });
    this.title2 = h('div', { class: 'dock-title dock-title2' });
    this.content2 = h('div', { class: 'dock-content dock-content2' });
    this.secondBox = h('div', { class: 'dock-second', hidden: true }, this.title2, this.content2);
    this.tabs = h('div', { class: 'dock-tabs', role: 'tablist' });
    this.body = h('div', { class: 'dock-body' }, this.content, this.splitBar, this.secondBox);
    if (side === 'bottom') this.el.append(this.tabs, this.titleBar, this.body);
    else this.el.append(this.titleBar, this.body, this.tabs);
    this.el.hidden = true;
    this._bindSplit();
  }

  add(p, activate = true) {
    if (!this.panels.includes(p)) this.panels.push(p);
    p.area = this;
    if (this.second === p) this.second = null;
    if (activate || !this.active) this.active = p;
    this.collapsed = activate ? false : this.collapsed;
    this.render();
  }

  remove(p) {
    this.panels = this.panels.filter((x) => x !== p);
    if (this.second === p) this.second = null;
    if (this.active === p) this.active = this.panels.find((x) => x !== this.second) ?? null;
    if (!this.active && this.second) {
      this.active = this.second;
      this.second = null;
    }
    this.render();
  }

  /** Show p beside the active panel (the lower half of a side dock, the right half of the bottom). */
  splitWith(p) {
    if (p.area !== this) {
      this.dm.unfloat(p);
      p.area?.remove(p);
      if (!this.panels.includes(p)) this.panels.push(p);
      p.area = this;
    }
    if (!this.active || this.active === p) this.active = this.panels.find((x) => x !== p) ?? p;
    this.second = this.active === p ? null : p;
    this.collapsed = false;
    this.render();
  }

  unsplit() {
    this.second = null;
    this.render();
  }

  setCollapsed(v) {
    this.collapsed = !!v;
    this.render();
    this.dm.saveSizes();
  }

  render() {
    clear(this.tabs);
    clear(this.titleBar);
    clear(this.title2);
    this.el.hidden = !this.panels.length;
    this.el.classList.toggle('collapsed', this.collapsed);
    this.el.classList.toggle('split', !!this.second && !this.collapsed);
    for (const p of this.panels) {
      const shown = p === this.active || p === this.second;
      const tabBtn = h('button', { class: ['dock-tab', shown && 'active'], role: 'tab', draggable: 'true', 'aria-selected': String(shown), 'data-id': `dock:panel:${p.id}`, title: this.collapsed ? p.title : null }, icon(p.icon), h('span', {}, p.title));
      tabBtn.addEventListener('click', () => {
        if (p !== this.second) this.active = p;
        this.collapsed = false;
        this.render();
      });
      tabBtn.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(DRAG_TYPE, p.id);
        e.dataTransfer.effectAllowed = 'move';
        this.dm.dragStart(p);
      });
      tabBtn.addEventListener('dragend', () => this.dm.dragEnd());
      this.tabs.appendChild(tabBtn);
    }
    if (this.active) {
      this.titleBar.append(...this.titleControls(this.active, false));
      if (this.content.firstChild !== this.active.el) {
        clear(this.content);
        this.content.appendChild(this.active.el);
        this.content.scrollTo(0, 0); // a panel opens at its top-left, not where the last one was scrolled (GUI-050)
      }
      this.active.onShow?.();
    } else clear(this.content);
    const two = !!this.second && !this.collapsed;
    this.splitBar.hidden = !two;
    this.secondBox.hidden = !two;
    if (two) {
      this.title2.append(...this.titleControls(this.second, true));
      if (this.content2.firstChild !== this.second.el) {
        clear(this.content2);
        this.content2.appendChild(this.second.el);
        this.content2.scrollTo(0, 0);
      }
      this.second.onShow?.();
    } else clear(this.content2);
    this.dm.app.emit('layout');
  }

  titleControls(p, isSecond) {
    const menuBtn = h('button', { class: 'dock-btn', title: t('Dock position'), 'aria-label': t('{panel} position', { panel: p.title }), 'data-id': `dock:menu:${p.id}` }, icon('dock', 14));
    menuBtn.addEventListener('click', () => {
      const others = this.panels.filter((x) => x !== this.active && x !== this.second);
      const items = [
        { label: t('Dock Left'), run: () => this.dm.move(p, 'left') },
        { label: t('Dock Right'), run: () => this.dm.move(p, 'right') },
        { label: t('Dock Bottom'), run: () => this.dm.move(p, 'bottom') },
        { label: t('Float'), run: () => this.dm.float(p) },
        '-',
      ];
      if (isSecond) items.push({ label: t('Back to a Tab'), run: () => this.unsplit() });
      else if (others.length) items.push({ label: this.side === 'bottom' ? t('Show Beside') : t('Show Below'), items: others.map((o) => ({ label: o.title, run: () => this.splitWith(o) })) });
      items.push({ label: t('Collapse to Icons'), run: () => this.setCollapsed(true) });
      openMenu(items, this.dm.app, { anchor: menuBtn });
    });
    const collapse = h('button', { class: 'dock-btn', title: t('Collapse to icons'), 'aria-label': t('Collapse the {side, select, left {left} right {right} other {bottom}} dock', { side: this.side }), 'data-id': `dock:collapse:${this.side}` }, this.side === 'right' ? '›' : this.side === 'left' ? '‹' : '⌄');
    collapse.addEventListener('click', () => this.setCollapsed(true));
    const close = h('button', { class: 'dock-btn', title: t('Close'), 'aria-label': t('Close {panel}', { panel: p.title }) }, icon('close', 14));
    close.addEventListener('click', () => this.dm.close(p));
    // The position menu stays the first button, as in 1.x.
    return [h('span', { class: 'dock-title-text' }, this.titleText(p)), menuBtn, isSecond ? null : collapse, close].filter(Boolean);
  }

  titleText(p) {
    return p.title;
  }

  _bindSplit() {
    const s = this.splitBar;
    const vertical = this.side !== 'bottom';
    const set = (frac) => {
      const f = Math.max(0.15, Math.min(0.85, frac));
      this.content.style.flex = `${f} 1 0`;
      this.secondBox.style.flex = `${1 - f} 1 0`;
      this.dm.app.renderer?.invalidate();
    };
    s.addEventListener('pointerdown', (e) => {
      s.setPointerCapture(e.pointerId);
      const r = this.body.getBoundingClientRect();
      const move = (ev) => set(vertical ? (ev.clientY - r.top) / r.height : (ev.clientX - r.left) / r.width);
      const up = () => {
        s.removeEventListener('pointermove', move);
        s.removeEventListener('pointerup', up);
      };
      s.addEventListener('pointermove', move);
      s.addEventListener('pointerup', up);
    });
    s.addEventListener('keydown', (e) => {
      const cur = this.content.getBoundingClientRect()[vertical ? 'height' : 'width'] / Math.max(1, this.body.getBoundingClientRect()[vertical ? 'height' : 'width']);
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') set(cur - 0.05);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') set(cur + 0.05);
    });
  }
}

export class DockManager {
  constructor(app, mp) {
    this.app = app;
    this.mp = mp;
    this.areas = { left: new DockArea(this, 'left'), right: new DockArea(this, 'right'), bottom: new DockArea(this, 'bottom') };
    this.registry = new Map();
    this.floating = new Set();
    this.restoreSizes();
  }

  /** Register a panel factory: {id, title, icon, create(app, mp) → element, home}. */
  register(spec) {
    this.registry.set(spec.id, { ...spec, spec, el: null, area: null });
  }

  panel(id) {
    const p = this.registry.get(id);
    if (!p) throw new Error(`unknown dock panel ${id}`);
    if (!p.el) {
      p.el = h('div', { class: 'dock-panel', 'data-id': `panel:${id}` });
      p.api = p.create(this.app, this.mp, p.el);
      p.onShow = () => p.api?.onShow?.();
    }
    return p;
  }

  show(id, side) {
    const p = this.panel(id);
    if (p.floatWin) {
      p.floatWin.style.zIndex = String(++DockManager.z);
      return p;
    }
    const area = p.area ?? this.areas[side ?? p.home ?? 'left'];
    if (area.second === p) {
      area.collapsed = false;
      area.render();
    } else area.add(p, true);
    return p;
  }

  isOpen(id) {
    const p = this.registry.get(id);
    if (!p) return false; // not registered (yet) in this Multiport (GUI-042)
    return !!(((p.area?.active === p || p.area?.second === p) && !p.area.collapsed) || p.floatWin);
  }

  toggle(id, side) {
    const p = this.registry.get(id);
    if (p?.area && (p.area.active === p || p.area.second === p) && !p.area.collapsed) this.close(p);
    else this.show(id, side);
  }

  move(p, side) {
    this.unfloat(p);
    p.area?.remove(p);
    this.areas[side].add(p, true);
  }

  close(p) {
    this.unfloat(p);
    p.area?.remove(p);
    p.area = null;
    // A tool editor hosted in the dock (Modern layout) ends with its panel.
    if (p.transient) {
      this.registry.delete(p.id);
      p.onClose?.();
    }
  }

  float(p) {
    p.area?.remove(p);
    p.area = null;
    const win = h('div', { class: 'float-win', role: 'dialog', 'aria-label': p.title, style: { left: '200px', top: '140px', zIndex: String(++DockManager.z) } });
    const bar = h('div', { class: 'float-title' }, h('span', {}, p.title));
    const dockBack = h('button', { class: 'dock-btn', title: tc('verb', 'Dock'), 'aria-label': t('Dock {panel}', { panel: p.title }) }, icon('dock', 14));
    dockBack.addEventListener('click', () => this.move(p, p.home ?? 'left'));
    const close = h('button', { class: 'dock-btn', title: t('Close'), 'aria-label': t('Close {panel}', { panel: p.title }) }, icon('close', 14));
    close.addEventListener('click', () => this.close(p));
    bar.append(dockBack, close);
    win.append(bar, p.el);
    document.body.appendChild(win);
    draggable(win, bar);
    win.addEventListener('pointerdown', () => (win.style.zIndex = String(++DockManager.z)));
    p.floatWin = win;
    p.onShow?.();
  }

  unfloat(p) {
    if (p.floatWin) {
      p.floatWin.remove();
      p.floatWin = null;
    }
  }

  // ---- drag a tab to an edge (REQ-SHL-09) ----
  dragStart(p) {
    const host = this.mp.main;
    if (!host) return;
    this.dragging = p;
    const zones = [];
    const zone = (side, split, label) => {
      const z = h('div', { class: `dock-drop dock-drop-${side}${split ? ' dock-drop-split' : ''}`, 'data-id': `dock:drop:${side}${split ? ':split' : ''}` }, h('span', {}, label));
      z.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes(DRAG_TYPE)) return;
        e.preventDefault();
        z.classList.add('over');
      });
      z.addEventListener('dragleave', () => z.classList.remove('over'));
      z.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = e.dataTransfer.getData(DRAG_TYPE);
        const panel = this.registry.get(id);
        this.dragEnd();
        if (!panel) return;
        if (split) this.areas[side].splitWith(panel);
        else this.move(panel, side);
      });
      zones.push(z);
    };
    zone('left', false, t('Dock left'));
    zone('right', false, t('Dock right'));
    zone('bottom', false, t('Dock bottom'));
    for (const side of ['left', 'right', 'bottom']) if (!this.areas[side].el.hidden && !this.areas[side].collapsed && !(this.areas[side].panels.length === 1 && this.areas[side].active === p)) zone(side, true, side === 'bottom' ? t('Beside') : t('Below'));
    this.dropLayer = h('div', { class: 'dock-drops' }, ...zones);
    // Split zones sit over their dock; edge zones over the panels.
    host.style.position = 'relative';
    host.appendChild(this.dropLayer);
    for (const z of zones) if (z.classList.contains('dock-drop-split')) {
      const side = /dock-drop-(left|right|bottom)/.exec(z.className)[1];
      const r = this.areas[side].el.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      Object.assign(z.style, side === 'bottom' ? { left: `${r.left - hr.left + r.width / 2}px`, top: `${r.top - hr.top}px`, width: `${r.width / 2}px`, height: `${r.height}px` } : { left: `${r.left - hr.left}px`, top: `${r.top - hr.top + r.height / 2}px`, width: `${r.width}px`, height: `${r.height / 2}px` });
    }
  }

  dragEnd() {
    this.dropLayer?.remove();
    this.dropLayer = null;
    this.dragging = null;
  }

  // ---- sizes (REQ-SHL-09) ----
  saveSizes() {
    const out = {};
    for (const [side, a] of Object.entries(this.areas)) {
      const v = a.el.style[side === 'bottom' ? 'height' : 'width'];
      out[side] = { size: v ? parseFloat(v) : null, collapsed: a.collapsed };
    }
    this.app.prefs.set('dockSizes', out);
  }

  restoreSizes() {
    const s = this.app.prefs.get('dockSizes') ?? {};
    for (const [side, v] of Object.entries(s)) {
      const a = this.areas[side];
      if (!a) continue;
      if (Number.isFinite(v?.size)) a.el.style[side === 'bottom' ? 'height' : 'width'] = `${v.size}px`;
      a.collapsed = !!v?.collapsed;
    }
  }

  // ---- tool editors in the dock (Modern layout, REQ-SHL-09) ----
  /** Host a modeless editor as a right-dock panel; resolves like modal(). */
  hostTool({ title, body, buttons, id, onApply, onHelp, onReset, width }) {
    return new Promise((resolve) => {
      const pid = `tool:${id ?? Math.random().toString(36).slice(2, 8)}`;
      const old = this.registry.get(pid);
      if (old) this.close(old);
      const wrap = h('div', { class: 'tool-panel', 'data-id': id ? `dialog:${id}` : null, role: 'region', 'aria-label': title });
      const btns = h('div', { class: 'dlg-buttons' });
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        const p = this.registry.get(pid);
        if (p) {
          p.onClose = null;
          this.close(p);
        }
        resolve(v);
      };
      const add = (label, fn, cls) => {
        const b = h('button', { class: ['btn', cls] }, label);
        b.addEventListener('click', fn);
        btns.appendChild(b);
      };
      if (onHelp) add(t('Help'), onHelp, 'btn-left');
      if (onReset) add(t('Reset'), onReset, 'btn-left');
      // The same buttons as modal() (string or {label, value}), so a docked editor resolves the same way.
      for (const s of buttons.map(buttonSpec)) add(s.label, () => finish(s.value), s.primary ? 'btn-primary' : null);
      if (onApply) add(t('Apply'), onApply);
      wrap.append(h('div', { class: 'tool-panel-body' }, body), btns);
      wrap.finish = finish;
      this.register({ id: pid, title, icon: 'gear', home: 'right', transient: true, create: (a, m, el) => el.appendChild(wrap) });
      const p = this.panel(pid);
      p.transient = true;
      p.onClose = () => finish(null);
      this.show(pid, 'right');
      // A wide editor (a table, a form) widens the dock up to 40 % of the window, never narrows it (GUI-035).
      const a = this.areas.right;
      const want = Math.min(Math.max(0, (width ?? 0) - 40), Math.round(innerWidth * 0.4));
      if (a && want > a.el.getBoundingClientRect().width) {
        a.el.style.width = `${want}px`;
        this.app.desktop?.layout?.();
      }
    });
  }

  layout() {
    const out = {};
    for (const [id, p] of this.registry) if ((p.area || p.floatWin) && !p.transient) out[id] = p.floatWin ? 'float' : p.area.second === p ? `${p.area.side}:split` : p.area.side;
    return out;
  }

  restore(layout) {
    const splits = [];
    for (const [id, side] of Object.entries(layout ?? {})) {
      if (!this.registry.has(id)) continue;
      if (side === 'float') this.float(this.panel(id));
      else if (side.endsWith(':split')) splits.push([id, side.split(':')[0]]);
      else this.show(id, side);
    }
    for (const [id, side] of splits) this.areas[side].splitWith(this.panel(id));
  }
}
DockManager.z = 50;
