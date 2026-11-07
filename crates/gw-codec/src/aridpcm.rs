//! NITF ARIDPCM C2/M2 decoder and encoder (MIL-STD-188-197A; FC-18, REQ-FMT-44/45).
//!
//! A block is cut into 8×8 neighbourhoods, left to right and top to bottom. The block starts with
//! a 2-bit busyness code per neighbourhood; the neighbourhoods' coded values follow, bit-packed
//! MSB first with no padding (as GDAL's `nitfaridpcm.cpp` reads them). Inside a neighbourhood the
//! standard's coordinates run from the lower-right corner, `i` upward and `j` leftward; row and
//! column 8 are the bottom row of the neighbourhood above and the right column of the one to the
//! left (replicated on the image's top and left edges, §5.2.2.1). Level 1 is the corner (0,0) at
//! full depth; levels 2–4 are predicted by linear and bilinear interpolation from the levels above
//! and coded as quantised deltas, the number of bits per level coming from the bit-assignment
//! matrix (BAM) of the compression rate and the busyness class (tables III and IV). A level coded
//! at the full sample depth carries the actual value (§5.2.2.5.1).
//!
//! Quantisation tables: the standard publishes those of the 8-bit 0.75 bpp rate (appendix A) and
//! keeps every other rate's on magnetic media (appendix B, never released). For those rates the
//! tables in `aridpcm_tables.rs` are derived by the standard's own procedure (§6.3: equal-population
//! regions of the delta distributions of sample imagery, the expected delta of each region) by
//! `crates/gw-codec/tools/aridpcm_tables.py`; such decodes are flagged approximate. Where GDAL's
//! table for 0.75 differs from appendix A (its class A/B level-2 table drops the entry 10), the
//! standard is followed.

use gw_abi::{Error, Result};

#[path = "aridpcm_tables.rs"]
mod derived;

/// Coding order of a neighbourhood's samples (table V), as (i, j).
const ORDER: [(u8, u8); 64] = [
    (0, 0),
    (0, 4),
    (4, 0),
    (4, 4),
    (0, 2),
    (2, 0),
    (2, 2),
    (0, 6),
    (2, 4),
    (2, 6),
    (4, 2),
    (6, 0),
    (6, 2),
    (4, 6),
    (6, 4),
    (6, 6),
    (0, 1),
    (1, 0),
    (1, 1),
    (0, 3),
    (1, 2),
    (1, 3),
    (0, 5),
    (1, 4),
    (1, 5),
    (0, 7),
    (1, 6),
    (1, 7),
    (2, 1),
    (3, 0),
    (3, 1),
    (2, 3),
    (3, 2),
    (3, 3),
    (2, 5),
    (3, 4),
    (3, 5),
    (2, 7),
    (3, 6),
    (3, 7),
    (4, 1),
    (5, 0),
    (5, 1),
    (4, 3),
    (5, 2),
    (5, 3),
    (4, 5),
    (5, 4),
    (5, 5),
    (4, 7),
    (5, 6),
    (5, 7),
    (6, 1),
    (7, 0),
    (7, 1),
    (6, 3),
    (7, 2),
    (7, 3),
    (6, 5),
    (7, 4),
    (7, 5),
    (6, 7),
    (7, 6),
    (7, 7),
];
/// First index in ORDER of each level and the number of samples in it.
const LEVEL_SPAN: [(usize, usize); 4] = [(0, 1), (1, 3), (4, 12), (16, 48)];

/// One compression rate: BAM per busyness class [L1, L2, L3, L4] and the class thresholds
/// (the lowest busyness of classes B, C and D).
struct Rate {
    name: &'static str,
    bam: [[u8; 4]; 4],
    thresholds: [i32; 3],
}

const RATES_8: [Rate; 4] = [
    Rate {
        name: "0.75",
        bam: [[8, 5, 0, 0], [8, 5, 2, 0], [8, 6, 4, 0], [8, 7, 4, 2]],
        thresholds: [45, 80, 123],
    },
    Rate {
        name: "1.40",
        bam: [[8, 5, 3, 0], [8, 7, 3, 0], [8, 7, 5, 0], [8, 7, 6, 3]],
        thresholds: [40, 58, 99],
    },
    Rate {
        name: "2.30",
        bam: [[8, 7, 3, 0], [8, 7, 6, 0], [8, 7, 5, 3], [8, 8, 7, 4]],
        thresholds: [38, 55, 94],
    },
    Rate {
        name: "4.50",
        bam: [[8, 7, 3, 2], [8, 7, 5, 3], [8, 8, 7, 5], [8, 8, 8, 7]],
        thresholds: [38, 48, 77],
    },
];
const RATES_11: [Rate; 4] = [
    Rate {
        name: "1.40",
        bam: [[11, 7, 0, 0], [11, 8, 2, 0], [11, 8, 5, 0], [11, 8, 6, 4]],
        thresholds: [28, 72, 140],
    },
    Rate {
        name: "2.30",
        bam: [[11, 8, 3, 0], [11, 8, 4, 0], [11, 8, 6, 3], [11, 11, 8, 4]],
        thresholds: [26, 68, 140],
    },
    Rate {
        name: "4.50",
        bam: [
            [11, 6, 3, 2],
            [11, 6, 5, 3],
            [11, 11, 6, 5],
            [11, 11, 11, 6],
        ],
        thresholds: [24, 54, 116],
    },
    Rate {
        name: "6.40",
        bam: [
            [11, 11, 7, 4],
            [11, 11, 7, 5],
            [11, 11, 11, 6],
            [11, 11, 11, 7],
        ],
        thresholds: [24, 54, 116],
    },
];

// Appendix A (8-bit, 0.75 bpp): expected deltas by code.
const A_L2_5: [i16; 32] = [
    -71, -49, -38, -32, -27, -23, -20, -17, -14, -12, -10, -8, -6, -4, -3, -1, 1, 2, 4, 6, 8, 10,
    12, 14, 16, 19, 22, 26, 31, 37, 46, 72,
];
const A_L2_5_GDAL: [i16; 32] = [
    -71, -49, -38, -32, -27, -23, -20, -17, -14, -12, -10, -8, -6, -4, -3, -1, 1, 2, 4, 6, 8, 12,
    14, 16, 19, 22, 26, 31, 37, 46, 72, 0,
];
const B_L3_2: [i16; 4] = [-24, -6, 6, 24];
const C_L2_6: [i16; 64] = [
    -109, -82, -68, -59, -52, -46, -41, -37, -33, -30, -27, -25, -22, -20, -18, -16, -15, -13, -11,
    -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, //
    3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 24, 26, 28, 31, 35, 38,
    42, 47, 52, 60, 69, 85, 118,
];
const C_L3_4: [i16; 16] = [
    -68, -37, -23, -15, -9, -6, -3, -1, 1, 4, 7, 10, 16, 24, 37, 70,
];
const D_L3_4: [i16; 16] = [
    -117, -72, -50, -36, -25, -17, -10, -5, -1, 3, 7, 14, 25, 45, 82, 166,
];
const D_L4_2: [i16; 4] = [-47, -8, 4, 43];
const D_L2_7: [i16; 128] = [
    -159, -134, -122, -113, -106, -100, -94, -88, -83, -79, -76, -72, -69, -66, -63, -61, -58, -56,
    -54, -52, -50, -48, -47, -45, -43, //
    -42, -40, -39, -37, -36, -35, -33, -32, -31, -30, -29, -28, -27, -25, -24, -23, -22, -21, -20,
    -19, -18, -17, -16, -15, -14, //
    -13, -12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    12, 13, 14, 15, 16, 17, 18, 19, 20, //
    21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45,
    48, 52, 56, 60, 64, 68, 73, 79, 85, //
    92, 100, 109, 118, 130, 144, 159, 177, 196, 217, 236,
];

/// The coding parameters of one image: depth, rate, and whether every table is the standard's.
pub struct Params {
    depth: u32,
    rate: &'static Rate,
    rate_index: usize,
    gdal: bool,
}

impl Params {
    /// From NBPP (8 or 11; ABPP 2–7 are coded as 8 and 9–10 as 11, §6.5) and the COMRAT field.
    pub fn new(depth: u32, comrat: &str) -> Result<Params> {
        let depth = match depth {
            2..=8 => 8,
            9..=11 => 11,
            _ => {
                return Err(gw_abi::err!(UNSUPPORTED, "ARIDPCM codes 8- and 11-bit samples, not {depth}-bit", depth))
            }
        };
        let v: f64 = comrat
            .trim()
            .parse()
            .ok()
            .filter(|v: &f64| v.is_finite())
            .ok_or_else(|| {
                gw_abi::err!(INVALID, "ARIDPCM COMRAT ''{comrat}'' is not a rate", comrat = comrat.trim())
            })?;
        let rates = if depth == 8 { &RATES_8 } else { &RATES_11 };
        let rate_index = rates
            .iter()
            .position(|r| (r.name.parse::<f64>().unwrap_or(0.0) - v).abs() < 0.02)
            .ok_or_else(|| {
                gw_abi::err!(UNSUPPORTED, "ARIDPCM COMRAT {comrat} is not one of the {depth}-bit rates ({rates})", comrat = comrat.trim(), depth, rates = rates.iter().map(|r| r.name).collect::<Vec<_>>().join(", "))
            })?;
        Ok(Params {
            depth,
            rate: &rates[rate_index],
            rate_index,
            gdal: false,
        })
    }

    /// GDAL's reading (nitfaridpcm.cpp, 0.75 bpp only), for the differential test: its class A/B
    /// level-2 table lacks the entry 10 (codes 10101… shift by one), and on the top and left image
    /// edges it sets the corner L8,8 to L0,0 where §5.2.2.1 copies L0,8 or L8,0.
    pub fn gdal_quirks(mut self) -> Self {
        self.gdal = true;
        self
    }

    /// True when every quantisation table of this rate is published in the standard.
    pub fn exact(&self) -> bool {
        self.depth == 8 && self.rate_index == 0
    }

    pub fn rate_name(&self) -> &'static str {
        self.rate.name
    }

    fn table(&self, class: usize, level: usize) -> Option<&'static [i16]> {
        if self.exact() {
            return match (class, level) {
                (0, 1) | (1, 1) if self.gdal => Some(&A_L2_5_GDAL),
                (0, 1) | (1, 1) => Some(&A_L2_5),
                (1, 2) => Some(&B_L3_2),
                (2, 1) => Some(&C_L2_6),
                (2, 2) => Some(&C_L3_4),
                (3, 1) => Some(&D_L2_7),
                (3, 2) => Some(&D_L3_4),
                (3, 3) => Some(&D_L4_2),
                _ => None,
            };
        }
        derived::table(
            self.depth as u8,
            self.rate_index as u8,
            class as u8,
            level as u8,
        )
    }

    /// Bits of one neighbourhood of class `class`.
    fn bits(&self, class: usize) -> usize {
        let b = &self.rate.bam[class];
        b[0] as usize + 3 * b[1] as usize + 12 * b[2] as usize + 48 * b[3] as usize
    }

    fn class_of(&self, busyness: i32) -> usize {
        self.rate
            .thresholds
            .iter()
            .filter(|&&t| busyness >= t)
            .count()
    }
}

struct BitReader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl BitReader<'_> {
    fn get(&mut self, n: u8) -> Result<u32> {
        if self.pos + n as usize > self.b.len() * 8 {
            return Err(Error::range(
                "ARIDPCM: coded data ends inside a neighbourhood",
            ));
        }
        let mut v = 0u32;
        for _ in 0..n {
            v = (v << 1) | ((self.b[self.pos >> 3] >> (7 - (self.pos & 7))) & 1) as u32;
            self.pos += 1;
        }
        Ok(v)
    }
}

#[derive(Default)]
struct BitWriter {
    out: Vec<u8>,
    pos: usize,
}

impl BitWriter {
    fn put(&mut self, v: u32, n: u8) {
        for k in (0..n).rev() {
            if self.pos >> 3 >= self.out.len() {
                self.out.push(0);
            }
            if (v >> k) & 1 == 1 {
                self.out[self.pos >> 3] |= 0x80 >> (self.pos & 7);
            }
            self.pos += 1;
        }
    }
}

/// Prediction of (i, j) from the 9×9 neighbourhood `l` at the step of its level.
fn predict(l: &[[i32; 9]; 9], i: usize, j: usize) -> i32 {
    let s = if i % 4 == 0 && j % 4 == 0 {
        4
    } else if i % 2 == 0 && j % 2 == 0 {
        2
    } else {
        1
    };
    if i % (2 * s) == 0 {
        (l[i][j - s] + l[i][j + s]) >> 1
    } else if j % (2 * s) == 0 {
        (l[i - s][j] + l[i + s][j]) >> 1
    } else {
        (l[i - s][j - s] + l[i - s][j + s] + l[i + s][j - s] + l[i + s][j + s]) >> 2
    }
}

/// Level (0 = the corner, 1–3 = levels 2–4 of the standard) of ORDER index k.
fn level_of(k: usize) -> usize {
    match k {
        0 => 0,
        1..=3 => 1,
        4..=15 => 2,
        _ => 3,
    }
}

/// Fill row 8 / column 8 from the image (reconstructed neighbours) or by the edge replication of
/// §5.2.2.1 for the samples known before level `stage` (0: before level 2, 2: after level 2,
/// 3: after level 3).
fn edges(l: &mut [[i32; 9]; 9], top: bool, left: bool, stage: u8) {
    match stage {
        0 => {
            if top && left {
                l[8][8] = l[0][0];
            } else if top {
                l[8][8] = l[0][8];
            } else if left {
                l[8][8] = l[8][0];
            }
            if top {
                l[8][0] = l[0][0];
            }
            if left {
                l[0][8] = l[0][0];
            }
        }
        2 => {
            if top {
                l[8][4] = l[0][4];
            }
            if left {
                l[4][8] = l[4][0];
            }
        }
        _ => {
            if top {
                l[8][2] = l[0][2];
                l[8][6] = l[0][6];
            }
            if left {
                l[2][8] = l[2][0];
                l[6][8] = l[6][0];
            }
        }
    }
}

/// Load row 8 and column 8 of neighbourhood (nx, ny) from the reconstructed image `img`
/// (width `pw`, padded to whole neighbourhoods).
fn load_neighbours(l: &mut [[i32; 9]; 9], img: &[u16], pw: usize, nx: usize, ny: usize) {
    let (x0, y0) = (nx * 8, ny * 8);
    if nx > 0 {
        for i in 0..8 {
            l[i][8] = img[(y0 + 7 - i) * pw + x0 - 1] as i32;
        }
    }
    if ny > 0 {
        for j in 0..8 {
            l[8][j] = img[(y0 - 1) * pw + x0 + 7 - j] as i32;
        }
    }
    if nx > 0 && ny > 0 {
        l[8][8] = img[(y0 - 1) * pw + x0 - 1] as i32;
    }
}

/// A decoded block: samples (row-major, width × height) and whether the standard's own tables
/// were used for every level.
pub struct Decoded {
    pub data: Vec<u16>,
    pub exact: bool,
}

/// Decode one NITF block of `width` × `height` samples.
pub fn decode(data: &[u8], width: usize, height: usize, p: &Params) -> Result<Decoded> {
    if width == 0 || height == 0 || width > 1 << 15 || height > 1 << 15 {
        return Err(gw_abi::err!(LIMIT, "ARIDPCM block {width}×{height} is out of range", width, height));
    }
    let (bx, by) = (width.div_ceil(8), height.div_ceil(8));
    let n = bx * by;
    if data.len() * 8 < n * 2 {
        return Err(Error::range(
            "ARIDPCM: the busyness codes run past the block",
        ));
    }
    let maxv = (1i32 << p.depth) - 1;
    let pw = bx * 8;
    let mut img = vec![0u16; pw * by * 8];
    let mut codes = BitReader { b: data, pos: 0 };
    let mut busy = Vec::with_capacity(n);
    for _ in 0..n {
        busy.push(codes.get(2)? as usize);
    }
    let mut r = BitReader {
        b: data,
        pos: n * 2,
    };
    let mut exact = true;
    let mut l = [[0i32; 9]; 9];
    let mut coded = [0u32; 64];
    for ny in 0..by {
        for nx in 0..bx {
            let class = busy[ny * bx + nx];
            let bam = p.rate.bam[class];
            for (k, c) in coded.iter_mut().enumerate() {
                *c = r.get(bam[level_of(k)])?;
            }
            l = [[0; 9]; 9];
            load_neighbours(&mut l, &img, pw, nx, ny);
            l[0][0] = coded[0] as i32;
            let (top, left) = (ny == 0, nx == 0);
            edges(&mut l, top, left, 0);
            if p.gdal && (top || left) {
                l[8][8] = l[0][0];
            }
            for level in 1..4 {
                let bits = bam[level];
                let table = if bits == 0 || bits as u32 == p.depth {
                    None
                } else {
                    p.table(class, level)
                };
                if bits != 0 && bits as u32 != p.depth && table.is_none() {
                    return Err(gw_abi::err!(UNSUPPORTED, "ARIDPCM {depth}-bit COMRAT {rate}: no quantisation table for class {class} level {level}", depth = p.depth, rate = p.rate.name, class, level = level + 1));
                }
                if !p.exact() && table.is_some() {
                    exact = false;
                }
                let (s, cnt) = LEVEL_SPAN[level];
                for k in s..s + cnt {
                    let (i, j) = (ORDER[k].0 as usize, ORDER[k].1 as usize);
                    l[i][j] = if bits as u32 == p.depth {
                        coded[k] as i32
                    } else {
                        let d = table
                            .map_or(0, |t| t.get(coded[k] as usize).copied().unwrap_or(0) as i32);
                        predict(&l, i, j) + d
                    };
                }
                edges(&mut l, top, left, if level == 1 { 2 } else { 3 });
            }
            for (i, row) in l.iter().enumerate().take(8) {
                for (j, &v) in row.iter().enumerate().take(8) {
                    img[(ny * 8 + 7 - i) * pw + nx * 8 + 7 - j] = v.clamp(0, maxv) as u16;
                }
            }
        }
    }
    let _ = l;
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        out.extend_from_slice(&img[y * pw..y * pw + width]);
    }
    Ok(Decoded { data: out, exact })
}

/// Bits used by a block: the busyness table and the neighbourhoods (for structure checks).
pub fn coded_bits(data: &[u8], width: usize, height: usize, p: &Params) -> Result<usize> {
    let n = width.div_ceil(8) * height.div_ceil(8);
    let mut r = BitReader { b: data, pos: 0 };
    let mut total = n * 2;
    for _ in 0..n {
        total += p.bits(r.get(2)? as usize);
    }
    Ok(total)
}

/// Code nearest to `d` in `t` (ties: the value nearer zero; a zero delta between two values
/// equally far from zero takes the positive one, §5.2.2.6).
fn quantise(t: &[i16], d: i32) -> usize {
    let mut best = 0;
    for (k, &e) in t.iter().enumerate() {
        let (e, b) = (e as i32, t[best] as i32);
        let (de, db) = ((e - d).abs(), (b - d).abs());
        if de < db || (de == db && (e.abs() < b.abs() || (e.abs() == b.abs() && e > b))) {
            best = k;
        }
    }
    best
}

/// Encode one block (non-driven mode, §5.2.2): busyness from the open-loop level-4 deltas,
/// closed-loop prediction from the reconstructed samples, so the decoder's predictions match.
pub fn encode(px: &[u16], width: usize, height: usize, p: &Params) -> Result<Vec<u8>> {
    if width == 0 || height == 0 || px.len() < width * height || width > 1 << 15 || height > 1 << 15
    {
        return Err(Error::invalid("ARIDPCM encode: bad block size"));
    }
    let maxv = (1i32 << p.depth) - 1;
    let (bx, by) = (width.div_ceil(8), height.div_ceil(8));
    let pw = bx * 8;
    // Pad by replicating the last row and column (§5.2.5.1).
    let src: Vec<i32> = (0..by * 8)
        .flat_map(|y| (0..pw).map(move |x| (y.min(height - 1), x.min(width - 1))))
        .map(|(y, x)| (px[y * width + x] as i32).min(maxv))
        .collect();
    let orig = |nx: usize, ny: usize| -> [[i32; 9]; 9] {
        let mut o = [[0i32; 9]; 9];
        for i in 0..8 {
            for j in 0..8 {
                o[i][j] = src[(ny * 8 + 7 - i) * pw + nx * 8 + 7 - j];
            }
        }
        o
    };
    // Busyness classes (open loop on the originals, edges replicated).
    let mut busy = Vec::with_capacity(bx * by);
    for ny in 0..by {
        for nx in 0..bx {
            let mut o = orig(nx, ny);
            let (x0, y0) = (nx * 8, ny * 8);
            if nx > 0 {
                for (i, row) in o.iter_mut().enumerate().take(8) {
                    row[8] = src[(y0 + 7 - i) * pw + x0 - 1];
                }
            }
            if ny > 0 {
                for j in 0..8 {
                    o[8][j] = src[(y0 - 1) * pw + x0 + 7 - j];
                }
            }
            if nx > 0 && ny > 0 {
                o[8][8] = src[(y0 - 1) * pw + x0 - 1];
            }
            let (top, left) = (ny == 0, nx == 0);
            edges(&mut o, top, left, 0);
            edges(&mut o, top, left, 2);
            edges(&mut o, top, left, 3);
            let (mut lo, mut hi) = (i32::MAX, i32::MIN);
            for &(i, j) in &ORDER[16..] {
                let d = o[i as usize][j as usize] - predict(&o, i as usize, j as usize);
                lo = lo.min(d);
                hi = hi.max(d);
            }
            busy.push(p.class_of(hi - lo));
        }
    }
    let mut w = BitWriter::default();
    for &c in &busy {
        w.put(c as u32, 2);
    }
    let mut img = vec![0u16; pw * by * 8];
    for ny in 0..by {
        for nx in 0..bx {
            let class = busy[ny * bx + nx];
            let bam = p.rate.bam[class];
            let o = orig(nx, ny);
            let mut l = [[0i32; 9]; 9];
            load_neighbours(&mut l, &img, pw, nx, ny);
            l[0][0] = o[0][0];
            w.put(o[0][0] as u32, bam[0]);
            let (top, left) = (ny == 0, nx == 0);
            edges(&mut l, top, left, 0);
            for level in 1..4 {
                let bits = bam[level];
                let (s, cnt) = LEVEL_SPAN[level];
                let table = if bits == 0 || bits as u32 == p.depth {
                    None
                } else {
                    Some(p.table(class, level).ok_or_else(|| {
                        gw_abi::err!(UNSUPPORTED, "ARIDPCM COMRAT {rate}: no table for class {class} level {level}", rate = p.rate.name, class, level = level + 1)
                    })?)
                };
                for &(i, j) in &ORDER[s..s + cnt] {
                    let (i, j) = (i as usize, j as usize);
                    if bits as u32 == p.depth {
                        w.put(o[i][j] as u32, bits);
                        l[i][j] = o[i][j];
                    } else {
                        let pr = predict(&l, i, j);
                        match table {
                            Some(t) => {
                                let c = quantise(t, o[i][j] - pr);
                                w.put(c as u32, bits);
                                l[i][j] = pr + t[c] as i32;
                            }
                            None => l[i][j] = pr,
                        }
                    }
                }
                edges(&mut l, top, left, if level == 1 { 2 } else { 3 });
            }
            for (i, row) in l.iter().enumerate().take(8) {
                for (j, &v) in row.iter().enumerate().take(8) {
                    img[(ny * 8 + 7 - i) * pw + nx * 8 + 7 - j] = v.clamp(0, maxv) as u16;
                }
            }
        }
    }
    Ok(w.out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_are_complete() {
        assert_eq!(A_L2_5.len(), 32);
        for t in [&A_L2_5[..], &C_L2_6, &D_L2_7, &C_L3_4, &D_L3_4] {
            assert!(t.windows(2).all(|w| w[0] < w[1]), "monotonic");
        }
        for (depth, rates) in [(8u32, &RATES_8), (11, &RATES_11)] {
            for r in rates.iter() {
                let p = Params::new(depth, r.name).unwrap();
                for class in 0..4 {
                    for level in 1..4 {
                        let bits = r.bam[class][level] as u32;
                        if bits == 0 || bits == depth {
                            continue;
                        }
                        let t = p.table(class, level).unwrap_or_else(|| {
                            panic!("{depth}-bit {} class {class} level {}", r.name, level + 1)
                        });
                        assert_eq!(
                            t.len(),
                            1 << bits,
                            "{depth}-bit {} class {class} level {}",
                            r.name,
                            level + 1
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn bam_rates_match_table_iii() {
        // Actual bpp of each class (tables III/IV): bits / 64.
        let p = Params::new(8, "0.75").unwrap();
        assert_eq!([0, 1, 2, 3].map(|c| p.bits(c)), [23, 47, 74, 173]);
        let p = Params::new(8, "4.50").unwrap();
        assert!((p.bits(3) as f64 / 64.0 - 7.25).abs() < 0.01);
    }

    fn sample(w: usize, h: usize) -> Vec<u16> {
        (0..w * h)
            .map(|k| ((k % w) * 3 + (k / w) * 2 + ((k * 7919) % 23)) as u16 % 256)
            .collect()
    }

    #[test]
    fn round_trip_every_rate() {
        for (depth, rates) in [(8u32, &RATES_8), (11, &RATES_11)] {
            for r in rates.iter() {
                let p = Params::new(depth, r.name).unwrap();
                let (w, h) = (37, 21);
                let px: Vec<u16> = sample(w, h)
                    .into_iter()
                    .map(|v| if depth == 11 { v * 7 } else { v })
                    .collect();
                let enc = encode(&px, w, h, &p).unwrap();
                assert!(coded_bits(&enc, w, h, &p).unwrap().div_ceil(8) == enc.len());
                let dec = decode(&enc, w, h, &p).unwrap();
                let mse = px
                    .iter()
                    .zip(&dec.data)
                    .map(|(a, b)| (*a as f64 - *b as f64).powi(2))
                    .sum::<f64>()
                    / px.len() as f64;
                let peak = ((1u32 << depth) - 1) as f64;
                let psnr = 10.0 * (peak * peak / mse.max(1e-9)).log10();
                assert!(psnr > 20.0, "{depth}-bit {}: PSNR {psnr:.1}", r.name);
            }
        }
    }

    #[test]
    fn flat_image_is_near_exact() {
        let p = Params::new(8, "0.75").unwrap();
        let px = vec![128u16; 64 * 16];
        let dec = decode(&encode(&px, 64, 16, &p).unwrap(), 64, 16, &p).unwrap();
        // Appendix A has no zero delta at level 2 (±1 nearest): a flat block comes back within 1.
        assert!(dec.data.iter().all(|&v| v.abs_diff(128) <= 1) && dec.exact);
    }

    #[test]
    fn truncated_input_is_an_error() {
        let p = Params::new(8, "0.75").unwrap();
        let enc = encode(&sample(32, 32), 32, 32, &p).unwrap();
        for n in [0, 1, 3, enc.len() / 2] {
            assert!(decode(&enc[..n], 32, 32, &p).is_err());
        }
        assert!(Params::new(8, "3.00").is_err() && Params::new(12, "0.75").is_err());
    }
}
