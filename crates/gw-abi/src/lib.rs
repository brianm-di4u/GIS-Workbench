//! Thin, stable C ABI shared by every GIS Workbench WASM bundle (Appendix D §3, REQ-RUST-03).
//!
//! * Buffers live in linear memory; JS allocates with `gw_alloc` and frees with `gw_free`.
//! * Every operation returns a small status code; the message is read with `gw_last_error`.
//! * Variable-length results are left in an output buffer read with `gw_out_ptr`/`gw_out_len`.
//! * Release builds import nothing, so a module instantiates with an empty import object.
//! * `panic = "abort"` traps the instance; the JS pool discards it (REQ-RUST-04).
//! * A message with values keeps its template (REQ-L10N-05): `err!(INVALID, "zone {zone} not in
//!   [1,60]", zone)` records the English text as usual, and `gw_last_error_i18n` returns
//!   `{"src":"zone {zone} not in [1,60]","params":{"zone":"61"}}` so the UI can show it in its
//!   language. Templates are ICU messages with `{name}` arguments only; an apostrophe right before
//!   a brace is written `''` (ICU quoting). The build extracts them into the source catalogue.

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
    static LAST_I18N: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// The template and arguments of a message with values (see `err!`).
#[derive(Debug, Clone, PartialEq)]
pub struct Msg {
    pub src: &'static str,
    pub args: Vec<(&'static str, String)>,
}

/// An error carrying a status code and a message (English), and for a message with values its
/// template and arguments. Two errors are equal when their code and message are.
#[derive(Debug, Clone)]
pub struct Error {
    pub code: i32,
    pub msg: String,
    pub i18n: Option<Box<Msg>>,
}

impl PartialEq for Error {
    fn eq(&self, o: &Self) -> bool {
        self.code == o.code && self.msg == o.msg
    }
}

/// The English text of a template: `{name}` is replaced by its argument and `''` is one
/// apostrophe, as an ICU message with plain arguments formats in English.
pub fn render(src: &str, args: &[(&'static str, String)]) -> String {
    // Byte scan: the delimiters are ASCII, so they never split a UTF-8 sequence.
    let b = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len() + 16);
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'\'' && b.get(i + 1) == Some(&b'\'') {
            out.push(c);
            i += 2;
            continue;
        }
        if c == b'{' {
            if let Some(j) = b[i..].iter().position(|&x| x == b'}') {
                match args.iter().find(|(k, _)| k.as_bytes() == &b[i + 1..i + j]) {
                    Some((_, v)) => out.extend_from_slice(v.as_bytes()),
                    None => out.extend_from_slice(&b[i..=i + j]),
                }
                i += j + 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

impl Error {
    pub fn new(code: i32, msg: impl Into<String>) -> Self {
        Error { code, msg: msg.into(), i18n: None }
    }
    /// A message with values: `src` is the template, `args` its `{name}` values (see `err!`).
    pub fn tpl(code: i32, src: &'static str, args: Vec<(&'static str, String)>) -> Self {
        debug_assert!(template_ok(src, &args), "error template {src:?} does not match its arguments");
        Error { code, msg: render(src, &args), i18n: Some(Box::new(Msg { src, args })) }
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

/// Whether a template has exactly the arguments it names, and parses as the same ICU message
/// (no apostrophe right before a brace, which ICU reads as quoting). Checked in debug builds.
pub fn template_ok(src: &str, args: &[(&'static str, String)]) -> bool {
    let b = src.replace("''", "");
    if b.contains("'{") || b.contains("'}") {
        return false;
    }
    let mut used = 0;
    let mut rest = b.as_str();
    while let Some(i) = rest.find('{') {
        let Some(j) = rest[i..].find('}') else { return false };
        let name = &rest[i + 1..i + j];
        if name.is_empty() || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') || !args.iter().any(|(k, _)| *k == name) {
            return false;
        }
        used += 1;
        rest = &rest[i + j + 1..];
    }
    !rest.contains('}') && used >= args.len()
}

/// An error whose message has values, keeping its template for localisation (REQ-L10N-05):
/// `err!(INVALID, "zone {zone} not in [1,60]", zone)` or `err!(RANGE, "{n} of {m}", n = a.len(), m)`.
/// Each argument is formatted with `Display`. The English text is the template with the values
/// in place, the same as `format!` with the same text gives.
#[macro_export]
macro_rules! err {
    (@v $k:ident) => { ::std::string::ToString::to_string(&$k) };
    (@v $k:ident, $v:expr) => { ::std::string::ToString::to_string(&$v) };
    ($code:ident, $src:literal $(, $k:ident $(= $v:expr)?)* $(,)?) => {
        $crate::Error::tpl($crate::$code, $src, ::std::vec![$((::core::stringify!($k), $crate::err!(@v $k $(, $v)?))),*])
    };
}

pub fn set_last_error(msg: &str) {
    LAST_ERROR.with(|e| {
        let mut e = e.borrow_mut();
        e.clear();
        e.extend_from_slice(msg.as_bytes());
    });
    LAST_I18N.with(|e| e.borrow_mut().clear());
}

/// Record an error: its message, and for a message with values `{"src":…,"params":{…}}`.
pub fn set_last(e: &Error) {
    set_last_error(&e.msg);
    if let Some(m) = &e.i18n {
        LAST_I18N.with(|b| {
            let mut b = b.borrow_mut();
            b.extend_from_slice(b"{\"src\":");
            json_bytes(&mut b, m.src);
            b.extend_from_slice(b",\"params\":{");
            for (i, (k, v)) in m.args.iter().enumerate() {
                if i > 0 {
                    b.push(b',');
                }
                json_bytes(&mut b, k);
                b.push(b':');
                json_bytes(&mut b, v);
            }
            b.extend_from_slice(b"}}");
        });
    }
}

/// A JSON string, small: the error path of every bundle has it (REQ-RUST-08).
fn json_bytes(out: &mut Vec<u8>, s: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    for &c in s.as_bytes() {
        match c {
            b'"' | b'\\' => out.extend_from_slice(&[b'\\', c]),
            0..=0x1f => out.extend_from_slice(&[b'\\', b'u', b'0', b'0', HEX[(c >> 4) as usize], HEX[(c & 15) as usize]]),
            _ => out.push(c),
        }
    }
    out.push(b'"');
}

/// Convert a `Result` into a status code, recording the error message.
pub fn status<T>(r: Result<T>) -> i32 {
    match r {
        Ok(_) => OK,
        Err(e) => {
            set_last(&e);
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

/// The template of the last error as JSON, or nothing when its message has no values.
pub fn last_error_i18n_copy(dst: &mut [u8]) -> usize {
    LAST_I18N.with(|e| {
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
        /// # Safety
        /// `ptr` must point to `cap` writable bytes.
        #[no_mangle]
        pub unsafe extern "C" fn gw_last_error_i18n(ptr: *mut u8, cap: usize) -> usize {
            $crate::last_error_i18n_copy($crate::slice_mut(ptr, cap))
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
    fn templates_keep_the_english_and_cross_as_json() {
        let zone = 61;
        let e = crate::err!(INVALID, "zone {zone} not in [1,60]", zone);
        assert_eq!(e, Error::invalid(format!("zone {zone} not in [1,60]")));
        assert_eq!(e.msg, "zone 61 not in [1,60]");
        assert_eq!(status::<()>(Err(e)), INVALID);
        let mut b = [0u8; 128];
        let n = last_error_i18n_copy(&mut b);
        assert_eq!(std::str::from_utf8(&b[..n]).unwrap(), r#"{"src":"zone {zone} not in [1,60]","params":{"zone":"61"}}"#);
        // A plain message clears the template of an earlier one.
        assert_eq!(status::<()>(Err(Error::invalid("bad"))), INVALID);
        assert_eq!(last_error_i18n_copy(&mut b), 0);
        let k = "BANDS";
        let e = crate::err!(INVALID, "ENVI header: ''{k}'' is missing", k);
        assert_eq!(e.msg, "ENVI header: 'BANDS' is missing");
        let e = crate::err!(RANGE, "need {n} bytes at {at}, have \"{v}\"", n = 2 + 2, at = 7u64, v = "x\"y");
        assert_eq!(e.msg, "need 4 bytes at 7, have \"x\"y\"");
        assert_eq!(e.code, RANGE);
        status::<()>(Err(e));
        let n = last_error_i18n_copy(&mut b);
        assert_eq!(std::str::from_utf8(&b[..n]).unwrap(), r#"{"src":"need {n} bytes at {at}, have \"{v}\"","params":{"n":"4","at":"7","v":"x\"y"}}"#);
    }

    #[test]
    fn template_checks() {
        let a = |k: &'static str| (k, String::new());
        assert!(template_ok("{a} and {b}", &[a("a"), a("b")]));
        assert!(template_ok("no values", &[]));
        assert!(template_ok("''{a}''", &[a("a")]));
        assert!(!template_ok("'{a}'", &[a("a")]));
        assert!(!template_ok("{a} and {b}", &[a("a")]));
        assert!(!template_ok("{a}", &[a("a"), a("b")]));
        assert!(!template_ok("{a b}", &[a("a")]));
        assert!(!template_ok("a } b", &[]));
        assert_eq!(render("{a}{a} {missing}", &[("a", "x".into())]), "xx {missing}");
    }

    #[test]
    fn non_finite_numbers_become_null_and_markup_is_escaped() {
        let mut j = Json::new();
        j.arr().num(f64::NAN).num(2.0).str("</script>").end_arr();
        assert_eq!(j.finish(), "[null,2,\"\\u003c/script>\"]");
    }
}
