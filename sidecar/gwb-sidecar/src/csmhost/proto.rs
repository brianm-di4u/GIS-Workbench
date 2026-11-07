//! The host's wire format, sidecar side. Everything that comes back is untrusted: a plug-in runs in
//! the host and could find the protocol's handles, so each frame is checked for its magic, its id,
//! its size and its contents before anything reads it.
//!
//!   frame   = magic u32, op or status u32, id u32, length u32, payload (little-endian)
//!   strings = count u32 (at most 16), then length u32 and UTF-8 bytes for each (at most 4096)
//!   numbers = f64 values, every one finite

use std::io::{Read, Write};

pub const REQ_MAGIC: u32 = 0x5153_4347; // "GCSQ"
pub const REP_MAGIC: u32 = 0x5253_4347; // "GCSR"
pub const PROTOCOL: u32 = 1;
pub const MAX_PAYLOAD: u32 = 16 << 20;
pub const MAX_POINTS: usize = 65536;
const MAX_STRINGS: usize = 16;
const MAX_TEXT: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum Op {
    Hello = 1,
    Load = 2,
    Open = 3,
    G2i = 4,
    I2g = 5,
    Partials = 6,
    Covariance = 7,
    Quit = 8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    BadRequest,
    NotReady,
    CsmVersion,
    NoModel,
    CsmError,
    PluginException,
    LoadFailed,
    Sandbox,
}

impl Status {
    pub fn parse(v: u32) -> Option<Status> {
        use Status::*;
        [Ok, BadRequest, NotReady, CsmVersion, NoModel, CsmError, PluginException, LoadFailed, Sandbox].get(v as usize).copied()
    }
}

#[derive(Debug, PartialEq)]
pub enum ProtoError {
    /// The pipe ended or broke: the host is gone.
    Gone,
    /// The reply is not what the protocol allows.
    Bad(String),
}

impl std::fmt::Display for ProtoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtoError::Gone => write!(f, "the plug-in host ended"),
            ProtoError::Bad(w) => write!(f, "the plug-in host broke the protocol: {w}"),
        }
    }
}

pub fn frame(op: Op, id: u32, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(16 + payload.len());
    for x in [REQ_MAGIC, op as u32, id, payload.len() as u32] {
        v.extend_from_slice(&x.to_le_bytes());
    }
    v.extend_from_slice(payload);
    v
}

pub fn write_frame(w: &mut impl Write, op: Op, id: u32, payload: &[u8]) -> Result<(), ProtoError> {
    w.write_all(&frame(op, id, payload)).and_then(|_| w.flush()).map_err(|_| ProtoError::Gone)
}

/// One reply, for request `id`.
pub fn read_reply(r: &mut impl Read, id: u32) -> Result<(Status, Vec<u8>), ProtoError> {
    let mut h = [0u8; 16];
    r.read_exact(&mut h).map_err(|_| ProtoError::Gone)?;
    let word = |i: usize| u32::from_le_bytes([h[i], h[i + 1], h[i + 2], h[i + 3]]);
    if word(0) != REP_MAGIC {
        return Err(ProtoError::Bad("bad magic".into()));
    }
    let status = Status::parse(word(4)).ok_or_else(|| ProtoError::Bad(format!("unknown status {}", word(4))))?;
    if word(8) != id {
        return Err(ProtoError::Bad(format!("reply to request {}, not {id}", word(8))));
    }
    let n = word(12);
    if n > MAX_PAYLOAD {
        return Err(ProtoError::Bad(format!("a {n} byte reply")));
    }
    let mut p = vec![0u8; n as usize];
    r.read_exact(&mut p).map_err(|_| ProtoError::Gone)?;
    Ok((status, p))
}

pub fn strings(v: &[&str]) -> Vec<u8> {
    let mut o = (v.len() as u32).to_le_bytes().to_vec();
    for s in v {
        o.extend_from_slice(&(s.len() as u32).to_le_bytes());
        o.extend_from_slice(s.as_bytes());
    }
    o
}

/// Exactly `want` strings, or any number up to the limit when `want` is `None`.
pub fn parse_strings(p: &[u8], want: Option<usize>) -> Result<Vec<String>, ProtoError> {
    let bad = |w: &str| ProtoError::Bad(w.to_string());
    let take_u32 = |at: usize| -> Result<usize, ProtoError> {
        let b = p.get(at..at + 4).ok_or_else(|| bad("a string list that stops short"))?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let count = take_u32(0)?;
    if count > MAX_STRINGS || want.is_some_and(|w| w != count) {
        return Err(bad("the wrong number of strings"));
    }
    let mut at = 4;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let n = take_u32(at)?;
        at += 4;
        if n > MAX_TEXT {
            return Err(bad("a string over the limit"));
        }
        let b = p.get(at..at + n).ok_or_else(|| bad("a string that stops short"))?;
        at += n;
        // Replacing, not refusing: a plug-in's name in Latin-1 is no attack, and it stays text.
        let s = String::from_utf8_lossy(b);
        out.push(s.chars().filter(|c| !c.is_control()).collect());
    }
    if at != p.len() {
        return Err(bad("bytes after the string list"));
    }
    Ok(out)
}

pub fn numbers(v: &[f64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// Exactly `want` finite numbers, or any count when `want` is `None`.
pub fn parse_numbers(p: &[u8], want: Option<usize>) -> Result<Vec<f64>, ProtoError> {
    if p.len() % 8 != 0 {
        return Err(ProtoError::Bad("a partial number".into()));
    }
    let n = p.len() / 8;
    if want.is_some_and(|w| w != n) {
        return Err(ProtoError::Bad(format!("{n} numbers where {} were due", want.unwrap_or(0))));
    }
    let v: Vec<f64> = p.chunks_exact(8).map(|c| f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])).collect();
    if v.iter().any(|x| !x.is_finite()) {
        return Err(ProtoError::Bad("a number that is not finite".into()));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn reply(status: u32, id: u32, p: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        for x in [REP_MAGIC, status, id, p.len() as u32] {
            v.extend_from_slice(&x.to_le_bytes());
        }
        v.extend_from_slice(p);
        v
    }

    #[test]
    fn round_trips() {
        let p = strings(&["a", "bé", ""]);
        assert_eq!(parse_strings(&p, Some(3)).unwrap(), ["a", "bé", ""]);
        assert_eq!(parse_numbers(&numbers(&[1.5, -2.0]), Some(2)).unwrap(), [1.5, -2.0]);
        let r = reply(0, 7, b"xy");
        assert_eq!(read_reply(&mut Cursor::new(r), 7).unwrap(), (Status::Ok, b"xy".to_vec()));
    }

    #[test]
    fn replies_that_are_refused() {
        let good = reply(0, 7, b"");
        let mut bad_magic = good.clone();
        bad_magic[0] ^= 1;
        assert!(matches!(read_reply(&mut Cursor::new(bad_magic), 7), Err(ProtoError::Bad(_))));
        assert!(matches!(read_reply(&mut Cursor::new(reply(99, 7, b"")), 7), Err(ProtoError::Bad(_))));
        assert!(matches!(read_reply(&mut Cursor::new(reply(0, 8, b"")), 7), Err(ProtoError::Bad(_))), "an old reply is not this one");
        let mut huge = good.clone();
        huge[12..16].copy_from_slice(&(MAX_PAYLOAD + 1).to_le_bytes());
        assert!(matches!(read_reply(&mut Cursor::new(huge), 7), Err(ProtoError::Bad(_))));
        let mut short = reply(0, 7, b"abcd");
        short.truncate(18);
        assert_eq!(read_reply(&mut Cursor::new(short), 7), Err(ProtoError::Gone));
        assert_eq!(read_reply(&mut Cursor::new(Vec::new()), 7), Err(ProtoError::Gone));
    }

    #[test]
    fn numbers_and_strings_that_are_refused() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(parse_numbers(&numbers(&[1.0, bad]), None).is_err());
        }
        assert!(parse_numbers(&[0u8; 7], None).is_err());
        assert!(parse_numbers(&numbers(&[1.0]), Some(2)).is_err());
        assert!(parse_strings(&[], None).is_err());
        assert!(parse_strings(&strings(&["a"]), Some(2)).is_err());
        assert!(parse_strings(&17u32.to_le_bytes(), None).is_err());
        let mut p = strings(&["a"]);
        p.push(0);
        assert!(parse_strings(&p, None).is_err(), "bytes after the list");
        let mut p = 1u32.to_le_bytes().to_vec();
        p.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse_strings(&p, None).is_err(), "a length that would wrap");
        let over = "x".repeat(MAX_TEXT + 1);
        assert!(parse_strings(&strings(&[&over]), None).is_err());
    }

    #[test]
    fn control_characters_never_reach_a_log_line() {
        assert_eq!(parse_strings(&strings(&["a\nb\u{1b}[2Jc"]), None).unwrap(), ["ab[2Jc"]);
        assert_eq!(parse_strings(&strings(&["\u{7f}"]), None).unwrap(), [""]);
    }

    /// Fuzz target for the parser (the brief's rule for a new parser): random bytes, and valid
    /// frames with random damage, must give an error or a value, and never a panic or a hang.
    #[test]
    fn fuzz_the_reply_parser() {
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let mut accepted = 0;
        for round in 0..200_000u32 {
            let len = (next() % 64) as usize;
            let mut b: Vec<u8> = if round % 2 == 0 { (0..len).map(|_| next() as u8).collect() } else { reply((next() % 10) as u32, 7, &strings(&["model", "1.0"])) };
            if round % 2 == 1 {
                for _ in 0..(next() % 4) {
                    let i = (next() as usize) % b.len();
                    b[i] = next() as u8;
                }
            }
            if let Ok((_, p)) = read_reply(&mut Cursor::new(&b), 7) {
                accepted += 1;
                let _ = parse_strings(&p, None);
                let _ = parse_numbers(&p, None);
            }
            let _ = parse_strings(&b, None);
            let _ = parse_numbers(&b, None);
        }
        assert!(accepted > 1000, "the mutated frames must reach the payload parsers: {accepted}");
    }
}
