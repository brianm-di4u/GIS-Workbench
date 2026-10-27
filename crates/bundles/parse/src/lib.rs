//! `parse` bundle (lazy; decode worker): hardened readers for untrusted files.
//! Inputs are byte ranges the worker read with `File.slice`; outputs are JSON metadata or
//! unpacked pixel planes in the output buffer.

use gw_abi::{set_out, set_out_json, slice, status, Error};
use gw_parse::{dted, nitf, pixels, tre};

gw_abi::export_abi!();

/// NITF file header → JSON. RANGE error "need HL=<n>" asks for a longer prefix.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_nitf_file_header(ptr: *const u8, len: usize, file_size: f64) -> i32 {
    status(nitf::file_header(slice(ptr, len), file_size as u64).map(set_out_json))
}

/// One image subheader → JSON. `base` = its file offset (for TRE offsets).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_nitf_image_subheader(ptr: *const u8, len: usize, base: f64, v21: i32) -> i32 {
    status(nitf::image_subheader(slice(ptr, len), base as u64, v21 != 0).map(set_out_json))
}

/// Graphic/text/DES/RES subheader → JSON. kind: 1 graphic, 2 text, 3 des, 4 res, 5 label.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_nitf_other_subheader(kind: i32, ptr: *const u8, len: usize, v21: i32) -> i32 {
    let k = match kind {
        1 => "graphic",
        2 => "text",
        3 => "des",
        4 => "res",
        5 => "label",
        _ => return status::<()>(Err(Error::invalid("unknown segment kind"))),
    };
    status(nitf::other_subheader(k, slice(ptr, len), v21 != 0).map(set_out_json))
}

/// Image data mask table → JSON.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_nitf_mask_table(ptr: *const u8, len: usize, nblocks: usize, nbpp: u32) -> i32 {
    status(nitf::mask_table(slice(ptr, len), nblocks, nbpp).map(set_out_json))
}

/// Output sample type for (NBPP, PVTYPE code); negative status on unsupported types.
#[no_mangle]
pub extern "C" fn gw_nitf_sample_type(nbpp: u32, pvtype: i32) -> i32 {
    match pixels::sample_type(nbpp, pvtype) {
        Ok(t) => t,
        Err(e) => -status::<()>(Err(e)),
    }
}

/// Unpack one uncompressed block into band-sequential planes (out buffer).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_nitf_unpack(ptr: *const u8, len: usize, w: usize, h: usize, nbands: usize, nbpp: u32, abpp: u32, pjust_left: i32, pvtype: i32, imode: u32) -> i32 {
    status(pixels::unpack_block(slice(ptr, len), w, h, nbands, nbpp, abpp, pjust_left != 0, pvtype, imode as u8).map(|(_, b)| set_out(b)))
}

/// Decode one TRE through the catalogue → JSON (for metadata browsing).
/// # Safety
/// `tag`/`data` buffers must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_tre_decode(tag: *const u8, tag_len: usize, data: *const u8, len: usize) -> i32 {
    let t = String::from_utf8_lossy(slice(tag, tag_len)).to_string();
    let tr = tre::Tre { tag: t, data: slice(data, len), offset: 0 };
    let mut j = gw_abi::Json::new();
    tre::to_json(&mut j, std::slice::from_ref(&tr));
    set_out_json(j.finish());
    gw_abi::OK
}

/// DTED → out = [json_len u32 LE][json][f32 heights north→south]. Header numbers in JSON.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_dted_parse(ptr: *const u8, len: usize) -> i32 {
    status(dted::parse_dted(slice(ptr, len)).map(pack_dem))
}

/// SRTM HGT → same output layout as `gw_dted_parse`.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_hgt_parse(ptr: *const u8, len: usize, sw_lat: f64, sw_lon: f64) -> i32 {
    status(dted::parse_hgt(slice(ptr, len), sw_lat, sw_lon).map(pack_dem))
}

fn pack_dem(d: dted::Dted) {
    let jb = d.json.into_bytes();
    let mut out = Vec::with_capacity(4 + jb.len() + 4 + d.heights.len() * 4);
    out.extend_from_slice(&(jb.len() as u32).to_le_bytes());
    out.extend_from_slice(&jb);
    while out.len() % 4 != 0 {
        out.push(b' ');
    }
    for h in &d.heights {
        out.extend_from_slice(&h.to_le_bytes());
    }
    set_out(out);
}

/// Decode one NITF JPEG block (IC=C3/M3): 8- or 12-bit, NITF default tables when absent.
/// `qlevel` > 0 overrides the APP6 Q level; `raw` = 1 keeps 3-component data as coded.
/// Output: gw-codec raster encoding (16-byte header, planar samples).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_jpeg_decode(ptr: *const u8, len: usize, qlevel: u32, raw: u32) -> i32 {
    status(gw_codec::jpeg::decode(slice(ptr, len), qlevel, raw).map(|r| set_out(gw_codec::encode(&r))))
}

/// RPF location table from RPFIMG TRE bytes → JSON [[id, size, offset], …].
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_rpf_locations(ptr: *const u8, len: usize) -> i32 {
    status(gw_codec::vq::rpf_locations(slice(ptr, len)).map(|v| {
        let rows: Vec<String> = v.iter().map(|(id, size, off)| format!("[{id},{size},{off}]")).collect();
        set_out_json(format!("[{}]", rows.join(",")))
    }))
}

/// Kernel tables (65 536 bytes) from an RPF compression lookup subsection.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_vq_luts(ptr: *const u8, len: usize) -> i32 {
    status(gw_codec::vq::luts(slice(ptr, len)).map(set_out))
}

/// Expand one VQ block (6144 code bytes) with tables (65 536 bytes) → 256×256 bytes.
/// # Safety
/// Both ranges must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_vq_decode(codes: *const u8, ncodes: usize, luts: *const u8, nluts: usize) -> i32 {
    status(gw_codec::vq::decode_block(slice(codes, ncodes), slice(luts, nluts)).map(set_out))
}

/// Decode one T.4 bi-level block → width×height bytes (1 white, 0 black). `mode2d` = 1
/// means COMRAT asked for two-dimensional coding.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_t4_decode(ptr: *const u8, len: usize, width: u32, height: u32, mode2d: u32) -> i32 {
    status(gw_codec::t4::decode(slice(ptr, len), width, height, if mode2d != 0 { "2DS" } else { "1D" }).map(set_out))
}

/// SICD/SIDD/CPHD XML metadata (REQ-SAR-01/02/12, REQ-FMT-08) → JSON {kind, version, …summary,
/// record (SICD Vol. 3 / SIDD PlaneProjection record or null), recordError, tree}. `tree` = 1
/// adds the whole element tree for the metadata panel.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_xml(ptr: *const u8, len: usize, tree: i32) -> i32 {
    let b = slice(ptr, len);
    status((|| {
        let root = gw_parse::xml::parse(b)?;
        let ns = gw_parse::xml::root_namespace(b).unwrap_or_default();
        let mut j = gw_abi::Json::new();
        j.obj();
        let rec = match root.name.as_str() {
            "SICD" => {
                gw_parse::sicd::summary(&root, &ns, &mut j);
                gw_parse::sicd::record(&root)
            }
            "SIDD" => {
                gw_parse::sicd::sidd_summary(&root, &ns, &mut j);
                gw_parse::sicd::sidd_plane_record(&root)
            }
            "CPHD" => {
                j.kv_str("kind", "CPHD").kv_str("namespace", &ns);
                Err(Error::unsupported("CPHD phase history has no image to project"))
            }
            other => return Err(Error::invalid(format!("XML root <{other}> is not SICD, SIDD or CPHD"))),
        };
        match rec {
            Ok(r) => {
                j.key("record").arr();
                for v in r {
                    j.num(v);
                }
                j.end_arr();
                j.key("recordError").null();
            }
            Err(e) => {
                j.key("record").null();
                j.kv_str("recordError", &e.msg);
            }
        }
        if tree != 0 {
            j.key("tree");
            root.to_json(&mut j);
        }
        j.end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// ENVI header (REQ-MSI-01, REQ-FMT-09) → JSON. `data_len` = size of the data file (0 = unknown).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_envi_header(ptr: *const u8, len: usize, data_len: f64) -> i32 {
    status(gw_parse::envi::parse(slice(ptr, len)).and_then(|h| gw_parse::envi::to_json(&h, data_len as u64)).map(set_out_json))
}

/// Radiometric metadata (REQ-MSI-05): kind 1 Landsat MTL, 2 Sentinel-2 MTD XML, 3 WorldView IMD.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_msi_meta(kind: i32, ptr: *const u8, len: usize) -> i32 {
    let b = slice(ptr, len);
    status(match kind {
        1 => gw_parse::msimeta::landsat_mtl(b),
        2 => gw_parse::msimeta::sentinel2_mtd(b),
        3 => gw_parse::msimeta::worldview_imd(b),
        _ => Err(Error::invalid("unknown metadata kind")),
    }
    .map(set_out_json))
}

/// Any XML document → its element tree JSON {n, a, t, c} (GDAL metadata, library headers).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_xml_tree(ptr: *const u8, len: usize) -> i32 {
    status(gw_parse::xml::parse(slice(ptr, len)).map(|root| {
        let mut j = gw_abi::Json::new();
        root.to_json(&mut j);
        set_out_json(j.finish());
    }))
}

thread_local! {
    static DEMUXERS: std::cell::RefCell<std::collections::HashMap<i32, gw_parse::ts::Demux>> = std::cell::RefCell::new(std::collections::HashMap::new());
    static NEXT_DEMUX: std::cell::Cell<i32> = const { std::cell::Cell::new(1) };
}

/// Start an MPEG-TS index (REQ-FMV-01); returns its id.
#[no_mangle]
pub extern "C" fn gw_ts_open() -> i32 {
    let id = NEXT_DEMUX.with(|n| {
        let v = n.get();
        n.set(v + 1);
        v
    });
    DEMUXERS.with(|d| d.borrow_mut().insert(id, gw_parse::ts::Demux::new()));
    id
}

/// Feed the next contiguous block of the file (starting at file offset `base`).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_ts_push(id: i32, ptr: *const u8, len: usize, base: f64) -> i32 {
    let b = slice(ptr, len);
    DEMUXERS.with(|d| match d.borrow_mut().get_mut(&id) {
        Some(m) => status(m.push(b, base as u64)),
        None => status::<()>(Err(Error::invalid("no such TS index"))),
    })
}

/// Finish and free the index → JSON (streams, video AU index, KLV packets with decoded items).
#[no_mangle]
pub extern "C" fn gw_ts_finish(id: i32) -> i32 {
    DEMUXERS.with(|d| match d.borrow_mut().remove(&id) {
        Some(mut m) => {
            m.finish();
            set_out_json(m.to_json());
            0
        }
        None => status::<()>(Err(Error::invalid("no such TS index"))),
    })
}

/// Complete PES packets of `pid` in a block at file offset `base` (`at_end`: the block ends the
/// file, so its last PES is complete) → packed
/// `[u32 json len][json {pes:[[pts, off, len]…]}][pad4][payload bytes]`.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_ts_pes(ptr: *const u8, len: usize, base: f64, pid: u32, at_end: i32) -> i32 {
    let (data, idx) = gw_parse::ts::extract_pes(slice(ptr, len), base as u64, pid as u16, at_end != 0);
    let mut j = gw_abi::Json::new();
    j.obj().key("pes").arr();
    for (pts, off, n) in &idx {
        j.arr();
        match pts {
            Some(p) => j.num(*p as f64),
            None => j.null(),
        };
        j.num(*off as f64).int(*n as i64).end_arr();
    }
    j.end_arr().end_obj();
    let js = j.finish().into_bytes();
    let mut out = (js.len() as u32).to_le_bytes().to_vec();
    out.extend(js);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    out.extend(data);
    set_out(out);
    0
}

/// Standalone KLV bytes (one or more packets) → JSON (REQ-FMV-02).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_klv_decode(ptr: *const u8, len: usize) -> i32 {
    set_out_json(gw_parse::klv::to_json(&gw_parse::klv::decode_packets(slice(ptr, len))));
    0
}

/// STANAG 4607 file → JSON (REQ-FMV-11).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_s4607(ptr: *const u8, len: usize) -> i32 {
    status(gw_parse::s4607::parse(slice(ptr, len)).map(|f| set_out_json(gw_parse::s4607::to_json(&f))))
}

/// GeoPDF pages, viewports and images → JSON (REQ-FMT-14).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_pdf_scan(ptr: *const u8, len: usize) -> i32 {
    status(gw_parse::pdf::Pdf::scan(slice(ptr, len)).and_then(|p| gw_parse::pdf::to_json(&p)).map(set_out_json))
}

/// Image placements (`cm … Do`) in a content stream the caller has already decoded → JSON.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_pdf_placements(ptr: *const u8, len: usize) -> i32 {
    set_out_json(gw_parse::pdf::placements_json(slice(ptr, len)));
    0
}
