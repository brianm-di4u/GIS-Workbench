//! `pointcloud` bundle (lazy; analysis workers): LAS/LAZ headers and CRS keys, record decoding by
//! blocks and LAZ chunks (parallel across workers), the LOD index, gridding, SMRF, profiles and
//! LAS 1.4 export (REQ-LDR-01..10, REQ-FMT-10).

use gw_abi::{set_out, set_out_json, slice, status, Error, Json};
use gw_pointcloud::decode::{decode, has_rgb, Columns, Lattice, RecordSpec};
use gw_pointcloud::grid::{fill, grid, GridSpec, Mode};
use gw_pointcloud::las::{self, KeyValue};
use gw_pointcloud::{laz, lod, profile, smrf, write};

gw_abi::export_abi!();

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn wkt_json(j: &mut Json, w: &las::WktInfo) {
    j.obj();
    j.kv_str("horizontal", &w.horizontal).kv_num("hUnit", w.h_unit).kv_str("hUnitName", &w.h_unit_name);
    j.kv_str("vertical", &w.vertical).kv_num("vUnit", w.v_unit).kv_str("vUnitName", &w.v_unit_name).kv_bool("geographic", w.geographic);
    j.key("hEpsg");
    match w.h_epsg {
        Some(c) => j.int(i64::from(c)),
        None => j.null(),
    };
    j.key("vEpsg");
    match w.v_epsg {
        Some(c) => j.int(i64::from(c)),
        None => j.null(),
    };
    j.end_obj();
}

/// Header, VLRs and CRS of a LAS/LAZ file from its first bytes. When `len` is shorter than the
/// point data offset, only the header is returned with `need` = the bytes to pass.
/// # Safety
/// `b` must hold `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn gw_las_info(b: *const u8, len: usize) -> i32 {
    let b = slice(b, len);
    status((|| {
        let h = las::header(b)?;
        let mut j = Json::new();
        j.obj();
        j.kv_str("version", &format!("{}.{}", h.version.0, h.version.1)).kv_int("format", i64::from(h.format)).kv_bool("compressed", h.compressed);
        j.kv_int("recordLen", i64::from(h.record_len)).kv_num("nPoints", h.n_points as f64).kv_int("headerSize", i64::from(h.header_size));
        j.kv_int("pointOffset", i64::from(h.point_offset)).kv_int("nVlrs", i64::from(h.n_vlrs)).kv_int("globalEncoding", i64::from(h.global_encoding));
        j.kv_int("fileSourceId", i64::from(h.file_source_id)).kv_str("guid", &hex(&h.guid)).kv_str("systemId", &h.system_id).kv_str("software", &h.software);
        j.kv_int("day", i64::from(h.day)).kv_int("year", i64::from(h.year)).kv_num("evlrStart", h.evlr_start as f64).kv_int("nEvlrs", i64::from(h.n_evlrs)).kv_num("waveformStart", h.waveform_start as f64);
        j.kv_int("baseSize", las::base_size(h.format).unwrap_or(0) as i64);
        for (k, v) in [("scale", h.scale), ("offset", h.offset), ("min", h.min), ("max", h.max)] {
            j.key(k).arr();
            for x in v {
                j.num(x);
            }
            j.end_arr();
        }
        j.key("byReturn").arr();
        for x in h.by_return {
            j.num(x as f64);
        }
        j.end_arr();
        if (h.point_offset as usize) > b.len() {
            j.kv_int("need", i64::from(h.point_offset));
            j.end_obj();
            set_out_json(j.finish());
            return Ok(());
        }
        let vl = las::vlrs(b, &h)?;
        let payload = |v: &las::Vlr| &b[v.data_offset as usize..(v.data_offset + v.data_len) as usize];
        j.key("vlrs").arr();
        for v in &vl {
            j.obj().kv_str("user", &v.user_id).kv_int("id", i64::from(v.record_id)).kv_str("desc", &v.description).kv_num("offset", v.data_offset as f64).kv_num("len", v.data_len as f64).end_obj();
        }
        j.end_arr();
        let find = |u: &str, id: u16| vl.iter().find(|v| v.user_id == u && v.record_id == id);
        if let Some(v) = find("LASF_Projection", 2112) {
            let t = String::from_utf8_lossy(payload(v)).trim_end_matches('\0').to_string();
            j.kv_str("wkt", &t);
            j.key("wktInfo");
            wkt_json(&mut j, &las::wkt(&t));
        }
        if let Some(d) = find("LASF_Projection", 34735) {
            let dbl = find("LASF_Projection", 34736).map(payload).unwrap_or(&[]);
            let asc = find("LASF_Projection", 34737).map(payload).unwrap_or(&[]);
            j.key("geoKeys").arr();
            for (id, v) in las::geokeys(payload(d), dbl, asc) {
                j.arr().int(i64::from(id));
                match v {
                    KeyValue::Int(x) => j.int(i64::from(x)),
                    KeyValue::Double(x) => j.num(x),
                    KeyValue::Ascii(s) => j.str(&s),
                };
                j.end_arr();
            }
            j.end_arr();
        }
        if let Some(v) = find("laszip encoded", 22204) {
            let z = laz::vlr(payload(v))?;
            j.key("laz").obj().kv_bool("variable", z.uses_variable_size_chunks()).kv_num("chunkSize", f64::from(z.chunk_size())).kv_num("itemsSize", z.items_size() as f64);
            j.kv_num("vlrOffset", v.data_offset as f64).kv_num("vlrLen", v.data_len as f64);
            j.key("items").arr();
            for it in z.items() {
                j.str(&format!("{:?} v{} ({} B)", it.item_type(), it.version(), it.size()));
            }
            j.end_arr().end_obj();
        }
        j.kv_bool("copc", find("copc", 1).is_some());
        j.end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// EVLR headers from a buffer read at `start` (f64 byte offset) in the file.
/// # Safety
/// `b` must hold `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn gw_las_evlrs(b: *const u8, len: usize, start: f64, count: u32) -> i32 {
    let b = slice(b, len);
    status((|| {
        let mut j = Json::new();
        j.arr();
        for v in las::evlrs(b, start as u64, count) {
            j.obj().kv_str("user", &v.user_id).kv_int("id", i64::from(v.record_id)).kv_str("desc", &v.description).kv_num("offset", v.data_offset as f64).kv_num("len", v.data_len as f64).end_obj();
        }
        j.end_arr();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// Units, vertical CRS and EPSG codes from WKT 1 or 2 (REQ-LDR-03).
/// # Safety
/// `s` must hold `len` bytes of UTF-8.
#[no_mangle]
pub unsafe extern "C" fn gw_wkt_info(s: *const u8, len: usize) -> i32 {
    let t = String::from_utf8_lossy(slice(s, len)).to_string();
    status((|| {
        let mut j = Json::new();
        wkt_json(&mut j, &las::wkt(&t));
        set_out_json(j.finish());
        Ok(())
    })())
}

/// LAZ chunk table: `vlr` = laszip VLR payload, `table` = bytes from the table offset on.
/// Output: f64 pairs (points, bytes) per chunk.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_laz_chunks(vlr: *const u8, vlen: usize, table: *const u8, tlen: usize, n_points: f64) -> i32 {
    let (v, t) = (slice(vlr, vlen), slice(table, tlen));
    status((|| {
        let z = laz::vlr(v)?;
        let c = laz::chunk_table(t, &z, n_points as u64)?;
        let mut b = Vec::with_capacity(c.len() * 16);
        for (p, n) in c {
            b.extend_from_slice(&(p as f64).to_le_bytes());
            b.extend_from_slice(&(n as f64).to_le_bytes());
        }
        set_out(b);
        Ok(())
    })())
}

/// `prm` = [format, record length, scale ×3, offset ×3, t0, lattice…].
fn spec_of(a: &[f64]) -> gw_abi::Result<(RecordSpec, Lattice)> {
    if a.len() < 9 {
        return Err(Error::invalid("decode: bad parameters"));
    }
    let spec = RecordSpec { format: a[0] as u8, record_len: a[1] as usize, scale: [a[2], a[3], a[4]], offset: [a[5], a[6], a[7]], t0: a[8] };
    if las::base_size(spec.format).is_none_or(|b| spec.record_len < b) {
        return Err(Error::invalid("decode: bad format or record length"));
    }
    let lat = if a.len() == 9 { Lattice::identity() } else { Lattice::from_flat(&a[9..]).ok_or_else(|| Error::invalid("decode: bad lattice"))? };
    Ok((spec, lat))
}

/// Decode uncompressed records. Output: the column layout of `Columns::to_bytes`.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_las_decode(prm: *const f64, plen: usize, raw: *const u8, rlen: usize) -> i32 {
    let (a, r) = (slice(prm, plen), slice(raw, rlen));
    status((|| {
        let (spec, lat) = spec_of(a)?;
        let mut c = Columns::with_capacity(r.len() / spec.record_len, has_rgb(spec.format));
        decode(r, &spec, &lat, &mut c);
        set_out(c.to_bytes());
        Ok(())
    })())
}

/// Decode a run of whole LAZ chunks (`chunks` = f64 pairs (points, bytes)) then the records.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_laz_decode(prm: *const f64, plen: usize, vlr: *const u8, vlen: usize, data: *const u8, dlen: usize, chunks: *const f64, clen: usize) -> i32 {
    let (a, v, d, c) = (slice(prm, plen), slice(vlr, vlen), slice(data, dlen), slice(chunks, clen));
    status((|| {
        let (spec, lat) = spec_of(a)?;
        let z = laz::vlr(v)?;
        let ch: Vec<(u64, u64)> = c.chunks_exact(2).map(|p| (p[0] as u64, p[1] as u64)).collect();
        let raw = laz::decode_chunks(&z, d, &ch)?;
        let mut cols = Columns::with_capacity(raw.len() / spec.record_len, has_rgb(spec.format));
        decode(&raw, &spec, &lat, &mut cols);
        set_out(cols.to_bytes());
        Ok(())
    })())
}

/// Decode a streamed LAZ (no chunk table, fixed-size chunks) sequentially (TE-022). `data` starts
/// at the point data, `n` is the point count.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_laz_decode_stream(prm: *const f64, plen: usize, vlr: *const u8, vlen: usize, data: *const u8, dlen: usize, n: f64) -> i32 {
    let (a, v, d) = (slice(prm, plen), slice(vlr, vlen), slice(data, dlen));
    status((|| {
        let (spec, lat) = spec_of(a)?;
        let z = laz::vlr(v)?;
        let raw = laz::decode_stream(&z, d, n as u64)?;
        let mut cols = Columns::with_capacity(raw.len() / spec.record_len, has_rgb(spec.format));
        decode(&raw, &spec, &lat, &mut cols);
        set_out(cols.to_bytes());
        Ok(())
    })())
}

thread_local! {
    static LAST_PERM: std::cell::RefCell<Vec<u32>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The permutation of the last gw_pc_index call: pointer to `len` u32 in linear memory (valid until
/// the next index call or gw_pc_index_release).
#[no_mangle]
pub extern "C" fn gw_pc_index_perm() -> *const u32 {
    LAST_PERM.with(|c| c.borrow().as_ptr())
}

/// Release the last permutation.
#[no_mangle]
pub extern "C" fn gw_pc_index_release() {
    LAST_PERM.with(|c| *c.borrow_mut() = Vec::new());
}

/// LOD index over positions (f32 ×3). Output: [tiles u32] then the permutation (u32 ×n) then per
/// tile f64 [start, count, min ×3, max ×3, levels, counts…].
/// # Safety
/// `pos` must hold `len` f32.
#[no_mangle]
pub unsafe extern "C" fn gw_pc_index(pos: *const f32, len: usize, tile: f64, s0: f64, max_level: u32) -> i32 {
    let p = slice(pos, len);
    status((|| {
        if tile <= 0.0 || s0 <= 0.0 {
            return Err(Error::invalid("index: tile and spacing must be positive"));
        }
        let ix = lod::index(p, tile, s0, max_level as usize);
        // TE-021: the permutation stays in the module (read with gw_pc_index_perm) instead of being
        // copied into the output buffer — one u32 per point less at the peak, which decides whether
        // a 37 M-point 3DEP tile fits under the 1 GiB memory cap.
        let mut b = Vec::with_capacity(8 + ix.tiles.len() * 160);
        b.extend_from_slice(&(ix.tiles.len() as u32).to_le_bytes());
        b.extend_from_slice(&(ix.perm.len() as u32).to_le_bytes());
        for t in &ix.tiles {
            let mut row = vec![t.start as f64, t.count as f64];
            row.extend(t.min.iter().map(|v| f64::from(*v)));
            row.extend(t.max.iter().map(|v| f64::from(*v)));
            row.push(t.levels.len() as f64);
            row.extend(t.levels.iter().map(|v| f64::from(*v)));
            for v in row {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        LAST_PERM.with(|c| *c.borrow_mut() = ix.perm);
        set_out(b);
        Ok(())
    })())
}

/// Grid. `prm` = [e0, n0, ce, cn, w, h, mode, fill iterations]; `mask` (u8 ×n) and `val` (f32 ×n)
/// may be empty. Output: f32 ×w·h.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_pc_grid(pos: *const f32, len: usize, mask: *const u8, mlen: usize, val: *const f32, vlen: usize, prm: *const f64, plen: usize) -> i32 {
    let (p, m, v, a) = (slice(pos, len), slice(mask, mlen), slice(val, vlen), slice(prm, plen));
    status((|| {
        if a.len() != 8 {
            return Err(Error::invalid("grid: bad parameters"));
        }
        let n = p.len() / 3;
        if (mlen != 0 && mlen != n) || (vlen != 0 && vlen != n) {
            return Err(Error::invalid("grid: mask or value length"));
        }
        let g = GridSpec { e0: a[0], n0: a[1], ce: a[2], cn: a[3], w: a[4] as usize, h: a[5] as usize };
        if g.w == 0 || g.h == 0 || g.w * g.h > 64 << 20 || g.ce <= 0.0 || g.cn <= 0.0 {
            return Err(Error::limit(format!("grid: {} × {} posts at {} m is outside 1 … 64 M posts; choose another post spacing", g.w, g.h, g.ce)));
        }
        let mode = Mode::from_code(a[6] as u32).ok_or_else(|| Error::invalid("grid: mode"))?;
        let mut z = grid(p, (mlen > 0).then_some(m), (vlen > 0).then_some(v), &g, mode);
        if a[7] > 0.0 {
            fill(&mut z, g.w, g.h, a[7] as usize);
        }
        let mut b = Vec::with_capacity(4 * z.len());
        for x in z {
            b.extend_from_slice(&x.to_le_bytes());
        }
        set_out(b);
        Ok(())
    })())
}

/// SMRF. `prm` = [cell, slope, window, threshold, scalar, low noise]. Output: u8 per point
/// (2 ground, 1 not ground, 7 low noise, 0 not considered).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_pc_smrf(pos: *const f32, len: usize, mask: *const u8, mlen: usize, prm: *const f64, plen: usize) -> i32 {
    let (p, m, a) = (slice(pos, len), slice(mask, mlen), slice(prm, plen));
    status((|| {
        if a.len() != 6 || a[0] <= 0.0 {
            return Err(Error::invalid("smrf: bad parameters"));
        }
        let pr = smrf::Params { cell: a[0], slope: a[1], window: a[2], threshold: a[3], scalar: a[4], low_noise: a[5] };
        set_out(smrf::smrf(p, (mlen > 0).then_some(m), &pr));
        Ok(())
    })())
}

/// Profile. `prm` = [ax, ay, bx, by, half width, max points]. Output: [count u32], index u32,
/// along f32, across f32 (each ×count).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_pc_profile(pos: *const f32, len: usize, mask: *const u8, mlen: usize, prm: *const f64, plen: usize) -> i32 {
    let (p, m, a) = (slice(pos, len), slice(mask, mlen), slice(prm, plen));
    status((|| {
        if a.len() != 6 {
            return Err(Error::invalid("profile: bad parameters"));
        }
        let r = profile::profile(p, (mlen > 0).then_some(m), [a[0], a[1]], [a[2], a[3]], a[4], a[5] as usize);
        let mut b = Vec::with_capacity(4 + 12 * r.index.len());
        b.extend_from_slice(&(r.index.len() as u32).to_le_bytes());
        for v in &r.index {
            b.extend_from_slice(&v.to_le_bytes());
        }
        for v in r.along.iter().chain(&r.across) {
            b.extend_from_slice(&v.to_le_bytes());
        }
        set_out(b);
        Ok(())
    })())
}

/// LAS 1.4 export. `cols` = the column layout for `n` points (with colours when `rgb` ≠ 0);
/// `inv` = the inverse lattice (local → target); `prm` = [format, scale ×3, day, year, adjusted
/// GPS, t0, compress]; `text` = "WKT\0system id\0software".
/// # Safety
/// The pointers must hold the stated lengths.
/// Write parameters [format, sx, sy, sz, day, year, adjusted_gps, t0, compress] and the text
/// "wkt\0system id\0software".
fn write_spec(a: &[f64], t: &[u8]) -> gw_abi::Result<write::WriteSpec> {
    if a.len() < 9 {
        return Err(Error::invalid("write: bad parameters"));
    }
    let s = String::from_utf8_lossy(t).to_string();
    let mut parts = s.split('\0');
    Ok(write::WriteSpec {
        format: a[0] as u8,
        scale: [a[1], a[2], a[3]],
        day: a[4] as u16,
        year: a[5] as u16,
        adjusted_gps: a[6] != 0.0,
        t0: a[7],
        compress: a[8] != 0.0,
        wkt: parts.next().unwrap_or("").to_string(),
        system_id: parts.next().unwrap_or("").to_string(),
        software: parts.next().unwrap_or("").to_string(),
    })
}

fn columns_of(cb: &[u8], n: u32, rgb: u32, iv: &[f64]) -> gw_abi::Result<(Columns, Lattice)> {
    let c = Columns::from_bytes(cb, n as usize, rgb != 0).ok_or_else(|| Error::invalid("write: column bytes"))?;
    let lat = Lattice::from_flat(iv).ok_or_else(|| Error::invalid("write: bad lattice"))?;
    Ok((c, lat))
}

/// LAS 1.4 / LAZ export of a whole cloud (REQ-LDR-10). Larger clouds go in slabs (below).
/// # Safety
/// The pointer/length pairs must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_las_write(cols: *const u8, clen: usize, n: u32, rgb: u32, inv: *const f64, ilen: usize, prm: *const f64, plen: usize, text: *const u8, tlen: usize) -> i32 {
    let (cb, iv, a, t) = (slice(cols, clen), slice(inv, ilen), slice(prm, plen), slice(text, tlen));
    status((|| {
        let (c, lat) = columns_of(cb, n, rgb, iv)?;
        if a.len() != 9 {
            return Err(Error::invalid("write: bad parameters"));
        }
        set_out(write::write(&c, &lat, &write_spec(a, t)?)?);
        Ok(())
    })())
}

/// Slab export, pass 1: bounds of a slab's target coordinates → f64 [min x, y, z, max x, y, z].
/// # Safety
/// The pointer/length pairs must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_las_bounds(cols: *const u8, clen: usize, n: u32, rgb: u32, inv: *const f64, ilen: usize) -> i32 {
    let (cb, iv) = (slice(cols, clen), slice(inv, ilen));
    status((|| {
        let (c, lat) = columns_of(cb, n, rgb, iv)?;
        let (mn, mx) = write::bounds(&c, &lat);
        set_out(mn.iter().chain(mx.iter()).flat_map(|v| v.to_le_bytes()).collect());
        Ok(())
    })())
}

/// Slab export, pass 2: a slab's records against the offset (prm = write parameters + offset x, y,
/// z), compressed into whole LAZ chunks when compress is set. Out: [u32 chunks][chunks × (u64
/// points, u64 bytes)][15 × u64 by return][record or chunk bytes].
/// # Safety
/// The pointer/length pairs must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_las_slab(cols: *const u8, clen: usize, n: u32, rgb: u32, inv: *const f64, ilen: usize, prm: *const f64, plen: usize) -> i32 {
    let (cb, iv, a) = (slice(cols, clen), slice(inv, ilen), slice(prm, plen));
    status((|| {
        let (c, lat) = columns_of(cb, n, rgb, iv)?;
        if a.len() != 12 {
            return Err(Error::invalid("write: bad slab parameters"));
        }
        let spec = write_spec(a, b"")?;
        let (raw, by_return) = write::points(&c, &lat, &spec, &[a[9], a[10], a[11]])?;
        drop(c);
        let (body, entries) = if spec.compress { laz::compress_chunks(&raw, spec.format, 0)? } else { (raw, Vec::new()) };
        let mut out = Vec::with_capacity(4 + 16 * entries.len() + 120 + body.len());
        out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
        for (p, b) in &entries {
            out.extend_from_slice(&p.to_le_bytes());
            out.extend_from_slice(&b.to_le_bytes());
        }
        for v in by_return {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&body);
        set_out(out);
        Ok(())
    })())
}

/// Slab export, last: header and VLRs (with the LAZ chunk-table offset) and the LAZ chunk table.
/// prm = write parameters + offset (3) + min (3) + max (3) + points + compressed body bytes + by
/// return (15); entries = (points, bytes) per LAZ chunk as f64 pairs. Out: [u32 head length][head][table].
/// # Safety
/// The pointer/length pairs must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_las_head(prm: *const f64, plen: usize, entries: *const f64, elen: usize, text: *const u8, tlen: usize) -> i32 {
    let (a, e, t) = (slice(prm, plen), slice(entries, elen), slice(text, tlen));
    status((|| {
        if a.len() != 9 + 3 + 3 + 3 + 2 + 15 || e.len() % 2 != 0 {
            return Err(Error::invalid("write: bad header parameters"));
        }
        let spec = write_spec(a, t)?;
        let v3 = |i: usize| [a[i], a[i + 1], a[i + 2]];
        let by_return: [u64; 15] = std::array::from_fn(|k| a[20 + k] as u64);
        let ents: Vec<(u64, u64)> = e.chunks_exact(2).map(|p| (p[0] as u64, p[1] as u64)).collect();
        let laz_part = spec.compress.then_some((&ents[..], a[19] as u64));
        let head = write::head(&spec, a[18] as usize, &v3(9), &v3(12), &v3(15), &by_return, laz_part)?;
        let table = if spec.compress { laz::laz_table(&ents, spec.format, 0)?.1 } else { Vec::new() };
        let mut out = Vec::with_capacity(4 + head.len() + table.len());
        out.extend_from_slice(&(head.len() as u32).to_le_bytes());
        out.extend(head);
        out.extend(table);
        set_out(out);
        Ok(())
    })())
}
