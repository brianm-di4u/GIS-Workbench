//! Service configuration: command-line flags over `<data>/config.toml` over defaults.

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// Per-user data folder: pairings, uploads, outputs, job folders, logs.
    pub data_dir: PathBuf,
    /// Where the module folders live (`<install>/modules` by default).
    pub modules_dir: PathBuf,
    /// The released HTML files and SHA256SUMS for `/app/` (`<install>/app`).
    pub app_dir: PathBuf,
    /// Ports tried in order (REQ-SDC-02).
    pub ports: Vec<u16>,
    /// Hosted https origins allowed to pair, besides `null` and the sidecar's own `/app/`.
    pub allowed_origins: Vec<String>,
    pub allow_null_origin: bool,
    pub concurrent_jobs: usize,
    /// Upper bound on uploads + outputs in the data folder (0: free disk space decides).
    pub quota_bytes: u64,
    pub max_upload: u64,
    /// Bytes always left free on the data folder's disk.
    pub reserve_bytes: u64,
    /// No tray icon and no browser windows (tests, services).
    pub headless: bool,
    /// Test builds only (GWB_SIDECAR_TEST=1): an origin paired at start with a known token.
    pub test_pair: Option<(String, String)>,
    /// Test builds only: what "Pick in sidecar" returns instead of opening a dialog.
    pub test_pick: Vec<PathBuf>,
    /// Test builds only: where "Save to folder" copies to.
    pub test_save_dir: Option<PathBuf>,
    /// Test builds only: open the `database` gate of a gated profile (OD-2.17).
    pub test_allow_database: bool,
    /// Test builds only: open the gate of the CORS relay, in a binary that has it (OD-2.17).
    #[cfg(feature = "cors-relay")]
    pub test_allow_cors_relay: bool,
    /// Test builds only: the relay trusts this CA instead of the system's roots.
    #[cfg(feature = "cors-relay")]
    pub test_relay_ca: Option<PathBuf>,
    /// Test builds only: a fixed answer for a name the relay resolves.
    #[cfg(feature = "cors-relay")]
    pub test_relay_resolve: Vec<(String, std::net::IpAddr)>,
    /// Test builds only: which device the stereo viewer draws on instead of a window on the screen:
    /// `soft-quad`, `soft-mono` or `hidden`.
    pub test_stereo_device: Option<String>,
    /// Where the viewer is (`gwb-stereo-viewer` beside the sidecar by default).
    pub stereo_exe: PathBuf,
    /// Test builds with the `csm-host` feature only: open the `csm-plugin` gate (OD-2.18).
    pub test_allow_csm: bool,
    /// Test builds with the `csm-host` feature only: the folder of the built host.
    pub test_csm_host: Option<PathBuf>,
    /// Tests only: the wall limit of one host call, in place of a minute.
    pub test_csm_wall_ms: Option<u64>,
    /// Write the bound port here once listening (tests).
    pub port_file: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    allowed_origins: Option<Vec<String>>,
    allow_null_origin: Option<bool>,
    concurrent_jobs: Option<usize>,
    quota_gb: Option<f64>,
    max_upload_gb: Option<f64>,
    reserve_gb: Option<f64>,
    modules_dir: Option<PathBuf>,
    app_dir: Option<PathBuf>,
}

pub fn default_data_dir() -> PathBuf {
    #[cfg(windows)]
    return local_app_data().join("GIS Workbench Sidecar");
    // Linux: the XDG data folder (~/.local/share unless XDG_DATA_HOME says otherwise).
    #[cfg(not(windows))]
    {
        let xdg = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute());
        let home = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"));
        xdg.or(home).unwrap_or_else(std::env::temp_dir).join("gis-workbench-sidecar")
    }
}

/// The user's LocalAppData from the Known Folder API (environment variables are missing in some
/// contexts, e.g. an installer's custom action), then %LOCALAPPDATA%, then TEMP.
#[cfg(windows)]
fn local_app_data() -> PathBuf {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath};
        let mut p: windows_sys::core::PWSTR = std::ptr::null_mut();
        if SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, std::ptr::null_mut(), &mut p) == 0 && !p.is_null() {
            let mut n = 0;
            while *p.add(n) != 0 {
                n += 1;
            }
            let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, n));
            windows_sys::Win32::System::Com::CoTaskMemFree(p as *const _);
            if !s.is_empty() {
                return PathBuf::from(s);
            }
        }
    }
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

fn install_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())).unwrap_or_else(|| PathBuf::from("."))
}

pub fn test_mode() -> bool {
    std::env::var("GWB_SIDECAR_TEST").map(|v| v == "1").unwrap_or(false)
}

impl Config {
    /// Whether a gate is open. Nothing in a shipped build opens one (OD-2.17, OD-2.18): there is
    /// no setting for it, only the test flags. The plug-in host's gate has one lock more: without
    /// the `csm-host` feature, which no package build sets, it cannot open at all.
    pub fn gate_open(&self, gate: &str) -> bool {
        match gate {
            "database" => self.test_allow_database && test_mode(),
            "csm-plugin" => cfg!(feature = "csm-host") && self.test_allow_csm && test_mode(),
            _ => false,
        }
    }

    /// Whether the CORS relay answers (OD-2.17). A shipped build has no relay at all; a build that
    /// has it needs the test flag in a test run. There is no setting for it.
    #[cfg(feature = "cors-relay")]
    pub fn cors_relay_open(&self) -> bool {
        self.test_allow_cors_relay && test_mode()
    }

    #[cfg(not(feature = "cors-relay"))]
    pub fn cors_relay_open(&self) -> bool {
        false
    }

    pub fn defaults(data_dir: PathBuf) -> Config {
        let inst = install_dir();
        Config {
            data_dir,
            modules_dir: inst.join("modules"),
            app_dir: inst.join("app"),
            ports: gwb_sidecar_api::PORTS.to_vec(),
            allowed_origins: vec![],
            allow_null_origin: true,
            concurrent_jobs: 2,
            quota_bytes: 0,
            max_upload: 256 << 30,
            reserve_bytes: 2 << 30,
            headless: false,
            test_pair: None,
            test_pick: vec![],
            test_save_dir: None,
            test_allow_database: false,
            #[cfg(feature = "cors-relay")]
            test_allow_cors_relay: false,
            #[cfg(feature = "cors-relay")]
            test_relay_ca: None,
            #[cfg(feature = "cors-relay")]
            test_relay_resolve: vec![],
            test_stereo_device: None,
            stereo_exe: inst.join(format!("gwb-stereo-viewer{}", std::env::consts::EXE_SUFFIX)),
            test_allow_csm: false,
            test_csm_host: None,
            test_csm_wall_ms: None,
            port_file: None,
        }
    }

    /// Parse `args` (without the program name).
    pub fn from_args(args: &[String]) -> Result<Config, String> {
        let mut data = None;
        let mut i = 0;
        while i < args.len() {
            if args[i] == "--data-dir" {
                data = args.get(i + 1).map(PathBuf::from);
            }
            i += 1;
        }
        let mut c = Config::defaults(data.unwrap_or_else(default_data_dir));
        let cfg_path = c.data_dir.join("config.toml");
        if let Ok(text) = std::fs::read_to_string(&cfg_path) {
            let f: FileConfig = toml::from_str(&text).map_err(|e| format!("{}: {e}", cfg_path.display()))?;
            if let Some(v) = f.allowed_origins {
                c.allowed_origins = v;
            }
            if let Some(v) = f.allow_null_origin {
                c.allow_null_origin = v;
            }
            if let Some(v) = f.concurrent_jobs {
                c.concurrent_jobs = v.clamp(1, 16);
            }
            if let Some(v) = f.quota_gb {
                c.quota_bytes = (v.max(0.0) * 1e9) as u64;
            }
            if let Some(v) = f.max_upload_gb {
                c.max_upload = (v.max(0.0) * 1e9) as u64;
            }
            if let Some(v) = f.reserve_gb {
                c.reserve_bytes = (v.max(0.0) * 1e9) as u64;
            }
            if let Some(v) = f.modules_dir {
                c.modules_dir = v;
            }
            if let Some(v) = f.app_dir {
                c.app_dir = v;
            }
        }
        let test = test_mode();
        let mut i = 0;
        let val = |i: usize| args.get(i + 1).cloned().ok_or_else(|| format!("{} needs a value", args[i]));
        while i < args.len() {
            match args[i].as_str() {
                "--data-dir" => i += 1,
                "--modules-dir" => {
                    c.modules_dir = PathBuf::from(val(i)?);
                    i += 1;
                }
                "--app-dir" => {
                    c.app_dir = PathBuf::from(val(i)?);
                    i += 1;
                }
                "--port" => {
                    let p: u16 = val(i)?.parse().map_err(|_| "--port needs a number")?;
                    if !gwb_sidecar_api::PORTS.contains(&p) && !test {
                        return Err(format!("--port must be one of {:?}", gwb_sidecar_api::PORTS));
                    }
                    c.ports = vec![p];
                    i += 1;
                }
                "--allow-origin" => {
                    c.allowed_origins.push(crate::security::normalise_origin(&val(i)?)?);
                    i += 1;
                }
                "--no-null-origin" => c.allow_null_origin = false,
                "--quota-bytes" => {
                    c.quota_bytes = val(i)?.parse().map_err(|_| "--quota-bytes needs a number")?;
                    i += 1;
                }
                "--concurrent-jobs" => {
                    c.concurrent_jobs = val(i)?.parse::<usize>().map_err(|_| "--concurrent-jobs needs a number")?.clamp(1, 16);
                    i += 1;
                }
                "--headless" => c.headless = true,
                "--port-file" => {
                    c.port_file = Some(PathBuf::from(val(i)?));
                    i += 1;
                }
                "--test-pair" | "--test-pick" | "--test-save-dir" | "--test-allow-database" | "--test-allow-cors-relay" | "--test-relay-ca" | "--test-relay-resolve" | "--test-stereo-device" | "--test-stereo-exe" if !test => return Err(format!("{} is only available with GWB_SIDECAR_TEST=1", args[i])),
                "--test-allow-database" => c.test_allow_database = true,
                #[cfg(feature = "cors-relay")]
                "--test-allow-cors-relay" => c.test_allow_cors_relay = true,
                #[cfg(feature = "cors-relay")]
                "--test-relay-ca" => {
                    c.test_relay_ca = Some(PathBuf::from(val(i)?));
                    i += 1;
                }
                #[cfg(feature = "cors-relay")]
                "--test-relay-resolve" => {
                    let v = val(i)?;
                    let (h, a) = v.split_once('=').ok_or("--test-relay-resolve HOST=ADDRESS")?;
                    c.test_relay_resolve.push((h.to_ascii_lowercase(), a.parse().map_err(|_| "--test-relay-resolve: not an address")?));
                    i += 1;
                }
                #[cfg(not(feature = "cors-relay"))]
                "--test-allow-cors-relay" | "--test-relay-ca" | "--test-relay-resolve" => return Err("this build has no CORS relay (OD-2.17)".into()),
                "--test-stereo-device" => {
                    let v = val(i)?;
                    if !["soft-quad", "soft-mono", "hidden"].contains(&v.as_str()) {
                        return Err("--test-stereo-device: soft-quad, soft-mono or hidden".into());
                    }
                    c.test_stereo_device = Some(v);
                    i += 1;
                }
                "--test-stereo-exe" => {
                    c.stereo_exe = PathBuf::from(val(i)?);
                    i += 1;
                }
                // Unknown flags, without the feature: a shipped binary refuses them at start.
                #[cfg(feature = "csm-host")]
                "--test-allow-csm" | "--test-csm-host" if !test => return Err(format!("{} is only available with GWB_SIDECAR_TEST=1", args[i])),
                #[cfg(feature = "csm-host")]
                "--test-allow-csm" => c.test_allow_csm = true,
                #[cfg(feature = "csm-host")]
                "--test-csm-host" => {
                    c.test_csm_host = Some(PathBuf::from(val(i)?));
                    i += 1;
                }
                "--test-pair" => {
                    let v = val(i)?;
                    let (o, t) = v.rsplit_once('=').ok_or("--test-pair ORIGIN=TOKEN")?;
                    if t.len() < 32 || !t.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Err("--test-pair: the token must be ≥ 32 hex digits".into());
                    }
                    let o = if o == "null" { "null".to_string() } else { crate::security::normalise_origin(o)? };
                    c.test_pair = Some((o, t.to_ascii_lowercase()));
                    i += 1;
                }
                "--test-pick" => {
                    c.test_pick.push(PathBuf::from(val(i)?));
                    i += 1;
                }
                "--test-save-dir" => {
                    c.test_save_dir = Some(PathBuf::from(val(i)?));
                    i += 1;
                }
                other if other.starts_with("--") => return Err(format!("unknown flag {other}")),
                _ => {}
            }
            i += 1;
        }
        Ok(c)
    }
}
