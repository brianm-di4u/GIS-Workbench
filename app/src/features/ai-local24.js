// Local AI, 2.4 (REQ-GAP-56/57, REQ-LAI-04/05; GR-21): on top of features/ai-local.js
//   - Find objects over the whole scene as a job: OWLv2 tiles with overlap, the reads of the next
//     tiles overlapped with the model run, optional batching of tiles per run, progress and cancel
//     in the Job Queue, results in the detections review queue;
//   - the SAM 2.1 encoder benchmark (the fp16 encoder of the ai-gpu pack on WebGPU);
//   - drafted observations and counts for a box with Moondream2 (vision encoder in the AI runtime,
//     the text decoder in a worker of its own). A draft is a proposal labelled AI-drafted; numbers
//     with units (lengths, areas, heights, speeds) and coordinates are taken out of it (D30): the
//     analyst measures with the tools;
//   - the change mask between the reference and the aligned image (after Auto Align (AI));
//   - user ONNX models (detection, segmentation, pixel classification) under the pack rules
//     (ai/user-models.js), and the shipped land-cover model, run on the view, a box or the scene.
//
// This module is the lazy js-ai24 block (lazy/ai24.lazy.js): features/ai-local.js implements the
// commands and app.aiLocal functions with stubs that load it on first use; its install replaces them.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { pickFiles } from '../storage/files.js';
import { txDone } from '../storage/idb.js';
import { applyAffine, invertAffine } from '../render/renderer.js';
import { nms } from '../workers/ai/image.js';
import { fromParts } from '../vector/geom.js';
import { stripMeasurements, parseCount, vlmPrompt, VLM } from '../workers/ai/vlm.js';
import { BpeTokenizer } from '../ai/bpe-tokenizer.js';
import { validateDescriptor, checkUserModel, LANDCOVER } from '../ai/user-models.js';
import { t, N_, msgOf, gwError } from '../i18n/index.js';
import { num, int, pct } from '../i18n/format.js';

const ID = [0, 1, 0, 0, 0, 1];
const DB = 'gw-models';
const STORE = 'models';

function idb() {
  return new Promise((res, rej) => {
    if (!globalThis.indexedDB) return rej(new Error('IndexedDB is not available'));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  try {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    return await txDone(tx, () => out?.result ?? out);
  } finally {
    db.close();
  }
}

export function installAi24(app, L, { pairOf }) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const targetLayer = (p = pane()) => {
    const l = p?.geoLayer?.() ?? p?.activeLayer?.();
    if (!l?.handle) throw gwError('open an image first', null, 'E_STEP_FIRST');
    return l;
  };

  // ---- tasks: a long AI job made of many worker jobs, shown in the job indicator and queue ----
  const tasks = new Map();
  let taskN = 0;
  function task(label) {
    const k = { id: `aitask-${++taskN}`, label, progress: 0, state: 'running', cancelled: false, current: null };
    k.cancel = () => {
      k.cancelled = true;
      k.current?.cancel?.();
    };
    tasks.set(k.id, k);
    const emit = () => {
      app.pool.emit?.('job', { id: k.id, op: 'ai-task', state: k.state, progress: k.progress, label: k.label });
    };
    k.set = (p) => {
      k.progress = p;
      emit();
    };
    k.end = (state) => {
      k.state = state;
      emit();
      tasks.delete(k.id);
    };
    emit();
    return k;
  }
  app.aiTasks = () => [...tasks.values()].map((k) => ({ id: k.id, op: 'ai-task', label: k.label, progress: k.progress, state: k.state, cancel: k.cancel }));
  /** A pool job on runtime rt that the task can cancel. */
  const taskJob = async (k, op, args, { transfer = [], label, rt = 'cpu', timeout = 900000 } = {}) => {
    if (k.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    const slot = (await L.runtime(rt))?.slot ?? null;
    const pr = app.pool.run(op, args, { kind: 'ai', transfer, timeout, label, affinity: slot });
    k.current = pr;
    try {
      return await pr;
    } finally {
      k.current = null;
    }
  };

  // ---- Find objects over the whole scene (REQ-GAP-56) ----

  /**
   * OWLv2 over every tile of the image (or `region`): tiles of 960 model pixels at `step` image
   * pixels each, overlapping by 10 %, `batch` tiles per model run; the next tiles are read while the
   * model runs. step defaults to 1 (full resolution) and doubles until the scene fits `maxTiles`.
   */
  async function findScene(queries, { layer, region, threshold = 0.15, batch = 1, commit = true, step = null, maxTiles = 400, label } = {}) {
    const q = [...new Set((Array.isArray(queries) ? queries : String(queries).split(/[,;]/)).map((s) => s.trim()).filter(Boolean))].slice(0, 8);
    if (!q.length) throw gwError('name what to look for, for example "aircraft, vehicle"', null, 'E_STEP_FIRST');
    const l = layer ?? targetLayer();
    const m = await L.load('owlv2');
    const tb = m.tokenizer.batch(q.map((s) => `a photo of ${/^(a|an|the)\s/i.test(s) ? s : `a ${s}`}`), 16, 0);
    const R = region ?? { x0: 0, y0: 0, w: l.width, h: l.height };
    const T = m.config?.size?.height ?? 960;
    const B = Math.max(1, Math.min(8, Math.round(batch)));
    let st = step ?? 1;
    const grid = (s) => {
      const side = T * s;
      const stride = Math.max(1, Math.round(side * 0.9));
      const xs = [];
      const ys = [];
      for (let x = 0; x < R.w; x += stride) {
        xs.push(R.x0 + Math.min(x, Math.max(0, R.w - side)));
        if (x + side >= R.w) break;
      }
      for (let y = 0; y < R.h; y += stride) {
        ys.push(R.y0 + Math.min(y, Math.max(0, R.h - side)));
        if (y + side >= R.h) break;
      }
      return { side, cells: ys.flatMap((y) => xs.map((x) => ({ x, y }))) };
    };
    let g = grid(st);
    while (g.cells.length > maxTiles) g = grid((st *= 2));
    const n = g.cells.length;
    const k = task(label ?? t('Find objects in the scene: {objects}', { objects: q.join(', ') }));
    const t0 = performance.now();
    const all = [];
    let ms = 0;
    let device = m.device;
    let batches = 0;
    const read = (c) => L.rgbRegion(l, c.x, c.y, Math.min(g.side, R.x0 + R.w - c.x), Math.min(g.side, R.y0 + R.h - c.y), st);
    try {
      // Reads of batch i + 1 run while batch i is in the model.
      let next = Promise.all(g.cells.slice(0, B).map(read));
      for (let i = 0; i < n; i += B) {
        const wins = await next;
        if (i + B < n) next = Promise.all(g.cells.slice(i + B, i + 2 * B).map(read));
        const r = await taskJob(k, 'owldetectbatch', { tiles: wins.map((w) => ({ rgb: w.rgb, w: w.w, h: w.h })), ids: Array.from(tb.ids, Number), mask: Array.from(tb.mask, Number), nq: tb.n, len: tb.length, threshold, config: m.config }, { transfer: wins.map((w) => w.rgb.buffer), label: t('Find objects (scene): tiles {from}–{to} of {n}', { from: i + 1, to: Math.min(n, i + B), n }), rt: m.rt });
        ms += r.ms;
        device = r.device;
        batches++;
        r.tiles.forEach((boxes, j) => {
          const w = wins[j];
          for (const b of boxes) all.push({ q: b.q, score: b.score, box: [w.x0 + b.box[0] * st, w.y0 + b.box[1] * st, w.x0 + b.box[2] * st, w.y0 + b.box[3] * st] });
        });
        k.set(Math.min(1, (i + B) / n));
      }
    } catch (e) {
      k.end(e.cancelled ? 'cancelled' : 'failed');
      throw e;
    }
    k.end('done');
    const kept = nms(all, 0.3);
    const list = kept.map((d) => ({ cls: q[d.q], confidence: Math.round(d.score * 1000) / 1000, anchor: 'image', ring: [[d.box[0], d.box[1]], [d.box[2], d.box[1]], [d.box[2], d.box[3]], [d.box[0], d.box[3]]], props: { model: m.title, device, prompt: q[d.q], scope: 'scene', step: st } }));
    if (commit && list.length) app.detections.add(list, { layer: l, source: `Find objects (AI, whole scene): ${q.join(', ')}` });
    const counts = Object.fromEntries(q.map((s, i) => [s, kept.filter((d) => d.q === i).length]));
    return { count: list.length, counts, tiles: n, batches, step: st, ms, wallMs: Math.round(performance.now() - t0), device, precision: m.precision, scope: 'scene', job: k.id, detections: list };
  }

  // ---- SAM 2.1 encoder benchmark (REQ-GAP-56 perf) ----

  /** Time the SAM 2.1 encoder on one 1024² window of the image: {times, first, warmMedian, device, precision, adapter}. */
  async function benchmarkSam({ layer, runs = 6 } = {}) {
    const l = layer ?? targetLayer();
    if (!L.has('sam2')) await app.packs.require('ai-sam2', N_('SAM 2.1 smart select'));
    const m = await L.load('sam2');
    const win = await app.sam.rgbWindow(l, l.width / 2, l.height / 2, 1024, false);
    const r = await L.job('sam2bench', { rgb: win.rgb, w: win.w, h: win.h, config: m.config, runs }, { transfer: [win.rgb.buffer], label: t('SAM 2.1 encoder timing'), rt: m.rt, timeout: 600000 });
    const warm = r.times.slice(1).sort((a, b) => a - b);
    let adapter = null;
    try {
      const a = await navigator.gpu?.requestAdapter();
      if (a?.info) adapter = { vendor: a.info.vendor, architecture: a.info.architecture, description: a.info.description, shaderF16: a.features.has('shader-f16') };
    } catch {}
    return { times: r.times, first: r.times[0], warmMedian: warm[Math.floor(warm.length / 2)] ?? r.times[0], device: r.device, precision: m.precision, model: m.title, window: [win.w, win.h, win.step], adapter };
  }

  // ---- drafted observations and counts (REQ-LAI-04, D30) ----

  let tok = null;
  async function tokenizer() {
    if (tok) return tok;
    const p = await app.packs.require('ai-vlm', N_('Draft observation (AI)'));
    const text = (path) => new TextDecoder().decode(p.entries.get(path));
    tok = new BpeTokenizer(JSON.parse(text('moondream2/vocab.json')), text('moondream2/merges.txt'), { ...JSON.parse(text('moondream2/added_tokens.json')), '<|endoftext|>': VLM.bos, '<image>': VLM.image });
    return tok;
  }

  /**
   * Draft an observation (or a count) for an image box with Moondream2 → a proposal. box: image
   * pixels [x0, y0, x1, y1] (default: the view). The model never sets a measurement: numbers with
   * units and coordinates are removed from the draft and listed.
   */
  async function describe({ box, question, count, layer, maxTokens = 96, propose = true } = {}) {
    const p = pane();
    const l = layer ?? targetLayer(p);
    const R = box ? { x0: Math.min(box[0], box[2]), y0: Math.min(box[1], box[3]), w: Math.abs(box[2] - box[0]), h: Math.abs(box[3] - box[1]) } : L.viewRegion(p, l);
    if (R.w < 8 || R.h < 8) throw gwError('the box is too small', null, 'E_STEP_FIRST');
    const vis = await L.load('vlmVision');
    const txt = await L.load('vlmText');
    const tk = await tokenizer();
    const step = Math.max(1, Math.floor(Math.max(R.w, R.h) / 756));
    const win = await L.rgbRegion(l, R.x0, R.y0, R.w, R.h, step);
    // The model's prompts are English (DN-62 rule 8).
    const objects = count ? String(count).trim() : '';
    const q = objects ? `How many ${objects} are in this image? Answer with a number.` : String(question ?? 'Describe this aerial image for an imagery analyst.').slice(0, 400);
    const ids = [VLM.bos, ...tk.encode(vlmPrompt(q))];
    const k = task(t('Draft observation (AI)'));
    let v;
    let r;
    try {
      v = await taskJob(k, 'vlmvision', { rgb: win.rgb, w: win.w, h: win.h, config: vis.config }, { transfer: [win.rgb.buffer], label: t('Draft observation: image'), rt: vis.rt, timeout: 600000 });
      k.set(0.2);
      r = await taskJob(k, 'vlmtext', { features: v.features, dims: v.dims, ids, maxTokens }, { transfer: [v.features.buffer], label: t('Draft observation: text'), rt: 'vlm', timeout: 900000 });
    } catch (e) {
      k.end(e.cancelled ? 'cancelled' : 'failed');
      throw e;
    }
    k.end('done');
    const raw = tk.decode(r.ids).trim();
    const clean = stripMeasurements(raw);
    const n = objects ? parseCount(raw) : null;
    const model = `Moondream2 (${vis.device === 'webgpu' ? 'WebGPU' : 'CPU'} / ${r.decoderDevice === 'webgpu' ? 'WebGPU' : 'CPU'}), on this device`;
    const text = objects ? (n === null ? clean.text : `${n} ${objects}`) : clean.text;
    const g = l.groundAt?.(R.x0 + R.w / 2, R.y0 + R.h / 2);
    let proposal = null;
    if (propose && text) {
      const tool = {
        name: 'lai_draft',
        title: objects ? t('AI draft count') : t('AI draft observation'),
        propose: (a, tx) => {
          tx.create('observation', { text, category: 'other', confidence: 'low', image: l.info?.iid ?? l.rec?.name ?? null, layer: l.id, lat: g?.lat ?? null, lon: g?.lon ?? null, time: l.info?.datetimeIso ?? null, created: new Date().toISOString(), label: N_('AI-drafted'), ai: { model, prompt: q, box: [R.x0, R.y0, R.x0 + R.w, R.y0 + R.h], removedMeasurements: clean.removed, count: n, raw } });
          return { title: objects ? t('AI draft count: {text}', { text }) : t('AI draft observation'), preview: text.slice(0, 300) };
        },
      };
      proposal = app.proposals.create(tool, {}, { source: 'local VLM', connection: 'this device', model }).id;
      app.activeMp()?.docks.show?.('ai');
    }
    return { text, draft: true, model, device: vis.device, decoderDevice: r.decoderDevice, proposal, removedMeasurements: clean.removed, ...(objects ? { count: n } : {}), raw, ms: (v?.ms ?? 0) + r.ms.prefill + r.ms.decode, msParts: { vision: v.ms, prefill: r.ms.prefill, decode: r.ms.decode }, tokens: r.tokens, tokensPerSecond: r.ms.decode > 0 ? Math.round((r.tokens / (r.ms.decode / 1000)) * 10) / 10 : null };
  }

  // ---- change mask (REQ-LAI-05) ----

  // pairOf (features/ai-local.js, eager: the command's enabled test needs it): the reference
  // (bottom visible image) and the aligned (active) image of the panel.
  /**
   * Changes between the reference and the aligned image over their overlap (≤ maxSide cells a
   * side) → change candidates (the change list), the mask as an overlay and, optionally, polygons.
   */
  async function changeMask({ threshold = 2.5, minArea = 64, polygons = false, maxSide = 2048, overlay = true } = {}) {
    const p = pane();
    const { master, slave } = pairOf(p);
    const mA = master.align ?? ID;
    const sA = slave.align ?? ID;
    const corners = (l, A) => [[0, 0], [l.width, 0], [0, l.height], [l.width, l.height]].map(([x, y]) => applyAffine(A, x, y));
    const bx = (c) => [Math.min(...c.map((q) => q.x)), Math.min(...c.map((q) => q.y)), Math.max(...c.map((q) => q.x)), Math.max(...c.map((q) => q.y))];
    const a = bx(corners(master, mA));
    const b = bx(corners(slave, sA));
    const ov = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    if (ov[2] - ov[0] < 32 || ov[3] - ov[1] < 32) throw gwError('the two images do not overlap', null, 'E_NO_OVERLAP');
    const step = Math.max(1, Math.ceil(Math.max(ov[2] - ov[0], ov[3] - ov[1]) / maxSide));
    const W = Math.floor((ov[2] - ov[0]) / step);
    const H = Math.floor((ov[3] - ov[1]) / step);
    const sample = async (l, A) => {
      const inv = invertAffine(A);
      const c = [[ov[0], ov[1]], [ov[2], ov[1]], [ov[0], ov[3]], [ov[2], ov[3]]].map(([x, y]) => applyAffine(inv, x, y));
      const [x0, y0, x1, y1] = bx(c);
      const win = await L.rgbRegion(l, Math.floor(x0) - 2, Math.floor(y0) - 2, Math.ceil(x1 - x0) + 4, Math.ceil(y1 - y0) + 4, step);
      const out = new Uint8Array(W * H);
      const ok = new Uint8Array(W * H);
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const q = applyAffine(inv, ov[0] + (i + 0.5) * step, ov[1] + (j + 0.5) * step);
          const fx = (q.x - win.x0) / win.step - 0.5;
          const fy = (q.y - win.y0) / win.step - 0.5;
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          if (ix < 0 || iy < 0 || ix + 1 >= win.w || iy + 1 >= win.h) continue;
          const tx = fx - ix;
          const ty = fy - iy;
          const g = (xx, yy) => {
            const o = 3 * (yy * win.w + xx);
            return (win.rgb[o] + win.rgb[o + 1] + win.rgb[o + 2]) / 3;
          };
          const v = (g(ix, iy) * (1 - tx) + g(ix + 1, iy) * tx) * (1 - ty) + (g(ix, iy + 1) * (1 - tx) + g(ix + 1, iy + 1) * tx) * ty;
          out[j * W + i] = Math.round(v);
          ok[j * W + i] = 1;
        }
      }
      return { v: out, ok };
    };
    const A = await sample(master, mA);
    const Bs = await sample(slave, sA);
    const valid = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) valid[i] = A.ok[i] && Bs.ok[i] ? 1 : 0;
    const r = await app.pool.run('changemask', { a: A.v, b: Bs.v, w: W, h: H, threshold, minArea: Math.max(1, Math.round(minArea / step ** 2)), valid }, { kind: 'ai', transfer: [A.v.buffer, Bs.v.buffer, valid.buffer], label: t('Change mask'), timeout: 300000 });
    // Cells → reference pixels → reference image pixels (the master image is the change list's image 1).
    const toMaster = invertAffine(mA);
    const cell = (x, y) => applyAffine(toMaster, ov[0] + x * step, ov[1] + y * step);
    const regions = r.regions.slice(0, 500).map((g) => {
      const p0 = cell(g.x0, g.y0);
      const p1 = cell(g.x1, g.y1);
      return { x0: Math.min(p0.x, p1.x), y0: Math.min(p0.y, p1.y), x1: Math.max(p0.x, p1.x), y1: Math.max(p0.y, p1.y), area: g.area * step * step, score: g.score };
    });
    const batchT = new Date().toISOString();
    let layerId = null;
    S.transact(t('Change mask ({n})', { n: regions.length }), (tx) => {
      let gl = p.rec.graphicsLayer;
      if (!gl) {
        gl = tx.create('glayer', { pane: p.id, name: t('Graphics'), visible: true, saved: false });
        tx.set(p.id, 'graphicsLayer', gl);
      }
      regions.forEach((c, i) => {
        const ring = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]].map(([x, y]) => master.groundAt?.(x, y));
        const ground = ring.every(Boolean);
        const gid = tx.create('graphic', { glayer: gl, pane: p.id, shape: 'polygon', anchor: ground ? 'ground' : 'image', coords: ground ? ring.map((g) => [g.lon, g.lat, g.h]) : [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]], text: `CM${i + 1}`, style: { stroke: '#ff00ff', width: 2, fill: '#ff00ff22', dash: 'dashed' }, created: batchT, provenance: { kind: 'change-mask' } });
        tx.create('change', { name: `CM${i + 1}`, status: 'candidate', pane: p.id, graphic: gid, bbox: [c.x0, c.y0, c.x1, c.y1], areaPx: c.area, score: c.score, meanDiff: c.score, image1: { layer: master.id, name: master.rec.name, iid: master.info.iid ?? null, date: master.info.datetime }, image2: { layer: slave.id, name: slave.rec.name, iid: slave.info.iid ?? null, date: slave.info.datetime }, method: { kind: 'change-mask', gain: +r.gain.toFixed(4), offset: +r.offset.toFixed(2), sigma: +r.sigma.toFixed(2), threshold, minArea, step }, created: batchT });
      });
      if (polygons && regions.length) {
        layerId = tx.create('vlayer', { name: t('Change mask — {image}', { image: slave.rec.name }), visible: true, style: { stroke: '#ff00ff', width: 2, fill: '#ff00ff30', outline: '#ff00ff' }, fields: [{ name: 'AREA_PX', type: 'integer' }, { name: 'SCORE', type: 'number' }], source: { format: 'change-mask' }, created: batchT });
        for (const c of regions) {
          const ring = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1], [c.x0, c.y0]].map(([x, y]) => master.groundAt?.(x, y));
          if (ring.some((g) => !g)) continue;
          tx.create('feature', { vlayer: layerId, geom: fromParts('Polygon', [ring.map((g) => [g.lon, g.lat, g.h])]), attrs: { AREA_PX: Math.round(c.area), SCORE: c.score }, name: null, prov: { kind: 'change-mask' } });
        }
      }
    });
    p.invalidate();
    let overlayId = null;
    if (overlay && master.affinity !== undefined && app.openMemoryLayer && step >= 1 && mA === ID) {
      // The mask on the reference image's pixels (only when the reference is not itself warped).
      const labels = new Uint8Array(W * H);
      for (let i = 0; i < W * H; i++) labels[i] = r.mask[i] ? 1 : 0;
      try {
        const P = await app.openMemoryLayer(master, { name: t('Change mask — {image}', { image: slave.rec.name }), bands: 1, sampleType: 'u8', planes: [labels], nodata: 0, x0: Math.round(ov[0]), y0: Math.round(ov[1]), step, width: W, height: H, chain: { stretch: 'none', kernel: 'nearest', colour: { palette: 'grey', table: [[0, 0, 0], [255, 0, 255]] } }, info: { bandsMeta: [{ name: 'change', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: 'change mask', gain: null, offset: null, unit: 'class', source: 'change mask' } } });
        overlayId = P?.id ?? null;
      } catch (e) {
        app.log?.('info', `change mask overlay: ${e.message}`);
      }
    }
    return { changedFraction: r.changedFraction, regions: regions.length, threshold, sigma: r.sigma, gain: r.gain, offset: r.offset, mask: { width: W, height: H, step }, layer: layerId, overlay: overlayId, candidates: regions.length, regionList: regions };
  }

  // ---- user models (REQ-GAP-57) and the land-cover pack model ----

  const users = new Map(); // id → {descriptor, blob, info}
  const restored = idbDo('readonly', (s) => s.getAll())
    .then((rows) => {
      for (const r of rows ?? []) {
        try {
          users.set(r.id, { descriptor: validateDescriptor(r.descriptor), blob: r.blob, added: r.added });
        } catch (e) {
          app.log?.('warn', `user model ${r.id}: ${e.message}`);
        }
      }
    })
    .catch(() => {});

  const shipped = () => (L.hasPack('ai-landcover') ? [{ id: LANDCOVER.id, title: LANDCOVER.name, task: LANDCOVER.task, source: 'pack', licence: LANDCOVER.licence.spdx.join(' AND '), sha256: app.packs.known('ai-landcover')?.entries?.['landcover/model.onnx']?.sha256 ?? null, input: LANDCOVER.input, classes: LANDCOVER.classes }] : []);
  function modelList() {
    return [...shipped(), ...[...users.values()].map((u) => ({ id: u.descriptor.id, title: u.descriptor.name, task: u.descriptor.task, source: 'user', licence: u.descriptor.licence.spdx.join(' AND '), sha256: u.descriptor.sha256, input: u.descriptor.input, classes: u.descriptor.classes }))];
  }

  /** Add a user model: descriptor (object or JSON text) and the .onnx File/Blob/bytes, checked by the gate. */
  async function addUserModel(descriptor, file) {
    const d = typeof descriptor === 'string' ? JSON.parse(descriptor, (k, v) => (k === '__proto__' || k === 'constructor' ? undefined : v)) : descriptor;
    const bytes = file instanceof Uint8Array ? file : new Uint8Array(await (file.arrayBuffer ? file.arrayBuffer() : file));
    const ok = await checkUserModel(d, bytes);
    if (ok.descriptor.id === LANDCOVER.id) throw gwError('the model id {id} belongs to a shipped model', { id: ok.descriptor.id }, 'E_MODEL_DESCRIPTOR');
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    users.set(ok.descriptor.id, { descriptor: ok.descriptor, blob, info: ok.info, added: new Date().toISOString() });
    loaded.delete(ok.descriptor.id);
    try {
      await idbDo('readwrite', (s) => s.put({ id: ok.descriptor.id, descriptor: ok.descriptor, blob, added: new Date().toISOString() }));
    } catch (e) {
      app.log?.('info', `user model ${ok.descriptor.id} is kept for this session only (${e.message})`);
    }
    app.emit('state');
    return modelList().find((x) => x.id === ok.descriptor.id);
  }
  async function removeUserModel(id) {
    users.delete(id);
    loaded.delete(id);
    try {
      await idbDo('readwrite', (s) => s.delete(id));
    } catch {}
  }

  const loaded = new Map(); // id → Promise<{key, rt, device, spec}>
  async function loadModel(id) {
    await restored;
    if (id === LANDCOVER.id) {
      const m = await L.load('landcover');
      return { key: 'landcover', rt: m.rt, device: m.device, spec: LANDCOVER, title: LANDCOVER.name };
    }
    const u = users.get(id);
    if (!u) throw gwError('no model {id}; add it with AI Models', { id: String(id) }, 'E_NO_MODEL');
    if (!loaded.has(id)) {
      loaded.set(
        id,
        (async () => {
          // The hash is checked again on every load, as for packs.
          const bytes = new Uint8Array(await u.blob.arrayBuffer());
          const ok = await checkUserModel(u.descriptor, bytes);
          await app.packs.require('ai', N_('Local AI'));
          const rt = (await L.gpuOk()) ? 'gpu' : 'cpu';
          await L.runtime(rt);
          const model = bytes.slice().buffer;
          const r = await L.job('aiload', { key: `user:${id}`, model }, { transfer: [model], label: t('AI load {model}', { model: u.descriptor.name }), timeout: 600000, rt });
          return { key: `user:${id}`, rt, device: r.device, spec: ok.descriptor, title: u.descriptor.name };
        })().catch((e) => {
          loaded.delete(id);
          throw e;
        }),
      );
    }
    return loaded.get(id);
  }

  /**
   * Run a model on the view, a box or the whole scene → detections in the review queue, or a
   * class overlay (memory layer on the image) with per-class pixel counts.
   */
  async function runModel(id, { scope = 'view', box, layer, threshold, maxTiles = 64, commit = true } = {}) {
    const p = pane();
    const l = layer ?? targetLayer(p);
    const m = await loadModel(id);
    const spec = Number.isFinite(threshold) ? { ...m.spec, threshold } : m.spec;
    const [TH, TW] = spec.input.size;
    let R;
    if (scope === 'box') {
      if (!Array.isArray(box) || box.length !== 4) throw gwError('give the box as [x0, y0, x1, y1] image pixels', null, 'E_API_ARGS');
      R = { x0: Math.max(0, Math.min(box[0], box[2])), y0: Math.max(0, Math.min(box[1], box[3])), w: Math.abs(box[2] - box[0]), h: Math.abs(box[3] - box[1]) };
    } else if (scope === 'scene') R = { x0: 0, y0: 0, w: l.width, h: l.height };
    else R = L.viewRegion(p, l);
    let step = scope === 'view' ? Math.max(1, Math.floor(1 / (p?.view?.zoom ?? 1))) : 1;
    const tiles = () => Math.ceil(R.w / (TW * step)) * Math.ceil(R.h / (TH * step));
    while (tiles() > maxTiles) step *= 2;
    const nx = Math.ceil(R.w / (TW * step));
    const ny = Math.ceil(R.h / (TH * step));
    const k = task(t('Run model: {model}', { model: m.title }));
    const dets = [];
    let ms = 0;
    let device = m.device;
    const W = Math.ceil(R.w / step);
    const H = Math.ceil(R.h / step);
    const classes = spec.task === 'detection' ? null : new Uint8Array(W * H);
    const counts = new Array(spec.classes.length).fill(0);
    try {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const win = await L.rgbRegion(l, R.x0 + i * TW * step, R.y0 + j * TH * step, Math.min(TW * step, R.w - i * TW * step), Math.min(TH * step, R.h - j * TH * step), step);
          const r = await taskJob(k, 'modelrun', { key: m.key, rgb: win.rgb, w: win.w, h: win.h, spec }, { transfer: [win.rgb.buffer], label: t('Run model: tile {i}/{n}', { i: j * nx + i + 1, n: nx * ny }), rt: m.rt });
          ms += r.ms;
          device = r.device;
          if (r.boxes) for (const b of r.boxes) dets.push({ q: b.q, cls: b.cls, score: b.score, box: [win.x0 + b.box[0] * step, win.y0 + b.box[1] * step, win.x0 + b.box[2] * step, win.y0 + b.box[3] * step] });
          if (r.classes) {
            const ox = Math.round((win.x0 - R.x0) / step);
            const oy = Math.round((win.y0 - R.y0) / step);
            for (let y = 0; y < r.h && oy + y < H; y++) for (let x = 0; x < r.w && ox + x < W; x++) classes[(oy + y) * W + ox + x] = r.classes[y * r.w + x] + 1;
            r.counts.forEach((c, q) => q < counts.length && (counts[q] += c));
          }
          k.set((j * nx + i + 1) / (nx * ny));
        }
      }
    } catch (e) {
      k.end(e.cancelled ? 'cancelled' : 'failed');
      throw e;
    }
    k.end('done');
    const out = { model: id, task: spec.task, device, ms, tiles: nx * ny, step };
    const prov = { model: `${m.title}, on this device`, device, scope };
    if (spec.task === 'detection') {
      const kept = nms(dets, 0.45);
      if (commit && kept.length) app.detections.add(kept.map((d) => ({ cls: d.cls, confidence: d.score, anchor: 'image', ring: [[d.box[0], d.box[1]], [d.box[2], d.box[1]], [d.box[2], d.box[3]], [d.box[0], d.box[3]]], props: prov })), { layer: l, source: `Run model: ${m.title}` });
      out.detections = kept.length;
    } else {
      out.classes = Object.fromEntries(spec.classes.map((c, q) => [c, counts[q]]));
      if (commit && app.openMemoryLayer) {
        const colours = spec.classes.map((_, q) => spec.colors?.[q] ?? [((q * 97) % 200) + 55, ((q * 57) % 200) + 55, ((q * 151) % 200) + 55]);
        const P = await app.openMemoryLayer(l, { name: t('{model} — {image}', { model: m.title, image: l.rec?.name ?? '' }), bands: 1, sampleType: 'u8', planes: [classes], nodata: 0, x0: R.x0, y0: R.y0, step, width: W, height: H, chain: { stretch: 'none', kernel: 'nearest', colour: { palette: 'grey', table: [[0, 0, 0], ...colours] } }, info: { bandsMeta: [{ name: 'class', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: 'class labels', gain: null, offset: null, unit: 'class', source: m.title }, classes: spec.classes } });
        out.layer = P?.id ?? null;
      }
    }
    return out;
  }

  Object.assign(L, { findScene, benchmarkSam, describe, changeMask, modelList, addUserModel, removeUserModel, runModel, loadModel, tasks: app.aiTasks, users });

  // ---- commands ----
  const busy = (label, fn) => async () => {
    try {
      await fn();
    } catch (e) {
      if (e?.cancelled) return app.toast(t('{action}: cancelled', { action: label }), { kind: 'info' });
      app.toast(t('{action}: {msg}', { action: label, msg: msgOf(e) }), { kind: e?.code === 'E_STEP_FIRST' || e?.code === 'E_PACK_REQUIRED' ? 'warn' : 'error', ms: 9000 });
    }
  };
  const hasImage = () => !!(pane()?.geoLayer?.() ?? pane()?.activeLayer?.())?.handle;
  const OK = (label) => [{ label, value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }];

  C.implement('lai.findscene', {
    enabled: hasImage,
    run: busy(t('Find objects in the scene'), async () => {
      const inp = h('input', { class: 'inp', value: app.prefs.get('aiFindLast') ?? 'aircraft, vehicle', 'aria-label': t('What to find (comma-separated)'), 'data-id': 'lai-findscene:text', style: { width: '100%' } });
      const bt = h('input', { class: 'inp inp-num', type: 'number', min: '1', max: '8', step: '1', value: String(app.prefs.get('aiSceneBatch') ?? 1), 'aria-label': t('Tiles per model run'), 'data-id': 'lai-findscene:batch' });
      const l = targetLayer();
      const est = Math.ceil(l.width / 864) * Math.ceil(l.height / 864);
      const r = await modal({ title: t('Find Objects in the Whole Scene (AI)'), body: h('div', {}, field(t('What to find (comma-separated)'), inp), field(t('Tiles per model run'), bt, t('1 is fastest on most graphics cards; more tiles per run use more memory.')), h('p', { class: 'hint' }, t('About {n, plural, one {# tile} other {# tiles}} at full resolution; the job runs in the background (Job Queue) and the results go to the detections review queue.', { n: Math.min(est, 400) }))), buttons: OK(t('Run')), id: 'lai-findscene' });
      if (r !== 'run' || !inp.value.trim()) return;
      app.prefs.set('aiFindLast', inp.value.trim());
      app.prefs.set('aiSceneBatch', Math.max(1, Math.min(8, Number(bt.value) || 1)));
      app.toast(t('Finding {query} in the whole scene…', { query: inp.value.trim() }), { kind: 'info' });
      const res = await findScene(inp.value, { batch: Number(bt.value) || 1 });
      app.activeMp()?.docks.show('detections');
      app.toast(t('Find objects (scene): {found} in {tiles, plural, one {# tile} other {# tiles}} ({s} s) — review them in the queue.', { found: Object.entries(res.counts).map(([kk, n]) => `${int(n)} ${kk}`).join(', '), tiles: res.tiles, s: num(res.wallMs / 1000, 1) }), { kind: 'info', ms: 9000 });
    }),
  });

  C.implement('lai.describe', {
    enabled: hasImage,
    run: busy(t('Draft observation'), async () => {
      const mode = h('select', { class: 'inp', 'aria-label': t('Draft'), 'data-id': 'lai-describe:mode' }, h('option', { value: 'describe' }, t('Describe what is in the box')), h('option', { value: 'count' }, t('Count objects in the box')));
      const what = h('input', { class: 'inp', value: app.prefs.get('aiCountLast') ?? 'cars', 'aria-label': t('Objects to count'), 'data-id': 'lai-describe:count' });
      const aoi = app.aoiBox?.(pane(), targetLayer());
      const r = await modal({ title: t('Draft Observation (AI)'), body: h('div', {}, field(t('Draft'), mode), field(t('Objects to count'), what), h('p', { class: 'hint' }, aoi ? t('The box is the AOI.') : t('The box is the view; draw an AOI to draft about a smaller box.')), h('p', { class: 'hint' }, t('Moondream2 runs on this device. The draft goes to AI Assistant ▸ Proposals, labelled AI-drafted; any measurement it writes is taken out, measure with the tools.'))), buttons: OK(t('Draft')), id: 'lai-describe' });
      if (r !== 'run') return;
      const box = aoi ? [aoi.x0, aoi.y0, aoi.x1, aoi.y1] : undefined;
      if (mode.value === 'count') app.prefs.set('aiCountLast', what.value.trim());
      app.toast(t('Drafting with Moondream2 on this device…'), { kind: 'info' });
      const res = await describe({ box, count: mode.value === 'count' ? what.value.trim() || 'objects' : undefined });
      app.toast(res.removedMeasurements.length ? t('AI draft ready in Proposals; {n, plural, one {# measurement was} other {# measurements were}} taken out of it.', { n: res.removedMeasurements.length }) : t('AI draft ready in Proposals: accept it to keep it.'), { kind: 'info', ms: 8000 });
    }),
  });

  C.implement('lai.changemask', {
    enabled: () => {
      try {
        pairOf();
        return true;
      } catch {
        return false;
      }
    },
    run: busy(t('Change mask'), async () => {
      const th = h('input', { class: 'inp inp-num', type: 'number', min: '0.5', max: '10', step: '0.1', value: '2.5', 'aria-label': t('Threshold (robust standard deviations)'), 'data-id': 'lai-changemask:k' });
      const ma = h('input', { class: 'inp inp-num', type: 'number', min: '0', step: '1', value: '64', 'aria-label': t('Smallest change (pixels)'), 'data-id': 'lai-changemask:min' });
      const pg = h('input', { type: 'checkbox', 'aria-label': t('Also add the changes as a vector layer'), 'data-id': 'lai-changemask:polygons' });
      const r = await modal({ title: t('Change Mask'), body: h('div', {}, h('p', { class: 'hint' }, t('Run Auto Align (AI) first: the mask compares the aligned image with the reference, after matching their brightness and allowing one pixel of misregistration.')), field(t('Threshold (robust standard deviations)'), th), field(t('Smallest change (pixels)'), ma), h('label', { class: 'chk' }, pg, ' ', t('Also add the changes as a vector layer'))), buttons: OK(t('Run')), id: 'lai-changemask' });
      if (r !== 'run') return;
      const res = await changeMask({ threshold: Number(th.value) || 2.5, minArea: Number(ma.value) || 0, polygons: pg.checked });
      app.toast(t('Change mask: {n, plural, one {# change} other {# changes}} ({share} of the overlap); they are in the change list.', { n: res.regions, share: pct(res.changedFraction, 1) }), { kind: 'info', ms: 8000 });
    }),
  });

  async function addDialog() {
    const files = await pickFiles(app, { multiple: true, accept: ['.json', '.onnx'], description: t('Model descriptor (.json) and model (.onnx)') });
    if (!files.length) return null;
    const dj = files.find((f) => /\.json$/i.test(f.name));
    const ox = files.find((f) => /\.onnx$/i.test(f.name));
    if (!dj || !ox) throw gwError('choose the descriptor (.json) and the model (.onnx) together', null, 'E_STEP_FIRST');
    return addUserModel(await dj.text(), ox);
  }

  C.implement('lai.models', {
    run: busy(t('AI Models'), async () => {
      await restored;
      for (;;) {
        const list = modelList();
        const rows = list.map((x) => {
          const run = h('button', { class: 'btn', style: { minHeight: '24px' }, 'data-id': `lai-models:run:${x.id}`, disabled: !hasImage() }, t('Run on the view'));
          run.addEventListener('click', () => {
            document.querySelector('[data-id="dialog:lai-models"]')?.finish?.('close');
            busy(t('Run model'), async () => {
              const res = await runModel(x.id, { scope: 'view' });
              app.toast(res.task === 'detection' ? t('{model}: {n, plural, one {# detection} other {# detections}} — review them in the queue.', { model: x.title, n: res.detections }) : t('{model}: the class map is open as a layer ({tiles, plural, one {# tile} other {# tiles}}).', { model: x.title, tiles: res.tiles }), { kind: 'info', ms: 8000 });
            })();
          });
          let rm = '';
          if (x.source === 'user') {
            rm = h('button', { class: 'btn', style: { minHeight: '24px', marginInlineStart: '8px' }, 'data-id': `lai-models:remove:${x.id}` }, t('Remove'));
            rm.addEventListener('click', () => removeUserModel(x.id).then(() => rm.closest('tr')?.remove()));
          }
          const task = { detection: t('detection'), segmentation: t('segmentation'), classification: t('pixel classification') }[x.task];
          return h('tr', {}, h('td', {}, x.title), h('td', {}, task), h('td', {}, x.source === 'pack' ? t('data pack') : t('added by you')), h('td', { class: 'mono small' }, x.licence), h('td', { class: 'mono small', title: x.sha256 ?? '' }, (x.sha256 ?? '').slice(0, 12)), h('td', { style: { whiteSpace: 'nowrap' } }, run, rm));
        });
        const tbl = list.length ? h('table', { class: 'tbl', 'aria-label': t('AI models') }, h('thead', {}, h('tr', {}, [t('Model'), t('Task'), t('Source'), t('Licence'), t('SHA-256'), ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows)) : h('p', { class: 'hint' }, t('No models yet: load the ai-landcover pack, or add your own ONNX model.'));
        const r = await modal({ title: t('AI Models'), body: h('div', {}, tbl, h('p', { class: 'hint' }, t('Add… takes a gw-model/1 descriptor (task, input spec, output format, classes, SPDX licence, SHA-256) and its .onnx file. The file must match the hash, the licence must be MIT, Apache-2.0, BSD or ISC, and only standard ONNX operators run.'))), buttons: [{ label: t('Add…'), value: 'add', primary: true }, { label: t('Close'), value: 'close' }], id: 'lai-models', width: 760 });
        if (r !== 'add') return;
        try {
          const m = await addDialog();
          if (m) app.toast(t('Model {name} added (SHA-256 and licence checked).', { name: m.title }), { kind: 'info' });
        } catch (e) {
          app.toast(t('The model was refused: {msg}', { msg: msgOf(e) }), { kind: 'error', ms: 12000 });
        }
      }
    }),
  });

  C.implement('lai.landcover', {
    enabled: hasImage,
    run: busy(t('Land cover (AI)'), async () => {
      app.toast(t('Classifying land cover in view on this device…'), { kind: 'info' });
      const res = await runModel(LANDCOVER.id, { scope: 'view' });
      const total = Object.values(res.classes).reduce((s, v) => s + v, 0) || 1;
      const top = Object.entries(res.classes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, v]) => `${c} ${pct(v / total, 0)}`);
      app.toast(t('Land cover: {classes}. The class map is open as a layer.', { classes: top.join(', ') }), { kind: 'info', ms: 8000 });
    }),
  });

  C.implement('lai.benchmark', {
    enabled: hasImage,
    run: busy(t('AI timing'), async () => {
      const r = await benchmarkSam();
      app.toast(t('SAM 2.1 encoder ({precision}, {device}): {ms} ms per 1024² window after the first run ({first} ms).', { precision: r.precision, device: r.device === 'webgpu' ? 'WebGPU' : 'CPU', ms: int(r.warmMedian), first: int(r.first) }), { kind: 'info', ms: 10000 });
    }),
  });
}
