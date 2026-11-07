//! TE 2.0.4: LAS/LAZ export in slabs (clouds too large for one pass in the 1 GiB worker) gives the
//! same bytes as the one-piece writer, and chunk-by-chunk LAZ compression equals laz-rs's
//! compress_buffer for the same records.

use gw_pointcloud::decode::{Columns, Lattice};
use gw_pointcloud::laz;
use gw_pointcloud::write::{bounds, head, offset_for, points, write, WriteSpec};

fn cloud(n: usize) -> Columns {
    let mut c = Columns::with_capacity(n, false);
    for k in 0..n {
        let f = k as f32;
        c.pos.extend([(f * 0.37) % 900.0, (f * 0.91) % 700.0, 100.0 + (f * 0.013).sin() * 20.0]);
        c.time.push(f * 0.001);
        c.intensity.push((k % 4096) as u16);
        c.source.push(7);
        c.scan.push((k % 90) as i16);
        c.class.push([1u8, 2, 5, 6][k % 4]);
        c.ret.push(0x11 + ((k % 3) as u8) * 0x10);
        c.flags.push(0);
        c.user.push(0);
    }
    c.n = n;
    c
}

fn slab(c: &Columns, a: usize, b: usize) -> Columns {
    let mut s = Columns::with_capacity(b - a, false);
    s.pos.extend_from_slice(&c.pos[3 * a..3 * b]);
    s.time.extend_from_slice(&c.time[a..b]);
    s.intensity.extend_from_slice(&c.intensity[a..b]);
    s.source.extend_from_slice(&c.source[a..b]);
    s.scan.extend_from_slice(&c.scan[a..b]);
    s.class.extend_from_slice(&c.class[a..b]);
    s.ret.extend_from_slice(&c.ret[a..b]);
    s.flags.extend_from_slice(&c.flags[a..b]);
    s.user.extend_from_slice(&c.user[a..b]);
    s.n = b - a;
    s
}

fn spec(compress: bool) -> WriteSpec {
    WriteSpec { format: 6, scale: [0.001; 3], wkt: "LOCAL_CS[\"test\"]".into(), system_id: "GIS Workbench".into(), software: "test".into(), day: 1, year: 2026, adjusted_gps: true, t0: 0.0, compress }
}

#[test]
fn slabs_match_the_one_piece_writer() {
    let inv = Lattice { x0: 0.0, y0: 0.0, dx: 1000.0, dy: 1000.0, nx: 2, ny: 2, nodes: vec![[500000.0, 4000000.0, 0.0], [501000.0, 4000000.0, 0.0], [500000.0, 4001000.0, 0.0], [501000.0, 4001000.0, 0.0]], v_unit: 1.0 };
    let c = cloud(130_000);
    for compress in [false, true] {
        let s = spec(compress);
        let one = write(&c, &inv, &s).unwrap();
        // Slabs of 100 000 and 30 000 points (whole LAZ chunks of 50 000, then the rest).
        let parts = [slab(&c, 0, 100_000), slab(&c, 100_000, 130_000)];
        let (mut mn, mut mx) = ([f64::MAX; 3], [f64::MIN; 3]);
        for p in &parts {
            let (a, b) = bounds(p, &inv);
            for i in 0..3 {
                mn[i] = mn[i].min(a[i]);
                mx[i] = mx[i].max(b[i]);
            }
        }
        let off = offset_for(&mn);
        let mut by_return = [0u64; 15];
        let mut body = Vec::new();
        let mut entries = Vec::new();
        for p in &parts {
            let (raw, br) = points(p, &inv, &s, &off).unwrap();
            for i in 0..15 {
                by_return[i] += br[i];
            }
            if compress {
                let (b, e) = laz::compress_chunks(&raw, 6, 0).unwrap();
                body.extend(b);
                entries.extend(e);
            } else {
                body.extend(raw);
            }
        }
        let mut out = head(&s, c.n, &off, &mn, &mx, &by_return, compress.then_some((&entries[..], body.len() as u64))).unwrap();
        out.extend(&body);
        if compress {
            out.extend(laz::laz_table(&entries, 6, 0).unwrap().1);
        }
        assert_eq!(out.len(), one.len(), "compress {compress}");
        assert!(out == one, "compress {compress}: slab bytes differ from the one-piece writer");
    }
}

#[test]
fn chunk_by_chunk_equals_compress_buffer() {
    let inv = Lattice { x0: 0.0, y0: 0.0, dx: 1000.0, dy: 1000.0, nx: 2, ny: 2, nodes: vec![[0.0, 0.0, 0.0], [1000.0, 0.0, 0.0], [0.0, 1000.0, 0.0], [1000.0, 1000.0, 0.0]], v_unit: 1.0 };
    let c = cloud(120_001);
    let (raw, _) = points(&c, &inv, &spec(true), &[0.0; 3]).unwrap();
    let (_, whole) = laz::compress(&raw, 6, 0, 0).unwrap();
    let (body, entries) = laz::compress_chunks(&raw, 6, 0).unwrap();
    let (_, table) = laz::laz_table(&entries, 6, 0).unwrap();
    assert_eq!(entries.len(), 3);
    assert_eq!(&whole[8..8 + body.len()], &body[..], "chunks");
    assert_eq!(&whole[8 + body.len()..], &table[..], "chunk table");
}
