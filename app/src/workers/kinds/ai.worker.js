// Local AI worker (REQ-EXT-18, REQ-AI-18): SlimSAM segmentation through onnxruntime-web from the
// AI data pack. The runtime script comes from the pool (bytes verified against the build
// manifest); its WASM glue runs from a Blob URL and its WASM binary is passed in memory, single
// threaded, without proxy workers. Nothing leaves the device.
//
// Pre/post-processing follows the Hugging Face SamProcessor (preprocessor_config.json in the
// pack): longest edge resized to 1024 (bilinear), rescale 1/255, ImageNet mean/std, zero pad to
// 1024²; point prompts in resized coordinates; the 256² mask logits are sampled back to the
// original pixels (bilinear) and thresholded at 0.

const { GW } = self;
let sessions = null;
const embeds = new Map(); // id → {emb, pos, w, h, scale}
let nextEmbed = 1;

GW.register('samload', async ({ glue, wasm, encoder, decoder, config }) => {
  if (sessions) return { ready: true, cached: true };
  await GW.lib('ort');
  const ort = self.ort;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmBinary = new Uint8Array(wasm);
  ort.env.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([glue], { type: 'text/javascript' })) };
  const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const enc = await ort.InferenceSession.create(new Uint8Array(encoder), opt);
  const dec = await ort.InferenceSession.create(new Uint8Array(decoder), opt);
  sessions = { ort, enc, dec, cfg: config ? JSON.parse(new TextDecoder().decode(config)) : {} };
  return { ready: true, inputs: [enc.inputNames, dec.inputNames] };
});

/** RGB (w × h × 3, u8) → image embeddings kept in the worker; returns their id. */
GW.register('samembed', async ({ rgb, w, h }, job) => {
  if (!sessions) throw new Error('the AI pack is not loaded in this worker');
  const { ort, enc, cfg } = sessions;
  const S = cfg.size?.longest_edge ?? 1024;
  const P = cfg.pad_size?.height ?? 1024;
  const mean = cfg.image_mean ?? [0.485, 0.456, 0.406];
  const std = cfg.image_std ?? [0.229, 0.224, 0.225];
  const scale = S / Math.max(w, h);
  const rw = Math.round(w * scale);
  const rh = Math.round(h * scale);
  const px = new Float32Array(3 * P * P);
  for (let y = 0; y < rh; y++) {
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) / scale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < rw; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) / scale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const a = rgb[3 * (y0 * w + x0) + c] * (1 - tx) + rgb[3 * (y0 * w + x1) + c] * tx;
        const b = rgb[3 * (y1 * w + x0) + c] * (1 - tx) + rgb[3 * (y1 * w + x1) + c] * tx;
        px[c * P * P + y * P + x] = ((a * (1 - ty) + b * ty) / 255 - mean[c]) / std[c];
      }
    }
  }
  job.progress(0.1);
  const t0 = performance.now();
  const out = await enc.run({ pixel_values: new ort.Tensor('float32', px, [1, 3, P, P]) });
  const id = nextEmbed++;
  embeds.set(id, { emb: out.image_embeddings, pos: out.image_positional_embeddings, w, h, scale, rw, rh, P });
  while (embeds.size > 4) embeds.delete(embeds.keys().next().value);
  return { id, ms: Math.round(performance.now() - t0), scale };
});

/** Point prompts [[x, y, label 1|0], …] in image pixels → mask (u8, w × h) and its IoU score. */
GW.register('samdecode', async ({ id, points }) => {
  const e = embeds.get(id);
  if (!e || !sessions) throw new Error('no image embedding: run the encoder first');
  const { ort, dec } = sessions;
  const n = points.length;
  const pts = new Float32Array(2 * n);
  const lab = new BigInt64Array(n);
  points.forEach(([x, y, l], i) => {
    pts[2 * i] = x * e.scale;
    pts[2 * i + 1] = y * e.scale;
    lab[i] = BigInt(l ?? 1);
  });
  const t0 = performance.now();
  const out = await dec.run({ input_points: new ort.Tensor('float32', pts, [1, 1, n, 2]), input_labels: new ort.Tensor('int64', lab, [1, 1, n]), image_embeddings: e.emb, image_positional_embeddings: e.pos });
  const iou = out.iou_scores.data;
  const dims = out.pred_masks.dims; // [1, 1, 3, 256, 256]
  const K = dims[2];
  const M = dims[3];
  let best = 0;
  for (let k = 1; k < K; k++) if (iou[k] > iou[best]) best = k;
  const logits = out.pred_masks.data.subarray(best * M * M, (best + 1) * M * M);
  // Original pixel (x, y) → padded 1024 square → 256² logits (bilinear).
  const f = (M / e.P) * e.scale;
  const mask = new Uint8Array(e.w * e.h);
  let area = 0;
  for (let y = 0; y < e.h; y++) {
    const sy = Math.min(M - 1, Math.max(0, (y + 0.5) * f - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(M - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < e.w; x++) {
      const sx = Math.min(M - 1, Math.max(0, (x + 0.5) * f - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(M - 1, x0 + 1);
      const tx = sx - x0;
      const v = (logits[y0 * M + x0] * (1 - tx) + logits[y0 * M + x1] * tx) * (1 - ty) + (logits[y1 * M + x0] * (1 - tx) + logits[y1 * M + x1] * tx) * ty;
      if (v > 0) {
        mask[y * e.w + x] = 1;
        area++;
      }
    }
  }
  return GW.transfer({ mask, w: e.w, h: e.h, iou: iou[best], scores: Array.from(iou), area, ms: Math.round(performance.now() - t0) }, [mask.buffer]);
});
