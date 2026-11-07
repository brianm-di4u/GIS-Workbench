//! CPHD phase history: XML, PVP, support arrays, signal blocks (FC-21, REQ-FMT-49..51).
//!
//! CPHD 1.0.x and 1.1.0 (NGA.STND.0068): a text header of `KEY := value` lines after `CPHD/<version>`,
//! ended by a form feed and a newline; an XML block; then the optional support block, the PVP block and
//! the signal block at the byte offsets the header gives. Binary data is big-endian. Each channel holds
//! `NumVectors` vectors of `NumSamples` complex samples (CI2, CI4 or CF8) and one PVP record per vector
//! (`NumBytesPVP` bytes; field offsets and sizes in 8-byte words). Everything here checks every size
//! and offset against the block that holds it, with overflow-checked arithmetic.
//!
//! The subset writer (REQ-FMT-51) keeps the source version, copies support arrays as they are and
//! recomputes the per-channel layout, the timeline, the band and the sample coordinates of the subset.

use crate::xml::{self, Node};
use gw_abi::{Error, Json, Result};

pub const MAX_HEADER: usize = 1 << 16;

/// The file header: version, key/value pairs and block extents.
#[derive(Clone, Debug, Default)]
pub struct Header {
    pub version: String,
    pub kvs: Vec<(String, String)>,
    pub xml: (u64, u64),
    pub support: Option<(u64, u64)>,
    pub pvp: (u64, u64),
    pub signal: (u64, u64),
    /// Bytes of the header up to and including the form feed + newline.
    pub len: usize,
}

impl Header {
    pub fn get(&self, k: &str) -> Option<&str> {
        self.kvs.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
}

fn need_u64(h: &[(String, String)], k: &str) -> Result<u64> {
    let v = h.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str()).ok_or_else(|| gw_abi::err!(INVALID, "CPHD header has no {k}", k))?;
    v.trim().parse::<u64>().map_err(|_| gw_abi::err!(INVALID, "CPHD header {k} is not a number ({v})", k, v))
}

/// Parse the file header from the first bytes of the file (at most 64 KiB are looked at).
pub fn parse_header(b: &[u8]) -> Result<Header> {
    let b = &b[..b.len().min(MAX_HEADER)];
    if !b.starts_with(b"CPHD/") {
        return Err(Error::invalid("not a CPHD file (no CPHD/ version line)"));
    }
    let end = b.windows(2).position(|w| w == b"\x0c\n").ok_or_else(|| Error::invalid("CPHD header is not terminated (no form feed within 64 KiB)"))?;
    let text = String::from_utf8_lossy(&b[..end]);
    let mut lines = text.split('\n');
    let first = lines.next().unwrap_or("").trim_end_matches('\r');
    let version = first[5..].trim().to_string();
    if !version.starts_with("1.") {
        return Err(gw_abi::err!(UNSUPPORTED, "CPHD version {version} is not read (CPHD 1.0 and 1.1 are)", version));
    }
    let mut kvs = Vec::new();
    for l in lines {
        let l = l.trim_end_matches('\r');
        if l.trim().is_empty() {
            continue;
        }
        let Some(p) = l.find(":=") else { return Err(gw_abi::err!(INVALID, "CPHD header line without ':=' ({line})", line = crate::bytes::printable(l.as_bytes(), 60))) };
        kvs.push((l[..p].trim().to_string(), l[p + 2..].trim().to_string()));
        if kvs.len() > 1000 {
            return Err(Error::limit("CPHD header has too many lines"));
        }
    }
    let xml = (need_u64(&kvs, "XML_BLOCK_BYTE_OFFSET")?, need_u64(&kvs, "XML_BLOCK_SIZE")?);
    let pvp = (need_u64(&kvs, "PVP_BLOCK_BYTE_OFFSET")?, need_u64(&kvs, "PVP_BLOCK_SIZE")?);
    let signal = (need_u64(&kvs, "SIGNAL_BLOCK_BYTE_OFFSET")?, need_u64(&kvs, "SIGNAL_BLOCK_SIZE")?);
    let support = if kvs.iter().any(|(k, _)| k == "SUPPORT_BLOCK_SIZE") { Some((need_u64(&kvs, "SUPPORT_BLOCK_BYTE_OFFSET")?, need_u64(&kvs, "SUPPORT_BLOCK_SIZE")?)) } else { None };
    if xml.1 as usize > xml::MAX_BYTES {
        return Err(Error::limit("CPHD XML block is larger than 32 MiB"));
    }
    Ok(Header { version, kvs, xml, support, pvp, signal, len: end + 2 })
}

/// One binary format component, e.g. `F8`, `I8`, `CI4`, `S20`.
#[derive(Clone, Debug, PartialEq)]
pub struct Comp {
    pub name: String,
    pub kind: char, // 'U' unsigned, 'I' signed, 'F' float, 'C' complex (int or float), 'S' string
    pub float: bool,
    pub bytes: usize,
}

/// Parse a CPHD binary format string: `F8`, `X=F8;Y=F8;Z=F8;`, `Gain=F4;Phase=F4;`, `CI4`, `S8`.
pub fn parse_format(f: &str) -> Result<Vec<Comp>> {
    let one = |name: &str, t: &str| -> Result<Comp> {
        let t = t.trim();
        let bad = || gw_abi::err!(INVALID, "CPHD binary format ''{t}'' is not known", t);
        let (kind, float, rest) = if let Some(r) = t.strip_prefix("CI") {
            ('C', false, r)
        } else if let Some(r) = t.strip_prefix("CF") {
            ('C', true, r)
        } else if let Some(r) = t.strip_prefix('U') {
            ('U', false, r)
        } else if let Some(r) = t.strip_prefix('I') {
            ('I', false, r)
        } else if let Some(r) = t.strip_prefix('F') {
            ('F', true, r)
        } else if let Some(r) = t.strip_prefix('S') {
            ('S', false, r)
        } else {
            return Err(bad());
        };
        let bytes: usize = rest.parse().map_err(|_| bad())?;
        let ok = match kind {
            'C' if float => bytes == 8 || bytes == 16,
            'C' => matches!(bytes, 2 | 4 | 8 | 16),
            'F' => bytes == 4 || bytes == 8,
            'U' | 'I' => matches!(bytes, 1 | 2 | 4 | 8),
            _ => (1..=1024).contains(&bytes),
        };
        if !ok {
            return Err(bad());
        }
        Ok(Comp { name: name.to_string(), kind, float, bytes })
    };
    let f = f.trim();
    if f.contains('=') {
        let mut out = Vec::new();
        for part in f.split(';').filter(|p| !p.trim().is_empty()) {
            let (n, t) = part.split_once('=').ok_or_else(|| gw_abi::err!(INVALID, "CPHD binary format ''{f}'' is not known", f))?;
            out.push(one(n.trim(), t)?);
            if out.len() > 64 {
                return Err(Error::limit("CPHD binary format has too many components"));
            }
        }
        if out.is_empty() {
            return Err(Error::invalid("empty CPHD binary format"));
        }
        Ok(out)
    } else {
        Ok(vec![one("", f)?])
    }
}

/// Number of f64 values one component decodes to (complex → 2, string → 0).
fn comp_values(c: &Comp) -> usize {
    match c.kind {
        'C' => 2,
        'S' => 0,
        _ => 1,
    }
}

fn be_uint(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |s, &x| (s << 8) | x as u64)
}
fn be_int(b: &[u8]) -> i64 {
    let n = b.len();
    let u = be_uint(b);
    if n >= 8 {
        u as i64
    } else {
        let sh = 64 - 8 * n as u32;
        ((u << sh) as i64) >> sh
    }
}
fn be_float(b: &[u8]) -> f64 {
    if b.len() == 4 {
        f32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64
    } else {
        f64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]])
    }
}

/// Decode the components at `b` (exactly their total size) into `out` (complex as re, im).
fn decode_comps(comps: &[Comp], b: &[u8], out: &mut Vec<f64>) {
    let mut o = 0;
    for c in comps {
        let s = &b[o..o + c.bytes];
        match c.kind {
            'U' => out.push(be_uint(s) as f64),
            'I' => out.push(be_int(s) as f64),
            'F' => out.push(be_float(s)),
            'C' => {
                let h = c.bytes / 2;
                if c.float {
                    out.push(be_float(&s[..h]));
                    out.push(be_float(&s[h..]));
                } else {
                    out.push(be_int(&s[..h]) as f64);
                    out.push(be_int(&s[h..]) as f64);
                }
            }
            _ => {}
        }
        o += c.bytes;
    }
}

#[derive(Clone, Debug)]
pub struct Channel {
    pub id: String,
    pub nv: u64,
    pub ns: u64,
    pub signal_offset: u64,
    pub pvp_offset: u64,
    pub compressed_size: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct PvpField {
    pub name: String,
    pub offset: u64,
    pub size: u64,
    pub format: String,
    pub comps: Vec<Comp>,
    pub added: bool,
}

#[derive(Clone, Debug)]
pub struct Support {
    pub id: String,
    pub rows: u64,
    pub cols: u64,
    pub bpe: u64,
    pub offset: u64,
    pub format: String,
    pub comps: Vec<Comp>,
    pub kind: String,
    pub grid: [f64; 4], // X0, Y0, XSS, YSS
}

/// Parsed and checked metadata of a CPHD file.
#[derive(Clone, Debug)]
pub struct Meta {
    pub header: Header,
    pub root: Node,
    pub namespace: String,
    pub signal_format: String,
    pub bytes_per_sample: u64,
    pub num_bytes_pvp: u64,
    pub compression: Option<String>,
    pub channels: Vec<Channel>,
    pub pvp: Vec<PvpField>,
    pub support: Vec<Support>,
}

fn num_u64(n: &Node, path: &str) -> Result<u64> {
    let t = n.text_at(path).ok_or_else(|| gw_abi::err!(INVALID, "CPHD XML has no {node}/{path}", path, node = n.name))?;
    t.parse::<u64>().map_err(|_| gw_abi::err!(INVALID, "CPHD XML {node}/{path} is not a whole number ({value})", path, node = n.name, value = crate::bytes::printable(t.as_bytes(), 40)))
}

fn mul(a: u64, b: u64) -> Result<u64> {
    a.checked_mul(b).ok_or_else(|| Error::range("CPHD array size overflows"))
}
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| Error::range("CPHD offset overflows"))
}

/// Parse the header bytes and the XML block, check every block and array against `file_len`.
pub fn parse(head: &[u8], xml_bytes: &[u8], file_len: u64) -> Result<Meta> {
    let header = parse_header(head)?;
    if xml_bytes.len() as u64 != header.xml.1 {
        return Err(gw_abi::err!(INVALID, "CPHD XML block is {size} bytes; the header says {header}", size = xml_bytes.len(), header = header.xml.1));
    }
    for (name, (o, s)) in [("XML", header.xml), ("PVP", header.pvp), ("signal", header.signal)].into_iter().chain(header.support.map(|s| ("support", s))) {
        if add(o, s)? > file_len {
            return Err(gw_abi::err!(RANGE, "CPHD {name} block ({s} bytes at {o}) runs past the end of the file ({file_len} bytes): truncated", name, s, o, file_len));
        }
    }
    let root = xml::parse(xml_bytes)?;
    if root.name != "CPHD" {
        return Err(gw_abi::err!(INVALID, "CPHD XML root is <{root}>, not <CPHD>", root = root.name));
    }
    let namespace = xml::root_namespace(xml_bytes).unwrap_or_default();
    let data = root.child("Data").ok_or_else(|| Error::invalid("CPHD XML has no Data block"))?;
    let signal_format = data.text_at("SignalArrayFormat").unwrap_or("").to_string();
    let bytes_per_sample = match signal_format.as_str() {
        "CI2" => 2,
        "CI4" => 4,
        "CF8" => 8,
        f => return Err(gw_abi::err!(UNSUPPORTED, "CPHD signal array format ''{f}'' is not known (CI2, CI4, CF8)", f)),
    };
    let num_bytes_pvp = num_u64(data, "NumBytesPVP")?;
    if num_bytes_pvp == 0 || num_bytes_pvp % 8 != 0 || num_bytes_pvp > 1 << 16 {
        return Err(gw_abi::err!(INVALID, "CPHD NumBytesPVP {num_bytes_pvp} is not a positive multiple of 8", num_bytes_pvp));
    }
    let compression = data.text_at("SignalCompressionID").filter(|s| !s.is_empty()).map(|s| s.to_string());
    let mut channels = Vec::new();
    for c in data.all("Channel") {
        let ch = Channel {
            id: c.text_at("Identifier").unwrap_or("").to_string(),
            nv: num_u64(c, "NumVectors")?,
            ns: num_u64(c, "NumSamples")?,
            signal_offset: num_u64(c, "SignalArrayByteOffset")?,
            pvp_offset: num_u64(c, "PVPArrayByteOffset")?,
            compressed_size: c.text_at("CompressedSignalSize").and_then(|t| t.parse().ok()),
        };
        let pv = mul(ch.nv, num_bytes_pvp)?;
        if add(ch.pvp_offset, pv)? > header.pvp.1 {
            return Err(gw_abi::err!(RANGE, "CPHD channel {channel} PVP array runs past the PVP block", channel = ch.id));
        }
        let sig = match (&compression, ch.compressed_size) {
            (Some(_), Some(s)) => s,
            _ => mul(mul(ch.nv, ch.ns)?, bytes_per_sample)?,
        };
        if add(ch.signal_offset, sig)? > header.signal.1 {
            return Err(gw_abi::err!(RANGE, "CPHD channel {channel} signal array ({nv} × {ns} {signal_format}) runs past the signal block", signal_format, channel = ch.id, nv = ch.nv, ns = ch.ns));
        }
        channels.push(ch);
        if channels.len() > 4096 {
            return Err(Error::limit("CPHD has too many channels"));
        }
    }
    if channels.is_empty() {
        return Err(Error::invalid("CPHD Data block lists no channel"));
    }
    let mut pvp = Vec::new();
    if let Some(p) = root.child("PVP") {
        // CPHD 1.1 groups the antenna PVPs (TxAntenna/TxACX…, RcvAntenna/RcvACX…): their members are fields.
        let fields: Vec<&Node> = p.children.iter().flat_map(|f| if f.child("Offset").is_none() && !f.children.is_empty() { f.children.iter().collect::<Vec<_>>() } else { vec![f] }).collect();
        for f in fields {
            let added = f.name == "AddedPVP";
            let name = if added { f.text_at("Name").unwrap_or("Added").to_string() } else { f.name.clone() };
            let offset = num_u64(f, "Offset")?;
            let size = num_u64(f, "Size")?;
            let format = f.text_at("Format").unwrap_or("").to_string();
            let comps = parse_format(&format)?;
            let bytes: usize = comps.iter().map(|c| c.bytes).sum();
            if add(offset, size)?.saturating_mul(8) > num_bytes_pvp || bytes as u64 > size * 8 {
                return Err(gw_abi::err!(RANGE, "CPHD PVP {name} ({size} words at word {offset}, format {format}) does not fit NumBytesPVP {num_bytes_pvp}", name, size, offset, format, num_bytes_pvp));
            }
            pvp.push(PvpField { name, offset, size, format, comps, added });
        }
    }
    let mut support = Vec::new();
    for s in data.all("SupportArray") {
        let id = s.text_at("Identifier").unwrap_or("").to_string();
        let (rows, cols, bpe, offset) = (num_u64(s, "NumRows")?, num_u64(s, "NumCols")?, num_u64(s, "BytesPerElement")?, num_u64(s, "ArrayByteOffset")?);
        let (blk_o, blk_s) = header.support.ok_or_else(|| Error::invalid("CPHD lists support arrays but the header has no support block"))?;
        let _ = blk_o;
        if add(offset, mul(mul(rows, cols)?, bpe)?)? > blk_s {
            return Err(gw_abi::err!(RANGE, "CPHD support array {id} runs past the support block", id));
        }
        // Its element format, grid and kind are under /SupportArray/<kind>[Identifier = id].
        let desc = root.child("SupportArray").and_then(|sa| sa.children.iter().find(|k| k.text_at("Identifier") == Some(id.as_str())));
        let format = desc.and_then(|d| d.text_at("ElementFormat")).unwrap_or("").to_string();
        let comps = if format.is_empty() { Vec::new() } else { parse_format(&format)? };
        if !comps.is_empty() && comps.iter().map(|c| c.bytes as u64).sum::<u64>() != bpe {
            return Err(gw_abi::err!(INVALID, "CPHD support array {id}: ElementFormat {format} is not {bpe} bytes", id, format, bpe));
        }
        let g = |k: &str| desc.and_then(|d| d.num(k)).unwrap_or(f64::NAN);
        support.push(Support { id, rows, cols, bpe, offset, format, comps, kind: desc.map(|d| d.name.clone()).unwrap_or_default(), grid: [g("X0"), g("Y0"), g("XSS"), g("YSS")] });
    }
    Ok(Meta { header, root, namespace, signal_format, bytes_per_sample, num_bytes_pvp, compression, channels, pvp, support })
}

fn v3(n: Option<&Node>) -> Option<[f64; 3]> {
    let n = n?;
    Some([n.num("X")?, n.num("Y")?, n.num("Z")?])
}

fn kv_opt_num(j: &mut Json, k: &str, v: Option<f64>) {
    match v {
        Some(x) => j.kv_num(k, x),
        None => j.key(k).null(),
    };
}
fn kv_v3(j: &mut Json, k: &str, v: Option<[f64; 3]>) {
    match v {
        Some(a) => {
            j.key(k).arr();
            for x in a {
                j.num(x);
            }
            j.end_arr();
        }
        None => {
            j.key(k).null();
        }
    }
}

/// The summary and layout JSON for the app (absolute byte offsets), with the XML tree.
pub fn to_json(m: &Meta) -> String {
    let r = &m.root;
    let h = &m.header;
    let mut j = Json::new();
    j.obj();
    j.kv_str("version", &h.version).kv_str("namespace", &m.namespace);
    j.key("header").obj();
    for (k, v) in &h.kvs {
        j.kv_str(k, v);
    }
    j.end_obj();
    j.kv_num("headerLen", h.len as f64);
    for (k, (o, s)) in [("xml", h.xml), ("pvp", h.pvp), ("signal", h.signal)] {
        j.key(k).arr().num(o as f64).num(s as f64).end_arr();
    }
    match h.support {
        Some((o, s)) => {
            j.key("support").arr().num(o as f64).num(s as f64).end_arr();
        }
        None => {
            j.key("support").null();
        }
    }
    j.kv_str("signalFormat", &m.signal_format).kv_num("bytesPerSample", m.bytes_per_sample as f64).kv_num("numBytesPVP", m.num_bytes_pvp as f64);
    match &m.compression {
        Some(c) => j.kv_str("compression", c),
        None => j.key("compression").null(),
    };
    let t = |p: &str| r.text_at(p).unwrap_or("");
    j.kv_str("classification", t("CollectionID/Classification")).kv_str("releaseInfo", t("CollectionID/ReleaseInfo"));
    j.kv_str("collector", t("CollectionID/CollectorName")).kv_str("coreName", t("CollectionID/CoreName")).kv_str("collectType", t("CollectionID/CollectType")).kv_str("modeType", t("CollectionID/RadarMode/ModeType"));
    j.kv_str("domain", t("Global/DomainType")).kv_str("collectStart", t("Global/Timeline/CollectionStart"));
    kv_opt_num(&mut j, "sgn", r.num("Global/SGN"));
    kv_opt_num(&mut j, "txTime1", r.num("Global/Timeline/TxTime1"));
    kv_opt_num(&mut j, "txTime2", r.num("Global/Timeline/TxTime2"));
    kv_opt_num(&mut j, "fxMin", r.num("Global/FxBand/FxMin"));
    kv_opt_num(&mut j, "fxMax", r.num("Global/FxBand/FxMax"));
    kv_opt_num(&mut j, "toaMin", r.num("Global/TOASwath/TOAMin"));
    kv_opt_num(&mut j, "toaMax", r.num("Global/TOASwath/TOAMax"));
    kv_v3(&mut j, "iarpEcf", v3(r.find("SceneCoordinates/IARP/ECF")));
    let llh = r.find("SceneCoordinates/IARP/LLH");
    match llh.and_then(|n| Some([n.num("Lat")?, n.num("Lon")?, n.num("HAE")?])) {
        Some(a) => {
            j.key("iarpLlh").arr().num(a[0]).num(a[1]).num(a[2]).end_arr();
        }
        None => {
            j.key("iarpLlh").null();
        }
    }
    j.key("iacp").arr();
    if let Some(c) = r.find("SceneCoordinates/ImageAreaCornerPoints") {
        let mut pts: Vec<(usize, f64, f64)> = c.all("IACP").filter_map(|p| Some((p.attr("index").and_then(|s| s.parse().ok()).unwrap_or(0), p.num("Lat")?, p.num("Lon")?))).collect();
        pts.sort_by_key(|p| p.0);
        for (_, la, lo) in pts.into_iter().take(16) {
            j.arr().num(la).num(lo).end_arr();
        }
    }
    j.end_arr();
    kv_v3(&mut j, "srpEcf", v3(r.find("ReferenceGeometry/SRP/ECF")));
    let mono = r.find("ReferenceGeometry/Monostatic");
    kv_v3(&mut j, "arpPos", v3(mono.and_then(|m| m.child("ARPPos"))));
    kv_v3(&mut j, "arpVel", v3(mono.and_then(|m| m.child("ARPVel"))));
    j.key("geometry").obj();
    if let Some(m) = mono {
        for k in ["SideOfTrack"] {
            j.kv_str(k, m.text_at(k).unwrap_or(""));
        }
        for k in ["SlantRange", "GroundRange", "DopplerConeAngle", "GrazeAngle", "IncidenceAngle", "AzimuthAngle", "TwistAngle", "SlopeAngle", "LayoverAngle"] {
            kv_opt_num(&mut j, k, m.num(k));
        }
    }
    j.end_obj();
    j.key("channels").arr();
    for c in &m.channels {
        j.obj().kv_str("id", &c.id).kv_num("nv", c.nv as f64).kv_num("ns", c.ns as f64);
        j.kv_num("signalOffset", (h.signal.0 + c.signal_offset) as f64).kv_num("pvpOffset", (h.pvp.0 + c.pvp_offset) as f64);
        if let Some(s) = c.compressed_size {
            j.kv_num("compressedSize", s as f64);
        }
        let p = r.child("Channel").and_then(|ch| ch.all("Parameters").find(|p| p.text_at("Identifier") == Some(c.id.as_str())));
        if let Some(p) = p {
            j.kv_str("txPol", p.text_at("Polarization/TxPol").unwrap_or("")).kv_str("rcvPol", p.text_at("Polarization/RcvPol").unwrap_or(""));
            kv_opt_num(&mut j, "fxC", p.num("FxC"));
            kv_opt_num(&mut j, "fxBW", p.num("FxBW"));
            kv_opt_num(&mut j, "refVector", p.num("RefVectorIndex"));
        }
        j.end_obj();
    }
    j.end_arr();
    j.key("pvp").arr();
    for f in &m.pvp {
        j.obj().kv_str("name", &f.name).kv_num("offset", f.offset as f64).kv_num("size", f.size as f64).kv_str("format", &f.format).kv_bool("added", f.added);
        j.key("comps").arr();
        for c in &f.comps {
            for k in 0..comp_values(c) {
                let n = if c.kind == 'C' { format!("{}{}", c.name, if k == 0 { "re" } else { "im" }) } else { c.name.clone() };
                j.str(&n);
            }
        }
        j.end_arr().end_obj();
    }
    j.end_arr();
    j.key("supportArrays").arr();
    for s in &m.support {
        j.obj().kv_str("id", &s.id).kv_str("kind", &s.kind).kv_num("rows", s.rows as f64).kv_num("cols", s.cols as f64).kv_num("bpe", s.bpe as f64);
        j.kv_num("offset", (h.support.map(|x| x.0).unwrap_or(0) + s.offset) as f64).kv_str("format", &s.format);
        j.key("comps").arr();
        for c in &s.comps {
            for _ in 0..comp_values(c) {
                j.str(&c.name);
            }
        }
        j.end_arr();
        j.key("grid").arr();
        for g in s.grid {
            j.num(g);
        }
        j.end_arr().end_obj();
    }
    j.end_arr();
    j.key("tree");
    r.to_json(&mut j);
    j.end_obj();
    j.finish()
}

/// PVP columns of `nv` records (`bytes` = nv × NumBytesPVP): for each field in XML order, for each
/// numeric component, nv f64 values (column-major), NaN for strings.
pub fn pvp_columns(m: &Meta, bytes: &[u8]) -> Result<Vec<f64>> {
    let rec = m.num_bytes_pvp as usize;
    if bytes.len() % rec != 0 {
        return Err(Error::invalid("CPHD PVP bytes are not whole records"));
    }
    let nv = bytes.len() / rec;
    let ncol: usize = m.pvp.iter().map(|f| f.comps.iter().map(comp_values).sum::<usize>()).sum();
    if nv.saturating_mul(ncol) > 64 << 20 {
        return Err(Error::limit("CPHD PVP request is too large"));
    }
    let mut out = vec![0.0f64; nv * ncol];
    let mut row = Vec::with_capacity(8);
    let mut col = 0;
    for f in &m.pvp {
        let o = f.offset as usize * 8;
        let nb: usize = f.comps.iter().map(|c| c.bytes).sum();
        let nvals: usize = f.comps.iter().map(comp_values).sum();
        for v in 0..nv {
            row.clear();
            decode_comps(&f.comps, &bytes[v * rec + o..v * rec + o + nb], &mut row);
            for (k, x) in row.iter().enumerate().take(nvals) {
                out[(col + k) * nv + v] = *x;
            }
        }
        col += nvals;
    }
    Ok(out)
}

/// A support array's bytes (rows × cols × bpe) → f32 values, components interleaved.
pub fn support_values(s: &Support, bytes: &[u8]) -> Result<Vec<f32>> {
    let n = (s.rows as usize).checked_mul(s.cols as usize).ok_or_else(|| Error::range("support array size overflows"))?;
    if bytes.len() != n.saturating_mul(s.bpe as usize) {
        return Err(gw_abi::err!(INVALID, "CPHD support array {id} needs {bytes} bytes", id = s.id, bytes = n * s.bpe as usize));
    }
    if s.comps.is_empty() {
        return Err(gw_abi::err!(UNSUPPORTED, "CPHD support array {id} has no ElementFormat", id = s.id));
    }
    let mut out = Vec::with_capacity(n * s.comps.len());
    let mut row = Vec::new();
    for e in 0..n {
        row.clear();
        decode_comps(&s.comps, &bytes[e * s.bpe as usize..(e + 1) * s.bpe as usize], &mut row);
        out.extend(row.iter().map(|&x| x as f32));
    }
    Ok(out)
}

// ---------------------------------------------------------------- subset writer (REQ-FMT-51)

fn esc(s: &str, attr: bool) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' if attr => o.push_str("&quot;"),
            c => o.push(c),
        }
    }
    o
}

/// Serialise an element tree (local names; the root gets `ns` as its default namespace).
pub fn write_xml(n: &Node, ns: Option<&str>, out: &mut String) {
    out.push('<');
    out.push_str(&n.name);
    if let Some(ns) = ns {
        out.push_str(&format!(" xmlns=\"{}\"", esc(ns, true)));
    }
    for (k, v) in &n.attrs {
        out.push_str(&format!(" {k}=\"{}\"", esc(v, true)));
    }
    if n.children.is_empty() && n.text.trim().is_empty() {
        out.push_str("/>");
        return;
    }
    out.push('>');
    if n.children.is_empty() {
        out.push_str(&esc(n.text.trim(), false));
    } else {
        for c in &n.children {
            write_xml(c, None, out);
        }
    }
    out.push_str("</");
    out.push_str(&n.name);
    out.push('>');
}

fn set_text(n: &mut Node, path: &str, v: String) {
    let mut cur = n;
    for p in path.split('/') {
        match cur.children.iter().position(|c| c.name == p) {
            Some(i) => cur = &mut cur.children[i],
            None => return,
        }
    }
    cur.text = v;
}

fn fmt_f(v: f64) -> String {
    format!("{v}")
}

/// One channel's subset: index into `Meta::channels`, vectors [v0, v1), samples [s0, s1).
#[derive(Clone, Copy, Debug)]
pub struct Sub {
    pub ch: usize,
    pub v0: u64,
    pub v1: u64,
    pub s0: u64,
    pub s1: u64,
}

/// The subset file's leading bytes (header, XML, padding up to the support block) and its PVP block.
/// The caller appends the support block as it is, the PVP block, then each channel's signal rows
/// (vectors v0..v1, samples s0..s1, in `subs` order). `pvp` holds the source PVP records of the subset
/// vectors, channel after channel.
pub fn subset(m: &Meta, subs: &[Sub], pvp: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
    if subs.is_empty() {
        return Err(Error::invalid("a CPHD subset needs at least one channel"));
    }
    if m.compression.is_some() {
        return Err(Error::unsupported("a compressed CPHD signal cannot be subset"));
    }
    let rec = m.num_bytes_pvp as usize;
    let mut want = 0usize;
    for s in subs {
        let c = m.channels.get(s.ch).ok_or_else(|| Error::range("CPHD subset names no such channel"))?;
        if !(s.v0 < s.v1 && s.v1 <= c.nv && s.s0 < s.s1 && s.s1 <= c.ns) {
            return Err(gw_abi::err!(RANGE, "CPHD subset of channel {channel} is outside its {nv} × {ns} signal array", channel = c.id, nv = c.nv, ns = c.ns));
        }
        want += (s.v1 - s.v0) as usize * rec;
    }
    if pvp.len() != want {
        return Err(gw_abi::err!(INVALID, "CPHD subset needs {want} PVP bytes, got {got}", want, got = pvp.len()));
    }
    let field = |n: &str| m.pvp.iter().find(|f| f.name == n && !f.added && f.comps.len() == 1 && f.comps[0].kind == 'F' && f.comps[0].bytes == 8);
    let fx = m.root.text_at("Global/DomainType") == Some("FX");
    let (sc0, scss) = (field("SC0"), field("SCSS"));
    let (fx1, fx2, toa1, toa2, toae1, toae2, tx) = (field("FX1"), field("FX2"), field("TOA1"), field("TOA2"), field("TOAE1"), field("TOAE2"), field("TxTime"));
    let signal = m.pvp.iter().find(|f| f.name == "SIGNAL" && !f.added && f.comps.len() == 1 && f.comps[0].kind == 'I');
    // The sample axis is frequency (FX domain) or time of arrival (TOA domain): its band is clipped.
    let (b1, b2) = if fx { (fx1, fx2) } else { (toa1, toa2) };
    let mut out_pvp = pvp.to_vec();
    let get = |b: &[u8], f: &PvpField| f64::from_be_bytes(b[f.offset as usize * 8..f.offset as usize * 8 + 8].try_into().unwrap_or([0; 8]));
    let put = |b: &mut [u8], f: &PvpField, v: f64| b[f.offset as usize * 8..f.offset as usize * 8 + 8].copy_from_slice(&v.to_be_bytes());
    // Per channel: [min FX1, max FX2, min TOA1, max TOA2, min TOAE1, max TOAE2], SIGNAL all 1.
    let mut stats: Vec<([f64; 6], bool)> = Vec::new();
    let (mut t1, mut t2) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut o = 0usize;
    for s in subs {
        let mut st = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
        let mut normal = true;
        for _ in s.v0..s.v1 {
            let r = &mut out_pvp[o..o + rec];
            if let (Some(a), Some(d)) = (sc0, scss) {
                // The first kept sample's coordinate; the valid band is clipped to the kept samples.
                let (c0, ss) = (get(r, a) + s.s0 as f64 * get(r, d), get(r, d));
                put(r, a, c0);
                let c1 = c0 + (s.s1 - s.s0 - 1) as f64 * ss;
                let (e0, e1) = (c0.min(c1), c0.max(c1));
                if let (Some(f1), Some(f2)) = (b1, b2) {
                    let (v1, v2) = (get(r, f1).max(e0), get(r, f2).min(e1));
                    put(r, f1, v1);
                    put(r, f2, v2.max(v1));
                }
            }
            for (k, f) in [fx1, fx2, toa1, toa2, toae1, toae2].into_iter().enumerate() {
                if let Some(f) = f {
                    let v = get(r, f);
                    st[k] = if k % 2 == 0 { st[k].min(v) } else { st[k].max(v) };
                }
            }
            if let Some(sg) = signal {
                let b = &r[sg.offset as usize * 8..sg.offset as usize * 8 + 8];
                normal &= be_int(b) == 1;
            }
            if let Some(t) = tx {
                t1 = t1.min(get(r, t));
                t2 = t2.max(get(r, t));
            }
            o += rec;
        }
        stats.push((st, normal));
    }
    let fin = |v: f64| v.is_finite();
    let mut glob = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
    for (st, _) in &stats {
        glob[0] = glob[0].min(st[0]);
        glob[1] = glob[1].max(st[1]);
        glob[2] = glob[2].min(st[2]);
        glob[3] = glob[3].max(st[3]);
    }
    // The new XML: the kept channels, their layout and parameters, the timeline and the band.
    let mut root = m.root.clone();
    let keep: Vec<&str> = subs.iter().map(|s| m.channels[s.ch].id.as_str()).collect();
    let bps = m.bytes_per_sample;
    let mut sig_off = 0u64;
    let mut pvp_off = 0u64;
    let mut sig_total = 0u64;
    if let Some(data) = root.children.iter_mut().find(|c| c.name == "Data") {
        let mut chans = Vec::new();
        for s in subs {
            let src = data.all("Channel").find(|c| c.text_at("Identifier") == Some(m.channels[s.ch].id.as_str())).cloned().unwrap_or_default();
            let mut c = src;
            let (nv, ns) = (s.v1 - s.v0, s.s1 - s.s0);
            set_text(&mut c, "NumVectors", nv.to_string());
            set_text(&mut c, "NumSamples", ns.to_string());
            set_text(&mut c, "SignalArrayByteOffset", sig_off.to_string());
            set_text(&mut c, "PVPArrayByteOffset", pvp_off.to_string());
            c.children.retain(|k| k.name != "CompressedSignalSize");
            sig_off += nv * ns * bps;
            pvp_off += nv * m.num_bytes_pvp;
            chans.push(c);
        }
        sig_total = sig_off;
        let first = data.children.iter().position(|c| c.name == "Channel").unwrap_or(data.children.len());
        data.children.retain(|c| c.name != "Channel");
        for (k, c) in chans.into_iter().enumerate() {
            data.children.insert(first + k, c);
        }
        set_text(data, "NumCPHDChannels", subs.len().to_string());
    }
    let mut refgeom_from: Option<(usize, u64)> = None; // (subset index, vector index in the subset)
    if let Some(ch) = root.children.iter_mut().find(|c| c.name == "Channel") {
        ch.children.retain(|p| p.name != "Parameters" || p.text_at("Identifier").map(|i| keep.contains(&i)).unwrap_or(false));
        let src_ref = ch.text_at("RefChId").map(|s| s.to_string());
        if !src_ref.as_deref().map(|r| keep.contains(&r)).unwrap_or(false) {
            set_text(ch, "RefChId", keep[0].to_string());
        }
        let ref_id = ch.text_at("RefChId").unwrap_or("").to_string();
        for (k, s) in subs.iter().enumerate() {
            let id = keep[k];
            let (st, normal) = stats[k];
            if let Some(p) = ch.children.iter_mut().find(|p| p.name == "Parameters" && p.text_at("Identifier") == Some(id)) {
                let rv = p.num("RefVectorIndex").unwrap_or(0.0) as i64;
                let n = (s.v1 - s.v0) as i64;
                // The reference vector stays when the subset keeps it; otherwise the middle vector is the
                // reference and the ReferenceGeometry is computed again from it (section 6.5).
                let inside = rv >= s.v0 as i64 && rv < s.v1 as i64;
                let new_rv = if inside { rv - s.v0 as i64 } else { n / 2 };
                set_text(p, "RefVectorIndex", new_rv.to_string());
                if id == ref_id && (!inside || src_ref.as_deref() != Some(id)) {
                    refgeom_from = Some((k, new_rv as u64));
                }
                if fin(st[0]) && fin(st[1]) {
                    set_text(p, "FxC", fmt_f((st[0] + st[1]) / 2.0));
                    set_text(p, "FxBW", fmt_f(st[1] - st[0]));
                }
                if fin(st[2]) && fin(st[3]) {
                    set_text(p, "TOASaved", fmt_f(st[3] - st[2]));
                }
                if fin(st[4]) && fin(st[5]) {
                    set_text(p, "TOAExtended/TOAExtSaved", fmt_f(st[5] - st[4]));
                }
                if signal.is_some() {
                    set_text(p, "SignalNormal", normal.to_string());
                }
            }
        }
    }
    if t1.is_finite() {
        set_text(&mut root, "Global/Timeline/TxTime1", fmt_f(t1));
        set_text(&mut root, "Global/Timeline/TxTime2", fmt_f(t2));
    }
    if fin(glob[0]) && fin(glob[1]) {
        set_text(&mut root, "Global/FxBand/FxMin", fmt_f(glob[0]));
        set_text(&mut root, "Global/FxBand/FxMax", fmt_f(glob[1]));
    }
    if fin(glob[2]) && fin(glob[3]) {
        set_text(&mut root, "Global/TOASwath/TOAMin", fmt_f(glob[2]));
        set_text(&mut root, "Global/TOASwath/TOAMax", fmt_f(glob[3]));
    }
    if let Some((k, v)) = refgeom_from {
        let off: usize = subs[..k].iter().map(|s| (s.v1 - s.v0) as usize * rec).sum::<usize>() + v as usize * rec;
        reference_geometry(m, &mut root, &out_pvp[off..off + rec])?;
    }
    // A vector subset shortens the dwell: the COD and dwell polynomials of the kept channels become the
    // constants the kept vectors support (their first and last reference times about the SRP, §6.5.1),
    // so every image point's dwell lies inside the subset.
    let cut = subs.iter().any(|s| s.v0 > 0 || s.v1 < m.channels[s.ch].nv);
    if cut {
        let tref = |r: &[u8]| -> Option<f64> {
            let pv = |n: &str| -> Option<Vec<f64>> {
                let f = m.pvp.iter().find(|f| f.name == n && !f.added)?;
                let mut out = Vec::new();
                let nb: usize = f.comps.iter().map(|c| c.bytes).sum();
                decode_comps(&f.comps, &r[f.offset as usize * 8..f.offset as usize * 8 + nb], &mut out);
                Some(out)
            };
            let (tx, trc) = (*pv("TxTime")?.first()?, *pv("RcvTime")?.first()?);
            let (xp, rp, sp) = (pv("TxPos")?, pv("RcvPos")?, pv("SRPPos")?);
            // A file may declare a position with fewer than three components (found by fuzzing).
            if xp.len() < 3 || rp.len() < 3 || sp.len() < 3 {
                return None;
            }
            let a = |v: &[f64]| [v[0], v[1], v[2]];
            let (rx, rr) = (norm(sub3(a(&xp), a(&sp))), norm(sub3(a(&rp), a(&sp))));
            Some(tx + rx / (rx + rr) * (trc - tx))
        };
        let mut ids: Vec<(String, String, f64, f64)> = Vec::new();
        let params: Vec<Node> = root.child("Channel").map(|c| c.all("Parameters").cloned().collect()).unwrap_or_default();
        let mut off = 0usize;
        for (k, s) in subs.iter().enumerate() {
            let n = (s.v1 - s.v0) as usize;
            let (a, b) = (tref(&out_pvp[off..off + rec]), tref(&out_pvp[off + (n - 1) * rec..off + n * rec]));
            off += n * rec;
            let (Some(a), Some(b)) = (a, b) else { continue };
            let Some(p) = params.iter().find(|p| p.text_at("Identifier") == Some(keep[k])) else { continue };
            let (c, d) = (p.text_at("DwellTimes/CODId").unwrap_or("").to_string(), p.text_at("DwellTimes/DwellId").unwrap_or("").to_string());
            match ids.iter_mut().find(|x| x.0 == c && x.1 == d) {
                Some(x) => {
                    x.2 = x.2.min(a.min(b));
                    x.3 = x.3.max(a.max(b));
                }
                None => ids.push((c, d, a.min(b), a.max(b))),
            }
        }
        let constant = |name: &str, v: f64| Node { name: name.to_string(), attrs: vec![("order1".into(), "0".into()), ("order2".into(), "0".into())], children: vec![Node { name: "Coef".into(), attrs: vec![("exponent1".into(), "0".into()), ("exponent2".into(), "0".into())], children: vec![], text: fmt_f(v) }], text: String::new() };
        if let Some(dw) = root.children.iter_mut().find(|c| c.name == "Dwell") {
            for (c, d, a, b) in &ids {
                let (cod, dwell) = ((a + b) / 2.0, (b - a) * 0.999);
                for (kind, id, poly, v) in [("CODTime", c, "CODTimePoly", cod), ("DwellTime", d, "DwellTimePoly", dwell)] {
                    if let Some(n) = dw.children.iter_mut().find(|n| n.name == kind && n.text_at("Identifier") == Some(id.as_str())) {
                        if let Some(pi) = n.children.iter().position(|x| x.name == poly) {
                            n.children[pi] = constant(poly, v);
                        }
                    }
                }
            }
        }
        // The SRP's centre of dwell and dwell time follow the new polynomials.
        let ref_id = root.text_at("Channel/RefChId").unwrap_or("").to_string();
        let rp = params.iter().find(|p| p.text_at("Identifier") == Some(ref_id.as_str()));
        if let Some(x) = rp.and_then(|p| ids.iter().find(|x| Some(x.0.as_str()) == p.text_at("DwellTimes/CODId") && Some(x.1.as_str()) == p.text_at("DwellTimes/DwellId"))) {
            if let Some(rg) = root.children.iter_mut().find(|c| c.name == "ReferenceGeometry") {
                set_text(rg, "SRPCODTime", fmt_f((x.2 + x.3) / 2.0));
                set_text(rg, "SRPDwellTime", fmt_f((x.3 - x.2) * 0.999));
            }
        }
    }
    let mut x = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
    write_xml(&root, Some(&m.namespace).filter(|s| !s.is_empty()).map(|s| s.as_str()), &mut x);
    let xml = x.into_bytes();
    // Layout: header, XML (after the header's form feed), "\f\n", then the 8-byte-aligned blocks.
    let support_size = m.header.support.map(|s| s.1);
    let pvp_size = out_pvp.len() as u64;
    let al = |v: u64| v.div_ceil(8) * 8;
    let mut head = String::new();
    let mut xml_off = 0u64;
    for _ in 0..8 {
        let mut h = format!("CPHD/{}\n", m.header.version);
        let mut sup_off = 0u64;
        let xml_end = xml_off + xml.len() as u64 + 2;
        let mut next = al(xml_end);
        h.push_str(&format!("XML_BLOCK_SIZE := {}\nXML_BLOCK_BYTE_OFFSET := {xml_off}\n", xml.len()));
        if let Some(s) = support_size {
            sup_off = next;
            next = al(sup_off + s);
            h.push_str(&format!("SUPPORT_BLOCK_SIZE := {s}\nSUPPORT_BLOCK_BYTE_OFFSET := {sup_off}\n"));
        }
        let pvp_off = next;
        let sig_off = al(pvp_off + pvp_size);
        h.push_str(&format!("PVP_BLOCK_SIZE := {pvp_size}\nPVP_BLOCK_BYTE_OFFSET := {pvp_off}\nSIGNAL_BLOCK_SIZE := {sig_total}\nSIGNAL_BLOCK_BYTE_OFFSET := {sig_off}\n"));
        h.push_str(&format!("CLASSIFICATION := {}\nRELEASE_INFO := {}\n", m.header.get("CLASSIFICATION").unwrap_or("UNCLASSIFIED"), m.header.get("RELEASE_INFO").unwrap_or("")));
        for (k, v) in &m.header.kvs {
            if !k.ends_with("_BLOCK_SIZE") && !k.ends_with("_BLOCK_BYTE_OFFSET") && k != "CLASSIFICATION" && k != "RELEASE_INFO" {
                h.push_str(&format!("{k} := {v}\n"));
            }
        }
        h.push_str("\x0c\n");
        let _ = sup_off;
        let need = al(h.len() as u64);
        head = h;
        if need <= xml_off {
            break;
        }
        xml_off = need;
    }
    if (head.len() as u64) > xml_off {
        return Err(Error::new(gw_abi::INTERNAL, "CPHD subset header layout did not settle"));
    }
    let mut prefix = head.into_bytes();
    prefix.resize(xml_off as usize, 0);
    prefix.extend_from_slice(&xml);
    prefix.extend_from_slice(b"\x0c\n");
    let first_block = al(prefix.len() as u64) as usize;
    prefix.resize(first_block, 0);
    Ok((prefix, out_pvp))
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}
fn unit(a: [f64; 3]) -> [f64; 3] {
    let n = norm(a);
    [a[0] / n, a[1] / n, a[2] / n]
}

/// WGS 84 ECEF → (lat, lon) radians (Bowring iterations: well below a micro-radian).
fn ecef_latlon(p: [f64; 3]) -> (f64, f64) {
    let (a, f) = (6378137.0f64, 1.0 / 298.257223563);
    let e2 = f * (2.0 - f);
    let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
    let mut lat = p[2].atan2(r * (1.0 - e2));
    for _ in 0..5 {
        let s = lat.sin();
        let n = a / (1.0 - e2 * s * s).sqrt();
        lat = (p[2] + e2 * n * s).atan2(r);
    }
    (lat, p[1].atan2(p[0]))
}

fn poly2_eval(n: Option<&Node>, x: f64, y: f64) -> Option<f64> {
    let n = n?;
    let mut s = 0.0;
    let mut any = false;
    for c in n.all("Coef") {
        let (Some(i), Some(j), Some(v)) = (c.attr("exponent1").and_then(|t| t.trim().parse::<i32>().ok()), c.attr("exponent2").and_then(|t| t.trim().parse::<i32>().ok()), c.value()) else { continue };
        if !(0..32).contains(&i) || !(0..32).contains(&j) {
            continue;
        }
        s += v * x.powi(i) * y.powi(j);
        any = true;
    }
    any.then_some(s)
}

fn set_v3(n: &mut Node, path: &str, v: [f64; 3]) {
    for (k, c) in ["X", "Y", "Z"].iter().enumerate() {
        set_text(n, &format!("{path}/{c}"), fmt_f(v[k]));
    }
}

fn v3_of(n: Option<&Node>) -> Option<[f64; 3]> {
    let n = n?;
    Some([n.num("X")?, n.num("Y")?, n.num("Z")?])
}

/// CPHD section 6.5 (monostatic): ReferenceGeometry from the reference vector's PVP record. A planar
/// reference surface is needed for the SRP's image area coordinates; other collects keep theirs.
fn reference_geometry(m: &Meta, root: &mut Node, r: &[u8]) -> Result<()> {
    if root.text_at("CollectionID/CollectType") != Some("MONOSTATIC") || root.find("SceneCoordinates/ReferenceSurface/Planar").is_none() {
        return Ok(());
    }
    let pv = |n: &str| -> Option<Vec<f64>> {
        let f = m.pvp.iter().find(|f| f.name == n && !f.added)?;
        let mut out = Vec::new();
        let nb: usize = f.comps.iter().map(|c| c.bytes).sum();
        decode_comps(&f.comps, &r[f.offset as usize * 8..f.offset as usize * 8 + nb], &mut out);
        Some(out)
    };
    let v3 = |n: &str| pv(n).filter(|v| v.len() == 3).map(|v| [v[0], v[1], v[2]]);
    let (Some(txc), Some(xmt), Some(vxmt), Some(trc), Some(rcv), Some(vrcv), Some(srp)) = (pv("TxTime").map(|v| v[0]), v3("TxPos"), v3("TxVel"), pv("RcvTime").map(|v| v[0]), v3("RcvPos"), v3("RcvVel"), v3("SRPPos")) else {
        return Ok(());
    };
    let sc = root.find("SceneCoordinates").cloned().unwrap_or_default();
    let (Some(iarp), Some(uiax), Some(uiay)) = (v3_of(sc.find("IARP/ECF")), v3_of(sc.find("ReferenceSurface/Planar/uIAX")), v3_of(sc.find("ReferenceSurface/Planar/uIAY"))) else { return Ok(()) };
    let uiaz = cross(uiax, uiay);
    let d = sub3(srp, iarp);
    let iac = [dot(d, uiax), dot(d, uiay), dot(d, uiaz)];
    let (lat, lon) = ecef_latlon(srp);
    let srp_dec = norm(srp);
    let uec_srp = unit(srp);
    let ueast = [-lon.sin(), lon.cos(), 0.0];
    let unor = [-lat.sin() * lon.cos(), -lat.sin() * lon.sin(), lat.cos()];
    let uup = [lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin()];
    let (rx, rr) = (norm(sub3(xmt, srp)), norm(sub3(rcv, srp)));
    let t_ref = txc + rx / (rx + rr) * (trc - txc);
    // The dwell polynomials of the reference channel at the SRP's image area coordinates.
    let ref_id = root.text_at("Channel/RefChId").unwrap_or("").to_string();
    let params = root.child("Channel").and_then(|c| c.all("Parameters").find(|p| p.text_at("Identifier") == Some(ref_id.as_str()))).cloned();
    let cod_id = params.as_ref().and_then(|p| p.text_at("DwellTimes/CODId")).unwrap_or("").to_string();
    let dwell_id = params.as_ref().and_then(|p| p.text_at("DwellTimes/DwellId")).unwrap_or("").to_string();
    let dw = root.child("Dwell").cloned().unwrap_or_default();
    let cod = poly2_eval(dw.all("CODTime").find(|c| c.text_at("Identifier") == Some(cod_id.as_str())).and_then(|c| c.child("CODTimePoly")), iac[0], iac[1]);
    let dwell = poly2_eval(dw.all("DwellTime").find(|c| c.text_at("Identifier") == Some(dwell_id.as_str())).and_then(|c| c.child("DwellTimePoly")), iac[0], iac[1]);
    let arp = [(xmt[0] + rcv[0]) / 2.0, (xmt[1] + rcv[1]) / 2.0, (xmt[2] + rcv[2]) / 2.0];
    let varp = [(vxmt[0] + vrcv[0]) / 2.0, (vxmt[1] + vrcv[1]) / 2.0, (vxmt[2] + vrcv[2]) / 2.0];
    let r_arp_srp = norm(sub3(arp, srp));
    let uarp = unit(sub3(arp, srp));
    let rdot = dot(uarp, varp);
    let uec_arp = unit(arp);
    let ea = dot(uec_arp, uec_srp).clamp(-1.0, 1.0).acos();
    let vm = norm(varp);
    let uvarp = unit(varp);
    let left = cross(uec_arp, uvarp);
    let look = if dot(left, uarp) < 0.0 { 1.0 } else { -1.0 };
    let dca = (-rdot / vm).clamp(-1.0, 1.0).acos();
    let ugpy = unit(cross(uup, uarp));
    let ugpx = cross(ugpy, uup);
    let graz = dot(uarp, ugpx).clamp(-1.0, 1.0).acos();
    let azim = dot(ugpx, ueast).atan2(dot(ugpx, unor));
    let c = cross(uarp, uvarp);
    let uspn = unit([look * c[0], look * c[1], look * c[2]]);
    let twst = -dot(uspn, ugpy).clamp(-1.0, 1.0).asin();
    let slope = dot(uup, uspn).clamp(-1.0, 1.0).acos();
    let nspn = [-uspn[0], -uspn[1], -uspn[2]];
    let lo_ang = dot(nspn, ueast).atan2(dot(nspn, unor));
    let deg = |v: f64| v.to_degrees();
    {
        let rg = root.children.iter_mut().find(|c| c.name == "ReferenceGeometry").ok_or_else(|| Error::invalid("CPHD XML has no ReferenceGeometry"))?;
        set_v3(rg, "SRP/ECF", srp);
        set_v3(rg, "SRP/IAC", iac);
        set_text(rg, "ReferenceTime", fmt_f(t_ref));
    }
    // A stripmap's dwell polynomials may not cover a far SRP (a negative time): the reference time is
    // the SRP's centre of dwell then, and the dwell time is kept.
    let (t1, t2) = (root.num("Global/Timeline/TxTime1").unwrap_or(f64::NEG_INFINITY), root.num("Global/Timeline/TxTime2").unwrap_or(f64::INFINITY));
    let rg = root.children.iter_mut().find(|c| c.name == "ReferenceGeometry").ok_or_else(|| Error::invalid("CPHD XML has no ReferenceGeometry"))?;
    set_text(rg, "SRPCODTime", fmt_f(cod.filter(|c| *c >= 0.0 && *c >= t1 - 1.0 && *c <= t2 + 1.0).unwrap_or(t_ref)));
    if let Some(d) = dwell.filter(|d| *d > 0.0) {
        set_text(rg, "SRPDwellTime", fmt_f(d));
    }
    set_v3(rg, "Monostatic/ARPPos", arp);
    set_v3(rg, "Monostatic/ARPVel", varp);
    set_text(rg, "Monostatic/SideOfTrack", (if look > 0.0 { "L" } else { "R" }).to_string());
    for (k, v) in [("SlantRange", r_arp_srp), ("GroundRange", srp_dec * ea), ("DopplerConeAngle", deg(dca)), ("GrazeAngle", deg(graz)), ("IncidenceAngle", 90.0 - deg(graz)), ("AzimuthAngle", deg(azim).rem_euclid(360.0)), ("TwistAngle", deg(twst)), ("SlopeAngle", deg(slope)), ("LayoverAngle", deg(lo_ang).rem_euclid(360.0))] {
        set_text(rg, &format!("Monostatic/{k}"), fmt_f(v));
    }
    Ok(())
}

/// Padding the caller writes between the support block and the PVP block (8-byte alignment).
pub fn pad_after_support(m: &Meta) -> u64 {
    m.header.support.map(|s| s.1.div_ceil(8) * 8 - s.1).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(fmt: &str, nv: u64, ns: u64) -> Vec<u8> {
        let bps = match fmt {
            "CI2" => 2,
            "CI4" => 4,
            _ => 8,
        };
        let xml = format!(
            r#"<CPHD xmlns="http://api.nsgreg.nga.mil/schema/cphd/1.0.1"><CollectionID><CollectorName>T</CollectorName></CollectionID><Global><DomainType>FX</DomainType><Timeline><CollectionStart>2020-01-01T00:00:00Z</CollectionStart><TxTime1>0</TxTime1><TxTime2>1</TxTime2></Timeline><FxBand><FxMin>9e9</FxMin><FxMax>10e9</FxMax></FxBand></Global><Data><SignalArrayFormat>{fmt}</SignalArrayFormat><NumBytesPVP>48</NumBytesPVP><NumCPHDChannels>1</NumCPHDChannels><Channel><Identifier>A</Identifier><NumVectors>{nv}</NumVectors><NumSamples>{ns}</NumSamples><SignalArrayByteOffset>0</SignalArrayByteOffset><PVPArrayByteOffset>0</PVPArrayByteOffset></Channel><NumSupportArrays>1</NumSupportArrays><SupportArray><Identifier>G</Identifier><NumRows>2</NumRows><NumCols>3</NumCols><BytesPerElement>8</BytesPerElement><ArrayByteOffset>0</ArrayByteOffset></SupportArray></Data><Channel><RefChId>A</RefChId><Parameters><Identifier>A</Identifier><RefVectorIndex>1</RefVectorIndex><FxC>9.5e9</FxC><FxBW>1e9</FxBW></Parameters></Channel><PVP><TxTime><Offset>0</Offset><Size>1</Size><Format>F8</Format></TxTime><TxPos><Offset>1</Offset><Size>3</Size><Format>X=F8;Y=F8;Z=F8;</Format></TxPos><SC0><Offset>4</Offset><Size>1</Size><Format>F8</Format></SC0><SCSS><Offset>5</Offset><Size>1</Size><Format>F8</Format></SCSS></PVP><SupportArray><AntGainPhase><Identifier>G</Identifier><ElementFormat>Gain=F4;Phase=F4;</ElementFormat><X0>0</X0><Y0>0</Y0><XSS>1</XSS><YSS>1</YSS></AntGainPhase></SupportArray></CPHD>"#
        );
        let support = 48u64;
        let pvp = 48 * nv;
        let sig = nv * ns * bps;
        let mut out = Vec::new();
        let xo = 512u64;
        let so = xo + xml.len() as u64 + 2;
        let po = so + support;
        let go = po + pvp;
        let h = format!("CPHD/1.0.1\nXML_BLOCK_SIZE := {}\nXML_BLOCK_BYTE_OFFSET := {xo}\nSUPPORT_BLOCK_SIZE := {support}\nSUPPORT_BLOCK_BYTE_OFFSET := {so}\nPVP_BLOCK_SIZE := {pvp}\nPVP_BLOCK_BYTE_OFFSET := {po}\nSIGNAL_BLOCK_SIZE := {sig}\nSIGNAL_BLOCK_BYTE_OFFSET := {go}\nCLASSIFICATION := UNCLASSIFIED\nRELEASE_INFO := UNRESTRICTED\n\x0c\n", xml.len());
        out.extend_from_slice(h.as_bytes());
        out.resize(xo as usize, 0);
        out.extend_from_slice(xml.as_bytes());
        out.extend_from_slice(b"\x0c\n");
        for k in 0..6 {
            out.extend_from_slice(&(k as f32).to_be_bytes());
            out.extend_from_slice(&(-(k as f32)).to_be_bytes());
        }
        for v in 0..nv {
            for x in [v as f64 * 0.1, 7e6 + v as f64, 1.0, 2.0, 9.4e9, 1e6] {
                out.extend_from_slice(&x.to_be_bytes());
            }
        }
        for v in 0..nv {
            for s in 0..ns {
                let (re, im) = ((v * 10 + s) as i64, -((v + s) as i64));
                match bps {
                    2 => out.extend_from_slice(&[re as i8 as u8, im as i8 as u8]),
                    4 => {
                        out.extend_from_slice(&(re as i16).to_be_bytes());
                        out.extend_from_slice(&(im as i16).to_be_bytes());
                    }
                    _ => {
                        out.extend_from_slice(&(re as f32).to_be_bytes());
                        out.extend_from_slice(&(im as f32).to_be_bytes());
                    }
                }
            }
        }
        out
    }

    fn open(b: &[u8]) -> Result<Meta> {
        let h = parse_header(b)?;
        parse(b, &b[h.xml.0 as usize..(h.xml.0 + h.xml.1) as usize], b.len() as u64)
    }

    #[test]
    fn header_xml_pvp_support() {
        let b = file("CI4", 4, 5);
        let m = open(&b).unwrap();
        assert_eq!(m.header.version, "1.0.1");
        assert_eq!(m.channels[0].nv, 4);
        assert_eq!(m.bytes_per_sample, 4);
        assert_eq!(m.pvp.len(), 4);
        let po = m.header.pvp.0 as usize;
        let cols = pvp_columns(&m, &b[po..po + 4 * 48]).unwrap();
        // TxTime, TxPos X, Y, Z, SC0, SCSS: 6 columns of 4.
        assert_eq!(cols.len(), 24);
        assert!((cols[2] - 0.2).abs() < 1e-12);
        assert_eq!(cols[4 + 1], 7e6 + 1.0);
        let so = m.header.support.unwrap().0 as usize;
        let s = support_values(&m.support[0], &b[so..so + 48]).unwrap();
        assert_eq!(s[2], 1.0);
        assert_eq!(s[3], -1.0);
        let j = to_json(&m);
        assert!(j.contains("\"signalFormat\":\"CI4\""));
        assert!(j.contains("\"comps\":[\"X\",\"Y\",\"Z\"]"));
    }

    #[test]
    fn refusals_are_named() {
        let mut b = file("CF8", 3, 3);
        let n = b.len();
        assert!(open(&b[..n - 10]).unwrap_err().msg.contains("truncated"));
        let s = String::from_utf8_lossy(&b).replace("CF8", "CX9");
        b = s.into_bytes();
        assert!(open(&b).unwrap_err().msg.contains("signal array format"));
        assert!(parse_header(b"CPHD/0.3\nX := 1\n\x0c\n").unwrap_err().msg.contains("version 0.3"));
        assert!(parse_header(b"CPHD/1.0.1\nXML_BLOCK_SIZE := 1\n").unwrap_err().msg.contains("not terminated"));
        assert!(parse_format("Q9").is_err());
        assert_eq!(parse_format("X=F8;Y=F8;Z=F8;").unwrap().len(), 3);
    }

    #[test]
    fn subset_round_trip() {
        let b = file("CI2", 6, 8);
        let m = open(&b).unwrap();
        let po = m.header.pvp.0 as usize;
        let sub = Sub { ch: 0, v0: 1, v1: 4, s0: 2, s1: 7 };
        let (prefix, pvp) = subset(&m, &[sub], &b[po + 48..po + 4 * 48]).unwrap();
        let so = m.header.support.unwrap();
        let mut out = prefix.clone();
        out.extend_from_slice(&b[so.0 as usize..(so.0 + so.1) as usize]);
        out.resize(out.len() + pad_after_support(&m) as usize, 0);
        out.extend_from_slice(&pvp);
        while out.len() % 8 != 0 {
            out.push(0);
        }
        let go = m.header.signal.0 as usize;
        for v in 1..4 {
            out.extend_from_slice(&b[go + (v * 8 + 2) * 2..go + (v * 8 + 7) * 2]);
        }
        let n = open(&out).unwrap();
        assert_eq!((n.channels[0].nv, n.channels[0].ns), (3, 5));
        let pc = pvp_columns(&n, &out[n.header.pvp.0 as usize..n.header.pvp.0 as usize + 3 * 48]).unwrap();
        // SC0 moved by two sample spacings; TxTime of the first kept vector.
        assert!((pc[4 * 3] - (9.4e9 + 2e6)).abs() < 1e-3);
        assert!((pc[0] - 0.1).abs() < 1e-12);
        let g = n.header.signal.0 as usize;
        // Vector 1, sample 2 of the source: re = 12, im = -3.
        assert_eq!((out[g] as i8, out[g + 1] as i8), (12, -3));
        assert_eq!(n.root.text_at("Global/Timeline/TxTime1").and_then(|t| t.parse::<f64>().ok()), Some(0.1));
        assert_eq!(n.root.text_at("Channel/Parameters/RefVectorIndex"), Some("0"));
    }
}
