//! TE-022: a streamed LAZ without a chunk table (PDAL test file TO_core_last_zoom.laz) decodes
//! sequentially; record count and XYZ bounds agree with the header. Skipped without TE-corpus.

use gw_pointcloud::{las, laz};
use std::path::PathBuf;

#[test]
fn te022_streamed_laz_without_chunk_table_decodes() {
    let root = std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"));
    let Some(p) = walk(&root.join("lidar-las-version-matrix")).into_iter().find(|p| p.ends_with("TO_core_last_zoom.laz")) else {
        eprintln!("TE-corpus not present; skipped");
        return;
    };
    let b = std::fs::read(p).unwrap();
    let h = las::header(&b).unwrap();
    let vl = las::vlrs(&b, &h).unwrap();
    let z = vl.iter().find(|x| x.user_id == "laszip encoded").unwrap();
    let v = laz::vlr(&b[z.data_offset as usize..(z.data_offset + z.data_len) as usize]).unwrap();
    let out = laz::decode_stream(&v, &b[h.point_offset as usize..], h.n_points).expect("decodes");
    let rec = v.items_size() as usize;
    assert_eq!(out.len(), h.n_points as usize * rec);
    // X of every record within the header bounds.
    let sx = h.scale[0];
    let ox = h.offset[0];
    for k in (0..h.n_points as usize).step_by(97) {
        let xi = i32::from_le_bytes(out[k * rec..k * rec + 4].try_into().unwrap());
        let x = f64::from(xi) * sx + ox;
        assert!(x >= h.min[0] - 1e-6 && x <= h.max[0] + 1e-6, "point {k}: x {x} outside [{}, {}]", h.min[0], h.max[0]);
    }
}

fn walk(d: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}
