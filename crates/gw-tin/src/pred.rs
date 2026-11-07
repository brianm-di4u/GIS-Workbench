//! Exact geometric predicates on integer coordinates (REQ-GAP-39). Every TIN vertex is snapped
//! to a grid of `Q` metres with |coordinate| ≤ `LIM` grid steps from the TIN origin, so a
//! difference fits 31 bits: orient2d is exact in i128, and so is incircle (four 31-bit factors,
//! sum < 2^124). A float filter answers the clear cases; the exact path decides the rest.

/// Largest |coordinate| in grid steps.
pub const LIM: i64 = 1 << 29;

/// Sign of the area of (a, b, c): +1 counter-clockwise, −1 clockwise, 0 collinear.
#[inline]
pub fn orient(ax: i64, ay: i64, bx: i64, by: i64, cx: i64, cy: i64) -> i32 {
    let (acx, bcx, acy, bcy) = (ax - cx, bx - cx, ay - cy, by - cy);
    let l = acx as f64 * bcy as f64;
    let r = acy as f64 * bcx as f64;
    let det = l - r;
    // The differences are exact in f64; two products and one subtraction round.
    let bound = 3.4e-16 * (l.abs() + r.abs());
    if det > bound {
        return 1;
    }
    if -det > bound {
        return -1;
    }
    let d = acx as i128 * bcy as i128 - acy as i128 * bcx as i128;
    d.signum() as i32
}

/// +1 when d is strictly inside the circle through the counter-clockwise a, b, c; 0 on it; −1 outside.
#[inline]
#[allow(clippy::too_many_arguments)]
pub fn incircle(ax: i64, ay: i64, bx: i64, by: i64, cx: i64, cy: i64, dx: i64, dy: i64) -> i32 {
    let (adx, ady, bdx, bdy, cdx, cdy) = (ax - dx, ay - dy, bx - dx, by - dy, cx - dx, cy - dy);
    let (fa, fb, fc) = ((adx as f64, ady as f64), (bdx as f64, bdy as f64), (cdx as f64, cdy as f64));
    let al = fa.0 * fa.0 + fa.1 * fa.1;
    let bl = fb.0 * fb.0 + fb.1 * fb.1;
    let cl = fc.0 * fc.0 + fc.1 * fc.1;
    let (bc1, bc2) = (fb.0 * fc.1, fc.0 * fb.1);
    let (ca1, ca2) = (fc.0 * fa.1, fa.0 * fc.1);
    let (ab1, ab2) = (fa.0 * fb.1, fb.0 * fa.1);
    let det = al * (bc1 - bc2) + bl * (ca1 - ca2) + cl * (ab1 - ab2);
    let perm = al * (bc1.abs() + bc2.abs()) + bl * (ca1.abs() + ca2.abs()) + cl * (ab1.abs() + ab2.abs());
    let bound = 1.2e-15 * perm;
    if det > bound {
        return 1;
    }
    if -det > bound {
        return -1;
    }
    let (adx, ady, bdx, bdy, cdx, cdy) = (adx as i128, ady as i128, bdx as i128, bdy as i128, cdx as i128, cdy as i128);
    let al = adx * adx + ady * ady;
    let bl = bdx * bdx + bdy * bdy;
    let cl = cdx * cdx + cdy * cdy;
    let d = al * (bdx * cdy - cdx * bdy) + bl * (cdx * ady - adx * cdy) + cl * (adx * bdy - bdx * ady);
    d.signum() as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orient_and_incircle_are_exact_at_the_limit() {
        let m = LIM;
        assert_eq!(orient(-m, -m, m, -m, m, m), 1);
        assert_eq!(orient(-m, -m, m, m, 0, 0), 0);
        assert_eq!(orient(-m, -m, m, m, 1, 0), -1);
        // Near-degenerate: c one step off the line through two far points.
        assert_eq!(orient(-m, -m + 1, m, m, 0, 1), 1);
        // Four cocircular points at the extreme range, and one step inside / outside.
        assert_eq!(incircle(-m, 0, 0, -m, m, 0, 0, m), 0);
        assert_eq!(incircle(-m, 0, 0, -m, m, 0, 0, m - 1), 1);
        assert_eq!(incircle(-m, 0, 0, -m, m, 0, 0, m + 1), -1);
        assert_eq!(incircle(0, 0, 1, 0, 0, 1, 1, 1), 0);
    }
}
