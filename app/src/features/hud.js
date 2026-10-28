// Tools at the cursor (2.0 plan P2; REQ-SHL-08, REQ-SHL-10, REQ-SHL-11): the contextual tool pill,
// the radial menu, and the cursor shortcuts — paste-to-pan, hold-F flicker, S+drag swipe,
// Alt+wheel opacity, C+drag quick chip, J/K target patrol with 1/2/3 triage, and the session deck.
// The pill and the radial menu belong to the Modern layout (the Classic layout has its Ribbon);
// the shortcuts work in both. Bare-letter keys act only while an image panel has focus, no text
// field or dialog does, and the feedback whiteboard is closed.

import { h, clear } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { metaOf } from '../shell/command-meta.js';
import { saveBlob } from '../storage/files.js';

export const name = 'hud';

/** Default radial tools (a persona can set its own: prefs 'radialItems'). */
export const DEFAULT_RADIAL = ['men.rangebearing', 'ai.smartselect', 'draw.marker', 'enh.auto', 'cmp.swiper', 'hud.quickchip', 'nav.whole', 'ui.palette'];

/** Contextual pill: the commands that matter for what is selected or active (REQ-SHL-08). */
export function pillCommands(app, ctx) {
  const out = [];
  const add = (...ids) => out.push(...ids);
  if (app.selection?.size) add('gfx.props', 'edit.copy', 'edit.delete');
  if (ctx.video) add('fmv.play', 'fmv.capture', 'fmv.klv', 'fmv.measure');
  else if (ctx.pointCloud || ctx.view3d) add('pc.colour.class', 'pc.measure', 'pc.profile', '3d.measure');
  else if (ctx.stereo) add('stereo.cursor', 'stereo.mheight', 'stereo.mdistance', 'stereo.swap');
  else if (ctx.sar) add('sar.remap', 'sar.speckle', 'sar.metadata', 'men.rangebearing');
  else if (ctx.activeLayer?.kind === 'vector') add('ext.vertices', 'ext.attributes', 'ext.attrtable', 'ext.saveas');
  else if (ctx.activeLayer?.kind === 'image') {
    if (ctx.hasDem && ctx.activeLayer && app.activeLayer()?.kind === 'dem') add('dem.hillshade', 'los.p2p', 'los.viewshed', '3d.open');
    else {
      add('enh.auto', 'men.rangebearing', 'draw.marker', 'hud.quickchip');
      if (ctx.multiband) add('bands.select', 'msi.index.ndvi');
      if (ctx.imageLayerCount > 1) add('cmp.swiper', 'cmp.play');
      add('ai.smartselect');
    }
  }
  return [...new Set(out)].filter((id) => app.commands.get(id)?.implemented).slice(0, 7);
}

function inText(e) {
  const t = e.target;
  return t?.closest?.('input, textarea, select, [contenteditable="true"], .dlg, [data-id="palette"]');
}

export function install(app) {
  const C = app.commands;
  const modern = () => app.layoutMode() === 'modern';
  const pane = () => app.activePane();
  const paneOf = (e) => {
    const el = e.target?.closest?.('.pane');
    if (!el) return null;
    for (const mp of app.desktop.multiports) for (const p of mp.panes) if (p.el === el) return p;
    return null;
  };
  const wbOn = () => !!app.feedback?.active;
  let pointer = { x: innerWidth / 2, y: innerHeight / 2 };
  document.addEventListener('pointermove', (e) => (pointer = { x: e.clientX, y: e.clientY }), { passive: true });

  // ---------------- Radial menu (REQ-SHL-10) ----------------
  const radial = { el: null, items: [], sel: -1 };
  const radialItems = () => (app.prefs.get('radialItems') ?? app.personas?.current()?.radial ?? DEFAULT_RADIAL).filter((id) => C.get(id)?.implemented);
  function closeRadial(run = false) {
    if (!radial.el) return;
    const it = radial.items[radial.sel];
    radial.el.remove();
    radial.el = null;
    if (run && it) C.run(it);
  }
  function openRadial(x, y) {
    closeRadial();
    const items = radialItems();
    if (!items.length) return;
    radial.items = items;
    radial.sel = -1;
    const R = 112;
    const r0 = 34;
    const n = items.length;
    const host = h('div', { class: 'radial', role: 'menu', 'aria-label': 'Radial menu', 'data-id': 'radial', style: { left: `${x}px`, top: `${y}px` } });
    const centre = h('div', { class: 'radial-centre' }, 'Esc');
    host.appendChild(centre);
    items.forEach((id, i) => {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const c = C.get(id);
      const b = h('button', { class: ['radial-item', !C.enabled(id) && 'off'], role: 'menuitem', type: 'button', 'data-id': `radial:${id}`, 'data-tip-cmd': id, style: { left: `calc(50% + ${Math.cos(a) * (R * 0.72)}px)`, top: `calc(50% + ${Math.sin(a) * (R * 0.72)}px)` } }, icon(c.icon, 20), h('span', {}, `${i + 1} ${c.label.replace(/…$/, '')}`));
      b.addEventListener('pointerenter', () => mark(i));
      b.addEventListener('click', () => {
        radial.sel = i;
        closeRadial(true);
      });
      host.appendChild(b);
    });
    const mark = (i) => {
      radial.sel = i;
      host.querySelectorAll('.radial-item').forEach((b, j) => b.classList.toggle('sel', j === i));
      centre.textContent = i >= 0 ? C.get(items[i]).label.replace(/…$/, '') : 'Esc';
    };
    radial.mark = mark;
    // Pointer direction picks the wedge (marking-menu style); the dead zone keeps nothing picked.
    radial.onMove = (e) => {
      const dx = e.clientX - x;
      const dy = e.clientY - y;
      if (Math.hypot(dx, dy) < r0) return mark(-1);
      let a = Math.atan2(dy, dx) + Math.PI / 2;
      if (a < 0) a += Math.PI * 2;
      mark(Math.round((a / (Math.PI * 2)) * n) % n);
    };
    document.body.appendChild(host);
    radial.el = host;
    // Keep it inside the window.
    const rr = host.getBoundingClientRect();
    if (rr.left < 4) host.style.left = `${x + 4 - rr.left}px`;
    if (rr.right > innerWidth - 4) host.style.left = `${x - (rr.right - innerWidth + 4)}px`;
    if (rr.top < 4) host.style.top = `${y + 4 - rr.top}px`;
    if (rr.bottom > innerHeight - 4) host.style.top = `${y - (rr.bottom - innerHeight + 4)}px`;
  }
  document.addEventListener('pointermove', (e) => radial.el && radial.onMove?.(e), { passive: true });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (radial.el && !radial.el.contains(e.target)) closeRadial();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!radial.el) return;
      const n = radial.items.length;
      if (e.key === 'Escape') closeRadial();
      else if (e.key === 'Enter') closeRadial(true);
      else if (/^[1-8]$/.test(e.key) && +e.key <= n) {
        radial.sel = +e.key - 1;
        closeRadial(true);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') radial.mark((radial.sel + 1) % n);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') radial.mark((radial.sel - 1 + n) % n);
      else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  app.radial = { open: openRadial, close: closeRadial, get isOpen() { return !!radial.el; } };
  C.implement('hud.radial', { run: () => openRadial(pointer.x, pointer.y) });

  // Space tap (< 200 ms, < 4 px, nothing else pressed) opens it; holding Space still pans.
  let space = null;
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || inText(e) || wbOn() || !modern()) {
      if (space && e.code !== 'Space') space.other = true;
      return;
    }
    const p = paneOf(e) ?? (document.activeElement?.classList.contains('pane') ? pane() : null);
    if (!p) return;
    space = { t: performance.now(), x: pointer.x, y: pointer.y, view: { ...p.view }, pane: p, other: false };
  });
  document.addEventListener('pointerdown', () => space && (space.other = true), true);
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !space) return;
    const s = space;
    space = null;
    const tap = performance.now() - s.t < 200 && Math.hypot(pointer.x - s.x, pointer.y - s.y) < 4 && !s.other;
    if (!tap) return;
    s.pane.setView({ cx: s.view.cx, cy: s.view.cy }); // undo any pan the tap caused
    openRadial(pointer.x, pointer.y);
  });
  // Backquote opens it from the keyboard.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote' || e.ctrlKey || e.metaKey || e.altKey || inText(e) || wbOn() || !modern() || radial.el) return;
    const p = paneOf(e) ?? (document.activeElement?.classList.contains('pane') ? pane() : null);
    if (!p) return;
    e.preventDefault();
    const r = p.el.getBoundingClientRect();
    const inside = pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
    openRadial(inside ? pointer.x : r.left + r.width / 2, inside ? pointer.y : r.top + r.height / 2);
  });
  // Right-button press and drag (> 8 px within 250 ms) is a marking menu; a plain right-click
  // still opens the context menu. Pen and touch: a 500 ms long press.
  let rdrag = null;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!modern() || wbOn()) return;
      const p = paneOf(e);
      if (!p) return;
      if (e.button === 2 && e.pointerType === 'mouse') rdrag = { x: e.clientX, y: e.clientY, t: performance.now(), opened: false };
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
        const start = { x: e.clientX, y: e.clientY };
        const timer = setTimeout(() => openRadial(start.x, start.y), 500);
        const cancel = (ev) => {
          if (ev.type !== 'pointermove' || Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 8) {
            clearTimeout(timer);
            document.removeEventListener('pointermove', cancel);
            document.removeEventListener('pointerup', cancel);
          }
        };
        document.addEventListener('pointermove', cancel);
        document.addEventListener('pointerup', cancel);
      }
    },
    true,
  );
  document.addEventListener('pointermove', (e) => {
    if (!rdrag || rdrag.opened) return;
    if (!(e.buttons & 2)) return void (rdrag = null);
    if (performance.now() - rdrag.t < 250 && Math.hypot(e.clientX - rdrag.x, e.clientY - rdrag.y) > 8) {
      rdrag.opened = true;
      openRadial(rdrag.x, rdrag.y);
    }
  });
  document.addEventListener(
    'pointerup',
    (e) => {
      if (rdrag?.opened && e.button === 2) closeRadial(true);
      if (e.button === 2) setTimeout(() => (rdrag = null), 0);
    },
    true,
  );
  document.addEventListener(
    'contextmenu',
    (e) => {
      if (rdrag?.opened || radial.el) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  // ---------------- Contextual tool pill (REQ-SHL-08) ----------------
  const pill = h('div', { class: 'tool-pill', role: 'toolbar', 'aria-label': 'Tools for the current selection', 'data-id': 'pill', hidden: true });
  // The panel captures the pointer for panning; the pill keeps its own clicks.
  for (const t of ['pointerdown', 'dblclick', 'wheel', 'contextmenu']) pill.addEventListener(t, (e) => e.stopPropagation());
  let pillIds = '';
  let pillPane = null;
  const renderPill = () => {
    const p = pane();
    const show = modern() && app.prefs.get('pill') !== false && p && !p.video && p.layers().length > 0;
    if (!show) {
      pill.hidden = true;
      return;
    }
    if (pill.parentNode !== p.el) p.el.appendChild(pill);
    const ids = pillCommands(app, app.ribbonContext(app.activeMp()));
    const key = `${p.id}|${ids.join(',')}`;
    pill.hidden = !ids.length;
    if (key !== pillIds || pillPane !== p) {
      pillIds = key;
      pillPane = p;
      clear(pill);
      for (const id of ids) {
        const c = C.get(id);
        const b = h('button', { class: 'pill-btn', type: 'button', 'data-id': `cmd:${id}`, 'aria-label': c.label }, icon(c.icon, 18), h('span', { class: 'pill-label' }, c.label.replace(/…$/, '')));
        b.addEventListener('click', () => C.run(id));
        pill.appendChild(b);
      }
      const more = h('button', { class: 'pill-btn pill-more', type: 'button', 'data-id': 'pill:more', 'aria-label': 'More tools' }, icon('more', 18));
      more.addEventListener('click', () => {
        const cat = metaOf(ids[0] ?? '').cat;
        app.palette.open('');
        app.palette.input.placeholder = `More ${cat ? `${cat} ` : ''}tools — type to search`;
      });
      pill.appendChild(more);
    }
    for (const b of pill.querySelectorAll('[data-id^="cmd:"]')) {
      const id = b.dataset.id.slice(4);
      b.disabled = !C.enabled(id);
      b.classList.toggle('on', C.checked(id));
    }
  };
  let pt = 0;
  const schedulePill = () => {
    if (!pt) pt = setTimeout(() => ((pt = 0), renderPill()), 30); // a timer, not rAF: it also runs in a background tab
  };
  app.on('state', schedulePill);
  app.on('layout', schedulePill);
  C.on('change', schedulePill);
  C.implement('hud.pill', {
    run: () => {
      app.prefs.set('pill', app.prefs.get('pill') === false);
      schedulePill();
    },
    checked: () => app.prefs.get('pill') !== false,
  });

  // ---------------- Cursor shortcuts (REQ-SHL-11) ----------------
  const paneKeyTarget = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || inText(e) || wbOn() || radial.el) return null;
    const p = paneOf(e) ?? (document.activeElement?.classList.contains('pane') ? pane() : null);
    if (!p || p.view3d) return null; // the 3D view keeps W/A/S/D/Q/E for flight
    return p;
  };
  const twoImages = (p) => (p?.visibleLayers().filter((l) => l.kind !== 'dem').length ?? 0) >= 2;

  // Hold F: show the image underneath while the key is down (spring-loaded flicker).
  // S held: a swipe curtain follows the cursor; releasing S restores the previous comparison.
  const held = new Map();
  const springMode = (p, mode, key) => {
    p.compare ??= { mode: 'none', pos: 0.5, radius: 120, rate: 2, alpha: 0.5 };
    held.set(key, { pane: p, prev: p.compare.mode });
    p.compare.mode = mode;
    p.invalidate();
    app.renderer.invalidate();
  };
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.code;
    if (k !== 'KeyF' && k !== 'KeyS') return;
    const p = paneKeyTarget(e);
    if (!p) return;
    if (!twoImages(p)) {
      if (!held.has(`hint${k}`)) app.toast(`${k === 'KeyF' ? 'Hold F (flicker)' : 'S + move (swipe)'} compares two images: open a second image in this panel first.`, { kind: 'info' });
      held.set(`hint${k}`, true);
      return;
    }
    e.preventDefault();
    springMode(p, k === 'KeyF' ? 'hold' : 'swipe', k);
  });
  document.addEventListener('keyup', (e) => {
    const s = held.get(e.code);
    held.delete(`hint${e.code}`);
    if (!s?.pane) return;
    held.delete(e.code);
    s.pane.compare.mode = s.prev;
    s.pane.invalidate();
    app.renderer.invalidate();
  });
  window.addEventListener('blur', () => {
    for (const [k, s] of held) if (s?.pane) {
      s.pane.compare.mode = s.prev;
      s.pane.invalidate();
      held.delete(k);
    }
  });
  C.implement('hud.flicker', { enabled: () => twoImages(pane()), run: () => app.toast('Hold F over the panel to see the image underneath; release to come back.') });

  // Alt + wheel: opacity of the active layer (in porthole mode Alt + wheel still sizes the hole).
  document.addEventListener(
    'wheel',
    (e) => {
      if (!e.altKey || e.shiftKey || e.ctrlKey) return;
      const p = paneOf(e);
      if (!p || p.compare?.mode === 'porthole') return;
      const l = p.activeLayer();
      if (!l?.rec) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const v = Math.max(0, Math.min(1, Math.round(((l.rec.opacity ?? 1) + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100));
      app.store.transact('Layer opacity', (tx) => tx.set(l.id, 'opacity', v), { mergeKey: `opacity:${l.id}` });
      p.status.textContent = `Opacity ${Math.round(v * 100)} %`;
      clearTimeout(p._opT);
      p._opT = setTimeout(() => (p.status.textContent = ''), 1200);
    },
    { capture: true, passive: false },
  );

  // C + drag: a quick chip of the box at full resolution, to the clipboard and the session deck.
  const deck = [];
  app.sessionDeck = deck;
  let chipKey = false;
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyC' && !e.repeat && paneKeyTarget(e)) chipKey = true;
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyC') chipKey = false;
  });
  async function quickChip(p, a, b) {
    const l = p.geoLayer() ?? p.activeLayer();
    if (!l) throw new Error('open an image first');
    const va = p.viewPoint(a.sx, a.sy);
    const vb = p.viewPoint(b.sx, b.sy);
    const w = Math.abs(b.sx - a.sx);
    const hgt = Math.abs(b.sy - a.sy);
    if (w < 6 || hgt < 6) throw new Error('drag a box around the target first');
    // Full resolution: one image pixel per chip pixel, capped at 4096 px.
    const scale = Math.min(1 / p.view.zoom, 4096 / Math.max(w, hgt));
    const chip = await app.makeChip({ width: Math.round(w * scale), height: Math.round(hgt * scale), view: { cx: (va.x + vb.x) / 2, cy: (va.y + vb.y) / 2, zoom: p.view.zoom * scale, rot: p.view.rot }, zoom: p.view.zoom * scale });
    const blob = await new Promise((r) => chip.canvas.toBlob(r, 'image/png'));
    let copied = false;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      copied = true;
    } catch {
      /* the clipboard may be blocked here (embeds); the deck still has it */
    }
    deck.push({ canvas: chip.canvas, record: chip.record, marking: chip.marking });
    app.toast(`Quick chip ${chip.record.centreMgrs ?? ''}: ${copied ? 'copied to the clipboard and ' : ''}added to the session deck (${deck.length}).`, { action: { label: 'Export deck', run: () => C.run('deck.export') } });
    return chip;
  }
  app.quickChip = quickChip;
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!chipKey || e.button !== 0) return;
      const p = paneOf(e);
      if (!p) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const r = p.el.getBoundingClientRect();
      const a = { sx: e.clientX - r.left, sy: e.clientY - r.top };
      const box = h('div', { class: 'chip-box', style: { left: `${a.sx}px`, top: `${a.sy}px` } });
      p.el.appendChild(box);
      let b = a;
      const move = (ev) => {
        b = { sx: ev.clientX - r.left, sy: ev.clientY - r.top };
        Object.assign(box.style, { left: `${Math.min(a.sx, b.sx)}px`, top: `${Math.min(a.sy, b.sy)}px`, width: `${Math.abs(b.sx - a.sx)}px`, height: `${Math.abs(b.sy - a.sy)}px` });
      };
      const up = () => {
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', up, true);
        box.remove();
        quickChip(p, a, b).catch((err) => app.toast(`Quick Chip: ${err.message}`, { kind: 'warn' }));
      };
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', up, true);
    },
    true,
  );
  C.implement('hud.quickchip', {
    enabled: () => !!pane()?.activeLayer(),
    run: () => {
      // From a button: chip the middle half of the view.
      const p = pane();
      const { w, h: hh } = p.size();
      return quickChip(p, { sx: w / 4, sy: hh / 4 }, { sx: (3 * w) / 4, sy: (3 * hh) / 4 }).catch((err) => app.toast(`Quick Chip: ${err.message}`, { kind: 'warn' }));
    },
  });
  C.implement('deck.export', {
    enabled: () => deck.length > 0,
    run: async () => {
      if (!app.writePptx) throw new Error('PowerPoint export is not available in this file');
      const slides = deck.map((d) => ({ image: d.canvas, wIn: 13.333, hIn: 7.5, title: d.record.caption ?? `Chip ${d.record.number}`, marking: d.marking, notes: `${d.record.centreMgrs ?? ''} · ${d.record.created}` }));
      const bytes = await app.writePptx(slides, { title: 'GIS Workbench session deck' });
      await saveBlob(app, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), { name: 'session-deck.pptx', types: ['.pptx'], description: 'PowerPoint' });
    },
  });
  C.implement('deck.clear', {
    enabled: () => deck.length > 0,
    run: () => {
      deck.length = 0;
      app.toast('Session deck emptied.');
    },
  });

  // Ctrl+V on an image panel: a coordinate on the clipboard flies the view there (paste-to-pan).
  document.addEventListener('paste', (e) => {
    if (inText(e)) return;
    const p = paneOf(e) ?? (document.activeElement?.classList.contains('pane') ? pane() : null);
    if (!p?.geoLayer()?.modelId) return;
    const text = e.clipboardData?.getData('text') ?? '';
    const coord = findCoordinate(app, text);
    if (!coord) return; // keys.js runs the ordinary Paste
    clearTimeout(app.keys.pasteT);
    e.preventDefault();
    e.stopImmediatePropagation();
    app.jumpTo(coord).catch((err) => app.toast(`Paste: ${err.message}`, { kind: 'warn' }));
  });
  app.findCoordinate = (text) => findCoordinate(app, text);

  // J / K: step through the targets (markers, detections, observations) at the current zoom;
  // 1 / 2 / 3 triage the current one as clear, active or flagged.
  const patrol = { i: -1, list: [] };
  const targets = () => {
    const out = [];
    for (const g of app.store.all('graphic')) if ((g.shape === 'marker' || g.shape === 'point') && g.anchor === 'ground' && g.coords?.[0]) out.push({ id: g.id, kind: 'graphic', name: g.text || `Marker ${g.id.slice(-4)}`, lat: g.coords[0][1], lon: g.coords[0][0] });
    for (const d of app.store.all('detection')) {
      if (d.anchor === 'ground' && d.point) out.push({ id: d.id, kind: 'detection', name: `${d.cls ?? 'detection'} ${d.n}`, lat: d.point[1], lon: d.point[0] });
      else if (d.anchor === 'image' && d.point) out.push({ id: d.id, kind: 'detection', name: `${d.cls ?? 'detection'} ${d.n}`, x: d.point[0], y: d.point[1], layer: d.layer });
    }
    for (const o of app.store.all('observation')) if (Number.isFinite(o.lat) && Number.isFinite(o.lon)) out.push({ id: o.id, kind: 'observation', name: (o.text ?? '').slice(0, 40) || 'Observation', lat: o.lat, lon: o.lon });
    return out;
  };
  const goTo = (step) => {
    patrol.list = targets();
    const n = patrol.list.length;
    if (!n) throw new Error('place markers, import detections or record observations first');
    patrol.i = (patrol.i + step + n) % n;
    const t = patrol.list[patrol.i];
    const p = pane();
    if (Number.isFinite(t.lat)) p.centreOnGround(t.lat, t.lon);
    else p.setView({ cx: t.x, cy: t.y });
    if (Number.isFinite(t.lat)) app.tools.flashGround?.(p, t.lat, t.lon);
    const tri = app.store.get(t.id)?.triage;
    p.status.textContent = `Target ${patrol.i + 1}/${n}: ${t.name}${tri ? ` · ${tri}` : ''}`;
    return t;
  };
  const triage = (state) => {
    const t = patrol.list[patrol.i];
    if (!t || !app.store.get(t.id)) throw new Error('step to a target with J first');
    app.store.transact(`Triage: ${state}`, (tx) => {
      tx.set(t.id, 'triage', state);
      if (t.kind === 'detection') tx.set(t.id, 'status', state === 'clear' ? 'rejected' : state === 'active' ? 'accepted' : 'pending');
    });
    pane().status.textContent = `Target ${patrol.i + 1}/${patrol.list.length}: ${t.name} · ${state}`;
    app.emit('state');
  };
  app.patrol = { next: () => goTo(1), prev: () => goTo(-1), triage, get current() { return patrol.list[patrol.i] ?? null; } };
  C.implement('patrol.next', { run: () => goTo(1) });
  C.implement('patrol.prev', { run: () => goTo(-1) });
  for (const [id, st] of [['triage.clear', 'clear'], ['triage.active', 'active'], ['triage.flag', 'flagged']]) C.implement(id, { enabled: () => patrol.i >= 0, run: () => triage(st) });
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const p = paneKeyTarget(e);
    if (!p) return;
    try {
      if (e.code === 'KeyJ') goTo(1);
      else if (e.code === 'KeyK') goTo(-1);
      else if (patrol.i >= 0 && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3')) triage({ Digit1: 'clear', Digit2: 'active', Digit3: 'flagged' }[e.code]);
      else return;
      e.preventDefault();
    } catch (err) {
      app.toast(`Target patrol: ${err.message}`, { kind: 'warn' });
    }
  });
}

/**
 * A coordinate in free text (a chat line, a cable, a spreadsheet cell): the whole text if it
 * parses, else the first MGRS token or decimal-degree pair inside it. Returns the coordinate
 * text or null.
 */
export function findCoordinate(app, text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 2000) return null;
  const ok = (s) => {
    try {
      const r = app.core.parse(s);
      return Number.isFinite(r?.lat) && Number.isFinite(r?.lon) ? s : null;
    } catch {
      return null;
    }
  };
  if (t.length < 80 && ok(t)) return t;
  const mgrs = t.match(/\b\d{1,2}[C-HJ-NP-X]\s?[A-HJ-NP-Z]{2}\s?(\d{2,10}|\d{1,5}\s\d{1,5})\b/i);
  if (mgrs && ok(mgrs[0])) return mgrs[0];
  const dd = t.match(/[-+]?\d{1,2}\.\d+\s*°?\s*[NS]?\s*[,; ]\s*[-+]?\d{1,3}\.\d+\s*°?\s*[EW]?/i);
  if (dd && ok(dd[0])) return dd[0];
  return null;
}
