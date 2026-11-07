//! DigitalGlobe/Maxar Level-1B support files (WorldView-1/2/3/4, GeoEye-1, QuickBird delivered by
//! DigitalGlobe): `.IMD` (image size, first-line time, line timing), `.EPH` (ECEF ephemeris with
//! velocity and position covariance), `.ATT` (attitude quaternions with covariance) and `.GEO`
//! (principal distance, perspective centre, camera attitude, detector mounting) → the rigorous
//! line scanner of `crate::linescan` (REQ-GAP-20).
//!
//! The DigitalGlobe file specification was not read. The layout below is what the 21 corpus
//! products (WorldView-2 Atlanta, WorldView-3 Buenos Aires and Jacksonville) contain, and the
//! conventions were fixed by the same files: the GEO detector line equals the CSSFAA START/FINISH
//! of the WorldView-3 NITFs (detOriginY = START_Y, pitch × (detectors − 1) = START_Y − FINISH_Y)
//! and the ATT quaternions equal the CSATTA DES ones (`docs/validation/2.4/sensor.md`), so they are
//! read as the 2.4 model reads CSATTA: (q1, q2, q3, q4 = scalar), rotating the camera into ECEF.
//!
//! - Time: IMD TLCList pairs (line, seconds from TLCTime), line 0 being the first line's centre;
//!   a negative slope is a reverse scan. Two or more pairs must lie on a line within 0.05 lines
//!   (a varying line rate is refused). Without TLCList: firstLineTime and avgLineRate.
//! - EPH / ATT: `startTime`, `timeInterval`, and per record (index, x, y, z, vx, vy, vz, six
//!   position covariances) / (index, q1, q2, q3, q4, ten quaternion covariances).
//! - GEO: PD (mm); CX/CY/CZ (m, camera frame); qcs1..4 (camera → body; composed as
//!   q_body→ECEF ⊗ q_cam→body, [unverified]: every corpus file has the identity); detector array
//!   of the band: detOriginX/Y (mm), detPitch (mm), the line running toward −y. A non-zero
//!   detRotAngle (its sign could not be checked: zero in every corpus file), an optical distortion
//!   polynomial (polyOrder ≥ 0) and bands with more than one detector array are refused by name.
//! - A priori covariance: position from the EPH covariance (in-track, cross-track, radial, at the
//!   image centre time); attitude from the ATT covariance as 4·trace/3 per axis (small rotations,
//!   [approximation]); focal length 0.1 mm.

use super::odl::{iso_time, numbers, Odl};
use crate::linescan::LineScanner;
use gw_abi::{err, Error, Result};

pub struct DgFiles<'a> {
    pub imd: &'a str,
    pub eph: &'a str,
    pub att: &'a str,
    pub geo: &'a str,
}

/// A model built from vendor files and what the app says about it: `flags` (NOTE_*), and the a
/// priori σ from the files (in-track, cross-track, radial m; attitude µrad), when they state one.
#[derive(Debug)]
pub struct Built {
    pub model: LineScanner,
    pub flags: u32,
    pub sigma: Option<[f64; 4]>,
}

/// Line timing from avgLineRate (the IMD has no TLCList).
pub const NOTE_TIMING_AVG: u32 = 1;
/// A non-identity GEO camera attitude was composed after the ATT attitude.
pub const NOTE_QCS: u32 = 2;
/// The EPH/ATT files state no covariance.
pub const NOTE_NOCOV: u32 = 8;

fn rows_of(v: &[f64], width: usize, what: &str) -> Result<Vec<Vec<f64>>> {
    if v.is_empty() || v.len() % width != 0 {
        return Err(err!(INVALID, "{what}: the list is not in records of {n} values", what = what.to_string(), n = width.to_string()));
    }
    Ok(v.chunks_exact(width).map(|c| c.to_vec()).collect())
}

/// A time of an EPH/ATT/IMD entry as seconds from midnight of day `day0`.
fn secs(s: Option<&str>, day0: i64, what: &str) -> Result<f64> {
    let (d, t) = s.and_then(iso_time).ok_or_else(|| err!(INVALID, "{what}: the time is missing or not ISO 8601", what = what.to_string()))?;
    Ok(t + 86400.0 * (d - day0) as f64)
}

pub fn dg_model(f: &DgFiles, band: usize) -> Result<Built> {
    let imd = Odl::parse(f.imd);
    let eph = Odl::parse(f.eph);
    let att = Odl::parse(f.att);
    let geo = Odl::parse(f.geo);
    let mut flags = 0u32;
    let mut sigma = None;
    let rows = imd.num("", "numRows").filter(|v| *v >= 2.0).ok_or_else(|| Error::invalid("IMD: numRows is missing"))?;
    let cols = imd.num("", "numColumns").filter(|v| *v >= 2.0).ok_or_else(|| Error::invalid("IMD: numColumns is missing"))?;
    let first = imd.get("", "firstLineTime").ok_or_else(|| Error::invalid("IMD: firstLineTime is missing"))?;
    let (day0, _) = iso_time(first).ok_or_else(|| Error::invalid("IMD: firstLineTime is not ISO 8601"))?;
    let t_line0 = secs(Some(first), day0, "IMD firstLineTime")?;
    // Line timing.
    let (t_first, period) = match (imd.get("", "TLCTime"), imd.nums("", "TLCList")) {
        (Some(tt), Some(l)) if l.len() >= 4 && l.len() % 2 == 0 => {
            let t0 = secs(Some(tt), day0, "IMD TLCTime")?;
            let pts: Vec<(f64, f64)> = l.chunks_exact(2).map(|c| (c[0], c[1])).collect();
            let n = pts.len() as f64;
            let (ml, mt) = (pts.iter().map(|p| p.0).sum::<f64>() / n, pts.iter().map(|p| p.1).sum::<f64>() / n);
            let sll: f64 = pts.iter().map(|p| (p.0 - ml) * (p.0 - ml)).sum();
            if !(sll > 0.0) {
                return Err(Error::invalid("IMD: TLCList needs two different lines"));
            }
            let slope = pts.iter().map(|p| (p.0 - ml) * (p.1 - mt)).sum::<f64>() / sll;
            if slope == 0.0 {
                return Err(Error::invalid("IMD: the line period is zero"));
            }
            let worst = pts.iter().map(|p| ((mt + slope * (p.0 - ml) - p.1) / slope).abs()).fold(0.0, f64::max);
            if worst > 0.05 {
                return Err(err!(UNSUPPORTED, "IMD: the line rate varies ({v} lines from a constant rate); a varying line rate is not modelled", v = hundredths(worst)));
            }
            (t0 + mt - slope * ml, slope)
        }
        _ => {
            let rate = imd.num("", "avgLineRate").filter(|v| *v > 0.0).ok_or_else(|| Error::invalid("IMD: neither TLCList nor avgLineRate"))?;
            let rev = imd.get("", "scanDirection").map(|s| s.eq_ignore_ascii_case("Reverse")).unwrap_or(false);
            flags |= NOTE_TIMING_AVG;
            (t_line0, if rev { -1.0 / rate } else { 1.0 / rate })
        }
    };
    // Ephemeris.
    let et0 = secs(eph.get("", "startTime"), day0, "EPH startTime")?;
    let edt = eph.num("", "timeInterval").filter(|v| *v > 0.0).ok_or_else(|| Error::invalid("EPH: timeInterval is missing"))?;
    let er = rows_of(&eph.nums("", "ephemList").unwrap_or_default(), 13, "EPH ephemList")?;
    let ap = rows_of(&att.nums("", "attList").unwrap_or_default(), 15, "ATT attList")?;
    let at0 = secs(att.get("", "startTime"), day0, "ATT startTime")?;
    let adt = att.num("", "timeInterval").filter(|v| *v > 0.0).ok_or_else(|| Error::invalid("ATT: timeInterval is missing"))?;
    if er.len() < 8 || ap.len() < 4 {
        return Err(Error::invalid("EPH/ATT: needs eight or more ephemeris and four or more attitude records"));
    }
    // Records must be numbered 1, 2, … (a gap would shift the times).
    if er.iter().enumerate().any(|(k, r)| r[0] != (k + 1) as f64) || ap.iter().enumerate().any(|(k, r)| r[0] != (k + 1) as f64) {
        return Err(Error::invalid("EPH/ATT: the records are not numbered 1, 2, … in order"));
    }
    let eph_v: Vec<[f64; 3]> = er.iter().map(|r| [r[1], r[2], r[3]]).collect();
    // Camera attitude (camera → body) composed with body → ECEF.
    let qcs = [geo.num("CAMERA_ATTITUDE", "qcs1"), geo.num("CAMERA_ATTITUDE", "qcs2"), geo.num("CAMERA_ATTITUDE", "qcs3"), geo.num("CAMERA_ATTITUDE", "qcs4")];
    let qcs = if qcs.iter().all(|v| v.is_some()) { [qcs[0].unwrap(), qcs[1].unwrap(), qcs[2].unwrap(), qcs[3].unwrap()] } else { [0.0, 0.0, 0.0, 1.0] };
    let ident = (qcs[3].abs() - 1.0).abs() < 1e-12 && qcs[..3].iter().all(|v| v.abs() < 1e-12);
    if !ident {
        flags |= NOTE_QCS;
    }
    let mut att_v: Vec<[f64; 4]> = Vec::with_capacity(ap.len());
    for r in &ap {
        let q = [r[1], r[2], r[3], r[4]];
        let n = (q.iter().map(|v| v * v).sum::<f64>()).sqrt();
        if !((n - 1.0).abs() < 1e-3) {
            return Err(Error::invalid("ATT: a quaternion is not a unit quaternion"));
        }
        let mut c = if ident { q } else { qmul(q, qcs) };
        if let Some(p) = att_v.last() {
            if (0..4).map(|i| p[i] * c[i]).sum::<f64>() < 0.0 {
                c = c.map(|v| -v);
            }
        }
        att_v.push(c);
    }
    // Camera.
    let pd = geo.num("PRINCIPAL_DISTANCE", "PD").filter(|v| *v > 0.0).ok_or_else(|| Error::invalid("GEO: the principal distance PD is missing"))?;
    if let Some(o) = geo.num("OPTICAL_DISTORTION", "polyOrder") {
        if o >= 0.0 {
            return Err(Error::unsupported("GEO: an optical distortion polynomial (polyOrder ≥ 0) is not modelled"));
        }
    }
    let pc = [geo.num("PERSPECTIVE_CENTER", "CX").unwrap_or(0.0), geo.num("PERSPECTIVE_CENTER", "CY").unwrap_or(0.0), geo.num("PERSPECTIVE_CENTER", "CZ").unwrap_or(0.0)];
    let bands: Vec<String> = geo.groups_with("detOriginX").iter().filter_map(|g| g.split('.').find(|p| p.starts_with("BAND_")).map(|s| s.to_string())).fold(Vec::new(), |mut v, b| {
        if !v.contains(&b) {
            v.push(b);
        }
        v
    });
    let bname = bands.get(band).ok_or_else(|| err!(INVALID, "GEO: no detector mounting for band {b}", b = band.to_string()))?.clone();
    let arrays: Vec<String> = geo.groups_with("detOriginX").into_iter().filter(|g| g.split('.').any(|p| p == bname)).collect();
    if arrays.len() != 1 {
        return Err(err!(UNSUPPORTED, "GEO: band {b} has {n} detector arrays; only one array per band is modelled", b = bname.clone(), n = arrays.len().to_string()));
    }
    let g = arrays[0].as_str();
    let gnum = |k: &str| -> Result<f64> { geo.entries.iter().find(|e| e.group == g && e.key == k).and_then(|e| e.value.trim().parse::<f64>().ok()).ok_or_else(|| err!(INVALID, "GEO: {k} is missing", k = k.to_string())) };
    let (ox, oy, pitch, rot) = (gnum("detOriginX")?, gnum("detOriginY")?, gnum("detPitch")?, gnum("detRotAngle").unwrap_or(0.0));
    if !(pitch > 0.0) {
        return Err(Error::invalid("GEO: detPitch must be positive"));
    }
    if rot != 0.0 {
        // Its sign and axis could not be checked: every corpus file has 0.
        return Err(Error::unsupported("GEO: a non-zero detector rotation (detRotAngle) is not modelled"));
    }
    let span = pitch * (cols - 1.0);
    let det_end = [ox, oy - span];
    let mut m = LineScanner {
        rows,
        cols,
        t_first,
        period,
        focal_mm: pd,
        det_start: [ox, oy],
        det_end,
        n_det: cols,
        first_det: 1.0,
        pc_offset: pc,
        eph_t0: et0,
        eph_dt: edt,
        eph: eph_v,
        att_t0: at0,
        att_dt: adt,
        att: att_v,
        aberration: true,
        refraction_k: crate::linescan::REFRACTION_K,
        params: [0.0; 7],
        cov: None,
        ce90_m: f64::NAN,
        name: String::new(),
    }
    .named(if period < 0.0 { "Pushbroom (DigitalGlobe EPH/ATT/GEO, reverse scan)" } else { "Pushbroom (DigitalGlobe EPH/ATT/GEO)" });
    m.check_coverage()?;
    // A priori covariance from the support data's own covariances, at the image's mid time.
    let tm = t_first + period * 0.5 * rows;
    let ke = (((tm - et0) / edt).round().max(0.0) as usize).min(er.len() - 1);
    let ka = (((tm - at0) / adt).round().max(0.0) as usize).min(ap.len() - 1);
    let r = &er[ke];
    let c = [[r[7], r[8], r[9]], [r[8], r[10], r[11]], [r[9], r[11], r[12]]];
    let (p, v) = ([r[1], r[2], r[3]], [r[4], r[5], r[6]]);
    let radial = unit(p);
    let cross_t = unit(cross(p, v));
    let in_t = cross(cross_t, radial);
    let q = |u: [f64; 3]| (0..3).map(|i| (0..3).map(|j| u[i] * c[i][j] * u[j]).sum::<f64>()).sum::<f64>().max(0.0);
    let a = &ap[ka];
    let tr = a[5] + a[9] + a[12] + a[14];
    let s_att = (4.0 * tr.max(0.0) / 3.0).sqrt() * 1e6; // µrad
    if q(radial) > 0.0 && s_att > 0.0 {
        let var = [q(in_t), q(cross_t), q(radial), s_att * s_att, s_att * s_att, s_att * s_att, 0.01];
        let mut cov = vec![0.0; 49];
        for i in 0..7 {
            cov[i * 8] = var[i];
        }
        m.cov = Some(cov);
        sigma = Some([q(in_t).sqrt(), q(cross_t).sqrt(), q(radial).sqrt(), s_att]);
    } else {
        m.cov = m.a_priori_cov();
        flags |= NOTE_NOCOV;
    }
    Ok(Built { model: m, flags, sigma })
}

/// A non-negative value as text with two decimals (integer formatting only).
fn hundredths(v: f64) -> String {
    let c = (v * 100.0).round().clamp(0.0, 1e15) as u64;
    format!("{}.{:02}", c / 100, c % 100)
}

/// Hamilton product a ⊗ b of (x, y, z, w) quaternions.
fn qmul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    let [ax, ay, az, aw] = a;
    let [bx, by, bz, bw] = b;
    [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn unit(a: [f64; 3]) -> [f64; 3] {
    let n = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    [a[0] / n, a[1] / n, a[2] / n]
}

/// The DG `.TIL` tile offset of a tile file (ULColOffset, ULRowOffset), when the TIL lists it.
pub fn til_offset(til: &str, file_name: &str) -> Option<(f64, f64)> {
    let o = Odl::parse(til);
    let fname = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name).to_ascii_lowercase();
    let g = o.entries.iter().find(|e| e.key == "filename" && e.value.to_ascii_lowercase() == fname)?.group.clone();
    let get = |k: &str| o.entries.iter().find(|e| e.group == g && e.key == k).and_then(|e| numbers(&e.value).first().copied());
    Some((get("ULColOffset")?, get("ULRowOffset")?))
}

/// A DigitalGlobe `.RPB` → the RPC record of `crate::rpc` (pixel-centre offsets, as RPC00B).
pub fn rpb_record(rpb: &str) -> Option<Vec<f64>> {
    let o = Odl::parse(rpb);
    let k = ["errBias", "errRand", "lineOffset", "sampOffset", "latOffset", "longOffset", "heightOffset", "lineScale", "sampScale", "latScale", "longScale", "heightScale"];
    let mut sc = [0.0; 12];
    for (i, key) in k.iter().enumerate() {
        sc[i] = o.num("", key).or_else(|| if i < 2 { Some(0.0) } else { None })?;
    }
    let mut c = [[0.0; 20]; 4];
    for (i, key) in ["lineNumCoef", "lineDenCoef", "sampNumCoef", "sampDenCoef"].iter().enumerate() {
        let v = o.nums("", key)?;
        if v.len() != 20 {
            return None;
        }
        c[i].copy_from_slice(&v);
    }
    Some(crate::rpc::record_from_tre(sc, c, false, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Ground, SensorModel};

    /// A small, self-consistent DG product: a 600 km circular polar orbit, a nadir camera.
    fn seed() -> [String; 4] {
        let r0 = 6_378_137.0 + 600_000.0;
        let w = 7560.0 / r0;
        let mut eph = String::from("satId = \"WV03\";\nstartTime = 2015-01-01T00:00:00.000000Z;\nnumPoints = 30;\ntimeInterval = 1.0;\nephemList = (\n");
        let mut att = String::from("satId = \"WV03\";\nstartTime = 2015-01-01T00:00:00.000000Z;\nnumPoints = 30;\ntimeInterval = 1.0;\nattList = (\n");
        for k in 0..30 {
            let a = w * (k as f64 - 15.0);
            let (x, z) = (r0 * a.cos(), r0 * a.sin());
            eph.push_str(&format!("({}, {x:.4}, 0.0, {z:.4}, {:.4}, 0.0, {:.4}, 0.01, 0, 0, 0.01, 0, 0.01){}\n", k + 1, -7560.0 * a.sin(), 7560.0 * a.cos(), if k < 29 { "," } else { ");" }));
            // Camera z toward the geocentre, x along track: a rotation about y by −(90° + a).
            let t = -(std::f64::consts::FRAC_PI_2 + a) / 2.0;
            att.push_str(&format!("({}, 0.0, {:.12}, 0.0, {:.12}, 1e-11, 0, 0, 0, 1e-11, 0, 0, 1e-11, 0, 1e-11){}\n", k + 1, t.sin(), t.cos(), if k < 29 { "," } else { ");" }));
        }
        let imd = "version = \"28.3\";\nnumRows = 2000;\nnumColumns = 3000;\nBEGIN_GROUP = IMAGE_1\n\tfirstLineTime = 2015-01-01T00:00:14.000000Z;\n\tavgLineRate = 1000.00;\n\tTLCTime = 2015-01-01T00:00:14.000000Z;\n\tnumTLC = 2;\n\tTLCList = (\n\t(0, 0.000000),\n\t(2000, 2.000000));\nEND_GROUP = IMAGE_1\nEND;";
        let geo = "effectiveTime = 2014-08-01T00:00:00.000000Z;\nBEGIN_GROUP = PRINCIPAL_DISTANCE\n\tPD = 16000.0;\nEND_GROUP = PRINCIPAL_DISTANCE\nBEGIN_GROUP = OPTICAL_DISTORTION\n\tpolyOrder = -1;\nEND_GROUP = OPTICAL_DISTORTION\nBEGIN_GROUP = CAMERA_ATTITUDE\n\tqcs1 = 0.0;\n\tqcs2 = 0.0;\n\tqcs3 = 0.0;\n\tqcs4 = 1.0;\nEND_GROUP = CAMERA_ATTITUDE\nBEGIN_GROUP = DETECTOR_MOUNTING\n\tBEGIN_GROUP = BAND_P\n\t\tBEGIN_GROUP = DETECTOR_ARRAY_1\n\t\t\tdetOriginX = 0.0;\n\t\t\tdetOriginY = 12.0;\n\t\t\tdetRotAngle = 0.0;\n\t\t\tdetPitch = 0.008;\n\t\tEND_GROUP = DETECTOR_ARRAY_1\n\tEND_GROUP = BAND_P\nEND_GROUP = DETECTOR_MOUNTING\nEND;";
        [imd.to_string(), eph, att, geo.to_string()]
    }


    #[test]
    fn synthetic_product_builds_round_trips_and_refuses_damage() {
        let [imd, eph, att, geo] = seed();
        let b = dg_model(&DgFiles { imd: &imd, eph: &eph, att: &att, geo: &geo }, 0).unwrap();
        let m = &b.model;
        assert_eq!((m.rows, m.cols), (2000.0, 3000.0));
        assert!((m.period - 1e-3).abs() < 1e-12, "{}", m.period);
        assert!(b.sigma.is_some() && b.flags == 0, "{:?} {}", b.sigma, b.flags);
        let mut worst = 0f64;
        for (x, y) in [(0.5, 0.5), (1500.0, 1000.0), (2999.5, 1999.5)] {
            for h in [-100.0, 500.0, 3000.0] {
                let g = m.image_to_ground(x, y, h).unwrap();
                let (x2, y2) = m.ground_to_image(Ground { ..g }).unwrap();
                worst = worst.max((x2 - x).hypot(y2 - y));
            }
        }
        assert!(worst < 1e-6, "round trip {worst} px");
        // A nadir camera 600 km up: the image centre is under the satellite (within a few metres
        // of aberration).
        assert!(m.off_nadir_deg() < 0.5, "{}", m.off_nadir_deg());
        // Damaged sets are refused by name.
        assert!(dg_model(&DgFiles { imd: "numRows = 10;", eph: &eph, att: &att, geo: &geo }, 0).is_err());
        let bad_geo = geo.replace("polyOrder = -1", "polyOrder = 2");
        assert!(dg_model(&DgFiles { imd: &imd, eph: &eph, att: &att, geo: &bad_geo }, 0).unwrap_err().msg.contains("distortion"));
        let short = imd.replace("(2000, 2.000000)", "(2000, 200.000000)");
        assert!(dg_model(&DgFiles { imd: &short, eph: &eph, att: &att, geo: &geo }, 0).is_err(), "the ephemeris must cover the image");
        assert!(dg_model(&DgFiles { imd: &imd, eph: &eph, att: &att, geo: &geo }, 3).is_err(), "no such band");
        // .TIL offsets and the RPB reader.
        let til = "BEGIN_GROUP = TILE_1\n\tfilename = \"A_R2C1.TIF\";\n\tULColOffset = 0;\n\tULRowOffset = 8192;\nEND_GROUP = TILE_1";
        assert_eq!(til_offset(til, "x/a_r2c1.tif"), Some((0.0, 8192.0)));
        assert!(rpb_record("lineOffset = 1;").is_none());
    }
}
