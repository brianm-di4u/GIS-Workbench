// Multiport window (REQ-UI-02, Appendix C §3): title with marking, QAT row with the
// contextual caption band, Ribbon, left/right/bottom docks, 1–4 panels, two-row status bar.

import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { Ribbon } from './ribbon.js';
import { DockManager } from './docks.js';
import { StatusBar } from './statusbar.js';
import { ImagePane } from './pane.js';
import { QAT } from './ribbon-data.js';

export const LAYOUTS = {
  '1x1': [1, 1],
  '1x2': [1, 2],
  '2x1': [2, 1],
  '2x2': [2, 2],
  '1x3': [1, 3],
  '3x1': [3, 1],
  '2x3': [2, 3],
  '3x3': [3, 3],
  '3x4': [3, 4],
  '4x4': [4, 4],
};

/** Smallest layout that holds n panels. */
export function layoutFor(n) {
  return n <= 1 ? '1x1' : n === 2 ? '1x2' : n === 3 ? '1x3' : n === 4 ? '2x2' : n <= 6 ? '2x3' : n <= 9 ? '3x3' : n <= 12 ? '3x4' : '4x4';
}

export class Multiport {
  constructor(app, id) {
    this.app = app;
    this.id = id;
    this.panes = [];
    this.activePane = null;
    this.title = h('span', { class: 'gwin-title-text' });
    const titleBar = h('div', { class: 'gwin-title', 'data-id': `win:${id}:title` }, icon('app', 16), this.title);
    titleBar.addEventListener('dblclick', () => app.desktop.toggleMaximise(this));
    this.qat = h('div', { class: 'qat', role: 'toolbar', 'aria-label': 'Quick Access Toolbar' });
    this.qatRow = h('div', { class: 'qat-row' }, this.qat);
    this.ribbon = new Ribbon(app, this);
    this.docks = new DockManager(app, this);
    this.grid = h('div', { class: 'panel-grid', role: 'group', 'aria-label': 'Panels' });
    this.status = new StatusBar(app, { id });
    this.main = h('div', { class: 'mp-main' }, this.docks.areas.left.el, h('div', { class: 'splitter splitter-v', 'data-side': 'left' }), this.grid, h('div', { class: 'splitter splitter-v', 'data-side': 'right' }), this.docks.areas.right.el);
    this.el = h(
      'section',
      { class: 'gwin multiport', 'aria-label': 'Multiport', 'data-id': `win:${id}` },
      titleBar,
      this.qatRow,
      this.ribbon.el,
      this.main,
      h('div', { class: 'splitter splitter-h', 'data-side': 'bottom' }),
      this.docks.areas.bottom.el,
      this.status.el,
    );
    this._splitters();
    this.renderQat();
    app.on('state', () => this.update());
    app.undo.on('change', () => this.renderQat());
  }

  get rec() {
    return this.app.store.get(this.id);
  }

  renderQat() {
    clear(this.qat);
    // The user's Quick Access Toolbar (REQ-UI-04); Customize always stays at the end.
    const list = [...(this.app.prefs.get('qat') ?? QAT).filter((x) => x === '-' || (x !== 'qat.customize' && this.app.commands.get(x))), 'qat.customize'];
    for (const id of list) {
      if (id === '-') {
        this.qat.appendChild(h('span', { class: 'qat-sep' }));
        continue;
      }
      const c = this.app.commands.get(id);
      const b = h('button', { class: 'qat-btn', title: `${c.label}${c.key ? ` (${c.key})` : ''}`, 'aria-label': c.label, 'data-id': `qat:${id}` }, icon(c.icon, 16));
      if (id === 'wb.toggle') b.appendChild(h('span', { class: 'qat-badge', 'data-id': 'qat:wb.count' }, String(this.app.feedback?.pageCount?.() || '')));
      b.disabled = !this.app.commands.enabled(id) && c.implemented;
      b.addEventListener('click', () => {
        this.app.commands.run(id);
      });
      this.qat.appendChild(b);
    }
  }

  setLayout(name) {
    const [rows, cols] = LAYOUTS[name] ?? LAYOUTS['1x1'];
    const n = rows * cols;
    const rec = this.rec;
    let ids = [...(rec.panes ?? [])];
    this.app.store.transact(`Layout ${name}`, (tx) => {
      while (ids.length < n) {
        const pid = tx.create('pane', { multiport: this.id, layers: [], activeLayer: null });
        ids.push(pid);
      }
      tx.set(this.id, 'panes', ids);
      tx.set(this.id, 'layout', name);
    });
    this.buildPanes();
  }

  buildPanes() {
    const rec = this.rec;
    const [rows, cols] = LAYOUTS[rec.layout] ?? LAYOUTS['1x1'];
    const n = rows * cols;
    const want = (rec.panes ?? []).slice(0, n);
    // Keep existing pane objects, dispose hidden ones from the grid (records stay).
    for (const p of this.panes) if (!want.includes(p.id)) p.dispose();
    const keep = new Map(this.panes.filter((p) => want.includes(p.id)).map((p) => [p.id, p]));
    this.panes = want.map((pid) => keep.get(pid) ?? new ImagePane(this.app, this, pid));
    if (!this.panes.includes(this.activePane)) this.activePane = this.panes[0];
    clear(this.grid);
    this.tabs?.remove();
    this.tabs = null;
    if (rec.tabbed && this.panes.length > 1) {
      // Tabbed panels (REQ-UI-02): one panel at a time under a tab strip.
      this.tabs = h('div', { class: 'panel-tabs', role: 'tablist', 'aria-label': 'Panels' });
      this.panes.forEach((p, i) => {
        const b = h('button', { class: ['panel-tab', p === this.activePane && 'active'], role: 'tab', 'aria-selected': String(p === this.activePane), 'data-id': `panel-tab:${p.id}` }, `Panel ${i + 1}`);
        b.addEventListener('click', () => {
          this.activePane = p;
          this.buildPanes();
        });
        this.tabs.appendChild(b);
      });
      this.grid.style.gridTemplateRows = 'auto 1fr';
      this.grid.style.gridTemplateColumns = '1fr';
      this.grid.append(this.tabs, this.activePane.el);
    } else {
      this.grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      this.grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      for (const p of this.panes) this.grid.appendChild(p.el);
    }
    this.app.renderer.invalidate();
    this.app.emit('state');
  }

  setActivePane(p) {
    if (this.activePane === p) return;
    this.activePane = p;
    this.app.desktop.activeMp = this;
    for (const q of this.panes) q.invalidate();
    this.app.emit('state');
  }

  update() {
    const m = this.app.markingSuffix(this);
    const t = `${this.rec?.name ?? 'Multiport'} (${m})`;
    if (this.title.textContent !== t) this.title.textContent = t;
    this.ribbon.update();
    for (const b of this.qat.querySelectorAll('.qat-btn')) {
      const id = b.dataset.id.slice(4);
      const c = this.app.commands.get(id);
      if (c) b.disabled = !this.app.commands.enabled(id) && c.implemented;
    }
    const badge = this.qat.querySelector('.qat-badge');
    if (badge) badge.textContent = String(this.app.feedback?.pageCount?.() || '');
  }

  _splitters() {
    for (const s of this.el.querySelectorAll('.splitter')) {
      s.setAttribute('role', 'separator');
      s.tabIndex = 0;
      const side = s.dataset.side;
      const area = this.docks.areas[side];
      const dim = side === 'bottom' ? 'height' : 'width';
      const max = side === 'bottom' ? 600 : 700;
      s.setAttribute('aria-orientation', side === 'bottom' ? 'horizontal' : 'vertical');
      s.setAttribute('aria-label', `Resize the ${side} dock`);
      s.setAttribute('aria-valuemin', '120');
      s.setAttribute('aria-valuemax', String(max));
      const report = () => s.setAttribute('aria-valuenow', String(Math.round(area.el.getBoundingClientRect()[dim]) || 120));
      report();
      this.app.on('layout', report);
      const resize = (delta) => {
        const cur = area.el.getBoundingClientRect()[dim];
        const v = Math.max(120, Math.min(max, cur + delta));
        area.el.style[dim] = `${v}px`;
        report();
        this.app.renderer.invalidate();
      };
      s.addEventListener('pointerdown', (e) => {
        s.setPointerCapture(e.pointerId);
        let last = side === 'bottom' ? e.clientY : e.clientX;
        const move = (ev) => {
          const cur = side === 'bottom' ? ev.clientY : ev.clientX;
          const d = cur - last;
          last = cur;
          resize(side === 'left' ? d : -d);
        };
        const up = () => {
          s.removeEventListener('pointermove', move);
          s.removeEventListener('pointerup', up);
        };
        s.addEventListener('pointermove', move);
        s.addEventListener('pointerup', up);
      });
      s.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 40 : 10;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') resize(side === 'left' ? -step : step);
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') resize(side === 'left' ? step : -step);
      });
    }
    // Hide splitters next to empty docks.
    const sync = () => {
      for (const s of this.el.querySelectorAll('.splitter')) s.hidden = this.docks.areas[s.dataset.side].el.hidden;
    };
    this.app.on('layout', sync);
    sync();
  }
}
