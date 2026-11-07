//! Test harness: a service on an ephemeral loopback port with a temporary data folder and a
//! modules folder whose tools are all the fake tool (or the real dev bundle when asked).
#![allow(dead_code)]

use gwb_sidecar::config::Config;
use gwb_sidecar::service::Service;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
pub const HOSTED: &str = "https://gwb.example";

pub struct H {
    pub port: u16,
    pub dir: PathBuf,
    pub svc: Arc<Service>,
}

// Each harness takes a folder under the temp directory. Without this they pile up: thousands of
// runs filled C: and /tmp. Best effort, because a service may still hold a file open.
impl Drop for H {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub fn fake_modules(root: &Path) {
    let exe = PathBuf::from(env!("CARGO_BIN_EXE_gwb-fake-tool"));
    // The same layout as the real modules on this platform (modules.rs): no extension on Linux.
    let x = std::env::consts::EXE_SUFFIX;
    let put = |rel: &str| {
        let p = root.join(format!("{rel}{x}"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::copy(&exe, &p).unwrap();
    };
    for t in ["gdal_translate", "gdalinfo", "ogrinfo", "ogr2ogr", "gdaladdo", "gdalbuildvrt", "gdalsrsinfo", "gdalwarp", "gdal"] {
        put(&format!("core-gdal/bin/{t}"));
    }
    std::fs::create_dir_all(root.join(if cfg!(windows) { "core-gdal/gdalplugins" } else { "core-gdal/lib/gdalplugins" })).unwrap();
    put("points/bin/pdal");
    put("media/bin/ffmpeg");
    put("media/bin/ffprobe");
    put("media/bin/ffmpeg-h264");
    std::fs::create_dir_all(root.join("vendor-openh264/lib")).unwrap();
    std::fs::write(root.join("vendor-openh264/ACCEPTED.json"), "{}").unwrap();
    put(if cfg!(windows) { "sar/python/python" } else { "sar/python/bin/python3" });
    std::fs::create_dir_all(root.join("sar/scripts")).unwrap();
    std::fs::write(root.join("sar/scripts/mesh_export.py"), "# fake").unwrap();
    std::fs::create_dir_all(root.join("model3d")).unwrap();
}

pub async fn start_with(tweak: impl FnOnce(&mut Config)) -> H {
    let dir = std::env::temp_dir().join(format!("gwb-sc-test-{}", gwb_sidecar::util::random_hex(6)));
    std::fs::create_dir_all(&dir).unwrap();
    let modules = dir.join("modules");
    fake_modules(&modules);
    let mut cfg = Config::defaults(dir.join("data"));
    cfg.modules_dir = modules;
    cfg.app_dir = dir.join("app");
    cfg.headless = true;
    cfg.allowed_origins = vec![HOSTED.into()];
    cfg.test_pair = Some(("null".into(), TOKEN.into()));
    cfg.reserve_bytes = 0;
    tweak(&mut cfg);
    let (l, port) = gwb_sidecar::bind(&[0]).unwrap();
    let svc = Service::new(cfg, port).unwrap();
    svc.caps.refresh().await;
    let s2 = svc.clone();
    tokio::spawn(async move { gwb_sidecar::serve(s2, l, std::future::pending()).await });
    H { port, dir, svc }
}

pub async fn start() -> H {
    start_with(|_| {}).await
}

#[derive(Debug)]
pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Resp {
    pub fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(a, _)| a.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// A raw HTTP/1.1 request (full control of Host, Origin and framing).
pub async fn raw(port: u16, bytes: &[u8]) -> Resp {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(bytes).await.unwrap();
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(60), s.read_to_end(&mut buf)).await;
    parse_resp(&buf)
}

pub fn parse_resp(buf: &[u8]) -> Resp {
    let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { return Resp { status: 0, headers: vec![], body: buf.to_vec() } };
    let head = String::from_utf8_lossy(&buf[..i]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0);
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(a, b)| (a.trim().to_string(), b.trim().to_string()))).collect();
    let mut body = buf[i + 4..].to_vec();
    if headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.contains("chunked")) {
        body = dechunk(&body);
    }
    Resp { status, headers, body }
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(i) = b.windows(2).position(|w| w == b"\r\n") else { break };
        let n = usize::from_str_radix(String::from_utf8_lossy(&b[..i]).trim(), 16).unwrap_or(0);
        if n == 0 || b.len() < i + 2 + n {
            break;
        }
        out.extend_from_slice(&b[i + 2..i + 2 + n]);
        b = &b[(i + 4 + n).min(b.len())..];
    }
    out
}

pub struct Req<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub host: Option<String>,
    pub origin: Option<&'a str>,
    pub token: Option<&'a str>,
    pub headers: Vec<(&'a str, String)>,
    pub body: Vec<u8>,
}

impl<'a> Req<'a> {
    pub fn new(method: &'a str, path: &'a str) -> Req<'a> {
        Req { method, path, host: None, origin: Some("null"), token: Some(TOKEN), headers: vec![], body: vec![] }
    }
    pub fn json(mut self, v: serde_json::Value) -> Self {
        self.body = serde_json::to_vec(&v).unwrap();
        self.headers.push(("Content-Type", "application/json".into()));
        self
    }
    pub fn origin(mut self, o: Option<&'a str>) -> Self {
        self.origin = o;
        self
    }
    pub fn token(mut self, t: Option<&'a str>) -> Self {
        self.token = t;
        self
    }
    pub fn host(mut self, h: &str) -> Self {
        self.host = Some(h.to_string());
        self
    }
    pub fn header(mut self, k: &'a str, v: impl Into<String>) -> Self {
        self.headers.push((k, v.into()));
        self
    }
    pub fn body(mut self, b: impl Into<Vec<u8>>) -> Self {
        self.body = b.into();
        self
    }
    /// Headers first; if the server answers before the body (an early 413/507), return that.
    pub async fn send_head_first(self, port: u16) -> Resp {
        let (head, body) = self.bytes(port);
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        s.write_all(&head).await.unwrap();
        let mut buf = vec![0u8; 65536];
        if let Ok(Ok(n)) = tokio::time::timeout(std::time::Duration::from_millis(1500), s.read(&mut buf)).await {
            if n > 0 {
                return parse_resp(&buf[..n]);
            }
        }
        let _ = s.write_all(&body).await;
        let mut out = Vec::new();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), s.read_to_end(&mut out)).await;
        parse_resp(&out)
    }

    fn bytes(self, port: u16) -> (Vec<u8>, Vec<u8>) {
        let host = self.host.unwrap_or_else(|| format!("127.0.0.1:{port}"));
        let mut s = format!("{} {} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n", self.method, self.path);
        if let Some(o) = self.origin {
            s.push_str(&format!("Origin: {o}\r\n"));
        }
        if let Some(t) = self.token {
            s.push_str(&format!("Authorization: Bearer {t}\r\n"));
        }
        for (k, v) in &self.headers {
            s.push_str(&format!("{k}: {v}\r\n"));
        }
        s.push_str(&format!("Content-Length: {}\r\n\r\n", self.body.len()));
        (s.into_bytes(), self.body)
    }

    pub async fn send(self, port: u16) -> Resp {
        let host = self.host.unwrap_or_else(|| format!("127.0.0.1:{port}"));
        let mut s = format!("{} {} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n", self.method, self.path);
        if let Some(o) = self.origin {
            s.push_str(&format!("Origin: {o}\r\n"));
        }
        if let Some(t) = self.token {
            s.push_str(&format!("Authorization: Bearer {t}\r\n"));
        }
        for (k, v) in &self.headers {
            s.push_str(&format!("{k}: {v}\r\n"));
        }
        s.push_str(&format!("Content-Length: {}\r\n\r\n", self.body.len()));
        let mut b = s.into_bytes();
        b.extend_from_slice(&self.body);
        raw(port, &b).await
    }
}

/// Upload `content` as `name`; returns the file id.
pub async fn upload(h: &H, name: &str, content: &[u8]) -> String {
    let r = Req::new("PUT", &format!("/v1/files?name={}", urlenc(name))).body(content.to_vec()).send(h.port).await;
    assert_eq!(r.status, 201, "upload {name}: {}", r.text());
    r.json()["id"].as_str().unwrap().to_string()
}

pub fn urlenc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub async fn job(h: &H, profile: &str, inputs: &[&str], options: serde_json::Value) -> Resp {
    Req::new("POST", "/v1/jobs").json(serde_json::json!({"profile": profile, "inputs": inputs, "options": options})).send(h.port).await
}

/// Wait until a job finishes; returns its final JSON.
pub async fn wait(h: &H, id: &str) -> serde_json::Value {
    for _ in 0..600 {
        let r = Req::new("GET", &format!("/v1/jobs/{id}")).send(h.port).await;
        let j = r.json();
        if ["succeeded", "failed", "cancelled"].contains(&j["state"].as_str().unwrap_or("")) {
            return j;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("job {id} did not finish");
}

pub fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::*;
        use windows_sys::Win32::System::Threading::*;
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code) != 0 && code == 259; // STILL_ACTIVE
        CloseHandle(h);
        ok
    }
    // Linux: the process exists and is not a zombie (killed, not yet reaped).
    #[cfg(not(windows))]
    {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(st) => st.rfind(')').map(|i| st[i + 1..].split_whitespace().next() != Some("Z")).unwrap_or(false),
            Err(_) => false,
        }
    }
}
