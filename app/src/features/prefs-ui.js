// Customize Hot Keys (REQ-UI-09) and UI scale (REQ-UI-17). Hot keys: every command with its
// key, changed by pressing the new chord; chords the browser keeps (new tab, close window …)
// are refused, and chords it uses outside the panel (F5, Ctrl+R …) are allowed as panel keys
// only. UI scale multiplies every size token of the chrome; graphics stay in device pixels.

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { chord, RESERVED, FOCUS_ONLY } from '../input/keys.js';

export const name = 'prefs-ui';

const pretty = (c) => c.replace(/Mod/g, navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl').replace(/Key([A-Z])/g, '$1').replace(/Digit(\d)/g, '$1').replace(/\+/g, ' + ');

export function install(app) {
  const C = app.commands;

  const applyScale = (s) => {
    document.documentElement.style.setProperty('--ui-scale', String(s));
    window.dispatchEvent(new Event('resize'));
  };
  applyScale(app.prefs.get('uiScale') ?? 1);

  C.implement('view.uiscale', {
    run: async () => {
      const cur = app.prefs.get('uiScale') ?? 1;
      const sel = h('select', { class: 'inp', 'aria-label': 'UI scale' }, ...[0.8, 0.9, 1, 1.1, 1.25, 1.5].map((v) => h('option', { value: String(v), selected: v === cur }, `${Math.round(v * 100)} %`)));
      sel.addEventListener('change', () => applyScale(Number(sel.value)));
      const r = await modal({ title: 'UI Scale', body: h('div', {}, field('Scale', sel), h('p', { class: 'hint' }, `Scales the ribbon, docks, dialogs and status bar. Images and graphics draw in device pixels (device pixel ratio ${window.devicePixelRatio || 1}).`)), buttons: ['OK', 'Cancel'], id: 'ui-scale' });
      if (r === 'OK') app.prefs.set('uiScale', Number(sel.value));
      applyScale(app.prefs.get('uiScale') ?? 1);
    },
  });
  app.setUiScale = (s) => {
    app.prefs.set('uiScale', s);
    applyScale(s);
  };

  /** Assign `ch` to `cmd` in the panel or global map; returns an error message or null. */
  app.assignHotkey = (cmd, ch, scope = 'global') => {
    if (RESERVED.has(ch)) return `${pretty(ch)} belongs to the browser (tabs and windows) and cannot be used`;
    if (scope === 'global' && FOCUS_ONLY.has(ch)) return `${pretty(ch)} works only while a panel has focus; assign it as a panel key`;
    const key = scope === 'pane' ? 'paneHotkeys' : 'hotkeys';
    const over = { ...(app.prefs.get(key) ?? {}) };
    for (const [c, v] of Object.entries(over)) if (v === cmd) delete over[c];
    over[ch] = cmd;
    app.prefs.set(key, over);
    app.keys.reload();
    return null;
  };

  C.implement('keys.customize', {
    run: async () => {
      const list = h('div', { class: 'grid-wrap', style: { maxHeight: '55vh', overflow: 'auto' }, tabindex: '0', role: 'region', 'aria-label': 'Hot keys' });
      const filter = h('input', { class: 'inp', type: 'search', placeholder: 'Filter commands', 'aria-label': 'Filter commands' });
      const note = h('p', { class: 'hint', 'aria-live': 'polite' });
      const render = () => {
        clear(list);
        const { global, pane } = app.keys.keyMap();
        const keysOf = (cmd) => [...Object.entries(global).filter(([, v]) => v === cmd).map(([k]) => ['global', k]), ...Object.entries(pane).filter(([, v]) => v === cmd).map(([k]) => ['pane', k])];
        const q = filter.value.trim().toLowerCase();
        const rows = [...app.commands.map.values()].filter((c) => c.implemented && (!q || c.label.toLowerCase().includes(q) || c.id.includes(q)));
        const tb = h('tbody');
        for (const c of rows.slice(0, 400)) {
          const ks = keysOf(c.id);
          const scope = h('select', { class: 'inp inp-small', 'aria-label': `Scope for ${c.label}` }, h('option', { value: 'global' }, 'anywhere'), h('option', { value: 'pane' }, 'panel'));
          if (ks[0]?.[0] === 'pane') scope.value = 'pane';
          const btn = h('button', { class: 'btn btn-small', 'aria-label': `Change the key of ${c.label}`, 'data-id': `hotkey:${c.id}` }, ks.length ? ks.map(([s, k]) => `${pretty(k)}${s === 'pane' ? ' (panel)' : ''}`).join(', ') : 'Set…');
          btn.addEventListener('click', () => {
            btn.textContent = 'Press a key…';
            const onKey = (e) => {
              if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
              e.preventDefault();
              e.stopPropagation();
              document.removeEventListener('keydown', onKey, true);
              if (e.key === 'Escape') return render();
              const err = app.assignHotkey(c.id, chord(e), scope.value);
              note.textContent = err ?? `${c.label}: ${pretty(chord(e))}${scope.value === 'pane' ? ' while a panel has focus' : ''}`;
              render();
            };
            document.addEventListener('keydown', onKey, true);
          });
          tb.appendChild(h('tr', {}, h('td', {}, c.label), h('td', { class: 'mono small' }, c.id), h('td', {}, scope), h('td', {}, btn)));
        }
        list.appendChild(h('table', { class: 'grid-table', 'aria-label': 'Commands and keys' }, h('thead', {}, h('tr', {}, ['Command', 'Id', 'Where', 'Key'].map((x) => h('th', { scope: 'col' }, x)))), tb));
      };
      filter.addEventListener('input', render);
      render();
      const reset = h('button', { class: 'btn' }, 'Reset All');
      reset.addEventListener('click', () => {
        app.prefs.set('hotkeys', {});
        app.prefs.set('paneHotkeys', {});
        app.keys.reload();
        note.textContent = 'All keys reset to the defaults.';
        render();
      });
      await modal({ title: 'Customize Hot Keys', body: h('div', {}, filter, list, h('div', {}, reset), note, h('p', { class: 'hint' }, 'Hold Space and move the mouse over a panel to pan (pan zone). Keys the browser keeps for tabs and windows cannot be assigned.')), buttons: ['Close'], width: 720, id: 'keys-customize' });
    },
  });
}
