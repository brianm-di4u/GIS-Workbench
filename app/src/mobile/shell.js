// The Lite mobile shell (OD-2.23, REQ-HOST-05): a touch-first GUI for phones and tablets around the
// shared image panel. The image fills the screen; a bottom app bar holds the primary actions; the
// layers are a drawer; tools, results and forms are bottom sheets. Touch targets are at least 48 px (WCAG 2.2 target size,
// 44 px for AAA). It offers only the commands of data/lite-commands.json.
//
// The shared features expect a desktop with Multiports, docks and a status bar; this shell gives
// them the same shape (desk, port, docks, status) with one panel and sheets in place of docks.

import { h, clear, copyText } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { ImagePane } from '../shell/pane.js';
import { LITE_COMMANDS } from '../core/profile.js';
import { bindGestures } from './gestures.js';
import { t, tr, msgOf } from '../i18n/index.js';
import { num, length, height } from '../i18n/format.js';

/** The app bar: [id, label, icon]. Labels are translated where shown. */
const BAR = [
  ['open', () => t('Open'), 'open'],
  ['layers', () => t('Layers'), 'layers'],
  ['measure', () => t('Measure'), 'ruler'],
  ['observe', () => t('Observe'), 'observation'],
  ['tools', () => t('Tools'), 'toolbox'],
];

/** The sheets' command groups (every id is a Lite command; tests/unit/profile.test.js checks it). */
export const SHEETS = {
  open: () => [
    { title: t('Open from this device'), cmds: ['file.openimage', 'file.openvector', 'file.openpack'] },
    { title: t('Project'), cmds: ['file.openproject', 'file.save', 'file.relink'] },
  ],
  measure: () => [{ title: t('Measure on the image'), cmds: ['men.rangebearing', 'men.length', 'men.area', 'men.point'] }],
  observe: () => [
    { title: t('Observations'), cmds: ['obs.field', 'obs.table', 'obs.export', 'file.snapshot'] },
    { title: t('Annotate'), cmds: ['draw.marker', 'draw.text', 'draw.arrow', 'draw.polygon'] },
  ],
  tools: () => [
    { title: t('View'), cmds: ['nav.whole', 'nav.onetoone', 'rot.north', 'rot.upisup', 'rot.zero'] },
    { title: t('Enhance'), cmds: ['enh.auto', 'enh.drascope', 'enh.brightness', 'enh.contrast', 'msi.preset.natural', 'msi.preset.cir', 'msi.preset.swir', 'msi.preset.agriculture', 'enh.reset'] },
    { title: t('Coordinates'), cmds: ['geo.locate', 'nav.jump', 'geo.convert'] },
    { title: t('Area of interest and GRG'), cmds: ['aoi.box', 'aoi.polygon', 'aoi.clear', 'grid.grg', 'grid.micro'] },
    { title: t('Edit'), cmds: ['qat.undo', 'qat.redo'] },
    { title: t('Settings'), cmds: ['net.toggle', 'file.prefs', 'help.about'] },
  ],
};
/** Floating map buttons (right edge). */
const FAB = ['geo.locate', 'rot.north', 'nav.zoomin', 'nav.zoomout', 'nav.whole'];

/** Point readout: {lat, lon, h, msl, mgrs, dd, dms, ce90} of a screen point, or null off the model. */
export function pointInfo(app, pane, sx, sy) {
  const l = pane?.geoLayer?.();
  if (!l?.modelId) return null;
  const p = pane.imagePoint(sx, sy);
  const g = l.groundWithTerrain?.(p.x, p.y) ?? l.groundAt(p.x, p.y);
  if (!g || !Number.isFinite(g.lat)) return null;
  const core = app.core;
  let mgrs = '';
  try {
    mgrs = core.mgrs(g.lat, g.lon, 5);
  } catch {
    /* outside the MGRS zones: no MGRS */
  }
  const N = core.undulation?.(g.lat, g.lon);
  let ce90 = NaN;
  try {
    ce90 = core.pointError(l.modelId, p.x, p.y, g.h, 0.5, g.sigmaV).ce90;
  } catch {
    /* the model states no error */
  }
  return { x: p.x, y: p.y, lat: g.lat, lon: g.lon, h: g.h, msl: Number.isFinite(N) ? g.h - N : NaN, mgrs, dd: core.format(g.lat, g.lon, 0, 6), dms: core.format(g.lat, g.lon, 1, 2), ce90, inside: p.x >= 0 && p.y >= 0 && p.x < l.width && p.y < l.height };
}

/** The coordinate shown for a point in the chosen format ('mgrs' | 'dd' | 'dms'). */
export function coordText(info, fmt) {
  if (!info) return '';
  if (fmt === 'dd') return info.dd;
  if (fmt === 'dms') return info.dms;
  return info.mgrs ? `MGRS ${info.mgrs}` : info.dd; // i18n-ignore: coordinate notation
}

const FORMATS = ['mgrs', 'dd', 'dms'];

/** One view in the shape of a Multiport (shell/multiport.js) for the shared features. */
class MobilePort {
  constructor(app, shell, id) {
    this.app = app;
    this.shell = shell;
    this.id = id;
    this.panes = [];
    this.activePane = null;
    this.el = shell.view;
    this.ribbon = { el: null, update() {}, toggleMinimise() {}, showKeyTips() {}, minimised: false };
    this.docks = new SheetDocks(app, this, shell);
    this.status = new StatusValues(shell);
    this.qat = null;
  }
  get rec() {
    return this.app.store.get(this.id);
  }
  buildPanes() {
    const rec = this.rec;
    const want = (rec?.panes ?? []).slice(0, 1); // Lite shows one panel
    for (const p of this.panes) if (!want.includes(p.id)) p.dispose();
    const keep = new Map(this.panes.filter((p) => want.includes(p.id)).map((p) => [p.id, p]));
    this.panes = want.map((pid) => keep.get(pid) ?? this.shell.makePane(this, pid));
    this.activePane = this.panes[0] ?? null;
    for (const p of this.panes) if (!p.el.isConnected) this.shell.view.prepend(p.el);
    this.app.renderer.invalidate();
    this.app.emit('state');
  }
  setLayout() {
    this.buildPanes(); // one panel only (Full has the panel layouts)
  }
  setActivePane(p) {
    if (this.activePane === p) return;
    this.activePane = p;
    this.app.emit('state');
  }
  update() {
    this.shell.refresh();
  }
}

/** Dock panels as bottom sheets: register() as DockManager does, show() opens the sheet. */
class SheetDocks {
  constructor(app, mp, shell) {
    this.app = app;
    this.mp = mp;
    this.shell = shell;
    this.registry = new Map();
    this.areas = { left: { el: h('div', { hidden: true }), collapsed: true }, right: { el: h('div', { hidden: true }), collapsed: true }, bottom: { el: h('div', { hidden: true }), collapsed: true } };
    this.open = null;
  }
  register(spec) {
    this.registry.set(spec.id, { spec, el: null, api: null });
  }
  show(id) {
    const r = this.registry.get(id);
    if (!r) return;
    if (!r.el) {
      r.el = h('div', { class: 'm-dock', 'data-id': `m:dock:${id}` });
      r.api = r.spec.create?.(this.app, this.mp, r.el) ?? null;
    }
    this.open = id;
    this.shell.openSheet({ id: `dock-${id}`, title: r.spec.title, body: r.el, modal: false, onClose: () => (this.open = null) });
    r.api?.onShow?.();
  }
  toggle(id) {
    if (this.open === id) this.shell.closeSheet();
    else this.show(id);
  }
  isOpen(id) {
    return this.open === id;
  }
  hostTool() {
    return null;
  }
  /** Lite has no docks: null keeps a Full project’s layout as it came (REQ-GAP-86). */
  layout() {
    return null;
  }
  restore() {}
  saveSizes() {}
}

/** The status-bar cells the shared readout writes (features/readout.js), kept for the readout chip. */
class StatusValues {
  constructor(shell) {
    this.shell = shell;
    this.rows = [];
    this.cells = {};
    this.values = {};
    this.el = null;
  }
  set(v) {
    Object.assign(this.values, v);
  }
  updateJobs() {}
}

export class MobileShell {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.fmt = FORMATS.includes(app.prefs.get('liteCoord')) ? app.prefs.get('liteCoord') : 'mgrs';
    this.view = h('main', { class: 'm-view', 'data-id': 'm:view', 'aria-label': t('Image view') });
    const shell = this;
    // The shared features' desktop: one port, no Workspace window.
    this.desk = {
      el: this.view,
      multiports: [],
      activeMp: null,
      arrange: null, // one panel, no arrangement: a Full project keeps its own
      wsCollapsed: true,
      maximised: null,
      workspace: { map: { zoomToFootprints() {} }, render() {}, setView() {}, el: null },
      addMultiport(id) {
        const mp = new MobilePort(app, shell, id);
        this.multiports.push(mp);
        mp.buildPanes();
        this.activeMp = mp;
        shell.refresh();
        return mp;
      },
      removeMultiport(mp) {
        for (const p of mp.panes) p.dispose();
        this.multiports = this.multiports.filter((m) => m !== mp);
        if (this.activeMp === mp) this.activeMp = this.multiports[0] ?? null;
      },
      focus() {},
      layout() {
        app.renderer?.invalidate();
        app.emit('layout');
      },
      setArrange() {},
      setWorkspaceCollapsed() {},
      toggleMaximise() {},
    };
    this.sheet = null;
  }

  /** An image panel for the port; its pointer capture never throws for a replayed touch. */
  makePane(mp, id) {
    const p = new ImagePane(this.app, mp, id);
    const cap = p.el.setPointerCapture.bind(p.el);
    p.el.setPointerCapture = (pid) => {
      try {
        cap(pid);
      } catch {
        /* a tap replayed after its finger lifted has nothing to capture */
      }
    };
    return p;
  }

  mount() {
    const app = this.app;
    const C = app.commands;
    this.title = h('h1', { class: 'm-title', 'data-id': 'm:title' }, t('GIS Workbench Lite'));
    this.chipHint = h('span', { class: 'sr-only', id: 'm-chip-hint' }, t('Coordinate of the view centre. Tap to change the format.'));
    this.chip = h('button', { class: 'm-chip', type: 'button', 'data-id': 'm:readout', hidden: true, 'aria-describedby': 'm-chip-hint' });
    this.chip.addEventListener('click', () => {
      this.fmt = FORMATS[(FORMATS.indexOf(this.fmt) + 1) % FORMATS.length];
      app.prefs.set('liteCoord', this.fmt);
      this.refreshReadout();
    });
    this.top = h('header', { class: 'm-top' }, this.title, this.chip, this.chipHint);
    this.cross = h('div', { class: 'm-cross', 'aria-hidden': 'true', hidden: true });
    this.fab = h('div', { class: 'm-fab', role: 'toolbar', 'aria-label': t('Map controls'), 'aria-orientation': 'vertical' });
    for (const id of FAB) this.fab.appendChild(this.cmdButton(id, { iconOnly: true }));
    this.empty = h(
      'div',
      { class: 'm-empty', 'data-id': 'm:empty' },
      h('h2', {}, t('Open imagery, a map or vectors')),
      h('p', {}, t('Files open from this device and stay on it. Pinch to zoom, turn two fingers to rotate, press and hold for a coordinate.')),
      this.cmdButton('file.openimage', { primary: true }),
    );
    this.view.append(this.cross, this.empty, this.fab);
    this.cueText = h('span', { class: 'm-cue-text' });
    this.cueFinish = h('button', { class: 'm-btn m-btn-primary', type: 'button', 'data-id': 'm:cue:finish' }, t('Finish'));
    this.cueCancel = h('button', { class: 'm-btn', type: 'button', 'data-id': 'm:cue:cancel' }, t('Cancel'));
    this.cueFinish.addEventListener('click', () => {
      const p = app.activePane();
      if (p) app.tools.current?.onEnter?.(p);
      this.refresh();
    });
    this.cueCancel.addEventListener('click', () => {
      app.tools.cancel();
      this.refresh();
    });
    this.cue = h('div', { class: 'm-cue', 'data-id': 'm:cue', role: 'status', 'aria-live': 'polite', hidden: true }, this.cueText, h('div', { class: 'm-cue-buttons' }, this.cueFinish, this.cueCancel));
    this.bar = h('nav', { class: 'm-appbar', 'aria-label': t('Main actions'), 'data-id': 'm:appbar' });
    for (const [id, label, ic] of BAR) {
      const b = h('button', { class: 'm-bar-btn', type: 'button', 'data-id': `m:bar:${id}`, 'aria-haspopup': 'dialog' }, icon(ic, 24), h('span', { class: 'm-bar-label' }, label()));
      b.addEventListener('click', () => (id === 'layers' ? this.openLayers(b) : this.openMenu(id, b)));
      this.bar.appendChild(b);
    }
    this.scrim = h('div', { class: 'm-scrim', hidden: true, 'data-id': 'm:scrim' });
    this.scrim.addEventListener('click', () => {
      this.closeSheet();
      this.closeLayers();
    });
    this.sheetEl = h('section', { class: 'm-sheet', hidden: true, 'data-id': 'm:sheet', tabindex: '-1' });
    this.drawer = h('aside', { class: 'm-drawer', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Layers'), 'data-id': 'm:layers', tabindex: '-1' });
    this.el = h('div', { class: 'm-shell', 'data-id': 'm:shell' }, this.top, this.view, this.cue, this.bar, this.scrim, this.drawer, this.sheetEl);
    this.root.appendChild(this.el);
    bindGestures(this.view, {
      paneOf: (target) => app.activeMp()?.panes.find((p) => p.el.contains(target)) ?? null,
      toolActive: () => !!app.tools?.current,
      onDoubleTap: (pane, sx, sy) => {
        pane.zoomAt(2, sx, sy);
        pane._afterRoam();
      },
      onLongPress: (pane, sx, sy) => this.pointSheet(pane, sx, sy),
    });
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Tab') return this.trapFocus(e);
        if (e.key !== 'Escape') return;
        if (!this.drawer.hidden) {
          e.stopPropagation();
          this.closeLayers();
        } else if (this.sheet) {
          e.stopPropagation();
          this.closeSheet();
        }
      },
      true,
    );
    // Android Back closes what is open, as Escape does, and only then leaves Lite (see syncBack).
    window.addEventListener('popstate', () => {
      if (this.backSkip) this.backSkip = false;
      else if (this.backGuard) {
        this.backGuard = false;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      this.syncBack();
    });
    new MutationObserver(() => this.syncBack()).observe(document.body, { childList: true }); // dialogs live on the body
    // The on-screen keyboard: keep sheets and dialogs above it (visual viewport), and the focused field
    // in view. On the root, as dialogs live on the body. iOS does not resize the page for the keyboard
    // as Android does, so only this keeps a dialog's fields and buttons out from under it.
    const vv = window.visualViewport;
    const kb = () => {
      if (!vv || vv.scale > 1.01) return; // a zoomed page shrinks the visual viewport too
      const root = document.documentElement.style;
      const inset = Math.max(0, window.innerHeight - vv.height);
      root.setProperty('--m-kb', `${Math.round(inset)}px`);
      root.setProperty('--m-vh', `${Math.round(vv.height)}px`);
      // Safari pans the page to a field it thinks is covered. The dialog now fits above the keyboard,
      // and a pan would only push its top off the screen.
      if (inset > 0 && vv.offsetTop > 0) window.scrollTo(0, 0);
    };
    vv?.addEventListener('resize', kb);
    vv?.addEventListener('scroll', kb);
    document.addEventListener('focusin', (e) => {
      if (e.target.matches?.('input, textarea, select, [contenteditable]')) setTimeout(() => e.target.scrollIntoView?.({ block: 'nearest' }), 300);
    });
    let pending = 0;
    const later = () => {
      if (!pending) pending = setTimeout(() => ((pending = 0), this.refresh()), 40);
    };
    app.on('state', () => {
      // The first-run card leaves with the first image, not with the refresh: it covers the image
      // and takes any touch that lands on it, so a gesture started in that gap would be lost.
      if (app.activePane()?.layers().length) this.empty.hidden = true;
      later();
    });
    app.on('view', () => this.refreshReadout());
    app.on('cue', later);
    app.on('location', later);
    C.on('change', later);
  }

  /** Tab stays inside an open modal sheet or the drawer (a dialog of the shared features has its own). */
  trapFocus(e) {
    const box = !this.drawer.hidden ? this.drawer : this.sheet?.modal ? this.sheetEl : null;
    if (!box || document.querySelector('.dlg')) return;
    const items = [...box.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    if (!box.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  /** After the features are in: the first render. */
  ready() {
    this.refresh();
  }

  /** A button for a Lite command: label, icon, enabled and checked state, data-cmd. */
  cmdButton(id, { iconOnly = false, primary = false } = {}) {
    const C = this.app.commands;
    if (!LITE_COMMANDS.has(id)) throw new Error(`${id} is not a Lite command`);
    const c = C.get(id);
    const label = C.labelOf(id).replace(/…$/, '');
    const kids = [icon(c?.icon ?? 'more', iconOnly ? 24 : 22)];
    if (!iconOnly) kids.push(h('span', { class: 'm-cmd-label' }, label));
    const b = h('button', { class: ['m-cmd', iconOnly && 'm-cmd-icon', primary && 'm-btn-primary'], type: 'button', 'data-cmd': id, 'data-id': `m:cmd:${id}`, 'aria-label': iconOnly ? label : null, title: iconOnly ? label : null }, ...kids);
    b.addEventListener('click', async () => {
      if (b.getAttribute('aria-disabled') === 'true') {
        this.app.toast(t('{cmd}: not available now', { cmd: label }), { kind: 'warn' });
        return;
      }
      // A menu sheet or the drawer closes first, so a tool's taps reach the image and a dialog opens on top.
      if (this.sheet?.modal) this.closeSheet();
      this.closeLayers();
      await C.run(id);
      this.refresh();
    });
    return b;
  }

  /** A slider or a choice for a command with setValue (brightness, contrast, DRA scope). */
  cmdControl(id) {
    const C = this.app.commands;
    const c = C.get(id);
    const label = C.labelOf(id);
    if (c.options) {
      const sel = h('select', { class: 'm-select', 'data-cmd': id, 'data-id': `m:cmd:${id}`, 'aria-label': label }, ...c.options().map((o) => h('option', { value: o.value, selected: o.value === c.value?.() }, o.label)));
      sel.addEventListener('change', () => c.setValue(sel.value));
      return h('label', { class: 'm-field' }, h('span', {}, label), sel);
    }
    const rng = h('input', { type: 'range', class: 'm-range', min: '-100', max: '100', step: '1', value: String(Math.round(c.value?.() ?? 0)), 'data-cmd': id, 'data-id': `m:cmd:${id}`, 'aria-label': label });
    rng.addEventListener('input', () => c.setValue(Number(rng.value)));
    return h('label', { class: 'm-field' }, h('span', {}, label), rng);
  }

  syncButton(b) {
    const C = this.app.commands;
    const id = b.dataset.cmd;
    const c = C.get(id);
    const ok = !!c?.implemented && C.enabled(id);
    b.setAttribute('aria-disabled', ok ? 'false' : 'true');
    if (c?.checked) b.setAttribute('aria-pressed', String(C.checked(id)));
  }

  /**
   * One history entry stands in front of the app while a sheet, the drawer or a dialog is open, so
   * Back pops that entry and not the app. Deferred, so one thing closing as the next opens counts
   * as still open; an embedded Lite leaves the host page's history alone.
   */
  syncBack() {
    if (window.top !== window || this.backTimer) return;
    this.backTimer = setTimeout(() => {
      this.backTimer = 0;
      if (this.backSkip) return; // the entry is still going: popstate looks again
      const open = !!this.sheet || !this.drawer.hidden || !!document.querySelector('.dlg');
      if (open && !this.backGuard) {
        history.pushState({ gwOverlay: true }, '');
        this.backGuard = true;
      } else if (!open && this.backGuard) {
        this.backGuard = false;
        this.backSkip = true;
        history.back();
      }
    }, 50);
  }

  /** Re-render the chrome from the app state. */
  refresh() {
    const app = this.app;
    const pane = app.activePane();
    const layer = pane?.activeLayer?.();
    this.empty.hidden = !!pane?.layers().length;
    this.el.classList.toggle('m-is-empty', this.empty.hidden === false);
    this.title.textContent = layer?.rec?.name ?? t('GIS Workbench Lite');
    for (const b of this.el.querySelectorAll('button[data-cmd]')) this.syncButton(b);
    this.el.style.setProperty('--m-appbar-h', `${this.bar.offsetHeight}px`);
    // The tool cue with Finish (multi-point tools) and Cancel.
    const tool = app.tools?.current;
    this.cue.hidden = !tool;
    if (tool) {
      this.cueText.textContent = app.cueText ?? '';
      this.cueFinish.hidden = !tool.onEnter;
    }
    this.refreshReadout();
  }

  /** The centre coordinate chip and cross-hair. */
  refreshReadout() {
    const pane = this.app.activePane();
    const info = pane ? (() => {
      const { w, h: hh } = pane.size();
      return pointInfo(this.app, pane, w / 2, hh / 2);
    })() : null;
    this.chip.hidden = !info;
    this.cross.hidden = !info;
    if (info) this.chip.textContent = coordText(info, this.fmt);
  }

  // ---- sheets ----

  /**
   * Open a bottom sheet. modal: a menu or form over a scrim (focus kept inside, Esc closes);
   * otherwise a result panel that leaves the image usable above it.
   */
  openSheet({ id, title, body, modal = true, onClose, opener = document.activeElement }) {
    this.closeSheet({ restore: false });
    const s = this.sheetEl;
    clear(s);
    const close = h('button', { class: 'm-sheet-close', type: 'button', 'aria-label': t('Close'), title: t('Close'), 'data-id': 'm:sheet:close' }, icon('close', 24));
    close.addEventListener('click', () => this.closeSheet());
    const handle = h('div', { class: 'm-sheet-handle', 'aria-hidden': 'true' });
    const head = h('div', { class: 'm-sheet-head' }, h('h2', { class: 'm-sheet-title', id: 'm-sheet-title' }, title), close);
    s.append(handle, head, h('div', { class: 'm-sheet-body' }, body));
    s.setAttribute('role', 'dialog');
    s.setAttribute('aria-modal', modal ? 'true' : 'false');
    s.setAttribute('aria-labelledby', 'm-sheet-title');
    s.dataset.sheet = id;
    s.dataset.modal = modal ? '1' : '0';
    s.hidden = false;
    this.scrim.hidden = !modal;
    this.sheet = { id, modal, onClose, opener };
    this.syncBack();
    this.bindSwipe(handle, () => this.closeSheet());
    this.bindSwipe(head, () => this.closeSheet());
    for (const b of s.querySelectorAll('button[data-cmd]')) this.syncButton(b);
    (s.querySelector('button[data-cmd]:not([aria-disabled="true"]), input, select, textarea') ?? close).focus({ preventScroll: true });
    return s;
  }

  closeSheet({ restore = true } = {}) {
    if (!this.sheet) return;
    const { onClose, opener } = this.sheet;
    this.sheet = null;
    this.sheetEl.hidden = true;
    clear(this.sheetEl);
    this.scrim.hidden = this.drawer.hidden;
    onClose?.();
    if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
    this.syncBack();
  }

  /** Swipe a sheet's header down to close it. */
  bindSwipe(el, fn) {
    let y0 = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      y0 = e.clientY;
    });
    el.addEventListener('pointerup', (e) => {
      if (y0 !== null && e.clientY - y0 > 60) fn();
      y0 = null;
    });
    el.addEventListener('pointercancel', () => (y0 = null));
  }

  /** A menu sheet of command groups. */
  openMenu(which, opener) {
    const groups = SHEETS[which]();
    const body = h('div', { class: 'm-groups' });
    for (const g of groups) {
      const grid = h('div', { class: 'm-grid', role: 'group', 'aria-label': g.title });
      for (const id of g.cmds) {
        const c = this.app.commands.get(id);
        grid.appendChild(c?.setValue ? this.cmdControl(id) : this.cmdButton(id));
      }
      body.append(h('h3', { class: 'm-group-title' }, g.title), grid);
    }
    if (which === 'measure') body.appendChild(this.measureList());
    const titles = { open: t('Open'), measure: t('Measure'), observe: t('Observe'), tools: t('Tools') };
    this.openSheet({ id: which, title: titles[which], body, modal: true, opener });
  }

  /** The latest measurements (the Mensuration Log of Full, short form). */
  measureList() {
    const rows = this.app.store.all('measurement').slice(-8).reverse();
    if (!rows.length) return h('p', { class: 'm-hint' }, t('Choose a measurement, then tap points on the image. Results appear here.'));
    const list = h('ol', { class: 'm-results', 'data-id': 'm:measurements', 'aria-label': t('Measurements') });
    for (const r of rows) list.appendChild(h('li', {}, this.measureText(r)));
    return h('div', {}, h('h3', { class: 'm-group-title' }, t('Results')), list);
  }

  measureText(r) {
    const d = this.app.menRowOf?.(r) ?? {};
    const value = d.value ?? `${r.value ?? ''} ${r.units ?? ''}`;
    const err = Number.isFinite(r.ce90) ? t('CE90 {ce}', { ce: length(r.ce90, 1) }) : t('error not available');
    return h('span', {}, h('b', {}, `${r.mid} ${tr(r.mtype)}: `), `${value} · ${err}`);
  }

  /** Called by the shared features (app.panels.show): a measurement, the observation table… */
  showPanel(id) {
    if (id === 'menlog') {
      const r = this.app.store.all('measurement').at(-1);
      if (!r) return;
      const body = h('div', { class: 'm-result', 'data-id': 'm:measure-result' }, h('p', { class: 'm-result-value' }, this.measureText(r)), this.measureDetails(r));
      this.openSheet({ id: 'measure-result', title: t('Measurement'), body, modal: false });
      return;
    }
    if (id === 'layers') return this.openLayers();
    this.app.activeMp()?.docks.show(id);
  }

  measureDetails(r) {
    const dl = h('dl', { class: 'm-dl' });
    const add = (k, v) => v !== undefined && v !== null && v !== '' && dl.append(h('dt', {}, k), h('dd', {}, v));
    const x = r.extra ?? {};
    if (Number.isFinite(x.azimuthTrue)) add(t('Bearing (true)'), `${num(x.azimuthTrue, 2)}°`);
    if (Number.isFinite(x.backAzimuth)) add(t('Back bearing'), `${num(x.backAzimuth, 2)}°`);
    if (Number.isFinite(x.perimeter)) add(t('Perimeter'), length(x.perimeter, 1));
    if (r.coords?.mgrs) add('MGRS', r.coords.mgrs); // i18n-ignore: grid name
    if (r.coords?.from) add(t('From'), r.coords.from);
    if (r.coords?.to) add(t('To'), r.coords.to);
    if (Number.isFinite(r.coords?.hae)) add(t('Height'), `${height(r.coords.hae, 1)} HAE`); // i18n-ignore: datum name
    add(t('Error'), Number.isFinite(r.ce90) ? t('CE90 {ce}', { ce: length(r.ce90, 1) }) : t('error not available (the sensor model states no error)'));
    add(t('Method'), r.method);
    return dl;
  }

  /** Long press: the point's coordinates, and what to do there. */
  pointSheet(pane, sx, sy) {
    const app = this.app;
    const info = pointInfo(app, pane, sx, sy);
    if (!info) {
      app.toast(t('This image has no sensor model: no ground coordinate here.'), { kind: 'warn' });
      return;
    }
    this.lastPoint = info;
    const dl = h('dl', { class: 'm-dl', 'data-id': 'm:point' });
    const row = (k, v) => dl.append(h('dt', {}, k), h('dd', { dir: 'ltr' }, v));
    row('MGRS', info.mgrs || '–'); // i18n-ignore: grid name
    row(t('Latitude, longitude'), info.dd);
    row('DMS', info.dms); // i18n-ignore: coordinate notation
    row(t('Height'), Number.isFinite(info.msl) ? `${height(info.h, 1)} HAE · ${height(info.msl, 1)} MSL` : `${height(info.h, 1)} HAE`); // i18n-ignore: datum names
    row(t('Error'), Number.isFinite(info.ce90) ? t('CE90 {ce}', { ce: length(info.ce90, 1) }) : t('error not available'));
    if (!info.inside) dl.append(h('dd', { class: 'm-hint' }, t('This point is outside the image.')));
    const act = (label, ic, did, fn) => {
      const b = h('button', { class: 'm-cmd', type: 'button', 'data-id': did }, icon(ic, 22), h('span', { class: 'm-cmd-label' }, label));
      b.addEventListener('click', async () => {
        try {
          await fn();
        } catch (e) {
          app.toast(msgOf(e), { kind: 'error' });
        }
      });
      return b;
    };
    const actions = h(
      'div',
      { class: 'm-grid' },
      act(t('Copy'), 'copy', 'm:point:copy', async () => {
        await copyText(`${info.mgrs ? `${info.mgrs} ` : ''}${info.dd}`);
        app.toast(t('Copied {coord}', { coord: info.mgrs || info.dd }), { kind: 'info' });
      }),
      act(t('Centre here'), 'recenter', 'm:point:centre', () => {
        pane.centreOn(info.x, info.y);
        this.closeSheet();
      }),
      act(t('Observation here'), 'observation', 'm:point:observe', async () => {
        this.closeSheet();
        await app.commands.run('obs.field', { lat: info.lat, lon: info.lon, h: info.h, where: 'point' });
      }),
      act(t('Marker here'), 'marker', 'm:point:marker', () => {
        this.closeSheet();
        app.tools.select('draw.marker');
        app.tools.current.onDown(pane, null, sx, sy);
        this.refresh();
      }),
    );
    this.openSheet({ id: 'point', title: t('Point'), body: h('div', {}, dl, actions), modal: false });
  }

  // ---- layers drawer ----

  openLayers(opener = document.activeElement) {
    const app = this.app;
    this.closeSheet({ restore: false });
    const d = this.drawer;
    clear(d);
    const close = h('button', { class: 'm-sheet-close', type: 'button', 'aria-label': t('Close'), title: t('Close'), 'data-id': 'm:layers:close' }, icon('close', 24));
    close.addEventListener('click', () => this.closeLayers());
    const list = h('ul', { class: 'm-layers', 'aria-label': t('Layers') });
    const pane = app.activePane();
    const layers = pane?.layers().slice().reverse() ?? [];
    for (const l of layers) {
      const rec = l.rec;
      const vis = h('input', { type: 'checkbox', class: 'm-check', checked: rec.visible !== false, 'aria-label': t('Show {layer}', { layer: rec.name }), 'data-id': `m:layer:vis:${l.id}` });
      vis.addEventListener('change', () => app.store.transact(t('Layer visibility'), (tx) => tx.set(l.id, 'visible', vis.checked)));
      const active = pane.rec.activeLayer === l.id || (!pane.rec.activeLayer && l === pane.activeLayer());
      const pick = h('button', { class: ['m-layer-name', active && 'active'], type: 'button', 'aria-pressed': String(active), 'data-id': `m:layer:${l.id}` }, h('span', {}, rec.name), h('small', {}, l.info?.format ?? ''));
      pick.addEventListener('click', () => {
        app.store.transact(t('Set active layer'), (tx) => tx.set(pane.id, 'activeLayer', l.id), { kind: 'load' });
        this.openLayers(opener);
      });
      const op = h('input', { type: 'range', class: 'm-range', min: '0', max: '100', value: String(Math.round((rec.opacity ?? 1) * 100)), 'aria-label': t('Opacity of {layer}', { layer: rec.name }) });
      op.addEventListener('input', () => app.store.transact(t('Layer opacity'), (tx) => tx.set(l.id, 'opacity', +op.value / 100), { mergeKey: `opacity:${l.id}` }));
      op.addEventListener('change', () => app.undo.seal());
      list.appendChild(h('li', { class: 'm-layer' }, h('div', { class: 'm-layer-row' }, h('label', { class: 'm-check-wrap' }, vis), pick), op));
    }
    for (const v of app.store.all('vlayer')) {
      const vis = h('input', { type: 'checkbox', class: 'm-check', checked: v.visible !== false, 'aria-label': t('Show {layer}', { layer: v.name }), 'data-id': `m:vlayer:vis:${v.id}` });
      vis.addEventListener('change', () => {
        app.store.transact(t('Layer visibility'), (tx) => tx.set(v.id, 'visible', vis.checked));
        app.renderer.invalidate();
      });
      list.appendChild(h('li', { class: 'm-layer' }, h('div', { class: 'm-layer-row' }, h('label', { class: 'm-check-wrap' }, vis), h('span', { class: 'm-layer-name' }, h('span', {}, v.name), h('small', {}, t('vector'))))));
    }
    const gl = pane?.rec?.graphicsLayer ? app.store.get(pane.rec.graphicsLayer) : null;
    if (gl) {
      const vis = h('input', { type: 'checkbox', class: 'm-check', checked: gl.visible !== false, 'aria-label': t('Show graphics'), 'data-id': 'm:glayer:vis' });
      vis.addEventListener('change', () => {
        app.store.transact(t('Graphics visibility'), (tx) => tx.set(gl.id, 'visible', vis.checked));
        pane.invalidate();
      });
      list.appendChild(h('li', { class: 'm-layer' }, h('div', { class: 'm-layer-row' }, h('label', { class: 'm-check-wrap' }, vis), h('span', { class: 'm-layer-name' }, h('span', {}, t('Graphics')), h('small', {}, t('{n, plural, one {# graphic} other {# graphics}}', { n: app.store.all('graphic').filter((g) => g.pane === pane.id).length }))))));
    }
    const body = layers.length || gl || app.store.all('vlayer').length ? list : h('p', { class: 'm-hint' }, t('Nothing is open yet.'));
    d.append(h('div', { class: 'm-sheet-head' }, h('h2', { class: 'm-sheet-title' }, t('Layers')), close), h('div', { class: 'm-drawer-body' }, body, this.cmdButton('file.openimage'), this.cmdButton('file.openvector')));
    for (const b of d.querySelectorAll('button[data-cmd]')) this.syncButton(b);
    d.hidden = false;
    this.scrim.hidden = false;
    this.layersOpener = opener;
    (d.querySelector('input, button.m-layer-name') ?? close).focus({ preventScroll: true });
    this.syncBack();
  }

  closeLayers() {
    if (this.drawer.hidden) return;
    this.drawer.hidden = true;
    clear(this.drawer);
    this.scrim.hidden = !this.sheet?.modal;
    if (this.layersOpener?.isConnected) this.layersOpener.focus({ preventScroll: true });
    this.syncBack();
  }
}
