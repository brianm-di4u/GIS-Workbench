//! Mosaic blending (REQ-SNS-18): images already orthorectified on a common grid are combined
//! by a label map (each pixel's source: by default the image whose nadir is nearest, i.e. the
//! smallest view distance; user seam edits override it), with per-image gain/offset colour
//! balance and feathering across seams (a weight that ramps over `feather` pixels on each side).

/// Per-image gain and offset from the overlaps: for each pair, the means and spreads of the two
/// images where both have data give one equation; the reference image (index 0) keeps (1, 0).
/// `sample(i)` yields (value, mask) arrays of image i on a coarse common grid.
pub fn balance(values: &[Vec<f32>], masks: &[Vec<u8>]) -> Vec<(f32, f32)> {
    let n = values.len();
    let mut gains = vec![(1f32, 0f32); n];
    if n < 2 {
        return gains;
    }
    // Spread and mean of each image over its overlaps with already-balanced images (greedy, in order).
    for i in 1..n {
        let (mut sa, mut sb, mut saa, mut sbb, mut c) = (0f64, 0f64, 0f64, 0f64, 0usize);
        for k in 0..values[i].len() {
            if masks[i][k] == 0 {
                continue;
            }
            for j in 0..i {
                if masks[j][k] == 0 {
                    continue;
                }
                let a = f64::from(values[j][k]) * f64::from(gains[j].0) + f64::from(gains[j].1);
                let b = f64::from(values[i][k]);
                sa += a;
                sb += b;
                saa += a * a;
                sbb += b * b;
                c += 1;
                break;
            }
        }
        if c < 16 {
            continue;
        }
        let cf = c as f64;
        let (ma, mb) = (sa / cf, sb / cf);
        let (va, vb) = ((saa / cf - ma * ma).max(1e-9), (sbb / cf - mb * mb).max(1e-9));
        let g = (va / vb).sqrt();
        gains[i] = (g as f32, (ma - g * mb) as f32);
    }
    gains
}

/// Blend one tile. `bands[i][b]` is image i's band b (w·h), `masks[i]` its data mask, `labels` the
/// chosen image per pixel (255 = none), `gains` per image. Feathering: within `feather` pixels of
/// a label change, the images on both sides are mixed by distance.
pub fn blend(w: usize, h: usize, bands: &[Vec<Vec<f32>>], masks: &[Vec<u8>], labels: &[u8], gains: &[(f32, f32)], feather: usize) -> (Vec<Vec<f32>>, Vec<u8>) {
    let n = w * h;
    let nb = bands.first().map_or(0, |b| b.len());
    let mut out: Vec<Vec<f32>> = (0..nb).map(|_| vec![f32::NAN; n]).collect();
    let mut mask = vec![0u8; n];
    let f = feather as i64;
    for y in 0..h {
        for x in 0..w {
            let k = y * w + x;
            let l = labels[k];
            if l == 255 {
                continue;
            }
            // Weights: own label 1 + the others whose label region is within the feather distance.
            let mut wsum = 0f32;
            let mut acc = vec![0f32; nb];
            let mut add = |img: usize, wt: f32| {
                if masks[img][k] == 0 || wt <= 0.0 {
                    return;
                }
                let (g, o) = gains[img];
                for b in 0..nb {
                    acc[b] += wt * (bands[img][b][k] * g + o);
                }
                wsum += wt;
            };
            if f > 0 {
                // Distance (in px, Chebyshev, capped) to the nearest pixel of each other label.
                let mut near = [i64::MAX; 16];
                for dy in -f..=f {
                    let yy = y as i64 + dy;
                    if yy < 0 || yy >= h as i64 {
                        continue;
                    }
                    for dx in -f..=f {
                        let xx = x as i64 + dx;
                        if xx < 0 || xx >= w as i64 {
                            continue;
                        }
                        let o = labels[yy as usize * w + xx as usize];
                        if o != 255 && o != l && (o as usize) < 16 {
                            near[o as usize] = near[o as usize].min(dx.abs().max(dy.abs()));
                        }
                    }
                }
                add(l as usize, 1.0);
                for (img, d) in near.iter().enumerate() {
                    if *d != i64::MAX && img < masks.len() {
                        add(img, 1.0 - (*d as f32) / (f as f32 + 1.0));
                    }
                }
            } else {
                add(l as usize, 1.0);
            }
            if wsum > 0.0 {
                for b in 0..nb {
                    out[b][k] = acc[b] / wsum;
                }
                mask[k] = 1;
            }
        }
    }
    (out, mask)
}
