//! Thin, stable C ABI shared by every GIS Workbench WASM bundle (Appendix D §3, REQ-RUST-03).
//!
//! * Buffers live in linear memory; JS allocates with `gw_alloc` and frees with `gw_free`.
//! * Every operation returns a small status code; the message is read with `gw_last_error`.
//! * Variable-length results are left in an output buffer read with `gw_out_ptr`/`gw_out_len`.
//! * Release builds import nothing, so a module instantiates with an empty import object.
//! * `panic = "abort"` traps the instance; the JS pool discards it (REQ-RUST-04).

use std::cell::RefCell;

/// Status codes (Appendix D §3.1).
pub const OK: i32 = 0;
pub const INVALID: i32 = 1;
pub const RANGE: i32 = 2;
pub const LIMIT: i32 = 3;
pub const UNSUPPORTED: i32 = 4;
pub const INTERNAL: i32 = 5;

/// ABI version. Bump on any incompatible change of an exported signature or record.
pub const ABI_VERSION: u32 = 1;

thread_local! {
    static LAST_ERROR: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// An error carrying a status code and a message.
#[derive(Debug, Clone, PartialEq)]
pub struct Error {
    pub code: i32,
    pub msg: String,
}

impl Error {
    pub fn new(code: i32, msg: impl Into<String>) -> Self {
        Error { code, msg: msg.into() }
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new(INVALID, msg)
    }
    pub fn range(msg: impl Into<String>) -> Self {
        Self::new(RANGE, msg)
    }
    pub fn limit(msg: impl Into<String>) -> Self {
        Self::new(LIMIT, msg)
    }
    pub fn unsupported(msg: impl Into<String>) -> Self {
        Self::new(UNSUPPORTED, msg)
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.msg, self.code)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn set_last_error(msg: &str) {
    LAST_ERROR.with(|e| {
        let mut e = e.borrow_mut();
        e.clear();
        e.extend_from_slice(msg.as_bytes());
    });
}

/// Convert a `Result` into a status code, recording the error message.
pub fn status<T>(r: Result<T>) -> i32 {
    match r {
        Ok(_) => OK,
        Err(e) => {
            set_last_error(&e.msg);
            e.code
        }
    }
}

/// Store a variable-length result. JS reads it with `gw_out_ptr`/`gw_out_len`.
pub fn set_out(bytes: Vec<u8>) {
    OUT.with(|o| *o.borrow_mut() = bytes);
}

/// Store a JSON result (UTF-8 text) in the output buffer.
pub fn set_out_json(json: String) {
    set_out(json.into_bytes());
}

/// # Safety
/// `ptr` must point to `len` readable elements in linear memory (or be dangling with len 0).
pub unsafe fn slice<'a, T>(ptr: *const T, len: usize) -> &'a [T] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

/// # Safety
/// `ptr` must point to `len` writable elements in linear memory.
pub unsafe fn slice_mut<'a, T>(ptr: *mut T, len: usize) -> &'a mut [T] {
    if len == 0 || ptr.is_null() {
        &mut []
    } else {
        std::slice::from_raw_parts_mut(ptr, len)
    }
}

pub fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::<u8>::dangling().as_ptr();
    }
    match std::alloc::Layout::from_size_align(len, 8) {
        Ok(layout) => unsafe { std::alloc::alloc(layout) },
        Err(_) => std::ptr::null_mut(),
    }
}

/// # Safety
/// `ptr`/`len` must come from a previous `alloc` call.
pub unsafe fn free(ptr: *mut u8, len: usize) {
    if len == 0 || ptr.is_null() {
        return;
    }
    if let Ok(layout) = std::alloc::Layout::from_size_align(len, 8) {
        std::alloc::dealloc(ptr, layout);
    }
}

pub fn last_error_copy(dst: &mut [u8]) -> usize {
    LAST_ERROR.with(|e| {
        let e = e.borrow();
        let n = e.len().min(dst.len());
        dst[..n].copy_from_slice(&e[..n]);
        e.len()
    })
}

pub fn out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}

pub fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}

/// Emit the common exports into a bundle crate. Each bundle calls this once.
#[macro_export]
macro_rules! export_abi {
    () => {
        #[no_mangle]
        pub extern "C" fn gw_abi_version() -> u32 {
            $crate::ABI_VERSION
        }
        #[no_mangle]
        pub extern "C" fn gw_alloc(len: usize) -> *mut u8 {
            $crate::alloc(len)
        }
        /// # Safety
        /// `ptr`/`len` must come from `gw_alloc`.
        #[no_mangle]
        pub unsafe extern "C" fn gw_free(ptr: *mut u8, len: usize) {
            $crate::free(ptr, len)
        }
        /// # Safety
        /// `ptr` must point to `cap` writable bytes.
        #[no_mangle]
        pub unsafe extern "C" fn gw_last_error(ptr: *mut u8, cap: usize) -> usize {
            $crate::last_error_copy($crate::slice_mut(ptr, cap))
        }
        #[no_mangle]
        pub extern "C" fn gw_out_ptr() -> *const u8 {
            $crate::out_ptr()
        }
        #[no_mangle]
        pub extern "C" fn gw_out_len() -> usize {
            $crate::out_len()
        }
        /// Deliberate trap, used by the worker-pool recovery test (PT-05, REQ-RUST-04).
        #[no_mangle]
        pub extern "C" fn gw_debug_trap(code: i32) -> i32 {
            if code == 0x7472_6170 {
                panic!("deliberate trap");
            }
            code
        }
    };
}

/// Minimal JSON writer. Metadata results cross the ABI as UTF-8 JSON text in a byte
/// buffer (never as JS objects); hot paths use flat typed arrays instead.
#[derive(Default)]
pub struct Json {
    buf: String,
    // One entry per open container: true while no item has been written at that level.
    first: Vec<bool>,
    // Set after a key so the following value does not emit a separator.
    pending_key: bool,
}

impl Json {
    pub fn new() -> Self {
        Self::default()
    }
    fn sep(&mut self) {
        if self.pending_key {
            self.pending_key = false;
            return;
        }
        if let Some(f) = self.first.last_mut() {
            if *f {
                *f = false;
            } else {
                self.buf.push(',');
            }
        }
    }
    pub fn obj(&mut self) -> &mut Self {
        self.sep();
        self.buf.push('{');
        self.first.push(true);
        self
    }
    pub fn arr(&mut self) -> &mut Self {
        self.sep();
        self.buf.push('[');
        self.first.push(true);
        self
    }
    pub fn end_obj(&mut self) -> &mut Self {
        self.first.pop();
        self.buf.push('}');
        self
    }
    pub fn end_arr(&mut self) -> &mut Self {
        self.first.pop();
        self.buf.push(']');
        self
    }
    pub fn key(&mut self, k: &str) -> &mut Self {
        self.sep();
        push_str(&mut self.buf, k);
        self.buf.push(':');
        self.pending_key = true;
        self
    }
    pub fn str(&mut self, v: &str) -> &mut Self {
        self.sep();
        push_str(&mut self.buf, v);
        self
    }
    pub fn num(&mut self, v: f64) -> &mut Self {
        self.sep();
        if v.is_finite() {
            if v == v.trunc() && v.abs() < 1e15 {
                self.buf.push_str(&(v as i64).to_string());
            } else {
                self.buf.push_str(&format!("{v}"));
            }
        } else {
            self.buf.push_str("null");
        }
        self
    }
    pub fn int(&mut self, v: i64) -> &mut Self {
        self.sep();
        self.buf.push_str(&v.to_string());
        self
    }
    pub fn bool(&mut self, v: bool) -> &mut Self {
        self.sep();
        self.buf.push_str(if v { "true" } else { "false" });
        self
    }
    pub fn null(&mut self) -> &mut Self {
        self.sep();
        self.buf.push_str("null");
        self
    }
    /// Insert pre-serialised JSON as one value.
    pub fn raw(&mut self, json: &str) -> &mut Self {
        self.sep();
        self.buf.push_str(json);
        self
    }
    pub fn kv_str(&mut self, k: &str, v: &str) -> &mut Self {
        self.key(k).str(v)
    }
    pub fn kv_num(&mut self, k: &str, v: f64) -> &mut Self {
        self.key(k).num(v)
    }
    pub fn kv_int(&mut self, k: &str, v: i64) -> &mut Self {
        self.key(k).int(v)
    }
    pub fn kv_bool(&mut self, k: &str, v: bool) -> &mut Self {
        self.key(k).bool(v)
    }
    pub fn finish(self) -> String {
        self.buf
    }
}

fn push_str(buf: &mut String, s: &str) {
    buf.push('"');
    for c in s.chars() {
        match c {
            '"' => buf.push_str("\\\""),
            '\\' => buf.push_str("\\\\"),
            '\n' => buf.push_str("\\n"),
            '\r' => buf.push_str("\\r"),
            '\t' => buf.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{2028}' || c == '\u{2029}' || c == '<' => {
                buf.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => buf.push(c),
        }
    }
    buf.push('"');
}

/// Read a little-endian f64 record field.
pub fn f64_at(b: &[u8], i: usize) -> f64 {
    let mut a = [0u8; 8];
    if i + 8 <= b.len() {
        a.copy_from_slice(&b[i..i + 8]);
    }
    f64::from_le_bytes(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_shapes() {
        let mut j = Json::new();
        j.obj().kv_str("a", "x\"y").kv_num("b", 1.5).key("c").arr().int(1).int(2).end_arr();
        j.kv_bool("d", true).end_obj();
        assert_eq!(j.finish(), r#"{"a":"x\"y","b":1.5,"c":[1,2],"d":true}"#);
    }

    #[test]
    fn nested_objects_in_arrays() {
        let mut j = Json::new();
        j.arr().obj().kv_int("i", 1).end_obj().obj().kv_int("i", 2).end_obj().end_arr();
        assert_eq!(j.finish(), r#"[{"i":1},{"i":2}]"#);
    }

    #[test]
    fn object_value_after_key() {
        let mut j = Json::new();
        j.obj().key("o").obj().kv_int("x", 1).end_obj().kv_int("y", 2).end_obj();
        assert_eq!(j.finish(), r#"{"o":{"x":1},"y":2}"#);
    }

    #[test]
    fn status_records_error() {
        let r: Result<()> = Err(Error::invalid("bad"));
        assert_eq!(status(r), INVALID);
        let mut b = [0u8; 8];
        let n = last_error_copy(&mut b);
        assert_eq!(&b[..n], b"bad");
    }

    #[test]
    fn non_finite_numbers_become_null_and_markup_is_escaped() {
        let mut j = Json::new();
        j.arr().num(f64::NAN).num(2.0).str("</script>").end_arr();
        assert_eq!(j.finish(), "[null,2,\"\\u003c/script>\"]");
    }
}
