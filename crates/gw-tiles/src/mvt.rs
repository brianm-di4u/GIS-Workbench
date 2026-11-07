//! Mapbox Vector Tiles (FC-07): the tiler (REQ-FMT-33) — longitude/latitude features → MVT 2.1
//! tiles over a zoom range, clipped with a buffer, simplified per zoom (Douglas–Peucker in tile
//! units), quantised to the tile extent, polygon winding per the specification — and a
//! bounds-checked decoder used by the round-trip tests and fuzz targets.
//! Specification: <https://github.com/mapbox/vector-tile-spec/tree/master/2.1>.

use gw_abi::{Error, Result};

pub type P = [f64; 2];

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Str(String),
    F64(f64),
    I64(i64),
    Bool(bool),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Geom {
    /// One or more points.
    Points(Vec<P>),
    /// One or more lines.
    Lines(Vec<Vec<P>>),
    /// Polygons, each an exterior ring then holes (rings not closed).
    Polys(Vec<Vec<Vec<P>>>),
}

#[derive(Clone, Debug)]
pub struct Feature {
    pub id: Option<u64>,
    /// (key index, value index) into the layer's tables.
    pub tags: Vec<(u32, u32)>,
    /// Longitude/latitude (degrees).
    pub geom: Geom,
}

#[derive(Clone, Debug, Default)]
pub struct Layer {
    pub name: String,
    pub keys: Vec<String>,
    pub values: Vec<Value>,
    pub features: Vec<Feature>,
}

#[derive(Clone, Debug)]
pub struct TileOptions {
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub extent: u32,
    /// Buffer around each tile, in tile units.
    pub buffer: u32,
    /// Douglas–Peucker tolerance in tile units below the maximum zoom (0 keeps every vertex).
    pub tolerance: f64,
    /// Refuse a tile set with more tiles than this.
    pub max_tiles: usize,
    /// Refuse a tile set whose tiles total more bytes than this.
    pub max_bytes: usize,
}

impl Default for TileOptions {
    fn default() -> Self {
        TileOptions { min_zoom: 0, max_zoom: 14, extent: 4096, buffer: 64, tolerance: 1.0, max_tiles: 200_000, max_bytes: 1 << 30 }
    }
}

// ---------------------------------------------------------------- input (binary, from JS)

struct Rd<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Rd<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let e = self.p.checked_add(n).filter(|&e| e <= self.b.len()).ok_or_else(|| Error::invalid("tiler input cut short"))?;
        let s = &self.b[self.p..e];
        self.p = e;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn count(&mut self, each: usize) -> Result<usize> {
        let n = self.u32()? as usize;
        if n.saturating_mul(each) > self.b.len() - self.p {
            return Err(Error::invalid("tiler input claims more items than it holds"));
        }
        Ok(n)
    }
    fn u64(&mut self) -> Result<u64> {
        let s = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        Ok(u64::from_le_bytes(a))
    }
    fn f64(&mut self) -> Result<f64> {
        Ok(f64::from_bits(self.u64()?))
    }
    fn str(&mut self) -> Result<String> {
        let n = self.count(1)?;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }
    fn pts(&mut self) -> Result<Vec<P>> {
        let n = self.count(16)?;
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            let x = self.f64()?;
            let y = self.f64()?;
            if x.is_finite() && y.is_finite() {
                v.push([x, y]);
            }
        }
        Ok(v)
    }
}

/// Parse the tiler's input: "GWVT", version 1, layers (see `app/src/tiles/tiler.js`).
pub fn parse_input(b: &[u8]) -> Result<Vec<Layer>> {
    let mut r = Rd { b, p: 0 };
    if r.take(4)? != b"GWVT" || r.u32()? != 1 {
        return Err(Error::invalid("not tiler input (GWVT 1)"));
    }
    let nl = r.count(12)?;
    let mut layers = Vec::with_capacity(nl);
    for _ in 0..nl {
        let name = r.str()?;
        let nk = r.count(4)?;
        let keys = (0..nk).map(|_| r.str()).collect::<Result<Vec<_>>>()?;
        let nv = r.count(2)?;
        let mut values = Vec::with_capacity(nv);
        for _ in 0..nv {
            values.push(match r.u8()? {
                1 => Value::Str(r.str()?),
                2 => Value::F64(r.f64()?),
                3 => Value::I64(r.u64()? as i64),
                4 => Value::Bool(r.u8()? != 0),
                _ => return Err(Error::invalid("unknown value type in tiler input")),
            });
        }
        let nf = r.count(10)?;
        let mut features = Vec::with_capacity(nf);
        for _ in 0..nf {
            let id = if r.u8()? != 0 { Some(r.u64()?) } else { None };
            let kind = r.u8()?;
            let nt = r.count(8)?;
            let mut tags = Vec::with_capacity(nt);
            for _ in 0..nt {
                let k = r.u32()?;
                let v = r.u32()?;
                if (k as usize) < keys.len() && (v as usize) < values.len() {
                    tags.push((k, v));
                }
            }
            let geom = match kind {
                1 => Geom::Points(r.pts()?),
                2 => {
                    let n = r.count(4)?;
                    Geom::Lines((0..n).map(|_| r.pts()).collect::<Result<Vec<_>>>()?)
                }
                3 => {
                    let n = r.count(4)?;
                    let mut polys = Vec::with_capacity(n);
                    for _ in 0..n {
                        let nr = r.count(4)?;
                        polys.push((0..nr).map(|_| r.pts()).collect::<Result<Vec<_>>>()?);
                    }
                    Geom::Polys(polys)
                }
                _ => return Err(Error::invalid("unknown geometry type in tiler input")),
            };
            features.push(Feature { id, tags, geom });
        }
        layers.push(Layer { name, keys, values, features });
    }
    Ok(layers)
}

// ---------------------------------------------------------------- geometry helpers

const MAX_LAT: f64 = 85.051_128_779_806_59;

/// Longitude/latitude → Web Mercator world coordinates in [0, 1] (y down).
pub fn to_world(p: P) -> P {
    let lat = p[1].clamp(-MAX_LAT, MAX_LAT).to_radians();
    [(p[0] + 180.0) / 360.0, (1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / std::f64::consts::PI) / 2.0]
}

fn bbox_of(g: &Geom) -> [f64; 4] {
    let mut b = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    let mut add = |p: &P| {
        b[0] = b[0].min(p[0]);
        b[1] = b[1].min(p[1]);
        b[2] = b[2].max(p[0]);
        b[3] = b[3].max(p[1]);
    };
    match g {
        Geom::Points(v) => v.iter().for_each(&mut add),
        Geom::Lines(v) => v.iter().flatten().for_each(&mut add),
        Geom::Polys(v) => v.iter().flat_map(|p| p.first()).flatten().for_each(&mut add),
    }
    b
}

fn map_geom(g: &Geom, f: impl Fn(P) -> P) -> Geom {
    match g {
        Geom::Points(v) => Geom::Points(v.iter().map(|&p| f(p)).collect()),
        Geom::Lines(v) => Geom::Lines(v.iter().map(|l| l.iter().map(|&p| f(p)).collect()).collect()),
        Geom::Polys(v) => Geom::Polys(v.iter().map(|poly| poly.iter().map(|r| r.iter().map(|&p| f(p)).collect()).collect()).collect()),
    }
}

/// Clip a polyline to a rectangle (Liang–Barsky per segment, joined where contiguous).
fn clip_line(l: &[P], r: [f64; 4], out: &mut Vec<Vec<P>>) {
    let mut cur: Vec<P> = Vec::new();
    for w in l.windows(2) {
        let (a, b) = (w[0], w[1]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let (mut t0, mut t1) = (0.0f64, 1.0f64);
        let mut ok = true;
        for (pp, qq) in [(-dx, a[0] - r[0]), (dx, r[2] - a[0]), (-dy, a[1] - r[1]), (dy, r[3] - a[1])] {
            if pp == 0.0 {
                if qq < 0.0 {
                    ok = false;
                    break;
                }
            } else {
                let t = qq / pp;
                if pp < 0.0 {
                    t0 = t0.max(t);
                } else {
                    t1 = t1.min(t);
                }
            }
        }
        if !ok || t0 > t1 {
            if cur.len() > 1 {
                out.push(std::mem::take(&mut cur));
            }
            cur.clear();
            continue;
        }
        let p0 = [a[0] + t0 * dx, a[1] + t0 * dy];
        let p1 = [a[0] + t1 * dx, a[1] + t1 * dy];
        if cur.last() != Some(&p0) {
            if cur.len() > 1 {
                out.push(std::mem::take(&mut cur));
            }
            cur.clear();
            cur.push(p0);
        }
        cur.push(p1);
        if t1 < 1.0 {
            if cur.len() > 1 {
                out.push(std::mem::take(&mut cur));
            }
            cur.clear();
        }
    }
    if cur.len() > 1 {
        out.push(cur);
    }
}

/// Clip a ring to a rectangle (Sutherland–Hodgman against each edge).
fn clip_ring(ring: &[P], r: [f64; 4]) -> Vec<P> {
    let mut pts = ring.to_vec();
    for edge in 0..4 {
        if pts.is_empty() {
            break;
        }
        let inside = |p: &P| match edge {
            0 => p[0] >= r[0],
            1 => p[0] <= r[2],
            2 => p[1] >= r[1],
            _ => p[1] <= r[3],
        };
        let cross = |a: &P, b: &P| -> P {
            let (k, v) = match edge {
                0 => (0, r[0]),
                1 => (0, r[2]),
                2 => (1, r[1]),
                _ => (1, r[3]),
            };
            let t = (v - a[k]) / (b[k] - a[k]);
            let mut p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
            p[k] = v;
            p
        };
        let mut out = Vec::with_capacity(pts.len() + 4);
        for i in 0..pts.len() {
            let a = &pts[i];
            let b = &pts[(i + 1) % pts.len()];
            match (inside(a), inside(b)) {
                (true, true) => out.push(*b),
                (true, false) => out.push(cross(a, b)),
                (false, true) => {
                    out.push(cross(a, b));
                    out.push(*b);
                }
                (false, false) => {}
            }
        }
        pts = out;
    }
    pts
}

fn clip(g: &Geom, r: [f64; 4]) -> Option<Geom> {
    match g {
        Geom::Points(v) => {
            let k: Vec<P> = v.iter().copied().filter(|p| p[0] >= r[0] && p[0] <= r[2] && p[1] >= r[1] && p[1] <= r[3]).collect();
            (!k.is_empty()).then_some(Geom::Points(k))
        }
        Geom::Lines(v) => {
            let mut out = Vec::new();
            for l in v {
                clip_line(l, r, &mut out);
            }
            (!out.is_empty()).then_some(Geom::Lines(out))
        }
        Geom::Polys(v) => {
            let mut out = Vec::new();
            for poly in v {
                let mut rings = Vec::new();
                for (i, ring) in poly.iter().enumerate() {
                    let c = clip_ring(ring, r);
                    if c.len() >= 3 {
                        rings.push(c);
                    } else if i == 0 {
                        break;
                    }
                }
                if !rings.is_empty() {
                    out.push(rings);
                }
            }
            (!out.is_empty()).then_some(Geom::Polys(out))
        }
    }
}

fn seg_dist2(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let l2 = dx * dx + dy * dy;
    let t = if l2 > 0.0 { (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    let (x, y) = (a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
    x * x + y * y
}

/// Douglas–Peucker (iterative, so deep inputs cannot overflow the stack).
pub fn simplify(pts: &[P], tol: f64) -> Vec<P> {
    if pts.len() < 3 || tol <= 0.0 {
        return pts.to_vec();
    }
    let t2 = tol * tol;
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0usize, pts.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let mut best = (0.0, 0usize);
        for i in a + 1..b {
            let d = seg_dist2(pts[i], pts[a], pts[b]);
            if d > best.0 {
                best = (d, i);
            }
        }
        if best.0 > t2 {
            keep[best.1] = true;
            stack.push((a, best.1));
            stack.push((best.1, b));
        }
    }
    pts.iter().zip(keep).filter(|(_, k)| *k).map(|(p, _)| *p).collect()
}

fn ring_area2(r: &[[i32; 2]]) -> i64 {
    let mut s = 0i64;
    for i in 0..r.len() {
        let a = r[i];
        let b = r[(i + 1) % r.len()];
        s += a[0] as i64 * b[1] as i64 - b[0] as i64 * a[1] as i64;
    }
    s
}

fn quantise(pts: &[P], closed: bool) -> Vec<[i32; 2]> {
    let mut out: Vec<[i32; 2]> = Vec::with_capacity(pts.len());
    for p in pts {
        let q = [p[0].round().clamp(-(1 << 28) as f64, (1 << 28) as f64) as i32, p[1].round().clamp(-(1 << 28) as f64, (1 << 28) as f64) as i32];
        if out.last() != Some(&q) {
            out.push(q);
        }
    }
    if closed && out.len() > 1 && out.first() == out.last() {
        out.pop();
    }
    out
}

// ---------------------------------------------------------------- protobuf writing

fn varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}
fn key(out: &mut Vec<u8>, field: u32, wire: u32) {
    varint(out, ((field << 3) | wire) as u64);
}
fn bytes_field(out: &mut Vec<u8>, field: u32, b: &[u8]) {
    key(out, field, 2);
    varint(out, b.len() as u64);
    out.extend_from_slice(b);
}
fn zz(v: i32) -> u32 {
    ((v << 1) ^ (v >> 31)) as u32
}

/// Geometry commands for one feature (tile coordinates), or None when nothing is left.
fn encode_geometry(g: &Geom, tol: f64, min_area2: i64) -> Option<(u32, Vec<u32>)> {
    let mut cmd = Vec::new();
    let mut cur = [0i32; 2];
    let push_pts = |cmd: &mut Vec<u32>, cur: &mut [i32; 2], pts: &[[i32; 2]]| {
        for p in pts {
            cmd.push(zz(p[0].wrapping_sub(cur[0])));
            cmd.push(zz(p[1].wrapping_sub(cur[1])));
            *cur = *p;
        }
    };
    let ty = match g {
        Geom::Points(v) => {
            let q: Vec<[i32; 2]> = v.iter().map(|p| [p[0].round() as i32, p[1].round() as i32]).collect();
            if q.is_empty() {
                return None;
            }
            cmd.push(1 | ((q.len() as u32) << 3));
            push_pts(&mut cmd, &mut cur, &q);
            1
        }
        Geom::Lines(v) => {
            for l in v {
                let q = quantise(&simplify(l, tol), false);
                if q.len() < 2 {
                    continue;
                }
                cmd.push(1 | (1 << 3));
                push_pts(&mut cmd, &mut cur, &q[..1]);
                cmd.push(2 | (((q.len() - 1) as u32) << 3));
                push_pts(&mut cmd, &mut cur, &q[1..]);
            }
            2
        }
        Geom::Polys(v) => {
            for poly in v {
                for (i, ring) in poly.iter().enumerate() {
                    let mut closed = ring.clone();
                    if let Some(&f) = ring.first() {
                        closed.push(f);
                    }
                    let mut q = quantise(&simplify(&closed, tol), true);
                    if q.len() < 3 {
                        if i == 0 {
                            break;
                        }
                        continue;
                    }
                    let a = ring_area2(&q);
                    if a == 0 || a.abs() < min_area2 {
                        if i == 0 {
                            break;
                        }
                        continue;
                    }
                    // Exterior rings positive by the surveyor's formula in tile coordinates, holes negative.
                    if (i == 0) != (a > 0) {
                        q.reverse();
                    }
                    cmd.push(1 | (1 << 3));
                    push_pts(&mut cmd, &mut cur, &q[..1]);
                    cmd.push(2 | (((q.len() - 1) as u32) << 3));
                    push_pts(&mut cmd, &mut cur, &q[1..]);
                    cmd.push(7 | (1 << 3));
                }
            }
            3
        }
    };
    (!cmd.is_empty()).then_some((ty, cmd))
}

fn encode_value(v: &Value) -> Vec<u8> {
    let mut b = Vec::new();
    match v {
        Value::Str(s) => bytes_field(&mut b, 1, s.as_bytes()),
        Value::F64(f) => {
            key(&mut b, 3, 1);
            b.extend_from_slice(&f.to_le_bytes());
        }
        Value::I64(i) if *i >= 0 => {
            key(&mut b, 5, 0);
            varint(&mut b, *i as u64);
        }
        Value::I64(i) => {
            key(&mut b, 6, 0);
            varint(&mut b, ((*i << 1) ^ (*i >> 63)) as u64);
        }
        Value::Bool(t) => {
            key(&mut b, 7, 0);
            varint(&mut b, u64::from(*t));
        }
    }
    b
}

/// A feature clipped to a tile, in that tile's coordinates.
struct TileFeat<'a> {
    src: &'a Feature,
    geom: Geom,
}

fn encode_tile(layers: &[Layer], feats: &[Vec<TileFeat>], extent: u32, tol: f64, min_area2: i64) -> Vec<u8> {
    let mut tile = Vec::new();
    for (li, l) in layers.iter().enumerate() {
        if feats[li].is_empty() {
            continue;
        }
        let mut kmap = vec![u32::MAX; l.keys.len()];
        let mut vmap = vec![u32::MAX; l.values.len()];
        let (mut keys, mut vals) = (Vec::new(), Vec::new());
        let mut body = Vec::new();
        bytes_field(&mut body, 1, l.name.as_bytes());
        let mut n = 0;
        for tf in &feats[li] {
            let Some((ty, geom)) = encode_geometry(&tf.geom, tol, min_area2) else { continue };
            let mut f = Vec::new();
            if let Some(id) = tf.src.id {
                key(&mut f, 1, 0);
                varint(&mut f, id);
            }
            if !tf.src.tags.is_empty() {
                let mut t = Vec::new();
                for &(k, v) in &tf.src.tags {
                    if kmap[k as usize] == u32::MAX {
                        kmap[k as usize] = keys.len() as u32;
                        keys.push(k);
                    }
                    if vmap[v as usize] == u32::MAX {
                        vmap[v as usize] = vals.len() as u32;
                        vals.push(v);
                    }
                    varint(&mut t, kmap[k as usize] as u64);
                    varint(&mut t, vmap[v as usize] as u64);
                }
                bytes_field(&mut f, 2, &t);
            }
            key(&mut f, 3, 0);
            varint(&mut f, ty as u64);
            let mut gb = Vec::with_capacity(geom.len() * 2);
            for c in geom {
                varint(&mut gb, c as u64);
            }
            bytes_field(&mut f, 4, &gb);
            bytes_field(&mut body, 2, &f);
            n += 1;
        }
        if n == 0 {
            continue;
        }
        for k in keys {
            bytes_field(&mut body, 3, l.keys[k as usize].as_bytes());
        }
        for v in vals {
            bytes_field(&mut body, 4, &encode_value(&l.values[v as usize]));
        }
        key(&mut body, 5, 0);
        varint(&mut body, extent as u64);
        key(&mut body, 15, 0);
        varint(&mut body, 2);
        bytes_field(&mut tile, 3, &body);
    }
    tile
}

/// One output tile: (z, x, y, uncompressed MVT bytes).
pub type Tile = (u8, u32, u32, Vec<u8>);

struct Ctx<'a> {
    layers: &'a [Layer],
    o: &'a TileOptions,
    out: Vec<Tile>,
    bytes: usize,
    err: Option<Error>,
}

/// World-coordinate features of one tile, per layer.
type Bucket<'a> = Vec<Vec<(&'a Feature, Geom, [f64; 4])>>;

fn recurse<'a>(c: &mut Ctx<'a>, z: u8, x: u32, y: u32, feats: Bucket<'a>) {
    if c.err.is_some() {
        return;
    }
    let n = (1u64 << z) as f64;
    if z >= c.o.min_zoom {
        let ext = c.o.extent as f64;
        let tf: Vec<Vec<TileFeat>> = feats
            .iter()
            .map(|l| l.iter().map(|(f, g, _)| TileFeat { src: f, geom: map_geom(g, |p| [(p[0] * n - x as f64) * ext, (p[1] * n - y as f64) * ext]) }).collect())
            .collect();
        let at_max = z == c.o.max_zoom;
        let tol = if at_max { 0.0 } else { c.o.tolerance };
        let min_area2 = if at_max { 0 } else { (2.0 * tol * tol) as i64 };
        let t = encode_tile(c.layers, &tf, c.o.extent, tol, min_area2);
        if !t.is_empty() {
            c.bytes += t.len();
            c.out.push((z, x, y, t));
            if c.out.len() > c.o.max_tiles {
                c.err = Some(gw_abi::err!(LIMIT, "the layer makes more than {max} tiles: lower the maximum zoom", max = c.o.max_tiles));
                return;
            }
            if c.bytes > c.o.max_bytes {
                c.err = Some(gw_abi::err!(LIMIT, "the tiles pass {mib} MiB: lower the maximum zoom", mib = c.o.max_bytes >> 20));
                return;
            }
        }
    }
    if z >= c.o.max_zoom {
        return;
    }
    let cz = z + 1;
    let cn = (1u64 << cz) as f64;
    let pad = c.o.buffer as f64 / c.o.extent as f64 / cn;
    for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
        let (cx, cy) = (2 * x + dx, 2 * y + dy);
        let r = [cx as f64 / cn - pad, cy as f64 / cn - pad, (cx + 1) as f64 / cn + pad, (cy + 1) as f64 / cn + pad];
        let mut child: Bucket = Vec::with_capacity(feats.len());
        let mut any = false;
        for l in &feats {
            let mut v = Vec::new();
            for (f, g, b) in l {
                if b[2] < r[0] || b[0] > r[2] || b[3] < r[1] || b[1] > r[3] {
                    continue;
                }
                if b[0] >= r[0] && b[2] <= r[2] && b[1] >= r[1] && b[3] <= r[3] {
                    v.push((*f, g.clone(), *b));
                } else if let Some(cg) = clip(g, r) {
                    let cb = bbox_of(&cg);
                    v.push((*f, cg, cb));
                }
            }
            any |= !v.is_empty();
            child.push(v);
        }
        if any {
            recurse(c, cz, cx, cy, child);
        }
    }
}

/// Tile every layer over the zoom range. Tiles come out in depth-first order.
pub fn tile_layers(layers: &[Layer], o: &TileOptions) -> Result<Vec<Tile>> {
    if o.max_zoom > 24 || o.min_zoom > o.max_zoom {
        return Err(Error::range("zoom range must satisfy 0 ≤ min ≤ max ≤ 24"));
    }
    if o.extent < 256 || o.extent > 65536 {
        return Err(Error::range("tile extent must be 256..65536"));
    }
    let root: Bucket = layers
        .iter()
        .map(|l| {
            l.features
                .iter()
                .map(|f| {
                    let g = map_geom(&f.geom, to_world);
                    let b = bbox_of(&g);
                    (f, g, b)
                })
                .filter(|(_, _, b)| b[0].is_finite())
                .collect()
        })
        .collect();
    let mut c = Ctx { layers, o, out: Vec::new(), bytes: 0, err: None };
    recurse(&mut c, 0, 0, 0, root);
    match c.err {
        Some(e) => Err(e),
        None => Ok(c.out),
    }
}

/// Tiler output as one buffer: u32 count, then per tile u8 z, u32 x, u32 y, u32 length, bytes.
pub fn pack_tiles(tiles: &[Tile]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + tiles.iter().map(|t| 13 + t.3.len()).sum::<usize>());
    out.extend_from_slice(&(tiles.len() as u32).to_le_bytes());
    for (z, x, y, b) in tiles {
        out.push(*z);
        out.extend_from_slice(&x.to_le_bytes());
        out.extend_from_slice(&y.to_le_bytes());
        out.extend_from_slice(&(b.len() as u32).to_le_bytes());
        out.extend_from_slice(b);
    }
    out
}

/// A packed tile borrowed from its buffer: (z, x, y, bytes).
pub type TileRef<'a> = (u8, u32, u32, &'a [u8]);

/// Inverse of [`pack_tiles`] (borrowing the bytes).
pub fn unpack_tiles(b: &[u8]) -> Result<Vec<TileRef<'_>>> {
    let mut r = Rd { b, p: 0 };
    let n = r.count(13)?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let z = r.u8()?;
        let x = r.u32()?;
        let y = r.u32()?;
        let len = r.u32()? as usize;
        out.push((z, x, y, r.take(len)?));
    }
    Ok(out)
}

// ---------------------------------------------------------------- decoding

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DecodedFeature {
    pub id: Option<u64>,
    pub kind: u32,
    pub tags: Vec<u32>,
    /// Parts in tile coordinates (MoveTo starts a part).
    pub parts: Vec<Vec<[i64; 2]>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DecodedLayer {
    pub name: String,
    pub version: u32,
    pub extent: u32,
    pub keys: Vec<String>,
    pub values: Vec<Value>,
    pub features: Vec<DecodedFeature>,
}

struct Pb<'a> {
    b: &'a [u8],
    p: usize,
}
impl<'a> Pb<'a> {
    fn varint(&mut self) -> Result<u64> {
        let mut v = 0u64;
        for i in 0..10 {
            let c = *self.b.get(self.p).ok_or_else(|| Error::invalid("MVT protobuf cut short"))?;
            self.p += 1;
            v |= u64::from(c & 0x7f) << (7 * i);
            if c < 0x80 {
                return Ok(v);
            }
        }
        Err(Error::invalid("MVT varint longer than 10 bytes"))
    }
    fn bytes(&mut self) -> Result<&'a [u8]> {
        let n = usize::try_from(self.varint()?).map_err(|_| Error::invalid("MVT length"))?;
        let e = self.p.checked_add(n).filter(|&e| e <= self.b.len()).ok_or_else(|| Error::invalid("MVT field runs past its message"))?;
        let s = &self.b[self.p..e];
        self.p = e;
        Ok(s)
    }
    fn fixed(&mut self, n: usize) -> Result<&'a [u8]> {
        let e = self.p.checked_add(n).filter(|&e| e <= self.b.len()).ok_or_else(|| Error::invalid("MVT fixed field cut short"))?;
        let s = &self.b[self.p..e];
        self.p = e;
        Ok(s)
    }
    fn skip(&mut self, wire: u64) -> Result<()> {
        match wire {
            0 => self.varint().map(|_| ()),
            1 => self.fixed(8).map(|_| ()),
            2 => self.bytes().map(|_| ()),
            5 => self.fixed(4).map(|_| ()),
            _ => Err(Error::invalid("MVT protobuf wire type not supported")),
        }
    }
    fn done(&self) -> bool {
        self.p >= self.b.len()
    }
}

fn packed(b: &[u8]) -> Result<Vec<u32>> {
    let mut p = Pb { b, p: 0 };
    let mut v = Vec::new();
    while !p.done() {
        v.push(p.varint()? as u32);
    }
    Ok(v)
}

fn decode_value(b: &[u8]) -> Result<Value> {
    let mut p = Pb { b, p: 0 };
    let mut v = Value::Str(String::new());
    while !p.done() {
        let k = p.varint()?;
        v = match (k >> 3, k & 7) {
            (1, 2) => Value::Str(String::from_utf8_lossy(p.bytes()?).into_owned()),
            (2, 5) => {
                let s = p.fixed(4)?;
                Value::F64(f32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64)
            }
            (3, 1) => {
                let s = p.fixed(8)?;
                let mut a = [0u8; 8];
                a.copy_from_slice(s);
                Value::F64(f64::from_le_bytes(a))
            }
            (4, 0) | (5, 0) => Value::I64(p.varint()? as i64),
            (6, 0) => {
                let u = p.varint()?;
                Value::I64(((u >> 1) as i64) ^ -((u & 1) as i64))
            }
            (7, 0) => Value::Bool(p.varint()? != 0),
            (_, w) => {
                p.skip(w)?;
                continue;
            }
        };
    }
    Ok(v)
}

fn decode_geometry(cmds: &[u32], limit: usize) -> Result<Vec<Vec<[i64; 2]>>> {
    let mut parts: Vec<Vec<[i64; 2]>> = Vec::new();
    let (mut x, mut y) = (0i64, 0i64);
    let mut i = 0;
    let mut total = 0usize;
    while i < cmds.len() {
        let c = cmds[i];
        i += 1;
        let (id, n) = (c & 7, (c >> 3) as usize);
        match id {
            1 | 2 => {
                if i + 2 * n > cmds.len() {
                    return Err(Error::invalid("MVT geometry command runs past its parameters"));
                }
                total += n;
                if total > limit {
                    return Err(Error::limit("MVT feature has too many vertices"));
                }
                for k in 0..n {
                    let dx = cmds[i + 2 * k];
                    let dy = cmds[i + 2 * k + 1];
                    x += ((dx >> 1) as i64) ^ -((dx & 1) as i64);
                    y += ((dy >> 1) as i64) ^ -((dy & 1) as i64);
                    if id == 1 || parts.is_empty() {
                        parts.push(Vec::new());
                    }
                    parts.last_mut().unwrap().push([x, y]);
                }
                i += 2 * n;
            }
            7 => {}
            _ => return Err(Error::invalid("unknown MVT geometry command")),
        }
    }
    Ok(parts)
}

/// Decode an (uncompressed) MVT tile.
pub fn decode(b: &[u8]) -> Result<Vec<DecodedLayer>> {
    let mut t = Pb { b, p: 0 };
    let mut layers = Vec::new();
    let mut verts = 0usize;
    while !t.done() {
        let k = t.varint()?;
        if k != (3 << 3 | 2) {
            t.skip(k & 7)?;
            continue;
        }
        let mut l = Pb { b: t.bytes()?, p: 0 };
        let mut dl = DecodedLayer { version: 1, extent: 4096, ..Default::default() };
        while !l.done() {
            let k = l.varint()?;
            match (k >> 3, k & 7) {
                (1, 2) => dl.name = String::from_utf8_lossy(l.bytes()?).into_owned(),
                (15, 0) => dl.version = l.varint()? as u32,
                (5, 0) => dl.extent = l.varint()? as u32,
                (3, 2) => dl.keys.push(String::from_utf8_lossy(l.bytes()?).into_owned()),
                (4, 2) => dl.values.push(decode_value(l.bytes()?)?),
                (2, 2) => {
                    let mut f = Pb { b: l.bytes()?, p: 0 };
                    let mut df = DecodedFeature::default();
                    while !f.done() {
                        let k = f.varint()?;
                        match (k >> 3, k & 7) {
                            (1, 0) => df.id = Some(f.varint()?),
                            (2, 2) => df.tags = packed(f.bytes()?)?,
                            (3, 0) => df.kind = f.varint()? as u32,
                            (4, 2) => {
                                df.parts = decode_geometry(&packed(f.bytes()?)?, 4_000_000 - verts)?;
                                verts += df.parts.iter().map(Vec::len).sum::<usize>();
                            }
                            (_, w) => f.skip(w)?,
                        }
                    }
                    dl.features.push(df);
                }
                (_, w) => l.skip(w)?,
            }
        }
        layers.push(dl);
    }
    Ok(layers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer() -> Layer {
        Layer {
            name: "roads".into(),
            keys: vec!["name".into(), "lanes".into(), "oneway".into()],
            values: vec![Value::Str("A1".into()), Value::I64(-2), Value::Bool(true), Value::F64(1.5)],
            features: vec![
                Feature { id: Some(7), tags: vec![(0, 0), (1, 1)], geom: Geom::Lines(vec![vec![[-10.0, 0.0], [10.0, 0.5], [30.0, 1.0]]]) },
                Feature { id: None, tags: vec![(2, 2)], geom: Geom::Points(vec![[2.35, 48.85]]) },
                Feature { id: Some(9), tags: vec![(1, 3)], geom: Geom::Polys(vec![vec![vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]], vec![[5.0, 5.0], [5.0, 10.0], [10.0, 10.0], [10.0, 5.0]]]]) },
            ],
        }
    }

    #[test]
    fn tiles_and_decodes_back() {
        let o = TileOptions { min_zoom: 0, max_zoom: 3, ..Default::default() };
        let tiles = tile_layers(&[layer()], &o).unwrap();
        let z0 = tiles.iter().find(|t| t.0 == 0).unwrap();
        let d = decode(&z0.3).unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].name, "roads");
        assert_eq!(d[0].extent, 4096);
        assert_eq!(d[0].version, 2);
        assert_eq!(d[0].features.len(), 3);
        let line = &d[0].features[0];
        assert_eq!((line.id, line.kind), (Some(7), 2));
        let names: Vec<_> = line.tags.chunks(2).map(|kv| (d[0].keys[kv[0] as usize].clone(), d[0].values[kv[1] as usize].clone())).collect();
        assert!(names.contains(&("lanes".into(), Value::I64(-2))));
        // The point lands where Web Mercator puts Paris.
        let w = to_world([2.35, 48.85]);
        let pt = &d[0].features[1].parts[0][0];
        assert!((pt[0] as f64 - w[0] * 4096.0).abs() <= 1.0 && (pt[1] as f64 - w[1] * 4096.0).abs() <= 1.0);
        // Polygon: exterior positive, hole negative.
        let poly = &d[0].features[2];
        assert_eq!(poly.kind, 3);
        assert_eq!(poly.parts.len(), 2);
        let area = |r: &Vec<[i64; 2]>| (0..r.len()).map(|i| r[i][0] * r[(i + 1) % r.len()][1] - r[(i + 1) % r.len()][0] * r[i][1]).sum::<i64>();
        assert!(area(&poly.parts[0]) > 0 && area(&poly.parts[1]) < 0);
        // The line crosses the antimeridian-free middle of the world: several z3 tiles.
        assert!(tiles.iter().filter(|t| t.0 == 3).count() >= 3);
        let packed = pack_tiles(&tiles);
        let back = unpack_tiles(&packed).unwrap();
        assert_eq!(back.len(), tiles.len());
    }

    #[test]
    fn clipping_keeps_pieces_inside_the_buffer() {
        let o = TileOptions { min_zoom: 2, max_zoom: 2, buffer: 64, ..Default::default() };
        let tiles = tile_layers(&[layer()], &o).unwrap();
        for t in &tiles {
            for l in decode(&t.3).unwrap() {
                for f in l.features {
                    for p in f.parts.iter().flatten() {
                        assert!(p[0] >= -65 && p[0] <= 4096 + 65 && p[1] >= -65 && p[1] <= 4096 + 65, "{p:?} outside the buffer");
                    }
                }
            }
        }
    }

    #[test]
    fn limits_and_bad_input() {
        let o = TileOptions { min_zoom: 0, max_zoom: 12, max_tiles: 10, ..Default::default() };
        assert!(tile_layers(&[layer()], &o).is_err());
        assert!(parse_input(b"GWVT\x01\0\0\0\xff\xff\xff\xff").is_err());
        assert!(decode(&[0x1a, 0x05, 0x0a]).is_err());
        assert!(decode(&[0x1a, 0x02, 0x78, 0x02]).is_ok());
    }

    #[test]
    fn simplify_drops_collinear() {
        let pts = vec![[0.0, 0.0], [1.0, 0.01], [2.0, 0.0], [3.0, 5.0]];
        assert_eq!(simplify(&pts, 0.1).len(), 3);
    }

    #[test]
    fn parse_input_round_trip() {
        let mut b = b"GWVT".to_vec();
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes()); // layers
        b.extend_from_slice(&1u32.to_le_bytes());
        b.push(b'L');
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes());
        b.push(b'k');
        b.extend_from_slice(&1u32.to_le_bytes());
        b.push(2);
        b.extend_from_slice(&3.5f64.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes()); // features
        b.push(0);
        b.push(1);
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&0u32.to_le_bytes());
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&10.0f64.to_le_bytes());
        b.extend_from_slice(&20.0f64.to_le_bytes());
        let l = parse_input(&b).unwrap();
        assert_eq!(l[0].name, "L");
        assert_eq!(l[0].values[0], Value::F64(3.5));
        assert_eq!(l[0].features[0].geom, Geom::Points(vec![[10.0, 20.0]]));
        for n in 0..b.len() {
            assert!(parse_input(&b[..n]).is_err());
        }
    }
}
