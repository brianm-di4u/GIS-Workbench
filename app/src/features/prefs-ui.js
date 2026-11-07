// Customize Hot Keys (REQ-UI-09) and UI scale (REQ-UI-17). Hot keys: every command with its
// key, changed by pressing the new chord; chords the browser keeps (new tab, close window …)
// are refused, and chords it uses outside the panel (F5, Ctrl+R …) are allowed as panel keys
// only. UI scale multiplies every size token of the chrome; graphics stay in device pixels.

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { chord, RESERVED, FOCUS_ONLY } from '../input/keys.js';
import { chordLabel } from '../shell/palette.js';
import { t, tc, tr } from '../i18n/index.js';
import { pct, numMax } from '../i18n/format.js';

export const name = 'prefs-ui';

// Key names (Ctrl, F5, KeyT → T) are shown as keyboards print them, untranslated.
// The key words (Ctrl, Shift, Del…) in the UI language, as the Keyboard Map shows them.
const pretty = (c) => chordLabel(c).replace(/\+/g, ' + ');

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
      const sel = h('select', { class: 'inp', 'aria-label': t('UI scale') }, ...[0.8, 0.9, 1, 1.1, 1.25, 1.5].map((v) => h('option', { value: String(v), selected: v === cur }, pct(v, 0))));
      sel.addEventListener('change', () => applyScale(Number(sel.value)));
      const r = await modal({ title: t('UI Scale'), body: h('div', {}, field(tc('ui size', 'Scale'), sel), h('p', { class: 'hint' }, t('Scales the ribbon, docks, dialogs and status bar. Images and graphics draw in device pixels (device pixel ratio {ratio}).', { ratio: numMax(window.devicePixelRatio || 1, 3) }))), buttons: [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'ui-scale' });
      if (r === 'ok') app.prefs.set('uiScale', Number(sel.value));
      applyScale(app.prefs.get('uiScale') ?? 1);
    },
  });
  app.setUiScale = (s) => {
    app.prefs.set('uiScale', s);
    applyScale(s);
  };

  /** Assign `ch` to `cmd` in the panel or global map; returns an error message (in the UI language) or null. */
  app.assignHotkey = (cmd, ch, scope = 'global') => {
    if (RESERVED.has(ch)) return t('{key} belongs to the browser (tabs and windows) and cannot be used', { key: pretty(ch) });
    if (scope === 'global' && FOCUS_ONLY.has(ch)) return t('{key} works only while a panel has focus; assign it as a panel key', { key: pretty(ch) });
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
      const list = h('div', { class: 'grid-wrap', style: { maxHeight: '55vh', overflow: 'auto' }, tabindex: '0', role: 'region', 'aria-label': t('Hot keys') });
      const filter = h('input', { class: 'inp', type: 'search', placeholder: t('Filter commands'), 'aria-label': t('Filter commands') });
      const note = h('p', { class: 'hint', 'aria-live': 'polite' });
      const render = () => {
        clear(list);
        const { global, pane } = app.keys.keyMap();
        const keysOf = (cmd) => [...Object.entries(global).filter(([, v]) => v === cmd).map(([k]) => ['global', k]), ...Object.entries(pane).filter(([, v]) => v === cmd).map(([k]) => ['pane', k])];
        const q = filter.value.trim().toLowerCase();
        // The filter matches the English label, the translated label and the id.
        const rows = [...app.commands.map.values()].filter((c) => c.implemented && (!q || c.label.toLowerCase().includes(q) || String(tr(c.label)).toLowerCase().includes(q) || c.id.includes(q)));
        const tb = h('tbody');
        for (const c of rows.slice(0, 400)) {
          const label = tr(c.label);
          const ks = keysOf(c.id);
          const scope = h('select', { class: 'inp inp-small', 'aria-label': t('Scope for {command}', { command: label }) }, h('option', { value: 'global' }, t('anywhere')), h('option', { value: 'pane' }, t('panel')));
          if (ks[0]?.[0] === 'pane') scope.value = 'pane';
          const btn = h('button', { class: 'btn btn-small', 'aria-label': t('Change the key of {command}', { command: label }), 'data-id': `hotkey:${c.id}` }, ks.length ? ks.map(([s, k]) => (s === 'pane' ? t('{key} (panel)', { key: pretty(k) }) : pretty(k))).join(', ') : t('Set…'));
          btn.addEventListener('click', () => {
            btn.textContent = t('Press a key…');
            const onKey = (e) => {
              if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
              e.preventDefault();
              e.stopPropagation();
              document.removeEventListener('keydown', onKey, true);
              if (e.key === 'Escape') return render();
              const err = app.assignHotkey(c.id, chord(e), scope.value);
              note.textContent = err ?? (scope.value === 'pane' ? t('{command}: {key} while a panel has focus', { command: label, key: pretty(chord(e)) }) : t('{command}: {key}', { command: label, key: pretty(chord(e)) }));
              render();
            };
            document.addEventListener('keydown', onKey, true);
          });
          tb.appendChild(h('tr', {}, h('td', {}, label), h('td', { class: 'mono small' }, c.id), h('td', {}, scope), h('td', {}, btn)));
        }
        list.appendChild(h('table', { class: 'grid-table', 'aria-label': t('Commands and keys') }, h('thead', {}, h('tr', {}, [t('Command'), t('Id'), t('Where'), tc('keyboard', 'Key')].map((x) => h('th', { scope: 'col' }, x)))), tb));
      };
      filter.addEventListener('input', render);
      render();
      const reset = h('button', { class: 'btn' }, t('Reset All'));
      reset.addEventListener('click', () => {
        app.prefs.set('hotkeys', {});
        app.prefs.set('paneHotkeys', {});
        app.keys.reload();
        note.textContent = t('All keys reset to the defaults.');
        render();
      });
      await modal({ title: t('Customize Hot Keys'), body: h('div', {}, filter, list, h('div', {}, reset), note, h('p', { class: 'hint' }, t('Hold Space and move the mouse over a panel to pan (pan zone). Keys the browser keeps for tabs and windows cannot be assigned.'))), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 720, id: 'keys-customize' });
    },
  });
}
