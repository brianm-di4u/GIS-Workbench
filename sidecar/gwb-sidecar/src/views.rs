//! Viewing MrSID and ECW without converting (REQ-GAP-70, SDP-2.3 GR-25). A view is a BigTIFF that
//! does not exist on disk: its header is built in memory and every tile is decoded when a range
//! asks for it, so the app opens it by range like any Cloud-Optimized GeoTIFF, with its overviews,
//! geokeys and no-data, and every reader of the app works on it unchanged.
//!
//! The decoder is the bundled `gdal_translate` with the vendor plug-in, run like a job step (fixed
//! arguments, the module's environment, a Job Object at Low integrity, wall and CPU limits), once
//! per metatile of `META` × `META` tiles: opening a large MrSID costs far more than decoding
//! (Hamilton County 11 GB: 1.8 s to open, 0.6 s for 2048² pixels), and a viewport's tiles are
//! neighbours. A crafted file can only hurt that one process. Metatiles are held in a small LRU
//! shared by all views; dropping a request (the client went away) kills its tool run.
//!
//! Tile data sits on 64 KiB boundaries, geotiff.js's read blocks, so a tile read never touches a
//! neighbour's metatile.

use crate::files::{is_pointer_file, FileRec};
use crate::runner::{self, Progress, RunSpec, Sink};
use crate::service::Service;
use crate::util;
use crate::winjob::JobLimits;
use gwb_sidecar_api::{FileOrigin, ViewInfo};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{OnceCell, Semaphore};
use tokio_util::sync::CancellationToken;

/// Tile side, as the app's own COGs (features/convert.js).
pub const TILE: u32 = 512;
/// Tiles per metatile side.
pub const META: u32 = 4;
/// geotiff.js reads in blocks of this size.
const ALIGN: u64 = 65536;
/// The drivers a view may be opened for. Anything else opens in the app or is converted.
pub const VIEW_DRIVERS: [&str; 2] = ["MrSID", "ECW"];
/// Largest range one request may ask for.
pub const MAX_RANGE: u64 = 64 << 20;
/// Largest image: the header holds 12 bytes per tile.
const MAX_TILES: u64 = 1 << 22;
const MAX_VIEWS_PER_OWNER: usize = 16;
/// Metatiles held in memory, over all views.
const CACHE_BYTES: u64 = 256 << 20;
/// Largest GeoTIFF the template step may write (one pixel and its tags).
const MAX_TEMPLATE: u64 = 4 << 20;

/// A failed view request: HTTP status, error code, message.
pub type ViewError = (u16, &'static str, String);

// ---------------------------------------------------------------- the template's tags

/// One TIFF tag: its type, its count and its value bytes (little-endian).
#[derive(Debug, Clone, PartialEq)]
pub struct Tag {
    pub id: u16,
    pub typ: u16,
    pub count: u64,
    pub data: Vec<u8>,
}

fn type_size(t: u16) -> Option<u64> {
    match t {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 | 13 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

/// The tags of the first IFD of a little-endian classic TIFF. Only ever fed GDAL's own one-pixel
/// output, but that file comes from a tool that read an untrusted input, so every length and
/// offset is checked; anything else is refused.
pub fn read_tags(b: &[u8]) -> Result<Vec<Tag>, String> {
    let u16at = |o: usize| -> Option<u16> { Some(u16::from_le_bytes(b.get(o..o.checked_add(2)?)?.try_into().ok()?)) };
    let u32at = |o: usize| -> Option<u32> { Some(u32::from_le_bytes(b.get(o..o.checked_add(4)?)?.try_into().ok()?)) };
    if b.get(..2) != Some(b"II") || u16at(2) != Some(42) {
        return Err("not a little-endian classic TIFF".into());
    }
    let ifd = u32at(4).ok_or("truncated header")? as usize;
    let n = u16at(ifd).ok_or("truncated IFD")? as usize;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let e = ifd + 2 + i * 12;
        let (id, typ, count) = (u16at(e).ok_or("truncated IFD")?, u16at(e + 2).ok_or("truncated IFD")?, u32at(e + 4).ok_or("truncated IFD")? as u64);
        // A tag of a type this reader does not know cannot be one it copies.
        let Some(size) = type_size(typ) else { continue };
        let len = count * size;
        if len > MAX_TEMPLATE {
            return Err(format!("tag {id} is impossibly long"));
        }
        let at = if len <= 4 { e + 8 } else { u32at(e + 8).ok_or("truncated IFD")? as usize };
        let end = at.checked_add(len as usize).ok_or("bad offset")?;
        let data = b.get(at..end).ok_or_else(|| format!("tag {id} runs past the end of the file"))?.to_vec();
        out.push(Tag { id, typ, count, data });
    }
    Ok(out)
}

/// The tags a view takes from the template: how the samples are read, and everything geographic.
const COPIED: [u16; 10] = [262, 338, 33550, 33922, 34264, 34735, 34736, 34737, 42112, 42113];

// ---------------------------------------------------------------- the layout

#[derive(Debug, Clone, PartialEq)]
pub struct Level {
    pub width: u32,
    pub height: u32,
    pub tiles_x: u32,
    pub tiles_y: u32,
    /// File offset of this level's first tile.
    pub first: u64,
}

/// Where a file offset falls.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Place {
    /// In the header, or the padding after it (`.0` is the offset, `.1` the end of this stretch).
    Header(u64, u64),
    /// In tile `(level, x, y)`, `at` bytes in; or in the padding after it when `at >= tile_bytes`.
    Tile { level: usize, x: u32, y: u32, at: u64 },
    Past,
}

#[derive(Debug)]
pub struct Layout {
    pub width: u32,
    pub height: u32,
    pub bands: u32,
    pub sample_bytes: u32,
    pub levels: Vec<Level>,
    pub tile_bytes: u64,
    pub stride: u64,
    pub header: Vec<u8>,
    pub data_start: u64,
    pub size: u64,
}

fn align(v: u64, a: u64) -> u64 {
    v.div_ceil(a) * a
}

struct Entry {
    tag: u16,
    typ: u16,
    count: u64,
    data: Vec<u8>,
}

fn shorts(tag: u16, v: &[u16]) -> Entry {
    Entry { tag, typ: 3, count: v.len() as u64, data: v.iter().flat_map(|x| x.to_le_bytes()).collect() }
}

fn long(tag: u16, v: u32) -> Entry {
    Entry { tag, typ: 4, count: 1, data: v.to_le_bytes().to_vec() }
}

/// Bytes an IFD takes with its out-of-line values.
fn ifd_size(e: &[Entry]) -> u64 {
    align(8 + e.len() as u64 * 20 + 8, 8) + e.iter().filter(|x| x.data.len() > 8).map(|x| align(x.data.len() as u64, 8)).sum::<u64>()
}

fn write_ifd(out: &mut Vec<u8>, mut e: Vec<Entry>, next: u64) {
    e.sort_by_key(|x| x.tag);
    let start = out.len() as u64;
    let mut blob = align(start + 8 + e.len() as u64 * 20 + 8, 8);
    out.extend_from_slice(&(e.len() as u64).to_le_bytes());
    for x in &e {
        out.extend_from_slice(&x.tag.to_le_bytes());
        out.extend_from_slice(&x.typ.to_le_bytes());
        out.extend_from_slice(&x.count.to_le_bytes());
        if x.data.len() <= 8 {
            let mut v = x.data.clone();
            v.resize(8, 0);
            out.extend_from_slice(&v);
        } else {
            out.extend_from_slice(&blob.to_le_bytes());
            blob += align(x.data.len() as u64, 8);
        }
    }
    out.extend_from_slice(&next.to_le_bytes());
    out.resize(align(out.len() as u64, 8) as usize, 0);
    for x in e.iter().filter(|x| x.data.len() > 8) {
        out.extend_from_slice(&x.data);
        out.resize(align(out.len() as u64, 8) as usize, 0);
    }
}

impl Layout {
    /// `sample_format`: TIFF SampleFormat (1 unsigned, 2 signed, 3 float). `template`: tags of a
    /// GDAL GeoTIFF of the same image's first pixel, which carries its georeferencing unchanged.
    pub fn new(width: u32, height: u32, bands: u32, sample_bytes: u32, sample_format: u16, template: &[Tag]) -> Result<Layout, String> {
        if width == 0 || height == 0 || bands == 0 || bands > 64 || ![1, 2, 4].contains(&sample_bytes) {
            return Err(format!("{width} × {height} × {bands} × {sample_bytes} bytes is not an image a view can hold"));
        }
        let (w, h) = (width as u64, height as u64);
        let mut levels = Vec::new();
        let mut tiles = 0u64;
        for k in 0..32 {
            let (lw, lh) = (w.div_ceil(1 << k), h.div_ceil(1 << k));
            let (tx, ty) = (lw.div_ceil(TILE as u64), lh.div_ceil(TILE as u64));
            tiles += tx * ty;
            levels.push(Level { width: lw as u32, height: lh as u32, tiles_x: tx as u32, tiles_y: ty as u32, first: 0 });
            if lw <= TILE as u64 && lh <= TILE as u64 {
                break;
            }
        }
        if tiles > MAX_TILES {
            return Err(format!("{width} × {height} needs {tiles} tiles; a view holds at most {MAX_TILES}"));
        }
        let tile_bytes = (TILE as u64).pow(2) * bands as u64 * sample_bytes as u64;
        let stride = align(tile_bytes, ALIGN);
        let copied: Vec<Tag> = template.iter().filter(|t| COPIED.contains(&t.id)).cloned().collect();
        let entries = |lv: &Level, full: bool, offsets: Vec<u8>, counts: Vec<u8>, n: u64| -> Vec<Entry> {
            let mut e = vec![
                long(256, lv.width),
                long(257, lv.height),
                shorts(258, &vec![(sample_bytes * 8) as u16; bands as usize]),
                shorts(259, &[1]),
                shorts(277, &[bands as u16]),
                shorts(284, &[1]),
                long(322, TILE),
                long(323, TILE),
                Entry { tag: 324, typ: 16, count: n, data: offsets },
                Entry { tag: 325, typ: 4, count: n, data: counts },
                shorts(339, &vec![sample_format; bands as usize]),
            ];
            if !full {
                e.push(long(254, 1)); // a reduced-resolution image
            }
            for t in copied.iter().filter(|t| full || [262, 338].contains(&t.id)) {
                e.push(Entry { tag: t.id, typ: t.typ, count: t.count, data: t.data.clone() });
            }
            if !e.iter().any(|x| x.tag == 262) {
                e.push(shorts(262, &[if bands >= 3 { 2 } else { 1 }]));
            }
            e
        };
        // First pass: the sizes, with placeholders of the right length.
        let mut at = 16u64;
        for (i, lv) in levels.iter().enumerate() {
            let n = lv.tiles_x as u64 * lv.tiles_y as u64;
            at += ifd_size(&entries(lv, i == 0, vec![0; n as usize * 8], vec![0; n as usize * 4], n));
        }
        let data_start = align(at, ALIGN);
        let mut p = data_start;
        for lv in levels.iter_mut() {
            lv.first = p;
            p += lv.tiles_x as u64 * lv.tiles_y as u64 * stride;
        }
        let size = p;
        // Second pass: the bytes.
        let mut out = Vec::with_capacity(at as usize);
        out.extend_from_slice(b"II");
        out.extend_from_slice(&43u16.to_le_bytes());
        out.extend_from_slice(&8u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&16u64.to_le_bytes());
        for (i, lv) in levels.iter().enumerate() {
            let n = lv.tiles_x as u64 * lv.tiles_y as u64;
            let offsets: Vec<u8> = (0..n).flat_map(|t| (lv.first + t * stride).to_le_bytes()).collect();
            let counts: Vec<u8> = (0..n).flat_map(|_| (tile_bytes as u32).to_le_bytes()).collect();
            let e = entries(lv, i == 0, offsets, counts, n);
            let next = if i + 1 < levels.len() { out.len() as u64 + ifd_size(&e) } else { 0 };
            write_ifd(&mut out, e, next);
        }
        debug_assert_eq!(out.len() as u64, at);
        Ok(Layout { width, height, bands, sample_bytes, levels, tile_bytes, stride, header: out, data_start, size })
    }

    pub fn place(&self, off: u64) -> Place {
        if off >= self.size {
            return Place::Past;
        }
        if off < self.data_start {
            return Place::Header(off, self.data_start);
        }
        for (i, lv) in self.levels.iter().enumerate().rev() {
            if off >= lv.first {
                let n = (off - lv.first) / self.stride;
                let (x, y) = ((n % lv.tiles_x as u64) as u32, (n / lv.tiles_x as u64) as u32);
                return Place::Tile { level: i, x, y, at: (off - lv.first) % self.stride };
            }
        }
        Place::Past
    }

    /// The pixels of metatile `(level, mx, my)` in that level's grid: `(x0, y0, x1, y1)`.
    pub fn meta_rect(&self, level: usize, mx: u32, my: u32) -> (u32, u32, u32, u32) {
        let lv = &self.levels[level];
        let side = META * TILE;
        let (x0, y0) = (mx * side, my * side);
        (x0, y0, (x0 + side).min(lv.width), (y0 + side).min(lv.height))
    }

    /// `gdal_translate`'s window for that metatile: `(srcwin, Some(outsize) below full resolution)`.
    pub fn source_window(&self, level: usize, mx: u32, my: u32) -> ([u64; 4], Option<[u32; 2]>) {
        let (x0, y0, x1, y1) = self.meta_rect(level, mx, my);
        let s = 1u64 << level;
        let (sx, sy) = (x0 as u64 * s, y0 as u64 * s);
        let (sw, sh) = ((x1 as u64 * s).min(self.width as u64) - sx, (y1 as u64 * s).min(self.height as u64) - sy);
        ([sx, sy, sw, sh], (level > 0).then_some([x1 - x0, y1 - y0]))
    }

    /// Tile `(x, y)` of a level, cut from its metatile's pixels; what lies outside the image is zero.
    pub fn cut_tile(&self, level: usize, x: u32, y: u32, meta: &[u8]) -> Vec<u8> {
        let (x0, y0, x1, y1) = self.meta_rect(level, x / META, y / META);
        let px = (self.bands * self.sample_bytes) as usize;
        let (mw, t) = ((x1 - x0) as usize, TILE as usize);
        let (tx, ty) = ((x * TILE - x0) as usize, (y * TILE - y0) as usize);
        let mut out = vec![0u8; self.tile_bytes as usize];
        let cols = mw.saturating_sub(tx).min(t);
        let rows = ((y1 - y0) as usize).saturating_sub(ty).min(t);
        for r in 0..rows {
            let from = (ty + r) * mw * px + tx * px;
            out[r * t * px..(r * t + cols) * px].copy_from_slice(&meta[from..from + cols * px]);
        }
        out
    }
}

// ---------------------------------------------------------------- views

type MetaKey = (usize, u32, u32);

pub struct View {
    pub id: String,
    pub owner: String,
    pub file: FileRec,
    pub layout: Layout,
    pub driver: String,
    pub sample_type: String,
    dir: PathBuf,
    cancel: CancellationToken,
    metas: Mutex<HashMap<MetaKey, Arc<OnceCell<Arc<Vec<u8>>>>>>,
    used: Mutex<Instant>,
}

impl View {
    pub fn info(&self) -> ViewInfo {
        ViewInfo { id: self.id.clone(), name: self.file.name.clone(), driver: self.driver.clone(), size: self.layout.size, width: self.layout.width, height: self.layout.height, bands: self.layout.bands, sample_type: self.sample_type.clone(), levels: self.layout.levels.len() as u32, tile: TILE }
    }
}

pub struct Views {
    map: Mutex<HashMap<String, Arc<View>>>,
    lru: Mutex<VecDeque<(String, MetaKey, u64)>>,
    sem: Arc<Semaphore>,
}

impl Default for Views {
    fn default() -> Self {
        Views::new()
    }
}

impl Views {
    pub fn new() -> Views {
        let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        Views { map: Mutex::new(HashMap::new()), lru: Mutex::new(VecDeque::new()), sem: Arc::new(Semaphore::new((cpus / 2).clamp(2, 4))) }
    }

    pub fn get(&self, id: &str, owner: &str) -> Option<Arc<View>> {
        let v = self.map.lock().unwrap().get(id).filter(|v| v.owner == owner).cloned()?;
        *v.used.lock().unwrap() = Instant::now();
        Some(v)
    }

    /// Close a view: its running decodes stop, its metatiles go, the app's next read gets a 404.
    pub fn close(&self, id: &str, owner: &str) -> bool {
        let mut m = self.map.lock().unwrap();
        if m.get(id).map(|v| v.owner == owner) != Some(true) {
            return false;
        }
        let v = m.remove(id).unwrap();
        drop(m);
        self.forget(&v);
        true
    }

    fn forget(&self, v: &View) {
        v.cancel.cancel();
        v.metas.lock().unwrap().clear();
        self.lru.lock().unwrap().retain(|(id, _, _)| *id != v.id);
        let _ = std::fs::remove_dir_all(&v.dir);
    }

    /// Close views nobody has read for `max_idle`.
    pub fn sweep(&self, max_idle: Duration) -> usize {
        let old: Vec<Arc<View>> = {
            let mut m = self.map.lock().unwrap();
            let ids: Vec<String> = m.values().filter(|v| v.used.lock().unwrap().elapsed() > max_idle).map(|v| v.id.clone()).collect();
            ids.iter().filter_map(|i| m.remove(i)).collect()
        };
        for v in &old {
            self.forget(v);
        }
        old.len()
    }

    fn insert(&self, v: Arc<View>) {
        let oldest = {
            let mut m = self.map.lock().unwrap();
            let mut mine: Vec<&Arc<View>> = m.values().filter(|x| x.owner == v.owner).collect();
            let old = if mine.len() >= MAX_VIEWS_PER_OWNER {
                mine.sort_by_key(|x| *x.used.lock().unwrap());
                Some(mine[0].id.clone())
            } else {
                None
            };
            let old = old.and_then(|id| m.remove(&id));
            m.insert(v.id.clone(), v);
            old
        };
        if let Some(o) = oldest {
            self.forget(&o);
        }
    }

    /// Note a metatile's use, newest last, and let the oldest go past the cap.
    fn touch(&self, id: &str, key: MetaKey, bytes: u64) {
        let dropped = {
            let mut q = self.lru.lock().unwrap();
            if let Some(i) = q.iter().position(|(a, k, _)| a == id && *k == key) {
                q.remove(i);
            }
            q.push_back((id.to_string(), key, bytes));
            let mut total: u64 = q.iter().map(|e| e.2).sum();
            let mut out = Vec::new();
            while total > CACHE_BYTES && q.len() > 1 {
                let e = q.pop_front().unwrap();
                total -= e.2;
                out.push(e);
            }
            out
        };
        if dropped.is_empty() {
            return;
        }
        let m = self.map.lock().unwrap();
        for (a, k, _) in dropped {
            if let Some(v) = m.get(&a) {
                v.metas.lock().unwrap().remove(&k);
            }
        }
    }
}

struct Quiet;
impl Sink for Quiet {
    fn log(&self, _: &str) {}
    fn progress(&self, _: f64) {}
}

fn why(o: &runner::RunOutcome) -> String {
    o.stderr_tail.iter().rev().find(|l| l.contains("ERROR") || l.contains("rror")).cloned().or_else(|| o.stderr_tail.last().cloned()).unwrap_or_else(|| format!("exit {:?}", o.exit_code))
}

const TOOL_WALL_S: u64 = 180;

fn spec<'a>(svc: &'a Service, tool: &'a str, args: &'a [String], work: &'a Path) -> RunSpec<'a> {
    RunSpec { modules_dir: &svc.cfg.modules_dir, tool, args, cwd: work, tmp: work, limits: JobLimits { memory_bytes: 8 << 30, cpu_seconds: 600, processes: 4 }, wall: Duration::from_secs(TOOL_WALL_S), capture_stdout: 0, progress: Progress::None }
}

/// `(bytes per sample, TIFF SampleFormat)` of a GDAL data type a view can carry.
fn sample_of(t: &str) -> Option<(u32, u16)> {
    match t {
        "Byte" => Some((1, 1)),
        "UInt16" => Some((2, 1)),
        "Int16" => Some((2, 2)),
        "UInt32" => Some((4, 1)),
        "Int32" => Some((4, 2)),
        "Float32" => Some((4, 3)),
        _ => None,
    }
}

/// What a view needs from `gdalinfo -json`: driver, size, band count and their one data type.
pub fn parse_info(text: &str) -> Result<(String, u32, u32, u32, String), String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("gdalinfo said something unexpected: {e}"))?;
    let driver = v["driverShortName"].as_str().unwrap_or("").to_string();
    let dim = |i: usize| v["size"][i].as_u64().filter(|n| *n > 0 && *n <= u32::MAX as u64).map(|n| n as u32);
    let (w, h) = dim(0).zip(dim(1)).ok_or("gdalinfo gave no image size")?;
    let bands = v["bands"].as_array().ok_or("gdalinfo gave no bands")?;
    let ty = bands.first().and_then(|b| b["type"].as_str()).ok_or("gdalinfo gave no band type")?;
    if bands.iter().any(|b| b["type"].as_str() != Some(ty)) {
        return Err("its bands have different data types".into());
    }
    Ok((driver, w, h, bands.len() as u32, ty.to_string()))
}

/// Open a view of a file the caller owns. Refusals are by name; nothing runs on a pointer file.
pub async fn open(svc: &Arc<Service>, owner: &str, file: FileRec) -> Result<Arc<View>, ViewError> {
    open_with(svc, owner, file, false).await
}

/// A view of any raster GDAL reads, for the stereo viewer (REQ-GAP-33): the app has no part in it,
/// so the rule that a view is for what the app cannot read itself does not apply.
pub async fn open_any(svc: &Arc<Service>, owner: &str, file: FileRec) -> Result<Arc<View>, ViewError> {
    open_with(svc, owner, file, true).await
}

async fn open_with(svc: &Arc<Service>, owner: &str, file: FileRec, any_driver: bool) -> Result<Arc<View>, ViewError> {
    if file.is_dir {
        return Err((400, "is_folder", format!("{} is a folder", file.name)));
    }
    if !svc.caps.installed("core-gdal") {
        return Err((409, "no_module", "the Core GDAL module is not installed".into()));
    }
    if is_pointer_file(&file.path) {
        return Err((422, "pointer_file", format!("{} is a VRT or another file that points at other files or URLs; it is refused as an input", file.name)));
    }
    if file.origin == FileOrigin::Pick {
        crate::paths::check_user_path(&file.path).map_err(|e| (403, "bad_path", e.to_string()))?;
    }
    let id = util::random_hex(12);
    let dir = svc.cfg.data_dir.join("views").join(&id);
    crate::winjob::create_low_dir(&dir).map_err(|e| (500, "io", format!("cannot create the view's folder: {e}")))?;
    let made = build(svc, owner, file, id, dir.clone(), any_driver).await;
    if made.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    let v = Arc::new(made?);
    svc.views.insert(v.clone());
    Ok(v)
}

async fn build(svc: &Arc<Service>, owner: &str, file: FileRec, id: String, dir: PathBuf, any_driver: bool) -> Result<View, ViewError> {
    let path = file.path.display().to_string();
    let probe = dir.join("probe");
    std::fs::create_dir_all(&probe).map_err(|e| (500, "io", e.to_string()))?;
    let args: Vec<String> = ["-json", "-nomd", "-norat", "-noct", path.as_str()].iter().map(|s| s.to_string()).collect();
    let mut info = spec(svc, "gdalinfo", &args, &probe);
    info.capture_stdout = 8 << 20;
    let o = runner::run(info, CancellationToken::new(), Arc::new(Quiet)).await.map_err(|e| (502, "tool_failed", e))?;
    // A slow disk is not a damaged file.
    if o.timed_out {
        return Err((504, "tool_failed", format!("{}: gdalinfo took longer than {TOOL_WALL_S} s", file.name)));
    }
    if o.exit_code != Some(0) {
        return Err((422, "unreadable", format!("no driver of this sidecar reads {}: the file is damaged, or its vendor plug-in is not installed", file.name)));
    }
    let (driver, w, h, bands, ty) = parse_info(&String::from_utf8_lossy(&o.stdout)).map_err(|e| (422, "unreadable", format!("{}: {e}", file.name)))?;
    if !any_driver && !VIEW_DRIVERS.contains(&driver.as_str()) {
        return Err((422, "not_viewable", format!("{} is {driver}: a view is for MrSID and ECW, whose pixels the app cannot read itself", file.name)));
    }
    let (sb, sf) = sample_of(&ty).ok_or_else(|| (422, "not_viewable", format!("{}: a view cannot carry {ty} samples", file.name)))?;
    // GDAL's own GeoTIFF of the first pixel: the geokeys, scale, tiepoint, no-data and colour
    // meaning of the image, whatever its CRS is, exactly as the COG conversion writes them.
    let tif = dir.join("template.tif");
    let args: Vec<String> = ["-q", "-of", "GTiff", "-co", "COMPRESS=NONE", "-srcwin", "0", "0", "1", "1", path.as_str(), &tif.display().to_string()].iter().map(|s| s.to_string()).collect();
    let o = runner::run(spec(svc, "gdal_translate", &args, &probe), CancellationToken::new(), Arc::new(Quiet)).await.map_err(|e| (502, "tool_failed", e))?;
    if o.exit_code != Some(0) {
        return Err((502, "tool_failed", format!("{}: gdal_translate failed: {}", file.name, why(&o))));
    }
    let small = std::fs::metadata(&tif).map(|m| m.len() <= MAX_TEMPLATE).unwrap_or(false);
    let bytes = if small { std::fs::read(&tif).unwrap_or_default() } else { vec![] };
    let tags = read_tags(&bytes).map_err(|e| (502, "tool_failed", format!("{}: {e}", file.name)))?;
    if tags.iter().any(|t| t.id == 320) {
        return Err((422, "not_viewable", format!("{}: a view cannot carry a palette", file.name)));
    }
    let layout = Layout::new(w, h, bands, sb, sf, &tags).map_err(|e| (422, "not_viewable", format!("{}: {e}", file.name)))?;
    let _ = std::fs::remove_dir_all(&probe);
    let _ = std::fs::remove_file(&tif);
    Ok(View { id, owner: owner.to_string(), file, layout, driver, sample_type: ty, dir, cancel: CancellationToken::new(), metas: Mutex::new(HashMap::new()), used: Mutex::new(Instant::now()) })
}

async fn decode(svc: &Arc<Service>, v: &Arc<View>, key: MetaKey) -> Result<Arc<Vec<u8>>, ViewError> {
    let _permit = tokio::select! {
        p = svc.views.sem.clone().acquire_owned() => p.map_err(|e| (500, "busy", e.to_string()))?,
        _ = v.cancel.cancelled() => return Err((410, "gone", "the view was closed".into())),
    };
    let (level, mx, my) = key;
    let ([sx, sy, sw, sh], out) = v.layout.source_window(level, mx, my);
    let (x0, y0, x1, y1) = v.layout.meta_rect(level, mx, my);
    let work = v.dir.join(util::random_hex(6));
    std::fs::create_dir_all(&work).map_err(|e| (500, "io", e.to_string()))?;
    let raw = work.join("meta.bin");
    // -a_ullr: only the pixels of this temporary file are used. ENVI cannot hold a rotated
    // geotransform and exits 1 on one, having written them, so the output gets a plain one.
    let mut args: Vec<String> = ["-q", "-of", "ENVI", "-co", "INTERLEAVE=BIP", "-a_ullr", "0", "0", "1", "1", "-srcwin"].iter().map(|s| s.to_string()).collect();
    args.extend([sx, sy, sw, sh].iter().map(u64::to_string));
    if let Some([ow, oh]) = out {
        args.extend(["-outsize".into(), ow.to_string(), oh.to_string(), "-r".into(), "nearest".into()]);
    }
    args.push(v.file.path.display().to_string());
    args.push(raw.display().to_string());
    let done = runner::run(spec(svc, "gdal_translate", &args, &work), v.cancel.clone(), Arc::new(Quiet)).await;
    let result = (|| {
        let o = done.map_err(|e| (502, "tool_failed", e))?;
        if o.cancelled {
            return Err((410, "gone", "the view was closed".to_string()));
        }
        if o.timed_out {
            return Err((504, "tool_failed", format!("{}: decoding a tile took longer than {TOOL_WALL_S} s", v.file.name)));
        }
        if o.exit_code != Some(0) {
            return Err((502, "tool_failed", format!("{}: {}", v.file.name, why(&o))));
        }
        let want = (x1 - x0) as u64 * (y1 - y0) as u64 * (v.layout.bands * v.layout.sample_bytes) as u64;
        let b = std::fs::read(&raw).map_err(|e| (502, "tool_failed", format!("{}: the tool wrote nothing: {e}", v.file.name)))?;
        if b.len() as u64 != want {
            return Err((502, "tool_failed", format!("{}: the tool wrote {} bytes, not {want}", v.file.name, b.len())));
        }
        Ok(Arc::new(b))
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

async fn metatile(svc: &Arc<Service>, v: &Arc<View>, key: MetaKey) -> Result<Arc<Vec<u8>>, ViewError> {
    let cell = v.metas.lock().unwrap().entry(key).or_default().clone();
    let m = cell.get_or_try_init(|| decode(svc, v, key)).await?.clone();
    svc.views.touch(&v.id, key, m.len() as u64);
    Ok(m)
}

/// One tile, as a view's range read would give it.
pub async fn tile(svc: &Arc<Service>, v: &Arc<View>, level: usize, x: u32, y: u32) -> Result<Vec<u8>, ViewError> {
    let m = metatile(svc, v, (level, x / META, y / META)).await?;
    Ok(v.layout.cut_tile(level, x, y, &m))
}

/// The bytes `[a, b)` of the view. Metatiles a range needs are decoded at once, then cut.
pub async fn read(svc: &Arc<Service>, v: &Arc<View>, a: u64, b: u64) -> Result<Vec<u8>, ViewError> {
    let lay = &v.layout;
    let mut need: Vec<MetaKey> = Vec::new();
    let mut p = a;
    while p < b {
        match lay.place(p) {
            Place::Header(_, end) => p = end,
            Place::Tile { level, x, y, at } => {
                if at < lay.tile_bytes {
                    let k = (level, x / META, y / META);
                    if !need.contains(&k) {
                        need.push(k);
                    }
                }
                p += lay.stride - at;
            }
            Place::Past => break,
        }
    }
    let got = futures_util::future::try_join_all(need.iter().map(|k| metatile(svc, v, *k))).await?;
    let metas: HashMap<MetaKey, Arc<Vec<u8>>> = need.into_iter().zip(got).collect();
    let mut out = Vec::with_capacity((b - a) as usize);
    let mut p = a;
    while p < b {
        match lay.place(p) {
            Place::Header(off, end) => {
                let n = end.min(b) - off;
                let have = (lay.header.len() as u64).saturating_sub(off).min(n);
                out.extend_from_slice(&lay.header[off as usize..(off + have) as usize]);
                out.resize(out.len() + (n - have) as usize, 0);
                p += n;
            }
            Place::Tile { level, x, y, at } => {
                let n = (lay.stride - at).min(b - p);
                if at >= lay.tile_bytes {
                    out.resize(out.len() + n as usize, 0);
                } else {
                    let tile = lay.cut_tile(level, x, y, &metas[&(level, x / META, y / META)]);
                    let m = n.min(lay.tile_bytes - at);
                    out.extend_from_slice(&tile[at as usize..(at + m) as usize]);
                    out.resize(out.len() + (n - m) as usize, 0);
                }
                p += n;
            }
            Place::Past => break,
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(id: u16, typ: u16, count: u64, data: Vec<u8>) -> Tag {
        Tag { id, typ, count, data }
    }

    /// A classic TIFF with the given tags, as GDAL would write it.
    fn classic(tags: &[Tag]) -> Vec<u8> {
        let mut b = b"II\x2a\0\x08\0\0\0".to_vec();
        b.extend_from_slice(&(tags.len() as u16).to_le_bytes());
        let mut blob = 10 + tags.len() * 12 + 4;
        let mut tail = Vec::new();
        for t in tags {
            b.extend_from_slice(&t.id.to_le_bytes());
            b.extend_from_slice(&t.typ.to_le_bytes());
            b.extend_from_slice(&(t.count as u32).to_le_bytes());
            if t.data.len() <= 4 {
                let mut v = t.data.clone();
                v.resize(4, 0);
                b.extend_from_slice(&v);
            } else {
                b.extend_from_slice(&(blob as u32).to_le_bytes());
                blob += t.data.len();
                tail.extend_from_slice(&t.data);
            }
        }
        b.extend_from_slice(&[0; 4]);
        b.extend_from_slice(&tail);
        b
    }

    /// Reads the BigTIFF a Layout wrote: for each IFD, (tag, type, count, value bytes).
    fn big_ifds(h: &[u8]) -> Vec<HashMap<u16, (u16, u64, Vec<u8>)>> {
        let r64 = |o: usize| u64::from_le_bytes(h[o..o + 8].try_into().unwrap());
        let r16 = |o: usize| u16::from_le_bytes(h[o..o + 2].try_into().unwrap());
        assert_eq!(&h[..4], b"II\x2b\0");
        assert_eq!(r16(4), 8);
        let mut out = vec![];
        let mut at = r64(8) as usize;
        while at != 0 {
            let n = r64(at) as usize;
            let mut m = HashMap::new();
            let mut last = 0;
            for i in 0..n {
                let e = at + 8 + i * 20;
                let (id, ty, cnt) = (r16(e), r16(e + 2), r64(e + 4));
                assert!(id > last, "tags ascend");
                last = id;
                let size = if ty == 16 { 8 } else { type_size(ty).unwrap() };
                let len = (cnt * size) as usize;
                let v = if len <= 8 { h[e + 12..e + 12 + len].to_vec() } else { let o = r64(e + 12) as usize; assert_eq!(o % 8, 0); h[o..o + len].to_vec() };
                m.insert(id, (ty, cnt, v));
            }
            out.push(m);
            at = r64(at + 8 + n * 20) as usize;
        }
        out
    }

    #[test]
    fn levels_tiles_and_alignment() {
        let l = Layout::new(5000, 3000, 3, 1, 1, &[]).unwrap();
        let dims: Vec<(u32, u32)> = l.levels.iter().map(|v| (v.width, v.height)).collect();
        assert_eq!(dims, vec![(5000, 3000), (2500, 1500), (1250, 750), (625, 375), (313, 188)]);
        assert_eq!(l.tile_bytes, 512 * 512 * 3);
        assert_eq!(l.stride, 786432, "12 × 64 KiB");
        assert_eq!(l.data_start % ALIGN, 0);
        assert_eq!((l.levels[0].tiles_x, l.levels[0].tiles_y), (10, 6));
        assert_eq!(l.size, l.levels[4].first + l.stride);
        assert!(l.header.len() as u64 <= l.data_start);
        // A small image is one level of one tile.
        let s = Layout::new(10, 10, 1, 1, 1, &[]).unwrap();
        assert_eq!(s.levels.len(), 1);
        assert_eq!(s.size, s.data_start + 262144);
    }

    #[test]
    fn the_header_is_a_good_bigtiff() {
        let t = [tag(262, 3, 1, vec![2, 0]), tag(338, 3, 1, vec![2, 0]), tag(33550, 12, 3, vec![1; 24]), tag(34735, 3, 4, vec![7; 8]), tag(34737, 2, 9, b"NAD83|ab\0".to_vec()), tag(42113, 2, 2, b"0\0".to_vec()), tag(305, 2, 5, b"GDAL\0".to_vec())];
        let l = Layout::new(1000, 600, 4, 2, 1, &t).unwrap();
        let ifd = big_ifds(&l.header);
        assert_eq!(ifd.len(), 2);
        let f = &ifd[0];
        assert_eq!(f[&256].2, 1000u32.to_le_bytes());
        assert_eq!(f[&258].2, [16, 0, 16, 0, 16, 0, 16, 0]);
        assert_eq!(f[&259].2, [1, 0], "no compression");
        assert_eq!(f[&277].2, [4, 0]);
        assert_eq!(f[&322].2, 512u32.to_le_bytes());
        assert_eq!(f[&324].0, 16, "LONG8 offsets");
        assert_eq!(f[&324].1, 4);
        assert_eq!(f[&33550].2, vec![1; 24]);
        assert_eq!(f[&34737].2, b"NAD83|ab\0");
        assert_eq!(f[&42113].2, b"0\0");
        assert!(!f.contains_key(&305), "only the listed tags are copied");
        assert!(!f.contains_key(&254));
        let o = &ifd[1];
        assert_eq!(o[&254].2, 1u32.to_le_bytes());
        assert_eq!(o[&256].2, 500u32.to_le_bytes());
        assert_eq!(o[&262].2, [2, 0]);
        assert!(!o.contains_key(&33550), "the overview has no georeferencing of its own");
        // Offsets step by the stride from the level's first tile.
        let off: Vec<u64> = f[&324].2.chunks(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
        assert_eq!(off, (0..4).map(|i| l.levels[0].first + i * l.stride).collect::<Vec<u64>>());
        assert_eq!(f[&325].2[..4], (l.tile_bytes as u32).to_le_bytes());
        assert_eq!(off[0] % ALIGN, 0);
    }

    #[test]
    fn places_cover_the_file() {
        let l = Layout::new(1500, 1100, 3, 1, 1, &[]).unwrap();
        assert_eq!(l.place(0), Place::Header(0, l.data_start));
        assert_eq!(l.place(l.data_start), Place::Tile { level: 0, x: 0, y: 0, at: 0 });
        let lv = &l.levels[0];
        assert_eq!((lv.tiles_x, lv.tiles_y), (3, 3));
        assert_eq!(l.place(lv.first + l.stride * 4 + 7), Place::Tile { level: 0, x: 1, y: 1, at: 7 });
        assert_eq!(l.place(l.levels[1].first), Place::Tile { level: 1, x: 0, y: 0, at: 0 });
        assert_eq!(l.place(l.size - 1), Place::Tile { level: l.levels.len() - 1, x: 0, y: 0, at: l.stride - 1 });
        assert_eq!(l.place(l.size), Place::Past);
    }

    #[test]
    fn source_windows_and_tile_cuts() {
        let l = Layout::new(5000, 3000, 1, 1, 1, &[]).unwrap();
        assert_eq!(l.source_window(0, 1, 0), ([2048, 0, 2048, 2048], None));
        // The last column is what is left.
        assert_eq!(l.source_window(0, 2, 1), ([4096, 2048, 904, 952], None));
        // A coarser level reads twice the window and shrinks it to its own pixels.
        assert_eq!(l.source_window(1, 1, 0), ([4096, 0, 904, 2048 + 952], Some([452, 1500])));
        // Tile (4,4) of a level with metatiles of 2048: x/y are the metatile's second tile… the
        // pixel at metatile (5,3) is tile (0,0)'s pixel (5,3).
        let (x0, y0, x1, y1) = l.meta_rect(0, 1, 1);
        assert_eq!((x0, y0, x1, y1), (2048, 2048, 4096, 3000));
        let (mw, mh) = ((x1 - x0) as usize, (y1 - y0) as usize);
        let meta: Vec<u8> = (0..mw * mh).map(|i| ((i % mw) as u8) ^ ((i / mw) as u8).wrapping_mul(7)).collect();
        let t = l.cut_tile(0, 5, 4, &meta);
        assert_eq!(t.len(), 512 * 512);
        assert_eq!(t[0], meta[512]);
        assert_eq!(t[3 * 512 + 2], meta[3 * mw + 512 + 2]);
        // Tile row 5 of the image starts 512 rows into the metatile, of which 440 remain: the rest is zero.
        let t = l.cut_tile(0, 4, 5, &meta);
        assert_eq!(t[439 * 512], meta[(512 + 439) * mw]);
        assert_eq!(t[440 * 512], 0);
        assert!(t[440 * 512..].iter().all(|b| *b == 0));
    }

    #[test]
    fn refusals_of_impossible_images() {
        assert!(Layout::new(0, 10, 1, 1, 1, &[]).is_err());
        assert!(Layout::new(10, 10, 65, 1, 1, &[]).is_err());
        assert!(Layout::new(10, 10, 1, 3, 1, &[]).is_err());
        assert!(Layout::new(u32::MAX, u32::MAX, 1, 1, 1, &[]).is_err(), "more tiles than a header holds");
    }

    #[test]
    fn gdalinfo_json() {
        let ok = r#"{"driverShortName":"MrSID","size":[640,480],"bands":[{"band":1,"type":"Byte"},{"band":2,"type":"Byte"}]}"#;
        assert_eq!(parse_info(ok).unwrap(), ("MrSID".to_string(), 640, 480, 2, "Byte".to_string()));
        for bad in ["", "{}", r#"{"size":[1,1]}"#, r#"{"size":[0,1],"bands":[{"type":"Byte"}]}"#, r#"{"size":[1,1],"bands":[]}"#, r#"{"size":[1,1],"bands":[{"type":"Byte"},{"type":"Int16"}]}"#, r#"{"size":[9999999999,1],"bands":[{"type":"Byte"}]}"#] {
            assert!(parse_info(bad).is_err(), "{bad}");
        }
        assert_eq!(sample_of("Byte"), Some((1, 1)));
        assert_eq!(sample_of("Float32"), Some((4, 3)));
        assert_eq!(sample_of("CFloat32"), None);
    }

    #[test]
    fn tags_round_trip() {
        let t = vec![tag(262, 3, 1, vec![1, 0]), tag(33550, 12, 3, vec![9; 24]), tag(34737, 2, 3, b"ab\0".to_vec()), tag(42113, 2, 8, b"-9999.5\0".to_vec())];
        assert_eq!(read_tags(&classic(&t)).unwrap(), t);
    }

    #[test]
    fn tag_reader_refuses_what_is_not_there() {
        assert!(read_tags(b"").is_err());
        assert!(read_tags(b"MM\0\x2a\0\0\0\x08").is_err());
        assert!(read_tags(b"II\x2b\0\x08\0\0\0").is_err(), "BigTIFF");
        assert!(read_tags(b"II\x2a\0\xff\xff\xff\xff").is_err());
        let mut b = classic(&[tag(33550, 12, 3, vec![9; 24])]);
        b.truncate(b.len() - 1);
        assert!(read_tags(&b).is_err());
        let mut b = classic(&[tag(33550, 12, 3, vec![9; 24])]);
        b[14..18].copy_from_slice(&u32::MAX.to_le_bytes()); // the count
        assert!(read_tags(&b).is_err());
    }

    /// Mutation fuzz of the only parser here (the REQ-RUST-07 rule for new parsers): no input
    /// panics, reads out of bounds or asks for more memory than the file holds.
    #[test]
    fn tag_reader_survives_mutations() {
        let seed = classic(&[tag(262, 3, 1, vec![2, 0]), tag(33550, 12, 3, vec![1; 24]), tag(33922, 12, 6, vec![2; 48]), tag(34735, 3, 8, vec![3; 16]), tag(34737, 2, 16, vec![65; 16]), tag(42113, 2, 2, b"0\0".to_vec())]);
        let mut s = 0x9E3779B97F4A7C15u64;
        let mut next = move || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            s
        };
        for _ in 0..200_000 {
            let mut b = seed.clone();
            for _ in 0..(next() % 8 + 1) {
                let i = next() as usize % b.len();
                b[i] = match next() % 4 {
                    0 => 0xff,
                    1 => 0,
                    2 => b[i] ^ (1 << (next() % 8)),
                    _ => next() as u8,
                };
            }
            if next() % 16 == 0 {
                b.truncate(next() as usize % b.len());
            }
            if let Ok(t) = read_tags(&b) {
                assert!(t.iter().map(|x| x.data.len()).sum::<usize>() <= b.len() * 2000);
            }
        }
    }
}
