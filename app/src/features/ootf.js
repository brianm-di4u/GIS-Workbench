// Ortho On-the-Fly and virtual mosaics (REQ-IMG-18): the panel shows its RPC images rectified
// through their sensor models and the terrain into one map projection (UTM at the view), at the
// display's ground resolution, over twice the view. As you pan or zoom past that region the
// rectification runs again (Rust ortho engine in workers) and the product swaps in place, with
// the ground centre and scale kept. Several images make a virtual mosaic (nadir seams, balanced).
// The rectified layer is transient: turning the mode off removes it and shows the sources again.

import { openImageFile } from '../formats/open.js';
import { removeLayer } from './panels.js';
import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';

export const name = 'ootf';

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const core = app.core;

  const sources = (p) => p.layers().filter((l) => l.kind !== 'dem' && !l.rec?.ootf && l.modelId && app.ortho?.rpcRecordOf(l));
  const centreGround = (p) => {
    const l = p.geoLayer();
    const { w, h } = p.size();
    const q = p.imagePoint(w / 2, h / 2);
    return l?.groundAt(q.x, q.y) ?? null;
  };

  /** Rectify the region around the view for `p.ootf`. */
  async function refresh(p, { force = false } = {}) {
    const s = p.ootf;
    if (!s || s.busy) return null;
    const g = centreGround(p);
    const mpp = p.groundScale();
    if (!g || !Number.isFinite(mpp)) return null;
    const { w, h } = p.size();
    if (!force && s.region) {
      const u = core.utm(g.lat, g.lon, s.region.zone);
      const fx = (u.easting - s.region.e0) / (s.region.w * s.region.res);
      const fy = (s.region.n0 - u.northing) / (s.region.h * s.region.res);
      const ratio = mpp / s.region.res;
      if (fx > 0.25 && fx < 0.75 && fy > 0.25 && fy < 0.75 && ratio > 0.6 && ratio < 1.8) return null;
    }
    s.busy = true;
    try {
      const src = s.sources.map((id) => app.layers.get(id)).filter(Boolean);
      const gsd = Math.min(...src.map((l) => app.ortho.gsdOf(l)));
      const res = Math.max(gsd, Math.round(mpp * 100) / 100);
      // Projection (REQ-IMG-18): the UTM zone at the view, or a fixed zone (a mosaic across a zone
      // boundary stays in one projection).
      const fixed = s.projection?.zone ? s.projection : null;
      const z0 = fixed ? core.utm(g.lat, g.lon, fixed.zone) : core.utm(g.lat, g.lon);
      const z = fixed ? { ...z0, zone: fixed.zone, north: fixed.north ?? z0.north } : z0;
      const W = Math.min(2048, Math.ceil((w * mpp * s.factor) / res));
      const H = Math.min(2048, Math.ceil((h * mpp * s.factor) / res));
      const e0 = Math.round((z.easting - (W * res) / 2) / res) * res;
      const n0 = Math.round((z.northing + (H * res) / 2) / res) * res;
      const grid = { zone: z.zone, north: z.north, e0, n0, res, w: W, h: H };
      const t0 = performance.now();
      const o = src.length > 1 ? await app.ortho.mosaic(src, { grid }) : await app.ortho.orthorectify(src[0], { grid });
      const ms = performance.now() - t0;
      if (!p.ootf) return null; // turned off meanwhile
      const label = src.length > 1 ? `Virtual mosaic (${src.length} images)` : `Ortho On-the-Fly — ${src[0].info.iid}`;
      const bytes = await app.ortho.cogOf(o, { description: `GIS Workbench ${label} (transient)` });
      const { layers } = await openImageFile(app, new File([bytes], `${label}.tif`, { type: 'image/tiff' }), { pane: p });
      const L = layers[0];
      const old = s.layerId;
      S.transact('Ortho On-the-Fly', (tx) => {
        tx.set(L.id, 'ootf', true);
        tx.set(L.id, 'name', label);
        for (const l of src) if (p.rec.layers.includes(l.id)) tx.set(l.id, 'visible', false);
        tx.set(p.id, 'activeLayer', L.id);
      }, { kind: 'load' });
      if (old && app.layers.has(old)) removeLayer(app, p, old);
      s.layerId = L.id;
      s.region = grid;
      s.gen++;
      s.lastMs = ms;
      // Same ground centre and scale, north up (a map product).
      const q = L.imageAt(g.lat, g.lon, g.h ?? 0);
      if (q) p.setView({ cx: q.x, cy: q.y, zoom: res / mpp, rot: 0 });
      app.renderer?.invalidate();
      app.emit('state');
      return { layer: L, grid, ms };
    } finally {
      s.busy = false;
    }
  }

  let timer = null;
  app.on('view', (p) => {
    if (!p?.ootf) return;
    clearTimeout(timer);
    timer = setTimeout(() => refresh(p).catch((e) => app.toast(`Ortho On-the-Fly: ${e.message}`, { kind: 'error' })), 350);
  });

  async function enable(p = pane(), { layers = null, factor = 2 } = {}) {
    const src = layers ?? sources(p);
    if (!src.length) throw new Error('Ortho On-the-Fly needs an image with an RPC model in the panel');
    p.ootf = { sources: src.map((l) => l.id), factor, gen: 0, layerId: null, region: null, busy: false, projection: app.prefs.get('ootfProjection') ?? null };
    const r = await refresh(p, { force: true });
    return { ...r, state: p.ootf };
  }
  function disable(p = pane()) {
    const s = p?.ootf;
    if (!s) return;
    p.ootf = null;
    const g = centreGround(p);
    if (s.layerId && app.layers.has(s.layerId)) removeLayer(app, p, s.layerId);
    S.transact('Ortho On-the-Fly off', (tx) => {
      for (const id of s.sources) if (app.layers.has(id)) tx.set(id, 'visible', true);
      tx.set(p.id, 'activeLayer', s.sources.at(-1));
    }, { kind: 'load' });
    if (g) {
      try {
        p.centreOnGround(g.lat, g.lon, g.h);
      } catch {}
    }
    app.emit('state');
  }
  /** Projection for Ortho On-the-Fly and virtual mosaics: null = the UTM zone at the view. */
  async function setProjection(proj, p = pane()) {
    app.prefs.set('ootfProjection', proj);
    if (p?.ootf) {
      p.ootf.projection = proj;
      await refresh(p, { force: true });
    }
    return proj;
  }
  app.ootf = { enable, disable, refresh, setProjection };

  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };
  C.implement('img.orthofly', {
    enabled: () => !!pane() && (!!pane().ootf || sources(pane()).length > 0),
    checked: () => !!pane()?.ootf && pane().ootf.sources.length === 1,
    run: run(async () => (pane().ootf ? disable() : enable(pane(), { layers: [pane().geoLayer()].filter((l) => l && app.ortho.rpcRecordOf(l)) }))),
  });
  C.implement('img.projection', {
    run: run(async () => {
      const cur = pane()?.ootf?.projection ?? app.prefs.get('ootfProjection') ?? null;
      const g = pane() ? centreGround(pane()) : null;
      const here = g ? core.utm(g.lat, g.lon) : null;
      const mode = h('select', { class: 'inp', 'aria-label': 'Projection' }, h('option', { value: 'auto', selected: !cur }, 'UTM, zone at the view (changes as you pan)'), h('option', { value: 'fixed', selected: !!cur }, 'UTM, fixed zone'));
      const zone = h('input', { class: 'inp inp-num', type: 'number', min: '1', max: '60', value: String(cur?.zone ?? here?.zone ?? 31), 'aria-label': 'UTM zone' });
      const hemi = h('select', { class: 'inp', 'aria-label': 'Hemisphere' }, h('option', { value: 'N', selected: (cur?.north ?? here?.north ?? true) === true }, 'North'), h('option', { value: 'S', selected: (cur?.north ?? here?.north ?? true) === false }, 'South'));
      if ((await modal({ title: 'Ortho On-the-Fly Projection', body: h('div', {}, field('Projection', mode), field('Zone', zone), field('Hemisphere', hemi), h('p', { class: 'hint' }, 'Ortho On-the-Fly and virtual mosaics are rectified into this projection (WGS 84 UTM).')), id: 'ootf-projection' })) !== 'OK') return;
      const z = Math.round(Number(zone.value));
      if (mode.value === 'fixed' && !(z >= 1 && z <= 60)) throw new Error('the UTM zone must be 1–60');
      await setProjection(mode.value === 'fixed' ? { zone: z, north: hemi.value === 'N' } : null);
    }),
  });
  C.implement('img.vmosaic', {
    enabled: () => !!pane() && (!!pane().ootf || sources(pane()).length > 1),
    checked: () => !!pane()?.ootf && pane().ootf.sources.length > 1,
    run: run(async () => (pane().ootf ? disable() : enable())),
  });
}
