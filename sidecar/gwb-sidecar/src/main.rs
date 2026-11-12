//! `gwb-sidecar [--data-dir D] [--modules-dir D] [--app-dir D] [--allow-origin https://…] [--headless]`
//!
//! Starting it a second time opens the window of the running instance instead.
#![windows_subsystem = "windows"]

use gwb_sidecar::{config::Config, service::Service};
use std::io::{Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // `gwb-sidecar run …` is gwb-run with no window: for a scheduler (REG-150, REG-151). It starts
    // no service and no tray; its log in the output folder is its output.
    if args.first().map(String::as_str) == Some("run") {
        std::process::exit(gwb_sidecar::recipe_run::main(&args[1..]) as i32);
    }
    if args.iter().any(|a| a == "--version") {
        println!("gwb-sidecar {} (API {})", env!("CARGO_PKG_VERSION"), gwb_sidecar_api::API_LEVEL);
        return;
    }
    let cfg = match Config::from_args(&args) {
        Ok(c) => c,
        Err(e) => fail(&e),
    };
    let (listener, port) = match gwb_sidecar::bind(&cfg.ports) {
        Ok(x) => x,
        Err(e) => {
            // Already running: ask it for a window link.
            if !cfg.headless && open_running(&cfg) {
                return;
            }
            fail(&e)
        }
    };
    if let Some(p) = &cfg.port_file {
        let _ = std::fs::write(p, port.to_string());
    }
    let svc = match Service::new(cfg, port) {
        Ok(s) => s,
        Err(e) => fail(&e),
    };
    svc.log(format!("gwb-sidecar {} listening on 127.0.0.1:{port} (data {})", env!("CARGO_PKG_VERSION"), svc.cfg.data_dir.display()));
    svc.log(format!("tool confinement: {}", gwb_sidecar::winjob::confinement()));
    gwb_sidecar::tray::spawn(svc.clone());
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio");
    let r = rt.block_on(gwb_sidecar::serve(svc.clone(), listener, async {
        let _ = tokio::signal::ctrl_c().await;
    }));
    gwb_sidecar::tray::remove_icon();
    if let Err(e) = r {
        fail(&e);
    }
}

fn fail(msg: &str) -> ! {
    eprintln!("gwb-sidecar: {msg}");
    #[cfg(windows)]
    unsafe {
        let w = |s: &str| -> Vec<u16> { s.encode_utf16().chain([0]).collect() };
        if std::env::args().all(|a| a != "--headless") {
            windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(std::ptr::null_mut(), w(msg).as_ptr(), w("GIS Workbench Sidecar").as_ptr(), windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR);
        }
    }
    std::process::exit(1)
}

/// POST /ui/api/launch to a running instance with the key from `<data>/ui.key`.
fn open_running(cfg: &Config) -> bool {
    let Ok(key) = std::fs::read_to_string(cfg.data_dir.join("ui.key")) else { return false };
    for &p in &cfg.ports {
        let Ok(mut s) = std::net::TcpStream::connect(("127.0.0.1", p)) else { continue };
        let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(3)));
        let req = format!("POST /ui/api/launch HTTP/1.1\r\nHost: localhost:{p}\r\nX-Gwb-Key: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", key.trim());
        if s.write_all(req.as_bytes()).is_err() {
            continue;
        }
        let mut buf = String::new();
        let _ = s.read_to_string(&mut buf);
        if let Some(i) = buf.find("\r\n\r\n") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(buf[i + 4..].trim()) {
                if let Some(u) = v.get("url").and_then(|u| u.as_str()) {
                    if u.starts_with(&format!("http://localhost:{p}/ui/")) {
                        gwb_sidecar::tray::open_url(u);
                        return true;
                    }
                }
            }
        }
    }
    false
}
