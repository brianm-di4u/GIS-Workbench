//! Ground control for a UAV block (REG-075): the control file, the marks in the photographs, and
//! the fit of the sparse model to the surveyed points with checkpoint residuals.
//!
//! The control file is a CSV, one row per mark: `id,x,y,z,crs,sigma,role,image,px,py`. `x,y,z` are
//! projected metres in `crs` (`EPSG:32617`); `sigma` is the survey's standard deviation in metres;
//! `role` is `gcp` (used in the fit) or `check` (held out, reported); `image,px,py` is one mark, in
//! pixels from the image's top-left corner. A point marked in several photographs takes several
//! rows; its coordinates must agree. OpenDroneMap's `gcp_list.txt` (a CRS line, then
//! `x y z px py image [id]`) is read too, every point as a `gcp` with sigma 0.02 m.

use crate::colmap::{rotation, Camera, Model};
use crate::geo::{fit_sim3, jacobi, mat_vec, sub, Sim3, V3};
use crate::Res;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct Mark {
    pub image: String,
    pub px: f64,
    pub py: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ControlPoint {
    pub id: String,
    pub xyz: V3,
    pub sigma: f64,
    pub check: bool,
    pub marks: Vec<Mark>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Control {
    pub epsg: u32,
    pub points: Vec<ControlPoint>,
}

/// ODM's lists carry no sigma; 2 cm is a typical RTK target survey.
const ODM_SIGMA: f64 = 0.02;

/// `EPSG:32617`, `WGS84 UTM 17N`, or `+proj=utm +zone=11 [+south] ... +datum=WGS84`.
pub fn parse_crs(s: &str) -> Res<u32> {
    let t = s.trim();
    let up = t.to_ascii_uppercase();
    if let Some(n) = up.strip_prefix("EPSG:") {
        return n
            .trim()
            .parse()
            .map_err(|_| format!("the CRS {t} is not an EPSG code"));
    }
    let wgs84 = up.contains("WGS84") || up.contains("WGS 84");
    if let Some(rest) = up
        .strip_prefix("WGS84 UTM ")
        .or_else(|| up.strip_prefix("WGS 84 / UTM ZONE "))
    {
        let rest = rest.trim();
        let (zone, hemi) = rest.split_at(rest.len().saturating_sub(1));
        let zone: u32 = zone
            .trim()
            .parse()
            .map_err(|_| format!("the CRS {t} names no UTM zone"))?;
        return utm_epsg(zone, hemi == "S");
    }
    if up.contains("+PROJ=UTM") && wgs84 {
        let zone = up
            .split_whitespace()
            .find_map(|w| w.strip_prefix("+ZONE="))
            .and_then(|z| z.parse().ok())
            .ok_or_else(|| format!("the CRS {t} names no UTM zone"))?;
        return utm_epsg(zone, up.contains("+SOUTH"));
    }
    Err(format!(
        "the CRS {t} is not supported: give EPSG:326xx or EPSG:327xx (WGS 84 / UTM)"
    ))
}

fn utm_epsg(zone: u32, south: bool) -> Res<u32> {
    if !(1..=60).contains(&zone) {
        return Err(format!("UTM zone {zone} does not exist"));
    }
    Ok(if south { 32700 } else { 32600 } + zone)
}

fn num(s: &str, what: &str, line: usize) -> Res<f64> {
    let v: f64 = s
        .trim()
        .parse()
        .map_err(|_| format!("line {line}: {what} {s:?} is not a number"))?;
    if v.is_finite() {
        Ok(v)
    } else {
        Err(format!("line {line}: {what} is not finite"))
    }
}

/// Read a control file (the CSV, or ODM's `gcp_list.txt`).
pub fn parse(text: &str) -> Res<Control> {
    let mut lines = text
        .lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l.trim()))
        .filter(|(_, l)| !l.is_empty() && !l.starts_with('#'));
    let (_, first) = lines.next().ok_or("the control file is empty")?;
    let header: Vec<String> = first
        .split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .collect();
    if header.len() > 1 && header[0] == "id" {
        parse_csv(&header, lines)
    } else {
        parse_odm(first, lines)
    }
}

fn add_mark(points: &mut BTreeMap<String, ControlPoint>, p: ControlPoint, line: usize) -> Res<()> {
    match points.get_mut(&p.id) {
        None => {
            points.insert(p.id.clone(), p);
        }
        Some(have) => {
            if sub(have.xyz, p.xyz).iter().any(|d| d.abs() > 1e-6) || have.check != p.check {
                return Err(format!(
                    "line {line}: point {} is given twice with different coordinates or roles",
                    p.id
                ));
            }
            have.marks.extend(p.marks);
        }
    }
    Ok(())
}

fn parse_csv<'a>(header: &[String], lines: impl Iterator<Item = (usize, &'a str)>) -> Res<Control> {
    let col = |name: &str| {
        header
            .iter()
            .position(|h| h == name)
            .ok_or_else(|| format!("the control file has no {name} column"))
    };
    let (ci, cx, cy, cz, ccrs, csig, crole) = (
        col("id")?,
        col("x")?,
        col("y")?,
        col("z")?,
        col("crs")?,
        col("sigma")?,
        col("role")?,
    );
    let (cim, cpx, cpy) = (col("image")?, col("px")?, col("py")?);
    let mut epsg = None;
    let mut points = BTreeMap::new();
    for (n, l) in lines {
        let f: Vec<&str> = l.split(',').map(str::trim).collect();
        if f.len() < header.len() {
            return Err(format!(
                "line {n}: {} fields, the header has {}",
                f.len(),
                header.len()
            ));
        }
        let crs = parse_crs(f[ccrs]).map_err(|e| format!("line {n}: {e}"))?;
        if epsg.is_some_and(|e| e != crs) {
            return Err(format!("line {n}: every point must be in the same CRS"));
        }
        epsg = Some(crs);
        let sigma = num(f[csig], "sigma", n)?;
        if sigma <= 0.0 {
            return Err(format!("line {n}: sigma must be more than 0"));
        }
        let check = match f[crole].to_ascii_lowercase().as_str() {
            "gcp" => false,
            "check" => true,
            r => return Err(format!("line {n}: role {r:?} is neither gcp nor check")),
        };
        if f[ci].is_empty() {
            return Err(format!("line {n}: the point has no id"));
        }
        let marks = if f[cim].is_empty() {
            vec![]
        } else {
            vec![Mark {
                image: f[cim].to_string(),
                px: num(f[cpx], "px", n)?,
                py: num(f[cpy], "py", n)?,
            }]
        };
        let xyz = [
            num(f[cx], "x", n)?,
            num(f[cy], "y", n)?,
            num(f[cz], "z", n)?,
        ];
        add_mark(
            &mut points,
            ControlPoint {
                id: f[ci].to_string(),
                xyz,
                sigma,
                check,
                marks,
            },
            n,
        )?;
    }
    Ok(Control {
        epsg: epsg.ok_or("the control file has no points")?,
        points: points.into_values().collect(),
    })
}

fn parse_odm<'a>(crs: &str, lines: impl Iterator<Item = (usize, &'a str)>) -> Res<Control> {
    let epsg = parse_crs(crs)?;
    let mut points = BTreeMap::new();
    for (n, l) in lines {
        let f: Vec<&str> = l.split_whitespace().collect();
        if f.len() < 6 {
            return Err(format!("line {n}: a gcp_list row needs x y z px py image"));
        }
        let xyz = [num(f[0], "x", n)?, num(f[1], "y", n)?, num(f[2], "z", n)?];
        // Without an id column, a point is its coordinates.
        let id = f
            .get(6)
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{:.3},{:.3},{:.3}", xyz[0], xyz[1], xyz[2]));
        let mark = Mark {
            image: f[5].to_string(),
            px: num(f[3], "px", n)?,
            py: num(f[4], "py", n)?,
        };
        add_mark(
            &mut points,
            ControlPoint {
                id,
                xyz,
                sigma: ODM_SIGMA,
                check: false,
                marks: vec![mark],
            },
            n,
        )?;
    }
    Ok(Control {
        epsg,
        points: points.into_values().collect(),
    })
}

/// A pixel to the normalised, undistorted image plane (z = 1) of a COLMAP camera. Pixel centres are
/// at +0.5 in COLMAP's convention, as in the control file's.
pub fn undistort(c: &Camera, px: f64, py: f64) -> Res<(f64, f64)> {
    let p = &c.params;
    let need = |n: usize| {
        if p.len() >= n {
            Ok(())
        } else {
            Err(format!("camera model {} has too few parameters", c.model))
        }
    };
    // fx, fy, cx, cy, then radial k1, k2 and tangential p1, p2 (absent = 0).
    let (fx, fy, cx, cy, k1, k2, p1, p2) = match c.model {
        0 => {
            need(3)?;
            (p[0], p[0], p[1], p[2], 0.0, 0.0, 0.0, 0.0)
        }
        1 => {
            need(4)?;
            (p[0], p[1], p[2], p[3], 0.0, 0.0, 0.0, 0.0)
        }
        2 => {
            need(4)?;
            (p[0], p[0], p[1], p[2], p[3], 0.0, 0.0, 0.0)
        }
        3 => {
            need(5)?;
            (p[0], p[0], p[1], p[2], p[3], p[4], 0.0, 0.0)
        }
        4 => {
            need(8)?;
            (p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7])
        }
        m => return Err(format!("camera model {m} is not supported for ground control (use SIMPLE_RADIAL, RADIAL or OPENCV)")),
    };
    let (xd, yd) = ((px - cx) / fx, (py - cy) / fy);
    // Fixed-point inversion of the distortion: converges for the small distortions of mapping lenses.
    let (mut x, mut y) = (xd, yd);
    for _ in 0..50 {
        let r2 = x * x + y * y;
        let radial = 1.0 + k1 * r2 + k2 * r2 * r2;
        let dx = 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x);
        let dy = p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y;
        let (nx, ny) = ((xd - dx) / radial, (yd - dy) / radial);
        let step = (nx - x).abs() + (ny - y).abs();
        (x, y) = (nx, ny);
        if step < 1e-14 {
            break;
        }
    }
    Ok((x, y))
}

/// The point in the model's frame that the marks see: linear triangulation (DLT) on the normalised
/// rays, from two or more photographs the model registered.
pub fn triangulate(model: &Model, marks: &[Mark]) -> Res<Option<(V3, usize)>> {
    let mut ata = [[0.0f64; 4]; 4];
    let mut used = 0;
    for m in marks {
        let Some(im) = model.images.iter().find(|i| i.name == m.image) else {
            continue;
        };
        let cam = model
            .cameras
            .get(&im.camera)
            .ok_or_else(|| format!("photograph {} has no camera", im.name))?;
        let (x, y) = undistort(cam, m.px, m.py)?;
        let r = rotation(im);
        let p = [
            [r[0][0], r[0][1], r[0][2], im.t[0]],
            [r[1][0], r[1][1], r[1][2], im.t[1]],
            [r[2][0], r[2][1], r[2][2], im.t[2]],
        ];
        for row in [
            std::array::from_fn::<f64, 4, _>(|j| x * p[2][j] - p[0][j]),
            std::array::from_fn(|j| y * p[2][j] - p[1][j]),
        ] {
            for a in 0..4 {
                for b in 0..4 {
                    ata[a][b] += row[a] * row[b];
                }
            }
        }
        used += 1;
    }
    if used < 2 {
        return Ok(None);
    }
    let (e, v) = jacobi(ata);
    let k = (0..4).min_by(|a, b| e[*a].total_cmp(&e[*b])).unwrap_or(0);
    let w = v[3][k];
    if w.abs() < 1e-12 {
        return Ok(None);
    }
    let x = [v[0][k] / w, v[1][k] / w, v[2][k] / w];
    // In front of every camera that saw it.
    for m in marks {
        if let Some(im) = model.images.iter().find(|i| i.name == m.image) {
            let c = mat_vec(&rotation(im), x);
            if c[2] + im.t[2] <= 0.0 {
                return Ok(None);
            }
        }
    }
    Ok(Some((x, used)))
}

#[derive(Debug, Clone)]
pub struct Residual {
    pub id: String,
    pub check: bool,
    pub d: V3,
}

#[derive(Debug, Clone)]
pub struct ControlFit {
    pub sim3: Sim3,
    pub residuals: Vec<Residual>,
    /// Points left out: fewer than two usable marks.
    pub unmarked: Vec<String>,
}

/// Root mean square of each axis over the residuals of one role.
pub fn rmse(r: &[Residual], check: bool) -> Option<V3> {
    let v: Vec<&Residual> = r.iter().filter(|x| x.check == check).collect();
    if v.is_empty() {
        return None;
    }
    let n = v.len() as f64;
    Some(std::array::from_fn(|k| {
        (v.iter().map(|x| x.d[k] * x.d[k]).sum::<f64>() / n).sqrt()
    }))
}

/// Fit the model to the ground control points (`offset` is subtracted from their coordinates, as
/// georef places the model) and measure every point, checkpoints included, against the fit.
pub fn fit_control(model: &Model, control: &Control, offset: V3) -> Res<ControlFit> {
    let mut seen = Vec::new();
    let mut unmarked = Vec::new();
    for p in &control.points {
        match triangulate(model, &p.marks)? {
            Some((x, _)) => seen.push((p, x)),
            None => unmarked.push(p.id.clone()),
        }
    }
    let gcps: Vec<&(&ControlPoint, V3)> = seen.iter().filter(|(p, _)| !p.check).collect();
    if gcps.len() < 3 {
        return Err(format!("{} ground control points are marked in two or more registered photographs; at least 3 are needed", gcps.len()));
    }
    let src: Vec<V3> = gcps.iter().map(|(_, x)| *x).collect();
    let dst: Vec<V3> = gcps.iter().map(|(p, _)| sub(p.xyz, offset)).collect();
    let sim3 = fit_sim3(&src, &dst)
        .ok_or("the ground control points could not be fitted (they may lie on a line)")?;
    let residuals = seen
        .iter()
        .map(|(p, x)| Residual {
            id: p.id.clone(),
            check: p.check,
            d: sub(sim3.apply(*x), sub(p.xyz, offset)),
        })
        .collect();
    Ok(ControlFit {
        sim3,
        residuals,
        unmarked,
    })
}

/// Marks are placed by hand: 2 px is a fair standard deviation.
const MARK_SIGMA_PX: f64 = 2.0;
/// COLMAP's tie points, after its own bundle adjustment.
const TIE_SIGMA_PX: f64 = 1.0;

/// The block after the bundle adjustment with ground control, back in the model's frame.
pub struct Adjusted {
    /// Image id to (quaternion w x y z, translation), world to camera.
    pub poses: std::collections::HashMap<u32, ([f64; 4], V3)>,
    /// Point id to position.
    pub points: std::collections::HashMap<u64, V3>,
    pub residuals: Vec<Residual>,
    pub stats: crate::ba::Stats,
}

/// Adjust the block (poses and tie points) with the ground control points as sigma-weighted
/// priors and their marks as observations, starting from the control fit `sim3`. Checkpoints stay
/// out of it, and are measured after it by triangulating their marks through the adjusted cameras.
pub fn adjust_block(
    model: &Model,
    obs: &std::collections::HashMap<u32, Vec<([f64; 2], u64)>>,
    control: &Control,
    sim3: &Sim3,
    offset: V3,
) -> Res<Adjusted> {
    use crate::ba::{adjust, rotate_into, Obs, Pose, Prior, Problem};
    use crate::colmap::centre;
    use crate::geo::{mat_mul, mat_to_quat, quat_to_mat, scale, transpose};
    let rs = quat_to_mat(sim3.q);
    let mut cams = Vec::with_capacity(model.images.len());
    let mut cam_of = std::collections::HashMap::new();
    for (k, im) in model.images.iter().enumerate() {
        let intr = model
            .cameras
            .get(&im.camera)
            .ok_or_else(|| format!("photograph {} has no camera", im.name))?
            .clone();
        cams.push(Pose {
            r: rotate_into(&rotation(im), &rs),
            c: sim3.apply(centre(im)),
            intr,
        });
        cam_of.insert(im.id, k);
    }
    let ids: Vec<u64> = model.points.keys().copied().collect();
    let index: std::collections::HashMap<u64, usize> =
        ids.iter().enumerate().map(|(k, id)| (*id, k)).collect();
    let mut pts: Vec<V3> = ids
        .iter()
        .map(|id| sim3.apply(model.points[id].xyz))
        .collect();
    let mut ba_obs = Vec::new();
    for (img, list) in obs {
        let Some(&cam) = cam_of.get(img) else {
            continue;
        };
        for (xy, pid) in list {
            if let Some(&pt) = index.get(pid) {
                ba_obs.push(Obs {
                    cam,
                    pt,
                    xy: *xy,
                    sigma: TIE_SIGMA_PX,
                });
            }
        }
    }
    let mut priors = Vec::new();
    let mut gcp_index = Vec::new();
    for p in control.points.iter().filter(|p| !p.check) {
        let Some((x, _)) = triangulate(model, &p.marks)? else {
            continue;
        };
        let pt = pts.len();
        pts.push(sim3.apply(x));
        for m in &p.marks {
            if let Some(&cam) = model.images.iter().position(|i| i.name == m.image).as_ref() {
                ba_obs.push(Obs {
                    cam,
                    pt,
                    xy: [m.px, m.py],
                    sigma: MARK_SIGMA_PX,
                });
            }
        }
        priors.push(Prior {
            pt,
            at: sub(p.xyz, offset),
            sigma: p.sigma,
        });
        gcp_index.push((p.id.clone(), pt));
    }
    if priors.len() < 3 {
        return Err(format!("{} ground control points are marked in two or more registered photographs; at least 3 are needed", priors.len()));
    }
    let mut pr = Problem {
        cams,
        pts,
        obs: ba_obs,
        priors,
    };
    let stats = adjust(&mut pr, 30);
    let mut residuals: Vec<Residual> = gcp_index
        .iter()
        .map(|(id, pt)| {
            let at = pr
                .priors
                .iter()
                .find(|q| q.pt == *pt)
                .map(|q| q.at)
                .unwrap_or([0.0; 3]);
            Residual {
                id: id.clone(),
                check: false,
                d: sub(pr.pts[*pt], at),
            }
        })
        .collect();
    // Checkpoints through the adjusted cameras (the map frame less the offset).
    let mut adjusted = Model {
        cameras: model.cameras.clone(),
        images: model.images.clone(),
        points: Default::default(),
    };
    for (k, im) in adjusted.images.iter_mut().enumerate() {
        let c = &pr.cams[k];
        im.q = mat_to_quat(&c.r);
        im.t = scale(mat_vec(&c.r, c.c), -1.0);
    }
    for p in control.points.iter().filter(|p| p.check) {
        if let Some((x, _)) = triangulate(&adjusted, &p.marks)? {
            residuals.push(Residual {
                id: p.id.clone(),
                check: true,
                d: sub(x, sub(p.xyz, offset)),
            });
        }
    }
    // Back to the model's frame: x = rs^T (y - t) / s.
    let back = |y: V3| scale(mat_vec(&transpose(&rs), sub(y, sim3.t)), 1.0 / sim3.s);
    let mut poses = std::collections::HashMap::new();
    for (k, im) in model.images.iter().enumerate() {
        let c = &pr.cams[k];
        let r_m = mat_mul(&c.r, &rs);
        let c_m = back(c.c);
        poses.insert(im.id, (mat_to_quat(&r_m), scale(mat_vec(&r_m, c_m), -1.0)));
    }
    let points = ids
        .iter()
        .enumerate()
        .map(|(k, id)| (*id, back(pr.pts[k])))
        .collect();
    Ok(Adjusted {
        poses,
        points,
        residuals,
        stats,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::colmap::Image;
    use crate::geo::{quat_to_mat, transpose};

    fn camera() -> Camera {
        Camera {
            model: 2,
            width: 4000,
            height: 3000,
            params: vec![3000.0, 2000.5, 1500.5, -0.08],
        }
    }

    /// Project a world point (model frame) through an image, with SIMPLE_RADIAL distortion.
    fn project(c: &Camera, im: &Image, x: V3) -> (f64, f64) {
        let p = crate::geo::add(mat_vec(&rotation(im), x), im.t);
        let (u, v) = (p[0] / p[2], p[1] / p[2]);
        let r2 = u * u + v * v;
        let d = 1.0 + c.params[3] * r2;
        (
            c.params[0] * u * d + c.params[1],
            c.params[0] * v * d + c.params[2],
        )
    }

    /// A 3 x 3 grid of cameras 100 m above the model's ground, looking down, slightly tilted.
    fn block() -> Model {
        let mut m = Model::default();
        m.cameras.insert(1, camera());
        let mut id = 0;
        for i in 0..3 {
            for j in 0..3 {
                id += 1;
                let tilt = 0.03 * (i as f64 - 1.0);
                // A camera looking down -Z: rotate 180 degrees about X, then a small tilt.
                let q = [(tilt / 2.0).sin(), (tilt / 2.0).cos(), 0.0, 0.0];
                let centre = [i as f64 * 40.0 - 40.0, j as f64 * 30.0 - 30.0, 100.0];
                let r = quat_to_mat(q);
                let t = crate::geo::scale(mat_vec(&r, centre), -1.0);
                m.images.push(Image {
                    id,
                    q,
                    t,
                    camera: 1,
                    name: format!("IMG_{id}.JPG"),
                    points: vec![],
                });
                let back = mat_vec(&transpose(&r), crate::geo::scale(t, -1.0));
                assert!(sub(back, centre).iter().all(|d| d.abs() < 1e-9));
            }
        }
        m
    }

    #[test]
    fn undistort_inverts_the_camera() {
        let c = camera();
        let (px, py) = (3500.0, 300.0);
        let (x, y) = undistort(&c, px, py).unwrap();
        let r2 = x * x + y * y;
        let d = 1.0 + c.params[3] * r2;
        assert!((c.params[0] * x * d + c.params[1] - px).abs() < 1e-8);
        assert!((c.params[0] * y * d + c.params[2] - py).abs() < 1e-8);
    }

    #[test]
    fn a_point_is_triangulated_from_its_marks() {
        let m = block();
        let truth = [7.0, -4.0, 3.5];
        let marks: Vec<Mark> = m
            .images
            .iter()
            .take(4)
            .map(|im| {
                let (px, py) = project(&m.cameras[&1], im, truth);
                Mark {
                    image: im.name.clone(),
                    px,
                    py,
                }
            })
            .collect();
        let (x, used) = triangulate(&m, &marks).unwrap().unwrap();
        assert_eq!(used, 4);
        assert!(sub(x, truth).iter().all(|d| d.abs() < 1e-6), "{x:?}");
        // One mark is not enough; a mark in a photograph the model did not register is skipped.
        assert_eq!(triangulate(&m, &marks[..1]).unwrap(), None);
        let stray = vec![
            marks[0].clone(),
            Mark {
                image: "NOT_IN_MODEL.JPG".into(),
                px: 1.0,
                py: 1.0,
            },
        ];
        assert_eq!(triangulate(&m, &stray).unwrap(), None);
    }

    /// The model is the ground scaled, turned and shifted (as COLMAP's arbitrary frame is); the fit
    /// to three or more ground control points recovers it, and the checkpoints land on their survey.
    #[test]
    fn the_fit_to_ground_control_puts_checkpoints_on_their_survey() {
        let m = block();
        // Ground (map, less the offset) = s R model + t.
        let truth = Sim3 {
            s: 2.5,
            q: {
                let a: f64 = 0.4;
                [(a / 2.0).cos(), 0.0, 0.0, (a / 2.0).sin()]
            },
            t: [512.0, 734.0, 300.0],
        };
        let offset = [440000.0, 4564000.0, 0.0];
        let model_pts = [
            [-20.0, -15.0, 0.0],
            [25.0, -10.0, 2.0],
            [0.0, 20.0, 1.0],
            [-15.0, 18.0, 4.0],
            [10.0, 0.0, -1.0],
        ];
        let points: Vec<ControlPoint> = model_pts
            .iter()
            .enumerate()
            .map(|(k, x)| {
                let marks = m
                    .images
                    .iter()
                    .filter_map(|im| {
                        let (px, py) = project(&m.cameras[&1], im, *x);
                        (px > 0.0 && px < 4000.0 && py > 0.0 && py < 3000.0).then(|| Mark {
                            image: im.name.clone(),
                            px,
                            py,
                        })
                    })
                    .collect();
                ControlPoint {
                    id: format!("p{k}"),
                    xyz: crate::geo::add(truth.apply(*x), offset),
                    sigma: 0.02,
                    check: k >= 3,
                    marks,
                }
            })
            .collect();
        let fit = fit_control(
            &m,
            &Control {
                epsg: 32617,
                points,
            },
            offset,
        )
        .unwrap();
        assert!((fit.sim3.s - truth.s).abs() < 1e-6, "{:?}", fit.sim3);
        let check = rmse(&fit.residuals, true).unwrap();
        assert!(check.iter().all(|d| *d < 1e-5), "{check:?}");
        assert_eq!(fit.residuals.iter().filter(|r| r.check).count(), 2);
    }

    #[test]
    fn fewer_than_three_marked_ground_control_points_are_refused() {
        let m = block();
        let p = |id: &str, check| ControlPoint {
            id: id.into(),
            xyz: [0.0; 3],
            sigma: 0.02,
            check,
            marks: vec![],
        };
        let err = fit_control(
            &m,
            &Control {
                epsg: 32617,
                points: vec![p("a", false), p("b", false), p("c", true)],
            },
            [0.0; 3],
        )
        .unwrap_err();
        assert!(err.contains("0 ground control points"), "{err}");
    }

    #[test]
    fn the_csv_and_odm_lists_are_read() {
        let csv = "id,x,y,z,crs,sigma,role,image,px,py\n\
                   A,441024.1,4564001.8,345.1,EPSG:32617,0.02,gcp,IMG_1.JPG,10.5,20.5\n\
                   A,441024.1,4564001.8,345.1,EPSG:32617,0.02,gcp,IMG_2.JPG,30,40\n\
                   B,441004.6,4564119.5,351.3,EPSG:32617,0.05,check,,,\n";
        let c = parse(csv).unwrap();
        assert_eq!(c.epsg, 32617);
        assert_eq!(c.points.len(), 2);
        assert_eq!(c.points[0].marks.len(), 2);
        assert!(c.points[1].check && c.points[1].marks.is_empty() && c.points[1].sigma == 0.05);
        let odm = "WGS84 UTM 17N\n441024.15 4564001.87 345.16 2648 2147 IMG_1356_RGB.jpg\n441024.15 4564001.87 345.16 100 200 IMG_1357_RGB.jpg\n";
        let o = parse(odm).unwrap();
        assert_eq!(
            (o.epsg, o.points.len(), o.points[0].marks.len()),
            (32617, 1, 2)
        );
        let proj = "+proj=utm +zone=11 +ellps=WGS84 +datum=WGS84 +units=m +no_defs\n235269.88\t3811198.11\t0.0\t3609.37\t2293.79\tIMG_0037.jpg\tgcp02\n";
        let p = parse(proj).unwrap();
        assert_eq!((p.epsg, p.points[0].id.as_str()), (32611, "gcp02"));
        for bad in [
            "id,x,y,z,crs,sigma,role,image,px,py\nA,1,2,3,EPSG:32617,0,gcp,,,\n",
            "id,x,y,z,crs,sigma,role,image,px,py\nA,1,2,3,EPSG:32617,0.1,tie,,,\n",
            "id,x,y,z,crs,sigma,role,image,px,py\nA,1,2,3,EPSG:32617,0.1,gcp,,,\nA,1,2,4,EPSG:32617,0.1,gcp,,,\n",
            "id,x,y,z,crs,sigma,role,image,px,py\nA,1,2,3,EPSG:4326,0.1,gcp,,,\nB,1,2,3,EPSG:32617,0.1,gcp,,,\n",
            "NAD27 / Texas\n1 2 3 4 5 a.jpg\n",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }
}
