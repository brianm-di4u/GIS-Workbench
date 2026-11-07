//! The native stereo viewer's side of the sidecar (REQ-GAP-33, SDP-2.3 GR-11). A browser cannot
//! reach a quad-buffer pixel format, so the sidecar starts a small native program,
//! `gwb-stereo-viewer`, and feeds it. The viewer never sees a path: it asks for tiles by session,
//! eye and level, on loopback, with a ticket that lives as long as the session, and the tiles come
//! from the same sandboxed `gdal_translate` runs that serve views (REQ-GAP-70). What the viewer
//! parses from the file is therefore nothing: it gets RGBA pixels.
//!
//! The viewer runs in a Job Object like any tool (Low integrity, memory and process limits,
//! killed with the sidecar). It opens a window on the desktop, so it only starts for a request that
//! came through a paired page, and a headless sidecar refuses unless a test run names a device with
//! no window.

use crate::files::FileRec;
use crate::service::Service;
use crate::views::{self, View, ViewError, TILE};
use crate::winjob::{spawn_in_job, JobLimits, ProcessJob};
use gwb_sidecar_api::*;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Viewers open at once: each is a window of the analyst's, and two pairs is already a lot.
pub const MAX_SESSIONS: usize = 2;
/// Largest image-to-display scale in an affine: anything larger is a broken fit.
pub const MAX_AFFINE: f64 = 1e9;

pub fn available(svc: &Service) -> bool {
    cfg!(windows) && svc.cfg.stereo_exe.is_file() && (!svc.cfg.headless || svc.cfg.test_stereo_device.is_some())
}

struct Status {
    state: StereoState,
    shown: Option<StereoMode>,
    quad_available: Option<bool>,
    frames: u64,
    detail: Option<String>,
    readback: Option<StereoReadback>,
}

/// The stretch of one eye: `(low, high)` of its samples; `None` for 8-bit, shown as it is.
pub type Stretch = Option<(f64, f64)>;

pub struct Session {
    pub id: String,
    pub owner: String,
    ticket: String,
    requested: StereoMode,
    left: Arc<View>,
    right: Arc<View>,
    stretch: [Stretch; 2],
    affines: [[f64; 6]; 2],
    st: Mutex<Status>,
    job: Mutex<Option<ProcessJob>>,
}

impl Session {
    pub fn info(&self) -> StereoInfo {
        let s = self.st.lock().unwrap();
        StereoInfo { id: self.id.clone(), state: s.state, requested: self.requested, shown: s.shown, quad_available: s.quad_available, frames: s.frames, detail: s.detail.clone(), left: self.left.info(), right: self.right.info(), readback: s.readback.clone() }
    }

    fn eye(v: &View, affine: [f64; 6]) -> StereoEye {
        StereoEye { name: v.file.name.clone(), width: v.layout.width, height: v.layout.height, levels: v.layout.levels.iter().map(|l| [l.width, l.height]).collect(), affine }
    }

    pub fn scene(&self) -> StereoScene {
        StereoScene { tile: TILE, mode: self.requested, left: Session::eye(&self.left, self.affines[0]), right: Session::eye(&self.right, self.affines[1]) }
    }

    /// What the viewer says. Reports after the end are ignored: the sidecar saw it go.
    pub fn report(&self, svc: &Service, r: StereoReport) {
        let mut s = self.st.lock().unwrap();
        if matches!(s.state, StereoState::Closed | StereoState::Failed) {
            return;
        }
        if s.state != StereoState::Showing && r.state == StereoState::Showing {
            svc.log(format!("stereo viewer {} shows the pair: {:?}{}", self.id, r.shown, r.detail.as_deref().map(|d| format!(" ({d})")).unwrap_or_default()));
        }
        s.state = r.state;
        s.shown = Some(r.shown);
        s.quad_available = Some(r.quad_available);
        s.frames = r.frames;
        s.detail = r.detail.map(|d| d.chars().filter(|c| !c.is_control()).take(400).collect());
        if r.readback.is_some() {
            s.readback = r.readback;
        }
    }

    fn ended(&self, how: StereoState, detail: Option<String>) {
        let mut s = self.st.lock().unwrap();
        if !matches!(s.state, StereoState::Closed | StereoState::Failed) {
            s.state = how;
            if detail.is_some() {
                s.detail = detail;
            }
        }
    }

    fn live(&self) -> bool {
        !matches!(self.st.lock().unwrap().state, StereoState::Closed | StereoState::Failed)
    }

    fn view(&self, eye: &str) -> Option<(&Arc<View>, Stretch)> {
        match eye {
            "left" => Some((&self.left, self.stretch[0])),
            "right" => Some((&self.right, self.stretch[1])),
            _ => None,
        }
    }
}

#[derive(Serialize)]
pub struct StereoStatus {
    pub open: usize,
}

#[derive(Default)]
pub struct Stereo {
    map: Mutex<HashMap<String, Arc<Session>>>,
}

fn views_owner(owner: &str) -> String {
    // The session's views are its own: they do not count against the page's sixteen, and no page
    // call can reach them.
    format!("{owner}#stereo")
}

impl Stereo {
    pub fn new() -> Stereo {
        Stereo::default()
    }

    pub fn status(&self) -> StereoStatus {
        StereoStatus { open: self.map.lock().unwrap().values().filter(|s| s.live()).count() }
    }

    pub fn get(&self, id: &str, owner: &str) -> Option<Arc<Session>> {
        self.map.lock().unwrap().get(id).filter(|s| s.owner == owner).cloned()
    }

    /// Tests stand in for the viewer; in a service the ticket is only in the viewer's environment.
    #[doc(hidden)]
    pub fn test_ticket(&self, id: &str) -> Option<String> {
        self.map.lock().unwrap().get(id).map(|s| s.ticket.clone())
    }

    pub fn by_ticket(&self, id: &str, ticket: &str) -> Option<Arc<Session>> {
        self.map.lock().unwrap().get(id).filter(|s| s.live() && crate::util::ct_eq(s.ticket.as_bytes(), ticket.as_bytes())).cloned()
    }

    fn release(&self, svc: &Service, s: &Session) {
        let owner = views_owner(&s.owner);
        svc.views.close(&s.left.id, &owner);
        svc.views.close(&s.right.id, &owner);
    }

    /// End a session: the viewer is killed, its views go, and so does the record.
    pub fn close(&self, svc: &Service, s: &Arc<Session>) {
        s.ended(StereoState::Closed, None);
        if let Some(j) = s.job.lock().unwrap().as_ref() {
            j.terminate(0);
        }
        self.release(svc, s);
        self.map.lock().unwrap().remove(&s.id);
    }

    pub fn close_owner(&self, svc: &Service, owner: &str) {
        let mine: Vec<Arc<Session>> = self.map.lock().unwrap().values().filter(|s| s.owner == owner).cloned().collect();
        for s in mine {
            self.close(svc, &s);
        }
    }

    fn finished(&self, svc: &Service, s: &Arc<Session>, how: StereoState, detail: Option<String>) {
        s.ended(how, detail);
        self.release(svc, s);
        *s.job.lock().unwrap() = None;
    }
}

fn check_affine(a: &[f64; 6]) -> Result<(), ViewError> {
    let det = a[0] * a[4] - a[1] * a[3];
    if a.iter().all(|v| v.is_finite() && v.abs() <= MAX_AFFINE) && det.is_finite() && det.abs() > 1e-12 {
        Ok(())
    } else {
        Err((400, "bad_affine", "an eye's affine must be finite and invertible".into()))
    }
}

/// The low and high 2 % of what a tile holds, for samples of more than 8 bits.
pub fn percentiles(samples: &mut Vec<f64>) -> Option<(f64, f64)> {
    samples.retain(|v| v.is_finite());
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(f64::total_cmp);
    let at = |q: f64| samples[((samples.len() - 1) as f64 * q).round() as usize];
    let (lo, hi) = (at(0.02), at(0.98));
    if hi > lo {
        Some((lo, hi))
    } else {
        Some((samples[0], samples[samples.len() - 1].max(samples[0] + 1.0)))
    }
}

/// One sample of a band-interleaved little-endian tile as a number.
fn sample(b: &[u8], sample_type: &str) -> f64 {
    match sample_type {
        "UInt16" => u16::from_le_bytes([b[0], b[1]]) as f64,
        "Int16" => i16::from_le_bytes([b[0], b[1]]) as f64,
        "UInt32" => u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
        "Int32" => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
        "Float32" => f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
        _ => b[0] as f64,
    }
}

/// A view's tile as RGBA8: one band is grey, three or more are the first three, and a stretch
/// applies to samples of more than 8 bits. What the viewer draws is decided here.
pub fn to_rgba(tile: &[u8], bands: u32, sample_bytes: u32, sample_type: &str, stretch: Stretch) -> Vec<u8> {
    let (px, sb) = ((bands * sample_bytes) as usize, sample_bytes as usize);
    let n = tile.len() / px.max(1);
    let mut out = Vec::with_capacity(n * 4);
    let map = |v: f64| match stretch {
        Some((lo, hi)) => (((v - lo) / (hi - lo)).clamp(0.0, 1.0) * 255.0).round() as u8,
        None => v.clamp(0.0, 255.0) as u8,
    };
    let (g, b) = if bands >= 3 { (1, 2) } else { (0, 0) };
    for p in tile.chunks_exact(px) {
        out.push(map(sample(&p[0..sb], sample_type)));
        out.push(map(sample(&p[g * sb..(g + 1) * sb], sample_type)));
        out.push(map(sample(&p[b * sb..(b + 1) * sb], sample_type)));
        out.push(255);
    }
    out
}

/// The stretch of a view: from its coarsest level, a thumbnail of the whole image.
async fn stretch_of(svc: &Arc<Service>, v: &Arc<View>) -> Result<Stretch, ViewError> {
    if v.layout.sample_bytes == 1 {
        return Ok(None);
    }
    let level = v.layout.levels.len() - 1;
    let t = views::tile(svc, v, level, 0, 0).await?;
    let sb = v.layout.sample_bytes as usize;
    let mut s: Vec<f64> = t.chunks_exact(sb).map(|c| sample(c, &v.sample_type)).filter(|x| *x != 0.0).collect();
    Ok(percentiles(&mut s))
}

/// Keep the end of what the viewer printed, for the report if it fails.
fn drain(mut r: impl tokio::io::AsyncRead + Unpin + Send + 'static) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut kept: Vec<u8> = Vec::new();
        let mut b = [0u8; 4096];
        while let Ok(n) = r.read(&mut b).await {
            if n == 0 {
                break;
            }
            kept.extend_from_slice(&b[..n]);
            let len = kept.len();
            if len > 2000 {
                kept.drain(..len - 2000);
            }
        }
        String::from_utf8_lossy(&kept).trim().to_string()
    })
}

/// Open a pair and start its viewer. Refusals are by name, and nothing starts until both eyes open.
pub async fn open(svc: &Arc<Service>, owner: &str, left: FileRec, right: FileRec, r: &StereoRequest) -> Result<Arc<Session>, ViewError> {
    let device = svc.cfg.test_stereo_device.clone().filter(|_| crate::config::test_mode());
    if !cfg!(windows) {
        return Err((501, "no_viewer", "the native stereo viewer is built for Windows only in this release".into()));
    }
    if svc.cfg.headless && device.is_none() {
        return Err((409, "no_display", "this sidecar runs headless: nobody is there to see a window".into()));
    }
    if !svc.cfg.stereo_exe.is_file() {
        return Err((409, "no_viewer", "the native stereo viewer is not installed beside the sidecar".into()));
    }
    const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let affines = [r.left_affine.unwrap_or(IDENTITY), r.right_affine.unwrap_or(IDENTITY)];
    check_affine(&affines[0])?;
    check_affine(&affines[1])?;
    if svc.stereo.status().open >= MAX_SESSIONS {
        return Err((409, "busy", format!("{MAX_SESSIONS} stereo viewers are open: close one first")));
    }
    {
        // Sessions that ended and were never deleted.
        let mut m = svc.stereo.map.lock().unwrap();
        m.retain(|_, s| s.owner != owner || s.live());
    }
    let vo = views_owner(owner);
    let lv = views::open_any(svc, &vo, left).await?;
    let opened = async {
        let rv = views::open_any(svc, &vo, right).await?;
        let lst = stretch_of(svc, &lv).await;
        let rst = stretch_of(svc, &rv).await;
        match (lst, rst) {
            (Ok(a), Ok(b)) => Ok((rv, [a, b])),
            (Err(e), _) | (_, Err(e)) => {
                svc.views.close(&rv.id, &vo);
                Err(e)
            }
        }
    }
    .await;
    let (rv, stretch) = match opened {
        Ok(x) => x,
        Err(e) => {
            svc.views.close(&lv.id, &vo);
            return Err(e);
        }
    };
    let id = crate::util::random_hex(12);
    let ticket = crate::util::random_hex(32);
    let mut cmd = tokio::process::Command::new(&svc.cfg.stereo_exe);
    cmd.args(["--sidecar", &format!("127.0.0.1:{}", svc.port), "--session", &id]);
    if let Some(d) = &device {
        cmd.args(["--device", d]);
    }
    cmd.current_dir(&svc.cfg.data_dir).env_clear().env("GWB_STEREO_TICKET", &ticket);
    // What a graphics driver needs and nothing of the sidecar's own environment.
    for k in ["SystemRoot", "windir", "TEMP", "TMP", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "HOME", "DISPLAY"] {
        if let Some(v) = std::env::var_os(k) {
            cmd.env(k, v);
        }
    }
    let limits = JobLimits { memory_bytes: 8 << 30, cpu_seconds: 7 * 24 * 3600, processes: 4 };
    let spawned = spawn_in_job(cmd, limits);
    let (mut child, job) = match spawned {
        Ok(x) => x,
        Err(e) => {
            svc.views.close(&lv.id, &vo);
            svc.views.close(&rv.id, &vo);
            return Err((502, "viewer_failed", format!("the stereo viewer could not start: {e}")));
        }
    };
    let s = Arc::new(Session {
        id: id.clone(),
        owner: owner.to_string(),
        ticket,
        requested: r.mode,
        left: lv,
        right: rv,
        stretch,
        affines,
        st: Mutex::new(Status { state: StereoState::Starting, shown: None, quad_available: None, frames: 0, detail: None, readback: None }),
        job: Mutex::new(Some(job)),
    });
    svc.stereo.map.lock().unwrap().insert(id, s.clone());
    let out = child.stdout.take().map(drain);
    let err = child.stderr.take().map(drain);
    let (svc2, s2) = (svc.clone(), s.clone());
    tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|c| c.code());
        let mut text = String::new();
        for t in [out, err].into_iter().flatten() {
            if let Ok(x) = t.await {
                if !x.is_empty() {
                    text = x;
                }
            }
        }
        if code == Some(0) {
            svc2.stereo.finished(&svc2, &s2, StereoState::Closed, None);
            svc2.log(format!("stereo viewer {} closed", s2.id));
        } else {
            let why = format!("the viewer stopped (exit {code:?}){}{}", if text.is_empty() { "" } else { ": " }, text);
            svc2.log(format!("stereo viewer {}: {why}", s2.id));
            svc2.stereo.finished(&svc2, &s2, StereoState::Failed, Some(why));
        }
    });
    Ok(s)
}

/// One tile of one eye as RGBA8.
pub async fn tile(svc: &Arc<Service>, s: &Arc<Session>, eye: &str, level: u32, x: u32, y: u32) -> Result<Vec<u8>, ViewError> {
    let nope = || (404, "not_found", "no such tile".to_string());
    let (v, stretch) = s.view(eye).ok_or_else(nope)?;
    let lv = v.layout.levels.get(level as usize).ok_or_else(nope)?;
    if x >= lv.tiles_x || y >= lv.tiles_y {
        return Err(nope());
    }
    // Asking through the registry keeps the view from being swept while the viewer is open.
    let v = svc.views.get(&v.id, &views_owner(&s.owner)).ok_or_else(|| (410, "gone", "the view was closed".to_string()))?;
    let t = views::tile(svc, &v, level as usize, x, y).await?;
    Ok(to_rgba(&t, v.layout.bands, v.layout.sample_bytes, &v.sample_type, stretch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affines_are_checked() {
        assert!(check_affine(&[1.0, 0.0, 5.0, 0.0, 1.0, -3.0]).is_ok());
        assert!(check_affine(&[0.5, 0.1, 0.0, -0.1, 0.5, 0.0]).is_ok());
        for bad in [[0.0; 6], [1.0, 2.0, 0.0, 2.0, 4.0, 0.0], [f64::NAN, 0.0, 0.0, 0.0, 1.0, 0.0], [f64::INFINITY, 0.0, 0.0, 0.0, 1.0, 0.0], [1e10, 0.0, 0.0, 0.0, 1.0, 0.0]] {
            assert!(check_affine(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn tiles_become_rgba() {
        assert_eq!(to_rgba(&[7, 9], 1, 1, "Byte", None), vec![7, 7, 7, 255, 9, 9, 9, 255]);
        assert_eq!(to_rgba(&[1, 2, 3, 4, 5, 6], 3, 1, "Byte", None), vec![1, 2, 3, 255, 4, 5, 6, 255]);
        assert_eq!(to_rgba(&[1, 2, 3, 200, 4, 5, 6, 200], 4, 1, "Byte", None), vec![1, 2, 3, 255, 4, 5, 6, 255]);
        let t: Vec<u8> = [0u16, 1000, 2000].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(to_rgba(&t, 1, 2, "UInt16", Some((0.0, 2000.0))), vec![0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
        let f: Vec<u8> = [-1f32, 0.5].iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(to_rgba(&f, 1, 4, "Float32", Some((0.0, 1.0))), vec![0, 0, 0, 255, 128, 128, 128, 255]);
    }

    #[test]
    fn the_stretch_ignores_outliers() {
        let mut v: Vec<f64> = (0..1000).map(|i| i as f64).collect();
        v[999] = 1e9;
        let (lo, hi) = percentiles(&mut v).unwrap();
        assert!((lo - 20.0).abs() < 1.5 && (hi - 979.0).abs() < 1.5, "{lo} {hi}");
        assert_eq!(percentiles(&mut vec![f64::NAN]), None);
        let (lo, hi) = percentiles(&mut vec![5.0; 10]).unwrap();
        assert!(hi > lo, "a flat tile still divides");
    }
}
