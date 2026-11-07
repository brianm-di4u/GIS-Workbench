//! Pairing (REQ-SDC-03, SDP-2.1 §3.3 items 1–3): an origin asks once; the sidecar window shows
//! "Allow <origin>?" with a six-digit code the app also shows; on approval the holder of the
//! (unguessable) pairing id collects a bearer token, once. Only the token's SHA-256 is stored.
//! Tokens are per origin and revocable in the sidecar window.

use crate::util;
use gwb_sidecar_api::{PairStart, PairState, PairStatus};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const PAIR_TTL: Duration = Duration::from_secs(180);
const MAX_PENDING_PER_ORIGIN: usize = 3;
const MAX_PENDING: usize = 16;

#[derive(Debug, Clone)]
pub struct Pending {
    pub id: String,
    pub origin: String,
    pub client: String,
    pub code: String,
    pub created: Instant,
    pub state: PairState,
    token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenRec {
    pub hash: String,
    pub client: String,
    pub created: String,
    #[serde(default)]
    pub last_used: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Store {
    /// origin → tokens.
    pub tokens: BTreeMap<String, Vec<TokenRec>>,
    /// Hosted origins the user allowed in the sidecar window (besides those in config.toml).
    #[serde(default)]
    pub origins: Vec<String>,
}

pub struct Pairings {
    path: PathBuf,
    pending: Mutex<HashMap<String, Pending>>,
    pub store: Mutex<Store>,
    pub notify: tokio::sync::broadcast::Sender<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingView {
    pub id: String,
    pub origin: String,
    pub client: String,
    pub code: String,
    pub age_s: u64,
}

impl Pairings {
    pub fn open(path: PathBuf) -> Pairings {
        let store = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let (notify, _) = tokio::sync::broadcast::channel(32);
        Pairings { path, pending: Mutex::new(HashMap::new()), store: Mutex::new(store), notify }
    }

    fn save(&self, s: &Store) {
        let tmp = self.path.with_extension("tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(s).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }

    fn expire(map: &mut HashMap<String, Pending>) {
        map.retain(|_, p| p.created.elapsed() < PAIR_TTL * 2);
        for p in map.values_mut() {
            if p.state == PairState::Pending && p.created.elapsed() >= PAIR_TTL {
                p.state = PairState::Expired;
            }
        }
    }

    pub fn start(&self, origin: &str, client: &str) -> Result<PairStart, String> {
        let client: String = client.chars().filter(|c| !c.is_control()).take(80).collect();
        if client.trim().is_empty() {
            return Err("the client name is empty".into());
        }
        let mut map = self.pending.lock().unwrap();
        Self::expire(&mut map);
        let live = |o: Option<&str>| map.values().filter(|p| p.state == PairState::Pending && o.is_none_or(|o| p.origin == o)).count();
        if live(Some(origin)) >= MAX_PENDING_PER_ORIGIN || live(None) >= MAX_PENDING {
            return Err("too many pairing requests are waiting; approve or deny them in the sidecar window".into());
        }
        let p = Pending { id: util::random_hex(24), origin: origin.into(), client, code: util::pairing_code(), created: Instant::now(), state: PairState::Pending, token: None };
        let out = PairStart { pairing_id: p.id.clone(), code: p.code.clone(), expires_in: PAIR_TTL.as_secs() as u32 };
        map.insert(p.id.clone(), p);
        let _ = self.notify.send(origin.to_string());
        Ok(out)
    }

    /// Poll a pairing; the token is handed over once, to the origin that asked.
    pub fn poll(&self, id: &str, origin: &str) -> Option<PairStatus> {
        let mut map = self.pending.lock().unwrap();
        Self::expire(&mut map);
        let p = map.get_mut(id)?;
        if p.origin != origin {
            return None;
        }
        let token = if p.state == PairState::Approved { p.token.take() } else { None };
        Some(PairStatus { state: p.state, token })
    }

    pub fn list_pending(&self) -> Vec<PendingView> {
        let mut map = self.pending.lock().unwrap();
        Self::expire(&mut map);
        let mut v: Vec<PendingView> = map.values().filter(|p| p.state == PairState::Pending).map(|p| PendingView { id: p.id.clone(), origin: p.origin.clone(), client: p.client.clone(), code: p.code.clone(), age_s: p.created.elapsed().as_secs() }).collect();
        v.sort_by_key(|p| p.age_s);
        v
    }

    pub fn decide(&self, id: &str, approve: bool) -> Result<(), String> {
        let mut map = self.pending.lock().unwrap();
        Self::expire(&mut map);
        let p = map.get_mut(id).ok_or("no such pairing request")?;
        if p.state != PairState::Pending {
            return Err(format!("the request is {:?}", p.state).to_lowercase());
        }
        if !approve {
            p.state = PairState::Denied;
            return Ok(());
        }
        let token = util::random_hex(32);
        self.add_token(&p.origin, &token, &p.client);
        p.token = Some(token);
        p.state = PairState::Approved;
        Ok(())
    }

    pub fn add_token(&self, origin: &str, token: &str, client: &str) {
        let mut s = self.store.lock().unwrap();
        let v = s.tokens.entry(origin.to_string()).or_default();
        v.push(TokenRec { hash: util::sha256_hex(token.as_bytes()), client: client.into(), created: util::now_rfc3339(), last_used: None });
        // At most 8 live tokens per origin (each browser profile pairs once).
        if v.len() > 8 {
            v.remove(0);
        }
        self.save(&s);
    }

    pub fn verify(&self, origin: &str, token: &str) -> bool {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        let h = util::sha256_hex(token.to_ascii_lowercase().as_bytes());
        let s = self.store.lock().unwrap();
        let mut ok = false;
        if let Some(v) = s.tokens.get(origin) {
            for t in v {
                ok |= util::ct_eq(t.hash.as_bytes(), h.as_bytes());
            }
        }
        ok
    }

    /// The client name a token was approved under (a relay call carries it to the page).
    pub fn client_of(&self, origin: &str, token: &str) -> Option<String> {
        let h = util::sha256_hex(token.to_ascii_lowercase().as_bytes());
        let s = self.store.lock().unwrap();
        s.tokens.get(origin)?.iter().find(|t| util::ct_eq(t.hash.as_bytes(), h.as_bytes())).map(|t| t.client.clone())
    }

    /// Forget every token of `origin` ("Revoke" in the sidecar window, "Forget sidecar" in the app).
    pub fn revoke(&self, origin: &str) -> bool {
        let mut s = self.store.lock().unwrap();
        let had = s.tokens.remove(origin).is_some();
        self.save(&s);
        had
    }

    /// Forget one token (the app's "Forget sidecar" uses its own token).
    pub fn revoke_token(&self, origin: &str, token: &str) -> bool {
        let h = util::sha256_hex(token.to_ascii_lowercase().as_bytes());
        let mut s = self.store.lock().unwrap();
        let mut had = false;
        if let Some(v) = s.tokens.get_mut(origin) {
            let n = v.len();
            v.retain(|t| !util::ct_eq(t.hash.as_bytes(), h.as_bytes()));
            had = v.len() != n;
            if v.is_empty() {
                s.tokens.remove(origin);
            }
        }
        self.save(&s);
        had
    }

    pub fn paired(&self) -> Vec<(String, usize, String)> {
        let s = self.store.lock().unwrap();
        s.tokens.iter().map(|(o, v)| (o.clone(), v.len(), v.last().map(|t| t.created.clone()).unwrap_or_default())).collect()
    }

    pub fn extra_origins(&self) -> Vec<String> {
        self.store.lock().unwrap().origins.clone()
    }

    pub fn set_origin(&self, origin: &str, allow: bool) {
        let mut s = self.store.lock().unwrap();
        s.origins.retain(|o| o != origin);
        if allow {
            s.origins.push(origin.into());
        } else {
            s.tokens.remove(origin);
        }
        self.save(&s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> Pairings {
        Pairings::open(std::env::temp_dir().join(format!("gwb-pair-{}.json", util::random_hex(4))))
    }

    #[test]
    fn flow() {
        let ps = p();
        let s = ps.start("null", "GIS Workbench 2.1").unwrap();
        assert_eq!(s.code.len(), 6);
        assert_eq!(ps.poll(&s.pairing_id, "null").unwrap().state, PairState::Pending);
        // Another origin cannot see or collect it.
        assert!(ps.poll(&s.pairing_id, "https://evil.example").is_none());
        ps.decide(&s.pairing_id, true).unwrap();
        let st = ps.poll(&s.pairing_id, "null").unwrap();
        let tok = st.token.unwrap();
        assert_eq!(tok.len(), 64);
        // The token is handed over once.
        assert!(ps.poll(&s.pairing_id, "null").unwrap().token.is_none());
        assert!(ps.verify("null", &tok));
        assert!(!ps.verify("https://evil.example", &tok));
        assert!(!ps.verify("null", &tok[..63]));
        assert!(ps.decide(&s.pairing_id, false).is_err());
        assert!(ps.revoke_token("null", &tok));
        assert!(!ps.verify("null", &tok));
    }

    #[test]
    fn deny_and_limits() {
        let ps = p();
        let a = ps.start("null", "x").unwrap();
        ps.decide(&a.pairing_id, false).unwrap();
        assert_eq!(ps.poll(&a.pairing_id, "null").unwrap().state, PairState::Denied);
        for _ in 0..3 {
            ps.start("https://a.example", "x").unwrap();
        }
        assert!(ps.start("https://a.example", "x").is_err());
        assert!(ps.start("", "").is_err() || ps.start("https://b.example", "\u{0}\u{1}").is_err());
    }
}
