// Keyboard router (REQ-UI-09, Research/15 §13.2): one map from KeyboardEvent.code + modifiers
// to commands, routed by focus context. Text fields keep browser behaviour. Browser-reserved
// chords get alternates (Ctrl+1 → Ctrl+Alt+1, Ctrl+T → Ctrl+Alt+T); F5/F7 are captured only
// while a panel has focus. Held keys are tracked with keyup for roaming.

const DEFAULT_MAP = {
  'Mod+KeyZ': 'qat.undo',
  'Mod+KeyY': 'qat.redo',
  'Mod+Shift+KeyZ': 'qat.redo',
  'Mod+KeyS': 'file.save',
  'Mod+Shift+KeyS': 'file.saveas',
  'Mod+KeyO': 'file.openimage',
  'Mod+Alt+Digit1': 'nav.onetoone',
  'Mod+Alt+KeyT': 'pane.showname',
  'Mod+Shift+Space': 'ai.assistant',
  F1: 'help.topics',
  'Mod+F1': 'ribbon.minimise',
  KeyB: 'wb.toggle',
  'Mod+KeyK': 'ui.palette',
};

const PANE_MAP = {
  KeyW: 'nav.whole',
  F5: 'draw.marker',
  F7: 'nav.roam',
  Equal: 'nav.zoomin',
  NumpadAdd: 'nav.zoomin',
  Minus: 'nav.zoomout',
  NumpadSubtract: 'nav.zoomout',
  'Mod+Digit1': 'nav.onetoone', // works while a pane has focus (S-07 to confirm per browser)
  'Mod+KeyA': 'sel.all',
  Delete: 'edit.delete',
  'Mod+KeyC': 'edit.copy',
  'Mod+KeyV': 'edit.paste',
};

/** Chords the browser keeps for itself (tabs, windows, quit): never assignable. */
export const RESERVED = new Set(['Mod+KeyT', 'Mod+KeyN', 'Mod+KeyW', 'Mod+Shift+KeyT', 'Mod+Shift+KeyN', 'Mod+Shift+KeyW', 'Mod+Tab', 'Mod+Shift+Tab', 'Mod+KeyQ', 'Alt+F4', 'F11', 'Mod+Shift+Delete']);
/** Chords the browser uses unless a panel has focus: assignable only as panel keys. */
export const FOCUS_ONLY = new Set(['F5', 'Mod+KeyR', 'F6', 'Mod+KeyL', 'Mod+KeyP', 'Mod+KeyF', 'Mod+KeyD', 'Mod+KeyH', 'Mod+KeyJ']);

export function chord(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && !/^(Shift)/.test(e.code)) parts.push('Shift');
  parts.push(e.code);
  return parts.join('+');
}

export class Keys {
  constructor(app) {
    this.app = app;
    this.reload();
    this.held = new Set();
    this.altAlone = false;
    document.addEventListener('keydown', (e) => this.onKey(e), true);
    document.addEventListener('keyup', (e) => this.onKeyUp(e), true);
    window.addEventListener('blur', () => this.held.clear());
  }

  /** Rebuild the maps from the defaults and the user's Customize Hot Keys choices. */
  reload() {
    const strip = (base, over) => {
      const m = { ...base };
      for (const [c, cmd] of Object.entries(over ?? {})) {
        // An override names its chord; a command moved to a new chord leaves its old one.
        for (const [k, v] of Object.entries(m)) if (v === cmd) delete m[k];
        if (cmd) m[c] = cmd;
      }
      return m;
    };
    this.map = strip(DEFAULT_MAP, this.app.prefs.get('hotkeys'));
    this.paneMap = strip(PANE_MAP, this.app.prefs.get('paneHotkeys'));
  }

  inText(e) {
    const t = e.target;
    return t?.closest?.('input, textarea, select, [contenteditable="true"]') && !t.closest('.rinput-wrap');
  }

  onKey(e) {
    this.held.add(e.code);
    if (e.key === 'Alt') {
      this.altAlone = true;
      return;
    }
    this.altAlone = false;
    if (this.app.feedback?.active && this.app.feedback.handlesKey(e)) return; // whiteboard key shield
    if (this.inText(e)) return;
    if (e.target.closest?.('.dlg')) return;
    const c = chord(e);
    if (e.key === 'Escape') {
      if (this.app.tools.current) {
        this.app.tools.cancel();
        e.preventDefault();
      }
      for (const mp of this.app.desktop.multiports) for (const p of mp.panes) if (p.fullRoam) p.toggleFullRoam();
      return;
    }
    const cmd = this.map[c];
    if (cmd && !e.repeat) {
      if (c === 'KeyB' && e.target.closest?.('.pane, .gwin, body') === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.runKey(cmd);
    }
  }

  /** A hot key for a greyed-out command says so instead of doing nothing (GUI-010). */
  runKey(cmd) {
    const C = this.app.commands;
    if (C.get(cmd)?.run && !C.enabled(cmd) && !C.liteGap(cmd)) {
      this.app.toast(`${C.get(cmd).label} is not available right now.`, { kind: 'info', ms: 2500 });
      return;
    }
    C.run(cmd);
  }

  onKeyUp(e) {
    this.held.delete(e.code);
    if (e.key === 'Alt' && this.altAlone) {
      this.altAlone = false;
      if (!this.inText(e)) {
        e.preventDefault();
        this.app.desktop.activeMp?.ribbon.showKeyTips();
      }
    }
  }

  /** Keys while a pane has focus. */
  paneKey(pane, e) {
    if (this.inText(e) || this.app.feedback?.active) return;
    const c = chord(e);
    if (this.app.tools.current?.onKey?.(pane, e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const cmd = this.paneMap[c];
    if (cmd) {
      e.preventDefault();
      e.stopPropagation();
      this.runKey(cmd);
      return;
    }
    // With the magnifier on, arrows change its power (up/down) and size (left/right).
    if (this.app.magnifier?.on && /^Arrow/.test(e.key) && this.app.magnifier.key(e.key)) {
      e.preventDefault();
      return;
    }
    // Arrow keys roam a quarter pane (WCAG: no drag-only actions).
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (step && !this.app.tools.current?.onArrow?.(pane, e)) {
      e.preventDefault();
      const { w, h } = pane.size();
      const z = pane.view.zoom;
      const dx = (step[0] * w) / 4 / z;
      const dy = (step[1] * h) / 4 / z;
      const co = Math.cos(pane.view.rot);
      const si = Math.sin(pane.view.rot);
      pane.setView({ cx: pane.view.cx + co * dx + si * dy, cy: pane.view.cy - si * dx + co * dy });
      pane._afterRoam();
    }
    if (e.key === 'Enter' && this.app.tools.current?.onEnter) {
      e.preventDefault();
      this.app.tools.current.onEnter(pane);
    }
  }

  keyMap() {
    return { global: this.map, pane: this.paneMap, defaults: { global: DEFAULT_MAP, pane: PANE_MAP } };
  }
}
