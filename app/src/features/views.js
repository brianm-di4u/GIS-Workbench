// Navigation aids (REQ-IMG-13/14/15/22, REQ-UI-18): magnifying glass, overview dock and
// panel-in-panel, 2D bookmarks, the Link Manager (geo- or pixel-link with per-property
// selection), lat/lon, UTM and MGRS map grids, sun and sensor azimuth arrows, and image
// cycling and ordering in a panel.

import { h, clear } from '../shell/dom.js';
import { modal, field, section, promptBox } from '../shell/dialogs.js';
import { MiniPane } from '../shell/minipane.js';
import { invertView } from '../render/renderer.js';
import { newId, clone } from '../core/util.js';

export const name = 'views';

const DEG_STEPS = [30, 10, 5, 2, 1, 30 / 60, 15 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60, 30 / 3600, 15 / 3600, 10 / 3600, 5 / 3600, 2 / 3600, 1 / 3600, 0.5 / 3600, 0.2 / 3600, 0.1 / 3600];
const M_STEPS = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

/** Pick the step giving about `want` lines across `span`. */
export function niceStep(span, steps, want = 5) {
  return steps.find((s) => span / s >= want - 1) ?? steps.at(-1);
}

function dms(v, pos, neg, step) {
  const hemi = v < 0 ? neg : pos;
  const a = Math.abs(v);
  const d = Math.floor(a + 1e-9);
  const mf = (a - d) * 60;
  const m = Math.floor(mf + 1e-7);
  const s = (mf - m) * 60;
  if (step >= 1) return `${d}°${hemi}`;
  if (step >= 1 / 60) return `${d}°${String(m).padStart(2, '0')}′${hemi}`;
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(step < 1 / 3600 ? 1 : 0).padStart(2, '0')}″${hemi}`;
}

export function install(app) {
  installWindows(app);
  const C = app.commands;
  const pane = () => app.activePane();
  const hasImage = () => !!pane()?.layers().length;
  const hasModel = () => !!pane()?.geoLayer()?.modelId;
  const allPanes = () => app.desktop.multiports.flatMap((m) => m.panes);
  const redrawAll = () => {
    for (const p of allPanes()) p.invalidate();
    app.emit('state');
  };

  // ---- magnifier ----
  const mg = app.prefs.get('magnifier') ?? {};
  app.magnifier = {
    on: false,
    power: mg.power ?? 4,
    size: mg.size ?? 200,
    key(k) {
      if (k === 'ArrowUp') this.power = Math.min(32, this.power * 2);
      else if (k === 'ArrowDown') this.power = Math.max(2, this.power / 2);
      else if (k === 'ArrowRight') this.size = Math.min(480, this.size + 40);
      else if (k === 'ArrowLeft') this.size = Math.max(80, this.size - 40);
      else return false;
      app.prefs.set('magnifier', { power: this.power, size: this.size });
      redrawAll();
      return true;
    },
  };
  C.implement('nav.magnifier', {
    enabled: hasImage,
    checked: () => app.magnifier.on,
    run: () => {
      app.magnifier.on = !app.magnifier.on;
      if (app.magnifier.on) app.toast(`Magnifying glass ×${app.magnifier.power}, ${app.magnifier.size} px: arrow keys change power (up/down) and size (left/right)`);
      redrawAll();
    },
  });

  // ---- overview dock and panel-in-panel ----
  const regDock = (spec) => {
    const reg = (mp) => mp.docks.register(spec);
    app.on('ready', reg);
    const orig = app.desktop.addMultiport.bind(app.desktop);
    app.desktop.addMultiport = (id) => {
      const mp = orig(id);
      if (app._ready) reg(mp);
      return mp;
    };
  };
  regDock({
    id: 'overview',
    title: 'Overview',
    icon: 'overview',
    home: 'right',
    create: (a, mp, el) => {
      const mini = new MiniPane(app, { source: () => mp.activePane, className: 'minipane minipane-dock', label: 'Overview', copy: true });
      el.appendChild(mini.el);
      return { onShow: () => app.renderer.invalidate() };
    },
  });
  C.implement('ov.open', { enabled: hasImage, checked: () => !!app.activeMp()?.docks.isOpen('overview'), run: () => app.panels.toggle('overview', 'right') });
  C.implement('ov.pip', {
    enabled: hasImage,
    checked: () => !!pane()?.pip,
    run: () => {
      const p = pane();
      if (p.pip) {
        p.pip.dispose();
        p.pip = null;
      } else {
        p.pip = new MiniPane(app, { source: () => p, className: 'minipane minipane-pip', label: 'Panel-in-panel overview' });
        p.el.appendChild(p.pip.el);
      }
      redrawAll();
    },
  });

  // ---- 2D bookmarks (REQ-IMG-13) ----
  const bookmarks = () => app.store.all('bookmark');
  C.implement('bm.add', {
    enabled: hasImage,
    run: async () => {
      const p = pane();
      const l = p.geoLayer();
      const g = l?.modelId ? l.groundAt(p.view.cx, p.view.cy) : null;
      const where = g ? app.core.mgrs(g.lat, g.lon, 5) : `x ${p.view.cx.toFixed(0)}, y ${p.view.cy.toFixed(0)}`;
      const nm = await promptBox('Add 2D Bookmark', 'Name', `Bookmark ${bookmarks().length + 1}`, { hint: `At ${where}` });
      if (nm === null) return;
      const rec = { name: nm || 'Bookmark', created: new Date().toISOString(), rot: p.view.rot, mode: p.view.mode, image: l?.rec?.name ?? null };
      if (g) Object.assign(rec, { lat: g.lat, lon: g.lon, h: g.h, mpp: p.groundScale() });
      else Object.assign(rec, { x: p.view.cx, y: p.view.cy, zoom: p.view.zoom, fileref: l?.rec?.fileref ?? null });
      app.store.transact('Add bookmark', (tx) => tx.create('bookmark', rec));
      app.toast(`Bookmark "${rec.name}" added`);
    },
  });
  const goTo = (b) => {
    const p = pane();
    if (Number.isFinite(b.lat)) {
      p.centreOnGround(b.lat, b.lon, b.h);
      const own = p.groundScale();
      if (Number.isFinite(own) && Number.isFinite(b.mpp) && b.mpp > 0) p.setView({ zoom: p.view.zoom * (own / b.mpp) });
    } else p.setView({ cx: b.x, cy: b.y, zoom: b.zoom });
    if (b.mode && b.mode !== 'native') p.applyOrientation(b.mode);
    else p.setView({ rot: b.rot ?? 0 });
  };
  app.goToBookmark = goTo;
  C.implement('bm.list', {
    run: async () => {
      const body = h('div');
      const render = () => {
        clear(body);
        const list = bookmarks();
        if (!list.length) return body.appendChild(h('p', {}, 'No bookmarks yet. Home ▸ Bookmarks ▸ Add 2D Bookmark stores the current centre, scale and rotation.'));
        const tb = h('tbody');
        for (const b of list) {
          const go = h('button', { class: 'btn btn-small' }, 'Go');
          go.addEventListener('click', () => {
            try {
              goTo(b);
            } catch (e) {
              app.toast(e.message, { kind: 'warn' });
            }
          });
          const ren = h('button', { class: 'btn btn-small' }, 'Rename');
          ren.addEventListener('click', async () => {
            const n = await promptBox('Rename Bookmark', 'Name', b.name);
            if (n) app.store.transact('Rename bookmark', (tx) => tx.set(b.id, 'name', n));
            render();
          });
          const del = h('button', { class: 'btn btn-small' }, 'Delete');
          del.addEventListener('click', () => {
            app.store.transact('Delete bookmark', (tx) => tx.delete(b.id));
            render();
          });
          const loc = Number.isFinite(b.lat) ? app.core.mgrs(b.lat, b.lon, 5) : `image x ${Math.round(b.x)}, y ${Math.round(b.y)}`;
          const scale = Number.isFinite(b.mpp) ? `${b.mpp < 1 ? b.mpp.toFixed(2) : b.mpp.toFixed(1)} m/px` : `zoom ${b.zoom?.toFixed(3)}`;
          tb.appendChild(h('tr', { 'data-id': `bookmark:${b.id}` }, h('td', {}, b.name), h('td', { class: 'mono' }, loc), h('td', {}, scale), h('td', {}, b.image ?? ''), h('td', {}, go, ren, del)));
        }
        body.appendChild(h('table', { class: 'grid-table', 'aria-label': 'Bookmarks' }, h('thead', {}, h('tr', {}, ['Name', 'Location', 'Scale', 'Image', ''].map((x) => h('th', {}, x)))), tb));
      };
      render();
      await modal({ title: 'Bookmarks', body, buttons: ['Close'], width: 720, id: 'bookmarks' });
    },
  });

  // ---- Link Manager (REQ-IMG-15) ----
  const L = app.links;
  L.props = L.props ?? new Map(); // group id → {mode, centre, scale, rotation, chain}
  const DEFAULT_PROPS = { mode: 'geo', centre: true, scale: true, rotation: false, chain: false };
  const propsOf = (gid) => L.props.get(gid) ?? DEFAULT_PROPS;
  L.propagate = function propagate(src) {
    const gid = this.groups.get(src.id);
    if (!gid || this._busy) return;
    const pr = propsOf(gid);
    const sl = src.geoLayer();
    // A stereo panel links through its ground point at the cursor Z (REQ-STR-10).
    const gc = pr.mode === 'geo' && sl?.modelId ? (src.stereo ? src.stereo.centreGround() : sl.groundAt(src.view.cx, src.view.cy)) : null;
    const mpp = pr.scale ? src.groundScale() : NaN;
    this._busy = true;
    try {
      for (const p of allPanes()) {
        if (p === src || this.groups.get(p.id) !== gid) continue;
        const l = p.geoLayer();
        const v = {};
        if (gc && p.stereo) {
          p.stereo.centreOnGround(gc.lat, gc.lon, gc.h);
          continue;
        }
        if (gc && l?.modelId) {
          if (pr.centre) {
            const q = l.imageAt(gc.lat, gc.lon, gc.h);
            if (!q) continue;
            v.cx = q.x;
            v.cy = q.y;
          }
          if (pr.scale) {
            const own = p.groundScale();
            if (Number.isFinite(mpp) && Number.isFinite(own) && own > 0) v.zoom = p.view.zoom * (own / mpp);
          }
        } else {
          if (pr.centre) Object.assign(v, { cx: src.view.cx, cy: src.view.cy });
          if (pr.scale) v.zoom = src.view.zoom;
        }
        if (pr.rotation) Object.assign(v, { rot: src.view.rot, mode: src.view.mode === 'native' ? 'native' : 'free' });
        p.setView(v, { link: false });
        if (pr.rotation && src.view.mode && !['native', 'free'].includes(src.view.mode)) p.applyOrientation(src.view.mode);
      }
    } finally {
      this._busy = false;
    }
  };
  // Chain link: a chain change on a linked pane's active layer is copied to the others.
  app.store.on('commit', (cs) => {
    if (L._chainBusy || cs.kind === 'load') return;
    for (const o of cs.ops) {
      if (o.op !== 'set' || !(o.path === 'chain' || String(o.path).startsWith('chain.'))) continue;
      const lay = app.layers.get(o.id);
      const src = allPanes().find((p) => p.layers().includes(lay));
      const gid = src && L.groups.get(src.id);
      if (!gid || !propsOf(gid).chain) continue;
      L._chainBusy = true;
      try {
        for (const p of allPanes()) {
          if (p === src || L.groups.get(p.id) !== gid) continue;
          const t = p.activeLayer();
          if (!t?.chain || t.bands !== lay.bands) continue;
          const next = clone(lay.chain);
          next.manual = lay.chain.manual;
          app.store.transact('Linked chain', (tx) => tx.set(t.id, 'chain', next), { kind: 'edit' });
        }
      } finally {
        L._chainBusy = false;
      }
    }
  });
  C.implement('link.manager', {
    enabled: () => allPanes().length > 1,
    run: async () => {
      const groups = ['', 'A', 'B', 'C', 'D'];
      const gidFor = new Map([...L.groups.values()].filter((v, i, a) => a.indexOf(v) === i).map((g, i) => [g, groups[i + 1] ?? 'D']));
      const letterToGid = new Map([...gidFor].map(([g, l]) => [l, g]));
      const rows = allPanes().map((p) => {
        const s = h('select', { class: 'inp inp-short', 'aria-label': `Link group of ${p.mp.rec.name} panel ${p.mp.panes.indexOf(p) + 1}` }, groups.map((g) => h('option', { value: g }, g || 'not linked')));
        s.value = gidFor.get(L.groups.get(p.id)) ?? '';
        return { p, s };
      });
      const propRows = groups.slice(1).map((g) => {
        const pr = { ...propsOf(letterToGid.get(g)) };
        const mode = h('select', { class: 'inp inp-short', 'aria-label': `Link mode of group ${g}` }, h('option', { value: 'geo' }, 'Geo-link'), h('option', { value: 'pixel' }, 'Pixel-link'));
        mode.value = pr.mode;
        const cb = (k) => h('input', { type: 'checkbox', checked: !!pr[k], 'aria-label': `Group ${g}: link ${k}` });
        const c = { centre: cb('centre'), scale: cb('scale'), rotation: cb('rotation'), chain: cb('chain') };
        return { g, mode, c, tr: h('tr', {}, h('td', {}, g), h('td', {}, mode), ...Object.values(c).map((x) => h('td', {}, x))) };
      });
      const body = h(
        'div',
        {},
        section('Panels', h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Multiport'), h('th', {}, 'Panel'), h('th', {}, 'Image'), h('th', {}, 'Group'))), h('tbody', {}, rows.map(({ p, s }) => h('tr', {}, h('td', {}, p.mp.rec.name), h('td', {}, String(p.mp.panes.indexOf(p) + 1)), h('td', {}, p.activeLayer()?.rec?.name ?? '—'), h('td', {}, s)))))),
        section('Groups', h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, ['Group', 'Mode', 'Centre', 'Scale', 'Rotation', 'Chain'].map((x) => h('th', {}, x)))), h('tbody', {}, propRows.map((r) => r.tr)))),
        h('p', { class: 'hint' }, 'Geo-link matches the ground point at the centre and the ground scale through each image’s sensor model; pixel-link matches image coordinates. Chain copies the active layer’s enhancement chain to the other panels of the group.'),
      );
      if ((await modal({ title: 'Link Manager', body, buttons: ['OK', 'Cancel'], width: 640, id: 'link-manager' })) !== 'OK') return;
      const gid = new Map(groups.slice(1).map((g) => [g, letterToGid.get(g) ?? newId('link')]));
      L.groups.clear();
      for (const { p, s } of rows) if (s.value) L.groups.set(p.id, gid.get(s.value));
      for (const r of propRows) L.props.set(gid.get(r.g), { mode: r.mode.value, ...Object.fromEntries(Object.entries(r.c).map(([k, x]) => [k, x.checked])) });
      const first = allPanes().find((p) => L.groups.has(p.id) && p === pane()) ?? allPanes().find((p) => L.groups.has(p.id));
      if (first) L.propagate(first);
      app.emit('state');
    },
  });

  // ---- map grid (REQ-IMG-22) ----
  const gp = () => ({ type: 'off', last: 'latlon', colour: '#00e5ff', labels: true, ...(app.prefs.get('grid') ?? {}) });
  const setGrid = (patch) => {
    app.prefs.set('grid', { ...gp(), ...patch });
    redrawAll();
  };
  const toggleGrid = { enabled: hasModel, checked: () => gp().type !== 'off', run: () => setGrid(gp().type === 'off' ? { type: gp().last } : { type: 'off', last: gp().type }) };
  C.implement('grid.map', toggleGrid);
  C.implement('geo.grid', toggleGrid);
  C.implement('grid.props', {
    enabled: hasModel,
    run: async () => {
      const g = gp();
      const type = h('select', { class: 'inp' }, [['off', 'Off'], ['latlon', 'Latitude / longitude'], ['utm', 'UTM / UPS (metres)'], ['mgrs', 'MGRS (100 km square IDs)']].map(([v, l]) => h('option', { value: v }, l)));
      type.value = g.type === 'off' ? g.last : g.type;
      const colour = h('input', { type: 'color', value: g.colour, 'aria-label': 'Grid colour' });
      const labels = h('input', { type: 'checkbox', checked: g.labels });
      const interval = h('input', { class: 'inp inp-num', type: 'number', min: '0', step: 'any', value: String(g.interval ?? 0), 'aria-label': 'Interval (0 = automatic)' });
      const body = h('div', {}, field('Grid', type), field('Interval (degrees or metres; 0 = automatic)', interval), field('Colour', colour), h('label', { class: 'fld fld-inline' }, labels, h('span', {}, 'Labels')));
      if ((await modal({ title: 'Grid Properties', body, buttons: ['OK', 'Cancel'], id: 'grid-props' })) === 'OK') setGrid({ type: type.value, last: type.value === 'off' ? g.last : type.value, colour: colour.value, labels: labels.checked, interval: Number(interval.value) || 0 });
    },
  });

  /** Screen polyline of a ground curve, split where the model cannot map a point. */
  const strokeGround = (g, p, l, pts) => {
    let started = false;
    g.beginPath();
    for (const [lat, lon, hh] of pts) {
      const q = l.imageAt(lat, lon, hh);
      if (!q) {
        started = false;
        continue;
      }
      const s = p.screenPoint(q.x, q.y);
      if (started) g.lineTo(s.x, s.y);
      else g.moveTo(s.x, s.y);
      started = true;
    }
    g.stroke();
  };
  const viewGround = (p, l, w, hh) => {
    const pts = [];
    for (const [fx, fy] of [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5], [0.5, 0.5]]) {
      const ip = invertView(p.view, w, hh, fx * w, fy * hh);
      const gnd = l.groundAt(ip.x, ip.y);
      if (gnd) pts.push(gnd);
    }
    return pts;
  };
  /** Label where a screen-space line first enters the pane on the left or top edge. */
  const label = (g, text, x, y, colour) => {
    g.save(); // the halo must not leak into the grid lines drawn after a label
    g.font = '11px Arial, sans-serif';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(text, x, y);
    g.fillStyle = colour;
    g.fillText(text, x, y);
    g.restore();
  };
  function drawGrid(p, g, w, hh, l, cfg = gp()) {
    if (cfg.type === 'off' || !l?.modelId) return;
    const gs = viewGround(p, l, w, hh);
    if (gs.length < 5) return;
    // Lines lie on the ground at the centre's terrain height (off-nadir images shift with height).
    const ic = invertView(p.view, w, hh, w / 2, hh / 2);
    const hc = (l.groundWithTerrain?.(ic.x, ic.y) ?? gs.at(-1)).h;
    g.save();
    g.strokeStyle = cfg.colour;
    g.globalAlpha = 0.85;
    g.lineWidth = 1;
    const labelAt = (text, pts) => {
      if (!cfg.labels) return;
      for (const [lat, lon] of pts) {
        const q = l.imageAt(lat, lon, hc);
        if (!q) continue;
        const s = p.screenPoint(q.x, q.y);
        if (s.x >= 4 && s.x <= w - 40 && s.y >= 14 && s.y <= hh - 4) {
          label(g, text, s.x + 3, s.y - 3, cfg.colour);
          return;
        }
      }
    };
    if (cfg.type === 'latlon') {
      const lats = gs.map((q) => q.lat);
      const lons = gs.map((q) => q.lon);
      const [la0, la1, lo0, lo1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
      if (lo1 - lo0 > 180) return g.restore();
      const step = cfg.interval || niceStep(Math.max(la1 - la0, lo1 - lo0), DEG_STEPS);
      const n = 32;
      for (let lat = Math.ceil(la0 / step) * step; lat <= la1 + 1e-12; lat += step) {
        const pts = Array.from({ length: n + 1 }, (_, i) => [lat, lo0 + ((lo1 - lo0) * i) / n, hc]);
        strokeGround(g, p, l, pts);
        labelAt(dms(lat, 'N', 'S', step), pts);
      }
      for (let lon = Math.ceil(lo0 / step) * step; lon <= lo1 + 1e-12; lon += step) {
        const pts = Array.from({ length: n + 1 }, (_, i) => [la1 - ((la1 - la0) * i) / n, lon, hc]);
        strokeGround(g, p, l, pts);
        labelAt(dms(lon, 'E', 'W', step), pts);
      }
    } else {
      const c = gs.at(-1);
      let u;
      try {
        u = app.core.utm(c.lat, c.lon);
      } catch {
        return g.restore();
      }
      const en = gs.map((q) => {
        try {
          return app.core.utm(q.lat, q.lon, u.zone);
        } catch {
          return null;
        }
      }).filter(Boolean);
      const E = en.map((q) => q.easting);
      const N = en.map((q) => q.northing);
      const [e0, e1, n0, n1] = [Math.min(...E), Math.max(...E), Math.min(...N), Math.max(...N)];
      const step = cfg.interval || niceStep(Math.max(e1 - e0, n1 - n0), M_STEPS);
      const n = 24;
      const ll = (e, nn) => {
        try {
          const r = app.core.utmReverse(u.zone, u.north, e, nn);
          return [r.lat, r.lon, hc];
        } catch {
          return [NaN, NaN, hc];
        }
      };
      const ok = (pts) => pts.filter((q) => Number.isFinite(q[0]));
      const mgrsLabel = (lat, lon, axis) => {
        try {
          const digits = Math.max(1, Math.min(5, 5 - Math.round(Math.log10(step))));
          const m = /^(\d{0,2}[A-Z])([A-Z]{2})(\d*)$/.exec(app.core.mgrs(lat, lon, digits).replace(/\s+/g, ''));
          if (!m) return '';
          const d = m[3];
          return `${m[2]} ${axis === 'e' ? d.slice(0, d.length / 2) : d.slice(d.length / 2)}`;
        } catch {
          return '';
        }
      };
      for (let e = Math.ceil(e0 / step) * step; e <= e1 + 1e-6; e += step) {
        const pts = ok(Array.from({ length: n + 1 }, (_, i) => ll(e, n1 - ((n1 - n0) * i) / n)));
        strokeGround(g, p, l, pts);
        const mid = ll(e + 0.5, (n0 + n1) / 2);
        labelAt(cfg.type === 'mgrs' ? mgrsLabel(mid[0], mid[1], 'e') : `${(e / 1000).toFixed(step < 1000 ? 2 : 0)}kE`, pts);
      }
      for (let nn = Math.ceil(n0 / step) * step; nn <= n1 + 1e-6; nn += step) {
        const pts = ok(Array.from({ length: n + 1 }, (_, i) => ll(e0 + ((e1 - e0) * i) / n, nn)));
        strokeGround(g, p, l, pts);
        const mid = ll((e0 + e1) / 2, nn + 0.5);
        labelAt(cfg.type === 'mgrs' ? mgrsLabel(mid[0], mid[1], 'n') : `${(nn / 1000).toFixed(step < 1000 ? 2 : 0)}kN`, pts);
      }
      if (cfg.labels) label(g, cfg.type === 'mgrs' ? `MGRS ${u.zone}` : `UTM ${u.zone}${u.north ? 'N' : 'S'} · ${step >= 1000 ? `${step / 1000} km` : `${step} m`}`, 8, hh - 44, cfg.colour);
    }
    g.restore();
  }

  // ---- sun and sensor azimuth arrows ----
  const deco = (k) => (app.prefs.get('decorations') ?? {})[k];
  const decoToggle = (k) => ({
    enabled: hasModel,
    checked: () => deco(k) === true,
    run: () => {
      app.prefs.set('decorations', { ...(app.prefs.get('decorations') ?? {}), [k]: deco(k) !== true });
      redrawAll();
    },
  });
  C.implement('deco.sun', decoToggle('sun'));
  C.implement('deco.sensor', decoToggle('sensor'));

  /** Ground azimuth of the sensor at a ground point, from the height displacement direction. */
  app.sensorAzimuth = (l, gpt) => {
    const p0 = l.imageAt(gpt.lat, gpt.lon, gpt.h);
    const p1 = l.imageAt(gpt.lat, gpt.lon, gpt.h + 50);
    if (!p0 || !p1 || Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1e-3) return null;
    // A raised point moves away from the sensor's ground position: step the other way.
    const q = l.groundAt(p0.x - (p1.x - p0.x), p0.y - (p1.y - p0.y), gpt.h);
    if (!q) return null;
    const inv = app.core.inverse(gpt.lat, gpt.lon, q.lat, q.lon);
    // Obliquity: ground displacement of a 50 m rise.
    const r = l.groundAt(p1.x, p1.y, gpt.h);
    const d = r ? app.core.inverse(gpt.lat, gpt.lon, r.lat, r.lon).distance : NaN;
    return { azimuth: (inv.azi1 + 360) % 360, elevation: Number.isFinite(d) && d > 0 ? (Math.atan2(50, d) * 180) / Math.PI : 90 };
  };
  const arrow = (g, p, l, gpt, az, x, y, colour, text) => {
    const t = app.core.direct(gpt.lat, gpt.lon, az, 50);
    const a = l.imageAt(gpt.lat, gpt.lon, gpt.h);
    const b = l.imageAt(t.lat, t.lon, gpt.h);
    if (!a || !b) return;
    const sa = p.screenPoint(a.x, a.y);
    const sb = p.screenPoint(b.x, b.y);
    const ang = Math.atan2(sb.y - sa.y, sb.x - sa.x);
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.strokeStyle = colour;
    g.fillStyle = colour;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-14, 0);
    g.lineTo(12, 0);
    g.stroke();
    g.beginPath();
    g.moveTo(16, 0);
    g.lineTo(8, -5);
    g.lineTo(8, 5);
    g.closePath();
    g.fill();
    g.restore();
    label(g, text, x + 20, y + 4, colour);
  };

  app.drawGrid = drawGrid; // products draw the same grid into their frames
  app.paneDecorations = (p, g, w, hh, l) => {
    drawGrid(p, g, w, hh, l);
    if (!l?.modelId) return;
    const gc = l.groundAt(p.view.cx, p.view.cy);
    if (!gc) return;
    if (deco('sun') === true) {
      const s = l.info.sun ?? app.sunFor(l, gc);
      if (s) arrow(g, p, l, gc, s.azimuth, 30, 100, '#ffd400', `Sun ${s.azimuth.toFixed(0)}° el ${s.elevation.toFixed(0)}°`);
    }
    if (deco('sensor') === true) {
      const s = app.sensorAzimuth(l, gc);
      if (s) arrow(g, p, l, gc, s.azimuth, 30, 124, '#7cf', `Sensor ${s.azimuth.toFixed(0)}° el ${s.elevation.toFixed(0)}°`);
    }
  };

  // ---- image cycling and order (REQ-UI-18) ----
  const images = (p) => p.layers().filter((l) => l.kind !== 'dem');
  const cycle = (d) => {
    const p = pane();
    const ls = images(p);
    if (ls.length < 2) return;
    const cur = ls.indexOf(p.activeLayer());
    const next = ls[(cur + d + ls.length) % ls.length];
    app.store.transact(d > 0 ? 'Next image' : 'Previous image', (tx) => {
      for (const l of ls) tx.set(l.id, 'visible', l === next);
      tx.set(p.id, 'activeLayer', next.id);
    });
    p.invalidate();
    app.toast(next.rec.name);
  };
  C.implement('lay.next', { enabled: () => images(pane() ?? { layers: () => [] }).length > 1, run: () => cycle(1) });
  C.implement('lay.prev', { enabled: () => images(pane() ?? { layers: () => [] }).length > 1, run: () => cycle(-1) });
  C.implement('lay.order', {
    enabled: () => (pane()?.layers().length ?? 0) > 1,
    run: async () => {
      const p = pane();
      let order = [...p.rec.layers];
      const list = h('ol', { class: 'order-list' });
      const render = () => {
        clear(list);
        [...order].reverse().forEach((id) => {
          const l = app.layers.get(id);
          const i = order.indexOf(id);
          const up = h('button', { class: 'btn btn-small', disabled: i === order.length - 1, 'aria-label': `Move ${l?.rec?.name} up` }, '▲');
          const dn = h('button', { class: 'btn btn-small', disabled: i === 0, 'aria-label': `Move ${l?.rec?.name} down` }, '▼');
          up.addEventListener('click', () => {
            [order[i], order[i + 1]] = [order[i + 1], order[i]];
            render();
          });
          dn.addEventListener('click', () => {
            [order[i], order[i - 1]] = [order[i - 1], order[i]];
            render();
          });
          list.appendChild(h('li', {}, up, dn, ' ', l?.rec?.name ?? id));
        });
      };
      render();
      if ((await modal({ title: 'Order Images', body: h('div', {}, h('p', { class: 'hint' }, 'Top of the list draws on top.'), list), buttons: ['OK', 'Cancel'], id: 'order-images' })) !== 'OK') return;
      app.store.transact('Order images', (tx) => tx.set(p.id, 'layers', order));
      app.emit('layers');
      p.invalidate();
    },
  });
}

/** Window commands (REQ-UI-02) and panel properties (REQ-UI-18); installed with the views. */
export function installWindows(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const mpNow = () => app.activeMp();

  C.implement('win.clone', {
    enabled: () => !!mpNow(),
    run: async () => {
      const src = mpNow();
      const id = newId('mp');
      const pids = src.panes.map(() => newId('pane'));
      const made = [];
      app.store.transact('Clone Multiport', (tx) => {
        tx.create('multiport', { name: `${src.rec.name} (clone)`, layout: src.rec.layout, panes: pids, tabbed: !!src.rec.tabbed }, id);
        src.panes.forEach((p, i) => {
          const ids = [];
          let active = null;
          for (const l of p.layers()) {
            const { id: _old, ...rec } = clone(l.rec);
            const lid = tx.create('layer', { ...rec, pane: pids[i] });
            ids.push(lid);
            made.push(lid);
            if (l === p.activeLayer()) active = lid;
          }
          tx.create('pane', { multiport: id, layers: ids, activeLayer: active }, pids[i]);
        });
      });
      const mp = app.desktop.addMultiport(id);
      const byRef = new Map();
      for (const lid of made) {
        const r = app.store.get(lid);
        if (!byRef.has(r.file)) byRef.set(r.file, []);
        byRef.get(r.file).push(r);
      }
      const { attachLayers } = await import('../formats/open.js');
      for (const [ref, recs] of byRef) {
        const fref = app.store.get(ref);
        if (fref) await attachLayers(app, fref, recs).catch((e) => app.toast(`${fref.name}: ${e.message}`, { kind: 'error' }));
      }
      mp.panes.forEach((p, i) => p.setView({ ...src.panes[i].view }, { link: false }));
      app.emit('layers');
      app.toast(`Cloned ${src.rec.name}`);
    },
  });

  C.implement('win.separate', {
    enabled: () => (mpNow()?.panes.length ?? 0) > 1,
    run: async () => {
      const src = mpNow();
      const p = pane();
      const { layoutFor } = await import('../shell/multiport.js');
      const view = { ...p.view };
      const rest = src.rec.panes.filter((x) => x !== p.id && src.panes.some((q) => q.id === x));
      const id = newId('mp');
      app.store.transact('Separate Multiport', (tx) => {
        tx.create('multiport', { name: `Multiport_${app.desktop.multiports.length + 1}`, layout: '1x1', panes: [p.id] }, id);
        tx.set(p.id, 'multiport', id);
        tx.set(src.id, 'panes', rest);
        tx.set(src.id, 'layout', layoutFor(rest.length));
      });
      src.buildPanes();
      const mp = app.desktop.addMultiport(id);
      mp.panes[0].setView(view, { link: false });
      app.desktop.layout();
    },
  });

  C.implement('win.tabbed', {
    enabled: () => (mpNow()?.panes.length ?? 0) > 1,
    checked: () => !!mpNow()?.rec.tabbed,
    run: () => {
      const mp = mpNow();
      app.store.transact('Tabbed panels', (tx) => tx.set(mp.id, 'tabbed', !mp.rec.tabbed));
      mp.buildPanes();
    },
  });

  C.implement('panel.props', {
    enabled: () => !!pane(),
    run: async () => {
      const p = pane();
      const bg = p.background ?? [0, 0, 0, 1];
      const hex = `#${bg.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
      const col = h('input', { type: 'color', value: hex, 'aria-label': 'Panel background colour' });
      const lbl = h('input', { type: 'checkbox', checked: !p.el.classList.contains('no-label') });
      const body = h('div', {}, field('Background', col), h('label', { class: 'fld fld-inline' }, lbl, h('span', {}, 'Show the image name')), h('p', { class: 'hint' }, `Panel ${p.mp.panes.indexOf(p) + 1} of ${p.mp.rec.name}: ${p.layers().length} layer(s); zoom ${p.view.zoom.toFixed(4)}; orientation ${p.view.mode ?? 'native'}.`));
      if ((await modal({ title: 'Panel Properties', body, buttons: ['OK', 'Cancel'], id: 'panel-props' })) !== 'OK') return;
      const v = col.value;
      p.background = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).concat(1);
      app.store.transact('Panel properties', (tx) => tx.set(p.id, 'background', p.background), { kind: 'edit' });
      p.el.classList.toggle('no-label', !lbl.checked);
      p.invalidate();
    },
  });

  C.implement('panel.visibility', {
    enabled: () => !!pane()?.layers().length,
    run: async () => {
      const p = pane();
      const boxes = p.layers().map((l) => [l, h('input', { type: 'checkbox', checked: l.rec.visible !== false, 'aria-label': `Show ${l.rec.name}` })]);
      const body = h('div', {}, ...boxes.map(([l, b]) => h('label', { class: 'fld fld-inline' }, b, h('span', {}, l.rec.name))));
      if ((await modal({ title: 'Data Visibility', body, buttons: ['OK', 'Cancel'], id: 'data-visibility' })) !== 'OK') return;
      app.store.transact('Data visibility', (tx) => {
        for (const [l, b] of boxes) tx.set(l.id, 'visible', b.checked);
      });
      p.invalidate();
      app.emit('layers');
    },
  });
}
