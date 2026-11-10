//! Capabilities (REQ-SDC-05): tool versions, GDAL/OGR drivers with read/write flags and creation
//! options, PDAL readers/writers, FFmpeg codecs, modules and vendor SDK licence state — all asked
//! of the installed tools, never hard-coded.

use crate::modules::{self, MODULES};
use crate::profiles::DriverInfo;
use crate::runner;
use gwb_sidecar_api::{CreationOption, Driver, ModuleInfo, ToolInfo, VendorSdk};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Vendor formats are read-only here: no proprietary writer is offered (OD-2.7).
pub const NO_WRITE: [&str; 4] = ["MrSID", "JP2MrSID", "ECW", "JP2ECW"];

#[derive(Default, Clone)]
pub struct Snapshot {
    pub tools: Vec<ToolInfo>,
    pub raster: Vec<Driver>,
    pub vector: Vec<Driver>,
    pub pdal_readers: Vec<String>,
    pub pdal_writers: Vec<String>,
    pub ffmpeg_encoders: Vec<String>,
    pub ffmpeg_decoders: Vec<String>,
    pub errors: Vec<String>,
}

pub struct Caps {
    modules_dir: PathBuf,
    tmp: PathBuf,
    pub snap: Mutex<Snapshot>,
    co_cache: Mutex<HashMap<(String, String), Vec<CreationOption>>>,
    /// Bytes per module, measured at refresh: walking 10 000 files on every `/v1/caps` blocked a
    /// worker thread for minutes on a busy disk.
    sizes: Mutex<HashMap<&'static str, u64>>,
    pub refresh_lock: tokio::sync::Mutex<()>,
}

impl Caps {
    pub fn new(modules_dir: PathBuf, tmp: PathBuf) -> Caps {
        Caps { modules_dir, tmp, snap: Mutex::new(Snapshot::default()), co_cache: Mutex::new(HashMap::new()), sizes: Mutex::new(HashMap::new()), refresh_lock: tokio::sync::Mutex::new(()) }
    }

    pub fn modules(&self) -> Vec<ModuleInfo> {
        MODULES
            .iter()
            .map(|m| {
                let inst = modules::installed(&self.modules_dir, m);
                ModuleInfo { id: m.id.into(), title: m.title.into(), installed: inst, version: modules::version_of(&self.modules_dir, m), licence: m.licence.into(), size: if inst { self.sizes.lock().unwrap().get(m.id).copied().unwrap_or(0) } else { 0 } }
            })
            .collect()
    }

    pub fn vendor(&self) -> Vec<VendorSdk> {
        let snap = self.snap.lock().unwrap();
        MODULES
            .iter()
            .filter(|m| !m.vendor_drivers.is_empty() || m.id == modules::OPENH264)
            .map(|m| {
                let plugin = !m.vendor_drivers.is_empty();
                let installed = if plugin { modules::dir(&self.modules_dir, m.id).join(modules::GDAL_PLUGINS).is_dir() && m.vendor_drivers.iter().all(|d| snap.raster.iter().any(|r| r.name == *d)) } else { modules::installed(&self.modules_dir, m) };
                VendorSdk {
                    id: m.id.into(),
                    name: m.title.into(),
                    drivers: m.vendor_drivers.iter().map(|s| s.to_string()).collect(),
                    installed,
                    licence_accepted: modules::licence_accepted(&self.modules_dir, m),
                    // The plug-ins come from OSGeo4W, which is Windows only (P16); on Linux only a
                    // build made under the vendor's own terms can fill the module (setup --from).
                    source: if cfg!(windows) || installed || !plugin { m.vendor_source.into() } else { format!("{} (Windows only)", m.vendor_source) },
                }
            })
            .collect()
    }

    pub fn installed(&self, id: &str) -> bool {
        modules::def(id).map(|m| modules::installed(&self.modules_dir, m)).unwrap_or(false)
    }

    pub fn tool_available(&self, tool: &str) -> bool {
        modules::module_of_tool(tool).map(|m| modules::installed(&self.modules_dir, m)).unwrap_or(false)
    }

    /// Ask every installed tool what it can do. Errors are kept and reported, not fatal.
    pub async fn refresh(&self) {
        let _g = self.refresh_lock.lock().await;
        let d = &self.modules_dir;
        let tmp = self.tmp.join("caps");
        let _ = crate::winjob::create_low_dir(&tmp); // tools run at Low integrity (winjob.rs)
        let mut s = Snapshot::default();
fn tool(tools: &mut Vec<ToolInfo>, name: &str, module: &str, v: Result<String, String>, errors: &mut Vec<String>) {
            match v {
                Ok(v) => tools.push(ToolInfo { name: name.into(), module: module.into(), version: v.lines().next().unwrap_or("").trim().to_string() }),
                Err(e) => errors.push(e),
            }
        }
        let mut errors = Vec::new();
        if self.installed("core-gdal") {
            tool(&mut s.tools, "gdal", "core-gdal", runner::query(d, "gdalinfo", &["--version"], &tmp).await, &mut errors);
            match runner::query(d, "gdalinfo", &["--formats"], &tmp).await {
                Ok(t) => s.raster = parse_formats(&t).into_iter().filter(|x| x.raster).collect(),
                Err(e) => errors.push(e),
            }
            match runner::query(d, "ogrinfo", &["--formats"], &tmp).await {
                Ok(t) => s.vector = parse_formats(&t).into_iter().filter(|x| x.vector).collect(),
                Err(e) => errors.push(e),
            }
        }
        if self.installed("points") {
            tool(&mut s.tools, "pdal", "points", runner::query(d, "pdal", &["--version"], &tmp).await.map(|v| v.lines().find(|l| l.contains("pdal")).unwrap_or(&v).trim().to_string()), &mut errors);
            match runner::query(d, "pdal", &["--drivers", "--showjson"], &tmp).await {
                Ok(t) => {
                    let (r, w) = parse_pdal_drivers(&t);
                    s.pdal_readers = r;
                    s.pdal_writers = w;
                }
                Err(e) => errors.push(e),
            }
        }
        if self.installed("media") {
            tool(&mut s.tools, "ffmpeg", "media", runner::query(d, "ffmpeg", &["-hide_banner", "-version"], &tmp).await, &mut errors);
            match runner::query(d, "ffmpeg", &["-hide_banner", "-encoders"], &tmp).await {
                Ok(t) => s.ffmpeg_encoders = parse_ffmpeg_codecs(&t),
                Err(e) => errors.push(e),
            }
            match runner::query(d, "ffmpeg", &["-hide_banner", "-decoders"], &tmp).await {
                Ok(t) => s.ffmpeg_decoders = parse_ffmpeg_codecs(&t),
                Err(e) => errors.push(e),
            }
        }
        // Asked as the job will run it: a library that does not load shows here, not in a job.
        if self.installed(modules::OPENH264) {
            tool(&mut s.tools, "ffmpeg-h264", modules::OPENH264, runner::query(d, "ffmpeg-h264", &["-hide_banner", "-version"], &tmp).await, &mut errors);
        }
        if self.installed("sar") {
            tool(&mut s.tools, "python", "sar", runner::query(d, "python", &["-I", "-c", "import sys, numpy; print('Python', sys.version.split()[0], 'numpy', numpy.__version__)"], &tmp).await, &mut errors);
        }
        if self.installed("ossim") {
            tool(&mut s.tools, "gwb-ossim-model", "ossim", runner::query(d, "gwb-ossim-model", &["version"], &tmp).await, &mut errors);
        }
        // REQ-GAP-29: COLMAP prints its version first in its help.
        if self.installed("sfm") {
            tool(&mut s.tools, "colmap", "sfm", runner::query(d, "colmap", &["-h"], &tmp).await, &mut errors);
        }
        s.errors = errors;
        let root = d.clone();
        let sizes = tokio::task::spawn_blocking(move || MODULES.iter().map(|m| (m.id, modules::size_of(&root, m))).collect::<HashMap<_, _>>()).await.unwrap_or_default();
        *self.sizes.lock().unwrap() = sizes;
        *self.snap.lock().unwrap() = s;
        self.co_cache.lock().unwrap().clear();
    }

    /// Creation options of a writable driver (asked once, then cached).
    pub async fn ensure_creation_options(&self, driver: &str, flag: &str) -> Result<Vec<CreationOption>, String> {
        let key = (driver.to_string(), flag.to_string());
        if let Some(v) = self.co_cache.lock().unwrap().get(&key) {
            return Ok(v.clone());
        }
        let (raster, vector) = {
            let s = self.snap.lock().unwrap();
            (s.raster.iter().any(|d| d.name == driver && d.write), s.vector.iter().any(|d| d.name == driver && d.write))
        };
        if !raster && !vector {
            return Err(format!("{driver} is not a writer of the sidecar's GDAL"));
        }
        let tool = if flag == "-co" || !vector { "gdalinfo" } else { "ogrinfo" };
        let text = runner::query(&self.modules_dir, tool, &["--format", driver], &self.tmp.join("caps")).await?;
        let tag = match flag {
            "-lco" => "LayerCreationOptionList",
            _ => "CreationOptionList",
        };
        let opts = parse_creation_options(&text, tag);
        self.co_cache.lock().unwrap().insert(key, opts.clone());
        Ok(opts)
    }

    /// A writer of either kind (creation options are asked of GDAL before a job is checked).
    pub fn raster_writer_any(&self, name: &str) -> bool {
        let s = self.snap.lock().unwrap();
        s.raster.iter().chain(s.vector.iter()).any(|d| d.name == name && d.write)
    }

    pub fn driver(&self, name: &str) -> Option<Driver> {
        let s = self.snap.lock().unwrap();
        s.raster.iter().chain(s.vector.iter()).find(|d| d.name == name).cloned()
    }
}

impl DriverInfo for Caps {
    fn raster_writer(&self, name: &str) -> bool {
        self.snap.lock().unwrap().raster.iter().any(|d| d.name == name && d.write)
    }
    fn vector_writer(&self, name: &str) -> bool {
        self.snap.lock().unwrap().vector.iter().any(|d| d.name == name && d.write)
    }
    fn creation_options(&self, driver: &str, flag: &str) -> Option<Vec<CreationOption>> {
        self.co_cache.lock().unwrap().get(&(driver.to_string(), flag.to_string())).cloned()
    }
}

/// `gdalinfo --formats` / `ogrinfo --formats` lines:
/// `  GTiff -raster- (rw+uvs): GeoTIFF (*.tif, *.tiff)`.
pub fn parse_formats(text: &str) -> Vec<Driver> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        let Some(dash) = l.find(" -") else { continue };
        let name = l[..dash].trim();
        let rest = &l[dash + 2..];
        let Some(kinds_end) = rest.find("- (") else { continue };
        let kinds = &rest[..kinds_end];
        let rest = &rest[kinds_end + 3..];
        let Some(fl_end) = rest.find("):") else { continue };
        let flags = &rest[..fl_end];
        let desc = rest[fl_end + 2..].trim();
        let (long, exts) = match desc.rfind(" (*.") {
            Some(i) if desc.ends_with(')') => (desc[..i].trim(), desc[i + 2..desc.len() - 1].split(',').map(|e| e.trim().trim_start_matches("*.").to_ascii_lowercase()).filter(|e| !e.is_empty()).collect()),
            _ => (desc, vec![]),
        };
        let write = (flags.contains('w') || flags.contains('+')) && !NO_WRITE.contains(&name);
        out.push(Driver { name: name.into(), long_name: long.into(), raster: kinds.contains("raster"), vector: kinds.contains("vector"), read: flags.contains('r'), write, extensions: exts });
    }
    out
}

/// `pdal --drivers --showjson`: `[{"name":"readers.las","description":...}, ...]`.
pub fn parse_pdal_drivers(text: &str) -> (Vec<String>, Vec<String>) {
    let v: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or(serde_json::Value::Null);
    let mut r = Vec::new();
    let mut w = Vec::new();
    if let Some(a) = v.as_array() {
        for d in a {
            if let Some(n) = d.get("name").and_then(|x| x.as_str()) {
                if n.starts_with("readers.") {
                    r.push(n.to_string());
                } else if n.starts_with("writers.") {
                    w.push(n.to_string());
                }
            }
        }
    }
    (r, w)
}

/// `ffmpeg -encoders`: lines ` V....D h264_mf   H264 via MediaFoundation`.
pub fn parse_ffmpeg_codecs(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut started = false;
    for line in text.lines() {
        if line.trim_start().starts_with("------") {
            started = true;
            continue;
        }
        if !started {
            continue;
        }
        let mut it = line.split_whitespace();
        let (Some(flags), Some(name)) = (it.next(), it.next()) else { continue };
        if flags.len() == 6 && name != "=" {
            out.push(name.to_string());
        }
    }
    out
}

/// The `<CreationOptionList>` (or `<LayerCreationOptionList>`) in `gdalinfo --format X` output.
pub fn parse_creation_options(text: &str, tag: &str) -> Vec<CreationOption> {
    use quick_xml::events::Event;
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let Some(a) = text.find(&open) else { return vec![] };
    let Some(b) = text[a..].find(&close) else { return vec![] };
    let xml = &text[a..a + b + close.len()];
    let mut r = quick_xml::Reader::from_str(xml);
    let mut out: Vec<CreationOption> = Vec::new();
    let mut in_value = false;
    let mut depth_option = false;
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.name().as_ref() == "Option" => {
                let mut o = CreationOption { name: String::new(), kind: "string".into(), values: vec![], default: None, description: None, min: None, max: None };
                for at in e.attributes().flatten() {
                    let v = at.normalized_value(quick_xml::XmlVersion::Implicit1_0).map(|c| c.into_owned()).unwrap_or_default();
                    match at.key.as_ref() {
                        "name" => o.name = v,
                        "type" => o.kind = v,
                        "default" => o.default = Some(v),
                        "description" => o.description = Some(v),
                        "min" => o.min = v.parse().ok(),
                        "max" => o.max = v.parse().ok(),
                        _ => {}
                    }
                }
                depth_option = true;
                out.push(o);
            }
            Ok(Event::End(e)) if e.name().as_ref() == "Option" => depth_option = false,
            Ok(Event::Start(e)) if e.name().as_ref() == "Value" => in_value = depth_option,
            Ok(Event::End(e)) if e.name().as_ref() == "Value" => in_value = false,
            Ok(Event::Text(t)) if in_value => {
                if let Some(o) = out.last_mut() {
                    let v = t.xml_content(quick_xml::XmlVersion::Implicit1_0);
                    o.values.push(v.trim().to_string());
                }
            }
            // Entities in a value arrive as their own events (quick-xml >= 0.38).
            Ok(Event::GeneralRef(r)) if in_value => {
                let ch = match r.as_ref() {
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    "quot" => "\"",
                    "apos" => "'",
                    _ => "",
                };
                if let Some(o) = out.last_mut() {
                    match o.values.last_mut() {
                        Some(last) => last.push_str(ch),
                        None => o.values.push(ch.to_string()),
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out.retain(|o| !o.name.is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats() {
        let t = "Supported Formats: (ro:read-only, rw:read-write, +:write from scratch)\n  GTiff -raster- (rw+uvs): GeoTIFF (*.tif, *.tiff)\n  COG -raster- (w+v): Cloud optimized GeoTIFF generator (*.tif, *.tiff)\n  MrSID -raster- (rov): Multi-resolution Seamless Image Database (MrSID) (*.sid)\n  ECW -raster- (rw+u): ERDAS Compressed Wavelets (SDK 5.5) (*.ecw)\n  ESRI Shapefile -vector- (rw+uv): ESRI Shapefile (*.shp, *.dbf, *.shz, *.shp.zip)\n  OpenFileGDB -raster,vector- (rw+uv): ESRI FileGeodatabase (using OpenFileGDB) (*.gdb)\n";
        let d = parse_formats(t);
        assert_eq!(d.len(), 6);
        assert!(d[0].write && d[0].read && d[0].extensions == vec!["tif", "tiff"]);
        assert!(d[1].write && !d[1].read);
        assert!(!d[2].write && d[2].read && d[2].long_name == "Multi-resolution Seamless Image Database (MrSID)");
        assert!(!d[3].write, "ECW must never be offered as a writer");
        assert_eq!(d[4].name, "ESRI Shapefile");
        assert!(d[5].raster && d[5].vector);
    }

    #[test]
    fn creation_option_xml() {
        let t = r#"Format Details:
  Short Name: GTiff
<CreationOptionList>   <Option name='COMPRESS' type='string-select' default='NONE'>       <Value>NONE</Value>       <Value>LZW</Value>   </Option>   <Option name='ZLEVEL' type='int' description='DEFLATE level' min='1' max='12'/>   <Option name='PROFILE' type='string-select'><Value>GDALGeoTIFF</Value></Option></CreationOptionList>
<LayerCreationOptionList><Option name='FID' type='string'/></LayerCreationOptionList>"#;
        let o = parse_creation_options(t, "CreationOptionList");
        assert_eq!(o.len(), 3);
        assert_eq!(o[0].values, vec!["NONE", "LZW"]);
        assert_eq!(o[1].max, Some(12.0));
        let l = parse_creation_options(t, "LayerCreationOptionList");
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].name, "FID");
    }

    #[test]
    fn creation_option_entities() {
        let t = "<CreationOptionList><Option name='SEP' type='string-select' description='a &amp; b'><Value>&amp;</Value><Value>TAB</Value></Option></CreationOptionList>";
        let o = parse_creation_options(t, "CreationOptionList");
        assert_eq!(o[0].description.as_deref(), Some("a & b"));
        assert_eq!(o[0].values, vec!["&", "TAB"]);
    }

    #[test]
    fn codecs() {
        let t = "Encoders:\n V..... = Video\n ------\n V....D h264_mf              H264 via MediaFoundation (codec h264)\n V....D libopenh264          OpenH264 H.264\n A....D aac                  AAC\n";
        assert_eq!(parse_ffmpeg_codecs(t), vec!["h264_mf", "libopenh264", "aac"]);
    }
}
