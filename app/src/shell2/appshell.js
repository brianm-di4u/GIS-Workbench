// Modern shell (REQ-SHL-01, REQ-SHL-02, REQ-SHL-13): an app bar and a navigation rail around the
// same desktop, Multiports, panes and command registry that the Classic layout uses. Only the
// chrome differs: in the Modern layout the Multiport's title bar, Quick Access Toolbar and Ribbon
// are hidden by CSS ([data-layout="modern"]) and the status bar shows one row. Switching layout
// is live and keeps the project, the view and the selection.

import { h, clear } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { openMenu } from '../shell/menu.js';
import { WORKSPACE_MENUS } from '../shell/ribbon-data.js';
import { applyTheme, themePref } from '../shell/theme.js';

/** Navigation rail: each item toggles a panel and shows whether it is open. */
const RAIL = [
  { id: 'catalog', label: 'Catalog', icon: 'globe', cmd: 'cat.panel', open: (app) => !!app.activeMp()?.docks.isOpen('catalog') },
  { id: 'data', label: 'Data', icon: 'list', cmd: 'win.workspace', open: (app) => !app.desktop.wsCollapsed },
  { id: 'layers', label: 'Layers', icon: 'layers', cmd: 'dock.layers', open: (app) => !!app.activeMp()?.docks.isOpen('layers') },
  { id: 'tools', label: 'Tools', icon: 'toolbox', cmd: 'dock.toolbox', open: (app) => !!app.activeMp()?.docks.isOpen('toolbox') },
  { id: 'measure', label: 'Measure', icon: 'ruler', cmd: 'men.log', open: (app) => !!app.activeMp()?.docks.isOpen('menlog') },
  { id: 'ai', label: 'AI', icon: 'ai', cmd: 'ai.assistant', open: (app) => !!app.activeMp()?.docks.isOpen('ai') },
  { id: 'recipes', label: 'Recipes', icon: 'template', cmd: 'rcp.open', open: (app) => !!app.activeMp()?.docks.isOpen('recipes') },
  { id: 'convert', label: 'Convert', icon: 'save', cmd: 'cnv.open', open: (app) => !!app.activeMp()?.docks.isOpen('convert') },
  {
    id: 'products',
    label: 'Products',
    icon: 'chip',
    menu: () => [{ cmd: 'chip.view' }, { cmd: 'chip.preset' }, { cmd: 'chip.markers' }, { cmd: 'hud.quickchip' }, { cmd: 'deck.export' }, '-', { cmd: 'snap.pptx' }, { cmd: 'snap.pdf' }, { cmd: 'snap.geopdf' }, { cmd: 'snap.kmz' }, '-', { cmd: 'hub.psd' }, { cmd: 'hub.pdf' }, { cmd: 'hub.glb' }, { cmd: 'hub.usdz' }, { cmd: 'hub.atak' }, '-', { cmd: 'report.template' }, { cmd: 'report.ai' }, { cmd: 'prod.finishing' }],
  },
];

/** The menus of the Workspace window, offered from the app bar's main menu. */
function mainMenu() {
  return WORKSPACE_MENUS.filter((m) => Array.isArray(m.items)).map((m) => ({ label: m.label, items: m.items }));
}

export class AppShell {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.bar = this.buildBar();
    this.rail = h('nav', { class: 'nav-rail', 'aria-label': 'Navigation', 'data-id': 'shell:rail' });
    this.row = h('div', { class: 'shell-row' });
    let t = 0;
    const refresh = () => {
      if (!t) t = setTimeout(() => ((t = 0), this.refresh()), 30);
    };
    app.on('state', refresh);
    app.on('layout', refresh);
    app.commands.on('change', refresh);
  }

  /** Put the shell around the desktop (called once the desktop exists). */
  mount() {
    const d = this.app.desktop;
    this.root.prepend(this.bar);
    this.root.appendChild(this.row);
    this.row.append(this.rail, d.el);
    this.renderRail();
    this.apply(this.app.layoutMode(), { initial: true });
  }

  buildBar() {
    const C = this.app.commands;
    const btn = (cmd, ic, label, extra = {}) => {
      const b = h('button', { class: ['ab-btn', extra.primary && 'ab-primary'], type: 'button', 'aria-label': label, 'data-id': `cmd:${cmd}`, ...extra.attrs }, icon(ic, 18), extra.text ? h('span', {}, extra.text) : null);
      b.addEventListener('click', () => C.run(cmd));
      return b;
    };
    const menuBtn = h('button', { class: 'ab-btn ab-menu', type: 'button', 'aria-label': 'Main menu', 'aria-haspopup': 'menu', 'data-id': 'shell:menu' }, h('span', { class: 'ab-burger', 'aria-hidden': 'true' }, '☰'));
    menuBtn.addEventListener('click', () => openMenu(mainMenu(), this.app, { anchor: menuBtn }));
    this.title = h('span', { class: 'ab-title' });
    const search = h('button', { class: 'ab-search', type: 'button', 'data-id': 'shell:search', 'aria-label': 'Search commands, layers and coordinates (Ctrl+K)' }, icon('search', 16), h('span', { class: 'ab-search-text' }, 'Search commands, layers or a coordinate'), h('kbd', {}, 'Ctrl K'));
    search.addEventListener('click', () => C.run('ui.palette'));
    this.persona = h('button', { class: 'ab-chip', type: 'button', 'data-id': 'shell:persona', 'aria-haspopup': 'menu' });
    this.persona.addEventListener('click', () => this.app.personas?.menu(this.persona));
    // Cycles Light → Dark → Follow system; the label says what is shown and what a click does (DN-60).
    const themeBtn = h('button', { class: 'ab-btn', type: 'button', 'aria-label': 'Theme', 'data-id': 'shell:theme' }, icon('theme', 18));
    themeBtn.addEventListener('click', () => C.run({ 'm3-light': 'theme.m3dark', 'm3-dark': 'theme.system' }[themePref(this.app)] ?? 'theme.m3light'));
    this.themeBtn = themeBtn;
    const helpBtn = h('button', { class: 'ab-btn', type: 'button', 'aria-label': 'Help', 'aria-haspopup': 'menu', 'data-id': 'shell:help' }, icon('help', 18));
    helpBtn.addEventListener('click', () => openMenu(WORKSPACE_MENUS.find((m) => m.label === 'Help').items, this.app, { anchor: helpBtn }));
    return h(
      'header',
      { class: 'app-bar', 'data-id': 'shell:appbar' },
      menuBtn,
      h('span', { class: 'ab-brand' }, icon('app', 20), h('span', { class: 'ab-name' }, 'GIS Workbench')),
      this.title,
      search,
      h('span', { class: 'ab-spacer' }),
      btn('file.openimage', 'open', 'Open imagery', { primary: true, text: 'Open' }),
      btn('file.openurl', 'network', 'Open from a URL'),
      btn('qat.undo', 'undo', 'Undo'),
      btn('qat.redo', 'redo', 'Redo'),
      btn('file.save', 'save', 'Save project'),
      this.persona,
      themeBtn,
      btn('wb.toggle', 'whiteboard', 'Feedback whiteboard'),
      btn('file.prefs', 'gear', 'Settings'),
      helpBtn,
    );
  }

  renderRail() {
    clear(this.rail);
    for (const it of RAIL) {
      const b = h('button', { class: 'rail-item', type: 'button', 'data-id': it.cmd ? `cmd:${it.cmd}` : `rail:${it.id}`, 'data-rail': it.id, 'aria-label': it.label, 'aria-pressed': 'false' }, h('span', { class: 'rail-ic' }, icon(it.icon, 20)), h('span', { class: 'rail-label' }, it.label));
      b.addEventListener('click', () => {
        if (it.menu) openMenu(it.menu(), this.app, { anchor: b });
        else this.app.commands.run(it.cmd);
      });
      this.rail.appendChild(b);
    }
  }

  refresh() {
    if (this.app.layoutMode() !== 'modern') return;
    const p = this.app.project();
    const name = `${p?.name ?? 'Untitled'}${this.app.layers.size ? '' : ''}`;
    const t = `${name} · ${this.app.markingSuffix?.() ?? ''}`;
    if (this.title.textContent !== t) this.title.textContent = t;
    for (const b of this.rail.querySelectorAll('.rail-item')) {
      const it = RAIL.find((r) => r.id === b.dataset.rail);
      const open = !!it.open?.(this.app);
      b.classList.toggle('active', open);
      b.setAttribute('aria-pressed', String(open));
    }
    for (const b of this.bar.querySelectorAll('[data-id^="cmd:"]')) {
      const id = b.dataset.id.slice(4);
      b.disabled = !this.app.commands.enabled(id);
    }
    const per = this.app.personas?.current();
    const label = per ? per.short : 'Workspace';
    if (this.persona.textContent !== label) this.persona.textContent = label;
    const pref = themePref(this.app);
    const next = { 'm3-light': 'dark', 'm3-dark': 'follow system' }[pref] ?? 'light';
    const tl = `Theme: ${pref === 'system' ? 'follow system' : pref.replace('m3-', '')}. Click for ${next}.`;
    if (this.themeBtn.getAttribute('aria-label') !== tl) {
      this.themeBtn.setAttribute('aria-label', tl);
      this.themeBtn.title = tl;
    }
  }

  /** Switch the chrome between 'modern' and 'classic' without a reload. */
  apply(mode, { initial = false } = {}) {
    const app = this.app;
    const html = document.documentElement;
    html.dataset.layout = mode;
    this.bar.hidden = mode !== 'modern';
    this.rail.hidden = mode !== 'modern';
    // A palette the user chose stays; Follow system (the default) picks the layout's own pair.
    applyTheme(app);
    if (!initial) {
      if (app.prefs.user('workspaceCollapsed') === undefined) app.desktop.setWorkspaceCollapsed(mode === 'modern');
      if (mode === 'classic') {
        const d = app.activeMp()?.docks;
        if (d && !Object.keys(d.layout()).length) {
          d.show('layers', 'left');
          d.show('cues', 'left');
          d.show('layers', 'left');
        }
      }
      for (const mp of app.desktop.multiports) for (const p of mp.panes) p.invalidate();
    }
    app.desktop.layout();
    this.refresh();
    app.emit('layout');
  }
}
