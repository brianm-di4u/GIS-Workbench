//! Path confinement (REQ-SDC-04, SDP-2.1 §3.3 item 5). No path ever comes from the browser: inputs
//! are file ids, and names are sanitised before they become a file name inside the sidecar's data
//! folder. Paths the user picks in the sidecar's own dialog are still refused when they are UNC,
//! device or reparse-point (symlink, junction) paths.

use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub enum PathError {
    Empty,
    TooLong,
    BadChar(char),
    Traversal,
    Reserved(String),
    TrailingDotOrSpace,
    Unc,
    Device,
    Reparse(PathBuf),
    Outside,
    Io(String),
}

impl std::fmt::Display for PathError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathError::Empty => write!(f, "the name is empty"),
            PathError::TooLong => write!(f, "the name is too long"),
            PathError::BadChar(c) => write!(f, "the name contains {c:?}"),
            PathError::Traversal => write!(f, "the name climbs out of its folder (..)"),
            PathError::Reserved(n) => write!(f, "{n} is a reserved Windows device name"),
            PathError::TrailingDotOrSpace => write!(f, "the name ends in a dot or a space"),
            PathError::Unc => write!(f, "network (UNC) paths are refused"),
            PathError::Device => write!(f, "device paths are refused"),
            PathError::Reparse(p) => write!(f, "{} is a link (symlink or junction); links are refused", p.display()),
            PathError::Outside => write!(f, "the path is outside the sidecar's folders"),
            PathError::Io(e) => write!(f, "{e}"),
        }
    }
}

const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];

/// Whether `stem` (the part before the first dot) is a Windows device name: CON, PRN, AUX, NUL,
/// COM0–9, LPT0–9 (also with superscript digits), CONIN$, CONOUT$, CLOCK$.
pub fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end_matches([' ']).to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) || ["CONIN$", "CONOUT$", "CLOCK$"].contains(&stem.as_str()) {
        return true;
    }
    let chars: Vec<char> = stem.chars().collect();
    if chars.len() == 4 {
        let head: String = chars[..3].iter().collect();
        if (head == "COM" || head == "LPT") && (chars[3].is_ascii_digit() || matches!(chars[3], '¹' | '²' | '³')) {
            return true;
        }
    }
    false
}

/// A single file-name component that is safe to create inside a folder the sidecar owns.
pub fn safe_name(name: &str) -> Result<String, PathError> {
    let n = name.trim_start();
    if n.is_empty() {
        return Err(PathError::Empty);
    }
    if n.chars().count() > 200 {
        return Err(PathError::TooLong);
    }
    if n == "." || n == ".." || n.contains("..") && (n.starts_with("..") || n.ends_with("..")) {
        return Err(PathError::Traversal);
    }
    for c in n.chars() {
        if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '\u{202e}' | '\u{feff}') {
            return Err(PathError::BadChar(c));
        }
    }
    if n.ends_with('.') || n.ends_with(' ') {
        return Err(PathError::TrailingDotOrSpace);
    }
    if is_reserved(n) {
        return Err(PathError::Reserved(n.split('.').next().unwrap_or(n).to_string()));
    }
    Ok(n.to_string())
}

/// A path the user picked in the sidecar's own dialog: absolute, local drive, no device/UNC prefix,
/// no `..`, and neither it nor any parent is a reparse point.
pub fn check_user_path(p: &Path) -> Result<PathBuf, PathError> {
    let s = p.to_string_lossy();
    if s.starts_with(r"\\.\") || s.starts_with(r"\\?\GLOBALROOT") || s.starts_with(r"\??\") {
        return Err(PathError::Device);
    }
    if s.starts_with(r"\\?\UNC\") || s.starts_with(r"\\") && !s.starts_with(r"\\?\") {
        return Err(PathError::Unc);
    }
    // Linux: kernel and device trees are not data (a tool reading /proc/self/... or /dev/sda).
    #[cfg(not(windows))]
    if ["/proc", "/sys", "/dev"].iter().any(|d| p.starts_with(d)) {
        return Err(PathError::Device);
    }
    for c in p.components() {
        match c {
            Component::ParentDir => return Err(PathError::Traversal),
            Component::Prefix(pre) => {
                use std::path::Prefix::*;
                match pre.kind() {
                    Disk(_) | VerbatimDisk(_) => {}
                    UNC(..) | VerbatimUNC(..) => return Err(PathError::Unc),
                    DeviceNS(_) | Verbatim(_) => return Err(PathError::Device),
                }
            }
            Component::Normal(x) => {
                if is_reserved(&x.to_string_lossy()) {
                    return Err(PathError::Reserved(x.to_string_lossy().into_owned()));
                }
            }
            _ => {}
        }
    }
    if !p.is_absolute() {
        return Err(PathError::Outside);
    }
    no_reparse_points(p)?;
    Ok(p.to_path_buf())
}

/// Refuse when `p` or any of its ancestors is a symlink or junction.
pub fn no_reparse_points(p: &Path) -> Result<(), PathError> {
    let mut cur = PathBuf::new();
    for c in p.components() {
        cur.push(c.as_os_str());
        if matches!(c, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        match std::fs::symlink_metadata(&cur) {
            Ok(m) => {
                if is_reparse(&m) {
                    return Err(PathError::Reparse(cur));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(PathError::Io(e.to_string())),
        }
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 || m.file_type().is_symlink()
}
#[cfg(not(windows))]
fn is_reparse(m: &std::fs::Metadata) -> bool {
    m.file_type().is_symlink()
}

/// `child` must resolve to a path under `root` (both canonicalised), with no reparse point between.
pub fn confined(root: &Path, child: &Path) -> Result<PathBuf, PathError> {
    let r = std::fs::canonicalize(root).map_err(|e| PathError::Io(e.to_string()))?;
    let c = std::fs::canonicalize(child).map_err(|e| PathError::Io(e.to_string()))?;
    if !c.starts_with(&r) {
        return Err(PathError::Outside);
    }
    let rel = c.strip_prefix(&r).map_err(|_| PathError::Outside)?;
    let mut cur = r.clone();
    for comp in rel.components() {
        cur.push(comp.as_os_str());
        let m = std::fs::symlink_metadata(&cur).map_err(|e| PathError::Io(e.to_string()))?;
        if is_reparse(&m) {
            return Err(PathError::Reparse(cur));
        }
    }
    Ok(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(safe_name("Hamilton 2023.sid").unwrap(), "Hamilton 2023.sid");
        assert_eq!(safe_name("a.b.c.tif").unwrap(), "a.b.c.tif");
        for bad in ["", "..", ".", "../x", "..\\x", "a/b", "a\\b", "C:x", "x:stream", "a|b", "a?b", "a*b", "a\"b", "a<b", "a>b", "a\u{0}b", "a\nb", "x.", "x ", "CON", "con.txt", "Nul.tif", "COM1", "lpt9.log", "COM¹", "CONIN$", "x..", "..x", "evil\u{202e}fdp.exe"] {
            assert!(safe_name(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(!is_reserved("console.txt") && !is_reserved("COM10") && !is_reserved("auxiliary.tif"));
    }

    #[test]
    fn user_paths() {
        #[cfg(not(windows))]
        {
            assert_eq!(check_user_path(Path::new("/proc/self/environ")), Err(PathError::Device));
            assert_eq!(check_user_path(Path::new("/dev/sda")), Err(PathError::Device));
            assert_eq!(check_user_path(Path::new("/data/../etc/x")), Err(PathError::Traversal));
            assert_eq!(check_user_path(Path::new("relative/x.sid")), Err(PathError::Outside));
            let tmp = std::env::temp_dir();
            assert!(check_user_path(&tmp.join("gwb-nonexistent-file.sid")).is_ok());
        }
        #[cfg(windows)]
        windows_user_paths();
    }

    #[cfg(windows)]
    fn windows_user_paths() {
        assert_eq!(check_user_path(Path::new(r"\\server\share\x.sid")), Err(PathError::Unc));
        assert_eq!(check_user_path(Path::new(r"\\?\UNC\server\share\x.sid")), Err(PathError::Unc));
        assert_eq!(check_user_path(Path::new(r"\\.\PhysicalDrive0")), Err(PathError::Device));
        assert_eq!(check_user_path(Path::new(r"\\?\GLOBALROOT\Device\X")), Err(PathError::Device));
        assert_eq!(check_user_path(Path::new(r"C:\data\..\Windows\x")), Err(PathError::Traversal));
        assert!(matches!(check_user_path(Path::new(r"C:\data\CON")), Err(PathError::Reserved(_))));
        assert_eq!(check_user_path(Path::new(r"relative\x.sid")), Err(PathError::Outside));
        let tmp = std::env::temp_dir();
        assert!(check_user_path(&tmp.join("gwb-nonexistent-file.sid")).is_ok());
    }

    #[test]
    fn confinement() {
        let base = std::env::temp_dir().join(format!("gwb-conf-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(base.join("a")).unwrap();
        std::fs::write(base.join("a/f.txt"), b"x").unwrap();
        assert!(confined(&base, &base.join("a/f.txt")).is_ok());
        assert_eq!(confined(&base.join("a"), &base.join("a/../")), Err(PathError::Outside));
        // A junction inside the root that points outside it is refused.
        #[cfg(windows)]
        {
            let target = std::env::temp_dir();
            let link = base.join("j");
            let ok = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&link).arg(&target).output().map(|o| o.status.success()).unwrap_or(false);
            if ok {
                assert!(confined(&base, &link).is_err());
                assert!(matches!(no_reparse_points(&link.join("x")), Err(PathError::Reparse(_))));
                std::fs::remove_dir(&link).ok();
            }
        }
        // A symlink inside the root that points outside it is refused.
        #[cfg(unix)]
        {
            let link = base.join("l");
            std::os::unix::fs::symlink(std::env::temp_dir(), &link).unwrap();
            assert!(confined(&base, &link).is_err());
            assert!(matches!(no_reparse_points(&link.join("x")), Err(PathError::Reparse(_))));
            std::fs::remove_file(&link).ok();
        }
        std::fs::remove_dir_all(&base).ok();
    }
}
