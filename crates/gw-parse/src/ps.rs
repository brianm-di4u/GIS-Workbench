//! MPEG program stream demultiplexer (FC-22, REQ-FMT-52; ISO/IEC 11172-1 and 13818-1 §2.5):
//! MPEG-1 and MPEG-2 pack headers (SCR), the system header, the program stream map, PES packets of
//! video, audio and private streams with PTS/DTS (33-bit, unwrapped), KLV in private stream 1 or
//! the metadata stream (0xFC), and an index of the video access units (one per coded frame) with
//! their file offset, picture type, temporal reference and presentation time, for seeking.
//! A bare video elementary stream (`.m1v`, `.m2v`: the file starts with a sequence header) is
//! indexed the same way.
//!
//! Like the transport-stream demuxer the index is fed contiguous blocks (`File.slice`) and keeps
//! only what the index needs; `extract_es` returns the elementary-stream bytes of one stream in a
//! byte range, to feed the video decoder from a keyframe.

use crate::klv;
use crate::ts::{au_cells, parse_pts, KlvRec};
use gw_abi::{Error, Json, Result};
use std::collections::HashMap;

const MAX_STREAMS: usize = 64;
const MAX_PICS: usize = 4_000_000;
const MAX_KLV: usize = 2_000_000;
const MAX_ERRORS: usize = 50;

/// Program stream map entry: stream type and whether a `KLVA` registration or metadata
/// descriptor marks it as KLV.
#[derive(Clone, Copy, Debug, Default)]
struct MapEntry {
    stream_type: u8,
    klva: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Video,
    Audio,
    Klv,
    Private,
    Other,
}

#[derive(Clone, Debug)]
pub struct PsStream {
    /// Stream id; private stream 1 substreams are `0xBD00 | substream`.
    pub id: u32,
    pub kind: Kind,
    pub stream_type: u8,
    pub packets: u64,
    pub bytes: u64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Seq {
    pub width: u32,
    pub height: u32,
    pub aspect: u8,
    pub rate_code: u8,
    pub bit_rate: u32,
    pub mpeg2: bool,
    pub rate_n: u8,
    pub rate_d: u8,
    pub progressive: bool,
}

impl Seq {
    pub fn fps(&self) -> f64 {
        const R: [f64; 9] = [0.0, 24000.0 / 1001.0, 24.0, 25.0, 30000.0 / 1001.0, 30.0, 50.0, 60000.0 / 1001.0, 60.0];
        let r = R.get(self.rate_code as usize).copied().unwrap_or(0.0);
        r * (self.rate_n as f64 + 1.0) / (self.rate_d as f64 + 1.0)
    }
}

/// One coded frame (decode order).
#[derive(Clone, Debug)]
pub struct Pic {
    /// File offset of the PES packet (or, for a bare elementary stream, the byte) in which the
    /// picture start code begins.
    pub off: u64,
    /// Position in the elementary stream.
    pub es: u64,
    /// Coded PTS (from the PES header that carries the picture's start).
    pub pts: Option<i64>,
    /// 1 I, 2 P, 3 B, 4 D.
    pub ptype: u8,
    pub tr: u16,
    pub gop: u32,
}

#[derive(Clone, Copy, Debug)]
struct Seg {
    es: u64,
    off: u64,
    pts: Option<i64>,
}

/// One parsed unit of a program stream.
struct Unit {
    off: u64,
    sid: u8,
    /// Payload range inside the block.
    payload: (usize, usize),
    pts: Option<i64>,
    dts: Option<i64>,
}

#[derive(Default)]
pub struct Demux {
    carry: Vec<u8>,
    next: u64,
    started: bool,
    /// A bare video elementary stream (no packs).
    pub es_only: bool,
    pub mpeg2_packs: Option<bool>,
    pub packs: u64,
    pub resyncs: u64,
    pub scr: Option<(u64, u64)>,
    pub mux_rate: u32,
    pub system_header: bool,
    pub psm: bool,
    map: HashMap<u8, MapEntry>,
    pub streams: Vec<PsStream>,
    pub video_sid: Option<u8>,
    pub codec: String,
    pub seq: Option<Seq>,
    /// File offset of the PES packet in which the first sequence header begins.
    pub seq_off: Option<u64>,
    /// ES position of the first sequence or GOP header since the last picture: a picture after
    /// one is entered at that header (a seek then sees the GOP flags and any new matrices).
    hdr_at: Option<u64>,
    // Elementary-stream scan state.
    es_pos: u64,
    pend: Vec<u8>,
    pend_base: u64,
    segs: Vec<Seg>,
    seg_used: Vec<bool>,
    gop: u32,
    field_pending: bool,
    pub closed_gops: u32,
    pub pics: Vec<Pic>,
    pts_state: HashMap<u32, (i64, i64)>,
    last_video_pts: Option<i64>,
    last_video_dts: Option<i64>,
    pub klv: Vec<KlvRec>,
    pub errors: Vec<String>,
}

fn scr_of(b: &[u8], mpeg2: bool) -> u64 {
    if mpeg2 {
        (((b[0] as u64 >> 3) & 7) << 30) | ((b[0] as u64 & 3) << 28) | ((b[1] as u64) << 20) | ((b[2] as u64 >> 3) << 15) | ((b[2] as u64 & 3) << 13) | ((b[3] as u64) << 5) | (b[4] as u64 >> 3)
    } else {
        parse_pts(b) as u64
    }
}

/// Is `c` a start code that may begin a unit at the top level of a program stream?
fn top_level(c: u8) -> bool {
    c == 0xBA || c == 0xBB || c == 0xB9 || c >= 0xBC
}

/// Stream ids whose PES packets have no optional header (ISO 13818-1 Table 2-18).
fn plain(sid: u8) -> bool {
    matches!(sid, 0xBC | 0xBE | 0xBF | 0xF0 | 0xF1 | 0xF2 | 0xF8 | 0xFF)
}

/// PES header after the 6-byte prefix → (payload start, PTS, DTS); None when malformed.
fn pes_header(p: &[u8], sid: u8) -> Option<(usize, Option<i64>, Option<i64>)> {
    if plain(sid) {
        return Some((6, None, None));
    }
    let b6 = *p.get(6)?;
    if b6 & 0xC0 == 0x80 {
        // MPEG-2 PES syntax.
        let flags = *p.get(7)? >> 6;
        let hl = *p.get(8)? as usize;
        let pts = if flags & 2 != 0 { p.get(9..14).map(parse_pts) } else { None };
        let dts = if flags == 3 { p.get(14..19).map(parse_pts) } else { None };
        return Some((9 + hl, pts, dts));
    }
    // MPEG-1 syntax: stuffing, optional STD buffer, then PTS / PTS+DTS / 0x0F.
    let mut i = 6;
    let mut n = 0;
    while *p.get(i)? == 0xFF {
        i += 1;
        n += 1;
        if n > 16 {
            return None;
        }
    }
    if *p.get(i)? >> 6 == 1 {
        i += 2;
    }
    let c = *p.get(i)?;
    match c >> 4 {
        2 => Some((i + 5, p.get(i..i + 5).map(parse_pts), None)),
        3 => Some((i + 10, p.get(i..i + 5).map(parse_pts), p.get(i + 5..i + 10).map(parse_pts))),
        _ if c == 0x0F => Some((i + 1, None, None)),
        _ => None,
    }
}

/// Walk the program stream units in `b` (a block at file offset `base`). Calls `f` for every PES
/// packet; returns (bytes consumed, resyncs, packs seen with their type and SCR, system-header
/// flag). A unit cut by the end of the block is left unconsumed unless `at_end`.
fn walk(b: &[u8], base: u64, at_end: bool, mut f: impl FnMut(&Unit, &[u8]), mut pack: impl FnMut(bool, u64, u32), mut other: impl FnMut(u8, u64, &[u8])) -> (usize, u64) {
    let mut i = 0;
    let mut resyncs = 0;
    while i + 4 <= b.len() {
        if !(b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 && top_level(b[i + 3])) {
            // Resync on the next pack header or packet start code.
            let from = i + 1;
            match (from..b.len().saturating_sub(3)).find(|&j| b[j] == 0 && b[j + 1] == 0 && b[j + 2] == 1 && top_level(b[j + 3])) {
                Some(j) => {
                    resyncs += 1;
                    i = j;
                    continue;
                }
                None => {
                    // Keep the last 3 bytes: a start code may straddle the block.
                    let keep = if at_end { b.len() } else { b.len().saturating_sub(3).max(i) };
                    if keep > i {
                        resyncs += 1;
                    }
                    return (keep, resyncs);
                }
            }
        }
        let c = b[i + 3];
        match c {
            0xBA => {
                // Pack header: MPEG-2 ('01' marker) 14 bytes + stuffing, MPEG-1 ('0010') 12 bytes.
                let Some(&m) = b.get(i + 4) else { break };
                let (len, mpeg2) = if m >> 6 == 1 {
                    let Some(&st) = b.get(i + 13) else { break };
                    (14 + (st & 7) as usize, true)
                } else {
                    (12, false)
                };
                if i + len > b.len() {
                    break;
                }
                let scr = scr_of(&b[i + 4..i + 9], mpeg2);
                let rate = if mpeg2 { ((b[i + 10] as u32) << 14) | ((b[i + 11] as u32) << 6) | (b[i + 12] as u32 >> 2) } else { (((b[i + 9] & 0x7F) as u32) << 15) | ((b[i + 10] as u32) << 7) | (b[i + 11] as u32 >> 1) };
                pack(mpeg2, scr, rate);
                i += len;
            }
            0xB9 => {
                i += 4;
            }
            _ => {
                // System header, program stream map or PES packet: 16-bit length.
                if i + 6 > b.len() {
                    break;
                }
                let len = u16::from_be_bytes([b[i + 4], b[i + 5]]) as usize;
                let end = i + 6 + len;
                if end > b.len() {
                    if at_end {
                        // Truncated last packet: use what is there.
                        let p = &b[i..];
                        if c >= 0xBC && c != 0xBC {
                            if let Some((h, pts, dts)) = pes_header(p, c) {
                                if h <= p.len() {
                                    f(&Unit { off: base + i as u64, sid: c, payload: (i + h, b.len()), pts, dts }, b);
                                }
                            }
                        }
                        i = b.len();
                    }
                    break;
                }
                if c == 0xBB || c == 0xBC {
                    other(c, base + i as u64, &b[i..end]);
                } else if let Some((h, pts, dts)) = pes_header(&b[i..end], c) {
                    if i + h <= end {
                        f(&Unit { off: base + i as u64, sid: c, payload: (i + h, end), pts, dts }, b);
                    }
                }
                i = end;
            }
        }
    }
    if at_end {
        i = b.len();
    }
    (i, resyncs)
}

struct Bits<'a> {
    b: &'a [u8],
    p: usize,
}

impl Bits<'_> {
    fn get(&mut self, n: usize) -> u32 {
        let mut v = 0;
        for _ in 0..n {
            let bit = self.b.get(self.p / 8).map_or(0, |c| (c >> (7 - self.p % 8)) & 1);
            v = (v << 1) | bit as u32;
            self.p += 1;
        }
        v
    }
}

impl Demux {
    pub fn new() -> Self {
        Self { codec: String::new(), ..Default::default() }
    }

    fn err(&mut self, s: String) {
        if self.errors.len() < MAX_ERRORS {
            self.errors.push(s);
        }
    }

    /// Feed the next contiguous block, which starts at file offset `base`.
    pub fn push(&mut self, chunk: &[u8], base: u64) -> Result<()> {
        self.feed(chunk, base, false)
    }

    fn feed(&mut self, chunk: &[u8], base: u64, at_end: bool) -> Result<()> {
        if base != self.next {
            return Err(Error::invalid(format!("PS: blocks must be contiguous (expected offset {}, got {base})", self.next)));
        }
        if !self.started && !chunk.is_empty() {
            self.started = true;
            self.es_only = chunk.len() >= 4 && chunk[..4] == [0, 0, 1, 0xB3];
            if self.es_only {
                self.video_sid = Some(0xE0);
                self.streams.push(PsStream { id: 0xE0, kind: Kind::Video, stream_type: 0, packets: 0, bytes: 0 });
            }
        }
        self.next = base + chunk.len() as u64;
        if self.es_only {
            if let Some(s) = self.streams.first_mut() {
                s.bytes += chunk.len() as u64;
            }
            self.video_es(chunk, base, None, true);
            return self.check();
        }
        let start = base - self.carry.len() as u64;
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);
        let mut units: Vec<(u64, u8, usize, usize, Option<i64>, Option<i64>)> = Vec::new();
        let mut packs: Vec<(bool, u64, u32)> = Vec::new();
        let mut others: Vec<(u8, u64, Vec<u8>)> = Vec::new();
        let (used, resyncs) = walk(&buf, start, at_end, |u, _| units.push((u.off, u.sid, u.payload.0, u.payload.1, u.pts, u.dts)), |m, s, r| packs.push((m, s, r)), |c, off, d| others.push((c, off, d.to_vec())));
        self.resyncs += resyncs;
        for (m, s, r) in packs {
            self.packs += 1;
            self.mpeg2_packs.get_or_insert(m);
            self.mux_rate = r;
            self.scr = Some(match self.scr {
                None => (s, s),
                Some((a, _)) => (a, s),
            });
        }
        for (c, off, d) in others {
            if c == 0xBB {
                self.system_header = true;
            } else {
                self.psm_parse(&d, off);
            }
        }
        for (off, sid, a, e, pts, dts) in units {
            self.pes(off, sid, &buf[a..e], pts, dts);
        }
        self.carry = buf[used.min(buf.len())..].to_vec();
        if self.carry.len() > (1 << 20) {
            // No unit boundary in a megabyte: not a program stream here; drop it.
            self.err(format!("PS: no packet start code in 1 MB before offset {}", self.next));
            self.carry.clear();
        }
        self.check()
    }

    fn check(&self) -> Result<()> {
        if self.pics.len() > MAX_PICS || self.klv.len() > MAX_KLV {
            return Err(Error::limit("PS: index too large"));
        }
        Ok(())
    }

    /// Program stream map (ISO 13818-1 §2.5.4): stream types and KLV registrations.
    fn psm_parse(&mut self, d: &[u8], off: u64) {
        self.psm = true;
        if d.len() < 16 {
            return;
        }
        let pil = u16::from_be_bytes([d[8], d[9]]) as usize;
        let Some(l) = d.get(10 + pil..12 + pil) else { return };
        let esl = u16::from_be_bytes([l[0], l[1]]) as usize;
        let mut p = 12 + pil;
        let end = (12 + pil + esl).min(d.len().saturating_sub(4));
        while p + 4 <= end {
            let st = d[p];
            let id = d[p + 1];
            let il = u16::from_be_bytes([d[p + 2], d[p + 3]]) as usize;
            let desc = d.get(p + 4..(p + 4 + il).min(end)).unwrap_or(&[]);
            let klva = desc.windows(4).any(|w| w == b"KLVA");
            self.map.insert(id, MapEntry { stream_type: st, klva: klva || st == 0x15 });
            p += 4 + il;
        }
        if p > end + 4 {
            self.err(format!("PS: program stream map at {off} overruns its length"));
        }
    }

    fn stream(&mut self, id: u32, kind: Kind, st: u8) -> Option<usize> {
        if let Some(i) = self.streams.iter().position(|s| s.id == id) {
            return Some(i);
        }
        if self.streams.len() >= MAX_STREAMS {
            return None;
        }
        self.streams.push(PsStream { id, kind, stream_type: st, packets: 0, bytes: 0 });
        Some(self.streams.len() - 1)
    }

    fn unwrap_pts(&mut self, id: u32, raw: i64) -> i64 {
        let (last, mut add) = self.pts_state.get(&id).copied().unwrap_or((raw, 0));
        if raw + add < last - (1 << 32) {
            add += 1 << 33;
        } else if raw + add > last + (1 << 32) && add > 0 {
            add -= 1 << 33;
        }
        let v = raw + add;
        self.pts_state.insert(id, (v, add));
        v
    }

    fn pes(&mut self, off: u64, sid: u8, payload: &[u8], pts: Option<i64>, dts: Option<i64>) {
        let me = self.map.get(&sid).copied().unwrap_or_default();
        let (id, kind) = match sid {
            0xE0..=0xEF => (sid as u32, Kind::Video),
            0xC0..=0xDF => (sid as u32, Kind::Audio),
            0xFC => (sid as u32, Kind::Klv),
            0xBD => {
                let klv = me.klva || payload.starts_with(&[0x06, 0x0E, 0x2B, 0x34]);
                if klv {
                    (0xBD00, Kind::Klv)
                } else {
                    let sub = payload.first().copied().unwrap_or(0);
                    (0xBD00 | sub as u32, Kind::Private)
                }
            }
            _ if me.klva => (sid as u32, Kind::Klv),
            0xBE => return, // padding
            _ => (sid as u32, Kind::Other),
        };
        let Some(si) = self.stream(id, kind, me.stream_type) else { return };
        self.streams[si].packets += 1;
        self.streams[si].bytes += payload.len() as u64;
        let pts = pts.map(|v| self.unwrap_pts(id, v));
        let dts = dts.map(|v| self.unwrap_pts(id | 0x1_0000, v)).or(pts);
        match kind {
            Kind::Video => {
                if self.video_sid.is_none() {
                    self.video_sid = Some(sid);
                }
                if Some(sid) == self.video_sid {
                    if pts.is_some() {
                        self.last_video_pts = pts;
                        self.last_video_dts = dts;
                    }
                    self.video_es(payload, off, pts, false);
                }
            }
            Kind::Klv => {
                let sync = sid == 0xFC || me.stream_type == 0x15;
                let body = if sync { au_cells(payload).unwrap_or_else(|| payload.to_vec()) } else { payload.to_vec() };
                let packets = klv::decode_packets(&body);
                if packets.is_empty() {
                    self.err(format!("PS: KLV packet at {off} holds no SMPTE KLV"));
                }
                self.klv.push(KlvRec { pid: id as u16, pts, mux_pts: self.last_video_pts, mux_dts: self.last_video_dts, off, sync: sync || pts.is_some(), packets });
            }
            _ => {}
        }
    }

    /// Scan the video elementary stream for sequence, GOP and picture headers.
    fn video_es(&mut self, payload: &[u8], off: u64, pts: Option<i64>, es_only: bool) {
        if !es_only {
            self.segs.push(Seg { es: self.es_pos, off, pts });
            self.seg_used.push(false);
        }
        if self.pend.is_empty() {
            self.pend_base = self.es_pos;
        }
        self.es_pos += payload.len() as u64;
        self.pend.extend_from_slice(payload);
        let mut i = 0;
        let n = self.pend.len();
        // Headers need at most 12 bytes after the start code.
        while i + 3 < n {
            let b = &self.pend;
            if !(b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1) {
                i += 1;
                continue;
            }
            if i + 16 > n {
                break;
            }
            let code = b[i + 3];
            let h: [u8; 12] = b[i + 4..i + 16].try_into().unwrap_or([0; 12]);
            let at = self.pend_base + i as u64;
            self.start_code(code, &h, at);
            i += 4;
        }
        let keep = i.min(n);
        self.pend.drain(..keep);
        self.pend_base += keep as u64;
        // Drop segments wholly before the pending bytes (and the pending header).
        let keep_from = self.hdr_at.map_or(self.pend_base, |h| h.min(self.pend_base));
        while self.segs.len() > 1 && self.segs[1].es <= keep_from {
            self.segs.remove(0);
            self.seg_used.remove(0);
        }
    }

    /// The PES (segment) in which ES position `at` lies → (file offset, PTS if not yet used).
    fn seg_at(&mut self, at: u64) -> (u64, Option<i64>) {
        let k = self.segs.iter().rposition(|s| s.es <= at);
        match k {
            Some(k) => {
                let s = self.segs[k];
                let pts = if self.seg_used[k] { None } else { s.pts };
                self.seg_used[k] = true;
                (s.off, pts)
            }
            None => (0, None),
        }
    }

    fn seg_off(&self, at: u64) -> Option<u64> {
        self.segs.iter().rev().find(|s| s.es <= at).map(|s| s.off)
    }

    fn start_code(&mut self, code: u8, h: &[u8; 12], at: u64) {
        match code {
            0xB3 => {
                self.hdr_at.get_or_insert(at);
                let width = ((h[0] as u32) << 4) | (h[1] as u32 >> 4);
                let height = (((h[1] & 0x0F) as u32) << 8) | h[2] as u32;
                let bit_rate = ((h[4] as u32) << 10) | ((h[5] as u32) << 2) | (h[6] as u32 >> 6);
                let prev = self.seq.unwrap_or_default();
                let s = Seq { width, height, aspect: h[3] >> 4, rate_code: h[3] & 0x0F, bit_rate, mpeg2: prev.mpeg2, rate_n: prev.rate_n, rate_d: prev.rate_d, progressive: prev.progressive };
                if self.seq.is_none() {
                    self.codec = "mp1v".into();
                    self.seq_off = Some(if self.es_only { at } else { self.segs.iter().rev().find(|s| s.es <= at).map_or(0, |s| s.off) });
                }
                self.seq = Some(s);
            }
            0xB5 => {
                let id = h[0] >> 4;
                if id == 1 {
                    // Sequence extension: MPEG-2.
                    let mut r = Bits { b: h, p: 4 };
                    let _pl = r.get(8);
                    let prog = r.get(1);
                    let _chroma = r.get(2);
                    let hx = r.get(2);
                    let vx = r.get(2);
                    let _brx = r.get(12);
                    r.get(1);
                    let _vbv = r.get(8);
                    let _low = r.get(1);
                    let n = r.get(2);
                    let d = r.get(5);
                    if let Some(s) = self.seq.as_mut() {
                        if !s.mpeg2 {
                            s.width |= hx << 12;
                            s.height |= vx << 12;
                        }
                        s.mpeg2 = true;
                        s.progressive = prog == 1;
                        s.rate_n = n as u8;
                        s.rate_d = d as u8;
                    }
                    self.codec = "mp2v".into();
                } else if id == 8 {
                    // Picture coding extension: a field picture pairs with the next one.
                    let structure = h[2] & 3;
                    if structure == 1 || structure == 2 {
                        if self.field_pending {
                            // Second field of a frame: same access unit.
                            if let Some(last) = self.pics.pop() {
                                if let Some(prev) = self.pics.last_mut() {
                                    if prev.pts.is_none() {
                                        prev.pts = last.pts;
                                    }
                                }
                            }
                            self.field_pending = false;
                        } else {
                            self.field_pending = true;
                        }
                    } else {
                        self.field_pending = false;
                    }
                }
            }
            0xB8 => {
                self.hdr_at.get_or_insert(at);
                self.gop += 1;
                if h[3] & 0x40 != 0 {
                    self.closed_gops += 1;
                }
            }
            0x00 => {
                if self.seq.is_none() {
                    return; // pictures before the first sequence header cannot be decoded
                }
                let tr = ((h[0] as u16) << 2) | (h[1] as u16 >> 6);
                let ptype = (h[1] >> 3) & 7;
                let from = self.hdr_at.take().unwrap_or(at);
                let (off, pts) = if self.es_only {
                    (from, None)
                } else {
                    let (o, p) = self.seg_at(at);
                    (self.seg_off(from).unwrap_or(o), p)
                };
                self.pics.push(Pic { off, es: at, pts, ptype, tr, gop: self.gop });
            }
            _ => {}
        }
        // H.264 in a program stream: an access-unit delimiter or SPS before any MPEG header.
        if self.seq.is_none() && self.codec.is_empty() && (code & 0x1F == 9 || code & 0x1F == 7) && code & 0x80 == 0 && code < 0x20 {
            self.codec = "avc1".into();
        }
    }

    pub fn finish(&mut self) {
        if !self.es_only && !self.carry.is_empty() {
            let c = std::mem::take(&mut self.carry);
            let base = self.next - c.len() as u64;
            self.next = base;
            let _ = self.feed(&c, base, true);
        }
        // Flush the last pending start codes with zero padding.
        let pad = [0u8; 16];
        let n = self.pend.len();
        if n > 0 {
            let mut tail = std::mem::take(&mut self.pend);
            tail.extend_from_slice(&pad);
            let mut i = 0;
            while i + 3 < n {
                if tail[i] == 0 && tail[i + 1] == 0 && tail[i + 2] == 1 {
                    let h: [u8; 12] = tail[i + 4..i + 16].try_into().unwrap_or([0; 12]);
                    let at = self.pend_base + i as u64;
                    self.start_code(tail[i + 3], &h, at);
                    i += 4;
                } else {
                    i += 1;
                }
            }
        }
    }

    /// Presentation time of every picture (90 kHz): the coded PTS where present, otherwise the
    /// GOP's base (from a coded PTS in it, or the previous GOP's end) plus temporal_reference.
    pub fn times(&self) -> Vec<i64> {
        let fps = self.seq.map(|s| s.fps()).filter(|f| *f > 0.0).unwrap_or(30.0);
        let dur = 90000.0 / fps;
        let mut out = vec![0i64; self.pics.len()];
        let mut i = 0;
        let mut next_base: Option<f64> = None;
        while i < self.pics.len() {
            let g = self.pics[i].gop;
            let mut j = i;
            while j < self.pics.len() && self.pics[j].gop == g {
                j += 1;
            }
            let base = self.pics[i..j].iter().find_map(|p| p.pts.map(|t| t as f64 - p.tr as f64 * dur)).or(next_base).unwrap_or(0.0);
            let max_tr = self.pics[i..j].iter().map(|p| p.tr).max().unwrap_or(0);
            let count = (j - i) as f64;
            for k in i..j {
                let p = &self.pics[k];
                out[k] = p.pts.unwrap_or_else(|| (base + p.tr as f64 * dur).round() as i64);
            }
            next_base = Some(base + (max_tr as f64 + 1.0).max(count) * dur);
            i = j;
        }
        out
    }

    pub fn to_json(&self) -> String {
        let mut j = Json::new();
        j.obj().kv_str("container", if self.es_only { "es" } else { "ps" }).kv_num("bytes", self.next as f64).kv_num("packs", self.packs as f64).kv_num("resyncs", self.resyncs as f64);
        match self.mpeg2_packs {
            Some(m) => j.kv_int("mpeg", if m { 2 } else { 1 }),
            None => j.key("mpeg").null(),
        };
        j.kv_bool("systemHeader", self.system_header).kv_bool("psm", self.psm).kv_int("muxRate", self.mux_rate as i64 * 50);
        if let Some((a, b)) = self.scr {
            j.key("scr").arr().num(a as f64).num(b as f64).end_arr();
        }
        j.key("streams").arr();
        for s in &self.streams {
            let kind = match s.kind {
                Kind::Video => "video",
                Kind::Audio => "audio",
                Kind::Klv => "klv",
                Kind::Private => "private",
                Kind::Other => "other",
            };
            j.obj().kv_int("pid", s.id as i64).kv_str("kind", kind).kv_int("type", s.stream_type as i64).kv_num("packets", s.packets as f64).kv_num("bytes", s.bytes as f64).end_obj();
        }
        j.end_arr();
        j.key("video").obj();
        match self.video_sid {
            Some(p) => j.kv_int("pid", p as i64),
            None => j.key("pid").null(),
        };
        j.kv_str("codec", &self.codec);
        if let Some(o) = self.seq_off {
            j.kv_num("seqOff", o as f64);
        }
        if let Some(s) = self.seq {
            j.kv_int("width", s.width as i64).kv_int("height", s.height as i64).kv_num("fps", (s.fps() * 1000.0).round() / 1000.0).kv_int("aspect", s.aspect as i64).kv_num("bitRate", s.bit_rate as f64 * 400.0).kv_bool("mpeg2", s.mpeg2);
        }
        let times = self.times();
        j.kv_int("count", self.pics.len() as i64).kv_int("gops", self.gop as i64).kv_int("closedGops", self.closed_gops as i64);
        j.key("pts").arr();
        for t in &times {
            j.num(*t as f64);
        }
        j.end_arr().key("coded").arr();
        for (i, p) in self.pics.iter().enumerate() {
            if p.pts.is_some() {
                j.int(i as i64);
            }
        }
        j.end_arr().key("off").arr();
        for p in &self.pics {
            j.num(p.off as f64);
        }
        j.end_arr().key("es").arr();
        for p in &self.pics {
            j.num(p.es as f64);
        }
        j.end_arr().key("size").arr();
        for (i, p) in self.pics.iter().enumerate() {
            let next = self.pics.get(i + 1).map_or(self.es_pos, |q| q.es);
            j.num(next.saturating_sub(p.es) as f64);
        }
        j.end_arr().key("types").str(&self.pics.iter().map(|p| match p.ptype {
            1 => 'I',
            2 => 'P',
            3 => 'B',
            4 => 'D',
            _ => '?',
        }).collect::<String>());
        j.key("key").arr();
        for (i, p) in self.pics.iter().enumerate() {
            if p.ptype == 1 {
                j.int(i as i64);
            }
        }
        j.end_arr().key("sei").arr().end_arr().end_obj();
        j.key("klv").arr();
        for k in &self.klv {
            j.obj().kv_int("pid", k.pid as i64);
            for (name, v) in [("pts", k.pts), ("muxPts", k.mux_pts), ("muxDts", k.mux_dts)] {
                match v {
                    Some(p) => j.kv_num(name, p as f64),
                    None => j.key(name).null(),
                };
            }
            j.kv_num("off", k.off as f64).kv_bool("sync", k.sync).key("packets").arr();
            for p in &k.packets {
                klv::packet_json(&mut j, p, 0);
            }
            j.end_arr().end_obj();
        }
        j.end_arr();
        j.key("errors").arr();
        for e in &self.errors {
            j.str(e);
        }
        j.end_arr().end_obj();
        j.finish()
    }
}

/// Elementary-stream bytes of stream `sid` (0xBD00 | sub for a private substream; any id for a
/// bare elementary stream) in a block at file offset `base` → (bytes, file offset after the last
/// complete unit, [(file offset, PTS, ES length)] per packet). `at_end`: the block ends the file.
pub fn extract_es(b: &[u8], base: u64, sid: u32, at_end: bool) -> (Vec<u8>, u64, Vec<(u64, Option<i64>, usize)>) {
    if sid == 0 {
        return (b.to_vec(), base + b.len() as u64, vec![(base, None, b.len())]);
    }
    let mut data = Vec::new();
    let mut idx = Vec::new();
    let (used, _) = walk(
        b,
        base,
        at_end,
        |u, buf| {
            let p = &buf[u.payload.0..u.payload.1];
            let hit = if sid > 0xFF { u.sid == 0xBD && (sid == 0xBD00 && p.starts_with(&[0x06, 0x0E, 0x2B, 0x34]) || p.first().map(|&s| 0xBD00 | s as u32) == Some(sid)) } else { u.sid as u32 == sid };
            if hit {
                idx.push((u.off, u.pts, p.len()));
                data.extend_from_slice(p);
            }
        },
        |_, _, _| {},
        |_, _, _| {},
    );
    (data, base + used as u64, idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pts_bytes(pts: i64, marker: u8) -> [u8; 5] {
        [(marker << 4) | (((pts >> 29) & 0x0E) as u8) | 1, (pts >> 22) as u8, (((pts >> 14) & 0xFE) as u8) | 1, (pts >> 7) as u8, (((pts << 1) & 0xFE) as u8) | 1]
    }

    fn pack1(scr: i64) -> Vec<u8> {
        let mut v = vec![0, 0, 1, 0xBA];
        let mut s = pts_bytes(scr, 2);
        s[0] = 0x21 | (s[0] & 0x0E);
        v.extend(s);
        v.extend([0x80, 0x1B, 0x83]);
        v
    }

    fn pack2(scr: u64) -> Vec<u8> {
        let mut v = vec![0, 0, 1, 0xBA];
        v.push(0x44 | (((scr >> 30) & 7) << 3) as u8 | ((scr >> 28) & 3) as u8);
        v.push((scr >> 20) as u8);
        v.push(((((scr >> 15) & 0x1F) << 3) as u8) | 0x04 | ((scr >> 13) & 3) as u8);
        v.push((scr >> 5) as u8);
        v.push((((scr & 0x1F) << 3) as u8) | 0x04);
        v.extend([0x01, 0x89, 0xC3, 0x03, 0xF8]);
        v
    }

    fn pes1(sid: u8, pts: Option<i64>, body: &[u8]) -> Vec<u8> {
        let mut h = Vec::new();
        match pts {
            Some(p) => h.extend(pts_bytes(p, 2)),
            None => h.push(0x0F),
        }
        let mut v = vec![0, 0, 1, sid];
        v.extend(((h.len() + body.len()) as u16).to_be_bytes());
        v.extend(h);
        v.extend_from_slice(body);
        v
    }

    fn pes2(sid: u8, pts: Option<i64>, body: &[u8]) -> Vec<u8> {
        let mut h = vec![0x81, if pts.is_some() { 0x80 } else { 0 }, if pts.is_some() { 5 } else { 0 }];
        if let Some(p) = pts {
            h.extend(pts_bytes(p, 2));
        }
        let mut v = vec![0, 0, 1, sid];
        v.extend(((h.len() + body.len()) as u16).to_be_bytes());
        v.extend(h);
        v.extend_from_slice(body);
        v
    }

    /// An MPEG-1 video ES: sequence header, GOP, then I B B P pictures (decode order).
    fn es(mpeg2: bool) -> Vec<u8> {
        let mut v = vec![0, 0, 1, 0xB3, 0x14, 0x00, 0xF0, 0x14, 0xFF, 0xFF, 0xE0, 0x18];
        if mpeg2 {
            v.extend([0, 0, 1, 0xB5, 0x14, 0x8A, 0x00, 0x01, 0x00, 0x00]);
        }
        v.extend([0, 0, 1, 0xB8, 0x00, 0x08, 0x00, 0x40]);
        for (tr, t) in [(0u16, 1u8), (3, 2), (1, 3), (2, 3)] {
            v.extend([0, 0, 1, 0x00, (tr >> 2) as u8, ((tr as u8 & 3) << 6) | (t << 3), 0xFF, 0xF8]);
            v.extend([0, 0, 1, 0x01, 0x12]);
            v.extend(vec![0x5A; 300]);
        }
        v.extend([0, 0, 1, 0xB7]);
        v
    }

    #[test]
    fn mpeg1_program_stream_index() {
        let es = es(false);
        let mut ps = Vec::new();
        // System header.
        ps.extend(pack1(0));
        ps.extend([0, 0, 1, 0xBB, 0, 6, 0x80, 0x1B, 0x83, 0x04, 0xE1, 0xFF]);
        // Video in 200-byte PES; PTS on the packets where pictures start (first only, plus one more).
        let ptss = [Some(9000i64), None, Some(9000 + 3 * 3003), None, None, None, None];
        for (k, c) in es.chunks(200).enumerate() {
            ps.extend(pack1(1000 * k as i64));
            ps.extend(pes1(0xE0, ptss.get(k).copied().flatten(), c));
        }
        // Async KLV in private stream 1.
        let pkt = klv::encode_uas(&[(2, 1_761_436_800_000_000u64.to_be_bytes().to_vec()), (65, vec![17])]);
        ps.extend(pack1(9000));
        ps.extend(pes1(0xBD, Some(9000), &pkt));
        ps.extend([0, 0, 1, 0xB9]);
        let mut d = Demux::new();
        let mut off = 0;
        for c in ps.chunks(333) {
            d.push(c, off as u64).unwrap();
            off += c.len();
        }
        d.finish();
        assert_eq!(d.codec, "mp1v");
        assert_eq!(d.mpeg2_packs, Some(false));
        assert!(d.system_header);
        let s = d.seq.unwrap();
        assert_eq!((s.width, s.height), (320, 240));
        assert!((s.fps() - 29.97).abs() < 0.01);
        assert_eq!(d.pics.len(), 4);
        assert_eq!(d.pics.iter().map(|p| p.ptype).collect::<Vec<_>>(), vec![1, 2, 3, 3]);
        let t = d.times();
        assert_eq!(t[0], 9000);
        // tr-based: P (tr 3) = 9000 + 3 frames; B tr 1 and 2 between.
        assert_eq!(t[2], 9000 + 3003);
        assert_eq!(t[1], 9000 + 3 * 3003);
        assert_eq!(d.klv.len(), 1);
        assert_eq!(d.klv[0].packets.len(), 1);
        assert_eq!(d.klv[0].packets[0].checksum_ok, Some(true));
        let js = d.to_json();
        assert!(js.contains("\"types\":\"IPBB\""));
        assert!(js.contains("\"kind\":\"klv\""));
        // Extraction from the first picture's packet returns the ES from there.
        let (data, next, idx) = extract_es(&ps, 0, 0xE0, true);
        assert_eq!(data, es);
        assert_eq!(next, ps.len() as u64);
        assert_eq!(idx.len(), es.chunks(200).count());
        // A block cut mid-packet stops at the last complete one.
        let (_, next, _) = extract_es(&ps[..500], 0, 0xE0, false);
        assert!(next < 500 && next > 0);
        let (k, _, _) = extract_es(&ps, 0, 0xBD00, true);
        assert_eq!(k, pkt);
    }

    #[test]
    fn mpeg2_program_stream_and_es() {
        let es = es(true);
        let mut ps = Vec::new();
        for (k, c) in es.chunks(2000).enumerate() {
            ps.extend(pack2(300 * k as u64));
            ps.extend(pes2(0xE0, if k == 0 { Some(90000) } else { None }, c));
        }
        let mut d = Demux::new();
        d.push(&ps, 0).unwrap();
        d.finish();
        assert_eq!(d.codec, "mp2v");
        assert_eq!(d.mpeg2_packs, Some(true));
        assert_eq!(d.pics.len(), 4);
        assert!(d.seq.unwrap().mpeg2);
        // Bare elementary stream.
        let mut d = Demux::new();
        for (k, c) in es.chunks(100).enumerate() {
            d.push(c, (k * 100) as u64).unwrap();
        }
        d.finish();
        assert!(d.es_only);
        assert_eq!(d.pics.len(), 4);
        assert_eq!(d.pics[1].off, d.pics[1].es);
    }

    #[test]
    fn garbage_and_truncation() {
        let junk: Vec<u8> = (0..20000u32).map(|i| (i * 7 % 251) as u8).collect();
        let mut d = Demux::new();
        d.push(&junk, 0).unwrap();
        d.finish();
        assert!(d.pics.is_empty());
        let es = es(false);
        let mut ps = pack1(0);
        ps.extend(pes1(0xE0, Some(0), &es));
        for cut in [5, 13, 20, 40, ps.len() - 7] {
            let mut d = Demux::new();
            d.push(&ps[..cut], 0).unwrap();
            d.finish();
            let _ = d.to_json();
            let _ = extract_es(&ps[..cut], 0, 0xE0, true);
        }
    }
}
