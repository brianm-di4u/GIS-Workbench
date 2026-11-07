// AI worker operations added in 2.4 (REQ-GAP-56/57, REQ-LAI-04/05), registered by ai.worker.js:
// batched OWLv2 over scene tiles, the SAM encoder benchmark, Moondream2 generation, user and pack
// models with a declared input/output spec, and the change mask. `env` gives the worker's ort,
// session lookup and device.

import { toPlanes, nms } from './image.js';
import { vlmGenerate } from './vlm.js';
import { changeMask } from './change.js';
import { decodeDetections, classify } from './user-model.js';

export function registerOps24(GW, env) {
  const { sess, sessions } = env;
  const ort = () => env.ort();
  const cancelledOf = (job) => () => {
    try {
      job.checkCancel();
      return false;
    } catch {
      return true;
    }
  };

  /**
   * OWLv2 over several tiles in one run (whole-scene batching): tiles [{rgb, w, h}] → per-tile
   * boxes. The text queries are repeated per image, as the model expects ([images × queries, len]).
   * The float16 graph (ai-gpu pack) is used when it is loaded.
   */
  GW.register('owldetectbatch', async ({ tiles, ids, mask, nq, len, threshold = 0.1, config }, job) => {
    const key = sessions.has('owlv2-fp16') ? 'owlv2-fp16' : 'owlv2';
    const s = sess(key);
    const S = config?.size?.height ?? 960;
    const B = tiles.length;
    const px = new Float32Array(B * 3 * S * S);
    const scales = tiles.map((t, k) => {
      const sc = S / Math.max(t.w, t.h);
      px.set(toPlanes(t.rgb, t.w, t.h, { W: S, H: S, rw: Math.round(t.w * sc), rh: Math.round(t.h * sc), mean: config?.image_mean, std: config?.image_std, pad: 0.5 }), k * 3 * S * S);
      return sc;
    });
    job.progress(0.1);
    job.checkCancel();
    const rep = (a) => BigInt64Array.from({ length: B * a.length }, (_, i) => BigInt(a[i % a.length]));
    const O = ort();
    const t0 = performance.now();
    const out = await s.run({ pixel_values: new O.Tensor('float32', px, [B, 3, S, S]), input_ids: new O.Tensor('int64', rep(ids), [B * nq, len]), attention_mask: new O.Tensor('int64', rep(mask), [B * nq, len]) });
    const ms = performance.now() - t0;
    const L = out.logits.data;
    const Bx = out.pred_boxes.data;
    const N = out.pred_boxes.dims[1];
    const res = tiles.map((t, k) => {
      const hits = [];
      for (let i = 0; i < N; i++) {
        for (let q = 0; q < nq; q++) {
          const p = 1 / (1 + Math.exp(-L[(k * N + i) * nq + q]));
          if (p < threshold) continue;
          const o = 4 * (k * N + i);
          const [cx, cy, bw, bh] = [Bx[o], Bx[o + 1], Bx[o + 2], Bx[o + 3]].map((v) => (v * S) / scales[k]);
          const box = [Math.max(0, cx - bw / 2), Math.max(0, cy - bh / 2), Math.min(t.w, cx + bw / 2), Math.min(t.h, cy + bh / 2)];
          if (box[2] - box[0] >= 1 && box[3] - box[1] >= 1) hits.push({ q, score: p, box });
        }
      }
      return nms(hits, 0.3);
    });
    return { tiles: res, ms: Math.round(ms), device: sessions.get(key).device, model: key };
  });

  /** SAM 2.1 encoder timing on this device (REQ-GAP-56): the encoder `runs` times on one window, outputs read back. */
  GW.register('sam2bench', async ({ rgb, w, h, config, runs = 5, key = 'sam2-enc' }, job) => {
    const enc = sess(key);
    const O = ort();
    const S = config?.size?.height ?? 1024;
    const px = toPlanes(rgb, w, h, { W: S, H: S, mean: config?.image_mean ?? [0.485, 0.456, 0.406], std: config?.image_std ?? [0.229, 0.224, 0.225] });
    const times = [];
    for (let k = 0; k < runs; k++) {
      job.checkCancel();
      const t0 = performance.now();
      const out = await enc.run({ pixel_values: new O.Tensor('float32', px, [1, 3, S, S]) });
      for (const v of Object.values(out)) await v.getData?.();
      times.push(Math.round(performance.now() - t0));
      job.progress((k + 1) / runs);
    }
    return { times, device: sessions.get(key).device };
  });

  /** Moondream2 image features (vision encoder only). */
  GW.register('vlmvision', async ({ rgb, w, h, config }) => {
    const O = ort();
    const S = config?.size?.height ?? 378;
    const px = toPlanes(rgb, w, h, { W: S, H: S, mean: config?.image_mean ?? [0.5, 0.5, 0.5], std: config?.image_std ?? [0.5, 0.5, 0.5] });
    const t0 = performance.now();
    const out = await sess('vlm-vision').run({ pixel_values: new O.Tensor('float32', px, [1, 3, S, S]) });
    const f = out.image_features ?? out[Object.keys(out)[0]];
    const data = Float32Array.from((await f.getData?.()) ?? f.data, Number);
    return GW.transfer({ features: data, dims: f.dims, ms: Math.round(performance.now() - t0), device: sessions.get('vlm-vision').device }, [data.buffer]);
  });

  /** Moondream2 text side: image features (from vlmvision) and prompt ids → generated ids (REQ-LAI-04). */
  GW.register('vlmtext', async ({ features, dims, ids, maxTokens = 96 }, job) => {
    const O = ort();
    const dec = sessions.get('vlm-dec');
    if (!dec) throw new Error('the vlm-dec model is not loaded in this worker');
    const vision = { outputNames: ['image_features'], run: async () => ({ image_features: new O.Tensor('float32', new Float32Array(features), dims) }) };
    const r = await vlmGenerate(O, { vision, embed: sess('vlm-embed'), decoder: dec.s }, null, ids, { maxTokens, gpuKv: !!dec.gpuKv, onToken: (_, n) => job.progress(Math.min(0.99, n / maxTokens)), cancelled: cancelledOf(job) });
    job.checkCancel();
    return { ...r, decoderDevice: dec.device };
  });

  /**
   * A user or pack model on one tile (REQ-GAP-57): the declared input spec makes the tensor; the
   * declared output format is decoded into boxes (detection) or a class raster (segmentation,
   * pixel classification). Nothing in the descriptor is code.
   */
  GW.register('modelrun', async ({ key, rgb, w, h, spec }, job) => {
    const O = ort();
    const s = sess(key);
    const inp = spec.input;
    const [H, W] = inp.size ?? [h, w];
    const pad = inp.resize === 'pad';
    const sc = pad ? Math.min(W / w, H / h) : null;
    const rw = pad ? Math.round(w * sc) : W;
    const rh = pad ? Math.round(h * sc) : H;
    const range = inp.range ?? [0, 1];
    // toPlanes gives (v/255 − mean)/std; a 0…255 model takes mean and std scaled to 0…1 units.
    const k = range[1] > 1 ? 255 : 1;
    const mean = (inp.mean ?? [0, 0, 0]).map((m) => m / k);
    const std = (inp.std ?? [1, 1, 1]).map((d) => d / k);
    const C = inp.channels ?? 3;
    let px = toPlanes(rgb, w, h, { W, H, rw, rh, mean, std, pad: pad ? (inp.padValue ?? 0) / 255 : null });
    if (C === 1) {
      const g = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) g[i] = (px[i] + px[W * H + i] + px[2 * W * H + i]) / 3;
      px = g;
    }
    let data = px;
    if (inp.layout === 'NHWC') {
      data = new Float32Array(px.length);
      for (let i = 0; i < W * H; i++) for (let ch = 0; ch < C; ch++) data[i * C + ch] = px[ch * W * H + i];
    }
    job.progress(0.1);
    const t0 = performance.now();
    const name = inp.name ?? s.inputNames[0];
    const dims = inp.layout === 'NHWC' ? [1, H, W, C] : [1, C, H, W];
    const out = await s.run({ [name]: new O.Tensor('float32', data, dims) });
    for (const v of Object.values(out)) if (v.location === 'gpu-buffer') await v.getData();
    const ms = Math.round(performance.now() - t0);
    if (spec.task === 'detection') {
      const boxes = decodeDetections(out, spec, { fx: pad ? 1 / sc : w / W, fy: pad ? 1 / sc : h / H, w, h });
      return { boxes, ms, device: sessions.get(key).device };
    }
    const r = classify(out, spec, { W, H, rw, rh, w, h });
    return GW.transfer({ classes: r.classes, counts: r.counts, w, h, ms, device: sessions.get(key).device }, [r.classes.buffer]);
  });

  /** Change mask between two co-registered windows (REQ-LAI-05): see workers/ai/change.js. */
  GW.register('changemask', async ({ a, b, w, h, threshold = 2.5, minArea = 64, valid = null }, job) => {
    job.progress(0.1);
    const r = changeMask(a, b, w, h, { threshold, minArea, valid });
    return GW.transfer(r, [r.mask.buffer]);
  });
}
