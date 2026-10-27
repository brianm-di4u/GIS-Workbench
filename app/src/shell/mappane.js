// Workspace Map View (REQ-UI-01, REQ-UI-26): the embedded Natural Earth 1:110m basemap in
// plate carrée, a graticule, and footprints of loaded images (red) and terrain (orange),
// drawn through the shared WebGL2 context. Display only; never used for measurement.

import { h } from './dom.js';

export class MapPane {
  constructor(app, host) {
    this.app = app;
    this.view = { lon: 0, lat: 20, zoom: 2 }; // CSS px per degree
    this.el = h('div', { class: 'pane map-pane', tabindex: '0', role: 'application', 'aria-label': 'Map view', 'data-id': 'pane:map' });
    this.coords = h('div', { class: 'map-coords' }, '');
    this.notice = h('div', { class: 'map-notice', role: 'status', hidden: true });
    this.attribution = h('div', { class: 'map-attribution' });
    this.el.append(this.coords, this.notice, this.attribution);
    app.on('online-notice', (t) => {
      this.notice.hidden = !t;
      this.notice.textContent = t;
    });
    host.appendChild(this.el);
    this.background = [0, 0, 0.078, 1]; // map.bg #000014
    this.rings = null;
    this.borders = null;
    this._bind();
    app.renderer.addPane(this);
    this._load();
  }

  async _load() {
    try {
      const text = await this.app.gw.text('data-basemap');
      const bm = JSON.parse(text);
      const q = bm.q;
      const rings = [];
      const lines = [];
      for (const c of bm.countries) {
        for (const enc of c.r) {
          const n = enc.length / 2;
          const ring = new Float32Array(enc.length);
          let x = 0;
          let y = 0;
          for (let i = 0; i < n; i++) {
            x += enc[2 * i];
            y += enc[2 * i + 1];
            ring[2 * i] = x / q;
            ring[2 * i + 1] = y / q;
          }
          rings.push(ring);
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            lines.push(ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1]);
          }
        }
      }
      this.rings = rings;
      this.borders = new Float32Array(lines);
      this.names = bm.countries.map((c) => c.n);
      this.app.renderer.invalidate();
    } catch (e) {
      this.app.log('warn', `basemap unavailable: ${e.message}`);
    }
  }

  matrix(pw, ph, dpr) {
    const z = this.view.zoom * dpr;
    // sx = (lon − lon0)·z + W/2 ; sy = (lat0 − lat)·z + H/2
    return new Float32Array([z, 0, 0, 0, -z, 0, pw / 2 - this.view.lon * z, ph / 2 + this.view.lat * z, 1]);
  }

  draw(r, vp) {
    const gl = r.gl;
    const m = this.matrix(vp.w, vp.h, vp.dpr);
    // An online background replaces the country fill; borders stay on top (REQ-UI-26).
    const online = this.app.onlineTiles?.draw(r, vp, this);
    const src = online ? this.app.onlineTiles.source() : null;
    const att = src ? src.attribution || src.name : '';
    if (this.attribution.textContent !== att) this.attribution.textContent = att;
    if (!online && !this.notice.hidden && !this.app.online?.visible) this.notice.hidden = true;
    if (this.rings) {
      if (!online) r.fillPolygons(this.rings, [0.18, 0.2, 0.22, 1], m, vp.w, vp.h);
      r.drawFlat(this.borders, gl.LINES, online ? [0.9, 0.9, 0.2, 0.6] : [0.45, 0.47, 0.5, 1], m, vp.w, vp.h);
    }
    // Graticule every 30° (10° when zoomed in).
    const step = this.view.zoom > 12 ? 5 : this.view.zoom > 5 ? 10 : 30;
    const g = [];
    for (let lon = -180; lon <= 180; lon += step) g.push(lon, -90, lon, 90);
    for (let lat = -90; lat <= 90; lat += step) g.push(-180, lat, 180, lat);
    r.drawFlat(new Float32Array(g), gl.LINES, [0.2, 0.25, 0.35, 0.8], m, vp.w, vp.h);
    // Footprints.
    for (const l of this.app.layers.values()) {
      const fp = l.footprint?.();
      if (!fp || l.rec?.footprint === false) continue; // footprint toggle (Image List, REQ-UI-19)
      const v = new Float32Array(fp.flatMap(([lat, lon]) => [lon, lat]));
      const col = l.kind === 'dem' ? [1, 0.55, 0, 1] : [0.88, 0, 0, 1];
      r.drawFlat(v, gl.LINE_LOOP, col, m, vp.w, vp.h);
      if (this.app.selectedLayerId === l.id) r.drawFlat(v, gl.TRIANGLE_FAN, [0.88, 0, 0, 0.25], m, vp.w, vp.h);
    }
    // Motion imagery: sensor path, LOS, footprint, events, VMTI and GMTI (REQ-FMV-07, 10, 11).
    this.app.fmv?.drawMap(r, m, vp, this);
  }

  toLonLat(sx, sy) {
    const r = this.el.getBoundingClientRect();
    return { lon: this.view.lon + (sx - r.width / 2) / this.view.zoom, lat: this.view.lat - (sy - r.height / 2) / this.view.zoom };
  }

  zoomTo(lat, lon, zoom) {
    Object.assign(this.view, { lat, lon, zoom: zoom ?? this.view.zoom });
    this.app.renderer.invalidate();
  }

  zoomToFootprints() {
    const pts = [];
    for (const l of this.app.layers.values()) for (const p of l.footprint?.() ?? []) pts.push(p);
    if (!pts.length) return this.zoomTo(20, 0, 2);
    const lats = pts.map((p) => p[0]);
    const lons = pts.map((p) => p[1]);
    const r = this.el.getBoundingClientRect();
    const span = Math.max(Math.max(...lons) - Math.min(...lons), (Math.max(...lats) - Math.min(...lats)) * (r.width / Math.max(1, r.height)), 0.01);
    this.zoomTo((Math.max(...lats) + Math.min(...lats)) / 2, (Math.max(...lons) + Math.min(...lons)) / 2, Math.min(4000, (r.width * 0.6) / span));
  }

  _bind() {
    const el = this.el;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const before = this.toLonLat(e.clientX - r.left, e.clientY - r.top);
      this.view.zoom = Math.min(20000, Math.max(0.5, this.view.zoom * (e.deltaY < 0 ? 1.25 : 0.8)));
      const after = this.toLonLat(e.clientX - r.left, e.clientY - r.top);
      this.view.lon += before.lon - after.lon;
      this.view.lat += before.lat - after.lat;
      this.app.renderer.invalidate();
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      el.setPointerCapture(e.pointerId);
      const s = { x: e.clientX, y: e.clientY, lon: this.view.lon, lat: this.view.lat };
      const move = (ev) => {
        this.view.lon = s.lon - (ev.clientX - s.x) / this.view.zoom;
        this.view.lat = Math.max(-90, Math.min(90, s.lat + (ev.clientY - s.y) / this.view.zoom));
        this.app.renderer.invalidate();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      const p = this.toLonLat(e.clientX - r.left, e.clientY - r.top);
      if (Math.abs(p.lat) <= 90) {
        let mg = '';
        try {
          mg = this.app.core.mgrs(p.lat, ((p.lon + 540) % 360) - 180, 3);
        } catch {}
        this.coords.textContent = `${this.app.core.format(p.lat, ((p.lon + 540) % 360) - 180, 0, 4)}  ${mg}`;
      }
    });
    el.addEventListener('dblclick', (e) => {
      const r = el.getBoundingClientRect();
      const p = this.toLonLat(e.clientX - r.left, e.clientY - r.top);
      this.zoomTo(p.lat, p.lon, this.view.zoom * 2);
    });
  }
}
