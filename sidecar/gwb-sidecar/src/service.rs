//! The service state shared by every request.

use crate::caps::Caps;
use crate::config::Config;
use crate::files::{free_space, Files};
use crate::jobs::Jobs;
use crate::pairing::Pairings;
use crate::profiles::{self, Profile};
use crate::prosync::Sync;
use crate::relay::Relay;
use crate::stereo::Stereo;
use crate::util;
use crate::views::Views;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub struct Admin {
    /// Secret of the open sidecar window (one at a time); sent as X-Gwb-Admin.
    pub session: Mutex<Option<String>>,
    /// One-time codes that open the window (`/ui/?launch=`), valid 2 minutes.
    pub launch: Mutex<HashMap<String, Instant>>,
    /// Long-lived key in `<data>/ui.key` (user-only folder) so a second start can open the window.
    pub key: String,
    pub last_poll: Mutex<Option<Instant>>,
}

pub struct Service {
    pub cfg: Config,
    pub port: u16,
    pub pairings: Pairings,
    pub relay: Relay,
    pub sync: Sync,
    pub stereo: Stereo,
    #[cfg(feature = "cors-relay")]
    pub cors: crate::corsrelay::CorsRelay,
    pub files: Files,
    pub jobs: Jobs,
    pub views: Views,
    pub caps: Arc<Caps>,
    pub profiles: Vec<Profile>,
    pub admin: Admin,
    pub log: Mutex<VecDeque<String>>,
    pub started: String,
    /// The plug-in records and sessions, in a build that has them (OD-2.18).
    #[cfg(feature = "csm-host")]
    pub csm: crate::csmhost::State,
}

impl Service {
    pub fn new(cfg: Config, port: u16) -> Result<Arc<Service>, String> {
        std::fs::create_dir_all(&cfg.data_dir).map_err(|e| format!("{}: {e}", cfg.data_dir.display()))?;
        let _ = std::fs::remove_dir_all(cfg.data_dir.join("jobs")); // half-done jobs of a crash
        std::fs::create_dir_all(cfg.data_dir.join("jobs")).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(cfg.data_dir.join("views")); // views last as long as the service
        let profiles = profiles::load_all()?;
        let pairings = Pairings::open(cfg.data_dir.join("pairings.json"));
        if let Some((o, t)) = &cfg.test_pair {
            if !pairings.verify(o, t) {
                pairings.add_token(o, t, "test pairing (GWB_SIDECAR_TEST)");
            }
        }
        let key_path = cfg.data_dir.join("ui.key");
        let key = match std::fs::read_to_string(&key_path) {
            Ok(k) if k.trim().len() == 64 => k.trim().to_string(),
            _ => {
                let k = util::random_hex(32);
                let _ = std::fs::write(&key_path, &k);
                k
            }
        };
        let caps = Arc::new(Caps::new(cfg.modules_dir.clone(), cfg.data_dir.join("jobs")));
        Ok(Arc::new(Service {
            files: Files::open(&cfg.data_dir),
            jobs: Jobs::new(cfg.concurrent_jobs),
            views: Views::new(),
            pairings,
            relay: Relay::new(),
            sync: Sync::new(),
            stereo: Stereo::new(),
            #[cfg(feature = "cors-relay")]
            cors: crate::corsrelay::CorsRelay::open(cfg.data_dir.join("cors-relay.json"), cfg.test_relay_ca.clone(), cfg.test_relay_resolve.clone()),
            caps,
            profiles,
            admin: Admin { session: Mutex::new(None), launch: Mutex::new(HashMap::new()), key, last_poll: Mutex::new(None) },
            log: Mutex::new(VecDeque::new()),
            started: util::now_rfc3339(),
            #[cfg(feature = "csm-host")]
            csm: crate::csmhost::State::open(&cfg.data_dir),
            cfg,
            port,
        }))
    }

    pub fn log(&self, line: impl Into<String>) {
        use std::io::Write;
        let l = format!("{} {}", util::now_rfc3339(), line.into());
        // Never eprintln!: it panics when the parent that gave us stderr has gone (a closed pipe).
        let _ = writeln!(std::io::stderr(), "{l}");
        // The service log file (kept to ~4 MB, one previous file).
        let path = self.cfg.data_dir.join("sidecar.log");
        if std::fs::metadata(&path).map(|m| m.len() > 4 << 20).unwrap_or(false) {
            let _ = std::fs::rename(&path, self.cfg.data_dir.join("sidecar.log.1"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "{l}");
        }
        let mut q = self.log.lock().unwrap();
        q.push_back(l);
        if q.len() > 2000 {
            q.pop_front();
        }
    }

    /// The sidecar's own `/app/` origin.
    pub fn app_origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn ui_origin(&self) -> String {
        format!("http://localhost:{}", self.port)
    }

    /// Origins allowed to call the API (REQ-SDC-04): `null`, configured and user-added hosted
    /// origins, and the sidecar's own `/app/`.
    pub fn origin_allowed(&self, o: &str) -> bool {
        if o == "null" {
            return self.cfg.allow_null_origin;
        }
        o == self.app_origin() || self.cfg.allowed_origins.iter().any(|x| x == o) || self.pairings.extra_origins().iter().any(|x| x == o) || self.cfg.test_pair.as_ref().is_some_and(|(to, _)| to == o)
    }

    /// Bytes a new upload or output may still use.
    pub fn space_left(&self) -> u64 {
        let free = free_space(&self.cfg.data_dir).saturating_sub(self.cfg.reserve_bytes);
        if self.cfg.quota_bytes > 0 {
            free.min(self.cfg.quota_bytes.saturating_sub(self.files.used_bytes()))
        } else {
            free
        }
    }

    pub fn new_launch_code(&self) -> String {
        let c = util::random_hex(16);
        let mut m = self.admin.launch.lock().unwrap();
        m.retain(|_, t| t.elapsed().as_secs() < 120);
        m.insert(c.clone(), Instant::now());
        c
    }

    pub fn ui_url(&self) -> String {
        format!("{}/ui/?launch={}", self.ui_origin(), self.new_launch_code())
    }
}
