// MIE4NITF frame sequences (REQ-FMT-14, REQ-GAP-47). A MIE4NITF file opens as one layer per camera
// set and layer (formats/mie4nitf.js, workers/decode/mie.js): the layer's `frame` is the frame shown,
// its frames are decoded on demand in the decode worker, and every frame has its own model from its
// image segments' IGEOLO corners (a moving camera's footprint moves with it). Stepping and real-time
// playback at the layer's frame rate show the frame time in the panel label; the next frames' tiles
// are requested ahead while a sequence plays. A WAMI chip (mie.chip) writes a region of a frame range
// as a MIE4NITF file of its own.

import { t, gwError, msgOf } from '../i18n/index.js';
import { int, num } from '../i18n/format.js';
import { orderCorners } from '../formats/open.js';
import { modal, field } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { saveBlob } from '../storage/files.js';

export const name = 'mie';

const AHEAD = 3; // frames whose tiles are requested ahead while playing
const MODELS = 256; // frame models kept per layer

export function install(app) {
  const C = app.commands;
  const S = app.store;
  let timer = null;

  /** The MIE4NITF sequence layer of a panel: the active layer when it is one, else the first. */
  function sequenceLayer(p = app.activePane()) {
    const ls = p?.layers?.() ?? [];
    const a = p?.activeLayer?.();
    return a?.info?.mie?.sequence ? a : (ls.find((l) => l.info?.mie?.sequence) ?? null);
  }

  /** Frames of a panel's sequence: [{index, time (ISO, ms), timeMs, iso (exact, ns), segments}]. */
  function sequence(p = app.activePane()) {
    const l = sequenceLayer(p);
    if (!l) return [];
    return l.info.mie.frames.map((f, index) => ({ index, time: new Date(f.ms).toISOString(), timeMs: f.ms, iso: f.iso, ns: f.ns, segments: f.parts.map((q) => q.seg + 1), layer: l.id }));
  }

  // ---- per-frame models -------------------------------------------------------------------------

  /** The frame's model: its cameras' IGEOLO corners placed in the mosaic (projective fit). */
  function frameModel(l, k) {
    const m = l.info.mie;
    const fr = m.frames[k];
    const gcps = [];
    for (const q of fr.parts) {
      const c = m.segCorners?.[q.seg];
      const cam = m.cameras[q.camera];
      if (!c || !cam) continue;
      const [W, H] = m.segSize?.[q.seg] ?? [cam.width, cam.height];
      const px = [
        [0.5, 0.5],
        [W - 0.5, 0.5],
        [W - 0.5, H - 0.5],
        [0.5, H - 0.5],
      ];
      orderCorners(c).pts.forEach(([lat, lon], i) => gcps.push({ x: cam.x + px[i][0], y: cam.y + px[i][1], lat, lon }));
    }
    if (gcps.length < 4) return null;
    const sig = gcps.map((g) => `${g.x},${g.y},${g.lat.toFixed(7)},${g.lon.toFixed(7)}`).join(';');
    l.mieModels ??= new Map();
    let e = l.mieModels.get(sig);
    if (!e) {
      const label = fr.parts.length > 1 ? 'IGEOLO corners of the camera set (approximate)' : 'IGEOLO corners (approximate)';
      try {
        const id = app.core.gcpModel(gcps, 4, label);
        e = { id, name: label, info: app.core.modelInfo(id) };
      } catch (err) {
        e = { error: err.message };
      }
      l.mieModels.set(sig, e);
      // Old models go, except the one in use.
      for (const [s, x] of l.mieModels) {
        if (l.mieModels.size <= MODELS) break;
        if (x.id !== undefined && x.id !== l.modelId) app.core.freeModel?.(x.id);
        l.mieModels.delete(s);
      }
    }
    return e.error ? null : e;
  }

  function applyModel(l, k) {
    // A user-chosen or registered model stays; only the IGEOLO frame models follow the frame.
    if (l.modelName && !/^IGEOLO corners/.test(l.modelName) && l.modelName !== 'none') return;
    const e = frameModel(l, k);
    if (!e) return;
    l.modelId = e.id;
    l.modelName = e.name;
    l.modelInfo = e.info;
    l._cell = null;
  }

  /** A sequence layer was created (open, project load): frame 0 and its model. */
  function attach(l) {
    l.frame = 0;
    applyModel(l, 0);
  }

  // ---- stepping and playback --------------------------------------------------------------------

  /** Show frame k of the panel's sequence (or of `layer`, a sequence layer in it). */
  async function show(k, p = app.activePane(), layer = null) {
    const l = layer?.info?.mie?.sequence ? layer : sequenceLayer(p);
    if (!l) throw gwError('this panel has no MIE4NITF frames', null, 'E_NO_MIE_FRAMES');
    const n = l.info.mie.frames.length;
    const i = ((k % n) + n) % n;
    const fr = l.info.mie.frames[i];
    const before = l.frame;
    l.frame = i;
    applyModel(l, i);
    // The worker's current frame: pixel read-outs, windows and statistics read this frame.
    await app.pool.run('mieFrame', { handle: l.handle, frame: i }, { affinity: l.affinity, priority: 'interactive', label: t('MIE4NITF frame') });
    p.mie = { index: i, count: n, time: new Date(fr.ms).toISOString(), layer: l.id };
    // The frame time stays as its ISO stamp: the exact value matters.
    p.status.textContent = t('MIE4NITF frame {i}/{n} · {time}', { i: int(i + 1), n: int(n), time: fr.iso.replace('T', ' ').replace('Z', ' UTC') });
    // Only the frame shown before (it stands in until this one's tiles arrive) and the next ones keep GPU tiles.
    l.tiles.dropFrames((f) => f === before || (f >= i && f <= i + AHEAD) || f + n <= i + AHEAD);
    p.invalidate();
    app.emit('state');
    return { index: i, layer: l.id, time: p.mie.time, iso: fr.iso };
  }

  /**
   * Request the view's tiles for the frames after `from` (read-ahead). The view's tiles are those of
   * the frame shown before (`before`): the new frame's own are requested only at the next draw.
   */
  function readAhead(l, from, before = from) {
    const n = l.info.mie.frames.length;
    const bands = l.chain.bandMath?.bands ?? l.chain.bands;
    const seen = new Set();
    const tiles = [...l.tiles.frameTiles(from), ...l.tiles.frameTiles(before)].filter(([L, x, y]) => !seen.has(`${L}/${x}/${y}`) && seen.add(`${L}/${x}/${y}`));
    for (let d = 1; d <= AHEAD; d++) for (const [L, tx, ty] of tiles) l.tiles.request(L, tx, ty, bands, (from + d) % n, 'background');
  }

  function play(p = app.activePane(), { rate = null } = {}) {
    stop();
    const l = sequenceLayer(p);
    if (!l) throw gwError('this panel has no MIE4NITF frames', null, 'E_NO_MIE_FRAMES');
    const fps = Math.max(0.1, Math.min(60, rate ?? l.info.mie.rate ?? 2));
    const n = l.info.mie.frames.length;
    const k0 = l.frame ?? 0;
    const t0 = performance.now();
    const me = { p, l, fps, shown: 0, skipped: 0, busy: false, id: 0 };
    timer = me;
    const tick = async () => {
      if (timer !== me) return;
      if (!S.get(p.id) || !app.layers.has(l.id)) return stop();
      // Real time: the frame due now; frames the display could not keep up with are skipped.
      const due = (k0 + Math.floor(((performance.now() - t0) / 1000) * fps)) % n;
      if (!me.busy && due !== l.frame) {
        me.busy = true;
        const step = (due - l.frame + n) % n;
        if (step > 1) me.skipped += step - 1;
        try {
          const before = l.frame;
          await show(due, p, l);
          me.shown++;
          readAhead(l, due, before);
        } catch (e) {
          app.log('warn', `MIE4NITF playback: ${e.message}`);
          return stop();
        } finally {
          me.busy = false;
        }
      }
      if (timer === me) me.id = setTimeout(tick, Math.max(4, 250 / fps));
    };
    show(k0, p, l).then(() => readAhead(l, k0), () => {});
    me.id = setTimeout(tick, 1000 / fps);
    app.emit('state');
    return fps;
  }

  function stop() {
    if (timer) clearTimeout(timer.id);
    const was = timer;
    timer = null;
    app.emit('state');
    return was ? { shown: was.shown, skipped: was.skipped, fps: was.fps } : null;
  }

  /** The worker side of a sequence: open segments, frames opened, the OPFS store and its hits. */
  async function info(p = app.activePane(), { flush = false } = {}) {
    const l = sequenceLayer(p);
    if (!l) throw gwError('this panel has no MIE4NITF frames', null, 'E_NO_MIE_FRAMES');
    return app.pool.run('mieInfo', { handle: l.handle, flush }, { affinity: l.affinity, label: t('MIE4NITF frame') });
  }

  // ---- WAMI chip ----------------------------------------------------------------------------------

  /** The visible part of the layer in the panel, in its pixels (the AOI's box when the panel has one). */
  function viewBox(p, l) {
    const a = app.aoiFor?.(p) ? app.aoiBox?.(p, l) : null;
    let b = a;
    if (!b) {
      const { w, h: hh } = p.size();
      const c = [[0, 0], [w, 0], [0, hh], [w, hh]].map(([x, y]) => p.imagePoint(x, y));
      b = { x0: Math.min(...c.map((q) => q.x)), y0: Math.min(...c.map((q) => q.y)), x1: Math.max(...c.map((q) => q.x)), y1: Math.max(...c.map((q) => q.y)) };
    }
    const x0 = Math.max(0, Math.floor(b.x0));
    const y0 = Math.max(0, Math.floor(b.y0));
    const x1 = Math.min(l.width, Math.ceil(b.x1));
    const y1 = Math.min(l.height, Math.ceil(b.y1));
    return { x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), aoi: !!a };
  }

  /**
   * Write a chip: region {x0, y0, w, h} (layer pixels) of frames first…last (0-based, every `step`-th)
   * at level L → {bytes, name, frames, width, height}. Each frame's IGEOLO comes from its model.
   */
  async function chip(p = app.activePane(), { x0, y0, w, h: hh, first = 0, last = null, step = 1, L = 0, save = true, onProgress } = {}) {
    const l = sequenceLayer(p);
    if (!l) throw gwError('this panel has no MIE4NITF frames', null, 'E_NO_MIE_FRAMES');
    const n = l.info.mie.frames.length;
    const a = Math.max(0, Math.min(n - 1, first));
    const b = Math.max(a, Math.min(n - 1, last ?? n - 1));
    const frames = [];
    for (let k = a; k <= b; k += Math.max(1, step)) frames.push(k);
    const f = 2 ** L;
    const corners = frames.map((k) => {
      const e = frameModel(l, k);
      if (!e) return null;
      try {
        // Corner pixel centres of the chip at its own resolution, mapped through the frame model.
        const pts = [[x0 + f / 2, y0 + f / 2], [x0 + w - f / 2, y0 + f / 2], [x0 + w - f / 2, y0 + hh - f / 2], [x0 + f / 2, y0 + hh - f / 2]];
        return pts.map(([x, y]) => {
          const g = app.core.i2g(e.id, x, y, 0);
          if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) throw new Error('no ground point');
          return [g.lat, g.lon];
        });
      } catch {
        return null;
      }
    });
    const r = await app.pool.run('mieChip', { handle: l.handle, x0, y0, w, h: hh, L, frames, corners, security: l.info.security ?? undefined, title: `MIE4NITF chip of ${l.rec?.name ?? 'sequence'}`.slice(0, 80), layer: l.info.mie.layer || undefined }, { affinity: l.affinity, label: t('MIE4NITF chip'), timeout: 900000, onProgress });
    const stem = String(l.info.fileName ?? 'sequence').replace(/\.[^.]+$/, '');
    const out = { bytes: r.bytes, name: `${stem}_chip_f${a + 1}-${b + 1}.ntf`, frames: frames.length, width: Math.ceil(w / f), height: Math.ceil(hh / f) };
    if (save) await saveBlob(app, new Blob([r.bytes], { type: 'application/octet-stream' }), { name: out.name, description: 'NITF' });
    return out;
  }

  async function chipDialog(p = app.activePane()) {
    const l = sequenceLayer(p);
    if (!l) throw gwError('this panel has no MIE4NITF frames', null, 'E_NO_MIE_FRAMES');
    const n = l.info.mie.frames.length;
    const box = viewBox(p, l);
    const numIn = (v, min, max, label) => h('input', { type: 'number', class: 'inp', value: String(v), min: String(min), max: String(max), step: '1', 'aria-label': label });
    const cur = (l.frame ?? 0) + 1;
    const first = numIn(cur, 1, n, t('First frame'));
    const last = numIn(Math.min(n, cur + 29), 1, n, t('Last frame'));
    const step = numIn(1, 1, n, t('Every nth frame'));
    const lvl = h('select', { class: 'inp', 'aria-label': t('Resolution') }, ...[0, 1, 2, 3].map((L) => h('option', { value: String(L) }, L ? t('1/{f} resolution', { f: int(2 ** L) }) : t('Full resolution'))));
    const est = h('p', { class: 'hint', 'aria-live': 'polite' });
    const update = () => {
      const fs = Math.max(0, Math.floor((Number(last.value) - Number(first.value)) / Math.max(1, Number(step.value))) + 1);
      const f = 2 ** Number(lvl.value);
      const bytes = fs * Math.ceil(box.w / f) * Math.ceil(box.h / f) * l.bands * ({ u8: 1, u16: 2, i16: 2 }[l.sampleType] ?? 4);
      est.textContent = t('{n, plural, one {# frame} other {# frames}} of {w} × {h} pixels, about {mb} MB', { n: fs, w: int(Math.ceil(box.w / f)), h: int(Math.ceil(box.h / f)), mb: num(bytes / 2 ** 20, 1) });
    };
    for (const e of [first, last, step, lvl]) e.addEventListener('input', update);
    update();
    const body = h(
      'div',
      { 'data-id': 'mie-chip' },
      h('p', { class: 'hint' }, box.aoi ? t('Region: the AOI box, {w} × {h} pixels at ({x}, {y}).', { w: int(box.w), h: int(box.h), x: int(box.x0), y: int(box.y0) }) : t('Region: the current view, {w} × {h} pixels at ({x}, {y}).', { w: int(box.w), h: int(box.h), x: int(box.x0), y: int(box.y0) })),
      field(t('First frame'), first),
      field(t('Last frame'), last),
      field(t('Every nth frame'), step),
      field(t('Resolution'), lvl),
      est,
      h('p', { class: 'hint' }, t('Writes a MIE4NITF file: one image segment per frame with its MTIMSA time and IGEOLO corners, and the camera set, layer, time interval and temporal blocks in the file header.')),
    );
    const r = await modal({ title: t('WAMI Chip'), body, buttons: [{ label: t('Write Chip…'), value: 'write', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'mie-chip' });
    if (r !== 'write') return null;
    const a = Math.max(1, Math.min(n, Math.round(Number(first.value)))) - 1;
    const b = Math.max(a + 1, Math.min(n, Math.round(Number(last.value)))) - 1;
    try {
      const out = await chip(p, { ...box, first: a, last: b, step: Math.max(1, Math.round(Number(step.value))), L: Number(lvl.value) });
      app.toast(t('Wrote {file}: {n, plural, one {# frame} other {# frames}} of {w} × {h} pixels', { file: out.name, n: out.frames, w: int(out.width), h: int(out.height) }), { kind: 'info' });
      return out;
    } catch (e) {
      if (e.cancelled) return null;
      app.toast(t('WAMI chip failed: {msg}', { msg: msgOf(e) }), { kind: 'error', ms: 8000 });
      throw e;
    }
  }

  const hasSeq = () => !!sequenceLayer();
  const many = () => (sequenceLayer()?.info.mie.frames.length ?? 0) > 1;
  C.implement('mie.play', { enabled: many, checked: () => !!timer, run: () => (timer ? stop() : play()) });
  C.implement('mie.next', { enabled: many, run: () => show((sequenceLayer()?.frame ?? -1) + 1) });
  C.implement('mie.prev', { enabled: many, run: () => show((sequenceLayer()?.frame ?? 1) - 1) });
  C.implement('mie.chip', { enabled: hasSeq, run: () => chipDialog() });
  C.implement('mie.clearcache', {
    // The store exists on the hosted copy only (a file:// page has no origin-private storage).
    enabled: () => location.protocol !== 'file:' && !!navigator.storage?.getDirectory,
    run: async () => {
      const r = await app.pool.run('mieClearStore', {}, { label: t('MIE4NITF frame') });
      app.toast(t('Removed {n, plural, one {# cached sequence} other {# cached sequences}} ({mb} MB)', { n: r.removed, mb: num(r.bytes / 2 ** 20, 1) }), { kind: 'info' });
      return r;
    },
  });
  app.mie = { sequence, sequenceLayer, show, play, stop, playing: () => !!timer, attach, frameModel, info, chip, chipDialog, viewBox };
}
