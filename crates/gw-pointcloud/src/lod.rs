//! Level-of-detail index for rendering with a point budget (REQ-LDR-04): the cloud is cut into
//! square tiles; inside a tile every point gets the coarsest level whose 3D cell (size s0 / 2^L)
//! it is the first to occupy, visiting points in a pseudo-random order. Points are then sorted by
//! tile and level, so any prefix of a tile is an even thinning of it: the renderer draws the first
//! k points of each tile, with k from the tile's share of the budget (a flattened octree).

use std::collections::HashSet;
use std::hash::{BuildHasherDefault, Hasher};

#[derive(Default)]
struct Fx(u64);
impl Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, b: &[u8]) {
        for x in b {
            self.write_u64(u64::from(*x));
        }
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = (self.0.rotate_left(5) ^ v).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}
type FxSet = HashSet<u64, BuildHasherDefault<Fx>>;

pub struct Tile {
    pub start: usize,
    pub count: usize,
    pub min: [f32; 3],
    pub max: [f32; 3],
    /// Points per level (the last entry collects every point finer than the deepest level).
    pub levels: Vec<u32>,
}

pub struct Index {
    pub perm: Vec<u32>,
    pub tiles: Vec<Tile>,
}

#[inline]
fn mix(mut x: u64) -> u64 {
    x ^= x >> 33;
    x = x.wrapping_mul(0xff51_afd7_ed55_8ccd);
    x ^= x >> 33;
    x = x.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    x ^ (x >> 33)
}

/// Build the index. `tile` = tile size (m); `s0` = level-0 cell size (m); `max_level` ≤ 20.
pub fn index(pos: &[f32], tile: f64, s0: f64, max_level: usize) -> Index {
    let n = pos.len() / 3;
    let (mut e0, mut n0, mut e1, mut n1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for k in 0..n {
        e0 = e0.min(pos[3 * k]);
        e1 = e1.max(pos[3 * k]);
        n0 = n0.min(pos[3 * k + 1]);
        n1 = n1.max(pos[3 * k + 1]);
    }
    if n == 0 {
        return Index { perm: Vec::new(), tiles: Vec::new() };
    }
    // TE-015: a cloud with an absurd extent (a CRS misread, e.g. "degrees" of 100° latitude in a
    // synthetic file) asked for billions of tiles and aborted the module. Grow the tile size so the
    // grid stays bounded; the LOD still works, only coarser. Non-finite extents index as one tile.
    const MAX_TILES: f64 = (1u64 << 20) as f64;
    let (wx, wy) = (f64::from(e1 - e0), f64::from(n1 - n0));
    let mut tile = if tile.is_finite() && tile > 0.0 { tile } else { 1.0 };
    if !(wx.is_finite() && wy.is_finite()) {
        tile = f64::MAX;
    } else if (wx / tile + 1.0) * (wy / tile + 1.0) > MAX_TILES {
        tile = ((wx * wy) / MAX_TILES).sqrt().max(wx.max(wy) / MAX_TILES).max(tile) * 1.01;
    }
    let ntx = if tile == f64::MAX { 1 } else { (wx / tile) as usize + 1 };
    let nty = if tile == f64::MAX { 1 } else { (wy / tile) as usize + 1 };
    // Tile per point (row-major from the south-west), then a counting sort by tile straight into
    // `perm` (TE-021: the tile id is recomputed instead of stored, and there is no separate
    // by-tile array — peak memory is the positions plus one u32 per point, so a 37 M-point 3DEP
    // tile fits the worker's memory cap).
    let tile_of = |k: usize| -> usize {
        let ti = ((f64::from(pos[3 * k] - e0) / tile).max(0.0) as usize).min(ntx - 1);
        let tj = ((f64::from(pos[3 * k + 1] - n0) / tile).max(0.0) as usize).min(nty - 1);
        tj * ntx + ti
    };
    let nt = ntx * nty;
    let mut start = vec![0usize; nt + 1];
    for k in 0..n {
        start[tile_of(k) + 1] += 1;
    }
    for t in 0..nt {
        start[t + 1] += start[t];
    }
    let mut perm = vec![0u32; n];
    {
        let mut fillp = start.clone();
        for k in 0..n {
            let t = tile_of(k);
            perm[fillp[t]] = k as u32;
            fillp[t] += 1;
        }
    }
    let ml = max_level.min(20);
    let nl = ml + 2;
    let mut tiles: Vec<Tile> = Vec::new();
    let mut idx: Vec<u32> = Vec::new();
    let mut seen: FxSet = FxSet::default();
    let mut keyed: Vec<u64> = Vec::new();
    let mut lv: Vec<u8> = Vec::new();
    for t in 0..nt {
        if start[t] == start[t + 1] {
            continue;
        }
        idx.clear();
        idx.extend_from_slice(&perm[start[t]..start[t + 1]]);
        // Pseudo-random visiting order inside the tile.
        keyed.clear();
        keyed.extend(idx.iter().map(|&k| (mix(u64::from(k) ^ 0x9e37_79b9) & 0xffff_ffff_0000_0000) | u64::from(k)));
        keyed.sort_unstable();
        seen.clear();
        seen.reserve(idx.len());
        lv.clear();
        let mut counts = vec![0u32; nl];
        for v in &keyed {
            let k = (*v & 0xffff_ffff) as usize;
            let (x, y, z) = (f64::from(pos[3 * k] - e0), f64::from(pos[3 * k + 1] - n0), f64::from(pos[3 * k + 2]));
            let mut l_found = ml + 1;
            for l in 0..=ml {
                let s = s0 / f64::from(1u32 << l);
                let (cx, cy, cz) = ((x / s).floor() as i64, (y / s).floor() as i64, (z / s).floor() as i64);
                let key = mix((l as u64) << 58 ^ (cx as u64).wrapping_mul(73_856_093) ^ (cy as u64).wrapping_mul(19_349_663) ^ (cz as u64).wrapping_mul(83_492_791));
                if seen.insert(key) {
                    l_found = l;
                    break;
                }
            }
            lv.push(l_found as u8);
            counts[l_found] += 1;
        }
        // Counting sort by level, keeping the visiting order inside a level.
        let mut at = vec![0usize; nl];
        for l in 1..nl {
            at[l] = at[l - 1] + counts[l - 1] as usize;
        }
        let base = start[t];
        for (r, v) in keyed.iter().enumerate() {
            let l = lv[r] as usize;
            perm[base + at[l]] = (*v & 0xffff_ffff) as u32;
            at[l] += 1;
        }
        let mut tl = Tile { start: base, count: idx.len(), min: [f32::MAX; 3], max: [f32::MIN; 3], levels: counts };
        for &k in &idx {
            let k = k as usize;
            for a in 0..3 {
                tl.min[a] = tl.min[a].min(pos[3 * k + a]);
                tl.max[a] = tl.max[a].max(pos[3 * k + a]);
            }
        }
        tiles.push(tl);
    }
    Index { perm, tiles }
}

#[cfg(test)]
mod te_tests {
    use super::*;

    // TE-015: an extent of thousands of kilometres with 500 m tiles must not abort.
    #[test]
    fn absurd_extent_stays_bounded() {
        let mut pos = Vec::new();
        for k in 0..20_000 {
            let t = k as f32 / 20_000.0;
            pos.extend_from_slice(&[-7_981_812.0 + t * 15_000_000.0, -5_506_315.0 + t * 11_000_000.0, 44.0]);
        }
        let ix = index(&pos, 500.0, 31.25, 12);
        assert_eq!(ix.perm.len(), 20_000);
        let nan = [f32::NAN, 0.0, 0.0, 1.0, 1.0, 1.0];
        assert_eq!(index(&nan, 500.0, 31.25, 12).perm.len(), 2);
    }
}
