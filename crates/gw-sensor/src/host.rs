//! Sensor models answered by the host (REQ-GAP-24): usgscsm CSM models built from an ISD in the
//! separate usgscsm WebAssembly module, behind the `SensorModel` trait.
//!
//! The bundle that links this (core on the main thread, photo in the analysis worker) imports a
//! fixed set of functions from the wasm import module `gw_host` (the REQ-RUST-01 allow-list names
//! each). The page's bridge (`app/src/sensor/csm-host.js`) implements them over the usgscsm
//! module's own C ABI (`build/csm/src/gw_csm.cpp`); without the bridge every call returns
//! UNSUPPORTED. A model is a handle in the bridge; `HostModel` owns it (Drop frees it).
//!
//! Units and conventions are the trait's: (lat, lon) in degrees on the model's ellipsoid, height
//! above it (m), image (x, y) corner-origin with the first pixel centre at (0.5, 0.5) — CSM's own
//! (line, sample) convention, so x = sample and y = line with no offset.

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result, INTERNAL, INVALID};
#[cfg(not(target_arch = "wasm32"))]
use std::cell::RefCell;

/// Record type of a host (CSM) model in block jobs (`model_of` in the photo bundle).
pub const RECORD_TYPE: i32 = 9;

/// The host interface: the `gw_host` imports, or a test double natively.
pub trait HostApi {
    /// Ground → image; 0 or −status.
    fn g2i(&self, h: i32, lat: f64, lon: f64, hae: f64, out: &mut [f64; 2]) -> i32;
    /// Image → ground at a height; out = (lat, lon, hae); 0 or −status.
    fn i2g(&self, h: i32, x: f64, y: f64, hae: f64, out: &mut [f64; 3]) -> i32;
    /// Sensor partials n × (∂x, ∂y) into out; returns n (≤ cap/2 written) or −status.
    fn partials(&self, h: i32, lat: f64, lon: f64, hae: f64, out: &mut [f64]) -> i32;
    /// A new handle: the model with `delta` added to its parameters; or −status.
    fn with_params(&self, h: i32, delta: &[f64]) -> i32;
    /// Unmodelled image-space covariance [σxx, σxy, σyy] (px²); 0 or −status.
    fn unmodelled(&self, h: i32, x: f64, y: f64, out: &mut [f64; 3]) -> i32;
    /// Model facts [nParams, hmin, hmax, a, b, covFlag, cov (n × n)…]; returns the full count.
    fn meta(&self, h: i32, out: &mut [f64]) -> i32;
    /// The model's name and parameter names, one per line (UTF-8); returns the full length.
    fn names(&self, h: i32, out: &mut [u8]) -> i32;
    /// A model from its saved state; a handle or −status.
    fn load(&self, state: &[u8]) -> i32;
    /// The last error's text for handle h; returns the full length.
    fn error(&self, h: i32, out: &mut [u8]) -> i32;
    fn free(&self, h: i32);
}

#[cfg(target_arch = "wasm32")]
mod imports {
    #[link(wasm_import_module = "gw_host")]
    extern "C" {
        pub fn csm_g2i(h: i32, lat: f64, lon: f64, hae: f64, out: *mut f64) -> i32;
        pub fn csm_i2g(h: i32, x: f64, y: f64, hae: f64, out: *mut f64) -> i32;
        pub fn csm_partials(h: i32, lat: f64, lon: f64, hae: f64, out: *mut f64, cap: usize) -> i32;
        pub fn csm_with_params(h: i32, delta: *const f64, n: usize) -> i32;
        pub fn csm_unmodelled(h: i32, x: f64, y: f64, out: *mut f64) -> i32;
        pub fn csm_meta(h: i32, out: *mut f64, cap: usize) -> i32;
        pub fn csm_names(h: i32, out: *mut u8, cap: usize) -> i32;
        pub fn csm_load(state: *const u8, len: usize) -> i32;
        pub fn csm_error(h: i32, out: *mut u8, cap: usize) -> i32;
        pub fn csm_free(h: i32);
    }
}

/// The `gw_host` imports (wasm32 only).
#[cfg(target_arch = "wasm32")]
pub struct Imports;

#[cfg(target_arch = "wasm32")]
impl HostApi for Imports {
    fn g2i(&self, h: i32, lat: f64, lon: f64, hae: f64, out: &mut [f64; 2]) -> i32 {
        unsafe { imports::csm_g2i(h, lat, lon, hae, out.as_mut_ptr()) }
    }
    fn i2g(&self, h: i32, x: f64, y: f64, hae: f64, out: &mut [f64; 3]) -> i32 {
        unsafe { imports::csm_i2g(h, x, y, hae, out.as_mut_ptr()) }
    }
    fn partials(&self, h: i32, lat: f64, lon: f64, hae: f64, out: &mut [f64]) -> i32 {
        unsafe { imports::csm_partials(h, lat, lon, hae, out.as_mut_ptr(), out.len()) }
    }
    fn with_params(&self, h: i32, delta: &[f64]) -> i32 {
        unsafe { imports::csm_with_params(h, delta.as_ptr(), delta.len()) }
    }
    fn unmodelled(&self, h: i32, x: f64, y: f64, out: &mut [f64; 3]) -> i32 {
        unsafe { imports::csm_unmodelled(h, x, y, out.as_mut_ptr()) }
    }
    fn meta(&self, h: i32, out: &mut [f64]) -> i32 {
        unsafe { imports::csm_meta(h, out.as_mut_ptr(), out.len()) }
    }
    fn names(&self, h: i32, out: &mut [u8]) -> i32 {
        unsafe { imports::csm_names(h, out.as_mut_ptr(), out.len()) }
    }
    fn load(&self, state: &[u8]) -> i32 {
        unsafe { imports::csm_load(state.as_ptr(), state.len()) }
    }
    fn error(&self, h: i32, out: &mut [u8]) -> i32 {
        unsafe { imports::csm_error(h, out.as_mut_ptr(), out.len()) }
    }
    fn free(&self, h: i32) {
        unsafe { imports::csm_free(h) }
    }
}

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    /// The host natively (tests and fuzzing); there is none otherwise.
    static OVERRIDE: RefCell<Option<std::rc::Rc<dyn HostApi>>> = const { RefCell::new(None) };
}

/// Install a host for this thread (native tests and fuzzing; in wasm the host is the imports).
#[cfg(not(target_arch = "wasm32"))]
pub fn set_host(h: Option<std::rc::Rc<dyn HostApi>>) {
    OVERRIDE.with(|o| *o.borrow_mut() = h);
}

#[cfg(not(target_arch = "wasm32"))]
fn with_host<T>(f: impl FnOnce(&dyn HostApi) -> T) -> Option<T> {
    let o = OVERRIDE.with(|o| o.borrow().clone());
    o.map(|h| f(&*h))
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
fn with_host<T>(f: impl FnOnce(&dyn HostApi) -> T) -> Option<T> {
    Some(f(&Imports))
}

fn no_host() -> Error {
    Error::unsupported("the CSM (usgscsm) module is not loaded in this context")
}

/// Call the host; a negative status becomes an Error with the host's text.
#[inline(always)]
fn call(h: i32, f: impl FnOnce(&dyn HostApi) -> i32) -> Result<i32> {
    match with_host(f) {
        Some(r) if r >= 0 => Ok(r),
        r => Err(host_error(h, r)),
    }
}

/// The error of a failed host call (one copy, not one per call site: the eager core carries it).
#[inline(never)]
fn host_error(h: i32, r: Option<i32>) -> Error {
    let Some(r) = r else { return no_host() };
    let code = (-r).clamp(INVALID, INTERNAL);
    let text = with_host(|a| {
        let mut buf = vec![0u8; 512];
        let n = a.error(h, &mut buf).max(0) as usize;
        if n > buf.len() {
            buf.resize(n, 0);
            a.error(h, &mut buf);
        }
        buf.truncate(n);
        String::from_utf8(buf).unwrap_or_default()
    })
    .unwrap_or_default();
    if text.is_empty() {
        return if code == gw_abi::UNSUPPORTED { no_host() } else { Error::new(code, "CSM model call failed") };
    }
    Error::new(code, text)
}

/// A CSM model held by the host.
pub struct HostModel {
    h: i32,
    name: String,
    params: Vec<String>,
    cov: Option<Vec<f64>>,
    hr: (f64, f64),
}

impl HostModel {
    /// Take ownership of host handle `h` (freed when the model drops).
    pub fn from_handle(h: i32) -> Result<Self> {
        if h <= 0 {
            return Err(Error::invalid("not a CSM model handle"));
        }
        // Owned from here: an error below still frees the handle.
        let mut m = HostModel { h, name: String::new(), params: Vec::new(), cov: None, hr: (-1000.0, 10000.0) };
        let mut meta = vec![0.0; 64];
        let n = call(h, |a| a.meta(h, &mut meta))? as usize;
        if n > meta.len() {
            meta.resize(n, 0.0);
            call(h, |a| a.meta(h, &mut meta))?;
        }
        if n < 6 {
            return Err(Error::new(INTERNAL, "CSM model facts are incomplete"));
        }
        let np = meta[0];
        if !(np >= 0.0 && np <= 4096.0 && np.fract() == 0.0) {
            return Err(Error::new(INTERNAL, "CSM model states an invalid parameter count"));
        }
        let np = np as usize;
        m.hr = (meta[1], meta[2]);
        if meta[5] != 0.0 {
            let need = 6 + np * np;
            if n < need {
                return Err(Error::new(INTERNAL, "CSM parameter covariance is incomplete"));
            }
            m.cov = Some(meta[6..need].to_vec());
        }
        let mut buf = vec![0u8; 1024];
        let len = call(h, |a| a.names(h, &mut buf))? as usize;
        if len > buf.len() {
            buf.resize(len, 0);
            call(h, |a| a.names(h, &mut buf))?;
        }
        buf.truncate(len);
        let text = String::from_utf8(buf).map_err(|_| Error::new(INTERNAL, "CSM model names are not UTF-8"))?;
        let mut lines = text.split('\n');
        m.name = lines.next().unwrap_or("CSM").to_string();
        m.params = lines.map(str::to_string).collect();
        m.params.resize(np, String::new());
        Ok(m)
    }

    /// A model from its saved state (the host's model-state text).
    pub fn from_state(state: &[u8]) -> Result<Self> {
        let h = call(0, |a| a.load(state))?;
        Self::from_handle(h)
    }

    /// A model from a block-job record: [byte length, state bytes packed 4 per value (u32 LE)].
    pub fn from_record(rec: &[f64]) -> Result<Self> {
        let n = rec.first().copied().unwrap_or(-1.0);
        if !(n >= 0.0 && n.fract() == 0.0 && n <= 1e9) {
            return Err(Error::invalid("CSM record: invalid state length"));
        }
        let n = n as usize;
        let words = n.div_ceil(4);
        if rec.len() != 1 + words {
            return Err(Error::invalid("CSM record has the wrong length"));
        }
        let mut bytes = Vec::with_capacity(words * 4);
        for &w in &rec[1..] {
            if !(w >= 0.0 && w <= u32::MAX as f64 && w.fract() == 0.0) {
                return Err(Error::invalid("CSM record: invalid state word"));
            }
            bytes.extend_from_slice(&(w as u32).to_le_bytes());
        }
        bytes.truncate(n);
        Self::from_state(&bytes)
    }

    /// The record of a state (inverse of `from_record`).
    pub fn record_of(state: &[u8]) -> Vec<f64> {
        let mut r = Vec::with_capacity(1 + state.len().div_ceil(4));
        r.push(state.len() as f64);
        for c in state.chunks(4) {
            let mut w = [0u8; 4];
            w[..c.len()].copy_from_slice(c);
            r.push(u32::from_le_bytes(w) as f64);
        }
        r
    }

    pub fn handle(&self) -> i32 {
        self.h
    }
}

impl Drop for HostModel {
    fn drop(&mut self) {
        let h = self.h;
        with_host(|a| a.free(h));
    }
}

impl SensorModel for HostModel {
    fn name(&self) -> &str {
        &self.name
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let mut o = [0.0; 2];
        call(self.h, |a| a.g2i(self.h, g.lat, g.lon, g.h, &mut o))?;
        if !(o[0].is_finite() && o[1].is_finite()) {
            return Err(Error::range("the CSM model has no image point for this ground point"));
        }
        Ok((o[0], o[1]))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let mut o = [0.0; 3];
        call(self.h, |a| a.i2g(self.h, x, y, h, &mut o))?;
        if !(o[0].is_finite() && o[1].is_finite()) {
            return Err(Error::range("the CSM model's line of sight misses the surface at this height"));
        }
        Ok(Ground { lat: o[0], lon: o[1], h: o[2] })
    }
    fn height_range(&self) -> (f64, f64) {
        self.hr
    }
    fn param_count(&self) -> usize {
        self.params.len()
    }
    fn param_name(&self, i: usize) -> String {
        self.params.get(i).cloned().unwrap_or_default()
    }
    fn param_covariance(&self) -> Option<Vec<f64>> {
        self.cov.clone()
    }
    fn with_params(&self, delta: &[f64]) -> Result<Box<dyn SensorModel>> {
        if delta.len() > self.params.len() {
            return Err(Error::invalid("more corrections than the CSM model has parameters"));
        }
        let h = call(self.h, |a| a.with_params(self.h, delta))?;
        let mut m = HostModel::from_handle(h)?;
        m.cov = self.cov.clone();
        Ok(Box::new(m))
    }
    /// CSM computeSensorPartials (usgscsm: its own differencing in the model).
    fn param_partials(&self, g: Ground) -> Result<Vec<[f64; 2]>> {
        let n = self.params.len();
        let mut buf = vec![0.0; 2 * n];
        let got = call(self.h, |a| a.partials(self.h, g.lat, g.lon, g.h, &mut buf))? as usize;
        if got != n {
            return Err(Error::new(INTERNAL, "CSM sensor partials have the wrong count"));
        }
        Ok(buf.chunks_exact(2).map(|c| [c[0], c[1]]).collect())
    }
    fn unmodelled_covariance(&self, x: f64, y: f64) -> Option<[f64; 3]> {
        let mut o = [0.0; 3];
        match call(self.h, |a| a.unmodelled(self.h, x, y, &mut o)) {
            // A model that states zero unmodelled error states none (CSM default).
            Ok(_) if o.iter().all(|v| v.is_finite()) && o.iter().any(|v| *v != 0.0) => Some(o),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    /// A host with an affine "camera": x = 100 + 10·(lon − p0), y = 50 − 10·(lat − p1), p2 ignored.
    struct Mock {
        next: Cell<i32>,
        params: RefCell<std::collections::HashMap<i32, Vec<f64>>>,
        freed: RefCell<Vec<i32>>,
        fail_next: Cell<bool>,
    }
    impl Mock {
        fn new() -> Rc<Self> {
            Rc::new(Mock { next: Cell::new(1), params: RefCell::new(Default::default()), freed: RefCell::new(vec![]), fail_next: Cell::new(false) })
        }
        fn make(&self, p: Vec<f64>) -> i32 {
            let h = self.next.get();
            self.next.set(h + 1);
            self.params.borrow_mut().insert(h, p);
            h
        }
        fn p(&self, h: i32) -> Vec<f64> {
            self.params.borrow()[&h].clone()
        }
    }
    impl HostApi for Mock {
        fn g2i(&self, h: i32, lat: f64, lon: f64, _hae: f64, out: &mut [f64; 2]) -> i32 {
            if self.fail_next.replace(false) {
                return -2;
            }
            let p = self.p(h);
            out[0] = 100.0 + 10.0 * (lon - p[0]);
            out[1] = 50.0 - 10.0 * (lat - p[1]);
            0
        }
        fn i2g(&self, h: i32, x: f64, y: f64, hae: f64, out: &mut [f64; 3]) -> i32 {
            let p = self.p(h);
            out[0] = (50.0 - y) / 10.0 + p[1];
            out[1] = (x - 100.0) / 10.0 + p[0];
            out[2] = hae;
            0
        }
        fn partials(&self, _h: i32, _lat: f64, _lon: f64, _hae: f64, out: &mut [f64]) -> i32 {
            let v = [-10.0, 0.0, 0.0, 10.0, 0.0, 0.0];
            let n = v.len().min(out.len());
            out[..n].copy_from_slice(&v[..n]);
            3
        }
        fn with_params(&self, h: i32, delta: &[f64]) -> i32 {
            let mut p = self.p(h);
            for (a, d) in p.iter_mut().zip(delta) {
                *a += d;
            }
            self.make(p)
        }
        fn unmodelled(&self, _h: i32, _x: f64, _y: f64, out: &mut [f64; 3]) -> i32 {
            *out = [0.0; 3];
            0
        }
        fn meta(&self, _h: i32, out: &mut [f64]) -> i32 {
            let v = [3.0, -100.0, 100.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 4.0];
            let n = v.len().min(out.len());
            out[..n].copy_from_slice(&v[..n]);
            v.len() as i32
        }
        fn names(&self, _h: i32, out: &mut [u8]) -> i32 {
            let s = b"USGS_ASTRO_FRAME_SENSOR_MODEL\nlon offset\nlat offset\nunused";
            let n = s.len().min(out.len());
            out[..n].copy_from_slice(&s[..n]);
            s.len() as i32
        }
        fn load(&self, state: &[u8]) -> i32 {
            if state == b"bad" {
                return -1;
            }
            self.make(vec![0.0, 0.0, 0.0])
        }
        fn error(&self, _h: i32, out: &mut [u8]) -> i32 {
            let s = "invalid state ✓".as_bytes();
            let n = s.len().min(out.len());
            out[..n].copy_from_slice(&s[..n]);
            s.len() as i32
        }
        fn free(&self, h: i32) {
            self.freed.borrow_mut().push(h);
        }
    }

    #[test]
    fn without_a_host_calls_are_unsupported() {
        set_host(None);
        let e = HostModel::from_handle(1).err().unwrap();
        assert_eq!(e.code, gw_abi::UNSUPPORTED);
    }

    #[test]
    fn plumbing_through_the_trait() {
        let mock = Mock::new();
        set_host(Some(mock.clone()));
        let h = mock.make(vec![0.0, 0.0, 0.0]);
        let m = HostModel::from_handle(h).unwrap();
        assert_eq!(m.name(), "USGS_ASTRO_FRAME_SENSOR_MODEL");
        assert_eq!(m.param_count(), 3);
        assert_eq!(m.param_name(1), "lat offset");
        assert_eq!(m.height_range(), (-100.0, 100.0));
        let c = m.param_covariance().unwrap();
        assert_eq!(c.len(), 9);
        assert_eq!(c[8], 4.0);
        let g = m.image_to_ground(120.0, 30.0, 5.0).unwrap();
        assert_eq!((g.lat, g.lon, g.h), (2.0, 2.0, 5.0));
        assert_eq!(m.ground_to_image(g).unwrap(), (120.0, 30.0));
        // partials come from the host, not differencing
        let p = m.param_partials(g).unwrap();
        assert_eq!(p, vec![[-10.0, 0.0], [0.0, 10.0], [0.0, 0.0]]);
        // zero unmodelled error → none
        assert!(m.unmodelled_covariance(1.0, 1.0).is_none());
        // with_params gives a new handle with the corrections and keeps the covariance
        let m2 = m.with_params(&[0.5, -0.25]).unwrap();
        assert_eq!(m2.ground_to_image(g).unwrap(), (115.0, 27.5));
        assert_eq!(m2.param_covariance().unwrap()[8], 4.0);
        assert!(m.with_params(&[0.0; 4]).is_err());
        // an image covariance through the generic J Σ Jᵀ
        let cov = crate::image_covariance(&m, 120.0, 30.0, 0.0).unwrap().unwrap();
        assert_eq!(cov, [100.0, 0.0, 100.0]);
        drop(m2);
        drop(m);
        assert_eq!(*mock.freed.borrow(), vec![h + 1, h]);
        set_host(None);
    }

    #[test]
    fn host_errors_keep_their_text_and_code() {
        let mock = Mock::new();
        set_host(Some(mock.clone()));
        let m = HostModel::from_handle(mock.make(vec![0.0; 3])).unwrap();
        mock.fail_next.set(true);
        let e = m.ground_to_image(Ground { lat: 0.0, lon: 0.0, h: 0.0 }).unwrap_err();
        assert_eq!(e.code, gw_abi::RANGE);
        assert_eq!(e.msg, "invalid state ✓");
        let e = HostModel::from_state(b"bad").err().unwrap();
        assert_eq!(e.code, INVALID);
        set_host(None);
    }

    #[test]
    fn records_round_trip() {
        let mock = Mock::new();
        set_host(Some(mock.clone()));
        for s in [&b""[..], b"a", b"abcd", b"abcde", "{\"m\":\"\u{e9}\"}".as_bytes()] {
            let r = HostModel::record_of(s);
            assert_eq!(r.len(), 1 + s.len().div_ceil(4));
            assert!(HostModel::from_record(&r).is_ok());
        }
        assert!(HostModel::from_record(&[]).is_err());
        assert!(HostModel::from_record(&[5.0, 1.0]).is_err());
        assert!(HostModel::from_record(&[1.0, -1.0]).is_err());
        assert!(HostModel::from_record(&[1.0, 0.5]).is_err());
        assert!(HostModel::from_record(&[f64::NAN]).is_err());
        assert!(HostModel::from_record(&[1e300, 0.0]).is_err());
        set_host(None);
    }
}
