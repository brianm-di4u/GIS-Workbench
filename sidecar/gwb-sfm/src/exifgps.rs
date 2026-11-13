//! `prepare`: what is in the folder, and whether a block can be built from it. Everything here
//! refuses by name before any long work starts.

use crate::Res;
use exif::{In, Reader, Tag, Value};
use serde_json::{json, Value as Json};
use std::collections::BTreeMap;
use std::fs;
use std::io::BufReader;
use std::path::Path;

pub const MIN_IMAGES: usize = 5;

#[derive(Debug, Clone, PartialEq)]
pub struct Tagged {
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt: Option<f64>,
    pub camera: String,
}

fn dms(v: &Value) -> Option<f64> {
    match v {
        Value::Rational(r) if r.len() >= 3 && r.iter().take(3).all(|x| x.denom != 0) => Some(r[0].to_f64() + r[1].to_f64() / 60.0 + r[2].to_f64() / 3600.0),
        _ => None,
    }
}

fn ascii(e: &exif::Exif, t: Tag) -> Option<String> {
    let f = e.get_field(t, In::PRIMARY)?;
    match &f.value {
        Value::Ascii(a) => a.first().map(|s| String::from_utf8_lossy(s).trim().to_string()),
        _ => None,
    }
}

/// GPS and camera identity from a file's EXIF. Any damage in it reads as "no EXIF".
pub fn read_tags(mut bytes: impl std::io::BufRead + std::io::Seek) -> Tagged {
    let Ok(e) = Reader::new().read_from_container(&mut bytes) else { return Tagged { lat: None, lon: None, alt: None, camera: String::new() } };
    let coord = |tag: Tag, rf: Tag, neg: &str| -> Option<f64> {
        let v = dms(&e.get_field(tag, In::PRIMARY)?.value)?;
        let sign = if ascii(&e, rf).is_some_and(|s| s.eq_ignore_ascii_case(neg)) { -1.0 } else { 1.0 };
        Some(v * sign)
    };
    let lat = coord(Tag::GPSLatitude, Tag::GPSLatitudeRef, "S").filter(|v| v.abs() <= 90.0);
    let lon = coord(Tag::GPSLongitude, Tag::GPSLongitudeRef, "W").filter(|v| v.abs() <= 180.0);
    let alt = e.get_field(Tag::GPSAltitude, In::PRIMARY).and_then(|f| match &f.value {
        Value::Rational(r) if !r.is_empty() && r[0].denom != 0 => {
            let below = matches!(e.get_field(Tag::GPSAltitudeRef, In::PRIMARY).map(|x| &x.value), Some(Value::Byte(b)) if b.first() == Some(&1));
            Some(r[0].to_f64() * if below { -1.0 } else { 1.0 })
        }
        _ => None,
    });
    let camera = format!("{} {}", ascii(&e, Tag::Make).unwrap_or_default(), ascii(&e, Tag::Model).unwrap_or_default()).trim().to_string();
    Tagged { lat, lon, alt, camera }
}

fn is_image(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".jpg") || l.ends_with(".jpeg")
}

/// Check the folder; write `images.txt` (names for COLMAP) and `gps.json`.
pub fn prepare(images: &Path, work: &Path) -> Res<Json> {
    let meta = fs::metadata(images).map_err(|e| format!("cannot read the image folder: {e}"))?;
    if !meta.is_dir() {
        return Err("the block must be a folder of photographs".into());
    }
    let mut names: Vec<String> = fs::read_dir(images).map_err(|e| format!("cannot read the image folder: {e}"))?.flatten().filter(|d| d.file_type().map(|t| t.is_file()).unwrap_or(false)).map(|d| d.file_name().to_string_lossy().into_owned()).filter(|n| is_image(n)).collect();
    names.sort();
    if names.len() < MIN_IMAGES {
        return Err(format!("a block needs at least {MIN_IMAGES} JPEG photographs; this folder holds {}", names.len()));
    }
    let mut gps = serde_json::Map::new();
    let mut cameras: BTreeMap<String, usize> = BTreeMap::new();
    let mut no_alt = 0;
    for n in &names {
        let f = fs::File::open(images.join(n)).map_err(|e| format!("cannot read {n}: {e}"))?;
        let t = read_tags(BufReader::new(f));
        *cameras.entry(t.camera.clone()).or_default() += 1;
        match (t.lat, t.lon, t.alt) {
            (Some(lat), Some(lon), Some(alt)) => {
                gps.insert(n.clone(), json!([lat, lon, alt]));
            }
            (Some(_), Some(_), None) => no_alt += 1,
            _ => {}
        }
    }
    if cameras.len() > 1 {
        return Err(format!("this folder mixes {} cameras ({}); run each camera as its own block", cameras.len(), cameras.keys().map(|k| if k.is_empty() { "unknown" } else { k.as_str() }).collect::<Vec<_>>().join(", ")));
    }
    if gps.len() < 3 {
        let more = if no_alt > 0 { format!(" ({no_alt} have a position but no altitude)") } else { String::new() };
        return Err(format!("only {} of {} photographs carry GPS latitude, longitude and altitude in EXIF{more}; a block is georeferenced from them", gps.len(), names.len()));
    }
    for d in ["sparse", "geo"] {
        fs::create_dir_all(work.join(d)).map_err(|e| e.to_string())?;
    }
    fs::write(work.join("images.txt"), names.join("\n") + "\n").map_err(|e| e.to_string())?;
    let out = json!({ "images": names.len(), "with_gps": gps.len(), "camera": cameras.keys().next().cloned().unwrap_or_default(), "gps": gps });
    fs::write(work.join("gps.json"), serde_json::to_vec_pretty(&out).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn damaged_exif_reads_as_none_and_never_panics() {
        let mut seed = 7u32;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        let base: Vec<u8> = [&[0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x40][..], b"Exif\0\0II*\0\x08\0\0\0\x01\0\x25\x88\x04\0\x01\0\0\0\x1a\0\0\0\0\0\0\0", &[0u8; 40]].concat();
        for _ in 0..20_000 {
            let mut b = base.clone();
            for _ in 0..(next() % 6) {
                let i = next() as usize % b.len();
                b[i] = next() as u8;
            }
            b.truncate(1 + next() as usize % b.len());
            let _ = read_tags(Cursor::new(b));
        }
    }

    #[test]
    fn refusals_name_the_problem() {
        let d = std::env::temp_dir().join(format!("gwb-sfm-prep-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("i")).unwrap();
        assert!(prepare(&d.join("i"), &d.join("w")).unwrap_err().contains("at least 5"));
        for i in 0..6 {
            fs::write(d.join("i").join(format!("{i}.jpg")), b"not a jpeg").unwrap();
        }
        assert!(prepare(&d.join("i"), &d.join("w")).unwrap_err().contains("GPS"));
        assert!(prepare(&d.join("nothing"), &d.join("w")).is_err());
        fs::remove_dir_all(&d).unwrap();
    }
}
