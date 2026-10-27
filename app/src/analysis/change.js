// EO change detection on a co-registered pair (SCN-11, AT-11.3): radiometric normalisation by
// robust linear regression, absolute difference, 3×3 smoothing, a robust threshold
// (median + k·MAD), opening to remove specks, and 8-connected components above a minimum
// area. DOM-free and deterministic (unit-tested in Node).

/** Robust fit b ≈ gain·a + offset: Deming regression, then refit without the 10 % largest residuals. */
export function radiometricFit(a, b, valid = null, step = 7) {
  // Saturated samples (at either image's extremes) would bias the fit: leave them out.
  let [amin, amax, bmin, bmax] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < a.length; i += step) {
    if (valid && !valid[i]) continue;
    amin = Math.min(amin, a[i]);
    amax = Math.max(amax, a[i]);
    bmin = Math.min(bmin, b[i]);
    bmax = Math.max(bmax, b[i]);
  }
  const unsat = (i) => a[i] > amin + 0.5 && a[i] < amax - 0.5 && b[i] > bmin + 0.5 && b[i] < bmax - 0.5;
  const fit = (keep) => {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < a.length; i += step) {
      if (valid && !valid[i]) continue;
      if (!unsat(i) || (keep && !keep(i))) continue;
      const x = a[i];
      const y = b[i];
      n++;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
    }
    // Deming (orthogonal) regression: both dates carry noise of similar size, which plain
    // least squares would turn into a gain biased towards 0.
    if (n < 3) return { gain: 1, offset: 0, n };
    const mx = sx / n;
    const my = sy / n;
    const vxx = sxx / n - mx * mx;
    const vyy = syy / n - my * my;
    const vxy = sxy / n - mx * my;
    const gain = vxy ? (vyy - vxx + Math.sqrt((vyy - vxx) ** 2 + 4 * vxy * vxy)) / (2 * vxy) : 1;
    return { gain, offset: my - gain * mx, n };
  };
  let f = fit(null);
  const res = [];
  for (let i = 0; i < a.length; i += step) if ((!valid || valid[i]) && unsat(i)) res.push(Math.abs(b[i] - (f.gain * a[i] + f.offset)));
  res.sort((x, y) => x - y);
  const cut = res[Math.floor(res.length * 0.9)] ?? Infinity;
  f = fit((i) => Math.abs(b[i] - (f.gain * a[i] + f.offset)) <= cut);
  return f;
}

function box3(src, w, h) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += src[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  return out;
}

function morph(mask, w, h, op) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = op === 'erode' ? 1 : 0;
      for (let dy = -1; dy <= 1 && (op === 'erode' ? v : !v); dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          const m = xx >= 0 && yy >= 0 && xx < w && yy < h ? mask[yy * w + xx] : 0;
          if (op === 'erode' && !m) {
            v = 0;
            break;
          }
          if (op === 'dilate' && m) {
            v = 1;
            break;
          }
        }
      out[y * w + x] = v;
    }
  return out;
}

/**
 * Change candidates between two co-registered images of size w×h (Float32Array each).
 * Returns {gain, offset, threshold, candidates: [{x0, y0, x1, y1, area, mean, peak}]}, sorted
 * by score (strongest first).
 */
export function detectChanges(a, b, w, h, { k = 4, minArea = 30, nodata = null } = {}) {
  const valid = new Uint8Array(w * h);
  for (let i = 0; i < valid.length; i++) valid[i] = Number.isFinite(a[i]) && Number.isFinite(b[i]) && a[i] !== nodata && b[i] !== nodata ? 1 : 0;
  const { gain, offset } = radiometricFit(a, b, valid);
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = valid[i] ? Math.abs(b[i] - (gain * a[i] + offset)) : 0;
  const s = box3(d, w, h);
  // Robust threshold from a sample: median + k·1.4826·MAD.
  const sample = [];
  for (let i = 0; i < s.length; i += 13) if (valid[i]) sample.push(s[i]);
  sample.sort((x, y) => x - y);
  const med = sample[sample.length >> 1] ?? 0;
  const mad = (sample.map((v) => Math.abs(v - med)).sort((x, y) => x - y)[sample.length >> 1] ?? 0) * 1.4826;
  const threshold = med + k * Math.max(mad, 1e-3) + 3;
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = valid[i] && s[i] > threshold ? 1 : 0;
  mask = morph(morph(mask, w, h, 'erode'), w, h, 'dilate');
  // 8-connected components (iterative flood fill).
  const label = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  let next = 1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || label[i]) continue;
    let top = 0;
    stack[top++] = i;
    label[i] = next;
    let area = 0;
    let sum = 0;
    let peak = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (top) {
      const j = stack[--top];
      const x = j % w;
      const y = (j - x) / w;
      area++;
      sum += d[j];
      peak = Math.max(peak, d[j]);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (mask[q] && !label[q]) {
            label[q] = next;
            stack[top++] = q;
          }
        }
    }
    next++;
    if (area >= minArea) out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, area, mean: sum / area, peak });
  }
  out.sort((p, q) => q.mean * Math.sqrt(q.area) - p.mean * Math.sqrt(p.area));
  return { gain, offset, threshold, candidates: out };
}
