// SAM-based smart select from the local AI pack (REQ-EXT-18, REQ-AI-18, D12): click an object on
// imagery or on a DSM hillshade and get its outline as a polygon graphic. SlimSAM runs on this
// device in the AI worker; the window around the click (≤ 1024 px at full resolution, or
// decimated to fit) is stretched to 8-bit RGB from the layer's display bands. Shift-click adds a
// positive point, Alt-click a negative one, on the same embedding.

import { groundOf } from '../tools/tools.js';

export const name = 'aiSam';

/** Largest 4-connected component of `mask` that contains (cx, cy) (or the largest one). */
function component(mask, w, h, cx, cy) {
  const lab = new Int32Array(w * h);
  let best = { id: 0, n: 0, hit: false };
  let id = 0;
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lab[s]) continue;
    id++;
    let n = 0;
    let hit = false;
    stack.push(s);
    lab[s] = id;
    while (stack.length) {
      const p = stack.pop();
      n++;
      const x = p % w;
      const y = (p - x) / w;
      if (x === cx && y === cy) hit = true;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && mask[q] && !lab[q]) {
          lab[q] = id;
          stack.push(q);
        }
      }
    }
    if ((hit && !best.hit) || (hit === best.hit && n > best.n)) best = { id, n, hit };
  }
  const out = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) out[s] = lab[s] === best.id ? 1 : 0;
  return { mask: out, n: best.n, hit: best.hit };
}

/**
 * Outer boundary of a binary mask as a ring of pixel corners: the mask's boundary edges, directed
 * with the region on their right, chained from the top-left pixel's top edge; then simplified.
 */
function outline(mask, w, h, tol = 1) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  const next = new Map(); // corner key → [corner keys] (outgoing edges)
  const key = (x, y) => y * (w + 1) + x;
  const add = (ax, ay, bx, by) => {
    const k = key(ax, ay);
    const v = next.get(k);
    if (v) v.push(key(bx, by));
    else next.set(k, [key(bx, by)]);
  };
  let first = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (first < 0) first = key(x, y);
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  if (first < 0) return [];
  const ring = [];
  let k = first;
  for (let guard = 0; guard <= 4 * w * h + 4; guard++) {
    ring.push([k % (w + 1), Math.floor(k / (w + 1))]);
    const out = next.get(k);
    if (!out?.length) break;
    const n = out.length > 1 ? out.shift() : out.pop();
    if (!out.length) next.delete(k);
    k = n;
    if (k === first) break;
  }
  // Drop collinear corners, then Douglas–Peucker.
  const lean = ring.filter((p, i) => {
    const a = ring[(i + ring.length - 1) % ring.length];
    const b = ring[(i + 1) % ring.length];
    return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0;
  });
  return simplify(lean, tol);
}

function simplify(pts, tol) {
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    let dmax = 0;
    let k = -1;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const L = Math.hypot(bx - ax, by - ay) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / L;
      if (d > dmax) [dmax, k] = [d, i];
    }
    if (dmax > tol && k > 0) {
      keep[k] = 1;
      st.push([a, k], [k, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const job = (op, args, transfer = []) => app.pool.run(op, args, { kind: 'ai', transfer, timeout: 300000, label: `AI ${op}` });
  let loaded = null;
  const cache = new Map(); // `${layer}|${x0},${y0},${w},${h},${step}` → embedding id

  async function ensure() {
    loaded ??= (async () => {
      const p = await app.packs.require('ai', 'Smart select');
      const g = (path) => p.entries.get(path).slice().buffer;
      return job('samload', { glue: g('ort-wasm-simd-threaded.mjs'), wasm: g('ort-wasm-simd-threaded.wasm'), encoder: g('slimsam/vision_encoder_quantized.onnx'), decoder: g('slimsam/prompt_encoder_mask_decoder_quantized.onnx'), config: g('slimsam/preprocessor_config.json') });
    })().catch((e) => {
      loaded = null;
      throw e;
    });
    return loaded;
  }

  /** The window around (x, y) as stretched 8-bit RGB. */
  async function rgbWindow(l, x, y, size, hillshade = l.kind === 'dem' || !!app.terrain?.entry?.(l.id)) {
    const W = Math.min(l.width, size);
    const H = Math.min(l.height, size);
    const step = Math.max(1, Math.ceil(Math.max(W, H) / 1024));
    const x0 = Math.max(0, Math.min(l.width - W, Math.round(x - W / 2)));
    const y0 = Math.max(0, Math.min(l.height - H, Math.round(y - H / 2)));
    const cb = l.chain?.bands ?? [0];
    const bands = cb.length >= 3 ? cb.slice(0, 3) : [cb[0] ?? 0];
    const r = await app.pool.run('window', { handle: l.handle, x0, y0, w: Math.ceil(W / step), h: Math.ceil(H / step), step, bands }, { affinity: l.affinity, label: 'smart select window' });
    const n = r.w * r.h;
    const rgb = new Uint8Array(3 * n);
    if (hillshade) {
      // DSM/DEM: a Horn hillshade (sun 315°, 45°) of the window, the surface SAM sees (D12).
      const z = r.planes[0];
      const a = l.groundAt?.(x0, y0);
      const b = l.groundAt?.(x0 + step, y0);
      const c = l.groundAt?.(x0, y0 + step);
      const dx = a && b ? app.core.inverse(a.lat, a.lon, b.lat, b.lon).distance || 1 : step;
      const dy = a && c ? app.core.inverse(a.lat, a.lon, c.lat, c.lon).distance || 1 : step;
      const Z = (i, j) => z[Math.min(r.h - 1, Math.max(0, j)) * r.w + Math.min(r.w - 1, Math.max(0, i))];
      const az = (315 * Math.PI) / 180;
      const alt = (45 * Math.PI) / 180;
      for (let j = 0; j < r.h; j++) {
        for (let i = 0; i < r.w; i++) {
          const gx = (Z(i + 1, j - 1) + 2 * Z(i + 1, j) + Z(i + 1, j + 1) - Z(i - 1, j - 1) - 2 * Z(i - 1, j) - Z(i - 1, j + 1)) / (8 * dx);
          const gy = (Z(i - 1, j + 1) + 2 * Z(i, j + 1) + Z(i + 1, j + 1) - Z(i - 1, j - 1) - 2 * Z(i, j - 1) - Z(i + 1, j - 1)) / (8 * dy);
          const slope = Math.atan(Math.hypot(gx, gy));
          const aspect = Math.atan2(gy, -gx);
          const v = Math.max(0, Math.sin(alt) * Math.cos(slope) + Math.cos(alt) * Math.sin(slope) * Math.cos(az - Math.PI / 2 - aspect));
          const q = Math.round(v * 255);
          rgb[3 * (j * r.w + i)] = rgb[3 * (j * r.w + i) + 1] = rgb[3 * (j * r.w + i) + 2] = q;
        }
      }
      return { rgb, w: r.w, h: r.h, x0: r.x0, y0: r.y0, step, hillshade: true };
    }
    const st = r.planes.map((pl) => {
      const v = Array.from(pl).filter((q) => Number.isFinite(q) && q !== l.nodata).sort((a, b) => a - b);
      const lo = v[Math.floor(v.length * 0.02)] ?? 0;
      const hi = v[Math.ceil(v.length * 0.98) - 1] ?? 1;
      return [lo, hi > lo ? hi : lo + 1];
    });
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const b = Math.min(c, r.planes.length - 1);
        const [lo, hi] = st[b];
        rgb[3 * i + c] = Math.max(0, Math.min(255, Math.round(((r.planes[b][i] - lo) / (hi - lo)) * 255)));
      }
    }
    return { rgb, w: r.w, h: r.h, x0: r.x0, y0: r.y0, step };
  }

  /**
   * Smart select at image point (x, y) of layer l: → {polygon (image coords), iou, area, graphic}.
   * points: extra prompts [[x, y, 1|0]] in image coordinates.
   */
  async function select(l, x, y, { pane = app.activePane(), size = 1024, points = [], commit = true, hillshade } = {}) {
    await ensure();
    const win = await rgbWindow(l, x, y, size, hillshade);
    const key = `${l.id}|${win.x0},${win.y0},${win.w},${win.h},${win.step},${win.hillshade ? 'hs' : 'rgb'}`;
    let id = cache.get(key);
    let encMs = 0;
    if (!id) {
      const e = await job('samembed', { rgb: win.rgb, w: win.w, h: win.h }, [win.rgb.buffer]);
      id = e.id;
      encMs = e.ms;
      cache.set(key, id);
      while (cache.size > 4) cache.delete(cache.keys().next().value);
    }
    const local = (px, py) => [(px - win.x0) / win.step, (py - win.y0) / win.step];
    const prompts = [[...local(x, y), 1], ...points.map(([px, py, lab]) => [...local(px, py), lab])];
    const d = await job('samdecode', { id, points: prompts });
    const [cx, cy] = local(x, y).map(Math.floor);
    const comp = component(d.mask, d.w, d.h, cx, cy);
    const ring = outline(comp.mask, d.w, d.h, 0.75).map(([px, py]) => [win.x0 + px * win.step, win.y0 + py * win.step]);
    const out = { polygon: ring, iou: d.iou, area: comp.n * win.step * win.step, hit: comp.hit, encoderMs: encMs, decoderMs: d.ms, window: { x0: win.x0, y0: win.y0, w: win.w * win.step, h: win.h * win.step, step: win.step } };
    if (commit && ring.length >= 3) {
      const ground = ring.map(([px, py]) => l.groundAt?.(px, py));
      const anchor = ground.every(Boolean) ? 'ground' : 'image';
      S.transact('Smart select', (tx) => {
        let gl = pane.rec.graphicsLayer;
        if (!gl) {
          gl = tx.create('glayer', { pane: pane.id, name: 'Graphics', visible: true, saved: false });
          tx.set(pane.id, 'graphicsLayer', gl);
        }
        out.graphic = tx.create('graphic', { glayer: gl, pane: pane.id, shape: 'polygon', anchor, coords: anchor === 'ground' ? ground.map((g) => [g.lon, g.lat, g.h]) : ring, text: `SAM ${(d.iou * 100).toFixed(0)}%`, style: { stroke: '#00e5ff', width: 2, fill: '#00e5ff22' }, created: new Date().toISOString(), provenance: { kind: 'ai-sam', model: 'SlimSAM-77-uniform (int8), on this device', iou: d.iou, layer: l.rec?.name ?? '' } });
      });
      pane.invalidate();
    }
    return out;
  }

  app.tools.register({
    id: 'ai.smartselect',
    cue: 'Smart select: click an object (SlimSAM from the local AI pack runs on this device).',
    onDown(p, e, sx, sy) {
      const l = p.geoLayer?.() ?? p.activeLayer?.();
      if (!l) return false;
      const q = p.imagePoint(sx, sy);
      app.toast('Smart select: segmenting…');
      select(l, q.x, q.y, { pane: p })
        .then((r) => app.toast(`Smart select: ${r.polygon.length} vertices, IoU estimate ${(r.iou * 100).toFixed(0)} %`))
        .catch((err) => app.toast(err.message, { kind: 'error', ms: 9000 }));
      void groundOf;
      app.tools.done();
      return true;
    },
  });
  C.implement('ai.smartselect', { enabled: () => !!app.activePane()?.activeLayer?.(), checked: () => app.tools.current?.id === 'ai.smartselect', run: () => app.tools.select('ai.smartselect') });
  app.sam = { ensure, select, rgbWindow, outline, component };
}
