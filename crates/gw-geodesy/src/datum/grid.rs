//! Grid sets for datum and height transformations (REQ-GAP-16), with PROJ's semantics
//! (`src/grids.cpp`, PROJ 9.9): extents in radians at the centres of the corner nodes, nested
//! sub-grids found by name or by extent, rows counted from the south, and the same rules for
//! nodata. Formats: GeoTIFF (PROJ-data), NTv2 (`.gsb`) and GTX (`.gtx`).

use super::tiff::{Meta, TiffFile, VecMap};
use gw_abi::{Error, Result};
use std::f64::consts::PI;
use std::rc::Rc;

pub const DEG_TO_RAD: f64 = PI / 180.0;
pub const ARCSEC_TO_RAD: f64 = (PI / 180.0) / 3600.0;
/// PROJ `REL_TOLERANCE_HGRIDSHIFT`.
pub const REL_TOL: f64 = 1e-5;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Extent {
    pub geographic: bool,
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
    pub res_x: f64,
    pub res_y: f64,
    pub inv_res_x: f64,
    pub inv_res_y: f64,
}

impl Extent {
    fn inv(mut self) -> Self {
        self.inv_res_x = 1.0 / self.res_x;
        self.inv_res_y = 1.0 / self.res_y;
        self
    }
    pub fn full_world_longitude(&self) -> bool {
        self.geographic && self.east - self.west + self.res_x >= 2.0 * PI - 1e-10
    }
    pub fn contains(&self, o: &Extent) -> bool {
        o.west >= self.west && o.east <= self.east && o.south >= self.south && o.north <= self.north
    }
    /// PROJ `isPointInExtent`.
    pub fn point_in(&self, mut x: f64, y: f64, eps: f64) -> bool {
        if !(y + eps >= self.south && y - eps <= self.north) {
            return false;
        }
        if self.full_world_longitude() {
            return true;
        }
        if self.geographic {
            if x + eps < self.west {
                x += 2.0 * PI;
            } else if x - eps > self.east {
                x -= 2.0 * PI;
            }
        }
        x + eps >= self.west && x - eps <= self.east
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Format {
    GTiff,
    Ntv2,
    Gtx,
}

/// What a grid set is opened for: horizontal offsets (`hgridshift`), a height offset
/// (`vgridshift`) or PROJ's generic `gridshift` (NADCON5, 3D offsets, biquadratic).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Role {
    Horizontal,
    Vertical,
    Generic,
}

enum Src {
    Tiff { file: Rc<TiffFile>, ifd: usize, bottom_up: bool },
    /// Row-major from the south row, samples interleaved.
    Dense(Vec<f32>),
}

pub struct Grid {
    pub name: String,
    pub width: i32,
    pub height: i32,
    pub extent: Extent,
    pub samples: usize,
    pub children: Vec<Grid>,
    meta: Meta,
    nodata: Option<f32>,
    src: Src,
    // Role-specific sample layout.
    pub idx_lat: usize,
    pub idx_lon: usize,
    pub idx_z: Option<usize>,
    pub conv_to_rad: f64,
    pub positive_east: bool,
    /// Generic grids: TYPE (inherited from the first IFD when absent) and interpolation.
    pub gtype: String,
    pub biquadratic: bool,
    /// Generic grids: the first IFD's metadata used as a fallback (PROJ `setFirstGrid`).
    first_meta: Option<Meta>,
    pub fast_path: bool,
}

impl Grid {
    pub fn meta(&self, key: &str, sample: i32) -> &str {
        let k = (sample, key.to_string());
        if let Some(v) = self.meta.get(&k) {
            return v;
        }
        self.first_meta.as_ref().and_then(|m| m.get(&k)).map_or("", |s| s.as_str())
    }

    /// Raw sample (after band scale and offset) at column x and row y counted from the south.
    pub fn raw(&self, sample: usize, x: i32, y: i32) -> Option<f32> {
        if x < 0 || y < 0 || x >= self.width || y >= self.height || sample >= self.samples {
            return None;
        }
        match &self.src {
            Src::Tiff { file, ifd, bottom_up } => {
                let yt = if *bottom_up { y } else { self.height - 1 - y };
                file.value(*ifd, sample, x as usize, yt as usize).ok()
            }
            Src::Dense(v) => v.get((y as usize * self.width as usize + x as usize) * self.samples + sample).copied(),
        }
    }

    /// PROJ `GTiffGrid::isNodata` (GeoTIFF) or the GTX rule.
    pub fn is_nodata(&self, v: f32, multiplier: f64) -> bool {
        match self.fmt() {
            Format::Gtx => (v as f64) * multiplier > 1000.0 || (v as f64) * multiplier < -1000.0 || v == -88.8888_f32,
            _ => self.nodata.is_some_and(|n| v == n) || v.is_nan(),
        }
    }

    fn fmt(&self) -> Format {
        match &self.src {
            Src::Tiff { .. } => Format::GTiff,
            Src::Dense(_) if self.idx_z.is_some() && self.samples == 1 => Format::Gtx,
            Src::Dense(_) => Format::Ntv2,
        }
    }

    /// Horizontal shift at a node as PROJ's `valueAt` returns it: (longitude, latitude) in
    /// radians, single precision, longitude positive east.
    pub fn hvalue(&self, x: i32, y: i32) -> Option<(f32, f32)> {
        match self.fmt() {
            Format::GTiff => {
                let lat = self.raw(self.idx_lat, x, y)?;
                let lon = self.raw(self.idx_lon, x, y)?;
                let lat = (lat as f64 * self.conv_to_rad) as f32;
                let mut lon = (lon as f64 * self.conv_to_rad) as f32;
                if !self.positive_east {
                    lon = -lon;
                }
                Some((lon, lat))
            }
            Format::Ntv2 => {
                let lat = self.raw(0, x, y)?;
                let lon = self.raw(1, x, y)?;
                // NTv2 is positive west; hgridshift compensates the convention.
                Some((-((lon as f64 * ARCSEC_TO_RAD) as f32), (lat as f64 * ARCSEC_TO_RAD) as f32))
            }
            Format::Gtx => None,
        }
    }

    /// The deepest grid of this hierarchy holding a point (PROJ `gridAt`); eps scaled per
    /// child for horizontal grids.
    pub fn grid_at(&self, lon: f64, lat: f64, horizontal: bool) -> &Grid {
        for c in &self.children {
            let eps = if horizontal { (c.extent.res_x + c.extent.res_y) * REL_TOL } else { 0.0 };
            if c.extent.point_in(lon, lat, eps) {
                return c.grid_at(lon, lat, horizontal);
            }
        }
        self
    }

    fn insert(&mut self, sub: Grid) {
        for c in &mut self.children {
            if c.extent.contains(&sub.extent) {
                c.insert(sub);
                return;
            }
        }
        self.children.push(sub);
    }

    pub fn count(&self) -> usize {
        1 + self.children.iter().map(Grid::count).sum::<usize>()
    }
}

/// A set of top-level grids from one file.
pub struct GridSet {
    pub name: String,
    pub format: Format,
    pub role: Role,
    pub grids: Vec<Grid>,
    tiff: Option<Rc<TiffFile>>,
}

impl GridSet {
    /// Open a grid file. GeoTIFF serves every role; NTv2 is horizontal only and GTX
    /// vertical only, as in PROJ.
    pub fn open(name: &str, bytes: Vec<u8>, role: Role, cache_budget: usize) -> Result<Self> {
        if TiffFile::is_tiff(&bytes) {
            let f = Rc::new(TiffFile::parse(bytes, cache_budget)?);
            return Self::from_tiff(name, f, role);
        }
        if bytes.len() >= 176 && &bytes[0..8] == b"NUM_OREC" {
            if role != Role::Horizontal {
                return Err(Error::unsupported("an NTv2 file holds horizontal offsets only"));
            }
            return Self::ntv2(name, &bytes);
        }
        if role == Role::Vertical && bytes.len() >= 40 {
            return Self::gtx(name, &bytes);
        }
        Err(Error::invalid("not a GeoTIFF, NTv2 or GTX grid file"))
    }

    pub fn tiff_cached_bytes(&self) -> usize {
        self.tiff.as_ref().map_or(0, |t| t.cached_bytes())
    }

    fn from_tiff(name: &str, f: Rc<TiffFile>, role: Role) -> Result<Self> {
        let mut tops: Vec<Grid> = Vec::new();
        // name → path of indices into the hierarchy
        let mut by_name: VecMap<String, Vec<usize>> = VecMap::new();
        let multi = f.ifds.len() > 1;
        let first_meta = f.ifds[0].meta.clone();
        for (k, d) in f.ifds.iter().enumerate() {
            if d.subfile_type != 0 && d.subfile_type != 2 {
                if k == 0 {
                    return Err(Error::invalid("invalid subfileType"));
                }
                continue;
            }
            let extent = tiff_extent(d).ok_or_else(|| gw_abi::err!(INVALID, "{file}: inconsistent georeferencing", file = name.to_string()))?;
            let bottom_up = tiff_bottom_up(d);
            let mut gname = name.to_string();
            if let Some(g) = d.meta.get(&(-1, "grid_name".to_string())) {
                gname.push_str(", ");
                gname.push_str(g);
            }
            if multi {
                gname.push_str(&format!(" (index {})", k + 1));
            }
            let mut g = Grid {
                name: gname,
                width: d.width as i32,
                height: d.height as i32,
                extent,
                samples: d.spp,
                children: Vec::new(),
                meta: d.meta.clone(),
                nodata: d.nodata,
                src: Src::Tiff { file: f.clone(), ifd: k, bottom_up },
                idx_lat: 0,
                idx_lon: 1,
                idx_z: None,
                conv_to_rad: ARCSEC_TO_RAD,
                positive_east: true,
                gtype: String::new(),
                biquadratic: false,
                first_meta: None,
                fast_path: d.fast_path(),
            };
            match role {
                Role::Horizontal => {
                    if d.spp < 2 {
                        if k == 0 {
                            return Err(Error::invalid("a horizontal grid needs at least 2 samples per node"));
                        }
                        continue;
                    }
                    let (mut any, mut flat, mut flon) = (false, false, false);
                    for i in 0..d.spp {
                        let desc = d.meta("DESCRIPTION", i as i32);
                        any |= !desc.is_empty();
                        if desc == "latitude_offset" {
                            g.idx_lat = i;
                            flat = true;
                        } else if desc == "longitude_offset" {
                            g.idx_lon = i;
                            flon = true;
                        }
                    }
                    if any && !flat && !flon {
                        if k > 0 {
                            continue;
                        }
                        return Err(Error::invalid("the grid has no latitude_offset/longitude_offset bands"));
                    }
                    if flat != flon {
                        return Err(Error::invalid("the grid has only one of latitude_offset and longitude_offset"));
                    }
                    if flon {
                        match d.meta("positive_value", g.idx_lon as i32) {
                            "" | "east" => {}
                            "west" => g.positive_east = false,
                            v => return Err(gw_abi::err!(UNSUPPORTED, "unsupported positive_value {v}", v = v.to_string())),
                        }
                    }
                    let (ua, ub) = (d.meta("UNITTYPE", g.idx_lat as i32), d.meta("UNITTYPE", g.idx_lon as i32));
                    if ua != ub {
                        return Err(Error::invalid("different units for the longitude and latitude offsets"));
                    }
                    g.conv_to_rad = match ua {
                        "" | "arc-second" | "arc-seconds per year" => ARCSEC_TO_RAD,
                        "radian" => 1.0,
                        "degree" => DEG_TO_RAD,
                        u => return Err(gw_abi::err!(UNSUPPORTED, "unsupported offset unit {u}", u = u.to_string())),
                    };
                }
                Role::Vertical => {
                    let (mut any, mut found) = (false, false);
                    let mut idx = 0;
                    for i in 0..d.spp {
                        let desc = d.meta("DESCRIPTION", i as i32);
                        any |= !desc.is_empty();
                        if matches!(desc, "geoid_undulation" | "vertical_offset" | "hydroid_height" | "ellipsoidal_height_offset") {
                            idx = i;
                            found = true;
                        }
                    }
                    if any && !found {
                        if k > 0 {
                            continue;
                        }
                        return Err(Error::invalid("the grid has no geoid_undulation or vertical_offset band"));
                    }
                    g.idx_z = Some(idx);
                }
                Role::Generic => {
                    if k > 0 && g.meta.get(&(-1, "TYPE".to_string())).is_none() && !first_meta.get(&(-1, "TYPE".to_string())).is_none_or(|t| t.is_empty()) {
                        g.first_meta = Some(first_meta.clone());
                    }
                    g.gtype = g.meta("TYPE", -1).to_string();
                    generic_layout(&mut g)?;
                }
            }
            let gridname = d.meta("grid_name", -1).to_string();
            let parent = d.meta("parent_grid_name", -1).to_string();
            insert_hierarchy(&mut tops, &mut by_name, g, &gridname, &parent);
        }
        if tops.is_empty() {
            return Err(Error::invalid("the file holds no usable grid"));
        }
        Ok(GridSet { name: name.to_string(), format: Format::GTiff, role, grids: tops, tiff: Some(f) })
    }

    fn ntv2(name: &str, b: &[u8]) -> Result<Self> {
        if &b[56..63] != b"SECONDS" {
            return Err(Error::unsupported("only NTv2 GS_TYPE=SECONDS is supported"));
        }
        let le = b[8] == 11;
        let u32_at = |o: usize| -> Result<u32> {
            let s = b.get(o..o + 4).ok_or_else(|| Error::invalid("NTv2: truncated"))?;
            let a = [s[0], s[1], s[2], s[3]];
            Ok(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
        };
        let f64_at = |o: usize| -> Result<f64> {
            let s = b.get(o..o + 8).ok_or_else(|| Error::invalid("NTv2: truncated"))?;
            let mut a = [0u8; 8];
            a.copy_from_slice(s);
            Ok(f64::from_bits(if le { u64::from_le_bytes(a) } else { u64::from_be_bytes(a) }))
        };
        let f32_at = |o: usize| -> Result<f32> { Ok(f32::from_bits(u32_at(o)?)) };
        let nsub = u32_at(40)? as usize;
        if nsub == 0 || nsub > 10_000 {
            return Err(Error::invalid("NTv2: bad sub-file count"));
        }
        let mut pos = 176usize;
        let mut tops: Vec<Grid> = Vec::new();
        let mut by_name: VecMap<String, Vec<usize>> = VecMap::new();
        for _ in 0..nsub {
            let h = b.get(pos..pos + 176).ok_or_else(|| Error::invalid("NTv2: truncated sub-file header"))?;
            if &h[0..8] != b"SUB_NAME" {
                return Err(Error::invalid("NTv2: bad sub-file header"));
            }
            let sub = String::from_utf8_lossy(&h[8..16]).to_string();
            let parent = String::from_utf8_lossy(&h[24..32]).to_string();
            let o = pos + 8 + 16 * 4;
            let e = Extent {
                geographic: true,
                south: f64_at(o)? * DEG_TO_RAD / 3600.0,
                north: f64_at(o + 16)? * DEG_TO_RAD / 3600.0,
                east: -f64_at(o + 32)? * DEG_TO_RAD / 3600.0,
                west: -f64_at(o + 48)? * DEG_TO_RAD / 3600.0,
                res_y: f64_at(o + 64)? * DEG_TO_RAD / 3600.0,
                res_x: f64_at(o + 80)? * DEG_TO_RAD / 3600.0,
                ..Default::default()
            }
            .inv();
            if !(e.west.abs() <= 4.0 * PI && e.east.abs() <= 4.0 * PI && e.north.abs() <= PI + 1e-5 && e.south.abs() <= PI + 1e-5 && e.west < e.east && e.south < e.north && e.res_x > 1e-10 && e.res_y > 1e-10) {
                return Err(gw_abi::err!(INVALID, "{file}: inconsistent georeferencing", file = name.to_string()));
            }
            let cols = ((e.east - e.west) * e.inv_res_x + 0.5).abs() as usize + 1;
            let rows = ((e.north - e.south) * e.inv_res_y + 0.5).abs() as usize + 1;
            let gs = u32_at(pos + 8 + 16 * 10)? as usize;
            if gs / cols != rows {
                return Err(Error::invalid("NTv2: GS_COUNT does not match the grid size"));
            }
            pos += 176;
            let need = rows * cols * 16;
            if b.len() < pos + need {
                return Err(Error::invalid("NTv2: truncated grid"));
            }
            let mut v = vec![0f32; rows * cols * 2];
            for r in 0..rows {
                for c in 0..cols {
                    let src = pos + (r * cols + c) * 16;
                    // NTv2 runs east to west: column c from the east is (cols - 1 - c) from the west.
                    let dst = (r * cols + (cols - 1 - c)) * 2;
                    v[dst] = f32_at(src)?;
                    v[dst + 1] = f32_at(src + 4)?;
                }
            }
            pos += need;
            let g = Grid {
                name: format!("{name}, {sub}"),
                width: cols as i32,
                height: rows as i32,
                extent: e,
                samples: 2,
                children: Vec::new(),
                meta: Meta::new(),
                nodata: None,
                src: Src::Dense(v),
                idx_lat: 0,
                idx_lon: 1,
                idx_z: None,
                conv_to_rad: ARCSEC_TO_RAD,
                positive_east: false,
                gtype: "HORIZONTAL_OFFSET".into(),
                biquadratic: false,
                first_meta: None,
                fast_path: false,
            };
            // NTv2: a sub-grid attaches to its named parent; otherwise it is a top grid.
            match by_name.get(&parent).cloned() {
                Some(path) => {
                    let p = node_mut(&mut tops, &path);
                    p.children.push(g);
                    let mut np = path.clone();
                    np.push(p.children.len() - 1);
                    by_name.insert(sub, np);
                }
                None => {
                    tops.push(g);
                    by_name.insert(sub, vec![tops.len() - 1]);
                }
            }
        }
        Ok(GridSet { name: name.to_string(), format: Format::Ntv2, role: Role::Horizontal, grids: tops, tiff: None })
    }

    fn gtx(name: &str, b: &[u8]) -> Result<Self> {
        let f = |o: usize| f64::from_be_bytes([b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6], b[o + 7]]);
        let (mut x0, y0, dy, dx) = (f(8), f(0), f(16), f(24));
        let rows = i32::from_be_bytes([b[32], b[33], b[34], b[35]]);
        let cols = i32::from_be_bytes([b[36], b[37], b[38], b[39]]);
        if cols <= 0 || rows <= 0 || !(-360.0..=360.0).contains(&x0) || !(-90.0..=90.0).contains(&y0) {
            return Err(Error::invalid("GTX header has invalid extents"));
        }
        let n = rows as usize * cols as usize;
        if b.len() < 40 + 4 * n {
            return Err(Error::invalid("GTX: truncated grid"));
        }
        if x0 >= 180.0 {
            x0 -= 360.0;
        }
        let e = Extent {
            geographic: true,
            west: x0 * DEG_TO_RAD,
            south: y0 * DEG_TO_RAD,
            res_x: dx * DEG_TO_RAD,
            res_y: dy * DEG_TO_RAD,
            east: (x0 + dx * (cols - 1) as f64) * DEG_TO_RAD,
            north: (y0 + dy * (rows - 1) as f64) * DEG_TO_RAD,
            ..Default::default()
        }
        .inv();
        let v = (0..n).map(|i| f32::from_be_bytes([b[40 + 4 * i], b[41 + 4 * i], b[42 + 4 * i], b[43 + 4 * i]])).collect();
        let g = Grid {
            name: name.to_string(),
            width: cols,
            height: rows,
            extent: e,
            samples: 1,
            children: Vec::new(),
            meta: Meta::new(),
            nodata: None,
            src: Src::Dense(v),
            idx_lat: 0,
            idx_lon: 0,
            idx_z: Some(0),
            conv_to_rad: 1.0,
            positive_east: true,
            gtype: "VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL".into(),
            biquadratic: false,
            first_meta: None,
            fast_path: false,
        };
        Ok(GridSet { name: name.to_string(), format: Format::Gtx, role: Role::Vertical, grids: vec![g], tiff: None })
    }

    /// PROJ `HorizontalShiftGridSet::gridAt` / `VerticalShiftGridSet::gridAt`.
    pub fn grid_at(&self, lon: f64, lat: f64) -> Option<&Grid> {
        let horizontal = self.role == Role::Horizontal;
        for g in &self.grids {
            let eps = if horizontal { (g.extent.res_x + g.extent.res_y) * REL_TOL } else { 0.0 };
            if g.extent.point_in(lon, lat, eps) {
                return Some(g.grid_at(lon, lat, horizontal));
            }
        }
        None
    }

    /// PROJ `GenericShiftGridSet::gridAt(type, x, y)`.
    pub fn grid_at_type(&self, ty: &str, x: f64, y: f64) -> Option<&Grid> {
        for g in &self.grids {
            if g.gtype != ty {
                continue;
            }
            if g.extent.point_in(x, y, 0.0) {
                return Some(g.grid_at(x, y, false));
            }
        }
        None
    }

    /// Every grid of the set, depth first.
    pub fn all(&self) -> Vec<&Grid> {
        fn walk<'a>(g: &'a Grid, out: &mut Vec<&'a Grid>) {
            out.push(g);
            for c in &g.children {
                walk(c, out);
            }
        }
        let mut out = Vec::new();
        for g in &self.grids {
            walk(g, &mut out);
        }
        out
    }
}

fn node_mut<'a>(tops: &'a mut [Grid], path: &[usize]) -> &'a mut Grid {
    let mut g = &mut tops[path[0]];
    for &i in &path[1..] {
        g = &mut g.children[i];
    }
    g
}

/// PROJ `insertIntoHierarchy`: by grid_name / parent_grid_name when present, else by extent.
fn insert_hierarchy(tops: &mut Vec<Grid>, by_name: &mut VecMap<String, Vec<usize>>, g: Grid, gridname: &str, parent: &str) {
    if !parent.is_empty() {
        if let Some(path) = by_name.get(&parent.to_string()).cloned() {
            let p = node_mut(tops, &path);
            if p.extent.contains(&g.extent) {
                p.children.push(g);
                if !gridname.is_empty() {
                    let mut np = path;
                    np.push(p.children.len() - 1);
                    by_name.insert(gridname.to_string(), np);
                }
                return;
            }
        }
    } else if !gridname.is_empty() {
        tops.push(g);
        by_name.insert(gridname.to_string(), vec![tops.len() - 1]);
        return;
    }
    let ty = g.meta("TYPE", -1).to_string();
    for t in tops.iter_mut() {
        if !ty.is_empty() && t.meta("TYPE", -1) != ty {
            continue;
        }
        if t.extent.contains(&g.extent) {
            t.insert(g);
            return;
        }
    }
    tops.push(g);
}

/// Extent of a GeoTIFF grid IFD as PROJ computes it (centres of the corner nodes, radians).
fn tiff_extent(d: &super::tiff::Ifd) -> Option<Extent> {
    let mut geographic = true;
    let mut area = false;
    let k = &d.geokeys;
    if k.len() >= 4 {
        let mut i = 4;
        while i + 3 < k.len() {
            if k[i] == 1024 {
                if k[i + 3] == 1 {
                    geographic = false;
                } else if k[i + 3] != 2 {
                    return None;
                }
            } else if k[i] == 1025 && k[i + 3] == 1 {
                area = true;
            }
            i += 4;
        }
    }
    let (mut west, h_res, mut north, v_res) = if let Some(m) = &d.matrix {
        if m[1] != 0.0 || m[4] != 0.0 {
            return None;
        }
        (m[3], m[0], m[7], -m[5])
    } else {
        let s = d.pixel_scale?;
        let t = d.tiepoint?;
        (t[3] - t[0] * s[0], s[0], t[4] + t[1] * s[1], s[1])
    };
    if area {
        west += 0.5 * h_res;
        north -= 0.5 * v_res;
    }
    let mul = if geographic { DEG_TO_RAD } else { 1.0 };
    let mut e = Extent {
        geographic,
        west: west * mul,
        north: north * mul,
        res_x: h_res * mul,
        res_y: v_res.abs() * mul,
        east: (west + h_res * (d.width - 1) as f64) * mul,
        south: (north - v_res * (d.height - 1) as f64) * mul,
        ..Default::default()
    }
    .inv();
    if v_res < 0.0 {
        std::mem::swap(&mut e.north, &mut e.south);
    }
    let ok = (!geographic || (e.west.abs() <= 4.0 * PI && e.east.abs() <= 4.0 * PI && e.north.abs() <= PI + 1e-5 && e.south.abs() <= PI + 1e-5)) && e.west < e.east && e.south < e.north && e.res_x > 1e-10 && e.res_y > 1e-10;
    ok.then_some(e)
}

fn tiff_bottom_up(d: &super::tiff::Ifd) -> bool {
    if let Some(m) = &d.matrix {
        -m[5] < 0.0
    } else {
        d.pixel_scale.is_some_and(|s| s[1] < 0.0)
    }
}

/// PROJ `gridshiftData::grid_interpolate` sample discovery.
fn generic_layout(g: &mut Grid) -> Result<()> {
    let projected = !g.extent.geographic;
    let (mut ix, mut iy, mut iz) = (None, None, None);
    for i in 0..g.samples {
        let desc = g.meta("DESCRIPTION", i as i32).to_string();
        let unit = g.meta("UNITTYPE", i as i32).to_string();
        match desc.as_str() {
            "latitude_offset" if !projected => {
                if !unit.is_empty() && unit != "arc-second" {
                    return Err(Error::unsupported("gridshift: only arc-second offsets are handled"));
                }
                iy = Some(i);
            }
            "longitude_offset" if !projected => {
                if !unit.is_empty() && unit != "arc-second" {
                    return Err(Error::unsupported("gridshift: only arc-second offsets are handled"));
                }
                ix = Some(i);
            }
            "ellipsoidal_height_offset" | "geoid_undulation" | "hydroid_height" | "vertical_offset" => {
                if !unit.is_empty() && unit != "metre" {
                    return Err(Error::unsupported("gridshift: only metre height offsets are handled"));
                }
                iz = Some(i);
            }
            _ => {}
        }
    }
    if projected {
        return Err(Error::unsupported("grids in projected coordinates are not supported"));
    }
    if g.samples >= 2 && ix.is_none() && iy.is_none() && g.gtype == "HORIZONTAL_OFFSET" {
        ix = Some(1);
        iy = Some(0);
    }
    if matches!(g.gtype.as_str(), "HORIZONTAL_OFFSET" | "GEOGRAPHIC_3D_OFFSET") && (ix.is_none() || iy.is_none()) {
        return Err(Error::invalid("gridshift: the grid lacks its offset bands"));
    }
    if matches!(g.gtype.as_str(), "ELLIPSOIDAL_HEIGHT_OFFSET" | "VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL" | "VERTICAL_OFFSET_VERTICAL_TO_VERTICAL" | "GEOGRAPHIC_3D_OFFSET") && iz.is_none() {
        return Err(Error::invalid("gridshift: the grid lacks its height band"));
    }
    if !matches!(g.gtype.as_str(), "HORIZONTAL_OFFSET" | "GEOGRAPHIC_3D_OFFSET" | "ELLIPSOIDAL_HEIGHT_OFFSET" | "VERTICAL_OFFSET_GEOGRAPHIC_TO_VERTICAL" | "VERTICAL_OFFSET_VERTICAL_TO_VERTICAL") {
        return Err(Error::invalid("gridshift: missing or unknown TYPE metadata"));
    }
    g.idx_lat = iy.unwrap_or(0);
    g.idx_lon = ix.unwrap_or(0);
    g.idx_z = iz;
    if ix.is_none() {
        // vertical-only generic grid: no horizontal samples
        g.idx_lat = usize::MAX;
        g.idx_lon = usize::MAX;
    }
    let interp = g.meta("interpolation_method", -1).to_string();
    let interp = if interp.is_empty() { "bilinear".to_string() } else { interp };
    if interp != "bilinear" && interp != "biquadratic" {
        return Err(Error::unsupported("gridshift: unsupported interpolation_method"));
    }
    g.biquadratic = interp == "biquadratic" && g.width >= 3 && g.height >= 3;
    Ok(())
}
