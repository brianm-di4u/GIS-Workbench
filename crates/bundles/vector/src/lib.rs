//! `vector` bundle (lazy; analysis worker): feature validation (REQ-EXT-13), and shortest routes
//! and service areas on road networks (REQ-GAP-85).

use gw_abi::{set_out_json, slice, status, Error, Json};
use gw_vector::network::Graph;
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

/// Road network (REQ-GAP-85). `data` = [nodes, edges, turn bans, then per edge from, to, cost
/// along, cost against (infinite or negative = closed), length (m); then x, y of every node (m,
/// local); then the bans as pairs (edge in, edge out)]. `prm`: [0, source node, target node] for a
/// route — JSON {cost, edges, forward} (cost null when unreachable); or [1, max cost, sources…] for
/// a service area — JSON {cost} per node and {entry} per edge direction (2e + 1 along, 2e against: the
/// least cost at which the edge can be entered, after turn bans), null beyond the maximum.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_network(prm: *const f64, plen: usize, data: *const f64, dlen: usize) -> i32 {
    let (a, d) = (slice(prm, plen), slice(data, dlen));
    status((|| {
        let bad = || Error::invalid("network: malformed graph");
        if d.len() < 3 || a.is_empty() {
            return Err(bad());
        }
        let (n, ne, nb) = (d[0] as usize, d[1] as usize, d[2] as usize);
        if n > 1 << 26 || ne > 1 << 26 || nb > 1 << 24 || d.len() != 3 + 5 * ne + 2 * n + 2 * nb {
            return Err(bad());
        }
        let col = |k: usize| &d[3 + k * ne..3 + (k + 1) * ne];
        let ids = |v: &[f64]| -> gw_abi::Result<Vec<u32>> { v.iter().map(|&x| if x >= 0.0 && (x as usize) < n && x.fract() == 0.0 { Ok(x as u32) } else { Err(bad()) }).collect() };
        let (from, to) = (ids(col(0))?, ids(col(1))?);
        let xy = &d[3 + 5 * ne..3 + 5 * ne + 2 * n];
        let bans = &d[3 + 5 * ne + 2 * n..];
        let banned = bans.chunks(2).filter(|p| p[0] >= 0.0 && p[1] >= 0.0 && (p[0] as usize) < ne && (p[1] as usize) < ne).map(|p| (p[0] as u32, p[1] as u32)).collect();
        let g = Graph { n, from: &from, to: &to, fwd: col(2), bwd: col(3), len: col(4), xy, banned };
        let node = |x: f64| if x >= 0.0 && (x as usize) < n { Ok(x as usize) } else { Err(Error::invalid("network: no such node")) };
        let mut j = Json::new();
        j.obj();
        match a[0] as i32 {
            0 if a.len() == 3 => match g.route(node(a[1])?, node(a[2])?) {
                Some(r) => {
                    j.kv_num("cost", r.cost).key("edges").arr();
                    r.edges.iter().for_each(|(e, _)| {
                        j.int(i64::from(*e));
                    });
                    j.end_arr().key("forward").arr();
                    r.edges.iter().for_each(|(_, f)| {
                        j.int(i64::from(*f));
                    });
                    j.end_arr();
                }
                None => {
                    j.key("cost").null();
                }
            },
            1 if a.len() >= 3 => {
                let src = a[2..].iter().map(|&x| node(x)).collect::<gw_abi::Result<Vec<_>>>()?;
                let max = if a[1] > 0.0 { a[1] } else { f64::INFINITY };
                let r = g.reach(&src, max);
                for (k, v) in [("cost", &r.node), ("entry", &r.entry)] {
                    j.key(k).arr();
                    for &c in v.iter() {
                        if c.is_finite() {
                            j.num(c);
                        } else {
                            j.null();
                        }
                    }
                    j.end_arr();
                }
            }
            _ => return Err(Error::invalid("network: unknown operation")),
        }
        j.end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}
