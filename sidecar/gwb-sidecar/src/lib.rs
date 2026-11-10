//! GIS Workbench sidecar (SDP-2.1 §3.2–§3.8, Appendix D §8): an optional loopback-only service
//! that converts files the browser cannot read into formats it can, with bundled tools run from
//! fixed profiles inside Windows Job Objects.

pub mod appserve;
pub mod caps;
pub mod cdp;
pub mod config;
#[cfg(feature = "cors-relay")]
pub mod corsrelay;
pub mod csmhost;
pub mod files;
pub mod jobs;
pub mod modules;
pub mod pairing;
pub mod paths;
pub mod picker;
pub mod profiles;
pub mod prosync;
pub mod recipe_run;
pub mod relay;
pub mod runner;
pub mod security;
pub mod server;
pub mod service;
pub mod stereo;
pub mod tray;
pub mod ui;
pub mod util;
pub mod views;
pub mod winjob;
pub mod zipdir;

use std::sync::Arc;

#[cfg(all(feature = "cors-relay", feature = "airgap"))]
compile_error!("the CORS relay is compiled out of the air-gapped variant (REQ-GAP-08, OD-2.17)");

/// Set by "Quit" in the window or the tray.
pub static QUIT: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Bind the first free port of `cfg.ports` on 127.0.0.1 only, exclusively (no other process can
/// bind the same address while the sidecar runs).
pub fn bind(ports: &[u16]) -> Result<(std::net::TcpListener, u16), String> {
    let mut last = String::new();
    for &p in ports {
        match bind_exclusive(p) {
            Ok(l) => {
                let actual = l.local_addr().map(|a| a.port()).unwrap_or(p);
                return Ok((l, actual));
            }
            Err(e) => last = format!("127.0.0.1:{p}: {e}"),
        }
    }
    Err(format!("no free port among {ports:?} ({last})"))
}

fn bind_exclusive(port: u16) -> std::io::Result<std::net::TcpListener> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    #[cfg(windows)]
    {
        use std::os::windows::io::FromRawSocket;
        use windows_sys::Win32::Networking::WinSock::*;
        // std's listener cannot set SO_EXCLUSIVEADDRUSE before bind, so make the socket by hand.
        let _ = std::net::UdpSocket::bind("127.0.0.1:0"); // makes std call WSAStartup
        unsafe {
            let s = WSASocketW(AF_INET as i32, SOCK_STREAM, IPPROTO_TCP, std::ptr::null(), 0, WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT);
            if s == INVALID_SOCKET {
                return Err(std::io::Error::last_os_error());
            }
            let one: i32 = 1;
            setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, &one as *const i32 as *const u8, 4);
            let sa = SOCKADDR_IN { sin_family: AF_INET, sin_port: port.to_be(), sin_addr: IN_ADDR { S_un: IN_ADDR_0 { S_addr: u32::from_ne_bytes([127, 0, 0, 1]) } }, sin_zero: [0; 8] };
            if windows_sys::Win32::Networking::WinSock::bind(s, &sa as *const SOCKADDR_IN as *const SOCKADDR, std::mem::size_of::<SOCKADDR_IN>() as i32) != 0 || listen(s, 128) != 0 {
                let e = std::io::Error::from_raw_os_error(WSAGetLastError());
                closesocket(s);
                return Err(e);
            }
            let l = std::net::TcpListener::from_raw_socket(s as u64);
            l.set_nonblocking(true)?;
            let _ = addr;
            Ok(l)
        }
    }
    #[cfg(not(windows))]
    {
        let l = std::net::TcpListener::bind(addr)?;
        l.set_nonblocking(true)?;
        Ok(l)
    }
}

/// The service, and with it the Python relay (REQ-GAP-02), never serves anything but loopback.
/// A separate check so that tests need no listener on a wider address, which on Windows raises a
/// firewall prompt for each newly compiled test program.
pub fn require_loopback(addr: std::io::Result<std::net::SocketAddr>) -> Result<(), String> {
    if addr.map(|a| a.ip().is_loopback()).unwrap_or(false) {
        Ok(())
    } else {
        Err("the sidecar serves loopback only".into())
    }
}

/// Run the service until Quit (or `shutdown` resolves).
pub async fn serve(svc: Arc<service::Service>, listener: std::net::TcpListener, shutdown: impl std::future::Future<Output = ()> + Send + 'static) -> Result<(), String> {
    require_loopback(listener.local_addr())?;
    let l = tokio::net::TcpListener::from_std(listener).map_err(|e| e.to_string())?;
    let app = server::router(svc.clone());
    let caps = svc.caps.clone();
    tokio::spawn(async move { caps.refresh().await });
    // Old uploads and outputs are removed after 14 days.
    let s2 = svc.clone();
    tokio::spawn(async move {
        loop {
            let n = s2.files.sweep(14 * 86400);
            if n > 0 {
                s2.log(format!("removed {n} file(s) older than 14 days"));
            }
            s2.views.sweep(std::time::Duration::from_secs(24 * 3600));
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
    axum::serve(l, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = QUIT.notified() => {},
                _ = shutdown => {},
            }
        })
        .await
        .map_err(|e| e.to_string())
}
