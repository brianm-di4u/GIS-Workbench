//! MPEG-2 transport stream demux and index (REQ-FMV-01; `Research/12` §4, §11.1): PAT, PMT,
//! PES with 33-bit PTS/DTS (unwrapped), synchronous KLV in metadata AU cells (stream type 0x15)
//! and asynchronous KLV (0x06 with a `KLVA` registration or metadata descriptor), H.264/H.265
//! access-unit index with keyframes, the SPS codec string and size, and ST 0604
//! `MISPmicrosectime` SEI time stamps.
//!
//! The demuxer is fed contiguous blocks of the file (`File.slice`) and keeps only what the index
//! needs: the first bytes of each video PES (NAL headers, SPS, SEI) and whole KLV PES.

use crate::klv;
use gw_abi::{Error, Json, Result};
use std::collections::HashMap;

pub const PACKET: usize = 188;
const VIDEO_KEEP: usize = 64 * 1024;
const KLV_KEEP: usize = 4 * 1024 * 1024;
const MAX_STREAMS: usize = 64;
const MAX_AUS: usize = 4_000_000;
const MAX_KLV: usize = 2_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamKind {
    H264,
    H265,
    H262,
    KlvSync,
    KlvAsync,
    Audio,
    Other,
}

#[derive(Clone, Debug)]
pub struct Stream {
    pub pid: u16,
    pub stream_type: u8,
    pub kind: StreamKind,
    pub registration: String,
    pub metadata_descriptor: bool,
}

#[derive(Default)]
struct PesBuf {
    off: u64,
    data: Vec<u8>,
    total: usize,
}

#[derive(Clone, Debug)]
pub struct Au {
    pub pts: Option<i64>,
    pub off: u64,
    pub size: usize,
    pub key: bool,
    pub sei_time: Option<u64>,
}

pub struct KlvRec {
    pub pid: u16,
    pub pts: Option<i64>,
    /// PTS of the latest video PES before this one in the multiplex (async KLV timing).
    pub mux_pts: Option<i64>,
    /// DTS of that video PES (the multiplex clock; PTS when the PES carries no DTS).
    pub mux_dts: Option<i64>,
    pub off: u64,
    pub sync: bool,
    pub packets: Vec<klv::Packet>,
}

#[derive(Default)]
pub struct Demux {
    carry: Vec<u8>,
    next: u64,
    pmt_pids: Vec<u16>,
    pub streams: Vec<Stream>,
    pes: HashMap<u16, PesBuf>,
    cc: HashMap<u16, u8>,
    pts_state: HashMap<u16, (i64, i64)>,
    pub video_pid: Option<u16>,
    pub codec: String,
    pub size: Option<(u32, u32)>,
    pub aus: Vec<Au>,
    pub klv: Vec<KlvRec>,
    last_video_pts: Option<i64>,
    last_video_dts: Option<i64>,
    pub packets: u64,
    pub resyncs: u64,
    pub cc_errors: u64,
    pub pcr: Option<(u64, u64)>,
    pub errors: Vec<String>,
}

fn parse_pts(b: &[u8]) -> i64 {
    (((b[0] as i64 >> 1) & 0x07) << 30) | ((b[1] as i64) << 22) | (((b[2] as i64) >> 1) << 15) | ((b[3] as i64) << 7) | ((b[4] as i64) >> 1)
}

impl Demux {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed the next contiguous block, which starts at file offset `base`.
    pub fn push(&mut self, chunk: &[u8], base: u64) -> Result<()> {
        if base != self.next {
            return Err(Error::invalid(format!("TS: blocks must be contiguous (expected offset {}, got {base})", self.next)));
        }
        let start = base - self.carry.len() as u64;
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(chunk);
        self.next = base + chunk.len() as u64;
        let mut i = 0;
        while i + PACKET <= buf.len() {
            if buf[i] != 0x47 {
                // Resync on two sync bytes one packet apart (or one at the end of the block).
                let found = (i + 1..buf.len()).find(|&j| buf[j] == 0x47 && (j + PACKET >= buf.len() || buf[j + PACKET] == 0x47));
                self.resyncs += 1;
                match found {
                    Some(j) => {
                        i = j;
                        continue;
                    }
                    None => {
                        i = buf.len();
                        break;
                    }
                }
            }
            if i + PACKET > buf.len() {
                break;
            }
            let pkt: [u8; PACKET] = buf[i..i + PACKET].try_into().unwrap();
            self.packet(&pkt, start + i as u64);
            i += PACKET;
        }
        self.carry = buf[i.min(buf.len())..].to_vec();
        if self.aus.len() > MAX_AUS || self.klv.len() > MAX_KLV {
            return Err(Error::limit("TS: index too large"));
        }
        Ok(())
    }

    fn packet(&mut self, p: &[u8; PACKET], off: u64) {
        self.packets += 1;
        let tei = p[1] & 0x80 != 0;
        let pusi = p[1] & 0x40 != 0;
        let pid = (((p[1] & 0x1F) as u16) << 8) | p[2] as u16;
        let afc = (p[3] >> 4) & 3;
        let cc = p[3] & 0x0F;
        if tei || pid == 0x1FFF {
            return;
        }
        let mut pos = 4;
        if afc == 2 || afc == 3 {
            let al = p[4] as usize;
            if al > 0 && 5 + al <= PACKET && p[5] & 0x10 != 0 && al >= 7 {
                let b = &p[6..12];
                let base = ((b[0] as u64) << 25) | ((b[1] as u64) << 17) | ((b[2] as u64) << 9) | ((b[3] as u64) << 1) | ((b[4] as u64) >> 7);
                self.pcr = Some(match self.pcr {
                    None => (base, base),
                    Some((f, _)) => (f, base),
                });
            }
            pos = 5 + al;
        }
        if afc == 0 || afc == 2 || pos >= PACKET {
            return;
        }
        if let Some(&last) = self.cc.get(&pid) {
            if cc != last && cc != (last + 1) & 0x0F {
                self.cc_errors += 1;
            }
        }
        self.cc.insert(pid, cc);
        let payload = &p[pos..];
        if pid == 0 {
            if pusi {
                self.pat(payload);
            }
            return;
        }
        if self.pmt_pids.contains(&pid) {
            if pusi {
                self.pmt(payload);
            }
            return;
        }
        let Some(kind) = self.kind_of(pid) else { return };
        if matches!(kind, StreamKind::Audio | StreamKind::Other) {
            return;
        }
        if pusi {
            if let Some(prev) = self.pes.remove(&pid) {
                self.finish_pes(pid, prev);
            }
            self.pes.insert(pid, PesBuf { off, data: Vec::new(), total: 0 });
        }
        let keep = if matches!(kind, StreamKind::KlvSync | StreamKind::KlvAsync) { KLV_KEEP } else { VIDEO_KEEP };
        if let Some(pb) = self.pes.get_mut(&pid) {
            pb.total += payload.len();
            if pb.data.len() < keep {
                let n = payload.len().min(keep - pb.data.len());
                pb.data.extend_from_slice(&payload[..n]);
            }
        }
    }

    fn kind_of(&self, pid: u16) -> Option<StreamKind> {
        self.streams.iter().find(|s| s.pid == pid).map(|s| s.kind)
    }

    fn section<'a>(&self, payload: &'a [u8]) -> Option<&'a [u8]> {
        let ptr = *payload.first()? as usize;
        let s = payload.get(1 + ptr..)?;
        if s.len() < 3 {
            return None;
        }
        let len = (((s[1] & 0x0F) as usize) << 8) | s[2] as usize;
        s.get(..3 + len)
    }

    fn pat(&mut self, payload: &[u8]) {
        let Some(s) = self.section(payload) else { return };
        if s[0] != 0x00 || s.len() < 12 {
            return;
        }
        let body = &s[8..s.len() - 4];
        for e in body.chunks_exact(4) {
            let prog = u16::from_be_bytes([e[0], e[1]]);
            let pid = (((e[2] & 0x1F) as u16) << 8) | e[3] as u16;
            if prog != 0 && !self.pmt_pids.contains(&pid) && self.pmt_pids.len() < MAX_STREAMS {
                self.pmt_pids.push(pid);
            }
        }
    }

    fn pmt(&mut self, payload: &[u8]) {
        let Some(s) = self.section(payload) else { return };
        if s[0] != 0x02 || s.len() < 16 {
            return;
        }
        let pil = (((s[10] & 0x0F) as usize) << 8) | s[11] as usize;
        let prog_desc = s.get(12..12 + pil).unwrap_or(&[]);
        let prog_klv = descriptors(prog_desc).iter().any(|(t, d)| (*t == 0x25 || *t == 0x26 || *t == 0x05) && contains(d, b"KLVA"));
        let mut p = 12 + pil;
        let end = s.len() - 4;
        while p + 5 <= end {
            let st = s[p];
            let pid = (((s[p + 1] & 0x1F) as u16) << 8) | s[p + 2] as u16;
            let il = (((s[p + 3] & 0x0F) as usize) << 8) | s[p + 4] as usize;
            let d = s.get(p + 5..(p + 5 + il).min(end)).unwrap_or(&[]);
            p += 5 + il;
            let ds = descriptors(d);
            let registration = ds.iter().find(|(t, _)| *t == 0x05).map(|(_, v)| String::from_utf8_lossy(&v[..v.len().min(4)]).to_string()).unwrap_or_default();
            let meta = ds.iter().any(|(t, v)| *t == 0x26 && (contains(v, b"KLVA") || v.len() >= 2));
            let klva = registration == "KLVA" || ds.iter().any(|(t, v)| *t == 0x26 && contains(v, b"KLVA"));
            let kind = match st {
                0x1B => StreamKind::H264,
                0x24 => StreamKind::H265,
                0x01 | 0x02 => StreamKind::H262,
                0x15 => StreamKind::KlvSync,
                0x06 if klva || meta || prog_klv => StreamKind::KlvAsync,
                0x03 | 0x04 | 0x0F | 0x11 | 0x81 | 0x87 => StreamKind::Audio,
                _ => StreamKind::Other,
            };
            if self.streams.iter().any(|x| x.pid == pid) || self.streams.len() >= MAX_STREAMS {
                continue;
            }
            if self.video_pid.is_none() && matches!(kind, StreamKind::H264 | StreamKind::H265 | StreamKind::H262) {
                self.video_pid = Some(pid);
                self.codec = match kind {
                    StreamKind::H264 => "avc1".into(),
                    StreamKind::H265 => "hvc1".into(),
                    _ => "mp2v".into(),
                };
            }
            self.streams.push(Stream { pid, stream_type: st, kind, registration, metadata_descriptor: meta });
        }
    }

    fn unwrap_pts(&mut self, pid: u16, raw: i64) -> i64 {
        let (last, add) = self.pts_state.get(&pid).copied().unwrap_or((raw, 0));
        let mut add = add;
        if raw + add < last - (1 << 32) {
            add += 1 << 33;
        } else if raw + add > last + (1 << 32) && add > 0 {
            add -= 1 << 33;
        }
        let v = raw + add;
        self.pts_state.insert(pid, (v, add));
        v
    }

    fn finish_pes(&mut self, pid: u16, pb: PesBuf) {
        let d = &pb.data;
        if d.len() < 9 || d[0] != 0 || d[1] != 0 || d[2] != 1 {
            if self.errors.len() < 50 {
                self.errors.push(format!("PID {pid}: PES at {} has no start code", pb.off));
            }
            return;
        }
        let sid = d[3];
        let (pts, dts, body) = if matches!(sid, 0xBC | 0xBE | 0xBF | 0xF0 | 0xF1 | 0xFF | 0xF2 | 0xF8) {
            (None, None, &d[6..])
        } else {
            let flags = d[7] >> 6;
            let hl = d[8] as usize;
            let pts = if flags & 2 != 0 && d.len() >= 14 { Some(parse_pts(&d[9..14])) } else { None };
            let dts = if flags == 3 && d.len() >= 19 { Some(parse_pts(&d[14..19])) } else { None };
            (pts, dts, d.get(9 + hl..).unwrap_or(&[]))
        };
        let pts = pts.map(|v| self.unwrap_pts(pid, v));
        let dts = dts.map(|v| self.unwrap_pts(pid, v)).or(pts);
        let kind = self.kind_of(pid).unwrap_or(StreamKind::Other);
        match kind {
            StreamKind::H264 | StreamKind::H265 | StreamKind::H262 if Some(pid) == self.video_pid => {
                let (key, sei) = self.scan_nals(body, kind);
                if pts.is_some() {
                    self.last_video_pts = pts;
                    self.last_video_dts = dts;
                }
                self.aus.push(Au { pts, off: pb.off, size: pb.total, key, sei_time: sei });
            }
            StreamKind::KlvSync | StreamKind::KlvAsync => {
                let sync = kind == StreamKind::KlvSync || sid == 0xFC;
                let payload = if sync { au_cells(body).unwrap_or_else(|| body.to_vec()) } else { body.to_vec() };
                let packets = klv::decode_packets(&payload);
                self.klv.push(KlvRec { pid, pts, mux_pts: self.last_video_pts, mux_dts: self.last_video_dts, off: pb.off, sync, packets });
            }
            _ => {}
        }
    }

    /// Keyframe flag and ST 0604 time from the NAL units at the start of an access unit.
    fn scan_nals(&mut self, b: &[u8], kind: StreamKind) -> (bool, Option<u64>) {
        let mut key = false;
        let mut sei = None;
        for (s, e) in nal_units(b) {
            let n = &b[s..e];
            if n.is_empty() {
                continue;
            }
            match kind {
                StreamKind::H264 => {
                    let t = n[0] & 0x1F;
                    match t {
                        5 => key = true,
                        7 => {
                            let r = unescape(n);
                            if r.len() >= 4 {
                                self.codec = format!("avc1.{:02x}{:02x}{:02x}", r[1], r[2], r[3]);
                                if self.size.is_none() {
                                    self.size = sps_size_h264(&r[1..]);
                                }
                            }
                        }
                        6 => sei = sei.or_else(|| sei_time(&unescape(&n[1..]))),
                        _ => {}
                    }
                }
                StreamKind::H265 => {
                    let t = (n[0] >> 1) & 0x3F;
                    match t {
                        16..=21 => key = true,
                        33 => {
                            let r = unescape(n);
                            if r.len() >= 15 {
                                let tier = if r[3] & 0x20 != 0 { 'H' } else { 'L' };
                                self.codec = format!("hvc1.{}.4.{}{}.B0", r[3] & 0x1F, tier, r[14]);
                            }
                        }
                        39 => sei = sei.or_else(|| sei_time(&unescape(&n[2.min(n.len())..]))),
                        _ => {}
                    }
                }
                _ => {
                    // H.262: picture start code 0x00 with picture_coding_type I.
                    if n[0] == 0x00 && n.len() > 2 && (n[2] >> 3) & 7 == 1 {
                        key = true;
                    }
                }
            }
        }
        (key, sei)
    }

    pub fn finish(&mut self) {
        let mut pending: Vec<(u16, PesBuf)> = self.pes.drain().collect();
        pending.sort_by_key(|(_, p)| p.off);
        for (pid, pb) in pending {
            self.finish_pes(pid, pb);
        }
    }

    pub fn to_json(&self) -> String {
        let mut j = Json::new();
        j.obj().kv_num("packets", self.packets as f64).kv_num("bytes", self.next as f64).kv_num("resyncs", self.resyncs as f64).kv_num("ccErrors", self.cc_errors as f64);
        j.key("streams").arr();
        for s in &self.streams {
            j.obj().kv_int("pid", s.pid as i64).kv_int("type", s.stream_type as i64).kv_str("kind", kind_name(s.kind)).kv_str("registration", &s.registration).kv_bool("metadataDescriptor", s.metadata_descriptor).end_obj();
        }
        j.end_arr();
        if let Some((a, b)) = self.pcr {
            j.key("pcr").arr().num(a as f64).num(b as f64).end_arr();
        }
        j.key("video").obj();
        match self.video_pid {
            Some(p) => j.kv_int("pid", p as i64),
            None => j.key("pid").null(),
        };
        j.kv_str("codec", &self.codec);
        if let Some((w, h)) = self.size {
            j.kv_int("width", w as i64).kv_int("height", h as i64);
        }
        j.kv_int("count", self.aus.len() as i64);
        j.key("pts").arr();
        for a in &self.aus {
            match a.pts {
                Some(p) => j.num(p as f64),
                None => j.null(),
            };
        }
        j.end_arr().key("off").arr();
        for a in &self.aus {
            j.num(a.off as f64);
        }
        j.end_arr().key("size").arr();
        for a in &self.aus {
            j.num(a.size as f64);
        }
        j.end_arr().key("key").arr();
        for (i, a) in self.aus.iter().enumerate() {
            if a.key {
                j.int(i as i64);
            }
        }
        j.end_arr().key("sei").arr();
        for (i, a) in self.aus.iter().enumerate() {
            if let Some(t) = a.sei_time {
                j.arr().int(i as i64).num(t as f64).end_arr();
            }
        }
        j.end_arr().end_obj();
        j.key("klv").arr();
        for k in &self.klv {
            j.obj().kv_int("pid", k.pid as i64);
            match k.pts {
                Some(p) => j.kv_num("pts", p as f64),
                None => j.key("pts").null(),
            };
            match k.mux_pts {
                Some(p) => j.kv_num("muxPts", p as f64),
                None => j.key("muxPts").null(),
            };
            match k.mux_dts {
                Some(p) => j.kv_num("muxDts", p as f64),
                None => j.key("muxDts").null(),
            };
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

fn kind_name(k: StreamKind) -> &'static str {
    match k {
        StreamKind::H264 => "h264",
        StreamKind::H265 => "h265",
        StreamKind::H262 => "h262",
        StreamKind::KlvSync => "klv-sync",
        StreamKind::KlvAsync => "klv-async",
        StreamKind::Audio => "audio",
        StreamKind::Other => "other",
    }
}

fn contains(h: &[u8], n: &[u8]) -> bool {
    h.windows(n.len()).any(|w| w == n)
}

fn descriptors(mut d: &[u8]) -> Vec<(u8, &[u8])> {
    let mut out = Vec::new();
    while d.len() >= 2 {
        let t = d[0];
        let l = d[1] as usize;
        if 2 + l > d.len() {
            break;
        }
        out.push((t, &d[2..2 + l]));
        d = &d[2 + l..];
    }
    out
}

/// ISO 13818-1 metadata AU cells: 5-byte header (service id, sequence, flags, 16-bit length).
fn au_cells(b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut p = 0;
    while p < b.len() {
        if p + 5 > b.len() {
            return None;
        }
        let len = u16::from_be_bytes([b[p + 3], b[p + 4]]) as usize;
        let s = p + 5;
        if s + len > b.len() {
            return None;
        }
        out.extend_from_slice(&b[s..s + len]);
        p = s + len;
    }
    // Only accept the cell reading when it exposes a SMPTE label.
    if out.len() >= 4 && out[..4] == [0x06, 0x0E, 0x2B, 0x34] {
        Some(out)
    } else {
        None
    }
}

/// Annex B NAL unit ranges (without start codes).
fn nal_units(b: &[u8]) -> Vec<(usize, usize)> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= b.len() {
        if b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (k, &s) in starts.iter().enumerate() {
        let mut e = starts.get(k + 1).map_or(b.len(), |&n| n - 3);
        while e > s && b[e - 1] == 0 {
            e -= 1;
        }
        out.push((s, e));
        if out.len() > 256 {
            break;
        }
    }
    out
}

/// Remove emulation-prevention bytes (00 00 03 → 00 00).
fn unescape(n: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(n.len());
    let mut z = 0;
    for &c in n {
        if z >= 2 && c == 3 {
            z = 0;
            continue;
        }
        z = if c == 0 { z + 1 } else { 0 };
        out.push(c);
    }
    out
}

/// ST 0604 time stamp in an SEI "user data unregistered" message with UUID MISPmicrosectime.
fn sei_time(r: &[u8]) -> Option<u64> {
    let mut p = 0;
    while p < r.len() && r[p] != 0x80 {
        let mut t = 0usize;
        while p < r.len() && r[p] == 0xFF {
            t += 255;
            p += 1;
        }
        t += *r.get(p)? as usize;
        p += 1;
        let mut sz = 0usize;
        while p < r.len() && r[p] == 0xFF {
            sz += 255;
            p += 1;
        }
        sz += *r.get(p)? as usize;
        p += 1;
        let body = r.get(p..p + sz)?;
        p += sz;
        if t == 5 && body.len() >= 16 + 12 && &body[..16] == b"MISPmicrosectime" {
            let x = &body[16..];
            // status, t0 t1 FF t2 t3 FF t4 t5 FF t6 t7
            let v = [x[1], x[2], x[4], x[5], x[7], x[8], x[10], x[11]];
            return Some(u64::from_be_bytes(v));
        }
    }
    None
}

struct Bits<'a> {
    b: &'a [u8],
    p: usize,
}

impl Bits<'_> {
    fn bit(&mut self) -> Option<u32> {
        let v = (*self.b.get(self.p / 8)? >> (7 - self.p % 8)) & 1;
        self.p += 1;
        Some(v as u32)
    }
    fn bits(&mut self, n: usize) -> Option<u32> {
        let mut v = 0;
        for _ in 0..n {
            v = (v << 1) | self.bit()?;
        }
        Some(v)
    }
    fn ue(&mut self) -> Option<u32> {
        let mut z = 0;
        while self.bit()? == 0 {
            z += 1;
            if z > 31 {
                return None;
            }
        }
        Some((1u32 << z) - 1 + self.bits(z)?)
    }
}

/// Coded size from an H.264 SPS (after the NAL header byte); None when scaling lists are present.
fn sps_size_h264(r: &[u8]) -> Option<(u32, u32)> {
    let mut b = Bits { b: r, p: 24 };
    let profile = r[0];
    b.ue()?;
    let mut chroma = 1;
    if matches!(profile, 100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135) {
        chroma = b.ue()?;
        if chroma == 3 {
            b.bit()?;
        }
        b.ue()?;
        b.ue()?;
        b.bit()?;
        if b.bit()? == 1 {
            return None;
        }
    }
    b.ue()?;
    let poc = b.ue()?;
    if poc == 0 {
        b.ue()?;
    } else if poc == 1 {
        b.bit()?;
        b.ue()?;
        b.ue()?;
        let n = b.ue()?;
        for _ in 0..n.min(256) {
            b.ue()?;
        }
    }
    b.ue()?;
    b.bit()?;
    let w = b.ue()? + 1;
    let h = b.ue()? + 1;
    let fmo = b.bit()?;
    if fmo == 0 {
        b.bit()?;
    }
    b.bit()?;
    let (mut cl, mut cr, mut ct, mut cb) = (0, 0, 0, 0);
    if b.bit()? == 1 {
        cl = b.ue()?;
        cr = b.ue()?;
        ct = b.ue()?;
        cb = b.ue()?;
    }
    let (sx, sy) = match chroma {
        0 | 3 => (1, 2 - fmo),
        2 => (2, 2 - fmo),
        _ => (2, 2 * (2 - fmo)),
    };
    let width = (w * 16).checked_sub(sx * (cl + cr))?;
    let height = ((2 - fmo) * h * 16).checked_sub(sy * (ct + cb))?;
    Some((width, height))
}

/// Complete PES packets of `pid` in a block that starts at file offset `base`: their payload
/// bytes back to back, plus (pts, file offset, payload length, keyframe) per PES. Used to feed a
/// video decoder from a keyframe to a target frame.
pub fn extract_pes(b: &[u8], base: u64, pid: u16, at_end: bool) -> (Vec<u8>, Vec<(Option<i64>, u64, usize)>) {
    let mut data = Vec::new();
    let mut index = Vec::new();
    let mut cur: Option<(u64, Vec<u8>)> = None;
    let flush = |c: Option<(u64, Vec<u8>)>, data: &mut Vec<u8>, index: &mut Vec<(Option<i64>, u64, usize)>| {
        if let Some((off, d)) = c {
            if d.len() >= 9 && d[0] == 0 && d[1] == 0 && d[2] == 1 {
                let hl = d[8] as usize;
                let pts = if d[7] & 0x80 != 0 && d.len() >= 14 { Some(parse_pts(&d[9..14])) } else { None };
                if let Some(body) = d.get(9 + hl..) {
                    data.extend_from_slice(body);
                    index.push((pts, off, body.len()));
                }
            }
        }
    };
    let mut i = 0;
    while i + PACKET <= b.len() {
        let p = &b[i..i + PACKET];
        if p[0] != 0x47 {
            i += 1;
            continue;
        }
        let ppid = (((p[1] & 0x1F) as u16) << 8) | p[2] as u16;
        if ppid == pid {
            let pusi = p[1] & 0x40 != 0;
            let afc = (p[3] >> 4) & 3;
            let pos = if afc & 2 != 0 { 5 + p[4] as usize } else { 4 };
            if afc & 1 != 0 && pos < PACKET {
                if pusi {
                    flush(cur.take(), &mut data, &mut index);
                    cur = Some((base + i as u64, Vec::new()));
                }
                if let Some((_, d)) = cur.as_mut() {
                    d.extend_from_slice(&p[pos..]);
                }
            }
        }
        i += PACKET;
    }
    // The last PES is complete when its declared length is met (video PES usually declare 0) or
    // when the block reaches the end of the file.
    if let Some((off, d)) = cur.take() {
        let declared = if d.len() >= 6 { u16::from_be_bytes([d[4], d[5]]) as usize } else { 0 };
        if at_end || (declared > 0 && d.len() >= declared + 6) {
            flush(Some((off, d)), &mut data, &mut index);
        }
    }
    (data, index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts_packet(pid: u16, pusi: bool, cc: u8, payload: &[u8]) -> Vec<u8> {
        let mut p = vec![0x47, ((pusi as u8) << 6) | (pid >> 8) as u8, pid as u8];
        let room = PACKET - 4;
        if payload.len() >= room {
            p.push(0x10 | (cc & 15));
            p.extend_from_slice(&payload[..room]);
        } else {
            // Adaptation field stuffing.
            let al = room - payload.len() - 1;
            p.push(0x30 | (cc & 15));
            p.push(al as u8);
            if al > 0 {
                p.push(0);
                p.extend(std::iter::repeat_n(0xFF, al - 1));
            }
            p.extend_from_slice(payload);
        }
        assert_eq!(p.len(), PACKET);
        p
    }

    fn psi(table: u8, body: &[u8]) -> Vec<u8> {
        let len = body.len() + 5 + 4;
        let mut s = vec![0, table, 0xB0 | (len >> 8) as u8, len as u8, 0, 1, 0xC1, 0, 0];
        s.extend_from_slice(body);
        s.extend([0, 0, 0, 0]);
        s
    }

    fn pts_bytes(pts: i64, marker: u8) -> [u8; 5] {
        [(marker << 4) | (((pts >> 29) & 0x0E) as u8) | 1, (pts >> 22) as u8, (((pts >> 14) & 0xFE) as u8) | 1, (pts >> 7) as u8, (((pts << 1) & 0xFE) as u8) | 1]
    }

    fn pes(sid: u8, pts: i64, body: &[u8], len_field: bool) -> Vec<u8> {
        let mut d = vec![0, 0, 1, sid];
        let l = if len_field { body.len() + 8 } else { 0 };
        d.extend((l as u16).to_be_bytes());
        d.extend([0x80, 0x80, 5]);
        d.extend(pts_bytes(pts, 2));
        d.extend_from_slice(body);
        d
    }

    fn split(pid: u16, data: &[u8], cc: &mut u8) -> Vec<u8> {
        let mut out = Vec::new();
        let mut first = true;
        for c in data.chunks(PACKET - 4) {
            out.extend(ts_packet(pid, first, *cc, c));
            *cc = (*cc + 1) & 15;
            first = false;
        }
        out
    }

    #[test]
    fn demux_sync_klv_and_video() {
        let mut ts = Vec::new();
        ts.extend(ts_packet(0, true, 0, &psi(0x00, &[0, 1, 0xF0, 0x00])));
        // PMT: H.264 on 0x100, sync KLV (0x15) on 0x101 with a metadata descriptor.
        let mut pmt = vec![0xE1, 0x00, 0xF0, 0x00];
        pmt.extend([0x1B, 0xE1, 0x00, 0xF0, 0x00]);
        let md = [0x26, 0x09, 0xFF, 0xFF, b'K', b'L', b'V', b'A', 0xFF, 0x00, 0x0F];
        pmt.extend([0x15, 0xE1, 0x01, 0xF0, md.len() as u8]);
        pmt.extend(md);
        ts.extend(ts_packet(0x1000, true, 0, &psi(0x02, &pmt)));
        let mut sps = vec![0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1E];
        sps.extend([0xAC, 0xD9, 0x40, 0xA0, 0x2F, 0xF9, 0x70, 0x11, 0x00, 0x00, 0x03, 0x00, 0x01]);
        let mut sei = vec![0, 0, 0, 1, 0x06, 0x05, 28];
        sei.extend(b"MISPmicrosectime");
        let t: u64 = 1_761_436_800_000_000;
        let tb = t.to_be_bytes();
        sei.extend([0x1F, tb[0], tb[1], 0xFF, tb[2], tb[3], 0xFF, tb[4], tb[5], 0xFF, tb[6], tb[7], 0x80]);
        let (mut vcc, mut kcc) = (0u8, 0u8);
        for f in 0..3i64 {
            let mut au = vec![0, 0, 0, 1, 0x09, 0xF0];
            if f == 0 {
                au.extend(&sps);
                au.extend(&sei);
                au.extend([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00]);
            } else {
                au.extend([0, 0, 0, 1, 0x41, 0x9A, 0x02]);
            }
            au.extend(vec![0x55; 400]);
            ts.extend(split(0x100, &pes(0xE0, 900_000 + 3000 * f, &au, false), &mut vcc));
            let pkt = klv::encode_uas(&[(2, (t + 33_333 * f as u64).to_be_bytes().to_vec()), (65, vec![17])]);
            let mut cell = vec![0, f as u8, 0xDF];
            cell.extend((pkt.len() as u16).to_be_bytes());
            cell.extend(&pkt);
            ts.extend(split(0x101, &pes(0xFC, 900_000 + 3000 * f, &cell, true), &mut kcc));
        }
        let mut d = Demux::new();
        // Feed in odd-sized blocks to exercise the carry.
        let mut off = 0;
        for c in ts.chunks(1000) {
            d.push(c, off as u64).unwrap();
            off += c.len();
        }
        d.finish();
        assert_eq!(d.aus.len(), 3);
        assert!(d.aus[0].key && !d.aus[1].key);
        assert_eq!(d.aus[0].sei_time, Some(t));
        assert_eq!(d.codec, "avc1.64001e");
        assert_eq!(d.klv.len(), 3);
        assert!(d.klv[2].sync);
        assert_eq!(d.klv[2].pts, Some(906_000));
        assert_eq!(d.klv[1].packets[0].checksum_ok, Some(true));
        assert_eq!(d.cc_errors, 0);
        let js = d.to_json();
        assert!(js.contains("\"kind\":\"klv-sync\""));
        // Extract the first two video PES from a block.
        let (data, idx) = extract_pes(&ts, 0, 0x100, false);
        assert_eq!(idx.len(), 2);
        assert_eq!(idx[0].0, Some(900_000));
        assert_eq!(data.len(), idx[0].2 + idx[1].2);
    }

    #[test]
    fn pts_wrap_and_garbage() {
        let mut d = Demux::new();
        assert_eq!(d.unwrap_pts(5, (1 << 33) - 100), (1 << 33) - 100);
        assert_eq!(d.unwrap_pts(5, 200), (1 << 33) + 200);
        let mut d = Demux::new();
        let junk: Vec<u8> = (0..5000u32).map(|i| (i * 7 % 251) as u8).collect();
        d.push(&junk, 0).unwrap();
        d.finish();
        assert!(d.aus.is_empty());
    }
}
