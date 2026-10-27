//! GIS Workbench spectral processing (Appendix D `gw-spectral`; REQ-MSI-05..14, 16;
//! REQ-EXT-28). Cubes are BIP f32 (`stats::Cube`); labels are u8 (0 = unclassified).

pub mod accuracy;
pub mod classify;
pub mod detect;
pub mod linalg;
pub mod misc;
pub mod stats;
pub mod transform;

#[cfg(test)]
mod tests {
    use super::*;

    /// Two Gaussian classes and an implanted target: ML separates them; RX flags the target.
    #[test]
    fn classes_and_anomaly() {
        let (w, h, nb) = (64usize, 32usize, 4usize);
        let mut s = 7u64;
        let mut g = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            let u = ((s >> 11) as f64 / (1u64 << 53) as f64).max(1e-12);
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            let v = (s >> 11) as f64 / (1u64 << 53) as f64;
            (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
        };
        let m = [[0.2, 0.3, 0.4, 0.5], [0.5, 0.4, 0.3, 0.2]];
        let mut v = vec![0f32; w * h * nb];
        let mut truth = vec![0u8; w * h];
        for p in 0..w * h {
            let k = usize::from(p % w >= w / 2);
            truth[p] = (k + 1) as u8;
            for b in 0..nb {
                v[p * nb + b] = (m[k][b] + 0.02 * g()) as f32;
            }
        }
        let t = 10 * w + 10;
        for b in 0..nb {
            v[t * nb + b] = [0.9, 0.1, 0.9, 0.1][b];
        }
        let c = stats::Cube { v: &v, nb, w, h };
        let train: Vec<Vec<usize>> = vec![(0..w * h).filter(|p| p % w < 8).collect(), (0..w * h).filter(|p| p % w >= w - 8).collect()];
        let cls = classify::train(&c, &train);
        let (lab, _) = classify::classify(&c, &cls, classify::Method::MaxLikelihood, f64::NAN);
        let a = accuracy::assess(&truth, &lab, 2, None);
        assert!(a.oa > 0.99, "OA {}", a.oa);
        let rx = detect::rx_global(&c, 1);
        let best = (0..rx.len()).max_by(|&i, &j| rx[i].partial_cmp(&rx[j]).unwrap()).unwrap();
        assert_eq!(best, t);
        let (km, _) = classify::kmeans(&c, 2, 20, 1, 0.001);
        let ka = accuracy::assess(&truth, &km, 2, None);
        assert!(ka.oa > 0.99 || ka.oa < 0.01, "K-means splits the two classes ({})", ka.oa);
        let pca = transform::pca(&c, 1);
        assert!(pca.values[0] > 10.0 * pca.values[1]);
        let mnf = transform::mnf(&c, 1);
        assert!(mnf.values[0] > mnf.values[nb - 1]);
    }
}
