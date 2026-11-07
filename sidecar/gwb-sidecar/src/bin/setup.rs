//! gwb-sidecar-setup: everything that touches the network or the installed modules, kept out of the
//! service (which never connects out, REQ-SDC-14). Run only when the user asks (the installer,
//! the Start menu, "Add or remove modules…" in the sidecar window).
//!
//!   gwb-sidecar-setup vendor-prompt            ask, per vendor plug-in, to install it (installer)
//!   gwb-sidecar-setup vendor mrsid|ecw [--from DIR] [--accept]
//!   gwb-sidecar-setup vendor openh264 [--from DIR] [--accept]   Linux: Cisco's binary (REQ-GAP-51)
//!   gwb-sidecar-setup remove vendor-mrsid|vendor-ecw|vendor-openh264|media|points|sar
//!   gwb-sidecar-setup add-module ZIP           portable builds: a module ZIP checked against SHA256SUMS
//!   gwb-sidecar-setup modules                  what is installed, with a menu
//!   gwb-sidecar-setup check-update             REQ-SDC-13: the release feed, only when asked
//!   gwb-sidecar-setup uninstall-cleanup        removes what the setup added and the data folder
//!
//! Downloads use Windows' own curl.exe and archives Windows' tar.exe, each with an argument array
//! (no shell), https only; every download is checked against a pinned SHA-256.
#![windows_subsystem = "windows"]

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const PINS: &str = include_str!("../../../installer/vendor-pins.toml");
const RELEASES: &str = "https://api.github.com/repos/brianm-di4u/GIS-Workbench/releases?per_page=20";
/// The installer asset check-update looks for.
#[cfg(windows)]
const PACKAGE_SUFFIX: &str = "-x64.msi";
#[cfg(not(windows))]
const PACKAGE_SUFFIX: &str = "-amd64.deb";

#[derive(Deserialize)]
struct Pins {
    mirror: String,
    #[allow(dead_code)]
    gdal_minor: String,
    #[serde(flatten)]
    vendors: BTreeMap<String, Pin>,
}

#[derive(Deserialize, Clone)]
struct Pin {
    /// Where `path` and a relative `licence_path` are; the `mirror` of the file when absent.
    #[serde(default)]
    #[cfg_attr(windows, allow(dead_code))]
    mirror: Option<String>,
    title: String,
    module: String,
    package: String,
    version: String,
    path: String,
    #[allow(dead_code)]
    size: u64,
    sha256: String,
    licence_path: String,
    licence_sha256: String,
    plugin: String,
    dlls: Vec<String>,
    notice: String,
    caution: String,
}

fn install_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."))
}

fn modules_dir() -> PathBuf {
    std::env::var_os("GWB_SIDECAR_MODULES").map(PathBuf::from).unwrap_or_else(|| install_dir().join("modules"))
}

#[cfg(windows)]
fn system32(exe: &str) -> PathBuf {
    PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())).join("System32").join(exe)
}

/// Linux: the system's own curl and tar (/usr/bin), never one found first on PATH.
#[cfg(not(windows))]
fn system32(exe: &str) -> PathBuf {
    let name = exe.trim_end_matches(".exe");
    ["/usr/bin", "/bin"].iter().map(|d| Path::new(d).join(name)).find(|p| p.is_file()).unwrap_or_else(|| PathBuf::from("/usr/bin").join(name))
}

fn quiet() -> bool {
    std::env::args().any(|a| a == "--quiet")
}

/// MessageBox (or stderr with --quiet). Returns true for Yes/OK.
fn ask(title: &str, text: &str, yes_no: bool) -> bool {
    if quiet() {
        eprintln!("{title}: {text}");
        return !yes_no;
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let w = |s: &str| -> Vec<u16> { s.encode_utf16().chain([0]).collect() };
        let flags = if yes_no { MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 } else { MB_OK | MB_ICONINFORMATION };
        let r = MessageBoxW(std::ptr::null_mut(), w(text).as_ptr(), w(title).as_ptr(), flags | MB_SETFOREGROUND | MB_TOPMOST);
        return r == IDYES || r == IDOK;
    }
    // Linux: the desktop's dialog (zenity, kdialog); without one, a terminal question when there
    // is a terminal, else the answer is No.
    #[cfg(not(windows))]
    {
        use std::io::IsTerminal;
        let z = if yes_no { "--question" } else { "--info" };
        if let Ok(st) = Command::new("zenity").args([z, "--no-wrap", &format!("--title={title}"), &format!("--text={text}")]).status() {
            return st.success();
        }
        let k = if yes_no { "--yesno" } else { "--msgbox" };
        if let Ok(st) = Command::new("kdialog").args(["--title", title, k, text]).status() {
            return st.success();
        }
        eprintln!("{title}: {text}");
        if yes_no && std::io::stdin().is_terminal() {
            eprint!("[y/N] ");
            let mut a = String::new();
            let _ = std::io::stdin().read_line(&mut a);
            return a.trim().eq_ignore_ascii_case("y") || a.trim().eq_ignore_ascii_case("yes");
        }
        return !yes_no;
    }
    #[allow(unreachable_code)]
    false
}

fn sha256_file(p: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// https download with Windows' curl.exe; fails on HTTP errors; never follows to http.
fn download(url: &str, dest: &Path) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err(format!("refusing a non-https URL: {url}"));
    }
    let st = Command::new(system32("curl.exe"))
        .args(["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--max-time", "1800", "--output"])
        .arg(dest)
        .arg(url)
        .status()
        .map_err(|e| format!("curl.exe: {e}"))?;
    if !st.success() {
        return Err(format!("download failed: {url}"));
    }
    Ok(())
}

fn fetch_checked(url: &str, dest: &Path, sha: &str) -> Result<(), String> {
    if dest.is_file() && sha256_file(dest)? == sha {
        return Ok(());
    }
    download(url, dest)?;
    let got = sha256_file(dest)?;
    if got != sha {
        let _ = std::fs::remove_file(dest);
        return Err(format!("{} does not match its pinned SHA-256 (got {got}); nothing was installed", dest.display()));
    }
    Ok(())
}

/// The plug-in was built against OSGeo4W's gdal313.dll; the sidecar ships conda-forge's gdal.dll.
fn retarget_import(buf: &mut [u8]) -> Result<(), String> {
    let from = b"gdal313.dll\0";
    let mut n = 0;
    let mut i = 0;
    while i + from.len() <= buf.len() {
        if &buf[i..i + from.len()] == from {
            buf[i..i + from.len()].copy_from_slice(b"gdal.dll\0\0\0\0");
            n += 1;
            i += from.len();
        } else {
            i += 1;
        }
    }
    if n != 1 {
        return Err(format!("expected one import of gdal313.dll in the plug-in, found {n}"));
    }
    Ok(())
}

fn vendor(name: &str, from: Option<PathBuf>, pre_accepted: bool) -> Result<bool, String> {
    #[cfg(not(windows))]
    {
        return linux::vendor(name, from, pre_accepted);
    }
    #[allow(unreachable_code)]
    let pins: Pins = toml::from_str(PINS).map_err(|e| e.to_string())?;
    if name == "openh264" {
        return Err("OpenH264 is for the Linux sidecar; on Windows the H.264 encoder is the operating system's".into());
    }
    let pin = pins.vendors.get(name).cloned().ok_or_else(|| format!("unknown vendor plug-in {name} (mrsid or ecw)"))?;
    let core = modules_dir().join("core-gdal");
    if !core.join("bin").join("gdal.dll").is_file() {
        return Err("the Core GDAL module is not installed; install it first".into());
    }
    let work = std::env::temp_dir().join(format!("gwb-sidecar-{}", pin.module));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let tarball = work.join(pin.path.rsplit('/').next().unwrap_or("pkg.tar.bz2"));
    let licence = work.join("LICENSE.txt");
    match &from {
        // Offline: the two files copied from a connected machine (same names as on the mirror).
        Some(dir) => {
            std::fs::copy(dir.join(tarball.file_name().unwrap()), &tarball).map_err(|e| format!("{}: {e}", dir.display()))?;
            std::fs::copy(dir.join(pin.licence_path.rsplit('/').next().unwrap()), &licence).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        None => {
            fetch_checked(&format!("{}/{}", pins.mirror, pin.licence_path), &licence, &pin.licence_sha256)?;
        }
    }
    if sha256_file(&licence)? != pin.licence_sha256 {
        return Err("the licence text does not match the pinned one; nothing was installed".into());
    }
    // Show the licence and ask (REQ-SDC-12): nothing of the SDK is fetched before acceptance.
    if !pre_accepted {
        let _ = Command::new(system32("notepad.exe")).arg(&licence).spawn();
        let mut q = format!("{}\n\nThe vendor's licence is open in Notepad. Do you accept its terms?\n\nYes downloads {} {} from download.osgeo.org (OSGeo4W) and installs it for the sidecar. No installs nothing; MrSID/ECW conversion then stays unavailable (you can add it later from the sidecar window).", pin.title, pin.package, pin.version);
        if !pin.caution.is_empty() {
            q = format!("{q}\n\nNote: {}", pin.caution);
        }
        if !ask("GIS Workbench Sidecar — vendor licence", &q, true) {
            return Ok(false);
        }
    }
    if from.is_none() {
        fetch_checked(&format!("{}/{}", pins.mirror, pin.path), &tarball, &pin.sha256)?;
    } else if sha256_file(&tarball)? != pin.sha256 {
        return Err(format!("{} does not match its pinned SHA-256", tarball.display()));
    }
    let x = work.join("x");
    std::fs::create_dir_all(&x).map_err(|e| e.to_string())?;
    let st = Command::new(system32("tar.exe")).arg("-xjf").arg(&tarball).arg("-C").arg(&x).status().map_err(|e| format!("tar.exe: {e}"))?;
    if !st.success() {
        return Err("could not unpack the plug-in package".into());
    }
    let dest = modules_dir().join(&pin.module);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::create_dir_all(dest.join("gdalplugins")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest.join("bin")).map_err(|e| e.to_string())?;
    let mut plugin = std::fs::read(x.join(&pin.plugin)).map_err(|e| format!("{}: {e}", pin.plugin))?;
    retarget_import(&mut plugin)?;
    std::fs::write(dest.join("gdalplugins").join(pin.plugin.rsplit('/').next().unwrap()), plugin).map_err(|e| e.to_string())?;
    for d in &pin.dlls {
        let src = x.join(d);
        if src.is_file() {
            std::fs::copy(&src, dest.join("bin").join(d.rsplit('/').next().unwrap())).map_err(|e| e.to_string())?;
        }
    }
    std::fs::copy(&licence, dest.join("LICENSE.txt")).map_err(|e| e.to_string())?;
    std::fs::write(dest.join("NOTICE.txt"), &pin.notice).map_err(|e| e.to_string())?;
    let acc = serde_json::json!({"package": pin.package, "version": pin.version, "source": pins.mirror, "sha256": pin.sha256, "licence_sha256": pin.licence_sha256, "accepted_at": gwb_sidecar::util::now_rfc3339(), "by": std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default(), "offline": from.is_some()});
    std::fs::write(dest.join("ACCEPTED.json"), serde_json::to_vec_pretty(&acc).unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(dest.join("MANIFEST.json"), serde_json::to_vec_pretty(&serde_json::json!({"id": pin.module, "version": pin.version, "package": pin.package})).unwrap()).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&work);
    Ok(true)
}

/// Linux: Cisco's OpenH264 (REQ-GAP-51), and a vendor plug-in a user built under the vendor's terms.
#[cfg(not(windows))]
mod linux {
    use super::*;

    /// Shows a licence: the desktop's text window, else stderr.
    fn show(licence: &Path) {
        if !quiet() {
            let shown = Command::new("zenity").args(["--text-info", "--width=760", "--height=560", "--title=Licence"]).arg(format!("--filename={}", licence.display())).status().map(|s| s.code().is_some()).unwrap_or(false);
            if shown {
                return;
            }
        }
        eprintln!("{}", std::fs::read_to_string(licence).unwrap_or_default());
    }

    /// `Ok(false)`: the user said no.
    pub fn vendor(name: &str, from: Option<PathBuf>, pre_accepted: bool) -> Result<bool, String> {
        match (name, from) {
            ("openh264", from) => openh264(from, pre_accepted),
            ("mrsid" | "ecw", Some(dir)) => plugin(name, &dir, pre_accepted),
            // REQ-GAP-69: no route without the vendors' terms (docs/validation/2.6/codecs.md).
            ("mrsid" | "ecw", None) => Err("the MrSID and ECW decode plug-ins come from OSGeo4W, which is Windows only: convert MrSID and ECW files with a Windows sidecar, or give --from a plug-in you built under the vendor's own licence".into()),
            _ => Err(format!("unknown vendor plug-in {name} (openh264, mrsid or ecw)")),
        }
    }

    /// Cisco's binary: fetched here, on the user's device, pinned like the Windows plug-ins, and
    /// never part of a package (BINARY_LICENSE.txt, condition 1).
    fn openh264(from: Option<PathBuf>, pre_accepted: bool) -> Result<bool, String> {
        let pins: Pins = toml::from_str(PINS).map_err(|e| e.to_string())?;
        let pin = pins.vendors.get("openh264").cloned().ok_or("no pin for OpenH264")?;
        if !modules_dir().join("media").join("bin").join("ffmpeg-h264").is_file() {
            return Err("this sidecar's Media module has no ffmpeg-h264: install the Media module of Sidecar 0.3 or later first".into());
        }
        let work = std::env::temp_dir().join(format!("gwb-vendor-{}", gwb_sidecar::util::random_hex(6)));
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let done = fetch_openh264(&pin, &work, from.as_deref(), pre_accepted);
        let _ = std::fs::remove_dir_all(&work);
        done
    }

    fn fetch_openh264(pin: &Pin, work: &Path, from: Option<&Path>, pre_accepted: bool) -> Result<bool, String> {
        let base = pin.mirror.as_deref().ok_or("the OpenH264 pin names no mirror")?;
        let packed = work.join(&pin.path);
        let licence = work.join("BINARY_LICENSE.txt");
        if let Some(dir) = from {
            std::fs::copy(dir.join(&pin.path), &packed).map_err(|e| format!("{}: {e}", dir.display()))?;
            std::fs::copy(dir.join("BINARY_LICENSE.txt"), &licence).map_err(|e| format!("{}: {e}", dir.display()))?;
        } else {
            fetch_checked(&pin.licence_path, &licence, &pin.licence_sha256)?;
        }
        if sha256_file(&licence)? != pin.licence_sha256 {
            return Err("the licence text does not match the pinned one; nothing was installed".into());
        }
        if !pre_accepted {
            show(&licence);
            let q = format!("{}\n\n{} {}, {} bytes, comes from {base} and goes into this sidecar's modules. Without it, MPEG-2 video converts to MPEG-1. You can turn it off again under Add or remove modules.\n\nPatent cover: Cisco's licence covers personal use and other uses for which you are not paid. No licence is granted for any other use, so paid or commercial work needs its own AVC licence.\n\nDo you accept the terms shown (Cisco's BINARY_LICENSE.txt)?", pin.title, pin.package, pin.version, pin.size);
            if !ask("GIS Workbench Sidecar — OpenH264", &q, true) {
                return Ok(false);
            }
        }
        if from.is_none() {
            fetch_checked(&format!("{base}/{}", pin.path), &packed, &pin.sha256)?;
        } else if sha256_file(&packed)? != pin.sha256 {
            return Err(format!("{} does not match its pinned SHA-256", packed.display()));
        }
        let dest = modules_dir().join(&pin.module);
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(dest.join("lib")).map_err(|e| e.to_string())?;
        let so = dest.join("lib").join(&pin.dlls[0]);
        let out = std::fs::File::create(&so).map_err(|e| e.to_string())?;
        let st = Command::new(system32("bzip2")).arg("-dc").arg(&packed).stdout(out).status().map_err(|e| format!("bzip2: {e}"))?;
        if !st.success() || std::fs::read(&so).map(|b| !b.starts_with(b"\x7fELF")).unwrap_or(true) {
            let _ = std::fs::remove_dir_all(&dest);
            return Err("could not unpack the OpenH264 library (is bzip2 installed?)".into());
        }
        finish(pin, &dest, &licence, base, from.is_some())?;
        Ok(true)
    }

    fn finish(pin: &Pin, dest: &Path, licence: &Path, source: &str, offline: bool) -> Result<(), String> {
        std::fs::copy(licence, dest.join("LICENSE.txt")).map_err(|e| e.to_string())?;
        std::fs::write(dest.join("NOTICE.txt"), &pin.notice).map_err(|e| e.to_string())?;
        let acc = serde_json::json!({"package": pin.package, "version": pin.version, "source": source, "sha256": pin.sha256, "licence_sha256": pin.licence_sha256, "accepted_at": gwb_sidecar::util::now_rfc3339(), "by": std::env::var("USER").unwrap_or_default(), "offline": offline});
        std::fs::write(dest.join("ACCEPTED.json"), serde_json::to_vec_pretty(&acc).unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(dest.join("MANIFEST.json"), serde_json::to_vec_pretty(&serde_json::json!({"id": pin.module, "version": pin.version, "package": pin.package})).unwrap()).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// A plug-in the user built against this sidecar's GDAL with the vendor's SDK: DIR holds the
    /// plug-in, its libraries in lib/, and the vendor's LICENSE.txt. No pin: this file is theirs.
    fn plugin(name: &str, dir: &Path, pre_accepted: bool) -> Result<bool, String> {
        let (module, so) = if name == "mrsid" { ("vendor-mrsid", "gdal_MrSID.so") } else { ("vendor-ecw", "gdal_ECW_JP2ECW.so") };
        let licence = dir.join("LICENSE.txt");
        if !dir.join(so).is_file() || !licence.is_file() {
            return Err(format!("{} must hold {so} and the vendor's LICENSE.txt", dir.display()));
        }
        if !pre_accepted {
            show(&licence);
            if !ask("GIS Workbench Sidecar — vendor licence", &format!("Install the {name} plug-in from {}? Its vendor's licence is shown; do you accept its terms?", dir.display()), true) {
                return Ok(false);
            }
        }
        let dest = modules_dir().join(module);
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(dest.join(gwb_sidecar::modules::GDAL_PLUGINS)).map_err(|e| e.to_string())?;
        std::fs::copy(dir.join(so), dest.join(gwb_sidecar::modules::GDAL_PLUGINS).join(so)).map_err(|e| e.to_string())?;
        if let Ok(rd) = std::fs::read_dir(dir.join("lib")) {
            for e in rd.flatten().filter(|e| e.path().is_file()) {
                std::fs::copy(e.path(), dest.join("lib").join(e.file_name())).map_err(|e| e.to_string())?;
            }
        }
        std::fs::copy(&licence, dest.join("LICENSE.txt")).map_err(|e| e.to_string())?;
        let acc = serde_json::json!({"package": so, "source": dir.display().to_string(), "accepted_at": gwb_sidecar::util::now_rfc3339(), "by": std::env::var("USER").unwrap_or_default(), "local_build": true});
        std::fs::write(dest.join("ACCEPTED.json"), serde_json::to_vec_pretty(&acc).unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(dest.join("MANIFEST.json"), serde_json::to_vec_pretty(&serde_json::json!({"id": module, "version": "local build", "package": so})).unwrap()).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// The modules window on Linux. The title is the text Cisco's licence asks for at this control.
    pub fn menu(lines: &[String]) -> Result<(), String> {
        let m = gwb_sidecar::modules::def(gwb_sidecar::modules::OPENH264).unwrap();
        let on = gwb_sidecar::modules::installed(&modules_dir(), m);
        let q = if on { format!("Turn off the {}? MPEG-2 video then converts to MPEG-1.", m.title) } else { format!("Download the {}? MPEG-2 video then converts to H.264 instead of MPEG-1.", m.title) };
        let text = format!("{}\n\nThe Linux package holds Core GDAL, Point cloud, Media and the Python runtime. The MrSID and ECW plug-ins are Windows only (OSGeo4W).\n\n{q}", lines.join("\n"));
        if ask("GIS Workbench Sidecar — modules", &text, true) {
            if on {
                remove(gwb_sidecar::modules::OPENH264)?;
            } else {
                vendor_prompt();
            }
        }
        Ok(())
    }
}

/// Modules `remove` may delete: the optional ones. Core GDAL goes with the sidecar. The folder name is the module id.
const REMOVABLE: &[&str] = &["vendor-mrsid", "vendor-ecw", "vendor-openh264", "media", "points", "sar", "model3d", "ossim", "sfm", "proj-grids"];

fn remove(module: &str) -> Result<(), String> {
    if !REMOVABLE.contains(&module) {
        return Err(format!("{module} cannot be removed here (Core GDAL is removed with the sidecar)"));
    }
    let d = modules_dir().join(module);
    if d.exists() {
        std::fs::remove_dir_all(&d).map_err(|e| format!("{}: {e} (stop the sidecar first)", d.display()))?;
    }
    Ok(())
}

/// The module a `gwb-sidecar-module-<id>-<version>.zip` holds: every module package.mjs writes a ZIP for
/// (core-gdal, points, media, sar, model3d, ossim, proj-grids, sfm). `ossim` was missing here, so its
/// ZIP was refused as an unknown module.
#[cfg_attr(not(windows), allow(dead_code))]
fn module_zip_id(name: &str) -> Result<&str, String> {
    let id = name.strip_prefix("gwb-sidecar-module-").and_then(|s| s.split('-').next()).ok_or("not a sidecar module ZIP")?;
    if !["core", "points", "media", "sar", "model3d", "ossim", "proj", "sfm"].contains(&id) {
        return Err(format!("unknown module in {name}"));
    }
    Ok(id)
}

/// Portable builds: `gwb-sidecar-module-<id>-<version>.zip` beside its release SHA256SUMS.
fn add_module(zip: &Path) -> Result<String, String> {
    // The Linux packages (.deb, AppImage) hold every module; there are no module archives.
    #[cfg(not(windows))]
    {
        let _ = zip;
        return Err("the Linux packages include every module; there is nothing to add".into());
    }
    #[allow(unreachable_code)]
    let name = zip.file_name().and_then(|s| s.to_str()).ok_or("bad file name")?;
    let id = module_zip_id(name)?;
    let sums = std::fs::read_to_string(zip.with_file_name("SHA256SUMS")).map_err(|_| "SHA256SUMS must sit beside the module ZIP".to_string())?;
    let want = sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let h = it.next()?;
        (it.next()?.trim_start_matches('*') == name).then(|| h.to_ascii_lowercase())
    });
    let got = sha256_file(zip)?;
    if want.as_deref() != Some(got.as_str()) {
        return Err(format!("{name} does not match SHA256SUMS"));
    }
    let st = Command::new(system32("tar.exe")).arg("-xf").arg(zip).arg("-C").arg(modules_dir()).status().map_err(|e| e.to_string())?;
    if !st.success() {
        return Err("could not unpack the module".into());
    }
    Ok(id.to_string())
}

fn version_tuple(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split(['.', '-']).map(|x| x.parse().unwrap_or(0)).collect()
}

/// REQ-SDC-13: only when asked; the package must match the release's SHA256SUMS. (Builds are
/// unsigned previews: Authenticode verification is added when signing is (an open owner item).)
fn check_update() -> Result<(), String> {
    let me = env!("CARGO_PKG_VERSION");
    let work = std::env::temp_dir().join("gwb-sidecar-update");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let feed = work.join("releases.json");
    download(RELEASES, &feed)?;
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(&feed).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut best: Option<(Vec<u64>, String, String, String)> = None;
    for rel in v.as_array().cloned().unwrap_or_default() {
        let assets = rel["assets"].as_array().cloned().unwrap_or_default();
        let msi = assets.iter().find(|a| a["name"].as_str().is_some_and(|n| n.starts_with("GWB-Sidecar-") && n.ends_with(PACKAGE_SUFFIX)));
        let sums = assets.iter().find(|a| a["name"] == "SHA256SUMS");
        if let (Some(m), Some(s)) = (msi, sums) {
            let name = m["name"].as_str().unwrap_or("").to_string();
            let ver = name.trim_start_matches("GWB-Sidecar-").trim_end_matches(PACKAGE_SUFFIX).to_string();
            let vt = version_tuple(&ver);
            if vt > version_tuple(me) && best.as_ref().is_none_or(|b| vt > b.0) {
                best = Some((vt, name, m["browser_download_url"].as_str().unwrap_or("").into(), s["browser_download_url"].as_str().unwrap_or("").into()));
            }
        }
    }
    let Some((_, name, url, sums_url)) = best else {
        ask("GIS Workbench Sidecar", &format!("Sidecar {me} is the newest release."), false);
        return Ok(());
    };
    if !ask("GIS Workbench Sidecar — update", &format!("{name} is available (installed: {me}). Download and install it?"), true) {
        return Ok(());
    }
    let sums = work.join("SHA256SUMS");
    download(&sums_url, &sums)?;
    let msi = work.join(&name);
    download(&url, &msi)?;
    let want = std::fs::read_to_string(&sums).map_err(|e| e.to_string())?.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let h = it.next()?;
        (it.next()?.trim_start_matches('*') == name).then(|| h.to_ascii_lowercase())
    });
    if want.as_deref() != Some(sha256_file(&msi)?.as_str()) {
        let _ = std::fs::remove_file(&msi);
        return Err("the update does not match the release's SHA256SUMS; it was deleted".into());
    }
    #[cfg(windows)]
    Command::new(system32("msiexec.exe")).arg("/i").arg(&msi).spawn().map_err(|e| e.to_string())?;
    // Linux: installing a .deb needs the administrator; the checked package is left for the user.
    #[cfg(not(windows))]
    ask("GIS Workbench Sidecar — update", &format!("{} is downloaded and matches the release's SHA256SUMS. Install it with:\n\nsudo apt install {}", name, msi.display()), false);
    Ok(())
}

/// Stop sidecars running from this install folder (the installer runs this before it replaces or
/// removes files; their tools die with them through the Job Objects).
fn stop() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::*;
        use windows_sys::Win32::System::Diagnostics::ToolHelp::*;
        use windows_sys::Win32::System::Threading::*;
        let me = install_dir().join("gwb-sidecar.exe");
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return;
        }
        let mut pe: PROCESSENTRY32W = std::mem::zeroed();
        pe.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut pe) != 0 {
            loop {
                let n = String::from_utf16_lossy(&pe.szExeFile[..pe.szExeFile.iter().position(|c| *c == 0).unwrap_or(0)]);
                if n.eq_ignore_ascii_case("gwb-sidecar.exe") {
                    let h = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pe.th32ProcessID);
                    if !h.is_null() {
                        let mut buf = vec![0u16; 1024];
                        let mut len = buf.len() as u32;
                        if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0 {
                            let path = PathBuf::from(String::from_utf16_lossy(&buf[..len as usize]));
                            if path.eq(&me) {
                                TerminateProcess(h, 0);
                                // Its files (log, store) are closed only once it has gone.
                                WaitForSingleObject(h, 5000);
                            }
                        }
                        CloseHandle(h);
                    }
                }
                if Process32NextW(snap, &mut pe) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    // Linux: every gwb-sidecar process whose program is this install's (from /proc/<pid>/exe).
    #[cfg(target_os = "linux")]
    {
        let me = std::fs::canonicalize(install_dir().join("gwb-sidecar")).unwrap_or_default();
        let Ok(rd) = std::fs::read_dir("/proc") else { return };
        for e in rd.flatten() {
            let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
            if std::fs::read_link(format!("/proc/{pid}/exe")).ok().as_deref() == Some(me.as_path()) {
                unsafe { libc::kill(pid, libc::SIGTERM) };
                for _ in 0..50 {
                    if !Path::new(&format!("/proc/{pid}")).exists() {
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
    }
}

fn uninstall_cleanup(data: Option<PathBuf>) {
    for m in ["vendor-mrsid", "vendor-ecw", "vendor-openh264"] {
        let _ = std::fs::remove_dir_all(modules_dir().join(m));
    }
    let _ = std::fs::remove_dir(modules_dir());
    // The per-user data folder (pairings, uploads, outputs not saved elsewhere, logs). The installer
    // passes it (its custom action may not see the user's environment); only a folder with the
    // sidecar's own name is ever removed.
    let d = data.unwrap_or_else(gwb_sidecar::config::default_data_dir);
    if d.file_name().and_then(|n| n.to_str()).is_some_and(|n| n == "GIS Workbench Sidecar" || n == "gis-workbench-sidecar") {
        // A just-stopped sidecar may still hold its log for a moment: retry briefly.
        let mut last = Ok(());
        for _ in 0..20 {
            last = std::fs::remove_dir_all(&d);
            if last.is_ok() || !d.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        if d.exists() {
            setup_log(&format!("uninstall-cleanup: data {} could not be removed: {:?}", d.display(), last.err().map(|e| e.to_string())));
        } else {
            // Nothing is left behind, not even this program's own log.
            let _ = std::fs::remove_file(std::env::temp_dir().join("gwb-sidecar-setup.log"));
        }
    } else {
        setup_log(&format!("uninstall-cleanup: refused to remove {}", d.display()));
    }
}

/// `%TEMP%\gwb-sidecar-setup.log`: what the setup program did (support, installer custom actions).
fn setup_log(line: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(std::env::temp_dir().join("gwb-sidecar-setup.log")) {
        let _ = writeln!(f, "{} {}", gwb_sidecar::util::now_rfc3339(), line);
    }
}

fn modules_menu() -> Result<(), String> {
    let root = modules_dir();
    let mut lines = vec![];
    for m in gwb_sidecar::modules::MODULES {
        let on = gwb_sidecar::modules::installed(&root, m);
        lines.push(format!("{} {}", if on { "✓" } else { "–" }, m.title));
    }
    let mrsid = gwb_sidecar::modules::installed(&root, gwb_sidecar::modules::def("vendor-mrsid").unwrap());
    let ecw = gwb_sidecar::modules::installed(&root, gwb_sidecar::modules::def("vendor-ecw").unwrap());
    #[cfg(not(windows))]
    {
        let _ = (mrsid, ecw);
        return linux::menu(&lines);
    }
    #[allow(unreachable_code)]
    let text = format!("{}\n\nMedia, Point cloud and the Python runtime are chosen in the installer (Apps ▸ GIS Workbench Sidecar ▸ Modify).\n\n{}", lines.join("\n"), if mrsid && ecw { "Remove the MrSID and ECW plug-ins?" } else { "Install the MrSID and ECW decode plug-ins from OSGeo4W (their licences are shown first)?" });
    if ask("GIS Workbench Sidecar — modules", &text, true) {
        if mrsid && ecw {
            remove("vendor-mrsid")?;
            remove("vendor-ecw")?;
        } else {
            vendor_prompt();
        }
    }
    Ok(())
}

fn vendor_prompt() {
    for v in if cfg!(windows) { ["mrsid", "ecw"].as_slice() } else { ["openh264"].as_slice() } {
        match vendor(v, None, false) {
            Ok(true) => {
                ask("GIS Workbench Sidecar", &format!("The {v} plug-in is installed. Restart the sidecar (tray icon ▸ Quit, then start it) to use it."), false);
            }
            Ok(false) => {}
            Err(e) => {
                ask("GIS Workbench Sidecar", &format!("The {v} plug-in was not installed: {e}"), false);
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).filter(|a| a != "--quiet").collect();
    let r: Result<(), String> = match args.first().map(String::as_str) {
        Some("vendor-prompt") => {
            vendor_prompt();
            Ok(())
        }
        Some("vendor") => {
            let name = args.get(1).cloned().unwrap_or_default();
            let from = args.iter().position(|a| a == "--from").and_then(|i| args.get(i + 1)).map(PathBuf::from);
            let accept = args.iter().any(|a| a == "--accept");
            vendor(&name, from, accept).map(|ok| {
                if !ok {
                    eprintln!("not installed: the licence was not accepted");
                }
            })
        }
        Some("remove") => remove(args.get(1).map(String::as_str).unwrap_or("")),
        Some("add-module") => add_module(Path::new(args.get(1).map(String::as_str).unwrap_or(""))).map(|id| eprintln!("module {id} added")),
        Some("check-update") => check_update(),
        Some("uninstall-cleanup") => {
            stop();
            let data = args.iter().position(|a| a == "--data").and_then(|i| args.get(i + 1)).map(|s| PathBuf::from(s.trim_end_matches(['\\', '/'])));
            uninstall_cleanup(data);
            Ok(())
        }
        Some("stop") => {
            stop();
            Ok(())
        }
        Some("modules") | Some("--modules") | None => modules_menu(),
        Some(o) => Err(format!("unknown command {o}")),
    };
    if let Err(e) = r {
        ask("GIS Workbench Sidecar setup", &e, false);
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn pins_parse_and_versions() {
        let p: super::Pins = toml::from_str(super::PINS).unwrap();
        assert!(p.vendors.contains_key("mrsid") && p.vendors.contains_key("ecw"));
        // Cisco's binary: https only, pinned, one library, and the wording its licence asks for.
        let o = &p.vendors["openh264"];
        assert!(o.mirror.as_deref().unwrap().starts_with("https://") && o.licence_path.starts_with("https://"));
        assert_eq!((o.sha256.len(), o.licence_sha256.len()), (64, 64));
        assert_eq!(o.dlls, ["libopenh264.so.8"]);
        assert_eq!(o.notice, "OpenH264 Video Codec provided by Cisco Systems, Inc.");
        assert!(super::version_tuple("0.2.0") > super::version_tuple("0.1.9"));
        for n in ["core-gdal", "points", "media", "sar", "model3d", "ossim", "proj-grids", "sfm"] {
            assert!(super::module_zip_id(&format!("gwb-sidecar-module-{n}-0.3.0.zip")).is_ok(), "{n}");
        }
        assert!(super::module_zip_id("gwb-sidecar-module-other-0.3.0.zip").is_err());
        // Every module but Core GDAL can be removed, and each one is a folder under the modules folder.
        for m in gwb_sidecar::modules::MODULES.iter().map(|d| d.id) {
            assert_eq!(super::REMOVABLE.contains(&m), m != "core-gdal", "{m}");
        }
        assert!(super::module_zip_id("GWB-Sidecar-0.3.0-x64.msi").is_err());
        let mut b = b"xxgdal313.dll\0yy".to_vec();
        super::retarget_import(&mut b).unwrap();
        assert_eq!(&b, b"xxgdal.dll\0\0\0\0yy");
    }
}
