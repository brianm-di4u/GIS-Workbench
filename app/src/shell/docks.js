// Docks (REQ-UI-05): left, right and bottom dock areas with tabbed panels (left dock tabs at
// the bottom, as in the reference layout), dock title bars, floating windows and moving a
// panel between areas. Layouts are saved with the project.

import { h, clear, draggable } from './dom.js';
import { icon } from './icons.js';
import { openMenu } from './menu.js';

export class DockArea {
  constructor(dm, side) {
    this.dm = dm;
    this.side = side;
    this.panels = [];
    this.active = null;
    this.el = h('div', { class: `dock dock-${side}`, role: 'complementary', 'aria-label': `${side} dock`, 'data-id': `dock:${side}` });
    this.titleBar = h('div', { class: 'dock-title' });
    this.content = h('div', { class: 'dock-content' });
    this.tabs = h('div', { class: 'dock-tabs', role: 'tablist' });
    if (side === 'bottom') this.el.append(this.tabs, this.titleBar, this.content);
    else this.el.append(this.titleBar, this.content, this.tabs);
    this.el.hidden = true;
  }

  add(p, activate = true) {
    if (!this.panels.includes(p)) this.panels.push(p);
    p.area = this;
    if (activate || !this.active) this.active = p;
    this.render();
  }

  remove(p) {
    this.panels = this.panels.filter((x) => x !== p);
    if (this.active === p) this.active = this.panels[0] ?? null;
    this.render();
  }

  render() {
    clear(this.tabs);
    clear(this.titleBar);
    this.el.hidden = !this.panels.length;
    for (const p of this.panels) {
      const t = h('button', { class: ['dock-tab', p === this.active && 'active'], role: 'tab', 'aria-selected': String(p === this.active), 'data-id': `dock:panel:${p.id}` }, icon(p.icon), h('span', {}, p.title));
      t.addEventListener('click', () => {
        this.active = p;
        this.render();
      });
      this.tabs.appendChild(t);
    }
    if (this.active) {
      const p = this.active;
      const menuBtn = h('button', { class: 'dock-btn', title: 'Dock position', 'aria-label': `${p.title} position` }, icon('dock', 14));
      menuBtn.addEventListener('click', () =>
        openMenu(
          [
            { label: 'Dock Left', run: () => this.dm.move(p, 'left') },
            { label: 'Dock Right', run: () => this.dm.move(p, 'right') },
            { label: 'Dock Bottom', run: () => this.dm.move(p, 'bottom') },
            { label: 'Float', run: () => this.dm.float(p) },
          ],
          this.dm.app,
          { anchor: menuBtn },
        ),
      );
      const close = h('button', { class: 'dock-btn', title: 'Close', 'aria-label': `Close ${p.title}` }, icon('close', 14));
      close.addEventListener('click', () => this.dm.close(p));
      this.titleBar.append(h('span', { class: 'dock-title-text' }, this.titleText(p)), menuBtn, close);
      if (this.content.firstChild !== p.el) {
        clear(this.content);
        this.content.appendChild(p.el);
      }
      p.onShow?.();
    } else clear(this.content);
    this.dm.app.emit('layout');
  }

  titleText(p) {
    return p.marked ? `${p.title} - ${this.dm.app.markingSuffix()}` : p.title;
  }
}

export class DockManager {
  constructor(app, mp) {
    this.app = app;
    this.mp = mp;
    this.areas = { left: new DockArea(this, 'left'), right: new DockArea(this, 'right'), bottom: new DockArea(this, 'bottom') };
    this.registry = new Map();
    this.floating = new Set();
  }

  /** Register a panel factory: {id, title, icon, create(app, mp) → element, home, marked?}. */
  register(spec) {
    this.registry.set(spec.id, { ...spec, el: null, area: null });
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
    (p.area ?? this.areas[side ?? p.home ?? 'left']).add(p, true);
    return p;
  }

  isOpen(id) {
    const p = this.registry.get(id);
    return !!(p?.area?.active === p || p?.floatWin);
  }

  toggle(id, side) {
    const p = this.registry.get(id);
    if (p?.area && p.area.active === p) this.close(p);
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
  }

  float(p) {
    p.area?.remove(p);
    p.area = null;
    const win = h('div', { class: 'float-win', role: 'dialog', 'aria-label': p.title, style: { left: '200px', top: '140px', zIndex: String(++DockManager.z) } });
    const bar = h('div', { class: 'float-title' }, h('span', {}, p.marked ? `${p.title} - ${this.app.markingSuffix()}` : p.title));
    const dockBack = h('button', { class: 'dock-btn', title: 'Dock', 'aria-label': `Dock ${p.title}` }, icon('dock', 14));
    dockBack.addEventListener('click', () => this.move(p, p.home ?? 'left'));
    const close = h('button', { class: 'dock-btn', title: 'Close', 'aria-label': `Close ${p.title}` }, icon('close', 14));
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

  layout() {
    const out = {};
    for (const [id, p] of this.registry) if (p.area || p.floatWin) out[id] = p.floatWin ? 'float' : p.area.side;
    return out;
  }

  restore(layout) {
    for (const [id, side] of Object.entries(layout ?? {})) {
      if (!this.registry.has(id)) continue;
      if (side === 'float') this.float(this.panel(id));
      else this.show(id, side);
    }
  }
}
DockManager.z = 50;
