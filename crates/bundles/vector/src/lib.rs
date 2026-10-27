//! `vector` bundle (lazy; analysis worker): feature validation (REQ-EXT-13).

use gw_abi::{set_out_json, slice, status, Error, Json};
use gw_vector::{validate, Feature, Fix, Kind, Opts};

gw_abi::export_abi!();

/// Validate features. `prm` = [tolerance, duplicate tolerance, sliver ratio, sliver max area];
/// `data` = [n, then per feature: kind (0 point, 1 line, 2 polygon), parts, polygons, polygon
/// starts…, then per part: vertices, x, y …] in metres. Output: JSON issues.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_validate(prm: *const f64, plen: usize, data: *const f64, dlen: usize) -> i32 {
    let (a, d) = (slice(prm, plen), slice(data, dlen));
    status((|| {
        if a.len() != 4 || d.is_empty() {
            return Err(Error::invalid("validate: bad parameters"));
        }
        let mut o = 1usize;
        let mut next = || -> gw_abi::Result<f64> {
            let v = *d.get(o).ok_or_else(|| Error::invalid("validate: truncated data"))?;
            o += 1;
            Ok(v)
        };
        let n = d[0] as usize;
        let mut fs = Vec::with_capacity(n);
        for _ in 0..n {
            let kind = match next()? as u32 {
                0 => Kind::Point,
                1 => Kind::Line,
                _ => Kind::Polygon,
            };
            let (np, npoly) = (next()? as usize, next()? as usize);
            let mut polys = Vec::with_capacity(npoly);
            for _ in 0..npoly {
                polys.push(next()? as usize);
            }
            let mut parts = Vec::with_capacity(np);
            for _ in 0..np {
                let nv = next()? as usize;
                let mut v = Vec::with_capacity(nv);
                for _ in 0..nv {
                    v.push([next()?, next()?]);
                }
                parts.push(v);
            }
            fs.push(Feature { kind, parts, polys });
        }
        let is = validate(&fs, &Opts { tol: a[0], dup_tol: a[1], sliver: a[2], sliver_area: a[3] });
        let mut j = Json::new();
        j.arr();
        for i in &is {
            j.obj().kv_str("check", i.check).kv_int("feature", i.feature as i64);
            j.key("other");
            match i.other {
                Some(x) => j.int(x as i64),
                None => j.null(),
            };
            j.kv_int("part", i.part as i64).key("at").arr().num(i.at[0]).num(i.at[1]).end_arr().kv_num("value", i.value).kv_str("message", &i.message);
            j.key("fix");
            match &i.fix {
                Some(Fix::Move { part, vertex, to }) => j.obj().kv_str("kind", "move").kv_int("part", *part as i64).kv_int("vertex", *vertex as i64).key("to").arr().num(to[0]).num(to[1]).end_arr().end_obj(),
                Some(Fix::Trim { part, end, keep, to }) => j.obj().kv_str("kind", "trim").kv_int("part", *part as i64).kv_int("end", i64::from(*end)).kv_int("keep", *keep as i64).key("to").arr().num(to[0]).num(to[1]).end_arr().end_obj(),
                None => j.null(),
            };
            j.end_obj();
        }
        j.end_arr();
        set_out_json(j.finish());
        Ok(())
    })())
}
