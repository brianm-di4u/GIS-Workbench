//! REQ-LDR-01/03/08/09/10 on FX-09: header and VLRs against the truth, LAZ chunk decoding equal to
//! the LAS records, WKT/GeoTIFF-key units, SMRF against the file's classes, LOD index invariants,
//! gridding, and the LAS 1.4 writer round trip (plain and LAZ).

use gw_pointcloud::decode::{decode, Columns, Lattice, RecordSpec};
use gw_pointcloud::grid::{grid, GridSpec, Mode};
use gw_pointcloud::las;
use gw_pointcloud::write::{write, WriteSpec};
use gw_pointcloud::{laz, lod, profile, smrf};
use std::path::PathBuf;

fn fixture(name: &str) -> Option<Vec<u8>> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx09").join(name);
    std::fs::read(p).ok()
}

fn read_all(b: &[u8]) -> (las::Header, Columns) {
    let h = las::header(b).unwrap();
    let spec = RecordSpec { format: h.format, record_len: h.record_len as usize, scale: h.scale, offset: h.offset, t0: 1.3e9 };
    // A local frame: offsets from the header minimum, metres.
    let lat = Lattice { x0: h.min[0], y0: h.min[1], dx: 1000.0, dy: 1000.0, nx: 2, ny: 2, nodes: vec![[0.0, 0.0, 0.0], [1000.0, 0.0, 0.0], [0.0, 1000.0, 0.0], [1000.0, 1000.0, 0.0]], v_unit: 1.0 };
    let n = h.n_points as usize;
    let mut c = Columns::with_capacity(n, false);
    let po = h.point_offset as usize;
    if h.compressed {
        let v = las::vlrs(b, &h).unwrap();
        let zv = v.iter().find(|x| x.user_id == "laszip encoded").unwrap();
        let z = laz::vlr(&b[zv.data_offset as usize..(zv.data_offset + zv.data_len) as usize]).unwrap();
        let table_at = i64::from_le_bytes(b[po..po + 8].try_into().unwrap()) as usize;
        let chunks = laz::chunk_table(&b[table_at..], &z, h.n_points).unwrap();
        // Decode in three runs of whole chunks, as three workers would.
        let mut off = po + 8;
        let third = chunks.len().div_ceil(3);
        for run in chunks.chunks(third) {
            let bytes: u64 = run.iter().map(|c| c.1).sum();
            let raw = laz::decode_chunks(&z, &b[off..off + bytes as usize], run).unwrap();
            decode(&raw, &spec, &lat, &mut c);
            off += bytes as usize;
        }
    } else {
        decode(&b[po..po + n * h.record_len as usize], &spec, &lat, &mut c);
    }
    (h, c)
}

#[test]
fn las_and_laz_agree_with_the_truth() {
    let (Some(las_b), Some(laz_b), Some(t)) = (fixture("fx09.las"), fixture("fx09.laz"), fixture("fx09_truth.json")) else {
        eprintln!("FX-09 not generated (node build/fixtures/fx09.mjs); skipped");
        return;
    };
    let truth = String::from_utf8(t).unwrap();
    let t0 = std::time::Instant::now();
    let (h, a) = read_all(&las_b);
    let t1 = t0.elapsed();
    let (hz, b) = read_all(&laz_b);
    let t2 = t0.elapsed() - t1;
    eprintln!("FX-09 {} points: LAS decode {:?}, LAZ decode {:?}", a.n, t1, t2);
    assert_eq!(h.version, (1, 4));
    assert_eq!(h.format, 6);
    assert!(hz.compressed && hz.format == 6);
    assert!(truth.contains(&format!("\"n\": {}", h.n_points)));
    assert_eq!(a.n as u64, h.n_points);
    assert_eq!(a.pos, b.pos);
    assert_eq!(a.class, b.class);
    assert_eq!(a.time, b.time);
    assert_eq!(a.ret, b.ret);
    // Counts by return match the header.
    let mut br = [0u64; 15];
    for r in &a.ret {
        br[(r & 15) as usize - 1] += 1;
    }
    assert_eq!(br, h.by_return);
    // CRS.
    let v = las::vlrs(&las_b, &h).unwrap();
    let w = v.iter().find(|x| x.record_id == 2112).unwrap();
    let wkt = String::from_utf8_lossy(&las_b[w.data_offset as usize..(w.data_offset + w.data_len) as usize]).to_string();
    let wi = las::wkt(&wkt);
    assert_eq!(wi.h_epsg, Some(32611));
    assert_eq!(wi.v_epsg, Some(5773));
    assert_eq!(wi.h_unit, 1.0);
    assert_eq!(wi.v_unit, 1.0);
}

#[test]
fn us_feet_geokeys() {
    let Some(b) = fixture("fx09_ftus.las") else { return };
    let h = las::header(&b).unwrap();
    assert_eq!((h.version, h.format, h.record_len), ((1, 2), 3, 34));
    let v = las::vlrs(&b, &h).unwrap();
    let d = v.iter().find(|x| x.record_id == 34735).unwrap();
    let keys = las::geokeys(&b[d.data_offset as usize..(d.data_offset + d.data_len) as usize], &[], &[]);
    let get = |id: u16| keys.iter().find(|k| k.0 == id).map(|k| matches!(k.1, las::KeyValue::Int(v) if v > 0)).unwrap_or(false);
    assert!(get(3072) && get(3076) && get(4096) && get(4099));
    assert!(keys.iter().any(|k| k.0 == 3076 && matches!(k.1, las::KeyValue::Int(9003))));
    // WKT 2 with feet.
    let w2 = las::wkt(r#"COMPOUNDCRS["x",PROJCRS["NAD83 / California zone 5 (ftUS)",BASEGEOGCRS["NAD83",DATUM["North American Datum 1983",ELLIPSOID["GRS 1980",6378137,298.257222101]]],CONVERSION["SPCS83 California zone 5",METHOD["Lambert Conic Conformal (2SP)"]],CS[Cartesian,2],AXIS["easting (X)",east,LENGTHUNIT["US survey foot",0.304800609601219]],AXIS["northing (Y)",north,LENGTHUNIT["US survey foot",0.304800609601219]],ID["EPSG",2229]],VERTCRS["NAVD88 height (ftUS)",VDATUM["North American Vertical Datum 1988"],CS[vertical,1],AXIS["gravity-related height (H)",up,LENGTHUNIT["US survey foot",0.304800609601219]],ID["EPSG",6360]]]"#);
    assert_eq!(w2.h_epsg, Some(2229));
    assert_eq!(w2.v_epsg, Some(6360));
    assert!((w2.h_unit - 0.304800609601219).abs() < 1e-12 && (w2.v_unit - 0.304800609601219).abs() < 1e-12);
}

#[test]
fn smrf_lod_grid_profile_and_write() {
    let Some(las_b) = fixture("fx09.las") else { return };
    let (h, c) = read_all(&las_b);
    // Exclude the high noise (class 18) as a user would with a class filter; keep the low noise.
    let mask: Vec<u8> = c.class.iter().map(|&k| u8::from(k != 18)).collect();
    let t0 = std::time::Instant::now();
    let cls = smrf::smrf(&c.pos, Some(&mask), &smrf::Params::default());
    let ms = t0.elapsed().as_millis();
    let (mut agree, mut n, mut low_ok) = (0usize, 0usize, 0usize);
    for k in 0..c.n {
        if mask[k] == 0 {
            continue;
        }
        if c.class[k] == 7 {
            low_ok += usize::from(cls[k] == smrf::LOW_NOISE);
            continue;
        }
        n += 1;
        agree += usize::from((cls[k] == smrf::GROUND) == (c.class[k] == 2));
    }
    let frac = agree as f64 / n as f64;
    eprintln!("SMRF {ms} ms: {:.2} % agree with the truth classes; {low_ok}/30 low noise found", frac * 100.0);
    assert!(frac >= 0.97, "SMRF agreement {frac}");
    assert!(low_ok >= 27);
    // LOD index: a permutation; tiles partition it; levels are non-decreasing inside a tile.
    let t0 = std::time::Instant::now();
    let ix = lod::index(&c.pos, 120.0, 8.0, 12);
    eprintln!("LOD index {} ms, {} tiles", t0.elapsed().as_millis(), ix.tiles.len());
    let mut seen = vec![false; c.n];
    for &p in &ix.perm {
        assert!(!seen[p as usize]);
        seen[p as usize] = true;
    }
    assert_eq!(ix.tiles.iter().map(|t| t.count).sum::<usize>(), c.n);
    assert!(ix.tiles.iter().all(|t| t.levels.iter().map(|v| *v as usize).sum::<usize>() == t.count));
    // Grids: DSM/DTM over the frame.
    let g = GridSpec { e0: 0.5, n0: (h.max[1] - h.min[1]).floor() - 0.5, ce: 1.0, cn: 1.0, w: (h.max[0] - h.min[0]) as usize, h: (h.max[1] - h.min[1]) as usize };
    let gm: Vec<u8> = c.class.iter().map(|&k| u8::from(k == 2)).collect();
    let dtm = grid(&c.pos, Some(&gm), None, &g, Mode::Plane);
    let dsm = grid(&c.pos, Some(&mask), None, &g, Mode::Max);
    let filled = dtm.iter().filter(|v| v.is_finite()).count() as f64 / dtm.len() as f64;
    assert!(filled > 0.9, "DTM coverage {filled}");
    assert!(dsm.iter().zip(&dtm).filter(|(a, b)| a.is_finite() && b.is_finite()).any(|(a, b)| a - b > 14.0));
    // Profile: only points inside the swath.
    let a = [100.0, 100.0];
    let b2 = [300.0, 250.0];
    let pr = profile::profile(&c.pos, None, a, b2, 1.5, 0);
    assert!(!pr.index.is_empty());
    assert!(pr.across.iter().all(|d| d.abs() <= 1.5));
    assert!(pr.along.windows(2).all(|w| w[0] <= w[1]));
    // Write LAS 1.4 (identity inverse lattice back to the header frame) and read it again.
    let inv = Lattice { x0: 0.0, y0: 0.0, dx: 1000.0, dy: 1000.0, nx: 2, ny: 2, nodes: vec![[h.min[0], h.min[1], 0.0], [h.min[0] + 1000.0, h.min[1], 0.0], [h.min[0], h.min[1] + 1000.0, 0.0], [h.min[0] + 1000.0, h.min[1] + 1000.0, 0.0]], v_unit: 1.0 };
    for compress in [false, true] {
        let spec = WriteSpec { format: 6, scale: [0.001; 3], wkt: "PROJCS[\"x\"]".into(), system_id: "GIS Workbench".into(), software: "test".into(), day: 1, year: 2026, adjusted_gps: true, t0: 1.3e9, compress };
        let bytes = write(&c, &inv, &spec).unwrap();
        let (h2, c2) = read_all(&bytes);
        assert_eq!(h2.n_points, h.n_points);
        assert_eq!(h2.compressed, compress);
        let maxd = c.pos.iter().zip(&c2.pos).map(|(x, y)| (x - y).abs()).fold(0f32, f32::max);
        // Different offsets requantise: within half a millimetre.
        assert!(maxd <= 0.0011, "round trip {maxd}");
        assert_eq!(c.class, c2.class);
        assert_eq!(c.ret, c2.ret);
        assert_eq!(c.intensity, c2.intensity);
    }
}
