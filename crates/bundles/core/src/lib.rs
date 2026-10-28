//! `core` bundle (eager; main thread and every worker): geodesy and the sensor point API.
//! Every export is a plain C ABI function over numbers and linear-memory buffers
//! (Appendix D §3.1). Small results return directly; variable-length ones go to the output
//! buffer (`gw_out_ptr`/`gw_out_len`); errors set `gw_last_error`.

use gw_abi::{set_out, set_out_json, slice, slice_mut, status, Error, Json, Result};
use gw_geodesy::{coords, geodesic, geoid::Geoid, grids, stats, time, wgs84};
use gw_sensor::error::mono_point_error;
use gw_sensor::gcp::{Gcp, PolyModel, ProjectiveModel};
use gw_sensor::geotransform::{GeoTransformModel, MapCrs};
use gw_sensor::rpc::Rpc;
use gw_sensor::terrain::{ray_dem, DemGrid};
use gw_sensor::{Ground, SensorModel};
use gw_sensor::adjusted::{Adjusted, ImageBias};
use gw_sensor::intersect::{intersect, observation_sigma, Observation};
use std::cell::RefCell;
use std::rc::Rc;

gw_abi::export_abi!();

thread_local! {
    static MODELS: RefCell<Vec<Option<Rc<dyn SensorModel>>>> = const { RefCell::new(Vec::new()) };
    /// SICD models by id, for the SAR-only projection helpers (REQ-SAR-05).
    static SICDS: RefCell<std::collections::HashMap<i32, std::rc::Weak<gw_sensor::sicd::Sicd>>> = RefCell::new(std::collections::HashMap::new());
    static GEOID: RefCell<Option<Geoid>> = const { RefCell::new(None) };
    static DEMS: RefCell<Vec<Option<DemGrid>>> = const { RefCell::new(Vec::new()) };
}

fn str_in(ptr: *const u8, len: usize) -> Result<String> {
    let b = unsafe { slice(ptr, len) };
    std::str::from_utf8(b).map(|s| s.to_string()).map_err(|_| Error::invalid("input is not UTF-8"))
}

fn out_str(s: String) -> i32 {
    set_out(s.into_bytes());
    gw_abi::OK
}

// ---- grids and coordinates ---------------------------------------------------------------

/// MGRS of a point with `prec` digits per coordinate (truncated).
#[no_mangle]
pub extern "C" fn gw_mgrs_forward(lat: f64, lon: f64, prec: i32) -> i32 {
    match grids::mgrs_forward(lat, lon, prec.clamp(0, 6) as usize) {
        Ok(s) => out_str(s),
        Err(e) => status::<()>(Err(e)),
    }
}

/// MGRS → out f64[4]: lat, lon (cell centre), cell size m, digits per coordinate.
/// # Safety
/// `ptr`/`len` must be a readable UTF-8 buffer and `out` must hold 4 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_mgrs_reverse(ptr: *const u8, len: usize, out: *mut f64) -> i32 {
    status((|| {
        let (lat, lon, cell, prec) = grids::mgrs_to_latlon(&str_in(ptr, len)?)?;
        slice_mut(out, 4).copy_from_slice(&[lat, lon, cell, prec as f64]);
        Ok(())
    })())
}

/// Parse any coordinate text → JSON {lat, lon, precisionM, format, notice}.
/// # Safety
/// `ptr`/`len` must be a readable buffer.
#[no_mangle]
pub unsafe extern "C" fn gw_coord_parse(ptr: *const u8, len: usize, lon_first: i32) -> i32 {
    status((|| {
        let p = coords::parse(&str_in(ptr, len)?, lon_first != 0)?;
        let mut j = Json::new();
        j.obj().kv_num("lat", p.lat).kv_num("lon", p.lon).kv_num("precisionM", p.precision_m).kv_str("format", p.format).kv_str("notice", &p.notice).end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// Format a point. fmt: 0 DD, 1 DMS, 2 DDM, 3 MGRS, 4 UTM, 5 USNG, 6 GARS, 7 GEOREF.
#[no_mangle]
pub extern "C" fn gw_coord_format(lat: f64, lon: f64, fmt: i32, prec: i32) -> i32 {
    let p = prec.max(0) as usize;
    let r = match fmt {
        0 => Ok(coords::format_dd(lat, lon, p)),
        1 => Ok(coords::format_dms(lat, lon, p)),
        2 => Ok(coords::format_ddm(lat, lon, p)),
        3 => grids::mgrs_forward(lat, lon, p.min(6)),
        4 => coords::format_utm(lat, lon, p),
        5 => grids::usng_forward(lat, lon, p.min(6)),
        6 => grids::gars_forward(lat, lon, p.min(2) as u8),
        7 => grids::georef_forward(lat, lon, prec.clamp(-1, 11)),
        _ => Err(Error::invalid("unknown coordinate format")),
    };
    match r {
        Ok(s) => out_str(s),
        Err(e) => status::<()>(Err(e)),
    }
}

/// UTM/UPS → out f64[6]: zone (0 = UPS), north (1/0), easting, northing, γ, k.
/// # Safety
/// `out` must hold 6 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_utm_forward(lat: f64, lon: f64, zone: i32, out: *mut f64) -> i32 {
    status((|| {
        let u = grids::utmups_forward(lat, lon, if zone < 0 { None } else { Some(zone) })?;
        slice_mut(out, 6).copy_from_slice(&[u.zone as f64, if u.northp { 1.0 } else { 0.0 }, u.easting, u.northing, u.gamma, u.k]);
        Ok(())
    })())
}

/// # Safety
/// `out` must hold 4 f64 (lat, lon, γ, k).
#[no_mangle]
pub unsafe extern "C" fn gw_utm_reverse(zone: i32, north: i32, e: f64, n: f64, out: *mut f64) -> i32 {
    status((|| {
        let (lat, lon, g, k) = grids::utmups_reverse(zone, north != 0, e, n)?;
        slice_mut(out, 4).copy_from_slice(&[lat, lon, g, k]);
        Ok(())
    })())
}

// ---- geodesics, ECEF, statistics --------------------------------------------------------

/// # Safety
/// `out` must hold 3 f64: distance m, azimuth 1, azimuth 2.
#[no_mangle]
pub unsafe extern "C" fn gw_geodesic_inverse(lat1: f64, lon1: f64, lat2: f64, lon2: f64, out: *mut f64) {
    let (s, a1, a2) = geodesic::inverse(lat1, lon1, lat2, lon2);
    slice_mut(out, 3).copy_from_slice(&[s, a1, a2]);
}

/// # Safety
/// `out` must hold 3 f64: lat2, lon2, azimuth 2.
#[no_mangle]
pub unsafe extern "C" fn gw_geodesic_direct(lat1: f64, lon1: f64, azi1: f64, s12: f64, out: *mut f64) {
    let (a, b, c) = geodesic::direct(lat1, lon1, azi1, s12);
    slice_mut(out, 3).copy_from_slice(&[a, b, c]);
}

/// Polygon area/perimeter over interleaved lat,lon pairs. out f64[2]: area m², perimeter m.
/// # Safety
/// `pts` holds 2n f64, `out` 2 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_polygon_area(pts: *const f64, n: usize, out: *mut f64) {
    let p = slice(pts, 2 * n);
    let lats: Vec<f64> = p.iter().step_by(2).copied().collect();
    let lons: Vec<f64> = p.iter().skip(1).step_by(2).copied().collect();
    let (a, per) = geodesic::polygon_area(&lats, &lons);
    slice_mut(out, 2).copy_from_slice(&[a, per]);
}

/// # Safety
/// `pts` holds 2n f64 (lat, lon pairs).
#[no_mangle]
pub unsafe extern "C" fn gw_polyline_length(pts: *const f64, n: usize) -> f64 {
    let p = slice(pts, 2 * n);
    let lats: Vec<f64> = p.iter().step_by(2).copied().collect();
    let lons: Vec<f64> = p.iter().skip(1).step_by(2).copied().collect();
    geodesic::polyline_length(&lats, &lons)
}

/// # Safety
/// `out` must hold 3 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_geodetic_to_ecef(lat: f64, lon: f64, h: f64, out: *mut f64) {
    slice_mut(out, 3).copy_from_slice(&wgs84::geodetic_to_ecef(lat, lon, h));
}

/// # Safety
/// `out` must hold 3 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_ecef_to_geodetic(x: f64, y: f64, z: f64, out: *mut f64) {
    let (a, b, c) = wgs84::ecef_to_geodetic(x, y, z);
    slice_mut(out, 3).copy_from_slice(&[a, b, c]);
}

/// # Safety
/// `out` must hold 3 f64: e, n, u.
#[no_mangle]
pub unsafe extern "C" fn gw_geodetic_to_enu(lat: f64, lon: f64, h: f64, lat0: f64, lon0: f64, h0: f64, out: *mut f64) {
    slice_mut(out, 3).copy_from_slice(&wgs84::geodetic_to_enu(lat, lon, h, lat0, lon0, h0));
}

/// # Safety
/// `out` must hold 3 f64: slant range, elevation at A, depression from B.
#[no_mangle]
pub unsafe extern "C" fn gw_slant_geometry(la: f64, oa: f64, ha: f64, lb: f64, ob: f64, hb: f64, out: *mut f64) {
    let (s, e, d) = wgs84::slant_geometry((la, oa, ha), (lb, ob, hb));
    slice_mut(out, 3).copy_from_slice(&[s, e, d]);
}

#[no_mangle]
pub extern "C" fn gw_curvature_drop(d: f64, k: f64) -> f64 {
    wgs84::curvature_drop(d, k)
}

#[no_mangle]
pub extern "C" fn gw_ce90(see: f64, sen: f64, snn: f64) -> f64 {
    stats::ce90(see, sen, snn)
}

#[no_mangle]
pub extern "C" fn gw_ce95(see: f64, sen: f64, snn: f64) -> f64 {
    stats::ce95(see, sen, snn)
}

#[no_mangle]
pub extern "C" fn gw_le90(sigma_v: f64) -> f64 {
    stats::le90(sigma_v)
}

/// # Safety
/// `c` holds 9 f64 (row-major 3×3 covariance).
#[no_mangle]
pub unsafe extern "C" fn gw_se90(c: *const f64) -> f64 {
    let m = slice(c, 9);
    stats::se90([[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]])
}

/// Error ellipse → out f64[3]: σmax, σmin, azimuth of the major axis.
/// # Safety
/// `out` must hold 3 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_error_ellipse(see: f64, sen: f64, snn: f64, out: *mut f64) {
    let e = stats::ellipse(see, sen, snn);
    slice_mut(out, 3).copy_from_slice(&[e.sigma_max, e.sigma_min, e.azimuth]);
}

/// # Safety
/// `out` must hold 2 f64: azimuth, elevation.
#[no_mangle]
pub unsafe extern "C" fn gw_sun_position(unix_utc: f64, lat: f64, lon: f64, out: *mut f64) {
    let (a, e) = time::sun_position(unix_utc, lat, lon);
    slice_mut(out, 2).copy_from_slice(&[a, e]);
}

#[no_mangle]
pub extern "C" fn gw_gps_to_unix_utc(gps: f64) -> f64 {
    time::gps_to_unix_utc(gps)
}

// ---- geoid -------------------------------------------------------------------------------

/// Load a geoid. kind 0: embedded predictor planes (width, height given); 1: PGM pack.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_geoid_load(ptr: *const u8, len: usize, kind: i32, width: usize, height: usize, name_ptr: *const u8, name_len: usize) -> i32 {
    status((|| {
        let b = slice(ptr, len);
        let name = str_in(name_ptr, name_len)?;
        let g = if kind == 0 { Geoid::from_predicted_planes(&name, width, height, b)? } else { Geoid::from_pgm(&name, b)? };
        GEOID.with(|x| *x.borrow_mut() = Some(g));
        Ok(())
    })())
}

/// Geoid undulation N (m), NaN when no geoid is loaded.
#[no_mangle]
pub extern "C" fn gw_geoid_undulation(lat: f64, lon: f64) -> f64 {
    GEOID.with(|g| g.borrow().as_ref().map_or(f64::NAN, |g| g.undulation(lat, lon)))
}

// ---- sensor models -----------------------------------------------------------------------

fn register(m: Box<dyn SensorModel>) -> i32 {
    register_rc(Rc::from(m))
}

fn register_rc(m: Rc<dyn SensorModel>) -> i32 {
    MODELS.with(|ms| {
        let mut ms = ms.borrow_mut();
        if let Some(i) = ms.iter().position(|x| x.is_none()) {
            ms[i] = Some(m);
            i as i32 + 1
        } else {
            ms.push(Some(m));
            ms.len() as i32
        }
    })
}

fn with_model<T>(id: i32, f: impl FnOnce(&dyn SensorModel) -> Result<T>) -> Result<T> {
    MODELS.with(|ms| {
        let ms = ms.borrow();
        let m = ms.get((id - 1) as usize).and_then(|m| m.as_ref()).ok_or_else(|| Error::invalid("unknown model id"))?;
        f(&**m)
    })
}

fn model_rc(id: i32) -> Result<Rc<dyn SensorModel>> {
    MODELS.with(|ms| {
        let ms = ms.borrow();
        let m = ms.get((id - 1) as usize).and_then(|m| m.as_ref()).ok_or_else(|| Error::invalid("unknown model id"))?;
        Ok(m.clone())
    })
}

/// RPC from the flat record (gw-sensor `RPC_RECORD_LEN` f64). Returns a model id > 0, or −status.
/// # Safety
/// `rec` must hold `n` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_model_rpc(rec: *const f64, n: usize) -> i32 {
    match Rpc::from_record(slice(rec, n)) {
        Ok(m) => register(Box::new(m)),
        Err(e) => -status::<()>(Err(e)),
    }
}

/// Geotransform model; epsg selects the CRS (4326, 326zz/327zz, 5041/5042, 3857).
/// # Safety
/// `gt` must hold 6 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_model_geotransform(gt: *const f64, epsg: i32) -> i32 {
    let g = slice(gt, 6);
    let r = (|| {
        let crs = MapCrs::from_epsg(epsg).ok_or_else(|| Error::unsupported(format!("EPSG:{epsg} is not built in")))?;
        GeoTransformModel::new([g[0], g[1], g[2], g[3], g[4], g[5]], crs)
    })();
    match r {
        Ok(m) => register(Box::new(m)),
        Err(e) => -status::<()>(Err(e)),
    }
}

/// GCP model: kind 1–3 polynomial order, 4 projective. `pts` = n × (x, y, lat, lon).
/// # Safety
/// `pts` must hold 4n f64; `name` is UTF-8.
#[no_mangle]
pub unsafe extern "C" fn gw_model_gcp(pts: *const f64, n: usize, kind: i32, name: *const u8, name_len: usize) -> i32 {
    let p = slice(pts, 4 * n);
    let gcps: Vec<Gcp> = p.chunks_exact(4).map(|c| Gcp { x: c[0], y: c[1], lat: c[2], lon: c[3] }).collect();
    let nm = str_in(name, name_len).unwrap_or_default();
    let r: Result<Box<dyn SensorModel>> = if kind == 4 {
        ProjectiveModel::fit(&gcps, if nm.is_empty() { "Projective (GCP)" } else { &nm }).map(|m| Box::new(m) as Box<dyn SensorModel>)
    } else {
        PolyModel::fit(&gcps, kind.clamp(1, 3) as usize).map(|m| Box::new(m) as Box<dyn SensorModel>)
    };
    match r {
        Ok(m) => register(m),
        Err(e) => -status::<()>(Err(e)),
    }
}

#[no_mangle]
pub extern "C" fn gw_model_free(id: i32) {
    MODELS.with(|ms| {
        if let Some(m) = ms.borrow_mut().get_mut((id - 1) as usize) {
            *m = None;
        }
    });
}

/// Model info JSON: name, 3-D flag, height range, horizontal σ.
#[no_mangle]
pub extern "C" fn gw_model_info(id: i32) -> i32 {
    status(with_model(id, |m| {
        let (h0, h1) = m.height_range();
        let mut j = Json::new();
        j.obj().kv_str("name", m.name()).kv_bool("is3d", m.is_3d()).kv_num("hmin", h0).kv_num("hmax", h1);
        match m.horizontal_sigma() {
            Some(s) => j.kv_num("sigmaH", s),
            None => j.key("sigmaH").null(),
        };
        j.end_obj();
        set_out_json(j.finish());
        Ok(())
    }))
}

/// Batch ground → image. `pts` = n × (lat, lon, h); `out` = n × (x, y) (NaN on failure).
/// # Safety
/// `pts` must hold 3n f64 and `out` 2n f64.
#[no_mangle]
pub unsafe extern "C" fn gw_g2i(id: i32, pts: *const f64, n: usize, out: *mut f64) -> i32 {
    let p = slice(pts, 3 * n);
    let o = slice_mut(out, 2 * n);
    status(with_model(id, |m| {
        for i in 0..n {
            let r = m.ground_to_image(Ground { lat: p[3 * i], lon: p[3 * i + 1], h: p[3 * i + 2] });
            let (x, y) = r.unwrap_or((f64::NAN, f64::NAN));
            o[2 * i] = x;
            o[2 * i + 1] = y;
        }
        Ok(())
    }))
}

/// Batch image → ground at given heights. `pts` = n × (x, y, h); `out` = n × (lat, lon).
/// # Safety
/// `pts` must hold 3n f64 and `out` 2n f64.
#[no_mangle]
pub unsafe extern "C" fn gw_i2g(id: i32, pts: *const f64, n: usize, out: *mut f64) -> i32 {
    let p = slice(pts, 3 * n);
    let o = slice_mut(out, 2 * n);
    status(with_model(id, |m| {
        for i in 0..n {
            let r = m.image_to_ground(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
            let (a, b) = r.map(|g| (g.lat, g.lon)).unwrap_or((f64::NAN, f64::NAN));
            o[2 * i] = a;
            o[2 * i + 1] = b;
        }
        Ok(())
    }))
}

/// Mono point error → JSON (covariance, CE90, LE90, components, GSD, tan off-nadir).
#[no_mangle]
pub extern "C" fn gw_point_error(id: i32, x: f64, y: f64, h: f64, sigma_pick_px: f64, sigma_dem_v: f64) -> i32 {
    status(with_model(id, |m| {
        let e = mono_point_error(m, x, y, h, sigma_pick_px, sigma_dem_v)?;
        let mut j = Json::new();
        j.obj();
        j.key("cov").arr().num(e.cov[0]).num(e.cov[1]).num(e.cov[2]).end_arr();
        j.kv_num("ce90", e.ce90).kv_num("le90", e.le90).kv_bool("modelErrorKnown", e.model_error_known);
        j.kv_num("sigmaModel", e.sigma_model).kv_num("sigmaPick", e.sigma_pick).kv_num("sigmaDemH", e.sigma_dem_h).kv_num("sigmaDemV", e.sigma_dem_v);
        j.kv_num("gsd", e.gsd).kv_num("tanOffNadir", e.tan_off_nadir).kv_num("sigmaBias", e.sigma_bias).kv_num("sigmaRand", e.sigma_rand);
        j.kv_str("ceMethod", "exact (numerical quadrature)");
        j.end_obj();
        set_out_json(j.finish());
        Ok(())
    }))
}

/// A model corrected by an image-space bias (REQ-SNS-11/15): `c` = [a0, a1, a2, b0, b1, b2]
/// (Δy then Δx, pixels) over normalised (u, v) = ((x − cx)/hx, (y − cy)/hy). The base model
/// stays registered and unchanged. `sigma` is the adjusted horizontal σ (m; NaN = the base's).
/// Returns a new model id > 0, or −status.
/// # Safety
/// `c` must hold 6 f64; `name` is UTF-8.
#[no_mangle]
pub unsafe extern "C" fn gw_model_adjusted(base: i32, c: *const f64, cx: f64, cy: f64, hx: f64, hy: f64, sigma: f64, name: *const u8, name_len: usize) -> i32 {
    let cc = slice(c, 6);
    let r = (|| {
        if !(hx > 0.0 && hy > 0.0) {
            return Err(Error::invalid("bias normalisation half-size must be > 0"));
        }
        let b = model_rc(base)?;
        let nm = str_in(name, name_len).unwrap_or_default();
        let name = if nm.is_empty() { format!("{} (adjusted)", b.name()) } else { nm };
        Ok(Adjusted { base: b, bias: ImageBias { c: [cc[0], cc[1], cc[2], cc[3], cc[4], cc[5]], centre: (cx, cy), half: (hx, hy) }, sigma: sigma.is_finite().then_some(sigma), name })
    })();
    match r {
        Ok(m) => register_rc(Rc::new(m)),
        Err(e) => -status::<()>(Err(e)),
    }
}

/// Multi-image point (REQ-MEN-11). `obs` = n × (model id, x, y, σ px); start (lat, lon, h)
/// or NaN. JSON {lat, lon, h, covEnu[9], residuals[[vx, vy]], sigma0, iterations,
/// minConvergenceDeg, maxConvergenceDeg, ce90, le90, ceMethod}.
/// # Safety
/// `obs` must hold 4n f64.
#[no_mangle]
pub unsafe extern "C" fn gw_intersect(obs: *const f64, n: usize, lat: f64, lon: f64, h: f64) -> i32 {
    let o = slice(obs, 4 * n);
    status((|| {
        let models: Vec<Rc<dyn SensorModel>> = o.chunks_exact(4).map(|c| model_rc(c[0] as i32)).collect::<Result<_>>()?;
        let ob: Vec<Observation<'_>> = o.chunks_exact(4).zip(&models).map(|(c, m)| Observation { model: &**m, x: c[1], y: c[2], sigma_px: c[3] }).collect();
        let start = (lat.is_finite() && lon.is_finite() && h.is_finite()).then_some(Ground { lat, lon, h });
        let r = intersect(&ob, start)?;
        let mut j = Json::new();
        j.obj().kv_num("lat", r.ground.lat).kv_num("lon", r.ground.lon).kv_num("h", r.ground.h).key("covEnu").arr();
        for row in r.cov_enu {
            for v in row {
                j.num(v);
            }
        }
        j.end_arr().key("residuals").arr();
        for (vx, vy) in &r.residuals {
            j.arr().num(*vx).num(*vy).end_arr();
        }
        j.end_arr();
        j.kv_num("sigma0", r.sigma0).kv_int("iterations", r.iterations as i64).kv_num("minConvergenceDeg", r.min_convergence_deg).kv_num("maxConvergenceDeg", r.max_convergence_deg);
        j.kv_num("ce90", r.ce90).kv_num("le90", r.le90).kv_str("ceMethod", "exact (numerical quadrature) from the 2 × 2 horizontal covariance").end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// Image-space σ (px) for a measurement: pick σ combined with the model's horizontal σ / GSD.
#[no_mangle]
pub extern "C" fn gw_observation_sigma(id: i32, x: f64, y: f64, h: f64, sigma_pick_px: f64) -> f64 {
    with_model(id, |m| observation_sigma(m, x, y, h, sigma_pick_px)).unwrap_or(f64::NAN)
}

// ---- DEMs and ray–DEM ---------------------------------------------------------------------

/// Register a DEM grid (heights f32 row-major from north). Returns id > 0 or −status.
/// # Safety
/// `h` must hold width·height f32.
#[no_mangle]
pub unsafe extern "C" fn gw_dem_load(lat0: f64, lon0: f64, dlat: f64, dlon: f64, width: usize, height: usize, h: *const f32, hae: i32, sigma_v: f64) -> i32 {
    let hv = slice(h, width * height).to_vec();
    match DemGrid::new(lat0, lon0, dlat, dlon, width, height, hv, hae != 0, sigma_v) {
        Ok(d) => DEMS.with(|ds| {
            let mut ds = ds.borrow_mut();
            ds.push(Some(d));
            ds.len() as i32
        }),
        Err(e) => -status::<()>(Err(e)),
    }
}

#[no_mangle]
pub extern "C" fn gw_dem_free(id: i32) {
    DEMS.with(|ds| {
        if let Some(d) = ds.borrow_mut().get_mut((id - 1) as usize) {
            *d = None;
        }
    });
}

fn dem_to_hae(d: &DemGrid, lat: f64, lon: f64, v: f64) -> f64 {
    if d.hae {
        v
    } else {
        let n = gw_geoid_undulation(lat, lon);
        if n.is_finite() {
            v + n
        } else {
            v
        }
    }
}

/// Lowest and highest posts of a DEM (HAE, approximately: the geoid at the grid centre).
fn dem_range(d: &DemGrid) -> (f64, f64) {
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for &v in &d.h {
        if v.is_finite() {
            lo = lo.min(v as f64);
            hi = hi.max(v as f64);
        }
    }
    let lat = d.lat0 - d.dlat * (d.height as f64) / 2.0;
    let lon = d.lon0 + d.dlon * (d.width as f64) / 2.0;
    (dem_to_hae(d, lat, lon, lo) - 30.0, dem_to_hae(d, lat, lon, hi) + 30.0)
}

/// DEM height (HAE) at a point, NaN outside or void.
#[no_mangle]
pub extern "C" fn gw_dem_sample_hae(id: i32, lat: f64, lon: f64) -> f64 {
    DEMS.with(|ds| {
        let ds = ds.borrow();
        match ds.get((id - 1) as usize).and_then(|d| d.as_ref()) {
            Some(d) => {
                let v = d.sample(lat, lon);
                if v.is_finite() {
                    dem_to_hae(d, lat, lon, v)
                } else {
                    f64::NAN
                }
            }
            None => f64::NAN,
        }
    })
}

/// Ray–DEM intersection → JSON {crossings: [[lat, lon, h], …], used: 0}.
#[no_mangle]
pub extern "C" fn gw_ray_dem(model: i32, dem: i32, x: f64, y: f64) -> i32 {
    status(with_model(model, |m| {
        DEMS.with(|ds| {
            let ds = ds.borrow();
            let d = ds.get((dem - 1) as usize).and_then(|d| d.as_ref()).ok_or_else(|| Error::invalid("unknown DEM id"))?;
            let to_hae = |lat: f64, lon: f64, v: f64| dem_to_hae(d, lat, lon, v);
            // A model-specific locus (SICD R/Rdot contour, lowest HAE first) or the generic ray.
            let surface = |lat: f64, lon: f64| {
                let v = d.sample(lat, lon);
                if v.is_finite() {
                    to_hae(lat, lon, v)
                } else {
                    f64::NAN
                }
            };
            let (lo, hi) = dem_range(d);
            let post = d.dlat.min(d.dlon) * 111_320.0;
            let (pts, rule): (Vec<gw_sensor::Ground>, &str) = match m.surface_crossings(x, y, &surface, lo - 10.0, hi + 10.0, post.max(1.0)) {
                Some(r) => (r?, "lowest HAE (R/Rdot contour, SICD Vol. 3)"),
                None => (ray_dem(m, x, y, d, &to_hae)?.into_iter().map(|c| c.ground).collect(), "first along the ray"),
            };
            let mut j = Json::new();
            j.obj().key("crossings").arr();
            for g in &pts {
                j.arr().num(g.lat).num(g.lon).num(g.h).end_arr();
            }
            j.end_arr().kv_int("used", 0).kv_str("rule", rule).kv_num("sigmaV", d.sigma_v).end_obj();
            set_out_json(j.finish());
            Ok(())
        })
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out_string() -> String {
        unsafe { String::from_utf8_lossy(slice(gw_abi::out_ptr(), gw_abi::out_len())).to_string() }
    }

    #[test]
    fn mgrs_round_trip_through_the_abi() {
        assert_eq!(gw_mgrs_forward(33.3, 44.4, 5), 0);
        let s = out_string();
        assert_eq!(s, "38SMB4414084706");
        let mut o = [0.0; 4];
        assert_eq!(unsafe { gw_mgrs_reverse(s.as_ptr(), s.len(), o.as_mut_ptr()) }, 0);
        assert!((o[0] - 33.3).abs() < 1e-5);
    }

    #[test]
    fn geotransform_model_through_the_abi() {
        let gt = [44.0, 0.001, 0.0, 34.0, 0.0, -0.001];
        let id = unsafe { gw_model_geotransform(gt.as_ptr(), 4326) };
        assert!(id > 0);
        let pts = [500.0, 700.0, 0.0];
        let mut o = [0.0; 2];
        assert_eq!(unsafe { gw_i2g(id, pts.as_ptr(), 1, o.as_mut_ptr()) }, 0);
        assert!((o[0] - 33.3).abs() < 1e-12 && (o[1] - 44.5).abs() < 1e-12);
        gw_model_free(id);
        assert_ne!(unsafe { gw_i2g(id, pts.as_ptr(), 1, o.as_mut_ptr()) }, 0);
    }

    #[test]
    fn bad_epsg_reports_error() {
        let gt = [0.0, 1.0, 0.0, 0.0, 0.0, -1.0];
        let id = unsafe { gw_model_geotransform(gt.as_ptr(), 27700) };
        assert_eq!(id, -gw_abi::UNSUPPORTED);
    }
}

// ---- extraction (REQ-EXT-05) -------------------------------------------------------------

/// Square a building ring. `pts` = n × (lon, lat, h). JSON {ring: [[lon, lat, h]…],
/// maxCornerErrorDeg, axisDeg, method} in the output buffer.
/// # Safety
/// `pts` must hold 3n f64.
#[no_mangle]
pub unsafe extern "C" fn gw_square_ring(pts: *const f64, n: usize, diagonals: i32) -> i32 {
    let p = slice(pts, 3 * n);
    status((|| {
        let ring: Vec<[f64; 3]> = p.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        let (out, sq) = gw_extract::square_geographic(&ring, diagonals != 0)?;
        let mut j = Json::new();
        j.obj().key("ring").arr();
        for v in &out {
            j.arr().num(v[0]).num(v[1]).num(v[2]).end_arr();
        }
        j.end_arr().kv_num("maxCornerErrorDeg", sq.max_corner_error_deg).kv_num("axisDeg", sq.axis_deg).kv_str("method", sq.method).end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// Medial axis of a ring (REQ-MEN-08). `pts` = n × (lon, lat, h); JSON {length, meanWidth,
/// maxWidth, minWidth, cellM, path: [[lon, lat]…]} in the output buffer.
/// # Safety
/// `pts` must hold 3n f64.
#[no_mangle]
pub unsafe extern "C" fn gw_medial_axis(pts: *const f64, n: usize, cells: i32) -> i32 {
    let p = slice(pts, 3 * n);
    status((|| {
        let ring: Vec<[f64; 3]> = p.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        let (m, path) = gw_extract::medial_geographic(&ring, cells.max(64) as usize)?;
        let mut j = Json::new();
        j.obj().kv_num("length", m.length).kv_num("meanWidth", m.mean_width).kv_num("maxWidth", m.max_width).kv_num("minWidth", m.min_width).kv_num("cellM", m.cell).key("path").arr();
        for q in path.iter().step_by((path.len() / 200).max(1)) {
            j.arr().num(q[0]).num(q[1]).end_arr();
        }
        j.end_arr().end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

fn camera_of(a: &[f64]) -> gw_sensor::frame::Camera {
    gw_sensor::frame::Camera { focal_mm: a[0], pixel_mm: a[1], cx: a[2], cy: a[3], k: [a[4], a[5], a[6]], p: [a[7], a[8]], width: a[9], height: a[10] }
}

/// Frame camera (REQ-SNS-04, REQ-SNS-14). `prm` = [focal mm, pixel mm, cx, cy, k1, k2, k3, p1, p2,
/// width, height, lat, lon, h, ω, φ, κ (degrees)].
/// # Safety
/// `prm` must hold `n` f64 and `name` `name_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn gw_model_frame(prm: *const f64, n: usize, name: *const u8, name_len: usize) -> i32 {
    let a = slice(prm, n);
    if a.len() != 17 {
        return -status::<()>(Err(Error::invalid("frame: 17 parameters expected")));
    }
    let nm = str_in(name, name_len).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "Frame camera".into());
    match gw_sensor::frame::FrameModel::new(camera_of(a), Ground { lat: a[11], lon: a[12], h: a[13] }, [a[14], a[15], a[16]], &nm) {
        Ok(m) => register(Box::new(m)),
        Err(e) => -status::<()>(Err(e)),
    }
}

/// Motion-imagery frame model from KLV (REQ-SNS-20). `prm` = [sensor lat, lon, HAE, platform
/// heading, pitch, roll, sensor relative azimuth, elevation, roll, HFOV (degrees), width, height].
/// # Safety
/// `prm` must hold `n` f64 and `name` `name_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn gw_model_klv(prm: *const f64, n: usize, name: *const u8, name_len: usize) -> i32 {
    let a = slice(prm, n);
    if a.len() != 12 {
        return -status::<()>(Err(Error::invalid("KLV frame: 12 parameters expected")));
    }
    let nm = str_in(name, name_len).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "KLV frame model".into());
    match gw_sensor::frame::FrameModel::from_klv(Ground { lat: a[0], lon: a[1], h: a[2] }, [a[3], a[4], a[5]], [a[6], a[7], a[8]], a[9], a[10], a[11], &nm) {
        Ok(m) => register(Box::new(m)),
        Err(e) => -status::<()>(Err(e)),
    }
}

/// Pushbroom (REQ-SNS-04). `prm` = [camera ×11, origin lat, lon, h, p0 ×3, v ×3, a ×3 (ENU m,
/// m/s, m/s²), ω, φ, κ, ω̇, φ̇, κ̇ (deg, deg/s), line time (s)].
/// # Safety
/// `prm` must hold `n` f64 and `name` `name_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn gw_model_pushbroom(prm: *const f64, n: usize, name: *const u8, name_len: usize) -> i32 {
    let a = slice(prm, n);
    if a.len() != 30 {
        return -status::<()>(Err(Error::invalid("pushbroom: 30 parameters expected")));
    }
    let nm = str_in(name, name_len).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "Pushbroom".into());
    let v3 = |i: usize| [a[i], a[i + 1], a[i + 2]];
    match gw_sensor::frame::PushbroomModel::new(camera_of(a), Ground { lat: a[11], lon: a[12], h: a[13] }, v3(14), v3(17), v3(20), v3(23), v3(26), a[29], &nm) {
        Ok(m) => register(Box::new(m)),
        Err(e) => -status::<()>(Err(e)),
    }
}

/// SICD Volume 3 projections (REQ-SAR-05). `prm` is the record from `gw_parse::sicd::record`
/// (see `gw_sensor::sicd`). Bistatic collects and unknown grids are refused.
/// # Safety
/// `prm` must hold `n` f64 and `name` `name_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn gw_model_sicd(prm: *const f64, n: usize, name: *const u8, name_len: usize) -> i32 {
    let a = slice(prm, n);
    let nm = str_in(name, name_len).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "SICD (Vol. 3)".into());
    match gw_sensor::sicd::Params::from_record(a) {
        Ok(p) => {
            let rc = Rc::new(gw_sensor::sicd::Sicd::new(p, &nm));
            let id = register_rc(rc.clone());
            SICDS.with(|ss| ss.borrow_mut().insert(id, Rc::downgrade(&rc)));
            id
        }
        Err(e) => -status::<()>(Err(e)),
    }
}

/// SICD projection helpers on a registered SICD model: `op` 0 = image → ground plane through
/// the SCP (ECF out), 1 = image → constant HAE (ECF out), 2 = scene ECF → image (x, y, Δgp).
/// `pts` = n × 3, `out` = n × 3.
/// # Safety
/// `pts` and `out` must hold 3n f64.
#[no_mangle]
pub unsafe extern "C" fn gw_sicd_project(id: i32, op: i32, pts: *const f64, n: usize, out: *mut f64) -> i32 {
    let p = slice(pts, 3 * n);
    let o = slice_mut(out, 3 * n);
    SICDS.with(|ss| {
        let ss = ss.borrow();
        let Some(Some(m)) = ss.get(&id).map(|m| m.upgrade()) else {
            return status::<()>(Err(Error::invalid("not a SICD model")));
        };
        for i in 0..n {
            let (a, b, c) = (p[3 * i], p[3 * i + 1], p[3 * i + 2]);
            let r: [f64; 3] = match op {
                0 | 1 => {
                    let (row, col) = m.xy_to_rowcol(a, b);
                    let (xr, yc) = m.rowcol_to_grid(row, col);
                    let s = m.projection_set(xr, yc);
                    if op == 0 {
                        let (la, lo, _) = gw_geodesy::wgs84::ecef_to_geodetic(m.p.scp[0], m.p.scp[1], m.p.scp[2]);
                        let (la, lo) = (la.to_radians(), lo.to_radians());
                        m.r_rdot_to_ground_plane(&s, m.p.scp, [la.cos() * lo.cos(), la.cos() * lo.sin(), la.sin()]).unwrap_or([f64::NAN; 3])
                    } else {
                        m.r_rdot_to_constant_hae(&s, c).map(|r| r.0).unwrap_or([f64::NAN; 3])
                    }
                }
                _ => {
                    let (xr, yc, dgp, ok) = m.scene_to_image([a, b, c]);
                    if ok {
                        let (x, y) = m.rowcol_to_xy(xr / m.p.row_ss + m.p.scp_row, yc / m.p.col_ss + m.p.scp_col);
                        [x, y, dgp]
                    } else {
                        [f64::NAN; 3]
                    }
                }
            };
            o[3 * i..3 * i + 3].copy_from_slice(&r);
        }
        0
    })
}

/// A registered model seen through a pixel offset: image (x, y) of the new model is (x + dx,
/// y + dy) of the base (products on a sub-window, REQ-MSI-08/11). Returns a new id or −status.
#[no_mangle]
pub extern "C" fn gw_model_offset(base: i32, dx: f64, dy: f64) -> i32 {
    gw_model_window(base, dx, dy, 1.0)
}

/// A model on a sub-window of the base model's image sampled every `step`-th pixel (TE-069):
/// pixel centre (x, y) is base pixel centre (dx + step·x − (step − 1)/2, …), so a product made
/// from every step-th source pixel (reduced-resolution analysis) keeps its geolocation.
#[no_mangle]
pub extern "C" fn gw_model_window(base: i32, dx: f64, dy: f64, step: f64) -> i32 {
    struct Window {
        base: Rc<dyn SensorModel>,
        dx: f64,
        dy: f64,
        step: f64,
        name: String,
    }
    impl Window {
        fn to_base(&self, x: f64, y: f64) -> (f64, f64) {
            let k = (self.step - 1.0) * 0.5;
            (self.dx + self.step * x - k, self.dy + self.step * y - k)
        }
    }
    impl SensorModel for Window {
        fn name(&self) -> &str {
            &self.name
        }
        fn ground_to_image(&self, g: gw_sensor::Ground) -> Result<(f64, f64)> {
            let (x, y) = self.base.ground_to_image(g)?;
            let k = (self.step - 1.0) * 0.5;
            Ok(((x - self.dx + k) / self.step, (y - self.dy + k) / self.step))
        }
        fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<gw_sensor::Ground> {
            let (bx, by) = self.to_base(x, y);
            self.base.image_to_ground(bx, by, h)
        }
        fn height_range(&self) -> (f64, f64) {
            self.base.height_range()
        }
        fn horizontal_sigma(&self) -> Option<f64> {
            self.base.horizontal_sigma()
        }
        fn horizontal_sigma_parts(&self) -> Option<(f64, f64)> {
            self.base.horizontal_sigma_parts()
        }
        fn is_3d(&self) -> bool {
            self.base.is_3d()
        }
        fn surface_crossings(&self, x: f64, y: f64, dem: &dyn Fn(f64, f64) -> f64, lo: f64, hi: f64, post: f64) -> Option<Result<Vec<gw_sensor::Ground>>> {
            let (bx, by) = self.to_base(x, y);
            self.base.surface_crossings(bx, by, dem, lo, hi, post)
        }
    }
    if !(step.is_finite() && step >= 1.0) {
        return -status::<()>(Err(Error::invalid("window model: step must be ≥ 1")));
    }
    match model_rc(base) {
        Ok(b) => {
            let name = if step == 1.0 { format!("{} (offset {dx}, {dy})", b.name()) } else { format!("{} (window {dx}, {dy}, every {step})", b.name()) };
            register_rc(Rc::new(Window { base: b, dx, dy, step, name }))
        }
        Err(e) => -status::<()>(Err(e)),
    }
}

/// RSM polynomial (REQ-SNS-03, experimental). `prm` = [domain (0 G, 1 H, 2 R), origin ×3,
/// axes ×9, offsets ×5 (row, col, x, y, z), scales ×5, rows, cols, then four polynomials (row
/// numerator, row denominator, column numerator, column denominator) each as [px, py, pz, terms,
/// coefficients…]].
/// # Safety
/// `prm` must hold `n` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_model_rsm(prm: *const f64, n: usize) -> i32 {
    let a = slice(prm, n);
    let r = (|| {
        if a.len() < 25 {
            return Err(Error::invalid("rsm: too few parameters"));
        }
        let domain = match a[0] as i32 {
            0 => gw_sensor::rsm::Domain::Geodetic,
            1 => gw_sensor::rsm::Domain::Geodetic2Pi,
            _ => gw_sensor::rsm::Domain::Rectangular,
        };
        let origin = [a[1], a[2], a[3]];
        let axes = [[a[4], a[5], a[6]], [a[7], a[8], a[9]], [a[10], a[11], a[12]]];
        let off = [a[13], a[14], a[15], a[16], a[17]];
        let scale = [a[18], a[19], a[20], a[21], a[22]];
        let size = (a[23], a[24]);
        let mut o = 25;
        let mut polys = Vec::with_capacity(4);
        for _ in 0..4 {
            let hd = a.get(o..o + 4).ok_or_else(|| Error::invalid("rsm: truncated polynomial"))?;
            let terms = hd[3] as usize;
            let c = a.get(o + 4..o + 4 + terms).ok_or_else(|| Error::invalid("rsm: truncated coefficients"))?.to_vec();
            polys.push(gw_sensor::rsm::Poly { px: hd[0] as usize, py: hd[1] as usize, pz: hd[2] as usize, c });
            o += 4 + terms;
        }
        let [p0, p1, p2, p3]: [gw_sensor::rsm::Poly; 4] = polys.try_into().map_err(|_| Error::invalid("rsm: four polynomials expected"))?;
        gw_sensor::rsm::RsmModel::new(domain, origin, axes, off, scale, [p0, p1, p2, p3], size)
    })();
    match r {
        Ok(m) => register(Box::new(m)),
        Err(e) => -status::<()>(Err(e)),
    }
}
