//! Notification-area icon: "Open the sidecar window" and "Quit". A pairing request shows a
//! balloon and opens the window (at most every 20 s, and not while a window is already polling).

use crate::service::Service;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

static SVC: OnceLock<Arc<Service>> = OnceLock::new();
static LAST_OPEN: Mutex<Option<Instant>> = Mutex::new(None);
#[cfg(windows)]
static HWND_TRAY: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Open the sidecar window in the default browser (a one-time launch link).
pub fn open_window(svc: &Service) {
    if svc.cfg.headless {
        svc.log(format!("sidecar window: {}", svc.ui_url()));
        return;
    }
    *LAST_OPEN.lock().unwrap() = Some(Instant::now());
    open_url(&svc.ui_url());
}

pub fn open_url(url: &str) {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        let w = |s: &str| -> Vec<u16> { std::ffi::OsStr::new(s).encode_wide().chain([0]).collect() };
        let (op, u) = (w("open"), w(url));
        windows_sys::Win32::UI::Shell::ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), u.as_ptr(), std::ptr::null(), std::ptr::null(), windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL);
    }
    // Linux: the desktop's opener (xdg-open, gio), else $BROWSER; argument arrays, no shell.
    #[cfg(not(windows))]
    {
        let browser = std::env::var("BROWSER").ok().filter(|b| !b.is_empty() && !b.contains(char::is_whitespace));
        let openers: Vec<(String, Vec<&str>)> = [("xdg-open".to_string(), vec![]), ("gio".to_string(), vec!["open"])].into_iter().chain(browser.map(|b| (b, vec![]))).collect();
        for (prog, pre) in openers {
            if std::process::Command::new(&prog).args(&pre).arg(url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().is_ok() {
                return;
            }
        }
        eprintln!("gwb-sidecar: open {url} in a browser");
    }
}

pub fn pairing_requested(svc: &Service) {
    let recent_window = svc.admin.last_poll.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_secs(5));
    let recent_open = LAST_OPEN.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_secs(20));
    balloon("GIS Workbench wants to pair", "Check the six-digit code in the sidecar window, then Allow or Deny.");
    if !recent_window && !recent_open {
        open_window(svc);
    }
}

fn balloon(title: &str, text: &str) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::Shell::*;
        let h = HWND_TRAY.load(std::sync::atomic::Ordering::SeqCst);
        if h == 0 {
            return;
        }
        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = h as _;
        nid.uID = 1;
        nid.uFlags = NIF_INFO;
        copy(&mut nid.szInfoTitle, title);
        copy(&mut nid.szInfo, text);
        nid.dwInfoFlags = NIIF_INFO;
        Shell_NotifyIconW(NIM_MODIFY, &nid);
    }
    // Linux: a desktop notification when notify-send is there (no tray icon on Linux).
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("notify-send").args(["--app-name=GIS Workbench Sidecar", title, text]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
    }
}

#[cfg(windows)]
fn copy(dst: &mut [u16], s: &str) {
    let w: Vec<u16> = s.encode_utf16().take(dst.len() - 1).collect();
    dst[..w.len()].copy_from_slice(&w);
    dst[w.len()] = 0;
}

/// Start the tray icon on its own thread (it needs a message loop).
pub fn spawn(svc: Arc<Service>) {
    if svc.cfg.headless {
        return;
    }
    let _ = SVC.set(svc);
    #[cfg(windows)]
    std::thread::spawn(|| unsafe { win::run() });
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Shell::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const WM_TRAY: u32 = WM_APP + 1;
    const ID_OPEN: usize = 1;
    const ID_QUIT: usize = 2;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }

    unsafe extern "system" fn proc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        match msg {
            WM_TRAY => {
                let ev = (lp & 0xffff) as u32;
                if ev == WM_LBUTTONDBLCLK || ev == NIN_BALLOONUSERCLICK || ev == WM_LBUTTONUP {
                    if let Some(s) = SVC.get() {
                        open_window(s);
                    }
                } else if ev == WM_RBUTTONUP || ev == WM_CONTEXTMENU {
                    let m = CreatePopupMenu();
                    let (o, q) = (wide("Open the sidecar window"), wide("Quit the sidecar"));
                    AppendMenuW(m, MF_STRING, ID_OPEN, o.as_ptr());
                    AppendMenuW(m, MF_STRING, ID_QUIT, q.as_ptr());
                    let mut pt = POINT { x: 0, y: 0 };
                    GetCursorPos(&mut pt);
                    SetForegroundWindow(h);
                    let cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, h, std::ptr::null());
                    DestroyMenu(m);
                    match cmd as usize {
                        ID_OPEN => {
                            if let Some(s) = SVC.get() {
                                open_window(s);
                            }
                        }
                        ID_QUIT => crate::QUIT.notify_waiters(),
                        _ => {}
                    }
                }
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(h, msg, wp, lp),
        }
    }

    pub unsafe fn run() {
        let inst = GetModuleHandleW(std::ptr::null());
        let cls = wide("GwbSidecarTray");
        let wc = WNDCLASSW { lpfnWndProc: Some(proc), hInstance: inst, lpszClassName: cls.as_ptr(), ..std::mem::zeroed() };
        RegisterClassW(&wc);
        let h = CreateWindowExW(0, cls.as_ptr(), cls.as_ptr(), 0, 0, 0, 0, 0, HWND_MESSAGE, std::ptr::null_mut(), inst, std::ptr::null());
        if h.is_null() {
            return;
        }
        HWND_TRAY.store(h as usize, std::sync::atomic::Ordering::SeqCst);
        let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
        nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        nid.hWnd = h;
        nid.uID = 1;
        nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        nid.uCallbackMessage = WM_TRAY;
        nid.hIcon = LoadIconW(std::ptr::null_mut(), IDI_APPLICATION);
        let port = SVC.get().map(|s| s.port).unwrap_or(0);
        copy(&mut nid.szTip, &format!("GIS Workbench Sidecar (preview) — 127.0.0.1:{port}"));
        Shell_NotifyIconW(NIM_ADD, &nid);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        Shell_NotifyIconW(NIM_DELETE, &nid);
    }

    pub fn remove() {
        let h = HWND_TRAY.load(std::sync::atomic::Ordering::SeqCst);
        if h != 0 {
            unsafe {
                let mut nid: NOTIFYICONDATAW = std::mem::zeroed();
                nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
                nid.hWnd = h as _;
                nid.uID = 1;
                Shell_NotifyIconW(NIM_DELETE, &nid);
            }
        }
    }
}

pub fn remove_icon() {
    #[cfg(windows)]
    win::remove();
}
