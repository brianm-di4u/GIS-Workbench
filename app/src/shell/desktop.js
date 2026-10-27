// In-page window manager: the Workspace window and one or more Multiport windows, tiled
// side by side or shown as tabs (Window ▸ Tile / Tabs); double-click a title to maximise.

import { h, clear } from './dom.js';
import { Multiport } from './multiport.js';
import { Workspace } from './workspace.js';

export class Desktop {
  constructor(app, host) {
    this.app = app;
    this.el = h('div', { class: 'desktop', 'data-arrange': 'tile' });
    this.tabsBar = h('div', { class: 'desk-tabs', role: 'tablist', hidden: true });
    host.append(this.tabsBar, this.el);
    this.multiports = [];
    this.maximised = null;
    this.arrange = app.prefs.get('arrange') ?? 'tile';
  }

  init() {
    this.workspace = new Workspace(this.app);
    this.wsSplit = h('div', { class: 'splitter splitter-v desk-split', role: 'separator', tabindex: '0', 'aria-label': 'Resize the Workspace window', 'aria-orientation': 'vertical', 'aria-valuemin': '220', 'aria-valuemax': '2000', 'aria-valuenow': '400' });
    this._bindSplit();
    this.layout();
  }

  addMultiport(id) {
    const mp = new Multiport(this.app, id);
    this.multiports.push(mp);
    mp.buildPanes();
    this.activeMp = mp;
    this.layout();
    return mp;
  }

  removeMultiport(mp) {
    for (const p of mp.panes) p.dispose();
    this.multiports = this.multiports.filter((m) => m !== mp);
    if (this.activeMp === mp) this.activeMp = this.multiports[0] ?? null;
    this.layout();
  }

  focus(win) {
    if (this.arrange === 'tabs') this.current = win;
    if (win instanceof Multiport) this.activeMp = win;
    this.layout();
    win.el.querySelector('.pane, button, [tabindex]')?.focus({ preventScroll: true });
  }

  toggleMaximise(win) {
    this.maximised = this.maximised === win ? null : win;
    this.layout();
  }

  setArrange(a) {
    this.arrange = a;
    this.app.prefs.set('arrange', a);
    this.maximised = null;
    this.layout();
  }

  windows() {
    return [this.workspace, ...this.multiports];
  }

  layout() {
    clear(this.el);
    this.el.dataset.arrange = this.maximised ? 'max' : this.arrange;
    const wins = this.windows();
    this.tabsBar.hidden = this.arrange !== 'tabs' || !!this.maximised;
    if (this.maximised) {
      this.el.appendChild(this.maximised.el);
    } else if (this.arrange === 'tabs') {
      clear(this.tabsBar);
      this.current ??= this.activeMp ?? this.workspace;
      for (const w of wins) {
        const label = w === this.workspace ? 'Workspace' : w.rec?.name ?? 'Multiport';
        const b = h('button', { class: ['desk-tab', w === this.current && 'active'], role: 'tab', 'aria-selected': String(w === this.current) }, label);
        b.addEventListener('click', () => {
          this.current = w;
          this.layout();
        });
        this.tabsBar.appendChild(b);
      }
      this.el.appendChild(this.current.el);
    } else {
      this.el.append(this.workspace.el, this.wsSplit, ...this.multiports.map((m) => m.el));
      this.workspace.el.style.width = `${this.app.prefs.get('workspaceWidth') ?? 400}px`;
      this.wsSplit.setAttribute('aria-valuenow', String(this.app.prefs.get('workspaceWidth') ?? 400));
    }
    this.app.renderer?.invalidate();
    this.app.emit('layout');
  }

  _bindSplit() {
    const s = this.wsSplit;
    const set = (w) => {
      const v = Math.max(220, Math.min(window.innerWidth - 400, w));
      this.workspace.el.style.width = `${v}px`;
      s.setAttribute('aria-valuenow', String(Math.round(v)));
      this.app.prefs.set('workspaceWidth', Math.round(v));
      this.app.renderer.invalidate();
    };
    s.addEventListener('pointerdown', (e) => {
      s.setPointerCapture(e.pointerId);
      const move = (ev) => set(ev.clientX - this.workspace.el.getBoundingClientRect().left);
      const up = () => {
        s.removeEventListener('pointermove', move);
        s.removeEventListener('pointerup', up);
      };
      s.addEventListener('pointermove', move);
      s.addEventListener('pointerup', up);
    });
    s.addEventListener('keydown', (e) => {
      const w = this.workspace.el.getBoundingClientRect().width;
      if (e.key === 'ArrowLeft') set(w - 20);
      if (e.key === 'ArrowRight') set(w + 20);
    });
  }
}
