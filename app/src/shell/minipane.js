// Overview and panel-in-panel (REQ-IMG-14): a small pane on the shared WebGL renderer that
// shows the whole image of a source pane, the source pane's footprint (rotation-aware) and a
// snail trail of where it has been. A click or drag recentres the source pane.
// Inside an opaque dock (`copy`), the pixels drawn on the shared canvas are copied into the
// overlay in the same frame, since the canvas behind the dock is covered.

import { h } from './dom.js';
import { levelFor } from '../render/tiles.js';
import { invertView, forwardView, alignedBox } from '../render/renderer.js';

export class MiniPane {
  constructor(app, { source, className = 'minipane', label = 'Overview', copy = false }) {
    this.app = app;
    this.source = source; // () => ImagePane
    this.copy = copy;
    this.trail = [];
    this.el = h('div', { class: className, role: 'img', 'aria-label': `${label}: the whole image with the current view outlined; click to move the view there` });
    this.overlay = h('canvas', { class: 'pane-overlay', 'aria-hidden': 'true' });
    this.el.appendChild(this.overlay);
    this.background = [0.08, 0.08, 0.08, 1];
    this._bind();
    app.renderer.addPane(this);
    this._offView = app.on('view', (p) => {
      if (p !== this.source()) return;
      const t = this.trail.at(-1);
      if (!t || Math.hypot(t.x - p.view.cx, t.y - p.view.cy) * p.view.zoom > 20) this.trail.push({ x: p.view.cx, y: p.view.cy });
      if (this.trail.length > 400) this.trail.shift();
      app.renderer.invalidate();
    });
  }

  layer() {
    const p = this.source();
    return p?.geoLayer() ?? p?.layers()[0] ?? null;
  }

  /** Whole-image view in CSS px. */
  view() {
    const l = this.layer();
    const r = this.el.getBoundingClientRect();
    if (!l || r.width < 2) return null;
    const z = Math.min(r.width / l.width, r.height / l.height) * 0.95;
    return { cx: l.width / 2, cy: l.height / 2, zoom: z, rot: 0, w: r.width, h: r.height };
  }

  draw(r, vp) {
    const v = this.view();
    const src = this.source();
    if (!v || !src) return;
    const dev = { ...v, zoom: v.zoom * vp.dpr };
    let loading = 0;
    for (const l of src.visibleLayers()) {
      if (!l.lutTex) continue;
      // A registered layer of another pixel size (a NITF mask segment) plans in its own pixels (CX-037).
      const A = l.align;
      const s = A ? Math.sqrt(Math.abs(A[1] * A[5] - A[2] * A[4])) || 1 : 1;
      const box = A ? alignedBox(A, [{ x: 0, y: 0 }, { x: v.cx * 2, y: 0 }, { x: 0, y: v.cy * 2 }, { x: v.cx * 2, y: v.cy * 2 }]) : { x0: 0, y0: 0, x1: l.width, y1: l.height };
      const L = levelFor(dev.zoom * s, l.levels);
      const tiles = l.tiles.plan(L, box, { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 });
      loading += l.tiles.loading;
      if (tiles.length) r.drawImageTiles(l, tiles, dev, vp.w, vp.h);
    }
    if (loading) r.invalidate();
    this._overlay(v, vp.dpr, src, r, vp);
  }

  _overlay(v, dpr, src, r, vp) {
    const c = this.overlay;
    const W = Math.round(v.w * dpr);
    const H = Math.round(v.h * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = c.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (this.copy) g.drawImage(r.canvas, vp.x, r.canvas.height - vp.y - vp.h, vp.w, vp.h, 0, 0, W, H);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const map = (x, y) => forwardView(v, v.w, v.h, x, y);
    if (this.trail.length > 1) {
      g.strokeStyle = 'rgba(0, 255, 255, 0.7)';
      g.lineWidth = 1;
      g.beginPath();
      this.trail.forEach((t, i) => {
        const p = map(t.x, t.y);
        if (i) g.lineTo(p.x, p.y);
        else g.moveTo(p.x, p.y);
      });
      g.stroke();
    }
    const { w, h } = src.size();
    const corners = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ].map(([x, y]) => invertView(src.view, w, h, x, y));
    g.strokeStyle = '#ffff00';
    g.lineWidth = 2;
    g.beginPath();
    corners.forEach((q, i) => {
      const p = map(q.x, q.y);
      if (i) g.lineTo(p.x, p.y);
      else g.moveTo(p.x, p.y);
    });
    g.closePath();
    g.stroke();
  }

  _bind() {
    const go = (e) => {
      const v = this.view();
      const src = this.source();
      if (!v || !src) return;
      const r = this.el.getBoundingClientRect();
      const p = invertView(v, v.w, v.h, e.clientX - r.left, e.clientY - r.top);
      src.centreOn(p.x, p.y);
      src._afterRoam?.();
    };
    this.el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.el.setPointerCapture(e.pointerId);
      go(e);
      const move = (ev) => go(ev);
      const up = () => {
        this.el.removeEventListener('pointermove', move);
        this.el.removeEventListener('pointerup', up);
      };
      this.el.addEventListener('pointermove', move);
      this.el.addEventListener('pointerup', up);
    });
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  animating() {
    return false;
  }

  onContextRestored() {}

  dispose() {
    this._offView?.();
    this.app.renderer.removePane(this);
    this.el.remove();
  }
}
