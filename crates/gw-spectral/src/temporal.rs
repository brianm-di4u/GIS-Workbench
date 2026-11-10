//! Time series of images (REQ-GAP-83): per-pixel linear trend with its two-sided p-value, and the
//! anomaly of each date against a baseline period. The cube is BIP f32 with one "band" per date;
//! a value that is not finite is missing, and each pixel uses only the dates it has.

use crate::stats::Cube;

/// Per-pixel least-squares line through (t, value): the slope per unit of `t`, the two-sided
/// p-value of "slope = 0" (Student's t with n − 2 degrees of freedom, as `scipy.stats.linregress`
/// gives it), and the number of dates used.
pub struct Trend {
    pub slope: Vec<f32>,
    pub pvalue: Vec<f32>,
    pub n: Vec<f32>,
}

/// Linear trend of every pixel over the dates `t` (one per band; decimal years from the caller).
/// A pixel with fewer than three usable dates, or whose dates are all the same, gets NaN.
pub fn trend(c: &Cube, t: &[f64]) -> Trend {
    let np = c.w * c.h;
    let mut out = Trend { slope: vec![f32::NAN; np], pvalue: vec![f32::NAN; np], n: vec![0.0; np] };
    for p in 0..np {
        let px = c.px(p);
        // Two passes about the means, which keeps the sums well conditioned for years near 2000.
        let (mut n, mut sx, mut sy) = (0usize, 0f64, 0f64);
        for (k, &y) in px.iter().enumerate() {
            if y.is_finite() {
                n += 1;
                sx += t[k];
                sy += y as f64;
            }
        }
        out.n[p] = n as f32;
        if n < 3 {
            continue;
        }
        let (mx, my) = (sx / n as f64, sy / n as f64);
        let (mut sxx, mut sxy, mut syy) = (0f64, 0f64, 0f64);
        for (k, &y) in px.iter().enumerate() {
            if y.is_finite() {
                let (dx, dy) = (t[k] - mx, y as f64 - my);
                sxx += dx * dx;
                sxy += dx * dy;
                syy += dy * dy;
            }
        }
        if sxx <= 0.0 {
            continue;
        }
        let b = sxy / sxx;
        out.slope[p] = b as f32;
        let df = (n - 2) as f64;
        let sse = (syy - b * sxy).max(0.0);
        out.pvalue[p] = if sse <= syy * 1e-15 {
            // A perfect line: t is infinite (p = 0), or there is no variation at all.
            if syy > 0.0 { 0.0 } else { f32::NAN }
        } else {
            let tt = b / (sse / df / sxx).sqrt();
            student_two_sided(tt, df) as f32
        };
    }
    out
}

/// Anomaly of each date against the baseline: value minus the mean of the baseline dates in the
/// same group (`group[k]`, e.g. the calendar month, or 0 for all dates), divided by their sample
/// standard deviation (n − 1) when `z` is set. Dates outside `base` still get an anomaly. NaN where
/// the value is missing or its group has no baseline value at that pixel (or fewer than two for `z`).
pub fn anomaly(c: &Cube, base: &[bool], group: &[u32], z: bool) -> Vec<f32> {
    let ng = group.iter().copied().max().map_or(0, |g| g as usize + 1);
    let mut out = vec![f32::NAN; c.v.len()];
    let (mut s, mut s2, mut cnt) = (vec![0f64; ng], vec![0f64; ng], vec![0usize; ng]);
    for p in 0..c.w * c.h {
        let px = c.px(p);
        s.iter_mut().for_each(|x| *x = 0.0);
        s2.iter_mut().for_each(|x| *x = 0.0);
        cnt.iter_mut().for_each(|x| *x = 0);
        for (k, &y) in px.iter().enumerate() {
            if base[k] && y.is_finite() {
                let g = group[k] as usize;
                s[g] += y as f64;
                cnt[g] += 1;
            }
        }
        for g in 0..ng {
            if cnt[g] > 0 {
                s[g] /= cnt[g] as f64;
            }
        }
        if z {
            for (k, &y) in px.iter().enumerate() {
                if base[k] && y.is_finite() {
                    let g = group[k] as usize;
                    s2[g] += (y as f64 - s[g]).powi(2);
                }
            }
        }
        let o = &mut out[p * c.nb..(p + 1) * c.nb];
        for (k, &y) in px.iter().enumerate() {
            let g = group[k] as usize;
            if !y.is_finite() || cnt[g] == 0 {
                continue;
            }
            let d = y as f64 - s[g];
            o[k] = if !z {
                d as f32
            } else if cnt[g] >= 2 && s2[g] > 0.0 {
                (d / (s2[g] / (cnt[g] - 1) as f64).sqrt()) as f32
            } else {
                f32::NAN
            };
        }
    }
    out
}

/// P(|T| ≥ |t|) for Student's t with `df` degrees of freedom: I_{df/(df+t²)}(df/2, 1/2).
pub fn student_two_sided(t: f64, df: f64) -> f64 {
    if !t.is_finite() {
        return if t.is_nan() { f64::NAN } else { 0.0 };
    }
    beta_inc(df / 2.0, 0.5, df / (df + t * t))
}

/// The regularised incomplete beta function I_x(a, b), by its continued fraction (modified Lentz),
/// using the symmetry I_x(a, b) = 1 − I_{1−x}(b, a) where the fraction converges slowly.
pub fn beta_inc(a: f64, b: f64, x: f64) -> f64 {
    if !(0.0..=1.0).contains(&x) {
        return f64::NAN;
    }
    if x == 0.0 || x == 1.0 {
        return x;
    }
    let front = (ln_gamma(a + b) - ln_gamma(a) - ln_gamma(b) + a * x.ln() + b * (1.0 - x).ln()).exp();
    if x < (a + 1.0) / (a + b + 2.0) {
        front * beta_cf(a, b, x) / a
    } else {
        1.0 - front * beta_cf(b, a, 1.0 - x) / b
    }
}

fn beta_cf(a: f64, b: f64, x: f64) -> f64 {
    const TINY: f64 = 1e-300;
    let (qab, qap, qam) = (a + b, a + 1.0, a - 1.0);
    let mut c = 1.0;
    let mut d = 1.0 - qab * x / qap;
    if d.abs() < TINY {
        d = TINY;
    }
    d = 1.0 / d;
    let mut h = d;
    for m in 1..=300 {
        let m = m as f64;
        let m2 = 2.0 * m;
        for aa in [m * (b - m) * x / ((qam + m2) * (a + m2)), -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))] {
            d = 1.0 + aa * d;
            if d.abs() < TINY {
                d = TINY;
            }
            c = 1.0 + aa / c;
            if c.abs() < TINY {
                c = TINY;
            }
            d = 1.0 / d;
            h *= d * c;
        }
        // The last factor of the pair is within rounding of 1: converged.
        if (d * c - 1.0).abs() < 1e-15 {
            break;
        }
    }
    h
}

/// ln Γ(x) for x > 0 (Lanczos, g = 7, n = 9; about 15 significant digits).
pub fn ln_gamma(x: f64) -> f64 {
    const G: [f64; 9] = [
        0.999_999_999_999_809_9,
        676.520_368_121_885_1,
        -1_259.139_216_722_402_8,
        771.323_428_777_653_1,
        -176.615_029_162_140_6,
        12.507_343_278_686_905,
        -0.138_571_095_265_720_12,
        9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    if x < 0.5 {
        // Reflection: Γ(x) Γ(1 − x) = π / sin(πx).
        return (std::f64::consts::PI / (std::f64::consts::PI * x).sin()).ln() - ln_gamma(1.0 - x);
    }
    let x = x - 1.0;
    let mut a = G[0];
    let t = x + 7.5;
    for (i, g) in G.iter().enumerate().skip(1) {
        a += g / (x + i as f64);
    }
    0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + a.ln()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn special_functions_match_known_values() {
        // Γ(5) = 24, Γ(0.5) = √π.
        assert!((ln_gamma(5.0) - 24f64.ln()).abs() < 1e-13);
        assert!((ln_gamma(0.5) - std::f64::consts::PI.sqrt().ln()).abs() < 1e-13);
        // I_x(1, 1) = x; I_0.5(a, a) = 0.5.
        assert!((beta_inc(1.0, 1.0, 0.3) - 0.3).abs() < 1e-14);
        assert!((beta_inc(7.0, 7.0, 0.5) - 0.5).abs() < 1e-13);
        // Student's t: two-sided p for t = 2.228 with 10 df is 0.05 (table value), t = 0 gives 1.
        assert!((student_two_sided(2.228_138_851_986_274, 10.0) - 0.05).abs() < 1e-9);
        assert!((student_two_sided(0.0, 5.0) - 1.0).abs() < 1e-14);
        assert_eq!(student_two_sided(f64::INFINITY, 5.0), 0.0);
    }

    #[test]
    fn trend_recovers_a_line_and_skips_missing_dates() {
        let t = [2000.0, 2001.0, 2002.0, 2003.0, 2004.0];
        // Pixel 0: exact line, slope 0.5. Pixel 1: same with a gap. Pixel 2: flat. Pixel 3: two dates.
        let v = [
            1.0, 1.5, 2.0, 2.5, 3.0, //
            1.0, f32::NAN, 2.0, 2.5, 3.0, //
            4.0, 4.0, 4.0, 4.0, 4.0, //
            1.0, f32::NAN, f32::NAN, f32::NAN, 2.0,
        ];
        let c = Cube { v: &v, nb: 5, w: 4, h: 1 };
        let r = trend(&c, &t);
        assert!((r.slope[0] - 0.5).abs() < 1e-6 && r.pvalue[0] == 0.0 && r.n[0] == 5.0);
        assert!((r.slope[1] - 0.5).abs() < 1e-6 && r.n[1] == 4.0);
        assert!(r.slope[2] == 0.0 && r.pvalue[2].is_nan());
        assert!(r.slope[3].is_nan() && r.n[3] == 2.0);
    }

    #[test]
    fn anomaly_against_a_grouped_baseline() {
        // Four dates in two groups (say January and July); the baseline is the first two years.
        let v = [1.0, 10.0, 3.0, 14.0, 5.0, 12.0];
        let c = Cube { v: &v, nb: 6, w: 1, h: 1 };
        let base = [true, true, true, true, false, false];
        let group = [0, 1, 0, 1, 0, 1];
        let a = anomaly(&c, &base, &group, false);
        // Group 0 baseline mean 2, group 1 mean 12.
        assert_eq!(a, vec![-1.0, -2.0, 1.0, 2.0, 3.0, 0.0]);
        let z = anomaly(&c, &base, &group, true);
        // Sample std: group 0 √2, group 1 √8.
        assert!((z[4] - (3.0 / 2f64.sqrt()) as f32).abs() < 1e-6 && (z[1] + (2.0 / 8f64.sqrt()) as f32).abs() < 1e-6);
    }
}
