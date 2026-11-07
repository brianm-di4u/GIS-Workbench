//! SAR radargrammetry (REQ-GAP-42, GR-15): a stereo pair finder over SICD collects, and a DSM
//! from two SICDs by object-space matching through the SICD Volume 3 models (`gw_sensor::sicd`).
//!
//! The 2.4 run of the generic optical path (census + SGM on single-look amplitude, REQ-GAP-41,
//! `docs/validation/2.4/terrsar.md`) found what this module answers: speckle decorrelates between
//! geometries, the disparity range is huge without a surface, layover and shadow dominate steep
//! ground, and two collects carry a relative offset of 10–13 m.
//!
//! **Resampling.** Both images are sampled on the ground: the DSM posts (a latitude/longitude grid)
//! are projected into each image through its SICD model (a lattice of exact `scene_to_image`
//! projections at several heights, interpolated), and each post takes the mean intensity of the
//! image pixels its ground cell covers (box sums on a summed-area table, `subs × subs` sub-cells
//! with the local slope of the surface). This multilooks both images over the same ground cell,
//! whatever their pixel spacing, squint or look direction. A height error δ moves the two samples
//! apart by `parallax · δ` along the parallax direction, so for each post the search is one
//! dimensional: the height along the post's vertical (the epipolar constraint in object space).
//!
//! **Matching.** Log intensity (speckle becomes additive), window ZNCC or the log-ratio cost over
//! `(2·half_window + 1)²` posts, on a pyramid of post spacings (coarse to fine). The search at the
//! top level is ±`search_m` about the prior DEM (Copernicus GLO-30), and about the upsampled result
//! of the level above at each finer level. The δ step is `step_frac` of a post of ground parallax.
//! A post is taken where the best score reaches `min_score`, beats the best peak more than two
//! steps away by `min_margin`, is not at the edge of the search, and agrees with its neighbours.
//!
//! **Relative orientation.** At the top level the cross-parallax shift of the second image
//! (perpendicular to the parallax direction, where it cannot be a height) is searched over
//! ±`shift_search_m` and applied at every level. The along-parallax part of a relative offset is
//! indistinguishable from a height bias: with `anchor` the median height difference to the prior
//! over the matched posts is removed (the DSM is then levelled on the prior, and its bias against
//! that same DEM is zero by construction); without it the heights are the models' own.
//!
//! **Masks.** Layover and shadow of each image from the geometry and the prior DEM
//! (`gw_terrain::sarmask`): masked posts are not matched.
//!
//! **Height and its accuracy.** A matched post's height is where the two image rays through the
//! matched conjugates meet on the post's vertical. Its σ combines two terms.
//!
//! * Random: the scatter (1.4826 · MAD, with the quantisation floor) of height minus prior over the
//!   footprint of one matching window at the top level of the pyramid (`scatter_sigma`). A smaller
//!   box cannot see the error of a coarse-to-fine match: neighbours share most of their window and
//!   the finer levels search only a little about the level above, so an error made at the top level
//!   moves a whole footprint together. The box comes from the job's own window and levels, with no
//!   constant fitted to any data. It holds the prior's own errors too.
//! * Bias: the prior's stated σ when anchored, or the models' CompositeSCP σ along the parallax
//!   direction divided by the parallax, when the SICDs state one. Without one (Umbra and Capella
//!   SICDs state none) σ leaves the bias out: `sigma_sys_source` is then "none".
//!
//! The σ is a model estimate; the report compares it with the measured error.

use crate::pairs;
use crate::speckle::{filter, Filter};
use gw_abi::{err, Error, Json, Result};
use gw_geodesy::wgs84::{ecef_to_geodetic, enu_rotation, geodetic_to_ecef, radii};
use gw_sensor::sicd::Sicd;
use gw_sensor::{Ground, SensorModel};
use gw_terrain::sarmask::{self, DemEnu};

type V3 = [f64; 3];

fn sub3(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot3(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn unit3(a: V3) -> V3 {
    let n = dot3(a, a).sqrt();
    [a[0] / n, a[1] / n, a[2] / n]
}
fn rot(r: &[[f64; 3]; 3], d: V3) -> V3 {
    [dot3(r[0], d), dot3(r[1], d), dot3(r[2], d)]
}

/// Metres per degree of latitude and longitude at a latitude (ellipsoid radii).
fn metres_per_degree(lat: f64) -> (f64, f64) {
    let (m, n) = radii(lat);
    let k = std::f64::consts::PI / 180.0;
    (m * k, n * k * lat.to_radians().cos())
}

/// The aperture reference point and its velocity (ECEF) at the centre of aperture of image
/// point (x, y), and the image's look sign.
fn arp_at(m: &Sicd, x: f64, y: f64) -> (V3, V3) {
    let (row, col) = m.xy_to_rowcol(x, y);
    let (xr, yc) = m.rowcol_to_grid(row, col);
    let s = m.projection_set(xr, yc);
    (s.arp, s.varp)
}

// ---------------------------------------------------------------- pair geometry

/// The stereo geometry of two collects at a ground point.
#[derive(Clone, Debug)]
pub struct PairGeometry {
    /// Angle between the two lines of sight (°).
    pub intersection_deg: f64,
    /// Both sensors on the same side of the point (horizontal look directions within 90°).
    pub same_side: bool,
    /// Angle between the horizontal directions from the point to each sensor (°).
    pub d_azimuth_deg: f64,
    pub incidence_deg: [f64; 2],
    /// Azimuth (clockwise from north) of the direction from the point to each sensor (°).
    pub look_azimuth_deg: [f64; 2],
    /// Horizontal ground displacement (east, north) per metre of height at a fixed image pixel.
    pub layover: [[f64; 2]; 2],
    /// |layover₀ − layover₁|: metres of ground parallax per metre of height.
    pub parallax: f64,
    /// Unit vector (east, north) of the parallax.
    pub parallax_dir: [f64; 2],
    /// Left-looking (SICD SideOfTrack L) per image.
    pub left: [bool; 2],
}

/// Geometry of collects `a` and `b` at ground point `g`.
pub fn pair_geometry(a: &Sicd, b: &Sicd, g: Ground) -> Result<PairGeometry> {
    let p = geodetic_to_ecef(g.lat, g.lon, g.h);
    let r = enu_rotation(g.lat, g.lon);
    let (kn, ke) = metres_per_degree(g.lat);
    let mut los = [[0.0; 3]; 2];
    let mut lay = [[0.0; 2]; 2];
    let mut inc = [0.0; 2];
    let mut az = [0.0; 2];
    for (k, m) in [a, b].into_iter().enumerate() {
        let (x, y) = m.ground_to_image(g)?;
        let (arp, _) = arp_at(m, x, y);
        let l = rot(&r, unit3(sub3(arp, p)));
        los[k] = l;
        inc[k] = l[2].clamp(-1.0, 1.0).acos().to_degrees();
        az[k] = l[0].atan2(l[1]).to_degrees().rem_euclid(360.0);
        let lo = m.image_to_ground(x, y, g.h - 5.0)?;
        let hi = m.image_to_ground(x, y, g.h + 5.0)?;
        lay[k] = [(hi.lon - lo.lon) * ke / 10.0, (hi.lat - lo.lat) * kn / 10.0];
    }
    let ang = dot3(los[0], los[1]).clamp(-1.0, 1.0).acos().to_degrees();
    let h0 = los[0][0].hypot(los[0][1]);
    let h1 = los[1][0].hypot(los[1][1]);
    let cos_az = if h0 > 1e-9 && h1 > 1e-9 { (los[0][0] * los[1][0] + los[0][1] * los[1][1]) / (h0 * h1) } else { 1.0 };
    let d = [lay[0][0] - lay[1][0], lay[0][1] - lay[1][1]];
    let par = d[0].hypot(d[1]);
    Ok(PairGeometry {
        intersection_deg: ang,
        same_side: cos_az > 0.0,
        d_azimuth_deg: cos_az.clamp(-1.0, 1.0).acos().to_degrees(),
        incidence_deg: inc,
        look_azimuth_deg: az,
        layover: lay,
        parallax: par,
        parallax_dir: if par > 0.0 { [d[0] / par, d[1] / par] } else { [1.0, 0.0] },
        left: [a.p.look > 0.0, b.p.look > 0.0],
    })
}

/// Pair finder limits.
#[derive(Clone, Copy, Debug)]
pub struct PairLimits {
    /// Smallest footprint overlap (share of the smaller footprint).
    pub min_overlap: f64,
    /// Below this intersection angle (°) the height sensitivity is too weak.
    pub min_angle: f64,
    /// Above this intersection angle (°) a same-side pair is likely to decorrelate (X band: the
    /// Umbra Hetch Hetchy pairs correlated at 10° and not at 22°, the Capella Hatay pair at 16°).
    pub max_angle_same: f64,
    /// Longest time between the collects (days).
    pub max_days: f64,
    /// Preferred intersection angle (°) for the ranking.
    pub target_angle: f64,
}

impl Default for PairLimits {
    fn default() -> Self {
        PairLimits { min_overlap: 0.3, min_angle: 3.0, max_angle_same: 20.0, max_days: 90.0, target_angle: 8.0 }
    }
}

/// One candidate pair.
#[derive(Clone, Debug)]
pub struct StereoPair {
    pub a: usize,
    pub b: usize,
    pub overlap: f64,
    pub days: f64,
    pub centre: Ground,
    pub geom: Option<PairGeometry>,
    /// Failed criteria: overlap, geometry, weak, wide, days. "opposite" is a note, not a failure.
    pub reasons: Vec<&'static str>,
    pub notes: Vec<&'static str>,
    pub ok: bool,
    pub score: f64,
}

/// The ground footprint (lat, lon) of a collect: its image corners at the SCP height.
pub fn footprint(m: &Sicd) -> Result<Vec<(f64, f64)>> {
    let (w, h) = (m.p.num_cols, m.p.num_rows);
    let (_, _, hs) = ecef_to_geodetic(m.p.scp[0], m.p.scp[1], m.p.scp[2]);
    let mut out = Vec::with_capacity(4);
    for (x, y) in [(0.5, 0.5), (w - 0.5, 0.5), (w - 0.5, h - 0.5), (0.5, h - 0.5)] {
        let g = m.image_to_ground(x, y, hs)?;
        out.push((g.lat, g.lon));
    }
    Ok(out)
}

fn scp_hae(m: &Sicd) -> f64 {
    ecef_to_geodetic(m.p.scp[0], m.p.scp[1], m.p.scp[2]).2
}

/// Every pair of `models` (collect start times `starts`, seconds), ranked: suitable pairs first.
pub fn find_pairs(models: &[Sicd], starts: &[f64], lim: PairLimits) -> Vec<StereoPair> {
    let fps: Vec<Option<Vec<(f64, f64)>>> = models.iter().map(|m| footprint(m).ok()).collect();
    let mut out = Vec::new();
    for i in 0..models.len() {
        for j in i + 1..models.len() {
            let (fa, fb) = (&fps[i], &fps[j]);
            let (ov, centre) = match (fa, fb) {
                (Some(fa), Some(fb)) => {
                    let inter = pairs::clip(fa, fb);
                    if inter.len() >= 3 {
                        let ov = pairs::area(&inter) / pairs::area(fa).min(pairs::area(fb)).max(1e-30);
                        let n = inter.len() as f64;
                        let lat = inter.iter().map(|p| p.0).sum::<f64>() / n;
                        let lon = inter.iter().map(|p| p.1).sum::<f64>() / n;
                        (ov, Some((lat, lon)))
                    } else {
                        (0.0, None)
                    }
                }
                _ => (0.0, None),
            };
            let days = (starts.get(i).copied().unwrap_or(f64::NAN) - starts.get(j).copied().unwrap_or(f64::NAN)).abs() / 86400.0;
            let mut reasons = Vec::new();
            let mut notes = Vec::new();
            let hc = 0.5 * (scp_hae(&models[i]) + scp_hae(&models[j]));
            let centre_g = centre.map(|(lat, lon)| Ground { lat, lon, h: hc });
            let geom = centre_g.and_then(|g| pair_geometry(&models[i], &models[j], g).ok());
            if ov < lim.min_overlap {
                reasons.push("overlap");
            }
            match &geom {
                None => reasons.push("geometry"),
                Some(g) => {
                    if g.intersection_deg < lim.min_angle {
                        reasons.push("weak");
                    }
                    if g.same_side && g.intersection_deg > lim.max_angle_same {
                        reasons.push("wide");
                    }
                    if !g.same_side {
                        notes.push("opposite");
                    }
                }
            }
            if days.is_finite() && days > lim.max_days {
                reasons.push("days");
            }
            let ok = reasons.is_empty();
            let score = match &geom {
                Some(g) => {
                    (if ok { 10.0 } else { 0.0 }) + (if g.same_side { 2.0 } else { 0.0 }) - (g.intersection_deg - lim.target_angle).abs() / 10.0 + ov.min(1.0) - if days.is_finite() { days / 365.0 } else { 0.0 }
                }
                None => -10.0,
            };
            out.push(StereoPair { a: i, b: j, overlap: ov, days, centre: centre_g.unwrap_or(Ground { lat: f64::NAN, lon: f64::NAN, h: hc }), geom, reasons, notes, ok, score });
        }
    }
    out.sort_by(|p, q| q.score.partial_cmp(&p.score).unwrap_or(std::cmp::Ordering::Equal));
    out
}

// ---------------------------------------------------------------- grids

/// Post centres of a latitude/longitude grid: post (i, j) is at (lat0 − j·dlat, lon0 + i·dlon).
#[derive(Clone, Copy, Debug)]
pub struct LatLonGrid {
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
    pub nx: usize,
    pub ny: usize,
}

impl LatLonGrid {
    fn check(&self, what: &str) -> Result<()> {
        let ok = self.lat0.is_finite() && self.lon0.is_finite() && self.dlat > 0.0 && self.dlon > 0.0 && self.dlat < 1.0 && self.dlon < 1.0 && self.nx >= 2 && self.ny >= 2 && self.nx <= 20_000 && self.ny <= 20_000;
        if !ok {
            return Err(err!(INVALID, "radargrammetry: bad {what} grid", what = what.to_string()));
        }
        Ok(())
    }
    pub fn at(&self, fi: f64, fj: f64) -> (f64, f64) {
        (self.lat0 - fj * self.dlat, self.lon0 + fi * self.dlon)
    }
    fn n(&self) -> usize {
        self.nx * self.ny
    }
}

/// A height grid (HAE) on a latitude/longitude grid.
#[derive(Clone, Debug)]
pub struct DemGrid {
    pub g: LatLonGrid,
    pub z: Vec<f32>,
}

impl DemGrid {
    /// Bilinear HAE at (lat, lon); NaN outside.
    pub fn sample(&self, lat: f64, lon: f64) -> f64 {
        let fx = (lon - self.g.lon0) / self.g.dlon;
        let fy = (self.g.lat0 - lat) / self.g.dlat;
        if !(fx >= 0.0 && fy >= 0.0) || fx > (self.g.nx - 1) as f64 || fy > (self.g.ny - 1) as f64 {
            return f64::NAN;
        }
        let i = (fx.floor() as usize).min(self.g.nx - 2);
        let j = (fy.floor() as usize).min(self.g.ny - 2);
        let (tx, ty) = (fx - i as f64, fy - j as f64);
        let q = |a: usize, b: usize| self.z[b * self.g.nx + a] as f64;
        (q(i, j) * (1.0 - tx) + q(i + 1, j) * tx) * (1.0 - ty) + (q(i, j + 1) * (1.0 - tx) + q(i + 1, j + 1) * tx) * ty
    }

    /// Fill no-data posts from their neighbours (bounded passes), then with the mean.
    fn fill_voids(&mut self) {
        let (w, h) = (self.g.nx, self.g.ny);
        for _ in 0..64 {
            let mut any = false;
            let src = self.z.clone();
            for j in 0..h {
                for i in 0..w {
                    if src[j * w + i].is_finite() {
                        continue;
                    }
                    let (mut s, mut c) = (0.0f64, 0);
                    for (di, dj) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)] {
                        let (a, b) = (i as i64 + di, j as i64 + dj);
                        if a >= 0 && b >= 0 && (a as usize) < w && (b as usize) < h {
                            let v = src[b as usize * w + a as usize];
                            if v.is_finite() {
                                s += v as f64;
                                c += 1;
                            }
                        }
                    }
                    if c > 0 {
                        self.z[j * w + i] = (s / c as f64) as f32;
                    } else {
                        any = true;
                    }
                }
            }
            if !any {
                return;
            }
        }
        let fin: Vec<f64> = self.z.iter().filter(|v| v.is_finite()).map(|&v| v as f64).collect();
        let m = if fin.is_empty() { 0.0 } else { fin.iter().sum::<f64>() / fin.len() as f64 };
        for v in self.z.iter_mut() {
            if !v.is_finite() {
                *v = m as f32;
            }
        }
    }
}

// ---------------------------------------------------------------- geometry lattice

/// Image positions of the post grid at a few heights: exact `scene_to_image` at the nodes
/// (every `step` posts, with a margin), interpolated bilinearly in the plane and linearly in
/// height.
pub struct Lattice {
    step: f64,
    margin: f64,
    ni: usize,
    nj: usize,
    h0: f64,
    dh: f64,
    nl: usize,
    xy: Vec<[f64; 2]>,
}

impl Lattice {
    pub fn build(m: &Sicd, g: &LatLonGrid, hmin: f64, hmax: f64, step: usize, margin_posts: f64) -> Result<Lattice> {
        let step = step.clamp(1, 64) as f64;
        let mn = (margin_posts / step).ceil().max(1.0) + 1.0;
        let ni = ((g.nx as f64 - 1.0) / step).ceil() as usize + 1 + 2 * mn as usize;
        let nj = ((g.ny as f64 - 1.0) / step).ceil() as usize + 1 + 2 * mn as usize;
        let span = (hmax - hmin).max(1.0);
        let nl = ((span / 80.0).ceil() as usize + 1).clamp(3, 64);
        let dh = span / (nl - 1) as f64;
        if ni.saturating_mul(nj).saturating_mul(nl) > 4_000_000 {
            return Err(Error::limit("radargrammetry: the geometry lattice is too large"));
        }
        let mut xy = vec![[f64::NAN; 2]; ni * nj * nl];
        let mut bad = 0usize;
        for k in 0..nl {
            let h = hmin + k as f64 * dh;
            for j in 0..nj {
                for i in 0..ni {
                    let fi = (i as f64 - mn) * step;
                    let fj = (j as f64 - mn) * step;
                    let (lat, lon) = g.at(fi, fj);
                    match m.ground_to_image(Ground { lat, lon, h }) {
                        Ok((x, y)) => xy[(k * nj + j) * ni + i] = [x, y],
                        Err(_) => bad += 1,
                    }
                }
            }
        }
        if bad * 2 > xy.len() {
            return Err(Error::range("radargrammetry: the area does not project into the image"));
        }
        Ok(Lattice { step, margin: mn, ni, nj, h0: hmin, dh, nl, xy })
    }

    /// (x, y, ∂x/∂h, ∂y/∂h) at fractional post (fi, fj) and height h (NaN outside the lattice).
    pub fn at(&self, fi: f64, fj: f64, h: f64) -> [f64; 4] {
        let u = fi / self.step + self.margin;
        let v = fj / self.step + self.margin;
        if !(u >= 0.0 && v >= 0.0) || u > (self.ni - 1) as f64 || v > (self.nj - 1) as f64 || !h.is_finite() {
            return [f64::NAN; 4];
        }
        let i = (u.floor() as usize).min(self.ni - 2);
        let j = (v.floor() as usize).min(self.nj - 2);
        let (tx, ty) = (u - i as f64, v - j as f64);
        let kf = ((h - self.h0) / self.dh).clamp(0.0, (self.nl - 1) as f64);
        let k = (kf.floor() as usize).min(self.nl - 2);
        let t = (h - self.h0) / self.dh - k as f64;
        let plane = |k: usize| {
            let q = |a: usize, b: usize| self.xy[(k * self.nj + b) * self.ni + a];
            let (a, b, c, d) = (q(i, j), q(i + 1, j), q(i, j + 1), q(i + 1, j + 1));
            [(a[0] * (1.0 - tx) + b[0] * tx) * (1.0 - ty) + (c[0] * (1.0 - tx) + d[0] * tx) * ty, (a[1] * (1.0 - tx) + b[1] * tx) * (1.0 - ty) + (c[1] * (1.0 - tx) + d[1] * tx) * ty]
        };
        let (p0, p1) = (plane(k), plane(k + 1));
        let (gx, gy) = ((p1[0] - p0[0]) / self.dh, (p1[1] - p0[1]) / self.dh);
        [p0[0] + t * (p1[0] - p0[0]), p0[1] + t * (p1[1] - p0[1]), gx, gy]
    }
}

// ---------------------------------------------------------------- image chips

/// A multilooked intensity chip of an image: sample (u, v) is the mean intensity of image pixels
/// x ∈ [x0 + u·mx, x0 + (u+1)·mx), y likewise (image coordinates with the corner origin).
pub struct Chip {
    pub x0: f64,
    pub y0: f64,
    pub mx: f64,
    pub my: f64,
    pub w: usize,
    pub h: usize,
    sat: Vec<f64>,
    cnt: Vec<f64>,
}

impl Chip {
    /// From mean intensities (NaN or ≤ 0 = no data). `despeckle` 0 none, 2 Lee, 6 refined Lee
    /// (speckle filter codes) on the chip before the box sums.
    pub fn new(x0: f64, y0: f64, mx: f64, my: f64, w: usize, h: usize, v: &[f32], despeckle: i32) -> Result<Chip> {
        if w < 2 || h < 2 || w.checked_mul(h) != Some(v.len()) || w * h > 64 << 20 || !(mx >= 1.0 && my >= 1.0) || !x0.is_finite() || !y0.is_finite() || mx > 4096.0 || my > 4096.0 {
            return Err(Error::invalid("radargrammetry: chip size does not match its samples"));
        }
        let filtered;
        let src: &[f32] = match despeckle {
            0 => v,
            c => {
                let f = Filter::from_code(c).ok_or_else(|| Error::invalid("radargrammetry: unknown speckle filter"))?;
                let clean: Vec<f32> = v.iter().map(|&a| if a.is_finite() && a > 0.0 { a } else { 0.0 }).collect();
                let mut o = filter(&clean, w, h, f, 5, (mx * my).max(1.0), 2.0);
                for (k, a) in v.iter().enumerate() {
                    if !(a.is_finite() && *a > 0.0) {
                        o[k] = f32::NAN;
                    }
                }
                filtered = o;
                &filtered
            }
        };
        let (sw, sh) = (w + 1, h + 1);
        let mut sat = vec![0.0f64; sw * sh];
        let mut cnt = vec![0.0f64; sw * sh];
        for j in 0..h {
            let (mut rs, mut rc) = (0.0, 0.0);
            for i in 0..w {
                let a = src[j * w + i];
                if a.is_finite() && a > 0.0 {
                    rs += a as f64;
                    rc += 1.0;
                }
                sat[(j + 1) * sw + i + 1] = sat[j * sw + i + 1] + rs;
                cnt[(j + 1) * sw + i + 1] = cnt[j * sw + i + 1] + rc;
            }
        }
        Ok(Chip { x0, y0, mx, my, w, h, sat, cnt })
    }

    fn s(t: &[f64], sw: usize, u: f64, v: f64, w: usize, h: usize) -> f64 {
        let u = u.clamp(0.0, w as f64);
        let v = v.clamp(0.0, h as f64);
        let i = (u.floor() as usize).min(w.saturating_sub(1));
        let j = (v.floor() as usize).min(h.saturating_sub(1));
        let (tx, ty) = (u - i as f64, v - j as f64);
        let q = |a: usize, b: usize| t[b * sw + a];
        (q(i, j) * (1.0 - tx) + q(i + 1, j) * tx) * (1.0 - ty) + (q(i, j + 1) * (1.0 - tx) + q(i + 1, j + 1) * tx) * ty
    }

    /// Mean intensity over image box [xa, xb] × [ya, yb] (pixels); NaN if under half of it has data.
    pub fn box_mean(&self, xa: f64, ya: f64, xb: f64, yb: f64) -> f64 {
        let (u0, u1) = ((xa - self.x0) / self.mx, (xb - self.x0) / self.mx);
        let (v0, v1) = ((ya - self.y0) / self.my, (yb - self.y0) / self.my);
        if !(u0.is_finite() && u1.is_finite() && v0.is_finite() && v1.is_finite()) || u1 <= 0.0 || v1 <= 0.0 || u0 >= self.w as f64 || v0 >= self.h as f64 {
            return f64::NAN;
        }
        let area = (u1 - u0) * (v1 - v0);
        let sw = self.w + 1;
        let f = |t: &[f64]| Self::s(t, sw, u1, v1, self.w, self.h) - Self::s(t, sw, u0, v1, self.w, self.h) - Self::s(t, sw, u1, v0, self.w, self.h) + Self::s(t, sw, u0, v0, self.w, self.h);
        let c = f(&self.cnt);
        if !(c >= 0.5 * area) || c <= 0.0 {
            return f64::NAN;
        }
        f(&self.sat) / c
    }
}

// ---------------------------------------------------------------- the DSM job

/// Matching cost.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cost {
    /// Zero-mean normalised cross-correlation of log intensity.
    Zncc,
    /// Log-ratio: 1 − var(ln a − ln b) / (var ln a + var ln b) = 2 cov / (var a + var b).
    LogRatio,
}

/// Job parameters.
#[derive(Clone, Debug)]
pub struct Params {
    /// Pyramid levels above the output posts (each halves the resolution).
    pub levels: usize,
    pub half_window: usize,
    /// Half search range about the prior at the top level (m).
    pub search_m: f64,
    /// δ step as a share of one post of ground parallax.
    pub step_frac: f64,
    pub cost: Cost,
    pub min_score: f64,
    pub min_margin: f64,
    /// Half range of the cross-parallax shift search (m); 0 = none.
    pub shift_search_m: f64,
    pub anchor: bool,
    /// Mask sampling (m) and height tolerance (m).
    pub mask_step_m: f64,
    pub mask_tol: f64,
    /// Sub-cells per post axis.
    pub subs: usize,
    /// The prior's stated vertical σ (m), the bias term when anchored.
    pub prior_sigma: f64,
    pub despeckle: i32,
    pub lattice_step: usize,
}

impl Default for Params {
    fn default() -> Self {
        Params { levels: 3, half_window: 4, search_m: 60.0, step_frac: 0.5, cost: Cost::Zncc, min_score: 0.3, min_margin: 0.03, shift_search_m: 30.0, anchor: false, mask_step_m: 5.0, mask_tol: 0.5, subs: 2, prior_sigma: 4.0, despeckle: 0, lattice_step: 8 }
    }
}

/// Post flags (output band 4).
pub mod flag {
    pub const LAYOVER_A: u8 = 1;
    pub const LAYOVER_B: u8 = 2;
    pub const SHADOW_A: u8 = 4;
    pub const SHADOW_B: u8 = 8;
    pub const WEAK: u8 = 16;
    pub const AMBIGUOUS: u8 = 32;
    pub const REJECTED: u8 = 64;
    pub const NO_DATA: u8 = 128;
    pub const MASKED: u8 = LAYOVER_A | LAYOVER_B | SHADOW_A | SHADOW_B;
}

#[derive(Clone, Debug, Default)]
pub struct LevelStats {
    pub post_m: f64,
    pub nx: usize,
    pub ny: usize,
    pub step_m: f64,
    pub range_m: f64,
    pub planes: usize,
    pub accepted: usize,
    pub weak: usize,
    pub ambiguous: usize,
    pub rejected: usize,
    pub median_score: f64,
}

/// Per-level working state.
struct Level {
    g: LatLonGrid,
    scale: f64,
    /// Guide surface (HAE) per post and the δ search.
    guide: Vec<f64>,
    d_lo: f64,
    dd: f64,
    k: usize,
    /// Per post, per image: x0, y0, xh, yh, half box x, half box y, Jeff (4).
    geo: [Vec<[f64; 10]>; 2],
    masked: Vec<bool>,
    vol: Vec<f32>,
    /// Shift search: candidates (m along the cross direction) and their mean best score.
    shift_cands: Vec<f64>,
    shift_scores: Vec<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Stage {
    Lattice(usize),
    Mask(usize),
    Prepare(usize),
    Shift(usize, usize),
    Plane(usize, usize),
    Select(usize),
    Finish,
    Done,
}

/// The DSM job: build with [`Job::new`], call [`Job::step`] until [`Job::done`], then read the
/// outputs (or call [`Job::run`]).
pub struct Job {
    pub models: [Sicd; 2],
    pub grid: LatLonGrid,
    pub prior: DemGrid,
    pub chips: [Chip; 2],
    pub p: Params,
    pub geom: PairGeometry,
    post_m: f64,
    lat: Vec<Lattice>,
    hmin: f64,
    hmax: f64,
    mask: Vec<u8>,
    mask_rows_per_step: usize,
    lv: Option<Level>,
    /// δ estimate on the level-0 grid (m above the prior), NaN where unknown.
    est: Vec<f64>,
    /// Cross-parallax shift of image B (m) and its east/north vector.
    pub shift_m: f64,
    pub shift_en: [f64; 2],
    stage: Stage,
    done_w: f64,
    total_w: f64,
    pub levels: Vec<LevelStats>,
    // outputs (level 0)
    pub heights: Vec<f32>,
    pub sigma: Vec<f32>,
    pub score: Vec<f32>,
    pub flags: Vec<u8>,
    pub anchor_offset: f64,
    pub sigma_sys: f64,
    pub sigma_sys_source: &'static str,
    pub lattice_max_px: f64,
    pub intersect_max_m: f64,
    pub intersect_n: usize,
}

fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let m = v.len() / 2;
    v.select_nth_unstable_by(m, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[m]
}

/// 1.4826 · MAD of a set of values (NaN when empty).
fn nmad(v: &mut [f64]) -> f64 {
    let med = median(v);
    let mut dev: Vec<f64> = v.iter().map(|x| (x - med).abs()).collect();
    1.4826 * median(&mut dev)
}

/// Per-post scatter of `d` (row-major, NaN where nothing matched): the NMAD of the values in the box
/// of half-size `half` posts about the post, sampled at about 11 × 11 points, at least `floor`. A
/// post with fewer than 5 values in its box takes the NMAD of the whole grid. NaN where `d` is NaN.
fn scatter_sigma(d: &[f64], nx: usize, ny: usize, half: usize, floor: f64) -> Vec<f64> {
    let half = half.min(nx.min(ny) / 2).max(1) as isize;
    let step = (half / 5).max(1);
    let mut all: Vec<f64> = d.iter().copied().filter(|v| v.is_finite()).collect();
    let whole = nmad(&mut all);
    let (w, h) = (nx as isize, ny as isize);
    let mut nb = Vec::with_capacity(121);
    let mut out = vec![f64::NAN; d.len()];
    for j in 0..h {
        for i in 0..w {
            let q = (j * w + i) as usize;
            if !d[q].is_finite() {
                continue;
            }
            nb.clear();
            let mut b = -half;
            while b <= half {
                let mut a = -half;
                while a <= half {
                    let (ii, jj) = (i + a, j + b);
                    if ii >= 0 && jj >= 0 && ii < w && jj < h {
                        let v = d[(jj * w + ii) as usize];
                        if v.is_finite() {
                            nb.push(v);
                        }
                    }
                    a += step;
                }
                b += step;
            }
            let r = if nb.len() >= 5 { nmad(&mut nb) } else { whole };
            out[q] = if r.is_finite() { r.max(floor) } else { floor };
        }
    }
    out
}

impl Job {
    #[allow(clippy::too_many_arguments)]
    pub fn new(a: Sicd, b: Sicd, grid: LatLonGrid, prior: DemGrid, ca: Chip, cb: Chip, p: Params) -> Result<Job> {
        grid.check("output")?;
        prior.g.check("prior")?;
        if prior.z.len() != prior.g.n() {
            return Err(Error::invalid("radargrammetry: prior heights do not match the prior grid"));
        }
        if grid.n() > 16_000_000 {
            return Err(Error::limit("radargrammetry: more than 16 million posts"));
        }
        let ok = p.levels <= 6 && (1..=12).contains(&p.half_window) && p.search_m > 0.0 && p.search_m <= 2000.0 && p.step_frac >= 0.05 && p.step_frac <= 2.0 && p.shift_search_m >= 0.0 && p.shift_search_m <= 500.0 && p.mask_step_m > 0.0 && p.mask_step_m <= 100.0 && p.mask_tol >= 0.0 && (1..=4).contains(&p.subs) && p.min_score.is_finite() && p.min_margin.is_finite() && p.prior_sigma >= 0.0 && p.lattice_step >= 1;
        if !ok {
            return Err(Error::invalid("radargrammetry: parameters out of range"));
        }
        let mut prior = prior;
        prior.fill_voids();
        let (latc, lonc) = grid.at((grid.nx - 1) as f64 / 2.0, (grid.ny - 1) as f64 / 2.0);
        let (kn, ke) = metres_per_degree(latc);
        let post_m = (grid.dlat * kn).min(grid.dlon * ke);
        // Prior heights over the output grid.
        let (mut hmin, mut hmax) = (f64::INFINITY, f64::NEG_INFINITY);
        for j in 0..grid.ny {
            for i in 0..grid.nx {
                let (la, lo) = grid.at(i as f64, j as f64);
                let h = prior.sample(la, lo);
                if h.is_finite() {
                    hmin = hmin.min(h);
                    hmax = hmax.max(h);
                }
            }
        }
        if !hmin.is_finite() {
            return Err(Error::range("radargrammetry: the prior DEM does not cover the area"));
        }
        let hc = prior.sample(latc, lonc);
        let geom = pair_geometry(&a, &b, Ground { lat: latc, lon: lonc, h: if hc.is_finite() { hc } else { 0.5 * (hmin + hmax) } })?;
        if !(geom.parallax > 0.01) {
            return Err(err!(RANGE, "radargrammetry: the pair has no height sensitivity (parallax {par} m per m)", par = format!("{:.3}", geom.parallax)));
        }
        let n = grid.n();
        let mut job = Job {
            models: [a, b],
            grid,
            prior,
            chips: [ca, cb],
            p,
            geom,
            post_m,
            lat: Vec::new(),
            hmin,
            hmax,
            mask: vec![0; n],
            mask_rows_per_step: 1,
            lv: None,
            est: vec![0.0; n],
            shift_m: 0.0,
            shift_en: [0.0, 0.0],
            stage: Stage::Lattice(0),
            done_w: 0.0,
            total_w: 1.0,
            levels: Vec::new(),
            heights: Vec::new(),
            sigma: Vec::new(),
            score: Vec::new(),
            flags: Vec::new(),
            anchor_offset: 0.0,
            sigma_sys: f64::NAN,
            sigma_sys_source: "none",
            lattice_max_px: f64::NAN,
            intersect_max_m: f64::NAN,
            intersect_n: 0,
        };
        job.mask_rows_per_step = (200_000 / grid.nx.max(1)).max(1);
        job.total_w = job.estimate_work();
        Ok(job)
    }

    fn level_grid(&self, l: usize) -> (LatLonGrid, f64) {
        let s = (1usize << l) as f64;
        let g = &self.grid;
        let nx = ((g.nx as f64) / s).ceil().max(2.0) as usize;
        let ny = ((g.ny as f64) / s).ceil().max(2.0) as usize;
        // Post (i, j) of level l sits at level-0 (fi, fj) = ((i + 0.5)·s − 0.5, …).
        let off = 0.5 * s - 0.5;
        (LatLonGrid { lat0: g.lat0 - off * g.dlat, lon0: g.lon0 + off * g.dlon, dlat: g.dlat * s, dlon: g.dlon * s, nx, ny }, s)
    }

    fn top(&self) -> usize {
        // No level coarser than about 12 posts across.
        let mut l = self.p.levels;
        while l > 0 && (self.grid.nx >> l < 12 || self.grid.ny >> l < 12) {
            l -= 1;
        }
        l
    }

    fn search_of(&self, l: usize) -> (f64, f64, usize) {
        let s = (1usize << l) as f64;
        // A weak pair (small parallax) at coarse posts would step further than the search itself:
        // at most a quarter of the search range per step, and no level searches wider than the top.
        let dd = (self.p.step_frac * self.post_m * s / self.geom.parallax).min(self.p.search_m / 4.0).max(0.05);
        let range = if l == self.top() { self.p.search_m } else { (5.0 * dd).min(self.p.search_m) };
        let k = (2.0 * (range / dd).ceil() + 1.0).min(161.0) as usize;
        (range, dd, k.max(3))
    }

    fn shift_candidates(&self) -> Vec<f64> {
        if !(self.p.shift_search_m > 0.0) {
            return vec![0.0];
        }
        let s = (1usize << self.top()) as f64 * self.post_m * 0.5;
        let n = (self.p.shift_search_m / s).ceil().min(40.0) as i64;
        (-n..=n).map(|k| k as f64 * s).collect()
    }

    fn estimate_work(&self) -> f64 {
        let n0 = self.grid.n() as f64;
        let mut w = 2.0 * n0 / 50.0 + n0 / (self.mask_stride() as f64).powi(2) * 2.0;
        for l in (0..=self.top()).rev() {
            let (g, _) = self.level_grid(l);
            let (_, _, k) = self.search_of(l);
            let n = g.n() as f64;
            w += n * 2.0;
            if l == self.top() {
                w += n * k as f64 * self.shift_candidates().len() as f64 * (if self.shift_candidates().len() > 1 { 1.0 } else { 0.0 });
            }
            w += n * k as f64 + n;
        }
        w + n0
    }

    fn mask_stride(&self) -> usize {
        ((self.p.mask_step_m / self.post_m).floor() as usize).max(1)
    }

    /// Share of the work done (0…1).
    pub fn progress(&self) -> f64 {
        if self.stage == Stage::Done {
            1.0
        } else {
            (self.done_w / self.total_w).clamp(0.0, 0.999)
        }
    }
    pub fn done(&self) -> bool {
        self.stage == Stage::Done
    }

    /// Run every step.
    pub fn run(&mut self) -> Result<()> {
        let mut guard = 0usize;
        while !self.done() {
            self.step()?;
            guard += 1;
            if guard > 10_000_000 {
                return Err(Error::limit("radargrammetry: too many steps"));
            }
        }
        Ok(())
    }

    /// One bounded unit of work.
    pub fn step(&mut self) -> Result<()> {
        match self.stage {
            Stage::Lattice(k) => {
                let margin = 8.0 + self.p.shift_search_m / self.post_m + (1usize << self.top()) as f64 * (self.p.half_window as f64 + 2.0);
                let lo = self.hmin - self.p.search_m - 30.0;
                let hi = self.hmax + self.p.search_m + 30.0;
                let l = Lattice::build(&self.models[k], &self.grid, lo, hi, self.p.lattice_step, margin)?;
                self.lat.push(l);
                self.done_w += self.grid.n() as f64 / 50.0;
                self.stage = if k == 0 { Stage::Lattice(1) } else { Stage::Mask(0) };
            }
            Stage::Mask(r0) => {
                let stride = self.mask_stride();
                let r1 = (r0 + self.mask_rows_per_step * stride).min(self.grid.ny);
                self.mask_rows(r0, r1, stride);
                self.done_w += ((r1 - r0) * self.grid.nx) as f64 / (stride * stride) as f64 * 2.0;
                if r1 >= self.grid.ny {
                    self.fill_mask(stride);
                    self.stage = Stage::Prepare(self.top());
                } else {
                    self.stage = Stage::Mask(r1);
                }
            }
            Stage::Prepare(l) => {
                self.prepare(l);
                let n = self.lv.as_ref().map(|v| v.g.n()).unwrap_or(0) as f64;
                self.done_w += 2.0 * n;
                self.stage = if l == self.top() && self.shift_candidates().len() > 1 { Stage::Shift(l, 0) } else { Stage::Plane(l, 0) };
            }
            Stage::Shift(l, c) => {
                let cands = self.shift_candidates();
                let n = self.lv.as_ref().map(|v| v.g.n()).unwrap_or(0) as f64;
                let k = self.lv.as_ref().map(|v| v.k).unwrap_or(0);
                // One candidate: sweep every plane, keep the mean best score.
                self.set_shift(cands[c]);
                self.geometry_b();
                for kk in 0..k {
                    self.plane(kk);
                }
                let s = self.mean_best();
                if let Some(v) = self.lv.as_mut() {
                    v.shift_cands.push(cands[c]);
                    v.shift_scores.push(s);
                }
                self.done_w += n * k as f64;
                if c + 1 < cands.len() {
                    self.stage = Stage::Shift(l, c + 1);
                } else {
                    let best = self.pick_shift();
                    self.set_shift(best);
                    self.geometry_b();
                    self.stage = Stage::Plane(l, 0);
                }
            }
            Stage::Plane(l, k) => {
                self.plane(k);
                let (n, kk) = self.lv.as_ref().map(|v| (v.g.n(), v.k)).unwrap_or((0, 0));
                self.done_w += n as f64;
                self.stage = if k + 1 < kk { Stage::Plane(l, k + 1) } else { Stage::Select(l) };
            }
            Stage::Select(l) => {
                self.select(l);
                let n = self.lv.as_ref().map(|v| v.g.n()).unwrap_or(0) as f64;
                self.done_w += n;
                self.stage = if l == 0 { Stage::Finish } else { Stage::Prepare(l - 1) };
            }
            Stage::Finish => {
                self.finish();
                self.stage = Stage::Done;
            }
            Stage::Done => {}
        }
        Ok(())
    }

    // -------------------------------------------------- masks

    fn mask_rows(&mut self, r0: usize, r1: usize, stride: usize) {
        let g = self.grid;
        let (latc, lonc) = g.at((g.nx - 1) as f64 / 2.0, (g.ny - 1) as f64 / 2.0);
        let (kn, ke) = metres_per_degree(latc);
        let (m, nr) = radii(latc);
        let rot_m = enu_rotation(latc, lonc);
        let o = geodetic_to_ecef(latc, lonc, 0.0);
        let pg = &self.prior.g;
        let Some(dem) = DemEnu::new(pg.nx, pg.ny, &self.prior.z, (pg.lon0 - lonc) * ke, (pg.lat0 - latc) * kn, pg.dlon * ke, pg.dlat * kn, (m * nr).sqrt()) else {
            return;
        };
        let step = (self.p.mask_step_m * 0.5).max(0.25);
        let tol = self.p.mask_tol;
        let mut j = r0;
        while j < r1 {
            let mut i = 0;
            while i < g.nx {
                let (la, lo) = g.at(i as f64, j as f64);
                let (e, n) = ((lo - lonc) * ke, (la - latc) * kn);
                let mut v = 0u8;
                if let (Some(pt), h) = (dem.point(e, n), self.prior.sample(la, lo)) {
                    for (k, bits) in [(0usize, (flag::LAYOVER_A, flag::SHADOW_A)), (1, (flag::LAYOVER_B, flag::SHADOW_B))] {
                        let q = self.lat[k].at(i as f64, j as f64, h);
                        if !q[0].is_finite() {
                            continue;
                        }
                        let (arp, varp) = arp_at(&self.models[k], q[0], q[1]);
                        let s = rot(&rot_m, sub3(arp, o));
                        let vv = rot(&rot_m, varp);
                        let mk = sarmask::mask(&dem, pt, s, vv, step, tol);
                        if mk & sarmask::LAYOVER != 0 {
                            v |= bits.0;
                        }
                        if mk & sarmask::SHADOW != 0 {
                            v |= bits.1;
                        }
                    }
                }
                self.mask[j * g.nx + i] = v;
                i += stride;
            }
            j += stride;
        }
    }

    /// Posts between the sampled ones take the nearest sample's mask.
    fn fill_mask(&mut self, stride: usize) {
        if stride <= 1 {
            return;
        }
        let g = self.grid;
        for j in 0..g.ny {
            for i in 0..g.nx {
                if i % stride == 0 && j % stride == 0 {
                    continue;
                }
                let si = (((i as f64) / stride as f64).round() as usize * stride).min((g.nx - 1) / stride * stride);
                let sj = (((j as f64) / stride as f64).round() as usize * stride).min((g.ny - 1) / stride * stride);
                self.mask[j * g.nx + i] = self.mask[sj * g.nx + si];
            }
        }
    }

    // -------------------------------------------------- levels

    fn prepare(&mut self, l: usize) {
        let (g, s) = self.level_grid(l);
        let (range, dd, k) = self.search_of(l);
        let n = g.n();
        // Guide = prior + current δ estimate (level-0 estimate sampled at the level's posts).
        let mut guide = vec![f64::NAN; n];
        let mut masked = vec![false; n];
        let g0 = self.grid;
        for j in 0..g.ny {
            for i in 0..g.nx {
                let (la, lo) = g.at(i as f64, j as f64);
                let fi = (i as f64 + 0.5) * s - 0.5;
                let fj = (j as f64 + 0.5) * s - 0.5;
                let d = sample_grid(&self.est, g0.nx, g0.ny, fi, fj);
                guide[j * g.nx + i] = self.prior.sample(la, lo) + if d.is_finite() { d } else { 0.0 };
                // Masked if more than half of the level-0 posts under it are.
                let (i0, j0) = ((i as f64 * s) as usize, (j as f64 * s) as usize);
                let (i1, j1) = (((((i + 1) as f64) * s) as usize).min(g0.nx), ((((j + 1) as f64) * s) as usize).min(g0.ny));
                let (mut c, mut t) = (0usize, 0usize);
                for jj in j0..j1.max(j0 + 1).min(g0.ny) {
                    for ii in i0..i1.max(i0 + 1).min(g0.nx) {
                        t += 1;
                        if self.mask[jj * g0.nx + ii] & flag::MASKED != 0 {
                            c += 1;
                        }
                    }
                }
                masked[j * g.nx + i] = t > 0 && 2 * c > t;
            }
        }
        self.lv = Some(Level { g, scale: s, guide, d_lo: -range, dd, k, geo: [vec![[f64::NAN; 10]; n], vec![[f64::NAN; 10]; n]], masked, vol: vec![f32::NAN; n * k], shift_cands: Vec::new(), shift_scores: Vec::new() });
        self.geometry(0);
        self.geometry(1);
    }

    fn set_shift(&mut self, s: f64) {
        let pd = self.geom.parallax_dir;
        self.shift_m = s;
        self.shift_en = [-pd[1] * s, pd[0] * s];
    }

    fn geometry_b(&mut self) {
        self.geometry(1);
    }

    /// Per post geometry of image k at the level's guide surface.
    fn geometry(&mut self, k: usize) {
        let Some(lv) = self.lv.as_mut() else { return };
        let g = lv.g;
        let s = lv.scale;
        let subs = self.p.subs as f64;
        let (sx, sy) = if k == 1 { (self.shift_en[0] / self.post_m, -self.shift_en[1] / self.post_m) } else { (0.0, 0.0) };
        let lat = &self.lat[k];
        let guide = &lv.guide;
        let at = |i: usize, j: usize| guide[j * g.nx + i];
        for j in 0..g.ny {
            for i in 0..g.nx {
                let h = at(i, j);
                let fi = (i as f64 + 0.5) * s - 0.5 + sx;
                let fj = (j as f64 + 0.5) * s - 0.5 + sy;
                let c = lat.at(fi, fj, h);
                let ex = lat.at(fi + 0.5 * s, fj, h);
                let wx = lat.at(fi - 0.5 * s, fj, h);
                let ny_ = lat.at(fi, fj + 0.5 * s, h);
                let sy_ = lat.at(fi, fj - 0.5 * s, h);
                // Surface slope per level post (central differences, one-sided at the edges).
                let gi = {
                    let (a, b) = (if i > 0 { at(i - 1, j) } else { h }, if i + 1 < g.nx { at(i + 1, j) } else { h });
                    (b - a) / ((i + 1).min(g.nx - 1) - i.saturating_sub(1)).max(1) as f64
                };
                let gj = {
                    let (a, b) = (if j > 0 { at(i, j - 1) } else { h }, if j + 1 < g.ny { at(i, j + 1) } else { h });
                    (b - a) / ((j + 1).min(g.ny - 1) - j.saturating_sub(1)).max(1) as f64
                };
                let jxx = ex[0] - wx[0] + c[2] * gi;
                let jyx = ex[1] - wx[1] + c[3] * gi;
                let jxy = ny_[0] - sy_[0] + c[2] * gj;
                let jyy = ny_[1] - sy_[1] + c[3] * gj;
                let hx = 0.5 * (jxx.abs() + jxy.abs()) / subs;
                let hy = 0.5 * (jyx.abs() + jyy.abs()) / subs;
                lv.geo[k][j * g.nx + i] = [c[0], c[1], c[2], c[3], hx.max(0.5), hy.max(0.5), jxx, jxy, jyx, jyy];
            }
        }
    }

    /// Log mean intensity of every post of the level for image k at δ.
    fn sample_plane(&self, k: usize, d: f64) -> Vec<f64> {
        let lv = self.lv.as_ref().expect("level");
        let chip = &self.chips[k];
        let subs = self.p.subs;
        let n = lv.g.n();
        let mut out = vec![f64::NAN; n];
        let inv = 1.0 / subs as f64;
        for (q, o) in out.iter_mut().enumerate() {
            if lv.masked[q] {
                continue;
            }
            let ge = &lv.geo[k][q];
            if !ge[0].is_finite() {
                continue;
            }
            let (x0, y0) = (ge[0] + ge[2] * d, ge[1] + ge[3] * d);
            let (mut s, mut c) = (0.0, 0usize);
            for b in 0..subs {
                let oj = (b as f64 + 0.5) * inv - 0.5;
                for a in 0..subs {
                    let oi = (a as f64 + 0.5) * inv - 0.5;
                    let x = x0 + ge[6] * oi + ge[7] * oj;
                    let y = y0 + ge[8] * oi + ge[9] * oj;
                    let v = chip.box_mean(x - ge[4], y - ge[5], x + ge[4], y + ge[5]);
                    if v.is_finite() {
                        s += v;
                        c += 1;
                    }
                }
            }
            if c * 2 >= subs * subs && s > 0.0 {
                *o = (s / c as f64).ln();
            }
        }
        out
    }

    /// The similarity of plane kk (δ = d_lo + kk·dd) for every post.
    fn plane(&mut self, kk: usize) {
        let (d, g, k) = {
            let lv = self.lv.as_ref().expect("level");
            (lv.d_lo + kk as f64 * lv.dd, lv.g, lv.k)
        };
        let a = self.sample_plane(0, d);
        let b = self.sample_plane(1, d);
        let sim = window_similarity(&a, &b, g.nx, g.ny, self.p.half_window, self.p.cost);
        let lv = self.lv.as_mut().expect("level");
        for (q, v) in sim.iter().enumerate() {
            lv.vol[q * k + kk] = *v as f32;
        }
    }

    fn mean_best(&self) -> f64 {
        let lv = self.lv.as_ref().expect("level");
        let (mut s, mut c) = (0.0, 0usize);
        for q in 0..lv.g.n() {
            let best = lv.vol[q * lv.k..(q + 1) * lv.k].iter().filter(|v| v.is_finite()).fold(f32::NEG_INFINITY, |m, &v| m.max(v));
            if best.is_finite() {
                s += best as f64;
                c += 1;
            }
        }
        if c == 0 {
            f64::NAN
        } else {
            s / c as f64
        }
    }

    fn pick_shift(&self) -> f64 {
        let lv = self.lv.as_ref().expect("level");
        let (c, sc) = (&lv.shift_cands, &lv.shift_scores);
        let mut kb = None;
        for k in 0..sc.len() {
            if sc[k].is_finite() && kb.is_none_or(|b: usize| sc[k] > sc[b]) {
                kb = Some(k);
            }
        }
        let Some(kb) = kb else { return 0.0 };
        if kb > 0 && kb + 1 < sc.len() && sc[kb - 1].is_finite() && sc[kb + 1].is_finite() {
            let den = sc[kb - 1] - 2.0 * sc[kb] + sc[kb + 1];
            if den < 0.0 {
                let f = (0.5 * (sc[kb - 1] - sc[kb + 1]) / den).clamp(-0.5, 0.5);
                return c[kb] + f * (c[kb + 1] - c[kb]);
            }
        }
        c[kb]
    }

    /// Pick δ per post, filter, and carry the estimate down.
    fn select(&mut self, l: usize) {
        let lv = self.lv.take().expect("level");
        let g = lv.g;
        let n = g.n();
        let k = lv.k;
        let mut d = vec![f64::NAN; n];
        let mut sc = vec![f64::NAN; n];
        let mut fl = vec![0u8; n];
        let mut st = LevelStats { post_m: self.post_m * lv.scale, nx: g.nx, ny: g.ny, step_m: lv.dd, range_m: -lv.d_lo, planes: k, ..Default::default() };
        for q in 0..n {
            if lv.masked[q] {
                fl[q] = flag::LAYOVER_A; // any mask bit; level 0 copies the real bits below
                continue;
            }
            let v = &lv.vol[q * k..(q + 1) * k];
            let mut kb = usize::MAX;
            for kk in 0..k {
                if v[kk].is_finite() && (kb == usize::MAX || v[kk] > v[kb]) {
                    kb = kk;
                }
            }
            if kb == usize::MAX {
                fl[q] = flag::NO_DATA;
                continue;
            }
            let best = v[kb] as f64;
            let second = (0..k).filter(|&kk| kk.abs_diff(kb) > 2 && v[kk].is_finite()).map(|kk| v[kk] as f64).fold(f64::NEG_INFINITY, f64::max);
            sc[q] = best;
            if kb == 0 || kb + 1 == k {
                fl[q] = flag::REJECTED;
                st.rejected += 1;
                continue;
            }
            if best < self.p.min_score {
                fl[q] = flag::WEAK;
                st.weak += 1;
                continue;
            }
            if second.is_finite() && best - second < self.p.min_margin {
                fl[q] = flag::AMBIGUOUS;
                st.ambiguous += 1;
                continue;
            }
            let (a, b, c) = (v[kb - 1] as f64, best, v[kb + 1] as f64);
            let den = a - 2.0 * b + c;
            let f = if a.is_finite() && c.is_finite() && den < 0.0 { (0.5 * (a - c) / den).clamp(-0.5, 0.5) } else { 0.0 };
            d[q] = lv.d_lo + (kb as f64 + f) * lv.dd + (lv.guide[q] - self.prior_at_level(&g, q));
            // The search is ±search_m about the prior: a height that has drifted beyond it through the
            // levels is not a match of this search.
            if d[q].abs() > self.p.search_m + lv.dd {
                d[q] = f64::NAN;
                fl[q] = flag::REJECTED;
                st.rejected += 1;
            }
        }
        // Neighbourhood check: a post must agree with the median of its 5 × 5 accepted neighbours.
        let tol = 1.5 * lv.dd;
        let dn = d.clone();
        for j in 0..g.ny {
            for i in 0..g.nx {
                let q = j * g.nx + i;
                if !dn[q].is_finite() {
                    continue;
                }
                let mut nb = Vec::with_capacity(25);
                for jj in j.saturating_sub(2)..(j + 3).min(g.ny) {
                    for ii in i.saturating_sub(2)..(i + 3).min(g.nx) {
                        let v = dn[jj * g.nx + ii];
                        if v.is_finite() && (ii, jj) != (i, j) {
                            nb.push(v);
                        }
                    }
                }
                if nb.len() < 4 {
                    d[q] = f64::NAN;
                    fl[q] = flag::REJECTED;
                    st.rejected += 1;
                    continue;
                }
                let med = median(&mut nb);
                let mut dev: Vec<f64> = nb.iter().map(|v| (v - med).abs()).collect();
                let mad = 1.4826 * median(&mut dev);
                if (dn[q] - med).abs() > tol.max(3.0 * mad) {
                    d[q] = f64::NAN;
                    fl[q] = flag::REJECTED;
                    st.rejected += 1;
                }
            }
        }
        st.accepted = d.iter().filter(|v| v.is_finite()).count();
        let mut scs: Vec<f64> = sc.iter().copied().filter(|v| v.is_finite()).collect();
        st.median_score = median(&mut scs);
        self.levels.push(st);
        // Carry down: fill the unknown δ by neighbour diffusion, smooth, and resample on level 0.
        let mut filled = d.clone();
        let known: Vec<bool> = d.iter().map(|v| v.is_finite()).collect();
        let mut fin: Vec<f64> = d.iter().copied().filter(|v| v.is_finite()).collect();
        let med = if fin.is_empty() { 0.0 } else { median(&mut fin) };
        diffuse(&mut filled, &known, g.nx, g.ny, med);
        if l > 0 {
            let sm = smooth3(&filled, g.nx, g.ny);
            let g0 = self.grid;
            let s = lv.scale;
            for j in 0..g0.ny {
                for i in 0..g0.nx {
                    let fi = (i as f64 + 0.5) / s - 0.5;
                    let fj = (j as f64 + 0.5) / s - 0.5;
                    self.est[j * g0.nx + i] = sample_grid(&sm, g.nx, g.ny, fi, fj).clamp(-self.p.search_m, self.p.search_m);
                }
            }
        } else {
            // Level 0: the outputs.
            let n0 = self.grid.n();
            self.heights = vec![f32::NAN; n0];
            self.score = sc.iter().map(|&v| v as f32).collect();
            self.flags = vec![0; n0];
            for q in 0..n0 {
                let m = self.mask[q] & flag::MASKED;
                self.flags[q] = if m != 0 { m } else { fl[q] };
                if self.flags[q] == 0 && d[q].is_finite() {
                    let (la, lo) = self.grid.at((q % self.grid.nx) as f64, (q / self.grid.nx) as f64);
                    self.heights[q] = (self.prior.sample(la, lo) + d[q]) as f32;
                }
            }
            self.est = d;
        }
    }

    fn prior_at_level(&self, g: &LatLonGrid, q: usize) -> f64 {
        let (la, lo) = g.at((q % g.nx) as f64, (q / g.nx) as f64);
        self.prior.sample(la, lo)
    }

    // -------------------------------------------------- outputs

    fn finish(&mut self) {
        let g = self.grid;
        let n = g.n();
        // Anchor on the prior: the median height difference over the matched posts.
        let mut diffs: Vec<f64> = (0..n).filter(|&q| self.heights[q].is_finite()).map(|q| self.est[q]).filter(|v| v.is_finite()).collect();
        let med = median(&mut diffs);
        if self.p.anchor && med.is_finite() {
            self.anchor_offset = med;
            for h in self.heights.iter_mut() {
                if h.is_finite() {
                    *h -= med as f32;
                }
            }
        }
        // Bias term of σ.
        if self.p.anchor {
            self.sigma_sys = self.p.prior_sigma;
            self.sigma_sys_source = "prior";
        } else {
            match (self.models[0].horizontal_sigma(), self.models[1].horizontal_sigma()) {
                (Some(a), Some(b)) => {
                    self.sigma_sys = (a * a + b * b).sqrt() / self.geom.parallax;
                    self.sigma_sys_source = "compositeScp";
                }
                _ => {
                    self.sigma_sys = f64::NAN;
                    self.sigma_sys_source = "none";
                }
            }
        }
        // Random term: the scatter over the footprint of one top-level matching window.
        let dd0 = self.levels.last().map(|s| s.step_m).unwrap_or(1.0);
        let floor = dd0 / 12f64.sqrt();
        let d: Vec<f64> = (0..n).map(|q| if self.heights[q].is_finite() { self.heights[q] as f64 - self.prior_at_level(&g, q) } else { f64::NAN }).collect();
        let half = ((2 * self.p.half_window + 1) << self.levels.len().saturating_sub(1)) / 2;
        let random = scatter_sigma(&d, g.nx, g.ny, half, floor);
        self.sigma = random.iter().map(|&r| if self.sigma_sys.is_finite() { (r * r + self.sigma_sys * self.sigma_sys).sqrt() as f32 } else { r as f32 }).collect();
        // Check: lattice against exact projections, and the rigorous two-ray intersection of the
        // matched conjugates against the post height (sample of up to 200 posts).
        let idx: Vec<usize> = (0..n).filter(|&q| self.heights[q].is_finite()).collect();
        let take = idx.len().min(200);
        let (mut px, mut dz, mut cnt) = (0.0f64, 0.0f64, 0usize);
        for t in 0..take {
            let q = idx[t * idx.len() / take.max(1)];
            let (fi, fj) = ((q % g.nx) as f64, (q / g.nx) as f64);
            let (la, lo) = g.at(fi, fj);
            let h = self.heights[q] as f64 + if self.p.anchor { self.anchor_offset } else { 0.0 };
            let gp = Ground { lat: la, lon: lo, h };
            let (Ok(ea), Ok(eb)) = (self.models[0].ground_to_image(gp), self.models[1].ground_to_image(gp)) else { continue };
            let la_ = self.lat[0].at(fi, fj, h);
            let lb_ = self.lat[1].at(fi, fj, h);
            px = px.max((la_[0] - ea.0).hypot(la_[1] - ea.1)).max((lb_[0] - eb.0).hypot(lb_[1] - eb.1));
            let obs = [gw_sensor::intersect::Observation { model: &self.models[0], x: ea.0, y: ea.1, sigma_px: 0.5 }, gw_sensor::intersect::Observation { model: &self.models[1], x: eb.0, y: eb.1, sigma_px: 0.5 }];
            if let Ok(x) = gw_sensor::intersect::intersect(&obs, Some(Ground { lat: la, lon: lo, h: h + 20.0 })) {
                dz = dz.max((x.ground.h - h).abs());
                cnt += 1;
            }
        }
        self.lattice_max_px = if take > 0 { px } else { f64::NAN };
        self.intersect_max_m = if cnt > 0 { dz } else { f64::NAN };
        self.intersect_n = cnt;
        self.done_w = self.total_w;
    }

    /// Statistics as JSON (the outputs are the arrays).
    pub fn stats_json(&self) -> String {
        let n = self.grid.n();
        let count = |f: &dyn Fn(u8) -> bool| self.flags.iter().filter(|&&v| f(v)).count() as i64;
        let mut j = Json::new();
        j.obj();
        j.kv_int("posts", n as i64).kv_int("nx", self.grid.nx as i64).kv_int("ny", self.grid.ny as i64).kv_num("postM", self.post_m);
        j.kv_int("matched", self.heights.iter().filter(|v| v.is_finite()).count() as i64);
        j.kv_int("layoverA", count(&|v| v & flag::LAYOVER_A != 0)).kv_int("layoverB", count(&|v| v & flag::LAYOVER_B != 0));
        j.kv_int("shadowA", count(&|v| v & flag::SHADOW_A != 0)).kv_int("shadowB", count(&|v| v & flag::SHADOW_B != 0));
        j.kv_int("masked", count(&|v| v & flag::MASKED != 0)).kv_int("weak", count(&|v| v == flag::WEAK)).kv_int("ambiguous", count(&|v| v == flag::AMBIGUOUS)).kv_int("rejected", count(&|v| v == flag::REJECTED)).kv_int("noData", count(&|v| v == flag::NO_DATA));
        j.kv_num("shiftM", self.shift_m).kv_num("shiftE", self.shift_en[0]).kv_num("shiftN", self.shift_en[1]);
        j.kv_bool("anchored", self.p.anchor).kv_num("anchorOffset", self.anchor_offset);
        j.kv_num("sigmaSys", self.sigma_sys).kv_str("sigmaSysSource", self.sigma_sys_source);
        j.kv_num("latticeMaxPx", self.lattice_max_px).kv_num("intersectMaxM", self.intersect_max_m).kv_int("intersectN", self.intersect_n as i64);
        let ge = &self.geom;
        j.key("geometry").obj().kv_num("intersectionDeg", ge.intersection_deg).kv_bool("sameSide", ge.same_side).kv_num("dAzimuthDeg", ge.d_azimuth_deg).kv_num("parallax", ge.parallax);
        j.key("incidenceDeg").arr().num(ge.incidence_deg[0]).num(ge.incidence_deg[1]).end_arr();
        j.key("lookAzimuthDeg").arr().num(ge.look_azimuth_deg[0]).num(ge.look_azimuth_deg[1]).end_arr();
        j.key("parallaxDir").arr().num(ge.parallax_dir[0]).num(ge.parallax_dir[1]).end_arr();
        j.end_obj();
        j.key("levels").arr();
        for s in &self.levels {
            j.obj().kv_num("postM", s.post_m).kv_int("nx", s.nx as i64).kv_int("ny", s.ny as i64).kv_num("stepM", s.step_m).kv_num("rangeM", s.range_m).kv_int("planes", s.planes as i64).kv_int("accepted", s.accepted as i64).kv_int("weak", s.weak as i64).kv_int("ambiguous", s.ambiguous as i64).kv_int("rejected", s.rejected as i64).kv_num("medianScore", s.median_score).end_obj();
        }
        j.end_arr();
        j.kv_str("cost", if self.p.cost == Cost::Zncc { "zncc" } else { "logratio" });
        j.end_obj();
        j.finish()
    }
}

/// Bilinear sample of a row-major grid at fractional (fi, fj), clamped to the grid; NaN-aware
/// (NaN corners are left out).
fn sample_grid(v: &[f64], w: usize, h: usize, fi: f64, fj: f64) -> f64 {
    if w == 0 || h == 0 || v.len() != w * h {
        return f64::NAN;
    }
    let fi = fi.clamp(0.0, (w - 1) as f64);
    let fj = fj.clamp(0.0, (h - 1) as f64);
    let i = (fi.floor() as usize).min(w.saturating_sub(2));
    let j = (fj.floor() as usize).min(h.saturating_sub(2));
    let (tx, ty) = (fi - i as f64, fj - j as f64);
    let (mut s, mut c) = (0.0, 0.0);
    for (a, b, wt) in [(i, j, (1.0 - tx) * (1.0 - ty)), (i + 1, j, tx * (1.0 - ty)), (i, j + 1, (1.0 - tx) * ty), (i + 1, j + 1, tx * ty)] {
        if a < w && b < h {
            let x = v[b * w + a];
            if x.is_finite() {
                s += wt * x;
                c += wt;
            }
        }
    }
    if c > 1e-9 {
        s / c
    } else {
        f64::NAN
    }
}

/// Fill NaN cells (known = false) by bounded neighbour averaging, the rest with `dflt`.
fn diffuse(v: &mut [f64], known: &[bool], w: usize, h: usize, dflt: f64) {
    for _ in 0..(w.max(h)).min(256) {
        let src = v.to_vec();
        let mut any = false;
        for j in 0..h {
            for i in 0..w {
                let q = j * w + i;
                if known[q] || src[q].is_finite() {
                    continue;
                }
                let (mut s, mut c) = (0.0, 0);
                if i > 0 && src[q - 1].is_finite() {
                    s += src[q - 1];
                    c += 1;
                }
                if i + 1 < w && src[q + 1].is_finite() {
                    s += src[q + 1];
                    c += 1;
                }
                if j > 0 && src[q - w].is_finite() {
                    s += src[q - w];
                    c += 1;
                }
                if j + 1 < h && src[q + w].is_finite() {
                    s += src[q + w];
                    c += 1;
                }
                if c > 0 {
                    v[q] = s / c as f64;
                } else {
                    any = true;
                }
            }
        }
        if !any {
            break;
        }
    }
    for x in v.iter_mut() {
        if !x.is_finite() {
            *x = dflt;
        }
    }
}

fn smooth3(v: &[f64], w: usize, h: usize) -> Vec<f64> {
    let mut o = vec![0.0; v.len()];
    for j in 0..h {
        for i in 0..w {
            let (mut s, mut c) = (0.0, 0.0);
            for jj in j.saturating_sub(1)..(j + 2).min(h) {
                for ii in i.saturating_sub(1)..(i + 2).min(w) {
                    s += v[jj * w + ii];
                    c += 1.0;
                }
            }
            o[j * w + i] = s / c;
        }
    }
    o
}

/// Window similarity of two log-intensity planes (NaN = no data) over (2r + 1)² posts.
pub fn window_similarity(a: &[f64], b: &[f64], w: usize, h: usize, r: usize, cost: Cost) -> Vec<f64> {
    let sw = w + 1;
    let mut t = vec![[0.0f64; 6]; sw * (h + 1)];
    for j in 0..h {
        let mut row = [0.0f64; 6];
        for i in 0..w {
            let (x, y) = (a[j * w + i], b[j * w + i]);
            if x.is_finite() && y.is_finite() {
                row[0] += 1.0;
                row[1] += x;
                row[2] += y;
                row[3] += x * x;
                row[4] += y * y;
                row[5] += x * y;
            }
            let up = t[j * sw + i + 1];
            let cell = &mut t[(j + 1) * sw + i + 1];
            for k in 0..6 {
                cell[k] = up[k] + row[k];
            }
        }
    }
    let need = 0.6 * ((2 * r + 1) * (2 * r + 1)) as f64;
    let mut out = vec![f64::NAN; w * h];
    for j in 0..h {
        let (j0, j1) = (j.saturating_sub(r), (j + r + 1).min(h));
        for i in 0..w {
            if !(a[j * w + i].is_finite() && b[j * w + i].is_finite()) {
                continue;
            }
            let (i0, i1) = (i.saturating_sub(r), (i + r + 1).min(w));
            let mut s = [0.0f64; 6];
            for k in 0..6 {
                s[k] = t[j1 * sw + i1][k] - t[j0 * sw + i1][k] - t[j1 * sw + i0][k] + t[j0 * sw + i0][k];
            }
            let n = s[0];
            if n < need {
                continue;
            }
            let va = s[3] - s[1] * s[1] / n;
            let vb = s[4] - s[2] * s[2] / n;
            let cv = s[5] - s[1] * s[2] / n;
            if !(va > 1e-12 * n && vb > 1e-12 * n) {
                continue;
            }
            out[j * w + i] = match cost {
                Cost::Zncc => cv / (va * vb).sqrt(),
                Cost::LogRatio => 2.0 * cv / (va + vb),
            };
        }
    }
    out
}

/// Block-average amplitude (or intensity) samples to mean intensity: input w × h, output
/// ceil(w/mx) × ceil(h/my). `amplitude` squares the input. NaN or non-positive samples are no data.
pub fn multilook(v: &[f32], w: usize, h: usize, mx: usize, my: usize, amplitude: bool) -> Result<(Vec<f32>, usize, usize)> {
    if w == 0 || h == 0 || w.checked_mul(h) != Some(v.len()) || mx == 0 || my == 0 || mx > 4096 || my > 4096 {
        return Err(Error::invalid("multilook: array size does not match the dimensions"));
    }
    let (ow, oh) = (w.div_ceil(mx), h.div_ceil(my));
    let mut s = vec![0.0f64; ow * oh];
    let mut c = vec![0u32; ow * oh];
    for j in 0..h {
        let oj = j / my;
        for i in 0..w {
            let a = v[j * w + i];
            if a.is_finite() && a > 0.0 {
                let q = oj * ow + i / mx;
                s[q] += if amplitude { (a as f64) * (a as f64) } else { a as f64 };
                c[q] += 1;
            }
        }
    }
    let out = s.iter().zip(&c).map(|(&s, &c)| if c > 0 { (s / c as f64) as f32 } else { f32::NAN }).collect();
    Ok((out, ow, oh))
}

#[cfg(test)]
mod tests;
