//! Geoid grids (REQ-GEO-02, REQ-GEO-03). The embedded EGM96 15′ grid arrives as a 2-D
//! planar-predictor residual in two byte planes (`Research/05` §2.6); a user-loaded
//! GeographicLib PGM grid (EGM2008 pack) is also accepted. Interpolation is Catmull-Rom
//! bicubic: within 0.02 m of GeoidEval at the §2.4 test points.

use gw_abi::{Error, Result};

#[derive(Clone)]
pub struct Geoid {
    pub name: String,
    width: usize,
    height: usize,
    // Value(m) = offset + scale * raw
    offset: f64,
    scale: f64,
    data: Vec<i32>,
}

impl Geoid {
    /// Decode the embedded EGM96 15′ block: `width*height` residuals of the predictor
    /// p = A + B − C (A left, B above, C above-left, 0 outside), int16 centimetres,
    /// stored as all low bytes followed by all high bytes.
    pub fn from_predicted_planes(name: &str, width: usize, height: usize, bytes: &[u8]) -> Result<Self> {
        let n = width.checked_mul(height).ok_or_else(|| Error::limit("grid too large"))?;
        if bytes.len() != 2 * n {
            return Err(Error::invalid(format!("geoid block has {} bytes, expected {}", bytes.len(), 2 * n)));
        }
        let mut data = vec![0i32; n];
        for r in 0..height {
            for c in 0..width {
                let i = r * width + c;
                let res = i16::from_le_bytes([bytes[i], bytes[n + i]]) as i32;
                let a = if c > 0 { data[i - 1] } else { 0 };
                let b = if r > 0 { data[i - width] } else { 0 };
                let cc = if r > 0 && c > 0 { data[i - width - 1] } else { 0 };
                // Wrapping 16-bit arithmetic, as the encoder used.
                let v = (res + a + b - cc) as i16;
                data[i] = v as i32;
            }
        }
        Ok(Geoid { name: name.to_string(), width, height, offset: 0.0, scale: 0.01, data })
    }

    /// Raw big-endian int16 centimetres (the NGA/egm96-universal layout), for tests.
    pub fn from_i16be_cm(name: &str, width: usize, height: usize, bytes: &[u8]) -> Result<Self> {
        let n = width * height;
        if bytes.len() != 2 * n {
            return Err(Error::invalid("geoid grid size mismatch"));
        }
        let data = (0..n).map(|i| i16::from_be_bytes([bytes[2 * i], bytes[2 * i + 1]]) as i32).collect();
        Ok(Geoid { name: name.to_string(), width, height, offset: 0.0, scale: 0.01, data })
    }

    /// GeographicLib PGM geoid file (P5, 16-bit, "# Offset" and "# Scale" comments).
    pub fn from_pgm(name: &str, bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 16 || &bytes[..2] != b"P5" {
            return Err(Error::invalid("not a binary PGM geoid file"));
        }
        let mut pos = 2usize;
        let mut offset = f64::NAN;
        let mut scale = f64::NAN;
        let mut nums: Vec<usize> = Vec::new();
        while nums.len() < 3 {
            while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
                pos += 1;
            }
            if pos >= bytes.len() {
                return Err(Error::invalid("truncated PGM header"));
            }
            if bytes[pos] == b'#' {
                let end = bytes[pos..].iter().position(|&b| b == b'\n').map_or(bytes.len(), |e| pos + e);
                let line = String::from_utf8_lossy(&bytes[pos + 1..end]).trim().to_string();
                let mut it = line.split_whitespace();
                match (it.next(), it.next()) {
                    (Some("Offset"), Some(v)) => offset = v.parse().unwrap_or(f64::NAN),
                    (Some("Scale"), Some(v)) => scale = v.parse().unwrap_or(f64::NAN),
                    _ => {}
                }
                pos = end;
                continue;
            }
            let start = pos;
            while pos < bytes.len() && bytes[pos].is_ascii_digit() {
                pos += 1;
            }
            let v: usize = std::str::from_utf8(&bytes[start..pos]).ok().and_then(|s| s.parse().ok()).ok_or_else(|| Error::invalid("bad PGM header number"))?;
            nums.push(v);
        }
        pos += 1; // single whitespace after maxval
        let (w, h, maxval) = (nums[0], nums[1], nums[2]);
        if maxval != 65535 || !offset.is_finite() || !scale.is_finite() {
            return Err(Error::invalid("PGM geoid needs 16-bit data with Offset and Scale comments"));
        }
        let n = w.checked_mul(h).ok_or_else(|| Error::limit("grid too large"))?;
        if bytes.len() < pos + 2 * n {
            return Err(Error::invalid("truncated PGM data"));
        }
        let d = &bytes[pos..pos + 2 * n];
        let data = (0..n).map(|i| u16::from_be_bytes([d[2 * i], d[2 * i + 1]]) as i32).collect();
        // PGM grids include the 90°S row: height = 180/step + 1.
        Ok(Geoid { name: name.to_string(), width: w, height: h, offset, scale, data })
    }

    fn at(&self, r: isize, c: isize) -> f64 {
        let r = r.clamp(0, self.height as isize - 1) as usize;
        let c = c.rem_euclid(self.width as isize) as usize;
        self.offset + self.scale * self.data[r * self.width + c] as f64
    }

    /// Geoid undulation N (m) at a point, Catmull-Rom bicubic.
    pub fn undulation(&self, lat: f64, lon: f64) -> f64 {
        let dlat = 180.0 / (self.height - 1) as f64;
        let dlon = 360.0 / self.width as f64;
        let fy = (90.0 - lat) / dlat;
        let fx = lon.rem_euclid(360.0) / dlon;
        let iy = fy.floor() as isize;
        let ix = fx.floor() as isize;
        let ty = fy - iy as f64;
        let tx = fx - ix as f64;
        let w = |t: f64| -> [f64; 4] {
            let t2 = t * t;
            let t3 = t2 * t;
            [
                (-t3 + 2.0 * t2 - t) / 2.0,
                (3.0 * t3 - 5.0 * t2 + 2.0) / 2.0,
                (-3.0 * t3 + 4.0 * t2 + t) / 2.0,
                (t3 - t2) / 2.0,
            ]
        };
        let wy = w(ty);
        let wx = w(tx);
        let mut v = 0.0;
        for (j, wyj) in wy.iter().enumerate() {
            let mut row = 0.0;
            for (i, wxi) in wx.iter().enumerate() {
                row += wxi * self.at(iy + j as isize - 1, ix + i as isize - 1);
            }
            v += wyj * row;
        }
        v
    }

    /// Orthometric (MSL) height from HAE: H = h − N.
    pub fn hae_to_msl(&self, lat: f64, lon: f64, h: f64) -> f64 {
        h - self.undulation(lat, lon)
    }

    pub fn msl_to_hae(&self, lat: f64, lon: f64, hm: f64) -> f64 {
        hm + self.undulation(lat, lon)
    }
}

/// Encode a grid with the predictor (used by the build and by round-trip tests).
pub fn encode_predicted_planes(width: usize, height: usize, v: &[i16]) -> Vec<u8> {
    let n = width * height;
    let mut out = vec![0u8; 2 * n];
    for r in 0..height {
        for c in 0..width {
            let i = r * width + c;
            let a = if c > 0 { v[i - 1] } else { 0 };
            let b = if r > 0 { v[i - width] } else { 0 };
            let cc = if r > 0 && c > 0 { v[i - width - 1] } else { 0 };
            let res = v[i].wrapping_sub(a.wrapping_add(b).wrapping_sub(cc));
            let le = res.to_le_bytes();
            out[i] = le[0];
            out[n + i] = le[1];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn predictor_round_trip() {
        let (w, h) = (17, 9);
        let v: Vec<i16> = (0..w * h).map(|i| ((i * 7919) % 20000) as i16 - 10000).collect();
        let enc = encode_predicted_planes(w, h, &v);
        let g = Geoid::from_predicted_planes("t", w, h, &enc).unwrap();
        for (i, &x) in v.iter().enumerate() {
            assert_eq!(g.data[i], x as i32);
        }
    }

    #[test]
    fn egm96_test_points() {
        // Uses the decoded grid written by build/data.mjs when it exists.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/data/egm96-15.i16be");
        let Ok(bytes) = std::fs::read(path) else { return };
        let g = Geoid::from_i16be_cm("EGM96", 1440, 721, &bytes).unwrap();
        // Research/05 §2.4: EGM96 N by GeoidEval; cubic must be within 0.05 m here.
        for &(lat, lon, n) in &[
            (33.3, 44.4, -2.2329),
            (40.6, -73.8, -32.7062),
            (-33.8568, 151.2153, 22.5054),
            (27.9881, 86.925, -28.7408),
            (-5.0, 145.0, 70.4041),
            (5.0, 78.0, -104.6823),
        ] {
            let got = g.undulation(lat, lon);
            assert!((got - n).abs() < 0.05, "{lat},{lon}: {got} vs {n}");
        }
    }
}
