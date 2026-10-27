// Tool manager and the interactive tools: navigation (re-centre, zoom box, mouse rotate),
// graphics (REQ-IMG-26/27: ground-anchored by default) and mono mensuration (REQ-MEN-01/02):
// point position, range & bearing, polyline length, polygon area — each logged with CE90/LE90
// computed by the Rust core, or "error not available".

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { chainSummary } from '../render/chain.js';

const DRAW_STYLE = { stroke: '#e00000', width: 2, fill: '#e0000040', font: '13px Arial, sans-serif', text: '#ffffff' };

export class Tools {
  constructor(app) {
    this.app = app;
    this.current = null;
    this.defs = new Map();
    this.sticky = false;
  }

  register(def) {
    this.defs.set(def.id, def);
  }

  select(id, { sticky = false } = {}) {
    this.current?.end?.();
    this.current = id ? { ...this.defs.get(id), state: {} } : null;
    this.sticky = sticky;
    this.current?.start?.();
    document.body.dataset.tool = id ?? '';
    for (const mp of this.app.desktop.multiports) for (const p of mp.panes) p.invalidate();
    this.app.emit('state');
    if (id && this.current?.cue) this.app.cue?.(this.current.cue);
  }

  /** Called when a one-shot tool finishes; sticky tools (double-click) stay until Esc. */
  done() {
    if (this.sticky) {
      this.current.state = {};
      this.current?.start?.();
    } else this.select(null);
  }

  cancel() {
    this.select(null);
  }

  drawOverlay(pane, g, w, hh) {
    this.current?.draw?.(pane, g, w, hh, this.current.state);
  }
}

// ---- helpers ----

export function groundOf(app, pane, sx, sy) {
  const l = pane.geoLayer();
  if (!l?.modelId) return null;
  const p = pane.imagePoint(sx, sy);
  const g = l.groundWithTerrain(p.x, p.y);
  return g ? { ...g, x: p.x, y: p.y, layer: l } : null;
}

export function screenOfGround(pane, lat, lon, h) {
  const l = pane.geoLayer();
  const q = l?.imageAt(lat, lon, h);
  return q ? pane.screenPoint(q.x, q.y) : null;
}

export function poly(g, pts, close) {
  if (!pts.length) return;
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) g.lineTo(p.x, p.y);
  if (close) g.closePath();
}

export function halo(g, fn) {
  g.save();
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.lineWidth = (g.lineWidth || 1) + 2;
  fn();
  g.stroke();
  g.restore();
  fn();
  g.stroke();
}

export function label(g, text, x, y, size = 12) {
  g.font = `${size}px Arial, sans-serif`;
  g.lineWidth = 3;
  g.strokeStyle = '#000';
  g.strokeText(text, x, y);
  g.fillStyle = '#fff';
  g.fillText(text, x, y);
}

export function fmtLen(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(3)} km` : `${m.toFixed(2)} m`;
}

// ---- install ----

export function installTools(app) {
  const tools = new Tools(app);
  app.tools = tools;
  const C = app.commands;

  tools.register({
    id: 'recenter',
    cue: 'Re-center: click a point to centre the panel on it.',
    onDown(pane, e, sx, sy) {
      const p = pane.imagePoint(sx, sy);
      pane.centreOn(p.x, p.y);
      tools.done();
      return true;
    },
  });

  tools.register({
    id: 'zoombox',
    cue: 'Zoom to Box: drag a box around the area to fill the panel.',
    onDown(pane, e, sx, sy) {
      this.state.a = { sx, sy };
      this.state.b = { sx, sy };
      return true;
    },
    onMove(pane, e, sx, sy) {
      if (!this.state.a) return;
      this.state.b = { sx, sy };
      pane.invalidate();
    },
    onUp(pane) {
      const { a, b } = this.state;
      if (!a) return;
      const w = Math.abs(b.sx - a.sx);
      const hh = Math.abs(b.sy - a.sy);
      if (w > 4 && hh > 4) {
        const c = pane.imagePoint((a.sx + b.sx) / 2, (a.sy + b.sy) / 2);
        const { w: pw, h: ph } = pane.size();
        pane.setView({ cx: c.x, cy: c.y, zoom: pane.view.zoom * Math.min(pw / w, ph / hh) });
      }
      this.state = {};
      tools.done();
    },
    draw(pane, g, w, hh, s) {
      if (!s.a) return;
      g.strokeStyle = '#ffff00';
      g.setLineDash([4, 3]);
      g.strokeRect(s.a.sx, s.a.sy, s.b.sx - s.a.sx, s.b.sy - s.a.sy);
      g.setLineDash([]);
    },
  });

  tools.register({
    id: 'rotate',
    cue: 'Mouse Rotate: drag left or right to rotate the panel.',
    onDown(pane, e, sx) {
      this.state = { sx, rot: pane.view.rot };
      return true;
    },
    onMove(pane, e, sx) {
      if (this.state.sx === undefined || !(e.buttons & 1)) return;
      pane.setView({ rot: this.state.rot + (sx - this.state.sx) / 150, mode: 'free' });
    },
    onUp() {
      this.state = {};
    },
  });

  // ---- graphics ----
  const shapes = {
    point: { n: 1 },
    marker: { n: 1 },
    text: { n: 1 },
    callout: { n: 2 },
    line: { n: 2 },
    arrow: { n: 2 },
    rect: { n: 2 },
    ellipse: { n: 2 },
    circle: { n: 2 },
    polyline: { n: Infinity },
    polygon: { n: Infinity },
  };

  async function askText(title, value = '') {
    const inp = h('input', { class: 'inp', value, spellcheck: 'true' });
    const r = await modal({ title, body: field('Text', inp), buttons: ['OK', 'Cancel'] });
    return r === 'OK' ? inp.value : null;
  }

  function graphicsLayerFor(pane) {
    // One graphics overlay per pane (a "Graphics" layer in the Layer Manager).
    return pane.rec.graphicsLayer ?? null;
  }

  async function commitGraphic(pane, shape, pts, gps = null) {
    const l = pane.geoLayer();
    const ground = !!l?.modelId;
    let text = '';
    if (shape === 'text' || shape === 'callout') {
      text = await askText(shape === 'text' ? 'Text Box' : 'Callout');
      if (text === null) return;
    }
    if (shape === 'marker') text = `Marker ${app.store.all('graphic').filter((g) => g.shape === 'marker').length + 1}`;
    // GPS routes and waypoints (REQ-IMG-31) are graphics tagged for GPX.
    if (gps) text = `${gps === 'route' ? 'Route' : 'Waypoint'} ${app.store.all('graphic').filter((g) => g.gps === gps).length + 1}`;
    const coords = pts.map((p) => (ground ? [p.lon, p.lat, p.h] : [p.x, p.y]));
    let radius = null;
    if (shape === 'circle' && ground && pts.length === 2) radius = app.core.inverse(pts[0].lat, pts[0].lon, pts[1].lat, pts[1].lon).distance;
    app.store.transact(`Draw ${shape}`, (tx) => {
      let gl = graphicsLayerFor(pane);
      if (!gl) {
        gl = tx.create('glayer', { pane: pane.id, name: 'Graphics', visible: true, saved: false });
        tx.set(pane.id, 'graphicsLayer', gl);
      }
      tx.create('graphic', {
        glayer: gl,
        pane: pane.id,
        shape,
        anchor: ground ? 'ground' : 'image',
        imageLayer: ground ? null : l?.id ?? null,
        coords,
        radius,
        text,
        style: gps ? { stroke: '#ff00ff', width: 2, fill: '#ff00ff40' } : { ...DRAW_STYLE, ...(app.prefs.get('graphicStyle') ?? {}) },
        gps: gps ?? undefined,
        created: new Date().toISOString(),
        provenance: { kind: 'user' },
      });
    });
    pane.invalidate();
  }

  const drawTools = [...Object.entries(shapes).map(([shape, def]) => [`draw.${shape}`, shape, def, null]), ['gps.route', 'polyline', shapes.polyline, 'route'], ['gps.waypoint', 'marker', shapes.marker, 'waypoint']];
  for (const [id, shape, def, gps] of drawTools) {
    tools.register({
      id,
      cue: def.n === Infinity ? `${shape}: click to add vertices; double-click or Enter to finish; Esc cancels.` : `${shape}: click ${def.n === 1 ? 'a point' : 'two points'}.`,
      onDown(pane, e, sx, sy) {
        const p = pane.imagePoint(sx, sy);
        const gr = groundOf(app, pane, sx, sy);
        const pt = gr ?? { x: p.x, y: p.y };
        (this.state.pts ??= []).push(pt);
        if (this.state.pts.length >= def.n) {
          const pts = this.state.pts;
          this.state = {};
          commitGraphic(pane, shape, pts, gps).then(() => tools.done());
        }
        pane.invalidate();
        return true;
      },
      onMove(pane, e, sx, sy) {
        this.state.hover = { sx, sy };
        if (this.state.pts?.length) pane.invalidate();
      },
      onDblClick(pane) {
        if (def.n !== Infinity || (this.state.pts?.length ?? 0) < 2) return true;
        const pts = this.state.pts.slice(0, -1).length >= (shape === 'polygon' ? 3 : 2) ? this.state.pts.slice(0, -1) : this.state.pts;
        this.state = {};
        commitGraphic(pane, shape, pts, gps).then(() => tools.done());
        return true;
      },
      onEnter(pane) {
        if ((this.state.pts?.length ?? 0) >= (shape === 'polygon' ? 3 : 2)) {
          const pts = this.state.pts;
          this.state = {};
          commitGraphic(pane, shape, pts, gps).then(() => tools.done());
        }
      },
      draw(pane, g, w, hh, s) {
        if (!s.pts?.length) return;
        const scr = s.pts.map((p) => (p.lat !== undefined ? screenOfGround(pane, p.lat, p.lon, p.h) : pane.screenPoint(p.x, p.y))).filter(Boolean);
        if (s.hover) scr.push({ x: s.hover.sx, y: s.hover.sy });
        g.strokeStyle = DRAW_STYLE.stroke;
        g.lineWidth = 2;
        halo(g, () => poly(g, scr, shape === 'polygon'));
      },
    });
    C.implement(id, { run: () => tools.select(id), sticky: () => tools.select(id, { sticky: true }), checked: () => tools.current?.id === id, enabled: () => (gps ? !!app.activePane()?.geoLayer()?.modelId : !!app.activePane()?.layers().length) });
  }

  // ---- graphics renderer (all panes) ----
  app.graphics = {
    drawPane(pane, g) {
      const recs = app.store.all('graphic').filter((x) => x.pane === pane.id);
      const glr = pane.rec?.graphicsLayer ? app.store.get(pane.rec.graphicsLayer) : null;
      if (glr?.visible === false) return;
      const l = pane.geoLayer();
      const { w: pw, h: ph } = pane.size();
      for (const r of recs) {
        // Anchors (REQ-IMG-27): ground (lon, lat, HAE), image (pixels) or screen (pane fractions).
        const pts = app.graphics.screenPoints(pane, r, pw, ph);
        if (!pts || pts.some((p) => !p)) continue;
        const st = r.style ?? DRAW_STYLE;
        g.save();
        g.strokeStyle = app.selection?.has(r.id) ? '#e000e0' : st.stroke;
        g.fillStyle = st.fill;
        g.lineWidth = st.width ?? 2;
        g.setLineDash(st.dash === 'dashed' ? [9, 5] : st.dash === 'dotted' ? [2, 4] : []);
        const fs = st.fontSize ?? 12;
        switch (r.shape) {
          case 'point':
          case 'marker': {
            const p = pts[0];
            g.strokeStyle = r.shape === 'marker' ? '#ffd400' : st.stroke;
            halo(g, () => {
              g.beginPath();
              g.arc(p.x, p.y, 6, 0, Math.PI * 2);
              g.moveTo(p.x - 10, p.y);
              g.lineTo(p.x + 10, p.y);
              g.moveTo(p.x, p.y - 10);
              g.lineTo(p.x, p.y + 10);
            });
            if (r.seq) {
              g.fillStyle = '#ffd400';
              g.beginPath();
              g.arc(p.x, p.y, 9, 0, Math.PI * 2);
              g.fill();
              g.fillStyle = '#000';
              g.font = `bold ${fs}px Arial, sans-serif`;
              g.textAlign = 'center';
              g.fillText(String(r.seq), p.x, p.y + fs / 3);
              g.textAlign = 'left';
            } else if (r.text) label(g, r.text, p.x + 9, p.y - 9, fs);
            break;
          }
          case 'text': {
            // Autolabels (REQ-IMG-28) keep their token template and resolve it for the pane's
            // current image at every draw, so they follow the image they are moved onto.
            const text = r.template ? app.resolveLabel?.(pane, r.template) ?? r.text : r.text;
            String(text ?? '').split(/\n/).forEach((t, i) => label(g, t, pts[0].x, pts[0].y + i * (fs + 4), fs));
            break;
          }
          case 'automap':
            app.drawAutomap?.(pane, g, pts[0], r);
            break;
          case 'symbol':
            // MIL-STD-2525 (REQ-IMG-32): the symbol's canvas from the lazy milsymbol block.
            app.milsym?.draw(g, r, pts[0]);
            break;
          case 'callout': {
            const [a, b] = pts;
            g.strokeStyle = '#e00000';
            halo(g, () => {
              g.beginPath();
              g.moveTo(a.x, a.y);
              g.lineTo(b.x, b.y);
            });
            g.font = '12px Arial, sans-serif';
            const tw = g.measureText(r.text).width + 10;
            g.fillStyle = '#ffffff';
            g.fillRect(b.x, b.y - 16, tw, 20);
            g.strokeStyle = '#000';
            g.lineWidth = 1;
            g.strokeRect(b.x, b.y - 16, tw, 20);
            g.fillStyle = '#000';
            g.fillText(r.text, b.x + 5, b.y - 2);
            break;
          }
          case 'line':
          case 'polyline':
            halo(g, () => poly(g, pts, false));
            break;
          case 'arrow': {
            const [a, b] = pts;
            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            halo(g, () => {
              g.beginPath();
              g.moveTo(a.x, a.y);
              g.lineTo(b.x, b.y);
              g.moveTo(b.x, b.y);
              g.lineTo(b.x - 12 * Math.cos(ang - 0.4), b.y - 12 * Math.sin(ang - 0.4));
              g.moveTo(b.x, b.y);
              g.lineTo(b.x - 12 * Math.cos(ang + 0.4), b.y - 12 * Math.sin(ang + 0.4));
            });
            break;
          }
          case 'polygon':
            poly(g, pts, true);
            g.fill();
            halo(g, () => poly(g, pts, true));
            break;
          case 'rect': {
            // Rectangle in image space through the two corners (screen-aligned to the image).
            const [a, b] = r.anchor === 'ground' ? r.coords.map((c) => l?.imageAt(c[1], c[0], c[2] ?? 0)) : r.coords.map((c) => ({ x: c[0], y: c[1] }));
            if (!a || !b) break;
            const q = [pane.screenPoint(a.x, a.y), pane.screenPoint(b.x, a.y), pane.screenPoint(b.x, b.y), pane.screenPoint(a.x, b.y)];
            poly(g, q, true);
            g.fill();
            halo(g, () => poly(g, q, true));
            break;
          }
          case 'ellipse': {
            const [a, b] = pts;
            halo(g, () => {
              g.beginPath();
              g.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
            });
            break;
          }
          case 'circle': {
            // A ground circle is a geodesic ring of the stored radius.
            if (r.anchor === 'ground' && r.radius) {
              const [lon, lat, hh] = r.coords[0];
              const ring = [];
              for (let k = 0; k <= 64; k++) {
                const d = app.core.direct(lat, lon, (k * 360) / 64, r.radius);
                const s = screenOfGround(pane, d.lat, d.lon, hh ?? 0);
                if (s) ring.push(s);
              }
              halo(g, () => poly(g, ring, true));
            } else {
              const [a, b] = pts;
              halo(g, () => {
                g.beginPath();
                g.arc(a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y), 0, Math.PI * 2);
              });
            }
            break;
          }
          default:
            break;
        }
        g.restore();
      }
      app.vectors?.drawPane(pane, g);
      app.mensuration?.drawPane(pane, g);
    },
    /** Screen points of a graphic in a pane (CSS px); null entries where it cannot map. */
    screenPoints(pane, r, pw, ph) {
      if (r.anchor === 'screen') return r.coords.map((c) => ({ x: c[0] * pw, y: c[1] * ph }));
      if (r.anchor === 'ground') return r.coords.map((c) => screenOfGround(pane, c[1], c[0], c[2] ?? 0));
      return r.coords.map((c) => pane.screenPoint(c[0], c[1]));
    },
  };

  installMensuration(app, tools);
  return tools;
}

// ---- mensuration ----

/**
 * Relative CE90 of the vector between two points of one image (REQ-MEN-07): the model bias
 * is shared, so its covariance cancels (Cov = Ca + Cb − 2·σbias²·I); pick, random and DEM
 * terms stay independent. Null when either point has no stated error.
 */
export function relativeCE90(app, ea, eb) {
  if (!ea?.modelErrorKnown || !eb?.modelErrorKnown) return null;
  const b = Number.isFinite(ea.sigmaBias) && Number.isFinite(eb.sigmaBias) ? Math.min(ea.sigmaBias, eb.sigmaBias) : 0;
  const cee = Math.max(1e-12, ea.cov[0] + eb.cov[0] - 2 * b * b);
  const cnn = Math.max(1e-12, ea.cov[2] + eb.cov[2] - 2 * b * b);
  return app.core.ce90(cee, ea.cov[1] + eb.cov[1], cnn);
}

function installMensuration(app, tools) {
  const C = app.commands;
  let seq = 0;

  function errorFor(l, x, y, g) {
    try {
      const e = app.core.pointError(l.modelId, x, y, g.h, app.prefs.get('pickSigmaPx') ?? 0.5, g.sigmaV);
      return e;
    } catch {
      return null;
    }
  }

  function baseRow(type, l, g, extra = {}) {
    seq = Math.max(seq, app.store.all('measurement').length);
    return {
      mid: `M-${String(++seq).padStart(2, '0')}`,
      object: '',
      mtype: type, // the store owns `type` (the record kind)
      method: l.modelInfo?.is3d ? (g.heightSource?.startsWith('default') ? 'Mono, default height' : 'Mono-DEM') : 'Map (2-D model)',
      model: l.modelName,
      heightSource: g.heightSource ?? 'N/A',
      chain: chainSummary(l.chain),
      image: l.info.iid,
      layer: l.id,
      analyst: app.prefs.get('analyst') ?? 'analyst',
      time: new Date().toISOString(),
      tag: 'absolute',
      ...extra,
    };
  }

  function logRow(row, pane) {
    app.store.transact(`Measure ${row.mtype}`, (tx) => tx.create('measurement', { ...row, pane: pane.id }));
    app.panels?.show('menlog', 'bottom');
    pane.invalidate();
  }

  function pointRow(l, p, g, err) {
    const mgrs = app.core.mgrs(g.lat, g.lon, 5);
    const N = app.core.undulation(g.lat, g.lon);
    return baseRow('Point', l, g, {
      value: mgrs,
      units: 'MGRS',
      coords: { lat: g.lat, lon: g.lon, hae: g.h, msl: Number.isFinite(N) ? g.h - N : null, geoid: app.core.geoidName ?? 'EGM96', mgrs, datum: 'WGS 84' },
      ce90: err && Number.isFinite(err.ce90) ? err.ce90 : null,
      le90: err && Number.isFinite(err.le90) ? err.le90 : null,
      sigma: err ? { model: err.sigmaModel, pick: err.sigmaPick, demH: err.sigmaDemH, demV: err.sigmaDemV, pickPx: app.prefs.get('pickSigmaPx') ?? 0.5, gsd: err.gsd, method: err.ceMethod } : null,
      errorNote: err?.modelErrorKnown ? '' : 'error not available (the sensor model states no error)',
      geom: [[g.lon, g.lat, g.h]],
      imagePts: [[p.x, p.y]],
    });
  }

  tools.register({
    id: 'men.point',
    cue: 'Point Position: click the point. The ground position, MGRS (truncated), HAE/MSL and CE90/LE90 go to the Mensuration Log.',
    onDown(pane, e, sx, sy) {
      const g = groundOf(app, pane, sx, sy);
      if (!g) {
        app.toast('Point Position needs an image with a sensor model', { kind: 'warn' });
        return true;
      }
      logRow(pointRow(g.layer, g, g, errorFor(g.layer, g.x, g.y, g)), pane);
      tools.done();
      return true;
    },
  });

  function multi(id, type, minPts, maxPts, compute, cue) {
    tools.register({
      id,
      cue,
      onDown(pane, e, sx, sy) {
        const g = groundOf(app, pane, sx, sy);
        if (!g) {
          app.toast(`${type} needs an image with a sensor model`, { kind: 'warn' });
          return true;
        }
        (this.state.pts ??= []).push(g);
        if (this.state.pts.length >= maxPts) finish(this, pane);
        pane.invalidate();
        return true;
      },
      onMove(pane, e, sx, sy) {
        this.state.hover = groundOf(app, pane, sx, sy);
        if (this.state.pts?.length) pane.invalidate();
      },
      onDblClick(pane) {
        if ((this.state.pts?.length ?? 0) > minPts) this.state.pts.pop(); // the second click of the dblclick
        finish(this, pane);
        return true;
      },
      onEnter(pane) {
        finish(this, pane);
      },
      draw(pane, g, w, hh, s) {
        const pts = [...(s.pts ?? [])];
        if (!pts.length) return;
        if (s.hover) pts.push(s.hover);
        const scr = pts.map((p) => screenOfGround(pane, p.lat, p.lon, p.h)).filter(Boolean);
        g.strokeStyle = '#ffd400';
        g.lineWidth = 2;
        halo(g, () => poly(g, scr, type === 'Area' && scr.length > 2));
        if (pts.length >= minPts) {
          const live = compute(pts, true);
          if (live) label(g, live.text, scr.at(-1).x + 10, scr.at(-1).y - 10);
        }
      },
    });
    function finish(tool, pane) {
      const pts = tool.state.pts ?? [];
      tool.state = {};
      if (pts.length < minPts) {
        pane.invalidate();
        return;
      }
      const r = compute(pts, false);
      const l = pts[0].layer;
      const errs = pts.map((p) => errorFor(l, p.x, p.y, p));
      // Relative error (REQ-MEN-07): points from one image share the model bias, which the
      // cross-covariance cancels (Research/05 §6.5). Polylines report their worst segment.
      let ce = null;
      let le = null;
      if (errs.every((e) => e?.modelErrorKnown)) {
        for (let i = 1; i < errs.length; i++) ce = Math.max(ce ?? 0, relativeCE90(app, errs[i - 1], errs[i]));
        if (type === 'Area' && errs.length > 2) ce = Math.max(ce, relativeCE90(app, errs.at(-1), errs[0]));
        if (errs.every((e) => Number.isFinite(e.le90))) le = Math.sqrt((errs[0].le90 / 1.6449) ** 2 + (errs.at(-1).le90 / 1.6449) ** 2) * 1.6449;
      }
      logRow(
        baseRow(type, l, pts[0], {
          value: r.value,
          units: r.units,
          coords: { from: app.core.mgrs(pts[0].lat, pts[0].lon, 5), to: app.core.mgrs(pts.at(-1).lat, pts.at(-1).lon, 5), datum: 'WGS 84' },
          extra: { ...r.extra, absoluteCE90: [errs[0]?.ce90 ?? null, errs.at(-1)?.ce90 ?? null] },
          ce90: ce,
          le90: le,
          tag: pts.length === 2 ? 'relative' : 'relative (largest segment)',
          sigma: errs[0] ? { perPoint: errs.map((e) => ({ model: e.sigmaModel, pick: e.sigmaPick, demH: e.sigmaDemH })) } : null,
          errorNote: errs.every((e) => e?.modelErrorKnown) ? '' : 'error not available (the sensor model states no error)',
          method: `${pts[0].heightSource?.startsWith('default') ? 'Mono, default height' : 'Mono-DEM'}; geodesic (Karney 2013, WGS 84)`,
          geom: pts.map((p) => [p.lon, p.lat, p.h]),
        }),
        pane,
      );
      tools.done();
    }
  }

  multi(
    'men.rangebearing',
    'Range & Bearing',
    2,
    2,
    (pts) => {
      const [a, b] = pts;
      const inv = app.core.inverse(a.lat, a.lon, b.lat, b.lon);
      const az = (inv.azi1 + 360) % 360;
      const back = (inv.azi2 + 180 + 360) % 360;
      return { value: +inv.distance.toFixed(3), units: 'm', text: `${fmtLen(inv.distance)} @ ${az.toFixed(2)}°T`, extra: { azimuthTrue: az, backAzimuth: back, slant: app.core.slant(a, b).slant, dh: b.h - a.h } };
    },
    'Range & Bearing: click the start and the end. Geodesic distance, true azimuth and back azimuth are logged.',
  );
  multi(
    'men.length',
    'Distance',
    2,
    Infinity,
    (pts) => {
      const d = app.core.polylineLength(pts.map((p) => [p.lat, p.lon]));
      return { value: +d.toFixed(3), units: 'm', text: fmtLen(d), extra: { vertices: pts.length } };
    },
    'Polyline Length: click vertices; double-click or Enter to finish.',
  );
  multi(
    'men.area',
    'Area',
    3,
    Infinity,
    (pts) => {
      const r = app.core.polygonArea(pts.map((p) => [p.lat, p.lon]));
      return { value: +r.area.toFixed(2), units: 'm²', text: `${r.area >= 1e6 ? `${(r.area / 1e6).toFixed(4)} km²` : `${r.area.toFixed(1)} m²`} · perimeter ${fmtLen(r.perimeter)}`, extra: { perimeter: r.perimeter, vertices: pts.length } };
    },
    'Polygon Area: click vertices; double-click or Enter to close. Area and perimeter are geodesic on WGS 84.',
  );

  for (const id of ['men.point', 'men.rangebearing', 'men.length', 'men.area']) {
    C.implement(id, { run: () => tools.select(id), sticky: () => tools.select(id, { sticky: true }), checked: () => tools.current?.id === id, enabled: () => !!app.activePane()?.geoLayer()?.modelId });
  }
  // Shared with the second mensuration module (features/measure.js).
  app.measureApi = { errorFor, baseRow, logRow, pointRow, multi };
  C.implement('men.tracking', { run: () => app.prefs.set('tracking', !app.prefs.get('tracking')), checked: () => app.prefs.get('tracking') !== false });

  app.mensuration = {
    drawPane(pane, g) {
      for (const m of app.store.all('measurement').filter((x) => x.pane === pane.id)) {
        if (!m.geom) continue;
        const scr = m.geom.map((c) => screenOfGround(pane, c[1], c[0], c[2] ?? 0)).filter(Boolean);
        if (!scr.length) continue;
        g.strokeStyle = '#ffd400';
        g.lineWidth = 1.5;
        if (scr.length === 1) {
          halo(g, () => {
            g.beginPath();
            g.arc(scr[0].x, scr[0].y, 5, 0, Math.PI * 2);
          });
        } else halo(g, () => poly(g, scr, m.mtype === 'Area'));
        label(g, m.mid, scr.at(-1).x + 8, scr.at(-1).y + 14);
      }
    },
  };

  // Flash a ground point after Jump to Point.
  const flashes = [];
  tools.flashGround = (pane, lat, lon) => {
    flashes.push({ pane, lat, lon, until: performance.now() + 2500 });
    pane.invalidate();
  };
  const draw = app.mensuration.drawPane;
  app.mensuration.drawPane = (pane, g) => {
    draw(pane, g);
    const now = performance.now();
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      if (now > f.until) {
        flashes.splice(i, 1);
        continue;
      }
      if (f.pane !== pane) continue;
      const s = screenOfGround(pane, f.lat, f.lon, pane.geoLayer()?.defaultHeight() ?? 0);
      if (!s) continue;
      g.strokeStyle = '#00ff00';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(s.x, s.y, 14, 0, Math.PI * 2);
      g.stroke();
      app.renderer.invalidate();
    }
  };
}
