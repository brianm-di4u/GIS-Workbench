//! `tin` bundle (lazy; main thread and analysis worker): TIN editing (REQ-GAP-39). A TIN is a
//! handle (id ≥ 1) to a mesh held in this instance. The worker builds one and hands it over as
//! bytes (`gw_tin_save` → `gw_tin_load`); the main thread edits it, queries it for display and
//! rasterises it. The LandXML and point-text readers are here too (the LandXML writer is JS:
//! formats/landxml.js). Floats leave as binary f64, or in JSON with a fixed number of decimals,
//! so the bundle carries no float formatting.

use gw_abi::{set_out, set_out_json, slice, status, Error, Json};
use gw_tin::make::{self, GridSpec};
use gw_tin::mesh::{Fail, Mesh, E_CONS, INF, T_EXCL, V_DEAD, V_LINE, V_MASS};
use gw_tin::ops;
use std::cell::RefCell;

gw_abi::export_abi!();

thread_local! {
    static TINS: RefCell<Vec<Option<Mesh>>> = const { RefCell::new(Vec::new()) };
}

fn put(m: Mesh) -> i32 {
    TINS.with(|t| {
        let mut t = t.borrow_mut();
        if let Some(k) = t.iter().position(|s| s.is_none()) {
            t[k] = Some(m);
            k as i32 + 1
        } else {
            t.push(Some(m));
            t.len() as i32
        }
    })
}

fn with<R>(id: i32, f: impl FnOnce(&mut Mesh) -> gw_abi::Result<R>) -> gw_abi::Result<R> {
    TINS.with(|t| {
        let mut t = t.borrow_mut();
        let m = t.get_mut((id as usize).wrapping_sub(1)).and_then(|s| s.as_mut()).ok_or_else(|| Error::invalid("tin: no such TIN"))?;
        f(m)
    })
}

fn fail(e: Fail) -> Error {
    match e {
        Fail::Refused(m) | Fail::Broken(m) => Error::invalid(m),
    }
}

/// A float in JSON with `d` decimals (null when not finite), without core float formatting.
fn fx(j: &mut Json, k: &str, v: f64, d: u32) {
    j.key(k);
    if !v.is_finite() || v.abs() > 1e15 {
        j.null();
        return;
    }
    let scale = 10u64.pow(d.min(12));
    let n = (v * scale as f64).round();
    if n.abs() > 9.0e18 {
        j.null();
        return;
    }
    let n = n as i64;
    let mut s = String::new();
    if n < 0 {
        s.push('-');
    }
    let a = n.unsigned_abs();
    s.push_str(&(a / scale).to_string());
    if d > 0 {
        let f = (a % scale).to_string();
        s.push('.');
        for _ in f.len()..d as usize {
            s.push('0');
        }
        s.push_str(&f);
    }
    j.raw(&s);
}

fn out_f64(v: &[f64]) {
    let mut b = Vec::with_capacity(v.len() * 8);
    for x in v {
        b.extend_from_slice(&x.to_le_bytes());
    }
    set_out(b);
}

/// A handle, or minus the status code on failure.
fn id_or(r: gw_abi::Result<Mesh>) -> i32 {
    match r {
        Ok(m) => put(m),
        Err(e) => -status::<()>(Err(e)),
    }
}

fn report_json(r: &make::Report, m: &Mesh) -> String {
    let mut j = Json::new();
    j.obj().kv_int("input", r.input as i64).kv_int("vertices", r.vertices as i64).kv_int("triangles", m.nreal as i64).kv_int("duplicates", r.duplicates as i64).kv_bool("stoppedAtLimit", r.stopped_at_limit);
    fx(&mut j, "maxError", r.max_error, 6);
    j.end_obj();
    j.finish()
}

fn maxv_of(v: f64) -> usize {
    if v.is_finite() && v >= 3.0 {
        v.min(8.0e6) as usize
    } else {
        3_000_000
    }
}

/// TIN through points. `prm` = [grid step m, cell m (0: none), max points]; `pts` = x, y, z
/// triples (plane metres). Returns a handle; the build report is in the output (JSON).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_tin_from_points(prm: *const f64, plen: usize, pts: *const f64, n: usize) -> i32 {
    let a = slice(prm, plen);
    let p = slice(pts, n);
    id_or((|| {
        if a.len() != 3 || !(a[0] > 0.0 && a[0] <= 1.0) || p.len() % 3 != 0 {
            return Err(Error::invalid("tin: bad parameters"));
        }
        let (m, r) = make::from_points(p, a[0], a[1], maxv_of(a[2])).map_err(fail)?;
        set_out_json(report_json(&r, &m));
        Ok(m)
    })())
}

/// TIN from DEM posts. `prm` = [w, h, ax, ay, bx, by, tolerance m (< 0: every post), max points,
/// grid step m]: post (i, j) is at x = ax + bx·i, y = ay + by·j. Returns a handle.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_tin_from_dem(prm: *const f64, plen: usize, z: *const f32, zlen: usize) -> i32 {
    let a = slice(prm, plen);
    let zz = slice(z, zlen);
    id_or((|| {
        if a.len() != 9 || !(a[8] > 0.0 && a[8] <= 1.0) || !a[6].is_finite() {
            return Err(Error::invalid("tin: bad parameters"));
        }
        let g = grid_of(a)?;
        if !g.valid(zlen) {
            return Err(Error::invalid("tin: the grid does not match the heights"));
        }
        let (m, r) = make::from_dem(&g, zz, a[6], maxv_of(a[7]), a[8], |_, _| {}).map_err(fail)?;
        set_out_json(report_json(&r, &m));
        Ok(m)
    })())
}

fn grid_of(a: &[f64]) -> gw_abi::Result<GridSpec> {
    let (w, h) = (a[0], a[1]);
    if !(w >= 1.0 && h >= 1.0 && w <= 1.0e6 && h <= 1.0e6 && w.fract() == 0.0 && h.fract() == 0.0) {
        return Err(Error::invalid("tin: bad grid size"));
    }
    let g = GridSpec { w: w as usize, h: h as usize, ax: a[2], ay: a[3], bx: a[4], by: a[5] };
    if !(g.ax.is_finite() && g.ay.is_finite() && g.bx.is_finite() && g.by.is_finite() && g.bx != 0.0 && g.by != 0.0) {
        return Err(Error::invalid("tin: bad grid size"));
    }
    Ok(g)
}

#[no_mangle]
pub extern "C" fn gw_tin_free(id: i32) {
    TINS.with(|t| {
        if let Some(s) = t.borrow_mut().get_mut((id as usize).wrapping_sub(1)) {
            *s = None;
        }
    });
}

/// The TIN's state as bytes (output).
#[no_mangle]
pub extern "C" fn gw_tin_save(id: i32) -> i32 {
    status(with(id, |m| {
        set_out(gw_tin::state::save(m));
        Ok(())
    }))
}

/// A TIN from saved bytes (checked). Returns a handle.
/// # Safety
/// The pointer must hold the stated length.
#[no_mangle]
pub unsafe extern "C" fn gw_tin_load(b: *const u8, n: usize) -> i32 {
    let bytes = slice(b, n);
    id_or(gw_tin::state::load(bytes).map_err(Error::invalid))
}

/// Apply an edit list (`gw_tin::ops`). Output JSON: one result per edit {ok, broken, msg, added,
/// removed, changed, profile}. A broken edit leaves the TIN to be rebuilt by the caller.
/// # Safety
/// The pointer must hold the stated length.
#[no_mangle]
pub unsafe extern "C" fn gw_tin_apply(id: i32, opsp: *const f64, olen: usize) -> i32 {
    let a = slice(opsp, olen);
    status(with(id, |m| {
        let list = ops::parse(a).map_err(Error::invalid)?;
        let mut j = Json::new();
        j.arr();
        for op in &list {
            let r = ops::apply(m, op);
            j.obj();
            match r {
                Ok(d) => {
                    j.kv_bool("ok", true).kv_int("added", d.added as i64).kv_int("removed", d.removed as i64).kv_int("changed", d.changed as i64);
                    if let Some(p) = d.profile {
                        j.key("profile").obj().kv_int("vertices", p.vertices as i64).kv_int("changed", p.changed as i64).kv_int("conflicts", p.conflicts as i64).kv_bool("reversed", p.reversed);
                        fx(&mut j, "maxChange", p.max_change, 4);
                        fx(&mut j, "start", p.start, 4);
                        fx(&mut j, "end", p.end, 4);
                        j.end_obj();
                    }
                }
                Err(Fail::Refused(e)) => {
                    j.kv_bool("ok", false).kv_bool("broken", false).kv_str("msg", e);
                }
                Err(Fail::Broken(e)) => {
                    j.kv_bool("ok", false).kv_bool("broken", true).kv_str("msg", e);
                }
            }
            j.end_obj();
        }
        j.end_arr();
        set_out_json(j.finish());
        Ok(())
    }))
}

/// Keep a file's own faces in a TIN built through its points (`gw_tin::faces`; LandXML, OD-2.41).
/// `pts` = the file's x, y, z (plane metres); `faces` = point indices as u32 LE, three per face;
/// `hidden` = one byte per face. Output JSON {faces, skipped, forced, rings, kept}.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_tin_keep_faces(id: i32, pts: *const f64, n: usize, faces: *const u8, fl: usize, hidden: *const u8, hl: usize) -> i32 {
    let p = slice(pts, n);
    let fb = slice(faces, fl);
    let h = slice(hidden, hl);
    status(with(id, |m| {
        if p.len() % 3 != 0 || fb.len() % 12 != 0 {
            return Err(Error::invalid("tin: bad faces"));
        }
        let f: Vec<u32> = fb.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let k = gw_tin::faces::keep_faces(m, p, &f, h, gw_tin::faces::KEY0).map_err(fail)?;
        let mut j = Json::new();
        j.obj().kv_int("faces", k.faces as i64).kv_int("skipped", k.skipped as i64).kv_int("forced", k.forced as i64).kv_int("rings", k.rings as i64).kv_int("kept", k.kept as i64).end_obj();
        set_out_json(j.finish());
        Ok(())
    }))
}

/// Summary (JSON): grid, counts, extent, heights, lines and statistics.
#[no_mangle]
pub extern "C" fn gw_tin_info(id: i32) -> i32 {
    status(with(id, |m| {
        m.classify();
        let (mut x0, mut y0, mut x1, mut y1, mut z0, mut z1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        let (mut mass, mut linev, mut alive) = (0i64, 0i64, 0i64);
        for v in 0..m.nv() as u32 {
            let f = m.vf[v as usize];
            if f & V_DEAD != 0 || m.vt[v as usize] == u32::MAX {
                continue;
            }
            alive += 1;
            if f & V_MASS != 0 {
                mass += 1;
            }
            if f & V_LINE != 0 {
                linev += 1;
            }
            let (x, y, z) = (m.px(v), m.py(v), m.z[v as usize]);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            if z.is_finite() {
                z0 = z0.min(z);
                z1 = z1.max(z);
            }
        }
        let excluded = m.triangles().filter(|&t| m.tf[t as usize] & T_EXCL != 0).count();
        let mut j = Json::new();
        j.obj().kv_int("vertices", alive).kv_int("mass", mass).kv_int("lineVertices", linev).kv_int("triangles", m.nreal as i64).kv_int("excluded", excluded as i64);
        fx(&mut j, "q", m.q, 6);
        fx(&mut j, "x0", x0, 4);
        fx(&mut j, "y0", y0, 4);
        fx(&mut j, "x1", x1, 4);
        fx(&mut j, "y1", y1, 4);
        fx(&mut j, "zmin", z0, 4);
        fx(&mut j, "zmax", z1, 4);
        j.key("lines").arr();
        for l in m.lines.iter().filter(|l| l.alive) {
            j.obj().kv_int("key", l.key as i64).kv_int("kind", l.kind as i64).kv_bool("closed", l.closed).kv_int("defs", l.defs.len() as i64).kv_int("path", l.path.len() as i64).end_obj();
        }
        j.end_arr();
        let s = &m.stats;
        j.key("stats").obj().kv_int("duplicates", s.duplicates as i64).kv_int("flips", s.flips as i64).kv_int("steiner", s.steiner as i64).kv_int("snapped", s.snapped as i64).kv_int("rebuilds", s.rebuilds as i64).end_obj();
        j.end_obj();
        set_out_json(j.finish());
        Ok(())
    }))
}

/// Lines with their coordinates, as f64: per line [key, kind, closed, defs n, path n], then
/// x, y, z of each defining vertex and of each path vertex.
#[no_mangle]
pub extern "C" fn gw_tin_lines(id: i32) -> i32 {
    status(with(id, |m| {
        let mut v = Vec::new();
        for l in m.lines.iter().filter(|l| l.alive) {
            v.extend_from_slice(&[l.key as f64, l.kind as f64, l.closed as u8 as f64, l.defs.len() as f64, l.path.len() as f64]);
            for &w in l.defs.iter().chain(l.path.iter()) {
                v.extend_from_slice(&[m.px(w), m.py(w), m.z[w as usize]]);
            }
        }
        out_f64(&v);
        Ok(())
    }))
}

/// Triangles meeting a box, for display and export. `prm` = [x0, y0, x1, y1, cap]. Output: u32
/// [vertices, triangles, constrained edges, triangles in the box], then f64 x, y, z per vertex,
/// u32 × 3 per triangle, u32 × 2 per constrained edge, u8 per triangle (1 = excluded), u8 per
/// edge (the kind of its first line). Over `cap` triangles only the counts come back.
/// # Safety
/// The pointer must hold the stated length.
#[no_mangle]
pub unsafe extern "C" fn gw_tin_mesh(id: i32, prm: *const f64, plen: usize) -> i32 {
    let a = slice(prm, plen);
    status(with(id, |m| {
        if a.len() != 5 {
            return Err(Error::invalid("tin: bad parameters"));
        }
        m.classify();
        let (bx0, by0, bx1, by1) = (a[0], a[1], a[2], a[3]);
        let cap = if a[4] >= 0.0 && a[4].is_finite() { a[4] as usize } else { usize::MAX };
        let mut tris = Vec::new();
        let mut total = 0usize;
        for t in m.triangles() {
            let v = m.tv[t as usize];
            let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            for &w in &v {
                let (x, y) = (m.px(w), m.py(w));
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
            }
            if x1 < bx0 || x0 > bx1 || y1 < by0 || y0 > by1 {
                continue;
            }
            total += 1;
            if total <= cap {
                tris.push(t);
            }
        }
        if total > cap {
            tris.clear();
        }
        let mut local = vec![u32::MAX; m.nv()];
        let mut verts: Vec<u32> = Vec::new();
        let mut idx: Vec<u32> = Vec::with_capacity(tris.len() * 3);
        let mut edges: Vec<(u32, u32, u8)> = Vec::new();
        for &t in &tris {
            let v = m.tv[t as usize];
            for &w in &v {
                if local[w as usize] == u32::MAX {
                    local[w as usize] = verts.len() as u32;
                    verts.push(w);
                }
                idx.push(local[w as usize]);
            }
            for i in 0..3 {
                if m.te[t as usize][i] & E_CONS == 0 {
                    continue;
                }
                let (p, q) = (v[(i + 1) % 3], v[(i + 2) % 3]);
                // Each edge once: from the side where p < q, or where the other side is outside the box.
                let u = m.tn[t as usize][i];
                let other_in = u != u32::MAX && !m.tv[u as usize].contains(&INF);
                if p < q || !other_in {
                    let kind = m.cons.get(&gw_tin::mesh::ekey(p, q)).and_then(|ls| ls.first()).map(|&l| m.lines[l as usize].kind).unwrap_or(0);
                    edges.push((p, q, kind));
                }
            }
        }
        // One u64 sort: the edge key above, the kind below.
        let mut ek: Vec<u64> = edges.iter().map(|e| (gw_tin::mesh::ekey(e.0, e.1) << 3) | e.2 as u64 & 7).collect();
        ek.sort_unstable();
        ek.dedup_by_key(|k| *k >> 3);
        let mut edges: Vec<(u32, u32, u8)> = ek.iter().map(|&k| (((k >> 3) >> 32) as u32, ((k >> 3) & 0xffff_ffff) as u32, (k & 7) as u8)).collect();
        for e in edges.iter_mut() {
            for w in [e.0, e.1] {
                if local[w as usize] == u32::MAX {
                    local[w as usize] = verts.len() as u32;
                    verts.push(w);
                }
            }
        }
        let mut b = Vec::with_capacity(16 + verts.len() * 24 + idx.len() * 4 + edges.len() * 9 + tris.len());
        for n in [verts.len(), tris.len(), edges.len(), total] {
            b.extend_from_slice(&(n as u32).to_le_bytes());
        }
        for &w in &verts {
            for v in [m.px(w), m.py(w), m.z[w as usize]] {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        for &i in &idx {
            b.extend_from_slice(&i.to_le_bytes());
        }
        for e in &edges {
            b.extend_from_slice(&local[e.0 as usize].to_le_bytes());
            b.extend_from_slice(&local[e.1 as usize].to_le_bytes());
        }
        for &t in &tris {
            b.push((m.tf[t as usize] & T_EXCL != 0) as u8);
        }
        for e in &edges {
            b.push(e.2);
        }
        set_out(b);
        Ok(())
    }))
}

/// Heights at plane points (x, y pairs). Output: f64 per point (NaN outside or excluded).
/// # Safety
/// The pointer must hold the stated length.
#[no_mangle]
pub unsafe extern "C" fn gw_tin_heights(id: i32, xy: *const f64, n: usize) -> i32 {
    let p = slice(xy, n);
    status(with(id, |m| {
        m.classify();
        let mut b = Vec::with_capacity(n / 2 * 8);
        for c in p.chunks_exact(2) {
            b.extend_from_slice(&m.height_at(c[0], c[1]).to_le_bytes());
        }
        set_out(b);
        Ok(())
    }))
}

/// TIN → grid. `prm` = [w, h, ax, ay, bx, by] as for gw_tin_from_dem. Output: f32 w·h (NaN outside).
/// # Safety
/// The pointer must hold the stated length.
#[no_mangle]
pub unsafe extern "C" fn gw_tin_raster(id: i32, prm: *const f64, plen: usize) -> i32 {
    let a = slice(prm, plen);
    status(with(id, |m| {
        if a.len() != 6 {
            return Err(Error::invalid("tin: bad parameters"));
        }
        let g = grid_of(a)?;
        if g.w.checked_mul(g.h).is_none_or(|n| n > 200_000_000) {
            return Err(Error::invalid("tin: the grid is too large (over 200 million posts)"));
        }
        let z = make::rasterize(m, &g);
        let mut b = Vec::with_capacity(z.len() * 4);
        for v in &z {
            b.extend_from_slice(&v.to_le_bytes());
        }
        set_out(b);
        Ok(())
    }))
}

/// Snap target near a plane point within r metres, as 11 f64: [vertex found, x, y, z, mass,
/// on a line, line point found, key, x, y, z] — the nearest vertex, and the nearest point on a
/// line's path.
#[no_mangle]
pub extern "C" fn gw_tin_snap(id: i32, x: f64, y: f64, r: f64) -> i32 {
    status(with(id, |m| {
        let mut o = [0.0f64; 11];
        if let Some(v) = m.nearest_vertex(x, y, r.max(0.0), 0) {
            o[..6].copy_from_slice(&[1.0, m.px(v), m.py(v), m.z[v as usize], (m.vf[v as usize] & V_MASS != 0) as u8 as f64, (m.vl[v as usize] > 0) as u8 as f64]);
        }
        let mut best = f64::INFINITY;
        for l in m.lines.iter().filter(|l| l.alive) {
            let n = l.path.len();
            let segs = if l.closed { n } else { n.saturating_sub(1) };
            for k in 0..segs {
                let (a, b) = (l.path[k], l.path[(k + 1) % n]);
                let (ax, ay, bx, by) = (m.px(a), m.py(a), m.px(b), m.py(b));
                if (ax.min(bx) - r > x) || (ax.max(bx) + r < x) || (ay.min(by) - r > y) || (ay.max(by) + r < y) {
                    continue;
                }
                let (dx, dy) = (bx - ax, by - ay);
                let l2 = dx * dx + dy * dy;
                let s = if l2 > 0.0 { (((x - ax) * dx + (y - ay) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
                let (px, py) = (ax + s * dx, ay + s * dy);
                let d = ((px - x).powi(2) + (py - y).powi(2)).sqrt();
                if d <= r && d < best {
                    best = d;
                    let z = m.z[a as usize] + (m.z[b as usize] - m.z[a as usize]) * s;
                    o[6..].copy_from_slice(&[1.0, l.key as f64, px, py, z]);
                }
            }
        }
        out_f64(&o);
        Ok(())
    }))
}

fn pad8(b: &mut Vec<u8>) {
    while b.len() % 8 != 0 {
        b.push(0);
    }
}

/// Read LandXML (UTF-8 text). Output: u32 JSON length, the JSON (document summary, the chosen
/// surface's lines as counts), padding to 8, then f64 x, y, z of the surface's points, of its
/// extra (data and proximity) points and of every line's points, u32 × 3 per face, u8 per face
/// (1 = invisible).
/// # Safety
/// The pointer must hold the stated length.
#[no_mangle]
pub unsafe extern "C" fn gw_landxml_read(p: *const u8, n: usize, surface: u32) -> i32 {
    let bytes = slice(p, n);
    status((|| {
        let text = std::str::from_utf8(bytes).map_err(|_| Error::invalid("the LandXML file is not UTF-8 text"))?;
        let d = gw_tin::landxml::parse(text).map_err(Error::invalid)?;
        let s = d.surfaces.get(surface as usize).ok_or_else(|| Error::invalid("the LandXML file has no TIN surface"))?;
        let mut j = Json::new();
        j.obj().kv_str("version", &d.version).kv_str("unit", &d.unit);
        fx(&mut j, "toMetres", d.to_m, 12);
        match d.epsg {
            Some(e) => j.kv_int("epsg", e as i64),
            None => j.key("epsg").null(),
        };
        j.kv_str("crsName", &d.crs_name).kv_str("wkt", &d.wkt);
        j.key("surfaces").arr();
        for x in &d.surfaces {
            j.obj().kv_str("name", &x.name).kv_int("points", x.points.len() as i64).kv_int("faces", x.faces.len() as i64).kv_int("lines", x.lines.len() as i64).end_obj();
        }
        j.end_arr().kv_int("surface", surface as i64).kv_int("points", s.points.len() as i64).kv_int("extra", s.extra.len() as i64).kv_int("faces", s.faces.len() as i64);
        j.key("lines").arr();
        for l in &s.lines {
            j.obj().kv_int("kind", l.kind as i64).kv_str("name", &l.name).kv_bool("closed", l.closed).kv_int("n", l.pts.len() as i64).end_obj();
        }
        j.end_arr().key("refused").arr();
        for r in &d.refused {
            j.obj().kv_str("what", r.0).kv_str("name", &r.1).kv_str("type", &r.2).end_obj();
        }
        j.end_arr().key("warnings").arr();
        for w in &d.warnings {
            j.obj().kv_str("what", w.0).kv_str("name", &w.1).end_obj();
        }
        j.end_arr().end_obj();
        let json = j.finish();
        let mut b = Vec::new();
        b.extend_from_slice(&(json.len() as u32).to_le_bytes());
        b.extend_from_slice(json.as_bytes());
        pad8(&mut b);
        for p in s.points.iter().chain(s.extra.iter()).chain(s.lines.iter().flat_map(|l| l.pts.iter())) {
            for v in p {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        for f in &s.faces {
            for v in f {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        for &h in &s.hidden {
            b.push(h as u8);
        }
        set_out(b);
        Ok(())
    })())
}

/// Read a delimited point table. Output: u32 JSON length, JSON {header, delimiter, rows, cols,
/// text: [[column, [values…]]…]}, padding to 8, then f64 rows × cols (NaN where not a number).
/// # Safety
/// The pointer must hold the stated length.
#[no_mangle]
pub unsafe extern "C" fn gw_points_read(p: *const u8, n: usize) -> i32 {
    let bytes = slice(p, n);
    status((|| {
        let t = gw_tin::text::parse(bytes).map_err(Error::invalid)?;
        let mut j = Json::new();
        j.obj().key("header").arr();
        for h in &t.header {
            j.str(h);
        }
        j.end_arr().kv_str("delimiter", &t.delimiter.to_string()).kv_int("rows", t.rows as i64).kv_int("cols", t.cols as i64).key("text").arr();
        for (c, col) in &t.text {
            j.arr().int(*c as i64).arr();
            for s in col {
                j.str(s);
            }
            j.end_arr().end_arr();
        }
        j.end_arr().end_obj();
        let json = j.finish();
        let mut b = Vec::with_capacity(16 + json.len() + t.values.len() * 8);
        b.extend_from_slice(&(json.len() as u32).to_le_bytes());
        b.extend_from_slice(json.as_bytes());
        pad8(&mut b);
        for v in &t.values {
            b.extend_from_slice(&v.to_le_bytes());
        }
        set_out(b);
        Ok(())
    })())
}
