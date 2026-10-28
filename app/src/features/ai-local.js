// Local AI (2.0 plan P5; REQ-LAI-01..09): the on-device models of the AI packs as tools. One AI
// worker holds the runtime (WebGPU when the device has it, WASM otherwise) and the sessions;
// every job is pinned to it. Find objects (OWLv2) tiles the view and fills the detections review
// queue; Search imagery (CLIP) indexes the image as chips and flies to the best matches; Auto
// Align (AI) matches DISK keypoints with LightGlue (features/register.js); Auto Contrast sets a
// local tone mapping (CLAHE) and gamma from the histogram; plain-language requests in the
// Copilot run these first (ai/intent.js). Nothing leaves the device; results carry provenance.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { probeAi, tierText } from '../ai/hw.js';
import { ClipTokenizer } from '../ai/clip-tokenizer.js';
import { parseIntent, LOCAL_HELP } from '../ai/intent.js';
import { nms } from '../workers/ai/image.js';
import { histPercentile } from '../render/chain.js';

export const name = 'aiLocal';

/** Model packs and their sessions: [session key, model entry, external data [[name in the model, entry]]]. */
export const MODELS = {
  // SlimSAM's int8 graph gives wrong masks on the WebGPU execution provider (DN-56): CPU only.
  slimsam: { pack: 'ai', title: 'SlimSAM', cpu: true, sessions: [['slimsam-enc', 'slimsam/vision_encoder_quantized.onnx'], ['slimsam-dec', 'slimsam/prompt_encoder_mask_decoder_quantized.onnx']], config: 'slimsam/preprocessor_config.json' },
  sam2: {
    pack: 'ai-sam2',
    title: 'SAM 2.1 hiera-tiny (int8)',
    sessions: [
      ['sam2-enc', 'sam2/vision_encoder_int8.onnx', [['vision_encoder_int8.onnx_data', 'sam2/vision_encoder_int8.onnx_data']]],
      ['sam2-dec', 'sam2/prompt_encoder_mask_decoder_int8.onnx', [['prompt_encoder_mask_decoder_int8.onnx_data', 'sam2/prompt_encoder_mask_decoder_int8.onnx_data']]],
    ],
    config: 'sam2/preprocessor_config.json',
  },
  owlv2: { pack: 'ai-detect', title: 'OWLv2 base (8-bit)', sessions: [['owlv2', 'owlv2/model_quantized.onnx']], config: 'owlv2/preprocessor_config.json', tokenizer: true },
  clip: { pack: 'ai-search', title: 'CLIP ViT-B/32 (8-bit)', sessions: [['clip-vision', 'clip/vision_model_quantized.onnx'], ['clip-text', 'clip/text_model_quantized.onnx']], config: 'clip/preprocessor_config.json', tokenizer: true },
  lightglue: { pack: 'ai-match', title: 'DISK + LightGlue', sessions: [['lightglue', 'lightglue/disk_lightglue_pipeline.onnx']] },
};
const PURPOSE = { slimsam: 'Smart select', sam2: 'SAM 2.1 smart select', owlv2: 'Find objects (AI)', clip: 'Search imagery (AI)', lightglue: 'Auto Align (AI)' };

/** Auto Contrast parameters from a band histogram (REQ-LAI-07): {clip, gamma}. */
export function autoContrastParams(hst) {
  const lo = histPercentile(hst, 0.02);
  const hi = histPercentile(hst, 0.98);
  const a = histPercentile(hst, 0.0005);
  const b = histPercentile(hst, 0.9995);
  const med = histPercentile(hst, 0.5);
  const spread = (hi - lo) / Math.max(1e-9, b - a); // share of the range that holds 96 % of the pixels
  const clip = spread < 0.2 ? 3.5 : spread < 0.45 ? 2.5 : 1.8;
  const um = Math.min(0.95, Math.max(0.05, (med - lo) / Math.max(1e-9, hi - lo)));
  // tone(): v^(1/g), g = 2^(gamma/50); bring the median to 0.45.
  const gamma = Math.round(Math.max(-60, Math.min(60, 50 * Math.log2(Math.log(um) / Math.log(0.45)))));
  return { clip, gamma, spread, median: um };
}

export function install(app) {
  const C = app.commands;
  let hw = null;
  // Two runtimes, each in its own AI worker: 'gpu' (the WebGPU build) when the device has WebGPU,
  // and 'cpu' (the WASM build), used for models the WebGPU build cannot create (DN-56).
  const rts = { gpu: null, cpu: null }; // kind → Promise<{slot, device}>
  const models = new Map(); // name → Promise<{config, tokenizer, device, rt}>
  const index = new Map(); // layer id → {emb: Int8Array, cells, dim, step, size}

  const reset = () => {
    rts.gpu = rts.cpu = null;
    models.clear();
  };
  const slotOf = async (rt) => (await rts[rt])?.slot ?? null;
  /** A job on the AI worker that holds runtime `rt` ('gpu' | 'cpu') and its sessions. */
  const job = async (op, args, { transfer = [], label, timeout = 900000, rt = 'cpu' } = {}) =>
    app.pool.run(op, args, { kind: 'ai', transfer, timeout, label: label ?? `AI ${op}`, affinity: await slotOf(rt) }).catch((e) => {
      if (e.lost) reset();
      throw e;
    });

  async function probe() {
    hw ??= await probeAi();
    return hw;
  }

  /** Can this device use the WebGPU runtime? */
  const gpuOk = async () => {
    const d = await probe();
    const p = await app.packs.require('ai', 'Local AI');
    return d.webgpu && app.prefs.get('aiDevice') !== 'cpu' && p.entries.has('ort.webgpu.min.js');
  };

  /** Start runtime `kind` in a worker of its own → {slot, device}. */
  function runtime(kind = 'cpu') {
    rts[kind] ??= (async () => {
      const p = await app.packs.require('ai', 'Local AI');
      const g = (path) => p.entries.get(path).slice().buffer;
      const args = kind === 'gpu' ? { lib: 'ortgpu', glue: g('ort-wasm-simd-threaded.asyncify.mjs'), wasm: g('ort-wasm-simd-threaded.asyncify.wasm'), gpu: true } : { lib: 'ort', glue: g('ort-wasm-simd-threaded.mjs'), wasm: g('ort-wasm-simd-threaded.wasm'), gpu: false };
      const other = kind === 'gpu' ? 'cpu' : 'gpu';
      const avoid = rts[other] ? [await rts[other].then((r) => r.slot, () => null)].filter(Boolean) : [];
      const pr = app.pool.run('ortinit', args, { kind: 'ai', transfer: [args.glue, args.wasm], timeout: 120000, label: `AI runtime (${kind === 'gpu' ? 'WebGPU' : 'CPU'})`, avoid });
      const r = await pr;
      return { slot: app.pool.slotOf.get(pr.jobId) ?? null, device: r.device };
    })().catch((e) => {
      rts[kind] = null;
      throw e;
    });
    return rts[kind];
  }

  /** Is a model's pack loaded or kept from an earlier session? */
  const has = (name) => {
    const p = MODELS[name]?.pack;
    return !!p && (app.packs.loaded.has(p) || app.packs.stored.has(p));
  };

  /** Load a model's sessions: on the WebGPU runtime when it can, else on the CPU one → {config, tokenizer, device, rt}. */
  async function load(name) {
    const spec = MODELS[name];
    if (!models.has(name)) {
      models.set(
        name,
        (async () => {
          if (spec.pack !== 'ai') await app.packs.require('ai', PURPOSE[name]);
          const p = await app.packs.require(spec.pack, PURPOSE[name]);
          const buf = (path) => {
            const b = p.entries.get(path);
            if (!b) throw new Error(`the ${spec.pack} pack has no ${path}`);
            return b.slice().buffer;
          };
          const tryOn = async (rt) => {
            await runtime(rt);
            let device = 'wasm';
            for (const [key, path, ext] of spec.sessions) {
              const model = buf(path);
              const external = (ext ?? []).map(([n, e]) => ({ path: n, data: buf(e) }));
              const r = await job('aiload', { key, model, external }, { transfer: [model, ...external.map((e) => e.data)], label: `AI load ${key}`, timeout: 300000, rt });
              device = r.device;
            }
            return device;
          };
          let rt = !spec.cpu && (await gpuOk()) ? 'gpu' : 'cpu';
          let device;
          let fallback = null;
          try {
            device = await tryOn(rt);
          } catch (e) {
            if (rt !== 'gpu') throw e;
            fallback = e.message;
            app.log?.('info', `Local AI: ${spec.title} cannot run on the WebGPU runtime (${e.message}); using the CPU runtime`);
            rt = 'cpu';
            device = await tryOn(rt);
          }
          const text = (path) => new TextDecoder().decode(p.entries.get(path));
          const config = spec.config ? JSON.parse(text(spec.config)) : null;
          const tokenizer = spec.tokenizer ? new ClipTokenizer(JSON.parse(text('clip/vocab.json')), text('clip/merges.txt')) : null;
          return { config, tokenizer, device, rt, fallback, title: spec.title };
        })().catch((e) => {
          models.delete(name);
          throw e;
        }),
      );
    }
    return models.get(name);
  }

  /** 8-bit RGB of an image region (x0, y0, w × h at `step`), stretched 2–98 % per band. */
  async function rgbRegion(l, x0, y0, w, h, step = 1) {
    x0 = Math.max(0, Math.round(x0));
    y0 = Math.max(0, Math.round(y0));
    w = Math.min(l.width - x0, Math.round(w));
    h = Math.min(l.height - y0, Math.round(h));
    const cb = l.chain?.bands ?? [0];
    const bands = cb.length >= 3 ? cb.slice(0, 3) : [cb[0] ?? 0];
    const r = await app.pool.run('window', { handle: l.handle, x0, y0, w: Math.max(1, Math.ceil(w / step)), h: Math.max(1, Math.ceil(h / step)), step, bands }, { affinity: l.affinity, label: 'AI: read window' });
    const n = r.w * r.h;
    const st = r.planes.map((pl) => {
      const v = Array.from(pl).filter((q) => Number.isFinite(q) && q !== l.nodata).sort((a, b) => a - b);
      const lo = v[Math.floor(v.length * 0.02)] ?? 0;
      const hi = v[Math.ceil(v.length * 0.98) - 1] ?? 1;
      return [lo, hi > lo ? hi : lo + 1];
    });
    const rgb = new Uint8Array(3 * n);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const b = Math.min(c, r.planes.length - 1);
        const [lo, hi] = st[b];
        rgb[3 * i + c] = Math.max(0, Math.min(255, Math.round(((r.planes[b][i] - lo) / (hi - lo)) * 255)));
      }
    }
    return { rgb, w: r.w, h: r.h, x0: r.x0 ?? x0, y0: r.y0 ?? y0, step };
  }

  /** The image region a panel shows of layer l (image pixels, clamped). */
  function viewRegion(p, l) {
    const { w, h } = p.size();
    const c = [p.imagePoint(0, 0), p.imagePoint(w, 0), p.imagePoint(0, h), p.imagePoint(w, h)];
    const x0 = Math.max(0, Math.min(...c.map((q) => q.x)));
    const y0 = Math.max(0, Math.min(...c.map((q) => q.y)));
    const x1 = Math.min(l.width, Math.max(...c.map((q) => q.x)));
    const y1 = Math.min(l.height, Math.max(...c.map((q) => q.y)));
    if (x1 - x0 < 8 || y1 - y0 < 8) throw new Error('the image is not in view');
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  const targetLayer = (p = app.activePane()) => {
    const l = p?.geoLayer?.() ?? p?.activeLayer?.();
    if (!l?.handle) throw new Error('open an image first');
    return l;
  };

  // ---- Find objects (OWLv2; REQ-LAI-03) ----

  /** Objects named in `queries` in the view (or `region`) → detections in the review queue. */
  async function find(queries, { pane = app.activePane(), layer, region, threshold = 0.15, maxTiles = 4, commit = true } = {}) {
    const q = [...new Set((Array.isArray(queries) ? queries : String(queries).split(/[,;]/)).map((s) => s.trim()).filter(Boolean))].slice(0, 8);
    if (!q.length) throw new Error('name what to look for, for example "aircraft, vehicle"');
    const l = layer ?? targetLayer(pane);
    const m = await load('owlv2');
    const tb = m.tokenizer.batch(q.map((s) => `a photo of ${/^(a|an|the)\s/i.test(s) ? s : `a ${s}`}`), 16, 0);
    const R = region ?? viewRegion(pane, l);
    const T = m.config?.size?.height ?? 960;
    let step = Math.max(1, Math.floor(1 / (pane?.view?.zoom ?? 1)));
    while (Math.ceil(R.w / (T * step)) * Math.ceil(R.h / (T * step)) > maxTiles) step *= 2;
    const nx = Math.ceil(R.w / (T * step));
    const ny = Math.ceil(R.h / (T * step));
    const all = [];
    let ms = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const win = await rgbRegion(l, R.x0 + i * T * step, R.y0 + j * T * step, Math.min(T * step, R.w - i * T * step), Math.min(T * step, R.h - j * T * step), step);
        const r = await job('owldetect', { rgb: win.rgb, w: win.w, h: win.h, ids: Array.from(tb.ids, Number), mask: Array.from(tb.mask, Number), nq: tb.n, len: tb.length, threshold, config: m.config }, { transfer: [win.rgb.buffer], label: `Find objects: tile ${j * nx + i + 1}/${nx * ny}`, rt: m.rt });
        ms += r.ms;
        for (const b of r.boxes) all.push({ q: b.q, score: b.score, box: [win.x0 + b.box[0] * step, win.y0 + b.box[1] * step, win.x0 + b.box[2] * step, win.y0 + b.box[3] * step] });
      }
    }
    const kept = nms(all, 0.3);
    const list = kept.map((d) => ({ cls: q[d.q], confidence: Math.round(d.score * 1000) / 1000, anchor: 'image', ring: [[d.box[0], d.box[1]], [d.box[2], d.box[1]], [d.box[2], d.box[3]], [d.box[0], d.box[3]]], props: { model: m.title, device: m.device, prompt: q[d.q] } }));
    if (commit && list.length) app.detections.add(list, { layer: l, source: `Find objects (AI): ${q.join(', ')}` });
    const counts = Object.fromEntries(q.map((s, i) => [s, kept.filter((d) => d.q === i).length]));
    return { count: list.length, counts, tiles: nx * ny, step, ms, device: m.device, detections: list };
  }

  // ---- Search imagery (CLIP; REQ-LAI-06) ----

  /** Index layer l as chips of ≥ `chip` image pixels (≤ maxChips chips): int8 unit embeddings. */
  async function buildIndex(l, { maxChips = 1200, chip = 224, onProgress } = {}) {
    const m = await load('clip');
    const P = 224;
    const size = Math.max(chip, Math.ceil(Math.sqrt((l.width * l.height) / maxChips)));
    const step = size / P;
    const nx = Math.max(1, Math.floor(l.width / size));
    const ny = Math.max(1, Math.floor(l.height / size));
    const D = 512;
    const emb = new Int8Array(nx * ny * D);
    const cells = [];
    for (let j = 0; j < ny; j++) {
      // One strip of chips per read, resampled to 224 px chips.
      const s = Math.max(1, Math.round(step));
      const win = await rgbRegion(l, 0, j * size, nx * size, size, s);
      const chips = new Uint8Array(nx * P * P * 3);
      for (let i = 0; i < nx; i++) {
        for (let y = 0; y < P; y++) {
          const sy = Math.min(win.h - 1, Math.floor(((y + 0.5) * size) / P / s));
          for (let x = 0; x < P; x++) {
            const sx = Math.min(win.w - 1, Math.floor((i * size + ((x + 0.5) * size) / P) / s));
            const o = 3 * (sy * win.w + sx);
            const d = 3 * ((i * P + y) * P + x);
            chips[d] = win.rgb[o];
            chips[d + 1] = win.rgb[o + 1];
            chips[d + 2] = win.rgb[o + 2];
          }
        }
        cells.push({ x0: i * size, y0: j * size, size });
      }
      const r = await job('clipimage', { chips, n: nx, size: P, config: m.config }, { transfer: [chips.buffer], label: `Search index: row ${j + 1}/${ny}`, rt: m.rt });
      for (let k = 0; k < nx * D; k++) emb[j * nx * D + k] = Math.max(-127, Math.min(127, Math.round(r.emb[k] * 127)));
      onProgress?.((j + 1) / ny);
    }
    const ix = { emb, cells, dim: D, size, device: m.device };
    index.set(l.id, ix);
    return ix;
  }

  /** Places in layer l that look like `text` → [{x0, y0, size, score}] best first. */
  async function search(text, { pane = app.activePane(), layer, k = 8, commit = true, chip } = {}) {
    const t = String(text ?? '').trim();
    if (!t) throw new Error('type what to look for, for example "unpaved runway"');
    const l = layer ?? targetLayer(pane);
    const m = await load('clip');
    const ix = index.get(l.id) ?? (await buildIndex(l, chip ? { chip } : {}));
    const ids = m.tokenizer.encode(`a satellite photo of ${t}`).slice(0, 77);
    const { emb } = await job('cliptext', { ids }, { label: 'Search: text', rt: m.rt });
    const n = ix.cells.length;
    const scores = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let d = 0; d < ix.dim; d++) s += ix.emb[i * ix.dim + d] * emb[d];
      scores[i] = s / 127;
    }
    const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, k);
    const hits = order.map((i) => ({ ...ix.cells[i], score: Math.round(scores[i] * 1000) / 1000 }));
    if (commit && hits.length && pane) {
      const ground = (x, y) => l.groundAt?.(x, y);
      app.store.transact(`Search: ${t}`, (tx) => {
        for (const g of app.store.all('graphic')) if (g.tag === 'aisearch') tx.delete(g.id);
        let gl = pane.rec.graphicsLayer;
        if (!gl) {
          gl = tx.create('glayer', { pane: pane.id, name: 'Graphics', visible: true, saved: false });
          tx.set(pane.id, 'graphicsLayer', gl);
        }
        hits.forEach((c, i) => {
          const ring = [[c.x0, c.y0], [c.x0 + c.size, c.y0], [c.x0 + c.size, c.y0 + c.size], [c.x0, c.y0 + c.size]];
          const g = ring.map(([x, y]) => ground(x, y));
          const anchor = g.every(Boolean) ? 'ground' : 'image';
          tx.create('graphic', { glayer: gl, pane: pane.id, shape: 'polygon', anchor, coords: anchor === 'ground' ? g.map((q) => [q.lon, q.lat, q.h]) : ring, text: `#${i + 1} ${t} (${c.score.toFixed(2)})`, style: { stroke: '#ffb300', width: 2, fill: '#ffb30014' }, created: new Date().toISOString(), tag: 'aisearch', provenance: { kind: 'ai-search', model: `${m.title}, on this device`, query: t, score: c.score, layer: l.rec?.name ?? '' } });
        });
      });
      pane.setView({ cx: hits[0].x0 + hits[0].size / 2, cy: hits[0].y0 + hits[0].size / 2 });
    }
    return { hits, chips: n, device: m.device };
  }

  // ---- Matching (DISK + LightGlue; REQ-LAI-05): used by Auto Align (AI) ----

  /** Matches between two same-size windows → [{a: {x, y}, b: {x, y}, score}] in window pixels. */
  async function match(winA, winB) {
    const m = await load('lightglue');
    if (winA.w !== winB.w || winA.h !== winB.h) throw new Error('the two windows differ in size');
    const r = await job('lgmatch', { a: winA.rgb, b: winB.rgb, w: winA.w, h: winA.h }, { transfer: [winA.rgb.buffer, winB.rgb.buffer], label: 'Auto Align (AI): match', rt: m.rt });
    const out = [];
    for (let i = 0; i < r.n; i++) out.push({ a: { x: r.pairs[5 * i], y: r.pairs[5 * i + 1] }, b: { x: r.pairs[5 * i + 2], y: r.pairs[5 * i + 3] }, score: r.pairs[5 * i + 4] });
    return { pairs: out, ms: r.ms };
  }

  // ---- Auto Contrast (REQ-LAI-07) ----

  function autoContrast(l = app.activeLayer()) {
    if (!l?.chain) throw new Error('select an image layer first');
    const hst = l.stats?.[l.chain.bands[0] ?? 0];
    if (!hst) throw new Error('the image statistics are still being computed; try again in a moment');
    const p = autoContrastParams(hst);
    app.setChain((c) => {
      c.stretch = 'dra';
      c.dra = { ...c.dra, scope: 'full', lock: false, pmin: 0.01, pmax: 0.99 };
      c.clahe = { on: true, grid: 8, clip: p.clip };
      c.tone = { ...c.tone, gamma: p.gamma };
    }, 'Auto Contrast');
    return p;
  }

  // ---- Copilot routing (REQ-LAI-09) ----

  /** Run a plain-language request on a local tool → {handled, text} (handled false: not a local request). */
  async function route(text) {
    const it = parseIntent(text);
    if (!it) return { handled: false, text: LOCAL_HELP };
    switch (it.intent) {
      case 'find': {
        const r = await find(it.objects);
        app.activeMp()?.docks.show('detections');
        const parts = Object.entries(r.counts).map(([k, n]) => `${n} ${k}`);
        return { handled: true, text: `Found ${parts.join(', ')} in view (${r.tiles} tile${r.tiles > 1 ? 's' : ''}, ${r.device === 'webgpu' ? 'WebGPU' : 'CPU'}). They are in the detections review queue: accept or reject each one.` };
      }
      case 'search': {
        const r = await search(it.text);
        return { handled: true, text: r.hits.length ? `The best match for “${it.text}” is outlined and centred (score ${r.hits[0].score.toFixed(2)}); ${r.hits.length - 1} more are outlined. J / K steps through them.` : `Nothing in the ${r.chips} chips looked like “${it.text}”.` };
      }
      case 'contrast': {
        const p = autoContrast();
        return { handled: true, text: `Auto Contrast: local contrast (CLAHE, clip ${p.clip}) and gamma ${p.gamma > 0 ? '+' : ''}${p.gamma}. Undo with Ctrl+Z; the classic DRA controls are under Enhance.` };
      }
      case 'align': {
        if (!app.autoAlignAI) throw new Error('Auto Align (AI) is not available in this build');
        const r = await app.autoAlignAI();
        return { handled: true, text: `Aligned with ${r.used} learned tie points (${r.rejected} rejected), RMS ${r.rms.toFixed(2)} px.` };
      }
      case 'segment':
        if (it.square) app.prefs.set('samSquare', true);
        app.tools.select('ai.smartselect');
        return { handled: true, text: `Click the object to outline${it.square ? ' (corners will be squared)' : ''}.` };
      case 'goto': {
        const c = app.findCoordinate?.(it.text);
        if (!c) return { handled: true, text: `“${it.text}” is not a coordinate I can read (MGRS, decimal degrees, DMS or UTM).` };
        await app.jumpTo(c);
        return { handled: true, text: `Centred on ${it.text}.` };
      }
    }
    return { handled: false, text: LOCAL_HELP };
  }

  // ---- commands and dialogs ----

  async function ask(title, label, value, id) {
    const inp = h('input', { class: 'inp', value, 'aria-label': label, 'data-id': `${id}:text`, style: { width: '100%' } });
    setTimeout(() => inp.select(), 0);
    const r = await modal({ title, body: h('div', {}, field(label, inp), h('p', { class: 'hint' }, tierText(hw))), buttons: ['Run', 'Cancel'], id });
    return r === 'Run' ? inp.value.trim() : null;
  }
  const busy = (label, fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(`${label}: ${e.message}`, { kind: 'warn', ms: 9000 });
    }
  };
  const hasImage = () => !!(app.activePane()?.geoLayer?.() ?? app.activePane()?.activeLayer?.())?.handle;

  C.implement('lai.find', {
    enabled: hasImage,
    run: busy('Find objects', async () => {
      await probe();
      const q = await ask('Find objects (AI)', 'What to find (comma-separated)', app.prefs.get('aiFindLast') ?? 'aircraft, vehicle', 'lai-find');
      if (!q) return;
      app.prefs.set('aiFindLast', q);
      app.toast(`Finding ${q}…`);
      const r = await find(q);
      app.activeMp()?.docks.show('detections');
      app.toast(`Find objects: ${Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(', ')} — review them in the queue.`);
    }),
  });
  C.implement('lai.search', {
    enabled: hasImage,
    run: busy('Search imagery', async () => {
      await probe();
      const q = await ask('Search imagery (AI)', 'Describe what you are looking for', app.prefs.get('aiSearchLast') ?? '', 'lai-search');
      if (!q) return;
      app.prefs.set('aiSearchLast', q);
      app.toast(`Searching for ${q}…`);
      const r = await search(q);
      app.toast(r.hits.length ? `Search: best match ${r.hits[0].score.toFixed(2)}; J / K steps through ${r.hits.length} places.` : 'Search: nothing matched.');
    }),
  });
  C.implement('lai.contrast', {
    enabled: () => !!app.activeLayer()?.chain,
    run: busy('Auto Contrast', async () => {
      const p = autoContrast();
      app.toast(`Auto Contrast: CLAHE clip ${p.clip}, gamma ${p.gamma > 0 ? '+' : ''}${p.gamma}.`);
    }),
  });
  C.implement('lai.square', { checked: () => !!app.prefs.get('samSquare'), run: () => app.prefs.set('samSquare', !app.prefs.get('samSquare')) });
  C.implement('lai.device', {
    run: async () => {
      const d = await probe();
      const rows = Object.entries(MODELS).map(([k, m]) => h('tr', {}, h('td', {}, m.title), h('td', {}, PURPOSE[k]), h('td', {}, has(k) ? 'pack loaded' : `needs ${app.packs.known(m.pack)?.file ?? m.pack}`)));
      const cpu = h('input', { type: 'checkbox', checked: app.prefs.get('aiDevice') === 'cpu', 'aria-label': 'Run the models on the CPU only' });
      cpu.addEventListener('change', () => {
        app.prefs.set('aiDevice', cpu.checked ? 'cpu' : 'auto');
        app.toast('Takes effect when the AI runtime next starts (reload the page).');
      });
      await modal({ title: 'AI Device', body: h('div', {}, h('p', {}, tierText(d)), d.reasons.length ? h('p', { class: 'hint' }, `Notes: ${d.reasons.join('; ')}.`) : null, h('p', { class: 'hint' }, `Runtimes: ${[rts.gpu && 'WebGPU', rts.cpu && 'CPU'].filter(Boolean).join(' and ') || 'not started'}; ${d.cores ?? '?'} CPU threads; ${d.memoryGB ? `≥ ${d.memoryGB} GB memory` : 'memory not reported'}.`), h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Model'), h('th', {}, 'Used by'), h('th', {}, 'Status'))), h('tbody', {}, rows)), h('label', { class: 'chk' }, cpu, ' Run the models on the CPU only')), buttons: ['Close'], id: 'lai-device', width: 640 });
    },
  });

  app.aiLocal = { probe, runtime, load, has, job, models, rgbRegion, viewRegion, find, search, buildIndex, match, autoContrast, route, index, get device() { return hw; } };
}
