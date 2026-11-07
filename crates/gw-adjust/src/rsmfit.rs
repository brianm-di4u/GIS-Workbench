//! Build an RSM from any sensor model (REQ-GAP-18): multi-section polynomials (RSMPIA + one
//! RSMPCA per section) or ground-to-image grids (RSMGIA + one RSMGGA per section) in the geodetic
//! ground domain. No NGA sample RSMs are available (O-12), so these synthetic RSMs, generated from
//! a known geometry (an RPC or a frame camera), are what the RSM reader is validated against.
//!
//! - Each polynomial section is fitted over its image region plus a margin, at five heights:
//!   numerator powers as asked, a first-order denominator 1 + d₁x + d₂y + d₃z, by the linearised
//!   r·D − N = −r … system, reweighted once by 1/D².
//! - The section index is a quadratic in unnormalised x, y, z fitted over the whole image.
//! - Grid sections sample the model at NPLN planes over each section's footprint (plus margin).
//! - The result carries the fit errors (RFEP/CFEP, GGRFEP/GGCFEP) measured on a separate grid.

use crate::linalg::{cholesky, chol_solve, Mat};
use gw_abi::{Error, Json, Result};
use gw_sensor::rsm::{Domain, Geometry, GridPlane, GridSection, Poly, PolySection, RsmModel, SectionIndex};
use gw_sensor::{Ground, SensorModel};

pub struct RsmSpec {
    pub rows: f64,
    pub cols: f64,
    pub h: (f64, f64),
    /// Sections in rows and columns.
    pub sections: (usize, usize),
    /// Grid sections instead of polynomials.
    pub grid: bool,
    /// Numerator maximum powers in x, y, z (polynomial sections).
    pub powers: (usize, usize, usize),
    /// Grid nodes per plane in x and y (at most), planes, interpolation order.
    pub nodes: (usize, usize),
    pub planes: usize,
    pub intord: usize,
    /// Margin around each section, as a fraction of its size.
    pub margin: f64,
}

impl Default for RsmSpec {
    fn default() -> Self {
        RsmSpec { rows: 0.0, cols: 0.0, h: (0.0, 1000.0), sections: (1, 1), grid: false, powers: (3, 3, 2), nodes: (21, 21), planes: 8, intord: 3, margin: 0.1 }
    }
}

pub struct RsmFit {
    pub model: RsmModel,
    /// Fit errors per section (row, col RMS, pixels).
    pub section_fep: Vec<(f64, f64)>,
    /// Against the generating model on a separate grid (pixels).
    pub rms_px: f64,
    pub max_px: f64,
}

fn dom(g: Ground) -> [f64; 3] {
    [g.lon.to_radians(), g.lat.to_radians(), g.h]
}

/// Least squares with a tiny ridge: A x ≈ b over rows of A.
fn lsq(rows: &[(Vec<f64>, f64, f64)], n: usize) -> Result<Vec<f64>> {
    let mut m = Mat::zeros(n);
    let mut v = vec![0.0; n];
    for (a, b, w) in rows {
        for i in 0..n {
            if a[i] == 0.0 {
                continue;
            }
            v[i] += w * a[i] * b;
            for j in 0..n {
                m.add(i, j, w * a[i] * a[j]);
            }
        }
    }
    let tr = (0..n).map(|i| m.at(i, i)).sum::<f64>() / n as f64;
    for i in 0..n {
        m.add(i, i, 1e-12 * tr.max(1e-300));
    }
    let l = cholesky(&m).ok_or_else(|| Error::range("RSM fit: the normal equations are singular"))?;
    Ok(chol_solve(&l, &v))
}

fn monomials(p: (usize, usize, usize), x: f64, y: f64, z: f64) -> Vec<f64> {
    let mut out = Vec::with_capacity((p.0 + 1) * (p.1 + 1) * (p.2 + 1));
    let mut zk = 1.0;
    for _ in 0..=p.2 {
        let mut yj = 1.0;
        for _ in 0..=p.1 {
            let mut xi = 1.0;
            for _ in 0..=p.0 {
                out.push(xi * yj * zk);
                xi *= x;
            }
            yj *= y;
        }
        zk *= z;
    }
    out
}

/// Samples (domain x, y, z; RSM row, col) over an image box at heights.
fn sample(model: &dyn SensorModel, r0: f64, r1: f64, c0: f64, c1: f64, h: (f64, f64), n: usize, nh: usize) -> Vec<([f64; 3], f64, f64)> {
    let mut out = Vec::new();
    for k in 0..nh {
        let hh = if nh > 1 { h.0 + (h.1 - h.0) * k as f64 / (nh - 1) as f64 } else { h.0 };
        for j in 0..n {
            for i in 0..n {
                let row = r0 + (r1 - r0) * j as f64 / (n - 1) as f64;
                let col = c0 + (c1 - c0) * i as f64 / (n - 1) as f64;
                if let Ok(g) = model.image_to_ground(col + 0.5, row + 0.5, hh) {
                    out.push((dom(g), row, col));
                }
            }
        }
    }
    out
}

fn fit_section(model: &dyn SensorModel, s: &RsmSpec, rsn: usize, csn: usize, rs: f64, cs: f64) -> Result<PolySection> {
    let (mr, mc) = (s.margin * rs, s.margin * cs);
    let (r0, r1) = ((rsn - 1) as f64 * rs - mr, rsn as f64 * rs + mr);
    let (c0, c1) = ((csn - 1) as f64 * cs - mc, csn as f64 * cs + mc);
    let pts = sample(model, r0, r1, c0, c1, s.h, 11, 5);
    if pts.len() < 60 {
        return Err(Error::range("RSM fit: the model does not reach enough of the section"));
    }
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for (p, _, _) in &pts {
        for i in 0..3 {
            lo[i] = lo[i].min(p[i]);
            hi[i] = hi[i].max(p[i]);
        }
    }
    let off = [0.5 * (r0 + r1), 0.5 * (c0 + c1), 0.5 * (lo[0] + hi[0]), 0.5 * (lo[1] + hi[1]), 0.5 * (lo[2] + hi[2])];
    let scale = [0.5 * (r1 - r0), 0.5 * (c1 - c0), (0.5 * (hi[0] - lo[0])).max(1e-9), (0.5 * (hi[1] - lo[1])).max(1e-9), (0.5 * (hi[2] - lo[2])).max(1.0)];
    let norm = |p: &[f64; 3]| ((p[0] - off[2]) / scale[2], (p[1] - off[3]) / scale[3], (p[2] - off[4]) / scale[4]);
    let nt = (s.powers.0 + 1) * (s.powers.1 + 1) * (s.powers.2 + 1);
    let fit = |target: &dyn Fn(f64, f64) -> f64| -> Result<(Vec<f64>, [f64; 3])> {
        let mut w: Vec<f64> = vec![1.0; pts.len()];
        let mut sol = Vec::new();
        for _ in 0..2 {
            let rows: Vec<(Vec<f64>, f64, f64)> = pts
                .iter()
                .zip(&w)
                .map(|((p, r, c), wt)| {
                    let (x, y, z) = norm(p);
                    let t = target(*r, *c);
                    let mut a = monomials(s.powers, x, y, z);
                    a.extend_from_slice(&[-t * x, -t * y, -t * z]);
                    (a, t, *wt)
                })
                .collect();
            sol = lsq(&rows, nt + 3)?;
            for (k, (p, _, _)) in pts.iter().enumerate() {
                let (x, y, z) = norm(p);
                let d = 1.0 + sol[nt] * x + sol[nt + 1] * y + sol[nt + 2] * z;
                w[k] = 1.0 / (d * d).max(1e-6);
            }
        }
        Ok((sol[..nt].to_vec(), [sol[nt], sol[nt + 1], sol[nt + 2]]))
    };
    let (rn, rd) = fit(&|r, _| (r - off[0]) / scale[0])?;
    let (cn, cd) = fit(&|_, c| (c - off[1]) / scale[1])?;
    let den = |d: [f64; 3]| Poly { px: 1, py: 1, pz: 1, c: vec![1.0, d[0], d[1], 0.0, d[2], 0.0, 0.0, 0.0] };
    let num = |c: Vec<f64>| Poly { px: s.powers.0, py: s.powers.1, pz: s.powers.2, c };
    Ok(PolySection { rsn, csn, off, scale, polys: [num(rn), den(rd), num(cn), den(cd)] })
}

/// The quadratic section index, fitted in normalised coordinates and expanded to unnormalised.
fn fit_index(model: &dyn SensorModel, s: &RsmSpec) -> Result<SectionIndex> {
    let pts = sample(model, 0.0, s.rows - 1.0, 0.0, s.cols - 1.0, s.h, 15, 3);
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for (p, _, _) in &pts {
        for i in 0..3 {
            lo[i] = lo[i].min(p[i]);
            hi[i] = hi[i].max(p[i]);
        }
    }
    let o = [0, 1, 2].map(|i| 0.5 * (lo[i] + hi[i]));
    let sc = [0, 1, 2].map(|i| (0.5 * (hi[i] - lo[i])).max(if i == 2 { 1.0 } else { 1e-9 }));
    let q = |u: f64, v: f64, w: f64| vec![1.0, u, v, w, u * u, u * v, u * w, v * v, v * w, w * w];
    let mut fits = Vec::new();
    for which in 0..2 {
        let rows: Vec<(Vec<f64>, f64, f64)> = pts.iter().map(|(p, r, c)| (q((p[0] - o[0]) / sc[0], (p[1] - o[1]) / sc[1], (p[2] - o[2]) / sc[2]), if which == 0 { *r } else { *c }, 1.0)).collect();
        fits.push(lsq(&rows, 10)?);
    }
    // u = αx + β per axis; expand Σ aₖ·basisₖ(u, v, w) into [1, x, y, z, xx, xy, xz, yy, yz, zz].
    let lin = |i: usize| -> [f64; 4] {
        let mut l = [-o[i] / sc[i], 0.0, 0.0, 0.0];
        l[1 + i] = 1.0 / sc[i];
        l
    };
    let mul = |a: [f64; 4], b: [f64; 4]| -> [f64; 10] {
        let mut out = [0.0; 10];
        let idx = |i: usize, j: usize| -> usize {
            let (i, j) = (i.min(j), i.max(j));
            match (i, j) {
                (1, 1) => 4,
                (1, 2) => 5,
                (1, 3) => 6,
                (2, 2) => 7,
                (2, 3) => 8,
                _ => 9,
            }
        };
        for i in 0..4 {
            for j in 0..4 {
                let v = a[i] * b[j];
                if v == 0.0 {
                    continue;
                }
                let k = if i == 0 { j } else if j == 0 { i } else { idx(i, j) };
                out[k] += v;
            }
        }
        out
    };
    let expand = |a: &[f64]| -> [f64; 10] {
        let (u, v, w) = (lin(0), lin(1), lin(2));
        let one = [1.0, 0.0, 0.0, 0.0];
        let basis = [mul(one, one), mul(u, one), mul(v, one), mul(w, one), mul(u, u), mul(u, v), mul(u, w), mul(v, v), mul(v, w), mul(w, w)];
        let mut out = [0.0; 10];
        for (k, b) in basis.iter().enumerate() {
            for m in 0..10 {
                out[m] += a[k] * b[m];
            }
        }
        out
    };
    let (rn, cn) = s.sections;
    Ok(SectionIndex { r: expand(&fits[0]), c: expand(&fits[1]), rnis: rn, cnis: cn, rssiz: s.rows / rn as f64, cssiz: s.cols / cn as f64 })
}

fn fit_grid(model: &dyn SensorModel, s: &RsmSpec, rsn: usize, csn: usize, rs: f64, cs: f64) -> Result<GridSection> {
    let (mr, mc) = (s.margin * rs, s.margin * cs);
    let (r0, r1) = ((rsn - 1) as f64 * rs - mr, rsn as f64 * rs + mr);
    let (c0, c1) = ((csn - 1) as f64 * cs - mc, csn as f64 * cs + mc);
    let np = s.planes.max(2);
    let dz = ((s.h.1 - s.h.0) / (np - 1) as f64).max(1.0);
    // Footprint of the section box per plane.
    let mut boxes = Vec::with_capacity(np);
    for k in 0..np {
        let z = s.h.0 + k as f64 * dz;
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for t in 0..=8 {
            let f = t as f64 / 8.0;
            for (row, col) in [(r0, c0 + f * (c1 - c0)), (r1, c0 + f * (c1 - c0)), (r0 + f * (r1 - r0), c0), (r0 + f * (r1 - r0), c1)] {
                let g = model.image_to_ground(col + 0.5, row + 0.5, z)?;
                let p = dom(g);
                for i in 0..2 {
                    lo[i] = lo[i].min(p[i]);
                    hi[i] = hi[i].max(p[i]);
                }
            }
        }
        boxes.push((lo, hi));
    }
    // Every plane covers the union of the footprints: interpolation across planes evaluates each
    // plane at the same (x, y).
    let lo = [0, 1].map(|i| boxes.iter().map(|(l, _)| l[i]).fold(f64::INFINITY, f64::min));
    let hi = [0, 1].map(|i| boxes.iter().map(|(_, h)| h[i]).fold(f64::NEG_INFINITY, f64::max));
    let (nx, ny) = (s.nodes.0.max(2), s.nodes.1.max(2));
    let dx = (hi[0] - lo[0]) / (nx - 1) as f64;
    let dy = (hi[1] - lo[1]) / (ny - 1) as f64;
    let mut planes = Vec::with_capacity(np);
    for k in 0..np {
        let z = s.h.0 + k as f64 * dz;
        let (x0, y0) = (lo[0], lo[1]);
        let mut row = vec![f64::NAN; nx * ny];
        let mut col = vec![f64::NAN; nx * ny];
        for j in 0..ny {
            for i in 0..nx {
                let g = Ground { lat: (y0 + j as f64 * dy).to_degrees(), lon: (x0 + i as f64 * dx).to_degrees(), h: z };
                if let Ok((x, y)) = model.ground_to_image(g) {
                    row[j * nx + i] = y - 0.5;
                    col[j * nx + i] = x - 0.5;
                }
            }
        }
        planes.push(GridPlane { x0, y0, nx, ny, row, col });
    }
    Ok(GridSection { rsn, csn, intord: s.intord.min(3), z0: s.h.0, dz, dx, dy, planes })
}

/// Fit an RSM to `model` over the image and height range of `s`.
pub fn fit_rsm(model: &dyn SensorModel, s: &RsmSpec) -> Result<RsmFit> {
    let (rn, cn) = s.sections;
    if !(s.rows > 1.0 && s.cols > 1.0 && rn >= 1 && cn >= 1 && rn <= 99 && cn <= 99 && s.h.1 > s.h.0) {
        return Err(Error::invalid("RSM fit: needs an image size, 1–99 sections each way and a height range"));
    }
    let (rs, cs) = (s.rows / rn as f64, s.cols / cn as f64);
    let index = if rn * cn > 1 { Some(fit_index(model, s)?) } else { None };
    let geometry = if s.grid {
        let mut v = Vec::new();
        for i in 1..=rn {
            for j in 1..=cn {
                v.push(fit_grid(model, s, i, j, rs, cs)?);
            }
        }
        Geometry::Grid(v)
    } else {
        let mut v = Vec::new();
        for i in 1..=rn {
            for j in 1..=cn {
                v.push(fit_section(model, s, i, j, rs, cs)?);
            }
        }
        Geometry::Poly(v)
    };
    let m = RsmModel::build(Domain::Geodetic, [0.0; 3], [[0.0; 3]; 3], (s.rows, s.cols), (0.0, 0.0), None, geometry, index)?;
    // Fit errors per section, and overall, on a grid offset from the fit samples.
    let mut section_fep = Vec::new();
    let (mut ss, mut n, mut mx) = (0.0, 0usize, 0.0f64);
    for i in 1..=rn {
        for j in 1..=cn {
            let (mut er, mut ec, mut k) = (0.0, 0.0, 0usize);
            for kh in 0..3 {
                let h = s.h.0 + (s.h.1 - s.h.0) * (0.25 + 0.25 * kh as f64);
                for a in 0..7 {
                    for b in 0..7 {
                        let y = (i - 1) as f64 * rs + rs * (a as f64 + 0.37) / 7.0;
                        let x = (j - 1) as f64 * cs + cs * (b as f64 + 0.61) / 7.0;
                        let g = model.image_to_ground(x, y, h)?;
                        let (x2, y2) = m.ground_to_image(g)?;
                        er += (y2 - y).powi(2);
                        ec += (x2 - x).powi(2);
                        mx = mx.max((x2 - x).hypot(y2 - y));
                        k += 1;
                    }
                }
            }
            ss += er + ec;
            n += k;
            section_fep.push(((er / k as f64).sqrt(), (ec / k as f64).sqrt()));
        }
    }
    Ok(RsmFit { model: m, section_fep, rms_px: (ss / n as f64).sqrt(), max_px: mx })
}

/// JSON of a fitted RSM in the shape `app/src/sensor/rsm.js` reads and writes as TREs.
pub fn rsm_json(f: &RsmFit) -> String {
    let m = &f.model;
    let mut j = Json::new();
    j.obj().kv_int("domain", 0).kv_num("rows", m.size.0).kv_num("cols", m.size.1).kv_num("minr", 0.0).kv_num("minc", 0.0).kv_num("rmsPx", f.rms_px).kv_num("maxPx", f.max_px);
    let index = |j: &mut Json, key: &str, ix: &Option<SectionIndex>| {
        match ix {
            Some(ix) => {
                j.key(key).obj().key("r").arr();
                for v in ix.r {
                    j.num(v);
                }
                j.end_arr().key("c").arr();
                for v in ix.c {
                    j.num(v);
                }
                j.end_arr().kv_int("rnis", ix.rnis as i64).kv_int("cnis", ix.cnis as i64).kv_num("rssiz", ix.rssiz).kv_num("cssiz", ix.cssiz).end_obj();
            }
            None => {
                j.key(key).null();
            }
        };
    };
    match &m.geometry {
        Geometry::Poly(secs) => {
            index(&mut j, "index", &m.index);
            j.key("sections").arr();
            for (s, fep) in secs.iter().zip(&f.section_fep) {
                j.obj().kv_int("rsn", s.rsn as i64).kv_int("csn", s.csn as i64).kv_num("rfep", fep.0).kv_num("cfep", fep.1).key("off").arr();
                for v in s.off {
                    j.num(v);
                }
                j.end_arr().key("scale").arr();
                for v in s.scale {
                    j.num(v);
                }
                j.end_arr().key("polys").arr();
                for p in &s.polys {
                    j.obj().kv_int("px", p.px as i64).kv_int("py", p.py as i64).kv_int("pz", p.pz as i64).key("c").arr();
                    for v in &p.c {
                        j.num(*v);
                    }
                    j.end_arr().end_obj();
                }
                j.end_arr().end_obj();
            }
            j.end_arr();
            j.key("gindex").null().key("grids").arr().end_arr();
        }
        Geometry::Grid(secs) => {
            j.key("index").null().key("sections").arr().end_arr();
            index(&mut j, "gindex", &m.index);
            j.key("grids").arr();
            for (s, fep) in secs.iter().zip(&f.section_fep) {
                j.obj().kv_int("rsn", s.rsn as i64).kv_int("csn", s.csn as i64).kv_num("rfep", fep.0).kv_num("cfep", fep.1).kv_int("intord", s.intord as i64);
                j.kv_num("z0", s.z0).kv_num("dz", s.dz).kv_num("dx", s.dx).kv_num("dy", s.dy).key("planes").arr();
                for p in &s.planes {
                    j.obj().kv_num("x0", p.x0).kv_num("y0", p.y0).kv_int("nx", p.nx as i64).kv_int("ny", p.ny as i64).key("row").arr();
                    for v in &p.row {
                        j.num(*v);
                    }
                    j.end_arr().key("col").arr();
                    for v in &p.col {
                        j.num(*v);
                    }
                    j.end_arr().end_obj();
                }
                j.end_arr().end_obj();
            }
            j.end_arr();
        }
    }
    j.end_obj();
    j.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use gw_sensor::frame::{Camera, FrameModel};

    fn frame() -> FrameModel {
        // 6000 × 4000 oblique-ish aerial frame with distortion, 1500 m above ground.
        let cam = Camera { focal_mm: 50.0, pixel_mm: 0.004, cx: 3000.0, cy: 2000.0, k: [2e-5, -1e-9, 0.0], p: [1e-6, -2e-6], width: 6000.0, height: 4000.0, ..Camera::default() };
        FrameModel::new(cam, Ground { lat: 34.5, lon: -116.5, h: 2100.0 }, [8.0, -5.0, 30.0], "frame").unwrap()
    }

    #[test]
    fn multi_section_polynomial_from_a_frame_camera() {
        let f = frame();
        let s = RsmSpec { rows: 4000.0, cols: 6000.0, h: (400.0, 900.0), sections: (2, 3), ..RsmSpec::default() };
        let r = fit_rsm(&f, &s).unwrap();
        assert!(r.rms_px < 0.01 && r.max_px < 0.05, "rms {} max {}", r.rms_px, r.max_px);
        assert!(r.model.name().contains("2 × 3 sections"));
        // One section fits worse than six (the reason for sections).
        let one = fit_rsm(&f, &RsmSpec { sections: (1, 1), powers: (1, 1, 1), ..s }).unwrap();
        let six = fit_rsm(&f, &RsmSpec { sections: (2, 3), powers: (1, 1, 1), ..s }).unwrap();
        assert!(six.rms_px < one.rms_px, "six {} one {}", six.rms_px, one.rms_px);
        // Image → ground → image through the RSM itself.
        for (x, y) in [(10.0, 10.0), (2999.0, 1999.0), (3001.0, 2001.0), (5990.0, 3990.0)] {
            let g = r.model.image_to_ground(x, y, 650.0).unwrap();
            let (x2, y2) = r.model.ground_to_image(g).unwrap();
            assert!((x2 - x).hypot(y2 - y) < 1e-6);
        }
        let js = rsm_json(&r);
        let v: serde_json::Value = serde_json::from_str(&js).unwrap();
        assert_eq!(v["sections"].as_array().unwrap().len(), 6);
        assert_eq!(v["index"]["rnis"], 2);
    }

    #[test]
    fn grid_from_a_frame_camera() {
        let f = frame();
        let s = RsmSpec { rows: 4000.0, cols: 6000.0, h: (400.0, 900.0), sections: (2, 2), grid: true, nodes: (25, 25), planes: 8, intord: 3, ..RsmSpec::default() };
        let r = fit_rsm(&f, &s).unwrap();
        assert!(r.rms_px < 0.02 && r.max_px < 0.05, "rms {} max {}", r.rms_px, r.max_px);
        // An oblique aerial frame is strongly non-linear in height (depth 1.2–1.7 km): four planes
        // leave 0.25 px, and linear interpolation is far coarser (the reason grids carry INTORD).
        let four = fit_rsm(&f, &RsmSpec { planes: 4, ..s }).unwrap();
        assert!(four.rms_px > 0.1 && four.rms_px < 0.5, "four planes {}", four.rms_px);
        let lin = fit_rsm(&f, &RsmSpec { intord: 1, ..s }).unwrap();
        assert!(lin.rms_px > 10.0 * r.rms_px, "linear {}", lin.rms_px);
        let v: serde_json::Value = serde_json::from_str(&rsm_json(&r)).unwrap();
        assert_eq!(v["grids"].as_array().unwrap().len(), 4);
        assert_eq!(v["gindex"]["cnis"], 2);
    }
}
