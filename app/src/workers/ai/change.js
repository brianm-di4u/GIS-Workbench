// Change mask between two co-registered 8-bit grey windows (REQ-LAI-05): after Auto Align (AI)
// has put the second image on the first, this marks where they differ beyond what radiometry and
// a pixel of residual misregistration explain. Classical, deterministic, no model:
//   1. both windows are smoothed (3 × 3 box) so speckle and sharpening differ less; pixels
//      saturated (0 or 255) in either image are left out (they carry no radiometry);
//   2. the second is mapped onto the first's radiometry by a robust line (b ≈ g·a + o, fitted on
//      the 10–90 % quantiles of a sample) so a different exposure or season is not "change";
//   3. the residual at each pixel is the smallest |a − b'| over b' within ±1 pixel (shift-tolerant
//      difference), so an edge that moved by one pixel is not "change";
//   4. it is smoothed again (5 × 5) and thresholded at `threshold` robust standard deviations
//      (1.4826 · MAD of the residual over the valid pixels);
//   5. an opening (3 × 3) removes isolated pixels; 4-connected regions smaller than `minArea`
//      pixels are dropped.
// Returns {mask (u8, 1 = changed), regions [{x0, y0, x1, y1, area, score}], changedFraction,
// sigma, gain, offset}.

function box(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / (2 * r + 1);
      s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

const quantile = (arr, q) => {
  const v = Float32Array.from(arr).sort();
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))];
};

export function changeMask(a, b, w, h, { threshold = 2.5, minArea = 64, valid = null } = {}) {
  const n = w * h;
  const A = box(a, w, h, 1);
  const B = box(b, w, h, 1);
  // Pixels saturated (0 or 255) in either image carry no radiometric information: never change.
  const ok = (i) => (!valid || valid[i]) && a[i] > 0 && a[i] < 255 && b[i] > 0 && b[i] < 255;
  // Robust radiometric line a ≈ g·b + o on co-located pixel pairs: least squares, then three
  // rounds that drop the 25 % of pairs with the largest residuals (changes and saturated pixels
  // are outliers).
  const sa = [];
  const sb = [];
  const step = Math.max(1, Math.floor(n / 40000));
  for (let i = 0; i < n; i += step) if (ok(i)) (sa.push(A[i]), sb.push(B[i]));
  if (sa.length < 16) throw new Error('the two images do not overlap here');
  let gain = 1;
  let offset = 0;
  let use = sa.map((_, k) => k);
  for (let round = 0; round < 4; round++) {
    let mx = 0;
    let my = 0;
    for (const k of use) (mx += sb[k]), (my += sa[k]);
    mx /= use.length;
    my /= use.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const k of use) {
      sxy += (sb[k] - mx) * (sa[k] - my);
      sxx += (sb[k] - mx) ** 2;
      syy += (sa[k] - my) ** 2;
    }
    // Geometric-mean (reduced major axis) slope: both images carry noise and residual
    // misregistration, which bias an ordinary least-squares slope towards zero.
    gain = sxx > 1e-6 && syy > 1e-6 ? Math.sign(sxy || 1) * Math.sqrt(syy / sxx) : 1;
    offset = my - gain * mx;
    if (round === 3) break;
    const res = use.map((k) => Math.abs(sa[k] - (gain * sb[k] + offset)));
    const cutR = quantile(res, 0.75);
    use = use.filter((_, j) => res[j] <= cutR);
    if (use.length < 16) break;
  }
  for (let i = 0; i < n; i++) B[i] = gain * B[i] + offset;
  // Shift-tolerant residual.
  const R = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let best = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const d = Math.abs(A[i] - B[yy * w + xx]);
          if (d < best) best = d;
        }
      }
      R[i] = ok(i) ? best : 0;
    }
  }
  const S = box(R, w, h, 2);
  const rs = [];
  for (let i = 0; i < n; i += step) if (ok(i)) rs.push(S[i]);
  const med = quantile(rs, 0.5);
  const mad = quantile(rs.map((v) => Math.abs(v - med)), 0.5);
  // The noise floor: the residual spread, but not below 2 % of the reference's 2–98 % range (the
  // shift-tolerant residual is near zero almost everywhere, so its MAD alone is too small a scale).
  const span = quantile(sa, 0.98) - quantile(sa, 0.02);
  const sigma = Math.max(1, 1.4826 * mad, 0.02 * span);
  const cut = med + threshold * sigma;
  let m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = ok(i) && S[i] > cut ? 1 : 0;
  // Opening: erode then dilate (3 × 3).
  const morph = (src, keep) => {
    const out = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let all = true;
        let any = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            const v = xx >= 0 && yy >= 0 && xx < w && yy < h ? src[yy * w + xx] : 0;
            if (v) any = true;
            else all = false;
          }
        }
        out[y * w + x] = keep === 'erode' ? (all ? 1 : 0) : any ? 1 : 0;
      }
    }
    return out;
  };
  m = morph(morph(m, 'erode'), 'dilate');
  // Regions.
  const lab = new Int32Array(n);
  const regions = [];
  const stack = [];
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (!m[s] || lab[s]) continue;
    id++;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    let area = 0;
    let sum = 0;
    lab[s] = id;
    stack.push(s);
    const px = [];
    while (stack.length) {
      const p = stack.pop();
      px.push(p);
      const x = p % w;
      const y = (p - x) / w;
      area++;
      sum += S[p];
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && m[q] && !lab[q]) {
          lab[q] = id;
          stack.push(q);
        }
      }
    }
    if (area < minArea) {
      for (const p of px) m[p] = 0;
      continue;
    }
    regions.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, area, score: Math.round((((sum / area - med) / sigma) * 100)) / 100 });
  }
  let changed = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (!ok(i)) continue;
    total++;
    if (m[i]) changed++;
  }
  regions.sort((p, q) => q.area * q.score - p.area * p.score);
  return { mask: m, regions, changedFraction: total ? changed / total : 0, sigma, gain, offset, threshold };
}

/** Pixel IoU, precision and recall of a mask against a truth mask (validation). */
export function maskScores(mask, truth) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && truth[i]) tp++;
    else if (mask[i]) fp++;
    else if (truth[i]) fn++;
  }
  return { iou: tp / Math.max(1, tp + fp + fn), precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), tp, fp, fn };
}
