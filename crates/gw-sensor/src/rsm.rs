//! RSM, the Replacement Sensor Model (REQ-SNS-03, REQ-GAP-18; STDI-0002 Vol. 1 App. U). Field
//! layouts follow GDAL's TRE tables (`nitf_spec.xml`); the specification itself was not read
//! (`Research/06` §2.3), so meanings marked [unverified] below are reconstructions.
//!
//! - Ground domain (RSMIDA GRNDD) G: x = longitude (rad), y = latitude (rad), z = HAE (m); H: as G
//!   with longitude in 0 … 2π; R: a local rectangular frame (origin and unit vectors in ECEF).
//! - Polynomial sections (RSMPCA): row and column are ratios of polynomials in normalised ground
//!   coordinates, each polynomial with its own maximum powers, coefficients x fastest, then y, z.
//! - Grid sections (RSMGGA): row and column at the nodes of NPLN planes of constant z; Lagrange
//!   interpolation of order INTORD inside a plane and across planes [unverified: INTORD 0 is taken
//!   as nearest node; nodes y outer, x inner].
//! - Section index (RSMPIA / RSMGIA): a quadratic in unnormalised ground x, y, z gives an
//!   approximate row and column; section i = ⌊(row − MINR) / RSSIZ⌋ + 1, clamped to 1 … RNIS
//!   (columns likewise).
//! - Adjustable parameters (RSMAPA/RSMAPB values; RSMECA/RSMECB indirect and RSMDCA/RSMDCB direct
//!   covariance): image-space terms Δrow, Δcol = Σ aᵢ·xᵖ·yᑫ·zʳ in local coordinates, and
//!   ground-space terms (offsets, small rotations, scale, affine) applied to the local ground point
//!   before projection [unverified sign conventions]. Values from RSMAPA/APB are applied; the
//!   covariance belongs to the adjustable set the block adjustment estimates.
//!
//! Image coordinates: RSM rows/columns are taken as pixel-centre based (the first pixel's centre
//! is 0, as RPC00B) [unverified]; `ground_to_image` adds 0.5 (corner-origin, see `lib.rs`).

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};
use gw_geodesy::wgs84::{ecef_to_geodetic, geodetic_to_ecef};

#[derive(Clone, Debug)]
pub struct Poly {
    /// Maximum powers of x, y, z; coefficients with x fastest, then y, then z.
    pub px: usize,
    pub py: usize,
    pub pz: usize,
    pub c: Vec<f64>,
}

impl Poly {
    pub fn eval(&self, x: f64, y: f64, z: f64) -> f64 {
        let mut s = 0.0;
        let mut k = 0;
        let mut zk = 1.0;
        for _ in 0..=self.pz {
            let mut yj = 1.0;
            for _ in 0..=self.py {
                let mut xi = 1.0;
                for _ in 0..=self.px {
                    s += self.c.get(k).copied().unwrap_or(0.0) * xi * yj * zk;
                    k += 1;
                    xi *= x;
                }
                yj *= y;
            }
            zk *= z;
        }
        s
    }
    pub fn terms(&self) -> usize {
        (self.px + 1) * (self.py + 1) * (self.pz + 1)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    Geodetic,
    Geodetic2Pi,
    Rectangular,
}

/// One polynomial section (RSMPCA).
#[derive(Clone, Debug)]
pub struct PolySection {
    pub rsn: usize,
    pub csn: usize,
    /// Normalisation offsets and scales: row, col, x, y, z.
    pub off: [f64; 5],
    pub scale: [f64; 5],
    /// Row numerator, row denominator, column numerator, column denominator.
    pub polys: [Poly; 4],
}

impl PolySection {
    fn eval(&self, p: [f64; 3]) -> Result<(f64, f64)> {
        let (x, y, z) = ((p[0] - self.off[2]) / self.scale[2], (p[1] - self.off[3]) / self.scale[3], (p[2] - self.off[4]) / self.scale[4]);
        let rd = self.polys[1].eval(x, y, z);
        let cd = self.polys[3].eval(x, y, z);
        if rd == 0.0 || cd == 0.0 {
            return Err(Error::range("RSM: zero denominator"));
        }
        Ok((self.polys[0].eval(x, y, z) / rd * self.scale[0] + self.off[0], self.polys[2].eval(x, y, z) / cd * self.scale[1] + self.off[1]))
    }
}

/// One plane of a grid section: nodes at (x0 + i·dx, y0 + j·dy), row-major with x fastest.
#[derive(Clone, Debug)]
pub struct GridPlane {
    pub x0: f64,
    pub y0: f64,
    pub nx: usize,
    pub ny: usize,
    /// Row and column per node (NaN where the TRE leaves the node blank).
    pub row: Vec<f64>,
    pub col: Vec<f64>,
}

/// One ground-to-image grid section (RSMGGA).
#[derive(Clone, Debug)]
pub struct GridSection {
    pub rsn: usize,
    pub csn: usize,
    pub intord: usize,
    /// z of the first plane and the plane spacing; node spacing in x and y.
    pub z0: f64,
    pub dz: f64,
    pub dx: f64,
    pub dy: f64,
    pub planes: Vec<GridPlane>,
}

/// Lagrange weights for `m` consecutive nodes starting at i0 at fractional position u (node units).
fn lagrange(m: usize, i0: isize, u: f64) -> Vec<f64> {
    (0..m)
        .map(|a| {
            let ia = i0 + a as isize;
            (0..m).filter(|b| *b != a).fold(1.0, |w, b| {
                let ib = i0 + b as isize;
                w * (u - ib as f64) / (ia - ib) as f64
            })
        })
        .collect()
}

/// First node and count for interpolation of `m` points around u on 0 … n−1.
fn window(m: usize, n: usize, u: f64) -> (isize, usize) {
    let m = m.min(n).max(1);
    if m == 1 {
        return ((u.round() as isize).clamp(0, n as isize - 1), 1);
    }
    let i0 = (u.floor() as isize) - (m as isize - 1) / 2;
    (i0.clamp(0, n as isize - m as isize), m)
}

impl GridPlane {
    fn eval(&self, x: f64, y: f64, dx: f64, dy: f64, order: usize) -> Result<(f64, f64)> {
        let (u, v) = ((x - self.x0) / dx, (y - self.y0) / dy);
        let slack = 0.5;
        if !(u >= -slack && v >= -slack && u <= self.nx as f64 - 1.0 + slack && v <= self.ny as f64 - 1.0 + slack) {
            return Err(Error::range("RSM: the ground point is outside the grid"));
        }
        let (i0, mi) = window(order + 1, self.nx, u);
        let (j0, mj) = window(order + 1, self.ny, v);
        let wi = if mi == 1 { vec![1.0] } else { lagrange(mi, i0, u) };
        let wj = if mj == 1 { vec![1.0] } else { lagrange(mj, j0, v) };
        let (mut r, mut c) = (0.0, 0.0);
        for (b, wb) in wj.iter().enumerate() {
            for (a, wa) in wi.iter().enumerate() {
                let k = (j0 as usize + b) * self.nx + i0 as usize + a;
                let (rr, cc) = (self.row[k], self.col[k]);
                if !(rr.is_finite() && cc.is_finite()) {
                    return Err(Error::range("RSM: the grid has no node here"));
                }
                r += wa * wb * rr;
                c += wa * wb * cc;
            }
        }
        Ok((r, c))
    }
}

impl GridSection {
    fn eval(&self, p: [f64; 3]) -> Result<(f64, f64)> {
        let n = self.planes.len();
        let w = (p[2] - self.z0) / self.dz;
        let (k0, mk) = window((self.intord + 1).max(2), n, w);
        let wk = if mk == 1 { vec![1.0] } else { lagrange(mk, k0, w) };
        let (mut r, mut c) = (0.0, 0.0);
        for (a, wa) in wk.iter().enumerate() {
            let (rr, cc) = self.planes[k0 as usize + a].eval(p[0], p[1], self.dx, self.dy, self.intord)?;
            r += wa * rr;
            c += wa * cc;
        }
        Ok((r, c))
    }
}

/// RSMPIA / RSMGIA: section selection from an approximate image position.
#[derive(Clone, Debug)]
pub struct SectionIndex {
    /// Approximate row and column: [0, x, y, z, xx, xy, xz, yy, yz, zz] in unnormalised x, y, z.
    pub r: [f64; 10],
    pub c: [f64; 10],
    pub rnis: usize,
    pub cnis: usize,
    pub rssiz: f64,
    pub cssiz: f64,
}

fn quad(k: &[f64; 10], p: [f64; 3]) -> f64 {
    let [x, y, z] = p;
    k[0] + k[1] * x + k[2] * y + k[3] * z + k[4] * x * x + k[5] * x * y + k[6] * x * z + k[7] * y * y + k[8] * y * z + k[9] * z * z
}

impl SectionIndex {
    /// Approximate (row, col) of a ground point.
    pub fn approx(&self, p: [f64; 3]) -> (f64, f64) {
        (quad(&self.r, p), quad(&self.c, p))
    }
    /// 1-based (row section, column section).
    pub fn select(&self, p: [f64; 3], minr: f64, minc: f64) -> (usize, usize) {
        let (r, c) = self.approx(p);
        let pick = |v: f64, min: f64, size: f64, n: usize| -> usize {
            if !(size > 0.0) || n <= 1 {
                return 1;
            }
            (((v - min) / size).floor() as i64 + 1).clamp(1, n as i64) as usize
        };
        (pick(r, minr, self.rssiz, self.rnis), pick(c, minc, self.cssiz, self.cnis))
    }
}

/// The model's geometry: polynomial sections or grid sections.
#[derive(Clone, Debug)]
pub enum Geometry {
    Poly(Vec<PolySection>),
    Grid(Vec<GridSection>),
}

/// Local frame of an adjustable-parameter set.
#[derive(Clone, Copy, Debug)]
pub enum Frame {
    /// Local rectangular: origin and unit-vector rows in ECEF (metres).
    Rect { origin: [f64; 3], axes: [[f64; 3]; 3] },
    /// The RSM ground domain's own coordinates (RSMAPB/ECB LOCTYP N) [unverified].
    Domain,
}

/// One adjustable parameter.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Term {
    /// Image-space row or column term with powers of local x, y, z.
    Row(u8, u8, u8),
    Col(u8, u8, u8),
    /// Ground-space term: 0..15 = GXO GYO GZO GXR GYR GZR GS GXX GXY GXZ GYX GYY GYZ GZX GZY GZZ.
    Ground(u8),
}

pub const GROUND_IDS: [&str; 16] = ["GXO", "GYO", "GZO", "GXR", "GYR", "GZR", "GS", "GXX", "GXY", "GXZ", "GYX", "GYY", "GYZ", "GZX", "GZY", "GZZ"];

/// A set of adjustable parameters: definition and values.
#[derive(Clone, Debug)]
pub struct ParamSet {
    pub frame: Frame,
    /// Normalisation of the local coordinates: (v − off) / scale (RSMECB/APB NOFF*, NSF*; 0 and 1 in set A).
    pub norm_off: [f64; 3],
    pub norm_scale: [f64; 3],
    pub terms: Vec<Term>,
    pub values: Vec<f64>,
}

impl ParamSet {
    fn has_ground(&self) -> bool {
        self.terms.iter().any(|t| matches!(t, Term::Ground(_)))
    }
    /// Local (unnormalised) coordinates of a ground point.
    fn local(&self, g: Ground, domain_xyz: [f64; 3]) -> [f64; 3] {
        match self.frame {
            Frame::Domain => domain_xyz,
            Frame::Rect { origin, axes } => {
                let p = geodetic_to_ecef(g.lat, g.lon, g.h);
                let d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
                [0, 1, 2].map(|i| axes[i][0] * d[0] + axes[i][1] * d[1] + axes[i][2] * d[2])
            }
        }
    }
    fn normalised(&self, l: [f64; 3]) -> [f64; 3] {
        [0, 1, 2].map(|i| (l[i] - self.norm_off[i]) / if self.norm_scale[i] != 0.0 { self.norm_scale[i] } else { 1.0 })
    }
    /// Image-space correction (Δrow, Δcol) at normalised local coordinates.
    fn image_delta(&self, n: [f64; 3], values: &[f64]) -> (f64, f64) {
        let mut d = (0.0, 0.0);
        for (t, v) in self.terms.iter().zip(values) {
            match *t {
                Term::Row(a, b, c) => d.0 += v * n[0].powi(a as i32) * n[1].powi(b as i32) * n[2].powi(c as i32),
                Term::Col(a, b, c) => d.1 += v * n[0].powi(a as i32) * n[1].powi(b as i32) * n[2].powi(c as i32),
                Term::Ground(_) => {}
            }
        }
        d
    }
    /// Ground-space correction of a local point: X + offset + (scale·I + rotation + affine)·X.
    fn ground_delta(&self, x: [f64; 3], values: &[f64]) -> [f64; 3] {
        let mut g = [0.0; 16];
        for (t, v) in self.terms.iter().zip(values) {
            if let Term::Ground(i) = *t {
                g[i as usize] += v;
            }
        }
        let m = [
            [g[6] + g[7], g[8] - g[5], g[9] + g[4]],
            [g[10] + g[5], g[6] + g[11], g[12] - g[3]],
            [g[13] - g[4], g[14] + g[3], g[6] + g[15]],
        ];
        [0, 1, 2].map(|i| x[i] + g[i] + m[i][0] * x[0] + m[i][1] * x[1] + m[i][2] * x[2])
    }
}

pub struct RsmModel {
    pub domain: Domain,
    /// Rectangular ground domain: origin (ECEF) and unit vectors (rows x, y, z) when domain = R.
    pub origin: [f64; 3],
    pub axes: [[f64; 3]; 3],
    /// Image size (rows, cols) and the first valid row and column (RSMIDA MINR, MINC).
    pub size: (f64, f64),
    pub min_rc: (f64, f64),
    /// Ground reference point (RSMIDA GRPX/Y/Z, in the ground domain) if given.
    pub grp: Option<[f64; 3]>,
    pub geometry: Geometry,
    pub index: Option<SectionIndex>,
    /// Corrections from RSMAPA/RSMAPB, always applied.
    pub applied: Option<ParamSet>,
    /// The adjustable set (values = current corrections) and its covariance (n × n).
    pub adjustable: Option<ParamSet>,
    pub cov: Option<Vec<f64>>,
    /// Unmodelled error (RSMECA/ECB URR, URC, UCC): row-row, row-col, col-col, pixels².
    pub unmodelled: Option<[f64; 3]>,
    name: String,
}

impl RsmModel {
    /// The 2.2 single-section polynomial model.
    #[allow(clippy::too_many_arguments)]
    pub fn new(domain: Domain, origin: [f64; 3], axes: [[f64; 3]; 3], off: [f64; 5], scale: [f64; 5], polys: [Poly; 4], size: (f64, f64)) -> Result<Self> {
        Self::build(domain, origin, axes, size, (0.0, 0.0), None, Geometry::Poly(vec![PolySection { rsn: 1, csn: 1, off, scale, polys }]), None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn build(domain: Domain, origin: [f64; 3], axes: [[f64; 3]; 3], size: (f64, f64), min_rc: (f64, f64), grp: Option<[f64; 3]>, geometry: Geometry, index: Option<SectionIndex>) -> Result<Self> {
        let n = match &geometry {
            Geometry::Poly(s) => {
                for sec in s {
                    if sec.scale.iter().any(|s| *s == 0.0 || !s.is_finite()) {
                        return Err(Error::invalid("RSM: a normalisation scale is zero"));
                    }
                    for p in &sec.polys {
                        if p.c.len() != p.terms() {
                            return Err(Error::invalid(format!("RSM: a polynomial has {} coefficients for {} terms", p.c.len(), p.terms())));
                        }
                    }
                }
                s.len()
            }
            Geometry::Grid(s) => {
                for sec in s {
                    if sec.planes.len() < 2 || !(sec.dx != 0.0 && sec.dy != 0.0 && sec.dz != 0.0) || sec.intord > 3 {
                        return Err(Error::invalid("RSM grid: needs two or more planes, non-zero spacings and an interpolation order 0–3"));
                    }
                    for pl in &sec.planes {
                        if pl.nx < 2 || pl.ny < 2 || pl.row.len() != pl.nx * pl.ny || pl.col.len() != pl.nx * pl.ny {
                            return Err(Error::invalid("RSM grid: a plane's node count does not match its size"));
                        }
                    }
                }
                s.len()
            }
        };
        if n == 0 {
            return Err(Error::invalid("RSM: no sections"));
        }
        let sections = index.as_ref().map(|i| (i.rnis, i.cnis)).unwrap_or((1, 1));
        if n > 1 && index.is_none() {
            return Err(Error::invalid("RSM: several sections but no section index (RSMPIA/RSMGIA)"));
        }
        let kind = if matches!(geometry, Geometry::Poly(_)) { "polynomial" } else { "grid" };
        let name = if sections.0 * sections.1 > 1 { format!("RSM {kind} ({} × {} sections, experimental)", sections.0, sections.1) } else { format!("RSM {kind} (experimental)") };
        Ok(RsmModel { domain, origin, axes, size, min_rc, grp, geometry, index, applied: None, adjustable: None, cov: None, unmodelled: None, name })
    }

    /// Ground-domain coordinates of a ground point.
    pub fn ground_xyz(&self, g: Ground) -> [f64; 3] {
        match self.domain {
            Domain::Geodetic => [g.lon.to_radians(), g.lat.to_radians(), g.h],
            Domain::Geodetic2Pi => [g.lon.to_radians().rem_euclid(2.0 * std::f64::consts::PI), g.lat.to_radians(), g.h],
            Domain::Rectangular => {
                let p = geodetic_to_ecef(g.lat, g.lon, g.h);
                let d = [p[0] - self.origin[0], p[1] - self.origin[1], p[2] - self.origin[2]];
                [0, 1, 2].map(|i| self.axes[i][0] * d[0] + self.axes[i][1] * d[1] + self.axes[i][2] * d[2])
            }
        }
    }

    /// Ground point of ground-domain coordinates.
    pub fn domain_ground(&self, p: [f64; 3]) -> Ground {
        match self.domain {
            Domain::Geodetic | Domain::Geodetic2Pi => {
                let lon = p[0].to_degrees();
                Ground { lat: p[1].to_degrees(), lon: if lon > 180.0 { lon - 360.0 } else { lon }, h: p[2] }
            }
            Domain::Rectangular => {
                let a = &self.axes;
                let e = [0, 1, 2].map(|i| self.origin[i] + a[0][i] * p[0] + a[1][i] * p[1] + a[2][i] * p[2]);
                let (lat, lon, h) = ecef_to_geodetic(e[0], e[1], e[2]);
                Ground { lat, lon, h }
            }
        }
    }

    /// Raw RSM (row, col) of ground-domain coordinates (no adjustable parameters).
    pub fn eval_domain(&self, p: [f64; 3]) -> Result<(f64, f64)> {
        let (rs, cs) = self.index.as_ref().map(|i| i.select(p, self.min_rc.0, self.min_rc.1)).unwrap_or((1, 1));
        match &self.geometry {
            Geometry::Poly(s) => {
                let sec = if s.len() == 1 { &s[0] } else { s.iter().find(|q| q.rsn == rs && q.csn == cs).ok_or_else(|| gw_abi::err!(RANGE, "RSM: polynomial section {r},{c} is missing", r = rs, c = cs))? };
                sec.eval(p)
            }
            Geometry::Grid(s) => {
                let sec = if s.len() == 1 { &s[0] } else { s.iter().find(|q| q.rsn == rs && q.csn == cs).ok_or_else(|| gw_abi::err!(RANGE, "RSM: grid section {r},{c} is missing", r = rs, c = cs))? };
                sec.eval(p)
            }
        }
    }

    /// Apply one parameter set's ground-space part to a ground point.
    fn ground_adjust(&self, set: &ParamSet, values: &[f64], g: Ground) -> Ground {
        if !set.has_ground() {
            return g;
        }
        match set.frame {
            Frame::Domain => {
                let p = self.ground_xyz(g);
                let n = set.normalised(p);
                let d = set.ground_delta(n, values);
                let back = [0, 1, 2].map(|i| d[i] * if set.norm_scale[i] != 0.0 { set.norm_scale[i] } else { 1.0 } + set.norm_off[i]);
                self.domain_ground(back)
            }
            Frame::Rect { origin, axes } => {
                let l = set.local(g, [0.0; 3]);
                let n = set.normalised(l);
                let d = set.ground_delta(n, values);
                let x = [0, 1, 2].map(|i| d[i] * if set.norm_scale[i] != 0.0 { set.norm_scale[i] } else { 1.0 } + set.norm_off[i]);
                let e = [0, 1, 2].map(|i| origin[i] + axes[0][i] * x[0] + axes[1][i] * x[1] + axes[2][i] * x[2]);
                let (lat, lon, h) = ecef_to_geodetic(e[0], e[1], e[2]);
                Ground { lat, lon, h }
            }
        }
    }

    /// (row, col) with the applied and adjustable corrections; `adj` overrides the adjustable values.
    fn project(&self, g: Ground, adj: Option<&[f64]>) -> Result<(f64, f64)> {
        let sets: [(Option<&ParamSet>, Option<&[f64]>); 2] = [(self.applied.as_ref(), None), (self.adjustable.as_ref(), adj)];
        let mut gg = g;
        for (s, v) in sets {
            if let Some(s) = s {
                gg = self.ground_adjust(s, v.unwrap_or(&s.values), gg);
            }
        }
        let (mut r, mut c) = self.eval_domain(self.ground_xyz(gg))?;
        let xyz = self.ground_xyz(g);
        for (s, v) in sets {
            if let Some(s) = s {
                let (dr, dc) = s.image_delta(s.normalised(s.local(g, xyz)), v.unwrap_or(&s.values));
                r += dr;
                c += dc;
            }
        }
        Ok((r, c))
    }

    /// Starting ground point for the image-to-ground iteration.
    fn start(&self, x: f64, y: f64, h: f64) -> Ground {
        // The section index polynomial inverted at the height (a few Newton steps), else the GRP or
        // the first section's offsets.
        let base = match (&self.grp, &self.geometry, self.domain) {
            (Some(p), _, _) => self.domain_ground(*p),
            (None, Geometry::Poly(s), Domain::Geodetic | Domain::Geodetic2Pi) => self.domain_ground([s[0].off[2], s[0].off[3], s[0].off[4]]),
            (None, Geometry::Grid(s), _) => {
                let pl = &s[0].planes[0];
                self.domain_ground([pl.x0 + 0.5 * (pl.nx - 1) as f64 * s[0].dx, pl.y0 + 0.5 * (pl.ny - 1) as f64 * s[0].dy, s[0].z0])
            }
            _ => {
                let (lat, lon, _) = ecef_to_geodetic(self.origin[0], self.origin[1], self.origin[2]);
                Ground { lat, lon, h }
            }
        };
        let mut g = Ground { h, ..base };
        if let Some(ix) = &self.index {
            let (row, col) = (y - 0.5, x - 0.5);
            for _ in 0..20 {
                let p = self.ground_xyz(g);
                let (r0, c0) = ix.approx(p);
                let d = 1e-7;
                let (r1, c1) = ix.approx(self.ground_xyz(Ground { lat: g.lat + d, ..g }));
                let (r2, c2) = ix.approx(self.ground_xyz(Ground { lon: g.lon + d, ..g }));
                let (a, b, c, e) = ((r1 - r0) / d, (r2 - r0) / d, (c1 - c0) / d, (c2 - c0) / d);
                let det = a * e - b * c;
                if !(det.abs() > 1e-30) {
                    break;
                }
                let (er, ec) = (row - r0, col - c0);
                let (dl, dn) = ((e * er - b * ec) / det, (-c * er + a * ec) / det);
                if !(dl.is_finite() && dn.is_finite()) || dl.abs() > 90.0 || dn.abs() > 180.0 {
                    break;
                }
                g.lat = (g.lat + dl).clamp(-89.9, 89.9);
                g.lon += dn;
                if dl.abs() + dn.abs() < 1e-9 {
                    break;
                }
            }
        }
        g
    }
}

impl SensorModel for RsmModel {
    fn name(&self) -> &str {
        &self.name
    }
    /// RSM rows/columns are pixel-centre based (the first pixel's centre is 0): + 0.5 here.
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let (row, col) = self.project(g, None)?;
        Ok((col + 0.5, row + 0.5))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        // Newton on (lat, lon) at fixed h with numerical partials; steps limited so a section or
        // grid edge cannot throw the iteration far away.
        let mut g = self.start(x, y, h);
        for _ in 0..60 {
            let (cx, cy) = self.ground_to_image(g)?;
            let (ex, ey) = (x - cx, y - cy);
            if ex.abs() + ey.abs() < 1e-7 {
                return Ok(g);
            }
            let d = 1e-6;
            let (ax, ay) = self.ground_to_image(Ground { lat: g.lat + d, ..g })?;
            let (bx, by) = self.ground_to_image(Ground { lon: g.lon + d, ..g })?;
            let (j11, j12, j21, j22) = ((ax - cx) / d, (bx - cx) / d, (ay - cy) / d, (by - cy) / d);
            let det = j11 * j22 - j12 * j21;
            if det.abs() < 1e-18 {
                return Err(Error::range("RSM: singular image-to-ground step"));
            }
            let (mut dl, mut dn) = ((j22 * ex - j12 * ey) / det, (-j21 * ex + j11 * ey) / det);
            let m = dl.abs().max(dn.abs());
            if m > 5.0 {
                dl *= 5.0 / m;
                dn *= 5.0 / m;
            }
            g.lat += dl;
            g.lon += dn;
        }
        Err(Error::range("RSM image-to-ground did not converge"))
    }
    fn height_range(&self) -> (f64, f64) {
        match &self.geometry {
            Geometry::Grid(s) if self.domain != Domain::Rectangular => {
                let lo = s.iter().map(|q| q.z0.min(q.z0 + q.dz * (q.planes.len() - 1) as f64)).fold(f64::INFINITY, f64::min);
                let hi = s.iter().map(|q| q.z0.max(q.z0 + q.dz * (q.planes.len() - 1) as f64)).fold(f64::NEG_INFINITY, f64::max);
                (lo, hi)
            }
            Geometry::Poly(s) if self.domain != Domain::Rectangular => (s[0].off[4] - s[0].scale[4].abs(), s[0].off[4] + s[0].scale[4].abs()),
            _ => (-1000.0, 10000.0),
        }
    }
    fn param_count(&self) -> usize {
        self.adjustable.as_ref().map_or(0, |s| s.terms.len())
    }
    fn param_name(&self, i: usize) -> String {
        match self.adjustable.as_ref().and_then(|s| s.terms.get(i)) {
            Some(Term::Row(a, b, c)) => format!("row x{a}y{b}z{c}"),
            Some(Term::Col(a, b, c)) => format!("col x{a}y{b}z{c}"),
            Some(Term::Ground(k)) => GROUND_IDS[*k as usize].to_string(),
            None => String::new(),
        }
    }
    fn param_covariance(&self) -> Option<Vec<f64>> {
        self.cov.clone()
    }
    fn with_params(&self, delta: &[f64]) -> Result<Box<dyn SensorModel>> {
        let Some(s) = &self.adjustable else {
            return Err(Error::unsupported("this RSM has no adjustable parameters"));
        };
        if delta.len() != s.values.len() {
            return Err(Error::invalid("RSM: wrong number of parameter corrections"));
        }
        let mut adj = s.clone();
        for (v, d) in adj.values.iter_mut().zip(delta) {
            *v += d;
        }
        Ok(Box::new(RsmModel {
            domain: self.domain,
            origin: self.origin,
            axes: self.axes,
            size: self.size,
            min_rc: self.min_rc,
            grp: self.grp,
            geometry: self.geometry.clone(),
            index: self.index.clone(),
            applied: self.applied.clone(),
            adjustable: Some(adj),
            cov: self.cov.clone(),
            unmodelled: self.unmodelled,
            name: self.name.clone(),
        }))
    }
    fn param_step(&self, i: usize) -> f64 {
        match self.adjustable.as_ref().and_then(|s| s.terms.get(i)) {
            Some(Term::Ground(k)) if *k < 3 => 1e-2,
            Some(Term::Ground(_)) => 1e-7,
            _ => 1e-3,
        }
    }
    /// Image-space terms in closed form (they are linear); ground-space terms by differences.
    fn param_partials(&self, g: Ground) -> Result<Vec<[f64; 2]>> {
        let Some(s) = &self.adjustable else { return Ok(Vec::new()) };
        let n = s.normalised(s.local(g, self.ground_xyz(g)));
        let mut out = Vec::with_capacity(s.terms.len());
        for (i, t) in s.terms.iter().enumerate() {
            match *t {
                Term::Row(a, b, c) => out.push([0.0, n[0].powi(a as i32) * n[1].powi(b as i32) * n[2].powi(c as i32)]),
                Term::Col(a, b, c) => out.push([n[0].powi(a as i32) * n[1].powi(b as i32) * n[2].powi(c as i32), 0.0]),
                Term::Ground(_) => {
                    let st = self.param_step(i);
                    let mut v = s.values.clone();
                    v[i] += st;
                    let (r1, c1) = self.project(g, Some(&v))?;
                    v[i] -= 2.0 * st;
                    let (r2, c2) = self.project(g, Some(&v))?;
                    out.push([(c1 - c2) / (2.0 * st), (r1 - r2) / (2.0 * st)]);
                }
            }
        }
        Ok(out)
    }
    fn unmodelled_covariance(&self, _x: f64, _y: f64) -> Option<[f64; 3]> {
        // Rows are y and columns x: [σxx, σxy, σyy] = [UCC, URC, URR].
        self.unmodelled.map(|[rr, rc, cc]| [cc, rc, rr])
    }
}

// ---- the flat record (core and photo bundles; written by app/src/sensor/rsm.js) -------------

struct Rd<'a> {
    a: &'a [f64],
    o: usize,
}

impl Rd<'_> {
    fn take(&mut self, n: usize) -> Result<&[f64]> {
        let s = self.a.get(self.o..self.o + n).ok_or_else(|| Error::invalid("RSM record is truncated"))?;
        self.o += n;
        Ok(s)
    }
    fn one(&mut self) -> Result<f64> {
        Ok(self.take(1)?[0])
    }
    fn count(&mut self, max: usize) -> Result<usize> {
        let v = self.one()?;
        if !(v >= 0.0 && v <= max as f64 && v.fract() == 0.0) {
            return Err(Error::invalid("RSM record: a count is out of range"));
        }
        Ok(v as usize)
    }
    fn arr<const N: usize>(&mut self) -> Result<[f64; N]> {
        let s = self.take(N)?;
        let mut o = [0.0; N];
        o.copy_from_slice(s);
        Ok(o)
    }
}

fn read_set(r: &mut Rd) -> Result<Option<ParamSet>> {
    if r.one()? == 0.0 {
        return Ok(None);
    }
    let fk = r.one()?;
    let o = r.arr::<3>()?;
    let a = r.arr::<9>()?;
    let frame = if fk == 0.0 { Frame::Rect { origin: o, axes: [[a[0], a[1], a[2]], [a[3], a[4], a[5]], [a[6], a[7], a[8]]] } } else { Frame::Domain };
    let norm_off = r.arr::<3>()?;
    let norm_scale = r.arr::<3>()?;
    let n = r.count(99)?;
    let mut terms = Vec::with_capacity(n);
    for _ in 0..n {
        let t = r.arr::<4>()?;
        let p = |v: f64| -> Result<u8> {
            if (0.0..=9.0).contains(&v) {
                Ok(v as u8)
            } else {
                Err(Error::invalid("RSM record: a term power is out of range"))
            }
        };
        terms.push(match t[0] as i32 {
            0 => Term::Row(p(t[1])?, p(t[2])?, p(t[3])?),
            1 => Term::Col(p(t[1])?, p(t[2])?, p(t[3])?),
            2 if (0.0..16.0).contains(&t[1]) => Term::Ground(t[1] as u8),
            _ => return Err(Error::invalid("RSM record: unknown adjustable-parameter term")),
        });
    }
    let values = r.take(n)?.to_vec();
    Ok(Some(ParamSet { frame, norm_off, norm_scale, terms, values }))
}

impl RsmModel {
    /// Build from the flat record (version 2):
    /// [2, domain, origin ×3, axes ×9, rows, cols, minr, minc, grp ×3 (NaN = none), geometry
    /// (0 polynomial, 1 grid), index flag (+ R ×10, C ×10, RNIS, CNIS, RSSIZ, CSSIZ), sections:
    /// count then per polynomial section [rsn, csn, off ×5, scale ×5, 4 × (px, py, pz, n, c…)] or
    /// per grid section [rsn, csn, intord, npln, z0, dz, dx, dy, per plane (x0, y0, nx, ny, rows…,
    /// cols…)]; applied set, adjustable set (flag, frame kind 0 rect / 1 domain, origin ×3, axes ×9,
    /// norm off ×3, norm scale ×3, n, n × (type 0 row / 1 col / 2 ground, a, b, c), n values);
    /// covariance flag (+ n × n); unmodelled flag (+ URR, URC, UCC)].
    pub fn from_record(a: &[f64]) -> Result<RsmModel> {
        let mut r = Rd { a, o: 0 };
        if r.one()? != 2.0 {
            return Err(Error::invalid("RSM record: unknown version"));
        }
        let domain = match r.one()? as i32 {
            0 => Domain::Geodetic,
            1 => Domain::Geodetic2Pi,
            _ => Domain::Rectangular,
        };
        let origin = r.arr::<3>()?;
        let ax = r.arr::<9>()?;
        let axes = [[ax[0], ax[1], ax[2]], [ax[3], ax[4], ax[5]], [ax[6], ax[7], ax[8]]];
        let [rows, cols, minr, minc] = r.arr::<4>()?;
        let gp = r.arr::<3>()?;
        let grp = gp.iter().all(|v| v.is_finite()).then_some(gp);
        let grid = r.one()? != 0.0;
        let index = if r.one()? != 0.0 {
            let rr = r.arr::<10>()?;
            let cc = r.arr::<10>()?;
            let [rn, cn, rs, cs] = r.arr::<4>()?;
            if !(rn >= 1.0 && cn >= 1.0 && rn <= 256.0 && cn <= 256.0) {
                return Err(Error::invalid("RSM record: section counts out of range"));
            }
            Some(SectionIndex { r: rr, c: cc, rnis: rn as usize, cnis: cn as usize, rssiz: rs, cssiz: cs })
        } else {
            None
        };
        let ns = r.count(65536)?;
        let geometry = if !grid {
            let mut v = Vec::with_capacity(ns);
            for _ in 0..ns {
                let [rsn, csn] = r.arr::<2>()?;
                let off = r.arr::<5>()?;
                let scale = r.arr::<5>()?;
                let mut polys = Vec::with_capacity(4);
                for _ in 0..4 {
                    let [px, py, pz] = r.arr::<3>()?;
                    let n = r.count(1000)?;
                    if !(px >= 0.0 && py >= 0.0 && pz >= 0.0 && px <= 9.0 && py <= 9.0 && pz <= 9.0) {
                        return Err(Error::invalid("RSM record: polynomial powers out of range"));
                    }
                    polys.push(Poly { px: px as usize, py: py as usize, pz: pz as usize, c: r.take(n)?.to_vec() });
                }
                let polys: [Poly; 4] = polys.try_into().map_err(|_| Error::invalid("RSM record: four polynomials expected"))?;
                v.push(PolySection { rsn: rsn as usize, csn: csn as usize, off, scale, polys });
            }
            Geometry::Poly(v)
        } else {
            let mut v = Vec::with_capacity(ns);
            for _ in 0..ns {
                let [rsn, csn, intord] = r.arr::<3>()?;
                let npln = r.count(999)?;
                let [z0, dz, dx, dy] = r.arr::<4>()?;
                let mut planes = Vec::with_capacity(npln);
                for _ in 0..npln {
                    let [x0, y0] = r.arr::<2>()?;
                    let nx = r.count(999)?;
                    let ny = r.count(999)?;
                    let row = r.take(nx * ny)?.to_vec();
                    let col = r.take(nx * ny)?.to_vec();
                    planes.push(GridPlane { x0, y0, nx, ny, row, col });
                }
                v.push(GridSection { rsn: rsn as usize, csn: csn as usize, intord: intord.max(0.0) as usize, z0, dz, dx, dy, planes });
            }
            Geometry::Grid(v)
        };
        let mut m = RsmModel::build(domain, origin, axes, (rows, cols), (minr, minc), grp, geometry, index)?;
        m.applied = read_set(&mut r)?;
        m.adjustable = read_set(&mut r)?;
        if r.one()? != 0.0 {
            let n = m.param_count();
            if n == 0 {
                return Err(Error::invalid("RSM record: a covariance without adjustable parameters"));
            }
            m.cov = Some(r.take(n * n)?.to_vec());
        }
        if r.one()? != 0.0 {
            m.unmodelled = Some(r.arr::<3>()?);
        }
        if r.o != a.len() {
            return Err(Error::invalid("RSM record has trailing values"));
        }
        Ok(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lin_section(rsn: usize, csn: usize) -> PolySection {
        // row = 1000 − 2e5·(lat − 0.6), col = 1000 + 2e5·(lon + 2.0) (radians), normalised identity.
        let one = Poly { px: 0, py: 0, pz: 0, c: vec![1.0] };
        PolySection {
            rsn,
            csn,
            off: [0.0, 0.0, 0.0, 0.0, 0.0],
            scale: [1.0, 1.0, 1.0, 1.0, 1.0],
            polys: [Poly { px: 1, py: 1, pz: 0, c: vec![1000.0 + 2e5 * 0.6, 0.0, -2e5, 0.0] }, one.clone(), Poly { px: 1, py: 1, pz: 0, c: vec![1000.0 + 2e5 * 2.0, 2e5, 0.0, 0.0] }, one],
        }
    }

    #[test]
    fn lagrange_reproduces_cubics() {
        let w = lagrange(4, 0, 1.3);
        let f = |x: f64| 2.0 - x + 0.5 * x * x - 0.1 * x * x * x;
        let v: f64 = (0..4).map(|i| w[i] * f(i as f64)).sum();
        assert!((v - f(1.3)).abs() < 1e-12);
        assert_eq!(window(4, 10, 0.2), (0, 4));
        assert_eq!(window(4, 10, 9.7), (6, 4));
        assert_eq!(window(1, 10, 3.6), (4, 1));
    }

    #[test]
    fn sections_are_selected_by_the_index() {
        // Two row sections with different row offsets: the index picks by approximate row.
        let mut a = lin_section(1, 1);
        let mut b = lin_section(2, 1);
        a.polys[0].c[0] += 0.0;
        b.polys[0].c[0] += 7.0; // section 2 is shifted by 7 rows
        let ix = SectionIndex { r: [1000.0 + 2e5 * 0.6, 0.0, -2e5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], c: [1000.0 + 2e5 * 2.0, 2e5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], rnis: 2, cnis: 1, rssiz: 1000.0, cssiz: 2000.0 };
        let m = RsmModel::build(Domain::Geodetic, [0.0; 3], [[0.0; 3]; 3], (2000.0, 2000.0), (0.0, 0.0), None, Geometry::Poly(vec![a, b]), Some(ix)).unwrap();
        let lat = |row: f64| (0.6 - (row - 1000.0) / 2e5).to_degrees();
        let lon = (-2.0f64).to_degrees();
        let (_, y1) = m.ground_to_image(Ground { lat: lat(500.0), lon, h: 0.0 }).unwrap();
        let (_, y2) = m.ground_to_image(Ground { lat: lat(1500.0), lon, h: 0.0 }).unwrap();
        assert!((y1 - 500.5).abs() < 1e-6, "{y1}");
        assert!((y2 - 1507.5).abs() < 1e-6, "{y2}");
        // image → ground inverts within a section.
        let g = m.image_to_ground(1000.5, 1507.5, 0.0).unwrap();
        assert!((g.lat - lat(1500.0)).abs() < 1e-9);
        assert!(m.name().contains("2 × 1 sections"));
        // Several sections without an index are refused.
        assert!(RsmModel::build(Domain::Geodetic, [0.0; 3], [[0.0; 3]; 3], (2000.0, 2000.0), (0.0, 0.0), None, Geometry::Poly(vec![lin_section(1, 1), lin_section(2, 1)]), None).is_err());
    }

    #[test]
    fn image_and_ground_terms_move_the_projection() {
        let mut m = RsmModel::build(Domain::Geodetic, [0.0; 3], [[0.0; 3]; 3], (2000.0, 2000.0), (0.0, 0.0), None, Geometry::Poly(vec![lin_section(1, 1)]), None).unwrap();
        m.adjustable = Some(ParamSet { frame: Frame::Domain, norm_off: [0.0; 3], norm_scale: [1.0; 3], terms: vec![Term::Row(0, 0, 0), Term::Col(0, 0, 0), Term::Ground(1)], values: vec![0.0; 3] });
        m.cov = Some(vec![4.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1e-12]);
        m.unmodelled = Some([0.25, 0.0, 0.09]);
        let g = Ground { lat: 34.0, lon: -114.0, h: 0.0 };
        let p0 = m.ground_to_image(g).unwrap();
        let p1 = m.with_params(&[2.0, -1.0, 0.0]).unwrap().ground_to_image(g).unwrap();
        assert!((p1.0 - p0.0 + 1.0).abs() < 1e-9 && (p1.1 - p0.1 - 2.0).abs() < 1e-9);
        // A latitude offset (domain y in radians) moves the row by −2e5 px per radian.
        let p2 = m.with_params(&[0.0, 0.0, 1e-5]).unwrap().ground_to_image(g).unwrap();
        assert!((p2.1 - p0.1 + 2.0).abs() < 1e-6, "{}", p2.1 - p0.1);
        let j = m.param_partials(g).unwrap();
        assert!((j[0][1] - 1.0).abs() < 1e-12 && (j[1][0] - 1.0).abs() < 1e-12 && (j[2][1] + 2e5).abs() < 1e-2);
        let c = crate::image_covariance(&m, p0.0, p0.1, 0.0).unwrap().unwrap();
        // σxx = 1 (col) + 0.09 (UCC); σyy = 4 (row) + (2e5)²·1e-12 + 0.25 (URR).
        assert!((c[0] - 1.09).abs() < 1e-6 && (c[2] - 4.29).abs() < 1e-6, "{c:?}");
    }
}
