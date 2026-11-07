//! A small TIFF reader for grid files (REQ-GAP-16): the PROJ "GeoTIFF grid" layout
//! (classic TIFF and BigTIFF, either byte order, strips or tiles, several IFDs for nested
//! sub-grids). Compression none, LZW and DEFLATE; predictors 1, 2 and 3; 16- and 32-bit
//! integers and 32/64-bit floats. Blocks are inflated on demand and kept in a bounded cache,
//! so a large grid (EGM2008 2.5′: 80 MB compressed, 149 MB of samples) never has to be
//! decoded in full.

use gw_abi::{Error, Result};
use std::cell::RefCell;
use std::rc::Rc;

/// A small map kept as a vector (linear search): the bundle stays free of hash tables.
#[derive(Clone, Debug)]
pub struct VecMap<K, V>(Vec<(K, V)>);

impl<K: PartialEq, V> Default for VecMap<K, V> {
    fn default() -> Self {
        VecMap(Vec::new())
    }
}

impl<K: PartialEq, V> VecMap<K, V> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn get(&self, k: &K) -> Option<&V> {
        self.0.iter().find(|e| &e.0 == k).map(|e| &e.1)
    }
    pub fn get_mut(&mut self, k: &K) -> Option<&mut V> {
        self.0.iter_mut().find(|e| &e.0 == k).map(|e| &mut e.1)
    }
    pub fn insert(&mut self, k: K, v: V) {
        match self.get_mut(&k) {
            Some(e) => *e = v,
            None => self.0.push((k, v)),
        }
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

pub type Meta = VecMap<(i32, String), String>;

/// Decimal number parser for TIFF ASCII values (GDAL_NODATA, scale, offset): sign, digits,
/// fraction and exponent, or nan/inf. Kept small instead of the standard float parser.
pub fn parse_num(s: &str) -> Option<f64> {
    let s = s.trim();
    let (neg, b) = match s.as_bytes().first() {
        Some(b'-') => (true, &s.as_bytes()[1..]),
        Some(b'+') => (false, &s.as_bytes()[1..]),
        _ => (false, s.as_bytes()),
    };
    let lower: Vec<u8> = b.iter().map(u8::to_ascii_lowercase).collect();
    if lower == b"nan" {
        return Some(f64::NAN);
    }
    if lower == b"inf" || lower == b"infinity" {
        return Some(if neg { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    let (mut m, mut e, mut i, mut digits) = (0u64, 0i32, 0usize, 0usize);
    while i < b.len() && b[i].is_ascii_digit() {
        if m < 100_000_000_000_000_000 {
            m = m * 10 + (b[i] - b'0') as u64;
        } else {
            e += 1;
        }
        i += 1;
        digits += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            if m < 100_000_000_000_000_000 {
                m = m * 10 + (b[i] - b'0') as u64;
                e -= 1;
            }
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return None;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        let (eneg, start) = match b.get(i) {
            Some(b'-') => (true, i + 1),
            Some(b'+') => (false, i + 1),
            _ => (false, i),
        };
        let mut x = 0i32;
        let mut j = start;
        while j < b.len() && b[j].is_ascii_digit() {
            x = x.saturating_mul(10).saturating_add((b[j] - b'0') as i32);
            j += 1;
        }
        if j == start {
            return None;
        }
        e = e.saturating_add(if eneg { -x } else { x });
        i = j;
    }
    if i != b.len() {
        return None;
    }
    let mut v = m as f64;
    // Powers of ten up to 1e22 are exact, so each step rounds once.
    let mut k = e;
    while k > 0 {
        let s = k.min(22);
        v *= 10f64.powi(s);
        k -= s;
    }
    while k < 0 {
        let s = (-k).min(22);
        v /= 10f64.powi(s);
        k += s;
    }
    Some(if neg { -v } else { v })
}

/// Sample type of an IFD, as PROJ accepts them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Dt {
    I16,
    U16,
    I32,
    U32,
    F32,
    F64,
}

impl Dt {
    fn size(self) -> usize {
        match self {
            Dt::I16 | Dt::U16 => 2,
            Dt::I32 | Dt::U32 | Dt::F32 => 4,
            Dt::F64 => 8,
        }
    }
}

#[derive(Clone, Debug)]
enum Val {
    Num(Vec<f64>),
    Text(String),
}

/// One image file directory (one grid or sub-grid).
#[derive(Clone, Debug)]
pub struct Ifd {
    pub width: usize,
    pub height: usize,
    pub spp: usize,
    pub dt: Dt,
    pub planar: u16,
    pub compression: u16,
    pub predictor: u16,
    pub tiled: bool,
    pub block_w: usize,
    pub block_h: usize,
    pub subfile_type: u32,
    offsets: Vec<u64>,
    counts: Vec<u64>,
    pub pixel_scale: Option<[f64; 3]>,
    pub tiepoint: Option<[f64; 6]>,
    pub matrix: Option<Vec<f64>>,
    pub geokeys: Vec<u16>,
    /// GDAL_METADATA items: (sample or -1, name) → value.
    pub meta: Meta,
    pub nodata: Option<f32>,
    pub scale: Vec<f64>,
    pub offset: Vec<f64>,
}

impl Ifd {
    pub fn blocks_per_row(&self) -> usize {
        self.width.div_ceil(self.block_w)
    }
    pub fn blocks_per_col(&self) -> usize {
        self.height.div_ceil(self.block_h)
    }
    pub fn meta(&self, key: &str, sample: i32) -> &str {
        self.meta.get(&(sample, key.to_string())).map_or("", |s| s.as_str())
    }
    /// True when PROJ reads this IFD through its fast path (256×256 float tiles, no nodata
    /// and no scale), which does not test samples for NaN.
    pub fn fast_path(&self) -> bool {
        self.block_w == 256 && self.block_h == 256 && (self.planar == 1 || self.spp == 1) && self.dt == Dt::F32 && self.nodata.is_none() && self.scale.is_empty()
    }
}

struct Cache {
    /// Per IFD, per block slot (block × planes): the decoded samples and their last use.
    slots: Vec<Vec<Option<(Rc<Vec<f32>>, u64)>>>,
    bytes: usize,
    budget: usize,
    tick: u64,
}

/// A parsed TIFF file. The file bytes stay compressed; blocks decode on demand.
pub struct TiffFile {
    data: Vec<u8>,
    pub ifds: Vec<Ifd>,
    cache: RefCell<Cache>,
}

struct Rd<'a> {
    b: &'a [u8],
    le: bool,
}

impl Rd<'_> {
    fn bytes(&self, off: u64, n: usize) -> Result<&[u8]> {
        let o = usize::try_from(off).map_err(|_| Error::invalid("TIFF offset out of range"))?;
        let end = o.checked_add(n).ok_or_else(|| Error::invalid("TIFF offset out of range"))?;
        self.b.get(o..end).ok_or_else(|| Error::invalid("TIFF: truncated file"))
    }
    fn u16(&self, off: u64) -> Result<u16> {
        let s = self.bytes(off, 2)?;
        Ok(if self.le { u16::from_le_bytes([s[0], s[1]]) } else { u16::from_be_bytes([s[0], s[1]]) })
    }
    fn u32(&self, off: u64) -> Result<u32> {
        let s = self.bytes(off, 4)?;
        let a = [s[0], s[1], s[2], s[3]];
        Ok(if self.le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    }
    fn u64(&self, off: u64) -> Result<u64> {
        let s = self.bytes(off, 8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        Ok(if self.le { u64::from_le_bytes(a) } else { u64::from_be_bytes(a) })
    }
    fn f64(&self, off: u64) -> Result<f64> {
        Ok(f64::from_bits(self.u64(off)?))
    }
    fn f32(&self, off: u64) -> Result<f32> {
        Ok(f32::from_bits(self.u32(off)?))
    }
}

fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 | 16 | 17 | 18 => 8,
        _ => 0,
    }
}

fn read_value(r: &Rd, t: u16, count: u64, at: u64) -> Result<Val> {
    let n = usize::try_from(count).map_err(|_| Error::invalid("TIFF tag count"))?;
    let sz = type_size(t);
    if n.checked_mul(sz).is_none_or(|total| total > r.b.len()) {
        return Err(Error::invalid("TIFF tag larger than the file"));
    }
    if t == 2 {
        let s = r.bytes(at, n)?;
        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
        return Ok(Val::Text(String::from_utf8_lossy(&s[..end]).into_owned()));
    }
    let mut v = Vec::with_capacity(n);
    for i in 0..n as u64 {
        let o = at + i * sz as u64;
        v.push(match t {
            1 | 7 => r.bytes(o, 1)?[0] as f64,
            6 => r.bytes(o, 1)?[0] as i8 as f64,
            3 => r.u16(o)? as f64,
            8 => r.u16(o)? as i16 as f64,
            4 | 13 => r.u32(o)? as f64,
            9 => r.u32(o)? as i32 as f64,
            5 => r.u32(o)? as f64 / r.u32(o + 4)?.max(1) as f64,
            10 => r.u32(o)? as i32 as f64 / (r.u32(o + 4)? as i32).max(1) as f64,
            11 => r.f32(o)? as f64,
            12 => r.f64(o)?,
            16 | 18 => r.u64(o)? as f64,
            17 => r.u64(o)? as i64 as f64,
            _ => return Err(Error::unsupported("TIFF tag type")),
        });
    }
    Ok(Val::Num(v))
}

/// Poor-man's parse of the GDAL_METADATA XML, as PROJ does it (name, sample, role).
fn parse_gdal_metadata(text: &str, spp: usize, meta: &mut Meta, scale: &mut Vec<f64>, offset: &mut Vec<f64>) {
    let mut rest = text;
    while let Some(p) = rest.find("<Item ") {
        let s = &rest[p..];
        let Some(end_tag) = s.find('>') else { break };
        let Some(end_val) = s[end_tag..].find('<') else { break };
        let tag = &s[..end_tag];
        let value = xml_unescape(&s[end_tag + 1..end_tag + end_val]);
        let attr = |name: &str| -> Option<String> {
            let key = format!("{name}=\"");
            let a = tag.find(&key)? + key.len();
            let b = tag[a..].find('"')?;
            Some(tag[a..a + b].to_string())
        };
        let Some(name) = attr("name") else { break };
        let sample = attr("sample").and_then(|v| v.trim().parse::<i32>().ok()).unwrap_or(-1);
        if let Some(role) = attr("role") {
            if (role == "offset" || role == "scale") && sample >= 0 && (sample as usize) <= spp {
                if let Some(v) = parse_num(&value) {
                    if offset.is_empty() {
                        offset.resize(spp, 0.0);
                        scale.resize(spp, 1.0);
                    }
                    if (sample as usize) < spp {
                        if role == "offset" {
                            offset[sample as usize] = v;
                        } else {
                            scale[sample as usize] = v;
                        }
                    }
                }
            }
        }
        meta.insert((sample, name), value);
        rest = &s[end_tag + end_val + 1..];
    }
}

fn xml_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

impl TiffFile {
    pub fn is_tiff(b: &[u8]) -> bool {
        b.len() >= 8 && ((b[0] == b'I' && b[1] == b'I' && (b[2] == 42 || b[2] == 43) && b[3] == 0) || (b[0] == b'M' && b[1] == b'M' && b[2] == 0 && (b[3] == 42 || b[3] == 43)))
    }

    /// Parse every IFD. `cache_budget` bounds the decoded-block cache (bytes).
    pub fn parse(data: Vec<u8>, cache_budget: usize) -> Result<Self> {
        if !Self::is_tiff(&data) {
            return Err(Error::invalid("not a TIFF file"));
        }
        let le = data[0] == b'I';
        let r = Rd { b: &data, le };
        let big = r.u16(2)? == 43;
        let mut next = if big {
            if r.u16(4)? != 8 {
                return Err(Error::invalid("BigTIFF: unsupported offset size"));
            }
            r.u64(8)?
        } else {
            r.u32(4)? as u64
        };
        let mut ifds = Vec::new();
        let mut seen: Vec<u64> = Vec::new();
        while next != 0 {
            if seen.contains(&next) || ifds.len() > 10_000 {
                return Err(Error::invalid("TIFF: IFD loop"));
            }
            seen.push(next);
            let (n, first, esz) = if big { (r.u64(next)?, next + 8, 20u64) } else { (r.u16(next)? as u64, next + 2, 12u64) };
            if n > 4096 {
                return Err(Error::invalid("TIFF: too many tags"));
            }
            let mut tags: VecMap<u16, Val> = VecMap::new();
            for i in 0..n {
                let e = first + i * esz;
                let tag = r.u16(e)?;
                let t = r.u16(e + 2)?;
                let count = if big { r.u64(e + 4)? } else { r.u32(e + 4)? as u64 };
                let sz = type_size(t) as u64;
                if sz == 0 {
                    continue;
                }
                let inline = if big { 8 } else { 4 };
                let at = if sz.saturating_mul(count) <= inline { e + if big { 12 } else { 8 } } else if big { r.u64(e + 12)? } else { r.u32(e + 8)? as u64 };
                if let Ok(v) = read_value(&r, t, count, at) {
                    tags.insert(tag, v);
                }
            }
            next = if big { r.u64(first + n * esz)? } else { r.u32(first + n * esz)? as u64 };
            ifds.push(Self::ifd(&tags)?);
        }
        if ifds.is_empty() {
            return Err(Error::invalid("TIFF: no image"));
        }
        let budget = cache_budget.max(1 << 20);
        let slots = ifds.iter().map(|d| vec![None; d.blocks_per_row() * d.blocks_per_col() * if d.planar == 2 { d.spp } else { 1 }]).collect();
        Ok(TiffFile { data, ifds, cache: RefCell::new(Cache { slots, bytes: 0, budget, tick: 0 }) })
    }

    fn ifd(tags: &VecMap<u16, Val>) -> Result<Ifd> {
        let num = |t: u16| -> Option<&Vec<f64>> {
            match tags.get(&t) {
                Some(Val::Num(v)) => Some(v),
                _ => None,
            }
        };
        let one = |t: u16, d: f64| num(t).and_then(|v| v.first().copied()).unwrap_or(d);
        let text = |t: u16| -> Option<&str> {
            match tags.get(&t) {
                Some(Val::Text(s)) => Some(s.as_str()),
                _ => None,
            }
        };
        let width = one(256, 0.0) as usize;
        let height = one(257, 0.0) as usize;
        if width == 0 || height == 0 || width > i32::MAX as usize || height > i32::MAX as usize {
            return Err(Error::invalid("TIFF: invalid image size"));
        }
        let spp = num(277).map(|v| v[0] as usize).ok_or_else(|| Error::invalid("TIFF: missing SamplesPerPixel"))?;
        if spp == 0 || spp > 64 {
            return Err(Error::invalid("TIFF: invalid SamplesPerPixel"));
        }
        let bps = num(258).map(|v| v[0] as u32).ok_or_else(|| Error::invalid("TIFF: missing BitsPerSample"))?;
        let sf = num(339).map(|v| v[0] as u32).ok_or_else(|| Error::invalid("TIFF: missing SampleFormat"))?;
        let dt = match (sf, bps) {
            (2, 16) => Dt::I16,
            (1, 16) => Dt::U16,
            (2, 32) => Dt::I32,
            (1, 32) => Dt::U32,
            (3, 32) => Dt::F32,
            (3, 64) => Dt::F64,
            _ => return Err(Error::unsupported("TIFF: unsupported SampleFormat and BitsPerSample")),
        };
        let planar = one(284, 1.0) as u16;
        if one(262, 1.0) as u16 != 1 {
            return Err(Error::unsupported("TIFF: unsupported Photometric value"));
        }
        let compression = one(259, 1.0) as u16;
        if !matches!(compression, 1 | 5 | 8 | 32946) {
            return Err(gw_abi::err!(UNSUPPORTED, "TIFF compression {c} is not supported", c = compression));
        }
        let predictor = one(317, 1.0) as u16;
        let tiled = num(322).is_some();
        let (block_w, block_h, offsets, counts) = if tiled {
            let tw = one(322, 0.0) as usize;
            let th = one(323, 0.0) as usize;
            let off = num(324).cloned().unwrap_or_default();
            let cnt = num(325).cloned().unwrap_or_default();
            (tw, th, off, cnt)
        } else {
            let rps = (one(278, height as f64) as usize).min(height).max(1);
            (width, rps, num(273).cloned().unwrap_or_default(), num(279).cloned().unwrap_or_default())
        };
        if block_w == 0 || block_h == 0 || block_w.saturating_mul(block_h).saturating_mul(spp) > 64 * 1024 * 1024 {
            return Err(Error::unsupported("TIFF: unsupported block size"));
        }
        let mut ifd = Ifd {
            width,
            height,
            spp,
            dt,
            planar: if spp == 1 { 1 } else { planar },
            compression,
            predictor,
            tiled,
            block_w,
            block_h,
            subfile_type: one(254, 0.0) as u32,
            offsets: offsets.iter().map(|&x| x as u64).collect(),
            counts: counts.iter().map(|&x| x as u64).collect(),
            pixel_scale: num(33550).filter(|v| v.len() == 3).map(|v| [v[0], v[1], v[2]]),
            tiepoint: num(33922).filter(|v| v.len() == 6).map(|v| [v[0], v[1], v[2], v[3], v[4], v[5]]),
            matrix: num(34264).filter(|v| v.len() == 16).cloned(),
            geokeys: num(34735).map(|v| v.iter().map(|&x| x as u16).collect()).unwrap_or_default(),
            meta: Meta::new(),
            nodata: text(42113).and_then(parse_num).map(|v| v as f32),
            scale: Vec::new(),
            offset: Vec::new(),
        };
        let nblocks = ifd.blocks_per_row() * ifd.blocks_per_col() * if ifd.planar == 2 { spp } else { 1 };
        if ifd.offsets.len() < nblocks || ifd.counts.len() < nblocks {
            return Err(Error::invalid("TIFF: missing block offsets"));
        }
        if let Some(t) = text(42112) {
            let (mut meta, mut scale, mut offset) = (Meta::new(), Vec::new(), Vec::new());
            parse_gdal_metadata(t, spp, &mut meta, &mut scale, &mut offset);
            ifd.meta = meta;
            ifd.scale = scale;
            ifd.offset = offset;
        }
        Ok(ifd)
    }

    /// Bytes of decoded samples currently cached.
    pub fn cached_bytes(&self) -> usize {
        self.cache.borrow().bytes
    }

    /// Decode one block (all its samples, chunky, or one plane) to f32 as PROJ reads values:
    /// nodata stays as it is; other values get the band scale and offset.
    fn block(&self, ifd_idx: usize, block: usize, plane: usize) -> Result<Rc<Vec<f32>>> {
        let slot = plane * self.ifds[ifd_idx].blocks_per_row() * self.ifds[ifd_idx].blocks_per_col() + block;
        {
            let mut c = self.cache.borrow_mut();
            c.tick += 1;
            let tick = c.tick;
            if let Some(Some(e)) = c.slots.get_mut(ifd_idx).and_then(|s| s.get_mut(slot)) {
                e.1 = tick;
                return Ok(e.0.clone());
            }
        }
        let d = &self.ifds[ifd_idx];
        let chunky = d.planar != 2;
        let per_pixel = if chunky { d.spp } else { 1 };
        let bpr = d.blocks_per_row();
        let rows = if d.tiled { d.block_h } else { d.block_h.min(d.height - (block / bpr) * d.block_h) };
        let n = d.block_w * rows * per_pixel;
        let sz = d.dt.size();
        let idx = if chunky { block } else { plane * d.blocks_per_row() * d.blocks_per_col() + block };
        let off = d.offsets[idx];
        let cnt = d.counts[idx] as usize;
        let le = self.data[0] == b'I';
        let rd = Rd { b: &self.data, le };
        let raw = rd.bytes(off, cnt)?;
        let mut buf = match d.compression {
            1 => raw.to_vec(),
            8 | 32946 => miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(raw, n * sz).map_err(|_| Error::invalid("TIFF: corrupt DEFLATE block"))?,
            5 => lzw_decode(raw, n * sz)?,
            _ => return Err(Error::unsupported("TIFF compression")),
        };
        if buf.len() < n * sz {
            buf.resize(n * sz, 0);
        }
        let row_samples = d.block_w * per_pixel;
        // Values in native (little-endian) order after the predictor.
        let mut native_le = le;
        match d.predictor {
            1 => {}
            2 => {
                swap_to_le(&mut buf[..n * sz], sz, le);
                native_le = true;
                for r in 0..rows {
                    let row = &mut buf[r * row_samples * sz..(r + 1) * row_samples * sz];
                    hor_acc(row, sz, per_pixel);
                }
            }
            3 => {
                for r in 0..rows {
                    let row = &mut buf[r * row_samples * sz..(r + 1) * row_samples * sz];
                    fp_acc(row, sz, per_pixel);
                }
                native_le = true;
            }
            p => return Err(gw_abi::err!(UNSUPPORTED, "TIFF predictor {p} is not supported", p = p)),
        }
        if !native_le {
            swap_to_le(&mut buf[..n * sz], sz, false);
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let s = &buf[i * sz..(i + 1) * sz];
            let raw: f64 = match d.dt {
                Dt::I16 => i16::from_le_bytes([s[0], s[1]]) as f64,
                Dt::U16 => u16::from_le_bytes([s[0], s[1]]) as f64,
                Dt::I32 => i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64,
                Dt::U32 => u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64,
                Dt::F32 => f32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64,
                Dt::F64 => f64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]),
            };
            let sample = if chunky { i % d.spp } else { plane };
            let is_nd = d.nodata.is_some_and(|nd| raw as f32 == nd);
            out.push(if !is_nd && sample < d.scale.len() { (raw * d.scale[sample] + d.offset[sample]) as f32 } else { raw as f32 });
        }
        let v = Rc::new(out);
        let mut c = self.cache.borrow_mut();
        let bytes = n * 4;
        while c.bytes + bytes > c.budget && c.bytes > 0 {
            // Evict the least recently used block.
            let mut oldest: Option<(usize, usize, u64)> = None;
            for (i, s) in c.slots.iter().enumerate() {
                for (j, e) in s.iter().enumerate() {
                    if let Some(e) = e {
                        if oldest.is_none_or(|o| e.1 < o.2) {
                            oldest = Some((i, j, e.1));
                        }
                    }
                }
            }
            let Some((i, j, _)) = oldest else { break };
            if let Some(e) = c.slots[i][j].take() {
                c.bytes -= e.0.len() * 4;
            }
        }
        c.bytes += bytes;
        let tick = c.tick;
        c.slots[ifd_idx][slot] = Some((v.clone(), tick));
        Ok(v)
    }

    /// Sample value at column x, TIFF row y (row 0 = first row in the file).
    pub fn value(&self, ifd_idx: usize, sample: usize, x: usize, y: usize) -> Result<f32> {
        let d = &self.ifds[ifd_idx];
        if x >= d.width || y >= d.height || sample >= d.spp {
            return Err(Error::range("grid index out of range"));
        }
        let bx = x / d.block_w;
        let by = y / d.block_h;
        let block = by * d.blocks_per_row() + bx;
        let (ox, oy) = (x % d.block_w, y % d.block_h);
        if d.planar == 2 {
            let b = self.block(ifd_idx, block, sample)?;
            Ok(b[oy * d.block_w + ox])
        } else {
            let b = self.block(ifd_idx, block, 0)?;
            Ok(b[(oy * d.block_w + ox) * d.spp + sample])
        }
    }
}

fn swap_to_le(buf: &mut [u8], sz: usize, already_le: bool) {
    if already_le || sz == 1 {
        return;
    }
    for c in buf.chunks_exact_mut(sz) {
        c.reverse();
    }
}

/// Undo horizontal differencing (predictor 2) on little-endian integers.
fn hor_acc(row: &mut [u8], sz: usize, stride: usize) {
    let n = row.len() / sz;
    for i in stride..n {
        match sz {
            2 => {
                let a = u16::from_le_bytes([row[(i - stride) * 2], row[(i - stride) * 2 + 1]]);
                let b = u16::from_le_bytes([row[i * 2], row[i * 2 + 1]]);
                row[i * 2..i * 2 + 2].copy_from_slice(&a.wrapping_add(b).to_le_bytes());
            }
            4 => {
                let p = (i - stride) * 4;
                let a = u32::from_le_bytes([row[p], row[p + 1], row[p + 2], row[p + 3]]);
                let q = i * 4;
                let b = u32::from_le_bytes([row[q], row[q + 1], row[q + 2], row[q + 3]]);
                row[q..q + 4].copy_from_slice(&a.wrapping_add(b).to_le_bytes());
            }
            8 => {
                let p = (i - stride) * 8;
                let q = i * 8;
                let mut a8 = [0u8; 8];
                let mut b8 = [0u8; 8];
                a8.copy_from_slice(&row[p..p + 8]);
                b8.copy_from_slice(&row[q..q + 8]);
                let s = u64::from_le_bytes(a8).wrapping_add(u64::from_le_bytes(b8));
                row[q..q + 8].copy_from_slice(&s.to_le_bytes());
            }
            _ => {}
        }
    }
}

/// Undo the floating-point predictor (predictor 3, libtiff `fpAcc`): bytes are differenced
/// with a stride of the samples per pixel, then stored by significance (most significant
/// byte plane first). The output is little-endian.
fn fp_acc(row: &mut [u8], bps: usize, stride: usize) {
    let cc = row.len();
    for i in stride..cc {
        row[i] = row[i].wrapping_add(row[i - stride]);
    }
    let wc = cc / bps;
    let tmp = row.to_vec();
    for count in 0..wc {
        for byte in 0..bps {
            row[bps * count + byte] = tmp[(bps - byte - 1) * wc + count];
        }
    }
}

/// TIFF LZW (MSB-first codes, early change), as libtiff writes it.
fn lzw_decode(src: &[u8], expect: usize) -> Result<Vec<u8>> {
    const CLEAR: usize = 256;
    const EOI: usize = 257;
    let mut out = Vec::with_capacity(expect);
    let mut prefix: Vec<u16> = vec![0; 4096];
    let mut suffix: Vec<u8> = vec![0; 4096];
    let mut first: Vec<u8> = vec![0; 4096];
    let mut len: Vec<u16> = vec![0; 4096];
    for i in 0..256 {
        suffix[i] = i as u8;
        first[i] = i as u8;
        len[i] = 1;
    }
    let mut next = 258usize;
    let mut width = 9u32;
    let mut old: Option<usize> = None;
    let (mut acc, mut nbits, mut pos) = (0u32, 0u32, 0usize);
    let mut stack: Vec<u8> = Vec::with_capacity(4096);
    loop {
        while nbits < width {
            if pos >= src.len() {
                return Ok(out);
            }
            acc = (acc << 8) | src[pos] as u32;
            pos += 1;
            nbits += 8;
        }
        let code = ((acc >> (nbits - width)) & ((1 << width) - 1)) as usize;
        nbits -= width;
        if code == EOI {
            break;
        }
        if code == CLEAR {
            next = 258;
            width = 9;
            old = None;
            continue;
        }
        fn emit(prefix: &[u16], suffix: &[u8], len: &[u16], c: usize, stack: &mut Vec<u8>, out: &mut Vec<u8>) {
            stack.clear();
            let mut k = c;
            loop {
                stack.push(suffix[k]);
                if len[k] <= 1 {
                    break;
                }
                k = prefix[k] as usize;
            }
            out.extend(stack.iter().rev());
        }
        match old {
            None => {
                if code > 255 {
                    return Err(Error::invalid("TIFF: corrupt LZW data"));
                }
                out.push(code as u8);
            }
            Some(o) => {
                if code < next {
                    emit(&prefix, &suffix, &len, code, &mut stack, &mut out);
                    if next < 4096 {
                        prefix[next] = o as u16;
                        suffix[next] = first[code];
                        first[next] = first[o];
                        len[next] = len[o] + 1;
                        next += 1;
                    }
                } else if code == next && next < 4096 {
                    prefix[next] = o as u16;
                    suffix[next] = first[o];
                    first[next] = first[o];
                    len[next] = len[o] + 1;
                    next += 1;
                    emit(&prefix, &suffix, &len, code, &mut stack, &mut out);
                } else {
                    return Err(Error::invalid("TIFF: corrupt LZW data"));
                }
            }
        }
        old = Some(code);
        if out.len() >= expect {
            break;
        }
        // Early change: the width grows one code before the table fills.
        if next + 1 >= (1 << width) && width < 12 {
            width += 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Write a minimal little-endian TIFF (for tests): one or more IFDs of float32 samples,
    /// stripped, uncompressed or with the floating-point predictor + DEFLATE.
    pub fn write_tiff(ifds: &[(usize, usize, usize, Vec<f32>, String, Option<String>)], deflate_fp: bool) -> Vec<u8> {
        let mut out = vec![b'I', b'I', 42, 0, 0, 0, 0, 0];
        let mut prev_next_pos = 4usize;
        for (w, h, spp, vals, meta, nodata) in ifds {
            let (w, h, spp) = (*w, *h, *spp);
            // strip data
            let mut row_bytes = Vec::new();
            for r in 0..h {
                let mut row: Vec<u8> = vals[r * w * spp..(r + 1) * w * spp].iter().flat_map(|v| v.to_le_bytes()).collect();
                if deflate_fp {
                    // forward fp predictor: reorder by significance, then difference
                    let wc = w * spp;
                    let mut tmp = vec![0u8; row.len()];
                    for count in 0..wc {
                        for byte in 0..4 {
                            tmp[(4 - byte - 1) * wc + count] = row[4 * count + byte];
                        }
                    }
                    for i in (spp..tmp.len()).rev() {
                        tmp[i] = tmp[i].wrapping_sub(tmp[i - spp]);
                    }
                    row = tmp;
                }
                row_bytes.extend(row);
            }
            let strip = if deflate_fp { miniz_oxide::deflate::compress_to_vec_zlib(&row_bytes, 6) } else { row_bytes };
            let strip_off = out.len();
            out.extend(&strip);
            while out.len() % 2 == 1 {
                out.push(0);
            }
            let meta_off = out.len();
            out.extend(meta.as_bytes());
            out.push(0);
            let nd_off = out.len();
            if let Some(n) = nodata {
                out.extend(n.as_bytes());
                out.push(0);
            }
            while out.len() % 2 == 1 {
                out.push(0);
            }
            let scale_off = out.len();
            for v in [1.0f64 / 60.0, 1.0 / 60.0, 0.0] {
                out.extend(v.to_le_bytes());
            }
            let tie_off = out.len();
            for v in [0.0f64, 0.0, 0.0, -10.0, 50.0, 0.0] {
                out.extend(v.to_le_bytes());
            }
            let geokeys: [u16; 12] = [1, 1, 0, 2, 1024, 0, 1, 2, 1025, 0, 1, 2];
            let gk_off = out.len();
            for g in geokeys {
                out.extend(g.to_le_bytes());
            }
            let bps_off = out.len();
            for _ in 0..spp {
                out.extend(32u16.to_le_bytes());
            }
            let sf_off = out.len();
            for _ in 0..spp {
                out.extend(3u16.to_le_bytes());
            }
            let ifd_off = out.len();
            out[prev_next_pos..prev_next_pos + 4].copy_from_slice(&(ifd_off as u32).to_le_bytes());
            let mut entries: Vec<(u16, u16, u32, u32)> = vec![
                (256, 4, 1, w as u32),
                (257, 4, 1, h as u32),
                (258, 3, spp as u32, if spp <= 2 { 32 } else { bps_off as u32 }),
                (259, 3, 1, if deflate_fp { 8 } else { 1 }),
                (262, 3, 1, 1),
                (273, 4, 1, strip_off as u32),
                (277, 3, 1, spp as u32),
                (278, 4, 1, h as u32),
                (279, 4, 1, strip.len() as u32),
                (284, 3, 1, 1),
                (317, 3, 1, if deflate_fp { 3 } else { 1 }),
                (339, 3, spp as u32, if spp <= 2 { 3 } else { sf_off as u32 }),
                (33550, 12, 3, scale_off as u32),
                (33922, 12, 6, tie_off as u32),
                (34735, 3, 12, gk_off as u32),
                (42112, 2, meta.len() as u32 + 1, meta_off as u32),
            ];
            if let Some(n) = nodata {
                entries.push((42113, 2, n.len() as u32 + 1, nd_off as u32));
            }
            entries.sort_by_key(|e| e.0);
            out.extend((entries.len() as u16).to_le_bytes());
            for (tag, t, c, v) in entries {
                out.extend(tag.to_le_bytes());
                out.extend(t.to_le_bytes());
                out.extend(c.to_le_bytes());
                if t == 3 && c == 1 {
                    out.extend((v as u16).to_le_bytes());
                    out.extend([0, 0]);
                } else if t == 3 && c == 2 {
                    out.extend((v as u16).to_le_bytes());
                    out.extend((v as u16).to_le_bytes());
                } else {
                    out.extend(v.to_le_bytes());
                }
            }
            prev_next_pos = out.len();
            out.extend([0, 0, 0, 0]);
        }
        out
    }

    #[test]
    fn reads_plain_and_predicted_deflate() {
        let (w, h) = (7, 5);
        let vals: Vec<f32> = (0..w * h * 2).map(|i| (i as f32) * 0.37 - 3.0).collect();
        for deflate in [false, true] {
            let t = write_tiff(&[(w, h, 2, vals.clone(), String::new(), None)], deflate);
            let f = TiffFile::parse(t, 1 << 20).unwrap();
            assert_eq!(f.ifds.len(), 1);
            for y in 0..h {
                for x in 0..w {
                    for s in 0..2 {
                        assert_eq!(f.value(0, s, x, y).unwrap(), vals[(y * w + x) * 2 + s]);
                    }
                }
            }
        }
    }

    #[test]
    fn lzw_round_trip_known_stream() {
        // "TOBEORNOTTOBEORTOBEORNOT" through a small encoder.
        let input = b"TOBEORNOTTOBEORTOBEORNOT#";
        let enc = lzw_encode(input);
        assert_eq!(lzw_decode(&enc, input.len()).unwrap(), input);
        let big: Vec<u8> = (0..20000u32).map(|i| ((i * 7) % 13) as u8).collect();
        assert_eq!(lzw_decode(&lzw_encode(&big), big.len()).unwrap(), big);
    }

    fn lzw_encode(src: &[u8]) -> Vec<u8> {
        let mut dict: std::collections::HashMap<Vec<u8>, usize> = (0..256).map(|i| (vec![i as u8], i)).collect();
        let mut next = 258usize;
        let mut width = 9u32;
        let mut bits: Vec<(usize, u32)> = vec![(256, 9)];
        let mut w: Vec<u8> = Vec::new();
        for &c in src {
            let mut wc = w.clone();
            wc.push(c);
            if dict.contains_key(&wc) {
                w = wc;
            } else {
                bits.push((dict[&w], width));
                dict.insert(wc, next);
                next += 1;
                if next + 1 > (1 << width) && width < 12 {
                    width += 1;
                }
                w = vec![c];
            }
        }
        bits.push((dict[&w], width));
        bits.push((257, width));
        let (mut out, mut acc, mut n) = (Vec::new(), 0u64, 0u32);
        for (code, wd) in bits {
            acc = (acc << wd) | code as u64;
            n += wd;
            while n >= 8 {
                out.push((acc >> (n - 8)) as u8);
                n -= 8;
            }
        }
        if n > 0 {
            out.push((acc << (8 - n)) as u8);
        }
        out
    }

    #[test]
    fn rejects_garbage() {
        assert!(TiffFile::parse(vec![0; 64], 1 << 20).is_err());
        let mut t = write_tiff(&[(3, 3, 1, vec![0.0; 9], String::new(), None)], false);
        t.truncate(t.len() - 40);
        assert!(TiffFile::parse(t, 1 << 20).is_err());
    }
}
