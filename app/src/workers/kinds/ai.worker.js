// Local AI worker (REQ-EXT-18, REQ-AI-18, REQ-LAI-01..06): onnxruntime-web from the AI data pack
// runs the models of the model packs on this device. The runtime script comes from the pool
// (bytes verified against the build manifest); its glue runs from a Blob URL and its WASM binary
// is passed in memory, single threaded, without proxy workers. With a WebGPU adapter the WebGPU
// build is used and each session asks for the WebGPU execution provider first, falling back to
// WASM for whatever WebGPU cannot run. Nothing leaves the device.
//
// Models: SlimSAM and SAM 2.1 (click/box → mask), OWLv2 (text queries → boxes), CLIP ViT-B/32
// (chips and text → embeddings) and DISK + LightGlue (two images → matched keypoints).
// Pre/post-processing follows the Hugging Face processors of each model (preprocessor_config.json
// in the packs).

import { toPlanes, maskFromLogits, nms } from '../ai/image.js';

const { GW } = self;
let ort = null;
let device = 'wasm';
const sessions = new Map(); // key → {s, device}
const embeds = new Map(); // id → {kind, …}
let nextEmbed = 1;

const keep = (id, e) => {
  embeds.set(id, e);
  while (embeds.size > 4) embeds.delete(embeds.keys().next().value);
};
const sess = (key) => {
  const s = sessions.get(key);
  if (!s) throw new Error(`the ${key} model is not loaded in this worker`);
  return s.s;
};

/** Load the runtime once: lib 'ort' (WASM) or 'ortgpu' (WebGPU build), glue and WASM binary from the pack. */
GW.register('ortinit', async ({ lib, glue, wasm, gpu }) => {
  if (ort) return { device, cached: true };
  await GW.lib(lib);
  const o = self.ort;
  o.env.wasm.numThreads = 1;
  o.env.wasm.proxy = false;
  o.env.wasm.wasmBinary = new Uint8Array(wasm);
  o.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([glue], { type: 'text/javascript' })) };
  ort = o;
  device = gpu ? 'webgpu' : 'wasm';
  return { device };
});

/** One session: model bytes plus any external-data files ({path, data}). */
GW.register('aiload', async ({ key, model, external, cpu }) => {
  if (!ort) throw new Error('the AI runtime is not loaded in this worker');
  if (sessions.has(key)) return { cached: true, device: sessions.get(key).device };
  const opt = { graphOptimizationLevel: 'all', executionProviders: device === 'webgpu' && !cpu ? ['webgpu', 'wasm'] : ['wasm'] };
  if (external?.length) opt.externalData = external.map((e) => ({ path: e.path, data: new Uint8Array(e.data) }));
  let s;
  let used = opt.executionProviders[0];
  try {
    s = await ort.InferenceSession.create(new Uint8Array(model), opt);
  } catch (e) {
    if (used !== 'webgpu') throw e;
    opt.executionProviders = ['wasm'];
    used = 'wasm';
    s = await ort.InferenceSession.create(new Uint8Array(model), opt);
  }
  sessions.set(key, { s, device: used });
  return { device: used, inputs: s.inputNames, outputs: s.outputNames };
});

// ---- SlimSAM: longest edge 1024, zero pad to 1024² ----

/** RGB (w × h × 3, u8) → image embeddings kept in the worker; returns their id. */
GW.register('samembed', async ({ rgb, w, h, config }, job) => {
  const enc = sess('slimsam-enc');
  const S = config?.size?.longest_edge ?? 1024;
  const P = config?.pad_size?.height ?? 1024;
  const scale = S / Math.max(w, h);
  const px = toPlanes(rgb, w, h, { W: P, H: P, rw: Math.round(w * scale), rh: Math.round(h * scale), mean: config?.image_mean ?? [0.485, 0.456, 0.406], std: config?.image_std ?? [0.229, 0.224, 0.225] });
  job.progress(0.1);
  const t0 = performance.now();
  const out = await enc.run({ pixel_values: new ort.Tensor('float32', px, [1, 3, P, P]) });
  const id = nextEmbed++;
  keep(id, { kind: 'slimsam', emb: out.image_embeddings, pos: out.image_positional_embeddings, w, h, sx: scale, sy: scale, P });
  return { id, ms: Math.round(performance.now() - t0), scale };
});

// ---- SAM 2.1: stretched to 1024², three feature levels ----

GW.register('sam2embed', async ({ rgb, w, h, config }, job) => {
  const enc = sess('sam2-enc');
  const S = config?.size?.height ?? 1024;
  const px = toPlanes(rgb, w, h, { W: S, H: S, mean: config?.image_mean ?? [0.485, 0.456, 0.406], std: config?.image_std ?? [0.229, 0.224, 0.225] });
  job.progress(0.1);
  const t0 = performance.now();
  const out = await enc.run({ pixel_values: new ort.Tensor('float32', px, [1, 3, S, S]) });
  const id = nextEmbed++;
  keep(id, { kind: 'sam2', e0: out['image_embeddings.0'], e1: out['image_embeddings.1'], e2: out['image_embeddings.2'], w, h, sx: S / w, sy: S / h, P: S });
  return { id, ms: Math.round(performance.now() - t0) };
});

/** Point prompts [[x, y, label 1|0], …] (and an optional box) in window pixels → mask (u8, w × h) and its IoU score. */
GW.register('samdecode', async ({ id, points, box, prefer = 'best' }) => {
  const e = embeds.get(id);
  if (!e) throw new Error('no image embedding: run the encoder first');
  const n = points.length;
  const pts = new Float32Array(2 * n);
  const lab = new BigInt64Array(n);
  points.forEach(([x, y, l], i) => {
    pts[2 * i] = x * e.sx;
    pts[2 * i + 1] = y * e.sy;
    lab[i] = BigInt(l ?? 1);
  });
  const t0 = performance.now();
  let out;
  if (e.kind === 'sam2') {
    const bx = box ? new Float32Array([box[0] * e.sx, box[1] * e.sy, box[2] * e.sx, box[3] * e.sy]) : new Float32Array(0);
    out = await sess('sam2-dec').run({ input_points: new ort.Tensor('float32', pts, [1, 1, n, 2]), input_labels: new ort.Tensor('int64', lab, [1, 1, n]), input_boxes: new ort.Tensor('float32', bx, [1, box ? 1 : 0, 4]), 'image_embeddings.0': e.e0, 'image_embeddings.1': e.e1, 'image_embeddings.2': e.e2 });
  } else {
    out = await sess('slimsam-dec').run({ input_points: new ort.Tensor('float32', pts, [1, 1, n, 2]), input_labels: new ort.Tensor('int64', lab, [1, 1, n]), image_embeddings: e.emb, image_positional_embeddings: e.pos });
  }
  const iou = out.iou_scores.data;
  const dims = out.pred_masks.dims; // [1, 1, 3, 256, 256]
  const K = dims[2];
  const M = dims[3];
  let best = 0;
  for (let k = 1; k < K; k++) if (iou[k] > iou[best]) best = k;
  if (prefer === 'whole') {
    // A click on a roof often scores one facet highest; for a whole object (a building) take the
    // largest of the masks that score within 0.15 of the best.
    const area = (k) => {
      let n = 0;
      const d = out.pred_masks.data;
      for (let i = k * M * M; i < (k + 1) * M * M; i++) if (d[i] > 0) n++;
      return n;
    };
    let big = area(best);
    for (let k = 0; k < K; k++) {
      const a = k === best ? 0 : iou[k] >= iou[best] - 0.15 ? area(k) : 0;
      if (a > big) [big, best] = [a, k];
    }
  }
  const logits = out.pred_masks.data.subarray(best * M * M, (best + 1) * M * M);
  // Window pixel → model square → M² logits. SlimSAM pads, so its square is P wide at scale sx.
  const { mask, area } = maskFromLogits(logits, M, e.w, e.h, (M / e.P) * e.sx, (M / e.P) * e.sy);
  const object = out.object_score_logits ? out.object_score_logits.data[0] : null;
  return GW.transfer({ mask, w: e.w, h: e.h, iou: iou[best], scores: Array.from(iou), area, object, ms: Math.round(performance.now() - t0) }, [mask.buffer]);
});

// ---- OWLv2: pad to a square (grey), 960², text queries ----

/** RGB window + tokenised queries → boxes [{q, score, box: [x0, y0, x1, y1]}] in window pixels. */
GW.register('owldetect', async ({ rgb, w, h, ids, mask, nq, len, threshold = 0.1, config }, job) => {
  const s = sess('owlv2');
  const S = config?.size?.height ?? 960;
  const scale = S / Math.max(w, h);
  const px = toPlanes(rgb, w, h, { W: S, H: S, rw: Math.round(w * scale), rh: Math.round(h * scale), mean: config?.image_mean, std: config?.image_std, pad: 0.5 });
  job.progress(0.1);
  const t0 = performance.now();
  const out = await s.run({ pixel_values: new ort.Tensor('float32', px, [1, 3, S, S]), input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [nq, len]), attention_mask: new ort.Tensor('int64', BigInt64Array.from(mask, BigInt), [nq, len]) });
  const L = out.logits.data;
  const B = out.pred_boxes.data;
  const N = out.pred_boxes.dims[1];
  const hits = [];
  for (let i = 0; i < N; i++) {
    for (let q = 0; q < nq; q++) {
      const p = 1 / (1 + Math.exp(-L[i * nq + q]));
      if (p < threshold) continue;
      const [cx, cy, bw, bh] = [B[4 * i], B[4 * i + 1], B[4 * i + 2], B[4 * i + 3]].map((v) => (v * S) / scale);
      const box = [Math.max(0, cx - bw / 2), Math.max(0, cy - bh / 2), Math.min(w, cx + bw / 2), Math.min(h, cy + bh / 2)];
      if (box[2] - box[0] >= 1 && box[3] - box[1] >= 1) hits.push({ q, score: p, box });
    }
  }
  return { boxes: nms(hits, 0.3), ms: Math.round(performance.now() - t0) };
});

// ---- CLIP ViT-B/32: 224² chips and text → unit embeddings ----

GW.register('clipimage', async ({ chips, n, size = 224, config }, job) => {
  const s = sess('clip-vision');
  const D = 512;
  const out = new Float32Array(n * D);
  const B = 16;
  for (let i = 0; i < n; i += B) {
    const m = Math.min(B, n - i);
    const px = new Float32Array(m * 3 * size * size);
    for (let k = 0; k < m; k++) px.set(toPlanes(chips.subarray((i + k) * size * size * 3, (i + k + 1) * size * size * 3), size, size, { W: 224, H: 224, mean: config?.image_mean, std: config?.image_std }), k * 3 * 224 * 224);
    const r = await s.run({ pixel_values: new ort.Tensor('float32', px, [m, 3, 224, 224]) });
    const e = r.image_embeds.data;
    for (let k = 0; k < m; k++) {
      const v = e.subarray(k * D, (k + 1) * D);
      const nn = Math.hypot(...v) || 1;
      for (let j = 0; j < D; j++) out[(i + k) * D + j] = v[j] / nn;
    }
    job.progress((i + m) / n);
  }
  return GW.transfer({ emb: out, n, dim: D }, [out.buffer]);
});

GW.register('cliptext', async ({ ids }) => {
  const s = sess('clip-text');
  const r = await s.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]) });
  const v = Float32Array.from(r.text_embeds.data);
  const nn = Math.hypot(...v) || 1;
  for (let j = 0; j < v.length; j++) v[j] /= nn;
  return GW.transfer({ emb: v }, [v.buffer]);
});

// ---- DISK + LightGlue: two same-size RGB windows → matched keypoints ----

GW.register('lgmatch', async ({ a, b, w, h }, job) => {
  const s = sess('lightglue');
  const px = new Float32Array(2 * 3 * w * h);
  [a, b].forEach((rgb, k) => {
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) px[k * 3 * w * h + c * w * h + i] = rgb[3 * i + c] / 255;
  });
  job.progress(0.1);
  const t0 = performance.now();
  const out = await s.run({ images: new ort.Tensor('float32', px, [2, 3, h, w]) });
  const K = out.keypoints.data;
  const nk = out.keypoints.dims[1];
  const M = out.matches.data;
  const n = out.matches.dims[0];
  const pairs = new Float32Array(5 * n); // x0, y0, x1, y1, score
  for (let i = 0; i < n; i++) {
    const i0 = Number(M[3 * i + 1]);
    const i1 = Number(M[3 * i + 2]);
    pairs[5 * i] = Number(K[2 * i0]);
    pairs[5 * i + 1] = Number(K[2 * i0 + 1]);
    pairs[5 * i + 2] = Number(K[2 * nk + 2 * i1]);
    pairs[5 * i + 3] = Number(K[2 * nk + 2 * i1 + 1]);
    pairs[5 * i + 4] = out.mscores.data[i];
  }
  return GW.transfer({ pairs, n, ms: Math.round(performance.now() - t0) }, [pairs.buffer]);
});
