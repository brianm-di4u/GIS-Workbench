// Navigation, rotation, linking, windows, themes and display commands (Home and View tabs).

import { modal, field } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { LAYOUTS } from '../shell/multiport.js';
import { KERNELS } from '../render/chain.js';
import { newId } from '../core/util.js';

export const name = 'navigation';

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const hasImage = () => !!pane()?.layers().length;
  const hasModel = () => !!pane()?.geoLayer()?.modelId;

  C.implement('nav.whole', { run: () => pane()?.fitWhole(), enabled: hasImage });
  C.implement('nav.onetoone', { run: () => pane()?.oneToOne(), enabled: hasImage });
  const zoomBy = (f) => {
    const p = pane();
    if (!p) return;
    const { w, h: hh } = p.size();
    p.zoomAt(f, w / 2, hh / 2);
  };
  C.implement('nav.zoomin', { run: () => zoomBy(2 ** 0.5), enabled: hasImage });
  C.implement('nav.zoomout', { run: () => zoomBy(2 ** -0.5), enabled: hasImage });
  C.implement('nav.roam', { run: () => pane()?.toggleFullRoam(), enabled: hasImage, checked: () => !!pane()?.fullRoam });
  C.implement('nav.glove', { run: () => app.tools.select(null), checked: () => !app.tools.current });
  C.implement('nav.recenter', { run: () => app.tools.select('recenter'), enabled: hasImage, checked: () => app.tools.current?.id === 'recenter' });
  C.implement('nav.zoombox', { run: () => app.tools.select('zoombox'), enabled: hasImage, checked: () => app.tools.current?.id === 'zoombox' });

  // Jump to Point (REQ-IMG-13, REQ-GEO-07): parse any format, echo, then move.
  const jump = async (text) => {
    const p = pane();
    if (!p) return;
    const r = app.core.parse(String(text));
    const echo = `${app.core.format(r.lat, r.lon, 0, 6)} (${r.format}${Number.isFinite(r.precisionM) ? `, ${r.precisionM < 1 ? r.precisionM.toFixed(2) : Math.round(r.precisionM)} m precision` : ''}${r.notice ? `; ${r.notice}` : ''})`;
    p.centreOnGround(r.lat, r.lon);
    app.toast(`Jumped to ${echo}`);
    app.tools.flashGround?.(p, r.lat, r.lon);
    return r;
  };
  app.jumpTo = jump;
  C.implement('nav.jumpbox', { run: (text) => text && jump(text), enabled: hasModel });
  C.implement('nav.jump', {
    enabled: hasModel,
    run: async () => {
      const inp = h('input', { class: 'inp', type: 'text', placeholder: 'e.g. 38SMB4414084706, 33.3 44.4, 33°18\'N 44°24\'E', spellcheck: 'false' });
      const echo = h('div', { class: 'hint', 'aria-live': 'polite' }, 'Type a coordinate in any format (DD, DMS, DDM, MGRS, USNG, UTM, UPS, GARS, GEOREF).');
      inp.addEventListener('input', () => {
        try {
          const r = app.core.parse(inp.value);
          echo.textContent = `→ ${app.core.format(r.lat, r.lon, 0, 6)} · ${r.format}${r.notice ? ` · ${r.notice}` : ''}`;
        } catch (e) {
          echo.textContent = inp.value ? `✗ ${e.message}` : '';
        }
      });
      const r = await modal({ title: 'Jump to Point', body: h('div', {}, field('Coordinate', inp), echo), buttons: ['Jump', 'Cancel'], id: 'jump' });
      if (r !== 'Jump') return;
      // A blank entry is a hint, a bad one a named message; neither reaches the console (TE-046).
      if (!inp.value.trim()) return app.toast('Jump to Point: type a coordinate first', { kind: 'warn' });
      try {
        await jump(inp.value);
      } catch (e) {
        app.toast(`Jump to Point: ${e.message}`, { kind: 'error' });
      }
    },
  });

  // Interpolation (REQ-IMG-02).
  C.implement('view.interpolation', {
    run: () => {},
    enabled: hasImage,
    options: () => KERNELS.map((k) => ({ value: k, label: { nearest: 'Nearest', bilinear: 'Bilinear', bicubic: 'Bicubic', lanczos3: 'Lanczos-3' }[k] })),
    value: () => app.activeLayer()?.chain?.kernel ?? 'bicubic',
    setValue: (v) => app.setChain((c) => (c.kernel = v), 'Interpolation'),
  });

  // Rotation (REQ-IMG-12).
  const rot = (mode) => ({ run: () => pane()?.applyOrientation(mode), enabled: mode === 'native' ? hasImage : hasModel, checked: () => pane()?.view.mode === mode });
  C.implement('rot.zero', rot('native'));
  C.implement('rot.north', rot('north'));
  C.implement('rot.upisup', rot('upisup'));
  C.implement('rot.shadows', {
    ...rot('shadows'),
    enabled: () => {
      const l = pane()?.geoLayer();
      return !!(l?.modelId && (l.info.sun || /^\d{14}$/.test(String(l.info.datetime ?? '').trim())));
    },
  });
  C.implement('rot.mouse', { run: () => app.tools.select('rotate'), enabled: hasImage, checked: () => app.tools.current?.id === 'rotate' });
  C.implement('rot.angle', {
    enabled: hasImage,
    run: (v) => {
      const deg = Number(String(v).replace(/[°\s]/g, ''));
      if (!Number.isFinite(deg)) return app.toast('Type an angle in degrees');
      pane()?.setView({ rot: (deg * Math.PI) / 180, mode: 'free' });
    },
  });

  // Linking (REQ-IMG-15): geo-link of centre and ground scale; cursor link.
  app.links = {
    groups: new Map(), // pane id → group id
    propagate(src) {
      const g = this.groups.get(src.id);
      if (!g || this._busy) return;
      const sl = src.geoLayer();
      const gc = sl?.groundAt(src.view.cx, src.view.cy);
      const mpp = src.groundScale();
      this._busy = true;
      try {
        for (const mp of app.desktop.multiports)
          for (const p of mp.panes) {
            if (p === src || this.groups.get(p.id) !== g) continue;
            const l = p.geoLayer();
            if (gc && l?.modelId) {
              const q = l.imageAt(gc.lat, gc.lon, gc.h);
              if (!q) continue;
              const v = { cx: q.x, cy: q.y };
              const own = p.groundScale();
              if (Number.isFinite(mpp) && Number.isFinite(own) && own > 0) v.zoom = p.view.zoom * (own / mpp);
              p.setView(v, { link: false });
            } else p.setView({ cx: src.view.cx, cy: src.view.cy, zoom: src.view.zoom, rot: src.view.rot }, { link: false });
          }
      } finally {
        this._busy = false;
      }
    },
    cursorFor(p) {
      const c = app.cursorGround;
      if (!c || c.pane === p || !this.groups.has(p.id) || this.groups.get(p.id) !== this.groups.get(c.pane.id)) return null;
      const l = p.geoLayer();
      const q = l?.imageAt(c.lat, c.lon, c.h);
      return q ? p.screenPoint(q.x, q.y) : null;
    },
  };
  C.implement('link.all', {
    enabled: () => (app.activeMp()?.panes.length ?? 0) > 1 || app.desktop.multiports.length > 1,
    checked: () => !!pane() && app.links.groups.has(pane().id),
    run: () => {
      const gid = newId('link');
      for (const mp of app.desktop.multiports) for (const p of mp.panes) app.links.groups.set(p.id, gid);
      app.links.propagate(pane());
      app.toast('All panels geo-linked (centre and ground scale)');
      app.emit('state');
    },
  });
  C.implement('link.unlink', {
    enabled: () => app.links.groups.size > 0,
    run: () => {
      app.links.groups.clear();
      app.emit('state');
    },
  });

  // Windows and layouts (REQ-UI-02).
  // The button toggles between one panel and the last split chosen from its menu (GUI-004).
  let lastSplit = '1x2';
  C.implement('win.split', {
    run: () => {
      const mp = app.activeMp();
      if (mp) mp.setLayout(mp.rec.layout === '1x1' ? lastSplit : '1x1');
    },
    checked: () => (app.activeMp()?.rec.layout ?? '1x1') !== '1x1',
    menu: () =>
      Object.keys(LAYOUTS).map((k) => ({
        label: k.replace('x', ' × '),
        checked: app.activeMp()?.rec.layout === k,
        run: () => {
          if (k !== '1x1') lastSplit = k;
          app.activeMp()?.setLayout(k);
        },
      })),
  });
  C.implement('win.new', {
    run: () => {
      const n = app.desktop.multiports.length + 1;
      const id = newId('mp');
      const pid = newId('pane');
      app.store.transact('New Multiport', (tx) => {
        tx.create('multiport', { name: `Multiport_${n}`, layout: '1x1', panes: [pid] }, id);
        tx.create('pane', { multiport: id, layers: [], activeLayer: null }, pid);
      });
      app.desktop.addMultiport(id);
    },
  });
  C.implement('win.close', {
    enabled: () => app.desktop.multiports.length > 1,
    run: () => app.desktop.removeMultiport(app.activeMp()),
  });
  app.windowMenu = () => [
    { label: 'New Multiport', run: () => C.run('win.new') },
    '-',
    { label: 'Tile', checked: app.desktop.arrange === 'tile', run: () => app.desktop.setArrange('tile') },
    { label: 'Tabs', checked: app.desktop.arrange === 'tabs', run: () => app.desktop.setArrange('tabs') },
    '-',
    { label: 'Workspace', run: () => app.desktop.focus(app.desktop.workspace) },
    ...app.desktop.multiports.map((mp) => ({ label: mp.rec.name, run: () => app.desktop.focus(mp) })),
  ];

  // Themes (REQ-UI-12).
  const theme = (t) => ({
    run: () => {
      document.documentElement.dataset.theme = t;
      app.prefs.set('theme', t);
      app.emit('state');
    },
    checked: () => document.documentElement.dataset.theme === t,
  });
  C.implement('theme.grey', theme('grey'));
  C.implement('theme.dark', theme('dark'));
  C.implement('theme.print', theme('print'));
  C.implement('display.theme', {
    run: () => C.run(document.documentElement.dataset.theme === 'grey' ? 'theme.dark' : 'theme.grey'),
    menu: () => [{ cmd: 'theme.grey' }, { cmd: 'theme.dark' }, { cmd: 'theme.print' }],
  });

  // Exploitation fullscreen with Keyboard Lock (REQ-UI-10).
  C.implement('display.fullscreen', {
    enabled: () => app.runMode.caps.fullscreen !== false,
    checked: () => !!document.fullscreenElement,
    run: async () => {
      if (document.fullscreenElement) return document.exitFullscreen();
      await document.documentElement.requestFullscreen();
      try {
        await navigator.keyboard?.lock?.(['KeyT', 'Digit1', 'F5', 'KeyW', 'KeyN']);
        app.toast('Exploitation Fullscreen: browser shortcuts are captured. Hold Esc to leave.');
      } catch {
        app.toast('Fullscreen on. Keyboard Lock is not available here, so Ctrl+T and Ctrl+1 use their alternates.');
      }
    },
  });
  document.addEventListener('fullscreenchange', () => app.emit('state'));

  // Decorations (REQ-IMG-22, REQ-SEC-04).
  const deco = (k) => ({
    run: () => {
      const d = { ...(app.prefs.get('decorations') ?? {}) };
      d[k] = d[k] === false;
      app.prefs.set('decorations', d);
      for (const mp of app.desktop.multiports) for (const p of mp.panes) p.invalidate();
      app.emit('state');
    },
    checked: () => (app.prefs.get('decorations') ?? {})[k] !== false,
  });
  C.implement('deco.north', deco('north'));
  C.implement('deco.scalebar', deco('scalebar'));
  C.implement('deco.banners', deco('banners'));

  // Workspace views.
  C.implement('ws.dataview', { run: () => app.desktop.workspace.setView('data') });
  C.implement('ws.windowsview', { run: () => app.desktop.workspace.setView('windows') });
  C.implement('ws.mapview', { run: () => app.desktop.workspace.map.zoomToFootprints() });
  C.implement('ws.preview', { run: () => app.desktop.focus(app.desktop.workspace) });
}
