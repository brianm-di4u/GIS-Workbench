//! LandXML 1.0–1.2 TIN surfaces (REQ-GAP-39): read the points, faces, breaklines, boundaries
//! and data points of each `Surface` whose `Definition` is a TIN; write one surface with its
//! breaklines and boundaries. LandXML lists coordinates northing first ("N E Z"); here x is the
//! easting and y the northing. Lengths are converted to metres from the file's linear unit.
//! Grid surfaces, wall breaklines and other boundary types are refused by name.

use crate::mesh::{HARD, OUTER, SOFT, VOID};
use crate::xml::{read, Ev};
use crate::err::{Error, Msg};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SLine {
    pub kind: u8,
    pub name: String,
    pub closed: bool,
    pub pts: Vec<[f64; 3]>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Surface {
    pub name: String,
    pub points: Vec<[f64; 3]>,
    pub faces: Vec<[u32; 3]>,
    pub hidden: Vec<bool>,
    pub lines: Vec<SLine>,
    /// Points from SourceData DataPoints and proximity breaklines (mass points).
    pub extra: Vec<[f64; 3]>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Doc {
    pub version: String,
    pub unit: String,
    pub to_m: f64,
    pub epsg: Option<u32>,
    pub crs_name: String,
    pub wkt: String,
    pub surfaces: Vec<Surface>,
    /// Parts not read, by name: (what, name, type) — what is "surface", "breakline" or
    /// "boundary"; the app words the message.
    pub refused: Vec<(&'static str, String, String)>,
    /// (what, name): "contours" (not read), "breakline2d" (a standard breakline without
    /// elevations, read as soft).
    pub warnings: Vec<(&'static str, String)>,
}

pub const MAX_POINTS: usize = 20_000_000;

fn unit_factor(u: &str) -> Option<f64> {
    Some(match u {
        "meter" | "metre" => 1.0,
        "millimeter" => 0.001,
        "centimeter" => 0.01,
        "kilometer" => 1000.0,
        "foot" | "internationalFoot" => 0.3048,
        "USSurveyFoot" => 1200.0 / 3937.0,
        "inch" => 0.0254,
        "mile" => 1609.344,
        _ => return None,
    })
}

fn nums(s: &str, out: &mut Vec<f64>) -> Result<(), Msg> {
    for w in s.split(|c: char| c.is_ascii_whitespace() || c == ',') {
        if w.is_empty() {
            continue;
        }
        let v: f64 = w.parse().map_err(|_| Error::invalid("LandXML: a coordinate is not a number"))?;
        if !v.is_finite() {
            return Err(Error::invalid("LandXML: a coordinate is not a number"));
        }
        out.push(v);
    }
    Ok(())
}

#[derive(PartialEq, Clone, Copy)]
enum In {
    None,
    P,
    F,
    List3,
    List2,
}

/// Parse a LandXML document.
pub fn parse(text: &str) -> Result<Doc, Msg> {
    let mut d = Doc { to_m: 1.0, unit: "meter".into(), ..Default::default() };
    let mut path: Vec<&str> = Vec::new();
    let mut cur: Option<Surface> = None;
    let mut ids: crate::mesh::Map<String, u32> = Default::default();
    let mut tin = false;
    let mut what = In::None;
    let mut p_id = String::new();
    let mut f_hidden = false;
    let mut buf = String::new();
    let mut line: Option<(u8, String, bool, bool)> = None; // kind, name, closed, is-mass
    let mut pending_faces: Vec<[String; 3]> = Vec::new();
    let mut root_ok = false;
    let mut unit_set = false;
    let mut total = 0usize;
    read(text, |ev| {
        match ev {
            Ev::Start(name, attrs, _) => {
                let at = |k: &str| attrs.iter().find(|a| a.0 == k).map(|a| a.1.as_str());
                if path.is_empty() {
                    if name != "LandXML" {
                        return Err(Error::invalid("not LandXML (the root element is not <LandXML>)"));
                    }
                    root_ok = true;
                    d.version = at("version").unwrap_or("").to_string();
                }
                let parent = path.last().copied().unwrap_or("");
                match name {
                    "Metric" | "Imperial" if parent == "Units" && !unit_set => {
                        let u = at("linearUnit").unwrap_or(if name == "Metric" { "meter" } else { "foot" });
                        d.to_m = unit_factor(u).ok_or_else(|| Error::invalid("LandXML: unknown linear unit"))?;
                        d.unit = u.to_string();
                        unit_set = true;
                    }
                    "CoordinateSystem" => {
                        if let Some(e) = at("epsgCode") {
                            d.epsg = e.trim().parse().ok();
                        }
                        d.crs_name = at("horizontalCoordinateSystemName").or(at("name")).unwrap_or("").to_string();
                        d.wkt = at("ogcWktCode").unwrap_or("").to_string();
                    }
                    "Surface" if parent == "Surfaces" => {
                        cur = Some(Surface { name: at("name").unwrap_or("Surface").to_string(), ..Default::default() });
                        ids.clear();
                        pending_faces.clear();
                        tin = false;
                    }
                    "Definition" if cur.is_some() => {
                        let st = at("surfType").unwrap_or("TIN");
                        tin = st.eq_ignore_ascii_case("TIN");
                        if !tin {
                            let n = cur.as_ref().map(|s| s.name.clone()).unwrap_or_default();
                            d.refused.push(("surface", n, st.to_string()));
                        }
                    }
                    "P" if parent == "Pnts" && tin => {
                        what = In::P;
                        p_id = at("id").unwrap_or("").to_string();
                        buf.clear();
                    }
                    "F" if parent == "Faces" && tin => {
                        what = In::F;
                        f_hidden = at("i") == Some("1");
                        buf.clear();
                    }
                    "Breakline" if cur.is_some() => {
                        let t = at("brkType").unwrap_or("standard");
                        let nm = at("name").or(at("desc")).unwrap_or("").to_string();
                        line = match t {
                            "standard" => Some((HARD, nm, false, false)),
                            "nonDestructive" => Some((SOFT, nm, false, false)),
                            "proximity" => Some((0, nm, false, true)),
                            _ => {
                                d.refused.push(("breakline", nm, t.to_string()));
                                None
                            }
                        };
                    }
                    "Boundary" if cur.is_some() => {
                        let t = at("bndType").unwrap_or("outer");
                        let nm = at("name").unwrap_or("").to_string();
                        line = match t {
                            "outer" => Some((OUTER, nm, true, false)),
                            "void" | "island" => Some((VOID, nm, true, false)),
                            _ => {
                                d.refused.push(("boundary", nm, t.to_string()));
                                None
                            }
                        };
                    }
                    "DataPoints" if cur.is_some() => line = Some((0, String::new(), false, true)),
                    "PntList3D" | "PntList2D" if line.is_some() => {
                        what = if name == "PntList3D" { In::List3 } else { In::List2 };
                        buf.clear();
                    }
                    "Contours" if cur.is_some() => d.warnings.push(("contours", String::new())),
                    _ => {}
                }
                path.push(name);
            }
            Ev::Text(s) => {
                if what != In::None {
                    if buf.len() + s.len() > 1 << 30 {
                        return Err(Error::invalid("LandXML: a value is too long"));
                    }
                    buf.push_str(&s);
                }
            }
            Ev::End(name) => {
                path.pop();
                let to = d.to_m;
                match name {
                    "P" if what == In::P => {
                        what = In::None;
                        let mut v = Vec::with_capacity(3);
                        nums(&buf, &mut v)?;
                        if v.len() < 3 {
                            return Err(Error::invalid("LandXML: a TIN point needs northing, easting and elevation"));
                        }
                        let s = cur.as_mut().ok_or_else(|| Error::invalid("LandXML: a point outside a surface"))?;
                        total += 1;
                        if total > MAX_POINTS {
                            return Err(Error::invalid("LandXML: more than 20 million points"));
                        }
                        let k = s.points.len() as u32;
                        s.points.push([v[1] * to, v[0] * to, v[2] * to]);
                        let key = if p_id.is_empty() { (k + 1).to_string() } else { std::mem::take(&mut p_id) };
                        ids.insert(key, k);
                    }
                    "F" if what == In::F => {
                        what = In::None;
                        let w: Vec<&str> = buf.split_ascii_whitespace().collect();
                        if w.len() != 3 {
                            return Err(Error::invalid("LandXML: a face needs three point ids"));
                        }
                        if pending_faces.len() >= 2 * MAX_POINTS {
                            return Err(Error::invalid("LandXML: more than 40 million faces"));
                        }
                        pending_faces.push([w[0].to_string(), w[1].to_string(), w[2].to_string()]);
                        if let Some(s) = cur.as_mut() {
                            s.hidden.push(f_hidden);
                        }
                    }
                    "PntList3D" | "PntList2D" if what != In::None => {
                        let three = what == In::List3;
                        what = In::None;
                        let mut v = Vec::new();
                        nums(&buf, &mut v)?;
                        let k = if three { 3 } else { 2 };
                        if v.len() % k != 0 {
                            return Err(Error::invalid("LandXML: a point list has a coordinate missing"));
                        }
                        total += v.len() / k;
                        if total > MAX_POINTS {
                            return Err(Error::invalid("LandXML: more than 20 million points"));
                        }
                        let pts: Vec<[f64; 3]> = v.chunks_exact(k).map(|c| [c[1] * to, c[0] * to, if three { c[2] * to } else { f64::NAN }]).collect();
                        if let (Some(s), Some((kind, nm, closed, mass))) = (cur.as_mut(), line.as_ref()) {
                            if *mass {
                                s.extra.extend(pts.iter().filter(|p| p[2].is_finite()));
                            } else {
                                let mut kind = *kind;
                                if kind == HARD && !three {
                                    // A standard breakline without heights takes them from the surface.
                                    kind = SOFT;
                                    d.warnings.push(("breakline2d", nm.clone()));
                                }
                                let mut pts = pts;
                                if *closed && pts.len() > 1 && pts[0][..2] == pts[pts.len() - 1][..2] {
                                    pts.pop();
                                }
                                s.lines.push(SLine { kind, name: nm.clone(), closed: *closed, pts });
                            }
                        }
                    }
                    "Breakline" | "Boundary" | "DataPoints" => line = None,
                    "Surface" => {
                        if let Some(mut s) = cur.take() {
                            if tin {
                                for f in pending_faces.drain(..) {
                                    let mut tri = [0u32; 3];
                                    for (k, id) in f.iter().enumerate() {
                                        tri[k] = *ids.get(id).ok_or_else(|| Error::invalid("LandXML: a face names a point that is not in the surface"))?;
                                    }
                                    s.faces.push(tri);
                                }
                                d.surfaces.push(s);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    })?;
    if !root_ok {
        return Err(Error::invalid("not LandXML (the root element is not <LandXML>)"));
    }
    if d.surfaces.is_empty() {
        return Err(Error::invalid("the LandXML file has no TIN surface"));
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_surfaces_and_refuses_by_name() {
        let x = "<?xml version=\"1.0\"?><LandXML xmlns=\"http://www.landxml.org/schema/LandXML-1.2\" version=\"1.2\"><Units><Metric linearUnit=\"meter\"/></Units><CoordinateSystem epsgCode=\"26913\"/><Surfaces><Surface name=\"EG\"><SourceData><Breaklines><Breakline brkType=\"standard\" name=\"ridge &amp; crest\"><PntList3D>4400000 500000 1600.25 4400010 500010 1603</PntList3D></Breakline><Breakline brkType=\"wall\" name=\"w\"><PntList3D>1 2 3 4 5 6</PntList3D></Breakline></Breaklines><Boundaries><Boundary bndType=\"void\"><PntList2D>4400002 500002 4400002 500004 4400004 500003 4400002 500002</PntList2D></Boundary></Boundaries></SourceData><Definition surfType=\"TIN\"><Pnts><P id=\"1\">4400000 500000 1600.25</P><P id=\"2\">4400000 500010 1601.5</P><P id=\"3\">4400010 500000 1602</P><P id=\"4\">4400010 500010 1603</P></Pnts><Faces><F>1 2 4</F><F>1 4 3</F></Faces></Definition></Surface></Surfaces></LandXML>";
        let pts = [[500000.0, 4400000.0, 1600.25], [500010.0, 4400000.0, 1601.5], [500000.0, 4400010.0, 1602.0], [500010.0, 4400010.0, 1603.0]];
        let faces = [[0, 1, 3], [0, 3, 2]];
        let d = parse(&x).unwrap();
        assert_eq!(d.epsg, Some(26913));
        let s = &d.surfaces[0];
        assert_eq!(s.points, pts.to_vec());
        assert_eq!(s.faces, faces.to_vec());
        assert_eq!(s.lines.len(), 2);
        assert_eq!(d.refused.len(), 1, "the wall breakline is refused by name");
        assert_eq!(s.lines[0].name, "ridge & crest");
        assert_eq!(s.lines[1].kind, VOID);
        assert_eq!(s.lines[1].pts.len(), 3);
        // US survey feet are converted; northing comes first.
        let ft = "<LandXML><Units><Imperial linearUnit=\"USSurveyFoot\"/></Units><Surfaces><Surface name=\"a\"><Definition surfType=\"TIN\"><Pnts><P id=\"a\">10 20 30</P><P id=\"b\">10 21 30</P><P id=\"c\">11 20 31</P></Pnts><Faces><F i=\"1\">a b c</F></Faces></Definition></Surface></Surfaces></LandXML>";
        let d = parse(ft).unwrap();
        let p = d.surfaces[0].points[0];
        assert!((p[0] - 20.0 * 1200.0 / 3937.0).abs() < 1e-9 && (p[1] - 10.0 * 1200.0 / 3937.0).abs() < 1e-9);
        assert!(d.surfaces[0].hidden[0]);
        assert!(parse("<Foo/>").is_err());
        assert!(parse("<LandXML><Surfaces><Surface><Definition surfType=\"grid\"/></Surface></Surfaces></LandXML>").is_err());
        assert!(parse("<LandXML><Surfaces><Surface><Definition><Pnts><P id=\"1\">1 2 3</P></Pnts><Faces><F>1 2 9</F></Faces></Definition></Surface></Surfaces></LandXML>").is_err());
    }
}
