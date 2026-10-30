//! REQ-EXT-13 / AC-10.5: each check on a constructed case, with no false alarms on clean ones.

use gw_vector::{apply_fix, validate, Feature, Fix, Kind, Opts};

fn line(v: &[[f64; 2]]) -> Feature {
    Feature {
        kind: Kind::Line,
        parts: vec![v.to_vec()],
        polys: vec![],
    }
}
fn poly(v: &[[f64; 2]]) -> Feature {
    Feature {
        kind: Kind::Polygon,
        parts: vec![v.to_vec()],
        polys: vec![0],
    }
}
fn rect(x: f64, y: f64, w: f64, h: f64) -> Feature {
    poly(&[[x, y], [x + w, y], [x + w, y + h], [x, y + h]])
}

#[test]
fn checks() {
    let fs = vec![
        // 0: main road along x.
        line(&[[0.0, 0.0], [100.0, 0.0]]),
        // 1: side road ending 1.2 m short of road 0 (undershoot).
        line(&[[50.0, 30.0], [50.0, 1.2]]),
        // 2: side road crossing road 0 and running 0.8 m past it (overshoot).
        line(&[[20.0, 30.0], [20.0, -0.8]]),
        // 3: a free end 10 m away (no issue) and a proper T junction at the other end (no issue).
        line(&[[80.0, 40.0], [80.0, 0.0]]),
        // 4: bow-tie polygon (self-intersection).
        poly(&[[200.0, 0.0], [210.0, 10.0], [210.0, 0.0], [200.0, 10.0]]),
        // 5, 6: duplicates (6 starts elsewhere and runs the other way).
        rect(300.0, 0.0, 10.0, 10.0),
        poly(&[[310.0, 10.0], [310.0, 0.0], [300.0, 0.0], [300.0, 10.0]]),
        // 7, 8: overlapping squares.
        rect(400.0, 0.0, 10.0, 10.0),
        rect(405.0, 5.0, 10.0, 10.0),
        // 9, 10: neighbours sharing an edge (no overlap).
        rect(500.0, 0.0, 10.0, 10.0),
        rect(510.0, 0.0, 10.0, 10.0),
        // 11: sliver.
        rect(600.0, 0.0, 30.0, 0.3),
        // 12: polygon with a hole outside the shell.
        Feature {
            kind: Kind::Polygon,
            parts: vec![
                vec![[700.0, 0.0], [710.0, 0.0], [710.0, 10.0], [700.0, 10.0]],
                vec![[720.0, 0.0], [722.0, 0.0], [722.0, 2.0]],
            ],
            polys: vec![0],
        },
    ];
    let o = Opts::default();
    let is = validate(&fs, &o);
    let has = |c: &str, f: usize| is.iter().any(|i| i.check == c && i.feature == f);
    for i in &is {
        eprintln!("{} f{} {:?}: {}", i.check, i.feature, i.other, i.message);
    }
    assert!(has("dangle", 1));
    assert!(has("overshoot", 2));
    assert!(!is
        .iter()
        .any(|i| i.feature == 3 && (i.check == "dangle" || i.check == "overshoot")));
    assert!(!is
        .iter()
        .any(|i| i.feature == 0 && (i.check == "dangle" || i.check == "overshoot")));
    assert!(has("self_intersection", 4));
    assert!(has("duplicate", 6));
    assert!(has("overlap", 7));
    assert!(!is
        .iter()
        .any(|i| i.check == "overlap" && (i.feature == 9 || i.feature == 10)));
    assert!(has("sliver", 11));
    assert!(has("ring", 12));
    assert!(!is
        .iter()
        .any(|i| i.check == "self_intersection" && i.feature != 4 && i.feature != 12));
    // Fixes close the dangle and trim the overshoot; a second pass is clean for them.
    let mut fixed = fs.clone();
    for i in &is {
        if let (Some(fix), true) = (&i.fix, i.check == "dangle" || i.check == "overshoot") {
            apply_fix(&mut fixed[i.feature], fix);
            if let Fix::Move { to, .. } = fix {
                assert!((to[1]).abs() < 1e-9);
            }
        }
    }
    let again = validate(&fixed, &o);
    assert!(
        !again
            .iter()
            .any(|i| i.check == "dangle" || i.check == "overshoot"),
        "{:?}",
        again.iter().map(|i| &i.message).collect::<Vec<_>>()
    );
    assert!((fixed[2].parts[0].last().unwrap()[1]).abs() < 1e-9);
}

/// Two coastline-sized neighbours (TE 2.0.4: Natural Earth countries ran past 300 s): overlap is
/// found, a shared border is not an overlap, and the check stays fast.
#[test]
fn polygon_overlap_large_rings() {
    let n = 40_000;
    // A wavy-edged half disc and its mirror sharing the wavy x = 0 border, then one nudged across it.
    let edge: Vec<[f64; 2]> = (0..=n)
        .map(|i| {
            let y = -5000.0 + 10_000.0 * i as f64 / n as f64;
            [((i as f64) * 0.37).sin() * 3.0, y]
        })
        .collect();
    let mut left: Vec<[f64; 2]> = edge.clone();
    left.extend([[-6000.0, 5000.0], [-6000.0, -5000.0]]);
    let mut right: Vec<[f64; 2]> = edge.iter().rev().copied().collect();
    right.extend([[6000.0, -5000.0], [6000.0, 5000.0]]);
    let shift: Vec<[f64; 2]> = right.iter().map(|v| [v[0] - 50.0, v[1]]).collect();
    let o = Opts {
        tol: 2.0,
        dup_tol: 0.01,
        sliver: 0.0,
        sliver_area: 0.0,
    };
    let t = std::time::Instant::now();
    let touching = validate(&[poly(&left), poly(&right)], &o);
    let crossing = validate(&[poly(&left), poly(&shift)], &o);
    let ms = t.elapsed().as_millis();
    assert!(
        !touching.iter().any(|i| i.check == "overlap"),
        "a shared border is not an overlap"
    );
    assert!(
        crossing.iter().any(|i| i.check == "overlap"),
        "a polygon pushed 50 m across its neighbour overlaps it"
    );
    assert!(
        ms < 20_000,
        "{ms} ms for two 40 000-vertex neighbours (unoptimised build)"
    );
}

#[test]
fn polygon_overlap_small_cases() {
    let o = Opts {
        tol: 0.5,
        dup_tol: 0.01,
        sliver: 0.0,
        sliver_area: 0.0,
    };
    let has = |fs: &[Feature]| validate(fs, &o).iter().any(|i| i.check == "overlap");
    assert!(
        has(&[rect(0.0, 0.0, 10.0, 10.0), rect(5.0, 5.0, 10.0, 10.0)]),
        "crossing squares"
    );
    assert!(
        has(&[rect(0.0, 0.0, 10.0, 10.0), rect(2.0, 2.0, 3.0, 3.0)]),
        "one inside the other"
    );
    assert!(
        !has(&[rect(0.0, 0.0, 10.0, 10.0), rect(10.0, 0.0, 10.0, 10.0)]),
        "edge-adjacent squares"
    );
    assert!(
        !has(&[rect(0.0, 0.0, 10.0, 10.0), rect(30.0, 0.0, 10.0, 10.0)]),
        "apart"
    );
}
