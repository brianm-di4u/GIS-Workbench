//! Error messages. `Error::invalid("…")` marks a static English message for the catalogue (the
//! build extracts it: build/i18n.mjs `messagesInRust`), so the app shows it in the UI language.
//! In this crate it is the `&'static str` itself, with no allocation where it is made; the bundle
//! turns it into a `gw_abi::Error` at the ABI.

pub type Msg = &'static str;

pub struct Error;
impl Error {
    #[inline(always)]
    pub const fn invalid(m: &'static str) -> Msg {
        m
    }
}
