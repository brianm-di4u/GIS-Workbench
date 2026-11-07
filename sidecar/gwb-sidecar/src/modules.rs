//! Optional modules (REQ-SDC-11) and how their tools are started: fixed relative paths inside
//! `<modules>/<id>/`, a fixed environment, and a PATH holding only the module folders and
//! System32. Every tool environment also blocks network access (REQ-SDC-14): proxies point at a
//! closed loopback port, GDAL/PROJ network features are off, and network-only drivers are skipped.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub struct ModuleDef {
    pub id: &'static str,
    pub title: &'static str,
    pub licence: &'static str,
    pub tools: &'static [(&'static str, &'static str)],
    /// Folders put on PATH, relative to the module folder (`../x` reaches a sibling module).
    pub path: &'static [&'static str],
    pub env: &'static [(&'static str, &'static str)],
    pub requires: &'static [&'static str],
    /// A closed vendor plug-in: GDAL drivers it adds to core-gdal.
    pub vendor_drivers: &'static [&'static str],
    pub vendor_source: &'static str,
}

// Module layouts: the Windows trees keep DLLs beside the programs in bin/; the Linux trees are
// conda-style prefixes (bin/, lib/, lib/gdalplugins) and python-build-standalone (bin/python3).
// Tool paths in MODULES have no extension; `program` adds the platform's.
#[cfg(windows)]
const PYTHON: &str = "python/python";
#[cfg(not(windows))]
const PYTHON: &str = "python/bin/python3";
#[cfg(windows)]
pub const GDAL_PLUGINS: &str = "gdalplugins";
#[cfg(not(windows))]
pub const GDAL_PLUGINS: &str = "lib/gdalplugins";
#[cfg(windows)]
const OSSIM_PLUGINS: &str = "plugins";
#[cfg(not(windows))]
const OSSIM_PLUGINS: &str = "lib/plugins";
#[cfg(windows)]
const LIB_DIR: &str = "bin";
#[cfg(not(windows))]
const LIB_DIR: &str = "lib";
#[cfg(windows)]
const SEP: &str = ";";
#[cfg(not(windows))]
const SEP: &str = ":";

/// A tool's program file inside its module folder.
pub fn program(module_dir: &Path, rel: &str) -> PathBuf {
    module_dir.join(format!("{rel}{}", std::env::consts::EXE_SUFFIX))
}

pub const MODULES: &[ModuleDef] = &[
    ModuleDef {
        id: "core-gdal",
        title: "Core GDAL",
        licence: "MIT (GDAL, PROJ); BSD/MIT/zlib/Apache-2.0 components; LGPL-2.1 GEOS and libiconv (dynamic, source offer)",
        tools: &[("gdal_translate", "bin/gdal_translate"), ("gdalinfo", "bin/gdalinfo"), ("ogrinfo", "bin/ogrinfo"), ("ogr2ogr", "bin/ogr2ogr"), ("gdaladdo", "bin/gdaladdo"), ("gdalbuildvrt", "bin/gdalbuildvrt"), ("gdalsrsinfo", "bin/gdalsrsinfo"), ("gdalwarp", "bin/gdalwarp"), ("gdal", "bin/gdal")],
        path: &["bin"],
        env: &[("GDAL_DATA", "share/gdal"), ("PROJ_DATA", "share/proj"), ("PROJ_LIB", "share/proj"), ("GDAL_DRIVER_PATH", GDAL_PLUGINS)],
        requires: &[],
        vendor_drivers: &[],
        vendor_source: "",
    },
    ModuleDef {
        id: "points",
        title: "Point cloud (PDAL)",
        licence: "BSD-3-Clause (PDAL); LGPL-3.0 nitro (dynamic, source offer)",
        tools: &[("pdal", "bin/pdal")],
        path: &["bin", "../core-gdal/bin"],
        env: &[("PDAL_DRIVER_PATH", LIB_DIR), ("GDAL_DATA", "../core-gdal/share/gdal"), ("PROJ_DATA", "../core-gdal/share/proj"), ("PROJ_LIB", "../core-gdal/share/proj")],
        requires: &["core-gdal"],
        vendor_drivers: &[],
        vendor_source: "",
    },
    ModuleDef {
        id: "media",
        title: "Media (FFmpeg, LGPL build)",
        licence: "LGPL-2.1-or-later FFmpeg shared libraries (no --enable-gpl, no OpenH264, no x264; source offer)",
        tools: &[("ffmpeg", "bin/ffmpeg"), ("ffprobe", "bin/ffprobe")],
        path: &["bin"],
        env: &[],
        requires: &[],
        vendor_drivers: &[],
        vendor_source: "",
    },
    ModuleDef {
        id: "sar",
        title: "Python runtime",
        licence: "PSF-2.0 (CPython); BSD-3-Clause numpy",
        tools: &[("python", PYTHON)],
        path: &["python"],
        env: &[("PYTHONNOUSERSITE", "1"), ("PYTHONDONTWRITEBYTECODE", "1"), ("PYTHONUTF8", "1")],
        requires: &[],
        vendor_drivers: &[],
        vendor_source: "",
    },
    // REQ-GAP-17: every PROJ grid. Data only, and large: a separate download.
    ModuleDef {
        id: "proj-grids",
        title: "PROJ grids (proj-data, full set)",
        licence: "Per grid: public domain, CC0, X/MIT, BSD, CC-BY and others (share/proj/*.README, proj-data-licences.json)",
        tools: &[],
        path: &[],
        env: &[],
        requires: &["core-gdal"],
        vendor_drivers: &[],
        vendor_source: "",
    },
    // REQ-GAP-36: Assimp's library, driven from sidecar/sar/mesh_export.py with the `sar` module's Python.
    ModuleDef {
        id: "model3d",
        title: "3D model export (Assimp, IfcOpenShell)",
        licence: "BSD-3-Clause (Assimp); LGPL-3.0-or-later (IfcOpenShell, dynamic, source offer); Zlib",
        tools: &[],
        path: &[],
        env: &[],
        requires: &["sar"],
        vendor_drivers: &[],
        vendor_source: "",
    },
    // REQ-GAP-21: OSSIM's rigorous models, sampled for an RPC (sidecar/ossim). The sources say both
    // MIT and LGPL, so it is treated as LGPL: dynamic, with a source offer.
    ModuleDef {
        id: "ossim",
        title: "Rigorous sensor models (OSSIM)",
        licence: "OSSIM: MIT in its LICENSE, LGPL in its file headers, treated as LGPL-2.1-or-later; CNES plug-in LGPL-2.1-or-later and LGPL-3.0-or-later files; GEOS LGPL-2.1 (all dynamic, source offer); libtiff, libgeotiff, libjpeg-turbo, zlib",
        tools: &[("gwb-ossim-model", "bin/gwb-ossim-model")],
        path: &["bin"],
        env: &[("GWB_OSSIM_PLUGINS", OSSIM_PLUGINS)],
        requires: &[],
        vendor_drivers: &[],
        vendor_source: "",
    },
    // REQ-GAP-29: COLMAP built without LSD, SiftGPU, CGAL, CHOLMOD or CUDA (sidecar/installer/sfm),
    // and gwb-sfm for the dense stage and the products. A separate download.
    ModuleDef {
        id: "sfm",
        title: "UAV structure from motion (COLMAP, gwb-sfm)",
        licence: "BSD-3-Clause (COLMAP, OpenBLAS, Ceres, PoseLib); Apache-2.0 (gwb-sfm, METIS); MIT (FAISS); MPL-2.0 (Eigen); others in NOTICES.txt",
        tools: &[("colmap", "bin/colmap"), ("gwb-sfm", "bin/gwb-sfm")],
        path: &["bin"],
        env: &[],
        requires: &[],
        vendor_drivers: &[],
        vendor_source: "",
    },
    ModuleDef {
        id: "vendor-mrsid",
        title: "MrSID decode plug-in (Extensis Decode SDK via OSGeo4W)",
        licence: "Proprietary: Extensis/LizardTech MrSID Decode SDK licence (accepted at install); GDAL plug-in MIT",
        tools: &[],
        path: &["bin"],
        env: &[],
        requires: &["core-gdal"],
        vendor_drivers: &["MrSID", "JP2MrSID"],
        vendor_source: "OSGeo4W package gdal-mrsid",
    },
    ModuleDef {
        id: "vendor-ecw",
        title: "ECW decode plug-in (Hexagon ECW JPEG 2000 SDK via OSGeo4W)",
        licence: "Proprietary: Hexagon ECW JPEG 2000 SDK read-only licence (accepted at install); GDAL plug-in MIT",
        tools: &[],
        path: &["bin"],
        env: &[],
        requires: &["core-gdal"],
        vendor_drivers: &["ECW", "JP2ECW"],
        vendor_source: "OSGeo4W package gdal-ecw",
    },
    // REQ-GAP-51: H.264 on Linux. The program ships in the Media module; the library it needs is
    // Cisco's binary, which only counts under Cisco's patent licence if it reaches the user's
    // device separately (BINARY_LICENSE.txt), so this module is made at install time and the title
    // is the text that licence wants wherever the user turns it on or off.
    #[cfg(not(windows))]
    ModuleDef {
        id: OPENH264,
        title: "OpenH264 Video Codec provided by Cisco Systems, Inc.",
        licence: "BSD-2-Clause; Cisco's binary, under the AVC/H.264 patent licence conditions of its BINARY_LICENSE.txt (accepted at install)",
        tools: &[("ffmpeg-h264", "../media/bin/ffmpeg-h264")],
        path: &["lib"],
        env: &[],
        requires: &["media"],
        vendor_drivers: &[],
        vendor_source: "ciscobinary.openh264.org",
    },
];

/// The module of Cisco's OpenH264 binary: a closed library, like a vendor plug-in, but no GDAL driver.
pub const OPENH264: &str = "vendor-openh264";

/// GDAL drivers that would reach the network; skipped in every tool run (defence in depth).
pub const GDAL_SKIP: &str = "WMS WMTS EEDA EEDAI PLMOSAIC DAAS OGCAPI NGW AMIGOCLOUD CARTO ELASTIC CSW WFS OAPIF GNMDatabase PLScenes STACIT STACTA HTTP";

pub fn def(id: &str) -> Option<&'static ModuleDef> {
    MODULES.iter().find(|m| m.id == id)
}

pub fn module_of_tool(tool: &str) -> Option<&'static ModuleDef> {
    MODULES.iter().find(|m| m.tools.iter().any(|(t, _)| *t == tool))
}

pub fn dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

pub fn installed(root: &Path, m: &ModuleDef) -> bool {
    let d = dir(root, m.id);
    if !d.is_dir() {
        return false;
    }
    if m.vendor_drivers.is_empty() {
        m.tools.iter().all(|(_, rel)| program(&d, rel).is_file()) && (m.id != OPENH264 || licence_accepted(root, m))
    } else {
        d.join(GDAL_PLUGINS).is_dir() && licence_accepted(root, m)
    }
}

pub fn licence_accepted(root: &Path, m: &ModuleDef) -> bool {
    dir(root, m.id).join("ACCEPTED.json").is_file()
}

pub fn version_of(root: &Path, m: &ModuleDef) -> Option<String> {
    let t = std::fs::read_to_string(dir(root, m.id).join("MANIFEST.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&t).ok()?;
    v.get("version").and_then(|x| x.as_str()).map(String::from)
}

pub fn size_of(root: &Path, m: &ModuleDef) -> u64 {
    fn walk(p: &Path) -> u64 {
        let Ok(rd) = std::fs::read_dir(p) else { return 0 };
        rd.flatten()
            .map(|e| match e.file_type() {
                Ok(t) if t.is_dir() => walk(&e.path()),
                Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
                _ => 0,
            })
            .sum()
    }
    walk(&dir(root, m.id))
}

/// Program path, PATH entries and environment for one tool, or why it cannot run.
pub struct ToolEnv {
    pub program: PathBuf,
    pub env: BTreeMap<String, String>,
    pub module: &'static str,
}

pub fn tool_env(root: &Path, tool: &str, tmp: &Path) -> Result<ToolEnv, String> {
    let m = module_of_tool(tool).ok_or_else(|| format!("no module provides {tool}"))?;
    if !installed(root, m) {
        return Err(format!("the {} module is not installed", m.title));
    }
    for r in m.requires {
        let rd = def(r).expect("module");
        if !installed(root, rd) {
            return Err(format!("{} needs the {} module", m.title, rd.title));
        }
    }
    let d = dir(root, m.id);
    let rel = m.tools.iter().find(|(t, _)| *t == tool).map(|(_, r)| *r).unwrap_or("");
    let program = program(&d, rel);
    let mut path: Vec<PathBuf> = m.path.iter().map(|p| d.join(p)).collect();
    // Linux: the shared libraries sit in lib/ beside each bin/ (points also loads core-gdal's).
    #[cfg(not(windows))]
    let mut libs: Vec<PathBuf> = m.path.iter().map(|p| d.join(p.replace("bin", "lib"))).collect();
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    for (k, v) in m.env {
        env.insert(k.to_string(), d.join(v).display().to_string());
    }
    for (k, v) in [("PYTHONNOUSERSITE", "1"), ("PYTHONDONTWRITEBYTECODE", "1"), ("PYTHONUTF8", "1")] {
        if m.id == "sar" {
            env.insert(k.into(), v.into());
        }
    }
    // The full grid set joins PROJ's search path (core-gdal and PDAL tools): PROJ looks in each
    // folder in turn, so the core folder's proj.db stays the one in use.
    if (m.id == "core-gdal" || m.id == "points") && def("proj-grids").is_some_and(|g| installed(root, g)) {
        let core = dir(root, "core-gdal").join("share").join("proj");
        let grids = dir(root, "proj-grids").join("share").join("proj");
        let v = format!("{}{SEP}{}", core.display(), grids.display());
        env.insert("PROJ_DATA".into(), v.clone());
        env.insert("PROJ_LIB".into(), v);
    }
    // Vendor plug-ins join GDAL's driver path and DLL search path (core-gdal and PDAL tools).
    if m.id == "core-gdal" || m.id == "points" {
        let mut drivers = vec![dir(root, "core-gdal").join(GDAL_PLUGINS).display().to_string()];
        for v in MODULES.iter().filter(|x| !x.vendor_drivers.is_empty()) {
            if installed(root, v) {
                drivers.push(dir(root, v.id).join(GDAL_PLUGINS).display().to_string());
                path.push(dir(root, v.id).join("bin"));
                #[cfg(not(windows))]
                libs.push(dir(root, v.id).join("lib"));
            }
        }
        env.insert("GDAL_DRIVER_PATH".into(), drivers.join(SEP));
    }
    #[cfg(windows)]
    {
        let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        path.push(PathBuf::from(&sysroot).join("System32"));
        env.insert("SystemRoot".into(), sysroot.clone());
        env.insert("windir".into(), sysroot);
    }
    #[cfg(not(windows))]
    {
        path.extend([PathBuf::from("/usr/bin"), PathBuf::from("/bin")]);
        if m.id == "points" {
            libs.push(dir(root, "core-gdal").join("lib"));
        }
        env.insert("LD_LIBRARY_PATH".into(), libs.iter().map(|p| normalise(p)).collect::<Vec<_>>().join(SEP));
        env.insert("LANG".into(), "C.UTF-8".into());
        // Fewer malloc arenas: each reserves address space, which RLIMIT_AS counts (winjob.rs).
        env.insert("MALLOC_ARENA_MAX".into(), "2".into());
    }
    env.insert("PATH".into(), path.iter().map(|p| normalise(p)).collect::<Vec<_>>().join(SEP));
    let t = tmp.display().to_string();
    for k in ["TEMP", "TMP", "TMPDIR", "CPL_TMPDIR"] {
        env.insert(k.into(), t.clone());
    }
    // A private profile in the job folder: some libraries fail fast without USERPROFILE (PDAL's
    // plug-ins exit 0xC0000409), and no tool reads or writes the user's real settings or caches.
    let home = tmp.join("home");
    let _ = std::fs::create_dir_all(home.join("AppData").join("Roaming"));
    let _ = std::fs::create_dir_all(home.join("AppData").join("Local"));
    env.insert("USERPROFILE".into(), home.display().to_string());
    env.insert("HOME".into(), home.display().to_string());
    env.insert("APPDATA".into(), home.join("AppData").join("Roaming").display().to_string());
    env.insert("LOCALAPPDATA".into(), home.join("AppData").join("Local").display().to_string());
    for k in ["NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "SystemDrive"] {
        if let Ok(v) = std::env::var(k) {
            env.insert(k.into(), v);
        }
    }
    // No network from any tool (REQ-SDC-14): curl and GDAL go through a proxy that does not exist.
    for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
        env.insert(k.into(), "http://127.0.0.1:9".into());
    }
    env.insert("NO_PROXY".into(), String::new());
    env.insert("GDAL_HTTP_PROXY".into(), "127.0.0.1:9".into());
    env.insert("CPL_VSIL_CURL_ALLOWED_EXTENSIONS".into(), ".gwb-no-network".into());
    env.insert("GDAL_HTTP_TIMEOUT".into(), "1".into());
    env.insert("PROJ_NETWORK".into(), "OFF".into());
    env.insert("GDAL_SKIP".into(), GDAL_SKIP.into());
    env.insert("GDAL_VRT_ENABLE_PYTHON".into(), "NO".into());
    env.insert("GDAL_VRT_ENABLE_RAWRASTERBAND".into(), "NO".into());
    env.insert("GDAL_ENABLE_DEPRECATED_DRIVER_ALL".into(), "NO".into());
    env.insert("GDAL_CACHEMAX".into(), "1024".into());
    env.insert("GDAL_NUM_THREADS".into(), "ALL_CPUS".into());
    env.insert("OGR_SQLITE_PRAGMA".into(), "trusted_schema=OFF".into());
    env.insert("CPL_LOG_ERRORS".into(), "ON".into());
    env.insert("PDAL_NO_NETWORK".into(), "1".into());
    // libpq asks Kerberos for a ticket on every connection; the bundled krb5 then calls into a
    // credentials-cache library that is not shipped, and the tool dies with an access violation.
    env.insert("PGGSSENCMODE".into(), "disable".into());
    Ok(ToolEnv { program, env, module: m.id })
}

fn normalise(p: &Path) -> String {
    // Resolve `..` lexically so PATH holds plain folders.
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out.display().to_string()
}
