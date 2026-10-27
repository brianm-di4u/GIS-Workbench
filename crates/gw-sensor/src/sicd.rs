//! SICD Volume 3 monostatic image projections (REQ-SAR-05, `Research/09` §9).
//!
//! A port of SARkit 1.12.0 `sarkit/sicd/projection/_calc.py` (MIT licence, © 2024 Valkyrie
//! Systems Corporation; notice in the build's licence block). Function names and step order
//! follow SARkit so that later SICD versions can be diffed against the source:
//! `compute_projection_sets`, `apply_apos`, `r_rdot_to_ground_plane_mono`,
//! `r_rdot_to_constant_hae_surface`, `scene_to_image` and `r_rdot_to_dem_surface` (every
//! crossing, linearly interpolated, ordered by increasing HAE — Volume 3 1.5).
//!
//! Grid types: PLANE, XRGYCR, XCTYAT (image-plane point), RGAZIM with PFA or RGAZCOMP, RGZERO
//! (RMA/INCA). Bistatic collects are refused with a message. The model record is built by the
//! `parse` bundle from the SICD XML (`gw_parse::sicd::record`) and passed here as flat f64.

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};
use gw_geodesy::wgs84::{ecef_to_geodetic, geodetic_to_ecef};

const C: f64 = 299_792_458.0;

type V3 = [f64; 3];

fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn mul(a: V3, k: f64) -> V3 {
    [a[0] * k, a[1] * k, a[2] * k]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn unit(a: V3) -> V3 {
    mul(a, 1.0 / norm(a))
}

/// 1-D power series, lowest order first.
fn polyval(c: &[f64], x: f64) -> f64 {
    c.iter().rev().fold(0.0, |s, &k| s * x + k)
}
fn polyder(c: &[f64]) -> Vec<f64> {
    c.iter().enumerate().skip(1).map(|(i, &k)| i as f64 * k).collect()
}

/// 2-D power series: `c[i * n2 + j]` multiplies x^i y^j.
#[derive(Clone, Debug, Default)]
pub struct Poly2 {
    pub n1: usize,
    pub n2: usize,
    pub c: Vec<f64>,
}
impl Poly2 {
    pub fn eval(&self, x: f64, y: f64) -> f64 {
        let mut s = 0.0;
        let mut xi = 1.0;
        for i in 0..self.n1 {
            let mut yj = 1.0;
            for j in 0..self.n2 {
                s += self.c[i * self.n2 + j] * xi * yj;
                yj *= y;
            }
            xi *= x;
        }
        s
    }
}

/// XYZ polynomial in time.
#[derive(Clone, Debug, Default)]
pub struct PolyXyz {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
}
impl PolyXyz {
    fn at(&self, t: f64) -> V3 {
        [polyval(&self.x, t), polyval(&self.y, t), polyval(&self.z, t)]
    }
    fn der(&self) -> PolyXyz {
        PolyXyz { x: polyder(&self.x), y: polyder(&self.y), z: polyder(&self.z) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Grid {
    Plane,
    Xrgycr,
    Xctyat,
    RgazimPfa,
    RgazimRgazcomp,
    Rgzero,
}

/// Adjustable parameter offsets (monostatic).
#[derive(Clone, Copy, Debug)]
pub struct Apo {
    pub d_arp: V3,
    pub d_varp: V3,
    pub d_tx: f64,
    pub d_tr: f64,
}

/// The IPDD metadata parameter list (monostatic subset).
#[derive(Clone, Debug)]
pub struct Params {
    pub grid: Grid,
    pub look: f64,
    pub scp: V3,
    pub scp_row: f64,
    pub scp_col: f64,
    pub first_row: f64,
    pub first_col: f64,
    pub num_rows: f64,
    pub num_cols: f64,
    pub row_ss: f64,
    pub col_ss: f64,
    pub u_row: V3,
    pub u_col: V3,
    pub t_scp_coa: f64,
    pub arp_scp_coa: V3,
    pub varp_scp_coa: V3,
    pub apo: Option<Apo>,
    pub az_sf: f64,
    pub r_ca_scp: f64,
    /// CompositeSCP σ (m) in range and azimuth of the image plane, and their correlation.
    pub err: Option<(f64, f64, f64)>,
    /// 0 slant, 1 ground, 2 other.
    pub image_plane: u8,
    pub graze_deg: f64,
    pub slope_deg: f64,
    pub ct_coa: Poly2,
    pub arp_poly: PolyXyz,
    pub c_pa: Vec<f64>,
    pub c_ksf: Vec<f64>,
    pub ct_ca: Vec<f64>,
    pub c_drsf: Poly2,
}

/// Record layout (see the module docs): fixed part of 44 values, then the polynomials.
pub const FIXED: usize = 44;

impl Params {
    pub fn from_record(a: &[f64]) -> Result<Params> {
        if a.len() < FIXED + 4 || a[0] != 1.0 {
            return Err(Error::invalid("sicd: bad model record"));
        }
        let v3 = |i: usize| [a[i], a[i + 1], a[i + 2]];
        let grid = match a[1] as i32 {
            0 => Grid::Plane,
            1 => Grid::Xrgycr,
            2 => Grid::Xctyat,
            3 => Grid::RgazimPfa,
            4 => Grid::RgazimRgazcomp,
            5 => Grid::Rgzero,
            _ => return Err(Error::unsupported("sicd: grid type / image formation not supported")),
        };
        let mut o = FIXED;
        let mut take = |n: usize| -> Result<Vec<f64>> {
            let s = a.get(o..o + n).ok_or_else(|| Error::invalid("sicd: truncated polynomial"))?.to_vec();
            o += n;
            Ok(s)
        };
        let p2 = |take: &mut dyn FnMut(usize) -> Result<Vec<f64>>| -> Result<Poly2> {
            let h = take(2)?;
            let (n1, n2) = (h[0] as usize, h[1] as usize);
            if n1 > 32 || n2 > 32 {
                return Err(Error::invalid("sicd: polynomial order too high"));
            }
            Ok(Poly2 { n1, n2, c: take(n1 * n2)? })
        };
        let ct_coa = p2(&mut take)?;
        let n = take(1)?[0] as usize;
        if n > 32 {
            return Err(Error::invalid("sicd: ARPPoly order too high"));
        }
        let arp_poly = PolyXyz { x: take(n)?, y: take(n)?, z: take(n)? };
        let p1 = |take: &mut dyn FnMut(usize) -> Result<Vec<f64>>| -> Result<Vec<f64>> {
            let n = take(1)?[0] as usize;
            if n > 32 {
                return Err(Error::invalid("sicd: polynomial order too high"));
            }
            take(n)
        };
        let c_pa = p1(&mut take)?;
        let c_ksf = p1(&mut take)?;
        let ct_ca = p1(&mut take)?;
        let c_drsf = p2(&mut take)?;
        let p = Params {
            grid,
            look: if a[2] > 0.0 { 1.0 } else { -1.0 },
            scp: v3(3),
            scp_row: a[6],
            scp_col: a[7],
            first_row: a[8],
            first_col: a[9],
            num_rows: a[10],
            num_cols: a[11],
            row_ss: a[12],
            col_ss: a[13],
            u_row: v3(14),
            u_col: v3(17),
            t_scp_coa: a[20],
            arp_scp_coa: v3(21),
            varp_scp_coa: v3(24),
            apo: if a[27] != 0.0 { Some(Apo { d_arp: v3(28), d_varp: v3(31), d_tx: a[34], d_tr: a[35] }) } else { None },
            az_sf: a[36],
            r_ca_scp: a[37],
            err: if a[38].is_finite() && a[39].is_finite() { Some((a[38], a[39], if a[40].is_finite() { a[40] } else { 0.0 })) } else { None },
            image_plane: a[41] as u8,
            graze_deg: a[42],
            slope_deg: a[43],
            ct_coa,
            arp_poly,
            c_pa,
            c_ksf,
            ct_ca,
            c_drsf,
        };
        if p.ct_coa.c.is_empty() || p.arp_poly.x.is_empty() || !(p.row_ss > 0.0) || !(p.col_ss > 0.0) {
            return Err(Error::invalid("sicd: TimeCOAPoly, ARPPoly and Grid SS are required"));
        }
        match p.grid {
            Grid::RgazimPfa if p.c_pa.is_empty() || p.c_ksf.is_empty() => return Err(Error::invalid("sicd: PFA needs PolarAngPoly and SpatialFreqSFPoly")),
            Grid::RgazimRgazcomp if !p.az_sf.is_finite() => return Err(Error::invalid("sicd: RGAZCOMP needs AzSF")),
            Grid::Rgzero if p.ct_ca.is_empty() || p.c_drsf.c.is_empty() || !p.r_ca_scp.is_finite() => return Err(Error::invalid("sicd: RGZERO needs INCA TimeCAPoly, R_CA_SCP and DRateSFPoly")),
            _ => {}
        }
        Ok(p)
    }
}

/// One COA projection set (monostatic).
#[derive(Clone, Copy, Debug)]
pub struct ProjSet {
    pub t: f64,
    pub arp: V3,
    pub varp: V3,
    pub r: f64,
    pub rdot: f64,
}

pub struct Sicd {
    pub p: Params,
    varp_poly: PolyXyz,
    name: String,
}

fn up_of(lat: f64, lon: f64) -> V3 {
    let (la, lo) = (lat.to_radians(), lon.to_radians());
    [la.cos() * lo.cos(), la.cos() * lo.sin(), la.sin()]
}

fn llh(p: V3) -> (f64, f64, f64) {
    ecef_to_geodetic(p[0], p[1], p[2])
}

impl Sicd {
    pub fn new(p: Params, name: &str) -> Sicd {
        let varp_poly = p.arp_poly.der();
        Sicd { p, varp_poly, name: name.to_string() }
    }

    /// Image grid location (xrow, ycol, metres) from a full-image (row, col).
    pub fn rowcol_to_grid(&self, row: f64, col: f64) -> (f64, f64) {
        ((row - self.p.scp_row) * self.p.row_ss, (col - self.p.scp_col) * self.p.col_ss)
    }

    /// Workbench image coordinates (corner origin, the file's chip) ↔ full-image (row, col).
    pub fn xy_to_rowcol(&self, x: f64, y: f64) -> (f64, f64) {
        (y - 0.5 + self.p.first_row, x - 0.5 + self.p.first_col)
    }
    pub fn rowcol_to_xy(&self, row: f64, col: f64) -> (f64, f64) {
        (col - self.p.first_col + 0.5, row - self.p.first_row + 0.5)
    }

    /// `compute_projection_sets` + `apply_apos`.
    pub fn projection_set(&self, xrow: f64, ycol: f64) -> ProjSet {
        let p = &self.p;
        let t = p.ct_coa.eval(xrow, ycol);
        let arp = p.arp_poly.at(t);
        let varp = self.varp_poly.at(t);
        let (r, rdot) = match p.grid {
            Grid::RgazimPfa => {
                let rv = sub(arp, p.scp);
                let r_scp = norm(rv);
                let rdot_scp = dot(varp, rv) / r_scp;
                let theta = polyval(&p.c_pa, t);
                let dtheta = polyval(&polyder(&p.c_pa), t);
                let ksf = polyval(&p.c_ksf, theta);
                let dksf = polyval(&polyder(&p.c_ksf), theta);
                let dphi_dka = xrow * theta.cos() + ycol * theta.sin();
                let dphi_dkc = -xrow * theta.sin() + ycol * theta.cos();
                (r_scp + ksf * dphi_dka, rdot_scp + (dksf * dphi_dka + ksf * dphi_dkc) * dtheta)
            }
            Grid::RgazimRgazcomp => {
                let rv = sub(arp, p.scp);
                let r_scp = norm(rv);
                let rdot_scp = dot(varp, rv) / r_scp;
                (r_scp + xrow, rdot_scp - norm(varp) * p.az_sf * ycol)
            }
            Grid::Rgzero => {
                let r_ca = p.r_ca_scp + xrow;
                let t_ca = polyval(&p.ct_ca, ycol);
                let v = norm(self.varp_poly.at(t_ca));
                let drsf = p.c_drsf.eval(xrow, ycol);
                let dt = t - t_ca;
                let r = (r_ca * r_ca + drsf * v * v * dt * dt).sqrt();
                (r, drsf / r * v * v * dt)
            }
            Grid::Plane | Grid::Xrgycr | Grid::Xctyat => {
                let ip = add(add(p.scp, mul(p.u_row, xrow)), mul(p.u_col, ycol));
                let d = sub(arp, ip);
                let r = norm(d);
                (r, dot(varp, mul(d, 1.0 / r)))
            }
        };
        let mut s = ProjSet { t, arp, varp, r, rdot };
        if let Some(a) = p.apo {
            s.arp = add(add(s.arp, a.d_arp), mul(a.d_varp, t - p.t_scp_coa));
            s.varp = add(s.varp, a.d_varp);
            s.r += C / 2.0 * (a.d_tr - a.d_tx);
        }
        s
    }

    /// `r_rdot_to_ground_plane_mono`: None when there is no solution.
    pub fn r_rdot_to_ground_plane(&self, s: &ProjSet, gref: V3, uz: V3) -> Option<V3> {
        let arpz = dot(sub(s.arp, gref), uz);
        if arpz.abs() > s.r {
            return None;
        }
        let agpn = sub(s.arp, mul(uz, arpz));
        let g = (s.r * s.r - arpz * arpz).sqrt();
        let cos_graz = g / s.r;
        let sin_graz = arpz / s.r;
        let vz = dot(s.varp, uz);
        let vx = (dot(s.varp, s.varp) - vz * vz).sqrt();
        if vx == 0.0 || !vx.is_finite() {
            return None;
        }
        let ux = mul(sub(s.varp, mul(uz, vz)), 1.0 / vx);
        let uy = cross(uz, ux);
        let cos_az = (-s.rdot + vz * sin_graz) / (vx * cos_graz);
        if !(-1.0..=1.0).contains(&cos_az) {
            return None;
        }
        let sin_az = self.p.look * (1.0 - cos_az * cos_az).sqrt();
        Some(add(add(agpn, mul(ux, g * cos_az)), mul(uy, g * sin_az)))
    }

    /// `r_rdot_to_constant_hae_surface` (Δh_max 1 m, n_lim 3) → (point, Δh, converged).
    pub fn r_rdot_to_constant_hae(&self, s: &ProjSet, hae0: f64) -> Option<(V3, f64, bool)> {
        let (slat, slon, shae) = llh(self.p.scp);
        let mut u_gpn = up_of(slat, slon);
        let mut gref = add(self.p.scp, mul(u_gpn, hae0 - shae));
        let mut gpp = [f64::NAN; 3];
        let mut u_up = u_gpn;
        let mut dh = f64::NAN;
        let mut ok = false;
        for _ in 0..3 {
            gpp = self.r_rdot_to_ground_plane(s, gref, u_gpn)?;
            let (la, lo, h) = llh(gpp);
            u_up = up_of(la, lo);
            dh = h - hae0;
            if dh <= 1.0 {
                ok = true;
                break;
            }
            gref = sub(gpp, mul(u_up, dh));
            u_gpn = u_up;
        }
        let spn = mul(cross(s.varp, sub(gpp, s.arp)), self.p.look);
        let u_spn = unit(spn);
        let sf = dot(u_up, u_spn);
        let slp = sub(gpp, mul(u_spn, dh / sf));
        let (la, lo, _) = llh(slp);
        let e = geodetic_to_ecef(la, lo, hae0);
        Some((e, dh, ok))
    }

    /// The SCP COA slant plane unit normal.
    fn scp_spn(&self) -> V3 {
        unit(mul(cross(sub(self.p.arp_scp_coa, self.p.scp), self.p.varp_scp_coa), self.p.look))
    }

    /// Image plane point → image grid (xrow, ycol).
    fn ip_to_grid(&self, ip: V3) -> (f64, f64) {
        let (ur, uc) = (self.p.u_row, self.p.u_col);
        let ct = dot(ur, uc);
        let st2 = 1.0 - ct * ct;
        let d = sub(ip, self.p.scp);
        let (a, b) = (dot(d, ur), dot(d, uc));
        ((a - ct * b) / st2, (-ct * a + b) / st2)
    }

    /// `scene_to_image` (Δgp 0.001 m, 10 iterations) → (xrow, ycol, Δgp, converged).
    pub fn scene_to_image(&self, s: V3) -> (f64, f64, f64, bool) {
        let u_gpn = unit(s);
        let u_proj = self.scp_spn();
        let u_ipn = unit(cross(self.p.u_row, self.p.u_col));
        let sf = dot(u_proj, u_ipn);
        let mut g = s;
        let (mut xr, mut yc, mut dgp) = (f64::NAN, f64::NAN, f64::NAN);
        for _ in 0..10 {
            let dist = dot(sub(self.p.scp, g), u_ipn) / sf;
            let i = add(g, mul(u_proj, dist));
            let (a, b) = self.ip_to_grid(i);
            xr = a;
            yc = b;
            let ps = self.projection_set(xr, yc);
            let Some(p) = self.r_rdot_to_ground_plane(&ps, s, u_gpn) else {
                return (f64::NAN, f64::NAN, f64::NAN, false);
            };
            let dp = sub(s, p);
            dgp = norm(dp);
            if dgp <= 0.001 {
                return (xr, yc, dgp, true);
            }
            g = add(g, dp);
        }
        (xr, yc, dgp, false)
    }

    /// `r_rdot_to_dem_surface` (monostatic): every point where the R/Rdot contour crosses the
    /// surface, ordered by increasing HAE. `dh(p)` = HAE(p) − DEM HAE below p (NaN outside).
    pub fn r_rdot_to_dem(&self, s: &ProjSet, dh: &dyn Fn(V3) -> f64, hae_min: f64, hae_max: f64, delta_dist_dem: f64) -> Vec<V3> {
        let delta_dist_rrc = 10.0;
        let look = self.p.look;
        let vmag = norm(s.varp);
        let u_vel = mul(s.varp, 1.0 / vmag);
        let cos_dca = -s.rdot / vmag;
        let sin_dca = (1.0 - cos_dca * cos_dca).sqrt();
        let ctr = add(s.arp, mul(u_vel, s.r * cos_dca));
        let r_rrc = s.r * sin_dca;
        let u_up = unit(s.arp);
        let u_rry = unit(cross(u_up, u_vel));
        let u_rrx = cross(u_rry, u_vel);
        let Some((a, _, true)) = self.r_rdot_to_constant_hae(s, hae_max) else {
            return Vec::new();
        };
        let cos_ca_a = dot(sub(a, ctr), u_rrx) / r_rrc;
        let Some((b, _, true)) = self.r_rdot_to_constant_hae(s, hae_min) else {
            return Vec::new();
        };
        let cos_ca_b = dot(sub(b, ctr), u_rrx) / r_rrc;
        let sin_ca_b = look * (1.0 - cos_ca_b * cos_ca_b).sqrt();
        let delta_cos_rrc = delta_dist_rrc * sin_ca_b.abs() / r_rrc;
        let delta_cos_dem = delta_dist_dem * sin_ca_b.abs() / r_rrc / cos_ca_b.max(0.01);
        let delta_cos_ca = -delta_cos_rrc.min(delta_cos_dem);
        let npts = ((cos_ca_a - cos_ca_b) / delta_cos_ca).floor() + 2.0;
        if !(npts.is_finite() && npts >= 2.0 && npts < 2e6) {
            return Vec::new();
        }
        let n = npts as usize;
        let pn: Vec<V3> = (0..n)
            .map(|k| {
                let cos_ca = cos_ca_b + k as f64 * delta_cos_ca;
                let sin_ca = look * (1.0 - cos_ca * cos_ca).sqrt();
                add(ctr, add(mul(u_rrx, r_rrc * cos_ca), mul(u_rry, r_rrc * sin_ca)))
            })
            .collect();
        let d: Vec<f64> = pn.iter().map(|p| dh(*p)).collect();
        let mut out = Vec::new();
        for k in 0..n.saturating_sub(1) {
            let (h0, h1) = (d[k], d[k + 1]);
            if h0 == 0.0 {
                out.push(pn[k]);
            }
            if h0.is_finite() && h1.is_finite() && h0.signum() * h1.signum() == -1.0 && h0 != 0.0 && h1 != 0.0 {
                let f = h0 / (h0 - h1);
                out.push(add(mul(pn[k], 1.0 - f), mul(pn[k + 1], f)));
            }
        }
        out
    }

    /// Ground-plane resolution-cell σ per axis from CompositeSCP (metres), if present.
    fn sigma_ground(&self) -> Option<(f64, f64)> {
        let (rg, az, _) = self.p.err?;
        // A slant-plane range σ maps to the ground through 1/cos(graze).
        let k = if self.p.image_plane == 0 && self.p.graze_deg.is_finite() { 1.0 / self.p.graze_deg.to_radians().cos() } else { 1.0 };
        Some((rg * k, az))
    }
}

impl SensorModel for Sicd {
    fn name(&self) -> &str {
        &self.name
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let s = geodetic_to_ecef(g.lat, g.lon, g.h);
        let (xr, yc, _, ok) = self.scene_to_image(s);
        if !ok || !xr.is_finite() {
            return Err(Error::range("sicd: scene to image did not converge"));
        }
        let row = xr / self.p.row_ss + self.p.scp_row;
        let col = yc / self.p.col_ss + self.p.scp_col;
        Ok(self.rowcol_to_xy(row, col))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let (row, col) = self.xy_to_rowcol(x, y);
        let (xr, yc) = self.rowcol_to_grid(row, col);
        let s = self.projection_set(xr, yc);
        let (e, _, _) = self.r_rdot_to_constant_hae(&s, h).ok_or_else(|| Error::range("sicd: the R/Rdot contour does not meet the surface"))?;
        let (lat, lon, hh) = llh(e);
        Ok(Ground { lat, lon, h: hh })
    }
    fn height_range(&self) -> (f64, f64) {
        (-1000.0, 9000.0)
    }
    fn horizontal_sigma(&self) -> Option<f64> {
        self.sigma_ground().map(|(a, b)| ((a * a + b * b) / 2.0).sqrt())
    }
    fn horizontal_sigma_parts(&self) -> Option<(f64, f64)> {
        // CompositeSCP is a whole-image (bias) error.
        self.horizontal_sigma().map(|s| (s, 0.0))
    }
    fn surface_crossings(&self, x: f64, y: f64, dem_hae: &dyn Fn(f64, f64) -> f64, hae_min: f64, hae_max: f64, post_m: f64) -> Option<Result<Vec<Ground>>> {
        let (row, col) = self.xy_to_rowcol(x, y);
        let (xr, yc) = self.rowcol_to_grid(row, col);
        let s = self.projection_set(xr, yc);
        let dh = |p: V3| {
            let (la, lo, h) = llh(p);
            h - dem_hae(la, lo)
        };
        let pts = self.r_rdot_to_dem(&s, &dh, hae_min, hae_max, post_m);
        if pts.is_empty() {
            return Some(Err(Error::range("the R/Rdot contour does not meet the DEM between its lowest and highest heights")));
        }
        Some(Ok(pts
            .into_iter()
            .map(|p| {
                let (lat, lon, h) = llh(p);
                Ground { lat, lon, h }
            })
            .collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poly2_eval_matches_power_series() {
        let p = Poly2 { n1: 2, n2: 3, c: vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0] };
        let (x, y) = (0.5, -2.0);
        let want = 1.0 + 2.0 * y + 3.0 * y * y + x * (4.0 + 5.0 * y + 6.0 * y * y);
        assert!((p.eval(x, y) - want).abs() < 1e-12);
    }
}
