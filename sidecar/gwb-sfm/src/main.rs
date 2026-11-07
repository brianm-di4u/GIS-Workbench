//! `gwb-sfm`: the stages of the `sfm-block` profile that are not COLMAP (sidecar/profiles/sfm-block.toml).
//! Errors print as `ERROR: ...` on stderr, which the job log shows, and exit 1.

use gwb_sfm::{exifgps, georef, mvs, products};
use std::collections::HashMap;
use std::path::PathBuf;

const USAGE: &str = "gwb-sfm prepare --images DIR --work DIR
gwb-sfm georef --sparse DIR --gps FILE --model DIR --sim3 FILE --json FILE [--focal PRIOR|REFINE]
gwb-sfm dense --workspace DIR [--max-size N] [--views N] [--iterations N]
gwb-sfm products --workspace DIR --georef FILE --ply FILE --dsm FILE --ortho FILE --frames FILE --las FILE --report FILE [--dsm-res M] [--ortho-res M]";

fn args() -> Result<(String, HashMap<String, String>), String> {
    let mut it = std::env::args().skip(1);
    let cmd = it.next().ok_or(USAGE)?;
    let mut map = HashMap::new();
    while let Some(k) = it.next() {
        let k = k.strip_prefix("--").ok_or_else(|| format!("unexpected argument {k}"))?.to_string();
        let v = it.next().ok_or_else(|| format!("--{k} needs a value"))?;
        map.insert(k, v);
    }
    Ok((cmd, map))
}

fn path(m: &HashMap<String, String>, k: &str) -> Result<PathBuf, String> {
    m.get(k).map(PathBuf::from).ok_or_else(|| format!("--{k} is required"))
}

fn num<T: std::str::FromStr>(m: &HashMap<String, String>, k: &str, d: T) -> Result<T, String> {
    match m.get(k) {
        None => Ok(d),
        Some(v) => v.parse().map_err(|_| format!("--{k}: {v} is not a number")),
    }
}

fn run() -> Result<(), String> {
    let (cmd, m) = args()?;
    let mut out = match cmd.as_str() {
        "prepare" => exifgps::prepare(&path(&m, "images")?, &path(&m, "work")?)?,
        "georef" => georef::georef(&path(&m, "sparse")?, &path(&m, "gps")?, &path(&m, "model")?, &path(&m, "sim3")?, &path(&m, "json")?, m.get("focal").is_some_and(|f| f == "REFINE"))?,
        "dense" => {
            let d = mvs::Options::default();
            let o = mvs::Options { max_size: num(&m, "max-size", d.max_size)?, views: num(&m, "views", d.views)?, iterations: num(&m, "iterations", d.iterations)?, ..d };
            if !(64..=16384).contains(&o.max_size) || !(2..=12).contains(&o.views) || !(1..=20).contains(&o.iterations) {
                return Err("--max-size, --views or --iterations is out of range".into());
            }
            mvs::run(&path(&m, "workspace")?, &o)?
        }
        "products" => {
            let (a, b, c, d, e, f, g, h) = (path(&m, "workspace")?, path(&m, "georef")?, path(&m, "ply")?, path(&m, "dsm")?, path(&m, "ortho")?, path(&m, "frames")?, path(&m, "las")?, path(&m, "report")?);
            let p = products::Paths { workspace: &a, georef: &b, ply: &c, dsm: &d, ortho: &e, frames: &f, las: &g, report: &h };
            products::run(&p, num(&m, "dsm-res", 0.0)?, num(&m, "ortho-res", 0.0)?)?
        }
        _ => return Err(USAGE.into()),
    };
    // The job log wants the summary; the positions are in gps.json.
    if let Some(o) = out.as_object_mut() {
        o.remove("gps");
    }
    println!("{out}");
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("ERROR: {e}");
        std::process::exit(1);
    }
}
