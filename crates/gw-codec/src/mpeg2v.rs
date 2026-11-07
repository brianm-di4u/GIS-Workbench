//! MPEG-2 video decoder (ISO/IEC 13818-2 Main Profile: MP@ML and MP@HL, 4:2:0; REQ-GAP-48, S-58).
//!
//! Built on the MPEG-1 decoder (`mpeg1v`, after pl_mpeg): the same piecewise input, start-code
//! framing, seek handling (pictures whose references were not decoded are skipped) and output
//! ordering, with the MPEG-2 syntax added:
//! - sequence, quant-matrix and picture-coding extensions (size and frame-rate extensions,
//!   progressive_sequence, f_code per direction and component, intra DC precision 8–11 bits,
//!   q_scale_type, intra_vlc_format, alternate scan, concealment motion vectors);
//! - frame pictures and field pictures (a frame is complete after its second field; the second
//!   field of a P frame may predict from the first);
//! - frame, field, 16×8 and dual-prime motion compensation, field and frame DCT;
//! - MPEG-2 inverse quantisation with saturation and mismatch control, the 12-bit escape and the
//!   intra VLC table B-15;
//! - the IDCT is the integer "simple IDCT" of FFmpeg (`libavcodec/simple_idct`, LGPL; this is an
//!   independent re-implementation of its published arithmetic, no code copied), so frames can
//!   be compared bit for bit with `ffmpeg -idct simple`.
//!
//! Every read and write is bounds-checked: a corrupt stream gives damaged pictures, never a panic.
//! VLC tables come from the pl_mpeg trees in `mpeg1v_tables.rs` (B-1..B-4, B-9, B-10, B-12..B-14)
//! and from ISO/IEC 13818-2 Table B-15 (below), decoded through leading-zero lookup tables.

use gw_abi::{Error, Result};

include!("mpeg1v_tables.rs");
// The AAN premultipliers of the MPEG-1 IDCT are not used here (the simple IDCT takes plain coefficients).
const _: [u8; 64] = PREMULTIPLIER_MATRIX;

const PIC_I: u8 = 1;
const PIC_P: u8 = 2;
const PIC_B: u8 = 3;
const MAX_DIM: u32 = 4096;
const TOP: u8 = 1;
#[cfg_attr(not(test), allow(dead_code))]
const BOTTOM: u8 = 2;
const FRAME: u8 = 3;

const EOB: i16 = -2;
const ESC: i16 = -1;

/// ISO/IEC 13818-2 Figure 7-3: alternate scan (scan position → natural index).
const ALT_SCAN: [u8; 64] = [
    0, 8, 16, 24, 1, 9, 2, 10, 17, 25, 32, 40, 48, 56, 57, 49, 41, 33, 26, 18, 3, 11, 4, 12, 19, 27, 34, 42, 50, 58, 35, 43, 51, 59, 20, 28, 5, 13, 6, 14, 21, 29, 36, 44, 52, 60, 37, 45, 53, 61, 22, 30, 7, 15, 23, 31, 38, 46, 54, 62, 39, 47, 55, 63,
];

/// Table 7-6: quantiser_scale for q_scale_type 1.
const NON_LINEAR_QS: [u8; 32] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96, 104, 112];

/// Table B-15 (intra_vlc_format = 1): (code, length without the sign bit, run, level).
#[rustfmt::skip]
const B15: [(u16, u8, u8, u8); 111] = [
    (0x02, 2, 0, 1), (0x06, 3, 0, 2), (0x07, 4, 0, 3), (0x1c, 5, 0, 4), (0x1d, 5, 0, 5), (0x05, 6, 0, 6), (0x04, 6, 0, 7), (0x7b, 7, 0, 8),
    (0x7c, 7, 0, 9), (0x23, 8, 0, 10), (0x22, 8, 0, 11), (0xfa, 8, 0, 12), (0xfb, 8, 0, 13), (0xfe, 8, 0, 14), (0xff, 8, 0, 15), (0x1f, 14, 0, 16),
    (0x1e, 14, 0, 17), (0x1d, 14, 0, 18), (0x1c, 14, 0, 19), (0x1b, 14, 0, 20), (0x1a, 14, 0, 21), (0x19, 14, 0, 22), (0x18, 14, 0, 23), (0x17, 14, 0, 24),
    (0x16, 14, 0, 25), (0x15, 14, 0, 26), (0x14, 14, 0, 27), (0x13, 14, 0, 28), (0x12, 14, 0, 29), (0x11, 14, 0, 30), (0x10, 14, 0, 31), (0x18, 15, 0, 32),
    (0x17, 15, 0, 33), (0x16, 15, 0, 34), (0x15, 15, 0, 35), (0x14, 15, 0, 36), (0x13, 15, 0, 37), (0x12, 15, 0, 38), (0x11, 15, 0, 39), (0x10, 15, 0, 40),
    (0x02, 3, 1, 1), (0x06, 5, 1, 2), (0x79, 7, 1, 3), (0x27, 8, 1, 4), (0x20, 8, 1, 5), (0x16, 13, 1, 6), (0x15, 13, 1, 7), (0x1f, 15, 1, 8),
    (0x1e, 15, 1, 9), (0x1d, 15, 1, 10), (0x1c, 15, 1, 11), (0x1b, 15, 1, 12), (0x1a, 15, 1, 13), (0x19, 15, 1, 14), (0x13, 16, 1, 15), (0x12, 16, 1, 16),
    (0x11, 16, 1, 17), (0x10, 16, 1, 18), (0x05, 5, 2, 1), (0x07, 7, 2, 2), (0xfc, 8, 2, 3), (0x0c, 10, 2, 4), (0x14, 13, 2, 5), (0x07, 5, 3, 1),
    (0x26, 8, 3, 2), (0x1c, 12, 3, 3), (0x13, 13, 3, 4), (0x06, 6, 4, 1), (0xfd, 8, 4, 2), (0x12, 12, 4, 3), (0x07, 6, 5, 1), (0x04, 9, 5, 2),
    (0x12, 13, 5, 3), (0x06, 7, 6, 1), (0x1e, 12, 6, 2), (0x14, 16, 6, 3), (0x04, 7, 7, 1), (0x15, 12, 7, 2), (0x05, 7, 8, 1), (0x11, 12, 8, 2),
    (0x78, 7, 9, 1), (0x11, 13, 9, 2), (0x7a, 7, 10, 1), (0x10, 13, 10, 2), (0x21, 8, 11, 1), (0x1a, 16, 11, 2), (0x25, 8, 12, 1), (0x19, 16, 12, 2),
    (0x24, 8, 13, 1), (0x18, 16, 13, 2), (0x05, 9, 14, 1), (0x17, 16, 14, 2), (0x07, 9, 15, 1), (0x16, 16, 15, 2), (0x0d, 10, 16, 1), (0x15, 16, 16, 2),
    (0x1f, 12, 17, 1), (0x1a, 12, 18, 1), (0x19, 12, 19, 1), (0x17, 12, 20, 1), (0x16, 12, 21, 1), (0x1f, 13, 22, 1), (0x1e, 13, 23, 1), (0x1d, 13, 24, 1),
    (0x1c, 13, 25, 1), (0x1b, 13, 26, 1), (0x1f, 16, 27, 1), (0x1e, 16, 28, 1), (0x1d, 16, 29, 1), (0x1c, 16, 30, 1), (0x1b, 16, 31, 1),
];

// ---- VLC lookup ----

#[derive(Clone, Copy, Default)]
struct E {
    len: u8,
    val: i16,
}

/// A prefix code decoded by the number of leading zeros, then a table of the bits after the first 1.
struct Vlc {
    lz: Vec<(u32, Vec<E>)>,
}

impl Vlc {
    fn new(codes: &[(u32, u8, i16)]) -> Self {
        // A code of n zero bits (e.g. "00" for DC size 1) matches every input with n or more
        // leading zeros: it fills every table from n leading zeros up.
        let lz_of = |c: u32, n: u8| n as usize - (32 - c.leading_zeros()) as usize;
        let mut lz: Vec<(u32, Vec<E>)> = vec![(0, Vec::new()); 33];
        for &(c, n, _) in codes {
            if c != 0 {
                let z = lz_of(c, n);
                lz[z].0 = lz[z].0.max((n as usize - z - 1) as u32);
            }
        }
        for e in lz.iter_mut() {
            e.1 = vec![E::default(); 1 << e.0];
        }
        for &(c, n, v) in codes {
            if c == 0 {
                for (_, t) in lz.iter_mut().skip(n as usize) {
                    for e in t.iter_mut().filter(|e| e.len == 0) {
                        *e = E { len: n, val: v };
                    }
                }
                continue;
            }
            let z = lz_of(c, n);
            let s = n as usize - z - 1;
            let (w, t) = &mut lz[z];
            let suffix = (c as usize) & ((1 << s) - 1);
            let span = 1usize << (*w as usize - s);
            for k in 0..span {
                t[(suffix << (*w as usize - s)) | k] = E { len: n, val: v };
            }
        }
        while lz.last().is_some_and(|e| e.1.iter().all(|x| x.len == 0)) {
            lz.pop();
        }
        Vlc { lz }
    }

    /// The entry for the next bits (MSB first in `b`); len 0 = no valid code.
    #[inline(always)]
    fn get(&self, b: u32) -> E {
        let z = b.leading_zeros() as usize;
        let Some((w, t)) = self.lz.get(z) else { return E::default() };
        if *w == 0 {
            return t[0];
        }
        let rest = (((b as u64) << (z + 1)) >> (32 - *w)) as u32 & ((1u32 << *w) - 1);
        t[rest as usize]
    }
}

/// Leaves of a pl_mpeg VLC tree → (code, length, value); invalid leaves are left out.
fn tree_codes(t: &[[i16; 2]]) -> Vec<(u32, u8, i16)> {
    let mut out = Vec::new();
    let mut stack = vec![(0usize, 0u32, 0u8)];
    while let Some((idx, code, len)) = stack.pop() {
        for bit in 0..2u32 {
            let Some(s) = t.get(idx + bit as usize) else { continue };
            let (c, n) = ((code << 1) | bit, len + 1);
            if s[0] > 0 {
                if n < 24 {
                    stack.push((s[0] as usize, c, n));
                }
            } else if s[0] == 0 {
                out.push((c, n, s[1]));
            }
        }
    }
    out
}

struct Tables {
    mba: Vlc,
    mbt: [Vlc; 3],
    cbp: Vlc,
    motion: Vlc,
    dc_l: Vlc,
    dc_c: Vlc,
    dct_first: Vlc,
    dct_next: Vlc,
    dct_b15: Vlc,
}

fn tables() -> &'static Tables {
    static T: std::sync::OnceLock<Tables> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let mut cbp = tree_codes(&CODE_BLOCK_PATTERN);
        // MPEG-2 allows coded_block_pattern 0 ('0000 0000 1', Table B-9).
        if !cbp.iter().any(|&(_, _, v)| v == 0) {
            cbp.push((1, 9, 0));
        }
        // Table B-12/B-13 extend the MPEG-1 DC size codes to 11 bits.
        let mut dc_l = tree_codes(&DCT_SIZE_LUMINANCE);
        dc_l.extend([(0xfe, 8, 9), (0x1fe, 9, 10), (0x1ff, 9, 11)]);
        let mut dc_c = tree_codes(&DCT_SIZE_CHROMINANCE);
        dc_c.extend([(0x1fe, 9, 9), (0x3fe, 10, 10), (0x3ff, 10, 11)]);
        // B-14: the pl_mpeg tree has "1" as (0,1); after the first coefficient "10" is end of
        // block and "11" is (0,1).
        let b14: Vec<_> = tree_codes(&DCT_COEFF).into_iter().map(|(c, n, v)| (c, n, if v == -1 { ESC } else { v })).collect();
        let first = b14.clone();
        let mut next: Vec<_> = b14.into_iter().filter(|&(c, n, _)| !(n == 1 && c == 1)).collect();
        next.extend([(0b10, 2, EOB), (0b11, 2, 1)]);
        let mut b15: Vec<_> = B15.iter().map(|&(c, n, r, l)| (c as u32, n, ((r as i16) << 8) | l as i16)).collect();
        b15.extend([(0b0110, 4, EOB), (0b000001, 6, ESC)]);
        Tables {
            mba: Vlc::new(&tree_codes(&MACROBLOCK_ADDRESS_INCREMENT)),
            mbt: [Vlc::new(&tree_codes(&MACROBLOCK_TYPE_INTRA)), Vlc::new(&tree_codes(&MACROBLOCK_TYPE_PREDICTIVE)), Vlc::new(&tree_codes(&MACROBLOCK_TYPE_B))],
            cbp: Vlc::new(&cbp),
            motion: Vlc::new(&tree_codes(&MOTION)),
            dc_l: Vlc::new(&dc_l),
            dc_c: Vlc::new(&dc_c),
            dct_first: Vlc::new(&first),
            dct_next: Vlc::new(&next),
            dct_b15: Vlc::new(&b15),
        }
    })
}

// ---- frames ----

#[derive(Default, Clone)]
pub struct Frame {
    pub y: Vec<u8>,
    pub cb: Vec<u8>,
    pub cr: Vec<u8>,
    /// Decode ordinal (frames since the last reset), temporal reference and type (of the first field).
    pub ord: u32,
    pub tr: u16,
    pub ptype: u8,
    /// Field pictures (true) or one frame picture; progressive_frame; top_field_first; repeat_first_field.
    pub fields: bool,
    pub progressive: bool,
    pub tff: bool,
    pub rff: bool,
}

/// Which internal frame holds a decoded picture ready for display.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    Current,
    Forward,
    Backward,
}

#[derive(Clone, Copy, Debug)]
pub struct Out {
    pub slot: Slot,
    pub ord: u32,
    pub tr: u16,
    pub ptype: u8,
}

/// Picture coding extension and header fields of the picture being decoded.
#[derive(Clone, Copy, Default)]
struct Pic {
    ptype: u8,
    structure: u8,
    f_code: [[u8; 2]; 2],
    dc_prec: u8,
    tff: bool,
    fpfd: bool,
    cmv: bool,
    qst: bool,
    ivf: bool,
    alt: bool,
    rff: bool,
    progressive: bool,
    second: bool,
}

/// One macroblock's prediction and reconstruction (luma 16×16, chroma 8×8 ×2; field MBs of a
/// field picture are 16 field lines).
struct Mb {
    y: [u8; 256],
    c: [[u8; 64]; 2],
}

#[derive(Clone, Copy, Default)]
struct MbMotion {
    fwd: bool,
    bwd: bool,
    /// Motion type: 1 field, 2 frame (frame pictures) / 16×8 (field pictures), 3 dual prime.
    mtype: u8,
    mv: [[[i32; 2]; 2]; 2], // [r][s][t]
    fs: [[u8; 2]; 2],       // [r][s]
    dmv: [i32; 2],
}

pub struct Decoder {
    buf: Vec<u8>,
    pos: usize,
    ended: bool,
    end_hint: usize,
    bit: usize,
    limit: usize,
    // Sequence.
    pub has_seq: bool,
    pub mpeg2: bool,
    pub width: u32,
    pub height: u32,
    pub rate_code: u8,
    pub rate_ext: (u8, u8),
    pub aspect: u8,
    pub profile_level: u8,
    pub progressive_seq: bool,
    pub chroma_format: u8,
    pub low_delay: bool,
    seq_pending: Option<(u32, u32, u8, u8)>,
    mb_w: i32,
    mb_h: i32,
    luma_w: usize,
    chroma_w: usize,
    luma_h: usize,
    chroma_h: usize,
    q: [[u8; 64]; 4], // intra, non-intra, chroma intra, chroma non-intra (natural order)
    cur: Frame,
    fwd: Frame,
    bwd: Frame,
    // Picture.
    pic: Pic,
    qs: i32,
    dc: [i32; 3],
    pmv: [[[i32; 2]; 2]; 2], // [r][s][t]
    last: MbMotion,
    mb_row: i32,
    mb_col: i32,
    block: [i32; 64],
    /// Field pairing: the parity of a first field waiting for its second, and whether its frame
    /// is being skipped (its references were not decoded).
    field_pending: Option<u8>,
    frame_skip: bool,
    has_ref: bool,
    refs: u8,
    refs_in_gop: u8,
    gop_closed: bool,
    broken_link: bool,
    ord: u32,
    flushed: bool,
    pub decoded: u32,
    pub skipped: u32,
    /// Field pictures and frames with interlaced coding seen (for the info).
    pub field_pictures: u32,
    pub interlaced_frames: u32,
    /// Slices cut short by a damaged macroblock.
    pub errors: u32,
    /// Coverage counters (tests): field-picture field MC, 16×8, field dual prime, frame dual
    /// prime, frame-picture field MC, skipped, concealment vectors, escapes.
    #[cfg(test)]
    cov: [u32; 8],
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    pub fn new() -> Self {
        tables();
        Self {
            buf: Vec::new(),
            pos: 0,
            ended: false,
            end_hint: 0,
            bit: 0,
            limit: 0,
            has_seq: false,
            mpeg2: false,
            width: 0,
            height: 0,
            rate_code: 0,
            rate_ext: (0, 0),
            aspect: 0,
            profile_level: 0,
            progressive_seq: true,
            chroma_format: 1,
            low_delay: false,
            seq_pending: None,
            mb_w: 0,
            mb_h: 0,
            luma_w: 0,
            chroma_w: 0,
            luma_h: 0,
            chroma_h: 0,
            q: [INTRA_QUANT_MATRIX, NON_INTRA_QUANT_MATRIX, INTRA_QUANT_MATRIX, NON_INTRA_QUANT_MATRIX],
            cur: Frame::default(),
            fwd: Frame::default(),
            bwd: Frame::default(),
            pic: Pic::default(),
            qs: 2,
            dc: [128; 3],
            pmv: [[[0; 2]; 2]; 2],
            last: MbMotion::default(),
            mb_row: 0,
            mb_col: 0,
            block: [0; 64],
            field_pending: None,
            frame_skip: false,
            has_ref: false,
            refs: 0,
            refs_in_gop: 0,
            gop_closed: false,
            broken_link: false,
            ord: 0,
            flushed: false,
            decoded: 0,
            skipped: 0,
            field_pictures: 0,
            interlaced_frames: 0,
            errors: 0,
            #[cfg(test)]
            cov: [0; 8],
        }
    }

    /// Append elementary-stream bytes.
    pub fn push(&mut self, data: &[u8]) {
        if self.pos > (1 << 20) && self.pos <= self.buf.len() {
            self.buf.drain(..self.pos);
            self.end_hint = self.end_hint.saturating_sub(self.pos);
            self.pos = 0;
        }
        self.buf.extend_from_slice(data);
    }

    /// No more input: the last pictures are decoded and the last reference is output.
    pub fn end(&mut self) {
        self.ended = true;
    }

    /// A seek: drop buffered input and the reference pictures (the sequence is kept).
    pub fn reset(&mut self) {
        self.buf.clear();
        self.pos = 0;
        self.end_hint = 0;
        self.ended = false;
        self.has_ref = false;
        self.refs = 0;
        self.ord = 0;
        self.flushed = false;
        self.field_pending = None;
        self.frame_skip = false;
    }

    pub fn fps(&self) -> f64 {
        const R: [f64; 9] = [0.0, 24000.0 / 1001.0, 24.0, 25.0, 30000.0 / 1001.0, 30.0, 50.0, 60000.0 / 1001.0, 60.0];
        let base = R.get(self.rate_code as usize).copied().unwrap_or(0.0);
        base * (self.rate_ext.0 as f64 + 1.0) / (self.rate_ext.1 as f64 + 1.0)
    }

    pub fn frame(&self, s: Slot) -> &Frame {
        match s {
            Slot::Current => &self.cur,
            Slot::Forward => &self.fwd,
            Slot::Backward => &self.bwd,
        }
    }

    /// Luma and chroma line strides of the frame buffers (coded size, a multiple of 16 / 8).
    pub fn strides(&self) -> (usize, usize) {
        (self.luma_w, self.chroma_w)
    }

    fn find_code(&self, from: usize) -> Option<(usize, u8)> {
        let b = &self.buf;
        let mut i = from;
        while i + 3 < b.len() {
            if b[i + 2] > 1 {
                i += 3;
            } else if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
                return Some((i, b[i + 3]));
            } else {
                i += 1;
            }
        }
        None
    }

    /// Decode until the next frame ready for display, or None when more input is needed (or the
    /// input has ended and everything was output).
    pub fn decode(&mut self) -> Result<Option<Out>> {
        loop {
            let Some((at, code)) = self.find_code(self.pos) else {
                if self.ended {
                    self.pos = self.buf.len();
                    if let Some(o) = self.lone_field() {
                        return Ok(Some(o));
                    }
                    return Ok(self.flush());
                }
                self.pos = self.buf.len().saturating_sub(3).max(self.pos);
                return Ok(None);
            };
            match code {
                0xB3 => {
                    if at + 4 + 8 + 128 > self.buf.len() && !self.ended {
                        self.pos = at;
                        return Ok(None);
                    }
                    self.sequence_header(at + 4)?;
                }
                0xB5 => {
                    if at + 16 > self.buf.len() && !self.ended {
                        self.pos = at;
                        return Ok(None);
                    }
                    self.extension(at + 4, self.buf.len())?;
                }
                0xB8 => {
                    if at + 8 > self.buf.len() && !self.ended {
                        self.pos = at;
                        return Ok(None);
                    }
                    let f = self.buf.get(at + 7).copied().unwrap_or(0);
                    self.gop_closed = f & 0x40 != 0;
                    self.broken_link = f & 0x20 != 0;
                    self.refs_in_gop = 0;
                }
                0x00 if self.has_seq => {
                    let mut from = (at + 4).max(self.end_hint);
                    let end = loop {
                        match self.find_code(from) {
                            Some((e, c)) if matches!(c, 0x00 | 0xB3 | 0xB7 | 0xB8) => break Some(e),
                            Some((e, _)) => from = e + 3,
                            None => break None,
                        }
                    };
                    let end = match end {
                        Some(e) => e,
                        None if self.ended => self.buf.len(),
                        None => {
                            self.pos = at;
                            self.end_hint = self.buf.len().saturating_sub(3);
                            return Ok(None);
                        }
                    };
                    self.end_hint = 0;
                    match self.picture(at + 4, end) {
                        Step::Lone(o) => {
                            // A first field without its second: that frame is finished first and
                            // this picture is decoded on the next call.
                            self.pos = at;
                            if let Some(o) = o {
                                return Ok(Some(o));
                            }
                            continue;
                        }
                        Step::Out(o) => {
                            self.pos = end;
                            return Ok(Some(o));
                        }
                        Step::None => {
                            self.pos = end;
                            continue;
                        }
                    }
                }
                _ => {}
            }
            self.pos = at + 4;
        }
    }

    /// Parse the first sequence header (and its extension) in the buffered input without decoding
    /// pictures; true once an MPEG-2 sequence is known.
    pub fn headers(&mut self) -> Result<bool> {
        let mut from = 0;
        while let Some((at, code)) = self.find_code(from) {
            if code == 0xB3 && at + 12 <= self.buf.len() {
                self.sequence_header(at + 4)?;
            } else if code == 0xB5 && at + 10 <= self.buf.len() && self.seq_pending.is_some() {
                self.extension(at + 4, self.buf.len())?;
                if self.has_seq {
                    return Ok(true);
                }
            } else if code == 0x00 && self.seq_pending.is_some() && !self.has_seq {
                return Err(Error::unsupported("MPEG-1 video (no sequence extension): use the MPEG-1 decoder"));
            }
            from = at + 3;
        }
        Ok(self.has_seq)
    }

    fn flush(&mut self) -> Option<Out> {
        if self.has_ref && !self.flushed && matches!(self.bwd.ptype, PIC_I | PIC_P) {
            self.flushed = true;
            self.has_ref = false;
            let f = &self.bwd;
            return Some(Out { slot: Slot::Backward, ord: f.ord, tr: f.tr, ptype: f.ptype });
        }
        None
    }

    // ---- bit reader ----

    #[inline(always)]
    fn peek(&self, n: u32) -> u32 {
        let byte = self.bit >> 3;
        let w = if byte + 8 <= self.limit {
            u64::from_be_bytes(self.buf[byte..byte + 8].try_into().unwrap_or([0; 8]))
        } else {
            let mut t = [0u8; 8];
            for (k, x) in t.iter_mut().enumerate() {
                if byte + k < self.limit {
                    *x = self.buf[byte + k];
                }
            }
            u64::from_be_bytes(t)
        };
        ((w << (self.bit & 7)) >> (64 - n)) as u32
    }

    #[inline(always)]
    fn read(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        let v = self.peek(n);
        self.bit += n as usize;
        v
    }

    #[inline(always)]
    fn read1(&mut self) -> u32 {
        self.read(1)
    }

    #[inline(always)]
    fn vlc(&mut self, v: &Vlc) -> Option<i16> {
        let e = v.get(self.peek(32));
        if e.len == 0 {
            return None;
        }
        self.bit += e.len as usize;
        Some(e.val)
    }

    fn overrun(&self) -> bool {
        self.bit > self.limit << 3
    }

    fn align(&mut self) {
        self.bit = (self.bit + 7) & !7;
    }

    fn next_start_code(&mut self) -> Option<u8> {
        self.align();
        let mut i = self.bit >> 3;
        while i + 3 < self.limit {
            if self.buf[i] == 0 && self.buf[i + 1] == 0 && self.buf[i + 2] == 1 {
                self.bit = (i + 4) << 3;
                return Some(self.buf[i + 3]);
            }
            i += 1;
        }
        self.bit = self.limit << 3;
        None
    }

    // ---- headers ----

    fn load_matrix(&mut self, into: &mut [u8; 64]) {
        for &z in ZIG_ZAG.iter() {
            into[z as usize] = (self.read(8) as u8).max(1);
        }
    }

    fn sequence_header(&mut self, at: usize) -> Result<()> {
        self.bit = at << 3;
        self.limit = self.buf.len();
        let w = self.read(12);
        let h = self.read(12);
        let aspect = self.read(4) as u8;
        let rate = self.read(4) as u8;
        self.bit += 18 + 1 + 10 + 1;
        // A sequence header resets the matrices to their defaults unless it loads them.
        let mut iq = INTRA_QUANT_MATRIX;
        let mut nq = NON_INTRA_QUANT_MATRIX;
        if self.read1() == 1 {
            self.load_matrix(&mut iq);
        }
        if self.read1() == 1 {
            self.load_matrix(&mut nq);
        }
        self.q = [iq, nq, iq, nq];
        self.aspect = aspect;
        self.rate_code = rate;
        self.seq_pending = Some((w, h, aspect, rate));
        Ok(())
    }

    /// An extension at `at` (after its start code) within `[.., limit)`.
    fn extension(&mut self, at: usize, limit: usize) -> Result<()> {
        self.bit = at << 3;
        self.limit = limit.min(self.buf.len());
        match self.read(4) {
            1 => self.sequence_extension(),
            3 => {
                if self.read1() == 1 {
                    let mut m = [0; 64];
                    self.load_matrix(&mut m);
                    self.q[0] = m;
                    self.q[2] = m;
                }
                if self.read1() == 1 {
                    let mut m = [0; 64];
                    self.load_matrix(&mut m);
                    self.q[1] = m;
                    self.q[3] = m;
                }
                // Chroma matrices are not used for 4:2:0 (ISO/IEC 13818-2 §6.3.11).
                Ok(())
            }
            8 => {
                let ptype = self.pic.ptype;
                let mut f = [[0u8; 2]; 2];
                for r in f.iter_mut() {
                    for s in r.iter_mut() {
                        *s = self.read(4) as u8;
                    }
                }
                let dc_prec = self.read(2) as u8;
                let structure = self.read(2) as u8;
                let flags = self.read(10);
                let p2 = Pic {
                    ptype,
                    structure,
                    f_code: f,
                    dc_prec,
                    tff: flags & 0x200 != 0,
                    fpfd: flags & 0x100 != 0,
                    cmv: flags & 0x80 != 0,
                    qst: flags & 0x40 != 0,
                    ivf: flags & 0x20 != 0,
                    alt: flags & 0x10 != 0,
                    rff: flags & 0x08 != 0,
                    progressive: flags & 0x02 != 0,
                    second: false,
                };
                self.pic = p2;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn sequence_extension(&mut self) -> Result<()> {
        let Some((w0, h0, _, _)) = self.seq_pending else { return Ok(()) };
        let pl = self.read(8) as u8;
        let progressive = self.read1() == 1;
        let chroma = self.read(2) as u8;
        let hx = self.read(2);
        let vx = self.read(2);
        self.bit += 12 + 1 + 8;
        let low_delay = self.read1() == 1;
        let rn = self.read(2) as u8;
        let rd = self.read(5) as u8;
        let w = (hx << 12) | w0;
        let h = (vx << 12) | h0;
        if w == 0 || h == 0 || w > MAX_DIM || h > MAX_DIM {
            return Err(gw_abi::err!(INVALID, "MPEG-2: invalid picture size {w}×{h}", w, h));
        }
        if chroma != 1 {
            return Err(Error::unsupported("MPEG-2 video with 4:2:2 or 4:4:4 chroma (High or 4:2:2 profile): only Main Profile 4:2:0 is decoded in the browser"));
        }
        self.mpeg2 = true;
        self.profile_level = pl;
        self.chroma_format = chroma;
        self.low_delay = low_delay;
        self.rate_ext = (rn, rd);
        let mb_w = (w as i32 + 15) >> 4;
        let mb_h = if progressive { (h as i32 + 15) >> 4 } else { ((h as i32 + 31) >> 5) << 1 };
        if !self.has_seq || w != self.width || h != self.height || mb_h != self.mb_h || progressive != self.progressive_seq {
            self.width = w;
            self.height = h;
            self.progressive_seq = progressive;
            self.mb_w = mb_w;
            self.mb_h = mb_h;
            self.luma_w = (mb_w as usize) << 4;
            self.chroma_w = (mb_w as usize) << 3;
            self.luma_h = (mb_h as usize) << 4;
            self.chroma_h = (mb_h as usize) << 3;
            let ly = self.luma_w * self.luma_h;
            let lc = self.chroma_w * self.chroma_h;
            for f in [&mut self.cur, &mut self.fwd, &mut self.bwd] {
                f.y = vec![0; ly];
                f.cb = vec![128; lc];
                f.cr = vec![128; lc];
                f.ptype = 0;
            }
            self.has_ref = false;
            self.refs = 0;
            self.field_pending = None;
            self.has_seq = true;
        }
        Ok(())
    }

    /// A first field that never got its second (a damaged stream, or the end): its frame is
    /// finished as it is.
    fn lone_field(&mut self) -> Option<Out> {
        self.field_pending.take()?;
        if self.frame_skip {
            self.frame_skip = false;
            return None;
        }
        self.finish_frame()
    }

    /// Decode one picture (bytes `[at, end)`, after its start code).
    fn picture(&mut self, at: usize, end: usize) -> Step {
        self.bit = at << 3;
        self.limit = end.min(self.buf.len());
        let tr = self.read(10) as u16;
        let ptype = self.read(3) as u8;
        self.bit += 16;
        if !(PIC_I..=PIC_B).contains(&ptype) {
            self.skipped += 1;
            return Step::None;
        }
        // Extensions and user data before the first slice.
        self.pic.structure = 0;
        let mut code = loop {
            match self.next_start_code() {
                Some(0xB5) => {
                    let p = self.bit >> 3;
                    let _ = self.extension(p, end);
                }
                Some(0xB2) => continue,
                c => break c,
            }
        };
        let resume = self.bit;
        if self.pic.structure == 0 {
            // No picture coding extension: not an MPEG-2 picture.
            self.skipped += 1;
            return Step::None;
        }
        self.pic.ptype = ptype;
        let structure = self.pic.structure;
        // Field pairing.
        let second = match (self.field_pending, structure) {
            (Some(first), s) if s != FRAME && s != first => true,
            (Some(_), _) => {
                // The pending field's partner is missing.
                return Step::Lone(self.lone_field());
            }
            _ => false,
        };
        self.pic.second = second;
        if !second {
            // A new frame: its references must have been decoded.
            let b_ok = if self.gop_closed {
                self.refs_in_gop >= 1
            } else if self.broken_link {
                self.refs_in_gop >= 2
            } else {
                self.refs >= 2
            };
            self.frame_skip = (ptype == PIC_P && self.refs < 1) || (ptype == PIC_B && !b_ok);
            if !self.frame_skip && ptype != PIC_B {
                std::mem::swap(&mut self.fwd, &mut self.bwd);
            }
            self.cur.ord = self.ord;
            self.ord += 1;
            self.cur.tr = tr;
            self.cur.ptype = ptype;
            self.cur.fields = structure != FRAME;
            self.cur.progressive = self.pic.progressive;
            self.cur.tff = if structure == FRAME { self.pic.tff } else { structure == TOP };
            self.cur.rff = self.pic.rff;
        } else if self.cur.ptype == PIC_B && ptype != PIC_B || self.cur.ptype != PIC_B && ptype == PIC_B {
            // A B field paired with a reference field: invalid; drop the frame.
            self.frame_skip = true;
        }
        if self.frame_skip {
            self.skipped += 1;
        } else {
            if structure != FRAME {
                self.field_pictures += 1;
            } else if !self.pic.fpfd || !self.pic.progressive {
                self.interlaced_frames += u32::from(!second);
            }
            self.bit = resume;
            while let Some(c @ 0x01..=0xAF) = code {
                self.slice(c);
                code = self.next_start_code();
            }
        }
        if structure != FRAME && !second {
            self.field_pending = Some(structure);
            return Step::None;
        }
        self.field_pending = None;
        if self.frame_skip {
            self.frame_skip = false;
            return Step::None;
        }
        match self.finish_frame() {
            Some(o) => Step::Out(o),
            None => Step::None,
        }
    }

    /// A frame is complete: reference bookkeeping and the frame to display, if any.
    fn finish_frame(&mut self) -> Option<Out> {
        self.decoded += 1;
        let ptype = self.cur.ptype;
        if ptype != PIC_B {
            std::mem::swap(&mut self.cur, &mut self.bwd);
            self.refs = self.refs.saturating_add(1);
            self.refs_in_gop = self.refs_in_gop.saturating_add(1);
            self.flushed = false;
            if self.has_ref {
                let f = &self.fwd;
                return Some(Out { slot: Slot::Forward, ord: f.ord, tr: f.tr, ptype: f.ptype });
            }
            self.has_ref = true;
            None
        } else {
            let f = &self.cur;
            Some(Out { slot: Slot::Current, ord: f.ord, tr: f.tr, ptype })
        }
    }

    // ---- slices and macroblocks ----

    fn reset_dc(&mut self) {
        let v = 1 << (7 + self.pic.dc_prec);
        self.dc = [v; 3];
    }

    fn set_qs(&mut self, code: u32) {
        self.qs = if self.pic.qst { NON_LINEAR_QS[code as usize & 31] as i32 } else { (code as i32 & 31) << 1 };
    }

    fn slice(&mut self, code: u8) {
        let t = tables();
        let rows = if self.pic.structure == FRAME { self.mb_h } else { self.mb_h >> 1 };
        let mut row = code as i32 - 1;
        if self.height > 2800 {
            row += (self.read(3) as i32) << 7;
        }
        if row >= rows {
            return;
        }
        let qc = self.read(5);
        self.set_qs(qc);
        if self.peek(1) == 1 {
            self.bit += 1 + 1 + 7;
            let mut n = 0;
            while self.read1() == 1 && n < 4096 {
                self.bit += 8;
                n += 1;
            }
        } else {
            self.bit += 1;
        }
        self.reset_dc();
        self.pmv = [[[0; 2]; 2]; 2];
        self.last = MbMotion::default();
        let count = rows * self.mb_w;
        let mut addr = row * self.mb_w - 1;
        let mut first = true;
        loop {
            // macroblock_address_increment (with escapes; stuffing is tolerated).
            let mut inc = 0;
            loop {
                let Some(v) = self.vlc(&t.mba) else { return };
                match v {
                    34 => {}
                    35 => inc += 33,
                    v => {
                        inc += v as i32;
                        break;
                    }
                }
                if self.overrun() || inc > count {
                    return;
                }
            }
            if first {
                first = false;
                addr += inc;
            } else {
                if addr + inc >= count {
                    return;
                }
                if inc > 1 && self.pic.ptype == PIC_I {
                    return; // skipped macroblocks in an I picture: damaged
                }
                for _ in 1..inc {
                    addr += 1;
                    self.mb_row = addr / self.mb_w;
                    self.mb_col = addr % self.mb_w;
                    self.skipped_mb();
                }
                addr += 1;
            }
            if addr < 0 || addr >= count {
                return;
            }
            self.mb_row = addr / self.mb_w;
            self.mb_col = addr % self.mb_w;
            if !self.macroblock() {
                self.errors += 1;
                return;
            }
            if self.overrun() || self.bit >= self.limit << 3 || self.peek(23) == 0 {
                return;
            }
        }
    }

    fn skipped_mb(&mut self) {
        #[cfg(test)]
        {
            self.cov[5] += 1;
        }
        self.reset_dc();
        let mut m = Mb { y: [0; 256], c: [[128; 64]; 2] };
        let field_pic = self.pic.structure != FRAME;
        let par = if field_pic { self.pic.structure - 1 } else { 0 };
        let mut mo = MbMotion { mtype: if field_pic { 1 } else { 2 }, ..Default::default() };
        if self.pic.ptype == PIC_P {
            self.pmv = [[[0; 2]; 2]; 2];
            mo.fwd = true;
            mo.fs = [[par; 2]; 2];
        } else {
            mo.fwd = self.last.fwd;
            mo.bwd = self.last.bwd;
            mo.mv[0][0] = self.pmv[0][0];
            mo.mv[0][1] = self.pmv[0][1];
            mo.fs = [[par; 2]; 2];
            if !mo.fwd && !mo.bwd {
                mo.fwd = true;
            }
        }
        self.predict(&mo, &mut m);
        self.store(&m);
    }

    fn mv_component(&mut self, f_code: u8, pred: i32) -> Option<i32> {
        let t = tables();
        let code = self.vlc(&t.motion)? as i32;
        let r = f_code.clamp(1, 9) as u32 - 1;
        let d = if r == 0 || code == 0 {
            code
        } else {
            let res = self.read(r) as i32;
            let d = ((code.abs() - 1) << r) + res + 1;
            if code < 0 {
                -d
            } else {
                d
            }
        };
        let f = 1i32 << r;
        let mut v = pred + d;
        if v > 16 * f - 1 {
            v -= 32 * f;
        } else if v < -16 * f {
            v += 32 * f;
        }
        Some(v)
    }

    fn dmvector(&mut self) -> i32 {
        if self.read1() == 0 {
            0
        } else if self.read1() == 0 {
            1
        } else {
            -1
        }
    }

    /// motion_vectors(s) for the macroblock's motion type → updates `mo` and the predictors.
    fn motion_vectors(&mut self, s: usize, mo: &mut MbMotion, concealment: bool) -> Option<()> {
        let frame_pic = self.pic.structure == FRAME;
        let (count, field_fmt, dmv) = if concealment {
            (1, !frame_pic, false)
        } else {
            match (frame_pic, mo.mtype) {
                (true, 1) => (2, true, false),
                (true, 2) => (1, false, false),
                (true, 3) => (1, true, true),
                (false, 1) => (1, true, false),
                (false, 2) => (2, true, false),
                (false, 3) => (1, true, true),
                _ => return None,
            }
        };
        let fc = self.pic.f_code[s];
        // Field vectors in frame pictures: the vertical predictor is in frame units.
        let vshift = i32::from(field_fmt && frame_pic);
        if count == 1 {
            if field_fmt && !dmv {
                mo.fs[0][s] = self.read1() as u8;
            }
            let x = self.mv_component(fc[0], self.pmv[0][s][0])?;
            if dmv {
                mo.dmv[0] = self.dmvector();
            }
            let y = self.mv_component(fc[1], self.pmv[0][s][1] >> vshift)?;
            if dmv {
                mo.dmv[1] = self.dmvector();
            }
            mo.mv[0][s] = [x, y];
            self.pmv[0][s] = [x, y << vshift];
            self.pmv[1][s] = [x, y << vshift];
        } else {
            for r in 0..2 {
                mo.fs[r][s] = self.read1() as u8;
                let x = self.mv_component(fc[0], self.pmv[r][s][0])?;
                let y = self.mv_component(fc[1], self.pmv[r][s][1] >> vshift)?;
                mo.mv[r][s] = [x, y];
                self.pmv[r][s] = [x, y << vshift];
            }
        }
        Some(())
    }

    /// One macroblock (after its address increment); false on a damaged macroblock.
    fn macroblock(&mut self) -> bool {
        let t = tables();
        let ptype = self.pic.ptype;
        let Some(ty) = self.vlc(&t.mbt[(ptype as usize).clamp(1, 3) - 1]) else { return false };
        let ty = ty as i32;
        let intra = ty & 1 != 0;
        let pattern = ty & 2 != 0;
        let mut mo = MbMotion { fwd: ty & 8 != 0, bwd: ty & 4 != 0, ..Default::default() };
        let quant = ty & 16 != 0;
        let frame_pic = self.pic.structure == FRAME;
        if mo.fwd || mo.bwd {
            mo.mtype = if frame_pic && self.pic.fpfd { 2 } else { self.read(2) as u8 };
            if mo.mtype == 0 || (mo.mtype == 3 && ptype == PIC_B) {
                return false;
            }
            #[cfg(test)]
            {
                let k = match (frame_pic, mo.mtype) {
                    (false, 1) => 0,
                    (false, 2) => 1,
                    (false, 3) => 2,
                    (true, 3) => 3,
                    (true, 1) => 4,
                    _ => 8,
                };
                if k < 8 {
                    self.cov[k] += 1;
                }
            }
        }
        let dct_field = frame_pic && !self.pic.fpfd && (intra || pattern) && self.read1() == 1;
        if quant {
            let c = self.read(5);
            self.set_qs(c);
        }
        let mut m = Mb { y: [0; 256], c: [[128; 64]; 2] };
        if intra {
            if self.pic.cmv {
                #[cfg(test)]
                {
                    self.cov[6] += 1;
                }
                let mut c = MbMotion::default();
                if self.motion_vectors(0, &mut c, true).is_none() {
                    return false;
                }
                self.bit += 1; // marker bit
            } else {
                self.pmv = [[[0; 2]; 2]; 2];
            }
            self.last = MbMotion::default();
        } else {
            self.reset_dc();
            let field_pic = !frame_pic;
            if ptype == PIC_P && !mo.fwd {
                // "No MC": zero vector from the same-parity field / the frame; predictors reset.
                self.pmv = [[[0; 2]; 2]; 2];
                mo.fwd = true;
                mo.mtype = if field_pic { 1 } else { 2 };
                let par = if field_pic { self.pic.structure - 1 } else { 0 };
                mo.fs = [[par; 2]; 2];
            } else {
                if mo.fwd && self.motion_vectors(0, &mut mo, false).is_none() {
                    return false;
                }
                if mo.bwd && self.motion_vectors(1, &mut mo, false).is_none() {
                    return false;
                }
            }
            self.last = mo;
            self.predict(&mo, &mut m);
        }
        let cbp = if pattern {
            match self.vlc(&t.cbp) {
                Some(v) => v as i32,
                None => return false,
            }
        } else if intra {
            0x3f
        } else {
            0
        };
        for b in 0..6 {
            if cbp & (0x20 >> b) != 0 {
                if !self.block(b, intra) {
                    return false;
                }
                self.place(b, intra, dct_field, &mut m);
            }
        }
        self.store(&m);
        !self.overrun()
    }

    /// Decode block b's coefficients into `self.block` (dequantised, natural order, mismatch
    /// controlled) and run the IDCT.
    fn block(&mut self, b: usize, intra: bool) -> bool {
        let t = tables();
        let scan = if self.pic.alt { &ALT_SCAN } else { &ZIG_ZAG };
        let chroma = b > 3;
        let w = &self.q[if intra { 0 } else { 1 } + if chroma { 2 } else { 0 }];
        let w = *w;
        let qs = self.qs;
        let mut parity = 0i32;
        let mut i;
        if intra {
            let comp = if b < 4 { 0 } else { b - 3 };
            let Some(size) = self.vlc(if chroma { &t.dc_c } else { &t.dc_l }) else { return false };
            let size = size as u32;
            let diff = if size == 0 {
                0
            } else {
                let d = self.read(size) as i32;
                if d & (1 << (size - 1)) != 0 {
                    d
                } else {
                    d - (1 << size) + 1
                }
            };
            let dc = self.dc[comp] + diff;
            self.dc[comp] = dc;
            let v = dc << (3 - self.pic.dc_prec.min(3));
            self.block[0] = v;
            parity ^= v;
            i = 1;
        } else {
            i = 0;
        }
        let table = if intra && self.pic.ivf { &t.dct_b15 } else if intra { &t.dct_next } else { &t.dct_first };
        let mut tab = table;
        loop {
            let e = tab.get(self.peek(32));
            if e.len == 0 {
                return false;
            }
            self.bit += e.len as usize;
            let (run, level) = match e.val {
                EOB => break,
                ESC => {
                    #[cfg(test)]
                    {
                        self.cov[7] += 1;
                    }
                    let run = self.read(6) as usize;
                    let l = self.read(12) as i32;
                    let l = if l & 0x800 != 0 { l - 4096 } else { l };
                    if l == 0 {
                        return false;
                    }
                    (run, l)
                }
                v => {
                    let l = (v & 0xff) as i32;
                    let s = self.read1();
                    ((v >> 8) as usize, if s == 1 { -l } else { l })
                }
            };
            if !intra {
                tab = &t.dct_next;
            }
            i += run;
            if i > 63 {
                return false;
            }
            let pos = scan[i] as usize;
            i += 1;
            let a = level.abs();
            let mut v = if intra { (a * qs * w[pos] as i32) >> 4 } else { ((2 * a + 1) * qs * w[pos] as i32) >> 5 };
            if level < 0 {
                v = -v;
            }
            let v = v.clamp(-2048, 2047);
            self.block[pos] = v;
            parity ^= v;
            if self.overrun() {
                return false;
            }
        }
        if parity & 1 == 0 {
            self.block[63] ^= 1;
        }
        simple_idct(&mut self.block);
        true
    }

    /// Add (or, intra, put) the IDCT output of block b into the macroblock.
    fn place(&mut self, b: usize, intra: bool, dct_field: bool, m: &mut Mb) {
        let s = &mut self.block;
        let (dst, stride, off, step): (&mut [u8], usize, usize, usize) = if b < 4 {
            let col = (b & 1) * 8;
            if dct_field {
                (&mut m.y[..], 16, (b >> 1) * 16 + col, 32)
            } else {
                (&mut m.y[..], 16, (b >> 1) * 128 + col, 16)
            }
        } else {
            (&mut m.c[b - 4][..], 8, 0, 8)
        };
        let _ = stride;
        for y in 0..8 {
            let r = &mut dst[off + y * step..off + y * step + 8];
            for (x, p) in r.iter_mut().enumerate() {
                let v = s[y * 8 + x];
                *p = if intra { clamp(v) } else { clamp(*p as i32 + v) };
            }
        }
        *s = [0; 64];
    }

    /// Write the macroblock into the current frame (frame lines, or one field's lines).
    fn store(&mut self, m: &Mb) {
        let (lw, cw) = (self.luma_w, self.chroma_w);
        let (row, col) = (self.mb_row as usize, self.mb_col as usize);
        let (y0, c0, lstep, cstep) = match self.pic.structure {
            FRAME => (row * 16 * lw + col * 16, row * 8 * cw + col * 8, lw, cw),
            s => {
                let p = (s - 1) as usize;
                ((row * 32 + p) * lw + col * 16, (row * 16 + p) * cw + col * 8, 2 * lw, 2 * cw)
            }
        };
        let f = &mut self.cur;
        if y0 + 15 * lstep + 16 > f.y.len() || c0 + 7 * cstep + 8 > f.cb.len() {
            return;
        }
        for r in 0..16 {
            f.y[y0 + r * lstep..y0 + r * lstep + 16].copy_from_slice(&m.y[r * 16..r * 16 + 16]);
        }
        for r in 0..8 {
            f.cb[c0 + r * cstep..c0 + r * cstep + 8].copy_from_slice(&m.c[0][r * 8..r * 8 + 8]);
            f.cr[c0 + r * cstep..c0 + r * cstep + 8].copy_from_slice(&m.c[1][r * 8..r * 8 + 8]);
        }
    }

    /// The reference frame for direction `dir` (0 forward, 1 backward) and field select `fs`:
    /// the second field of a P frame predicts its opposite-parity field from the first field of
    /// the same frame.
    fn reference(&self, dir: usize, fs: u8) -> &Frame {
        if dir == 1 {
            return &self.bwd;
        }
        let p = &self.pic;
        if p.structure != FRAME && p.second && p.ptype == PIC_P && fs + 1 != p.structure {
            return &self.cur;
        }
        &self.fwd
    }

    /// Motion-compensated prediction of the macroblock into `m`.
    fn predict(&self, mo: &MbMotion, m: &mut Mb) {
        let g = Geo { lw: self.luma_w, cw: self.chroma_w, lh: self.luma_h as i32, ch: self.chroma_h as i32, mx: self.mb_col, my: self.mb_row };
        let frame_pic = self.pic.structure == FRAME;
        let mut avg = false;
        for dir in 0..2 {
            if !(if dir == 0 { mo.fwd } else { mo.bwd }) {
                continue;
            }
            let mv = &mo.mv;
            match (frame_pic, mo.mtype) {
                (true, 2) => {
                    let r = self.reference(dir, 0);
                    mc_block(&g, r, m, View::Frame, mv[0][dir], 0, 16, 0, 1, avg);
                }
                (true, 1) => {
                    for d in 0..2 {
                        let r = self.reference(dir, mo.fs[d][dir]);
                        mc_block(&g, r, m, View::Field(mo.fs[d][dir]), mv[d][dir], 0, 8, d, 2, avg);
                    }
                }
                (true, 3) => {
                    // Dual prime in a frame picture: each field from its own parity, averaged
                    // with the derived vector from the opposite parity.
                    let [x, y] = mv[0][0];
                    let mm = if self.pic.tff { 1 } else { 3 };
                    let r = &self.fwd;
                    let v_tb = [((x * mm + i32::from(x > 0)) >> 1) + mo.dmv[0], ((y * mm + i32::from(y > 0)) >> 1) + mo.dmv[1] - 1];
                    let mm = 4 - mm;
                    let v_bt = [((x * mm + i32::from(x > 0)) >> 1) + mo.dmv[0], ((y * mm + i32::from(y > 0)) >> 1) + mo.dmv[1] + 1];
                    mc_block(&g, r, m, View::Field(0), [x, y], 0, 8, 0, 2, false);
                    mc_block(&g, r, m, View::Field(1), [x, y], 0, 8, 1, 2, false);
                    mc_block(&g, r, m, View::Field(1), v_tb, 0, 8, 0, 2, true);
                    mc_block(&g, r, m, View::Field(0), v_bt, 0, 8, 1, 2, true);
                }
                (false, 1) => {
                    let r = self.reference(dir, mo.fs[0][dir]);
                    mc_block(&g, r, m, View::Field(mo.fs[0][dir]), mv[0][dir], 0, 16, 0, 1, avg);
                }
                (false, 2) => {
                    for k in 0..2 {
                        let r = self.reference(dir, mo.fs[k][dir]);
                        mc_block(&g, r, m, View::Field(mo.fs[k][dir]), mv[k][dir], 8 * k as i32, 8, 8 * k, 1, avg);
                    }
                }
                (false, 3) => {
                    let par = self.pic.structure - 1;
                    let [x, y] = mv[0][0];
                    let opp = [((x + i32::from(x > 0)) >> 1) + mo.dmv[0], ((y + i32::from(y > 0)) >> 1) + mo.dmv[1] + if par == 0 { -1 } else { 1 }];
                    let same = self.reference(0, par);
                    mc_block(&g, same, m, View::Field(par), [x, y], 0, 16, 0, 1, false);
                    let other = self.reference(0, 1 - par);
                    mc_block(&g, other, m, View::Field(1 - par), opp, 0, 16, 0, 1, true);
                }
                _ => {}
            }
            avg = true;
        }
    }

    /// The frame in `slot` as packed I420 (Y, then Cb, then Cr; width × height luma and
    /// ⌈width/2⌉ × ⌈height/2⌉ chroma), for the browser to convert (WebCodecs VideoFrame).
    pub fn i420(&self, slot: Slot, out: &mut Vec<u8>) {
        let f = self.frame(slot);
        let (w, h) = (self.width as usize, self.height as usize);
        let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
        out.clear();
        if f.y.len() < self.luma_w * h || f.cb.len() < self.chroma_w * ch {
            out.resize(w * h + 2 * cw * ch, 128);
            return;
        }
        out.reserve(w * h + 2 * cw * ch);
        for r in 0..h {
            out.extend_from_slice(&f.y[r * self.luma_w..r * self.luma_w + w]);
        }
        for p in [&f.cb, &f.cr] {
            for r in 0..ch {
                out.extend_from_slice(&p[r * self.chroma_w..r * self.chroma_w + cw]);
            }
        }
    }

    /// The frame in `slot` as RGBA (BT.601 studio range, the same integer arithmetic as the
    /// MPEG-1 decoder), width × height. The chroma terms are computed once per chroma row and
    /// pixel pair; the rows run four pixels at a time in SIMD128 on wasm32.
    pub fn rgba(&self, slot: Slot, out: &mut Vec<u8>) {
        let f = self.frame(slot);
        let (w, h) = (self.width as usize, self.height as usize);
        out.clear();
        out.resize(w * h * 4, 255);
        let (yw, cw) = (self.luma_w, self.chroma_w);
        if f.y.len() < yw * h || f.cb.len() < cw * h.div_ceil(2) || cw * 2 < w {
            return;
        }
        let mut cr_r = vec![0i32; w];
        let mut c_g = vec![0i32; w];
        let mut cb_b = vec![0i32; w];
        for row in 0..h {
            if row & 1 == 0 {
                let cbr = &f.cb[(row >> 1) * cw..(row >> 1) * cw + cw];
                let crr = &f.cr[(row >> 1) * cw..(row >> 1) * cw + cw];
                for x in 0..w {
                    let cr = crr[x >> 1] as i32 - 128;
                    let cb = cbr[x >> 1] as i32 - 128;
                    cr_r[x] = (cr * 104597) >> 16;
                    c_g[x] = (cb * 25674 + cr * 53278) >> 16;
                    cb_b[x] = (cb * 132201) >> 16;
                }
            }
            rgba_row(&f.y[row * yw..row * yw + w], &cr_r, &c_g, &cb_b, &mut out[row * w * 4..(row + 1) * w * 4]);
        }
    }
}

/// One row of RGBA from luma and per-pixel chroma terms (`r`, `g`, `b` at least as long as `y`;
/// `o` four bytes per pixel).
fn rgba_row(y: &[u8], r: &[i32], g: &[i32], b: &[i32], o: &mut [u8]) {
    let n = y.len().min(r.len()).min(g.len()).min(b.len()).min(o.len() / 4);
    #[allow(unused_mut)]
    let mut x = 0;
    #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
    // SAFETY: every load and store is within `y[..n]`, `r/g/b[..n]` and `o[..4n]` (x + 4 <= n).
    unsafe {
        use core::arch::wasm32::*;
        let c16 = i32x4_splat(16);
        let cm = i32x4_splat(76309);
        let zero = i32x4_splat(0);
        let max = i32x4_splat(255);
        let alpha = i32x4_splat(0xFF00_0000u32 as i32);
        while x + 4 <= n {
            let y8 = v128_load32_zero(y.as_ptr().add(x) as *const u32);
            let yv = u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(y8));
            let yy = i32x4_shr(i32x4_mul(i32x4_sub(yv, c16), cm), 16);
            let rr = v128_load(r.as_ptr().add(x) as *const v128);
            let gg = v128_load(g.as_ptr().add(x) as *const v128);
            let bb = v128_load(b.as_ptr().add(x) as *const v128);
            let cr = i32x4_min(i32x4_max(i32x4_add(yy, rr), zero), max);
            let cg = i32x4_min(i32x4_max(i32x4_sub(yy, gg), zero), max);
            let cb = i32x4_min(i32x4_max(i32x4_add(yy, bb), zero), max);
            let px = v128_or(v128_or(cr, i32x4_shl(cg, 8)), v128_or(i32x4_shl(cb, 16), alpha));
            v128_store(o.as_mut_ptr().add(x * 4) as *mut v128, px);
            x += 4;
        }
    }
    while x < n {
        let yv = ((y[x] as i32 - 16) * 76309) >> 16;
        o[x * 4] = clamp(yv + r[x]);
        o[x * 4 + 1] = clamp(yv - g[x]);
        o[x * 4 + 2] = clamp(yv + b[x]);
        o[x * 4 + 3] = 255;
        x += 1;
    }
}

enum Step {
    None,
    Out(Out),
    /// A first field was left without its second; the current picture is decoded again.
    Lone(Option<Out>),
}

#[inline(always)]
fn clamp(n: i32) -> u8 {
    n.clamp(0, 255) as u8
}

struct Geo {
    lw: usize,
    cw: usize,
    lh: i32,
    ch: i32,
    mx: i32,
    my: i32,
}

#[derive(Clone, Copy)]
enum View {
    Frame,
    Field(u8),
}

/// Predict a luma `16 × bh` block (and its chroma) of the macroblock from reference `r`.
/// `y_off` is the vertical offset in the view of the block within the macroblock (16×8 lower
/// half), `d_row0`/`d_step` place its lines in the macroblock buffer (field lines of a frame MB).
#[allow(clippy::too_many_arguments)]
fn mc_block(g: &Geo, r: &Frame, m: &mut Mb, view: View, mv: [i32; 2], y_off: i32, bh: i32, d_row0: usize, d_step: usize, avg: bool) {
    let (fs, pitch_mul, vh_div, base_y_mul) = match view {
        View::Frame => (0usize, 1usize, 1i32, 16),
        View::Field(p) => (p as usize, 2, 2, if bh == 8 && d_step == 2 { 8 } else { 16 }),
    };
    // Luma.
    let [vx, vy] = mv;
    let lx = g.mx * 16 * 2 + vx;
    let ly = (g.my * base_y_mul + y_off) * 2 + vy;
    mc(&r.y, fs * g.lw, g.lw * pitch_mul, g.lw as i32, g.lh / vh_div, lx, ly, 16, bh, &mut m.y, 16, d_row0, d_step, avg);
    // Chroma (4:2:0): vectors halved toward zero.
    let (cx, cy) = (vx / 2, vy / 2);
    let lx = g.mx * 8 * 2 + cx;
    let ly = (g.my * base_y_mul / 2 + y_off / 2) * 2 + cy;
    let (c0, c1) = m.c.split_at_mut(1);
    let crow0 = if d_step == 2 { d_row0 } else { d_row0 / 2 };
    mc(&r.cb, fs * g.cw, g.cw * pitch_mul, g.cw as i32, g.ch / vh_div, lx, ly, 8, bh / 2, &mut c0[0], 8, crow0, d_step, avg);
    mc(&r.cr, fs * g.cw, g.cw * pitch_mul, g.cw as i32, g.ch / vh_div, lx, ly, 8, bh / 2, &mut c1[0], 8, crow0, d_step, avg);
}

/// Half-pel prediction of a `bw × bh` block at half-pel position (hx2, hy2) of a view (`base`,
/// `pitch`, `vw × vh`) of `src` into `dst` (rows `row0 + k × step`); positions outside the view
/// repeat its edge pixels.
#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn mc(src: &[u8], base: usize, pitch: usize, vw: i32, vh: i32, hx2: i32, hy2: i32, bw: i32, bh: i32, dst: &mut [u8], dstride: usize, row0: usize, step: usize, avg: bool) {
    let (x0, y0) = (hx2 >> 1, hy2 >> 1);
    let (fx, fy) = (hx2 & 1 != 0, hy2 & 1 != 0);
    let inside = x0 >= 0 && y0 >= 0 && x0 + bw + i32::from(fx) <= vw && y0 + bh + i32::from(fy) <= vh;
    let last = base as i64 + (vh as i64 - 1) * pitch as i64 + vw as i64;
    if vh <= 0 || vw <= 0 || last > src.len() as i64 || bh <= 0 || row0 + (bh as usize - 1) * step >= dst.len() / dstride {
        return;
    }
    if inside {
        let si = base + y0 as usize * pitch + x0 as usize;
        match (fx, fy, avg) {
            (false, false, false) => run::<false, false, false>(src, si, pitch, bw, bh, dst, dstride, row0, step),
            (true, false, false) => run::<true, false, false>(src, si, pitch, bw, bh, dst, dstride, row0, step),
            (false, true, false) => run::<false, true, false>(src, si, pitch, bw, bh, dst, dstride, row0, step),
            (true, true, false) => run::<true, true, false>(src, si, pitch, bw, bh, dst, dstride, row0, step),
            (false, false, true) => run::<false, false, true>(src, si, pitch, bw, bh, dst, dstride, row0, step),
            (true, false, true) => run::<true, false, true>(src, si, pitch, bw, bh, dst, dstride, row0, step),
            (false, true, true) => run::<false, true, true>(src, si, pitch, bw, bh, dst, dstride, row0, step),
            (true, true, true) => run::<true, true, true>(src, si, pitch, bw, bh, dst, dstride, row0, step),
        }
        return;
    }
    // Edge emulation.
    let px = |x: i32, y: i32| -> u32 { src[base + y.clamp(0, vh - 1) as usize * pitch + x.clamp(0, vw - 1) as usize] as u32 };
    for r in 0..bh {
        let d = (row0 + r as usize * step) * dstride;
        for c in 0..bw {
            let (x, y) = (x0 + c, y0 + r);
            let p = match (fx, fy) {
                (false, false) => px(x, y),
                (true, false) => (px(x, y) + px(x + 1, y) + 1) >> 1,
                (false, true) => (px(x, y) + px(x, y + 1) + 1) >> 1,
                (true, true) => (px(x, y) + px(x + 1, y) + px(x, y + 1) + px(x + 1, y + 1) + 2) >> 2,
            };
            let o = &mut dst[d + c as usize];
            *o = if avg { ((*o as u32 + p + 1) >> 1) as u8 } else { p as u8 };
        }
    }
}

#[allow(clippy::too_many_arguments)]
#[inline(always)]
fn run<const FX: bool, const FY: bool, const AVG: bool>(src: &[u8], si: usize, pitch: usize, bw: i32, bh: i32, dst: &mut [u8], dstride: usize, row0: usize, step: usize) {
    let bw = bw as usize;
    for r in 0..bh as usize {
        let s = si + r * pitch;
        let d = (row0 + r * step) * dstride;
        let a = &src[s..s + bw + 1 - usize::from(!FX)];
        let b = if FY { &src[s + pitch..s + pitch + bw + 1 - usize::from(!FX)] } else { a };
        let o = &mut dst[d..d + bw];
        for c in 0..bw {
            let p = match (FX, FY) {
                (false, false) => a[c] as u32,
                (true, false) => (a[c] as u32 + a[c + 1] as u32 + 1) >> 1,
                (false, true) => (a[c] as u32 + b[c] as u32 + 1) >> 1,
                (true, true) => (a[c] as u32 + a[c + 1] as u32 + b[c] as u32 + b[c + 1] as u32 + 2) >> 2,
            };
            o[c] = if AVG { ((o[c] as u32 + p + 1) >> 1) as u8 } else { p as u8 };
        }
    }
}

// ---- IDCT ----

const W1: i32 = 22725;
const W2: i32 = 21407;
const W3: i32 = 19266;
const W4: i32 = 16383;
const W5: i32 = 12873;
const W6: i32 = 8867;
const W7: i32 = 4520;
const ROW_SHIFT: u32 = 11;
const COL_SHIFT: u32 = 20;

/// The integer "simple IDCT" arithmetic (8-bit, FFmpeg `simple_idct_template.c`): rows with a
/// DC-only shortcut, then columns; outputs are the residual (put clips, add adds then clips).
pub fn simple_idct(b: &mut [i32; 64]) {
    for r in 0..8 {
        let row = &mut b[r * 8..r * 8 + 8];
        if row[1..].iter().all(|&v| v == 0) {
            // The shortcut keeps 16 bits, as the reference does.
            let v = ((row[0] << 3) as i16) as i32;
            row.fill(v);
            continue;
        }
        let mut a0 = W4.wrapping_mul(row[0]).wrapping_add(1 << (ROW_SHIFT - 1));
        let mut a1 = a0;
        let mut a2 = a0;
        let mut a3 = a0;
        a0 = a0.wrapping_add(W2.wrapping_mul(row[2]));
        a1 = a1.wrapping_add(W6.wrapping_mul(row[2]));
        a2 = a2.wrapping_sub(W6.wrapping_mul(row[2]));
        a3 = a3.wrapping_sub(W2.wrapping_mul(row[2]));
        let mut b0 = W1.wrapping_mul(row[1]).wrapping_add(W3.wrapping_mul(row[3]));
        let mut b1 = W3.wrapping_mul(row[1]).wrapping_sub(W7.wrapping_mul(row[3]));
        let mut b2 = W5.wrapping_mul(row[1]).wrapping_sub(W1.wrapping_mul(row[3]));
        let mut b3 = W7.wrapping_mul(row[1]).wrapping_sub(W5.wrapping_mul(row[3]));
        if row[4] | row[5] | row[6] | row[7] != 0 {
            a0 = a0.wrapping_add(W4.wrapping_mul(row[4])).wrapping_add(W6.wrapping_mul(row[6]));
            a1 = a1.wrapping_sub(W4.wrapping_mul(row[4])).wrapping_sub(W2.wrapping_mul(row[6]));
            a2 = a2.wrapping_sub(W4.wrapping_mul(row[4])).wrapping_add(W2.wrapping_mul(row[6]));
            a3 = a3.wrapping_add(W4.wrapping_mul(row[4])).wrapping_sub(W6.wrapping_mul(row[6]));
            b0 = b0.wrapping_add(W5.wrapping_mul(row[5])).wrapping_add(W7.wrapping_mul(row[7]));
            b1 = b1.wrapping_sub(W1.wrapping_mul(row[5])).wrapping_sub(W5.wrapping_mul(row[7]));
            b2 = b2.wrapping_add(W7.wrapping_mul(row[5])).wrapping_add(W3.wrapping_mul(row[7]));
            b3 = b3.wrapping_add(W3.wrapping_mul(row[5])).wrapping_sub(W1.wrapping_mul(row[7]));
        }
        // Row outputs are stored as 16-bit in the reference.
        let s = |v: i32| ((v >> ROW_SHIFT) as i16) as i32;
        row[0] = s(a0.wrapping_add(b0));
        row[7] = s(a0.wrapping_sub(b0));
        row[1] = s(a1.wrapping_add(b1));
        row[6] = s(a1.wrapping_sub(b1));
        row[2] = s(a2.wrapping_add(b2));
        row[5] = s(a2.wrapping_sub(b2));
        row[3] = s(a3.wrapping_add(b3));
        row[4] = s(a3.wrapping_sub(b3));
    }
    for c in 0..8 {
        let col = |k: usize| b[k * 8 + c];
        let mut a0 = W4.wrapping_mul(col(0) + ((1 << (COL_SHIFT - 1)) / W4));
        let mut a1 = a0;
        let mut a2 = a0;
        let mut a3 = a0;
        a0 = a0.wrapping_add(W2.wrapping_mul(col(2)));
        a1 = a1.wrapping_add(W6.wrapping_mul(col(2)));
        a2 = a2.wrapping_sub(W6.wrapping_mul(col(2)));
        a3 = a3.wrapping_sub(W2.wrapping_mul(col(2)));
        let mut b0 = W1.wrapping_mul(col(1)).wrapping_add(W3.wrapping_mul(col(3)));
        let mut b1 = W3.wrapping_mul(col(1)).wrapping_sub(W7.wrapping_mul(col(3)));
        let mut b2 = W5.wrapping_mul(col(1)).wrapping_sub(W1.wrapping_mul(col(3)));
        let mut b3 = W7.wrapping_mul(col(1)).wrapping_sub(W5.wrapping_mul(col(3)));
        a0 = a0.wrapping_add(W4.wrapping_mul(col(4)));
        a1 = a1.wrapping_sub(W4.wrapping_mul(col(4)));
        a2 = a2.wrapping_sub(W4.wrapping_mul(col(4)));
        a3 = a3.wrapping_add(W4.wrapping_mul(col(4)));
        b0 = b0.wrapping_add(W5.wrapping_mul(col(5)));
        b1 = b1.wrapping_sub(W1.wrapping_mul(col(5)));
        b2 = b2.wrapping_add(W7.wrapping_mul(col(5)));
        b3 = b3.wrapping_add(W3.wrapping_mul(col(5)));
        a0 = a0.wrapping_add(W6.wrapping_mul(col(6)));
        a1 = a1.wrapping_sub(W2.wrapping_mul(col(6)));
        a2 = a2.wrapping_add(W2.wrapping_mul(col(6)));
        a3 = a3.wrapping_sub(W6.wrapping_mul(col(6)));
        b0 = b0.wrapping_add(W7.wrapping_mul(col(7)));
        b1 = b1.wrapping_sub(W5.wrapping_mul(col(7)));
        b2 = b2.wrapping_add(W3.wrapping_mul(col(7)));
        b3 = b3.wrapping_sub(W1.wrapping_mul(col(7)));
        b[c] = a0.wrapping_add(b0) >> COL_SHIFT;
        b[8 + c] = a1.wrapping_add(b1) >> COL_SHIFT;
        b[16 + c] = a2.wrapping_add(b2) >> COL_SHIFT;
        b[24 + c] = a3.wrapping_add(b3) >> COL_SHIFT;
        b[32 + c] = a3.wrapping_sub(b3) >> COL_SHIFT;
        b[40 + c] = a2.wrapping_sub(b2) >> COL_SHIFT;
        b[48 + c] = a1.wrapping_sub(b1) >> COL_SHIFT;
        b[56 + c] = a0.wrapping_sub(b0) >> COL_SHIFT;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Share of the code space used (a signed pair's two codes together take 2^-n).
    fn kraft(codes: &[(u32, u8, i16)]) -> f64 {
        codes.iter().map(|&(_, n, _)| 0.5f64.powi(n as i32)).sum()
    }

    fn prefix_free(codes: &[(u32, u8, i16)]) {
        for (i, &(a, n, _)) in codes.iter().enumerate() {
            for &(b, m, _) in &codes[i + 1..] {
                let k = n.min(m);
                assert_ne!(a >> (n - k), b >> (m - k), "codes {a:0n$b}/{n} and {b:0m$b}/{m} share a prefix", n = n as usize, m = m as usize);
            }
        }
    }

    #[test]
    fn b15_is_a_complete_prefix_code_and_shares_long_codes_with_b14() {
        let mut b15: Vec<_> = B15.iter().map(|&(c, n, r, l)| (c as u32, n, ((r as i16) << 8) | l as i16)).collect();
        b15.extend([(0b0110, 4, EOB), (0b000001, 6, ESC)]);
        prefix_free(&b15);
        // Escape is followed by 18 fixed bits; EOB has no sign; the rest one sign bit. The
        // codes of B-15 leave '0000 0000 0000' (forbidden) unassigned as B-14 does.
        let k = kraft(&b15);
        let b14: Vec<_> = tree_codes(&DCT_COEFF).into_iter().filter(|&(c, n, _)| !(n == 1 && c == 1)).chain([(0b10, 2, EOB), (0b11, 2, 1)]).collect();
        let k14 = kraft(&b14);
        // B-14 leaves only the forbidden '0000 0000 0000' prefix (2^-12) unused. B-15 also leaves
        // the slots of the pairs it moved to short codes: six 12-bit ((0,8)..(0,11), (1,5), (2,4))
        // and four 13-bit ((0,12)..(0,15)) codes with their sign bit, 8 × 2^-12 in all.
        assert_eq!(k14, 1.0 - 0.5f64.powi(12), "B-14 Kraft");
        assert_eq!(k, k14 - 8.0 * 0.5f64.powi(12), "B-15 Kraft");
        // Every B-15 code of 12 bits or more (sign excluded) is the B-14 code of the same pair.
        for &(c, n, v) in &b15 {
            if n >= 12 && v >= 0 {
                assert!(b14.iter().any(|&(c2, n2, v2)| c2 == c && n2 == n && v2 == v), "B-15 code {c:0n$b} ({}, {})", v >> 8, v & 255, n = n as usize);
            }
        }
        // All 111 (run, level) pairs of B-14 are in B-15.
        for &(_, _, v) in b14.iter().filter(|e| e.2 >= 0) {
            assert!(b15.iter().any(|e| e.2 == v), "({}, {}) missing", v >> 8, v & 255);
        }
    }

    #[test]
    fn dc_size_tables() {
        let t = tables();
        for (bits, n, size) in [(0b100u32, 3u32, 0i16), (0b00, 2, 1), (0b1111_1110, 8, 9), (0b1_1111_1110, 9, 10), (0b1_1111_1111, 9, 11)] {
            let e = t.dc_l.get(bits << (32 - n));
            assert_eq!((e.len as u32, e.val), (n, size), "luma {bits:b}");
        }
        for (bits, n, size) in [(0b00u32, 2u32, 0i16), (0b1111_1110, 8, 8), (0b1_1111_1110, 9, 9), (0b11_1111_1110, 10, 10), (0b11_1111_1111, 10, 11)] {
            let e = t.dc_c.get(bits << (32 - n));
            assert_eq!((e.len as u32, e.val), (n, size), "chroma {bits:b}");
        }
    }

    #[test]
    fn scans_are_permutations() {
        let mut a = ALT_SCAN.to_vec();
        a.sort();
        assert_eq!(a, (0..64).collect::<Vec<u8>>());
    }

    #[test]
    fn idct_dc_and_basis() {
        let mut b = [0i32; 64];
        b[0] = 1024; // 1024 / 8 = 128 per pixel
        simple_idct(&mut b);
        assert!(b.iter().all(|&v| v == 128), "{b:?}");
        // Against a double-precision IDCT on a pseudo-random block (IEEE 1180-style range).
        let mut seed = 12345u32;
        let mut worst = 0f64;
        for _ in 0..2000 {
            let mut c = [0i32; 64];
            for v in c.iter_mut() {
                seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
                *v = ((seed >> 16) % 512) as i32 - 256;
            }
            let mut f = [0f64; 64];
            for y in 0..8 {
                for x in 0..8 {
                    let mut s = 0.0;
                    for v in 0..8 {
                        for u in 0..8 {
                            let cu = if u == 0 { std::f64::consts::FRAC_1_SQRT_2 } else { 1.0 };
                            let cv = if v == 0 { std::f64::consts::FRAC_1_SQRT_2 } else { 1.0 };
                            s += cu * cv * c[v * 8 + u] as f64 * (((2 * x + 1) as f64 * u as f64 * std::f64::consts::PI) / 16.0).cos() * (((2 * y + 1) as f64 * v as f64 * std::f64::consts::PI) / 16.0).cos();
                        }
                    }
                    f[y * 8 + x] = s / 4.0;
                }
            }
            simple_idct(&mut c);
            for k in 0..64 {
                worst = worst.max((c[k] as f64 - f[k]).abs());
            }
        }
        assert!(worst <= 1.5, "worst IDCT error {worst}");
    }

    #[test]
    fn garbage_never_panics() {
        let mut seed = 99u32;
        for trial in 0..40 {
            let mut d = Decoder::new();
            // 720×576 interlaced MP@ML sequence header + sequence extension.
            let mut v = vec![0, 0, 1, 0xB3, 0x2D, 0x02, 0x40, 0x33, 0xFF, 0xFF, 0xE0, 0x18];
            v.extend([0, 0, 1, 0xB5, 0x14, 0x82, 0x00, 0x01, 0x00, 0x00]);
            for k in 0..12u32 {
                let pt = (k % 3) + 1;
                v.extend([0, 0, 1, 0x00, (k >> 2) as u8, ((k as u8 & 3) << 6) | ((pt as u8) << 3), 0xFF, 0xFF, 0xF8]);
                // Picture coding extension: f_codes 2, structure by trial, alternate scan etc.
                let st = [3u8, 1, 2][(trial + k as usize) % 3];
                v.extend([0, 0, 1, 0xB5, 0x82, 0x22, 0x10 | st, (trial as u8) ^ 0x5A, 0x80]);
                for s in 1..=4u8 {
                    v.extend([0, 0, 1, s]);
                    for _ in 0..600 {
                        seed = seed.wrapping_mul(2654435761).wrapping_add(7);
                        v.push((seed >> 24) as u8);
                    }
                }
            }
            d.push(&v);
            d.end();
            let mut out = Vec::new();
            let mut n = 0;
            while let Ok(Some(o)) = d.decode() {
                d.rgba(o.slot, &mut out);
                assert_eq!(out.len(), 720 * 576 * 4);
                n += 1;
                assert!(n < 100);
            }
            assert_eq!((d.width, d.height), (720, 576));
        }
    }
}

/// Field pictures, 16×8 and dual-prime prediction, concealment vectors and B field pairs: FFmpeg's
/// MPEG-2 encoder writes none of these, so this test-only generator writes a stream that uses
/// them (random but valid syntax over a 720×576 interlaced sequence) and FFmpeg's decoder is the
/// oracle. Run with `GW_FFMPEG` = ffmpeg executable and `GW_MPEG2_GEN` = an output folder.
#[cfg(test)]
mod fieldgen {
    use super::*;
    use std::collections::HashMap;

    struct Bw {
        v: Vec<u8>,
        acc: u64,
        n: u32,
    }

    impl Bw {
        fn put(&mut self, bits: u32, n: u32) {
            for k in (0..n).rev() {
                self.acc = (self.acc << 1) | ((bits >> k) & 1) as u64;
                self.n += 1;
                if self.n == 8 {
                    self.v.push(self.acc as u8);
                    self.acc = 0;
                    self.n = 0;
                }
            }
        }
        fn start(&mut self, code: u8) {
            while self.n != 0 {
                self.put(0, 1);
            }
            self.v.extend([0, 0, 1, code]);
        }
    }

    struct Rng(u32);
    impl Rng {
        fn next(&mut self) -> u32 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 17;
            self.0 ^= self.0 << 5;
            self.0
        }
        fn range(&mut self, lo: i32, hi: i32) -> i32 {
            lo + (self.next() % (hi - lo + 1) as u32) as i32
        }
        fn chance(&mut self, pct: u32) -> bool {
            self.next() % 100 < pct
        }
    }

    type Map = HashMap<i16, (u32, u8)>;

    fn map(codes: Vec<(u32, u8, i16)>) -> Map {
        codes.into_iter().map(|(c, n, v)| (v, (c, n))).collect()
    }

    struct Codes {
        mba: Map,
        mbt: [Map; 3],
        cbp: Map,
        motion: Map,
        dc_l: Map,
        dc_c: Map,
        b14: Map,
        b15: Map,
    }

    fn codes() -> Codes {
        let mut dc_l = tree_codes(&DCT_SIZE_LUMINANCE);
        dc_l.extend([(0xfe, 8, 9), (0x1fe, 9, 10), (0x1ff, 9, 11)]);
        let mut dc_c = tree_codes(&DCT_SIZE_CHROMINANCE);
        dc_c.extend([(0x1fe, 9, 9), (0x3fe, 10, 10), (0x3ff, 10, 11)]);
        Codes {
            mba: map(tree_codes(&MACROBLOCK_ADDRESS_INCREMENT)),
            mbt: [map(tree_codes(&MACROBLOCK_TYPE_INTRA)), map(tree_codes(&MACROBLOCK_TYPE_PREDICTIVE)), map(tree_codes(&MACROBLOCK_TYPE_B))],
            cbp: map(tree_codes(&CODE_BLOCK_PATTERN)),
            motion: map(tree_codes(&MOTION)),
            dc_l: map(dc_l),
            dc_c: map(dc_c),
            // B-14 as used after the first coefficient: (0,1) is "11".
            b14: map(tree_codes(&DCT_COEFF).into_iter().filter(|&(_, n, v)| v > 1 || (v == 1 && n > 1)).chain([(0b11, 2, 1)]).collect()),
            b15: map(B15.iter().map(|&(c, n, r, l)| (c as u32, n, ((r as i16) << 8) | l as i16)).collect()),
        }
    }

    const W: i32 = 720;
    const H: i32 = 576;
    const MBW: i32 = W / 16;

    #[derive(Clone, Copy)]
    struct PicCfg {
        ptype: u8,
        tr: u16,
        structure: u8,
        fpfd: bool,
        cmv: bool,
        qst: bool,
        ivf: bool,
        alt: bool,
        dc_prec: u8,
        /// P second field of the very first frame: only the first field can be referenced.
        first_frame_second: bool,
    }

    struct Enc {
        b: Bw,
        c: Codes,
        r: Rng,
        pmv: [[[i32; 2]; 2]; 2],
        dc: [i32; 3],
    }

    fn put_vlc(b: &mut Bw, t: &Map, v: i16) {
        let (c, n) = *t.get(&v).unwrap_or_else(|| panic!("no code for {v}"));
        b.put(c, n as u32);
    }

    impl Enc {
        fn sequence(&mut self) {
            self.b.start(0xB3);
            self.b.put(W as u32, 12);
            self.b.put(H as u32, 12);
            self.b.put(2, 4); // 4:3
            self.b.put(3, 4); // 25 Hz
            self.b.put(0x3FFFF, 18);
            self.b.put(1, 1);
            self.b.put(112, 10);
            self.b.put(0, 1);
            self.b.put(0, 2); // default matrices
            self.b.start(0xB5);
            self.b.put(1, 4);
            self.b.put(0x48, 8); // Main@Main
            self.b.put(0, 1); // interlaced sequence
            self.b.put(1, 2); // 4:2:0
            self.b.put(0, 4);
            self.b.put(0, 12);
            self.b.put(1, 1);
            self.b.put(0, 8);
            self.b.put(0, 1);
            self.b.put(0, 7);
            self.b.start(0xB8);
            self.b.put(0, 25);
            self.b.put(0, 2);
        }

        fn picture(&mut self, p: PicCfg) {
            self.b.start(0x00);
            self.b.put(p.tr as u32, 10);
            self.b.put(p.ptype as u32, 3);
            self.b.put(0xFFFF, 16);
            if p.ptype >= PIC_P {
                self.b.put(0b0111, 4);
            }
            if p.ptype == PIC_B {
                self.b.put(0b0111, 4);
            }
            self.b.put(0, 1);
            self.b.start(0xB5);
            self.b.put(8, 4);
            let fc = |used: bool| if used { 3u32 } else { 15 };
            let fwd = p.ptype >= PIC_P || p.cmv;
            self.b.put(fc(fwd), 4);
            self.b.put(fc(fwd), 4);
            self.b.put(fc(p.ptype == PIC_B), 4);
            self.b.put(fc(p.ptype == PIC_B), 4);
            self.b.put(p.dc_prec as u32, 2);
            self.b.put(p.structure as u32, 2);
            self.b.put(u32::from(p.structure == FRAME), 1); // top_field_first (frame pictures)
            self.b.put(u32::from(p.fpfd), 1);
            self.b.put(u32::from(p.cmv), 1);
            self.b.put(u32::from(p.qst), 1);
            self.b.put(u32::from(p.ivf), 1);
            self.b.put(u32::from(p.alt), 1);
            self.b.put(0, 1); // repeat_first_field
            self.b.put(0, 1); // chroma_420_type
            self.b.put(0, 1); // progressive_frame
            self.b.put(0, 1); // composite_display_flag
            let rows = if p.structure == FRAME { H / 16 } else { H / 32 };
            for row in 0..rows {
                self.slice(p, row, rows);
            }
        }

        fn mv_comp(&mut self, target: i32, pred: i32) -> i32 {
            // f_code 3: f = 4, range [-64, 63].
            let (r, f) = (2, 4);
            let mut d = target - pred;
            if d > 16 * f - 1 {
                d -= 32 * f;
            } else if d < -16 * f {
                d += 32 * f;
            }
            if d == 0 {
                put_vlc(&mut self.b, &self.c.motion, 0);
            } else {
                let a = d.abs() - 1;
                let code = (a >> r) + 1;
                let res = a & (f - 1);
                put_vlc(&mut self.b, &self.c.motion, if d < 0 { -code as i16 } else { code as i16 });
                self.b.put(res as u32, r as u32);
            }
            target
        }

        fn dmv(&mut self, v: i32) {
            match v {
                0 => self.b.put(0, 1),
                1 => self.b.put(0b10, 2),
                _ => self.b.put(0b11, 2),
            }
        }

        fn slice(&mut self, p: PicCfg, row: i32, rows: i32) {
            self.b.start((row + 1) as u8);
            let qcode = if p.qst { 6 } else { 4 };
            self.b.put(qcode, 5);
            self.b.put(0, 1);
            self.pmv = [[[0; 2]; 2]; 2];
            self.dc = [1 << (7 + p.dc_prec); 3];
            let mut col = 0;
            let mut skip = 0;
            let mut prev_intra = true;
            while col < MBW {
                let interior = col > 0 && col < MBW - 1 && row > 0 && row < rows - 1;
                // Skipped macroblocks: not first/last, not in I pictures, B not after intra, not
                // in the first frame's P field (no same-parity reference).
                if col > 0 && col < MBW - 1 && p.ptype != PIC_I && !p.first_frame_second && !(p.ptype == PIC_B && prev_intra) && self.r.chance(15) {
                    skip += 1;
                    col += 1;
                    if p.ptype == PIC_P {
                        self.pmv = [[[0; 2]; 2]; 2];
                    }
                    self.dc = [1 << (7 + p.dc_prec); 3];
                    continue;
                }
                put_vlc(&mut self.b, &self.c.mba, if col == 0 { 1 } else { skip + 1 } as i16);
                skip = 0;
                prev_intra = self.macroblock(p, interior);
                col += 1;
            }
        }

        /// One macroblock; returns whether it was intra.
        fn macroblock(&mut self, p: PicCfg, interior: bool) -> bool {
            let frame_pic = p.structure == FRAME;
            let intra = p.ptype == PIC_I || (!p.first_frame_second && self.r.chance(8));
            let (mut fwd, mut bwd) = (false, false);
            if !intra {
                match p.ptype {
                    PIC_P => fwd = !self.r.chance(10) || p.first_frame_second,
                    _ => match self.r.range(0, 2) {
                        0 => fwd = true,
                        1 => bwd = true,
                        _ => {
                            fwd = true;
                            bwd = true;
                        }
                    },
                }
            }
            let pattern = !intra && (self.r.chance(60) || (p.ptype == PIC_P && !fwd));
            let ty: i16 = (intra as i16) | ((pattern as i16) << 1) | ((bwd as i16) << 2) | ((fwd as i16) << 3);
            put_vlc(&mut self.b, &self.c.mbt[p.ptype as usize - 1], ty);
            // Motion type.
            let mut mtype = 0;
            if fwd || bwd {
                mtype = if frame_pic && p.fpfd {
                    2
                } else {
                    let dp_ok = p.ptype == PIC_P && interior;
                    loop {
                        let m = self.r.range(1, 3);
                        if m != 3 || dp_ok {
                            break m;
                        }
                    }
                };
                if p.first_frame_second {
                    mtype = 1;
                }
                if !(frame_pic && p.fpfd) {
                    self.b.put(mtype as u32, 2);
                }
            }
            if frame_pic && !p.fpfd && (intra || pattern) {
                let d = self.r.next() & 1;
                self.b.put(d, 1);
            }
            let par = if frame_pic { 0 } else { (p.structure - 1) as u32 };
            if intra {
                if p.cmv {
                    if !frame_pic {
                        self.b.put(par, 1);
                    }
                    let tx = if interior { self.r.range(-6, 6) } else { 0 };
                    let ty = if interior { self.r.range(-6, 6) } else { 0 };
                    let x = self.mv_comp(tx, self.pmv[0][0][0]);
                    let y = self.mv_comp(ty, self.pmv[0][0][1]);
                    self.pmv[0][0] = [x, y];
                    self.pmv[1][0] = [x, y];
                    self.b.put(1, 1); // marker
                } else {
                    self.pmv = [[[0; 2]; 2]; 2];
                }
            } else {
                self.dc = [1 << (7 + p.dc_prec); 3];
                if p.ptype == PIC_P && !fwd {
                    self.pmv = [[[0; 2]; 2]; 2];
                }
                for s in 0..2 {
                    if (s == 0 && fwd) || (s == 1 && bwd) {
                        self.vectors(p, s, mtype, interior, par);
                    }
                }
            }
            if pattern {
                let cbp = self.r.range(1, 63) as i16;
                put_vlc(&mut self.b, &self.c.cbp, cbp);
                for b in 0..6 {
                    if cbp & (0x20 >> b) != 0 {
                        self.block(p, b, false);
                    }
                }
            } else if intra {
                for b in 0..6 {
                    self.block(p, b, true);
                }
            }
            intra
        }

        fn vectors(&mut self, p: PicCfg, s: usize, mtype: i32, interior: bool, par: u32) {
            let frame_pic = p.structure == FRAME;
            let (count, field_fmt, dmv) = match (frame_pic, mtype) {
                (true, 1) => (2, true, false),
                (true, 2) => (1, false, false),
                (true, 3) => (1, true, true),
                (false, 1) => (1, true, false),
                (false, 2) => (2, true, false),
                _ => (1, true, true),
            };
            let vshift = i32::from(field_fmt && frame_pic);
            let ffs = p.first_frame_second;
            if count == 1 {
                if field_fmt && !dmv {
                    let fs = if ffs { 0 } else if interior { self.r.next() & 1 } else { par };
                    self.b.put(fs, 1);
                }
                let lim = if dmv { 3 } else { 10 };
                let tx = if interior { self.r.range(-lim, lim) } else { 0 };
                let ty = if interior { self.r.range(-lim, lim) } else { 0 };
                let x = self.mv_comp(tx, self.pmv[0][s][0]);
                if dmv {
                    let d = self.r.range(-1, 1);
                    self.dmv(if interior { d } else { 0 });
                }
                let y = self.mv_comp(ty, self.pmv[0][s][1] >> vshift);
                if dmv {
                    let d = self.r.range(-1, 1);
                    self.dmv(if interior { d } else { 0 });
                }
                self.pmv[0][s] = [x, y << vshift];
                self.pmv[1][s] = [x, y << vshift];
            } else {
                for r in 0..2 {
                    let fs = if ffs { 0 } else if interior { self.r.next() & 1 } else { par };
                    self.b.put(fs, 1);
                    let tx = if interior { self.r.range(-10, 10) } else { 0 };
                    let ty = if interior { self.r.range(-10, 10) } else { 0 };
                    let x = self.mv_comp(tx, self.pmv[r][s][0]);
                    let y = self.mv_comp(ty, self.pmv[r][s][1] >> vshift);
                    self.pmv[r][s] = [x, y << vshift];
                }
            }
        }

        fn block(&mut self, p: PicCfg, b: usize, intra: bool) {
            let mut first = !intra;
            if intra {
                let comp = if b < 4 { 0 } else { b - 3 };
                let target = (self.dc[comp] + self.r.range(-40, 40) * (1 << p.dc_prec)).clamp(0, (1 << (8 + p.dc_prec)) - 1);
                let diff = target - self.dc[comp];
                self.dc[comp] = target;
                let size = 32 - diff.unsigned_abs().leading_zeros();
                put_vlc(&mut self.b, if b < 4 { &self.c.dc_l } else { &self.c.dc_c }, size as i16);
                if size > 0 {
                    let v = if diff > 0 { diff } else { diff + (1 << size) - 1 };
                    self.b.put(v as u32, size);
                }
            }
            let n = self.r.range(if intra { 0 } else { 1 }, 6);
            let mut pos = if intra { 1 } else { 0 };
            for _ in 0..n {
                let run = self.r.range(0, 6);
                if pos + run > 63 {
                    break;
                }
                pos += run + 1;
                let mag = if self.r.chance(10) { self.r.range(20, 60) } else { self.r.range(1, 6) };
                let level = if self.r.chance(50) { -mag } else { mag };
                let key = ((run as i16) << 8) | mag as i16;
                let force_escape = self.r.chance(5);
                let table = if intra && p.ivf { &self.c.b15 } else { &self.c.b14 };
                let code = table.get(&key).copied();
                if first && run == 0 && mag == 1 && !force_escape {
                    self.b.put(1, 1); // dct_coeff_first "1s"
                    self.b.put(u32::from(level < 0), 1);
                } else if let (Some((c, l)), false) = (code, force_escape) {
                    self.b.put(c, l as u32);
                    self.b.put(u32::from(level < 0), 1);
                } else {
                    self.b.put(1, 6);
                    self.b.put(run as u32, 6);
                    self.b.put((level & 0xfff) as u32, 12);
                }
                first = false;
            }
            if intra && p.ivf {
                self.b.put(0b0110, 4);
            } else {
                self.b.put(0b10, 2);
            }
        }
    }

    fn stream(seed: u32) -> Vec<u8> {
        let mut e = Enc { b: Bw { v: Vec::new(), acc: 0, n: 0 }, c: codes(), r: Rng(seed), pmv: [[[0; 2]; 2]; 2], dc: [128; 3] };
        e.sequence();
        let base = PicCfg { ptype: PIC_I, tr: 0, structure: TOP, fpfd: false, cmv: false, qst: false, ivf: false, alt: false, dc_prec: 0, first_frame_second: false };
        // Decode order: I/P field pair (tr 0), P field pair (2), B field pair bottom first (1),
        // P frame picture with field DCT, field/frame/dual-prime MC (3), I frame with concealment
        // vectors, B-15, alternate scan, non-linear quant and 10-bit DC (4), P field pair bottom
        // first (6), B frame picture (5), then a P frame with frame_pred_frame_dct (7).
        let pics = [
            base,
            PicCfg { ptype: PIC_P, structure: BOTTOM, first_frame_second: true, ..base },
            PicCfg { ptype: PIC_P, tr: 2, structure: TOP, ..base },
            PicCfg { ptype: PIC_P, tr: 2, structure: BOTTOM, ..base },
            PicCfg { ptype: PIC_B, tr: 1, structure: BOTTOM, alt: true, ..base },
            PicCfg { ptype: PIC_B, tr: 1, structure: TOP, alt: true, ..base },
            PicCfg { ptype: PIC_P, tr: 3, structure: FRAME, qst: true, ..base },
            PicCfg { ptype: PIC_I, tr: 4, structure: FRAME, cmv: true, ivf: true, alt: true, qst: true, dc_prec: 2, ..base },
            PicCfg { ptype: PIC_P, tr: 6, structure: BOTTOM, ivf: true, dc_prec: 1, ..base },
            PicCfg { ptype: PIC_P, tr: 6, structure: TOP, ivf: true, dc_prec: 1, ..base },
            PicCfg { ptype: PIC_B, tr: 5, structure: FRAME, ..base },
            PicCfg { ptype: PIC_P, tr: 7, structure: FRAME, fpfd: true, ..base },
        ];
        for p in pics {
            e.picture(p);
        }
        e.b.start(0xB7);
        e.b.v
    }

    #[test]
    fn field_pictures_match_ffmpeg() {
        let (Ok(ff), Ok(dir)) = (std::env::var("GW_FFMPEG"), std::env::var("GW_MPEG2_GEN")) else {
            eprintln!("GW_FFMPEG / GW_MPEG2_GEN not set: skipped");
            return;
        };
        std::fs::create_dir_all(&dir).unwrap();
        for seed in [1u32, 7, 1234, 99991] {
            let es = stream(seed);
            let path = format!("{dir}/fieldgen_{seed}.m2v");
            let yuv = format!("{dir}/fieldgen_{seed}.yuv");
            std::fs::write(&path, &es).unwrap();
            let st = std::process::Command::new(&ff).args(["-hide_banner", "-loglevel", "error", "-y", "-idct", "simple", "-i", &path, "-f", "rawvideo", "-pix_fmt", "yuv420p", &yuv]).status().unwrap();
            assert!(st.success(), "ffmpeg failed on {path}");
            let r = std::fs::read(&yuv).unwrap();
            let mut d = Decoder::new();
            d.push(&es);
            d.end();
            let (w, h) = (W as usize, H as usize);
            let fsz = w * h * 3 / 2;
            let mut k = 0;
            let mut exact = 0;
            let mut worst = f64::INFINITY;
            while let Some(o) = d.decode().unwrap() {
                let f = d.frame(o.slot);
                let (lw, cw) = d.strides();
                let mut mine = Vec::with_capacity(fsz);
                for y in 0..h {
                    mine.extend_from_slice(&f.y[y * lw..y * lw + w]);
                }
                for p in [&f.cb, &f.cr] {
                    for y in 0..h / 2 {
                        mine.extend_from_slice(&p[y * cw..y * cw + w / 2]);
                    }
                }
                let Some(theirs) = r.get(k * fsz..(k + 1) * fsz) else { break };
                if mine == theirs {
                    exact += 1;
                } else {
                    let se: f64 = mine.iter().zip(theirs).map(|(&a, &b)| (a as f64 - b as f64).powi(2)).sum();
                    let p = 10.0 * (255f64 * 255.0 / (se / fsz as f64)).log10();
                    let bad = mine.iter().zip(theirs).position(|(a, b)| a != b).unwrap();
                    eprintln!("seed {seed} frame {k} (type {}, tr {}): PSNR {p:.2} dB, first difference at sample {bad} (luma row {}, col {})", o.ptype, o.tr, bad / w, bad % w);
                    worst = worst.min(p);
                }
                k += 1;
            }
            eprintln!("seed {seed}: {k} frames ({} from ffmpeg), {exact} bit-exact ({} field pictures); macroblocks: field MC in field pictures {}, 16x8 {}, dual prime field {} / frame {}, field MC in frame pictures {}, skipped {}, concealment {}; escapes {}", r.len() / fsz, d.field_pictures, d.cov[0], d.cov[1], d.cov[2], d.cov[3], d.cov[4], d.cov[5], d.cov[6], d.cov[7]);
            assert_eq!(d.errors, 0, "damaged slices");
            assert!(d.cov.iter().all(|&c| c > 50), "coverage {:?}", d.cov);
            assert_eq!(k, r.len() / fsz, "frame count");
            assert_eq!(exact, k, "worst PSNR {worst:.2} dB");
        }
    }
}
