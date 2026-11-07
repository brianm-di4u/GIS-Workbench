// Keyboard router (REQ-UI-09, Research/15 §13.2): one map from KeyboardEvent.code + modifiers
// to commands, routed by focus context. Text fields keep browser behaviour. Browser-reserved
// chords get alternates (Ctrl+1 → Ctrl+Alt+1, Ctrl+T → Ctrl+Alt+T); F5/F7 are captured only
// while a panel has focus. Held keys are tracked with keyup for roaming.

import { t, tc } from '../i18n/index.js';

// The user's keyboard layout (REQ-L10N-12): physical key code → the character it types, where
// the browser tells it (navigator.keyboard.getLayoutMap, Chromium). Chords are matched by code, so
// the labels shown for them (Keyboard Map, tooltips, palette) follow the layout: KeyZ shows "Y" on
// a German keyboard and "W" on a French one.
let layoutMap = null;

/** Read the keyboard layout again (at start and when the window gets focus: the user may switch). */
export async function loadKeyboardLayout() {
  try {
    const m = await globalThis.navigator?.keyboard?.getLayoutMap?.();
    if (m) layoutMap = m;
  } catch {
    /* not offered here (an iframe or an older browser): key codes are shown as US letters */
  }
}

/** The character a physical key types in the user's layout, upper case; null when not known. */
export function layoutKey(code) {
  const k = layoutMap?.get?.(code);
  return typeof k === 'string' && k.trim() && [...k].length === 1 ? k.toLocaleUpperCase() : null;
}

// KeyTip letters (REQ-L10N-12). Each English letter is a catalogue message in the 'keytip'
// context, so a translator can give a tab the letter of its translated name. A translation that
// is not one A–Z / 0–9 character, or that a sibling already uses, falls back to the English letter.
const KEYTIP = {
  F: () => tc('keytip', 'F'), // File
  H: () => tc('keytip', 'H'), // Home
  S: () => tc('keytip', 'S'), // Select
  D: () => tc('keytip', 'D'), // Draw
  G: () => tc('keytip', 'G'), // Geospatial
  P: () => tc('keytip', 'P'), // Products
  V: () => tc('keytip', 'V'), // View
  A: () => tc('keytip', 'A'), // Add-Ins
};
const KEYTIP_OK = /^[A-Z0-9]$/;

/** Letters for a row of KeyTips: [{en, label}] → [letter], unique among the siblings. */
export function keyTipLetters(items) {
  const used = new Set();
  const out = items.map(() => null);
  // Translated letters first, then the English ones, then any free letter of the label.
  items.forEach((it, i) => {
    const l = String(KEYTIP[it.en]?.() ?? it.en).trim().toLocaleUpperCase();
    if (KEYTIP_OK.test(l) && !used.has(l) && !items.some((o, j) => j !== i && String(KEYTIP[o.en]?.() ?? o.en).trim().toLocaleUpperCase() === l)) {
      out[i] = l;
      used.add(l);
    }
  });
  items.forEach((it, i) => {
    if (out[i]) return;
    const cands = [it.en, ...String(it.label ?? '').toUpperCase(), ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
    const l = cands.find((c) => KEYTIP_OK.test(c) && !used.has(c));
    if (l) {
      out[i] = l;
      used.add(l);
    }
  });
  return out;
}

/**
 * The KeyTip letter a key press means. A Latin layout (QWERTY, AZERTY, QWERTZ…) types the letter
 * printed on the key, so e.key is used; on a layout without Latin letters (Arabic, Cyrillic,
 * Greek…) e.key is another script and the physical key's code is used instead (KeyH → H).
 */
export function keyTipOf(e) {
  const k = String(e.key ?? '').toUpperCase();
  if (KEYTIP_OK.test(k)) return k;
  const m = /^(?:Key([A-Z])|Digit([0-9])|Numpad([0-9]))$/.exec(e.code ?? '');
  return m ? m[1] ?? m[2] ?? m[3] : null;
}

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
    loadKeyboardLayout();
    window.addEventListener('focus', () => loadKeyboardLayout());
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
      this.app.toast(t('{cmd} is not available right now.', { cmd: C.labelOf(cmd) }), { kind: 'info', ms: 2500 });
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
    if (cmd === 'edit.paste' && c === 'Mod+KeyV' && this.app.findCoordinate) {
      // Let the browser fire 'paste' so a coordinate on the clipboard can fly the view there
      // (REQ-SHL-11, features/hud.js); with no paste event or no coordinate, Paste runs as before.
      e.stopPropagation();
      clearTimeout(this.pasteT);
      this.pasteT = setTimeout(() => this.runKey(cmd), 80);
      return;
    }
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
