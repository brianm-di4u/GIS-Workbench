//! The sidecar's own file and folder pickers (REQ-SDC-07 "Pick in sidecar"): the user chooses in
//! a native dialog, so the browser never names a path and a 10 GB mosaic is read in place.

use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    File,
    Files,
    Folder,
    /// Choose a folder to save an output into.
    SaveFolder,
}

/// Blocks until the user closes the dialog. Empty when cancelled.
pub fn pick(mode: Mode, title: &str) -> Vec<PathBuf> {
    #[cfg(windows)]
    unsafe {
        win::pick(mode, title)
    }
    #[cfg(not(windows))]
    {
        unix::pick(mode, title)
    }
}

/// Linux: the desktop's own dialog through zenity (GNOME and most others) or kdialog (KDE), run
/// with an argument array. Neither present (a server, WSL without a desktop): empty, and the
/// browser upload stays available.
#[cfg(not(windows))]
mod unix {
    use super::Mode;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    pub fn pick(mode: Mode, title: &str) -> Vec<PathBuf> {
        let zenity: Vec<&str> = match mode {
            Mode::File => vec!["--file-selection"],
            Mode::Files => vec!["--file-selection", "--multiple", "--separator=\n"],
            Mode::Folder | Mode::SaveFolder => vec!["--file-selection", "--directory"],
        };
        let kdialog: Vec<&str> = match mode {
            Mode::File => vec!["--getopenfilename", "."],
            Mode::Files => vec!["--getopenfilename", ".", "--multiple", "--separate-output"],
            Mode::Folder | Mode::SaveFolder => vec!["--getexistingdirectory", "."],
        };
        let title_z = format!("--title={title}");
        let runs: [(&str, Vec<&str>); 2] = [("zenity", [zenity, vec![title_z.as_str()]].concat()), ("kdialog", [kdialog, vec!["--title", title]].concat())];
        for (prog, args) in runs {
            match Command::new(prog).args(&args).stdin(Stdio::null()).stderr(Stdio::null()).output() {
                Ok(o) if o.status.success() => {
                    return String::from_utf8_lossy(&o.stdout).lines().map(str::trim).filter(|l| !l.is_empty()).map(PathBuf::from).collect();
                }
                Ok(_) => return vec![], // cancelled
                Err(_) => continue,     // not installed
            }
        }
        vec![]
    }
}

#[cfg(windows)]
mod win {
    use super::Mode;
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::PathBuf;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::Com::*;
    use windows_sys::Win32::UI::Controls::Dialogs::*;
    use windows_sys::Win32::UI::Shell::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain([0]).collect()
    }

    /// A tiny topmost owner so the dialog comes up in front of the browser.
    unsafe fn owner() -> HWND {
        let class = wide("STATIC");
        let h = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, class.as_ptr(), std::ptr::null(), WS_POPUP, 0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null());
        if !h.is_null() {
            SetForegroundWindow(h);
        }
        h
    }

    pub unsafe fn pick(mode: Mode, title: &str) -> Vec<PathBuf> {
        let hw = owner();
        let t = wide(title);
        let out = match mode {
            Mode::File | Mode::Files => {
                let mut buf = vec![0u16; 65536];
                let filter: Vec<u16> = "All files (*.*)\0*.*\0\0".encode_utf16().collect();
                let mut ofn: OPENFILENAMEW = std::mem::zeroed();
                ofn.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
                ofn.hwndOwner = hw;
                ofn.lpstrFilter = filter.as_ptr();
                ofn.lpstrFile = buf.as_mut_ptr();
                ofn.nMaxFile = buf.len() as u32;
                ofn.lpstrTitle = t.as_ptr();
                ofn.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_DONTADDTORECENT | OFN_HIDEREADONLY | if mode == Mode::Files { OFN_ALLOWMULTISELECT } else { 0 };
                if GetOpenFileNameW(&mut ofn) == 0 {
                    vec![]
                } else {
                    // One path, or a folder followed by file names, separated by NULs.
                    let parts: Vec<OsString> = buf.split(|c| *c == 0).take_while(|s| !s.is_empty()).map(OsString::from_wide).collect();
                    if parts.len() == 1 {
                        vec![PathBuf::from(&parts[0])]
                    } else {
                        let dir = PathBuf::from(&parts[0]);
                        parts[1..].iter().map(|n| dir.join(n)).collect()
                    }
                }
            }
            Mode::Folder | Mode::SaveFolder => {
                CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32);
                let mut bi: BROWSEINFOW = std::mem::zeroed();
                bi.hwndOwner = hw;
                bi.lpszTitle = t.as_ptr();
                bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | if mode == Mode::Folder { BIF_NONEWFOLDERBUTTON } else { 0 };
                let pidl = SHBrowseForFolderW(&bi);
                let mut res = vec![];
                if !pidl.is_null() {
                    let mut path = vec![0u16; 32768];
                    if SHGetPathFromIDListEx(pidl, path.as_mut_ptr(), path.len() as u32, 0) != 0 {
                        let n = path.iter().position(|c| *c == 0).unwrap_or(0);
                        res.push(PathBuf::from(OsString::from_wide(&path[..n])));
                    }
                    CoTaskMemFree(pidl as *const _);
                }
                CoUninitialize();
                res
            }
        };
        if !hw.is_null() {
            DestroyWindow(hw);
        }
        out
    }
}
