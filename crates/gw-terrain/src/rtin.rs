//! Right-triangulated irregular network (RTIN) terrain meshes (REQ-STR-11; the "Martini" scheme
//! of Evans et al. 2001): on a (2^k + 1)² height grid, the error of every bintree triangle's
//! hypotenuse midpoint is propagated up the tree once; a mesh for any error bound is then the
//! set of triangles that need no further split. NaN heights should be filled before.

pub struct Rtin {
    size: usize,
    errors: Vec<f32>,
}

impl Rtin {
    /// `z` = size² heights, size = 2^k + 1.
    pub fn new(z: &[f32], size: usize) -> Option<Self> {
        let tile = size.checked_sub(1)?;
        if tile == 0 || tile & (tile - 1) != 0 || z.len() != size * size {
            return None;
        }
        let num_tri = tile * tile * 2 - 2;
        let num_parent = num_tri - tile * tile;
        let mut errors = vec![0f32; size * size];
        for i in (0..num_tri).rev() {
            let (ax, ay, bx, by, cx, cy) = coords(i, tile);
            let (mx, my) = ((ax + bx) >> 1, (ay + by) >> 1);
            let interp = (z[ay * size + ax] + z[by * size + bx]) / 2.0;
            let mi = my * size + mx;
            let me = (interp - z[mi]).abs();
            errors[mi] = errors[mi].max(me);
            if i < num_parent {
                let l = ((ay + cy) >> 1) * size + ((ax + cx) >> 1);
                let r = ((by + cy) >> 1) * size + ((bx + cx) >> 1);
                errors[mi] = errors[mi].max(errors[l]).max(errors[r]);
            }
        }
        Some(Rtin { size, errors })
    }

    /// Mesh for an error bound: (vertices as grid (x, y), triangles as vertex indices).
    pub fn mesh(&self, max_error: f32) -> (Vec<[u32; 2]>, Vec<[u32; 3]>) {
        let size = self.size;
        let max = size - 1;
        let mut index = vec![u32::MAX; size * size];
        let mut verts: Vec<[u32; 2]> = Vec::new();
        let mut tris: Vec<[u32; 3]> = Vec::new();
        let mut stack = vec![(0usize, 0usize, max, max, max, 0usize), (max, max, 0, 0, 0, max)];
        while let Some((ax, ay, bx, by, cx, cy)) = stack.pop() {
            let (mx, my) = ((ax + bx) >> 1, (ay + by) >> 1);
            if ax.abs_diff(cx) + ay.abs_diff(cy) > 1 && self.errors[my * size + mx] > max_error {
                stack.push((cx, cy, ax, ay, mx, my));
                stack.push((bx, by, cx, cy, mx, my));
            } else {
                let mut v = |x: usize, y: usize| -> u32 {
                    let k = y * size + x;
                    if index[k] == u32::MAX {
                        index[k] = verts.len() as u32;
                        verts.push([x as u32, y as u32]);
                    }
                    index[k]
                };
                let (ia, ib, ic) = (v(ax, ay), v(bx, by), v(cx, cy));
                tris.push([ia, ib, ic]);
            }
        }
        (verts, tris)
    }
}

/// Corner coordinates of bintree triangle `i` on a tile of `tile` cells.
fn coords(i: usize, tile: usize) -> (usize, usize, usize, usize, usize, usize) {
    let mut id = i + 2;
    let (mut ax, mut ay, mut bx, mut by, mut cx, mut cy);
    if id & 1 == 1 {
        (ax, ay, bx, by, cx, cy) = (0, 0, tile, tile, tile, 0);
    } else {
        (ax, ay, bx, by, cx, cy) = (tile, tile, 0, 0, 0, tile);
    }
    loop {
        id >>= 1;
        if id <= 1 {
            break;
        }
        let (mx, my) = ((ax + bx) >> 1, (ay + by) >> 1);
        if id & 1 == 1 {
            (bx, by) = (ax, ay);
            (ax, ay) = (cx, cy);
        } else {
            (ax, ay) = (bx, by);
            (bx, by) = (cx, cy);
        }
        (cx, cy) = (mx, my);
    }
    (ax, ay, bx, by, cx, cy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_and_bumpy() {
        let size = 65;
        let flat = vec![10f32; size * size];
        let r = Rtin::new(&flat, size).unwrap();
        let (v, t) = r.mesh(0.01);
        assert_eq!((v.len(), t.len()), (4, 2));
        let bump: Vec<f32> = (0..size * size).map(|k| (((k % size) as f32 - 32.0).powi(2) + ((k / size) as f32 - 32.0).powi(2)).sqrt().min(20.0)).collect();
        let r = Rtin::new(&bump, size).unwrap();
        let (v1, t1) = r.mesh(2.0);
        let (v2, t2) = r.mesh(0.1);
        assert!(t2.len() > t1.len() && v2.len() > v1.len());
        // Every triangle is right-angled with axis-aligned or diagonal legs and covers the tile.
        let area: f64 = t2.iter().map(|tr| {
            let p: Vec<[f64; 2]> = tr.iter().map(|&i| [f64::from(v2[i as usize][0]), f64::from(v2[i as usize][1])]).collect();
            ((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])).abs() / 2.0
        }).sum();
        assert!((area - 64.0 * 64.0).abs() < 1e-6);
    }
}
