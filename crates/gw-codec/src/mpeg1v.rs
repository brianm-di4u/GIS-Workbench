//! MPEG-1 video decoder (ISO/IEC 11172-2; FC-22, REQ-FMT-52): a port of the video part of
//! pl_mpeg (MIT, Dominic Szablewski, https://github.com/phoboslab/pl_mpeg; itself after Zoltan
//! Korandi's Java MPEG-1 decoder). I, P and B pictures, half-pel motion compensation, the AAN
//! integer IDCT, BT.601 YCbCr → RGBA.
//!
//! Differences from pl_mpeg, for the app's player: the decoder is fed the elementary stream in
//! pieces and decodes a picture only once the next picture (or GOP/sequence) header is in the
//! buffer, or the input has ended; after `reset` (a seek) it skips pictures whose references were
//! not decoded (P before the first I, B before two references), so a seek never shows garbage;
//! every output carries the picture's decode ordinal since the reset, its temporal reference and
//! type; every read and write is bounds-checked (corrupt streams give damaged pictures, never a
//! panic); an MPEG-2 sequence (sequence extension) is reported, not decoded.

use gw_abi::{Error, Result};

include!("mpeg1v_tables.rs");

const PIC_I: u8 = 1;
const PIC_P: u8 = 2;
const PIC_B: u8 = 3;
const MAX_DIM: u32 = 4096;

#[derive(Default, Clone)]
pub struct Frame {
    pub y: Vec<u8>,
    pub cb: Vec<u8>,
    pub cr: Vec<u8>,
    /// Decode ordinal (pictures since the last reset), temporal reference and type.
    pub ord: u32,
    pub tr: u16,
    pub ptype: u8,
}

#[derive(Default, Clone, Copy)]
struct Motion {
    full_px: bool,
    is_set: bool,
    r_size: u32,
    h: i32,
    v: i32,
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

pub struct Decoder {
    buf: Vec<u8>,
    pos: usize,
    ended: bool,
    end_hint: usize,
    // Bit reader over buf[..limit].
    bit: usize,
    limit: usize,
    // Sequence.
    pub has_seq: bool,
    pub mpeg2: bool,
    pub width: u32,
    pub height: u32,
    pub rate_code: u8,
    pub aspect: u8,
    mb_w: i32,
    mb_h: i32,
    mb_size: i32,
    luma_w: usize,
    chroma_w: usize,
    intra_q: [u8; 64],
    non_intra_q: [u8; 64],
    cur: Frame,
    fwd: Frame,
    bwd: Frame,
    // Picture.
    ptype: u8,
    mf: Motion,
    mb_: Motion,
    quant: i32,
    slice_begin: bool,
    mb_addr: i32,
    mb_row: i32,
    mb_col: i32,
    mb_type: i32,
    mb_intra: bool,
    dc: [i32; 3],
    block: [i32; 64],
    has_ref: bool,
    refs: u8,
    /// Reference pictures decoded since the last GOP header, and that header's flags.
    refs_in_gop: u8,
    gop_closed: bool,
    broken_link: bool,
    ord: u32,
    flushed: bool,
    pub decoded: u32,
    pub skipped: u32,
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    pub fn new() -> Self {
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
            aspect: 0,
            mb_w: 0,
            mb_h: 0,
            mb_size: 0,
            luma_w: 0,
            chroma_w: 0,
            intra_q: INTRA_QUANT_MATRIX,
            non_intra_q: NON_INTRA_QUANT_MATRIX,
            cur: Frame::default(),
            fwd: Frame::default(),
            bwd: Frame::default(),
            ptype: 0,
            mf: Motion::default(),
            mb_: Motion::default(),
            quant: 0,
            slice_begin: false,
            mb_addr: 0,
            mb_row: 0,
            mb_col: 0,
            mb_type: 0,
            mb_intra: false,
            dc: [128; 3],
            block: [0; 64],
            has_ref: false,
            refs: 0,
            refs_in_gop: 0,
            gop_closed: false,
            broken_link: false,
            ord: 0,
            flushed: false,
            decoded: 0,
            skipped: 0,
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

    /// A seek: drop buffered input and the reference pictures (the sequence header is kept).
    pub fn reset(&mut self) {
        self.buf.clear();
        self.pos = 0;
        self.end_hint = 0;
        self.ended = false;
        self.has_ref = false;
        self.refs = 0;
        self.ord = 0;
        self.flushed = false;
    }

    pub fn fps(&self) -> f64 {
        const R: [f64; 9] = [0.0, 24000.0 / 1001.0, 24.0, 25.0, 30000.0 / 1001.0, 30.0, 50.0, 60000.0 / 1001.0, 60.0];
        R.get(self.rate_code as usize).copied().unwrap_or(0.0)
    }

    pub fn frame(&self, s: Slot) -> &Frame {
        match s {
            Slot::Current => &self.cur,
            Slot::Forward => &self.fwd,
            Slot::Backward => &self.bwd,
        }
    }

    /// Position of the next start code at or after `from` (bytes) → (index of 00 00 01, code).
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

    /// Decode until the next picture ready for display, or None when more input is needed (or
    /// the input has ended and everything was output).
    pub fn decode(&mut self) -> Result<Option<Out>> {
        loop {
            let Some((at, code)) = self.find_code(self.pos) else {
                if self.ended {
                    self.pos = self.buf.len();
                    return Ok(self.flush());
                }
                // Keep the last 3 bytes: a start code may straddle the next push.
                self.pos = self.buf.len().saturating_sub(3).max(self.pos);
                return Ok(None);
            };
            match code {
                0xB3 => {
                    // Up to 8 header bytes and two 64-byte matrices.
                    if at + 4 + 8 + 128 > self.buf.len() && !self.ended {
                        self.pos = at;
                        return Ok(None);
                    }
                    self.sequence_header(at + 4)?;
                    if self.mpeg2 {
                        return Err(Error::unsupported("MPEG-2 video (a sequence extension follows the sequence header): only MPEG-1 video is decoded in the browser"));
                    }
                }
                0xB8 => {
                    // GOP header: closed_gop (B pictures use only the following reference) and
                    // broken_link (the first B pictures lost their earlier reference).
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
                    // A whole picture: up to the next picture, GOP, sequence or end code.
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
                    self.pos = end;
                    if let Some(o) = self.picture(at + 4, end) {
                        return Ok(Some(o));
                    }
                    continue;
                }
                _ => {}
            }
            self.pos = at + 4;
        }
    }

    /// Parse the first sequence header in the buffered input without decoding pictures (the
    /// buffer is kept); true once a sequence header is known.
    pub fn headers(&mut self) -> Result<bool> {
        let mut from = 0;
        while let Some((at, code)) = self.find_code(from) {
            if code == 0xB3 && at + 12 <= self.buf.len() {
                self.sequence_header(at + 4)?;
                if self.mpeg2 {
                    return Err(Error::unsupported("MPEG-2 video (a sequence extension follows the sequence header): only MPEG-1 video is decoded in the browser"));
                }
                return Ok(true);
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
        let byte = self.bit >> 3;
        let v = if byte < self.limit { (self.buf[byte] >> (7 - (self.bit & 7))) & 1 } else { 0 };
        self.bit += 1;
        v as u32
    }

    fn vlc(&mut self, t: &[[i16; 2]]) -> i32 {
        let mut idx = 0usize;
        loop {
            let Some(s) = t.get(idx + self.read1() as usize) else { return 0 };
            if s[0] > 0 {
                idx = s[0] as usize;
            } else {
                return s[1] as i32;
            }
        }
    }

    fn align(&mut self) {
        self.bit = (self.bit + 7) & !7;
    }

    /// Next start code within the bit reader's range → its code (the reader is placed after it).
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

    fn sequence_header(&mut self, at: usize) -> Result<()> {
        self.bit = at << 3;
        self.limit = self.buf.len();
        let w = self.read(12);
        let h = self.read(12);
        let aspect = self.read(4) as u8;
        let rate = self.read(4) as u8;
        self.bit += 18 + 1 + 10 + 1;
        let mut iq = INTRA_QUANT_MATRIX;
        let mut nq = NON_INTRA_QUANT_MATRIX;
        if self.read1() == 1 {
            for &z in ZIG_ZAG.iter() {
                iq[z as usize] = self.read(8) as u8;
            }
        }
        if self.read1() == 1 {
            for &z in ZIG_ZAG.iter() {
                nq[z as usize] = self.read(8) as u8;
            }
        }
        // A sequence extension right after the header: MPEG-2.
        let next = (self.bit + 7) >> 3;
        if let Some((e, 0xB5)) = self.find_code(next) {
            if e == next || self.buf[next..e].iter().all(|&c| c == 0) {
                if self.buf.get(e + 4).is_some_and(|&c| c >> 4 == 1) {
                    self.mpeg2 = true;
                }
            }
        }
        if w == 0 || h == 0 || w > MAX_DIM || h > MAX_DIM {
            return Err(gw_abi::err!(INVALID, "MPEG-1: invalid picture size {w}×{h}", w, h));
        }
        // Zero entries would zero every coefficient; treat as the default matrix value.
        for q in iq.iter_mut().chain(nq.iter_mut()) {
            if *q == 0 {
                *q = 16;
            }
        }
        self.intra_q = iq;
        self.non_intra_q = nq;
        self.aspect = aspect;
        self.rate_code = rate;
        if !self.has_seq || w != self.width || h != self.height {
            self.width = w;
            self.height = h;
            self.mb_w = (w as i32 + 15) >> 4;
            self.mb_h = (h as i32 + 15) >> 4;
            self.mb_size = self.mb_w * self.mb_h;
            self.luma_w = (self.mb_w as usize) << 4;
            self.chroma_w = (self.mb_w as usize) << 3;
            let ly = self.luma_w * ((self.mb_h as usize) << 4);
            let lc = self.chroma_w * ((self.mb_h as usize) << 3);
            for f in [&mut self.cur, &mut self.fwd, &mut self.bwd] {
                f.y = vec![0; ly];
                f.cb = vec![128; lc];
                f.cr = vec![128; lc];
                f.ptype = 0;
            }
            self.has_ref = false;
            self.refs = 0;
            self.has_seq = true;
        }
        Ok(())
    }

    /// Decode one picture (bytes `[at, end)`, after its start code) → the picture to display.
    fn picture(&mut self, at: usize, end: usize) -> Option<Out> {
        self.bit = at << 3;
        self.limit = end.min(self.buf.len());
        let ord = self.ord;
        self.ord += 1;
        let tr = self.read(10) as u16;
        let ptype = self.read(3) as u8;
        self.bit += 16;
        if !(PIC_I..=PIC_B).contains(&ptype) {
            self.skipped += 1;
            return None; // D pictures
        }
        // References a seek did not decode. A B picture of a closed GOP needs only the reference
        // after it; after a broken link it needs two references of its own GOP.
        let b_ok = if self.gop_closed {
            self.refs_in_gop >= 1
        } else if self.broken_link {
            self.refs_in_gop >= 2
        } else {
            self.refs >= 2
        };
        if (ptype == PIC_P && self.refs < 1) || (ptype == PIC_B && !b_ok) {
            self.skipped += 1;
            return None;
        }
        if ptype == PIC_P || ptype == PIC_B {
            self.mf.full_px = self.read1() == 1;
            let f = self.read(3);
            if f == 0 {
                self.skipped += 1;
                return None;
            }
            self.mf.r_size = f - 1;
        }
        if ptype == PIC_B {
            self.mb_.full_px = self.read1() == 1;
            let f = self.read(3);
            if f == 0 {
                self.skipped += 1;
                return None;
            }
            self.mb_.r_size = f - 1;
        }
        self.ptype = ptype;
        let reference = ptype != PIC_B;
        if reference {
            std::mem::swap(&mut self.fwd, &mut self.bwd);
        }
        let mut code = loop {
            match self.next_start_code() {
                Some(0xB5) | Some(0xB2) => continue,
                c => break c,
            }
        };
        while let Some(c @ 0x01..=0xAF) = code {
            self.slice(c as i32);
            if self.mb_addr >= self.mb_size - 1 {
                break;
            }
            code = self.next_start_code();
        }
        self.decoded += 1;
        self.cur.ord = ord;
        self.cur.tr = tr;
        self.cur.ptype = ptype;
        if reference {
            // backward = current; current = the old forward (now in bwd).
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
            Some(Out { slot: Slot::Current, ord, tr, ptype })
        }
    }

    fn slice(&mut self, slice: i32) {
        self.slice_begin = true;
        self.mb_addr = (slice - 1) * self.mb_w - 1;
        self.mf.h = 0;
        self.mf.v = 0;
        self.mb_.h = 0;
        self.mb_.v = 0;
        self.dc = [128; 3];
        self.quant = self.read(5) as i32;
        let mut extra = 0;
        while self.read1() == 1 && extra < 4096 {
            self.bit += 8;
            extra += 1;
        }
        loop {
            self.macroblock();
            if !(self.mb_addr < self.mb_size - 1 && self.bit < self.limit << 3 && self.peek(23) != 0) {
                break;
            }
        }
    }

    fn macroblock(&mut self) {
        let mut inc = 0;
        let mut t = self.vlc(&MACROBLOCK_ADDRESS_INCREMENT);
        while t == 34 {
            if self.bit >= self.limit << 3 {
                return;
            }
            t = self.vlc(&MACROBLOCK_ADDRESS_INCREMENT);
        }
        while t == 35 {
            inc += 33;
            if self.bit >= self.limit << 3 || inc > self.mb_size {
                return;
            }
            t = self.vlc(&MACROBLOCK_ADDRESS_INCREMENT);
        }
        inc += t;
        if self.slice_begin {
            self.slice_begin = false;
            self.mb_addr += inc;
        } else {
            if self.mb_addr + inc >= self.mb_size {
                self.mb_addr = self.mb_size; // invalid: end the slice
                return;
            }
            if inc > 1 {
                self.dc = [128; 3];
                if self.ptype == PIC_P {
                    self.mf.h = 0;
                    self.mf.v = 0;
                }
            }
            while inc > 1 {
                self.mb_addr += 1;
                self.mb_row = self.mb_addr / self.mb_w;
                self.mb_col = self.mb_addr % self.mb_w;
                self.predict();
                inc -= 1;
            }
            self.mb_addr += 1;
        }
        if self.mb_addr < 0 || self.mb_addr >= self.mb_size {
            self.mb_addr = self.mb_size;
            return;
        }
        self.mb_row = self.mb_addr / self.mb_w;
        self.mb_col = self.mb_addr % self.mb_w;
        self.mb_type = match self.ptype {
            PIC_I => self.vlc(&MACROBLOCK_TYPE_INTRA),
            PIC_P => self.vlc(&MACROBLOCK_TYPE_PREDICTIVE),
            _ => self.vlc(&MACROBLOCK_TYPE_B),
        };
        self.mb_intra = self.mb_type & 0x01 != 0;
        self.mf.is_set = self.mb_type & 0x08 != 0;
        self.mb_.is_set = self.mb_type & 0x04 != 0;
        if self.mb_type & 0x10 != 0 {
            self.quant = self.read(5) as i32;
        }
        if self.mb_intra {
            self.mf.h = 0;
            self.mf.v = 0;
            self.mb_.h = 0;
            self.mb_.v = 0;
        } else {
            self.dc = [128; 3];
            self.motion_vectors();
            self.predict();
        }
        let cbp = if self.mb_type & 0x02 != 0 {
            self.vlc(&CODE_BLOCK_PATTERN)
        } else if self.mb_intra {
            0x3f
        } else {
            0
        };
        let mut mask = 0x20;
        for b in 0..6 {
            if cbp & mask != 0 {
                self.decode_block(b);
            }
            mask >>= 1;
        }
    }

    fn motion_vectors(&mut self) {
        if self.mf.is_set {
            let r = self.mf.r_size;
            self.mf.h = self.motion_vector(r, self.mf.h);
            self.mf.v = self.motion_vector(r, self.mf.v);
        } else if self.ptype == PIC_P {
            self.mf.h = 0;
            self.mf.v = 0;
        }
        if self.mb_.is_set {
            let r = self.mb_.r_size;
            self.mb_.h = self.motion_vector(r, self.mb_.h);
            self.mb_.v = self.motion_vector(r, self.mb_.v);
        }
    }

    fn motion_vector(&mut self, r_size: u32, motion: i32) -> i32 {
        let fscale = 1i32 << r_size;
        let m = self.vlc(&MOTION);
        let d = if m != 0 && fscale != 1 {
            let r = self.read(r_size) as i32;
            let d = ((m.abs() - 1) << r_size) + r + 1;
            if m < 0 {
                -d
            } else {
                d
            }
        } else {
            m
        };
        let mut v = motion + d;
        if v > (fscale << 4) - 1 {
            v -= fscale << 5;
        } else if v < -(fscale << 4) {
            v += fscale << 5;
        }
        v
    }

    fn predict(&mut self) {
        let (mut fh, mut fv) = (self.mf.h, self.mf.v);
        if self.mf.full_px {
            fh <<= 1;
            fv <<= 1;
        }
        let g = Geo { mb_w: self.mb_w, mb_h: self.mb_h, row: self.mb_row, col: self.mb_col };
        if self.ptype == PIC_B {
            let (mut bh, mut bv) = (self.mb_.h, self.mb_.v);
            if self.mb_.full_px {
                bh <<= 1;
                bv <<= 1;
            }
            if self.mf.is_set {
                copy_mb(&g, &self.fwd, &mut self.cur, fh, fv, false);
                if self.mb_.is_set {
                    copy_mb(&g, &self.bwd, &mut self.cur, bh, bv, true);
                }
            } else {
                copy_mb(&g, &self.bwd, &mut self.cur, bh, bv, false);
            }
        } else {
            copy_mb(&g, &self.fwd, &mut self.cur, fh, fv, false);
        }
    }

    fn decode_block(&mut self, block: usize) {
        let mut n: usize = 0;
        let intra = self.mb_intra;
        if intra {
            let plane = if block > 3 { block - 3 } else { 0 };
            let pred = self.dc[plane];
            let size = if plane == 0 { self.vlc(&DCT_SIZE_LUMINANCE) } else { self.vlc(&DCT_SIZE_CHROMINANCE) };
            let v = if size > 0 {
                let diff = self.read(size as u32) as i32;
                if diff & (1 << (size - 1)) != 0 {
                    pred + diff
                } else {
                    pred + ((-(1i32 << size)) | (diff + 1))
                }
            } else {
                pred
            };
            self.dc[plane] = v;
            self.block[0] = v << 8;
            n = 1;
        }
        let q = if intra { self.intra_q } else { self.non_intra_q };
        loop {
            let coeff = self.vlc(&DCT_COEFF);
            if coeff == 0x0001 && n > 0 && self.read1() == 0 {
                break; // end of block
            }
            let (run, mut level);
            if coeff == -1 {
                run = self.read(6) as usize;
                level = self.read(8) as i32;
                if level == 0 {
                    level = self.read(8) as i32;
                } else if level == 128 {
                    level = self.read(8) as i32 - 256;
                } else if level > 128 {
                    level -= 256;
                }
            } else {
                run = (coeff >> 8) as usize;
                level = coeff & 0xff;
                if self.read1() == 1 {
                    level = -level;
                }
            }
            n += run;
            if n >= 64 {
                break; // invalid: keep what was decoded
            }
            let z = ZIG_ZAG[n] as usize;
            n += 1;
            level <<= 1;
            if !intra {
                level += if level < 0 { -1 } else { 1 };
            }
            level = (level * self.quant * q[z] as i32) >> 4;
            if level & 1 == 0 {
                level -= if level > 0 { 1 } else { -1 };
            }
            level = level.clamp(-2048, 2047);
            self.block[z] = level * PREMULTIPLIER_MATRIX[z] as i32;
            if self.bit > (self.limit << 3) + 64 {
                break;
            }
        }
        // Place the block.
        let (row, col) = (self.mb_row as usize, self.mb_col as usize);
        let (d, dw, di) = if block < 4 {
            let mut di = (row * self.luma_w + col) << 4;
            if block & 1 != 0 {
                di += 8;
            }
            if block & 2 != 0 {
                di += self.luma_w << 3;
            }
            (&mut self.cur.y, self.luma_w, di)
        } else {
            let di = ((row * self.luma_w) << 2) + (col << 3);
            (if block == 4 { &mut self.cur.cb } else { &mut self.cur.cr }, self.chroma_w, di)
        };
        if di + 7 * dw + 8 > d.len() {
            self.block = [0; 64];
            return;
        }
        let s = &mut self.block;
        if n == 1 {
            let v = (s[0] + 128) >> 8;
            for y in 0..8 {
                let r = &mut d[di + y * dw..di + y * dw + 8];
                for p in r.iter_mut() {
                    *p = if intra { clamp(v) } else { clamp(*p as i32 + v) };
                }
            }
            s[0] = 0;
        } else {
            idct(s);
            for y in 0..8 {
                let r = &mut d[di + y * dw..di + y * dw + 8];
                for (x, p) in r.iter_mut().enumerate() {
                    *p = if intra { clamp(s[y * 8 + x]) } else { clamp(*p as i32 + s[y * 8 + x]) };
                }
            }
            *s = [0; 64];
        }
    }

    /// The picture in `slot` as RGBA (BT.601 studio range, as pl_mpeg), `width × height`.
    pub fn rgba(&self, slot: Slot, out: &mut Vec<u8>) {
        let f = self.frame(slot);
        let (w, h) = (self.width as usize, self.height as usize);
        out.clear();
        out.resize(w * h * 4, 255);
        let (yw, cw) = (self.luma_w, self.chroma_w);
        if f.y.len() < yw * ((h + 1) & !1) || f.cb.len() < cw * h.div_ceil(2) {
            return;
        }
        for row in 0..h {
            let yr = &f.y[row * yw..row * yw + w];
            let cbr = &f.cb[(row >> 1) * cw..];
            let crr = &f.cr[(row >> 1) * cw..];
            let o = &mut out[row * w * 4..(row + 1) * w * 4];
            for (x, (px, &yv)) in o.chunks_exact_mut(4).zip(yr.iter()).enumerate() {
                let cr = crr[x >> 1] as i32 - 128;
                let cb = cbr[x >> 1] as i32 - 128;
                let r = (cr * 104597) >> 16;
                let g = (cb * 25674 + cr * 53278) >> 16;
                let b = (cb * 132201) >> 16;
                let y = ((yv as i32 - 16) * 76309) >> 16;
                px[0] = clamp(y + r);
                px[1] = clamp(y - g);
                px[2] = clamp(y + b);
            }
        }
    }
}

#[inline(always)]
fn clamp(n: i32) -> u8 {
    n.clamp(0, 255) as u8
}

struct Geo {
    mb_w: i32,
    mb_h: i32,
    row: i32,
    col: i32,
}

fn copy_mb(g: &Geo, s: &Frame, d: &mut Frame, mh: i32, mv: i32, interp: bool) {
    process(g, &s.y, &mut d.y, mh, mv, 16, interp);
    process(g, &s.cr, &mut d.cr, mh / 2, mv / 2, 8, interp);
    process(g, &s.cb, &mut d.cb, mh / 2, mv / 2, 8, interp);
}

fn process(g: &Geo, s: &[u8], d: &mut [u8], mh: i32, mv: i32, bs: i32, interp: bool) {
    let dw = g.mb_w * bs;
    let hp = mh >> 1;
    let vp = mv >> 1;
    let odd_h = mh & 1 == 1;
    let odd_v = mv & 1 == 1;
    let si = ((g.row * bs) + vp) as i64 * dw as i64 + (g.col * bs + hp) as i64;
    let di = ((g.row * dw + g.col) * bs) as i64;
    let max = (dw as i64) * ((g.mb_h * bs - bs + 1) as i64) - bs as i64;
    if si < 0 || si > max || di < 0 || di > max {
        return;
    }
    let (si, di, dw, bs) = (si as usize, di as usize, dw as usize, bs as usize);
    // Furthest source byte read (half-pel needs one more row and column).
    if si + (bs - 1) * dw + bs + usize::from(odd_v) * dw + usize::from(odd_h) > s.len() || di + (bs - 1) * dw + bs > d.len() {
        return;
    }
    match (interp, odd_h, odd_v) {
        (false, false, false) => blk(s, d, si, di, dw, bs, |s, i, _| s[i] as u32),
        (false, false, true) => blk(s, d, si, di, dw, bs, |s, i, w| (s[i] as u32 + s[i + w] as u32 + 1) >> 1),
        (false, true, false) => blk(s, d, si, di, dw, bs, |s, i, _| (s[i] as u32 + s[i + 1] as u32 + 1) >> 1),
        (false, true, true) => blk(s, d, si, di, dw, bs, |s, i, w| (s[i] as u32 + s[i + 1] as u32 + s[i + w] as u32 + s[i + w + 1] as u32 + 2) >> 2),
        (true, false, false) => avg(s, d, si, di, dw, bs, |s, i, _| s[i] as u32),
        (true, false, true) => avg(s, d, si, di, dw, bs, |s, i, w| (s[i] as u32 + s[i + w] as u32 + 1) >> 1),
        (true, true, false) => avg(s, d, si, di, dw, bs, |s, i, _| (s[i] as u32 + s[i + 1] as u32 + 1) >> 1),
        (true, true, true) => avg(s, d, si, di, dw, bs, |s, i, w| (s[i] as u32 + s[i + 1] as u32 + s[i + w] as u32 + s[i + w + 1] as u32 + 2) >> 2),
    }
}

#[inline(always)]
fn blk(s: &[u8], d: &mut [u8], si: usize, di: usize, dw: usize, bs: usize, f: impl Fn(&[u8], usize, usize) -> u32) {
    for y in 0..bs {
        let (so, dof) = (si + y * dw, di + y * dw);
        for x in 0..bs {
            d[dof + x] = f(s, so + x, dw) as u8;
        }
    }
}

#[inline(always)]
fn avg(s: &[u8], d: &mut [u8], si: usize, di: usize, dw: usize, bs: usize, f: impl Fn(&[u8], usize, usize) -> u32) {
    for y in 0..bs {
        let (so, dof) = (si + y * dw, di + y * dw);
        for x in 0..bs {
            d[dof + x] = ((d[dof + x] as u32 + f(s, so + x, dw) + 1) >> 1) as u8;
        }
    }
}

/// AAN integer IDCT on premultiplied coefficients (pl_mpeg).
fn idct(b: &mut [i32; 64]) {
    for i in 0..8 {
        let b1 = b[32 + i];
        let b3 = b[16 + i] + b[48 + i];
        let b4 = b[40 + i] - b[24 + i];
        let tmp1 = b[8 + i] + b[56 + i];
        let tmp2 = b[24 + i] + b[40 + i];
        let b6 = b[8 + i] - b[56 + i];
        let b7 = tmp1 + tmp2;
        let m0 = b[i];
        let x4 = ((b6 * 473 - b4 * 196 + 128) >> 8) - b7;
        let x0 = x4 - (((tmp1 - tmp2) * 362 + 128) >> 8);
        let x1 = m0 - b1;
        let x2 = (((b[16 + i] - b[48 + i]) * 362 + 128) >> 8) - b3;
        let x3 = m0 + b1;
        let y3 = x1 + x2;
        let y4 = x3 + b3;
        let y5 = x1 - x2;
        let y6 = x3 - b3;
        let y7 = -x0 - ((b4 * 473 + b6 * 196 + 128) >> 8);
        b[i] = b7 + y4;
        b[8 + i] = x4 + y3;
        b[16 + i] = y5 - x0;
        b[24 + i] = y6 - y7;
        b[32 + i] = y6 + y7;
        b[40 + i] = x0 + y5;
        b[48 + i] = y3 - x4;
        b[56 + i] = y4 - b7;
    }
    for i in (0..64).step_by(8) {
        let b1 = b[4 + i];
        let b3 = b[2 + i] + b[6 + i];
        let b4 = b[5 + i] - b[3 + i];
        let tmp1 = b[1 + i] + b[7 + i];
        let tmp2 = b[3 + i] + b[5 + i];
        let b6 = b[1 + i] - b[7 + i];
        let b7 = tmp1 + tmp2;
        let m0 = b[i];
        let x4 = ((b6 * 473 - b4 * 196 + 128) >> 8) - b7;
        let x0 = x4 - (((tmp1 - tmp2) * 362 + 128) >> 8);
        let x1 = m0 - b1;
        let x2 = (((b[2 + i] - b[6 + i]) * 362 + 128) >> 8) - b3;
        let x3 = m0 + b1;
        let y3 = x1 + x2;
        let y4 = x3 + b3;
        let y5 = x1 - x2;
        let y6 = x3 - b3;
        let y7 = -x0 - ((b4 * 473 + b6 * 196 + 128) >> 8);
        b[i] = (b7 + y4 + 128) >> 8;
        b[1 + i] = (x4 + y3 + 128) >> 8;
        b[2 + i] = (y5 - x0 + 128) >> 8;
        b[3 + i] = (y6 - y7 + 128) >> 8;
        b[4 + i] = (y6 + y7 + 128) >> 8;
        b[5 + i] = (x0 + y5 + 128) >> 8;
        b[6 + i] = (y3 - x4 + 128) >> 8;
        b[7 + i] = (y4 - b7 + 128) >> 8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idct_dc_only() {
        let mut b = [0i32; 64];
        // DC 1024 premultiplied by 32 (≈ 128 per pixel after the IDCT scaling).
        b[0] = 128 << 8;
        idct(&mut b);
        assert!(b.iter().all(|&v| (v - 128).abs() <= 1), "{b:?}");
    }

    #[test]
    fn garbage_never_panics() {
        let mut d = Decoder::new();
        let mut v = vec![0, 0, 1, 0xB3, 0x01, 0x40, 0xF0, 0x14, 0xFF, 0xFF, 0xE0, 0x18];
        v.extend(vec![0; 128]);
        for k in 0..20u32 {
            v.extend([0, 0, 1, 0x00, (k >> 2) as u8, ((k as u8 & 3) << 6) | (((k % 3) as u8 + 1) << 3), 0xFF, 0xFF, 0xF8]);
            v.extend([0, 0, 1, 0x01]);
            v.extend((0..900u32).map(|i| (i.wrapping_mul(2654435761).wrapping_add(k) >> 13) as u8));
        }
        d.push(&v);
        d.end();
        let mut out = Vec::new();
        let mut n = 0;
        while let Ok(Some(o)) = d.decode() {
            d.rgba(o.slot, &mut out);
            assert_eq!(out.len(), 20 * 240 * 4);
            n += 1;
            assert!(n < 100);
        }
        assert_eq!(d.width, 20);
    }
}
