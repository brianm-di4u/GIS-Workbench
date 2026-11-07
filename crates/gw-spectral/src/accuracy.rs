//! Accuracy assessment (REQ-MSI-10, `Research/10` §7.4): the confusion matrix (rows reference,
//! columns mapped), overall, producer's and user's accuracy, Cohen's κ, Pontius & Millones
//! quantity and allocation disagreement, and the Olofsson et al. (2014) area-weighted overall
//! accuracy with its 95 % confidence interval from mapped-area weights.

pub struct Accuracy {
    pub k: usize,
    /// matrix[r * k + c]: reference class r, mapped class c.
    pub matrix: Vec<u64>,
    pub n: u64,
    pub oa: f64,
    pub kappa: f64,
    pub producers: Vec<f64>,
    pub users: Vec<f64>,
    pub quantity: f64,
    pub allocation: f64,
    /// Area-weighted OA and the half-width of its 95 % interval (when weights are given).
    pub oa_area: Option<(f64, f64)>,
}

/// Pairs (reference, mapped) as 1-based labels; 0 = no reference or unclassified (skipped when
/// the reference is 0; an unclassified mapped pixel counts as an error in its reference row).
pub fn assess(reference: &[u8], mapped: &[u8], k: usize, area_weights: Option<&[f64]>) -> Accuracy {
    let k1 = k + 1; // column k is "unclassified"
    let mut m = vec![0u64; k * k1];
    for (&r, &c) in reference.iter().zip(mapped) {
        if r == 0 || r as usize > k {
            continue;
        }
        let col = if c == 0 || c as usize > k { k } else { c as usize - 1 };
        m[(r as usize - 1) * k1 + col] += 1;
    }
    let n: u64 = m.iter().sum();
    let nf = n.max(1) as f64;
    let row = |r: usize| (0..k1).map(|c| m[r * k1 + c]).sum::<u64>() as f64;
    let col = |c: usize| (0..k).map(|r| m[r * k1 + c]).sum::<u64>() as f64;
    let diag: f64 = (0..k).map(|i| m[i * k1 + i] as f64).sum();
    let oa = diag / nf;
    let pe: f64 = (0..k).map(|i| row(i) * col(i)).sum::<f64>() / (nf * nf);
    let kappa = if pe < 1.0 { (oa - pe) / (1.0 - pe) } else { f64::NAN };
    let producers = (0..k).map(|i| if row(i) > 0.0 { m[i * k1 + i] as f64 / row(i) } else { f64::NAN }).collect();
    let users = (0..k).map(|i| if col(i) > 0.0 { m[i * k1 + i] as f64 / col(i) } else { f64::NAN }).collect();
    // Pontius & Millones (2011) on proportions.
    let quantity = (0..k).map(|i| (row(i) - col(i)).abs()).sum::<f64>() / (2.0 * nf);
    let allocation = (0..k).map(|i| 2.0 * (row(i) - m[i * k1 + i] as f64).min(col(i) - m[i * k1 + i] as f64)).sum::<f64>() / (2.0 * nf);
    // Olofsson: strata = mapped classes with area weights W_c; OA = Σ_c W_c n_cc / n_·c.
    let oa_area = area_weights.filter(|w| w.len() >= k).map(|w| {
        let (mut o, mut v) = (0.0, 0.0);
        for c in 0..k {
            let nc = col(c);
            if nc < 1.0 {
                continue;
            }
            let u = m[c * k1 + c] as f64 / nc;
            o += w[c] * u;
            if nc > 1.0 {
                v += w[c] * w[c] * u * (1.0 - u) / (nc - 1.0);
            }
        }
        (o, 1.96 * v.sqrt())
    });
    // Return the k × k part plus the unclassified column folded into the matrix as k × (k + 1).
    Accuracy { k, matrix: m, n, oa, kappa, producers, users, quantity, allocation, oa_area }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn congalton_example_reconciles() {
        // 3 classes: 50 correct of class 1, mistakes elsewhere.
        let mut r = Vec::new();
        let mut c = Vec::new();
        for (rr, cc, n) in [(1u8, 1u8, 50), (1, 2, 5), (2, 2, 40), (2, 3, 10), (3, 3, 30), (3, 1, 5)] {
            for _ in 0..n {
                r.push(rr);
                c.push(cc);
            }
        }
        let a = assess(&r, &c, 3, Some(&[0.5, 0.3, 0.2]));
        assert_eq!(a.n, 140);
        assert!((a.oa - 120.0 / 140.0).abs() < 1e-12);
        let pe = (55.0 * 55.0 + 50.0 * 45.0 + 35.0 * 40.0) / (140.0 * 140.0);
        assert!((a.kappa - (a.oa - pe) / (1.0 - pe)).abs() < 1e-12);
        assert!((a.quantity + a.allocation - (1.0 - a.oa)).abs() < 1e-12);
        assert!(a.oa_area.unwrap().0 > 0.8);
    }
}
