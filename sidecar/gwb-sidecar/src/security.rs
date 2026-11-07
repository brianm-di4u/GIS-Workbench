//! Request checks (REQ-SDC-04, SDP-2.1 §3.3 item 4): Host allow-list (DNS rebinding), Origin
//! allow-list, exact-origin CORS with Private/Local Network Access preflights, bearer tokens.

use axum::http::{HeaderMap, HeaderValue, Method};

/// Where a request is going.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    /// `/v1/...`: the API.
    Api,
    /// `/app/...`: the released HTML, same origin as the API (REQ-SDC-15).
    App,
    /// `/ui/...`: the sidecar window (served to `localhost:<port>` only, with its own secret).
    Ui,
    /// `/relay/...`: the Python relay's client side (REQ-GAP-02): programs, never pages.
    Relay,
    /// `/sync/...`: the ArcGIS Pro add-in's side of sync (REQ-GAP-65): programs, never pages.
    Sync,
    /// `/stereo/...`: the native viewer's feed (REQ-GAP-33): one process with one ticket.
    Stereo,
    Other,
}

pub fn zone(path: &str) -> Zone {
    if path == "/v1" || path.starts_with("/v1/") {
        Zone::Api
    } else if path == "/app" || path.starts_with("/app/") {
        Zone::App
    } else if path == "/ui" || path.starts_with("/ui/") {
        Zone::Ui
    } else if path == "/relay" || path.starts_with("/relay/") {
        Zone::Relay
    } else if path == "/sync" || path.starts_with("/sync/") {
        Zone::Sync
    } else if path == "/stereo" || path.starts_with("/stereo/") {
        Zone::Stereo
    } else {
        Zone::Other
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKind {
    /// `127.0.0.1:<port>`: the API and `/app/`.
    Ip,
    /// `localhost:<port>`: the API and the sidecar window.
    Localhost,
}

/// The Host header must name this service exactly; anything else is a rebinding attempt or a
/// confused client. Only one Host header is accepted.
pub fn check_host(h: &HeaderMap, port: u16) -> Option<HostKind> {
    let mut it = h.get_all(axum::http::header::HOST).iter();
    let v = it.next()?;
    if it.next().is_some() {
        return None;
    }
    let s = v.to_str().ok()?;
    if s == format!("127.0.0.1:{port}") {
        Some(HostKind::Ip)
    } else if s.eq_ignore_ascii_case(&format!("localhost:{port}")) {
        Some(HostKind::Localhost)
    } else {
        None
    }
}

/// `scheme://host[:port]` in canonical form, https (or http on loopback), no path, no wildcard.
pub fn normalise_origin(t: &str) -> Result<String, String> {
    let t = t.trim();
    if t.contains('*') || t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("{t:?} is not an origin"));
    }
    let (scheme, rest) = t.split_once("://").ok_or_else(|| format!("{t:?} is not an origin"))?;
    let scheme = scheme.to_ascii_lowercase();
    let rest = rest.trim_end_matches('/');
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', '\\']) {
        return Err(format!("{t:?} is not an origin (no path, query or user part)"));
    }
    let host = rest.to_ascii_lowercase();
    let (h, port) = match host.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || h.starts_with('[') => {
            let pn: u16 = p.parse().map_err(|_| format!("{t:?}: bad port"))?;
            (h.to_string(), Some(pn))
        }
        _ => (host.clone(), None),
    };
    if h.is_empty() || !h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':')) {
        return Err(format!("{t:?}: bad host"));
    }
    let loopback = h == "localhost" || h == "127.0.0.1" || h == "[::1]";
    match scheme.as_str() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(format!("{t:?}: only https origins (or http on this computer) can be allowed")),
    }
    let default = if scheme == "https" { 443 } else { 80 };
    Ok(match port {
        Some(p) if p != default => format!("{scheme}://{h}:{p}"),
        _ => format!("{scheme}://{h}"),
    })
}

/// The request's origin as the sidecar treats it: the Origin header, or (when the browser sends
/// none, i.e. a same-origin GET) the origin named by the Host header.
pub fn request_origin(h: &HeaderMap, host: HostKind, port: u16) -> Result<String, &'static str> {
    let mut it = h.get_all(axum::http::header::ORIGIN).iter();
    match (it.next(), it.next()) {
        (Some(_), Some(_)) => Err("several Origin headers"),
        (Some(v), None) => {
            let s = v.to_str().map_err(|_| "unreadable Origin")?;
            if s == "null" {
                Ok("null".into())
            } else {
                normalise_origin(s).map_err(|_| "malformed Origin")
            }
        }
        (None, _) => Ok(match host {
            HostKind::Ip => format!("http://127.0.0.1:{port}"),
            HostKind::Localhost => format!("http://localhost:{port}"),
        }),
    }
}

pub const ALLOWED_METHODS: &str = "GET, HEAD, POST, PUT, DELETE";
pub const ALLOWED_HEADERS: [&str; 4] = ["authorization", "content-type", "range", "x-gwb-client"];
#[cfg(not(feature = "cors-relay"))]
pub const EXPOSED_HEADERS: &str = "Content-Range, Content-Length, Accept-Ranges, Content-Disposition, X-Gwb-File, X-Gwb-Api";
#[cfg(feature = "cors-relay")]
pub const EXPOSED_HEADERS: &str = "Content-Range, Content-Length, Accept-Ranges, Content-Disposition, X-Gwb-File, X-Gwb-Api, X-Gwb-Relay-Status, X-Gwb-Relay-Content-Type, X-Gwb-Relay-Content-Range, X-Gwb-Relay-Content-Length, X-Gwb-Relay-Content-Encoding, X-Gwb-Relay-Accept-Ranges, X-Gwb-Relay-Etag, X-Gwb-Relay-Last-Modified";

/// A CORS preflight: allowed when the method and every requested header are on the lists.
pub fn preflight_ok(h: &HeaderMap) -> bool {
    let m = h.get("access-control-request-method").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !["GET", "HEAD", "POST", "PUT", "DELETE"].contains(&m) {
        return false;
    }
    let req = h.get("access-control-request-headers").and_then(|v| v.to_str().ok()).unwrap_or("");
    req.split(',').map(|x| x.trim().to_ascii_lowercase()).filter(|x| !x.is_empty()).all(|x| ALLOWED_HEADERS.contains(&x.as_str()))
}

/// CORS headers for an allowed origin (exact origin, never `*`).
pub fn cors_headers(out: &mut HeaderMap, origin: &str, req: &HeaderMap, method: &Method) {
    if let Ok(v) = HeaderValue::from_str(origin) {
        out.insert("access-control-allow-origin", v);
    }
    out.append("vary", HeaderValue::from_static("Origin"));
    out.insert("access-control-expose-headers", HeaderValue::from_static(EXPOSED_HEADERS));
    if method == Method::OPTIONS {
        out.insert("access-control-allow-methods", HeaderValue::from_static(ALLOWED_METHODS));
        out.insert("access-control-allow-headers", HeaderValue::from_static("Authorization, Content-Type, Range, X-Gwb-Client"));
        out.insert("access-control-max-age", HeaderValue::from_static("600"));
        // Private Network Access (Chrome ≤ 141) and Local Network Access preflights.
        if req.get("access-control-request-private-network").and_then(|v| v.to_str().ok()) == Some("true") {
            out.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
        }
        if req.get("access-control-request-local-network").and_then(|v| v.to_str().ok()) == Some("true") {
            out.insert("access-control-allow-local-network", HeaderValue::from_static("true"));
        }
    }
}

/// The headers only a browser sends. The relay's client side refuses them, so no page, whatever
/// its origin or pairing, can reach it; that side answers no preflight and sends no CORS header.
pub fn from_a_browser(h: &HeaderMap) -> bool {
    ["origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"].iter().any(|k| h.contains_key(*k))
}

/// Relay routes serve a loopback peer only. The listener is bound to 127.0.0.1, so this is the
/// second lock; a request with no known peer is refused.
pub fn peer_is_loopback(peer: Option<std::net::SocketAddr>) -> bool {
    peer.is_some_and(|p| p.ip().is_loopback())
}

/// `Authorization: Bearer <64 hex>`.
pub fn bearer(h: &HeaderMap) -> Option<String> {
    let mut it = h.get_all(axum::http::header::AUTHORIZATION).iter();
    let v = it.next()?;
    if it.next().is_some() {
        return None;
    }
    let s = v.to_str().ok()?;
    let t = s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer "))?;
    Some(t.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hm(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn hosts() {
        assert_eq!(check_host(&hm(&[("host", "127.0.0.1:47821")]), 47821), Some(HostKind::Ip));
        assert_eq!(check_host(&hm(&[("host", "localhost:47821")]), 47821), Some(HostKind::Localhost));
        for bad in ["evil.example:47821", "127.0.0.1", "127.0.0.1:47822", "127.0.0.2:47821", "localhost.evil.example:47821", "0.0.0.0:47821", "[::1]:47821", "127.0.0.1:47821.evil", "2130706433:47821"] {
            assert_eq!(check_host(&hm(&[("host", bad)]), 47821), None, "{bad}");
        }
        assert_eq!(check_host(&hm(&[("host", "127.0.0.1:47821"), ("host", "evil:1")]), 47821), None);
        assert_eq!(check_host(&HeaderMap::new(), 47821), None);
    }

    #[test]
    fn origins() {
        assert_eq!(normalise_origin("https://Example.org/").unwrap(), "https://example.org");
        assert_eq!(normalise_origin("https://example.org:443").unwrap(), "https://example.org");
        assert_eq!(normalise_origin("https://example.org:8443").unwrap(), "https://example.org:8443");
        assert_eq!(normalise_origin("http://localhost:8080").unwrap(), "http://localhost:8080");
        for bad in ["http://example.org", "https://*.example.org", "https://example.org/path", "https://u@example.org", "ftp://example.org", "example.org", "https://", "https://exa mple.org", "javascript://x", "https://example.org?x"] {
            assert!(normalise_origin(bad).is_err(), "{bad}");
        }
        assert_eq!(request_origin(&hm(&[("origin", "null")]), HostKind::Ip, 1).unwrap(), "null");
        assert_eq!(request_origin(&HeaderMap::new(), HostKind::Ip, 47821).unwrap(), "http://127.0.0.1:47821");
        assert!(request_origin(&hm(&[("origin", "null"), ("origin", "https://a.example")]), HostKind::Ip, 1).is_err());
    }

    #[test]
    fn preflights() {
        assert!(preflight_ok(&hm(&[("access-control-request-method", "PUT"), ("access-control-request-headers", "authorization, content-type")])));
        assert!(!preflight_ok(&hm(&[("access-control-request-method", "PATCH")])));
        assert!(!preflight_ok(&hm(&[("access-control-request-method", "GET"), ("access-control-request-headers", "x-evil")])));
        let mut out = HeaderMap::new();
        cors_headers(&mut out, "null", &hm(&[("access-control-request-private-network", "true"), ("access-control-request-local-network", "true")]), &Method::OPTIONS);
        assert_eq!(out["access-control-allow-origin"], "null");
        assert_eq!(out["access-control-allow-private-network"], "true");
        assert_eq!(out["access-control-allow-local-network"], "true");
    }

    #[test]
    fn relay_client_side() {
        assert_eq!(zone("/relay/v1/mcp"), Zone::Relay);
        assert_eq!(zone("/relayx"), Zone::Other);
        assert!(!from_a_browser(&hm(&[("authorization", "Bearer a"), ("content-type", "application/json")])));
        for k in ["origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"] {
            assert!(from_a_browser(&hm(&[(k, "x")])), "{k}");
        }
        assert!(peer_is_loopback(Some("127.0.0.1:5000".parse().unwrap())));
        assert!(peer_is_loopback(Some("[::1]:5000".parse().unwrap())));
        for p in ["192.168.1.5:5000", "10.0.0.2:1", "0.0.0.0:1", "[2001:db8::1]:1"] {
            assert!(!peer_is_loopback(Some(p.parse().unwrap())), "{p}");
        }
        assert!(!peer_is_loopback(None));
        assert!(normalise_origin(crate::relay::RELAY_ORIGIN).is_err(), "no Origin header can name the relay's tokens");
    }

    #[test]
    fn tokens() {
        assert_eq!(bearer(&hm(&[("authorization", "Bearer abc")])).as_deref(), Some("abc"));
        assert_eq!(bearer(&hm(&[("authorization", "Basic abc")])), None);
        assert_eq!(bearer(&hm(&[("authorization", "Bearer a"), ("authorization", "Bearer b")])), None);
    }
}
