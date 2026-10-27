//! SICD and SIDD metadata (REQ-SAR-01/02/05/06/12, REQ-FMT-08): the summary card, the flat
//! projection record for `gw_sensor::sicd`, the Radiometric polynomials and the SIDD display
//! chain. Element queries match local names only (any namespace prefix, SICD 1.0–1.5).

use crate::xml::Node;
use gw_abi::{Error, Json, Result};

fn v3(n: Option<&Node>) -> Option<[f64; 3]> {
    let n = n?;
    Some([n.num("X")?, n.num("Y")?, n.num("Z")?])
}

/// A 1-D polynomial by its `exponent1` attributes (not element order).
pub fn poly1(n: Option<&Node>) -> Vec<f64> {
    let Some(n) = n else { return Vec::new() };
    let mut c: Vec<f64> = Vec::new();
    for k in n.all("Coef") {
        let (Some(e), Some(v)) = (k.attr("exponent1").and_then(|s| s.trim().parse::<usize>().ok()), k.value()) else { continue };
        if e > 31 {
            continue;
        }
        if c.len() <= e {
            c.resize(e + 1, 0.0);
        }
        c[e] = v;
    }
    c
}

/// A 2-D polynomial → (n1, n2, row-major coefficients of x^i y^j).
pub fn poly2(n: Option<&Node>) -> (usize, usize, Vec<f64>) {
    let Some(n) = n else { return (0, 0, Vec::new()) };
    let mut t: Vec<(usize, usize, f64)> = Vec::new();
    for k in n.all("Coef") {
        let e1 = k.attr("exponent1").and_then(|s| s.trim().parse::<usize>().ok());
        let e2 = k.attr("exponent2").and_then(|s| s.trim().parse::<usize>().ok());
        if let (Some(a), Some(b), Some(v)) = (e1, e2, k.value()) {
            if a < 32 && b < 32 {
                t.push((a, b, v));
            }
        }
    }
    if t.is_empty() {
        return (0, 0, Vec::new());
    }
    let n1 = t.iter().map(|x| x.0).max().unwrap() + 1;
    let n2 = t.iter().map(|x| x.1).max().unwrap() + 1;
    let mut c = vec![0.0; n1 * n2];
    for (a, b, v) in t {
        c[a * n2 + b] = v;
    }
    (n1, n2, c)
}

fn xyz_poly(n: Option<&Node>) -> Option<[Vec<f64>; 3]> {
    let n = n?;
    Some([poly1(n.child("X")), poly1(n.child("Y")), poly1(n.child("Z"))])
}

fn polyval(c: &[f64], x: f64) -> f64 {
    c.iter().rev().fold(0.0, |s, &k| s * x + k)
}

fn push_poly2(r: &mut Vec<f64>, p: (usize, usize, Vec<f64>)) {
    r.push(p.0 as f64);
    r.push(p.1 as f64);
    r.extend(p.2);
}
fn push_poly1(r: &mut Vec<f64>, p: Vec<f64>) {
    r.push(p.len() as f64);
    r.extend(p);
}

/// The projection record for `gw_sensor::sicd::Params::from_record` from a SICD root.
pub fn record(root: &Node) -> Result<Vec<f64>> {
    if root.name != "SICD" {
        return Err(Error::invalid("not a SICD XML document"));
    }
    let ct = root.text_at("CollectionInfo/CollectType").unwrap_or("MONOSTATIC");
    if ct == "BISTATIC" {
        return Err(Error::unsupported("bistatic SICD projections are not supported in this release"));
    }
    let need = |p: &str| root.num(p).ok_or_else(|| Error::invalid(format!("SICD: {p} is missing")));
    let gtype = root.text_at("Grid/Type").unwrap_or("");
    let ifa = root.text_at("ImageFormation/ImageFormAlgo").unwrap_or("");
    let grid = match (gtype, ifa) {
        ("PLANE", _) => 0.0,
        ("XRGYCR", _) => 1.0,
        ("XCTYAT", _) => 2.0,
        ("RGAZIM", "PFA") => 3.0,
        ("RGAZIM", "RGAZCOMP") => 4.0,
        ("RGZERO", _) => 5.0,
        _ => return Err(Error::unsupported(format!("SICD grid {gtype} with image formation {ifa} has no projection"))),
    };
    let scp = v3(root.find("GeoData/SCP/ECF")).ok_or_else(|| Error::invalid("SICD: GeoData/SCP/ECF is missing"))?;
    let urow = v3(root.find("Grid/Row/UVectECF")).ok_or_else(|| Error::invalid("SICD: Grid/Row/UVectECF is missing"))?;
    let ucol = v3(root.find("Grid/Col/UVectECF")).ok_or_else(|| Error::invalid("SICD: Grid/Col/UVectECF is missing"))?;
    let arp = xyz_poly(root.find("Position/ARPPoly")).ok_or_else(|| Error::invalid("SICD: Position/ARPPoly is missing"))?;
    let ct_coa = poly2(root.find("Grid/TimeCOAPoly"));
    if ct_coa.2.is_empty() {
        return Err(Error::invalid("SICD: Grid/TimeCOAPoly is missing"));
    }
    // SCPCOA: from the file, or computed from the polynomials at t_COA(SCP).
    let t_scp = root.num("SCPCOA/SCPTime").unwrap_or(ct_coa.2[0]);
    let n = arp[0].len().max(arp[1].len()).max(arp[2].len());
    let pad = |c: &Vec<f64>| {
        let mut c = c.clone();
        c.resize(n, 0.0);
        c
    };
    let (ax, ay, az) = (pad(&arp[0]), pad(&arp[1]), pad(&arp[2]));
    let der = |c: &[f64]| -> Vec<f64> { c.iter().enumerate().skip(1).map(|(i, &k)| i as f64 * k).collect() };
    let arp_scp = v3(root.find("SCPCOA/ARPPos")).unwrap_or([polyval(&ax, t_scp), polyval(&ay, t_scp), polyval(&az, t_scp)]);
    let varp_scp = v3(root.find("SCPCOA/ARPVel")).unwrap_or([polyval(&der(&ax), t_scp), polyval(&der(&ay), t_scp), polyval(&der(&az), t_scp)]);
    let look = match root.text_at("SCPCOA/SideOfTrack") {
        Some("L") => 1.0,
        Some("R") => -1.0,
        _ => {
            // Left of track when (ARP × VARP) points along the line of sight.
            let u = |v: [f64; 3]| {
                let m = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                [v[0] / m, v[1] / m, v[2] / m]
            };
            let (ua, uv) = (u(arp_scp), u(varp_scp));
            let left = [ua[1] * uv[2] - ua[2] * uv[1], ua[2] * uv[0] - ua[0] * uv[2], ua[0] * uv[1] - ua[1] * uv[0]];
            let los = u([scp[0] - arp_scp[0], scp[1] - arp_scp[1], scp[2] - arp_scp[2]]);
            if left[0] * los[0] + left[1] * los[1] + left[2] * los[2] > 0.0 {
                1.0
            } else {
                -1.0
            }
        }
    };
    let mut r = vec![1.0, grid, look];
    r.extend(scp);
    r.push(need("ImageData/SCPPixel/Row")?);
    r.push(need("ImageData/SCPPixel/Col")?);
    r.push(root.num("ImageData/FirstRow").unwrap_or(0.0));
    r.push(root.num("ImageData/FirstCol").unwrap_or(0.0));
    r.push(need("ImageData/NumRows")?);
    r.push(need("ImageData/NumCols")?);
    r.push(need("Grid/Row/SS")?);
    r.push(need("Grid/Col/SS")?);
    r.extend(urow);
    r.extend(ucol);
    r.push(t_scp);
    r.extend(arp_scp);
    r.extend(varp_scp);
    match root.find("ErrorStatistics/AdjustableParameterOffsets") {
        Some(a) => {
            r.push(1.0);
            r.extend(v3(a.child("ARPPosSCPCOA")).unwrap_or([0.0; 3]));
            r.extend(v3(a.child("ARPVel")).unwrap_or([0.0; 3]));
            r.push(a.num("TxTimeSCPCOA").unwrap_or(0.0));
            r.push(a.num("RcvTimeSCPCOA").unwrap_or(0.0));
        }
        None => r.extend([0.0; 9]),
    }
    r.push(root.num("RgAzComp/AzSF").unwrap_or(f64::NAN));
    r.push(root.num("RMA/INCA/R_CA_SCP").unwrap_or(f64::NAN));
    let cs = root.find("ErrorStatistics/CompositeSCP");
    r.push(cs.and_then(|c| c.num("Rg")).unwrap_or(f64::NAN));
    r.push(cs.and_then(|c| c.num("Az")).unwrap_or(f64::NAN));
    r.push(cs.and_then(|c| c.num("RgAz")).unwrap_or(f64::NAN));
    r.push(match root.text_at("Grid/ImagePlane") {
        Some("SLANT") => 0.0,
        Some("GROUND") => 1.0,
        _ => 2.0,
    });
    r.push(root.num("SCPCOA/GrazeAng").unwrap_or(f64::NAN));
    r.push(root.num("SCPCOA/SlopeAng").unwrap_or(f64::NAN));
    debug_assert_eq!(r.len(), 44);
    push_poly2(&mut r, ct_coa);
    r.push(n as f64);
    r.extend(ax);
    r.extend(ay);
    r.extend(az);
    push_poly1(&mut r, poly1(root.find("PFA/PolarAngPoly")));
    push_poly1(&mut r, poly1(root.find("PFA/SpatialFreqSFPoly")));
    push_poly1(&mut r, poly1(root.find("RMA/INCA/TimeCAPoly")));
    push_poly2(&mut r, poly2(root.find("RMA/INCA/DRateSFPoly")));
    Ok(r)
}

/// A SIDD PlaneProjection as a SICD-style PLANE record (the product's own reference point and
/// plane, the ARP polynomial from Measurement). PolynomialProjection is returned separately.
pub fn sidd_plane_record(root: &Node) -> Result<Vec<f64>> {
    let m = root.find("Measurement").ok_or_else(|| Error::invalid("SIDD: Measurement is missing"))?;
    let pp = m.child("PlaneProjection").ok_or_else(|| Error::unsupported("SIDD: not a PlaneProjection product"))?;
    let refp = pp.child("ReferencePoint").ok_or_else(|| Error::invalid("SIDD: ReferencePoint is missing"))?;
    let scp = v3(refp.child("ECEF")).ok_or_else(|| Error::invalid("SIDD: ReferencePoint/ECEF is missing"))?;
    let row = refp.num("Point/Row").ok_or_else(|| Error::invalid("SIDD: ReferencePoint/Point is missing"))?;
    let col = refp.num("Point/Col").ok_or_else(|| Error::invalid("SIDD: ReferencePoint/Point is missing"))?;
    let rss = pp.num("SampleSpacing/Row").ok_or_else(|| Error::invalid("SIDD: SampleSpacing is missing"))?;
    let css = pp.num("SampleSpacing/Col").ok_or_else(|| Error::invalid("SIDD: SampleSpacing is missing"))?;
    let urow = v3(pp.find("ProductPlane/RowUnitVector")).ok_or_else(|| Error::invalid("SIDD: ProductPlane is missing"))?;
    let ucol = v3(pp.find("ProductPlane/ColUnitVector")).ok_or_else(|| Error::invalid("SIDD: ProductPlane is missing"))?;
    let ct = poly2(pp.child("TimeCOAPoly"));
    if ct.2.is_empty() {
        return Err(Error::invalid("SIDD: TimeCOAPoly is missing"));
    }
    let arp = xyz_poly(m.child("ARPPoly")).ok_or_else(|| Error::invalid("SIDD: Measurement/ARPPoly is missing"))?;
    let n = arp[0].len().max(arp[1].len()).max(arp[2].len());
    let pad = |c: &Vec<f64>| {
        let mut c = c.clone();
        c.resize(n, 0.0);
        c
    };
    let (ax, ay, az) = (pad(&arp[0]), pad(&arp[1]), pad(&arp[2]));
    let t = ct.2[0];
    let der = |c: &[f64]| -> Vec<f64> { c.iter().enumerate().skip(1).map(|(i, &k)| i as f64 * k).collect() };
    let a = [polyval(&ax, t), polyval(&ay, t), polyval(&az, t)];
    let v = [polyval(&der(&ax), t), polyval(&der(&ay), t), polyval(&der(&az), t)];
    let u = |v: [f64; 3]| {
        let m = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        [v[0] / m, v[1] / m, v[2] / m]
    };
    let (ua, uv) = (u(a), u(v));
    let left = [ua[1] * uv[2] - ua[2] * uv[1], ua[2] * uv[0] - ua[0] * uv[2], ua[0] * uv[1] - ua[1] * uv[0]];
    let los = u([scp[0] - a[0], scp[1] - a[1], scp[2] - a[2]]);
    let look = if left[0] * los[0] + left[1] * los[1] + left[2] * los[2] > 0.0 { 1.0 } else { -1.0 };
    let (nr, nc) = (root.num("Measurement/PixelFootprint/Row").unwrap_or(0.0), root.num("Measurement/PixelFootprint/Col").unwrap_or(0.0));
    let mut r = vec![1.0, 0.0, look];
    r.extend(scp);
    r.extend([row, col, 0.0, 0.0, nr, nc, rss, css]);
    r.extend(urow);
    r.extend(ucol);
    r.push(t);
    r.extend(a);
    r.extend(v);
    r.extend([0.0; 9]);
    r.extend([f64::NAN, f64::NAN, f64::NAN, f64::NAN, f64::NAN, 1.0]);
    r.push(root.num("ExploitationFeatures/Collection/Geometry/Graze").unwrap_or(f64::NAN));
    r.push(root.num("ExploitationFeatures/Collection/Geometry/Slope").unwrap_or(f64::NAN));
    push_poly2(&mut r, ct);
    r.push(n as f64);
    r.extend(ax);
    r.extend(ay);
    r.extend(az);
    for _ in 0..3 {
        r.push(0.0);
    }
    r.extend([0.0, 0.0]);
    Ok(r)
}

fn put_poly2(j: &mut Json, k: &str, p: Option<&Node>) {
    let (n1, n2, c) = poly2(p);
    if c.is_empty() {
        j.key(k).null();
        return;
    }
    j.key(k).obj().kv_int("n1", n1 as i64).kv_int("n2", n2 as i64).key("c").arr();
    for v in c {
        j.num(v);
    }
    j.end_arr().end_obj();
}

fn put_str(j: &mut Json, k: &str, v: Option<&str>) {
    match v {
        Some(s) => j.kv_str(k, s),
        None => j.key(k).null(),
    };
}
fn put_num(j: &mut Json, k: &str, v: Option<f64>) {
    match v {
        Some(x) if x.is_finite() => j.kv_num(k, x),
        _ => j.key(k).null(),
    };
}

/// The SICD summary card, radiometric polynomials and pixel decode facts as JSON fields.
pub fn summary(root: &Node, ns: &str, j: &mut Json) {
    j.kv_str("kind", "SICD").kv_str("namespace", ns);
    let ver = ns.rsplit(':').next().unwrap_or("");
    j.kv_str("version", ver);
    put_str(j, "collector", root.text_at("CollectionInfo/CollectorName"));
    put_str(j, "coreName", root.text_at("CollectionInfo/CoreName"));
    put_str(j, "collectType", root.text_at("CollectionInfo/CollectType"));
    put_str(j, "modeType", root.text_at("CollectionInfo/RadarMode/ModeType"));
    put_str(j, "modeId", root.text_at("CollectionInfo/RadarMode/ModeID"));
    put_str(j, "classification", root.text_at("CollectionInfo/Classification"));
    put_str(j, "collectStart", root.text_at("Timeline/CollectStart"));
    put_num(j, "collectDuration", root.num("Timeline/CollectDuration"));
    put_str(j, "pixelType", root.text_at("ImageData/PixelType"));
    put_num(j, "numRows", root.num("ImageData/NumRows"));
    put_num(j, "numCols", root.num("ImageData/NumCols"));
    put_num(j, "firstRow", root.num("ImageData/FirstRow"));
    put_num(j, "firstCol", root.num("ImageData/FirstCol"));
    put_num(j, "fullRows", root.num("ImageData/FullImage/NumRows"));
    put_num(j, "fullCols", root.num("ImageData/FullImage/NumCols"));
    put_num(j, "scpRow", root.num("ImageData/SCPPixel/Row"));
    put_num(j, "scpCol", root.num("ImageData/SCPPixel/Col"));
    put_str(j, "gridType", root.text_at("Grid/Type"));
    put_str(j, "imagePlane", root.text_at("Grid/ImagePlane"));
    put_str(j, "ifa", root.text_at("ImageFormation/ImageFormAlgo"));
    put_num(j, "rowSS", root.num("Grid/Row/SS"));
    put_num(j, "colSS", root.num("Grid/Col/SS"));
    put_num(j, "rowRes", root.num("Grid/Row/ImpRespWid"));
    put_num(j, "colRes", root.num("Grid/Col/ImpRespWid"));
    put_num(j, "rowBW", root.num("Grid/Row/ImpRespBW"));
    put_num(j, "colBW", root.num("Grid/Col/ImpRespBW"));
    put_num(j, "rowSgn", root.num("Grid/Row/Sgn"));
    put_num(j, "colSgn", root.num("Grid/Col/Sgn"));
    put_num(j, "rowKCtr", root.num("Grid/Row/KCtr"));
    put_num(j, "colKCtr", root.num("Grid/Col/KCtr"));
    put_str(j, "rowWgt", root.text_at("Grid/Row/WgtType/WindowName"));
    put_str(j, "colWgt", root.text_at("Grid/Col/WgtType/WindowName"));
    put_poly2(j, "rowDeltaKCOAPoly", root.find("Grid/Row/DeltaKCOAPoly"));
    put_poly2(j, "colDeltaKCOAPoly", root.find("Grid/Col/DeltaKCOAPoly"));
    put_num(j, "graze", root.num("SCPCOA/GrazeAng"));
    put_num(j, "incidence", root.num("SCPCOA/IncidenceAng"));
    put_num(j, "slope", root.num("SCPCOA/SlopeAng"));
    put_num(j, "twist", root.num("SCPCOA/TwistAng"));
    put_num(j, "azimuth", root.num("SCPCOA/AzimAng"));
    put_num(j, "layover", root.num("SCPCOA/LayoverAng"));
    put_num(j, "dopplerCone", root.num("SCPCOA/DopplerConeAng"));
    put_num(j, "slantRange", root.num("SCPCOA/SlantRange"));
    put_str(j, "sideOfTrack", root.text_at("SCPCOA/SideOfTrack"));
    put_num(j, "scpLat", root.num("GeoData/SCP/LLH/Lat"));
    put_num(j, "scpLon", root.num("GeoData/SCP/LLH/Lon"));
    put_num(j, "scpHae", root.num("GeoData/SCP/LLH/HAE"));
    put_str(j, "polarization", root.text_at("ImageFormation/TxRcvPolarizationProc"));
    put_num(j, "fcMin", root.num("RadarCollection/TxFrequency/Min"));
    put_num(j, "fcMax", root.num("RadarCollection/TxFrequency/Max"));
    // Image corners (information only: producers fill them differently, `Research/09` §10).
    j.key("imageCorners").arr();
    if let Some(ic) = root.find("GeoData/ImageCorners") {
        for c in ic.children.iter() {
            if let (Some(a), Some(b)) = (c.num("Lat"), c.num("Lon")) {
                j.arr().num(a).num(b).end_arr();
            }
        }
    }
    j.end_arr();
    j.key("validData").arr();
    if let Some(vd) = root.find("ImageData/ValidData") {
        for c in vd.children.iter() {
            if let (Some(a), Some(b)) = (c.num("Row"), c.num("Col")) {
                j.arr().num(a).num(b).end_arr();
            }
        }
    }
    j.end_arr();
    // AMP8I_PHS8I amplitude table (256 entries, by index).
    match root.find("ImageData/AmpTable") {
        Some(t) => {
            let mut a = vec![f64::NAN; 256];
            for e in t.children.iter() {
                if let (Some(i), Some(v)) = (e.attr("index").and_then(|s| s.trim().parse::<usize>().ok()), e.value()) {
                    if i < 256 {
                        a[i] = v;
                    }
                }
            }
            j.key("ampTable").arr();
            for v in a {
                j.num(if v.is_finite() { v } else { 0.0 });
            }
            j.end_arr();
        }
        None => {
            j.key("ampTable").null();
        }
    }
    j.key("radiometric");
    match root.child("Radiometric") {
        Some(r) => {
            j.obj();
            put_str(j, "noiseType", r.text_at("NoiseLevel/NoiseLevelType"));
            put_poly2(j, "noise", r.find("NoiseLevel/NoisePoly"));
            put_poly2(j, "rcs", r.child("RCSSFPoly"));
            put_poly2(j, "sigma0", r.child("SigmaZeroSFPoly"));
            put_poly2(j, "beta0", r.child("BetaZeroSFPoly"));
            put_poly2(j, "gamma0", r.child("GammaZeroSFPoly"));
            j.end_obj();
        }
        None => {
            j.null();
        }
    }
    j.key("match").arr();
    if let Some(mi) = root.child("MatchInfo") {
        for mt in mi.all("MatchType") {
            for mc in mt.all("MatchCollection") {
                j.obj();
                put_str(j, "type", mt.text_at("TypeID"));
                put_str(j, "coreName", mc.text_at("CoreName"));
                j.end_obj();
            }
        }
    }
    j.end_arr();
    let cs = root.find("ErrorStatistics/CompositeSCP");
    put_num(j, "errRg", cs.and_then(|c| c.num("Rg")));
    put_num(j, "errAz", cs.and_then(|c| c.num("Az")));
    j.kv_bool("apo", root.find("ErrorStatistics/AdjustableParameterOffsets").is_some());
}

/// The SIDD summary: product, pixel type, measurement type and the display chain (read-only).
pub fn sidd_summary(root: &Node, ns: &str, j: &mut Json) {
    j.kv_str("kind", "SIDD").kv_str("namespace", ns);
    j.kv_str("version", ns.rsplit(':').next().unwrap_or(""));
    put_str(j, "pixelType", root.text_at("Display/PixelType"));
    put_num(j, "numBands", root.num("Display/NumBands"));
    put_str(j, "classification", root.find("ProductCreation/Classification").and_then(|c| c.attr("classification")));
    put_str(j, "productName", root.text_at("ProductCreation/ProductName"));
    put_str(j, "productClass", root.text_at("ProductCreation/ProductClass"));
    put_str(j, "collector", root.text_at("ExploitationFeatures/Collection/Information/SensorName"));
    put_str(j, "collectStart", root.text_at("ExploitationFeatures/Collection/Information/CollectionDateTime"));
    put_str(j, "modeType", root.text_at("ExploitationFeatures/Collection/Information/RadarMode/ModeType"));
    put_num(j, "graze", root.num("ExploitationFeatures/Collection/Geometry/Graze"));
    put_num(j, "slope", root.num("ExploitationFeatures/Collection/Geometry/Slope"));
    put_num(j, "azimuth", root.num("ExploitationFeatures/Collection/Geometry/Azimuth"));
    put_num(j, "twist", root.num("ExploitationFeatures/Collection/Geometry/Twist"));
    let m = root.find("Measurement");
    let mt = m.and_then(|m| m.children.iter().find(|c| c.name.ends_with("Projection")).map(|c| c.name.clone()));
    put_str(j, "measurement", mt.as_deref());
    put_num(j, "rows", root.num("Measurement/PixelFootprint/Row"));
    put_num(j, "cols", root.num("Measurement/PixelFootprint/Col"));
    // PolynomialProjection: row/col ↔ lat/lon polynomials about a reference point.
    if let Some(pp) = m.and_then(|m| m.child("PolynomialProjection")) {
        j.key("polynomial").obj();
        put_num(j, "refRow", pp.num("ReferencePoint/Point/Row"));
        put_num(j, "refCol", pp.num("ReferencePoint/Point/Col"));
        put_poly2(j, "rowColToLat", pp.child("RowColToLat"));
        put_poly2(j, "rowColToLon", pp.child("RowColToLon"));
        put_poly2(j, "rowColToAlt", pp.child("RowColToAlt"));
        put_poly2(j, "latLonToRow", pp.child("LatLonToRow"));
        put_poly2(j, "latLonToCol", pp.child("LatLonToCol"));
        j.end_obj();
    }
    // The display chain, stage by stage (read-only in the image chain panel).
    j.key("display").arr();
    if let Some(d) = root.child("Display") {
        for stage in ["NonInteractiveProcessing", "InteractiveProcessing"] {
            for s in d.all(stage) {
                for step in s.children.iter() {
                    j.obj().kv_str("stage", stage).kv_str("step", &step.name);
                    let names: Vec<String> = step.children.iter().map(|c| c.name.clone()).collect();
                    j.kv_str("detail", &names.join(", "));
                    j.end_obj();
                }
            }
        }
    }
    j.end_arr();
    put_str(j, "shadowDirection", root.text_at("Display/InteractiveProcessing/GeometricTransform/Orientation/ShadowDirection"));
}
