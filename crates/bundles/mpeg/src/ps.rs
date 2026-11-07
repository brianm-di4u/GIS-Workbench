//! `mpeg` exports: MPEG program stream index and elementary-stream extraction (FC-22,
//! REQ-FMT-52), and the MPEG-1 and MPEG-2 (REQ-GAP-48) video decoder sessions behind the FMV
//! player. Both decoders share one session API (`gw_mpv_*`); `gw_mpv_new_kind` picks one.

use gw_abi::{set_out, set_out_json, slice, status, Error, Json};
use gw_codec::{mpeg1v as v1, mpeg2v as v2};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

thread_local! {
    static INDEXES: RefCell<HashMap<i32, gw_parse::ps::Demux>> = RefCell::new(HashMap::new());
    static DECODERS: RefCell<HashMap<i32, Dec>> = RefCell::new(HashMap::new());
    static NEXT: Cell<i32> = const { Cell::new(1) };
}

fn next_id() -> i32 {
    NEXT.with(|n| {
        let v = n.get();
        n.set(v.wrapping_add(1).max(1));
        v
    })
}

/// A decoder session and the picture last returned by its `decode`.
enum Dec {
    V1(v1::Decoder, Option<v1::Out>),
    V2(Box<v2::Decoder>, Option<v2::Out>),
}

/// The fields of a decoded picture the session API reports (both decoders).
struct Pic {
    ord: u32,
    tr: u16,
    ptype: u8,
}

impl Dec {
    fn push(&mut self, b: &[u8]) {
        match self {
            Dec::V1(d, _) => d.push(b),
            Dec::V2(d, _) => d.push(b),
        }
    }

    fn end(&mut self) {
        match self {
            Dec::V1(d, _) => d.end(),
            Dec::V2(d, _) => d.end(),
        }
    }

    fn reset(&mut self) {
        match self {
            Dec::V1(d, last) => {
                d.reset();
                *last = None;
            }
            Dec::V2(d, last) => {
                d.reset();
                *last = None;
            }
        }
    }

    fn headers(&mut self) -> gw_abi::Result<bool> {
        match self {
            Dec::V1(d, _) => d.headers(),
            Dec::V2(d, _) => d.headers(),
        }
    }

    fn decode(&mut self) -> gw_abi::Result<Option<Pic>> {
        match self {
            Dec::V1(d, last) => {
                let r = d.decode();
                *last = r.as_ref().ok().copied().flatten();
                r.map(|o| o.map(|o| Pic { ord: o.ord, tr: o.tr, ptype: o.ptype }))
            }
            Dec::V2(d, last) => {
                let r = d.decode();
                *last = r.as_ref().ok().copied().flatten();
                r.map(|o| o.map(|o| Pic { ord: o.ord, tr: o.tr, ptype: o.ptype }))
            }
        }
    }

    /// RGBA of the picture last returned by `decode`; false if there is none.
    fn rgba(&self, out: &mut Vec<u8>) -> bool {
        match self {
            Dec::V1(d, Some(o)) => d.rgba(o.slot, out),
            Dec::V2(d, Some(o)) => d.rgba(o.slot, out),
            _ => return false,
        }
        true
    }

    /// Packed I420 of the picture last returned by `decode` (MPEG-2 only); false if none.
    fn i420(&self, out: &mut Vec<u8>) -> bool {
        match self {
            Dec::V2(d, Some(o)) => d.i420(o.slot, out),
            _ => return false,
        }
        true
    }

    fn info(&self) -> String {
        let mut j = Json::new();
        match self {
            Dec::V1(d, _) => {
                j.obj().kv_bool("hasSeq", d.has_seq).kv_bool("mpeg2", d.mpeg2).kv_int("width", d.width as i64).kv_int("height", d.height as i64).kv_num("fps", d.fps()).kv_int("aspect", d.aspect as i64).kv_int("decoded", d.decoded as i64).kv_int("skipped", d.skipped as i64).kv_str("decoder", "mpeg1").end_obj();
            }
            Dec::V2(d, _) => {
                j.obj()
                    .kv_bool("hasSeq", d.has_seq)
                    .kv_bool("mpeg2", d.mpeg2)
                    .kv_int("width", d.width as i64)
                    .kv_int("height", d.height as i64)
                    .kv_num("fps", d.fps())
                    .kv_int("aspect", d.aspect as i64)
                    .kv_int("decoded", d.decoded as i64)
                    .kv_int("skipped", d.skipped as i64)
                    .kv_str("decoder", "mpeg2")
                    .kv_int("profileLevel", d.profile_level as i64)
                    .kv_bool("progressiveSequence", d.progressive_seq)
                    .kv_bool("lowDelay", d.low_delay)
                    .kv_int("fieldPictures", d.field_pictures as i64)
                    .kv_int("interlacedFrames", d.interlaced_frames as i64)
                    .kv_int("errors", d.errors as i64)
                    .end_obj();
            }
        }
        j.finish()
    }
}

/// `[u32 json len][json][pad to 4][bytes]`.
fn packed(json: String, data: &[u8]) -> Vec<u8> {
    let jb = json.into_bytes();
    let mut out = Vec::with_capacity(8 + jb.len() + data.len());
    out.extend_from_slice(&(jb.len() as u32).to_le_bytes());
    out.extend_from_slice(&jb);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    out.extend_from_slice(data);
    out
}

/// Start a program stream index; returns its id.
#[no_mangle]
pub extern "C" fn gw_ps_open() -> i32 {
    let id = next_id();
    INDEXES.with(|d| d.borrow_mut().insert(id, gw_parse::ps::Demux::new()));
    id
}

/// Feed the next contiguous block (file offset `base`).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_ps_push(id: i32, ptr: *const u8, len: usize, base: f64) -> i32 {
    let b = slice(ptr, len);
    INDEXES.with(|d| match d.borrow_mut().get_mut(&id) {
        Some(m) => status(m.push(b, base as u64)),
        None => status::<()>(Err(Error::invalid("no such program stream index"))),
    })
}

/// Finish and free the index → JSON (packs, streams, video access units, KLV packets).
#[no_mangle]
pub extern "C" fn gw_ps_finish(id: i32) -> i32 {
    INDEXES.with(|d| match d.borrow_mut().remove(&id) {
        Some(mut m) => {
            m.finish();
            set_out_json(m.to_json());
            0
        }
        None => status::<()>(Err(Error::invalid("no such program stream index"))),
    })
}

/// Elementary-stream bytes of stream `sid` (0 = the block is a bare elementary stream) in a block
/// at file offset `base` → packed `[u32 json len][json {next, pes:[[off, pts, len]…]}][pad4][bytes]`.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_ps_es(ptr: *const u8, len: usize, base: f64, sid: u32, at_end: i32) -> i32 {
    let (data, next, idx) = gw_parse::ps::extract_es(slice(ptr, len), base as u64, sid, at_end != 0);
    let mut j = Json::new();
    j.obj().kv_num("next", next as f64).key("pes").arr();
    for (off, pts, n) in &idx {
        j.arr().num(*off as f64);
        match pts {
            Some(p) => j.num(*p as f64),
            None => j.null(),
        };
        j.int(*n as i64).end_arr();
    }
    j.end_arr().end_obj();
    set_out(packed(j.finish(), &data));
    0
}

/// New MPEG-1 video decoder; returns its id.
#[no_mangle]
pub extern "C" fn gw_mpv_new() -> i32 {
    gw_mpv_new_kind(1)
}

/// New video decoder of `kind` (1 = MPEG-1, 2 = MPEG-2); returns its id.
#[no_mangle]
pub extern "C" fn gw_mpv_new_kind(kind: i32) -> i32 {
    let id = next_id();
    let d = if kind == 2 { Dec::V2(Box::new(v2::Decoder::new()), None) } else { Dec::V1(v1::Decoder::new(), None) };
    DECODERS.with(|m| m.borrow_mut().insert(id, d));
    id
}

#[no_mangle]
pub extern "C" fn gw_mpv_free(id: i32) {
    DECODERS.with(|d| d.borrow_mut().remove(&id));
}

fn with<R>(id: i32, f: impl FnOnce(&mut Dec) -> R) -> Option<R> {
    DECODERS.with(|d| d.borrow_mut().get_mut(&id).map(f))
}

fn missing() -> i32 {
    status::<()>(Err(Error::invalid("no such MPEG video decoder")))
}

/// Append elementary-stream bytes.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_mpv_push(id: i32, ptr: *const u8, len: usize) -> i32 {
    let b = slice(ptr, len);
    with(id, |d| d.push(b)).map_or_else(missing, |_| 0)
}

/// `what`: 1 = end of input, 2 = reset (seek), 3 = parse the sequence header from the buffered
/// input (status 0 and out "1" once known, "0" if not yet).
#[no_mangle]
pub extern "C" fn gw_mpv_ctl(id: i32, what: i32) -> i32 {
    with(id, |d| match what {
        1 => {
            d.end();
            0
        }
        2 => {
            d.reset();
            0
        }
        3 => match d.headers() {
            Ok(k) => {
                set_out(vec![b'0' + k as u8]);
                0
            }
            Err(e) => status::<()>(Err(e)),
        },
        _ => 0,
    })
    .unwrap_or_else(missing)
}

/// Sequence information → JSON {hasSeq, mpeg2, width, height, fps, aspect, decoded, skipped,
/// decoder, and for MPEG-2 profileLevel, progressiveSequence, lowDelay, fieldPictures,
/// interlacedFrames, errors}.
#[no_mangle]
pub extern "C" fn gw_mpv_info(id: i32) -> i32 {
    with(id, |d| set_out_json(d.info())).map_or_else(missing, |_| 0)
}

/// Decode the next displayable picture. Out: empty when more input is needed (or all was output
/// after the end), else JSON {ord, tr, type}. `gw_mpv_rgba` then converts it.
#[no_mangle]
pub extern "C" fn gw_mpv_decode(id: i32) -> i32 {
    with(id, |d| match d.decode() {
        Ok(Some(o)) => {
            let mut j = Json::new();
            j.obj().kv_int("ord", o.ord as i64).kv_int("tr", o.tr as i64).kv_int("type", o.ptype as i64).end_obj();
            set_out_json(j.finish());
            0
        }
        Ok(None) => {
            set_out(Vec::new());
            0
        }
        Err(e) => status::<()>(Err(e)),
    })
    .unwrap_or_else(missing)
}

/// The picture last returned by `gw_mpv_decode` → RGBA, width × height (out).
#[no_mangle]
pub extern "C" fn gw_mpv_rgba(id: i32) -> i32 {
    thread_local! {
        static RGBA: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }
    with(id, |d| {
        RGBA.with(|b| {
            let mut b = b.borrow_mut();
            if !d.rgba(&mut b) {
                return status::<()>(Err(Error::invalid("no decoded picture to convert")));
            }
            set_out(std::mem::take(&mut *b));
            0
        })
    })
    .unwrap_or_else(missing)
}

/// The picture last returned by `gw_mpv_decode` → packed I420 (out), MPEG-2 sessions only: the
/// player hands it to a WebCodecs VideoFrame, which converts it to RGB faster than `gw_mpv_rgba`.
#[no_mangle]
pub extern "C" fn gw_mpv_i420(id: i32) -> i32 {
    thread_local! {
        static YUV: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    }
    with(id, |d| {
        YUV.with(|b| {
            let mut b = b.borrow_mut();
            if !d.i420(&mut b) {
                return status::<()>(Err(Error::invalid("no decoded MPEG-2 picture")));
            }
            set_out(std::mem::take(&mut *b));
            0
        })
    })
    .unwrap_or_else(missing)
}
