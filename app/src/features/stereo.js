// Stereo (R2.3, Research/07 §3–7): pair metrics (REQ-STR-01), the Stereo Model Manager and Pair
// Finder (REQ-STR-02), on-the-fly epipolar display through the sensor models (REQ-STR-03), the
// anaglyph / side-by-side / over-under / interleaved views (REQ-STR-04/05), the floating cursor
// with Fixed Image / Fixed Cursor modes, zoom-scaled Z steps, place on ground, terrain tracking
// and snap to ground (REQ-STR-08/09), stereo linking (REQ-STR-10), Stereo Align (REQ-SNS-10)
// and stereo mensuration (REQ-MEN-12).
//
// Geometry: both eyes share one *display plane* — local ENU at the reference height h_ref,
// rotated so the pair's x-parallax runs along screen x, one display pixel = the left image's GSD.
// Each eye maps display → image through a viewport-local affine fitted to its sensor model (7 × 7
// points at h_ref); the right eye adds an affine y-correction fitted over several heights, so
// y-parallax is removed over the view (DN-28). The renderer draws each eye with that affine as the
// layer's alignment into an offscreen target, then composites.

import { h, clear } from '../shell/dom.js';
import { modal, section, field } from '../shell/dialogs.js';
import { invertView, forwardView, applyAffine, invertAffine } from '../render/renderer.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';

export const name = 'stereo';

const MODES = ['dubois', 'true', 'grey', 'half', 'sbs', 'cross', 'overunder', 'interleaved', 'split', 'spanned', 'dual'];
const MODE_NAMES = { dubois: 'Anaglyph (Dubois)', true: 'True anaglyph', grey: 'Grey anaglyph', half: 'Half-colour anaglyph', sbs: 'Side-by-side (parallel)', cross: 'Side-by-side (cross-eyed)', overunder: 'Over-under', interleaved: 'Row-interleaved', split: 'Split screen', spanned: 'Spanned (two monitors)', dual: 'Dual output (second window)' };
const D2R = Math.PI / 180;

/** Least-squares affine (x, y) = A·(u, v, 1) from pairs [{u, v, x, y}]. */
export function fitAffine(pairs) {
  const n = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const by = [0, 0, 0];
  for (const p of pairs) {
    const r = [1, p.u, p.v];
    for (let i = 0; i < 3; i++) {
      bx[i] += r[i] * p.x;
      by[i] += r[i] * p.y;
      for (let j = 0; j < 3; j++) n[i][j] += r[i] * r[j];
    }
  }
  const sol = (b) => {
    const m = n.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      [m[c], m[p]] = [m[p], m[c]];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const k = m[r][c] / m[c][c];
        for (let j = c; j < 4; j++) m[r][j] -= k * m[c][j];
      }
    }
    return m.map((row, i) => row[3] / row[i]);
  };
  const ax = sol(bx);
  const ay = sol(by);
  return [ax[0], ax[1], ax[2], ay[0], ay[1], ay[2]];
}

const compose = (A, B) => [A[0] + A[1] * B[0] + A[2] * B[3], A[1] * B[1] + A[2] * B[4], A[1] * B[2] + A[2] * B[5], A[3] + A[4] * B[0] + A[5] * B[3], A[4] * B[1] + A[5] * B[4], A[4] * B[2] + A[5] * B[5]];
const norm = (v) => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class StereoView {
  constructor(app, pane, L, R) {
    this.app = app;
    this.pane = pane;
    this.ids = { L: L.id, R: R.id };
    const pr = app.prefs.get('stereo') ?? {};
    this.mode = pr.mode ?? 'dubois';
    this.swap = false;
    this.parity = 0;
    this.linear = pr.linear ?? true;
    this.mirror = [false, false];
    this.cursorMode = pr.cursorMode ?? 'image'; // 'image' (Fixed Image) | 'cursor' (Fixed Cursor)
    this.showCursor = true;
    this.track = false;
    this.zOffset = 0;
    this.zSource = 'manual';
    this.cursor = null;
    this.shift = { L: [0, 0], R: [0, 0] };
    this.marks = [];
    this.key = '';
    this.setup();
    if (!pane) return; // geometry only (terrain extraction)
    this.statusEl = h('div', { class: 'pane-status stereo-status', 'data-id': `stereo:status:${pane.id}`, 'aria-live': 'polite' });
    pane.el.appendChild(this.statusEl);
    this.onKey = (e) => this.keydown(e);
    pane.el.addEventListener('keydown', this.onKey, true);
  }

  layer(e) {
    return this.app.layers.get(this.ids[e]);
  }

  dispose() {
    for (const e of ['L', 'R']) {
      const l = this.layer(e);
      if (l) l._stereoAlign = null;
    }
    this.statusEl?.remove();
    this.pane?.el.removeEventListener('keydown', this.onKey, true);
  }

  // ---- display plane ----
  setup() {
    const core = this.app.core;
    const L = this.layer('L');
    const R = this.layer('R');
    if (!L?.modelId || !R?.modelId) throw new Error('stereo needs two images with sensor models');
    const g0 = L.groundWithTerrain(L.width / 2, L.height / 2);
    if (!g0) throw new Error('the left image centre has no ground position');
    this.hRef = g0.h;
    const ga = L.groundAt(L.width / 2 + 1, L.height / 2);
    const gb = L.groundAt(L.width / 2, L.height / 2 + 1);
    const ex = core.inverse(g0.lat, g0.lon, ga.lat, ga.lon).distance;
    const ey = core.inverse(g0.lat, g0.lon, gb.lat, gb.lon).distance;
    this.s = 0.5 * (ex + ey); // metres per display pixel
    const dlat = 1e-4;
    const mN = core.inverse(g0.lat, g0.lon, g0.lat + dlat, g0.lon).distance / dlat;
    const mE = core.inverse(g0.lat, g0.lon, g0.lat, g0.lon + dlat).distance / dlat;
    this.O = { lat: g0.lat, lon: g0.lon, kLat: 1 / mN, kLon: 1 / mE };
    // x-parallax direction in ENU: how a height change separates the two eyes' ground positions.
    this.a = [1, 0];
    this.b = [0, -1];
    const enuOf = (lat, lon) => [(lon - this.O.lon) / this.O.kLon, (lat - this.O.lat) / this.O.kLat];
    const sep = (dz) => {
      const pl = L.imageAt(g0.lat, g0.lon, this.hRef + dz);
      const pr = R.imageAt(g0.lat, g0.lon, this.hRef + dz);
      const ql = core.i2g(L.modelId, pl.x, pl.y, this.hRef);
      const qr = core.i2g(R.modelId, pr.x, pr.y, this.hRef);
      const el = enuOf(ql.lat, ql.lon);
      const er = enuOf(qr.lat, qr.lon);
      return [er[0] - el[0], er[1] - el[1]];
    };
    const p0 = sep(-50);
    const p1 = sep(50);
    const pd = norm([p1[0] - p0[0], p1[1] - p0[1]]);
    this.a = pd; // display u axis (ENU), x-parallax grows with height along +u
    this.b = [pd[1], -pd[0]]; // display v axis: u rotated −90° (screen down)
    this.z = this.hRef;
    this.cursor = { lat: g0.lat, lon: g0.lon, h: this.hRef };
  }

  plane2ground(u, v, hh = this.hRef) {
    const e = this.s * (u * this.a[0] + v * this.b[0]);
    const n = this.s * (u * this.a[1] + v * this.b[1]);
    return { lat: this.O.lat + n * this.O.kLat, lon: this.O.lon + e * this.O.kLon, h: hh };
  }

  ground2plane(lat, lon) {
    const e = (lon - this.O.lon) / this.O.kLon;
    const n = (lat - this.O.lat) / this.O.kLat;
    return { x: (e * this.a[0] + n * this.a[1]) / this.s, y: (e * this.b[0] + n * this.b[1]) / this.s };
  }

  /** Refit the eye affines (and the right eye's y-correction) for the current view. */
  prepare(view, pw, ph) {
    const z = view.zoom;
    const k = `${pw}|${ph}|${Math.round(view.cx * z / (pw / 8))}|${Math.round(view.cy * z / (ph / 8))}|${Math.round(Math.log2(z) * 8)}|${view.rot}`;
    if (k !== this.key) {
      this.key = k;
      this.fit(view, pw, ph);
    }
    if (this.cursorMode === 'cursor') this.followCentre();
    this.applyAligns();
    this.updateStatus();
  }

  fit(view, pw, ph) {
    const cs = [
      [0, 0],
      [pw, 0],
      [0, ph],
      [pw, ph],
    ].map(([x, y]) => invertView(view, pw, ph, x, y));
    const x0 = Math.min(...cs.map((c) => c.x));
    const x1 = Math.max(...cs.map((c) => c.x));
    const y0 = Math.min(...cs.map((c) => c.y));
    const y1 = Math.max(...cs.map((c) => c.y));
    this.fitBounds(x0, y0, x1, y1);
  }

  /** Eye affines over a display-plane box (10 % margin), with the right eye's y-correction. */
  fitBounds(x0, y0, x1, y1, dzs = [-100, -50, 50, 100]) {
    const core = this.app.core;
    const mx = (x1 - x0) * 0.1;
    const my = (y1 - y0) * 0.1;
    const grid = [];
    for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) grid.push({ u: x0 - mx + ((x1 - x0 + 2 * mx) * i) / 6, v: y0 - my + ((y1 - y0 + 2 * my) * j) / 6 });
    this.A = {};
    this.M = {};
    for (const e of ['L', 'R']) {
      const l = this.layer(e);
      const pts = new Float64Array(grid.length * 3);
      grid.forEach((g, i) => {
        const q = this.plane2ground(g.u, g.v);
        pts.set([q.lat, q.lon, q.h], i * 3);
      });
      const xy = core.g2iBatch(l.modelId, pts);
      const pairs = grid.map((g, i) => ({ u: g.u, v: g.v, x: xy[2 * i], y: xy[2 * i + 1] })).filter((p) => Number.isFinite(p.x));
      this.A[e] = fitAffine(pairs); // display → image
      this.M[e] = invertAffine(this.A[e]); // image → display
    }
    // Right-eye y-correction over heights around h_ref: v′ = v − (c0 + c1·u + c2·v).
    const L = this.layer('L');
    const R = this.layer('R');
    const corr = [];
    for (let j = 0; j < 5; j++)
      for (let i = 0; i < 5; i++) {
        const u = x0 + ((x1 - x0) * i) / 4;
        const v = y0 + ((y1 - y0) * j) / 4;
        const pl = applyAffine(this.A.L, u, v);
        for (const dz of dzs) {
          const g = core.i2g(L.modelId, pl.x, pl.y, this.hRef + dz);
          const pr = core.g2i(R.modelId, g.lat, g.lon, this.hRef + dz);
          const dr = applyAffine(this.M.R, pr.x, pr.y);
          if (Number.isFinite(dr.y)) corr.push({ u: dr.x, v: dr.y, x: 0, y: dr.y - v });
        }
      }
    if (corr.length >= 6) {
      const c = fitAffine(corr); // only the y row matters: dy = c3 + c4·u + c5·v
      const C = [0, 1, 0, -c[3], -c[4], 1 - c[5]];
      this.M.R = compose(C, this.M.R);
      this.A.R = invertAffine(this.M.R);
      // Residual y-parallax of the fit (display px), for the status bar.
      let ss = 0;
      for (const q of corr) {
        const y = q.y - (c[3] + c[4] * q.u + c[5] * q.v);
        ss += y * y;
      }
      this.yFitRms = Math.sqrt(ss / corr.length);
    }
  }

  applyAligns() {
    for (const e of ['L', 'R']) {
      const l = this.layer(e);
      if (!l || !this.M) continue;
      const [sx, sy] = this.shift[e];
      l._stereoAlign = [this.M[e][0] + sx, this.M[e][1], this.M[e][2], this.M[e][3] + sy, this.M[e][4], this.M[e][5]];
    }
  }

  /** Display position (no eye shift) of a ground point in one eye. */
  eyeAt(e, g) {
    const p = this.app.core.g2i(this.layer(e).modelId, g.lat, g.lon, g.h);
    return applyAffine(this.M[e], p.x, p.y);
  }

  /** Ground point at height hh whose two eye positions average to display point d. */
  solveAt(d, hh) {
    let q = this.plane2ground(d.x, d.y, hh);
    for (let i = 0; i < 6; i++) {
      const l = this.eyeAt('L', q);
      const r = this.eyeAt('R', q);
      const m = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
      const pp = this.ground2plane(q.lat, q.lon);
      q = this.plane2ground(pp.x + (d.x - m.x), pp.y + (d.y - m.y), hh);
      if (Math.hypot(d.x - m.x, d.y - m.y) < 1e-4) break;
    }
    return q;
  }

  /** x- and y-parallax (display px, right − left) of a ground point. */
  parallax(g) {
    const l = this.eyeAt('L', g);
    const r = this.eyeAt('R', g);
    return { x: r.x - l.x, y: r.y - l.y };
  }

  /** Parallax gain: display px of x-parallax per metre of height at the cursor. */
  gain(g = this.cursor) {
    const a = this.parallax({ ...g, h: g.h + 1 });
    const b = this.parallax({ ...g, h: g.h - 1 });
    return Math.abs(a.x - b.x) / 2;
  }

  // ---- cursor ----
  setCursor(g, source = this.zSource) {
    this.cursor = { lat: g.lat, lon: g.lon, h: g.h };
    this.z = g.h;
    this.zSource = source;
    if (this.cursorMode === 'cursor') this.centreOnCursor();
    this.pane.invalidate();
    this.app.links?.propagate(this.pane);
  }

  setZ(z, source = 'manual') {
    if (!Number.isFinite(z)) return;
    const d = this.cursorDisplay();
    this.z = z;
    this.zSource = source;
    this.cursor = d ? this.solveAt(d, z) : { ...this.cursor, h: z };
    this.pane.invalidate();
  }

  cursorDisplay() {
    if (!this.cursor || !this.M) return null;
    const l = this.eyeAt('L', this.cursor);
    const r = this.eyeAt('R', this.cursor);
    return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  }

  mouseMoved(sx, sy) {
    if (!this.showCursor || this.cursorMode !== 'image' || !this.M) return;
    const d = this.pane.viewPoint(sx, sy);
    let q = this.solveAt(d, this.z);
    if (this.track) {
      for (let i = 0; i < 3; i++) {
        const t = this.app.terrain.sample(q.lat, q.lon);
        if (!t) break;
        q = this.solveAt(d, t.hae + this.zOffset);
      }
      this.z = q.h;
      this.zSource = 'terrain tracking';
    }
    this.cursor = q;
    this.pane.invalidate();
  }

  followCentre() {
    const d = { x: this.pane.view.cx, y: this.pane.view.cy };
    let q = this.solveAt(d, this.z);
    if (this.track) {
      const t = this.app.terrain.sample(q.lat, q.lon);
      if (t) q = this.solveAt(d, t.hae + this.zOffset);
      this.z = q.h;
    }
    this.cursor = q;
    // Fixed Cursor: both eyes put the cursor at the centre (zero parallax at the cursor Z).
    const l = this.eyeAt('L', q);
    const r = this.eyeAt('R', q);
    this.shift = { L: [d.x - l.x, d.y - l.y], R: [d.x - r.x, d.y - r.y] };
  }

  centreOnCursor() {
    const d = this.cursorDisplay();
    if (d) this.pane.setView({ cx: d.x, cy: d.y });
  }

  setCursorMode(m) {
    this.cursorMode = m;
    if (m === 'image') this.shift = { L: [0, 0], R: [0, 0] };
    else this.centreOnCursor();
    this.key = '';
    this.pane.invalidate();
  }

  /** Shift+wheel (REQ-STR-08): ¼ screen px of parallax per notch (Ctrl: 1/16), scaled to zoom. */
  wheelZ(e) {
    const notch = -Math.sign(e.deltaY);
    const frac = e.ctrlKey ? 1 / 16 : 1 / 4;
    this.stepZ(notch * frac);
  }

  stepZ(parallaxPx) {
    const g = this.gain();
    if (!(g > 0)) return;
    this.setZ(this.z + parallaxPx / (g * this.pane.view.zoom), 'manual');
  }

  keydown(e) {
    const k = e.key;
    if (k === 'PageUp' || k === 'PageDown') this.stepZ((k === 'PageUp' ? 1 : -1) * 2.5);
    else if (e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) this.stepZ((k === 'ArrowUp' ? 1 : -1) * 0.25);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  placeOnGround() {
    const c = this.cursor;
    const t = c && this.app.terrain.sample(c.lat, c.lon);
    if (!t) throw new Error('no terrain covers the cursor');
    this.setZ(t.hae + this.zOffset, 'DEM');
    return this.z;
  }

  /**
   * Snap to ground (REQ-STR-09): a 1-D correlator along the left-eye ray. The left template stays
   * at the cursor's left-image position; candidates step Z by ½ px of parallax over the DEM ± 3σ
   * (or ±64 px without a DEM); NCC picks the best, LSM refines the right position, and the two
   * rays are intersected. Accepts NCC ≥ 0.7.
   */
  async snapToGround({ tpl = 21 } = {}) {
    const app = this.app;
    const L = this.layer('L');
    const R = this.layer('R');
    const c = this.cursor;
    const pl = app.core.g2i(L.modelId, c.lat, c.lon, c.h);
    const g = this.gain() || 1;
    const t = app.terrain.sample(c.lat, c.lon);
    const zc = t ? t.hae : c.h;
    const range = t ? Math.max(3 * (Number.isFinite(t.sigmaV) ? t.sigmaV : 5), 64 / g) : 64 / g;
    const step = 0.5 / g;
    const zs = [];
    for (let z = zc - range; z <= zc + range; z += step) zs.push(z);
    const cand = zs.map((z) => {
      const q = app.core.i2g(L.modelId, pl.x, pl.y, z);
      return { z, p: app.core.g2i(R.modelId, q.lat, q.lon, z) };
    });
    const half = Math.floor(tpl / 2);
    const xs = cand.map((k) => k.p.x);
    const ys = cand.map((k) => k.p.y);
    const bx0 = Math.floor(Math.min(...xs)) - half - 3;
    const by0 = Math.floor(Math.min(...ys)) - half - 3;
    const bw = Math.ceil(Math.max(...xs)) + half + 4 - bx0;
    const bh = Math.ceil(Math.max(...ys)) + half + 4 - by0;
    const T = await app.pool.run('patch', { handle: L.handle, x: Math.round(pl.x) - half - 0.5, y: Math.round(pl.y) - half - 0.5, w: tpl, h: tpl, band: 0 }, { affinity: L.affinity, priority: 'interactive' });
    const S = await app.pool.run('patch', { handle: R.handle, x: bx0, y: by0, w: bw, h: bh, band: 0 }, { affinity: R.affinity, priority: 'interactive' });
    const tv = Array.from(T.px);
    const tm = tv.reduce((a, b) => a + b, 0) / tv.length;
    const td = tv.map((v) => v - tm);
    const tn = Math.sqrt(td.reduce((a, b) => a + b * b, 0)) || 1;
    // Template centre in left-image pixels and its offset from pl (sub-pixel).
    const tcx = T.x0 + T.w / 2;
    const tcy = T.y0 + T.h / 2;
    const sample = (x, y) => {
      const fx = x - 0.5 - S.x0;
      const fy = y - 0.5 - S.y0;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      if (i < 0 || j < 0 || i + 1 >= S.w || j + 1 >= S.h) return NaN;
      const ax = fx - i;
      const ay = fy - j;
      const v = (a, b) => S.px[b * S.w + a];
      return v(i, j) * (1 - ax) * (1 - ay) + v(i + 1, j) * ax * (1 - ay) + v(i, j + 1) * (1 - ax) * ay + v(i + 1, j + 1) * ax * ay;
    };
    let best = null;
    for (const k of cand) {
      const ox = k.p.x + (tcx - pl.x);
      const oy = k.p.y + (tcy - pl.y);
      const w = [];
      for (let y = 0; y < tpl; y++) for (let x = 0; x < tpl; x++) w.push(sample(ox - tpl / 2 + x + 0.5, oy - tpl / 2 + y + 0.5));
      if (w.some(Number.isNaN)) continue;
      const wm = w.reduce((a, b) => a + b, 0) / w.length;
      let num = 0;
      let den = 0;
      w.forEach((v, i) => {
        num += (v - wm) * td[i];
        den += (v - wm) ** 2;
      });
      const ncc = den > 0 ? num / (tn * Math.sqrt(den)) : 0;
      if (!best || ncc > best.ncc) best = { ...k, ncc };
    }
    if (!best || best.ncc < 0.7) {
      this.zSource = 'no correlation';
      this.pane.invalidate();
      return { ok: false, ncc: best?.ncc ?? 0 };
    }
    // LSM refinement of the right position around the best candidate.
    const r = 3;
    const sw = tpl + 2 * r;
    const S2 = await app.pool.run('patch', { handle: R.handle, x: Math.round(best.p.x + (tcx - pl.x)) - half - r - 0.5, y: Math.round(best.p.y + (tcy - pl.y)) - half - r - 0.5, w: sw, h: sw, band: 0 }, { affinity: R.affinity, priority: 'interactive' });
    const m = await app.pool.run('match', { tpl: T.px, tw: T.w, th: T.h, srch: S2.px, sw: S2.w, sh: S2.h, refine: true }, { kind: 'analysis', transfer: [S2.px.buffer] });
    let xr = best.p.x;
    let yr = best.p.y;
    if (m.ok === 1 && Number.isFinite(m.x)) {
      xr = S2.x0 + m.x - (tcx - pl.x);
      yr = S2.y0 + m.y - (tcy - pl.y);
    }
    const sig = app.prefs.get('pickSigmaPx') ?? 0.5;
    const x = app.core.intersect([
      { model: L.modelId, x: pl.x, y: pl.y, sigma: sig },
      { model: R.modelId, x: xr, y: yr, sigma: sig },
    ], { lat: c.lat, lon: c.lon, h: best.z });
    this.setCursor({ lat: x.lat, lon: x.lon, h: x.h }, 'correlated');
    return { ok: true, ncc: m.ok === 1 ? m.lsmScore : best.ncc, z: x.h, lsm: m.ok === 1 };
  }

  // ---- pane hooks ----
  imagePoint(sx, sy) {
    const d = this.pane.viewPoint(sx, sy);
    const [ax, ay] = this.shift.L;
    return this.A ? applyAffine(this.A.L, d.x - ax, d.y - ay) : d;
  }

  screenPoint(x, y) {
    const { w, h: hh } = this.pane.size();
    const d = this.M ? applyAffine(this.M.L, x, y) : { x, y };
    return forwardView(this.pane.view, w, hh, d.x + this.shift.L[0], d.y + this.shift.L[1]);
  }

  fitWhole() {
    const L = this.layer('L');
    const { w, h: hh } = this.pane.size();
    if (w < 2) return requestAnimationFrame(() => this.fitWhole());
    const ps = [
      [0, 0],
      [L.width, 0],
      [L.width, L.height],
      [0, L.height],
    ].map(([x, y]) => {
      const g = this.app.core.i2g(L.modelId, x, y, this.hRef);
      return this.ground2plane(g.lat, g.lon);
    });
    const x0 = Math.min(...ps.map((p) => p.x));
    const x1 = Math.max(...ps.map((p) => p.x));
    const y0 = Math.min(...ps.map((p) => p.y));
    const y1 = Math.max(...ps.map((p) => p.y));
    this.pane.setView({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, zoom: Math.min(w / (x1 - x0), hh / (y1 - y0)) * 0.96, rot: 0, mode: 'native' });
  }

  centreOnGround(lat, lon, hh) {
    const t = hh === undefined ? this.app.terrain?.sample?.(lat, lon) : null;
    const g = { lat, lon, h: hh ?? t?.hae ?? this.z };
    if (!this.M) {
      const p = this.ground2plane(lat, lon);
      this.pane.setView({ cx: p.x, cy: p.y });
      return p;
    }
    const l = this.eyeAt('L', g);
    const r = this.eyeAt('R', g);
    const d = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
    this.cursor = g;
    this.z = g.h;
    this.pane.setView({ cx: d.x, cy: d.y });
    return d;
  }

  /** Ground at the view centre (cursor Z), for linking (REQ-STR-10). */
  centreGround() {
    if (this.cursorMode === 'cursor' && this.cursor) return this.cursor;
    return this.solveAt({ x: this.pane.view.cx, y: this.pane.view.cy }, this.z);
  }

  groundScale() {
    return this.s / this.pane.view.zoom;
  }

  displayOpts() {
    return { mode: MODES.indexOf(this.mode), swap: this.swap, parity: this.parity, linear: this.linear, mirror: this.mirror };
  }

  /** Cursor glyph and stereo marks in one eye's target (before the composite, Research/07 §6.3). */
  drawEye(r, e, view, pw, ph) {
    const dpr = view.zoom / this.pane.view.zoom;
    const at = (g) => {
      const d = this.eyeAt(e, g);
      return forwardView(view, pw, ph, d.x + this.shift[e][0], d.y + this.shift[e][1]);
    };
    const segs = [];
    const col = this.app.prefs.get('stereoCursorColour') ?? [1, 0.84, 0, 1];
    for (const m of this.marks) {
      const pts = m.pts.map(at);
      for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y]);
      if (m.closed && pts.length > 2) segs.push([pts.at(-1).x, pts.at(-1).y, pts[0].x, pts[0].y]);
      for (const p of pts) segs.push([p.x - 3 * dpr, p.y, p.x + 3 * dpr, p.y], [p.x, p.y - 3 * dpr, p.x, p.y + 3 * dpr]);
    }
    if (segs.length) r.drawSegments(segs, [0, 0.9, 1, 1], 1.5 * dpr, pw, ph);
    // 3-D vector overlays drawn per eye (contours, REQ-DEM-11): layers styled {stereo: true}.
    this.drawOverlays(r, e, view, pw, ph, dpr);
    if (!this.showCursor || !this.cursor) return;
    const c = at(this.cursor);
    const a = 4 * dpr;
    const b = 11 * dpr;
    r.drawSegments([[c.x - b, c.y, c.x - a, c.y], [c.x + a, c.y, c.x + b, c.y], [c.x, c.y - b, c.x, c.y - a], [c.x, c.y + a, c.x, c.y + b]], col, 2 * dpr, pw, ph);
  }

  /** Eye display positions of stereo-flagged vector layers, cached per eye fit and store version. */
  drawOverlays(r, e, view, pw, ph, dpr) {
    const S = this.app.store;
    const vls = S.all('vlayer').filter((v) => v.visible !== false && v.style?.stereo);
    if (!vls.length) return;
    const ver = `${this.key}|${this.app._storeVersion ?? 0}`;
    if (this._ovKey !== ver) {
      this._ovKey = ver;
      this._ov = { L: [], R: [] };
      const ids = new Set(vls.map((v) => v.id));
      const feats = S.all('feature').filter((f) => ids.has(f.vlayer) && f.geom?.xyz?.length >= 6);
      for (const eye of ['L', 'R']) {
        const l = this.layer(eye);
        for (const f of feats) {
          const n = f.geom.xyz.length / 3;
          const pts = new Float64Array(n * 3);
          for (let k = 0; k < n; k++) pts.set([f.geom.xyz[3 * k + 1], f.geom.xyz[3 * k], f.geom.xyz[3 * k + 2]], k * 3);
          const xy = this.app.core.g2iBatch(l.modelId, pts);
          const d = new Float64Array(n * 2);
          for (let k = 0; k < n; k++) {
            const q = applyAffine(this.M[eye], xy[2 * k], xy[2 * k + 1]);
            d[2 * k] = q.x;
            d[2 * k + 1] = q.y;
          }
          const v = S.get(f.vlayer);
          this._ov[eye].push({ d, index: !!f.attrs?.INDEX, colour: (f.style?.stroke ?? v.style?.stroke ?? '#d8a040'), width: f.style?.width ?? v.style?.width ?? 1 });
        }
      }
    }
    const rgba = (hex) => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, 1];
    const [sx, sy] = this.shift[e];
    const groups = new Map();
    for (const o of this._ov[e]) {
      const key = `${o.colour}|${o.width}`;
      if (!groups.has(key)) groups.set(key, { colour: o.colour, width: o.width, segs: [] });
      const segs = groups.get(key).segs;
      let prev = null;
      for (let k = 0; k < o.d.length / 2; k++) {
        const s = forwardView(view, pw, ph, o.d[2 * k] + sx, o.d[2 * k + 1] + sy);
        if (prev && Number.isFinite(s.x) && Number.isFinite(prev.x)) segs.push([prev.x, prev.y, s.x, s.y]);
        prev = s;
      }
    }
    for (const gr of groups.values()) if (gr.segs.length) r.drawSegments(gr.segs, rgba(gr.colour), gr.width * dpr, pw, ph);
  }

  updateStatus() {
    const c = this.cursor;
    if (!c || !this.statusEl) return;
    const N = this.app.core.undulation(c.lat, c.lon);
    const p = this.parallax(c);
    this.statusEl.textContent = `Z ${c.h.toFixed(2)} m HAE${Number.isFinite(N) ? ` (${(c.h - N).toFixed(2)} m MSL)` : ''} · x-parallax ${p.x.toFixed(2)} px · y-parallax ${p.y.toFixed(2)} px · ${this.zSource}${this.track ? ' · tracking' : ''}`;
  }

  /** RMS y-parallax (display px) at points measured in both images [{a: [x, y], b: [x, y]}]. */
  yParallaxRms(pts) {
    let ss = 0;
    for (const q of pts) {
      const l = applyAffine(this.M.L, q.a[0], q.a[1]);
      const r = applyAffine(this.M.R, q.b[0], q.b[1]);
      ss += (r.y - l.y) ** 2;
    }
    return Math.sqrt(ss / pts.length);
  }
}

// ---- pair metrics (REQ-STR-01) ----
/** Sensor direction (ECEF unit vector from the ground towards the sensor) of an image at a point. */
function sensorDir(app, l, g) {
  const p = app.core.g2i(l.modelId, g.lat, g.lon, g.h);
  const a = app.core.i2g(l.modelId, p.x, p.y, g.h + 200);
  const b = app.core.i2g(l.modelId, p.x, p.y, g.h - 200);
  const ea = app.core.ecef(a.lat, a.lon, g.h + 200);
  const eb = app.core.ecef(b.lat, b.lon, g.h - 200);
  return norm([ea[0] - eb[0], ea[1] - eb[1], ea[2] - eb[2]]);
}

function enuBasis(lat, lon) {
  const f = lat * D2R;
  const l = lon * D2R;
  return { e: [-Math.sin(l), Math.cos(l), 0], n: [-Math.sin(f) * Math.cos(l), -Math.sin(f) * Math.sin(l), Math.cos(f)], u: [Math.cos(f) * Math.cos(l), Math.cos(f) * Math.sin(l), Math.sin(f)] };
}

const idatimMs = (s) => {
  const t = String(s ?? '').trim();
  if (!/^\d{14}$/.test(t)) return NaN;
  return Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14));
};

export function pairMetrics(app, L, R, { target = null, pick = 0.3, le90Target = app.prefs.get('stereoLe90Target') ?? 1 } = {}) {
  const g = target ?? L.groundWithTerrain(L.width / 2, L.height / 2);
  const B = enuBasis(g.lat, g.lon);
  const u1 = sensorDir(app, L, g);
  const u2 = sensorDir(app, R, g);
  const elev = (u) => Math.asin(dot(u, B.u)) / D2R;
  const azim = (u) => ((Math.atan2(dot(u, B.e), dot(u, B.n)) / D2R) + 360) % 360;
  const C = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2)))) / D2R;
  const bis = norm(u1.map((v, i) => v + u2[i]));
  const bie = Math.asin(dot(bis, B.u)) / D2R;
  const pn = norm(cross(u1, u2));
  const vp = norm(B.u.map((v, i) => v - dot(B.u, pn) * pn[i]));
  const asym = Math.acos(Math.max(-1, Math.min(1, dot(bis, vp)))) / D2R;
  const roll = Math.asin(Math.min(1, Math.abs(dot(B.u, pn)))) / D2R;
  // Effective B/H = GSD × parallax gain (Research/07 §3.4): gain from a ±1 m height step.
  const gsdOf = (l) => {
    const p = l.imageAt(g.lat, g.lon, g.h);
    const a = app.core.i2g(l.modelId, p.x, p.y, g.h);
    const b = app.core.i2g(l.modelId, p.x + 1, p.y, g.h);
    const c = app.core.i2g(l.modelId, p.x, p.y + 1, g.h);
    return 0.5 * (app.core.inverse(a.lat, a.lon, b.lat, b.lon).distance + app.core.inverse(a.lat, a.lon, c.lat, c.lon).distance);
  };
  const gsd = gsdOf(L);
  // Ground displacement per metre of height between the two looks, at the reference height.
  const disp = (l, dz) => {
    const p = l.imageAt(g.lat, g.lon, g.h + dz);
    return app.core.i2g(l.modelId, p.x, p.y, g.h);
  };
  const sepAt = (dz) => {
    const a = disp(L, dz);
    const b = disp(R, dz);
    return app.core.enu(b.lat, b.lon, g.h, a.lat, a.lon, g.h);
  };
  const s1 = sepAt(1);
  const s0 = sepAt(-1);
  const bhEff = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) / 2;
  const sunL = L.info.sun ?? app.sunFor(L, g);
  const sunR = R.info.sun ?? app.sunFor(R, g);
  const sunVec = (s) => (s ? [Math.cos(s.elevation * D2R) * Math.sin(s.azimuth * D2R), Math.cos(s.elevation * D2R) * Math.cos(s.azimuth * D2R), Math.sin(s.elevation * D2R)] : null);
  const sv1 = sunVec(sunL);
  const sv2 = sunVec(sunR);
  const sunDiff = sv1 && sv2 ? Math.acos(Math.max(-1, Math.min(1, dot(sv1, sv2)))) / D2R : NaN;
  // Overlap: share of the left footprint seen by the right image (21 × 21 samples).
  let inside = 0;
  let total = 0;
  for (let j = 0; j <= 20; j++)
    for (let i = 0; i <= 20; i++) {
      const q = L.groundAt((L.width * i) / 20, (L.height * j) / 20);
      if (!q) continue;
      total++;
      const p = R.imageAt(q.lat, q.lon, g.h);
      if (p && p.x >= 0 && p.y >= 0 && p.x <= R.width && p.y <= R.height) inside++;
    }
  const le90 = (1.6449 * Math.SQRT2 * pick * gsd) / Math.max(bhEff, 1e-6);
  const dt = Math.abs(idatimMs(R.info.datetime) - idatimMs(L.info.datetime)) / 1000;
  const warnings = [];
  if (C < 10) warnings.push(`convergence ${C.toFixed(1)}° is under 10°`);
  if (bie < 60) warnings.push(`BIE ${bie.toFixed(1)}° is under 60°`);
  if (le90 > le90Target) warnings.push(`predicted LE90 ${le90.toFixed(2)} m exceeds the ${le90Target} m target`);
  const grade = (v, good, fair) => (good(v) ? 'good' : fair(v) ? 'fair' : 'poor');
  return {
    images: [L.info.iid, R.info.iid],
    convergenceDeg: C,
    bieDeg: bie,
    asymmetryDeg: asym,
    asymmetryDefinition: 'ISD/2008: angle between the bisector and the local vertical projected onto the convergence plane',
    rollDeg: roll,
    bOverHEffective: bhEff,
    bOverHGeometric: 2 * Math.tan((C * D2R) / 2),
    offNadirDeg: [90 - elev(u1), 90 - elev(u2)],
    sensorAzimuthDeg: [azim(u1), azim(u2)],
    deltaTimeS: Number.isFinite(dt) ? dt : null,
    sunDifferenceDeg: sunDiff,
    overlap: total ? inside / total : 0,
    gsd,
    predictedLe90: le90,
    grades: { convergence: grade(C, (v) => v >= 30 && v <= 60, (v) => v >= 10 && v <= 70), bie: grade(bie, (v) => v >= 60, (v) => v >= 45), asymmetry: grade(asym, (v) => v < 20, (v) => v < 30), le90: grade(le90, (v) => v <= le90Target, (v) => v <= 2 * le90Target) },
    warnings,
  };
}

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const st = () => pane()?.stereo ?? null;
  const toast = (m, o) => app.toast(m, o);
  const modelLayers = (p) => (p?.layers() ?? []).filter((l) => l.kind !== 'dem' && l.modelId && l.modelInfo?.is3d);

  function openStereo(L, R, p = pane()) {
    if (!L || !R || L === R) throw new Error('stereo needs two different images with 3-D sensor models in this panel');
    p.stereo?.dispose();
    p.stereo = new StereoView(app, p, L, R);
    for (const l of p.layers()) if (l !== L && l !== R && l.rec?.visible !== false && l.kind === 'image') app.store.transact('Hide for stereo', (tx) => tx.set(l.id, 'visible', false), { kind: 'edit' });
    p.label.textContent = `Stereo: ${L.info.iid} | ${R.info.iid}`;
    p.stereo.fitWhole();
    app.emit('state');
    return p.stereo;
  }
  function closeStereo(p = pane()) {
    if (!p?.stereo) return;
    p.stereo.dispose();
    p.stereo = null;
    p.label.textContent = '';
    p.fitWhole();
    app.emit('state');
  }
  app.store.on('change', () => (app._storeVersion = (app._storeVersion ?? 0) + 1));
  app.stereo = { open: openStereo, close: closeStereo, metrics: (L, R, o) => pairMetrics(app, L, R, o), view: st };

  const need = () => {
    const s = st();
    if (!s) throw new Error('open a stereo panel first (Stereo ▸ Stereo Panel)');
    return s;
  };
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  };

  C.implement('stereo.open', { enabled: () => modelLayers(pane()).length >= 2, checked: () => !!st(), run: run(() => (st() ? closeStereo() : openStereo(...modelLayers(pane()).slice(0, 2)))) });
  for (const m of MODES.filter((x) => x !== 'dual')) C.implement(`stereo.mode.${m}`, { enabled: () => !!st(), checked: () => st()?.mode === m, run: () => {
    const s = need();
    s.mode = m;
    app.prefs.set('stereo', { ...(app.prefs.get('stereo') ?? {}), mode: m });
    if (m === 'spanned') document.documentElement.requestFullscreen?.().catch(() => {});
    pane().invalidate();
  } });
  C.implement('stereo.swap', { enabled: () => !!st(), checked: () => !!st()?.swap, run: () => {
    need().swap = !st().swap;
    pane().invalidate();
  } });
  C.implement('stereo.parity', { enabled: () => st()?.mode === 'interleaved', run: () => {
    need().parity = 1 - st().parity;
    pane().invalidate();
  } });
  C.implement('stereo.cursor', { enabled: () => !!st(), checked: () => !!st()?.showCursor, run: () => {
    need().showCursor = !st().showCursor;
    pane().invalidate();
  } });
  C.implement('stereo.fixedcursor', { enabled: () => !!st(), checked: () => st()?.cursorMode === 'cursor', run: () => need().setCursorMode(st().cursorMode === 'cursor' ? 'image' : 'cursor') });
  C.implement('stereo.place', { enabled: () => !!st() && app.terrain.available, run: run(() => need().placeOnGround()) });
  C.implement('stereo.snap', { enabled: () => !!st(), run: run(async () => {
    const r = await need().snapToGround();
    toast(r.ok ? `Snapped: Z ${r.z.toFixed(2)} m HAE (correlation ${r.ncc.toFixed(2)})` : `No correlation (best ${r.ncc.toFixed(2)}); Z kept`, { kind: r.ok ? 'info' : 'warn' });
  }) });
  C.implement('stereo.track', { enabled: () => !!st() && app.terrain.available, checked: () => !!st()?.track, run: () => {
    need().track = !st().track;
    pane().invalidate();
  } });
  /**
   * Epipolar-resampled pair as two GeoTIFFs (REQ-STR-16): both eyes resampled (bilinear) onto the
   * display plane over the view, the right eye with its y-correction, so a ground point sits on
   * the same row in both. Georeferenced by five GCPs on the plane at h_ref (exact: the plane is
   * affine in latitude and longitude); the description holds the output → source image affine.
   */
  async function exportEpipolar({ p = pane(), maxSize = 4096, box = null } = {}) {
    const s = p?.stereo;
    if (!s) throw new Error('open a stereo panel first');
    let [x0, y0, x1, y1] = box ?? [];
    if (!box) {
      const { w: pw, h: ph } = p.size();
      const cs = [[0, 0], [pw, 0], [0, ph], [pw, ph]].map(([x, y]) => invertView(p.view, pw, ph, x, y));
      [x0, x1] = [Math.min(...cs.map((c) => c.x)), Math.max(...cs.map((c) => c.x))];
      [y0, y1] = [Math.min(...cs.map((c) => c.y)), Math.max(...cs.map((c) => c.y))];
    }
    s.fitBounds(x0, y0, x1, y1);
    s.key = ''; // the display refits for its own view next frame
    const step = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / maxSize));
    const W = Math.ceil((x1 - x0) / step);
    const H = Math.ceil((y1 - y0) / step);
    const out = {};
    for (const e of ['L', 'R']) {
      const l = s.layer(e);
      const A = e === 'L' ? s.A.L : invertAffine(s.M.R);
      // Output pixel (i, j) → source image point (corner-origin pixel coordinates).
      const Ao = [A[0] + A[1] * x0 + A[2] * y0, A[1] * step, A[2] * step, A[3] + A[4] * x0 + A[5] * y0, A[4] * step, A[5] * step];
      const corners = [[0, 0], [W, 0], [0, H], [W, H]].map(([i, j]) => applyAffine(Ao, i, j));
      const sx0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))) - 2);
      const sy0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))) - 2);
      const sx1 = Math.min(l.width, Math.ceil(Math.max(...corners.map((c) => c.x))) + 2);
      const sy1 = Math.min(l.height, Math.ceil(Math.max(...corners.map((c) => c.y))) + 2);
      if (sx1 <= sx0 || sy1 <= sy0) throw new Error(`the view is outside image ${e === 'L' ? 'left' : 'right'}`);
      const bands = (l.chain?.bands ?? [0]).slice(0, 3);
      const r = await app.pool.run('window', { handle: l.handle, x0: sx0, y0: sy0, w: sx1 - sx0, h: sy1 - sy0, step: 1, bands }, { affinity: l.affinity, label: `epipolar ${e}`, timeout: 300000 });
      const type = ['u8', 'u16', 'i16', 'f32'].includes(l.sampleType) ? l.sampleType : 'f32';
      const Arr = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array }[type];
      const nb = bands.length;
      const data = new Arr(W * H * nb);
      const nodata = type === 'f32' ? NaN : 0;
      for (let j = 0; j < H; j++)
        for (let i = 0; i < W; i++) {
          const q = applyAffine(Ao, i + 0.5, j + 0.5);
          const fx = q.x - 0.5 - sx0;
          const fy = q.y - 0.5 - sy0;
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const k = (j * W + i) * nb;
          if (ix < 0 || iy < 0 || ix + 1 >= r.w || iy + 1 >= r.h) {
            for (let b = 0; b < nb; b++) data[k + b] = nodata;
            continue;
          }
          const ax = fx - ix;
          const ay = fy - iy;
          for (let b = 0; b < nb; b++) {
            const pl = r.planes[b];
            const o = iy * r.w + ix;
            const v = pl[o] * (1 - ax) * (1 - ay) + pl[o + 1] * ax * (1 - ay) + pl[o + r.w] * (1 - ax) * ay + pl[o + r.w + 1] * ax * ay;
            data[k + b] = type === 'f32' ? v : Math.round(v);
          }
        }
      const gcps = [[0, 0], [W, 0], [0, H], [W, H], [W / 2, H / 2]].map(([i, j]) => {
        const g = s.plane2ground(x0 + i * step, y0 + j * step);
        return { x: i, y: j, lon: g.lon, lat: g.lat, h: s.hRef };
      });
      const description = JSON.stringify({ epipolar: e === 'L' ? 'left' : 'right', source: l.info.iid ?? l.rec?.name, outputToImage: Ao, hRef: s.hRef, metresPerPixel: s.s * step, note: 'image (x, y) = A·(i, j, 1), corner-origin pixels; the GCPs are on the display plane at hRef (HAE)' });
      const bytes = await writeGeoTiff({ width: W, height: H, bands: nb, type, data }, { epsg: 4326, gcps, nodata: type === 'f32' ? NaN : null, photometric: nb === 3 ? 'rgb' : 'minisblack', description, overviews: true });
      out[e] = { bytes, outputToImage: Ao, name: `${String(l.info.iid ?? l.rec?.name ?? e).replace(/[^\w.-]+/g, '_')}_epi_${e}.tif` };
    }
    return { left: out.L, right: out.R, width: W, height: H, step, box: [x0, y0, x1, y1], hRef: s.hRef };
  }
  app.stereo.exportEpipolar = exportEpipolar;
  C.implement('stereo.epipolar', {
    enabled: () => !!st(),
    run: run(async () => {
      const r = await exportEpipolar();
      for (const e of [r.left, r.right]) await saveBlob(app, new Blob([e.bytes], { type: 'image/tiff' }), { name: e.name, types: ['.tif'], description: 'Epipolar GeoTIFF' });
      toast(`Epipolar pair: ${r.width} × ${r.height} px at ${r.step} display px per pixel`);
    }),
  });
  C.implement('stereo.ypar', { enabled: () => !!st(), run: () => toast(`Residual y-parallax of the epipolar fit over the view: ${need().yFitRms?.toFixed(3) ?? '—'} px RMS`) });

  // ---- Stereo Align (REQ-SNS-10): tie points on the pair, the right image adjusted, left fixed ----
  C.implement('stereo.align', { enabled: () => !!st() && !!app.tri, run: run(async () => {
    const s = need();
    const L = s.layer('L');
    const R = s.layer('R');
    const before = app.tri.points().length;
    // A denser grid and NCC 0.65 (LSM and the back-match still guard): multi-date pairs (TE-038).
    const ties = await app.tri.autoTiePoints({ layers: [L, R], grid: 8, minNcc: 0.65 });
    if (ties.points < 6) throw new Error(`Stereo Align found only ${ties.points} tie points`);
    const rep = await app.tri.solve({ layers: [L, R], fixed: [L.id], kind: 'affine' });
    const label = app.tri.applySolution(rep);
    s.key = '';
    pane().invalidate();
    toast(`Stereo Align: ${ties.points} tie points, σ₀ ${rep.sigma0.toFixed(2)}; ${R.info.iid} adjusted (${label}); ${app.tri.points().length - before} points added`);
  }) });

  // ---- Pair metrics and the Model Manager (REQ-STR-01/02) ----
  const metricsTable = (rows, onOpen) => {
    const cls = (gr) => ({ good: 'ok', fair: 'warn', poor: 'bad' })[gr] ?? '';
    const t = h('table', { class: 'grid-table', 'data-id': 'stereo:pairs' }, h('thead', {}, h('tr', {}, ['Images', 'Convergence', 'BIE', 'Asymmetry (ISD)', 'Roll', 'B/H eff.', 'Off-nadir', 'Δt', 'Sun Δ', 'Overlap', 'LE90 @0.3 px', ''].map((x) => h('th', { title: x.startsWith('Asym') ? 'Angle between the bisector and the local vertical projected onto the convergence plane (ISD/2008)' : x.startsWith('B/H') ? 'GSD × parallax gain; the geometric 2·tan(C/2) is in the tooltip of each value' : '' }, x)))));
    const tb = h('tbody');
    for (const r of rows) {
      const m = r.m;
      const open = h('button', { class: 'btn btn-small' }, 'Open');
      open.addEventListener('click', () => onOpen(r));
      tb.appendChild(
        h(
          'tr',
          { title: m.warnings.join('; ') },
          h('td', {}, m.images.join(' + ')),
          h('td', { class: cls(m.grades.convergence) }, `${m.convergenceDeg.toFixed(1)}°`),
          h('td', { class: cls(m.grades.bie) }, `${m.bieDeg.toFixed(1)}°`),
          h('td', { class: cls(m.grades.asymmetry) }, `${m.asymmetryDeg.toFixed(1)}°`),
          h('td', {}, `${m.rollDeg.toFixed(1)}°`),
          h('td', { title: `geometric 2·tan(C/2) = ${m.bOverHGeometric.toFixed(3)}` }, m.bOverHEffective.toFixed(3)),
          h('td', {}, m.offNadirDeg.map((v) => `${v.toFixed(1)}°`).join(' / ')),
          h('td', {}, m.deltaTimeS === null ? '—' : `${m.deltaTimeS.toFixed(0)} s`),
          h('td', {}, Number.isFinite(m.sunDifferenceDeg) ? `${m.sunDifferenceDeg.toFixed(1)}°` : '—'),
          h('td', {}, `${(m.overlap * 100).toFixed(0)} %`),
          h('td', { class: cls(m.grades.le90) }, `${m.predictedLe90.toFixed(2)} m`),
          h('td', {}, onOpen ? open : ''),
        ),
      );
    }
    t.appendChild(tb);
    return t;
  };
  const loadedPairs = () => {
    const ls = modelLayers(pane());
    const rows = [];
    for (let i = 0; i < ls.length; i++) for (let k = i + 1; k < ls.length; k++) rows.push({ L: ls[i], R: ls[k], m: pairMetrics(app, ls[i], ls[k]) });
    return rows;
  };
  C.implement('stereo.metrics', { enabled: () => modelLayers(pane()).length >= 2, run: run(async () => {
    const s = st();
    const [L, R] = s ? [s.layer('L'), s.layer('R')] : modelLayers(pane());
    const m = pairMetrics(app, L, R);
    await modal({ title: 'Pair Metrics', body: h('div', {}, metricsTable([{ L, R, m }], null), m.warnings.length ? h('p', { class: 'warn' }, `Warnings: ${m.warnings.join('; ')}`) : h('p', { class: 'hint' }, 'No warnings.'), h('p', { class: 'hint' }, 'Colours: green inside the usual measurement range (convergence 30–60°, BIE ≥ 60°, asymmetry < 20°), amber marginal, red poor (Research/07 §3.2).')), buttons: ['Close'], width: 900, id: 'stereo-metrics' });
  }) });
  C.implement('stereo.manager', { enabled: () => modelLayers(pane()).length >= 2, run: run(async () => {
    const rows = loadedPairs();
    await modal({ title: 'Stereo Model Manager', body: h('div', {}, metricsTable(rows, (r) => openStereo(r.L, r.R)), h('p', { class: 'hint' }, 'Pairs among the images of the active panel. Next Stereo Model steps through them.')), buttons: ['Close'], width: 960, id: 'stereo-manager' });
  }) });
  let nextIdx = 0;
  C.implement('stereo.next', { enabled: () => modelLayers(pane()).length >= 2, run: run(() => {
    const rows = loadedPairs().sort((a, b) => Math.abs(a.m.convergenceDeg - 30) - Math.abs(b.m.convergenceDeg - 30));
    const r = rows[nextIdx++ % rows.length];
    openStereo(r.L, r.R);
    toast(`Stereo model ${r.m.images.join(' + ')}: convergence ${r.m.convergenceDeg.toFixed(1)}°`);
  }) });
  // Pair Finder over a folder's metadata: RPC footprints and times, without opening the pixels.
  C.implement('stereo.finder', { run: run(async () => {
    const files = await pickFiles(app, { multiple: true, accept: ['.ntf', '.nitf', '.ntf.r0', '.tif', '.tiff'], description: 'Images to search for stereo pairs' });
    if (!files?.length) return;
    const { describe } = await import('../formats/open.js');
    const cands = [];
    for (const f of files) {
      try {
        const d = await describe(app, f, []);
        for (const r of d.rasters) {
          const rpc = r.info.subheader?.rpc;
          if (!rpc) continue;
          const id = app.core.rpcModel([...rpc.slice(0, 92), ...(r.info.subheader?.ichipb ?? [0, 1, 0, 0, 0, 1])]);
          const info = app.core.modelInfo(id);
          const fake = { modelId: id, modelInfo: info, width: r.raster.width, height: r.raster.height, info: r.info, imageAt: (lat, lon, hh) => app.core.g2i(id, lat, lon, hh), groundAt: (x, y) => ({ ...app.core.i2g(id, x, y, rpc[6]), h: rpc[6] }), groundWithTerrain: (x, y) => ({ ...app.core.i2g(id, x, y, rpc[6]), h: rpc[6] }) };
          cands.push({ file: f, fake });
        }
      } catch {
        /* not an image with an RPC: skipped */
      }
    }
    const rows = [];
    for (let i = 0; i < cands.length; i++)
      for (let k = i + 1; k < cands.length; k++) {
        const m = pairMetrics(app, cands[i].fake, cands[k].fake);
        if (m.overlap > 0.1 && m.convergenceDeg >= 10 && m.convergenceDeg <= 60) rows.push({ L: cands[i], R: cands[k], m });
      }
    for (const c of cands) app.core.freeModel(c.fake.modelId);
    await modal({ title: 'Stereo Pair Finder', body: h('div', {}, rows.length ? metricsTable(rows, null) : h('p', { class: 'muted' }, 'No pairs with more than 10 % overlap and 10–60° convergence.'), h('p', { class: 'hint' }, `${cands.length} image(s) with RPC00B read from their headers. Open both files of a pair, then Stereo ▸ Stereo Panel.`)), buttons: ['Close'], width: 960, id: 'stereo-finder' });
  }) });

  // ---- stereo mensuration (REQ-MEN-12) ----
  const pickSigma = () => app.prefs.get('pickSigmaPx') ?? 0.5;
  /** Absolute error of a stereo point (model + pick), and the pick-only vertical σ for relative heights. */
  function pointError(s, g) {
    const L = s.layer('L');
    const R = s.layer('R');
    const pl = app.core.g2i(L.modelId, g.lat, g.lon, g.h);
    const pr = app.core.g2i(R.modelId, g.lat, g.lon, g.h);
    const sig = pickSigma();
    const abs = app.core.intersect([
      { model: L.modelId, x: pl.x, y: pl.y, sigma: app.core.observationSigma(L.modelId, pl.x, pl.y, g.h, sig) },
      { model: R.modelId, x: pr.x, y: pr.y, sigma: app.core.observationSigma(R.modelId, pr.x, pr.y, g.h, sig) },
    ], g);
    const rel = app.core.intersect([
      { model: L.modelId, x: pl.x, y: pl.y, sigma: sig },
      { model: R.modelId, x: pr.x, y: pr.y, sigma: sig },
    ], g);
    return { abs, sz: Math.sqrt(rel.covEnu[8]), sh: Math.sqrt((rel.covEnu[0] + rel.covEnu[4]) / 2), images: [pl, pr] };
  }
  function row(s, type, g, extra) {
    const L = s.layer('L');
    const R = s.layer('R');
    const m = pairMetrics(app, L, R, { target: g });
    return app.measureApi.baseRow(type, L, { ...g, heightSource: `stereo (${s.zSource})` }, {
      method: `Stereo (${L.info.iid} + ${R.info.iid})`,
      model: `${L.modelName} + ${R.modelName}`,
      extra: { pair: { convergenceDeg: m.convergenceDeg, bieDeg: m.bieDeg, bOverH: m.bOverHEffective }, zSource: s.zSource, images: [L.info.iid, R.info.iid] },
      ...extra,
    });
  }
  function logStereo(kind, pts) {
    const s = need();
    const p = pane();
    const e = pts.map((g) => pointError(s, g));
    const core = app.core;
    const N = (g) => core.undulation(g.lat, g.lon);
    let r;
    if (kind === 'point') {
      const g = pts[0];
      const mg = core.mgrs(g.lat, g.lon, 5);
      r = row(s, 'Stereo point', g, { value: mg, units: 'MGRS', coords: { lat: g.lat, lon: g.lon, hae: g.h, msl: Number.isFinite(N(g)) ? g.h - N(g) : null, geoid: core.geoidName ?? 'EGM96', mgrs: mg, datum: 'WGS 84' }, ce90: e[0].abs.ce90, le90: e[0].abs.le90, tag: 'absolute', geom: [[g.lon, g.lat, g.h]] });
    } else if (kind === 'height') {
      const [a, b] = pts;
      const dh = b.h - a.h;
      const le = 1.6449 * Math.hypot(e[0].sz, e[1].sz);
      r = row(s, 'Stereo height', a, { value: Number(dh.toFixed(2)), units: 'm', tag: 'relative', le90: le, ce90: null, sigmaText: `LE90 ${le.toFixed(2)} m relative (pick σ ${pickSigma()} px per image; the shared model bias cancels)`, geom: [[a.lon, a.lat, a.h], [b.lon, b.lat, b.h]] });
    } else if (kind === 'distance' || kind === 'slope') {
      const [a, b] = pts;
      const inv = core.inverse(a.lat, a.lon, b.lat, b.lon);
      const ea = core.ecef(a.lat, a.lon, a.h);
      const eb = core.ecef(b.lat, b.lon, b.h);
      const slant = Math.hypot(ea[0] - eb[0], ea[1] - eb[1], ea[2] - eb[2]);
      const slope = (Math.atan2(b.h - a.h, inv.distance) * 180) / Math.PI;
      const ce = 2.1460 * Math.hypot(e[0].sh, e[1].sh) / Math.SQRT2;
      const le = 1.6449 * Math.hypot(e[0].sz, e[1].sz);
      r = kind === 'distance'
        ? row(s, 'Stereo distance', a, { value: Number(slant.toFixed(2)), units: 'm', tag: 'relative', ce90: ce, le90: le, sigmaText: `ground ${inv.distance.toFixed(2)} m, Δh ${(b.h - a.h).toFixed(2)} m, slope ${slope.toFixed(2)}°, azimuth ${(((inv.azi1 % 360) + 360) % 360).toFixed(2)}°`, geom: [[a.lon, a.lat, a.h], [b.lon, b.lat, b.h]] })
        : row(s, 'Stereo slope', a, { value: Number(slope.toFixed(2)), units: '°', tag: 'relative', ce90: ce, le90: le, sigmaText: `over ${inv.distance.toFixed(2)} m ground, Δh ${(b.h - a.h).toFixed(2)} m`, geom: [[a.lon, a.lat, a.h], [b.lon, b.lat, b.h]] });
    } else if (kind === 'polyline' || kind === 'polygon') {
      const closed = kind === 'polygon';
      const ring = closed ? [...pts, pts[0]] : pts;
      let l2 = 0;
      let l3 = 0;
      let maxSlope = 0;
      for (let i = 1; i < ring.length; i++) {
        const d = core.inverse(ring[i - 1].lat, ring[i - 1].lon, ring[i].lat, ring[i].lon).distance;
        const dz = ring[i].h - ring[i - 1].h;
        l2 += d;
        l3 += Math.hypot(d, dz);
        if (d > 0) maxSlope = Math.max(maxSlope, (Math.atan2(Math.abs(dz), d) * 180) / Math.PI);
      }
      const area = closed ? core.polygonArea(pts.map((q) => [q.lat, q.lon])).area : null;
      r = row(s, closed ? 'Stereo polygon' : 'Stereo polyline', pts[0], { value: Number((closed ? area : l3).toFixed(2)), units: closed ? 'm²' : 'm', tag: 'relative', ce90: null, le90: null, sigmaText: `${closed ? 'perimeter' : 'length'} 2-D ${l2.toFixed(2)} m, 3-D ${l3.toFixed(2)} m; maximum slope ${maxSlope.toFixed(1)}°; Z per vertex (LE90 ≈ ${(1.6449 * e[0].sz).toFixed(2)} m)`, geom: pts.map((q) => [q.lon, q.lat, q.h]) });
    } else if (kind === 'volume') {
      r = volumeRow(s, pts);
    }
    app.measureApi.logRow(r, p);
    return r;
  }
  /** Volume (cut/fill) inside a polygon: base = plane through the vertices, top = the terrain/DSM. */
  function volumeRow(s, pts) {
    const core = app.core;
    if (!app.terrain.available) throw new Error('Volume needs a DSM or DEM covering the polygon');
    const o = pts[0];
    const enu = pts.map((q) => core.enu(q.lat, q.lon, q.h, o.lat, o.lon, o.h));
    // Plane z = a + b·e + c·n through the vertices (least squares).
    const pl = fitAffine(enu.map(([e, n, u]) => ({ u: e, v: n, x: u, y: 0 })));
    const xs = enu.map((p) => p[0]);
    const ys = enu.map((p) => p[1]);
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = enu.length - 1; i < enu.length; j = i++) if (enu[i][1] > y !== enu[j][1] > y && x < ((enu[j][0] - enu[i][0]) * (y - enu[i][1])) / (enu[j][1] - enu[i][1]) + enu[i][0]) c = !c;
      return c;
    };
    const cell = Math.max(0.5, Math.sqrt(((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))) / 40000));
    let cut = 0;
    let fill = 0;
    let n = 0;
    const o0 = { lat: o.lat, lon: o.lon };
    const dlat = 1e-4 / core.inverse(o.lat, o.lon, o.lat + 1e-4, o.lon).distance;
    const dlon = 1e-4 / core.inverse(o.lat, o.lon, o.lat, o.lon + 1e-4).distance;
    for (let y = Math.min(...ys) + cell / 2; y < Math.max(...ys); y += cell)
      for (let x = Math.min(...xs) + cell / 2; x < Math.max(...xs); x += cell) {
        if (!inside(x, y)) continue;
        const lat = o0.lat + y * dlat;
        const lon = o0.lon + x * dlon;
        const t = app.terrain.sample(lat, lon);
        if (!t) continue;
        const base = o.h + pl[0] + pl[1] * x + pl[2] * y;
        const d = t.hae - base;
        if (d > 0) cut += d * cell * cell;
        else fill -= d * cell * cell;
        n++;
      }
    return row(s, 'Stereo volume', o, { value: Number((cut - fill).toFixed(1)), units: 'm³', tag: 'relative', ce90: null, le90: null, sigmaText: `above the base plane ${cut.toFixed(1)} m³, below ${fill.toFixed(1)} m³; ${n} cells of ${cell.toFixed(2)} m; top from ${app.terrain.sample(o.lat, o.lon)?.name ?? 'terrain'}`, extra: { cut, fill, cellM: cell, base: 'plane through the vertices' }, geom: pts.map((q) => [q.lon, q.lat, q.h]) });
  }
  app.stereo.log = logStereo;

  const MEAS = { point: 1, height: 2, distance: 2, slope: 2, polyline: Infinity, polygon: Infinity, volume: Infinity };
  for (const [kind, n] of Object.entries(MEAS)) {
    const id = `stereo.m${kind}`;
    app.tools.register({
      id,
      cue: `Stereo ${kind}: set the floating cursor on each point (Shift+wheel for Z, or Snap to Ground) and click.${n === Infinity ? ' Enter or a double-click finishes.' : ''}`,
      onDown(p) {
        const s = p.stereo;
        if (!s?.cursor) {
          toast('Stereo measurements need a stereo panel', { kind: 'warn' });
          return true;
        }
        const mark = (this.state.mark ??= { pts: [], closed: kind === 'polygon' || kind === 'volume' });
        if (!s.marks.includes(mark)) s.marks.push(mark);
        mark.pts.push({ ...s.cursor });
        if (mark.pts.length >= n) this.finish(p);
        p.invalidate();
        return true;
      },
      onDblClick(p) {
        this.finish(p);
        return true;
      },
      onEnter(p) {
        this.finish(p);
      },
      finish(p) {
        const mark = this.state.mark;
        this.state = {};
        if (!mark) return;
        const s = p.stereo;
        const min = kind === 'polygon' || kind === 'volume' ? 3 : kind === 'polyline' ? 2 : n;
        if (mark.pts.length >= min) {
          try {
            logStereo(kind, mark.pts);
          } catch (e) {
            toast(e.message, { kind: 'error' });
          }
        }
        if (s) s.marks = s.marks.filter((m) => m !== mark);
        app.tools.done();
        p.invalidate();
      },
    });
    C.implement(id, { enabled: () => !!st(), checked: () => app.tools.current?.id === id, run: () => app.tools.select(id) });
  }
}
