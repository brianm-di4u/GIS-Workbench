//! Where the pixels come from: the sidecar on loopback, or a built-in pattern for the hardware test.
//! The viewer holds no HTTP library: one short request per connection to 127.0.0.1, answered with a
//! `Content-Length`, is all it does, and it can name no other host.

use gwb_sidecar_api::{StereoEye, StereoMode, StereoReport, StereoScene};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use crate::scene::TileKey;

/// Largest answer taken: a 512² RGBA tile and its headers.
pub const MAX_RESPONSE: usize = (512 * 512 * 4) + 4096;
const TIMEOUT: Duration = Duration::from_secs(200);

/// One HTTP/1.1 response: its status and body. The body must be as long as its Content-Length.
pub fn parse_response(b: &[u8]) -> Result<(u16, &[u8]), String> {
    let Some(end) = b.windows(4).position(|w| w == b"\r\n\r\n") else { return Err("no end of headers".into()) };
    let head = std::str::from_utf8(&b[..end]).map_err(|_| "headers are not text")?;
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap_or("");
    let mut f = status.split(' ');
    if !f.next().is_some_and(|v| v == "HTTP/1.1" || v == "HTTP/1.0") {
        return Err("not an HTTP response".into());
    }
    let code: u16 = f.next().and_then(|c| c.parse().ok()).filter(|c| (100..600).contains(c)).ok_or("bad status")?;
    let mut length = None;
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { return Err("bad header".into()) };
        if k.eq_ignore_ascii_case("content-length") {
            let n: usize = v.trim().parse().map_err(|_| "bad Content-Length")?;
            if length.is_some_and(|m| m != n) {
                return Err("two Content-Lengths".into());
            }
            length = Some(n);
        }
        if k.eq_ignore_ascii_case("transfer-encoding") {
            return Err("a body in chunks".into());
        }
    }
    let body = &b[end + 4..];
    match length {
        Some(n) if n == body.len() => Ok((code, body)),
        Some(n) if n < body.len() => Err("more bytes than Content-Length".into()),
        Some(_) => Err("the answer was cut short".into()),
        None if body.is_empty() => Ok((code, body)),
        None => Err("no Content-Length".into()),
    }
}

/// A channel to one session of the sidecar.
#[derive(Clone)]
pub struct Link {
    addr: SocketAddr,
    session: String,
    ticket: String,
}

impl Link {
    pub fn new(addr: &str, session: &str, ticket: &str) -> Result<Link, String> {
        let addr: SocketAddr = addr.parse().map_err(|_| "--sidecar needs 127.0.0.1:<port>")?;
        if !addr.ip().is_loopback() {
            return Err("the viewer talks to the sidecar on this computer only".into());
        }
        if session.is_empty() || !session.bytes().all(|b| b.is_ascii_hexdigit()) || ticket.is_empty() || !ticket.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("bad session or ticket".into());
        }
        Ok(Link { addr, session: session.into(), ticket: ticket.into() })
    }

    fn call(&self, method: &str, path: &str, body: &[u8]) -> Result<Vec<u8>, String> {
        let mut s = TcpStream::connect_timeout(&self.addr, Duration::from_secs(10)).map_err(|e| format!("connect: {e}"))?;
        s.set_read_timeout(Some(TIMEOUT)).ok();
        s.set_write_timeout(Some(TIMEOUT)).ok();
        s.set_nodelay(true).ok();
        let head = format!("{method} /stereo/v1/{}/{path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", self.session, self.addr.port(), self.ticket, body.len());
        s.write_all(head.as_bytes()).map_err(|e| format!("send: {e}"))?;
        s.write_all(body).map_err(|e| format!("send: {e}"))?;
        let mut out = Vec::with_capacity(1 << 16);
        s.take(MAX_RESPONSE as u64 + 1).read_to_end(&mut out).map_err(|e| format!("read: {e}"))?;
        if out.len() > MAX_RESPONSE {
            return Err("the answer is larger than a tile".into());
        }
        let (code, b) = parse_response(&out)?;
        if !(200..300).contains(&code) {
            return Err(format!("{path}: {code} {}", String::from_utf8_lossy(b).chars().take(200).collect::<String>()));
        }
        Ok(b.to_vec())
    }

    pub fn report(&self, r: &StereoReport) -> Result<(), String> {
        let b = serde_json::to_vec(r).map_err(|e| e.to_string())?;
        self.call("POST", "report", &b).map(|_| ())
    }
}

/// Everything the viewer draws from.
pub trait Source: Send + Sync {
    fn scene(&self) -> Result<StereoScene, String>;
    /// `tile`² RGBA8 pixels.
    fn tile(&self, k: TileKey) -> Result<Vec<u8>, String>;
    fn report(&self, r: &StereoReport) -> Result<(), String>;
}

impl Source for Link {
    fn scene(&self) -> Result<StereoScene, String> {
        let b = self.call("GET", "scene", b"")?;
        serde_json::from_slice(&b).map_err(|e| format!("scene: {e}"))
    }

    fn tile(&self, k: TileKey) -> Result<Vec<u8>, String> {
        self.call("GET", &format!("tile/{}/{}/{}/{}", if k.left { "left" } else { "right" }, k.level, k.x, k.y), b"")
    }

    fn report(&self, r: &StereoReport) -> Result<(), String> {
        Link::report(self, r)
    }
}

/// The hardware test's pair (`--test-pattern`): the left eye sees an L on green, the right eye an R
/// on magenta, so a shutter system that swaps or leaks shows at once. No sidecar is needed.
pub struct Pattern;

pub const PATTERN_TILE: u32 = 512;

impl Pattern {
    fn lit(left: bool, x: u32, y: u32) -> bool {
        // On a 5 × 7 grid of 64-pixel cells, 96 pixels in from the corner.
        let (cx, cy) = (x.wrapping_sub(96) / 64, y.wrapping_sub(32) / 64);
        if cx >= 5 || cy >= 7 {
            return false;
        }
        const L: [u8; 7] = [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111];
        const R: [u8; 7] = [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001];
        (if left { L } else { R })[cy as usize] >> (4 - cx) & 1 == 1
    }
}

impl Source for Pattern {
    fn scene(&self) -> Result<StereoScene, String> {
        let e = |n: &str| StereoEye { name: n.into(), width: PATTERN_TILE, height: PATTERN_TILE, levels: vec![[PATTERN_TILE, PATTERN_TILE]], affine: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0] };
        Ok(StereoScene { tile: PATTERN_TILE, mode: StereoMode::Auto, left: e("left pattern"), right: e("right pattern") })
    }

    fn tile(&self, k: TileKey) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity((PATTERN_TILE * PATTERN_TILE * 4) as usize);
        for y in 0..PATTERN_TILE {
            for x in 0..PATTERN_TILE {
                let v = if Pattern::lit(k.left, x, y) { 255 } else { 48 };
                out.extend_from_slice(&if k.left { [0, v, 0, 255] } else { [v, 0, v, 255] });
            }
        }
        Ok(out)
    }

    fn report(&self, _: &StereoReport) -> Result<(), String> {
        Ok(())
    }
}

/// Requests waiting for a worker, newest first: what the analyst looks at now.
#[derive(Default)]
struct Queue {
    waiting: Vec<TileKey>,
    /// With a worker, or fetched and not yet taken by the viewer, so a new list does not ask for
    /// them twice. A key leaves only when the viewer receives it.
    running: HashSet<TileKey>,
    stop: bool,
}

#[derive(Default)]
struct Wanted {
    q: Mutex<Queue>,
    cv: Condvar,
}

pub struct Loaded {
    pub key: TileKey,
    pub rgba: Result<Vec<u8>, String>,
}

/// A few threads fetching tiles. They hold no GL: tiles come back to the drawing thread.
pub struct Fetcher {
    wanted: Arc<Wanted>,
    rx: mpsc::Receiver<Loaded>,
}

impl Fetcher {
    pub fn start<S: Source + 'static>(src: Arc<S>, threads: usize) -> Fetcher {
        let wanted = Arc::new(Wanted::default());
        let (tx, rx) = mpsc::channel();
        for _ in 0..threads {
            let (src, wanted, tx) = (src.clone(), wanted.clone(), tx.clone());
            std::thread::spawn(move || loop {
                let key = {
                    let mut g = wanted.q.lock().unwrap();
                    loop {
                        if g.stop {
                            return;
                        }
                        if !g.waiting.is_empty() {
                            let k = g.waiting.remove(0);
                            g.running.insert(k);
                            break k;
                        }
                        g = wanted.cv.wait(g).unwrap();
                    }
                };
                let rgba = src.tile(key);
                if tx.send(Loaded { key, rgba }).is_err() {
                    return;
                }
            });
        }
        Fetcher { wanted, rx }
    }

    /// Replace what is waiting: tiles the view has left behind are not fetched.
    pub fn want(&self, keys: Vec<TileKey>) {
        let mut g = self.wanted.q.lock().unwrap();
        g.waiting = keys.into_iter().filter(|k| !g.running.contains(k)).collect();
        drop(g);
        self.wanted.cv.notify_all();
    }

    /// The next tile fetched, waiting up to `wait`. Once it is here it may be asked for again.
    pub fn recv(&self, wait: Duration) -> Option<Loaded> {
        let l = if wait.is_zero() { self.rx.try_recv().ok() } else { self.rx.recv_timeout(wait).ok() }?;
        self.wanted.q.lock().unwrap().running.remove(&l.key);
        Some(l)
    }
}

impl Drop for Fetcher {
    fn drop(&mut self) {
        self.wanted.q.lock().unwrap().stop = true;
        self.wanted.cv.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses() {
        assert_eq!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc"), Ok((200, &b"abc"[..])));
        assert_eq!(parse_response(b"HTTP/1.1 204 No Content\r\n\r\n"), Ok((204, &b""[..])));
        assert_eq!(parse_response(b"HTTP/1.1 401 x\r\ncontent-length: 1\r\n\r\nz"), Ok((401, &b"z"[..])));
        for bad in [&b""[..], b"HTTP/1.1 200 OK\r\n", b"SMTP 200\r\n\r\n", b"HTTP/1.1 9999 x\r\n\r\n", b"HTTP/1.1 x y\r\n\r\n", b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabc", b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nabc", b"HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n", b"HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\na", b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", b"HTTP/1.1 200 OK\r\n\r\nabc", b"HTTP/1.1 200 OK\r\nno colon\r\n\r\n", b"HTTP/1.1 200 OK\r\nX: \xff\r\n\r\n"] {
            assert!(parse_response(bad).is_err(), "{:?}", String::from_utf8_lossy(bad));
        }
    }

    /// The parser on a mutated stream: it may refuse anything, and it must not panic.
    #[test]
    fn mutation_test_of_the_response_parser() {
        let seeds: [&[u8]; 3] = [b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Type: a/b\r\n\r\nabc", b"HTTP/1.1 204 No Content\r\n\r\n", b"HTTP/1.0 500 x\r\nContent-Length: 0\r\n\r\n"];
        let mut x: u64 = 0x2545f4914f6cdd1d;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        for _ in 0..200_000 {
            let mut b = seeds[(next() % 3) as usize].to_vec();
            for _ in 0..1 + next() % 8 {
                let i = next() as usize % b.len().max(1);
                match next() % 3 {
                    0 if !b.is_empty() => b[i] = next() as u8,
                    1 if !b.is_empty() => {
                        b.remove(i);
                    }
                    _ => b.insert(i.min(b.len()), next() as u8),
                }
            }
            if let Ok((c, body)) = parse_response(&b) {
                assert!((100..600).contains(&c));
                assert!(body.len() <= b.len());
            }
        }
    }

    #[test]
    fn links_reach_this_computer_only() {
        assert!(Link::new("127.0.0.1:47821", "ab12", "cd34").is_ok());
        for a in ["10.0.0.1:47821", "93.184.216.34:80", "example.org:80", "localhost:47821", ""] {
            assert!(Link::new(a, "ab12", "cd34").is_err(), "{a}");
        }
        for (s, t) in [("", "cd"), ("ab", ""), ("../x", "cd"), ("ab", "c d"), ("ab", "c\r\nd")] {
            assert!(Link::new("127.0.0.1:1", s, t).is_err(), "{s} {t}");
        }
    }

    #[test]
    fn the_pattern_differs_by_eye() {
        let k = |left| TileKey { left, level: 0, x: 0, y: 0 };
        let (l, r) = (Pattern.tile(k(true)).unwrap(), Pattern.tile(k(false)).unwrap());
        assert_eq!(l.len(), (PATTERN_TILE * PATTERN_TILE * 4) as usize);
        assert_ne!(l, r);
        let lit = |b: &[u8], x: usize, y: usize, c: usize| b[(y * 512 + x) * 4 + c];
        // The foot of the L is only in the left eye; the top of the R's bowl only in the right.
        assert_eq!(lit(&l, 96 + 64 * 4 + 8, 32 + 64 * 6 + 8, 1), 255);
        assert_eq!(lit(&r, 96 + 64 * 3 + 8, 32 + 8, 0), 255);
        assert_eq!(lit(&l, 96 + 64 * 3 + 8, 32 + 8, 1), 48);
    }
}
