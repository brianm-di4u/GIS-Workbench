//! TE-059 REQ-SEC-02: a LAZ chunk table whose chunk count is corrupt is refused by name instead of
//! aborting the worker on a multi-gigabyte allocation (found by gw-fuzz on the 1.2.1 baseline).

use gw_pointcloud::{las, laz};
use std::path::PathBuf;

#[test]
fn te059_corrupt_chunk_count_is_refused() {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx09/fx09.laz");
    let b = std::fs::read(p).unwrap();
    let h = las::header(&b).unwrap();
    let vl = las::vlrs(&b, &h).unwrap();
    let zv = vl.iter().find(|x| x.user_id == "laszip encoded").unwrap();
    let z = laz::vlr(&b[zv.data_offset as usize..(zv.data_offset + zv.data_len) as usize]).unwrap();
    let po = h.point_offset as usize;
    let at = i64::from_le_bytes(b[po..po + 8].try_into().unwrap()) as usize;
    let good = laz::chunk_table(&b[at..], &z, h.n_points).expect("intact table");
    assert!(!good.is_empty());

    let mut t = b[at..].to_vec();
    t[4..8].copy_from_slice(&0xF000_0000u32.to_le_bytes());
    let e = laz::chunk_table(&t, &z, h.n_points).expect_err("corrupt count");
    assert!(e.to_string().contains("chunk table claims"), "{e}");
}
