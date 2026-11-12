//! The sparse model handed from the first stage of a controlled run to the second (decision 0018,
//! REG-075): one file, so the sidecar publishes it as an ordinary output, and a header the app reads
//! to project ground control points into the photographs. Layout: the line `GWB-SFM-MODEL 1`, one
//! line of JSON (the header), then the COLMAP binaries the header lists, back to back.

use crate::colmap::{centre, read_model, rotation};
use crate::geo::{quat_to_mat, Sim3};
use crate::Res;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAGIC: &str = "GWB-SFM-MODEL";
pub const VERSION: u64 = 1;
const FILES: [&str; 3] = ["cameras.bin", "images.bin", "points3D.bin"];

/// Read `sim3.txt` as georef writes it.
pub fn read_sim3(path: &Path) -> Res<Sim3> {
    let v: Vec<f64> = fs::read_to_string(path).map_err(|e| e.to_string())?.split_whitespace().map(|s| s.parse::<f64>().map_err(|e| e.to_string())).collect::<Res<_>>()?;
    if v.len() != 8 {
        return Err(format!("{} does not hold a similarity transform", path.display()));
    }
    Ok(Sim3 { s: v[0], q: [v[1], v[2], v[3], v[4]], t: [v[5], v[6], v[7]] })
}

/// Write the COLMAP model in `model` (georef's copy), its placement (`georef_json`, `sim3`), the
/// photographs' GPS and the first stage's provenance as one file at `out`. Each photograph's pose is
/// also given in the map frame less the offset (`r` turns map into camera, `c` is the centre), so
/// the app needs no similarity to project a surveyed point: p = r (X - offset - c).
pub fn export(model: &Path, georef_json: &Path, sim3_path: &Path, gps_path: &Path, provenance: &str, out: &Path) -> Res<Value> {
    let read_json = |p: &Path| -> Res<Value> { serde_json::from_slice(&fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?).map_err(|e| format!("{}: {e}", p.display())) };
    let georef = read_json(georef_json)?;
    let gps = read_json(gps_path)?;
    let sim3 = read_sim3(sim3_path)?;
    let m = read_model(model)?;
    let rs = quat_to_mat(sim3.q);
    let mut cameras: Vec<Value> = m.cameras.iter().map(|(id, c)| json!({ "id": id, "model": c.model, "width": c.width, "height": c.height, "params": c.params })).collect();
    cameras.sort_by_key(|c| c["id"].as_u64());
    let images: Vec<Value> = m
        .images
        .iter()
        .map(|im| {
            let r = crate::ba::rotate_into(&rotation(im), &rs);
            json!({ "id": im.id, "name": im.name, "camera": im.camera, "r": r, "c": sim3.apply(centre(im)) })
        })
        .collect();
    let mut blobs = Vec::new();
    let mut files = Vec::new();
    for f in FILES {
        let b = fs::read(model.join(f)).map_err(|e| format!("{f}: {e}"))?;
        files.push(json!({ "name": f, "bytes": b.len() }));
        blobs.push(b);
    }
    let header = json!({
        "format": "gwb-sfm-model",
        "version": VERSION,
        "stage_one": { "provenance": provenance, "focal_refined": georef["focal"]["refined"].as_bool().unwrap_or(false) },
        "georef": georef,
        "sim3": { "s": sim3.s, "q": sim3.q, "t": sim3.t },
        "cameras": cameras,
        "images": images,
        "gps": gps,
        "files": files,
    });
    let mut buf = format!("{MAGIC} {VERSION}\n").into_bytes();
    buf.extend(serde_json::to_vec(&header).map_err(|e| e.to_string())?);
    buf.push(b'\n');
    for b in &blobs {
        buf.extend(b);
    }
    fs::write(out, &buf).map_err(|e| format!("{}: {e}", out.display()))?;
    Ok(json!({ "model_file": out.file_name().map(|n| n.to_string_lossy().to_string()), "bytes": buf.len(), "images": images.len(), "cameras": cameras.len() }))
}

/// The header of a model file, and where its binaries start; None when `b` is not one.
fn header(b: &[u8]) -> Option<Res<(Value, usize)>> {
    let first = b.iter().position(|c| *c == b'\n')?;
    let line = std::str::from_utf8(&b[..first]).ok()?;
    let version = line.strip_prefix(MAGIC)?.trim();
    Some((|| {
        let v: u64 = version.parse().map_err(|_| format!("the model file's version {version:?} is not a number"))?;
        if v != VERSION {
            return Err(format!("the model file is version {v}; this gwb-sfm reads version {VERSION}, so run the first stage again with this sidecar"));
        }
        let end = first + 1 + b[first + 1..].iter().position(|c| *c == b'\n').ok_or("the model file is cut short in its header")?;
        let h: Value = serde_json::from_slice(&b[first + 1..end]).map_err(|e| format!("the model file's header: {e}"))?;
        Ok((h, end + 1))
    })())
}

/// Unpack the first stage's model for the second: its COLMAP binaries into `sparse/0`, the
/// photographs' GPS (with the first stage's settings, which georef reads) into `gps`, and the control
/// file to `control`. `inputs` are the job's inputs after the photographs, in any order: one must be
/// a model file and one a control file. Every photograph in the model must be in `images`.
pub fn import(images: &Path, inputs: &[PathBuf], sparse: &Path, gps: &Path, control: &Path) -> Res<Value> {
    if !images.is_dir() {
        return Err(format!("{} is not a folder: the first input is the folder of photographs the first stage ran on", images.display()));
    }
    let (mut model, mut ctl) = (None, None);
    for p in inputs {
        let b = fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if let Some(h) = header(&b) {
            if model.is_some() {
                return Err("two model files were given; give the one from the first stage".into());
            }
            let (h, at) = h?;
            model = Some((h, b, at));
        } else {
            let text = String::from_utf8(b).map_err(|_| format!("{name} is neither a model file from the first stage nor a ground control file"))?;
            let c = crate::gcp::parse(&text).map_err(|e| format!("{name} is neither a model file from the first stage nor a ground control file ({e})"))?;
            if ctl.is_some() {
                return Err("two ground control files were given; give one".into());
            }
            ctl = Some((c, text));
        }
    }
    let (h, b, mut at) = model.ok_or("no model file from the first stage was given")?;
    let (c, text) = ctl.ok_or("no ground control file was given")?;
    let missing: Vec<&str> = h["images"].as_array().into_iter().flatten().filter_map(|i| i["name"].as_str()).filter(|n| !images.join(n).is_file()).collect();
    if !missing.is_empty() {
        return Err(format!("{} of the model's photographs are not in {} (first: {}); give the folder the first stage ran on", missing.len(), images.display(), missing[0]));
    }
    let dir = sparse.join("0");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for f in h["files"].as_array().ok_or("the model file lists no binaries")? {
        let name = f["name"].as_str().filter(|n| FILES.contains(n)).ok_or("the model file lists an unknown binary")?;
        let n = f["bytes"].as_u64().ok_or("the model file gives no size for a binary")? as usize;
        let part = b.get(at..at + n).ok_or("the model file is cut short")?;
        fs::write(dir.join(name), part).map_err(|e| e.to_string())?;
        at += n;
    }
    if at != b.len() {
        return Err("the model file has bytes after its binaries".into());
    }
    let mut g = h["gps"].clone();
    g["stage_one"] = h["stage_one"].clone();
    fs::write(gps, serde_json::to_vec(&g).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    fs::write(control, text).map_err(|e| e.to_string())?;
    // model_transformer writes beside the sparse model and needs its folder made (prepare does this
    // in the first stage).
    if let Some(geo) = sparse.parent().map(|p| p.join("geo")) {
        fs::create_dir_all(geo).map_err(|e| e.to_string())?;
    }
    Ok(json!({ "images": h["images"].as_array().map_or(0, |a| a.len()), "control_points": c.points.len(), "checkpoints": c.points.iter().filter(|p| p.check).count(), "epsg": c.epsg }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A model file goes out and comes back byte for byte, its header placing each photograph in the
    /// map frame; the second stage refuses a wrong folder, a missing control file and a newer version.
    #[test]
    fn a_model_file_round_trips_and_is_checked_on_the_way_in() {
        let dir = std::env::temp_dir().join(format!("gwb-sfm-model-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let model = dir.join("model");
        let photos = dir.join("photos");
        fs::create_dir_all(&model).unwrap();
        fs::create_dir_all(&photos).unwrap();
        let mut cam = Vec::new();
        cam.extend(1u64.to_le_bytes());
        cam.extend(1u32.to_le_bytes());
        cam.extend(0i32.to_le_bytes());
        cam.extend(4000u64.to_le_bytes());
        cam.extend(3000u64.to_le_bytes());
        for v in [3000.0f64, 2000.0, 1500.0] {
            cam.extend(v.to_le_bytes());
        }
        let mut im = Vec::new();
        im.extend(1u64.to_le_bytes());
        im.extend(7u32.to_le_bytes());
        for v in [1.0f64, 0.0, 0.0, 0.0, -1.0, -2.0, -3.0] {
            im.extend(v.to_le_bytes());
        }
        im.extend(1u32.to_le_bytes());
        im.extend(b"DJI_0001.JPG\0");
        im.extend(0u64.to_le_bytes());
        fs::write(model.join("cameras.bin"), &cam).unwrap();
        fs::write(model.join("images.bin"), &im).unwrap();
        fs::write(model.join("points3D.bin"), 0u64.to_le_bytes()).unwrap();
        fs::write(dir.join("georef.json"), r#"{"epsg":32630,"offset":[500000.0,900000.0,0.0],"focal":{"refined":false}}"#).unwrap();
        fs::write(dir.join("sim3.txt"), "2 1 0 0 0 10 20 30\n").unwrap();
        fs::write(dir.join("gps.json"), r#"{"images":1,"with_gps":1,"gps":{"DJI_0001.JPG":[8.1,-2.4,180.0]}}"#).unwrap();
        let file = dir.join("block.sfm-model");
        export(&model, &dir.join("georef.json"), &dir.join("sim3.txt"), &dir.join("gps.json"), "gwb-sidecar test", &file).unwrap();
        let b = fs::read(&file).unwrap();
        let (h, _) = header(&b).unwrap().unwrap();
        assert_eq!(h["stage_one"]["provenance"], "gwb-sidecar test");
        // The centre is (1, 2, 3) in the model, so 2 x that + t in the map frame.
        assert_eq!(h["images"][0]["c"], json!([12.0, 24.0, 36.0]));
        assert_eq!(h["georef"]["epsg"], 32630);
        let ctl = dir.join("gcp.csv");
        fs::write(&ctl, "id,x,y,z,crs,sigma,role,image,px,py\nG1,500010,900020,120,EPSG:32630,0.02,gcp,DJI_0001.JPG,10,20\n").unwrap();
        let run = |inputs: &[PathBuf]| import(&photos, inputs, &dir.join("sparse"), &dir.join("gps2.json"), &dir.join("control.txt"));
        let err = run(&[file.clone(), ctl.clone()]).unwrap_err();
        assert!(err.contains("not in"), "{err}");
        fs::write(photos.join("DJI_0001.JPG"), b"jpeg").unwrap();
        assert!(run(std::slice::from_ref(&file)).unwrap_err().contains("no ground control file"));
        assert!(run(std::slice::from_ref(&ctl)).unwrap_err().contains("no model file"));
        let junk = dir.join("notes.txt");
        fs::write(&junk, "hello").unwrap();
        assert!(run(&[file.clone(), junk]).unwrap_err().contains("neither a model file"));
        let out = run(&[ctl.clone(), file.clone()]).unwrap();
        assert_eq!(out["control_points"], 1);
        assert!(dir.join("geo").is_dir(), "model_transformer's folder");
        for (f, want) in [("cameras.bin", &cam), ("images.bin", &im)] {
            assert_eq!(&fs::read(dir.join("sparse").join("0").join(f)).unwrap(), want);
        }
        let g: Value = serde_json::from_slice(&fs::read(dir.join("gps2.json")).unwrap()).unwrap();
        assert_eq!(g["stage_one"]["focal_refined"], false);
        assert!(g["gps"]["DJI_0001.JPG"].is_array());
        let mut newer = b.clone();
        newer[MAGIC.len() + 1] = b'2';
        fs::write(&file, newer).unwrap();
        let err = run(&[file.clone(), ctl.clone()]).unwrap_err();
        let _ = fs::remove_dir_all(&dir);
        assert!(err.contains("version 2"), "{err}");
    }
}
