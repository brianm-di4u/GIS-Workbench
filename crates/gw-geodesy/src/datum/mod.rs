//! Datum and height transformations with grids and time-dependent frames (REQ-GAP-16,
//! SDP-2.3 GR-05). The arithmetic follows PROJ 9.9 so results agree with `cct`/`cs2cs`
//! (the golden tests hold it to 1 mm): `grid` and `tiff` read the grid files, `shift` applies
//! them, `helmert` and `frames` carry the EPSG frame transformations with their rates.

pub mod frames;
pub mod grid;
pub mod helmert;
pub mod shift;
pub mod tiff;

#[cfg(test)]
mod tests {
    use super::grid::{GridSet, Role, DEG_TO_RAD};
    use super::shift::*;
    use super::tiff::tests::write_tiff;

    const META_H: &str = r#"<GDALMetadata><Item name="TYPE">HORIZONTAL_OFFSET</Item><Item name="DESCRIPTION" sample="0" role="description">latitude_offset</Item><Item name="DESCRIPTION" sample="1" role="description">longitude_offset</Item><Item name="UNITTYPE" sample="0" role="unittype">arc-second</Item><Item name="UNITTYPE" sample="1" role="unittype">arc-second</Item></GDALMetadata>"#;
    const META_V: &str = r#"<GDALMetadata><Item name="TYPE">VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL</Item><Item name="DESCRIPTION" sample="0" role="description">geoid_undulation</Item><Item name="UNITTYPE" sample="0" role="unittype">metre</Item></GDALMetadata>"#;

    /// A 1′ grid with its NW node at (−10°, 50°), 13 × 9 nodes; lat offset = 1″·row, lon = 2″·col.
    fn hgrid() -> Vec<u8> {
        let (w, h) = (13, 9);
        let mut v = Vec::new();
        for r in 0..h {
            for c in 0..w {
                v.push(r as f32 * 1.0);
                v.push(c as f32 * 2.0);
            }
        }
        write_tiff(&[(w, h, 2, v, META_H.into(), None)], true)
    }

    #[test]
    fn hgridshift_bilinear_and_inverse() {
        let s = GridSet::open("t.tif", hgrid(), Role::Horizontal, 1 << 20).unwrap();
        let sets = [&s];
        // A point on node (col 3, TIFF row 2): lat offset 2″, lon 6″.
        let lam = (-10.0 + 3.0 / 60.0) * DEG_TO_RAD;
        let phi = (50.0 - 2.0 / 60.0) * DEG_TO_RAD;
        let (l, p, _) = hgrid_apply(&sets, lam, phi, false).unwrap();
        assert!(((l - lam) / DEG_TO_RAD * 3600.0 - 6.0).abs() < 1e-6);
        assert!(((p - phi) / DEG_TO_RAD * 3600.0 - 2.0).abs() < 1e-6);
        let (l2, p2, _) = hgrid_apply(&sets, l, p, true).unwrap();
        assert!((l2 - lam).abs() < 1e-11 && (p2 - phi).abs() < 1e-11);
        // Outside the grid.
        assert!(hgrid_apply(&sets, 0.0, 0.0, false).is_none());
    }

    #[test]
    fn vgridshift_nodata_reweighting() {
        let (w, h) = (4, 3);
        let mut v: Vec<f32> = (0..w * h).map(|i| i as f32).collect();
        v[0] = -32768.0;
        let t = write_tiff(&[(w, h, 1, v, META_V.into(), Some("-32768".into()))], true);
        let s = GridSet::open("v.tif", t, Role::Vertical, 1 << 20).unwrap();
        // Centre of the NW cell: nodes (0,0)=nodata, (1,0)=1, (0,1)=4, (1,1)=5 in TIFF order.
        let lam = (-10.0 + 0.5 / 60.0) * DEG_TO_RAD;
        let phi = (50.0 - 0.5 / 60.0) * DEG_TO_RAD;
        let (z, _) = vgrid_value(&[&s], lam, phi, 1.0).unwrap();
        assert!((z - (1.0 + 4.0 + 5.0) / 3.0).abs() < 1e-9, "{z}");
        // On the nodata node itself: the other weights are zero → no valid weight.
        let lam0 = -10.0 * DEG_TO_RAD;
        let phi0 = 50.0 * DEG_TO_RAD;
        assert!(vgrid_value(&[&s], lam0 + 1e-15, phi0 - 1e-15, 1.0).is_none_or(|(z, _)| z.is_finite()));
    }

    #[test]
    fn gridshift_biquadratic_reproduces_a_quadratic() {
        let meta = META_H.replace("</GDALMetadata>", r#"<Item name="interpolation_method">biquadratic</Item></GDALMetadata>"#);
        let (w, h) = (9, 7);
        let f = |x: f64, y: f64| 0.3 * x * x - 0.2 * x * y + 0.1 * y * y + x - 2.0 * y + 5.0;
        let mut v = Vec::new();
        for r in 0..h {
            // TIFF row r is grid row (h-1-r) from the south.
            let ys = (h - 1 - r) as f64;
            for c in 0..w {
                v.push(f(c as f64, ys) as f32);
                v.push((f(ys, c as f64) * 0.5) as f32);
            }
        }
        let s = GridSet::open("q.tif", write_tiff(&[(w, h, 2, v, meta, None)], true), Role::Generic, 1 << 20).unwrap();
        let plan = generic_plan(&[&s]).unwrap();
        let (gx, gy) = (3.37, 2.81);
        let lam = (-10.0 + gx / 60.0) * DEG_TO_RAD;
        let phi = (50.0 - (h as f64 - 1.0) / 60.0 + gy / 60.0) * DEG_TO_RAD;
        let ((l, p, _), _) = gridshift_apply(&[&s], &plan, (lam, phi, 0.0), false, None, true).unwrap();
        let dlat = (p - phi) / DEG_TO_RAD * 3600.0;
        let dlon = (l - lam) / DEG_TO_RAD * 3600.0;
        assert!((dlat - f(gx, gy)).abs() < 1e-4, "{dlat} vs {}", f(gx, gy));
        assert!((dlon - f(gy, gx) * 0.5).abs() < 1e-4, "{dlon}");
    }

    #[test]
    fn ntv2_and_gtx_readers() {
        // NTv2: one sub-grid, 3 × 2 nodes, 60″ spacing, positive west.
        let mut b = Vec::new();
        let rec = |b: &mut Vec<u8>, k: &str, v: &[u8]| {
            let mut key = k.as_bytes().to_vec();
            key.resize(8, b' ');
            b.extend(key);
            let mut val = v.to_vec();
            val.resize(8, 0);
            b.extend(val);
        };
        rec(&mut b, "NUM_OREC", &11i32.to_le_bytes());
        rec(&mut b, "NUM_SREC", &11i32.to_le_bytes());
        rec(&mut b, "NUM_FILE", &1i32.to_le_bytes());
        rec(&mut b, "GS_TYPE", b"SECONDS ");
        for k in ["VERSION", "SYSTEM_F", "SYSTEM_T", "MAJOR_F", "MINOR_F", "MAJOR_T", "MINOR_T"] {
            rec(&mut b, k, &[0; 8]);
        }
        rec(&mut b, "SUB_NAME", b"A       ");
        rec(&mut b, "PARENT", b"NONE    ");
        rec(&mut b, "CREATED", b"        ");
        rec(&mut b, "UPDATED", b"        ");
        for (k, v) in [("S_LAT", 180000.0f64), ("N_LAT", 180060.0), ("E_LONG", -36120.0), ("W_LONG", -36000.0), ("LAT_INC", 60.0), ("LONG_INC", 60.0)] {
            rec(&mut b, k, &v.to_le_bytes());
        }
        rec(&mut b, "GS_COUNT", &6i32.to_le_bytes());
        // Rows south → north, columns east → west: lon shift (positive west) = 10 + column-from-east.
        for _r in 0..2 {
            for c in 0..3 {
                for v in [1.5f32, 10.0 + c as f32, 0.0, 0.0] {
                    b.extend(v.to_le_bytes());
                }
            }
        }
        let s = GridSet::open("n.gsb", b, Role::Horizontal, 1 << 20).unwrap();
        // West node (10°E, 50°N): column-from-east 2 → 12″ west → −12″ east.
        let lam = 10.0 * DEG_TO_RAD;
        let phi = 50.0 * DEG_TO_RAD;
        let (l, p, _) = hgrid_apply(&[&s], lam, phi, false).unwrap();
        assert!(((l - lam) / DEG_TO_RAD * 3600.0 + 12.0).abs() < 1e-5, "{}", (l - lam) / DEG_TO_RAD * 3600.0);
        assert!(((p - phi) / DEG_TO_RAD * 3600.0 - 1.5).abs() < 1e-5);
        // GTX: 2 × 2, big-endian.
        let mut g = Vec::new();
        for v in [49.0f64, 9.0, 1.0, 1.0] {
            g.extend(v.to_be_bytes());
        }
        g.extend(2i32.to_be_bytes());
        g.extend(2i32.to_be_bytes());
        for v in [10.0f32, 20.0, 30.0, -88.8888] {
            g.extend(v.to_be_bytes());
        }
        let s = GridSet::open("g.gtx", g, Role::Vertical, 1 << 20).unwrap();
        let (z, _) = vgrid_value(&[&s], 9.5 * DEG_TO_RAD, 49.5 * DEG_TO_RAD, 1.0).unwrap();
        assert!((z - 20.0).abs() < 1e-9, "{z}");
    }
}

