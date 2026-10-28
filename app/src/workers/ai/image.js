// Image preparation for the local AI models (2.0 plan P5): 8-bit RGB (w × h × 3) → a CHW float
// tensor of W × H, bilinear, rescaled to 0…1 and normalised by mean/std. The image fills the
// top-left `rw × rh` of the tensor; the rest is `pad` (0…1 units, before normalising), or zero
// after normalising when `pad` is null (the SAM processors).

export function toPlanes(rgb, w, h, { W, H, rw = W, rh = H, mean = [0, 0, 0], std = [1, 1, 1], pad = null }) {
  const px = new Float32Array(3 * W * H);
  if (pad !== null) for (let c = 0; c < 3; c++) px.fill((pad - mean[c]) / std[c], c * W * H, (c + 1) * W * H);
  const sxs = rw / w;
  const sys = rh / h;
  for (let y = 0; y < rh; y++) {
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) / sys - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < rw; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) / sxs - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const a = rgb[3 * (y0 * w + x0) + c] * (1 - tx) + rgb[3 * (y0 * w + x1) + c] * tx;
        const b = rgb[3 * (y1 * w + x0) + c] * (1 - tx) + rgb[3 * (y1 * w + x1) + c] * tx;
        px[c * W * H + y * W + x] = ((a * (1 - ty) + b * ty) / 255 - mean[c]) / std[c];
      }
    }
  }
  return px;
}

/** Mask logits (M × M, covering the tensor's `rw × rh` of an `S`-square) → u8 mask of w × h. */
export function maskFromLogits(logits, M, w, h, fx, fy) {
  const mask = new Uint8Array(w * h);
  let area = 0;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(M - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(M - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(M - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(M - 1, x0 + 1);
      const tx = sx - x0;
      const v = (logits[y0 * M + x0] * (1 - tx) + logits[y0 * M + x1] * tx) * (1 - ty) + (logits[y1 * M + x0] * (1 - tx) + logits[y1 * M + x1] * tx) * ty;
      if (v > 0) {
        mask[y * w + x] = 1;
        area++;
      }
    }
  }
  return { mask, area };
}

/** Intersection over union of two boxes [x0, y0, x1, y1]. */
export function boxIou(a, b) {
  const iw = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = iw * ih;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
}

/** Greedy non-maximum suppression per class: items [{box, score, q}] → kept items. */
export function nms(items, iou = 0.3) {
  const out = [];
  for (const it of [...items].sort((a, b) => b.score - a.score)) if (!out.some((k) => k.q === it.q && boxIou(k.box, it.box) > iou)) out.push(it);
  return out;
}
