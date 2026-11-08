//! 2.5 fuzz targets (tin group, REQ-GAP-39): the LandXML reader, the point-text reader, the
//! triangulator on arbitrary point sets and DEM grids, the TIN edit list (parsed and replayed on a
//! small TIN), a file's own faces kept in a TIN (OD-2.41: forced edges and outline rings) and the
//! TIN state loader. Seeds are valid inputs of each; mutations must fail cleanly
//! or run to the end, never panic or hang, and a TIN that comes out must pass its topology check.
//! Iterations: GW_FUZZ_ITERS (default 1500 per target); --release.

use gw_fuzz::run;
use gw_tin::make::{self, GridSpec};
use gw_tin::mesh::{Mesh, E_CONS, INF};
use gw_tin::pred::incircle;
use gw_tin::{faces, landxml, ops, state, text};
use std::path::Path;
use std::time::Duration;

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}
fn hang() -> Duration {
    Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000))
}
fn f64s(b: &[u8]) -> Vec<f64> {
    b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()
}
fn bytes(v: &[f64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// Every unconstrained interior edge locally Delaunay (constraints exempt): a constrained Delaunay
/// triangulation by Lawson's lemma. A TIN that comes out of a build or an edit must pass this as well
/// as its topology check.
fn assert_delaunay(m: &Mesh) {
    for t in m.triangles() {
        let v = m.tv[t as usize];
        for i in 0..3 {
            if m.te[t as usize][i] & E_CONS != 0 {
                continue;
            }
            let w = m.tv[m.tn[t as usize][i] as usize];
            if w.contains(&INF) {
                continue;
            }
            let (a, b) = (v[(i + 1) % 3], v[(i + 2) % 3]);
            let Some(q) = w.iter().copied().find(|&x| x != a && x != b) else { continue };
            let (z, q) = (v.map(|x| x as usize), q as usize);
            assert!(incircle(m.x[z[0]], m.y[z[0]], m.x[z[1]], m.y[z[1]], m.x[z[2]], m.y[z[2]], m.x[q], m.y[q]) <= 0, "an edge that is not Delaunay");
        }
    }
}

const LANDXML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="2026-11-03" time="12:00:00">
  <Units><Imperial linearUnit="USSurveyFoot"/></Units>
  <CoordinateSystem epsgCode="2232" horizontalCoordinateSystemName="NAD83 / Colorado Central (ftUS)"/>
  <Surfaces><Surface name="EG &amp; site">
    <SourceData>
      <Breaklines>
        <Breakline brkType="standard" name="ridge"><PntList3D>1000 2000 5300 1010 2010 5305.5 1020 2015 5302</PntList3D></Breakline>
        <Breakline brkType="nonDestructive"><PntList2D>1000 2010 1020 2000</PntList2D></Breakline>
        <Breakline brkType="proximity"><PntList3D>1005 2005 5301</PntList3D></Breakline>
        <Breakline brkType="wall"><PntList3D>1 2 3 4 5 6</PntList3D></Breakline>
      </Breaklines>
      <Boundaries><Boundary bndType="void"><PntList2D>1004 2004 1006 2004 1005 2006 1004 2004</PntList2D></Boundary><Boundary bndType="dataClip"><PntList2D>0 0 1 1</PntList2D></Boundary></Boundaries>
      <DataPoints><PntList3D>1002 2002 5300.5</PntList3D></DataPoints>
      <Contours/>
    </SourceData>
    <Definition surfType="TIN">
      <Pnts><P id="1">1000 2000 5300</P><P id="2">1000 2020 5301</P><P id="3">1020 2000 5302</P><P id="4">1020 2020 5303</P><P id="x9">1010 2010 5304</P></Pnts>
      <Faces><F>1 2 x9</F><F>2 4 x9</F><F i="1">4 3 x9</F><F>3 1 x9</F></Faces>
    </Definition>
  </Surface><Surface name="g"><Definition surfType="grid"/></Surface></Surfaces>
</LandXML>"#;

fn points_seed(n: usize, seed: u64) -> Vec<f64> {
    let mut s = seed;
    let mut f = move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s >> 11) as f64 / (1u64 << 53) as f64
    };
    (0..n).flat_map(|_| {
        let (x, y) = (500.0 * f(), 400.0 * f());
        [x, y, 100.0 + 0.1 * x]
    }).collect()
}

/// One valid edit list of every kind on the small TIN below.
fn edit_seeds() -> Vec<Vec<u8>> {
    let mut all = vec![0.0];
    let mut seeds = Vec::new();
    let lists: Vec<Vec<f64>> = vec![
        vec![1.0, 250.0, 200.0, 140.0],
        vec![2.0, 250.0, 200.0, 50.0],
        vec![3.0, 250.0, 200.0, 50.0, 260.0, 210.0, f64::NAN],
        vec![4.0, 1.0, 1.0, 0.0, 3.0, 50.0, 50.0, 110.0, 250.0, 300.0, 130.0, 450.0, 60.0, 120.0],
        vec![4.0, 2.0, 2.0, 0.0, 2.0, 60.0, 300.0, f64::NAN, 400.0, 100.0, f64::NAN],
        vec![4.0, 3.0, 3.0, 1.0, 3.0, 200.0, 200.0, 0.0, 260.0, 200.0, 0.0, 230.0, 250.0, 0.0],
        vec![5.0, 1.0],
        vec![6.0, 2.0, 1.0, 0.0, 2.0, 70.0, 310.0, 115.0, 390.0, 90.0, 118.0],
        vec![7.0, 9.0, 1.0, 3.0, 40.0, 40.0, 250.0, 250.0, 460.0, 350.0],
        vec![7.0, 10.0, 2.0, 2.0, 460.0, 40.0, 40.0, 350.0],
        vec![8.0, 4.0, 100.0, 100.0, 200.0, 100.0, 200.0, 200.0, 100.0, 200.0],
        vec![9.0, 11.0, 300.0, 300.0],
        vec![10.0, 3.0, 250.0, 250.0, 350.0, 250.0, 300.0, 350.0],
    ];
    for l in lists {
        let mut v = vec![1.0];
        v.extend_from_slice(&l);
        all[0] += 1.0;
        all.extend_from_slice(&l);
        seeds.push(bytes(&v));
    }
    seeds.push(bytes(&all));
    seeds
}

fn small_tin() -> Mesh {
    make::from_points(&points_seed(300, 77), 0.001, 0.0, 1 << 20).unwrap().0
}

#[test]
fn fuzz_tin25() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    let mut reports = Vec::new();
    // LandXML: every surface read, every refusal by name.
    reports.push(run("tin_landxml", &[LANDXML.as_bytes().to_vec()], n, hang(), &o, |b| {
        if let Ok(s) = std::str::from_utf8(b) {
            let _ = landxml::parse(s);
        }
    }));
    reports.push(run("tin_points_text", &[b"# x y z\nx,y,z,kind,line\n1,2,3,hard,a\n4,5,6,soft,a\n7,8,9,,\n".to_vec(), b"500000 4400000 1600.5\n500001\t4400001\t1601\n".to_vec()], n, hang(), &o, |b| {
        let _ = text::parse(b);
    }));
    // The triangulator on arbitrary points: a TIN that comes out passes its topology check.
    reports.push(run("tin_points", &[bytes(&points_seed(120, 5)), bytes(&[0.0, 0.0, 1.0, 1.0, 0.0, 2.0, 0.0, 1.0, 3.0, 1.0, 1.0, 4.0, 0.5, 0.5, 5.0])], n, hang(), &o, |b| {
        let p = f64s(b);
        if let Ok((m, _)) = make::from_points(&p[..p.len() / 3 * 3], 0.001, 0.0, 100_000) {
            m.check().expect("a built TIN fails its check");
            assert_delaunay(&m);
        }
    }));
    // DEM posts (12 × 10, voids allowed), tolerance from the first value.
    let grid = GridSpec { w: 12, h: 10, ax: 0.0, ay: 0.0, bx: 1.0, by: -1.0 };
    let dseed: Vec<u8> = std::iter::once(0.5f32).chain((0..120).map(|k| 100.0 + ((k * 37) % 11) as f32)).flat_map(|v| v.to_le_bytes()).collect();
    reports.push(run("tin_dem", &[dseed], n, hang(), &o, |b| {
        let f: Vec<f32> = b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        if f.len() < 121 {
            return;
        }
        let tol = if f[0].is_finite() { (f[0] as f64).clamp(-1.0, 100.0) } else { 0.0 };
        if let Ok((m, _)) = make::from_dem(&grid, &f[1..121], tol, 1 << 16, 0.001, |_, _| {}) {
            m.check().expect("a built TIN fails its check");
            assert_delaunay(&m);
        }
    }));
    // The edit list, parsed and replayed on a small TIN (a fresh one per input).
    let base = state::save(&small_tin());
    reports.push(run("tin_edits", &edit_seeds(), n, hang(), &o, |b| {
        if let Ok(list) = ops::parse(&f64s(b)) {
            let mut m = state::load(&base).unwrap();
            for op in &list {
                if let Err(gw_tin::mesh::Fail::Broken(e)) = ops::apply(&mut m, op) {
                    // A broken edit asks for a rebuild; the app does that. Not a crash.
                    let _ = e;
                    return;
                }
            }
            m.check().expect("an edited TIN fails its check");
            assert_delaunay(&m);
        }
    }));
    // A file's own faces (OD-2.41) over the points of a small TIN: faces as u32 point indices (the top
    // bit of a face's first index hides it), so mutations give out-of-range, repeated, degenerate,
    // overlapping and crossing faces. It never fails; what comes out passes its checks.
    let fpts = points_seed(60, 9);
    let fbase = state::save(&make::from_points(&fpts, 0.001, 0.0, 1 << 20).unwrap().0);
    let fseed: Vec<u8> = {
        let m = state::load(&fbase).unwrap();
        let mut v: Vec<u32> = m.triangles().flat_map(|t| m.tv[t as usize]).collect();
        // The TIN's own faces, the first one hidden; mutations make the rest.
        v.truncate(v.len() - v.len() % 3);
        v[0] |= 1 << 31;
        v.iter().flat_map(|x| x.to_le_bytes()).collect()
    };
    reports.push(run("tin_keep_faces", &[fseed], n, hang(), &o, |b| {
        let raw: Vec<u32> = b.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect();
        let nf = raw.len() / 3;
        let hidden: Vec<u8> = (0..nf).map(|f| (raw[3 * f] >> 31) as u8).collect();
        let fs: Vec<u32> = raw[..3 * nf].iter().map(|v| (v & 0x7fff_ffff) % 64).collect(); // a few out of range
        let mut m = state::load(&fbase).unwrap();
        match faces::keep_faces(&mut m, &fpts, &fs, &hidden, faces::KEY0) {
            Ok(k) => {
                assert!(k.skipped <= k.faces && k.kept <= m.nreal, "{k:?}");
                m.check().expect("a TIN with a file's faces fails its check");
                assert_delaunay(&m);
                m.classify();
            }
            Err(gw_tin::mesh::Fail::Refused(_)) => {}
            Err(gw_tin::mesh::Fail::Broken(e)) => panic!("keep_faces broke the TIN: {e}"),
        }
    }));
    // The state loader: damaged state refused or still consistent.
    let mut st = small_tin();
    let _ = ops::apply(&mut st, &ops::parse(&f64s(&edit_seeds()[3])).unwrap()[0]);
    let sseed = state::save(&st);
    reports.push(run("tin_state", &[sseed], n, hang(), &o, |b| {
        if let Ok(m) = state::load(b) {
            m.check().expect("a loaded state fails its check");
        }
    }));
    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("{}: {} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
        assert!(r.runs > 0 || r.skipped, "{}: no seeds", r.target);
        for (p, m) in &r.crashes {
            bad.push(format!("{} {}: {m}", r.target, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}
