// Areas of interest and the panel legend (REQ-IMG-30). An AOI is a ground polygon (image
// polygon without a sensor model) per panel, drawn as a box, a polygon or taken from a graphic.
// It scopes processing: DRA statistics ("DRA: AOI"), change detection, chips (Chip Current View
// covers the AOI) and Select by Location. The legend lists graphics by style and vector layers
// by symbol, with counts, in a corner of the panel; products draw it too.

import { groundOf, screenOfGround, halo, poly } from '../tools/tools.js';
import { pointInRing, bbox as gbbox } from '../vector/geom.js';

export const name = 'aoi';

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const hasImage = () => !!pane()?.layers().length;

  app.aoiFor = (p) => (p?.rec?.aoi && S.has(p.rec.aoi) ? S.get(p.rec.aoi) : null);

  /** AOI ring in a layer's pixels (array of {x, y}), or null. */
  const ringIn = (p, l) => {
    const a = app.aoiFor(p);
    if (!a || !l) return null;
    if (a.anchor === 'image') return a.coords.map(([x, y]) => ({ x, y }));
    if (!l.modelId) return null;
    const pts = a.coords.map(([lon, lat, h]) => l.imageAt(lat, lon, h ?? 0));
    return pts.every(Boolean) ? pts : null;
  };
  app.aoiRing = ringIn;
  /** AOI bounding box in a layer's pixels (for DRA statistics). */
  app.aoiBox = (p, l) => {
    const r = ringIn(p, l);
    if (!r) return null;
    return { x0: Math.min(...r.map((q) => q.x)), y0: Math.min(...r.map((q) => q.y)), x1: Math.max(...r.map((q) => q.x)), y1: Math.max(...r.map((q) => q.y)) };
  };
  /** Point-in-AOI test in a layer's pixels, or null when the panel has no AOI. */
  app.aoiContainsImage = (p, l) => {
    const r = ringIn(p, l);
    if (!r) return null;
    const ring = r.map((q) => [q.x, q.y]);
    return (x, y) => pointInRing([x, y], ring);
  };
  /** Point-in-AOI test on the ground (lon, lat), or null. */
  app.aoiContainsGround = (p) => {
    const a = app.aoiFor(p);
    if (!a || a.anchor !== 'ground') return null;
    const ring = a.coords.map((c) => [c[0], c[1]]);
    return (lon, lat) => pointInRing([lon, lat], ring);
  };

  function setAoi(p, coords, anchor, nm = 'AOI') {
    S.transact('Set AOI', (tx) => {
      if (p.rec.aoi && S.has(p.rec.aoi)) tx.delete(p.rec.aoi);
      const id = tx.create('aoi', { pane: p.id, name: nm, anchor, coords, created: new Date().toISOString() });
      tx.set(p.id, 'aoi', id);
    });
    p.invalidate();
    app.renderer.invalidate();
    app.toast(`${nm} set: DRA (AOI scope), change detection, chips and Select by Location use it`);
  }
  app.setAoi = (coords, anchor = 'ground', nm) => setAoi(pane(), coords, anchor, nm);

  const ptOf = (p, sx, sy) => {
    const g = groundOf(app, p, sx, sy);
    const q = p.imagePoint(sx, sy);
    return g ? { ground: [g.lon, g.lat, g.h], image: [q.x, q.y] } : { ground: null, image: [q.x, q.y] };
  };
  const commit = (p, pts) => {
    const ground = pts.every((q) => q.ground);
    setAoi(p, pts.map((q) => (ground ? q.ground : q.image)), ground ? 'ground' : 'image');
  };

  app.tools.register({
    id: 'aoi.box',
    cue: 'Box AOI: drag a box over the area of interest.',
    onDown(p, e, sx, sy) {
      this.state = { a: { sx, sy }, b: { sx, sy } };
      return true;
    },
    onMove(p, e, sx, sy) {
      if (!this.state.a) return;
      this.state.b = { sx, sy };
      p.invalidate();
    },
    onUp(p) {
      const { a, b } = this.state;
      this.state = {};
      if (!a || Math.abs(b.sx - a.sx) < 4 || Math.abs(b.sy - a.sy) < 4) return;
      commit(p, [
        [a.sx, a.sy],
        [b.sx, a.sy],
        [b.sx, b.sy],
        [a.sx, b.sy],
      ].map(([x, y]) => ptOf(p, x, y)));
      app.tools.done();
    },
    draw(p, g, w, hh, s) {
      if (!s.a) return;
      g.strokeStyle = '#ffd400';
      g.setLineDash([6, 4]);
      g.strokeRect(s.a.sx, s.a.sy, s.b.sx - s.a.sx, s.b.sy - s.a.sy);
      g.setLineDash([]);
    },
  });
  app.tools.register({
    id: 'aoi.polygon',
    cue: 'Polygon AOI: click the corners; Enter or a double-click closes it.',
    onDown(p, e, sx, sy) {
      (this.state.pts ??= []).push({ sx, sy });
      p.invalidate();
      return true;
    },
    onMove(p, e, sx, sy) {
      this.state.hover = { sx, sy };
      if (this.state.pts?.length) p.invalidate();
    },
    onDblClick(p) {
      this.onEnter(p);
      return true;
    },
    onEnter(p) {
      const pts = (this.state.pts ?? []).filter((q, i, a) => !i || Math.hypot(q.sx - a[i - 1].sx, q.sy - a[i - 1].sy) > 2);
      this.state = {};
      if (pts.length < 3) return;
      commit(p, pts.map((q) => ptOf(p, q.sx, q.sy)));
      app.tools.done();
    },
    draw(p, g, w, hh, s) {
      const pts = [...(s.pts ?? []), ...(s.hover ? [s.hover] : [])].map((q) => ({ x: q.sx, y: q.sy }));
      if (!pts.length) return;
      g.strokeStyle = '#ffd400';
      g.setLineDash([6, 4]);
      poly(g, pts, true);
      g.stroke();
      g.setLineDash([]);
    },
  });
  C.implement('aoi.box', { enabled: hasImage, checked: () => app.tools.current?.id === 'aoi.box', run: () => app.tools.select('aoi.box') });
  C.implement('aoi.polygon', { enabled: hasImage, checked: () => app.tools.current?.id === 'aoi.polygon', run: () => app.tools.select('aoi.polygon') });
  C.implement('aoi.fromgraphic', {
    enabled: () => [...(app.selection ?? [])].some((id) => ['polygon', 'rect', 'circle', 'ellipse'].includes(S.get(id)?.shape) || S.get(id)?.geom?.type === 'Polygon'),
    run: () => {
      const p = pane();
      const id = [...app.selection].find((x) => S.get(x)?.shape || S.get(x)?.geom);
      const r = S.get(id);
      if (r.geom) {
        const n = r.geom.parts[1] ?? r.geom.xyz.length / 3;
        return setAoi(p, Array.from({ length: n }, (_, i) => [r.geom.xyz[3 * i], r.geom.xyz[3 * i + 1], r.geom.xyz[3 * i + 2]]), 'ground', `AOI from ${r.name || 'feature'}`);
      }
      const { w, h: hh } = p.size();
      let scr = app.graphics.screenPoints(p, r, w, hh);
      // A ground graphic whose points the image's model cannot project (off the image) has no AOI here.
      if (!scr?.length || scr.some((q) => !q)) return app.toast('AOI from Graphic: the graphic does not project onto this image', { kind: 'warn' });
      if (r.shape === 'rect' && scr.length === 2) scr = [scr[0], { x: scr[1].x, y: scr[0].y }, scr[1], { x: scr[0].x, y: scr[1].y }];
      if ((r.shape === 'circle' || r.shape === 'ellipse') && scr.length === 2) {
        const [c, e] = scr;
        const rx = r.shape === 'circle' ? Math.hypot(e.x - c.x, e.y - c.y) : Math.abs(e.x - c.x) / 2;
        const ry = r.shape === 'circle' ? rx : Math.abs(e.y - c.y) / 2;
        const cx = r.shape === 'circle' ? c.x : (c.x + e.x) / 2;
        const cy = r.shape === 'circle' ? c.y : (c.y + e.y) / 2;
        scr = Array.from({ length: 32 }, (_, i) => ({ x: cx + rx * Math.cos((i * Math.PI) / 16), y: cy + ry * Math.sin((i * Math.PI) / 16) }));
      }
      commit(p, scr.map((q) => ptOf(p, q.x, q.y)));
    },
  });
  C.implement('aoi.clear', {
    enabled: () => !!app.aoiFor(pane()),
    run: () => {
      const p = pane();
      S.transact('Clear AOI', (tx) => {
        tx.delete(p.rec.aoi);
        tx.set(p.id, 'aoi', null);
      });
      p.invalidate();
    },
  });

  // ---- drawing: the AOI outline and the legend ----
  const prevDraw = app.graphics.drawPane;
  app.graphics.drawPane = (p, g) => {
    prevDraw(p, g);
    const l = p.geoLayer?.();
    const a = app.aoiFor(p.source ?? p) ?? app.aoiFor(p);
    if (a) {
      const pts = a.anchor === 'ground' ? a.coords.map((c) => screenOfGround(p, c[1], c[0], c[2] ?? 0)) : a.coords.map(([x, y]) => p.screenPoint(x, y));
      if (pts.every(Boolean)) {
        g.save();
        g.strokeStyle = '#ffd400';
        g.lineWidth = 2;
        g.setLineDash([8, 5]);
        halo(g, () => poly(g, pts, true));
        g.restore();
      }
    }
    if ((p.source?.rec ?? p.rec)?.legend) drawLegend(p, g);
    void l;
  };

  /** Legend entries for a panel: graphics grouped by shape and style, then vector layers. */
  app.legendEntries = (p) => {
    const pid = p.source?.id ?? p.id;
    const groups = new Map();
    for (const gr of S.all('graphic').filter((x) => x.pane === pid)) {
      const k = `${gr.shape}|${gr.style?.stroke}|${gr.style?.fill}`;
      if (!groups.has(k)) groups.set(k, { kind: 'graphic', label: gr.shape, shape: gr.shape, style: gr.style ?? {}, n: 0 });
      groups.get(k).n++;
    }
    const out = [...groups.values()];
    for (const v of S.all('vlayer').filter((x) => x.visible !== false)) {
      const fs = S.all('feature').filter((f) => f.vlayer === v.id);
      if (!fs.length) continue;
      const types = new Set(fs.map((f) => f.geom.type.replace('Multi', '')));
      out.push({ kind: 'vector', label: v.name, shape: types.has('Polygon') ? 'polygon' : types.has('LineString') ? 'line' : 'point', style: v.style ?? {}, n: fs.length });
    }
    return out;
  };

  function drawLegend(p, g) {
    const items = app.legendEntries(p);
    if (!items.length) return;
    const { w } = p.size();
    const rowH = 18;
    const W = 190;
    const H = 22 + rowH * items.length;
    const x0 = w - W - 10;
    const y0 = 34;
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.72)';
    g.fillRect(x0, y0, W, H);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1;
    g.strokeRect(x0, y0, W, H);
    g.fillStyle = '#ffffff';
    g.font = 'bold 12px Arial, sans-serif';
    g.fillText('Legend', x0 + 8, y0 + 15);
    g.font = '11px Arial, sans-serif';
    items.forEach((it, i) => {
      const y = y0 + 22 + i * rowH;
      g.strokeStyle = it.style.stroke ?? '#e00000';
      g.fillStyle = it.style.fill ?? 'transparent';
      g.lineWidth = Math.min(3, it.style.width ?? 2);
      if (it.shape === 'polygon' || it.shape === 'rect' || it.shape === 'circle' || it.shape === 'ellipse') {
        g.fillRect(x0 + 8, y + 3, 20, 10);
        g.strokeStyle = it.style.outline ?? it.style.stroke ?? '#e00000';
        g.strokeRect(x0 + 8, y + 3, 20, 10);
      } else if (it.shape === 'point' || it.shape === 'marker' || it.shape === 'text') {
        g.beginPath();
        g.arc(x0 + 18, y + 8, 4, 0, Math.PI * 2);
        g.stroke();
      } else {
        g.beginPath();
        g.moveTo(x0 + 8, y + 8);
        g.lineTo(x0 + 28, y + 8);
        g.stroke();
      }
      g.fillStyle = '#ffffff';
      g.fillText(`${it.label} (${it.n})`, x0 + 36, y + 12, W - 44);
    });
    g.restore();
  }

  C.implement('panel.legend', {
    enabled: () => !!pane(),
    checked: () => !!pane()?.rec?.legend,
    run: () => {
      const p = pane();
      S.transact('Legend', (tx) => tx.set(p.id, 'legend', !p.rec.legend));
      p.invalidate();
    },
  });

  // Select by Location: "inside the AOI".
  const prevLoc = app.selectByLocation;
  app.selectByLocation = (layerId, mode, metres) => {
    if (mode !== 'aoi') return prevLoc(layerId, mode, metres);
    const inside = app.aoiContainsGround(pane());
    if (!inside) throw new Error('the panel has no ground AOI');
    const hit = S.all('feature').filter((f) => f.vlayer === layerId).filter((f) => {
      const [x0, y0, x1, y1] = gbbox(f.geom);
      return inside((x0 + x1) / 2, (y0 + y1) / 2);
    });
    for (const id of [...app.selection]) if (S.get(id)?.type === 'feature') app.selection.delete(id);
    for (const f of hit) app.selection.add(f.id);
    app.emit('selection');
    return hit.length;
  };

  /** The view that frames the AOI in an output of W × H px (chips). */
  app.aoiView = (p, W, H) => {
    const l = p.geoLayer();
    const b = app.aoiBox(p, l);
    if (!b) return null;
    const c = Math.cos(p.view.rot ?? 0);
    const s = Math.sin(p.view.rot ?? 0);
    const r = ringIn(p, l).map((q) => ({ u: c * (q.x - (b.x0 + b.x1) / 2) - s * (q.y - (b.y0 + b.y1) / 2), v: s * (q.x - (b.x0 + b.x1) / 2) + c * (q.y - (b.y0 + b.y1) / 2) }));
    const du = Math.max(...r.map((q) => q.u)) - Math.min(...r.map((q) => q.u));
    const dv = Math.max(...r.map((q) => q.v)) - Math.min(...r.map((q) => q.v));
    return { ...p.view, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, zoom: 0.95 * Math.min(W / du, H / dv) };
  };
}
