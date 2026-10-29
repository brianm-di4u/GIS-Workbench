// Workspace personas (REQ-SHL-12): one click sets the layout, the open panels, the radial tools,
// the status rows and the contextual pill for a way of working. Three ship with the app; users
// save their own, and a site can ship one through Common preferences ('personas', 'persona').
// The first start offers the choice on a card over the empty panel; it never blocks the app.

import { h } from '../shell/dom.js';
import { openMenu } from '../shell/menu.js';
import { promptBox } from '../shell/dialogs.js';
import { applyTheme } from '../shell/theme.js';

export const PERSONAS = [
  {
    id: 'explorer',
    short: 'Explorer',
    name: 'Imagery Explorer & Converter',
    blurb: 'A clean canvas: open, look, compare and share. For responders, GIS analysts and anyone browsing data.',
    layout: 'modern',
    docks: {},
    statusRows: 1,
    pill: true,
    radial: ['nav.whole', 'men.rangebearing', 'draw.marker', 'enh.auto', 'cmp.swiper', 'hud.quickchip', 'bm.add', 'ui.palette'],
  },
  {
    id: 'analyst',
    short: 'AI Analyst',
    name: 'AI & Exploitation Analyst',
    blurb: 'The AI assistant at hand, smart selection and detections to review, quick chips to a deck.',
    layout: 'modern',
    docks: { ai: 'right' },
    statusRows: 1,
    pill: true,
    radial: ['ai.smartselect', 'lai.find', 'lai.search', 'hud.quickchip', 'det.review', 'patrol.next', 'lai.contrast', 'rcp.airfield-triage'],
  },
  {
    id: 'pro',
    short: 'Pro',
    name: 'Mensuration & Photogrammetry Pro',
    blurb: 'Layers and the Mensuration Log docked, two status rows with error, model and datum; stereo and 3D on demand.',
    layout: 'modern',
    docks: { layers: 'left', menlog: 'bottom' },
    statusRows: 2,
    pill: true,
    radial: ['men.rangebearing', 'men.height', 'men.point', 'stereo.open', 'enh.drasettings', 'cmp.swiper', 'los.p2p', 'ui.palette'],
  },
];

export class Personas {
  constructor(app) {
    this.app = app;
  }

  list() {
    const site = this.app.prefs.common.values.personas;
    const own = this.app.prefs.get('customPersonas');
    return [...PERSONAS, ...(Array.isArray(site) ? site : []), ...(Array.isArray(own) ? own : [])];
  }

  current() {
    const id = this.app.prefs.get('persona');
    return this.list().find((p) => p.id === id) ?? null;
  }

  /** Apply a persona: layout, docks, status rows, pill; radial tools follow it. */
  apply(id, { quiet = false } = {}) {
    const app = this.app;
    const p = this.list().find((x) => x.id === id);
    if (!p) throw new Error(`no persona "${id}"`);
    app.prefs.set('persona', p.id);
    if (p.layout && p.layout !== app.layoutMode()) app.setLayout(p.layout);
    for (const mp of app.desktop.multiports) {
      const d = mp.docks;
      for (const [pid, panel] of d.registry) if (panel.area || panel.floatWin) d.close(panel);
      for (const [pid, side] of Object.entries(p.docks ?? {})) if (d.registry.has(pid)) d.show(pid, side);
    }
    document.documentElement.dataset.statusRows = String(p.statusRows ?? 1);
    app.prefs.set('pill', p.pill !== false);
    if (p.theme) {
      app.prefs.set('theme', p.theme);
      applyTheme(app);
    }
    this.dismissWelcome();
    app.emit('state');
    app.emit('layout');
    if (!quiet) app.toast(`${p.name}: workspace set. Tap Space over an image for its tools; Ctrl+K finds anything.`);
    return p;
  }

  /** Keep the current set-up as a persona of the user's own. */
  async saveCurrent() {
    const app = this.app;
    const nm = await promptBox('Save Workspace', 'Name', 'My workspace');
    if (!nm) return;
    const id = `custom-${nm.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const p = {
      id,
      short: nm.slice(0, 18),
      name: nm,
      blurb: 'Saved from your own set-up.',
      layout: app.layoutMode(),
      docks: app.activeMp()?.docks.layout() ?? {},
      statusRows: Number(document.documentElement.dataset.statusRows) || 1,
      pill: app.prefs.get('pill') !== false,
      radial: app.prefs.get('radialItems') ?? this.current()?.radial ?? null,
      theme: app.prefs.get('theme') ?? null,
    };
    const own = (app.prefs.get('customPersonas') ?? []).filter((x) => x.id !== id);
    app.prefs.set('customPersonas', [...own, p]);
    app.prefs.set('persona', id);
    app.toast(`Workspace "${nm}" saved.`);
    app.emit('state');
  }

  menu(anchor) {
    const cur = this.current()?.id;
    const items = this.list().map((p) => ({ label: p.name, checked: p.id === cur, run: () => this.apply(p.id) }));
    items.push('-', { label: 'Save Current Workspace…', run: () => this.saveCurrent() }, { cmd: 'ui.layout' });
    openMenu(items, this.app, { anchor });
  }

  /** First start: a card over the empty panel offers the three personas (never modal). */
  welcome() {
    const app = this.app;
    if (app.prefs.get('persona') || app.prefs.get('layout') || app.prefs.get('welcomeDone')) return;
    const pane = app.activePane();
    if (!pane) return;
    const card = h('div', { class: 'welcome', role: 'region', 'aria-label': 'Choose how you will work', 'data-id': 'welcome' }, h('h2', {}, 'How will you mostly work?'), h('p', { class: 'welcome-sub' }, 'Pick a starting workspace. You can switch any time from the button in the top bar, or keep the 1.x Classic layout.'));
    const row = h('div', { class: 'welcome-row' });
    for (const p of PERSONAS) {
      const b = h('button', { class: 'welcome-card', type: 'button', 'data-id': `welcome:${p.id}` }, h('strong', {}, p.name), h('span', {}, p.blurb));
      b.addEventListener('click', () => this.apply(p.id));
      row.appendChild(b);
    }
    // Network choice (REQ-NET-02): offline until the user says otherwise.
    if (app.network && !app.network.airgap && !app.prefs.isLocked('network')) {
      const online = h('input', { type: 'checkbox', 'data-id': 'welcome:online', checked: app.network.isOnline() });
      online.addEventListener('change', () => app.network.set(online.checked ? 'online' : 'offline'));
      card.append(h('label', { class: 'welcome-net' }, online, h('span', {}, h('strong', {}, 'Work online'), ' — satellite and map backgrounds, cloud catalogs (Earth Search, Planetary Computer, open data buckets). Every request is listed in the Network Log; leave it off to keep everything on this computer.')));
    }
    const skip = h('button', { class: 'btn', type: 'button', 'data-id': 'welcome:skip' }, 'Skip for now');
    skip.addEventListener('click', () => this.dismissWelcome(true));
    const classic = h('button', { class: 'btn', type: 'button', 'data-id': 'welcome:classic' }, 'Classic layout (1.x)');
    classic.addEventListener('click', () => {
      this.dismissWelcome(true);
      app.setLayout('classic');
    });
    card.append(row, h('div', { class: 'welcome-actions' }, classic, skip), h('p', { class: 'welcome-sub' }, 'Drop imagery anywhere to start, or press Ctrl+K to find any command.'));
    // The panel captures the pointer for panning; the card keeps its own clicks.
    for (const t of ['pointerdown', 'dblclick', 'wheel', 'contextmenu']) card.addEventListener(t, (e) => e.stopPropagation());
    pane.el.appendChild(card);
    this.card = card;
    // Opening an image is a choice too: the card steps aside.
    const off = () => {
      if (app.layers.size) this.dismissWelcome();
    };
    app.on('layers', off);
  }

  dismissWelcome(remember = false) {
    if (remember) this.app.prefs.set('welcomeDone', true);
    this.card?.remove();
    this.card = null;
  }
}
