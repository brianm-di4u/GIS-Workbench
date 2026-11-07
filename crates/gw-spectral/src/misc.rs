//! Radiometric corrections, thermal conversion, spectral libraries, destriping, two-date change
//! and template matching (REQ-MSI-06/13/14/16, REQ-EXT-28, `Research/10` §6, §8, §11).

use crate::stats::Cube;

/// Dark-object subtraction: per band, the value at percentile `p` (e.g. 0.0001) of the valid
/// pixels; the correction is x − dark.
pub fn dark_objects(c: &Cube, p: f64) -> Vec<f64> {
    (0..c.nb)
        .map(|b| {
            let mut v: Vec<f32> = (0..c.n()).step_by(3).map(|q| c.v[q * c.nb + b]).filter(|x| x.is_finite()).collect();
            if v.is_empty() {
                return 0.0;
            }
            let k = ((v.len() - 1) as f64 * p.clamp(0.0, 1.0)) as usize;
            v.select_nth_unstable_by(k, |a, b| a.partial_cmp(b).unwrap());
            v[k] as f64
        })
        .collect()
}

/// Empirical line: per band a least-squares fit ρ = gain·x + offset over ≥ 2 targets, given each
/// target's mean image spectrum and its known reflectance. Returns (gain, offset, r²) per band.
pub fn empirical_line(image: &[Vec<f64>], reference: &[Vec<f64>]) -> Vec<(f64, f64, f64)> {
    let nb = image.first().map_or(0, |v| v.len());
    (0..nb)
        .map(|b| {
            let n = image.len() as f64;
            let (mut sx, mut sy, mut sxx, mut sxy, mut syy) = (0.0, 0.0, 0.0, 0.0, 0.0);
            for (x, y) in image.iter().zip(reference) {
                let (x, y) = (x[b], y[b]);
                sx += x;
                sy += y;
                sxx += x * x;
                sxy += x * y;
                syy += y * y;
            }
            let d = n * sxx - sx * sx;
            if d.abs() < 1e-30 {
                return (f64::NAN, f64::NAN, f64::NAN);
            }
            let g = (n * sxy - sx * sy) / d;
            let o = (sy - g * sx) / n;
            let r = (n * sxy - sx * sy) / ((d * (n * syy - sy * sy)).sqrt().max(1e-30));
            (g, o, r * r)
        })
        .collect()
}

/// Mean spectrum over the valid pixels (IARR uses the scene, flat field an AOI): the correction
/// divides each band by it.
pub fn mean_spectrum(c: &Cube, idx: Option<&[usize]>) -> Vec<f64> {
    let mut m = vec![0.0; c.nb];
    let mut n = 0.0f64;
    let mut each = |p: usize| {
        if c.valid(p) {
            for b in 0..c.nb {
                m[b] += c.v[p * c.nb + b] as f64;
            }
            n += 1.0;
        }
    };
    match idx {
        Some(ix) => ix.iter().for_each(|&p| each(p)),
        None => (0..c.n()).step_by(2).for_each(each),
    }
    m.iter().map(|v| v / n.max(1.0)).collect()
}

/// Brightness temperature (K) from spectral radiance: the Landsat K1/K2 form, or Planck at the
/// band's effective wavelength λ (µm) when k1/k2 are NaN. Optional emissivity correction
/// T_s = BT / (1 + (λ·BT/ρ)·ln ε), ρ = hc/k = 1.438e-2 m·K.
pub fn brightness_temperature(l: f64, k1: f64, k2: f64, lambda_um: f64, emissivity: f64) -> f64 {
    let bt = if k1.is_finite() && k2.is_finite() {
        k2 / (k1 / l + 1.0).ln()
    } else {
        // Planck: L = c1 / (λ⁵ (e^{c2/λT} − 1)), L in W m⁻² sr⁻¹ µm⁻¹.
        let c1 = 1.191_042_97e8; // W µm⁴ m⁻² sr⁻¹
        let c2 = 1.438_776_9e4; // µm K
        c2 / (lambda_um * (c1 / (lambda_um.powi(5) * l) + 1.0).ln())
    };
    if emissivity.is_finite() && emissivity > 0.0 && emissivity < 1.0 && lambda_um.is_finite() {
        bt / (1.0 + (lambda_um * 1e-6 * bt / 1.438e-2) * emissivity.ln())
    } else {
        bt
    }
}

/// Resample a library spectrum (wavelengths µm, values) to sensor bands with Gaussian spectral
/// response functions (centre, FWHM µm). Bands with no library coverage get NaN.
pub fn resample(wl: &[f64], val: &[f64], centres: &[f64], fwhm: &[f64]) -> Vec<f64> {
    centres
        .iter()
        .enumerate()
        .map(|(i, &cw)| {
            let f = fwhm.get(i).copied().filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.01);
            let s = f / 2.354_82;
            let (mut a, mut w) = (0.0, 0.0);
            for (k, &x) in wl.iter().enumerate() {
                let v = val[k];
                if !v.is_finite() || (x - cw).abs() > 3.0 * s {
                    continue;
                }
                let g = (-0.5 * ((x - cw) / s).powi(2)).exp();
                a += g * v;
                w += g;
            }
            if w > 0.0 {
                a / w
            } else {
                f64::NAN
            }
        })
        .collect()
}

/// Continuum removal: divide by the upper convex hull of (wavelength, value).
pub fn continuum_removed(wl: &[f64], v: &[f64]) -> Vec<f64> {
    let pts: Vec<(f64, f64)> = wl.iter().zip(v).filter(|(_, y)| y.is_finite()).map(|(&x, &y)| (x, y)).collect();
    if pts.len() < 2 {
        return v.to_vec();
    }
    let mut hull: Vec<(f64, f64)> = Vec::new();
    for &p in &pts {
        while hull.len() >= 2 {
            let (a, b) = (hull[hull.len() - 2], hull[hull.len() - 1]);
            if (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0) >= 0.0 {
                hull.pop();
            } else {
                break;
            }
        }
        hull.push(p);
    }
    wl.iter()
        .zip(v)
        .map(|(&x, &y)| {
            let i = hull.windows(2).position(|w| x >= w[0].0 && x <= w[1].0).unwrap_or(0);
            let (a, b) = (hull[i], hull[(i + 1).min(hull.len() - 1)]);
            let c = if b.0 > a.0 { a.1 + (b.1 - a.1) * (x - a.0) / (b.0 - a.0) } else { a.1 };
            if c > 0.0 {
                y / c
            } else {
                f64::NAN
            }
        })
        .collect()
}

/// Destriping by moment matching: each column of each band gets the band's mean and σ.
pub fn destripe(c: &Cube) -> Vec<f32> {
    let (w, h, nb) = (c.w, c.h, c.nb);
    let mut out = c.v.to_vec();
    for b in 0..nb {
        let (mut gs, mut gs2, mut gn) = (0.0f64, 0.0f64, 0.0f64);
        let mut cols = vec![(0.0, 0.0, 0.0); w];
        for y in 0..h {
            for x in 0..w {
                let v = c.v[(y * w + x) * nb + b] as f64;
                if v.is_finite() {
                    cols[x].0 += v;
                    cols[x].1 += v * v;
                    cols[x].2 += 1.0;
                    gs += v;
                    gs2 += v * v;
                    gn += 1.0;
                }
            }
        }
        let gm = gs / gn.max(1.0);
        let gsd = (gs2 / gn.max(1.0) - gm * gm).max(0.0).sqrt();
        for x in 0..w {
            let (s, s2, n) = cols[x];
            if n < 2.0 {
                continue;
            }
            let m = s / n;
            let sd = (s2 / n - m * m).max(0.0).sqrt();
            let k = if sd > 0.0 { gsd / sd } else { 1.0 };
            for y in 0..h {
                let i = (y * w + x) * nb + b;
                if out[i].is_finite() {
                    out[i] = (gm + (out[i] as f64 - m) * k) as f32;
                }
            }
        }
    }
    out
}

/// Two-date spectral change: change-vector magnitude and spectral angle (rad) per pixel.
pub fn change_vector(a: &Cube, b: &Cube) -> (Vec<f32>, Vec<f32>) {
    let n = a.n().min(b.n());
    let nb = a.nb.min(b.nb);
    let (mut mag, mut ang) = (vec![f32::NAN; n], vec![f32::NAN; n]);
    for p in 0..n {
        if !a.valid(p) || !b.valid(p) {
            continue;
        }
        let (x, y) = (a.px(p), b.px(p));
        let (mut d2, mut xy, mut xx, mut yy) = (0.0, 0.0, 0.0, 0.0);
        for k in 0..nb {
            let (u, v) = (x[k] as f64, y[k] as f64);
            d2 += (v - u) * (v - u);
            xy += u * v;
            xx += u * u;
            yy += v * v;
        }
        mag[p] = d2.sqrt() as f32;
        ang[p] = if xx > 0.0 && yy > 0.0 { (xy / (xx.sqrt() * yy.sqrt())).clamp(-1.0, 1.0).acos() as f32 } else { f32::NAN };
    }
    (mag, ang)
}

/// Template matching (REQ-EXT-28): normalised cross-correlation of a tw × th template over a
/// single-band image (integral images for the window statistics). Output: NCC per top-left
/// position, (w − tw + 1) × (h − th + 1).
pub fn template_ncc(img: &[f32], w: usize, h: usize, t: &[f32], tw: usize, th: usize) -> Vec<f32> {
    if tw > w || th > h || tw * th == 0 {
        return Vec::new();
    }
    let (ow, oh) = (w - tw + 1, h - th + 1);
    let iw = w + 1;
    let mut s1 = vec![0f64; iw * (h + 1)];
    let mut s2 = vec![0f64; iw * (h + 1)];
    for y in 0..h {
        let (mut r1, mut r2) = (0.0, 0.0);
        for x in 0..w {
            let v = img[y * w + x] as f64;
            let v = if v.is_finite() { v } else { 0.0 };
            r1 += v;
            r2 += v * v;
            s1[(y + 1) * iw + x + 1] = s1[y * iw + x + 1] + r1;
            s2[(y + 1) * iw + x + 1] = s2[y * iw + x + 1] + r2;
        }
    }
    let n = (tw * th) as f64;
    let tm = t.iter().map(|&v| v as f64).sum::<f64>() / n;
    let tz: Vec<f64> = t.iter().map(|&v| v as f64 - tm).collect();
    let tsd = (tz.iter().map(|v| v * v).sum::<f64>()).sqrt();
    let mut out = vec![0f32; ow * oh];
    for y in 0..oh {
        for x in 0..ow {
            let g = |s: &[f64]| s[(y + th) * iw + x + tw] - s[y * iw + x + tw] - s[(y + th) * iw + x] + s[y * iw + x];
            let (a, a2) = (g(&s1), g(&s2));
            let var = (a2 - a * a / n).max(0.0);
            if var <= 0.0 || tsd <= 0.0 {
                continue;
            }
            let mut cov = 0.0;
            for ty in 0..th {
                let row = (y + ty) * w + x;
                for tx in 0..tw {
                    let v = img[row + tx];
                    cov += tz[ty * tw + tx] * if v.is_finite() { v as f64 } else { 0.0 };
                }
            }
            out[y * ow + x] = (cov / (var.sqrt() * tsd)) as f32;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn brightness_temperature_round_trips_planck() {
        let (c1, c2, lam, t) = (1.191_042_97e8, 1.438_776_9e4, 10.9f64, 300.0f64);
        let l = c1 / (lam.powi(5) * ((c2 / (lam * t)).exp() - 1.0));
        assert!((brightness_temperature(l, f64::NAN, f64::NAN, lam, f64::NAN) - t).abs() < 1e-6);
        let bt = brightness_temperature(10.0, 774.8853, 1321.0789, 10.9, f64::NAN);
        assert!((bt - 1321.0789 / (774.8853f64 / 10.0 + 1.0).ln()).abs() < 1e-9);
    }

    #[test]
    fn resample_and_continuum() {
        let wl: Vec<f64> = (0..200).map(|i| 0.4 + i as f64 * 0.005).collect();
        let v: Vec<f64> = wl.iter().map(|x| 0.2 + 0.1 * x).collect();
        let r = resample(&wl, &v, &[0.5, 0.8], &[0.05, 0.1]);
        assert!((r[0] - 0.25).abs() < 1e-3 && (r[1] - 0.28).abs() < 1e-3);
        let cr = continuum_removed(&wl, &v);
        assert!(cr.iter().all(|x| (x - 1.0).abs() < 1e-9));
    }

    #[test]
    fn template_finds_itself() {
        let (w, h) = (40, 30);
        let img: Vec<f32> = (0..w * h).map(|i| (((i % w) as f32 * 0.7).sin() + ((i / w) as f32 * 0.45).cos()) * 10.0).collect();
        let (tx, ty, tw, th) = (12, 9, 8, 6);
        let t: Vec<f32> = (0..th).flat_map(|y| (0..tw).map(move |x| (y, x))).map(|(y, x)| img[(ty + y) * w + tx + x]).collect();
        let r = template_ncc(&img, w, h, &t, tw, th);
        let best = (0..r.len()).max_by(|&a, &b| r[a].partial_cmp(&r[b]).unwrap()).unwrap();
        assert_eq!((best % (w - tw + 1), best / (w - tw + 1)), (tx, ty));
    }
}
