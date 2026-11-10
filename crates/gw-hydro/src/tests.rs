use super::*;

/// The whole chain on a grid: fill, D8, accumulation, Strahler, Shreve.
fn chain(z: &mut [f32], w: usize, h: usize, eps: bool, thresh: u32) -> (Vec<u8>, Vec<u32>, Vec<u8>, Vec<u32>, FillStats) {
    let n = w * h;
    let mut dir = vec![0u8; n];
    let st = fill(z, w, h, eps, &mut dir, n);
    d8(z, w, h, 1.0, 1.0, &mut dir);
    let (mut acc, mut so, mut sh) = (vec![0u32; n], vec![0u8; n], vec![0u32; n]);
    let done = accumulate(&mut dir, w, h, &mut acc, &mut so, &mut sh, thresh);
    assert_eq!(done, st.valid, "every valid post is reached once (no cycle)");
    (dir, acc, so, sh, st)
}

#[test]
fn fill_raises_a_pit_to_its_spill_height() {
    // A 5 × 5 bowl: rim 10, floor 2, one gap in the rim at 6.
    let mut z = vec![10.0f32; 25];
    for y in 1..4 {
        for x in 1..4 {
            z[y * 5 + x] = 2.0;
        }
    }
    z[2] = 6.0; // gap on the north edge
    let mut dir = vec![0u8; 25];
    let st = fill(&mut z, 5, 5, false, &mut dir, 25);
    for y in 1..4 {
        for x in 1..4 {
            assert_eq!(z[y * 5 + x], 6.0, "floor filled to the spill height");
        }
    }
    assert_eq!(st.valid, 25);
    assert_eq!(st.raised, 9);
    // Epsilon: every raised post is above its parent, so D8 finds a downhill neighbour everywhere.
    let mut z2 = vec![10.0f32; 25];
    for y in 1..4 {
        for x in 1..4 {
            z2[y * 5 + x] = 2.0;
        }
    }
    z2[2] = 6.0;
    let mut dir2 = vec![0u8; 25];
    fill(&mut z2, 5, 5, true, &mut dir2, 25);
    assert!(z2[12] > 6.0 && z2[7] > 6.0 && z2[12] > z2[7], "deeper posts end higher than those nearer the spill");
}

#[test]
fn d8_follows_the_steepest_descent_with_rectangular_posts() {
    // A plane falling to the east: every interior post flows east.
    let (w, h) = (4, 3);
    let z: Vec<f32> = (0..w * h).map(|i| 10.0 - (i % w) as f32).collect();
    let mut dir = vec![0u8; w * h];
    d8(&z, w, h, 1.0, 1.0, &mut dir);
    assert_eq!(dir[5], 1, "east");
    // Falling 1 per post east and 1 per post south: with dy = 3 the slope south is a third, so east wins;
    // with dx = 3 south wins.
    let z: Vec<f32> = (0..9).map(|i| 10.0 - (i % 3) as f32 - (i / 3) as f32).collect();
    let mut dir = vec![0u8; 9];
    d8(&z, 3, 3, 1.0, 3.0, &mut dir);
    assert_eq!(dir[4], 1, "east when the rows are far apart");
    let mut dir = vec![0u8; 9];
    d8(&z, 3, 3, 3.0, 1.0, &mut dir);
    assert_eq!(dir[4], 7, "south when the columns are far apart");
}

/// A Y-shaped valley on a 9 × 9 grid: two branches meet at (4, 4) and leave by the south edge. Edge
/// posts flow inwards when they can, so the side slopes gather up to 4 posts: streams start at 5.
fn y_valley() -> Vec<f32> {
    let (w, h) = (9usize, 9usize);
    let mut z = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let fy = y as f32;
            // Distance to the branch lines x = 4 - (4 - y) and x = 4 + (4 - y) above the junction, x = 4 below.
            let d = if y < 4 { (x as f32 - (y as f32)).abs().min((x as f32 - (8.0 - y as f32)).abs()) } else { (x as f32 - 4.0).abs() };
            z[y * w + x] = 100.0 - 2.0 * fy + 5.0 * d;
        }
    }
    z
}

#[test]
fn accumulation_strahler_and_shreve_on_a_y_network() {
    let mut z = y_valley();
    let (dir, acc, so, sh, st) = chain(&mut z, 9, 9, true, 5);
    assert_eq!(st.valid, 81);
    // The outlet at the bottom of the trunk drains at least the trunk and both branches.
    let trunk_low = 8 * 9 + 4;
    assert!(acc[trunk_low] >= 9, "acc {}", acc[trunk_low]);
    assert_eq!(dir[trunk_low], OUTLET);
    // Below the junction: two order-1 links meet, so order 2 and magnitude 2.
    assert_eq!(so[6 * 9 + 4], 2);
    assert_eq!(sh[6 * 9 + 4], 2);
    // On a branch: order 1, magnitude 1.
    assert!(acc[3 * 9 + 3] >= 5, "acc {}", acc[3 * 9 + 3]);
    assert_eq!(so[3 * 9 + 3], 1);
    assert_eq!(sh[3 * 9 + 3], 1);
    // Off the network: nothing.
    assert_eq!(acc[4 * 9], 1);
    assert_eq!(so[4 * 9], 0);
    assert_eq!(sh[4 * 9], 0);
}

#[test]
fn streams_are_links_that_join_at_junctions() {
    let mut z = y_valley();
    let (dir, acc, so, sh, _) = chain(&mut z, 9, 9, true, 5);
    let s = streams(&dir, &acc, &so, &sh, 9, 5);
    let mut links = Vec::new();
    let mut k = 0;
    while k < s.len() {
        let c = s[k] as usize;
        links.push((s[k + 1], s[k + 2], s[k + 3..k + 3 + c].to_vec()));
        k += 3 + c;
    }
    assert_eq!(links.len(), 3, "two branches and the trunk: {links:?}");
    let trunk = links.iter().find(|l| l.0 == 2).expect("an order-2 link");
    assert_eq!(trunk.1, 2);
    assert_eq!(*trunk.2.last().unwrap() as usize, 8 * 9 + 4, "the trunk ends at the outlet");
    // Each branch ends on the trunk's first post.
    for b in links.iter().filter(|l| l.0 == 1) {
        assert_eq!(b.2.last(), trunk.2.first());
        assert!(b.2.len() >= 2);
    }
}

#[test]
fn snap_and_label_watersheds() {
    let mut z = y_valley();
    let (dir, acc, ..) = chain(&mut z, 9, 9, true, 4);
    // A pour point one post off the trunk snaps onto it.
    let mut pts = vec![(7 * 9 + 5) as u32];
    snap(&acc, 9, 9, &mut pts, 1);
    assert_eq!(pts[0] as usize % 9, 4);
    let mut lab = vec![0u32; 81];
    label(&dir, 9, &pts, &mut lab);
    let inside = lab.iter().filter(|&&l| l == 1).count() as u32;
    assert_eq!(inside, acc[pts[0] as usize], "the watershed holds exactly the posts that accumulate at the pour point");
    // A second pour point upstream on a branch takes its own basin out of the first.
    let mut pts2 = vec![pts[0], (2 * 9 + 2) as u32];
    snap(&acc, 9, 9, &mut pts2[1..], 0);
    label(&dir, 9, &pts2, &mut lab);
    let a1 = lab.iter().filter(|&&l| l == 1).count() as u32;
    let a2 = lab.iter().filter(|&&l| l == 2).count() as u32;
    assert_eq!(a1 + a2, inside);
    assert_eq!(a2, acc[pts2[1] as usize]);
}

#[test]
fn nodata_is_left_out_and_its_neighbours_drain_into_it() {
    let mut z: Vec<f32> = (0..25).map(|i| 10.0 + (i % 5) as f32).collect();
    z[12] = f32::NAN;
    let (dir, acc, ..) = chain(&mut z, 5, 5, false, 1000);
    assert_eq!(dir[12], 0);
    assert_eq!(acc[12], 0);
    // Next to nodata, a post still flows to a lower valid neighbour, never into the nodata post.
    assert!(dir[13] != 0 && dir[13] != OUTLET && dir[13] != 5, "dir {}", dir[13]);
    // A post with no lower neighbour at all drains off the grid.
    assert_eq!(dir[10], OUTLET);
}

#[test]
fn dinf_splits_flow_between_facet_posts_and_conserves_it() {
    // A plane whose fall line points 22.5° north of east on square posts: half the flow to E, half to NE.
    let (w, h) = (7usize, 7usize);
    let a = 22.5f32.to_radians();
    let mut z = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            z[y * w + x] = 100.0 - (x as f32 * a.cos() - y as f32 * a.sin());
        }
    }
    let mut dir = vec![0u8; w * h];
    let mut zf = z.clone();
    fill(&mut zf, w, h, false, &mut dir, w * h);
    d8(&zf, w, h, 1.0, 1.0, &mut dir);
    let mut ang = vec![0f32; w * h];
    dinf(&zf, w, h, 1.0, 1.0, &dir, &mut ang);
    let c = 3 * w + 3;
    assert!((ang[c] - 0.5).abs() < 1e-4, "facet 0, share 0.5: {}", ang[c]);
    let mut indeg = vec![0u8; w * h];
    let mut acc = vec![0f32; w * h];
    let (done, lost) = dinf_accumulate(&ang, w, h, &mut indeg, &mut acc);
    assert_eq!(done as usize, w * h);
    assert!((lost - (w * h) as f64).abs() < 1e-3, "all the flow leaves the grid: {lost}");
}

#[test]
fn dinf_on_rectangular_posts_uses_the_true_facet_angle() {
    // Fall line straight to the north-east neighbour when dx = 2, dy = 1: the angle atan(1/2) from east.
    let (w, h) = (5usize, 5usize);
    let (dx, dy) = (2.0f32, 1.0f32);
    let th = dy.atan2(dx);
    let mut z = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (e, n) = (x as f32 * dx, -(y as f32) * dy);
            z[y * w + x] = 100.0 - (e * th.cos() + n * th.sin());
        }
    }
    let mut dir = vec![0u8; w * h];
    d8(&z, w, h, dx as f64, dy as f64, &mut dir);
    let mut ang = vec![0f32; w * h];
    dinf(&z, w, h, dx as f64, dy as f64, &dir, &mut ang);
    let c = 2 * w + 2;
    assert!((ang[c] - 1.0).abs() < 1e-4, "all to the NE post: {}", ang[c]);
}

