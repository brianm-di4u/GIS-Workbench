// Image pane (REQ-IMG-01, REQ-IMG-11/12, REQ-UI-08, REQ-UI-13): a transparent DOM rectangle
// over the shared WebGL canvas, with a Canvas 2D overlay for graphics, cursor and
// decorations, DOM classification banners, and the GXP mouse grammar.

import { h } from './dom.js';
import { levelFor } from '../render/tiles.js';
import { invertView, forwardView, alignedBox, applyAffine, invertAffine, screenToImageDelta } from '../render/renderer.js';
import { bannerText, highest, bannerColorVar } from '../security/marking.js';

const WHEEL_STEP = 2 ** 0.25;
const ZMIN = 1 / 4096;
const ZMAX = 32;

export class ImagePane {
  constructor(app, mp, id) {
    this.app = app;
    this.mp = mp;
    this.id = id;
    this.view = { cx: 0, cy: 0, zoom: 1, rot: 0, mode: 'native' };
    this.cursor = null; // {sx, sy, x, y}
    this.roam = null;
    this.fullRoam = false;
    this.el = h('div', { class: 'pane', tabindex: '0', role: 'application', 'aria-roledescription': 'image panel', 'data-id': `pane:${id}` });
    this.overlay = h('canvas', { class: 'pane-overlay', 'aria-hidden': 'true' });
    this.bannerTop = h('div', { class: 'banner banner-top', 'data-id': `pane:${id}:banner` });
    this.bannerBottom = h('div', { class: 'banner banner-bottom' });
    this.label = h('div', { class: 'pane-label' });
    this.status = h('div', { class: 'pane-status', 'aria-live': 'polite' });
    this.readout = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    this.el.append(this.overlay, this.bannerTop, this.bannerBottom, this.label, this.status, this.readout);
    this._bind();
    // Window resizes, splitters and docks change the panel's size: redraw (GUI-011).
    this._resize = new ResizeObserver(() => this.invalidate());
    this._resize.observe(this.el);
    app.renderer.addPane(this);
    this.background = this.rec?.background ?? [0, 0, 0, 1];
    this._overlayDirty = true;
  }

  get rec() {
    return this.app.store.get(this.id);
  }

  layers() {
    const ids = this.rec?.layers ?? [];
    return ids.map((id) => this.app.layers.get(id)).filter(Boolean);
  }

  visibleLayers() {
    return this.layers().filter((l) => l.rec?.visible !== false);
  }

  activeLayer() {
    const id = this.rec?.activeLayer;
    return (id && this.app.layers.get(id)) || this.layers().at(-1) || null;
  }

  /** Reference layer for geometry: the active image layer, else the top image layer. */
  geoLayer() {
    const a = this.activeLayer();
    if (a?.modelId) return a;
    return this.layers().reverse().find((l) => l.modelId) ?? a;
  }

  size() {
    const r = this.el.getBoundingClientRect();
    return { w: r.width, h: r.height, r };
  }

  animating() {
    return !!this.roam || this.fullRoam || this.compare?.mode === 'flicker';
  }

  invalidate() {
    this._overlayDirty = true;
    this.app.renderer.invalidate();
  }

  // ---- view ----

  setView(v, { link = true } = {}) {
    Object.assign(this.view, v);
    this.view.zoom = Math.min(ZMAX, Math.max(ZMIN, this.view.zoom));
    this.invalidate();
    if (link) this.app.links?.propagate(this);
    this.app.emit('view', this);
  }

  fitWhole() {
    if (this.stereo) return this.stereo.fitWhole();
    const l = this.geoLayer() ?? this.layers()[0];
    if (!l) return;
    const { w, h } = this.size();
    if (w < 2) return requestAnimationFrame(() => this.fitWhole());
    // With a display transform (SAR squaring/ground plane), fit the transformed extent.
    const L = this.view.lin ?? [1, 0, 0, 1];
    const ex = Math.abs(L[0] * l.width) + Math.abs(L[1] * l.height);
    const ey = Math.abs(L[2] * l.width) + Math.abs(L[3] * l.height);
    const z = Math.min(w / ex, h / ey) * 0.96;
    this.setView({ cx: l.width / 2, cy: l.height / 2, zoom: z });
    this.applyOrientation();
  }

  zoomAt(factor, sx, sy) {
    const { w, h } = this.size();
    const p = invertView(this.view, w, h, sx, sy);
    const z = Math.min(ZMAX, Math.max(ZMIN, this.view.zoom * factor));
    // Keep the image point under the cursor fixed: c′ = p + (c − p)·z/z′ (rotation-aware).
    const nv = { ...this.view, zoom: z };
    const q = invertView(nv, w, h, sx, sy);
    this.setView({ zoom: z, cx: this.view.cx + (p.x - q.x), cy: this.view.cy + (p.y - q.y) });
  }

  oneToOne() {
    this.setView({ zoom: 1 / (window.devicePixelRatio || 1) });
  }

  centreOn(x, y) {
    this.setView({ cx: x, cy: y });
  }

  /** Centre on a ground point through the reference layer's model. */
  centreOnGround(lat, lon, h) {
    if (this.stereo) return this.stereo.centreOnGround(lat, lon, h);
    const l = this.geoLayer();
    if (!l?.modelId) throw new Error('the active image has no sensor model; Jump to Point needs one');
    // The terrain height under the point, so off-nadir images centre on the right pixel.
    const t = h === undefined ? this.app.terrain?.sample?.(lat, lon) : null;
    const p = l.imageAt(lat, lon, h ?? t?.hae ?? l.defaultHeight());
    if (!p) throw new Error('the point is outside the sensor model');
    this.centreOn(p.x, p.y);
    return p;
  }

  /** Orientation modes (REQ-IMG-12): computed from the model at the view centre. */
  orientationAngle(mode) {
    if (this.stereo) return 0;
    const l = this.geoLayer();
    if (mode === 'native' || !l?.modelId) return 0;
    const g = l.groundAt(this.view.cx, this.view.cy);
    if (!g) return 0;
    const core = this.app.core;
    let d;
    if (mode === 'north' || mode === 'shadows') {
      let az = 0;
      if (mode === 'shadows' && Number.isFinite(l.info.sar?.azimuth)) {
        // SAR: shadows fall away from the sensor, AzimAng + 180° on the ground (REQ-SAR-04).
        az = (l.info.sar.azimuth + 180) % 360;
      } else if (mode === 'shadows') {
        const sun = l.info.sun ?? this.app.sunFor(l, g);
        if (!sun) throw new Error('sun angles are not available for this image');
        az = (sun.azimuth + 180) % 360;
      }
      const t = core.direct(g.lat, g.lon, az, 10);
      const p0 = l.imageAt(g.lat, g.lon, g.h);
      const p1 = l.imageAt(t.lat, t.lon, g.h);
      if (!p0 || !p1) return 0;
      d = [p1.x - p0.x, p1.y - p0.y];
    } else if (mode === 'upisup') {
      const p0 = l.imageAt(g.lat, g.lon, g.h);
      const p1 = l.imageAt(g.lat, g.lon, g.h + 10);
      if (!p0 || !p1) return 0;
      d = [p1.x - p0.x, p1.y - p0.y];
      if (Math.hypot(d[0], d[1]) < 1e-6) return 0; // nadir view or 2-D model
    }
    // Through the display transform (SAR squaring or ground plane), if any.
    const L = this.view.lin;
    if (L) d = [L[0] * d[0] + L[1] * d[1], L[2] * d[0] + L[3] * d[1]];
    const ang = Math.atan2(d[1], d[0]);
    return mode === 'shadows' ? Math.PI / 2 - ang : -Math.PI / 2 - ang;
  }

  applyOrientation(mode = this.view.mode) {
    try {
      const rot = this.orientationAngle(mode);
      this.setView({ rot, mode });
    } catch (e) {
      this.app.toast(e.message, { kind: 'warn' });
    }
  }

  // ---- drawing ----

  draw(r, vp) {
    const { w: cw, h: chh } = this.size();
    if (this.view3d || this.video) {
      // The 3D view and the video panel draw themselves (REQ-LDR-04, REQ-FMV-05); keep the 2D overlay clear.
      const g = this.overlay.getContext('2d');
      g.clearRect(0, 0, this.overlay.width, this.overlay.height);
      return;
    }
    const dpr = vp.dpr;
    const view = { ...this.view, zoom: this.view.zoom * dpr };
    const pw = vp.w;
    const ph = vp.h;
    // Image bbox of the pane (rotation-aware) at full resolution.
    const corners = [
      [0, 0],
      [pw, 0],
      [0, ph],
      [pw, ph],
    ].map(([x, y]) => invertView(view, pw, ph, x, y));
    const bbox = { x0: Math.min(...corners.map((c) => c.x)), y0: Math.min(...corners.map((c) => c.y)), x1: Math.max(...corners.map((c) => c.x)), y1: Math.max(...corners.map((c) => c.y)) };
    let loading = 0;
    const drawLayer = (l, opts) => {
      if (!l.stats) {
        loading++;
        return;
      }
      const L = levelFor(view.zoom, l.levels);
      // A registered (or stereo-eye) layer plans tiles and viewport statistics in its own pixel frame (REQ-SNS-09).
      const lb = l.align ? alignedBox(l.align, corners) : bbox;
      l.updateViewHist(L, l.chain.dra.scope === 'aoi' ? this.app.aoiBox?.(this, l) ?? lb : lb);
      l.updateLut();
      if (!l.lutTex) return;
      const lc = l.align ? applyAffine(invertAffine(l.align), view.cx, view.cy) : { x: view.cx, y: view.cy };
      const tiles = l.tiles.plan(L, lb, lc);
      loading += l.tiles.loading;
      if (tiles.length) r.drawImageTiles(l, tiles, view, pw, ph, opts);
    };
    const cmp = this.compareLayers();
    const ps = !cmp && this.app.panSharpenFor?.(this);
    if (ps) {
      // Pan-sharpening (REQ-IMG-10): MS colour, pan and (IHS-NIR) the NIR band offscreen,
      // then fused in screen space; other layers draw as usual.
      const vpGl = { x: vp.x, y: vp.y, w: pw, h: ph };
      const pass = (i, l) => {
        const t = r.beginTarget(i, pw, ph);
        drawLayer(l);
        return t;
      };
      for (const l of this.visibleLayers()) if (l !== ps.ms && l !== ps.pan && this.visibleLayers().indexOf(l) < this.visibleLayers().indexOf(ps.ms)) drawLayer(l);
      const a = pass(0, ps.ms);
      const b = pass(1, ps.pan);
      const c = ps.nir ? pass(2, ps.nir) : null;
      r.endTarget(vpGl);
      if (ps.stats) r.drawPanSharpen(a, b, c, ps.method, ps.stats, vpGl);
      for (const l of this.visibleLayers()) if (l !== ps.ms && l !== ps.pan && this.visibleLayers().indexOf(l) > this.visibleLayers().indexOf(ps.ms)) drawLayer(l);
    } else if (this.stereo && !cmp) {
      // Stereo (REQ-STR-03/04): each eye through its display-plane affine into a target, its
      // cursor and marks drawn per eye, then the composite.
      const vpGl = { x: vp.x, y: vp.y, w: pw, h: ph };
      const st = this.stereo;
      st.prepare(view, pw, ph);
      const tl = r.beginTarget(0, pw, ph);
      drawLayer(st.layer('L'));
      st.drawEye(r, 'L', view, pw, ph);
      const tr = r.beginTarget(1, pw, ph);
      drawLayer(st.layer('R'));
      st.drawEye(r, 'R', view, pw, ph);
      r.endTarget(vpGl);
      r.drawStereo(tl, tr, st.displayOpts(), vpGl);
      st.afterDraw?.(r);
    } else if (!cmp) for (const l of this.visibleLayers()) drawLayer(l);
    else this._drawCompare(r, vp, cmp, drawLayer);
    this._loading = loading;
    if (this.app.magnifier?.on && this.cursor) loading += this._drawLens(r, vp, view);
    if (loading) r.invalidate();
    this._drawOverlay(cw, chh, dpr);
    if (this.roam) this._stepRoam();
  }

  // ---- comparison (REQ-IMG-24) ----

  /** {mode, top, bottom, under} when a comparison is on and two image layers are visible. */
  compareLayers() {
    const c = this.compare;
    if (!c || c.mode === 'none') return null;
    const vis = this.visibleLayers().filter((l) => l.kind !== 'dem');
    if (vis.length < 2) return null;
    const active = this.activeLayer();
    const top = vis.includes(active) ? active : vis.at(-1);
    const under = this.visibleLayers().filter((l) => l !== top);
    const bottom = [...vis].reverse().find((l) => l !== top);
    return { mode: c.mode, top, bottom, under };
  }

  _drawCompare(r, vp, cmp, drawLayer) {
    const gl = r.gl;
    const c = this.compare;
    const dpr = vp.dpr;
    if (cmp.mode === 'twocolour') {
      // Date 1 (the lower image) in red, date 2 (the upper image) in green + blue.
      gl.disable(gl.BLEND);
      gl.colorMask(true, false, false, true);
      drawLayer(cmp.bottom);
      gl.colorMask(false, true, true, false);
      drawLayer(cmp.top);
      gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND);
      return;
    }
    for (const l of cmp.under) drawLayer(l);
    if (cmp.mode === 'swipe') {
      if (this.cursor) c.pos = this.cursor.sx / Math.max(1, this.size().w);
      const w = Math.round(vp.w * (c.pos ?? 0.5));
      if (w > 0) {
        gl.scissor(Math.max(0, vp.x), Math.max(0, vp.y), w, vp.h);
        drawLayer(cmp.top);
        gl.scissor(Math.max(0, vp.x), Math.max(0, vp.y), vp.w, vp.h);
      }
    } else if (cmp.mode === 'porthole') {
      if (!this.cursor) return drawLayer(cmp.top);
      r.stencilDisc(this.cursor.sx * dpr, this.cursor.sy * dpr, (c.radius ?? 120) * dpr, vp.w, vp.h);
      gl.stencilFunc(gl.EQUAL, 0, 0xff); // the upper image everywhere except the hole
      drawLayer(cmp.top);
      gl.disable(gl.STENCIL_TEST);
    } else if (cmp.mode === 'blend') {
      drawLayer(cmp.top, { opacity: c.alpha ?? 0.5 });
    } else if (cmp.mode === 'flicker') {
      const phase = Math.floor((performance.now() / 1000) * (c.rate ?? 2) * 2) % 2 === 0;
      c.showingTop = phase;
      if (phase) drawLayer(cmp.top);
    }
  }

  /** Magnifying glass (REQ-IMG-14): a second pass of the pane's layers around the cursor. */
  lensRect() {
    const m = this.app.magnifier;
    if (!m?.on || !this.cursor) return null;
    const s = m.size;
    return { x: this.cursor.sx - s / 2, y: this.cursor.sy - s / 2, s };
  }

  _drawLens(r, vp, view) {
    const lr = this.lensRect();
    const gl = r.gl;
    const dpr = vp.dpr;
    const lw = Math.round(lr.s * dpr);
    const lx = Math.round(vp.x + lr.x * dpr);
    const ly = Math.round(vp.y + vp.h - (lr.y + lr.s) * dpr);
    gl.viewport(lx, ly, lw, lw);
    // Scissor to the lens and the pane together.
    const x0 = Math.max(lx, vp.x);
    const y0 = Math.max(ly, vp.y);
    const x1 = Math.min(lx + lw, vp.x + vp.w);
    const y1 = Math.min(ly + lw, vp.y + vp.h);
    if (x1 <= x0 || y1 <= y0) return 0;
    gl.scissor(x0, y0, x1 - x0, y1 - y0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const lens = { ...view, cx: this.cursor.x, cy: this.cursor.y, zoom: view.zoom * this.app.magnifier.power };
    const half = lw / 2 / lens.zoom * 1.5;
    const bbox = { x0: lens.cx - half, y0: lens.cy - half, x1: lens.cx + half, y1: lens.cy + half };
    let loading = 0;
    for (const l of this.visibleLayers()) {
      if (!l.lutTex) continue;
      const L = levelFor(lens.zoom, l.levels);
      const tiles = l.tiles.plan(L, bbox, { x: lens.cx, y: lens.cy });
      loading += l.tiles.loading;
      if (tiles.length) r.drawImageTiles(l, tiles, lens, lw, lw);
    }
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
    gl.scissor(Math.max(0, vp.x), Math.max(0, vp.y), vp.w, vp.h);
    return loading;
  }

  _drawOverlay(w, h, dpr) {
    const c = this.overlay;
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const l = this.geoLayer();
    // Graphics and measurements in this pane.
    this.app.graphics?.drawPane(this, g, w, h);
    this.app.tools?.drawOverlay(this, g, w, h);
    // Cursor link cross-hair from other panes.
    const lc = this.app.links?.cursorFor(this);
    if (lc) {
      g.strokeStyle = '#00ff00';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(lc.x - 10, lc.y);
      g.lineTo(lc.x + 10, lc.y);
      g.moveTo(lc.x, lc.y - 10);
      g.lineTo(lc.x, lc.y + 10);
      g.stroke();
    }
    const lr = this.lensRect();
    if (lr) {
      g.strokeStyle = '#ffcb5f';
      g.lineWidth = 2;
      g.strokeRect(lr.x, lr.y, lr.s, lr.s);
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(lr.x + lr.s / 2 - 6, lr.y + lr.s / 2);
      g.lineTo(lr.x + lr.s / 2 + 6, lr.y + lr.s / 2);
      g.moveTo(lr.x + lr.s / 2, lr.y + lr.s / 2 - 6);
      g.lineTo(lr.x + lr.s / 2, lr.y + lr.s / 2 + 6);
      g.stroke();
      g.font = '11px Segoe UI, system-ui, sans-serif';
      g.fillStyle = '#ffcb5f';
      g.fillText(`×${this.app.magnifier.power}`, lr.x + 4, lr.y + lr.s - 6);
    }
    this.app.paneDecorations?.(this, g, w, h, l);
    this.app.compareOverlay?.(this, g, w, h);
    const deco = this.app.prefs.get('decorations') ?? {};
    if (l?.modelId && deco.north !== false) this._northArrow(g, l);
    if (l?.modelId && deco.scalebar !== false) this._scaleBar(g, l, w, h);
    if (this._loading) {
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.font = '11px Segoe UI, system-ui, sans-serif';
      g.fillText(`loading ${this._loading} tile${this._loading > 1 ? 's' : ''}…`, 8, h - 24);
    }
    // Active panel outline (REQ-UI-13): yellow when this pane is active in a multi-panel layout.
    const active = this.mp.activePane === this && this.mp.panes.length > 1;
    this.el.classList.toggle('active', active);
    this._updateBanners();
  }

  _northArrow(g, l) {
    // Direction of north at the view centre, in screen space.
    let ang;
    try {
      const gc = l.groundAt(this.view.cx, this.view.cy);
      const t = this.app.core.direct(gc.lat, gc.lon, 0, 50);
      const p1 = l.imageAt(t.lat, t.lon, gc.h);
      const { w, h } = this.size();
      const a = forwardView(this.view, w, h, this.view.cx, this.view.cy);
      const b = forwardView(this.view, w, h, p1.x, p1.y);
      ang = Math.atan2(b.y - a.y, b.x - a.x);
    } catch {
      return;
    }
    const x = 28;
    const y = 52;
    g.save();
    g.translate(x, y);
    g.rotate(ang + Math.PI / 2);
    g.fillStyle = getComputedStyle(this.el).getPropertyValue('--c-gfx-northArrow') || '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, -16);
    g.lineTo(7, 9);
    g.lineTo(0, 4);
    g.lineTo(-7, 9);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.font = 'bold 11px Arial, sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 3;
    const nx = x + Math.cos(ang) * 26;
    const ny = y + Math.sin(ang) * 26 + 4;
    g.strokeText('N', nx, ny);
    g.fillText('N', nx, ny);
    g.textAlign = 'left';
  }

  /** Metres per CSS pixel at the view centre (geodesic). */
  groundScale(l = this.geoLayer()) {
    if (this.stereo) return this.stereo.groundScale();
    if (!l?.modelId) return NaN;
    const { w, h } = this.size();
    const a = invertView(this.view, w, h, w / 2, h / 2);
    const b = invertView(this.view, w, h, w / 2 + 100, h / 2);
    const ga = l.groundAt(a.x, a.y);
    const gb = l.groundAt(b.x, b.y);
    if (!ga || !gb) return NaN;
    return this.app.core.inverse(ga.lat, ga.lon, gb.lat, gb.lon).distance / 100;
  }

  _scaleBar(g, l, w, h) {
    const mpp = this.groundScale(l);
    if (!Number.isFinite(mpp) || mpp <= 0) return;
    const target = 120 * mpp;
    const p = 10 ** Math.floor(Math.log10(target));
    const nice = [1, 2, 5, 10].map((k) => k * p).filter((v) => v <= target).pop() ?? p;
    const px = nice / mpp;
    const x0 = w - px - 20;
    const y0 = h - 30;
    const blocks = 4;
    for (let i = 0; i < blocks; i++) {
      g.fillStyle = i % 2 ? '#ffffff' : '#e00000';
      g.fillRect(x0 + (i * px) / blocks, y0, px / blocks, 6);
    }
    g.strokeStyle = '#000';
    g.strokeRect(x0, y0, px, 6);
    const label = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
    g.font = '11px Arial, sans-serif';
    g.lineWidth = 3;
    g.strokeStyle = '#000';
    g.strokeText(label, x0, y0 - 4);
    g.fillStyle = '#fff';
    g.fillText(label, x0, y0 - 4);
    this.lastScale = { metresPerPx: mpp, bar: nice };
  }

  /** The highest marking of the visible layers drives the pane banners (REQ-SEC-04). */
  marking() {
    return highest(this.visibleLayers().map((l) => l.info.marking).concat(this.video?.clip.banner?.klv ? [this.video.clip.banner.klv] : []));
  }

  _updateBanners() {
    if (this.video) return; // the video panel sets ST 0102 banners itself (REQ-FMV-03)
    const show = (this.app.prefs.get('decorations') ?? {}).banners !== false;
    const m = this.marking();
    const text = this.visibleLayers().length ? bannerText(m) : '';
    for (const b of [this.bannerTop, this.bannerBottom]) {
      b.hidden = !show || !text;
      if (b.textContent !== text) b.textContent = text;
      b.style.background = `var(${bannerColorVar(m)})`;
    }
    const l = this.activeLayer();
    const lbl = this.video ? `Video — ${this.video.clip.name}` : this.view3d ? `3D — ${this.view3d.clouds.map((c) => c.cloud.name).join(', ')}` : l ? `${l.rec?.saved === false ? '*' : ''}${l.rec?.name ?? ''}` : 'No image — File ▸ Open Image, or drop files here';
    if (this.label.textContent !== lbl) this.label.textContent = lbl;
    this.el.setAttribute('aria-label', `Panel ${this.mp.panes.indexOf(this) + 1}: ${l?.rec?.name ?? 'empty'}, zoom ${this.view.zoom.toFixed(3)}`);
  }

  // ---- interaction ----

  _local(e) {
    const r = this.el.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  /** View-plane point under screen (sx, sy): image pixels of the geo layer, or the stereo display plane. */
  viewPoint(sx, sy) {
    const { w, h } = this.size();
    return invertView(this.view, w, h, sx, sy);
  }

  /** Image pixels of the geo layer under screen (sx, sy) (the left eye in stereo). */
  imagePoint(sx, sy) {
    if (this.stereo) return this.stereo.imagePoint(sx, sy);
    return this.viewPoint(sx, sy);
  }

  screenPoint(x, y) {
    if (this.stereo) return this.stereo.screenPoint(x, y);
    const { w, h } = this.size();
    return forwardView(this.view, w, h, x, y);
  }

  _bind() {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      el.focus({ preventScroll: true });
      this.mp.setActivePane(this);
      const { sx, sy } = this._local(e);
      if (e.button === 1) {
        // Middle button: roam with speed proportional to the distance from the centre.
        e.preventDefault();
        this.roam = { sx, sy, t: performance.now() };
        el.setPointerCapture(e.pointerId);
        this.app.renderer.invalidate();
        return;
      }
      if (e.button === 2) return;
      const tool = this.app.tools.current;
      if (tool?.onDown?.(this, e, sx, sy) === true) {
        el.setPointerCapture(e.pointerId);
        return;
      }
      // Default: glove pan.
      const start = { sx, sy, cx: this.view.cx, cy: this.view.cy };
      el.setPointerCapture(e.pointerId);
      el.classList.add('grabbing');
      const move = (ev) => {
        const p = this._local(ev);
        const d = screenToImageDelta(this.view, p.sx - start.sx, p.sy - start.sy);
        this.setView({ cx: start.cx - d.x, cy: start.cy - d.y });
      };
      const up = () => {
        el.classList.remove('grabbing');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        this._afterRoam();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('pointermove', (e) => {
      const { sx, sy } = this._local(e);
      if (this.roam) {
        this.roam.mx = sx;
        this.roam.my = sy;
      }
      if (this.fullRoam) this.roam = { ...(this.roam ?? { t: performance.now() }), sx: this.size().w / 2, sy: this.size().h / 2, mx: sx, my: sy, full: true };
      // Pan zone (REQ-UI-09): with Space held, moving the mouse drags the image under it.
      if (this.app.keys?.held.has('Space') && !e.buttons && this._spacePrev && !this.app.feedback?.active) {
        const a = this.viewPoint(this._spacePrev.sx, this._spacePrev.sy);
        const b = this.viewPoint(sx, sy);
        this.setView({ cx: this.view.cx - (b.x - a.x), cy: this.view.cy - (b.y - a.y) });
      }
      this._spacePrev = this.app.keys?.held.has('Space') ? { sx, sy } : null;
      const p = this.imagePoint(sx, sy);
      this.cursor = { sx, sy, x: p.x, y: p.y };
      if (this.app.magnifier?.on || this.compare?.mode === 'swipe' || this.compare?.mode === 'porthole') this.invalidate();
      this.stereo?.mouseMoved(sx, sy);
      this.app.tools.current?.onMove?.(this, e, sx, sy);
      this.app.cursorMoved(this, p.x, p.y);
    });
    el.addEventListener('pointerup', (e) => {
      if (e.button === 1 && this.roam) {
        this.roam = null;
        this._afterRoam();
      }
      const { sx, sy } = this._local(e);
      this.app.tools.current?.onUp?.(this, e, sx, sy);
    });
    el.addEventListener('pointerleave', () => {
      this.cursor = null;
      if (this.app.magnifier?.on) this.invalidate();
      this.app.cursorMoved(this, NaN, NaN);
    });
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.shiftKey) {
          this.stereo?.wheelZ(e); // Shift+wheel is Z in stereo (REQ-STR-08)
          return;
        }
        if (e.altKey && this.compare?.mode === 'porthole') {
          this.compare.radius = Math.max(20, Math.min(600, (this.compare.radius ?? 120) * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
          this.invalidate();
          return;
        }
        const { sx, sy } = this._local(e);
        const steps = -Math.sign(e.deltaY) * Math.min(4, Math.max(1, Math.abs(e.deltaY) / 100));
        this.zoomAt(WHEEL_STEP ** steps, sx, sy);
        clearTimeout(this._wheelT);
        this._wheelT = setTimeout(() => this._afterRoam(), 250);
      },
      { passive: false },
    );
    el.addEventListener('dblclick', (e) => {
      if (this.app.tools.current?.onDblClick?.(this, e)) return;
      const { sx, sy } = this._local(e);
      const p = this.viewPoint(sx, sy);
      this.setView({ cx: p.x, cy: p.y, zoom: this.view.zoom * 2 });
      this._afterRoam();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { sx, sy } = this._local(e);
      this.app.paneContextMenu(this, e.clientX, e.clientY, this.imagePoint(sx, sy));
    });
    el.addEventListener('keydown', (e) => this.app.keys.paneKey(this, e));
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('drop');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop');
      this.mp.setActivePane(this);
      this.app.openDropped(e.dataTransfer, this);
    });
  }

  _stepRoam() {
    const r = this.roam;
    if (!r || r.mx === undefined) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - r.t) / 1000);
    r.t = now;
    const { w, h } = this.size();
    const ox = r.full ? w / 2 : r.sx;
    const oy = r.full ? h / 2 : r.sy;
    const dx = r.mx - ox;
    const dy = r.my - oy;
    const dead = r.full ? 20 : 4;
    if (Math.hypot(dx, dy) < dead) return;
    // Speed ∝ distance: 3 × distance in screen px per second.
    const d = screenToImageDelta(this.view, 3 * dt * dx, 3 * dt * dy);
    this.setView({ cx: this.view.cx + d.x, cy: this.view.cy + d.y });
  }

  _afterRoam() {
    // Recompute the orientation angle when a roam ends, not every frame (Research/04 §4.2).
    if (this.view.mode && this.view.mode !== 'native' && this.view.mode !== 'free') {
      try {
        this.setView({ rot: this.orientationAngle(this.view.mode) }, { link: false });
      } catch {
        /* keep the angle */
      }
    }
    this.app.undo.seal();
  }

  toggleFullRoam() {
    this.fullRoam = !this.fullRoam;
    if (!this.fullRoam) this.roam = null;
    this.app.toast(this.fullRoam ? 'Full roam on: move the mouse away from the centre to roam (F7 or Esc to stop)' : 'Full roam off');
    this.app.renderer.invalidate();
  }

  onContextRestored() {
    for (const l of this.layers()) l.onContextRestored();
  }

  dispose() {
    this._resize.disconnect();
    this.app.renderer.removePane(this);
    this.el.remove();
  }
}
