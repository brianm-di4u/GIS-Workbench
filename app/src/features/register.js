// Registration and GCP models (REQ-SNS-09, REQ-SNS-05): Glove Align (drag the active layer over
// the reference), Quick Align (two point pairs, similarity), Auto Align (normalised cross-
// correlation tie points on a grid, robust affine fit) and Polynomial Registration (order 1–3
// with an RMS report); GCP Model builds affine, polynomial or projective models from ground
// control points. A registration stores the layer's display affine (layer pixel → panel
// reference pixel) and gives the layer a corrected model so its geolocation agrees with the
// reference: RPCs keep their 3-D model with the correction folded into the ICHIPB affine.
//
// Auto Align assumes the two images share a nominal pixel grid (two dates of one scene, or
// orthos); use Quick Align or GCPs for images of different geometry.

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { applyAffine, invertAffine } from '../render/renderer.js';

export const name = 'register';

const ID = [0, 1, 0, 0, 0, 1];

/** Least-squares 2-D transform from pairs [{s: {x, y}, t: {x, y}}]: 'shift' | 'similarity' | 'affine'. */
export function fitTransform(pairs, kind = 'affine') {
  const n = pairs.length;
  if (!n) throw new Error('no tie points');
  if (kind === 'shift' || n < 2) {
    const dx = pairs.reduce((s, p) => s + p.t.x - p.s.x, 0) / n;
    const dy = pairs.reduce((s, p) => s + p.t.y - p.s.y, 0) / n;
    return [dx, 1, 0, dy, 0, 1];
  }
  if (kind === 'similarity' || n < 3) {
    // t = [a −b; b a]·s + [c; d]
    const mx = pairs.reduce((s, p) => s + p.s.x, 0) / n;
    const my = pairs.reduce((s, p) => s + p.s.y, 0) / n;
    const ux = pairs.reduce((s, p) => s + p.t.x, 0) / n;
    const uy = pairs.reduce((s, p) => s + p.t.y, 0) / n;
    let sxx = 0;
    let sab = 0;
    let sba = 0;
    for (const p of pairs) {
      const x = p.s.x - mx;
      const y = p.s.y - my;
      const X = p.t.x - ux;
      const Y = p.t.y - uy;
      sxx += x * x + y * y;
      sab += x * X + y * Y;
      sba += x * Y - y * X;
    }
    const a = sab / sxx;
    const b = sba / sxx;
    return [ux - a * mx + b * my, a, -b, uy - b * mx - a * my, b, a];
  }
  // Affine: normal equations for [c, a, b] per axis.
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bx = [0, 0, 0];
  const by = [0, 0, 0];
  for (const p of pairs) {
    const r = [1, p.s.x, p.s.y];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) M[i][j] += r[i] * r[j];
      bx[i] += r[i] * p.t.x;
      by[i] += r[i] * p.t.y;
    }
  }
  const solve3 = (A, b) => {
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(A);
    if (Math.abs(D) < 1e-12) throw new Error('the tie points are collinear');
    return [0, 1, 2].map((k) => det(A.map((r, i) => r.map((v, j) => (j === k ? b[i] : v)))) / D);
  };
  const [c, a, b] = solve3(M, bx);
  const [d, e, f] = solve3(M, by);
  return [c, a, b, d, e, f];
}

export const residuals = (pairs, A) => pairs.map((p) => {
  const q = applyAffine(A, p.s.x, p.s.y);
  return Math.hypot(q.x - p.t.x, q.y - p.t.y);
});

const rms = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0) / Math.max(1, v.length));

/**
 * Robust fit: consensus over candidate fits from point triples (repetitive scenes give false
 * matches), then refit on the inliers within `tol` px (0.5) and trim at 3 × MAD (at least 0.5 px).
 * Returns {A, used, rejected, rms}.
 */
export function robustFit(pairs, kind, tol = 0.5) {
  let best = null;
  const n = pairs.length;
  const tries = [];
  for (let i = 0; i < n && tries.length < 400; i++) for (let j = i + 1; j < n && tries.length < 400; j++) for (let k = j + 1; k < n && tries.length < 400; k += Math.max(1, Math.floor(n / 7))) tries.push([i, j, k]);
  for (const t of tries.length ? tries : [[...pairs.keys()]]) {
    let A;
    try {
      A = fitTransform(t.map((q) => pairs[q]), kind === 'affine' && t.length >= 3 ? 'affine' : kind);
    } catch {
      continue;
    }
    const inl = residuals(pairs, A).filter((r) => r <= tol).length;
    if (!best || inl > best.inl) best = { A, inl };
  }
  let used = best ? pairs.filter((_, i) => residuals(pairs, best.A)[i] <= tol) : pairs.slice();
  if (used.length < 3) used = pairs.slice();
  let A = fitTransform(used, kind);
  for (let it = 0; it < 4 && used.length > 4; it++) {
    const r = residuals(used, A);
    const med = [...r].sort((a, b) => a - b)[Math.floor(r.length / 2)];
    const lim = Math.max(0.5, 3 * 1.4826 * med);
    const keep = used.filter((_, i) => r[i] <= lim);
    if (keep.length === used.length || keep.length < 3) break;
    used = keep;
    A = fitTransform(used, kind);
  }
  return { A, used, rejected: pairs.length - used.length, rms: rms(residuals(used, A)) };
}

/** High-pass (value − 3×3 mean): sharp correlation peaks on smooth, low-texture scenes. */
export function highPass(v, w, h) {
  const out = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += v[(y + dy) * w + x + dx];
      out[y * w + x] = v[y * w + x] - s / 9;
    }
  return out;
}

/** Normalised cross-correlation search of patch `p` (P×P) over `w` (W×W); {dx, dy, score}. */
export function nccSearch(p, P, w, W) {
  const R = (W - P) / 2;
  let mp = 0;
  for (const v of p) mp += v;
  mp /= p.length;
  let sp = 0;
  for (const v of p) sp += (v - mp) ** 2;
  if (sp <= 1e-9) return null;
  const score = new Float64Array((2 * R + 1) ** 2);
  let best = { s: -2, i: 0, j: 0 };
  for (let j = 0; j <= 2 * R; j++)
    for (let i = 0; i <= 2 * R; i++) {
      let mw = 0;
      for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) mw += w[(j + y) * W + i + x];
      mw /= P * P;
      let num = 0;
      let sw = 0;
      for (let y = 0; y < P; y++)
        for (let x = 0; x < P; x++) {
          const a = p[y * P + x] - mp;
          const b = w[(j + y) * W + i + x] - mw;
          num += a * b;
          sw += b * b;
        }
      const s = sw > 1e-9 ? num / Math.sqrt(sp * sw) : -1;
      score[j * (2 * R + 1) + i] = s;
      if (s > best.s) best = { s, i, j };
    }
  const at = (i, j) => score[j * (2 * R + 1) + i];
  const sub = (a, b, c) => (a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0);
  const fx = best.i > 0 && best.i < 2 * R ? sub(at(best.i - 1, best.j), best.s, at(best.i + 1, best.j)) : 0;
  const fy = best.j > 0 && best.j < 2 * R ? sub(at(best.i, best.j - 1), best.s, at(best.i, best.j + 1)) : 0;
  return { dx: best.i - R + fx, dy: best.j - R + fy, score: best.s, edge: best.i === 0 || best.j === 0 || best.i === 2 * R || best.j === 2 * R };
}

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const images = (p) => (p?.visibleLayers() ?? []).filter((l) => l.kind !== 'dem');
  /** The reference (bottom visible image) and the layer to register (the active one). */
  const pair = (p = pane()) => {
    const ls = images(p);
    const master = ls[0];
    const a = p?.activeLayer();
    const slave = a && a !== master && a.kind !== 'dem' ? a : ls.at(-1);
    if (!master || !slave || master === slave) throw new Error('registration needs two images in the panel: the reference (bottom) and the active layer to align');
    return { master, slave };
  };
  const hasPair = () => {
    try {
      pair();
      return true;
    } catch {
      return false;
    }
  };

  /** RPC record (92) and chip affine of a layer whose active model is an RPC. */
  const rpcRec = (l) => {
    if (!/^RPC/.test(l.modelName)) return null;
    const rec = l.info.subheader?.rpc?.slice(0, 92) ?? l.info.meta?.rpc?.slice(0, 92);
    if (!rec) return null;
    const base = l.rec?.registration?.chip ?? l.info.subheader?.ichipb;
    return { rec, chip: base && base.some((v) => v !== 0) ? base : ID };
  };
  const compose = (A, B) => [A[0] + A[1] * B[0] + A[2] * B[3], A[1] * B[1] + A[2] * B[4], A[1] * B[2] + A[2] * B[5], A[3] + A[4] * B[0] + A[5] * B[3], A[4] * B[1] + A[5] * B[4], A[4] * B[2] + A[5] * B[5]];

  /** Add (or replace) a model on a layer and make it active. */
  function activate(l, name, id) {
    l.models = (l.models ?? []).filter((m) => m.name !== name);
    const info = app.core.modelInfo(id);
    l.models.push({ name, id, info });
    l.modelId = id;
    l.modelName = name;
    l.modelInfo = info;
  }

  /** Rebuild a registered model from its stored description (project reload, undo). */
  app.registrationModel = (l, reg) => {
    try {
      if (reg.kind === 'rpc') {
        const r = l.info.subheader?.rpc?.slice(0, 92) ?? l.info.meta?.rpc?.slice(0, 92);
        if (!r) return null;
        const id = app.core.rpcModel([...r, ...reg.chip]);
        activate(l, reg.name, id);
        return id;
      }
      if (reg.kind === 'gcp') {
        const id = app.core.gcpModel(reg.gcps, reg.order, reg.name);
        activate(l, reg.name, id);
        return id;
      }
    } catch (e) {
      app.toast(`${l.rec?.name}: registered model not restored (${e.message})`, { kind: 'warn' });
    }
    return null;
  };

  /**
   * Apply a registration: store the display affine and give the slave a model that agrees with
   * the master at aligned pixels. order > 1 adds a polynomial GCP model from `pairs`.
   */
  function apply(master, slave, A, { method, rmsPx = null, pairs = [], order = 1 } = {}) {
    const W = slave.width;
    const H = slave.height;
    const toMaster = invertAffine(master.align ?? ID); // reference pixel → master pixel
    const grid = [];
    for (let j = 0; j <= 6; j++)
      for (let i = 0; i <= 6; i++) {
        const p = { x: (W * i) / 6, y: (H * j) / 6 };
        const r = applyAffine(A, p.x, p.y);
        const q = applyAffine(toMaster, r.x, r.y);
        const g = master.modelId ? master.groundWithTerrain(q.x, q.y) : null;
        if (g) grid.push({ p, g });
      }
    let reg = null;
    const rr = rpcRec(slave);
    if (grid.length >= 6 && order === 1 && rr && slave.modelId) {
      // Fold the correction into the RPC: C maps registered pixels to the old model's pixels.
      const cp = grid.map(({ p, g }) => ({ s: p, t: slave.imageAt(g.lat, g.lon, g.h) })).filter((x) => x.t);
      const Cc = fitTransform(cp, 'affine');
      reg = { kind: 'rpc', name: 'RPC00B (registered)', chip: compose(rr.chip, Cc), method, at: new Date().toISOString() };
    } else if (grid.length >= 6) {
      const gcps = (order > 1 && pairs.length >= [0, 3, 6, 10][order] ? pairs.map((pp) => {
              const q = applyAffine(toMaster, pp.t.x, pp.t.y);
              return { p: pp.s, g: master.groundWithTerrain(q.x, q.y) };
            }) : grid).filter((x) => x.g).map(({ p, g }) => ({ x: p.x, y: p.y, lat: g.lat, lon: g.lon }));
      reg = { kind: 'gcp', name: `Registered (polynomial ${order})`, order, gcps, method, at: new Date().toISOString() };
    }
    slave._alignPreview = null;
    app.store.transact(`Register ${slave.rec.name}`, (tx) => {
      tx.set(slave.id, 'align', A);
      if (reg) tx.set(slave.id, 'registration', reg);
    });
    if (reg) app.registrationModel(slave, reg);
    const msg = `${slave.rec.name} registered to ${master.rec.name} (${method})${rmsPx !== null ? `: RMS ${rmsPx.toFixed(2)} px` : ''}${reg ? `; model ${reg.name}` : ''}`;
    app.toast(msg);
    app.renderer.invalidate();
    for (const mp of app.desktop.multiports) for (const p of mp.panes) p.invalidate();
    app.emit('state');
    return { A, reg, rmsPx };
  }
  // Undo, redo and project reload: keep each layer's model in step with its stored registration.
  app.store.on('change', () => {
    for (const l of app.layers.values()) {
      const sig = JSON.stringify(l.rec?.registration ?? null);
      if (l._regSig === undefined) l._regSig = JSON.stringify(null);
      if (sig === l._regSig) continue;
      l._regSig = sig;
      if (l.rec?.registration) app.registrationModel(l, l.rec.registration);
      else {
        const orig = (l.models ?? []).find((m) => !m.error && !/registered|^GCP \(/i.test(m.name));
        if (orig) {
          l.modelId = orig.id;
          l.modelName = orig.name;
          l.modelInfo = orig.info;
        }
      }
    }
  });
  app.applyRegistration = (A, opts) => {
    const { master, slave } = pair();
    return apply(master, slave, A, opts);
  };

  // ---- Glove Align: drag the active layer over the reference ----
  app.tools.register({
    id: 'align.glove',
    cue: 'Glove Align: drag the active layer over the reference until features line up; Enter applies, Esc cancels.',
    start() {
      try {
        const { slave } = pair();
        this.state = { slave, A0: slave.align ?? ID };
      } catch (e) {
        app.toast(e.message, { kind: 'warn' });
      }
    },
    end() {
      if (this.state?.slave && !this.state.applied) {
        this.state.slave._alignPreview = null;
        app.renderer.invalidate();
      }
    },
    onDown(p, e, sx, sy) {
      if (!this.state.slave) return false;
      this.state.from = p.imagePoint(sx, sy);
      this.state.base = this.state.slave._alignPreview ?? this.state.A0;
      return true;
    },
    onMove(p, e, sx, sy) {
      const st = this.state;
      if (!st.from || !(e.buttons & 1)) return;
      const q = p.imagePoint(sx, sy);
      const [a0, a1, a2, a3, a4, a5] = st.base;
      st.slave._alignPreview = [a0 + q.x - st.from.x, a1, a2, a3 + q.y - st.from.y, a4, a5];
      app.renderer.invalidate();
      p.invalidate();
    },
    onUp() {
      this.state.from = null;
    },
    onEnter() {
      const st = this.state;
      if (!st.slave?._alignPreview) return app.tools.done();
      const { master } = pair();
      st.applied = true;
      apply(master, st.slave, st.slave._alignPreview, { method: 'Glove Align' });
      app.tools.done();
    },
  });
  C.implement('align.glove', { enabled: hasPair, checked: () => app.tools.current?.id === 'align.glove', run: () => app.tools.select('align.glove') });

  // ---- Quick Align: two pairs (feature in the active layer → same feature in the reference) ----
  app.tools.register({
    id: 'align.quick',
    cue: 'Quick Align: click a feature as the active layer shows it, then where the reference shows it; repeat for a second feature.',
    start() {
      this.state = { pts: [] };
    },
    onDown(p, e, sx, sy) {
      const st = this.state;
      st.pts.push(p.imagePoint(sx, sy));
      if (st.pts.length === 4) {
        try {
          const { master, slave } = pair();
          const inv = invertAffine(slave.align ?? ID);
          const prs = [0, 2].map((k) => ({ s: applyAffine(inv, st.pts[k].x, st.pts[k].y), t: st.pts[k + 1] }));
          const A = fitTransform(prs, 'similarity');
          apply(master, slave, A, { method: 'Quick Align (2-point similarity)', rmsPx: Math.max(...residuals(prs, A)) });
        } catch (er) {
          app.toast(er.message, { kind: 'warn' });
        }
        app.tools.done();
      }
      p.invalidate();
      return true;
    },
    draw(p, g, w, hh, st) {
      g.save();
      (st.pts ?? []).forEach((q, i) => {
        const s = p.screenPoint(q.x, q.y);
        g.strokeStyle = i % 2 ? '#00ff40' : '#ff4040';
        g.lineWidth = 2;
        g.strokeRect(s.x - 5, s.y - 5, 10, 10);
        g.fillStyle = '#fff';
        g.font = '11px Arial, sans-serif';
        g.fillText(`${i % 2 ? 'to' : 'from'} ${Math.floor(i / 2) + 1}`, s.x + 8, s.y - 6);
      });
      g.restore();
    },
  });
  C.implement('align.quick', { enabled: hasPair, checked: () => app.tools.current?.id === 'align.quick', run: () => app.tools.select('align.quick') });

  // ---- Auto Align: NCC tie points on a grid ----
  /** Tie points between the active layer and the reference: [{s (slave px), t (ref px), score}]. */
  async function tiePoints({ n = 8, P = 41, R = 12, minScore = 0.5 } = {}) {
    const { master, slave } = pair();
    const A = slave.align ?? ID;
    const inv = invertAffine(A);
    const W = P + 2 * R;
    const band = (l) => l.chain.bands[0] ?? 0;
    const read = (l, cx, cy, size) => app.pool.run('pixels', { handle: l.handle, x: Math.round(cx - size / 2), y: Math.round(cy - size / 2), w: size, h: size, bands: [band(l)] }, { affinity: l.affinity, label: 'align: read patch' });
    const out = [];
    const margin = W;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const t = { x: margin + ((master.width - 2 * margin) * (i + 0.5)) / n, y: margin + ((master.height - 2 * margin) * (j + 0.5)) / n };
        const s = applyAffine(inv, t.x, t.y);
        const tm = applyAffine(invertAffine(master.align ?? ID), t.x, t.y);
        if (s.x < P || s.y < P || s.x > slave.width - P || s.y > slave.height - P) continue;
        const [pw, ww] = await Promise.all([read(slave, s.x, s.y, P), read(master, tm.x, tm.y, W)]);
        if (pw.w !== P || ww.w !== W) continue;
        const m = nccSearch(highPass(pw.values[0], P, P), P, highPass(ww.values[0], W, W), W);
        if (!m || m.edge || m.score < minScore) continue;
        // The slave patch centre (at the window's rounded origin) sits at the match in the reference.
        const sx = pw.x0 + P / 2;
        const sy = pw.y0 + P / 2;
        const sp = { x: sx, y: sy };
        const mm = { x: ww.x0 + R + m.dx + P / 2, y: ww.y0 + R + m.dy + P / 2 }; // master pixel
        const tp = applyAffine(master.align ?? ID, mm.x, mm.y); // reference pixel
        out.push({ s: sp, t: tp, score: m.score });
      }
    return { master, slave, pairs: out };
  }
  app.tiePoints = tiePoints;

  async function autoAlign({ kind = 'affine', ...o } = {}) {
    const { master, slave, pairs } = await tiePoints(o);
    if (pairs.length < 3) throw new Error(`only ${pairs.length} tie point(s) matched; Auto Align needs 3 (try Quick Align)`);
    const fit = robustFit(pairs, kind);
    const res = apply(master, slave, fit.A, { method: `Auto Align (${fit.used.length} tie points, ${fit.rejected} rejected, ${kind})`, rmsPx: fit.rms, pairs: fit.used });
    app.store.transact('Tie points', (tx) => tx.set(slave.id, 'tiepoints', fit.used.map((p) => ({ s: p.s, t: p.t, score: p.score }))));
    return { ...res, used: fit.used.length, rejected: fit.rejected };
  }
  app.autoAlign = autoAlign;
  C.implement('align.auto', {
    enabled: hasPair,
    run: async () => {
      try {
        await autoAlign();
      } catch (e) {
        app.toast(`Auto Align: ${e.message}`, { kind: 'warn' });
      }
    },
  });

  // ---- Auto Align (AI): DISK keypoints matched by LightGlue (REQ-LAI-05) ----
  /**
   * Learned tie points: one coarse window over the overlap (decimated to `size` px) gives a first
   * affine; then `fine` windows of `fineSize` px at full resolution, placed with it, give the
   * precise points. Works across dates, sensors and moderate rotation/scale, unlike the NCC grid.
   */
  async function aiTiePoints({ size = 768, fine = 4, fineSize = 512, minScore = 0.5 } = {}) {
    const { master, slave } = pair();
    const L = app.aiLocal;
    if (!L) throw new Error('the local AI tools are not part of this build');
    const toRef = (l, x, y) => applyAffine(l.align ?? ID, x, y); // layer pixel → reference pixel
    const box = (l) => {
      const c = [[0, 0], [l.width, 0], [0, l.height], [l.width, l.height]].map(([x, y]) => toRef(l, x, y));
      return [Math.min(...c.map((q) => q.x)), Math.min(...c.map((q) => q.y)), Math.max(...c.map((q) => q.x)), Math.max(...c.map((q) => q.y))];
    };
    const a = box(master);
    const b = box(slave);
    const ov = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    if (ov[2] - ov[0] < 64 || ov[3] - ov[1] < 64) throw new Error('the two images do not overlap');
    const crop = (win, w, hh) => {
      if (win.w === w && win.h === hh) return win;
      const rgb = new Uint8Array(3 * w * hh);
      for (let y = 0; y < hh; y++) rgb.set(win.rgb.subarray(3 * y * win.w, 3 * (y * win.w + w)), 3 * y * w);
      return { ...win, rgb, w, h: hh };
    };
    /** Pairs from windows centred on reference pixel (cx, cy); A maps slave pixels to reference pixels. */
    const pairsAt = async (cx, cy, side, step, A) => {
      const m = applyAffine(invertAffine(master.align ?? ID), cx, cy);
      const s = applyAffine(invertAffine(A), cx, cy);
      const half = (side * step) / 2;
      const wa = await L.rgbRegion(master, m.x - half, m.y - half, side * step, side * step, step);
      const wb = await L.rgbRegion(slave, s.x - half, s.y - half, side * step, side * step, step);
      // DISK's U-Net halves the image four times: sides are cut to multiples of 16.
      const w = Math.floor(Math.min(wa.w, wb.w) / 16) * 16;
      const hh = Math.floor(Math.min(wa.h, wb.h) / 16) * 16;
      if (w < 64 || hh < 64) return [];
      const r = await L.match(crop(wa, w, hh), crop(wb, w, hh));
      return r.pairs.filter((p) => p.score >= minScore).map((p) => ({ s: { x: wb.x0 + p.b.x * step, y: wb.y0 + p.b.y * step }, t: toRef(master, wa.x0 + p.a.x * step, wa.y0 + p.a.y * step), score: p.score }));
    };
    const ow = ov[2] - ov[0];
    const oh = ov[3] - ov[1];
    const cstep = Math.max(1, Math.ceil(Math.max(ow, oh) / size));
    const coarse = await pairsAt((ov[0] + ov[2]) / 2, (ov[1] + ov[3]) / 2, size, cstep, slave.align ?? ID);
    if (coarse.length < 3) throw new Error(`only ${coarse.length} learned match(es) between the images; try Quick Align`);
    const A0 = robustFit(coarse, 'affine', Math.max(1, cstep)).A;
    let pairs = [];
    if (fine > 0 && cstep > 1) {
      const k = Math.ceil(Math.sqrt(fine));
      for (let j = 0; j < k; j++)
        for (let i = 0; i < k && pairs.length < 4000; i++) {
          if (j * k + i >= fine) break;
          pairs.push(...(await pairsAt(ov[0] + (ow * (i + 0.5)) / k, ov[1] + (oh * (j + 0.5)) / k, Math.min(fineSize, Math.floor(Math.min(ow, oh) / k)), 1, A0)));
        }
    }
    if (pairs.length < 8) pairs = pairs.concat(coarse);
    return { master, slave, pairs, coarse: coarse.length, step: cstep };
  }
  app.aiTiePoints = aiTiePoints;

  async function autoAlignAI({ kind = 'affine', ...o } = {}) {
    const { master, slave, pairs } = await aiTiePoints(o);
    if (pairs.length < 3) throw new Error(`only ${pairs.length} tie point(s) matched; Auto Align (AI) needs 3`);
    const fit = robustFit(pairs.length > 600 ? pairs.filter((_, i) => i % Math.ceil(pairs.length / 600) === 0) : pairs, kind, 1);
    const res = apply(master, slave, fit.A, { method: `Auto Align (AI: DISK + LightGlue, ${fit.used.length} tie points, ${fit.rejected} rejected, ${kind})`, rmsPx: fit.rms, pairs: fit.used });
    app.store.transact('Tie points', (tx) => tx.set(slave.id, 'tiepoints', fit.used.slice(0, 200).map((p) => ({ s: p.s, t: p.t, score: p.score }))));
    return { ...res, used: fit.used.length, rejected: fit.rejected, rms: fit.rms };
  }
  app.autoAlignAI = autoAlignAI;
  C.implement('align.ai', {
    enabled: hasPair,
    run: async () => {
      try {
        app.toast('Auto Align (AI): matching learned keypoints…');
        const r = await autoAlignAI();
        app.toast(`Auto Align (AI): ${r.used} tie points, RMS ${r.rms.toFixed(2)} px.`);
      } catch (e) {
        app.toast(`Auto Align (AI): ${e.message}`, { kind: 'warn', ms: 9000 });
      }
    },
  });

  // ---- Polynomial Registration with an RMS report ----
  C.implement('align.poly', {
    enabled: hasPair,
    run: async () => {
      let ctx;
      try {
        ctx = pair();
      } catch (e) {
        return app.toast(e.message, { kind: 'warn' });
      }
      let pairs = (ctx.slave.rec.tiepoints ?? []).map((p) => ({ ...p }));
      const order = h('select', { class: 'inp', 'aria-label': 'Order' }, h('option', { value: '1' }, '1 (affine)'), h('option', { value: '2' }, '2'), h('option', { value: '3' }, '3'));
      const table = h('div', { class: 'grid-wrap', style: { maxHeight: '40vh', overflow: 'auto' }, tabindex: '0', role: 'region', 'aria-label': 'Tie points' });
      const summary = h('p', { class: 'hint', 'aria-live': 'polite' });
      const find = h('button', { class: 'btn' }, 'Find tie points');
      const render = () => {
        clear(table);
        const ord = Number(order.value);
        const need = [0, 3, 6, 10][ord];
        let r = [];
        if (pairs.length >= need) {
          const A = fitTransform(pairs, 'affine');
          r = residuals(pairs, A);
        }
        table.appendChild(
          h(
            'table',
            { class: 'grid-table', 'aria-label': 'Tie point residuals' },
            h('thead', {}, h('tr', {}, ['#', 'Active x', 'Active y', 'Reference x', 'Reference y', 'Score', 'Residual (px)', ''].map((x) => h('th', { scope: 'col' }, x)))),
            h(
              'tbody',
              {},
              ...pairs.map((p, i) => {
                const del = h('button', { class: 'btn btn-small', 'aria-label': `Delete tie point ${i + 1}` }, 'Delete');
                del.addEventListener('click', () => {
                  pairs.splice(i, 1);
                  render();
                });
                return h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, p.s.x.toFixed(2)), h('td', {}, p.s.y.toFixed(2)), h('td', {}, p.t.x.toFixed(2)), h('td', {}, p.t.y.toFixed(2)), h('td', {}, p.score?.toFixed(3) ?? '–'), h('td', {}, r[i]?.toFixed(3) ?? '–'), h('td', {}, del));
              }),
            ),
          ),
        );
        summary.textContent = pairs.length >= need ? `${pairs.length} tie points; affine RMS ${rms(r).toFixed(3)} px. Order ${ord} needs at least ${need}.` : `${pairs.length} tie points; order ${ord} needs at least ${need}.`;
      };
      find.addEventListener('click', async () => {
        summary.textContent = 'Matching…';
        try {
          pairs = (await tiePoints({ n: 8 })).pairs;
        } catch (e) {
          summary.textContent = e.message;
        }
        render();
      });
      order.addEventListener('change', render);
      render();
      const res = await modal({ title: 'Polynomial Registration', body: h('div', {}, h('div', {}, find), field('Order', order), table, summary), buttons: ['Apply', 'Cancel'], width: 720, id: 'align-poly' });
      if (res !== 'Apply') return;
      const ord = Number(order.value);
      if (pairs.length < [0, 3, 6, 10][ord]) return app.toast(`order ${ord} needs at least ${[0, 3, 6, 10][ord]} tie points`, { kind: 'warn' });
      const fit = robustFit(pairs, 'affine');
      apply(ctx.master, ctx.slave, fit.A, { method: `Polynomial registration (order ${ord}, ${fit.used.length} points)`, rmsPx: fit.rms, pairs: fit.used, order: ord });
    },
  });

  // ---- GCP Model (REQ-SNS-05) ----
  /** Fit a GCP model for a layer: kind 1–3 polynomial, 4 projective; {id, rmsM, residualsM}. */
  app.gcpModelFor = (l, gcps, kind = 1) => {
    const need = { 1: 3, 2: 6, 3: 10, 4: 4 }[kind];
    if (gcps.length < need) throw new Error(`${kind === 4 ? 'a projective' : `an order-${kind}`} model needs at least ${need} GCPs`);
    const name = kind === 4 ? 'GCP (projective)' : `GCP (polynomial ${kind})`;
    const id = app.core.gcpModel(gcps, kind, name);
    const res = gcps.map((g) => {
      const q = app.core.i2g(id, g.x, g.y, g.h ?? 0);
      return app.core.inverse(q.lat, q.lon, g.lat, g.lon).distance;
    });
    activate(l, name, id);
    app.store.transact('GCP model', (tx) => tx.set(l.id, 'registration', { kind: 'gcp', name, order: kind, gcps: gcps.map(({ x, y, lat, lon }) => ({ x, y, lat, lon })), method: 'GCP Model', at: new Date().toISOString() }));
    app.emit('state');
    return { id, name, rmsM: rms(res), residualsM: res };
  };

  app.tools.register({
    id: 'model.gcp.pick',
    cue: 'GCP Model: click the image point of a ground control point.',
    onDown(p, e, sx, sy) {
      const q = p.imagePoint(sx, sy);
      this.state.resolve?.(q);
      app.tools.done();
      return true;
    },
  });
  C.implement('model.gcp', {
    enabled: () => !!app.activeLayer(),
    run: async () => {
      const l = app.activeLayer();
      let gcps = (l.rec?.registration?.kind === 'gcp' ? l.rec.registration.gcps : []).map((g) => ({ ...g }));
      const kind = h('select', { class: 'inp', 'aria-label': 'Model' }, h('option', { value: '1' }, 'Affine (order 1)'), h('option', { value: '2' }, 'Polynomial order 2'), h('option', { value: '3' }, 'Polynomial order 3'), h('option', { value: '4' }, 'Projective'));
      const x = h('input', { class: 'inp', type: 'number', step: 'any', 'aria-label': 'Image x' });
      const y = h('input', { class: 'inp', type: 'number', step: 'any', 'aria-label': 'Image y' });
      const coord = h('input', { class: 'inp', placeholder: 'any format: MGRS, DD, DMS, UTM…', 'aria-label': 'Ground coordinate' });
      const hgt = h('input', { class: 'inp', type: 'number', step: 'any', value: '0', 'aria-label': 'Height (m HAE)' });
      const list = h('ul', { class: 'small' });
      const note = h('p', { class: 'hint', 'aria-live': 'polite' });
      const render = () => {
        clear(list);
        gcps.forEach((g, i) => list.appendChild(h('li', {}, `${i + 1}: (${g.x.toFixed(1)}, ${g.y.toFixed(1)}) → ${g.lat.toFixed(7)}, ${g.lon.toFixed(7)}`)));
      };
      const add = h('button', { class: 'btn' }, 'Add GCP');
      add.addEventListener('click', () => {
        try {
          const r = app.core.parse(coord.value);
          gcps.push({ x: Number(x.value), y: Number(y.value), lat: r.lat, lon: r.lon, h: Number(hgt.value) || 0 });
          note.textContent = `Added: ${app.core.format(r.lat, r.lon, 0, 7)} (${r.format})`;
          render();
        } catch (e) {
          note.textContent = e.message;
        }
      });
      render();
      const body = h('div', {}, field('Model', kind), field('Image x', x), field('Image y', y), field('Ground', coord), field('Height (m HAE)', hgt), h('div', {}, add), list, note, h('p', { class: 'hint' }, 'Image coordinates: the first pixel centre is (0.5, 0.5). Ground: WGS 84.'));
      if ((await modal({ title: 'GCP Model', body, buttons: ['Fit', 'Cancel'], width: 560, id: 'model-gcp' })) !== 'Fit') return;
      try {
        const r = app.gcpModelFor(l, gcps, Number(kind.value));
        await modal({ title: 'GCP Model', body: h('div', {}, h('p', {}, `${r.name}: RMS ${r.rmsM.toFixed(3)} m over ${gcps.length} GCPs.`), h('ul', { class: 'small' }, ...r.residualsM.map((v, i) => h('li', {}, `GCP ${i + 1}: ${v.toFixed(3)} m`)))), buttons: ['Close'], id: 'model-gcp-report' });
      } catch (e) {
        app.toast(e.message, { kind: 'warn' });
      }
    },
  });
}
