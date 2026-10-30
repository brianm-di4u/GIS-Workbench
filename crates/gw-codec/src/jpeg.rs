//! Sequential-DCT JPEG decoder for NITF IC=C3/M3 blocks (MIL-STD-188-198A profile):
//! baseline (SOF0) and extended (SOF1) Huffman, 8- and 12-bit samples, any sampling factors,
//! restart intervals, interleaved and single-component scans. When the stream has no DQT
//! (or no DHT) the NITF default tables apply: the quantisation level comes from the NITF APP6
//! segment and the Huffman tables are the ITU T.81 Annex K luminance tables.
//!
//! Lossless Huffman streams (SOF3, NITF IC=C5/M5: predictors 1..7, point transform, restart
//! intervals) decode too. Progressive, arithmetic and hierarchical processes are refused with
//! UNSUPPORTED. Output is planar u16.

use gw_abi::{Error, Result};

/// Decoded raster: planar samples, `comps` planes of `width × height`.
pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub comps: u32,
    pub bits: u32,
    pub data: Vec<u16>,
}

const MAX_SAMPLES: usize = 1 << 28;

const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

// MIL-STD-188-198A default quantisation tables Q1..Q5, stored in zig-zag order (as a DQT
// marker carries them). Values as published in GDAL's JPEG driver (MIT).
const DEFAULT_Q: [[u8; 64]; 5] = [
    [8, 72, 72, 72, 72, 72, 72, 72, 72, 72, 78, 74, 76, 74, 78, 89, 81, 84, 84, 81, 89, 106, 93, 94, 99, 94, 93, 106, 129, 111, 108, 116, 116, 108, 111, 129, 135, 128, 136, 145, 136, 128, 135, 155, 160, 177, 177, 160, 155, 193, 213, 228, 213, 193, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
    [8, 36, 36, 36, 36, 36, 36, 36, 36, 36, 39, 37, 38, 37, 39, 45, 41, 42, 42, 41, 45, 53, 47, 47, 50, 47, 47, 53, 65, 56, 54, 59, 59, 54, 56, 65, 68, 64, 69, 73, 69, 64, 68, 78, 81, 89, 89, 81, 78, 98, 108, 115, 108, 98, 130, 144, 144, 130, 178, 190, 178, 243, 243, 255],
    [8, 10, 10, 10, 10, 10, 10, 10, 10, 10, 11, 10, 11, 10, 11, 13, 11, 12, 12, 11, 13, 15, 13, 13, 14, 13, 13, 15, 18, 16, 15, 16, 16, 15, 16, 18, 19, 18, 19, 21, 19, 18, 19, 22, 23, 25, 25, 23, 22, 27, 30, 32, 30, 27, 36, 40, 40, 36, 50, 53, 50, 68, 68, 91],
    [8, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 7, 8, 7, 8, 9, 8, 8, 8, 8, 9, 11, 9, 9, 10, 9, 9, 11, 13, 11, 11, 12, 12, 11, 11, 13, 14, 13, 14, 15, 14, 13, 14, 16, 16, 18, 18, 16, 16, 20, 22, 23, 22, 20, 26, 29, 29, 26, 36, 38, 36, 49, 49, 65],
    [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 5, 5, 6, 5, 5, 6, 7, 6, 6, 6, 6, 6, 6, 7, 8, 7, 8, 8, 8, 7, 8, 9, 9, 10, 10, 9, 9, 11, 12, 13, 12, 11, 14, 16, 16, 14, 20, 21, 20, 27, 27, 36],
];

const DC_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS: [u8; 16] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125];
const AC_VALS: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA,
];

#[derive(Clone)]
struct Huff {
    // Fast path: 9-bit prefix → (length, symbol); length 0 = slow path.
    fast: Vec<(u8, u8)>,
    maxcode: [i32; 18],
    valptr: [i32; 17],
    mincode: [i32; 17],
    vals: Vec<u8>,
}

impl Huff {
    fn new(bits: &[u8; 16], vals: &[u8]) -> Result<Self> {
        let total: usize = bits.iter().map(|&b| b as usize).sum();
        if total > 256 || total > vals.len() {
            return Err(Error::invalid("JPEG: bad Huffman table"));
        }
        let mut h = Huff { fast: vec![(0, 0); 512], maxcode: [-1; 18], valptr: [0; 17], mincode: [0; 17], vals: vals[..total].to_vec() };
        let mut code: i32 = 0;
        let mut k: i32 = 0;
        for l in 1..=16usize {
            let n = bits[l - 1] as i32;
            h.valptr[l] = k;
            h.mincode[l] = code;
            if n > 0 {
                if l <= 9 {
                    for i in 0..n {
                        let c = (code + i) as usize;
                        let shift = 9 - l;
                        for f in 0..(1usize << shift) {
                            let idx = (c << shift) | f;
                            if idx < 512 {
                                h.fast[idx] = (l as u8, h.vals[(k + i) as usize]);
                            }
                        }
                    }
                }
                code += n;
                k += n;
                h.maxcode[l] = code - 1;
            } else {
                h.maxcode[l] = -1;
            }
            if code > (1 << l) {
                return Err(Error::invalid("JPEG: over-subscribed Huffman table"));
            }
            code <<= 1;
        }
        h.maxcode[17] = i32::MAX;
        Ok(h)
    }
}

struct Bits<'a> {
    d: &'a [u8],
    pos: usize,
    acc: u32,
    n: u32,
    marker: Option<u8>,
    /// Zero bits fed after the entropy-coded data ended (a truncated or hostile stream).
    pad: u32,
}

impl<'a> Bits<'a> {
    fn fill(&mut self) {
        while self.n <= 24 {
            let mut b = 0u8;
            if self.marker.is_some() || self.pos >= self.d.len() {
                self.pad = self.pad.saturating_add(8);
            }
            if self.marker.is_none() && self.pos < self.d.len() {
                b = self.d[self.pos];
                if b == 0xFF {
                    let nb = self.d.get(self.pos + 1).copied().unwrap_or(0xD9);
                    if nb == 0x00 {
                        self.pos += 2;
                    } else if nb == 0xFF {
                        self.pos += 1; // fill byte
                        continue;
                    } else {
                        self.marker = Some(nb);
                        b = 0;
                    }
                } else {
                    self.pos += 1;
                }
            }
            self.acc |= (b as u32) << (24 - self.n);
            self.n += 8;
        }
    }
    fn get(&mut self, k: u32) -> u32 {
        if k == 0 {
            return 0;
        }
        if self.n < k {
            self.fill();
        }
        let v = self.acc >> (32 - k);
        self.acc <<= k;
        self.n -= k;
        v
    }
    fn decode(&mut self, h: &Huff) -> Result<u8> {
        if self.n < 16 {
            self.fill();
        }
        let (l, s) = h.fast[(self.acc >> 23) as usize];
        if l > 0 {
            self.acc <<= l;
            self.n -= l as u32;
            return Ok(s);
        }
        let mut code = self.get(1) as i32;
        for l in 1..=16usize {
            if code <= h.maxcode[l] {
                let i = h.valptr[l] + code - h.mincode[l];
                return h.vals.get(i as usize).copied().ok_or_else(|| Error::invalid("JPEG: bad Huffman code"));
            }
            code = (code << 1) | self.get(1) as i32;
        }
        Err(Error::invalid("JPEG: bad Huffman code"))
    }
    fn extend(v: u32, s: u32) -> i32 {
        if s == 0 {
            0
        } else if v < (1 << (s - 1)) {
            v as i32 - (1 << s) + 1
        } else {
            v as i32
        }
    }
    /// Skip to just after the next RSTn marker and clear the bit buffer.
    fn restart(&mut self) {
        self.acc = 0;
        self.n = 0;
        if let Some(m) = self.marker {
            if (0xD0..=0xD7).contains(&m) {
                self.pos += 2;
                self.marker = None;
                self.pad = 0;
            }
            return;
        }
        while self.pos + 1 < self.d.len() {
            if self.d[self.pos] == 0xFF && (0xD0..=0xD7).contains(&self.d[self.pos + 1]) {
                self.pos += 2;
                self.pad = 0;
                return;
            }
            self.pos += 1;
        }
        // No further restart marker: the data is exhausted for good.
        self.pad = u32::MAX;
    }
}

struct Comp {
    id: u8,
    h: usize,
    v: usize,
    tq: usize,
    stride: usize,
    rows: usize,
    plane: Vec<i32>,
}

struct Idct {
    c: [[f32; 8]; 8],
}

impl Idct {
    fn new() -> Self {
        let mut c = [[0f32; 8]; 8];
        for (x, row) in c.iter_mut().enumerate() {
            for (u, v) in row.iter_mut().enumerate() {
                let cu = if u == 0 { core::f32::consts::FRAC_1_SQRT_2 } else { 1.0 };
                *v = 0.5 * cu * (((2 * x + 1) as f32 * u as f32 * core::f32::consts::PI) / 16.0).cos();
            }
        }
        Idct { c }
    }
    /// coef (natural order, dequantised) → samples into plane at (bx, by), level shift + clamp.
    fn block(&self, coef: &[i32; 64], out: &mut [i32], stride: usize, x0: usize, y0: usize, shift: i32, max: i32) {
        let mut tmp = [0f32; 64];
        // rows: tmp[v][x] = Σu c[x][u] F[v][u]
        for v in 0..8 {
            let r = &coef[v * 8..v * 8 + 8];
            if r[1..].iter().all(|&a| a == 0) {
                let d = r[0] as f32 * self.c[0][0];
                for x in 0..8 {
                    tmp[v * 8 + x] = d;
                }
                continue;
            }
            for x in 0..8 {
                let cx = &self.c[x];
                let mut s = 0f32;
                for u in 0..8 {
                    s += cx[u] * r[u] as f32;
                }
                tmp[v * 8 + x] = s;
            }
        }
        for x in 0..8 {
            for y in 0..8 {
                let cy = &self.c[y];
                let mut s = 0f32;
                for v in 0..8 {
                    s += cy[v] * tmp[v * 8 + x];
                }
                let p = (s.round() as i32 + shift).clamp(0, max);
                out[(y0 + y) * stride + x0 + x] = p;
            }
        }
    }
}

fn be16(d: &[u8], i: usize) -> Result<usize> {
    if i + 2 > d.len() {
        return Err(Error::range("JPEG: truncated marker"));
    }
    Ok(((d[i] as usize) << 8) | d[i + 1] as usize)
}

/// Decode one JPEG stream. `qlevel_hint` (1..5) overrides the APP6 Q level when > 0.
/// `color`: 0 = automatic YCbCr→RGB for 3-component 8-bit streams (libjpeg rule), 1 = raw.
pub fn decode(d: &[u8], qlevel_hint: u32, color: u32) -> Result<Raster> {
    let mut i = 0;
    while i + 2 < d.len() && !(d[i] == 0xFF && d[i + 1] == 0xD8) {
        i += 1; // NSIF files may carry bytes before SOI
    }
    if i + 2 >= d.len() {
        return Err(Error::invalid("JPEG: no SOI marker"));
    }
    let soi = i;
    i += 2;
    let mut qt: [Option<[u16; 64]>; 4] = [None; 4];
    let mut dc: [Option<Huff>; 4] = [None, None, None, None];
    let mut ac: [Option<Huff>; 4] = [None, None, None, None];
    let mut qlevel = qlevel_hint;
    let mut adobe: Option<u8> = None;
    let mut restart = 0usize;
    let mut frame: Option<(u32, usize, usize, Vec<Comp>)> = None; // precision, X, Y, comps
    let mut lossless = false; // SOF3: Huffman lossless (NITF IC=C5/M5)
    let idct = Idct::new();
    loop {
        if i + 1 >= d.len() {
            break;
        }
        if d[i] != 0xFF {
            i += 1;
            continue;
        }
        let m = d[i + 1];
        i += 2;
        match m {
            0xFF | 0x00 | 0x01 | 0xD0..=0xD7 => {
                if m == 0xFF {
                    i -= 1;
                }
                continue;
            }
            0xD9 => break,
            _ => {}
        }
        let len = be16(d, i)?;
        if len < 2 || i + len > d.len() {
            return Err(Error::range("JPEG: marker segment runs past the data"));
        }
        let seg = &d[i + 2..i + len];
        match m {
            0xE6 if seg.len() >= 17 && &seg[..5] == b"NITF\0" && qlevel == 0 => {
                // APP6 NITF: byte 22 from SOI is the default-table Q level.
                let q = d.get(soi + 22).copied().unwrap_or(0) as u32;
                qlevel = if (1..=5).contains(&q) { q } else { 0 };
            }
            0xEE if seg.len() >= 12 && &seg[..5] == b"Adobe" => adobe = Some(seg[11]),
            0xDB => {
                let mut p = 0;
                while p < seg.len() {
                    let pq = seg[p] >> 4;
                    let tq = (seg[p] & 15) as usize;
                    p += 1;
                    if tq > 3 || pq > 1 {
                        return Err(Error::invalid("JPEG: bad DQT"));
                    }
                    let mut t = [0u16; 64];
                    for v in t.iter_mut() {
                        if pq == 0 {
                            *v = *seg.get(p).ok_or_else(|| Error::range("JPEG: short DQT"))? as u16;
                            p += 1;
                        } else {
                            *v = be16(seg, p)? as u16;
                            p += 2;
                        }
                    }
                    qt[tq] = Some(t);
                }
            }
            0xC4 => {
                let mut p = 0;
                while p + 17 <= seg.len() {
                    let tc = seg[p] >> 4;
                    let th = (seg[p] & 15) as usize;
                    let mut bits = [0u8; 16];
                    bits.copy_from_slice(&seg[p + 1..p + 17]);
                    let n: usize = bits.iter().map(|&b| b as usize).sum();
                    if th > 3 || tc > 1 || p + 17 + n > seg.len() {
                        return Err(Error::invalid("JPEG: bad DHT"));
                    }
                    let h = Huff::new(&bits, &seg[p + 17..p + 17 + n])?;
                    if tc == 0 {
                        dc[th] = Some(h);
                    } else {
                        ac[th] = Some(h);
                    }
                    p += 17 + n;
                }
            }
            0xDD => restart = be16(seg, 0)?,
            0xC0 | 0xC1 => {
                if seg.len() < 6 {
                    return Err(Error::range("JPEG: short SOF"));
                }
                let prec = seg[0] as u32;
                if prec != 8 && prec != 12 {
                    return Err(Error::unsupported(format!("JPEG: {prec}-bit DCT precision")));
                }
                let y = be16(seg, 1)?;
                let x = be16(seg, 3)?;
                let nf = seg[5] as usize;
                if x == 0 || y == 0 || nf == 0 || nf > 4 || seg.len() < 6 + nf * 3 {
                    return Err(Error::invalid("JPEG: bad frame header (DNL streams are not supported)"));
                }
                if x * y * nf > MAX_SAMPLES {
                    return Err(Error::limit("JPEG: image too large"));
                }
                let mut comps = Vec::new();
                for k in 0..nf {
                    let c = &seg[6 + k * 3..9 + k * 3];
                    let (h, v) = ((c[1] >> 4) as usize, (c[1] & 15) as usize);
                    if !(1..=4).contains(&h) || !(1..=4).contains(&v) || c[2] > 3 {
                        return Err(Error::invalid("JPEG: bad component sampling"));
                    }
                    comps.push(Comp { id: c[0], h, v, tq: c[2] as usize, stride: 0, rows: 0, plane: Vec::new() });
                }
                let hmax = comps.iter().map(|c| c.h).max().unwrap();
                let vmax = comps.iter().map(|c| c.v).max().unwrap();
                let mcux = x.div_ceil(8 * hmax);
                let mcuy = y.div_ceil(8 * vmax);
                for c in comps.iter_mut() {
                    c.stride = mcux * c.h * 8;
                    c.rows = mcuy * c.v * 8;
                    c.plane = vec![0; c.stride * c.rows];
                }
                frame = Some((prec, x, y, comps));
            }
            0xC2 | 0xC6 | 0xCA | 0xCE => return Err(Error::unsupported("JPEG: progressive streams are not part of the NITF profile")),
            0xC3 => {
                // Lossless (T.81 Annex H): 2..16-bit samples, one sample per "block".
                if seg.len() < 6 {
                    return Err(Error::range("JPEG: short SOF"));
                }
                let prec = seg[0] as u32;
                if !(2..=16).contains(&prec) {
                    return Err(Error::invalid(format!("JPEG: {prec}-bit lossless precision")));
                }
                let y = be16(seg, 1)?;
                let x = be16(seg, 3)?;
                let nf = seg[5] as usize;
                if x == 0 || y == 0 || nf == 0 || nf > 4 || seg.len() < 6 + nf * 3 {
                    return Err(Error::invalid("JPEG: bad frame header (DNL streams are not supported)"));
                }
                if x * y * nf > MAX_SAMPLES {
                    return Err(Error::limit("JPEG: image too large"));
                }
                let mut comps = Vec::new();
                for k in 0..nf {
                    let c = &seg[6 + k * 3..9 + k * 3];
                    let (h, v) = ((c[1] >> 4) as usize, (c[1] & 15) as usize);
                    if !(1..=4).contains(&h) || !(1..=4).contains(&v) {
                        return Err(Error::invalid("JPEG: bad component sampling"));
                    }
                    comps.push(Comp { id: c[0], h, v, tq: 0, stride: 0, rows: 0, plane: Vec::new() });
                }
                let hmax = comps.iter().map(|c| c.h).max().unwrap();
                let vmax = comps.iter().map(|c| c.v).max().unwrap();
                for c in comps.iter_mut() {
                    c.stride = x.div_ceil(hmax) * c.h;
                    c.rows = y.div_ceil(vmax) * c.v;
                    c.plane = vec![0; c.stride * c.rows];
                }
                frame = Some((prec, x, y, comps));
                lossless = true;
            }
            0xC7 | 0xCB | 0xCF => return Err(Error::unsupported("JPEG: differential (hierarchical) lossless coding")),
            0xC5 | 0xC9 | 0xCD => return Err(Error::unsupported("JPEG: arithmetic or hierarchical coding")),
            0xDA => {
                let (prec, x, y, comps) = frame.as_mut().ok_or_else(|| Error::invalid("JPEG: SOS before SOF"))?;
                let ns = *seg.first().ok_or_else(|| Error::range("JPEG: short SOS"))? as usize;
                if ns == 0 || ns > 4 || seg.len() < 1 + ns * 2 + 3 {
                    return Err(Error::invalid("JPEG: bad SOS"));
                }
                let mut sc = Vec::new();
                for k in 0..ns {
                    let cs = seg[1 + k * 2];
                    let t = seg[2 + k * 2];
                    let ci = comps.iter().position(|c| c.id == cs).ok_or_else(|| Error::invalid("JPEG: SOS names an unknown component"))?;
                    sc.push((ci, (t >> 4) as usize & 3, (t & 15) as usize & 3));
                }
                let (ss, se) = (seg[1 + ns * 2], seg[2 + ns * 2]);
                if lossless {
                    // Ss is the predictor (1..7), Al the point transform.
                    let pt = (seg[3 + ns * 2] & 15) as u32;
                    if !(1..=7).contains(&ss) || pt >= *prec {
                        return Err(Error::invalid("JPEG: bad lossless predictor or point transform"));
                    }
                    for &(_, td, _) in &sc {
                        if dc[td].is_none() {
                            return Err(Error::invalid("JPEG: lossless scan without its Huffman table"));
                        }
                    }
                    let tables: Vec<&Huff> = sc.iter().map(|&(_, td, _)| dc[td].as_ref().unwrap()).collect();
                    i = lossless_scan(d, i + len, *prec, pt, ss, restart, *x, *y, comps, &sc, &tables)?;
                    continue;
                }
                if ss != 0 || se != 63 {
                    return Err(Error::unsupported("JPEG: spectral selection (progressive)"));
                }
                // Default tables (NITF): fill whatever the stream left out.
                for &(ci, td, ta) in &sc {
                    let tq = comps[ci].tq;
                    if qt[tq].is_none() {
                        if !(1..=5).contains(&qlevel) {
                            return Err(Error::invalid("JPEG: no quantisation table and no NITF default Q level"));
                        }
                        let mut t = [0u16; 64];
                        for (a, b) in t.iter_mut().zip(DEFAULT_Q[qlevel as usize - 1].iter()) {
                            *a = *b as u16;
                        }
                        qt[tq] = Some(t);
                    }
                    if dc[td].is_none() {
                        dc[td] = Some(Huff::new(&DC_BITS, &DC_VALS)?);
                    }
                    if ac[ta].is_none() {
                        ac[ta] = Some(Huff::new(&AC_BITS, &AC_VALS)?);
                    }
                }
                let hmax = comps.iter().map(|c| c.h).max().unwrap();
                let vmax = comps.iter().map(|c| c.v).max().unwrap();
                let shift = 1i32 << (*prec - 1);
                let max = (1i32 << *prec) - 1;
                let mut bits = Bits { d, pos: i + len, acc: 0, n: 0, marker: None, pad: 0 };
                let mut pred = [0i32; 4];
                let mut coef = [0i32; 64];
                let mut mcu_count = 0usize;
                let (mcux, mcuy, single) = if ns == 1 {
                    let c = &comps[sc[0].0];
                    ((*x * c.h).div_ceil(hmax).div_ceil(8), (*y * c.v).div_ceil(vmax).div_ceil(8), true)
                } else {
                    (x.div_ceil(8 * hmax), y.div_ceil(8 * vmax), false)
                };
                let qts: Vec<[i32; 64]> = sc.iter().map(|&(ci, _, _)| {
                    let q = qt[comps[ci].tq].unwrap();
                    let mut o = [0i32; 64];
                    for k in 0..64 {
                        o[k] = q[k] as i32;
                    }
                    o
                }).collect();
                'scan: for my in 0..mcuy {
                    for mx in 0..mcux {
                        // Data exhausted (no restart marker coming): the rest of the scan
                        // would decode from zero padding; stop and keep what was decoded.
                        if bits.pad > 4096 && (bits.pad == u32::MAX || !bits.marker.is_some_and(|m| (0xD0..=0xD7).contains(&m))) {
                            break 'scan;
                        }
                        if restart > 0 && mcu_count > 0 && mcu_count % restart == 0 {
                            bits.restart();
                            pred = [0; 4];
                        }
                        mcu_count += 1;
                        for (si, &(ci, td, ta)) in sc.iter().enumerate() {
                            let (bh, bv) = if single { (1, 1) } else { (comps[ci].h, comps[ci].v) };
                            let dch = dc[td].as_ref().unwrap();
                            let ach = ac[ta].as_ref().unwrap();
                            let q = &qts[si];
                            for v in 0..bv {
                                for h in 0..bh {
                                    coef.fill(0);
                                    let t = bits.decode(dch)? as u32;
                                    if t > 16 {
                                        return Err(Error::invalid("JPEG: bad DC magnitude"));
                                    }
                                    let diff = Bits::extend(bits.get(t), t);
                                    pred[si] += diff;
                                    coef[0] = pred[si] * q[0];
                                    let mut k = 1;
                                    while k < 64 {
                                        let rs = bits.decode(ach)? as u32;
                                        let r = rs >> 4;
                                        let s = rs & 15;
                                        if s == 0 {
                                            if r == 15 {
                                                k += 16;
                                                continue;
                                            }
                                            break;
                                        }
                                        k += r as usize;
                                        if k > 63 {
                                            break;
                                        }
                                        coef[ZIGZAG[k]] = Bits::extend(bits.get(s), s) * q[k];
                                        k += 1;
                                    }
                                    let c = &mut comps[ci];
                                    let (bx, by) = if single { (mx, my) } else { (mx * c.h + h, my * c.v + v) };
                                    if (bx + 1) * 8 <= c.stride && (by + 1) * 8 <= c.rows {
                                        let stride = c.stride;
                                        idct.block(&coef, &mut c.plane, stride, bx * 8, by * 8, shift, max);
                                    }
                                }
                            }
                        }
                    }
                }
                // Continue at the marker that ended the entropy-coded data.
                i = bits.pos;
                continue;
            }
            _ => {}
        }
        i += len;
    }
    let (prec, x, y, comps) = frame.ok_or_else(|| Error::invalid("JPEG: no frame header"))?;
    let hmax = comps.iter().map(|c| c.h).max().unwrap();
    let vmax = comps.iter().map(|c| c.v).max().unwrap();
    let n = x * y;
    let mut out = vec![0u16; n * comps.len()];
    for (k, c) in comps.iter().enumerate() {
        let o = &mut out[k * n..(k + 1) * n];
        for yy in 0..y {
            let sy = yy * c.v / vmax;
            let row = &c.plane[sy * c.stride..];
            for xx in 0..x {
                o[yy * x + xx] = row[xx * c.h / hmax] as u16;
            }
        }
    }
    let ycc = comps.len() == 3
        && prec == 8
        && color == 0
        && match adobe {
            Some(t) => t != 0,
            None => !(comps[0].id == b'R' && comps[1].id == b'G' && comps[2].id == b'B'),
        };
    if ycc {
        let (yp, rest) = out.split_at_mut(n);
        let (cb, cr) = rest.split_at_mut(n);
        for j in 0..n {
            let yv = yp[j] as f32;
            let b = cb[j] as f32 - 128.0;
            let r = cr[j] as f32 - 128.0;
            yp[j] = (yv + 1.402 * r).round().clamp(0.0, 255.0) as u16;
            cb[j] = (yv - 0.344136 * b - 0.714136 * r).round().clamp(0.0, 255.0) as u16;
            cr[j] = (yv + 1.772 * b).round().clamp(0.0, 255.0) as u16;
        }
    }
    Ok(Raster { width: x as u32, height: y as u32, comps: comps.len() as u32, bits: prec, data: out })
}

/// One lossless scan (T.81 Annex H): Huffman-coded DPCM differences per sample, predicted by
/// selector `sel` (1..7) from the left (Ra), upper (Rb) and upper-left (Rc) neighbours. The first
/// sample of the scan and of each restart interval is predicted by 2^(P−Pt−1), the first line of
/// each interval from the left, the first column from above. Samples are left-shifted by the point
/// transform `pt` into the component planes. Returns the offset after the entropy-coded data.
#[allow(clippy::too_many_arguments)]
fn lossless_scan(d: &[u8], start: usize, prec: u32, pt: u32, sel: u8, restart: usize, x: usize, y: usize, comps: &mut [Comp], sc: &[(usize, usize, usize)], tables: &[&Huff]) -> Result<usize> {
    let hmax = comps.iter().map(|c| c.h).max().unwrap();
    let vmax = comps.iter().map(|c| c.v).max().unwrap();
    let single = sc.len() == 1;
    // MCU grid: one sample of a single-component scan, else h × v samples of each component.
    let (mcux, mcuy) = if single {
        let c = &comps[sc[0].0];
        ((x * c.h).div_ceil(hmax), (y * c.v).div_ceil(vmax))
    } else {
        (x.div_ceil(hmax), y.div_ceil(vmax))
    };
    let mask = (1i32 << (prec - pt)) - 1;
    let init = 1i32 << (prec - pt - 1);
    let mut bits = Bits { d, pos: start, acc: 0, n: 0, marker: None, pad: 0 };
    let mut work: Vec<Vec<i32>> = sc.iter().map(|&(ci, _, _)| vec![0; comps[ci].stride * comps[ci].rows]).collect();
    let mut reset = vec![true; sc.len()];
    let mut first_row = vec![0usize; sc.len()];
    let mut mcu = 0usize;
    'scan: for my in 0..mcuy {
        for mx in 0..mcux {
            if bits.pad > 4096 && (bits.pad == u32::MAX || !bits.marker.is_some_and(|m| (0xD0..=0xD7).contains(&m))) {
                break 'scan;
            }
            if restart > 0 && mcu > 0 && mcu % restart == 0 {
                bits.restart();
                for (si, &(ci, _, _)) in sc.iter().enumerate() {
                    reset[si] = true;
                    first_row[si] = if single { my } else { my * comps[ci].v };
                }
            }
            mcu += 1;
            for (si, &(ci, _, _)) in sc.iter().enumerate() {
                let (bh, bv) = if single { (1, 1) } else { (comps[ci].h, comps[ci].v) };
                let stride = comps[ci].stride;
                let w = &mut work[si];
                for v in 0..bv {
                    for h in 0..bh {
                        let (sx, sy) = if single { (mx, my) } else { (mx * bh + h, my * bv + v) };
                        let t = bits.decode(tables[si])? as u32;
                        if t > 16 {
                            return Err(Error::invalid("JPEG: bad lossless difference category"));
                        }
                        let diff = if t == 16 { 32768 } else { Bits::extend(bits.get(t), t) };
                        let p = if reset[si] {
                            reset[si] = false;
                            init
                        } else if sy == first_row[si] {
                            if sx > 0 { w[sy * stride + sx - 1] } else if sy > 0 { w[(sy - 1) * stride] } else { init }
                        } else if sx == 0 {
                            w[(sy - 1) * stride]
                        } else {
                            let ra = w[sy * stride + sx - 1];
                            let rb = w[(sy - 1) * stride + sx];
                            let rc = w[(sy - 1) * stride + sx - 1];
                            match sel {
                                1 => ra,
                                2 => rb,
                                3 => rc,
                                4 => ra + rb - rc,
                                5 => ra + ((rb - rc) >> 1),
                                6 => rb + ((ra - rc) >> 1),
                                _ => (ra + rb) >> 1,
                            }
                        };
                        w[sy * stride + sx] = (p + diff) & 0xFFFF;
                    }
                }
            }
        }
    }
    for (si, &(ci, _, _)) in sc.iter().enumerate() {
        for (o, v) in comps[ci].plane.iter_mut().zip(work[si].iter()) {
            *o = (*v & mask) << pt;
        }
    }
    Ok(bits.pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn huffman_tables_build() {
        assert!(Huff::new(&DC_BITS, &DC_VALS).is_ok());
        assert!(Huff::new(&AC_BITS, &AC_VALS).is_ok());
    }

    #[test]
    fn garbage_is_refused_without_panic() {
        for n in [0usize, 1, 2, 10, 100] {
            let mut v = vec![0xFFu8, 0xD8];
            v.extend((0..n).map(|i| (i * 37 % 251) as u8));
            let _ = decode(&v, 0, 0);
        }
        assert!(decode(b"not a jpeg", 0, 0).is_err());
    }
}
