// Output decoding for user and pack models (REQ-GAP-57), run in the AI worker. The descriptor
// (ai/user-models.js validates it) names an output format; nothing in it is code.
//   detection:  'yolov8'  — one tensor [1, 4 + C, N] (cx, cy, w, h in input pixels, then class
//                            scores) or [1, N, 4 + C];
//               'boxes'   — tensors named by output.boxes ([N, 4] or [1, N, 4], x0 y0 x1 y1 in
//                            input pixels, or 0…1 when output.normalized), output.scores ([N]) and
//                            output.labels ([N], optional);
//   segmentation / classification: 'logits' — [1, C, H′, W′] class scores (argmax per pixel);
//               'mask'    — [1, 1, H′, W′] one class (sigmoid when output.sigmoid, then > threshold).

import { nms } from './image.js';

const dataOf = (t) => t?.data ?? null;

/** Boxes in tile pixels: [{cls, score, box: [x0, y0, x1, y1]}], after per-class NMS. */
export function decodeDetections(out, spec, { fx, fy, w, h }) {
  const o = spec.output;
  const names = spec.classes ?? [];
  const th = Number.isFinite(spec.threshold) ? spec.threshold : 0.25;
  const hits = [];
  const clip = (b) => [Math.max(0, b[0] * fx), Math.max(0, b[1] * fy), Math.min(w, b[2] * fx), Math.min(h, b[3] * fy)];
  if (o.format === 'yolov8') {
    const t = out[o.name ?? Object.keys(out)[0]];
    const d = dataOf(t);
    const [, a, b] = t.dims;
    const C = names.length || Math.min(a, b) - 4;
    const transposed = a === C + 4; // [1, 4 + C, N]
    const N = transposed ? b : a;
    const at = (i, k) => (transposed ? d[k * N + i] : d[i * (C + 4) + k]);
    for (let i = 0; i < N; i++) {
      let best = 0;
      let bs = -Infinity;
      for (let c = 0; c < C; c++) {
        const v = at(i, 4 + c);
        if (v > bs) [bs, best] = [v, c];
      }
      if (bs < th) continue;
      const cx = at(i, 0);
      const cy = at(i, 1);
      const bw = at(i, 2);
      const bh = at(i, 3);
      hits.push({ q: best, score: bs, box: clip([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2]) });
    }
  } else if (o.format === 'boxes') {
    const B = dataOf(out[o.boxes]);
    const S = dataOf(out[o.scores]);
    const Lb = o.labels ? dataOf(out[o.labels]) : null;
    if (!B || !S) throw new Error('the model has no outputs named as the descriptor says');
    const N = S.length;
    const [sx, sy] = o.normalized ? [spec.input.size[1], spec.input.size[0]] : [1, 1];
    for (let i = 0; i < N; i++) {
      if (S[i] < th) continue;
      hits.push({ q: Lb ? Number(Lb[i]) : 0, score: S[i], box: clip([B[4 * i] * sx, B[4 * i + 1] * sy, B[4 * i + 2] * sx, B[4 * i + 3] * sy]) });
    }
  } else throw new Error(`unknown detection output format ${o.format}`);
  return nms(
    hits.filter((x) => x.box[2] - x.box[0] >= 1 && x.box[3] - x.box[1] >= 1),
    Number.isFinite(o.iou) ? o.iou : 0.45,
  ).map((x) => ({ cls: names[x.q] ?? `class ${x.q}`, q: x.q, score: Math.round(x.score * 1000) / 1000, box: x.box }));
}

/**
 * Class raster of the tile (w × h, u8: class index, 255 = no data) from the model output, which
 * covers the tensor's rw × rh region of W × H (scaled when the output is smaller).
 */
export function classify(out, spec, { W, H, rw, rh, w, h }) {
  const o = spec.output;
  const t = out[o.name ?? Object.keys(out)[0]];
  const d = dataOf(t);
  const dims = t.dims;
  const [Ho, Wo] = dims.slice(-2);
  const C = o.format === 'mask' ? 1 : dims[1];
  const sx = Wo / W;
  const sy = Ho / H;
  const classes = new Uint8Array(w * h);
  const counts = new Array(Math.max(2, C)).fill(0);
  const th = Number.isFinite(spec.threshold) ? spec.threshold : 0.5;
  for (let y = 0; y < h; y++) {
    const ty = Math.min(Ho - 1, Math.floor(((y + 0.5) * rh) / h * sy));
    for (let x = 0; x < w; x++) {
      const tx = Math.min(Wo - 1, Math.floor(((x + 0.5) * rw) / w * sx));
      const p = ty * Wo + tx;
      let c = 0;
      if (o.format === 'mask') {
        let v = d[p];
        if (o.sigmoid) v = 1 / (1 + Math.exp(-v));
        c = v > th ? 1 : 0;
      } else {
        let bv = -Infinity;
        for (let k = 0; k < C; k++) {
          const v = d[k * Ho * Wo + p];
          if (v > bv) [bv, c] = [v, k];
        }
      }
      classes[y * w + x] = c;
      counts[c]++;
    }
  }
  return { classes, counts };
}
