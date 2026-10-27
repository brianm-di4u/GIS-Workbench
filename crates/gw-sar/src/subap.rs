//! Sub-aperture stack and colour sub-aperture image (REQ-SAR-11, `Research/09` §7) and
//! polarimetric composites (REQ-SAR-13), after sarpy's `subaperture`/`csi` (MIT) logic: the FFT
//! of the complex chip along one dimension, `frames` evenly stepped windows of `fraction` of the
//! processed band (inside the `fill` support), each inverse-transformed (FULL output size).

use crate::fft::{fft, next_pow2, Cx};

/// Which image dimension is split: 1 = columns (azimuth for most SICD grids), 0 = rows.
fn lines(w: usize, h: usize, dim: u8) -> (usize, usize) {
    if dim == 1 {
        (h, w)
    } else {
        (w, h)
    }
}

fn get_line(z: &[Cx], w: usize, dim: u8, k: usize, n: usize, buf: &mut [Cx]) {
    for i in 0..n {
        buf[i] = if dim == 1 { z[k * w + i] } else { z[i * w + k] };
    }
}

/// Magnitude frames, frame-major (frames × w × h). `fill` = oversample ratio (≥ 1): the band
/// occupies 1/fill of the spectrum around its centre.
pub fn subaperture(z: &[Cx], w: usize, h: usize, dim: u8, frames: usize, fraction: f64, fill: f64) -> Vec<f32> {
    let frames = frames.clamp(1, 32);
    let (count, n) = lines(w, h, dim);
    let np = next_pow2(n);
    let band = (np as f64 / fill.max(1.0)).floor() as usize;
    let win = ((band as f64 * fraction.clamp(0.05, 1.0)).round() as usize).max(2);
    let start0 = (np - band) / 2;
    let step = if frames > 1 { (band - win) as f64 / (frames - 1) as f64 } else { 0.0 };
    let mut out = vec![0f32; frames * w * h];
    let mut line = vec![Cx::ZERO; np];
    let mut spec = vec![Cx::ZERO; np];
    let mut sub = vec![Cx::ZERO; np];
    for k in 0..count {
        line.iter_mut().for_each(|v| *v = Cx::ZERO);
        get_line(z, w, dim, k, n, &mut line);
        spec.copy_from_slice(&line);
        fft(&mut spec, false);
        // Centre the spectrum (fftshift) so the band is contiguous.
        spec.rotate_left(np / 2);
        for f in 0..frames {
            let s = start0 + (f as f64 * step).round() as usize;
            sub.iter_mut().for_each(|v| *v = Cx::ZERO);
            sub[s..s + win].copy_from_slice(&spec[s..s + win]);
            sub.rotate_right(np / 2);
            fft(&mut sub, true);
            for i in 0..n {
                let a = sub[i].abs() as f32;
                let o = if dim == 1 { k * w + i } else { i * w + k };
                out[f * w * h + o] = a;
            }
        }
    }
    out
}

/// Colour sub-aperture image: three overlapping triangular weights across the band → R, G, B
/// magnitudes (planar, 3 × w × h). Static scatterers come out grey, moving or aspect-dependent
/// ones coloured.
pub fn csi(z: &[Cx], w: usize, h: usize, dim: u8, fill: f64) -> Vec<f32> {
    let (count, n) = lines(w, h, dim);
    let np = next_pow2(n);
    let band = (np as f64 / fill.max(1.0)).floor() as usize;
    let start = (np - band) / 2;
    let mut out = vec![0f32; 3 * w * h];
    let mut line = vec![Cx::ZERO; np];
    let mut sub = vec![Cx::ZERO; np];
    for k in 0..count {
        line.iter_mut().for_each(|v| *v = Cx::ZERO);
        get_line(z, w, dim, k, n, &mut line);
        fft(&mut line, false);
        line.rotate_left(np / 2);
        for c in 0..3 {
            sub.iter_mut().for_each(|v| *v = Cx::ZERO);
            // Triangles centred at 1/4, 1/2 and 3/4 of the band, half-width 1/4 of the band.
            let centre = start as f64 + band as f64 * (0.25 + 0.25 * c as f64);
            let hw = band as f64 * 0.25;
            for (i, s) in sub.iter_mut().enumerate().take(start + band).skip(start) {
                let t = 1.0 - ((i as f64 + 0.5) - centre).abs() / hw;
                if t > 0.0 {
                    *s = line[i].scale(t);
                }
            }
            sub.rotate_right(np / 2);
            fft(&mut sub, true);
            for i in 0..n {
                let o = if dim == 1 { k * w + i } else { i * w + k };
                out[c * w * h + o] = sub[i].abs() as f32;
            }
        }
    }
    out
}

/// Pauli composite from co-registered HH, HV, VV: R = |HH − VV|/√2, G = √2·|HV|, B = |HH + VV|/√2.
pub fn pauli(hh: &[Cx], hv: &[Cx], vv: &[Cx]) -> Vec<f32> {
    let n = hh.len();
    let mut out = vec![0f32; 3 * n];
    let r2 = std::f64::consts::SQRT_2;
    for i in 0..n {
        out[i] = (hh[i].sub(vv[i]).abs() / r2) as f32;
        out[n + i] = (hv[i].abs() * r2) as f32;
        out[2 * n + i] = (hh[i].add(vv[i]).abs() / r2) as f32;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_keep_energy_and_shape() {
        let (w, h) = (64, 32);
        let z: Vec<Cx> = (0..w * h).map(|i| Cx::cis(0.3 * (i % w) as f64 + 0.1 * (i / w) as f64)).collect();
        let f = subaperture(&z, w, h, 1, 5, 0.25, 1.0);
        assert_eq!(f.len(), 5 * w * h);
        assert!(f.iter().all(|v| v.is_finite()));
        let c = csi(&z, w, h, 1, 1.0);
        assert_eq!(c.len(), 3 * w * h);
    }
}
