//! A TIN's whole state as bytes (REQ-GAP-39): the analysis worker builds it, the main thread
//! loads it and edits it there. Loading checks every index and the topology before use.

use crate::err::{Error, Msg};
use crate::mesh::{ekey, Line, Map, Mesh, Stats, E_CONS, E_REGION, INF, NONE, T_DEAD};

const MAGIC: &[u8; 8] = b"GWTIN\x01\x00\x00";

struct W(Vec<u8>);
impl W {
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
}

pub fn save(m: &Mesh) -> Vec<u8> {
    let (nv, nt) = (m.nv(), m.tv.len());
    let mut w = W(Vec::with_capacity(64 + nv * 45 + nt * 28));
    w.0.extend_from_slice(MAGIC);
    w.f64(m.q);
    w.f64(m.ox);
    w.f64(m.oy);
    w.u64(nv as u64);
    w.u64(nt as u64);
    w.u64(m.lines.len() as u64);
    w.u64(m.free.len() as u64);
    w.u32(m.hint);
    w.u32(m.nreal as u32);
    w.u64(m.rng);
    for s in [m.stats.duplicates, m.stats.flips, m.stats.steiner, m.stats.snapped, m.stats.rebuilds] {
        w.u64(s);
    }
    for k in 0..nv {
        w.u64(m.x[k] as u64);
        w.u64(m.y[k] as u64);
        w.f64(m.z[k]);
        w.f64(m.z0[k]);
        w.u32(m.vt[k]);
        w.u32(m.vl[k]);
    }
    w.0.extend_from_slice(&m.vf);
    for t in 0..nt {
        for i in 0..3 {
            w.u32(m.tv[t][i]);
        }
        for i in 0..3 {
            w.u32(m.tn[t][i]);
        }
    }
    for t in 0..nt {
        w.0.extend_from_slice(&m.te[t]);
        w.0.push(m.tf[t]);
    }
    for &f in &m.free {
        w.u32(f);
    }
    for l in &m.lines {
        w.u64(l.key);
        w.0.push(l.kind);
        w.0.push(l.closed as u8);
        w.0.push(l.alive as u8);
        w.u32(l.defs.len() as u32);
        for &v in &l.defs {
            w.u32(v);
        }
        w.u32(l.path.len() as u32);
        for &v in &l.path {
            w.u32(v);
        }
    }
    w.0
}

struct R<'a> {
    b: &'a [u8],
    i: usize,
}
impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], Msg> {
        let end = self.i.checked_add(n).ok_or_else(|| Error::invalid("tin state: cut short"))?;
        if end > self.b.len() {
            return Err(Error::invalid("tin state: cut short"));
        }
        let s = &self.b[self.i..end];
        self.i = end;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32, Msg> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| Error::invalid("tin state: cut short"))?))
    }
    fn u64(&mut self) -> Result<u64, Msg> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().map_err(|_| Error::invalid("tin state: cut short"))?))
    }
    fn f64(&mut self) -> Result<f64, Msg> {
        Ok(f64::from_bits(self.u64()?))
    }
    fn count(&mut self, unit: usize) -> Result<usize, Msg> {
        let n = self.u64()?;
        if n > (self.b.len() / unit.max(1)) as u64 {
            return Err(Error::invalid("tin state: a count is larger than the data"));
        }
        Ok(n as usize)
    }
}

pub fn load(b: &[u8]) -> Result<Mesh, Msg> {
    let mut r = R { b, i: 0 };
    if r.take(8)? != MAGIC {
        return Err(Error::invalid("tin state: not a TIN state"));
    }
    let mut m = Mesh::new(r.f64()?, r.f64()?, r.f64()?);
    if !(m.q > 0.0 && m.q.is_finite() && m.ox.is_finite() && m.oy.is_finite()) {
        return Err(Error::invalid("tin state: bad grid"));
    }
    let nv = r.count(41)?;
    let nt = r.count(28)?;
    let nl = r.count(15)?;
    let nf = r.count(4)?;
    m.hint = r.u32()?;
    m.nreal = r.u32()? as usize;
    m.rng = r.u64()?.max(1);
    m.stats = Stats { duplicates: r.u64()?, flips: r.u64()?, steiner: r.u64()?, snapped: r.u64()?, rebuilds: r.u64()? };
    let lim = crate::pred::LIM;
    for _ in 0..nv {
        let x = r.u64()? as i64;
        let y = r.u64()? as i64;
        if x.abs() > lim || y.abs() > lim {
            return Err(Error::invalid("tin state: a vertex is outside the grid"));
        }
        m.x.push(x);
        m.y.push(y);
        m.z.push(r.f64()?);
        m.z0.push(r.f64()?);
        let t = r.u32()?;
        if t != NONE && t as usize >= nt {
            return Err(Error::invalid("tin state: a vertex names a missing triangle"));
        }
        m.vt.push(t);
        m.vl.push(r.u32()?);
    }
    m.vf = r.take(nv)?.to_vec();
    for _ in 0..nt {
        let mut v = [0u32; 3];
        let mut n = [0u32; 3];
        for x in v.iter_mut() {
            *x = r.u32()?;
        }
        for x in n.iter_mut() {
            *x = r.u32()?;
        }
        if v.iter().any(|&x| x != INF && x as usize >= nv) || n.iter().any(|&x| x != NONE && x as usize >= nt) {
            return Err(Error::invalid("tin state: a triangle names a missing vertex or neighbour"));
        }
        m.tv.push(v);
        m.tn.push(n);
    }
    for _ in 0..nt {
        let s = r.take(4)?;
        m.te.push([s[0] & 3, s[1] & 3, s[2] & 3]);
        m.tf.push(s[3] & 3);
    }
    for _ in 0..nf {
        let f = r.u32()?;
        if f as usize >= nt {
            return Err(Error::invalid("tin state: bad free list"));
        }
        m.free.push(f);
    }
    for _ in 0..nl {
        let key = r.u64()?;
        let h = r.take(3)?;
        let (kind, closed, alive) = (h[0], h[1] != 0, h[2] != 0);
        if !(1..=8).contains(&kind) {
            return Err(Error::invalid("tin state: unknown line kind"));
        }
        let list = |r: &mut R| -> Result<Vec<u32>, Msg> {
            let n = r.u32()? as usize;
            if n > b.len() / 4 {
                return Err(Error::invalid("tin state: a count is larger than the data"));
            }
            let mut out = Vec::with_capacity(n);
            for _ in 0..n {
                let v = r.u32()?;
                if v as usize >= nv {
                    return Err(Error::invalid("tin state: a line names a missing vertex"));
                }
                out.push(v);
            }
            Ok(out)
        };
        let defs = list(&mut r)?;
        let path = list(&mut r)?;
        m.lines.push(Line { key, kind, closed, defs, path, alive });
    }
    if r.i != b.len() {
        return Err(Error::invalid("tin state: trailing bytes"));
    }
    // Every live triangle's vertices are live; the free list holds dead ones only.
    for t in 0..nt {
        if m.tf[t] & T_DEAD == 0 && m.tv[t].iter().any(|&v| v != INF && m.vf[v as usize] & crate::mesh::V_DEAD != 0) {
            return Err(Error::invalid("tin state: a triangle uses a removed vertex"));
        }
    }
    if m.free.iter().any(|&f| m.tf[f as usize] & T_DEAD == 0) {
        return Err(Error::invalid("tin state: bad free list"));
    }
    m.check().map_err(|_| Error::invalid("tin state: the topology is not consistent"))?;
    // Constraints from the lines; they must agree with the edge flags.
    let mut cons: Map<u64, Vec<u32>> = Map::default();
    for (l, ln) in m.lines.iter().enumerate() {
        if !ln.alive {
            continue;
        }
        if m.by_key.insert(ln.key, l as u32).is_some() {
            return Err(Error::invalid("tin state: two lines with one key"));
        }
        let n = ln.path.len();
        let segs = if ln.closed { n } else { n.saturating_sub(1) };
        for k in 0..segs {
            cons.entry(ekey(ln.path[k], ln.path[(k + 1) % n])).or_default().push(l as u32);
        }
    }
    m.cons = cons;
    for (key, ls) in &m.cons {
        let (a, b) = ((key >> 32) as u32, (key & 0xffff_ffff) as u32);
        let want = E_CONS | if ls.iter().any(|&l| crate::mesh::is_region(m.lines[l as usize].kind)) { E_REGION } else { 0 };
        match m.find_edge(a, b) {
            Some((t, i)) if m.te[t as usize][i] == want => {}
            _ => return Err(Error::invalid("tin state: a line's edge is missing or not constrained")),
        }
    }
    let ncons = m.te.iter().enumerate().filter(|(t, _)| m.tf[*t] & T_DEAD == 0).map(|(_, e)| e.iter().filter(|&&f| f & E_CONS != 0).count()).sum::<usize>();
    if ncons != 2 * m.cons.len() {
        return Err(Error::invalid("tin state: constrained edges without a line"));
    }
    m.dirty = true;
    Ok(m)
}
