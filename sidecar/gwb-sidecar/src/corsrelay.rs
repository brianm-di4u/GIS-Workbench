//! The outbound relay for origins that send no CORS headers (REQ-GAP-08, SDP-2.3 GR-02, OD-2.17).
//!
//! **This file is not in any shipped build.** It compiles only with the `cors-relay` Cargo feature,
//! which no release command sets and which `compose`'s package gate refuses by the marker below. In
//! a build that has it, every call still stops at a gate that only a test run can open
//! (`Config::cors_relay_open`). Nothing here may ship until the sidecar is signed and has passed its
//! external security review, and it can never be in the air-gapped variant (`airgap` feature).
//!
//! Everything else in the sidecar is loopback-only, so this is the one place that makes a request
//! to the network. Its rules, each with a refusal and a test (`tests/corsrelay.rs`):
//!
//! 1. A paired page only (the guard), and a hosted origin the user listed in the sidecar window.
//!    No page can add to that list.
//! 2. https only, GET and HEAD only, and no way to send a body, a cookie or a credential.
//! 3. The host is resolved once, every address is classified, and the connection goes to an address
//!    that passed: a name cannot change its answer between the check and the connection. A loopback
//!    or private address needs an entry the user marked private; multicast, broadcast, the
//!    unspecified address and the sidecar's own ports are refused whatever is listed.
//! 4. Redirects are followed only on the same origin, at most `MAX_REDIRECTS` times, each hop
//!    through the same checks. Anywhere else is a refusal, never a fallback.
//! 5. Certificates are verified against the system's roots. There is no way to turn that off.
//! 6. Only a few response headers come back; `Set-Cookie` and its like stop here.
//! 7. Every call, refused or not, is one line in the request log, without its query string.

use crate::service::Service;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::Response;
use gwb_sidecar_api::{CorsRelayRequest, PORTS};
use http_body_util::{BodyExt, Empty};
use hyper_util::rt::TokioIo;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{OnceCell, Semaphore};
use tokio_rustls::TlsConnector;

/// Found by the package gate (`sidecar/installer/package*.mjs`): a binary holding these bytes does
/// not ship. `sidecar/gwb-sidecar/tests/shipped.rs` checks a relay build does hold them.
#[used]
pub static COMPILED_IN: [u8; 26] = *b"GWB-CORS-RELAY-COMPILED-IN";

pub const MAX_URL: usize = 4096;
pub const MAX_REDIRECTS: usize = 3;
pub const MAX_RESPONSE: u64 = 256 << 20;
pub const MAX_ORIGINS: usize = 64;
pub const MAX_CONCURRENT: usize = 4;
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(300);
const AGENT: &str = concat!("GIS-Workbench-Sidecar/", env!("CARGO_PKG_VERSION"));
/// What comes back of the origin's response.
const KEPT_HEADERS: [&str; 7] = ["content-type", "content-range", "content-length", "content-encoding", "accept-ranges", "etag", "last-modified"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    GateClosed,
    BadUrl(String),
    NotHttps,
    NotListed(String),
    BadMethod(String),
    BadHeader(&'static str),
    /// A loopback or private address of an origin not marked private.
    PrivateTarget(String),
    /// An address that is never a target.
    NeverTarget(String),
    /// The sidecar itself.
    OwnPort,
    RedirectRefused(String),
    TooManyRedirects,
    Busy,
    Dns(String),
    Connect(String),
    Tls(String),
    Upstream(String),
    TooLarge,
    Timeout,
}

impl Refusal {
    /// HTTP status, error code and the message (English, shown to developers: DN-62 rule 7).
    pub fn http(&self) -> (u16, &'static str, String) {
        match self {
            Refusal::GateClosed => (403, "gate_closed", "the CORS relay stays off until the sidecar is signed and has passed its external security review (OD-2.17)".into()),
            Refusal::BadUrl(m) => (400, "bad_url", format!("not a URL the relay takes: {m}")),
            Refusal::NotHttps => (400, "not_https", "the relay reaches https origins only".into()),
            Refusal::NotListed(o) => (403, "not_listed", format!("{o} is not on the relay's list: add it in the sidecar window first")),
            Refusal::BadMethod(m) => (405, "bad_method", format!("the relay sends GET and HEAD only, not {}", m.chars().take(16).collect::<String>())),
            Refusal::BadHeader(n) => (400, "bad_header", format!("{n} is not a value the relay sends")),
            Refusal::PrivateTarget(a) => (403, "private_target", format!("this name resolves to {a}, a loopback or private address, and the origin is not marked private in the sidecar window")),
            Refusal::NeverTarget(a) => (403, "never_target", format!("{a} is never a relay target")),
            Refusal::OwnPort => (403, "own_port", "the relay does not call the sidecar itself".into()),
            Refusal::RedirectRefused(t) => (502, "redirect_refused", format!("the origin redirects to {t}: the relay follows redirects on the same origin only")),
            Refusal::TooManyRedirects => (502, "too_many_redirects", format!("more than {MAX_REDIRECTS} redirects")),
            Refusal::Busy => (429, "busy", format!("{MAX_CONCURRENT} relay calls are already running")),
            Refusal::Dns(m) => (502, "dns", format!("could not resolve the host: {m}")),
            Refusal::Connect(m) => (502, "connect", format!("could not connect: {m}")),
            Refusal::Tls(m) => (502, "tls", format!("the origin's certificate or TLS failed: {m}")),
            Refusal::Upstream(m) => (502, "upstream", format!("the origin did not answer properly: {m}")),
            Refusal::TooLarge => (413, "too_large", format!("the response is larger than the relay carries ({MAX_RESPONSE} bytes)")),
            Refusal::Timeout => (504, "timeout", "the origin took too long".into()),
        }
    }
}

// ---------------------------------------------------------------- URLs

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    /// `https://host[:port]` in canonical form.
    pub origin: String,
    /// Lower case; an IPv6 literal without brackets.
    pub host: String,
    pub port: u16,
    /// Path and query, as sent.
    pub path: String,
    pub ip: Option<IpAddr>,
}

impl Target {
    /// The URL with no query, for the log.
    pub fn loggable(&self) -> String {
        format!("{}{}", self.origin, self.path.split('?').next().unwrap_or(""))
    }
}

/// A last label of digits or `0x…` is how an address hides in a name (`127.1`, `2130706433`,
/// `0x7f.0.0.1`): resolvers disagree about them, so none is taken.
fn numeric_host(h: &str) -> bool {
    let last = h.rsplit('.').next().unwrap_or("");
    !last.is_empty() && (last.bytes().all(|b| b.is_ascii_digit()) || (last.starts_with("0x") && last[2..].bytes().all(|b| b.is_ascii_hexdigit())))
}

/// The relay's only URL parser. It takes less than a browser's: what a page's `URL` object prints
/// passes, and the spellings that confuse parsers are refused rather than understood.
pub fn parse_url(url: &str) -> Result<Target, Refusal> {
    let bad = |m: &str| Err(Refusal::BadUrl(m.to_string()));
    if url.len() > MAX_URL {
        return bad("too long");
    }
    if !url.bytes().all(|b| (0x21..0x7f).contains(&b)) {
        return bad("it holds a space, a control character or a non-ASCII character");
    }
    if url.contains('\\') {
        return bad("it holds a backslash");
    }
    let Some(i) = url.find("://") else { return bad("no scheme") };
    if !url[..i].eq_ignore_ascii_case("https") {
        return Err(Refusal::NotHttps);
    }
    let rest = &url[i + 3..];
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (auth, tail) = rest.split_at(end);
    if auth.contains('@') {
        return bad("it names a user");
    }
    if auth.contains('%') {
        return bad("its host is percent-encoded");
    }
    if tail.contains('#') {
        return bad("it has a fragment");
    }
    let auth = auth.to_ascii_lowercase();
    let (host, port) = if let Some(r) = auth.strip_prefix('[') {
        let Some((h, p)) = r.split_once(']') else { return bad("unclosed IPv6 address") };
        let port = match p {
            "" => None,
            _ => Some(p.strip_prefix(':').ok_or(Refusal::BadUrl("junk after the IPv6 address".into()))?),
        };
        (h.to_string(), port.map(str::to_string))
    } else {
        match auth.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), Some(p.to_string())),
            None => (auth.clone(), None),
        }
    };
    let port = match port {
        None => 443,
        Some(p) if !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()) => match p.parse::<u16>() {
            Ok(n) if n > 0 => n,
            _ => return bad("bad port"),
        },
        Some(_) => return bad("bad port"),
    };
    if host.is_empty() || host.len() > 253 {
        return bad("no host");
    }
    let ip = if auth.starts_with('[') {
        match host.parse::<Ipv6Addr>() {
            Ok(a) => Some(IpAddr::V6(a)),
            Err(_) => return bad("bad IPv6 address"),
        }
    } else {
        host.parse::<Ipv4Addr>().ok().map(IpAddr::V4)
    };
    if ip.is_none() {
        let labels_ok = host.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-') && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
        if !labels_ok {
            return bad("bad host name (a trailing dot is refused too)");
        }
        if numeric_host(&host) {
            return bad("its host is a number in disguise");
        }
    }
    let name = match ip {
        Some(IpAddr::V6(_)) => format!("[{host}]"),
        _ => host.clone(),
    };
    let origin = if port == 443 { format!("https://{name}") } else { format!("https://{name}:{port}") };
    let path = if tail.is_empty() {
        "/".to_string()
    } else if tail.starts_with('?') {
        format!("/{tail}")
    } else {
        tail.to_string()
    };
    Ok(Target { origin, host, port, path, ip })
}

/// `Location` against the URL it came from. A path, or a whole https URL; everything else is
/// refused by `parse_url` or by its origin.
pub fn redirect_target(from: &Target, location: &str) -> Result<Target, Refusal> {
    let t = location.trim();
    let refuse = || Refusal::RedirectRefused(t.chars().take(120).collect());
    if t.is_empty() || t.contains('\\') {
        return Err(refuse());
    }
    let url = if t.starts_with("//") {
        format!("https:{t}")
    } else if t.starts_with('/') {
        format!("{}{t}", from.origin)
    } else if t.contains("://") {
        t.to_string()
    } else if t.split(['/', '?']).next().is_some_and(|s| s.contains(':')) {
        return Err(refuse()); // another scheme: data:, file:, http: without slashes
    } else {
        let dir = from.path.split('?').next().unwrap_or("/").rsplit_once('/').map(|x| x.0).unwrap_or("");
        format!("{}{dir}/{t}", from.origin)
    };
    let next = parse_url(&url).map_err(|_| refuse())?;
    if next.origin != from.origin {
        return Err(refuse());
    }
    Ok(next)
}

// ---------------------------------------------------------------- addresses

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpClass {
    Public,
    /// Loopback, private, link-local, shared and documentation ranges: an entry marked private only.
    Private,
    /// Multicast, broadcast, reserved and unspecified: no entry opens these.
    Never,
}

fn classify_v4(a: Ipv4Addr) -> IpClass {
    let o = a.octets();
    let u = u32::from(a);
    let within = |net: u32, bits: u32| u >> (32 - bits) == net >> (32 - bits);
    if o[0] == 0 || o[0] >= 224 {
        return IpClass::Never;
    }
    let private = [
        (0x7f00_0000, 8),  // 127.0.0.0/8 loopback
        (0x0a00_0000, 8),  // 10.0.0.0/8
        (0xac10_0000, 12), // 172.16.0.0/12
        (0xc0a8_0000, 16), // 192.168.0.0/16
        (0xa9fe_0000, 16), // 169.254.0.0/16 link-local, and cloud metadata
        (0x6440_0000, 10), // 100.64.0.0/10 shared
        (0xc000_0000, 24), // 192.0.0.0/24
        (0xc000_0200, 24), // 192.0.2.0/24 documentation
        (0xc058_6300, 24), // 192.88.99.0/24 6to4 relay
        (0xc612_0000, 15), // 198.18.0.0/15 benchmarking
        (0xc633_6400, 24), // 198.51.100.0/24 documentation
        (0xcb00_7100, 24), // 203.0.113.0/24 documentation
    ];
    if private.iter().any(|(n, b)| within(*n, *b)) {
        IpClass::Private
    } else {
        IpClass::Public
    }
}

/// Every form that carries an IPv4 address is judged by that address.
fn classify_v6(a: Ipv6Addr) -> IpClass {
    let s = a.segments();
    let o = a.octets();
    let v4 = |x: &[u8]| Ipv4Addr::new(x[0], x[1], x[2], x[3]);
    if a.is_unspecified() || s[0] & 0xff00 == 0xff00 {
        return IpClass::Never;
    }
    if a.is_loopback() {
        return IpClass::Private;
    }
    if let Some(m) = a.to_ipv4_mapped() {
        return classify_v4(m);
    }
    // ::a.b.c.d (deprecated), 64:ff9b::a.b.c.d (NAT64), 2002:a.b.c.d:: (6to4).
    if s[..6] == [0; 6] || s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return classify_v4(v4(&o[12..]));
    }
    if s[0] == 0x2002 {
        return classify_v4(v4(&o[2..6]));
    }
    // Teredo and documentation sit inside 2000::/3; only the rest of it is the global internet.
    if s[0] & 0xe000 != 0x2000 || (s[0] == 0x2001 && (s[1] == 0 || s[1] == 0xdb8)) {
        return IpClass::Private;
    }
    IpClass::Public
}

pub fn classify(ip: IpAddr) -> IpClass {
    match ip {
        IpAddr::V4(a) => classify_v4(a),
        IpAddr::V6(a) => classify_v6(a),
    }
}

/// Whether every address may be connected to for this entry; all of them must pass, so a name that
/// answers with one public and one private address is refused.
pub fn check_addresses(addrs: &[IpAddr], port: u16, private_ok: bool) -> Result<(), Refusal> {
    for a in addrs {
        match classify(*a) {
            IpClass::Public => {}
            IpClass::Never => return Err(Refusal::NeverTarget(a.to_string())),
            IpClass::Private => {
                if !private_ok {
                    return Err(Refusal::PrivateTarget(a.to_string()));
                }
                if a.is_loopback() && PORTS.contains(&port) {
                    return Err(Refusal::OwnPort);
                }
            }
        }
    }
    Ok(())
}

/// `Accept`: short, printable, nothing that could end a header.
pub fn check_accept(v: &str) -> Result<(), Refusal> {
    if v.len() <= 256 && !v.is_empty() && v.bytes().all(|b| (0x20..0x7f).contains(&b)) {
        Ok(())
    } else {
        Err(Refusal::BadHeader("accept"))
    }
}

/// `Range`: `bytes=a-b` or `bytes=a-`.
pub fn check_range(v: &str) -> Result<(), Refusal> {
    let bad = Refusal::BadHeader("range");
    let Some(r) = v.strip_prefix("bytes=") else { return Err(bad) };
    let Some((a, b)) = r.split_once('-') else { return Err(bad) };
    let digits = |s: &str| s.len() <= 20 && s.bytes().all(|c| c.is_ascii_digit());
    if a.is_empty() || !digits(a) || !digits(b) {
        return Err(bad);
    }
    Ok(())
}

// ---------------------------------------------------------------- the user's list

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub origin: String,
    /// The user says this origin is on a private network or this computer.
    pub private: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListFile {
    origins: Vec<Entry>,
}

pub struct CorsRelay {
    path: PathBuf,
    list: Mutex<Vec<Entry>>,
    /// `(largest response, wait for the head)`: constants but for tests.
    limits: Mutex<(u64, Duration)>,
    sem: Arc<Semaphore>,
    tls: OnceCell<Arc<rustls::ClientConfig>>,
    ca: Option<PathBuf>,
    resolve: Vec<(String, IpAddr)>,
}

impl CorsRelay {
    pub fn open(path: PathBuf, ca: Option<PathBuf>, resolve: Vec<(String, IpAddr)>) -> CorsRelay {
        let list = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<ListFile>(&t).ok()).map(|f| f.origins).unwrap_or_default();
        CorsRelay { path, list: Mutex::new(list), limits: Mutex::new((MAX_RESPONSE, HEAD_TIMEOUT)), sem: Arc::new(Semaphore::new(MAX_CONCURRENT)), tls: OnceCell::new(), ca, resolve }
    }

    /// Lower limits for tests.
    pub fn set_limits(&self, max_response: u64, head_timeout: Duration) {
        *self.limits.lock().unwrap() = (max_response, head_timeout);
    }

    pub fn entries(&self) -> Vec<Entry> {
        self.list.lock().unwrap().clone()
    }

    pub fn lookup(&self, origin: &str) -> Option<Entry> {
        self.list.lock().unwrap().iter().find(|e| e.origin == origin).cloned()
    }

    /// Add or change an entry: the sidecar window only. `origin` must be an https origin alone.
    pub fn set(&self, origin: &str, private: bool) -> Result<String, String> {
        let t = parse_url(origin).map_err(|e| e.http().2)?;
        if t.path != "/" {
            return Err("an origin has no path or query".into());
        }
        let mut l = self.list.lock().unwrap();
        l.retain(|e| e.origin != t.origin);
        if l.len() >= MAX_ORIGINS {
            return Err(format!("the list holds at most {MAX_ORIGINS} origins"));
        }
        l.push(Entry { origin: t.origin.clone(), private });
        self.save(&l);
        Ok(t.origin)
    }

    pub fn remove(&self, origin: &str) -> bool {
        let mut l = self.list.lock().unwrap();
        let n = l.len();
        l.retain(|e| e.origin != origin);
        let gone = l.len() != n;
        self.save(&l);
        gone
    }

    fn save(&self, l: &[Entry]) {
        if let Ok(t) = serde_json::to_string_pretty(&ListFile { origins: l.to_vec() }) {
            let _ = std::fs::write(&self.path, t);
        }
    }

    async fn tls(&self) -> Result<Arc<rustls::ClientConfig>, Refusal> {
        self.tls
            .get_or_try_init(|| async {
                let mut roots = rustls::RootCertStore::empty();
                match &self.ca {
                    // A test run's own CA, instead of the system's roots (never beside them).
                    Some(p) if crate::config::test_mode() => {
                        for c in CertificateDer::pem_file_iter(p).map_err(|e| Refusal::Tls(e.to_string()))? {
                            roots.add(c.map_err(|e| Refusal::Tls(e.to_string()))?).map_err(|e| Refusal::Tls(e.to_string()))?;
                        }
                    }
                    _ => {
                        let got = rustls_native_certs::load_native_certs();
                        let (ok, _) = roots.add_parsable_certificates(got.certs);
                        if ok == 0 {
                            return Err(Refusal::Tls("this computer gave no root certificates".into()));
                        }
                    }
                }
                let provider = Arc::new(rustls::crypto::ring::default_provider());
                let cfg = rustls::ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().map_err(|e| Refusal::Tls(e.to_string()))?.with_root_certificates(roots).with_no_client_auth();
                Ok(Arc::new(cfg))
            })
            .await
            .cloned()
    }

    /// The host's addresses: its IP literal, else one lookup. A test run may fix the answer.
    async fn addresses(&self, t: &Target) -> Result<Vec<IpAddr>, Refusal> {
        if let Some(ip) = t.ip {
            return Ok(vec![ip]);
        }
        if crate::config::test_mode() {
            let fixed: Vec<IpAddr> = self.resolve.iter().filter(|(h, _)| *h == t.host).map(|x| x.1).collect();
            if !fixed.is_empty() {
                return Ok(fixed);
            }
        }
        let found = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((t.host.as_str(), t.port))).await.map_err(|_| Refusal::Timeout)?.map_err(|e| Refusal::Dns(e.to_string()))?;
        let v: Vec<IpAddr> = found.map(|a| a.ip()).collect();
        if v.is_empty() {
            return Err(Refusal::Dns("no addresses".into()));
        }
        Ok(v)
    }
}

// ---------------------------------------------------------------- the call

/// Logs one line when the call is over, however it ended.
struct LogLine {
    svc: Arc<Service>,
    line: String,
    bytes: u64,
}

impl Drop for LogLine {
    fn drop(&mut self) {
        self.svc.log(format!("cors-relay: {}, {} bytes", self.line, self.bytes));
    }
}

async fn connect(cr: &CorsRelay, t: &Target, addrs: &[IpAddr]) -> Result<tokio_rustls::client::TlsStream<TcpStream>, Refusal> {
    let mut last = Refusal::Connect("no address answered".into());
    for a in addrs {
        // This address has been checked: never a second lookup of the name.
        let sa = SocketAddr::new(*a, t.port);
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(sa)).await {
            Ok(Ok(tcp)) => {
                let name = match t.ip {
                    Some(ip) => ServerName::IpAddress(ip.into()),
                    None => ServerName::try_from(t.host.clone()).map_err(|e| Refusal::Tls(e.to_string()))?,
                };
                let tls = TlsConnector::from(cr.tls().await?);
                return match tokio::time::timeout(CONNECT_TIMEOUT, tls.connect(name, tcp)).await {
                    Ok(Ok(s)) => Ok(s),
                    Ok(Err(e)) => Err(Refusal::Tls(e.to_string())),
                    Err(_) => Err(Refusal::Timeout),
                };
            }
            Ok(Err(e)) => last = Refusal::Connect(e.to_string()),
            Err(_) => last = Refusal::Timeout,
        }
    }
    Err(last)
}

type Upstream = hyper::Response<hyper::body::Incoming>;

/// One hop: every check, then the request.
async fn hop(cr: &CorsRelay, t: &Target, method: &Method, accept: Option<&str>, range: Option<&str>) -> Result<Upstream, Refusal> {
    let Some(entry) = cr.lookup(&t.origin) else { return Err(Refusal::NotListed(t.origin.clone())) };
    let addrs = cr.addresses(t).await?;
    check_addresses(&addrs, t.port, entry.private)?;
    let tls = connect(cr, t, &addrs).await?;
    let (mut send, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await.map_err(|e| Refusal::Upstream(e.to_string()))?;
    tokio::spawn(conn);
    let host = t.origin.trim_start_matches("https://").to_string();
    let mut b = hyper::Request::builder().method(method.clone()).uri(t.path.as_str()).header("host", host).header("user-agent", AGENT).header("accept-encoding", "identity").header("connection", "close");
    b = b.header("accept", accept.unwrap_or("*/*"));
    if let Some(r) = range {
        b = b.header("range", r);
    }
    let req = b.body(Empty::<Bytes>::new()).map_err(|e| Refusal::Upstream(e.to_string()))?;
    let wait = cr.limits.lock().unwrap().1;
    match tokio::time::timeout(wait, send.send_request(req)).await {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(Refusal::Upstream(e.to_string())),
        Err(_) => Err(Refusal::Timeout),
    }
}

async fn run(svc: &Arc<Service>, caller: &str, r: &CorsRelayRequest, log: &mut String) -> Result<Response, Refusal> {
    if !svc.cfg.cors_relay_open() {
        return Err(Refusal::GateClosed);
    }
    std::hint::black_box(&COMPILED_IN);
    let mut t = parse_url(&r.url)?;
    *log = format!("{} {} for {caller}", r.method.chars().filter(|c| c.is_ascii_alphabetic()).take(8).collect::<String>(), t.loggable());
    let method = match r.method.as_str() {
        "GET" => Method::GET,
        "HEAD" => Method::HEAD,
        o => return Err(Refusal::BadMethod(o.to_string())),
    };
    if let Some(a) = &r.accept {
        check_accept(a)?;
    }
    if let Some(v) = &r.range {
        check_range(v)?;
    }
    if svc.cors.lookup(&t.origin).is_none() {
        return Err(Refusal::NotListed(t.origin.clone()));
    }
    let _permit = svc.cors.sem.clone().try_acquire_owned().map_err(|_| Refusal::Busy)?;
    let mut hops = 0;
    let up = loop {
        let resp = hop(&svc.cors, &t, &method, r.accept.as_deref(), r.range.as_deref()).await?;
        if !resp.status().is_redirection() || resp.status() == StatusCode::NOT_MODIFIED {
            break resp;
        }
        let Some(loc) = resp.headers().get("location").and_then(|v| v.to_str().ok()) else { return Err(Refusal::Upstream("a redirect with no Location".into())) };
        let next = redirect_target(&t, loc)?;
        hops += 1;
        if hops > MAX_REDIRECTS {
            return Err(Refusal::TooManyRedirects);
        }
        t = next;
    };
    let length = up.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
    if length.is_some_and(|n| n > svc.cors.limits.lock().unwrap().0) {
        return Err(Refusal::TooLarge);
    }
    Ok(respond(svc, up, std::mem::take(log), _permit))
}

fn respond(svc: &Arc<Service>, up: Upstream, line: String, permit: tokio::sync::OwnedSemaphorePermit) -> Response {
    let status = up.status();
    let kept: Vec<(String, HeaderValue)> = up.headers().iter().filter(|(k, _)| KEPT_HEADERS.contains(&k.as_str())).map(|(k, v)| (k.as_str().to_string(), v.clone())).collect();
    let body = up.into_body();
    struct St {
        body: hyper::body::Incoming,
        log: LogLine,
        deadline: tokio::time::Instant,
        over: bool,
        max: u64,
        _permit: tokio::sync::OwnedSemaphorePermit,
    }
    let log = LogLine { svc: svc.clone(), line: format!("{line} → {}", status.as_u16()), bytes: 0 };
    let max = svc.cors.limits.lock().unwrap().0;
    let st = St { body, log, deadline: tokio::time::Instant::now() + TOTAL_TIMEOUT, over: false, max, _permit: permit };
    let stream = futures_util::stream::unfold(st, |mut st| async move {
        if st.over {
            return None;
        }
        loop {
            let wait = IDLE_TIMEOUT.min(st.deadline.saturating_duration_since(tokio::time::Instant::now()));
            match tokio::time::timeout(wait, st.body.frame()).await {
                Ok(None) => return None,
                Ok(Some(Ok(f))) => {
                    let Ok(data) = f.into_data() else { continue };
                    st.log.bytes += data.len() as u64;
                    if st.log.bytes > st.max {
                        st.over = true;
                        st.log.line.push_str(" (stopped: too large)");
                        return Some((Err(std::io::Error::other("the response is too large")), st));
                    }
                    return Some((Ok::<Bytes, std::io::Error>(data), st));
                }
                Ok(Some(Err(e))) => {
                    st.over = true;
                    st.log.line.push_str(" (the origin broke off)");
                    return Some((Err(std::io::Error::other(e.to_string())), st));
                }
                Err(_) => {
                    st.over = true;
                    st.log.line.push_str(" (stopped: timed out)");
                    return Some((Err(std::io::Error::other("the origin took too long")), st));
                }
            }
        }
    });
    let mut out = Response::new(Body::from_stream(stream));
    let h: &mut HeaderMap = out.headers_mut();
    h.insert("x-gwb-relay-status", HeaderValue::from(status.as_u16()));
    for (k, v) in kept {
        // The page reads these under names of their own: they describe the origin's response, and
        // a wrong Content-Length here would break the sidecar's own framing.
        if let Ok(n) = axum::http::HeaderName::from_bytes(format!("x-gwb-relay-{k}").as_bytes()) {
            h.insert(n, v);
        }
    }
    out
}

/// `POST /v1/cors-relay/fetch`. The guard has checked the page's origin and pairing token.
pub async fn fetch(svc: &Arc<Service>, caller: &str, r: CorsRelayRequest) -> Result<Response, Refusal> {
    let mut line = format!("{} (unparsed URL) for {caller}", r.method.chars().filter(|c| c.is_ascii_alphabetic()).take(8).collect::<String>());
    let out = run(svc, caller, &r, &mut line).await;
    if let Err(e) = &out {
        // `line` was moved out only on success.
        svc.log(format!("cors-relay: refused {} ({})", line, e.http().1));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_that_pass() {
        let t = parse_url("https://Data.Example.org/a/b?x=1&y=%20").unwrap();
        assert_eq!((t.origin.as_str(), t.host.as_str(), t.port, t.path.as_str()), ("https://data.example.org", "data.example.org", 443, "/a/b?x=1&y=%20"));
        assert_eq!(parse_url("https://example.org").unwrap().path, "/");
        assert_eq!(parse_url("https://example.org?q=1").unwrap().path, "/?q=1");
        assert_eq!(parse_url("https://example.org:443/").unwrap().origin, "https://example.org");
        assert_eq!(parse_url("https://example.org:8443/x").unwrap().origin, "https://example.org:8443");
        assert_eq!(parse_url("https://93.184.216.34/").unwrap().ip, Some("93.184.216.34".parse().unwrap()));
        let v6 = parse_url("https://[2606:2800:220:1::1]:444/x").unwrap();
        assert_eq!(v6.origin, "https://[2606:2800:220:1::1]:444");
        assert_eq!(v6.host, "2606:2800:220:1::1");
    }

    #[test]
    fn urls_that_are_refused() {
        for u in [
            "http://example.org/",
            "ftp://example.org/",
            "file:///etc/passwd",
            "gopher://example.org/",
            "HTTP://example.org/",
        ] {
            assert_eq!(parse_url(u), Err(Refusal::NotHttps), "{u}");
        }
        for u in [
            "",
            "example.org",
            "//example.org/",
            "https://",
            "https:///x",
            "https://user@example.org/",
            "https://user:pw@example.org/",
            "https://example.org@evil.example/",
            "https://exa mple.org/",
            "https://example.org/a b",
            "https://example.org/\r\nHost: evil",
            "https://example.org\\@evil.example/",
            "https://evil.example\\.example.org/",
            "https://example.org/#frag",
            "https://example.org#frag",
            "https://example.org:0/",
            "https://example.org:65536/",
            "https://example.org:80a/",
            "https://example.org:/",
            "https://example.org./",
            "https://.example.org/",
            "https://exa..mple.org/",
            "https://-example.org/",
            "https://exam_ple.org/",
            "https://ex%61mple.org/",
            "https://[::1/",
            "https://[::1]x/",
            "https://[zz]/",
            "https://[::ffff:127.0.0.1%25eth0]/",
            "https://2130706433/",
            "https://0x7f000001/",
            "https://0x7f.0.0.1/",
            "https://127.1/",
            "https://017700000001/",
            "https://example.123/",
            "https://bücher.example/",
        ] {
            assert!(matches!(parse_url(u), Err(Refusal::BadUrl(_))), "{u}: {:?}", parse_url(u));
        }
        assert!(matches!(parse_url(&format!("https://example.org/{}", "a".repeat(MAX_URL))), Err(Refusal::BadUrl(_))));
    }

    #[test]
    fn the_log_gets_no_query() {
        assert_eq!(parse_url("https://example.org/a/b?token=secret").unwrap().loggable(), "https://example.org/a/b");
    }

    #[test]
    fn redirects_stay_on_the_origin() {
        let f = parse_url("https://example.org:8443/a/b?x=1").unwrap();
        assert_eq!(redirect_target(&f, "/c").unwrap().path, "/c");
        assert_eq!(redirect_target(&f, "c?d=1").unwrap().path, "/a/c?d=1");
        assert_eq!(redirect_target(&f, "https://EXAMPLE.org:8443/z").unwrap().path, "/z");
        for bad in ["https://example.org/x", "https://other.example:8443/", "http://example.org:8443/", "//evil.example/", "//example.org/", "https://example.org:8443@evil.example/", "/\\evil.example", "\\\\evil.example", "data:text/html,x", "file:///c:/x", "javascript:alert(1)", "", "   "] {
            assert!(matches!(redirect_target(&f, bad), Err(Refusal::RedirectRefused(_))), "{bad}: {:?}", redirect_target(&f, bad));
        }
    }

    #[test]
    fn addresses_are_classified() {
        let c = |s: &str| classify(s.parse().unwrap());
        for a in ["8.8.8.8", "93.184.216.34", "1.1.1.1", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "100.63.255.255", "100.128.0.0", "169.253.255.255", "223.255.255.255", "2606:2800:220:1::1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"] {
            assert_eq!(c(a), IpClass::Public, "{a}");
        }
        for a in ["127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255", "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.255", "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "198.19.255.255", "192.88.99.1", "192.0.0.8", "::1", "fe80::1", "febf::1", "fc00::1", "fdff::1", "fec0::1", "2001:db8::1", "2001:0:4136:e378::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2002:a00:1::", "100::1", "4000::1"] {
            assert_eq!(c(a), IpClass::Private, "{a}");
        }
        for a in ["0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "::", "ff02::1", "ff00::", "::ffff:0.0.0.0", "::ffff:224.0.0.1", "64:ff9b::e000:1"] {
            assert_eq!(c(a), IpClass::Never, "{a}");
        }
    }

    #[test]
    fn every_address_must_pass() {
        let ips = |v: &[&str]| v.iter().map(|s| s.parse().unwrap()).collect::<Vec<IpAddr>>();
        assert_eq!(check_addresses(&ips(&["8.8.8.8", "1.1.1.1"]), 443, false), Ok(()));
        assert_eq!(check_addresses(&ips(&["8.8.8.8", "10.0.0.1"]), 443, false), Err(Refusal::PrivateTarget("10.0.0.1".into())));
        assert_eq!(check_addresses(&ips(&["127.0.0.1"]), 8443, false), Err(Refusal::PrivateTarget("127.0.0.1".into())));
        assert_eq!(check_addresses(&ips(&["10.0.0.1", "127.0.0.1"]), 8443, true), Ok(()));
        assert_eq!(check_addresses(&ips(&["0.0.0.0"]), 443, true), Err(Refusal::NeverTarget("0.0.0.0".into())));
        assert_eq!(check_addresses(&ips(&["224.0.0.1"]), 443, true), Err(Refusal::NeverTarget("224.0.0.1".into())));
        for p in PORTS {
            assert_eq!(check_addresses(&ips(&["127.0.0.1"]), p, true), Err(Refusal::OwnPort));
            assert_eq!(check_addresses(&ips(&["::1"]), p, true), Err(Refusal::OwnPort));
        }
    }

    #[test]
    fn headers_are_narrow() {
        assert!(check_accept("application/json, text/plain;q=0.5").is_ok());
        for b in ["", "a\r\nCookie: x", "é", &"a".repeat(257)] {
            assert!(check_accept(b).is_err(), "{b}");
        }
        for ok in ["bytes=0-", "bytes=0-99", "bytes=123-456"] {
            assert!(check_range(ok).is_ok(), "{ok}");
        }
        for b in ["", "bytes", "bytes=", "bytes=-5", "bytes=a-b", "bytes=0-1,3-4", "items=0-1", "bytes=0-1\r\nx: y", "bytes=123456789012345678901-"] {
            assert!(check_range(b).is_err(), "{b}");
        }
    }

    #[test]
    fn the_list_takes_origins_only() {
        let dir = std::env::temp_dir().join(format!("gwb-cr-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cors-relay.json");
        let c = CorsRelay::open(p.clone(), None, vec![]);
        assert_eq!(c.set("https://Example.org/", false).unwrap(), "https://example.org");
        for bad in ["http://example.org", "https://example.org/path", "https://example.org/?q=1", "https://*.example.org", "example.org"] {
            assert!(c.set(bad, false).is_err(), "{bad}");
        }
        c.set("https://10.0.0.5:8443", true).unwrap();
        let again = CorsRelay::open(p, None, vec![]);
        assert_eq!(again.entries().len(), 2);
        assert!(again.lookup("https://10.0.0.5:8443").unwrap().private);
        assert!(again.remove("https://example.org"));
        assert!(!again.remove("https://example.org"));
        assert_eq!(again.lookup("https://example.org"), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The parsers on a mutated stream: no panic, and nothing accepted is outside the rules.
    #[test]
    fn mutation_test_of_the_url_parser() {
        let seeds: [&[u8]; 8] = [b"https://example.org/a?b=1", b"https://[::1]:8443/x", b"https://10.0.0.1/", b"http://a/", b"https://u@h/", b"https://a.b.c:1/%20?x#y", b"//x/y", b"/a/b?c"];
        let mut x: u64 = 0x9e3779b97f4a7c15;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let from = parse_url("https://example.org/p/q").unwrap();
        let mut accepted = 0u32;
        for _ in 0..200_000 {
            let mut b = seeds[(next() % seeds.len() as u64) as usize].to_vec();
            for _ in 0..1 + next() % 6 {
                let i = (next() as usize) % b.len().max(1);
                match next() % 4 {
                    0 if !b.is_empty() => b[i] = (next() & 0xff) as u8,
                    1 if !b.is_empty() => {
                        b.remove(i);
                    }
                    2 => b.insert(i.min(b.len()), b"/\\@:#?%[].-\r\n\t "[(next() % 15) as usize]),
                    _ => {
                        let j = (next() as usize) % b.len().max(1);
                        if !b.is_empty() {
                            b.swap(i, j);
                        }
                    }
                }
            }
            let Ok(s) = std::str::from_utf8(&b) else { continue };
            if let Ok(t) = parse_url(s) {
                accepted += 1;
                assert!(t.origin.starts_with("https://"), "{s}");
                assert!(!t.origin.contains('@') && !t.path.contains('#') && !t.path.contains('\\'), "{s}");
                assert!(t.path.starts_with('/'), "{s}: {:?}", t.path);
                assert!(t.path.bytes().all(|c| (0x21..0x7f).contains(&c)), "{s}");
                assert_eq!(parse_url(&format!("{}{}", t.origin, t.path)).as_ref(), Ok(&t), "{s} does not round-trip");
            }
            if let Ok(t) = redirect_target(&from, s) {
                assert_eq!(t.origin, from.origin, "{s}");
            }
        }
        assert!(accepted > 1000, "the mutations should still pass sometimes: {accepted}");
    }
}
