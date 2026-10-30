//! NITF 2.1 / NSIF 1.0 / NITF 2.0 reader (REQ-FMT-01, REQ-SEC-04). Layout: `Research/14` §2.
//! The reader works on byte ranges supplied by the decode worker: first the file header,
//! then each subheader, then the mask table of masked images. All lengths are checked
//! against the declared file size before any offset is returned.

use crate::bytes::{printable, Reader};
use crate::tre;
use gw_abi::{Error, Json, Result};

pub const SECURITY_FIELDS_21: [(&str, usize); 15] = [
    ("CLSY", 2),
    ("CODE", 11),
    ("CTLH", 2),
    ("REL", 20),
    ("DCTP", 2),
    ("DCDT", 8),
    ("DCXM", 4),
    ("DG", 1),
    ("DGDT", 8),
    ("CLTX", 43),
    ("CATP", 1),
    ("CAUT", 40),
    ("CRSN", 1),
    ("SRDT", 8),
    ("CTLN", 15),
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Version {
    V20,
    V21,
}

#[derive(Clone, Debug, Default)]
pub struct Security {
    pub clas: String,
    pub fields: Vec<(String, String)>,
}

fn read_security(r: &mut Reader, prefix: &str, v: Version) -> Result<Security> {
    let clas = r.trimmed(1)?;
    let mut fields = Vec::new();
    match v {
        Version::V21 => {
            for (name, n) in SECURITY_FIELDS_21 {
                fields.push((format!("{prefix}{name}"), r.trimmed(n)?));
            }
        }
        Version::V20 => {
            for (name, n) in [("CODE", 40), ("CTLH", 40), ("REL", 40), ("CAUT", 20), ("CTLN", 20)] {
                fields.push((format!("{prefix}{name}"), r.trimmed(n)?));
            }
            let dwng = r.trimmed(6)?;
            fields.push((format!("{prefix}DWNG"), dwng.clone()));
            if dwng == "999998" {
                fields.push((format!("{prefix}DEVT"), r.trimmed(40)?));
            }
        }
    }
    Ok(Security { clas, fields })
}

fn security_json(j: &mut Json, s: &Security) {
    j.obj().kv_str("class", &s.clas);
    for (k, v) in &s.fields {
        j.kv_str(k, v);
    }
    j.end_obj();
}

#[derive(Clone, Debug)]
pub struct SegmentInfo {
    pub kind: &'static str,
    pub subheader_offset: u64,
    pub subheader_len: u64,
    pub data_offset: u64,
    pub data_len: u64,
}

/// A user-defined or extended data area of `len` bytes: a 3-digit overflow pointer and TREs
/// (NITF 2.0/2.1), or free-form user data (NITF 1.1, `raw`, or an area that does not start with
/// a number), which is skipped. TRE offsets are reported from `base`.
fn tre_area_at<'a>(r: &mut Reader<'a>, len: usize, raw: bool, base: usize) -> Result<Option<Vec<tre::Tre<'a>>>> {
    if len == 0 {
        return Ok(None);
    }
    let start = r.pos;
    let pointer = len >= 3 && r.b.get(start..start + 3).is_some_and(|h| h.iter().all(u8::is_ascii_digit));
    if raw || !pointer {
        r.bytes(len)?;
        return Ok(None);
    }
    r.bytes(3)?;
    let area = r.bytes(len - 3)?;
    Ok(Some(tre::split(area, base + start + 3)?))
}

fn tre_area<'a>(r: &mut Reader<'a>, len: usize, raw: bool) -> Result<Option<Vec<tre::Tre<'a>>>> {
    tre_area_at(r, len, raw, 0)
}

/// Parse the file header. `b` must start at offset 0 and hold at least HL bytes; when it
/// is shorter, the error is RANGE and its message starts with "need HL=<n>".
pub fn file_header(b: &[u8], file_size: u64) -> Result<String> {
    let mut r = Reader::new(b);
    let fhdr = r.text(4)?;
    let fver = r.text(5)?;
    let version = match (fhdr.as_str(), fver.as_str()) {
        ("NITF", "02.10") | ("NSIF", "01.00") => Version::V21,
        // NITF 1.1 (1989) file and image subheaders have the NITF 2.0 field layout (TE archive 2.0.4:
        // the six JITC 1.1 conformance files parse field for field); read with it and say so.
        ("NITF", "02.00") | ("NITF", "01.10") => Version::V20,
        _ => return Err(Error::unsupported(format!("not a NITF 1.1/2.0/2.1 or NSIF 1.0 file (header \"{}{}\")", printable(fhdr.as_bytes(), 4), printable(fver.as_bytes(), 5)))),
    };
    let clevel = r.trimmed(2)?;
    let stype = r.trimmed(4)?;
    let ostaid = r.trimmed(10)?;
    let fdt = r.trimmed(14)?;
    let ftitle = r.trimmed(80)?;
    let sec = read_security(&mut r, "FS", version)?;
    let fscop = r.trimmed(5)?;
    let fscpys = r.trimmed(5)?;
    let encryp = r.trimmed(1)?;
    let fbkgc = if version == Version::V21 { Some(r.bytes(3)?.to_vec()) } else { None };
    let oname = r.trimmed(if version == Version::V21 { 24 } else { 27 })?;
    let ophone = r.trimmed(18)?;
    let fl = r.num(12, "FL")?;
    let hl = r.num(6, "HL")?;
    if (b.len() as u64) < hl {
        return Err(Error::range(format!("need HL={hl}")));
    }
    if encryp != "0" && !encryp.is_empty() {
        return Err(Error::unsupported("encrypted NITF files are not supported (ENCRYP != 0)"));
    }
    let mut segs: Vec<SegmentInfo> = Vec::new();
    let mut lens: Vec<(&'static str, u64, u64)> = Vec::new();
    let mut groups: Vec<(&'static str, usize, usize)> = vec![("image", 6, 10), ("graphic", 4, 6)];
    if version == Version::V20 {
        groups.push(("label", 4, 3));
    } else {
        groups.push(("reserved", 0, 0));
    }
    groups.extend_from_slice(&[("text", 4, 5), ("des", 4, 9), ("res", 4, 7)]);
    for (kind, sh, dl) in groups {
        let n = r.num(3, "segment count")? as usize;
        if kind == "reserved" {
            if n != 0 {
                return Err(Error::invalid("NUMX must be 0"));
            }
            continue;
        }
        for _ in 0..n {
            let s = r.num(sh, "subheader length")?;
            let d = r.num(dl, "data length")?;
            lens.push((kind, s, d));
        }
    }
    let udhdl = r.num(5, "UDHDL")? as usize;
    let mut header_tres_json = String::from("[]");
    if let Some(t) = tre_area(&mut r, udhdl, fver == "01.10")? {
        let mut jj = Json::new();
        tre::to_json(&mut jj, &t);
        header_tres_json = jj.finish();
    }
    let xhdl = r.num(5, "XHDL")? as usize;
    let mut ext_tres_json = String::from("[]");
    if let Some(t) = tre_area(&mut r, xhdl, fver == "01.10")? {
        let mut jj = Json::new();
        tre::to_json(&mut jj, &t);
        ext_tres_json = jj.finish();
    }
    // Segment offsets.
    let mut off = hl;
    for (kind, s, d) in lens {
        let seg = SegmentInfo { kind, subheader_offset: off, subheader_len: s, data_offset: off + s, data_len: d };
        off = off.checked_add(s).and_then(|v| v.checked_add(d)).ok_or_else(|| Error::range("segment lengths overflow"))?;
        segs.push(seg);
    }
    let mut warnings: Vec<String> = Vec::new();
    if fver == "01.10" {
        warnings.push("NITF 1.1: read with the NITF 2.0 layout".to_string());
    }
    if off > file_size {
        warnings.push(format!("segments end at byte {off}, beyond the file size {file_size}; the file is truncated"));
    }
    if fl != 999_999_999_999 && fl != file_size {
        warnings.push(format!("FL = {fl} but the file has {file_size} bytes"));
    }
    let mut j = Json::new();
    j.obj();
    j.kv_str("format", if fhdr == "NSIF" { "NSIF" } else { "NITF" });
    j.kv_str("version", &fver);
    j.kv_str("CLEVEL", &clevel).kv_str("STYPE", &stype).kv_str("OSTAID", &ostaid).kv_str("FDT", &fdt).kv_str("FTITLE", &ftitle);
    j.key("security");
    security_json(&mut j, &sec);
    j.kv_str("FSCOP", &fscop).kv_str("FSCPYS", &fscpys).kv_str("ONAME", &oname).kv_str("OPHONE", &ophone);
    if let Some(c) = fbkgc {
        j.key("FBKGC").arr().int(c[0] as i64).int(c[1] as i64).int(c[2] as i64).end_arr();
    }
    j.kv_int("FL", fl as i64).kv_int("HL", hl as i64);
    j.key("segments").arr();
    for s in &segs {
        j.obj()
            .kv_str("kind", s.kind)
            .kv_int("subheaderOffset", s.subheader_offset as i64)
            .kv_int("subheaderLength", s.subheader_len as i64)
            .kv_int("dataOffset", s.data_offset as i64)
            .kv_int("dataLength", s.data_len as i64)
            .end_obj();
    }
    j.end_arr();
    j.key("tres").raw(&header_tres_json);
    j.key("extTres").raw(&ext_tres_json);
    j.key("warnings").arr();
    for w in &warnings {
        j.str(w);
    }
    j.end_arr();
    j.end_obj();
    Ok(j.finish())
}

/// Parse IGEOLO corners into (lat, lon) pairs; returns None when the format is unknown or
/// the text does not parse. MGRS ('U') and UTM ('N'/'S') need the geodesy module, so they
/// are returned as raw text for the caller to convert.
fn igeolo_geographic(icords: &str, igeolo: &str) -> Option<[(f64, f64); 4]> {
    let mut out = [(0.0, 0.0); 4];
    let g = igeolo.as_bytes();
    if g.len() < 60 {
        return None;
    }
    for (k, o) in out.iter_mut().enumerate() {
        let s = std::str::from_utf8(&g[k * 15..k * 15 + 15]).ok()?;
        *o = match icords {
            "G" | "C" => {
                let dms = |t: &str, dd: usize| -> Option<f64> {
                    let d: f64 = t.get(..dd)?.trim().parse().ok()?;
                    let m: f64 = t.get(dd..dd + 2)?.trim().parse().ok()?;
                    let s: f64 = t.get(dd + 2..dd + 4)?.trim().parse().ok()?;
                    Some(d + m / 60.0 + s / 3600.0)
                };
                let lat = dms(&s[0..6], 2)? * if &s[6..7] == "S" { -1.0 } else { 1.0 };
                let lon = dms(&s[7..14], 3)? * if &s[14..15] == "W" { -1.0 } else { 1.0 };
                // TE-026: NITF 2.0 ICORDS "C" gives geocentric latitudes; convert to geodetic
                // (WGS 84 e² = 0.00669437999014): 0.18° at 33° N, ~20 km.
                let lat = if icords == "C" && lat.abs() < 90.0 { (lat.to_radians().tan() / (1.0 - 0.006_694_379_990_14)).atan().to_degrees() } else { lat };
                (lat, lon)
            }
            "D" => {
                let lat: f64 = s[0..7].trim().parse().ok()?;
                let lon: f64 = s[7..15].trim().parse().ok()?;
                (lat, lon)
            }
            _ => return None,
        };
    }
    Some(out)
}

fn f(s: &str) -> f64 {
    s.trim().parse::<f64>().unwrap_or(f64::NAN)
}

/// Parse one image subheader (the bytes of exactly that subheader). `base` is its offset in
/// the file, used to report TRE offsets.
pub fn image_subheader(b: &[u8], base: u64, version21: bool) -> Result<String> {
    image_subheader_v(b, base, version21 as u8)
}

/// As image_subheader, by version: 0 = NITF 2.0, 1 = NITF 2.1 / NSIF 1.0, 2 = NITF 1.1. A NITF 1.1
/// subheader has the 2.0 fields except that ISORCE is 80 characters and NROWS…PJUST are absent:
/// the size follows from the blocks (NBPC × NPPBV rows, NBPR × NPPBH columns), ABPP = NBPP, and the
/// representation from the band codes.
pub fn image_subheader_v(b: &[u8], base: u64, ver: u8) -> Result<String> {
    let version21 = ver == 1;
    let v11 = ver == 2;
    let v = if version21 { Version::V21 } else { Version::V20 };
    let mut r = Reader::new(b);
    if r.text(2)? != "IM" {
        return Err(Error::invalid("image subheader does not start with IM"));
    }
    let iid1 = r.trimmed(10)?;
    let idatim = r.trimmed(14)?;
    let tgtid = r.trimmed(17)?;
    let iid2 = r.trimmed(80)?;
    let sec = read_security(&mut r, "IS", v)?;
    let encryp = r.trimmed(1)?;
    let (isorce, mut nrows, mut ncols, pvtype, mut irep, icat, mut abpp, pjust) = if v11 {
        (r.trimmed(80)?, 0, 0, String::from("INT"), String::new(), String::from("VIS"), 0, String::from("R"))
    } else {
        (r.trimmed(42)?, r.num(8, "NROWS")?, r.num(8, "NCOLS")?, r.trimmed(3)?, r.trimmed(8)?, r.trimmed(8)?, r.num(2, "ABPP")?, r.trimmed(1)?)
    };
    let mut band_reps: Vec<String> = Vec::new();
    let icords = r.text(1)?;
    let icords_t = icords.trim().to_string();
    let has_geo = if version21 { !icords_t.is_empty() } else { icords_t != "N" && !icords_t.is_empty() };
    let igeolo = if has_geo { r.text(60)? } else { String::new() };
    let nicom = r.num(1, "NICOM")? as usize;
    let mut icom = Vec::new();
    for _ in 0..nicom {
        icom.push(r.trimmed(80)?);
    }
    let ic = r.trimmed(2)?;
    let comrat = if ic != "NC" && ic != "NM" { r.trimmed(4)? } else { String::new() };
    let mut nbands = r.num(1, "NBANDS")?;
    if nbands == 0 && version21 {
        nbands = r.num(5, "XBANDS")?;
    }
    if nbands == 0 {
        return Err(Error::invalid("image has zero bands"));
    }
    if nbands > 99_999 {
        return Err(Error::limit("too many bands"));
    }
    let mut bands = Json::new();
    bands.arr();
    for _ in 0..nbands {
        let irepband = r.trimmed(2)?;
        band_reps.push(irepband.clone());
        let isubcat = r.trimmed(6)?;
        let ifc = r.trimmed(1)?;
        let imflt = r.trimmed(3)?;
        let nluts = r.num(1, "NLUTS")? as usize;
        bands.obj().kv_str("IREPBAND", &irepband).kv_str("ISUBCAT", &isubcat).kv_str("IFC", &ifc).kv_str("IMFLT", &imflt).kv_int("NLUTS", nluts as i64);
        if nluts > 0 {
            let nelut = r.num(5, "NELUT")? as usize;
            bands.kv_int("NELUT", nelut as i64);
            bands.key("LUT").arr();
            for _ in 0..nluts {
                let lut = r.bytes(nelut)?;
                bands.arr();
                for &x in lut {
                    bands.int(x as i64);
                }
                bands.end_arr();
            }
            bands.end_arr();
        }
        bands.end_obj();
    }
    bands.end_arr();
    let isync = r.trimmed(1)?;
    let imode = r.trimmed(1)?;
    let nbpr = r.num(4, "NBPR")?;
    let nbpc = r.num(4, "NBPC")?;
    let mut nppbh = r.num(4, "NPPBH")?;
    let mut nppbv = r.num(4, "NPPBV")?;
    let nbpp = r.num(2, "NBPP")?;
    let idlvl = r.num(3, "IDLVL")?;
    let ialvl = r.num(3, "IALVL")?;
    let iloc = r.text(10)?;
    let imag = r.trimmed(4)?;
    if v11 {
        nrows = nbpc.saturating_mul(nppbv);
        ncols = nbpr.saturating_mul(nppbh);
        abpp = nbpp;
        let reps: Vec<&str> = band_reps.iter().map(|x| x.as_str()).collect();
        irep = match reps.as_slice() {
            ["R", "G", "B"] => "RGB",
            [_] => "MONO",
            _ => "MULTI",
        }
        .to_string();
    }
    if nppbh == 0 && nbpr == 1 {
        nppbh = ncols;
    }
    if nppbv == 0 && nbpc == 1 {
        nppbv = nrows;
    }
    if nrows == 0 || ncols == 0 || nbpr == 0 || nbpc == 0 || nppbh == 0 || nppbv == 0 {
        return Err(Error::invalid("image or block dimensions are zero"));
    }
    if nbpr.saturating_mul(nppbh) < ncols || nbpc.saturating_mul(nppbv) < nrows {
        return Err(Error::invalid("blocks do not cover the image"));
    }
    if !(1..=64).contains(&nbpp) {
        return Err(Error::invalid(format!("NBPP {nbpp} not supported")));
    }
    // TRE areas.
    let mut tres_all: Vec<tre::Tre> = Vec::new();
    let udidl = r.num(5, "UDIDL")? as usize;
    if let Some(t) = tre_area_at(&mut r, udidl, false, base as usize)? {
        tres_all.extend(t);
    }
    let ixshdl = r.num(5, "IXSHDL")? as usize;
    if let Some(t) = tre_area_at(&mut r, ixshdl, false, base as usize)? {
        tres_all.extend(t);
    }
    // Derived: RPC record and ICHIPB.
    let mut rpc_record: Option<Vec<f64>> = None;
    let mut rpc_kind = "";
    let mut ichipb: Option<[f64; 6]> = None;
    let mut chip_full_size: Option<(f64, f64)> = None;
    let mut sun: Option<(f64, f64)> = None;
    // BANDSB (REQ-MSI-01, AC-13.4): per-band identifiers, centre wavelengths, FWHM, bad bands.
    let mut bandsb: Option<String> = None;
    for t in &tres_all {
        if t.tag == "RPC00B" || t.tag == "RPC00A" {
            let (fl, complete, _) = tre::decode(&t.tag, t.data);
            let get = |n: &str| tre::field(&fl, n).map(f).unwrap_or(f64::NAN);
            if complete && tre::field(&fl, "SUCCESS").map(str::trim) != Some("0") {
                let names = ["ERR_BIAS", "ERR_RAND", "LINE_OFF", "SAMP_OFF", "LAT_OFF", "LONG_OFF", "HEIGHT_OFF", "LINE_SCALE", "SAMP_SCALE", "LAT_SCALE", "LONG_SCALE", "HEIGHT_SCALE"];
                let mut rec: Vec<f64> = names.iter().map(|n| get(n)).collect();
                let remap = t.tag == "RPC00A";
                for arr in ["LINE_NUM_COEFF", "LINE_DEN_COEFF", "SAMP_NUM_COEFF", "SAMP_DEN_COEFF"] {
                    let c: Vec<f64> = (0..20).map(|i| get(&format!("{arr}[{i}].{arr}"))).collect();
                    for k in 0..20 {
                        rec.push(if remap { c[RPC00A_TO_B[k]] } else { c[k] });
                    }
                }
                rpc_record = Some(rec);
                rpc_kind = if remap { "RPC00A" } else { "RPC00B" };
            }
        } else if t.tag == "ICHIPB" {
            let (fl, complete, _) = tre::decode("ICHIPB", t.data);
            if complete {
                let g = |n: &str| tre::field(&fl, n).map(f).unwrap_or(f64::NAN);
                // Corners in (row, col); fit chip (x=col, y=row) → full (x, y).
                let op = [(g("OP_COL_11"), g("OP_ROW_11")), (g("OP_COL_12"), g("OP_ROW_12")), (g("OP_COL_21"), g("OP_ROW_21")), (g("OP_COL_22"), g("OP_ROW_22"))];
                let fi = [(g("FI_COL_11"), g("FI_ROW_11")), (g("FI_COL_12"), g("FI_ROW_12")), (g("FI_COL_21"), g("FI_ROW_21")), (g("FI_COL_22"), g("FI_ROW_22"))];
                if let Some(a) = fit_affine(&op, &fi) {
                    ichipb = Some(a);
                }
                chip_full_size = Some((g("FI_COL"), g("FI_ROW")));
            }
        } else if t.tag == "BANDSB" {
            let (fl, _, _) = tre::decode("BANDSB", t.data);
            let n = tre::field(&fl, "COUNT").map(f).unwrap_or(0.0) as usize;
            let unit = tre::field(&fl, "WAVE_LENGTH_UNIT").map(str::trim).unwrap_or("");
            let mut b = Json::new();
            b.obj().kv_int("count", n as i64).kv_str("quantity", tre::field(&fl, "RADIOMETRIC_QUANTITY").map(str::trim).unwrap_or(""));
            b.kv_str("quantityUnit", tre::field(&fl, "RADIOMETRIC_QUANTITY_UNIT").map(str::trim).unwrap_or("")).kv_str("waveUnit", unit);
            b.kv_num("scale", tre::field(&fl, "SCALE_FACTOR").map(f).unwrap_or(f64::NAN)).kv_num("offset", tre::field(&fl, "ADDITIVE_FACTOR").map(f).unwrap_or(f64::NAN));
            b.key("bands").arr();
            for i in 0..n.min(99_999) {
                let g = |k: &str| tre::field(&fl, &format!("BANDS[{i}].{k}"));
                b.obj().kv_str("id", g("BANDID").map(str::trim).unwrap_or(""));
                // Micrometres (U) or wavenumbers (W, cm⁻¹) → micrometres.
                let wl = |v: Option<&str>| {
                    let x = v.map(f).unwrap_or(f64::NAN);
                    if unit == "W" && x > 0.0 {
                        1e4 / x
                    } else {
                        x
                    }
                };
                b.kv_num("cw", wl(g("CWAVE"))).kv_num("fwhm", if unit == "W" { f64::NAN } else { g("FWHM").map(f).unwrap_or(f64::NAN) });
                b.kv_bool("bad", g("BAD_BAND").map(str::trim) == Some("1"));
                b.end_obj();
            }
            b.end_arr().end_obj();
            bandsb = Some(b.finish());
        } else if t.tag == "USE00A" {
            let (fl, _, _) = tre::decode("USE00A", t.data);
            let az = tre::field(&fl, "SUN_AZ").map(f).unwrap_or(f64::NAN);
            let el = tre::field(&fl, "SUN_EL").map(f).unwrap_or(f64::NAN);
            if az.is_finite() && el.is_finite() && el.abs() <= 90.0 && (0.0..=360.0).contains(&az) {
                sun = Some((az, el));
            }
        }
    }
    let mut j = Json::new();
    j.obj();
    j.kv_str("IID1", &iid1).kv_str("IDATIM", &idatim).kv_str("TGTID", &tgtid).kv_str("IID2", &iid2);
    j.key("security");
    security_json(&mut j, &sec);
    j.kv_str("ENCRYP", &encryp).kv_str("ISORCE", &isorce);
    j.kv_int("NROWS", nrows as i64).kv_int("NCOLS", ncols as i64);
    j.kv_str("PVTYPE", &pvtype).kv_str("IREP", &irep).kv_str("ICAT", &icat).kv_int("ABPP", abpp as i64).kv_str("PJUST", &pjust);
    j.kv_str("ICORDS", &icords_t).kv_str("IGEOLO", &igeolo);
    if let Some(c) = igeolo_geographic(&icords_t, &igeolo) {
        j.key("corners").arr();
        for (la, lo) in c {
            j.arr().num(la).num(lo).end_arr();
        }
        j.end_arr();
    }
    j.key("ICOM").arr();
    for c in &icom {
        j.str(c);
    }
    j.end_arr();
    j.kv_str("IC", &ic).kv_str("COMRAT", &comrat).kv_int("NBANDS", nbands as i64);
    j.key("bands").raw(&bands.finish());
    j.kv_str("ISYNC", &isync).kv_str("IMODE", &imode);
    if let Some(b) = &bandsb {
        j.key("bandsb").raw(b);
    }
    j.kv_int("NBPR", nbpr as i64).kv_int("NBPC", nbpc as i64).kv_int("NPPBH", nppbh as i64).kv_int("NPPBV", nppbv as i64).kv_int("NBPP", nbpp as i64);
    j.kv_int("IDLVL", idlvl as i64).kv_int("IALVL", ialvl as i64);
    let (lr, lc) = (iloc.get(..5).map(f).unwrap_or(0.0), iloc.get(5..10).map(f).unwrap_or(0.0));
    j.key("ILOC").arr().num(lr).num(lc).end_arr();
    j.kv_str("IMAG", &imag);
    j.key("tres");
    tre::to_json(&mut j, &tres_all);
    if let Some(rec) = &rpc_record {
        j.kv_str("rpcKind", rpc_kind);
        j.key("rpc").arr();
        for v in rec {
            j.num(*v);
        }
        j.end_arr();
    }
    if let Some(a) = ichipb {
        j.key("ichipb").arr();
        for v in a {
            j.num(v);
        }
        j.end_arr();
    }
    if let Some((w, h)) = chip_full_size {
        j.key("fullImageSize").arr().num(w).num(h).end_arr();
    }
    if let Some((az, el)) = sun {
        j.key("sun").obj().kv_num("azimuth", az).kv_num("elevation", el).kv_str("source", "USE00A").end_obj();
    }
    j.kv_int("subheaderBytesUsed", r.pos as i64);
    j.end_obj();
    Ok(j.finish())
}

use gw_sensor_free::RPC00A_TO_B;
mod gw_sensor_free {
    /// Same table as gw-sensor (kept here so the parse bundle does not link the sensor crate).
    pub const RPC00A_TO_B: [usize; 20] = [0, 1, 2, 3, 4, 5, 6, 10, 7, 8, 9, 11, 14, 17, 12, 15, 18, 13, 16, 19];
}

/// Least-squares affine (x, y) → (u, v) from four ICHIPB corner pairs.
fn fit_affine(src: &[(f64, f64); 4], dst: &[(f64, f64); 4]) -> Option<[f64; 6]> {
    if src.iter().chain(dst).any(|p| !p.0.is_finite() || !p.1.is_finite()) {
        return None;
    }
    let mut ata = [[0.0f64; 3]; 3];
    let mut atu = [0.0f64; 3];
    let mut atv = [0.0f64; 3];
    for (s, d) in src.iter().zip(dst) {
        let row = [1.0, s.0, s.1];
        for i in 0..3 {
            for k in 0..3 {
                ata[i][k] += row[i] * row[k];
            }
            atu[i] += row[i] * d.0;
            atv[i] += row[i] * d.1;
        }
    }
    let su = solve3(ata, atu)?;
    let sv = solve3(ata, atv)?;
    Some([su[0], su[1], su[2], sv[0], sv[1], sv[2]])
}

fn solve3(m: [[f64; 3]; 3], b: [f64; 3]) -> Option<[f64; 3]> {
    let mut a = [[0.0; 4]; 3];
    for i in 0..3 {
        a[i][..3].copy_from_slice(&m[i]);
        a[i][3] = b[i];
    }
    for col in 0..3 {
        let piv = (col..3).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        for r in 0..3 {
            if r != col {
                let f = a[r][col] / a[col][col];
                for k in col..4 {
                    a[r][k] -= f * a[col][k];
                }
            }
        }
    }
    Some([a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]])
}

/// Parse a graphic, text, DES or RES subheader.
pub fn other_subheader(kind: &str, b: &[u8], version21: bool) -> Result<String> {
    let v = if version21 { Version::V21 } else { Version::V20 };
    let mut r = Reader::new(b);
    let mut j = Json::new();
    j.obj().kv_str("kind", kind);
    match kind {
        "graphic" => {
            if r.text(2)? != "SY" {
                return Err(Error::invalid("graphic subheader does not start with SY"));
            }
            j.kv_str("SID", &r.trimmed(10)?).kv_str("SNAME", &r.trimmed(20)?);
            let s = read_security(&mut r, "SS", v)?;
            j.key("security");
            security_json(&mut j, &s);
            j.kv_str("ENCRYP", &r.trimmed(1)?);
            j.kv_str("SFMT", &r.trimmed(1)?).kv_str("SSTRUCT", &r.trimmed(13)?);
            j.kv_int("SDLVL", r.num(3, "SDLVL")? as i64).kv_int("SALVL", r.num(3, "SALVL")? as i64);
            j.kv_str("SLOC", &r.text(10)?).kv_str("SBND1", &r.text(10)?).kv_str("SCOLOR", &r.trimmed(1)?).kv_str("SBND2", &r.text(10)?);
            j.kv_str("SRES", &r.trimmed(2)?);
        }
        "label" => {
            j.kv_str("note", "NITF 2.0 label segment (listed only)");
        }
        "text" => {
            if r.text(2)? != "TE" {
                return Err(Error::invalid("text subheader does not start with TE"));
            }
            j.kv_str("TEXTID", &r.trimmed(7)?);
            if version21 {
                j.kv_int("TXTALVL", r.num(3, "TXTALVL")? as i64);
            }
            j.kv_str("TXTDT", &r.trimmed(14)?).kv_str("TXTITL", &r.trimmed(80)?);
            let s = read_security(&mut r, "TS", v)?;
            j.key("security");
            security_json(&mut j, &s);
            j.kv_str("ENCRYP", &r.trimmed(1)?).kv_str("TXTFMT", &r.trimmed(3)?);
        }
        "des" => {
            if r.text(2)? != "DE" {
                return Err(Error::invalid("DES subheader does not start with DE"));
            }
            let desid = r.trimmed(25)?;
            j.kv_str("DESID", &desid).kv_str("DESVER", &r.trimmed(2)?);
            let s = read_security(&mut r, "DES", v)?;
            j.key("security");
            security_json(&mut j, &s);
            if desid == "TRE_OVERFLOW" || desid == "Registered Extensions" || desid == "Controlled Extensions" {
                j.kv_str("DESOFLW", &r.trimmed(6)?).kv_int("DESITEM", r.num(3, "DESITEM")? as i64);
            }
            let shl = r.num(4, "DESSHL")? as usize;
            let shf = r.bytes(shl)?;
            j.kv_int("DESSHL", shl as i64).kv_str("DESSHF", &crate::bytes::latin1(shf));
        }
        "res" => {
            j.kv_str("note", "reserved extension segment (listed only)");
        }
        _ => return Err(Error::invalid("unknown segment kind")),
    }
    j.end_obj();
    Ok(j.finish())
}

/// Image data mask table (IC = NM, M1, M3, M4, M5, M8). `nblocks` = NBPR·NBPC, multiplied by
/// NBANDS for IMODE S. Returns JSON with IMDATOFF, the pad pixel and the block offsets
/// (−1 = block not recorded).
pub fn mask_table(b: &[u8], nblocks: usize, nbpp: u32) -> Result<String> {
    if nblocks > 10_000_000 {
        return Err(Error::limit("too many blocks"));
    }
    let mut r = Reader::new(b);
    let imdatoff = r.u32be()?;
    let bmrlnth = r.u16be()?;
    let tmrlnth = r.u16be()?;
    let tpxcdlnth = r.u16be()?;
    let tpxcd = if tpxcdlnth > 0 {
        let n = (tpxcdlnth as usize).div_ceil(8);
        let v = r.bytes(n)?;
        let mut x: u64 = 0;
        for &c in v {
            x = (x << 8) | c as u64;
        }
        // Right-align to NBPP bits when the code is wider.
        if (tpxcdlnth as u32) > nbpp && nbpp < 64 {
            x &= (1u64 << nbpp) - 1;
        }
        Some(x)
    } else {
        None
    };
    let mut j = Json::new();
    j.obj().kv_int("IMDATOFF", imdatoff as i64).kv_int("BMRLNTH", bmrlnth as i64).kv_int("TMRLNTH", tmrlnth as i64).kv_int("TPXCDLNTH", tpxcdlnth as i64);
    match tpxcd {
        Some(x) => j.kv_int("TPXCD", x as i64),
        None => j.key("TPXCD").null(),
    };
    if bmrlnth > 0 {
        j.key("blockOffsets").arr();
        for _ in 0..nblocks {
            let o = r.u32be()?;
            j.int(if o == 0xFFFF_FFFF { -1 } else { o as i64 });
        }
        j.end_arr();
    }
    if tmrlnth > 0 {
        j.key("padOffsets").arr();
        for _ in 0..nblocks {
            let o = r.u32be()?;
            j.int(if o == 0xFFFF_FFFF { -1 } else { o as i64 });
        }
        j.end_arr();
    }
    j.kv_int("tableBytes", r.pos as i64);
    j.end_obj();
    if (imdatoff as usize) < r.pos {
        return Err(Error::invalid("IMDATOFF is inside the mask table"));
    }
    Ok(j.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pad(s: &str, n: usize) -> String {
        format!("{s:<n$}")
    }

    /// Build a minimal valid NITF 2.1 file header with one image segment.
    pub fn header(li: u64, lish: u64) -> Vec<u8> {
        let mut h = String::new();
        h += "NITF02.10";
        h += "03";
        h += "BF01";
        h += &pad("GWTEST", 10);
        h += "20261026120000";
        h += &pad("test", 80);
        h += "U";
        h += &" ".repeat(166);
        h += "00000";
        h += "00000";
        h += "0";
        let mut bytes = h.into_bytes();
        bytes.extend_from_slice(&[0, 0, 0]);
        let mut rest = String::new();
        rest += &pad("GIS Workbench", 24);
        rest += &pad("", 18);
        let hl = bytes.len() + rest.len() + 12 + 6 + 3 + 16 + 3 + 3 + 3 + 3 + 3 + 5 + 5;
        let fl = hl as u64 + lish + li;
        rest += &format!("{fl:012}");
        rest += &format!("{hl:06}");
        rest += "001";
        rest += &format!("{lish:06}{li:010}");
        rest += "000000000000000";
        rest += "0000000000";
        bytes.extend_from_slice(rest.as_bytes());
        assert_eq!(bytes.len(), hl);
        bytes
    }

    #[test]
    fn file_header_segments() {
        let h = header(100, 500);
        let j = file_header(&h, h.len() as u64 + 600).unwrap();
        assert!(j.contains("\"format\":\"NITF\""), "{j}");
        let off = h.len();
        assert!(j.contains(&format!("\"subheaderOffset\":{off}")), "{j}");
        assert!(j.contains(&format!("\"dataOffset\":{}", off + 500)), "{j}");
        // Short buffer → RANGE with the needed length.
        let e = file_header(&h[..h.len() - 10], 9999).unwrap_err();
        assert_eq!(e.code, gw_abi::RANGE);
    }

    #[test]
    fn rejects_non_nitf_and_encrypted() {
        assert_eq!(file_header(b"GIF89a.........", 15).unwrap_err().code, gw_abi::UNSUPPORTED);
        let mut h = header(1, 1);
        let enc_pos = 9 + 2 + 4 + 10 + 14 + 80 + 1 + 166 + 5 + 5;
        h[enc_pos] = b'1';
        assert_eq!(file_header(&h, 99999).unwrap_err().code, gw_abi::UNSUPPORTED);
    }

    #[test]
    fn igeolo_forms() {
        let g = "331800N0442400E331800N0442500E331700N0442500E331700N0442400E";
        let c = igeolo_geographic("G", g).unwrap();
        assert!((c[0].0 - 33.3).abs() < 1e-9 && (c[0].1 - 44.4).abs() < 1e-9);
        let d = "+33.300+044.400+33.300+044.410+33.290+044.410+33.290+044.400";
        let c = igeolo_geographic("D", d).unwrap();
        assert!((c[2].0 - 33.29).abs() < 1e-9 && (c[2].1 - 44.41).abs() < 1e-9);
    }

    #[test]
    fn mask_table_parses() {
        let mut b = vec![0, 0, 0, 30, 0, 4, 0, 0, 0, 8, 7];
        for o in [0u32, 0xFFFF_FFFF, 1024, 2048] {
            b.extend_from_slice(&o.to_be_bytes());
        }
        b.resize(30, 0);
        let j = mask_table(&b, 4, 8).unwrap();
        assert!(j.contains("\"blockOffsets\":[0,-1,1024,2048]"), "{j}");
        assert!(j.contains("\"TPXCD\":7"));
    }
}
