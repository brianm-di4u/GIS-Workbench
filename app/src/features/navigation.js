// Navigation, rotation, linking, windows, themes and display commands (Home and View tabs).

import { modal, field } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { LAYOUTS } from '../shell/multiport.js';
import { KERNELS } from '../render/chain.js';
import { newId } from '../core/util.js';
import { setTheme, themePref } from '../shell/theme.js';
import { t, msgOf } from '../i18n/index.js';
import { length } from '../i18n/format.js';

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

  // Jump to Point (REQ-IMG-13, REQ-GEO-07): parse any format, echo, then move. Text that is not a
  // coordinate is looked up in the address index when one is open (REQ-GAP-85; nothing is sent).
  const parse = (text) => {
    try {
      return app.core.parse(String(text));
    } catch (e) {
      const [c] = app.routing?.geocoder ? app.routing.geocode(String(text), { limit: 1 }) : [];
      if (!c) throw e;
      return { lat: c.at[1], lon: c.at[0], format: t('Address'), notice: t('{address}, {score}% ({match})', { address: `${c.number ? `${c.number} ` : ''}${c.street}`, score: Math.round(c.score), match: c.match }), precisionM: NaN };
    }
  };
  const jump = async (text) => {
    const p = pane();
    if (!p) return;
    const r = parse(text);
    const fmt = r.format;
    const notice = r.notice;
    const prec = Number.isFinite(r.precisionM) ? length(r.precisionM, r.precisionM < 1 ? 2 : 0) : null;
    const detail = prec ? (notice ? t('{fmt}, {prec} precision; {notice}', { fmt, prec, notice }) : t('{fmt}, {prec} precision', { fmt, prec })) : notice ? t('{fmt}; {notice}', { fmt, notice }) : fmt;
    // The coordinate keeps its standard notation (DN-62 rule 7).
    const echo = t('{coord} ({detail})', { coord: app.core.format(r.lat, r.lon, 0, 6), detail });
    try {
      p.centreOnGround(r.lat, r.lon);
    } catch (e) {
      // A coordinate off the image (or a model that cannot invert it) is the user's input, not a fault.
      app.toast(t('{echo} is not on the image: {msg}', { echo, msg: msgOf(e) }), { kind: 'warn', ms: 6000 });
      return null;
    }
    app.toast(t('Jumped to {echo}', { echo }), { kind: 'info' });
    app.tools.flashGround?.(p, r.lat, r.lon);
    return r;
  };
  app.jumpTo = jump;
  C.implement('nav.jumpbox', { run: (text) => text && jump(text), enabled: hasModel });
  C.implement('nav.jump', {
    enabled: hasModel,
    run: async () => {
      const inp = h('input', { class: 'inp', type: 'text', placeholder: t('e.g. {examples}', { examples: "38SMB4414084706, 33.3 44.4, 33°18'N 44°24'E" }), spellcheck: 'false' });
      const echo = h('div', { class: 'hint', 'aria-live': 'polite' }, t('Type a coordinate in any format (DD, DMS, DDM, MGRS, USNG, UTM, UPS, GARS, GEOREF).'));
      inp.addEventListener('input', () => {
        try {
          const r = parse(inp.value);
          echo.textContent = `→ ${app.core.format(r.lat, r.lon, 0, 6)} · ${r.format}${r.notice ? ` · ${r.notice}` : ''}`;
        } catch (e) {
          echo.textContent = inp.value ? `✗ ${msgOf(e)}` : '';
        }
      });
      const r = await modal({ title: t('Jump to Point'), body: h('div', {}, field(t('Coordinate'), inp), echo), buttons: [{ label: t('Jump'), value: 'jump', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'jump' });
      if (r !== 'jump') return;
      // A blank entry is a hint, a bad one a named message; neither reaches the console (TE-046).
      if (!inp.value.trim()) return app.toast(t('Jump to Point: type a coordinate first'), { kind: 'warn' });
      try {
        await jump(inp.value);
      } catch (e) {
        app.toast(t('Jump to Point: {msg}', { msg: msgOf(e) }), { kind: 'error' });
      }
    },
  });

  // Interpolation (REQ-IMG-02).
  C.implement('view.interpolation', {
    run: () => {},
    enabled: hasImage,
    options: () => KERNELS.map((k) => ({ value: k, label: { nearest: t('Nearest'), bilinear: t('Bilinear'), bicubic: t('Bicubic'), lanczos3: t('Lanczos-3') }[k] ?? k })),
    value: () => app.activeLayer()?.chain?.kernel ?? 'bicubic',
    setValue: (v) => app.setChain((c) => (c.kernel = v), t('Interpolation')),
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
      if (!Number.isFinite(deg)) return app.toast(t('Type an angle in degrees'), { kind: 'warn' });
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
      // The other program's cursor, when sync with ArcGIS Pro is on (sidecar/native-ui.js).
      const far = this.outside?.(p);
      if (far) return far;
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
      app.toast(t('All panels geo-linked (centre and ground scale)'), { kind: 'info' });
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
      app.store.transact(t('New Multiport'), (tx) => {
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
    { label: t('New Multiport'), run: () => C.run('win.new') },
    '-',
    { label: t('Tile'), checked: app.desktop.arrange === 'tile', run: () => app.desktop.setArrange('tile') },
    { label: t('Tabs'), checked: app.desktop.arrange === 'tabs', run: () => app.desktop.setArrange('tabs') },
    '-',
    { label: t('Workspace'), run: () => app.desktop.focus(app.desktop.workspace) },
    ...app.desktop.multiports.map((mp) => ({ label: mp.rec.name, run: () => app.desktop.focus(mp) })),
  ];

  // Themes (REQ-UI-12); 'system' follows the OS light or dark setting (DN-60).
  const theme = (th) => ({
    run: () => setTheme(app, th),
    checked: () => themePref(app) === th,
  });
  C.implement('theme.system', theme('system'));
  C.implement('theme.grey', theme('grey'));
  C.implement('theme.dark', theme('dark'));
  C.implement('theme.print', theme('print'));
  C.implement('theme.m3light', theme('m3-light'));
  C.implement('theme.m3dark', theme('m3-dark'));
  C.implement('display.theme', {
    run: () => {
      const th = document.documentElement.dataset.theme;
      if (th?.startsWith('m3')) return C.run(th === 'm3-dark' ? 'theme.m3light' : 'theme.m3dark');
      return C.run(th === 'grey' ? 'theme.dark' : 'theme.grey');
    },
    menu: () => [{ cmd: 'theme.system' }, '-', { cmd: 'theme.m3light' }, { cmd: 'theme.m3dark' }, '-', { cmd: 'theme.grey' }, { cmd: 'theme.dark' }, { cmd: 'theme.print' }],
  });

  // Analysis fullscreen with Keyboard Lock (REQ-UI-10).
  C.implement('display.fullscreen', {
    enabled: () => app.runMode.caps.fullscreen !== false,
    checked: () => !!document.fullscreenElement,
    run: async () => {
      if (document.fullscreenElement) return document.exitFullscreen();
      await document.documentElement.requestFullscreen();
      try {
        await navigator.keyboard?.lock?.(['KeyT', 'Digit1', 'F5', 'KeyW', 'KeyN']);
        app.toast(t('Analysis Fullscreen: browser shortcuts are captured. Hold Esc to leave.'), { kind: 'info' });
      } catch {
        app.toast(t('Fullscreen on. Keyboard Lock is not available here, so Ctrl+T and Ctrl+1 use their alternates.'), { kind: 'info' });
      }
    },
  });
  document.addEventListener('fullscreenchange', () => app.emit('state'));

  // Decorations (REQ-IMG-22).
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

  // Workspace views.
  C.implement('ws.dataview', { run: () => app.desktop.workspace.setView('data') });
  C.implement('ws.windowsview', { run: () => app.desktop.workspace.setView('windows') });
  C.implement('ws.mapview', { run: () => app.desktop.workspace.map.zoomToFootprints() });
  C.implement('ws.preview', { run: () => app.desktop.focus(app.desktop.workspace) });
  /** Make a layer active in the panel that holds it and fit it (snackbar "Zoom to layer"). */
  app.zoomToLayer = (layerId) => {
    for (const mp of app.desktop.multiports) {
      for (const p of mp.panes) {
        if (!(p.rec?.layers ?? []).includes(layerId)) continue;
        mp.setActivePane(p);
        if (p.rec.activeLayer !== layerId) app.store.transact(t('Set active layer'), (tx) => tx.set(p.id, 'activeLayer', layerId), { kind: 'load' });
        p.fitWhole();
        return true;
      }
    }
    return false;
  };
  C.implement('ui.palette', { run: (q) => app.palette.open(typeof q === 'string' ? q : '') });
  C.implement('win.workspace', {
    run: () => app.desktop.setWorkspaceCollapsed(!app.desktop.wsCollapsed),
    checked: () => !app.desktop.wsCollapsed,
  });
  // Interface layout (REQ-SHL-01): switches the chrome live; the project, view and selection stay.
  app.setLayout = (mode) => {
    app.prefs.set('layout', mode === 'classic' ? 'classic' : 'modern');
    app.shell?.apply(app.layoutMode());
    app.emit('state');
  };
  C.implement('ui.layout', {
    run: (mode) => {
      const next = typeof mode === 'string' ? mode : app.layoutMode() === 'modern' ? 'classic' : 'modern';
      app.setLayout(next);
      app.toast(next === 'classic' ? t('Classic layout: Ribbon and docks as in 1.x. Switch back from View ▸ Display or the palette (Ctrl+K).') : t('Modern layout: clean canvas. Switch back from View ▸ Display or the palette (Ctrl+K).'), { kind: 'info' });
    },
    checked: () => app.layoutMode() === 'classic',
  });
}
