//! File hand-off (REQ-SDC-07). Uploads land in `<data>/files/<group>/<name>`, outputs in
//! `<data>/outputs/<job>/<name>`, and picked files stay where the user keeps them (zero copy).
//! Every record belongs to the origin that created it: another origin cannot read, convert or
//! delete it. The browser only ever sees ids and names, never a path.

use crate::paths;
use gwb_sidecar_api::{FileInfo, FileOrigin};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRec {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub origin: FileOrigin,
    /// The pairing origin that owns it.
    pub owner: String,
    pub path: PathBuf,
    /// Upload group (files that travel together: a .sid with its .sdw, a shapefile set).
    pub group: String,
    /// A picked folder: its file names.
    #[serde(default)]
    pub entries: Vec<String>,
    #[serde(default)]
    pub is_dir: bool,
    pub created: u64,
}

impl FileRec {
    pub fn info(&self) -> FileInfo {
        FileInfo { id: self.id.clone(), name: self.name.clone(), size: self.size, origin: self.origin, entries: self.entries.clone(), group: (self.origin == FileOrigin::Upload).then(|| self.group.clone()) }
    }
}

pub struct Files {
    pub root: PathBuf,
    map: Mutex<HashMap<String, FileRec>>,
}

impl Files {
    pub fn open(data: &Path) -> Files {
        let root = data.to_path_buf();
        let _ = std::fs::create_dir_all(root.join("files"));
        let _ = std::fs::create_dir_all(root.join("outputs"));
        let mut map = HashMap::new();
        if let Ok(t) = std::fs::read_to_string(root.join("files.json")) {
            if let Ok(v) = serde_json::from_str::<Vec<FileRec>>(&t) {
                for r in v {
                    // Records whose bytes are gone (deleted by hand) are dropped.
                    if r.path.exists() {
                        map.insert(r.id.clone(), r);
                    }
                }
            }
        }
        // Partial uploads from a crash never become files.
        if let Ok(rd) = std::fs::read_dir(root.join("files")) {
            for g in rd.flatten() {
                if let Ok(rd2) = std::fs::read_dir(g.path()) {
                    for f in rd2.flatten() {
                        if f.path().extension().map(|e| e == "part").unwrap_or(false) {
                            let _ = std::fs::remove_file(f.path());
                        }
                    }
                }
            }
        }
        Files { root, map: Mutex::new(map) }
    }

    fn save(&self, map: &HashMap<String, FileRec>) {
        let v: Vec<&FileRec> = map.values().collect();
        let tmp = self.root.join("files.json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(&v).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, self.root.join("files.json"));
        }
    }

    pub fn get(&self, id: &str, owner: &str) -> Option<FileRec> {
        let m = self.map.lock().unwrap();
        m.get(id).filter(|r| r.owner == owner).cloned()
    }

    pub fn list(&self, owner: &str) -> Vec<FileRec> {
        let m = self.map.lock().unwrap();
        let mut v: Vec<FileRec> = m.values().filter(|r| r.owner == owner).cloned().collect();
        v.sort_by_key(|r| r.created);
        v
    }

    pub fn insert(&self, r: FileRec) {
        let mut m = self.map.lock().unwrap();
        m.insert(r.id.clone(), r);
        self.save(&m);
    }

    pub fn remove(&self, id: &str, owner: &str) -> Option<FileRec> {
        let mut m = self.map.lock().unwrap();
        if m.get(id).map(|r| r.owner == owner) != Some(true) {
            return None;
        }
        let r = m.remove(id)?;
        if r.origin != FileOrigin::Pick {
            let _ = std::fs::remove_file(&r.path);
            if let Some(dir) = r.path.parent() {
                let _ = std::fs::remove_dir(dir); // only when empty
            }
        }
        self.save(&m);
        Some(r)
    }

    /// Bytes held in uploads and outputs (picks are the user's own files and do not count).
    pub fn used_bytes(&self) -> u64 {
        self.map.lock().unwrap().values().filter(|r| r.origin != FileOrigin::Pick).map(|r| r.size).sum()
    }

    /// The folder an upload goes to: a new group, or an existing group of the same owner.
    pub fn upload_dir(&self, owner: &str, group: Option<&str>) -> Result<(String, PathBuf), String> {
        let g = match group {
            Some(g) => {
                if !(g.len() == 24 && g.bytes().all(|b| b.is_ascii_hexdigit())) {
                    return Err("bad group id".into());
                }
                let m = self.map.lock().unwrap();
                if !m.values().any(|r| r.group == g && r.owner == owner && r.origin == FileOrigin::Upload) {
                    return Err("unknown group".into());
                }
                g.to_string()
            }
            None => crate::util::random_hex(12),
        };
        let d = self.root.join("files").join(&g);
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        Ok((g, d))
    }

    /// Paths of every file in the same upload group (the tool sees a .sid's .sdw/.aux.xml beside it).
    pub fn group_of(&self, id: &str) -> Vec<FileRec> {
        let m = self.map.lock().unwrap();
        let Some(r) = m.get(id) else { return vec![] };
        m.values().filter(|x| x.group == r.group).cloned().collect()
    }

    /// A picked file or folder: checked (no UNC, device or link paths), never copied.
    pub fn add_pick(&self, owner: &str, path: &Path) -> Result<FileRec, String> {
        let p = paths::check_user_path(path).map_err(|e| e.to_string())?;
        let md = std::fs::metadata(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string());
        let mut entries = vec![];
        if md.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                for e in rd.flatten().take(20000) {
                    if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                        entries.push(e.file_name().to_string_lossy().into_owned());
                    }
                }
            }
            entries.sort();
        }
        let r = FileRec { id: crate::util::random_hex(16), name, size: if md.is_dir() { 0 } else { md.len() }, origin: FileOrigin::Pick, owner: owner.into(), path: p, group: crate::util::random_hex(12), entries, is_dir: md.is_dir(), created: crate::util::unix_secs() };
        self.insert(r.clone());
        Ok(r)
    }

    /// Delete uploads and outputs older than `max_age_s` (picks are only forgotten).
    pub fn sweep(&self, max_age_s: u64) -> usize {
        let now = crate::util::unix_secs();
        let old: Vec<(String, String)> = self.map.lock().unwrap().values().filter(|r| now.saturating_sub(r.created) > max_age_s).map(|r| (r.id.clone(), r.owner.clone())).collect();
        for (id, owner) in &old {
            self.remove(id, owner);
        }
        old.len()
    }
}

/// Free bytes on the disk holding `p`.
pub fn free_space(p: &Path) -> u64 {
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        let w: Vec<u16> = p.as_os_str().encode_wide().chain([0]).collect();
        let mut free = 0u64;
        if windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(w.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) != 0 {
            return free;
        }
        0
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(p.as_os_str().as_bytes()) else { return 0 };
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } == 0 {
            return (st.f_bavail as u64).saturating_mul(st.f_frsize as u64);
        }
        0
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = p;
        u64::MAX / 4
    }
}

/// Does the start of a file look like a GDAL/OGR "pointer" format that can name other files or
/// URLs (VRT, WMS, tile indexes)? Such inputs are refused unless the profile builds its own.
pub fn is_pointer_file(path: &Path) -> bool {
    use std::io::Read;
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if ["vrt", "gti", "wms", "wmts"].contains(&ext.as_str()) {
        return true;
    }
    let mut head = vec![0u8; 8192];
    let n = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)).unwrap_or(0);
    let t = String::from_utf8_lossy(&head[..n]).to_ascii_lowercase();
    ["<vrtdataset", "<ogrvrtdatasource", "<gdal_wms", "<gdal_wmts", "<gdaltileindexdataset", "<wms_capabilities", "<wmt_ms_capabilities", "<capabilities", "derived_subdataset:", "/vsicurl", "/vsis3", "/vsigs", "/vsiaz", "/vsiadls", "/vsioss", "/vsiswift", "/vsiwebhdfs", "/vsihdfs", "<plmosaic"]
        .iter()
        .any(|m| t.contains(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pointer_files() {
        let d = std::env::temp_dir().join(format!("gwb-ptr-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.xml"), b"<VRTDataset rasterXSize='1'><SourceFilename>C:/secret.tif</SourceFilename></VRTDataset>").unwrap();
        std::fs::write(d.join("b.tif"), b"II*\0").unwrap();
        std::fs::write(d.join("c.csv"), b"x,y\n/vsicurl/http://evil/,1\n").unwrap();
        std::fs::write(d.join("d.vrt"), b"").unwrap();
        assert!(is_pointer_file(&d.join("a.xml")));
        assert!(!is_pointer_file(&d.join("b.tif")));
        assert!(is_pointer_file(&d.join("c.csv")));
        assert!(is_pointer_file(&d.join("d.vrt")));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn ownership() {
        let d = std::env::temp_dir().join(format!("gwb-files-{}", crate::util::random_hex(4)));
        let f = Files::open(&d);
        let (g, dir) = f.upload_dir("null", None).unwrap();
        std::fs::write(dir.join("x.bin"), b"abc").unwrap();
        f.insert(FileRec { id: "f1".into(), name: "x.bin".into(), size: 3, origin: FileOrigin::Upload, owner: "null".into(), path: dir.join("x.bin"), group: g.clone(), entries: vec![], is_dir: false, created: 0 });
        assert!(f.get("f1", "null").is_some());
        assert!(f.get("f1", "https://evil.example").is_none());
        assert!(f.upload_dir("https://evil.example", Some(&g)).is_err());
        assert!(f.remove("f1", "https://evil.example").is_none());
        assert_eq!(f.used_bytes(), 3);
        assert!(f.remove("f1", "null").is_some());
        assert!(!dir.join("x.bin").exists());
        std::fs::remove_dir_all(&d).ok();
    }
}
