//! A geoid grid too large to hold whole (EGM2008 1′: 10,801 × 21,600 samples, 467 MB), read a
//! tile at a time (REG-024, S-64). The pack cuts the grid into square tiles of `cells` × `cells`
//! grid cells, each stored with one sample before and two after in both axes ((cells + 3)²
//! samples), so the 4 × 4 Catmull-Rom stencil never leaves its tile. Rows are clamped at the poles
//! and columns wrap across 360° when the pack is built, as `Geoid::at` does, so values are
//! bit-identical to `Geoid::undulation` on the whole grid. A tile is the GeographicLib PGM's
//! 16-bit samples, A + B − C predicted and split into low and high byte planes as the embedded
//! EGM96 grid is, then raw-DEFLATE compressed. Decoded tiles are kept in a small LRU.

use crate::geoid::catmull_rom;
use gw_abi::{Error, Result};

pub struct TiledGeoid {
    rows: usize,
    cols: usize,
    cells: usize,
    side: usize,
    bands: usize,
    tcols: usize,
    offset: f64,
    scale: f64,
    cap: usize,
    clock: u64,
    slots: Vec<Slot>,
}

struct Slot {
    idx: u32,
    used: u64,
    data: Vec<u16>,
}

impl TiledGeoid {
    /// `rows` × `cols` is the whole grid (10,801 × 21,600 for 1′, rows from 90° N to 90° S,
    /// columns from 0° E), `cells` the tile edge in grid cells (300 = 5° at 1′), value =
    /// `offset` + `scale` · sample, `cap` the number of decoded tiles kept.
    pub fn new(rows: usize, cols: usize, cells: usize, offset: f64, scale: f64, cap: usize) -> Result<Self> {
        if cells == 0 || rows < 2 || (rows - 1) % cells != 0 || cols % cells != 0 || !offset.is_finite() || !scale.is_finite() {
            return Err(Error::invalid("tiled geoid: the tiles do not divide the grid"));
        }
        Ok(TiledGeoid { rows, cols, cells, side: cells + 3, bands: (rows - 1) / cells, tcols: cols / cells, offset, scale, cap: cap.max(1), clock: 0, slots: Vec::new() })
    }

    pub fn tile_count(&self) -> usize {
        self.bands * self.tcols
    }

    /// Tile index and position in it: (tile, row of the cell, column of the cell, fractions).
    fn locate(&self, lat: f64, lon: f64) -> (u32, usize, usize, f64, f64) {
        let dlat = 180.0 / (self.rows - 1) as f64;
        let dlon = 360.0 / self.cols as f64;
        // min / max rather than f64::clamp, whose panic message pulls float formatting into geod.
        let fy = ((90.0 - lat.max(-90.0).min(90.0)) / dlat).max(0.0).min((self.rows - 1) as f64);
        let fx = lon.rem_euclid(360.0) / dlon;
        let iy = fy.floor() as usize;
        let mut ix = fx.floor() as usize;
        let (ty, tx) = (fy - iy as f64, fx - ix as f64);
        if ix >= self.cols {
            ix -= self.cols;
        }
        let band = (iy / self.cells).min(self.bands - 1);
        let tc = ix / self.cells;
        ((band * self.tcols + tc) as u32, iy - band * self.cells, ix - tc * self.cells, ty, tx)
    }

    /// The tile a point needs (NaN coordinates give tile 0; their value is NaN anyway).
    pub fn tile_of(&self, lat: f64, lon: f64) -> u32 {
        if lat.is_finite() && lon.is_finite() {
            self.locate(lat, lon).0
        } else {
            0
        }
    }

    /// Decode a tile as the pack stores it and keep it, dropping the least recently used.
    pub fn put(&mut self, idx: u32, bytes: &[u8]) -> Result<()> {
        if idx as usize >= self.tile_count() {
            return Err(Error::invalid("tiled geoid: no such tile"));
        }
        let (s, n) = (self.side, self.side * self.side);
        let raw = miniz_oxide::inflate::decompress_to_vec_with_limit(bytes, 2 * n).map_err(|_| Error::invalid("tiled geoid: corrupt tile"))?;
        if raw.len() != 2 * n {
            return Err(Error::invalid("tiled geoid: tile size mismatch"));
        }
        let mut t = vec![0u16; n];
        for r in 0..s {
            for c in 0..s {
                let i = r * s + c;
                let a = if c > 0 { t[i - 1] } else { 0 };
                let b = if r > 0 { t[i - s] } else { 0 };
                let cc = if r > 0 && c > 0 { t[i - s - 1] } else { 0 };
                t[i] = (raw[i] as u16 | (raw[n + i] as u16) << 8).wrapping_add(a).wrapping_add(b).wrapping_sub(cc);
            }
        }
        self.clock += 1;
        self.slots.retain(|x| x.idx != idx);
        if self.slots.len() >= self.cap {
            if let Some(k) = self.slots.iter().enumerate().min_by_key(|(_, s)| s.used).map(|(k, _)| k) {
                self.slots.swap_remove(k);
            }
        }
        self.slots.push(Slot { idx, used: self.clock, data: t });
        Ok(())
    }

    /// Undulation N (m), Catmull-Rom as `Geoid::undulation`; None when the tile is not loaded.
    pub fn value(&mut self, lat: f64, lon: f64) -> Option<f64> {
        if !(lat.is_finite() && lon.is_finite()) {
            return Some(f64::NAN);
        }
        let (tile, cy, cx, ty, tx) = self.locate(lat, lon);
        self.clock += 1;
        let (clock, side, off, sc) = (self.clock, self.side, self.offset, self.scale);
        let slot = self.slots.iter_mut().find(|s| s.idx == tile)?;
        slot.used = clock;
        let d = &slot.data;
        // Tile row 0 is grid row (first cell row − 1); a point exactly at 90° S (cy = cells) reads
        // the clamped padding rows, as the whole grid's clamp does.
        let at = |j: usize, i: usize| off + sc * d[j.min(side - 1) * side + i.min(side - 1)] as f64;
        let (wy, wx) = (catmull_rom(ty), catmull_rom(tx));
        let mut v = 0.0;
        for (j, wj) in wy.iter().enumerate() {
            let mut row = 0.0;
            for (i, wi) in wx.iter().enumerate() {
                row += wi * at(cy + j, cx + i);
            }
            v += wj * row;
        }
        Some(v)
    }
}

/// Cut one tile from a whole grid of `rows` × `cols` samples and encode it as the pack stores
/// it before compression: predictor residuals, low byte plane then high byte plane. The pack
/// builder (build/packs.mjs) does the same; tests check the two against each other.
pub fn encode_tile(grid: &[u16], rows: usize, cols: usize, cells: usize, idx: usize) -> Vec<u8> {
    let (s, tcols) = (cells + 3, cols / cells);
    let (band, tc) = (idx / tcols, idx % tcols);
    let n = s * s;
    let mut t = vec![0u16; n];
    for j in 0..s {
        let r = (band * cells + j).saturating_sub(1).min(rows - 1);
        for i in 0..s {
            let c = (tc * cells + i + cols - 1) % cols;
            t[j * s + i] = grid[r * cols + c];
        }
    }
    let mut o = vec![0u8; 2 * n];
    for r in 0..s {
        for c in 0..s {
            let i = r * s + c;
            let a = if c > 0 { t[i - 1] } else { 0 };
            let b = if r > 0 { t[i - s] } else { 0 };
            let cc = if r > 0 && c > 0 { t[i - s - 1] } else { 0 };
            let res = t[i].wrapping_sub(a.wrapping_add(b).wrapping_sub(cc));
            o[i] = res as u8;
            o[n + i] = (res >> 8) as u8;
        }
    }
    o
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geoid::Geoid;

    /// A small whole grid (1° cells, 181 × 360) as a PGM.
    fn grid() -> (Vec<u16>, Geoid) {
        let (rows, cols) = (181usize, 360usize);
        let g: Vec<u16> = (0..rows * cols)
            .map(|k| {
                let (r, c) = ((k / cols) as f64, (k % cols) as f64);
                (30000.0 + 9000.0 * (2.0 * c.to_radians()).sin() * r.to_radians().sin() + 50.0 * ((k * 7919) % 13) as f64) as u16
            })
            .collect();
        let mut pgm = format!("P5\n# Offset -108\n# Scale 0.003\n{cols} {rows}\n65535\n").into_bytes();
        for v in &g {
            pgm.extend(v.to_be_bytes());
        }
        (g, Geoid::from_pgm("t", &pgm).unwrap())
    }

    #[test]
    fn tiles_match_the_whole_grid_everywhere() {
        let (g, whole) = grid();
        let mut t = TiledGeoid::new(181, 360, 30, -108.0, 0.003, 4).unwrap();
        assert_eq!(t.tile_count(), 72);
        let mut pts = vec![(90.0, 0.0), (-90.0, 0.0), (-90.0, 359.999), (89.9999, -180.0), (0.0, 360.0), (12.3, -1e-12), (-45.5, 179.999_999_9), (60.0, 30.0), (60.0, 29.999_999)];
        let mut s = 99u64;
        let mut rnd = || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (s >> 11) as f64 / (1u64 << 53) as f64
        };
        for _ in 0..400 {
            pts.push((180.0 * rnd() - 90.0, 720.0 * rnd() - 360.0));
        }
        for (lat, lon) in pts {
            let k = t.tile_of(lat, lon);
            if t.value(lat, lon).is_none() {
                let raw = encode_tile(&g, 181, 360, 30, k as usize);
                t.put(k, &miniz_oxide::deflate::compress_to_vec(&raw, 6)).unwrap();
            }
            assert_eq!(t.value(lat, lon).unwrap().to_bits(), whole.undulation(lat, lon).to_bits(), "{lat} {lon}");
        }
        assert!(t.slots.len() <= 4);
    }

    #[test]
    fn refuses_bad_tiles() {
        let mut t = TiledGeoid::new(181, 360, 30, -108.0, 0.003, 4).unwrap();
        assert!(t.put(72, &[]).is_err());
        assert!(t.put(0, &[1, 2, 3]).is_err());
        assert!(t.put(0, &miniz_oxide::deflate::compress_to_vec(&[0u8; 10], 6)).is_err());
        assert!(TiledGeoid::new(181, 360, 7, 0.0, 1.0, 4).is_err());
        assert!(t.value(f64::NAN, 0.0).unwrap().is_nan());
        assert!(t.value(1.0, 1.0).is_none());
    }
}
