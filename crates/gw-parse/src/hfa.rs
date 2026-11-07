//! ERDAS Imagine HFA (.img/.ige/.rrd) reader and writer (FC-03, REQ-FMT-24/25).
//!
//! An HFA file is a tree of entries (128-byte headers: next, prev, parent, child, data pointer,
//! data size, name, type) whose data are laid out by a data dictionary stored in the file as
//! text (`{1:lwidth,1:lheight,…}Eimg_Layer,…`). The reader is split so the caller walks the tree
//! by byte range and never loads the whole file:
//!
//! * [`file_header`]: `EHFA_HEADER_TAG` → the root entry and dictionary pointers;
//! * [`entry`]: one entry header;
//! * [`Dict::parse`] + [`Dict::decode`]: any node's data → JSON, by the file's own dictionary;
//! * [`block_table`]: an `Edms_State` → flat (offset, size, flags) per block;
//! * [`decode_block`]: one raster block, uncompressed or RLE ("ESRI GRID compression"), every
//!   pixel type (1/2/4-bit unpacked to one byte per pixel) → little-endian samples.
//!
//! The writer ([`write`]) takes a line spec and lays out header, dictionary, entries and the
//! block tables; the caller appends the block data at the offsets it returns.

use gw_abi::{Error, Json, Result};

pub const TAG: &[u8] = b"EHFA_HEADER_TAG";
const MAX_DEPTH: usize = 12;
const MAX_ITEMS: u64 = 1 << 22;

fn u16le(b: &[u8], o: usize) -> Result<u16> {
    b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or_else(|| Error::range(format!("HFA: need 2 bytes at {o}, have {}", b.len())))
}
fn u32le(b: &[u8], o: usize) -> Result<u32> {
    b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| Error::range(format!("HFA: need 4 bytes at {o}, have {}", b.len())))
}
fn cstr(b: &[u8]) -> String {
    let n = b.iter().position(|&c| c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..n]).into_owned()
}

/// `EHFA_HEADER_TAG` + header pointer, then the `Ehfa_File` record. `b` = the first bytes of the
/// file (≥ 38; RANGE asks for more when the record lies further on).
pub fn file_header(b: &[u8]) -> Result<String> {
    if b.len() < 20 || &b[..15] != TAG {
        return Err(Error::invalid("not an ERDAS Imagine HFA file (no EHFA_HEADER_TAG)"));
    }
    let hp = u32le(b, 16)? as usize;
    let version = u32le(b, hp)?;
    let free_list = u32le(b, hp + 4)?;
    let root = u32le(b, hp + 8)?;
    let ehl = u16le(b, hp + 12)?;
    let dict = u32le(b, hp + 14)?;
    let mut j = Json::new();
    j.obj().kv_int("headerPtr", hp as i64).kv_int("version", version as i64).kv_int("freeList", free_list as i64);
    j.kv_int("root", root as i64).kv_int("entryHeaderLength", ehl as i64).kv_int("dictionary", dict as i64).end_obj();
    Ok(j.finish())
}

/// One entry header (at least 120 bytes).
pub fn entry(b: &[u8]) -> Result<String> {
    if b.len() < 120 {
        return Err(Error::range(format!("HFA entry header: need 120 bytes, have {}", b.len())));
    }
    let mut j = Json::new();
    j.obj();
    for (i, k) in ["next", "prev", "parent", "child", "data", "dataSize"].iter().enumerate() {
        j.kv_num(k, u32le(b, i * 4)? as f64);
    }
    j.kv_str("name", &cstr(&b[24..88])).kv_str("type", &cstr(&b[88..120])).end_obj();
    Ok(j.finish())
}

// ---------------------------------------------------------------------------------------------
// Data dictionary

#[derive(Debug, Clone)]
pub struct Field {
    pub count: u32,
    /// 0 = inline, b'p' or b'*' = counted pointer (count + offset, then the items inline).
    pub pointer: u8,
    pub ty: u8,
    pub enums: Vec<String>,
    pub object: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct Type {
    pub name: String,
    pub fields: Vec<Field>,
}

#[derive(Debug, Default, Clone)]
pub struct Dict {
    pub types: Vec<Type>,
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

impl P<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn until(&mut self, stop: &[u8]) -> Result<String> {
        let st = self.i;
        while let Some(c) = self.peek() {
            if stop.contains(&c) {
                return Ok(String::from_utf8_lossy(&self.s[st..self.i]).into_owned());
            }
            self.i += 1;
        }
        Err(Error::invalid("HFA dictionary: unterminated item"))
    }
    fn eat(&mut self, c: u8) -> Result<()> {
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(Error::invalid(format!("HFA dictionary: expected '{}' at {}", c as char, self.i)))
        }
    }
}

impl Dict {
    /// Parse dictionary text (`{…}Name,{…}Name,….`); stops at the final '.' or at a NUL.
    pub fn parse(b: &[u8]) -> Result<Dict> {
        let n = b.iter().position(|&c| c == 0).unwrap_or(b.len());
        let mut p = P { s: &b[..n], i: 0 };
        let mut d = Dict::default();
        loop {
            while matches!(p.peek(), Some(b' ' | b'\n' | b'\r' | b'\t' | b',')) {
                p.i += 1;
            }
            match p.peek() {
                None | Some(b'.') => break,
                Some(b'{') => {
                    let t = d.parse_type(&mut p, 0)?;
                    d.add(t);
                }
                Some(c) => return Err(Error::invalid(format!("HFA dictionary: unexpected '{}' at {}", c as char, p.i))),
            }
            if d.types.len() > 4096 {
                return Err(Error::limit("HFA dictionary: too many types"));
            }
        }
        if d.types.is_empty() {
            return Err(Error::invalid("HFA dictionary is empty"));
        }
        Ok(d)
    }

    fn add(&mut self, t: Type) {
        if !self.types.iter().any(|x| x.name == t.name) {
            self.types.push(t);
        }
    }

    fn parse_type(&mut self, p: &mut P, depth: usize) -> Result<Type> {
        if depth > MAX_DEPTH {
            return Err(Error::limit("HFA dictionary: nesting too deep"));
        }
        p.eat(b'{')?;
        let mut fields = Vec::new();
        while p.peek() != Some(b'}') {
            let cnt = p.until(b":")?;
            p.eat(b':')?;
            let count = cnt.trim().parse::<u32>().map_err(|_| Error::invalid(format!("HFA dictionary: item count '{cnt}'")))?;
            let mut pointer = 0;
            if matches!(p.peek(), Some(b'p' | b'*')) {
                pointer = p.peek().unwrap_or(0);
                p.i += 1;
            }
            let ty = p.peek().ok_or_else(|| Error::invalid("HFA dictionary: truncated field"))?;
            p.i += 1;
            let mut enums = Vec::new();
            let mut object = String::new();
            match ty {
                b'e' => {
                    let k = p.until(b":")?;
                    p.eat(b':')?;
                    let k = k.trim().parse::<usize>().map_err(|_| Error::invalid("HFA dictionary: enum count"))?;
                    if k > 65536 {
                        return Err(Error::limit("HFA dictionary: enum too long"));
                    }
                    for _ in 0..k {
                        enums.push(p.until(b",")?);
                        p.eat(b',')?;
                    }
                }
                b'o' => {
                    object = p.until(b",")?;
                    p.eat(b',')?;
                }
                b'x' => {
                    let t = self.parse_type(p, depth + 1)?;
                    object = t.name.clone();
                    self.add(t);
                }
                _ => {}
            }
            let name = p.until(b",")?;
            p.eat(b',')?;
            fields.push(Field { count, pointer, ty, enums, object, name });
            if fields.len() > 4096 {
                return Err(Error::limit("HFA dictionary: too many fields"));
            }
        }
        p.eat(b'}')?;
        let name = p.until(b",.")?;
        if p.peek() == Some(b',') {
            p.i += 1;
        }
        Ok(Type { name: name.trim().to_string(), fields })
    }

    pub fn get(&self, name: &str) -> Option<&Type> {
        self.types.iter().find(|t| t.name == name)
    }

    /// Size in bytes of one inline item of a field type (None = variable).
    fn item_size(&self, f: &Field, depth: usize) -> Option<usize> {
        match f.ty {
            b'1' | b'2' | b'4' | b'c' | b'C' => Some(1),
            b'e' | b's' | b'S' => Some(2),
            b't' | b'l' | b'L' | b'f' => Some(4),
            b'd' | b'm' => Some(8),
            b'M' => Some(16),
            b'o' | b'x' => {
                if depth > MAX_DEPTH {
                    return None;
                }
                let t = self.get(&f.object)?;
                let mut n = 0usize;
                for g in &t.fields {
                    if g.pointer != 0 {
                        return None;
                    }
                    n = n.checked_add(self.item_size(g, depth + 1)?.checked_mul(g.count as usize)?)?;
                }
                Some(n)
            }
            _ => None,
        }
    }

    /// Decode `data` as type `ty` → JSON object; `max_items` caps each array.
    pub fn decode(&self, ty: &str, data: &[u8], max_items: usize) -> Result<String> {
        let t = self.get(ty).ok_or_else(|| Error::invalid(format!("HFA dictionary has no type {ty}")))?;
        let mut j = Json::new();
        let mut pos = 0usize;
        self.obj(t, data, &mut pos, &mut j, max_items, 0)?;
        Ok(j.finish())
    }

    fn obj(&self, t: &Type, d: &[u8], pos: &mut usize, j: &mut Json, max: usize, depth: usize) -> Result<()> {
        if depth > MAX_DEPTH {
            return Err(Error::limit("HFA node: nesting too deep"));
        }
        j.obj();
        for f in &t.fields {
            j.key(&f.name);
            self.field(f, d, pos, j, max, depth)?;
        }
        j.end_obj();
        Ok(())
    }

    fn field(&self, f: &Field, d: &[u8], pos: &mut usize, j: &mut Json, max: usize, depth: usize) -> Result<()> {
        let mut n = f.count as u64;
        if f.pointer != 0 {
            n = u32le(d, *pos)? as u64;
            *pos += 8; // count, then the offset of the items, which follow inline
        }
        if n > MAX_ITEMS {
            return Err(Error::limit(format!("HFA field {}: {} items", f.name, n)));
        }
        let n = n as usize;
        match f.ty {
            b'c' | b'C' => {
                let s = d.get(*pos..*pos + n).ok_or_else(|| Error::range(format!("HFA field {}: string past the node data", f.name)))?;
                *pos += n;
                j.str(&cstr(s));
            }
            b'b' => {
                // Base data: rows, columns, item type, object type, then rows × columns values.
                if n == 0 {
                    j.null();
                    return Ok(());
                }
                let rows = u32le(d, *pos)? as usize;
                let cols = u32le(d, *pos + 4)? as usize;
                let it = u16le(d, *pos + 8)?;
                let ot = u16le(d, *pos + 10)?;
                *pos += 12;
                let cnt = rows.checked_mul(cols).ok_or_else(|| Error::range("HFA base data size"))?;
                let bits = pixel_bits(it as u32).ok_or_else(|| Error::invalid(format!("HFA base data type {it}")))?;
                let bytes = (cnt * bits).div_ceil(8);
                let raw = d.get(*pos..*pos + bytes).ok_or_else(|| Error::range(format!("HFA field {}: base data past the node data", f.name)))?;
                *pos += bytes;
                j.obj().kv_int("rows", rows as i64).kv_int("cols", cols as i64).kv_int("type", it as i64).kv_int("objectType", ot as i64);
                j.key("values").arr();
                for i in 0..cnt.min(max) {
                    j.num(sample(raw, it as u32, i));
                }
                j.end_arr().end_obj();
            }
            b'o' | b'x' => {
                let t = self.get(&f.object).ok_or_else(|| Error::invalid(format!("HFA dictionary has no type {}", f.object)))?;
                let single = n == 1 && (f.pointer == b'*' || f.pointer == 0);
                if !single {
                    j.arr();
                }
                for i in 0..n {
                    if i < max {
                        self.obj(t, d, pos, j, max, depth + 1)?;
                    } else {
                        // Skip the rest without output (fixed-size objects only).
                        let sz = self.item_size(f, 0).ok_or_else(|| Error::limit("HFA: long array of variable objects"))?;
                        *pos = pos.checked_add(sz * (n - i)).ok_or_else(|| Error::range("HFA overflow"))?;
                        break;
                    }
                }
                if !single {
                    j.end_arr();
                }
            }
            _ => {
                let sz = self.item_size(f, 0).ok_or_else(|| Error::invalid(format!("HFA field {}: item type '{}'", f.name, f.ty as char)))?;
                let total = sz.checked_mul(n).ok_or_else(|| Error::range("HFA overflow"))?;
                let raw = d.get(*pos..*pos + total).ok_or_else(|| Error::range(format!("HFA field {}: {} bytes past the node data", f.name, total)))?;
                *pos += total;
                let val = |i: usize| -> f64 {
                    let o = i * sz;
                    match f.ty {
                        b'1' | b'2' | b'4' => raw[o] as f64,
                        b'e' | b'S' => u16::from_le_bytes([raw[o], raw[o + 1]]) as f64,
                        b's' => i16::from_le_bytes([raw[o], raw[o + 1]]) as f64,
                        b't' | b'L' => u32::from_le_bytes([raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]) as f64,
                        b'l' => i32::from_le_bytes([raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]) as f64,
                        b'f' => f32::from_le_bytes([raw[o], raw[o + 1], raw[o + 2], raw[o + 3]]) as f64,
                        b'd' | b'm' => f64::from_le_bytes(raw[o..o + 8].try_into().unwrap_or([0; 8])),
                        _ => f64::NAN,
                    }
                };
                let emit = |j: &mut Json, i: usize| {
                    let v = val(i);
                    if f.ty == b'e' {
                        match f.enums.get(v as usize) {
                            Some(s) => j.str(s),
                            None => j.num(v),
                        };
                    } else {
                        j.num(v);
                    }
                };
                if n == 1 && f.pointer != b'p' {
                    emit(j, 0);
                } else {
                    j.arr();
                    for i in 0..n.min(max) {
                        emit(j, i);
                    }
                    j.end_arr();
                }
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Raster blocks

/// Bits per pixel of an HFA pixel type (Eimg_Layer `pixelType` enum).
pub fn pixel_bits(t: u32) -> Option<usize> {
    Some(match t {
        0 => 1,
        1 => 2,
        2 => 4,
        3 | 4 => 8,
        5 | 6 => 16,
        7..=9 => 32,
        10 | 11 => 64,
        12 => 128,
        _ => return None,
    })
}

/// Bytes per output sample: sub-byte types come out as one byte per pixel.
pub fn out_bytes(t: u32) -> Option<usize> {
    pixel_bits(t).map(|b| (b / 8).max(1))
}

fn sample(raw: &[u8], t: u32, i: usize) -> f64 {
    let g = |o: usize, n: usize| raw.get(o..o + n);
    match t {
        0 => raw.get(i >> 3).map(|b| ((b >> (i & 7)) & 1) as f64),
        1 => raw.get(i >> 2).map(|b| ((b >> ((i & 3) * 2)) & 3) as f64),
        2 => raw.get(i >> 1).map(|b| ((b >> ((i & 1) * 4)) & 15) as f64),
        3 => raw.get(i).map(|&b| b as f64),
        4 => raw.get(i).map(|&b| b as i8 as f64),
        5 => g(i * 2, 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as f64),
        6 => g(i * 2, 2).map(|s| i16::from_le_bytes([s[0], s[1]]) as f64),
        7 => g(i * 4, 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64),
        8 => g(i * 4, 4).map(|s| i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64),
        9 => g(i * 4, 4).map(|s| f32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64),
        10 => g(i * 8, 8).map(|s| f64::from_le_bytes(s.try_into().unwrap_or([0; 8]))),
        11 => g(i * 8, 4).map(|s| f32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64),
        12 => g(i * 16, 8).map(|s| f64::from_le_bytes(s.try_into().unwrap_or([0; 8]))),
        _ => None,
    }
    .unwrap_or(f64::NAN)
}

/// `Edms_State` node data → Uint32 triples (offset, size, flags) per block; flags bit 0 = valid,
/// bit 1 = compressed. Uses the dictionary for the layout of the record.
pub fn block_table(dict: &Dict, data: &[u8]) -> Result<Vec<u32>> {
    let t = dict.get("Edms_State").ok_or_else(|| Error::invalid("HFA dictionary has no Edms_State"))?;
    let vbi = dict.get("Edms_VirtualBlockInfo").ok_or_else(|| Error::invalid("HFA dictionary has no Edms_VirtualBlockInfo"))?;
    // Field offsets inside one Edms_VirtualBlockInfo, from the dictionary.
    let mut offs: Vec<(&str, (usize, u8))> = Vec::new();
    let mut sz = 0usize;
    for f in &vbi.fields {
        let s = dict.item_size(f, 0).ok_or_else(|| Error::invalid("HFA: variable Edms_VirtualBlockInfo"))? * f.count as usize;
        offs.push((f.name.as_str(), (sz, f.ty)));
        sz += s;
    }
    let mut pos = 0usize;
    for f in &t.fields {
        if f.name == "blockinfo" {
            let n = u32le(data, pos)? as usize;
            pos += 8;
            if n as u64 > 1 << 26 {
                return Err(Error::limit("HFA: more than 67 M blocks"));
            }
            let need = n.checked_mul(sz).ok_or_else(|| Error::range("HFA overflow"))?;
            if pos + need > data.len() {
                return Err(gw_abi::err!(RANGE, "HFA Edms_State: {n} block records need {need} bytes, the node has {have}", n, need, have = data.len() - pos.min(data.len())));
            }
            let mut out = Vec::with_capacity(n * 3);
            let get = |b: &[u8], name: &str| -> u32 {
                match offs.iter().find(|x| x.0 == name).map(|x| &x.1) {
                    // Bounds-checked: a hostile dictionary may give a field a 1-byte type at the end.
                    Some(&(o, ty)) => match ty {
                        b'e' | b's' | b'S' => b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as u32).unwrap_or(0),
                        b'1' | b'2' | b'4' | b'c' | b'C' => b.get(o).map(|&v| v as u32).unwrap_or(0),
                        _ => b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).unwrap_or(0),
                    },
                    None => 0,
                }
            };
            for i in 0..n {
                let b = &data[pos + i * sz..pos + (i + 1) * sz];
                let valid = get(b, "logvalid") != 0;
                let comp = get(b, "compressionType") != 0;
                out.extend_from_slice(&[get(b, "offset"), get(b, "size"), valid as u32 | ((comp as u32) << 1)]);
            }
            return Ok(out);
        }
        // Skip the fields before blockinfo.
        if f.pointer != 0 {
            let n = u32le(data, pos)? as usize;
            pos += 8 + n * dict.item_size(f, 0).ok_or_else(|| Error::invalid("HFA: variable field before blockinfo"))?;
        } else {
            pos += dict.item_size(f, 0).ok_or_else(|| Error::invalid("HFA: variable field before blockinfo"))? * f.count as usize;
        }
    }
    Err(Error::invalid("HFA Edms_State has no blockinfo"))
}

/// Decode one block: `n` = pixels in the block; `compressed` = RLE ("ESRI GRID compression").
/// Output: little-endian samples, `out_bytes(t)` each (sub-byte types unpacked).
pub fn decode_block(b: &[u8], t: u32, n: usize, compressed: bool) -> Result<Vec<u8>> {
    let ob = out_bytes(t).ok_or_else(|| gw_abi::err!(UNSUPPORTED, "HFA pixel type {t}", t))?;
    if n > 1 << 26 {
        return Err(Error::limit("HFA block larger than 67 M pixels"));
    }
    let mut out = vec![0u8; n * ob];
    if !compressed {
        let bits = pixel_bits(t).unwrap_or(8);
        if bits >= 8 {
            let need = n * ob;
            let src = b.get(..need).ok_or_else(|| gw_abi::err!(RANGE, "HFA block: {need} bytes needed, {have} read", need, have = b.len()))?;
            out.copy_from_slice(src);
        } else {
            if b.len() < (n * bits).div_ceil(8) {
                return Err(Error::range("HFA block: short sub-byte block"));
            }
            for (i, o) in out.iter_mut().enumerate() {
                *o = sample(b, t, i) as u8;
            }
        }
        return Ok(out);
    }
    if b.len() < 13 {
        return Err(Error::range("HFA RLE block shorter than its 13-byte header"));
    }
    let min = u32le(b, 0)?;
    let runs = u32le(b, 4)? as i32;
    let data_off = u32le(b, 8)? as i32;
    let nbits = b[12] as usize;
    if !matches!(nbits, 0 | 1 | 2 | 4 | 8 | 16 | 32) {
        return Err(gw_abi::err!(INVALID, "HFA RLE block: {nbits}-bit values", nbits));
    }
    // Values: packed LSB first below 8 bits, big-endian at 16 and 32 bits.
    let value = |vals: &[u8], k: usize| -> Result<u32> {
        let e = || Error::range("HFA RLE block: values past the block");
        Ok(match nbits {
            0 => 0,
            1 | 2 | 4 => {
                let bit = k * nbits;
                let byte = *vals.get(bit >> 3).ok_or_else(e)?;
                ((byte >> (bit & 7)) as u32) & ((1u32 << nbits) - 1)
            }
            8 => *vals.get(k).ok_or_else(e)? as u32,
            16 => {
                let s = vals.get(k * 2..k * 2 + 2).ok_or_else(e)?;
                u16::from_be_bytes([s[0], s[1]]) as u32
            }
            _ => {
                let s = vals.get(k * 4..k * 4 + 4).ok_or_else(e)?;
                u32::from_be_bytes([s[0], s[1], s[2], s[3]])
            }
        })
    };
    let put = |out: &mut [u8], i: usize, raw: u32| {
        let v = raw.wrapping_add(min);
        let o = i * ob;
        match t {
            0..=4 => out[o] = v as u8,
            5 | 6 => out[o..o + 2].copy_from_slice(&(v as u16).to_le_bytes()),
            7..=9 => out[o..o + 4].copy_from_slice(&v.to_le_bytes()),
            // f64 runs carry 32-bit integers (GDAL writes RLE only up to 32 bits).
            10 => out[o..o + 8].copy_from_slice(&(v as i32 as f64).to_le_bytes()),
            _ => {}
        }
    };
    if runs == -1 {
        let vals = &b[13..];
        for i in 0..n {
            put(&mut out, i, value(vals, i)?);
        }
        return Ok(out);
    }
    if runs < 0 || data_off < 13 || data_off as usize > b.len() {
        return Err(Error::invalid("HFA RLE block: bad run count or data offset"));
    }
    let vals = &b[data_off as usize..];
    let mut c = 13usize;
    let mut done = 0usize;
    for r in 0..runs as usize {
        let b0 = *b.get(c).ok_or_else(|| Error::range("HFA RLE block: run counts past the block"))?;
        let nb = 1 + (b0 >> 6) as usize;
        let s = b.get(c..c + nb).ok_or_else(|| Error::range("HFA RLE block: run count past the block"))?;
        let mut rep = (b0 & 0x3f) as usize;
        for &x in &s[1..] {
            rep = rep * 256 + x as usize;
        }
        c += nb;
        let v = value(vals, r)?;
        let rep = rep.min(n - done);
        for _ in 0..rep {
            put(&mut out, done, v);
            done += 1;
        }
        if done >= n {
            break;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Writer

/// GDAL's default dictionary entries for the types the writer emits (hfadictionary.cpp), so the
/// file reads in GDAL and ERDAS alike.
pub const DICT: &str = concat!(
    "{1:lversion,1:LfreeList,1:LrootEntryPtr,1:sentryHeaderLength,1:LdictionaryPtr,}Ehfa_File,",
    "{1:Lnext,1:Lprev,1:Lparent,1:Lchild,1:Ldata,1:ldataSize,64:cname,32:ctype,1:tmodTime,}Ehfa_Entry,",
    "{16:clabel,1:LheaderPtr,}Ehfa_HeaderTag,",
    "{1:LfreeList,1:lfreeSize,}Ehfa_FreeListNode,",
    "{1:lsize,1:Lptr,}Ehfa_Data,",
    "{1:lwidth,1:lheight,1:e3:thematic,athematic,fft of real-valued data,layerType,1:e13:u1,u2,u4,u8,s8,u16,s16,u32,s32,f32,f64,c64,c128,pixelType,1:lblockWidth,1:lblockHeight,}Eimg_Layer,",
    "{1:lwidth,1:lheight,1:e3:thematic,athematic,fft of real-valued data,layerType,1:e13:u1,u2,u4,u8,s8,u16,s16,u32,s32,f32,f64,c64,c128,pixelType,1:lblockWidth,1:lblockHeight,}Eimg_Layer_SubSample,",
    "{1:e2:raster,vector,type,1:LdictionaryPtr,}Ehfa_Layer,",
    "{1:sfileCode,1:Loffset,1:lsize,1:e2:false,true,logvalid,1:e2:no compression,ESRI GRID compression,compressionType,}Edms_VirtualBlockInfo,",
    "{1:lmin,1:lmax,}Edms_FreeIDList,",
    "{1:lnumvirtualblocks,1:lnumobjectsperblock,1:lnextobjectnum,1:e2:no compression,RLC compression,compressionType,0:poEdms_VirtualBlockInfo,blockinfo,0:poEdms_FreeIDList,freelist,1:tmodTime,}Edms_State,",
    "{0:pcstring,}Emif_String,",
    "{1:oEmif_String,dependent,}Eimg_DependentFile,",
    "{1:lnumrows,1:lnumcolumns,1:e13:EGDA_TYPE_U1,EGDA_TYPE_U2,EGDA_TYPE_U4,EGDA_TYPE_U8,EGDA_TYPE_S8,EGDA_TYPE_U16,EGDA_TYPE_S16,EGDA_TYPE_U32,EGDA_TYPE_S32,EGDA_TYPE_F32,EGDA_TYPE_F64,EGDA_TYPE_C64,EGDA_TYPE_C128,datatype,1:e4:EGDA_SCALAR_OBJECT,EGDA_TABLE_OBJECT,EGDA_MATRIX_OBJECT,EGDA_RASTER_OBJECT,objecttype,}Egda_BaseData,",
    "{1:*bvalueBD,}Eimg_NonInitializedValue,",
    "{1:dx,1:dy,}Eprj_Coordinate,",
    "{1:dwidth,1:dheight,}Eprj_Size,",
    "{0:pcproName,1:*oEprj_Coordinate,upperLeftCenter,1:*oEprj_Coordinate,lowerRightCenter,1:*oEprj_Size,pixelSize,0:pcunits,}Eprj_MapInfo,",
    "{0:pcdatumname,1:e3:EPRJ_DATUM_PARAMETRIC,EPRJ_DATUM_GRID,EPRJ_DATUM_REGRESSION,type,0:pdparams,0:pcgridname,}Eprj_Datum,",
    "{0:pcsphereName,1:da,1:db,1:deSquared,1:dradius,}Eprj_Spheroid,",
    "{1:e2:EPRJ_INTERNAL,EPRJ_EXTERNAL,proType,1:lproNumber,0:pcproExeName,0:pcproName,1:lproZone,0:pdproParams,1:*oEprj_Spheroid,proSpheroid,}Eprj_ProParameters,",
    "{1:dminimum,1:dmaximum,1:dmean,1:dmedian,1:dmode,1:dstddev,}Esta_Statistics,",
    "{1:lnumBins,1:e4:direct,linear,logarithmic,explicit,binFunctionType,1:dminLimit,1:dmaxLimit,1:*bbinLimits,}Edsc_BinFunction,",
    "{1:lnumrows,}Edsc_Table,",
    "{1:lnumRows,1:LcolumnDataPtr,1:e4:integer,real,complex,string,dataType,1:lmaxNumChars,}Edsc_Column,",
    "{1:oEmif_String,projection,1:oEmif_String,units,}Eimg_MapInformation,",
    "."
);

/// Little-endian writer of node data.
struct B(Vec<u8>);
impl B {
    fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    /// A counted pointer header: count, then the absolute offset of the items that follow.
    fn ptr(&mut self, count: u32, base: u32) {
        self.u32(count);
        let at = base + self.0.len() as u32 + 4;
        self.u32(if count == 0 { 0 } else { at });
    }
    fn string(&mut self, s: &str, base: u32) {
        self.ptr(s.len() as u32 + 1, base);
        self.0.extend_from_slice(s.as_bytes());
        self.0.push(0);
    }
}

#[derive(Debug, Clone)]
struct Node {
    name: String,
    ty: String,
    /// Index of the parent in the node list (None = root).
    parent: Option<usize>,
    /// Node data, built with `base` = 0; rebuilt with the real data offset by `make`.
    make: NodeData,
    pos: u32,
}

#[derive(Debug, Clone)]
enum NodeData {
    None,
    Layer { w: u32, h: u32, thematic: bool, pt: u16, bw: u32, bh: u32 },
    Dms { blocks: u32, block_bytes: u32, first: u32 },
    MapInfo { proj: String, ul: (f64, f64), lr: (f64, f64), px: (f64, f64), units: String },
    Pro { number: u32, external: bool, exe: String, name: String, zone: u32, params: Vec<f64>, sph: String, a: f64, b: f64 },
    Datum { name: String, params: Vec<f64> },
    Stats([f64; 6]),
    NoData { pt: u16, v: f64 },
}

fn encode_sample(b: &mut B, pt: u16, v: f64) {
    match pt {
        0..=3 => b.0.push(v as u8),
        4 => b.0.push(v as i8 as u8),
        5 => b.u16(v as u16),
        6 => b.0.extend_from_slice(&(v as i16).to_le_bytes()),
        7 => b.u32(v as u32),
        8 => b.0.extend_from_slice(&(v as i32).to_le_bytes()),
        9 => b.0.extend_from_slice(&(v as f32).to_le_bytes()),
        _ => b.f64(v),
    }
}

impl NodeData {
    fn bytes(&self, base: u32) -> Vec<u8> {
        let mut b = B(Vec::new());
        match self {
            NodeData::None => {}
            NodeData::Layer { w, h, thematic, pt, bw, bh } => {
                b.u32(*w);
                b.u32(*h);
                b.u16(if *thematic { 0 } else { 1 });
                b.u16(*pt);
                b.u32(*bw);
                b.u32(*bh);
            }
            NodeData::Dms { blocks, block_bytes, first } => {
                b.u32(*blocks);
                b.u32(*blocks);
                b.u32(0);
                b.u16(0); // no compression
                b.ptr(*blocks, base);
                for i in 0..*blocks {
                    b.u16(0); // fileCode
                    b.u32(first + i * block_bytes);
                    b.u32(*block_bytes);
                    b.u16(1); // logvalid
                    b.u16(0); // no compression
                }
                b.ptr(0, base); // freelist
                b.u32(0); // modTime
            }
            NodeData::MapInfo { proj, ul, lr, px, units } => {
                b.string(proj, base);
                for c in [ul, lr, px] {
                    b.ptr(1, base);
                    b.f64(c.0);
                    b.f64(c.1);
                }
                b.string(units, base);
            }
            NodeData::Pro { number, external, exe, name, zone, params, sph, a, b: bb } => {
                b.u16(*external as u16);
                b.u32(*number);
                b.string(exe, base);
                b.string(name, base);
                b.u32(*zone);
                b.ptr(params.len() as u32, base);
                for &p in params {
                    b.f64(p);
                }
                b.ptr(1, base);
                b.string(sph, base);
                let e2 = if *a > 0.0 { 1.0 - (bb * bb) / (a * a) } else { 0.0 };
                b.f64(*a);
                b.f64(*bb);
                b.f64(e2);
                b.f64(*a);
            }
            NodeData::Datum { name, params } => {
                b.string(name, base);
                b.u16(0); // parametric
                b.ptr(params.len() as u32, base);
                for &p in params {
                    b.f64(p);
                }
                b.string("", base);
            }
            NodeData::Stats(s) => {
                for &v in s {
                    b.f64(v);
                }
            }
            NodeData::NoData { pt, v } => {
                let bits = pixel_bits(*pt as u32).unwrap_or(8);
                let payload = 12 + bits.div_ceil(8);
                b.u32(payload as u32);
                let at = base + 8;
                b.u32(at);
                b.u32(1);
                b.u32(1);
                b.u16(*pt);
                b.u16(0); // scalar
                encode_sample(&mut b, *pt, *v);
            }
        }
        b.0
    }
}

fn nums(s: &str) -> Result<Vec<f64>> {
    s.split_whitespace().map(|x| x.parse::<f64>().map_err(|_| Error::invalid(format!("HFA spec: number '{x}'")))).collect()
}

/// Write the metadata part of an HFA file from a line spec:
///
/// ```text
/// size <width> <height>             block 64 × 64 is used
/// band <name> <pixelType 0..10> [thematic]
/// nodata <value>                    (last band)
/// stats <min> <max> <mean> <median> <mode> <stddev>   (last band)
/// overview <width> <height>         (an internal Eimg_Layer_SubSample of the last band)
/// mapinfo <proName>|<units>|<ulx> <uly> <lrx> <lry> <pw> <ph>
/// pro <number> <zone> <sphere a> <sphere b>|<proName>|<sphereName>|<15 params>   (external if number < 0: then proName is the exe name)
/// datum <name>|<7 params>
/// ```
///
/// Returns (metadata bytes, layout JSON `{dataStart, fileSize, layers:[{band, level, offset, blocks, blockBytes, blocksX, blocksY, width, height}]}`).
/// Layers' blocks are uncompressed and consecutive, written by the caller from `dataStart` on.
pub fn write(spec: &str) -> Result<(Vec<u8>, String)> {
    const BW: u32 = 64;
    let mut size = (0u32, 0u32);
    let mut nodes: Vec<Node> = vec![Node { name: "root".into(), ty: "root".into(), parent: None, make: NodeData::None, pos: 0 }];
    let mut bands: Vec<usize> = Vec::new();
    // (node index of Edms_State, band, level, w, h, pixel type)
    let mut layers: Vec<(usize, usize, usize, u32, u32, u16)> = Vec::new();
    let mut pro: Option<NodeData> = None;
    let mut datum: Option<NodeData> = None;
    let mut mapinfo: Option<NodeData> = None;
    let add = |nodes: &mut Vec<Node>, name: &str, ty: &str, parent: usize, make: NodeData| -> usize {
        nodes.push(Node { name: name.into(), ty: ty.into(), parent: Some(parent), make, pos: 0 });
        nodes.len() - 1
    };
    for (ln, line) in spec.lines().enumerate() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let (kw, rest) = line.split_once(' ').unwrap_or((line, ""));
        let err = |m: &str| Error::invalid(format!("HFA spec line {}: {m}", ln + 1));
        match kw {
            "size" => {
                let v = nums(rest)?;
                if v.len() != 2 || v[0] < 1.0 || v[1] < 1.0 || v[0] > 1e7 || v[1] > 1e7 {
                    return Err(err("size w h"));
                }
                size = (v[0] as u32, v[1] as u32);
            }
            "band" | "overview" => {
                let mut p = rest.split_whitespace();
                let (name, w, h, pt, thematic) = if kw == "band" {
                    let name = p.next().ok_or_else(|| err("band name"))?.to_string();
                    let pt = p.next().ok_or_else(|| err("pixel type"))?.parse::<u16>().map_err(|_| err("pixel type"))?;
                    (name, size.0, size.1, pt, p.next() == Some("thematic"))
                } else {
                    let &bi = bands.last().ok_or_else(|| err("overview before band"))?;
                    let pt = match nodes[bi].make {
                        NodeData::Layer { pt, .. } => pt,
                        _ => 3,
                    };
                    let w = p.next().and_then(|s| s.parse::<u32>().ok()).ok_or_else(|| err("overview w"))?;
                    let h = p.next().and_then(|s| s.parse::<u32>().ok()).ok_or_else(|| err("overview h"))?;
                    (format!("_ss_{}_", (size.0 as f64 / w.max(1) as f64).round() as u32), w, h, pt, false)
                };
                if size.0 == 0 || pt > 10 || w == 0 || h == 0 || w > size.0 || h > size.1 {
                    return Err(err("size first; pixel type 0..10"));
                }
                let parent = if kw == "band" { 0 } else { *bands.last().unwrap_or(&0) };
                let li = add(&mut nodes, &name, if kw == "band" { "Eimg_Layer" } else { "Eimg_Layer_SubSample" }, parent, NodeData::Layer { w, h, thematic, pt, bw: BW, bh: BW });
                if kw == "band" {
                    bands.push(li);
                }
                let d = add(&mut nodes, "RasterDMS", "Edms_State", li, NodeData::None);
                layers.push((d, bands.len() - 1, if kw == "band" { 0 } else { layers.iter().filter(|l| l.1 == bands.len() - 1).count() }, w, h, pt));
            }
            "nodata" => {
                let &bi = bands.last().ok_or_else(|| err("nodata before band"))?;
                let pt = match nodes[bi].make {
                    NodeData::Layer { pt, .. } => pt,
                    _ => 3,
                };
                let v = rest.trim().parse::<f64>().map_err(|_| err("nodata value"))?;
                add(&mut nodes, "Eimg_NonInitializedValue", "Eimg_NonInitializedValue", bi, NodeData::NoData { pt, v });
            }
            "stats" => {
                let &bi = bands.last().ok_or_else(|| err("stats before band"))?;
                let v = nums(rest)?;
                if v.len() != 6 {
                    return Err(err("stats needs 6 values"));
                }
                add(&mut nodes, "Statistics", "Esta_Statistics", bi, NodeData::Stats([v[0], v[1], v[2], v[3], v[4], v[5]]));
            }
            "mapinfo" => {
                let p: Vec<&str> = rest.splitn(3, '|').collect();
                if p.len() != 3 {
                    return Err(err("mapinfo proName|units|numbers"));
                }
                let v = nums(p[2])?;
                if v.len() != 6 {
                    return Err(err("mapinfo needs 6 numbers"));
                }
                mapinfo = Some(NodeData::MapInfo { proj: p[0].into(), units: p[1].into(), ul: (v[0], v[1]), lr: (v[2], v[3]), px: (v[4], v[5]) });
            }
            "pro" => {
                let p: Vec<&str> = rest.splitn(4, '|').collect();
                if p.len() != 4 {
                    return Err(err("pro numbers|proName|sphereName|params"));
                }
                let v = nums(p[0])?;
                if v.len() != 4 {
                    return Err(err("pro number zone a b"));
                }
                let params = nums(p[3])?;
                let external = v[0] < 0.0;
                pro = Some(NodeData::Pro {
                    number: if external { 0 } else { v[0] as u32 },
                    external,
                    exe: if external { p[1].into() } else { String::new() },
                    name: p[1].into(),
                    zone: v[1] as u32,
                    params,
                    sph: p[2].into(),
                    a: v[2],
                    b: v[3],
                });
            }
            "datum" => {
                let (name, ps) = rest.split_once('|').ok_or_else(|| err("datum name|params"))?;
                datum = Some(NodeData::Datum { name: name.into(), params: nums(ps)? });
            }
            _ => return Err(err(&format!("unknown keyword {kw}"))),
        }
    }
    if bands.is_empty() {
        return Err(Error::invalid("HFA spec: no band"));
    }
    // Map information and projection on every band (ERDAS and GDAL read them per layer).
    for &bi in bands.clone().iter() {
        if let Some(m) = &mapinfo {
            add(&mut nodes, "Map_Info", "Eprj_MapInfo", bi, m.clone());
        }
        if let Some(p) = &pro {
            let pi = add(&mut nodes, "Projection", "Eprj_ProParameters", bi, p.clone());
            if let Some(d) = &datum {
                add(&mut nodes, "Datum", "Eprj_Datum", pi, d.clone());
            }
        }
    }
    // Layout: tag (16) + header pointer (4), Ehfa_File (18), dictionary, then each entry header
    // (128 bytes) followed by its data, then the raster blocks.
    let mut off = 20u32 + 18;
    let dict_ptr = off;
    off += DICT.len() as u32 + 1;
    // Block tables need their counts first (their sizes do not depend on the offsets).
    for &(d, _, _, w, h, pt) in &layers {
        let bx = w.div_ceil(BW);
        let by = h.div_ceil(BW);
        let bb = ((BW * BW) as usize * pixel_bits(pt as u32).unwrap_or(8)).div_ceil(8) as u32;
        nodes[d].make = NodeData::Dms { blocks: bx * by, block_bytes: bb, first: 0 };
    }
    for n in nodes.iter_mut() {
        n.pos = off;
        off = off.checked_add(128 + n.make.bytes(0).len() as u32).ok_or_else(|| Error::limit("HFA metadata over 4 GB"))?;
    }
    let data_start = off;
    let mut cur = data_start as u64;
    let mut lj = Json::new();
    lj.arr();
    for &(d, band, level, w, h, _) in &layers {
        if let NodeData::Dms { blocks, block_bytes, .. } = nodes[d].make {
            if cur + blocks as u64 * block_bytes as u64 > u32::MAX as u64 {
                return Err(Error::limit("the image is larger than 4 GB: HFA without a spill file cannot hold it"));
            }
            nodes[d].make = NodeData::Dms { blocks, block_bytes, first: cur as u32 };
            lj.obj().kv_int("band", band as i64).kv_int("level", level as i64).kv_num("offset", cur as f64).kv_int("blocks", blocks as i64).kv_int("blockBytes", block_bytes as i64);
            lj.kv_int("blocksX", w.div_ceil(BW) as i64).kv_int("blocksY", h.div_ceil(BW) as i64).kv_int("width", w as i64).kv_int("height", h as i64).kv_int("blockSize", BW as i64).end_obj();
            cur += blocks as u64 * block_bytes as u64;
        }
    }
    lj.end_arr();
    // Tree links.
    let n = nodes.len();
    let mut out = Vec::with_capacity(data_start as usize);
    out.extend_from_slice(b"EHFA_HEADER_TAG\0");
    out.extend_from_slice(&20u32.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes()); // version
    out.extend_from_slice(&0u32.to_le_bytes()); // free list
    out.extend_from_slice(&nodes[0].pos.to_le_bytes());
    out.extend_from_slice(&128u16.to_le_bytes());
    out.extend_from_slice(&dict_ptr.to_le_bytes());
    out.extend_from_slice(DICT.as_bytes());
    out.push(0);
    for i in 0..n {
        let parent = nodes[i].parent;
        let sib: Vec<usize> = (0..n).filter(|&k| nodes[k].parent == parent && parent.is_some()).collect();
        let me = sib.iter().position(|&k| k == i);
        let next = me.and_then(|m| sib.get(m + 1)).map(|&k| nodes[k].pos).unwrap_or(0);
        let prev = me.and_then(|m| if m > 0 { sib.get(m - 1) } else { None }).map(|&k| nodes[k].pos).unwrap_or(0);
        let child = (0..n).find(|&k| nodes[k].parent == Some(i)).map(|k| nodes[k].pos).unwrap_or(0);
        let data_pos = nodes[i].pos + 128;
        let data = nodes[i].make.bytes(data_pos);
        debug_assert_eq!(out.len() as u32, nodes[i].pos);
        for v in [next, prev, parent.map(|p| nodes[p].pos).unwrap_or(0), child, if data.is_empty() { 0 } else { data_pos }, data.len() as u32] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let mut name = [0u8; 64];
        let nb = nodes[i].name.as_bytes();
        name[..nb.len().min(63)].copy_from_slice(&nb[..nb.len().min(63)]);
        out.extend_from_slice(&name);
        let mut ty = [0u8; 32];
        let tb = nodes[i].ty.as_bytes();
        ty[..tb.len().min(31)].copy_from_slice(&tb[..tb.len().min(31)]);
        out.extend_from_slice(&ty);
        out.extend_from_slice(&[0u8; 8]); // modTime + padding to 128
        out.extend_from_slice(&data);
    }
    let mut j = Json::new();
    j.obj().kv_num("dataStart", data_start as f64).kv_num("fileSize", cur as f64).key("layers").raw(&lj.finish()).end_obj();
    Ok((out, j.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn walk(file: &[u8]) -> (Dict, Vec<(String, String, u32, u32)>) {
        let h = file_header(file).unwrap();
        let root = h.split("\"root\":").nth(1).unwrap().split(',').next().unwrap().parse::<usize>().unwrap();
        let dp = h.split("\"dictionary\":").nth(1).unwrap().split('}').next().unwrap().parse::<usize>().unwrap();
        let dict = Dict::parse(&file[dp..]).unwrap();
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(p) = stack.pop() {
            let e = &file[p..p + 128];
            let next = u32le(e, 0).unwrap();
            let child = u32le(e, 12).unwrap();
            out.push((cstr(&e[24..88]), cstr(&e[88..120]), u32le(e, 16).unwrap(), u32le(e, 20).unwrap()));
            if next != 0 {
                stack.push(next as usize);
            }
            if child != 0 {
                stack.push(child as usize);
            }
        }
        (dict, out)
    }

    #[test]
    fn writer_output_reads_back() {
        let spec = "size 100 70\nband Layer_1 9\nnodata -9999\nstats 1 2 1.5 1.5 1 0.5\noverview 50 35\nband B2 3 thematic\nmapinfo UTM|meters|440750 3751290 446690 3747150 60 60\npro 1 11 6378206.4 6356583.8|UTM|Clarke 1866|0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\ndatum NAD27|0 0 0 0 0 0 0\n";
        let (meta, layout) = write(spec).unwrap();
        assert!(layout.contains("\"blocks\":4"), "{layout}"); // 2 × 2 blocks of 64 for 100 × 70
        let (dict, nodes) = walk(&meta);
        let names: Vec<&str> = nodes.iter().map(|n| n.0.as_str()).collect();
        for want in ["root", "Layer_1", "RasterDMS", "Eimg_NonInitializedValue", "Statistics", "_ss_2_", "B2", "Map_Info", "Projection", "Datum"] {
            assert!(names.contains(&want), "{want} in {names:?}");
        }
        for (name, ty, pos, size) in &nodes {
            if ty == "root" {
                continue;
            }
            let d = &meta[*pos as usize..(*pos + *size) as usize];
            let j = dict.decode(ty, d, 64).unwrap_or_else(|e| panic!("{name} {ty}: {e:?}"));
            if ty == "Eprj_MapInfo" {
                assert!(j.contains("\"proName\":\"UTM\"") && j.contains("\"x\":440750"), "{j}");
            }
            if ty == "Eimg_NonInitializedValue" {
                assert!(j.contains("-9999"), "{j}");
            }
            if ty == "Edms_State" {
                let t = block_table(&dict, d).unwrap();
                assert_eq!(t[2], 1);
                assert!(t[0] as usize >= meta.len());
            }
        }
        // Prefixes fail without panicking.
        for n in (0..meta.len()).step_by(7) {
            let _ = file_header(&meta[..n]);
            let _ = Dict::parse(&meta[38..n.max(38)]);
        }
    }

    #[test]
    fn rle_and_bits() {
        // Two runs: 3 × (min + 1), 2 × (min + 0) at 8 bits.
        let mut b = Vec::new();
        b.extend_from_slice(&10u32.to_le_bytes());
        b.extend_from_slice(&2u32.to_le_bytes());
        b.extend_from_slice(&15u32.to_le_bytes());
        b.push(8);
        b.push(3);
        b.push(2);
        b.extend_from_slice(&[1, 0]);
        assert_eq!(decode_block(&b, 3, 5, true).unwrap(), vec![11, 11, 11, 10, 10]);
        // Reduced precision (runs = -1), 4 bits.
        let mut c = Vec::new();
        c.extend_from_slice(&100u32.to_le_bytes());
        c.extend_from_slice(&(-1i32 as u32).to_le_bytes());
        c.extend_from_slice(&13u32.to_le_bytes());
        c.push(4);
        c.push(0x21);
        let o = decode_block(&c, 5, 2, true).unwrap();
        assert_eq!(o, vec![101, 0, 102, 0]);
        // 1-bit uncompressed, LSB first.
        assert_eq!(decode_block(&[0b0000_0101], 0, 4, false).unwrap(), vec![1, 0, 1, 0]);
        assert!(decode_block(&b[..14], 3, 5, true).is_err());
        assert!(decode_block(&[1, 2], 9, 1, false).is_err());
    }

    #[test]
    fn dictionary_with_inline_types() {
        let d = Dict::parse(b"{1:x{0:pcstring,}Emif_String,type,1:lx,}T,.").unwrap();
        assert!(d.get("Emif_String").is_some());
        let mut data = Vec::new();
        data.extend_from_slice(&3u32.to_le_bytes());
        data.extend_from_slice(&0u32.to_le_bytes());
        data.extend_from_slice(b"ab\0");
        data.extend_from_slice(&7i32.to_le_bytes());
        let j = d.decode("T", &data, 10).unwrap();
        assert_eq!(j, r#"{"type":{"string":"ab"},"x":7}"#);
        assert!(Dict::parse(b"{1:l").is_err());
        assert!(Dict::parse(b"").is_err());
    }
}
