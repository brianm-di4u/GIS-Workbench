//! Grid-based transformations with PROJ 9.9's arithmetic (REQ-GAP-16):
//! `hgridshift` (`pj_hgrid_apply`: bilinear, inverse by fixed-point iteration),
//! `gridshift` (bilinear or NOAA biquadratic, 2D or 3D offsets; NADCON5) and `vgridshift`
//! (bilinear with nodata re-weighting). Coordinates are radians; heights metres.

use super::grid::{Grid, GridSet, REL_TOL};
use std::f64::consts::PI;

const MAX_ITERATIONS: i32 = 10;
const TOL: f64 = 1e-12;

/// PROJ `adjlon`.
pub fn adjlon(mut lon: f64) -> f64 {
    if lon.abs() < PI + 1e-12 {
        return lon;
    }
    lon += PI;
    lon -= 2.0 * PI * (lon / (2.0 * PI)).floor();
    lon - PI
}

fn ifloor(v: f64) -> i32 {
    if v.is_nan() {
        0
    } else {
        v.floor().clamp(i32::MIN as f64, i32::MAX as f64) as i32
    }
}

/// Which grid served a point (for the "transform used" note).
pub struct Used<'a> {
    pub grid: &'a Grid,
    pub set: usize,
}

fn find_hgrid<'a>(sets: &[&'a GridSet], lam: f64, phi: f64) -> Option<Used<'a>> {
    for (i, s) in sets.iter().enumerate() {
        if let Some(g) = s.grid_at(lam, phi) {
            return Some(Used { grid: g, set: i });
        }
    }
    None
}

/// PROJ `pj_hgrid_interpolate`: t is the offset from the grid's south-west node (radians).
fn hgrid_interpolate(t: (f64, f64), g: &Grid) -> Option<(f64, f64)> {
    let e = &g.extent;
    let tl = t.0 / e.res_x;
    let tp = t.1 / e.res_y;
    let mut il = ifloor(tl);
    let mut ip = ifloor(tp);
    let mut fl = tl - il as f64;
    let mut fp = tp - ip as f64;
    if il < 0 {
        if il == -1 && fl > 1.0 - 10.0 * REL_TOL {
            il += 1;
            fl = 0.0;
        } else {
            return None;
        }
    } else if il + 1 >= g.width {
        if il + 1 == g.width && fl < 10.0 * REL_TOL {
            il -= 1;
            fl = 1.0;
        } else {
            return None;
        }
    }
    if ip < 0 {
        if ip == -1 && fp > 1.0 - 10.0 * REL_TOL {
            ip += 1;
            fp = 0.0;
        } else {
            return None;
        }
    } else if ip + 1 >= g.height {
        if ip + 1 == g.height && fp < 10.0 * REL_TOL {
            ip -= 1;
            fp = 1.0;
        } else {
            return None;
        }
    }
    let f00 = g.hvalue(il, ip)?;
    let f10 = g.hvalue(il + 1, ip)?;
    let f01 = g.hvalue(il, ip + 1)?;
    let f11 = g.hvalue(il + 1, ip + 1)?;
    let mut m10 = fl;
    let mut m11 = m10;
    let mut m01 = 1.0 - fl;
    let mut m00 = m01;
    m11 *= fp;
    m01 *= fp;
    let fp1 = 1.0 - fp;
    m00 *= fp1;
    m10 *= fp1;
    let lam = m00 * f00.0 as f64 + m10 * f10.0 as f64 + m01 * f01.0 as f64 + m11 * f11.0 as f64;
    let phi = m00 * f00.1 as f64 + m10 * f10.1 as f64 + m01 * f01.1 as f64 + m11 * f11.1 as f64;
    Some((lam, phi))
}

fn norm_to(g: &Grid, lam: f64, phi: f64) -> (f64, f64) {
    let e = &g.extent;
    let eps = (e.res_x + e.res_y) * REL_TOL;
    let mut l = lam - e.west;
    if l + eps < 0.0 {
        l += 2.0 * PI;
    } else if l - eps > e.east - e.west {
        l -= 2.0 * PI;
    }
    (l, phi - e.south)
}

/// PROJ `pj_hgrid_apply`. Returns (λ, φ) and the grid used, or None outside every grid
/// (or when the inverse does not converge).
pub fn hgrid_apply<'a>(sets: &[&'a GridSet], lam: f64, phi: f64, inverse: bool) -> Option<(f64, f64, Used<'a>)> {
    if lam.is_infinite() || lam.is_nan() || phi.is_nan() {
        return None;
    }
    // PROJ's forward entry (fwd_prepare) brings the longitude into [−π, π]; the inverse does not.
    let lam = if inverse { lam } else { adjlon(lam) };
    let mut used = find_hgrid(sets, lam, phi)?;
    let mut grid = used.grid;
    let tb0 = norm_to(grid, lam, phi);
    let t = hgrid_interpolate(tb0, grid)?;
    if !inverse {
        return Some((lam + t.0, phi + t.1, used));
    }
    let mut tb = tb0;
    let mut t = (tb.0 - t.0, tb.1 - t.1);
    let mut i = MAX_ITERATIONS;
    let toltol = TOL * TOL;
    let mut del: Option<(f64, f64)>;
    loop {
        del = hgrid_interpolate(t, grid);
        let dif;
        match del {
            None => {
                let lp = (t.0 + grid.extent.west, t.1 + grid.extent.south);
                match find_hgrid(sets, lp.0, lp.1) {
                    Some(u) if !std::ptr::eq(u.grid, grid) => {
                        grid = u.grid;
                        used = u;
                        t = (lp.0 - grid.extent.west, lp.1 - grid.extent.south);
                        tb = norm_to(grid, lam, phi);
                        dif = (f64::MAX, f64::MAX);
                    }
                    _ => break,
                }
            }
            Some(d) => {
                dif = (t.0 + d.0 - tb.0, t.1 + d.1 - tb.1);
                t.0 -= dif.0;
                t.1 -= dif.1;
            }
        }
        i -= 1;
        if i == 0 || dif.0 * dif.0 + dif.1 * dif.1 <= toltol {
            break;
        }
    }
    if i == 0 {
        return None;
    }
    // When the iteration left the grid, PROJ keeps the first approximation.
    let _ = del;
    Some((adjlon(t.0 + grid.extent.west), t.1 + grid.extent.south, used))
}

// ---- gridshift (generic) -----------------------------------------------------------------

/// The node window values of a generic grid: (lon, lat, z) per node, arc-seconds / metres.
fn generic_window(g: &Grid, x0: i32, y0: i32, n: i32, horizontal: bool) -> Option<Vec<[f64; 3]>> {
    let mut out = Vec::with_capacity((n * n) as usize);
    // PROJ's fast path (256×256 float tiles inside one block) does not flag NaN as nodata.
    let same_block = g.fast_path && x0 / 256 == (x0 + n - 1) / 256 && {
        let row = |y: i32| g.height - 1 - y;
        row(y0) / 256 == row(y0 + n - 1) / 256
    };
    for y in y0..y0 + n {
        for x in x0..x0 + n {
            let mut v = [0.0f64; 3];
            if horizontal {
                let lat = g.raw(g.idx_lat, x, y)?;
                let lon = g.raw(g.idx_lon, x, y)?;
                if !same_block && (g.is_nodata(lat, 1.0) || g.is_nodata(lon, 1.0)) {
                    return None;
                }
                v[0] = lon as f64;
                v[1] = lat as f64;
            }
            if let Some(iz) = g.idx_z {
                let z = g.raw(iz, x, y)?;
                if !same_block && g.is_nodata(z, 1.0) {
                    return None;
                }
                v[2] = z as f64;
            }
            out.push(v);
        }
    }
    Some(out)
}

fn qterp(x: f64, f0: f64, f1: f64, f2: f64) -> f64 {
    let df0 = f1 - f0;
    let df1 = f2 - f1;
    let d2f0 = df1 - df0;
    f0 + x * df0 + 0.5 * x * (x - 1.0) * d2f0
}

/// PROJ `gridshiftData::grid_interpolate`. xy are absolute (normalised) radians.
/// Returns (Δλ rad, Δφ rad, Δz m) and whether the interpolation was biquadratic.
fn generic_interpolate(g: &Grid, xy: (f64, f64), want_z: bool, force: Option<bool>) -> Option<((f64, f64, f64), bool)> {
    let e = &g.extent;
    let horizontal = g.idx_lon != usize::MAX;
    let biq = force.unwrap_or(g.biquadratic) && g.width >= 3 && g.height >= 3;
    let x = (xy.0 - e.west) / e.res_x;
    let y = (xy.1 - e.south) / e.res_y;
    let mut ix = ifloor(x);
    let mut iy = ifloor(y);
    let mut fx = x - ix as f64;
    let mut fy = y - iy as f64;
    if ix < 0 {
        if ix == -1 && fx > 1.0 - 10.0 * REL_TOL {
            ix += 1;
            fx = 0.0;
        } else {
            return None;
        }
    } else if ix + 1 >= g.width {
        if ix + 1 == g.width && fx < 10.0 * REL_TOL {
            ix -= 1;
            fx = 1.0;
        } else {
            return None;
        }
    }
    if iy < 0 {
        if iy == -1 && fy > 1.0 - 10.0 * REL_TOL {
            iy += 1;
            fy = 0.0;
        } else {
            return None;
        }
    } else if iy + 1 >= g.height {
        if iy + 1 == g.height && fy < 10.0 * REL_TOL {
            iy -= 1;
            fy = 1.0;
        } else {
            return None;
        }
    }
    let has_z = want_z && g.idx_z.is_some();
    let mut val = (0.0, 0.0, 0.0);
    if !biq {
        let w = generic_window(g, ix, iy, 2, horizontal)?;
        let mut m10 = fx;
        let mut m11 = m10;
        let mut m01 = 1.0 - fx;
        let mut m00 = m01;
        m11 *= fy;
        m01 *= fy;
        let fy1 = 1.0 - fy;
        m00 *= fy1;
        m10 *= fy1;
        if horizontal {
            val.0 = m00 * w[0][0] + m10 * w[1][0] + m01 * w[2][0] + m11 * w[3][0];
            val.1 = m00 * w[0][1] + m10 * w[1][1] + m01 * w[2][1] + m11 * w[3][1];
        }
        if has_z {
            val.2 = m00 * w[0][2] + m10 * w[1][2] + m01 * w[2][2] + m11 * w[3][2];
        }
    } else {
        // NOAA TM NOS NGS 84: a 3×3 window chosen by the half-cell.
        if (fx <= 0.5 && ix > 0) || ix + 2 == g.width {
            ix -= 1;
            fx += 1.0;
        }
        if (fy <= 0.5 && iy > 0) || iy + 2 == g.height {
            iy -= 1;
            fy += 1.0;
        }
        let w = generic_window(g, ix, iy, 3, horizontal)?;
        let mut rows = [[0.0f64; 3]; 3];
        for (j, row) in rows.iter_mut().enumerate() {
            let r = &w[j * 3..j * 3 + 3];
            for c in 0..3 {
                row[c] = qterp(fx, r[0][c], r[1][c], r[2][c]);
            }
        }
        if horizontal {
            val.0 = qterp(fy, rows[0][0], rows[1][0], rows[2][0]);
            val.1 = qterp(fy, rows[0][1], rows[1][1], rows[2][1]);
        }
        if has_z {
            val.2 = qterp(fy, rows[0][2], rows[1][2], rows[2][2]);
        }
    }
    if horizontal {
        let conv = 1.0 / 3600.0 / 180.0 * PI;
        val.0 *= conv;
        val.1 *= conv;
    }
    Some((val, biq))
}

fn find_generic<'a>(sets: &[&'a GridSet], ty: &str, x: f64, y: f64) -> Option<Used<'a>> {
    for (i, s) in sets.iter().enumerate() {
        if let Some(g) = s.grid_at_type(ty, x, y) {
            return Some(Used { grid: g, set: i });
        }
    }
    None
}

fn normalize_x(g: &Grid, x: f64, y: f64) -> (f64, f64) {
    let e = &g.extent;
    let mut nx = x;
    if e.geographic {
        let eps = (e.res_x + e.res_y) * REL_TOL;
        if nx < e.west - eps {
            nx += 2.0 * PI;
        } else if nx > e.east + eps {
            nx -= 2.0 * PI;
        }
    }
    (nx, y)
}

/// The main and auxiliary grid types of a generic set list (PROJ `checkGridTypes`).
pub struct GenericPlan {
    pub main: String,
    pub aux: Option<String>,
    pub has_geog3d: bool,
    pub has_horizontal: bool,
}

pub fn generic_plan(sets: &[&GridSet]) -> Option<GenericPlan> {
    let (mut h, mut g3, mut eh, mut vv, mut gv) = (false, false, false, false, false);
    for s in sets {
        for g in s.all() {
            match g.gtype.as_str() {
                "HORIZONTAL_OFFSET" => h = true,
                "GEOGRAPHIC_3D_OFFSET" => g3 = true,
                "ELLIPSOIDAL_HEIGHT_OFFSET" => eh = true,
                "VERTICAL_OFFSET_VERTICAL_TO_VERTICAL" => vv = true,
                "VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL" => gv = true,
                _ => return None,
            }
        }
    }
    if u8::from(eh) + u8::from(vv) + u8::from(gv) > 1 {
        return None;
    }
    let main = if g3 {
        "GEOGRAPHIC_3D_OFFSET"
    } else if !h {
        if eh {
            "ELLIPSOIDAL_HEIGHT_OFFSET"
        } else if gv {
            "VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL"
        } else {
            "VERTICAL_OFFSET_VERTICAL_TO_VERTICAL"
        }
    } else {
        "HORIZONTAL_OFFSET"
    };
    let aux = if h {
        if eh {
            Some("ELLIPSOIDAL_HEIGHT_OFFSET")
        } else if gv {
            Some("VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL")
        } else if vv {
            Some("VERTICAL_OFFSET_VERTICAL_TO_VERTICAL")
        } else {
            None
        }
    } else {
        None
    };
    Some(GenericPlan { main: main.into(), aux: aux.map(Into::into), has_geog3d: g3, has_horizontal: h })
}

#[allow(clippy::too_many_arguments)]
fn generic_apply_internal<'a>(sets: &[&'a GridSet], ty: &str, vertical_only: bool, inp: (f64, f64, f64), inverse: bool, mut used: Used<'a>, force: Option<bool>, want_z: bool) -> Option<((f64, f64, f64), Used<'a>)> {
    let mut grid = used.grid;
    let mut nin = normalize_x(grid, inp.0, inp.1);
    let (mut shift, biq) = generic_interpolate(grid, nin, want_z, force)?;
    if !inverse {
        return Some(((inp.0 + shift.0, inp.1 + shift.1, inp.2 + shift.2), used));
    }
    if vertical_only {
        return Some(((inp.0, inp.1, inp.2 - shift.2), used));
    }
    let mut guess = (nin.0 - shift.0, nin.1 - shift.1);
    if !biq {
        let mut i = MAX_ITERATIONS;
        let toltol = TOL * TOL;
        loop {
            let diff;
            match generic_interpolate(grid, guess, want_z, force) {
                // PROJ keeps the failed result, whose height shift is 0.
                None => match {
                    shift = (f64::INFINITY, f64::INFINITY, 0.0);
                    find_generic(sets, ty, guess.0, guess.1)
                } {
                    Some(u) if !std::ptr::eq(u.grid, grid) => {
                        grid = u.grid;
                        used = u;
                        nin = normalize_x(grid, inp.0, inp.1);
                        diff = (f64::MAX, f64::MAX);
                    }
                    _ => break,
                },
                Some((s, _)) => {
                    shift = s;
                    diff = (guess.0 + shift.0 - nin.0, guess.1 + shift.1 - nin.1);
                    guess.0 -= diff.0;
                    guess.1 -= diff.1;
                }
            }
            i -= 1;
            if i == 0 || diff.0 * diff.0 + diff.1 * diff.1 <= toltol {
                break;
            }
        }
        if i == 0 {
            return None;
        }
    }
    let x = if grid.extent.geographic { adjlon(guess.0) } else { guess.0 };
    Some(((x, guess.1, inp.2 - shift.2), used))
}

/// PROJ `+proj=gridshift` (`gridshiftData::apply`). `force_biquadratic` overrides the
/// grid's `interpolation_method` (PROJ `+interpolation=`); `want_z` false is `+no_z_transform`.
pub fn gridshift_apply<'a>(sets: &[&'a GridSet], plan: &GenericPlan, xyz: (f64, f64, f64), inverse: bool, force_biquadratic: Option<bool>, want_z: bool) -> Option<((f64, f64, f64), Used<'a>)> {
    if xyz.0.is_infinite() || xyz.0.is_nan() || xyz.1.is_nan() {
        return None;
    }
    let mut ty = plan.main.as_str();
    let mut found_g3 = false;
    let used = match find_generic(sets, ty, xyz.0, xyz.1) {
        Some(u) => {
            found_g3 = plan.has_geog3d;
            u
        }
        None => {
            if plan.has_geog3d && plan.has_horizontal {
                ty = "HORIZONTAL_OFFSET";
                find_generic(sets, ty, xyz.0, xyz.1)?
            } else {
                return None;
            }
        }
    };
    let (mut out, used) = generic_apply_internal(sets, ty, !(plan.has_geog3d || plan.has_horizontal), xyz, inverse, used, force_biquadratic, want_z)?;
    if !found_g3 {
        if let Some(aux) = &plan.aux {
            let u2 = find_generic(sets, aux, out.0, out.1)?;
            let (o2, _) = generic_apply_internal(sets, aux, true, out, inverse, u2, force_biquadratic, want_z)?;
            out = o2;
        }
    }
    Some((out, used))
}

// ---- vgridshift ------------------------------------------------------------------------

/// PROJ `read_vgrid_value`: the grid value × multiplier, or None outside the grids or where
/// all four nodes are nodata.
pub fn vgrid_value<'a>(sets: &[&'a GridSet], lam: f64, phi: f64, mult: f64) -> Option<(f64, Used<'a>)> {
    if lam.is_nan() || phi.is_nan() {
        return None;
    }
    vgrid_value_raw(sets, lam, phi, mult)
}

/// `vgrid_value` for PROJ's forward direction, whose entry normalises the longitude first.
pub fn vgrid_value_fwd<'a>(sets: &[&'a GridSet], lam: f64, phi: f64, mult: f64) -> Option<(f64, Used<'a>)> {
    if lam.is_nan() || phi.is_nan() {
        return None;
    }
    vgrid_value_raw(sets, adjlon(lam), phi, mult)
}

fn vgrid_value_raw<'a>(sets: &[&'a GridSet], lam: f64, phi: f64, mult: f64) -> Option<(f64, Used<'a>)> {
    let mut used = None;
    for (i, s) in sets.iter().enumerate() {
        if let Some(g) = s.grid_at(lam, phi) {
            used = Some(Used { grid: g, set: i });
            break;
        }
    }
    let used = used?;
    let g = used.grid;
    let e = &g.extent;
    if !e.geographic {
        return None;
    }
    let w = g.width as f64;
    let mut gx = (lam - e.west) * e.inv_res_x;
    if lam < e.west {
        gx = if e.full_world_longitude() { ((gx + w) % w + w) % w } else { (lam + 2.0 * PI - e.west) * e.inv_res_x };
    } else if lam > e.east {
        gx = if e.full_world_longitude() { ((gx + w) % w + w) % w } else { (lam - 2.0 * PI - e.west) * e.inv_res_x };
    }
    let mut gy = (phi - e.south) * e.inv_res_y;
    let ix = ifloor(gx);
    if !(ix >= 0 && ix < g.width) {
        return None;
    }
    let iy = ifloor(gy);
    if !(iy >= 0 && iy < g.height) {
        return None;
    }
    gx -= ix as f64;
    gy -= iy as f64;
    let mut ix2 = ix + 1;
    if ix2 >= g.width {
        ix2 = if e.full_world_longitude() { 0 } else { g.width - 1 };
    }
    let iy2 = (iy + 1).min(g.height - 1);
    let iz = g.idx_z.unwrap_or(0);
    let a = g.raw(iz, ix, iy)?;
    let b = g.raw(iz, ix2, iy)?;
    let c = g.raw(iz, ix, iy2)?;
    let d = g.raw(iz, ix2, iy2)?;
    let gxy = gx * gy;
    let (av, bv, cv, dv) = (!g.is_nodata(a, mult), !g.is_nodata(b, mult), !g.is_nodata(c, mult), !g.is_nodata(d, mult));
    let n = u8::from(av) + u8::from(bv) + u8::from(cv) + u8::from(dv);
    let value = if n == 4 {
        let mut v = a as f64 * (1.0 - gx - gy + gxy);
        v += b as f64 * (gx - gxy);
        v += c as f64 * (gy - gxy);
        v += d as f64 * gxy;
        v
    } else if n == 0 {
        return None;
    } else {
        let (mut v, mut tw) = (0.0, 0.0);
        if av {
            let wt = 1.0 - gx - gy + gxy;
            v = a as f64 * wt;
            tw = wt;
        }
        if bv {
            let wt = gx - gxy;
            v += b as f64 * wt;
            tw += wt;
        }
        if cv {
            let wt = gy - gxy;
            v += c as f64 * wt;
            tw += wt;
        }
        if dv {
            let wt = gxy;
            v += d as f64 * wt;
            tw += wt;
        }
        v / tw
    };
    Some((value * mult, used))
}
