//! STANAG 4607 GMTI reader (REQ-FMV-11; `Research/12` §16): packet header, mission, dwell (with
//! the existence mask and target reports, high-resolution or delta positions), job definition,
//! free text and platform location segments. Big-endian; binary angles BA16/BA32 (unsigned,
//! 2^14 / 2^30 = 90°) and SA16/SA32 (signed, same scale), following the Wireshark dissector.
//! Other segment types are counted and skipped by their declared size.

use crate::bytes::latin1;
use gw_abi::{Error, Json, Result};

const MAX_PACKETS: usize = 2_000_000;
const MAX_TARGETS: usize = 65_535;

struct R<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> R<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let e = self.p.checked_add(n).filter(|&e| e <= self.b.len()).ok_or_else(|| Error::range(format!("4607: need {n} bytes at {}", self.p)))?;
        let s = &self.b[self.p..e];
        self.p = e;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn i8(&mut self) -> Result<i8> {
        Ok(self.take(1)?[0] as i8)
    }
    fn u16(&mut self) -> Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    fn i16(&mut self) -> Result<i16> {
        Ok(self.u16()? as i16)
    }
    fn u32(&mut self) -> Result<u32> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(self.u32()? as i32)
    }
    fn u64(&mut self) -> Result<u64> {
        let b = self.take(8)?;
        Ok(u64::from_be_bytes(b.try_into().unwrap()))
    }
    fn text(&mut self, n: usize) -> Result<String> {
        Ok(latin1(self.take(n)?).trim_end_matches(['\0', ' ']).to_string())
    }
    fn sa32(&mut self) -> Result<f64> {
        Ok(self.i32()? as f64 * 90.0 / (1u64 << 30) as f64)
    }
    /// BA32 as a longitude in (−180, 180].
    fn ba32_lon(&mut self) -> Result<f64> {
        let v = self.u32()? as f64 * 90.0 / (1u64 << 30) as f64;
        Ok(if v > 180.0 { v - 360.0 } else { v })
    }
    fn ba16(&mut self) -> Result<f64> {
        Ok(self.u16()? as f64 * 90.0 / (1u32 << 14) as f64)
    }
    fn sa16(&mut self) -> Result<f64> {
        Ok(self.i16()? as f64 * 90.0 / (1u32 << 14) as f64)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Header {
    pub version: String,
    pub size: u32,
    pub nationality: String,
    pub classification: u8,
    pub class_system: String,
    pub security_code: u16,
    pub exercise: u8,
    pub platform: String,
    pub mission: u32,
    pub job: u32,
}

#[derive(Clone, Debug, Default)]
pub struct Mission {
    pub plan: String,
    pub flight_plan: String,
    pub platform_type: u8,
    pub configuration: String,
    pub date: (u16, u8, u8),
}

#[derive(Clone, Debug, Default)]
pub struct Target {
    pub index: Option<u16>,
    pub lat: f64,
    pub lon: f64,
    pub hires: bool,
    pub height: Option<f64>,
    /// Line-of-sight (radial) velocity, m/s.
    pub vlos: Option<f64>,
    pub wrap: Option<f64>,
    pub snr: Option<f64>,
    pub class: Option<u8>,
    pub prob: Option<u8>,
    pub unc: [Option<f64>; 4],
    pub truth: Option<(u8, u32)>,
    pub rcs: Option<f64>,
}

#[derive(Clone, Debug, Default)]
pub struct Dwell {
    pub packet: usize,
    pub platform: String,
    pub mission_id: u32,
    pub job: u32,
    pub mask: u64,
    pub revisit: u16,
    pub dwell: u16,
    pub last: bool,
    pub count: u16,
    pub time_ms: u32,
    pub sensor: (f64, f64, f64),
    pub scale: Option<(f64, f64)>,
    pub track: Option<f64>,
    pub speed: Option<f64>,
    pub vvel: Option<f64>,
    pub platform_hpr: [Option<f64>; 3],
    pub centre: (f64, f64),
    pub range_half_km: f64,
    pub angle_half_deg: f64,
    pub sensor_hpr: [Option<f64>; 3],
    pub mdv: Option<f64>,
    pub targets: Vec<Target>,
}

#[derive(Clone, Debug, Default)]
pub struct Job {
    pub job_id: u32,
    pub sensor_type: u8,
    pub sensor_model: String,
    pub filtering: u8,
    pub priority: u8,
    pub area: [(f64, f64); 4],
    pub radar_mode: u8,
    pub revisit_ds: u16,
    pub terrain_model: u8,
    pub geoid_model: u8,
}

#[derive(Clone, Debug, Default)]
pub struct PlatformLoc {
    pub time_ms: u32,
    pub lat: f64,
    pub lon: f64,
    pub alt_m: f64,
    pub track: f64,
    pub speed: f64,
    pub vvel: f64,
}

#[derive(Default)]
pub struct File {
    pub packets: usize,
    pub header: Option<Header>,
    pub missions: Vec<Mission>,
    pub dwells: Vec<Dwell>,
    pub jobs: Vec<Job>,
    pub platform: Vec<PlatformLoc>,
    pub texts: Vec<(String, String, String)>,
    pub counts: std::collections::BTreeMap<u8, usize>,
    pub errors: Vec<String>,
}

/// Existence-mask bit of dwell field index `i` (D2 = 0 … D31 = 29, D32.1 = 30 … D32.18 = 47).
fn has(mask: u64, i: u32) -> bool {
    mask & (1u64 << (63 - i)) != 0
}

fn dwell(r: &mut R, h: &Header, packet: usize) -> Result<Dwell> {
    let mask = r.u64()?;
    let opt = |i: u32| has(mask, i);
    let mut d = Dwell { packet, platform: h.platform.clone(), mission_id: h.mission, job: h.job, mask, ..Default::default() };
    d.revisit = r.u16()?;
    d.dwell = r.u16()?;
    d.last = r.u8()? != 0;
    d.count = r.u16()?;
    d.time_ms = r.u32()?;
    d.sensor = (r.sa32()?, r.ba32_lon()?, r.i32()? as f64 / 100.0);
    if opt(8) {
        let la = r.sa32()?;
        let lo = r.u32()? as f64 * 90.0 / (1u64 << 30) as f64;
        d.scale = Some((la, lo));
    } else if opt(9) {
        r.take(4)?;
    }
    for i in 10..=12 {
        if opt(i) {
            r.take(if i == 12 { 2 } else { 4 })?;
        }
    }
    if opt(13) {
        d.track = Some(r.ba16()?);
    }
    if opt(14) {
        d.speed = Some(r.u32()? as f64 / 1000.0);
    }
    if opt(15) {
        d.vvel = Some(r.i8()? as f64 / 10.0);
    }
    for (i, n) in [(16, 1), (17, 2), (18, 2)] {
        if opt(i) {
            r.take(n)?;
        }
    }
    if opt(19) {
        d.platform_hpr[0] = Some(r.ba16()?);
    }
    if opt(20) {
        d.platform_hpr[1] = Some(r.sa16()?);
    }
    if opt(21) {
        d.platform_hpr[2] = Some(r.sa16()?);
    }
    d.centre = (r.sa32()?, r.ba32_lon()?);
    d.range_half_km = r.u16()? as f64 / 128.0;
    d.angle_half_deg = r.ba16()?;
    if opt(26) {
        d.sensor_hpr[0] = Some(r.ba16()?);
    }
    if opt(27) {
        d.sensor_hpr[1] = Some(r.sa16()?);
    }
    if opt(28) {
        d.sensor_hpr[2] = Some(r.sa16()?);
    }
    if opt(29) {
        d.mdv = Some(r.u8()? as f64 / 10.0);
    }
    for _ in 0..(d.count as usize).min(MAX_TARGETS) {
        let mut t = Target::default();
        if opt(30) {
            t.index = Some(r.u16()?);
        }
        if opt(31) || opt(32) {
            t.lat = if opt(31) { r.sa32()? } else { d.centre.0 };
            t.lon = if opt(32) { r.ba32_lon()? } else { d.centre.1 };
            t.hires = true;
        }
        if opt(33) || opt(34) {
            let (sl, so) = d.scale.unwrap_or((0.0, 0.0));
            let dl = if opt(33) { r.i16()? as f64 } else { 0.0 };
            let dn = if opt(34) { r.i16()? as f64 } else { 0.0 };
            if !t.hires {
                t.lat = d.centre.0 + dl * sl;
                let mut lo = d.centre.1 + dn * so;
                if lo > 180.0 {
                    lo -= 360.0;
                }
                t.lon = lo;
            }
        }
        if opt(35) {
            t.height = Some(r.i16()? as f64);
        }
        if opt(36) {
            t.vlos = Some(r.i16()? as f64 / 100.0);
        }
        if opt(37) {
            t.wrap = Some(r.u16()? as f64 / 100.0);
        }
        if opt(38) {
            t.snr = Some(r.i8()? as f64);
        }
        if opt(39) {
            t.class = Some(r.u8()?);
        }
        if opt(40) {
            t.prob = Some(r.u8()?);
        }
        if opt(41) {
            t.unc[0] = Some(r.u16()? as f64 / 100.0);
        }
        if opt(42) {
            t.unc[1] = Some(r.u16()? as f64 / 10.0);
        }
        if opt(43) {
            t.unc[2] = Some(r.u8()? as f64);
        }
        if opt(44) {
            t.unc[3] = Some(r.u16()? as f64 / 100.0);
        }
        let app = if opt(45) { Some(r.u8()?) } else { None };
        let ent = if opt(46) { Some(r.u32()?) } else { None };
        if app.is_some() || ent.is_some() {
            t.truth = Some((app.unwrap_or(0), ent.unwrap_or(0)));
        }
        if opt(47) {
            t.rcs = Some(r.i8()? as f64);
        }
        d.targets.push(t);
    }
    Ok(d)
}

pub fn parse(b: &[u8]) -> Result<File> {
    let mut f = File::default();
    let mut p = 0;
    if b.len() < 32 {
        return Err(Error::invalid("4607: shorter than a packet header"));
    }
    while p + 32 <= b.len() && f.packets < MAX_PACKETS {
        let mut r = R { b, p };
        let h = Header { version: r.text(2)?, size: r.u32()?, nationality: r.text(2)?, classification: r.u8()?, class_system: r.text(2)?, security_code: r.u16()?, exercise: r.u8()?, platform: r.text(10)?, mission: r.u32()?, job: r.u32()? };
        if f.packets == 0 && !h.version.chars().all(|c| c.is_ascii_digit()) {
            return Err(Error::invalid("4607: the packet header version is not two digits"));
        }
        let size = h.size as usize;
        if size < 32 || p + size > b.len() {
            f.errors.push(format!("packet {} at {p}: size {size} runs past the file", f.packets));
            break;
        }
        let end = p + size;
        let idx = f.packets;
        f.packets += 1;
        let mut q = p + 32;
        while q + 5 <= end {
            let typ = b[q];
            let ss = u32::from_be_bytes([b[q + 1], b[q + 2], b[q + 3], b[q + 4]]) as usize;
            if ss < 5 || q + ss > end {
                f.errors.push(format!("packet {idx}: segment type {typ} size {ss} runs past the packet"));
                break;
            }
            *f.counts.entry(typ).or_default() += 1;
            let body = &b[q + 5..q + ss];
            let mut r = R { b: body, p: 0 };
            let res: Result<()> = (|| {
                match typ {
                    1 => f.missions.push(Mission { plan: r.text(12)?, flight_plan: r.text(12)?, platform_type: r.u8()?, configuration: r.text(10)?, date: (r.u16()?, r.u8()?, r.u8()?) }),
                    2 => f.dwells.push(dwell(&mut r, &h, idx)?),
                    5 => {
                        let job_id = r.u32()?;
                        let sensor_type = r.u8()?;
                        let sensor_model = r.text(6)?;
                        let filtering = r.u8()?;
                        let priority = r.u8()?;
                        let mut area = [(0.0, 0.0); 4];
                        for a in &mut area {
                            *a = (r.sa32()?, r.ba32_lon()?);
                        }
                        let radar_mode = r.u8()?;
                        let revisit_ds = r.u16()?;
                        r.take(4 + 2 + 1 + 2 + 2 + 2 + 2 + 1 + 1 + 1)?;
                        f.jobs.push(Job { job_id, sensor_type, sensor_model, filtering, priority, area, radar_mode, revisit_ds, terrain_model: r.u8()?, geoid_model: r.u8()? });
                    }
                    6 => {
                        let o = r.text(10)?;
                        let to = r.text(10)?;
                        let t = latin1(&body[r.p..]);
                        f.texts.push((o, to, t));
                    }
                    13 => f.platform.push(PlatformLoc { time_ms: r.u32()?, lat: r.sa32()?, lon: r.ba32_lon()?, alt_m: r.i32()? as f64 / 100.0, track: r.ba16()?, speed: r.u32()? as f64 / 1000.0, vvel: r.i8()? as f64 / 10.0 }),
                    _ => {}
                }
                Ok(())
            })();
            if let Err(e) = res {
                if f.errors.len() < 100 {
                    f.errors.push(format!("packet {idx}: segment type {typ}: {}", e.msg));
                }
            }
            q += ss;
        }
        if f.header.is_none() {
            f.header = Some(h);
        }
        p = end;
    }
    if p < b.len() && f.errors.is_empty() {
        f.errors.push(format!("{} trailing bytes", b.len() - p));
    }
    Ok(f)
}

/// Days since 1970-01-01 of a civil date.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub const CLASS: [&str; 7] = ["", "TOP SECRET", "SECRET", "CONFIDENTIAL", "RESTRICTED", "UNCLASSIFIED", "NO CLASSIFICATION"];

fn opt(j: &mut Json, k: &str, v: Option<f64>) {
    if let Some(x) = v {
        j.kv_num(k, x);
    }
}

pub fn to_json(f: &File) -> String {
    let mut j = Json::new();
    j.obj().kv_int("packets", f.packets as i64);
    if let Some(h) = &f.header {
        j.key("header").obj().kv_str("version", &h.version).kv_str("nationality", &h.nationality).kv_int("classification", h.classification as i64).kv_str("classificationText", CLASS.get(h.classification as usize).copied().unwrap_or("")).kv_str("classSystem", &h.class_system).kv_int("securityCode", h.security_code as i64).kv_int("exercise", h.exercise as i64).kv_str("platform", &h.platform).kv_num("mission", h.mission as f64).kv_num("job", h.job as f64).end_obj();
    }
    j.key("segments").obj();
    for (t, n) in &f.counts {
        j.kv_int(&t.to_string(), *n as i64);
    }
    j.end_obj();
    let date = f.missions.first().map(|m| m.date);
    j.key("missions").arr();
    for m in &f.missions {
        j.obj().kv_str("plan", &m.plan).kv_str("flightPlan", &m.flight_plan).kv_int("platformType", m.platform_type as i64).kv_str("configuration", &m.configuration).key("date").arr().int(m.date.0 as i64).int(m.date.1 as i64).int(m.date.2 as i64).end_arr().end_obj();
    }
    j.end_arr();
    let day0 = date.map(|(y, m, d)| days_from_civil(y as i64, m as i64, d as i64) as f64 * 86_400_000.0);
    j.key("dwells").arr();
    for d in &f.dwells {
        j.obj().kv_int("packet", d.packet as i64).kv_str("platform", &d.platform).kv_num("mission", d.mission_id as f64).kv_num("job", d.job as f64).kv_int("revisit", d.revisit as i64).kv_int("dwell", d.dwell as i64).kv_bool("last", d.last).kv_num("timeMs", d.time_ms as f64);
        match day0 {
            Some(t0) => j.kv_num("utcMs", t0 + d.time_ms as f64),
            None => j.key("utcMs").null(),
        };
        j.key("sensor").arr().num(d.sensor.0).num(d.sensor.1).num(d.sensor.2).end_arr();
        j.key("centre").arr().num(d.centre.0).num(d.centre.1).end_arr().kv_num("rangeHalfKm", d.range_half_km).kv_num("angleHalfDeg", d.angle_half_deg);
        opt(&mut j, "track", d.track);
        opt(&mut j, "speed", d.speed);
        opt(&mut j, "heading", d.platform_hpr[0]);
        opt(&mut j, "sensorHeading", d.sensor_hpr[0]);
        opt(&mut j, "mdv", d.mdv);
        j.key("targets").arr();
        for t in &d.targets {
            j.obj().kv_num("lat", t.lat).kv_num("lon", t.lon).kv_bool("hires", t.hires);
            if let Some(i) = t.index {
                j.kv_int("i", i as i64);
            }
            opt(&mut j, "h", t.height);
            opt(&mut j, "v", t.vlos);
            opt(&mut j, "wrap", t.wrap);
            opt(&mut j, "snr", t.snr);
            if let Some(c) = t.class {
                j.kv_int("class", c as i64);
            }
            if let Some(c) = t.prob {
                j.kv_int("prob", c as i64);
            }
            opt(&mut j, "uRange", t.unc[0]);
            opt(&mut j, "uCross", t.unc[1]);
            if let Some((a, e)) = t.truth {
                j.key("truth").arr().int(a as i64).num(e as f64).end_arr();
            }
            opt(&mut j, "rcs", t.rcs);
            j.end_obj();
        }
        j.end_arr().end_obj();
    }
    j.end_arr();
    j.key("jobs").arr();
    for jb in &f.jobs {
        j.obj().kv_num("id", jb.job_id as f64).kv_int("sensorType", jb.sensor_type as i64).kv_str("sensorModel", &jb.sensor_model).kv_int("radarMode", jb.radar_mode as i64).kv_num("revisitS", jb.revisit_ds as f64 / 10.0).kv_int("terrainModel", jb.terrain_model as i64).kv_int("geoidModel", jb.geoid_model as i64).key("area").arr();
        for (la, lo) in jb.area {
            j.arr().num(la).num(lo).end_arr();
        }
        j.end_arr().end_obj();
    }
    j.end_arr();
    j.key("platform").arr();
    for p in &f.platform {
        j.obj().kv_num("timeMs", p.time_ms as f64);
        if let Some(t0) = day0 {
            j.kv_num("utcMs", t0 + p.time_ms as f64);
        }
        j.kv_num("lat", p.lat).kv_num("lon", p.lon).kv_num("alt", p.alt_m).kv_num("track", p.track).kv_num("speed", p.speed).end_obj();
    }
    j.end_arr();
    j.key("texts").arr();
    for (o, r, t) in &f.texts {
        j.obj().kv_str("from", o).kv_str("to", r).kv_str("text", t).end_obj();
    }
    j.end_arr().key("errors").arr();
    for e in &f.errors {
        j.str(e);
    }
    j.end_arr().end_obj();
    j.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sa32(v: f64) -> [u8; 4] {
        ((v / 90.0 * (1u64 << 30) as f64).round() as i32).to_be_bytes()
    }
    fn ba32(v: f64) -> [u8; 4] {
        let v = if v < 0.0 { v + 360.0 } else { v };
        ((v / 90.0 * (1u64 << 30) as f64).round() as u32).to_be_bytes()
    }
    fn seg(t: u8, body: &[u8]) -> Vec<u8> {
        let mut s = vec![t];
        s.extend(((body.len() + 5) as u32).to_be_bytes());
        s.extend(body);
        s
    }
    fn packet(segs: &[Vec<u8>]) -> Vec<u8> {
        let n: usize = 32 + segs.iter().map(|s| s.len()).sum::<usize>();
        let mut p = b"30".to_vec();
        p.extend((n as u32).to_be_bytes());
        p.extend(b"XN");
        p.push(5);
        p.extend(b"XN");
        p.extend(0u16.to_be_bytes());
        p.push(0);
        p.extend(b"GW-SYN-01 ");
        p.extend(7u32.to_be_bytes());
        p.extend(42u32.to_be_bytes());
        for s in segs {
            p.extend(s);
        }
        p
    }

    #[test]
    fn dwell_with_hires_and_delta_targets() {
        let mut m = b"MISSIONPLAN1FLIGHTPLAN1".to_vec();
        m.push(b' ');
        m.push(19);
        m.extend(b"CONFIG0001");
        m.extend(2025u16.to_be_bytes());
        m.extend([10, 26]);
        // Dwell: mandatory D2–D9, D10/D11, D24–D27 and target fields D32.1–D32.7, D32.9.
        let mut mask: u64 = 0;
        for i in [0u32, 1, 2, 3, 4, 5, 6, 7, 8, 9, 22, 23, 24, 25, 30, 31, 32, 35, 36, 38] {
            mask |= 1 << (63 - i);
        }
        let mut d = mask.to_be_bytes().to_vec();
        d.extend(1u16.to_be_bytes());
        d.extend(3u16.to_be_bytes());
        d.push(1);
        d.extend(2u16.to_be_bytes());
        d.extend(36_000_500u32.to_be_bytes());
        d.extend(sa32(-34.40));
        d.extend(ba32(-58.70));
        d.extend(800_000i32.to_be_bytes());
        d.extend(sa32(1e-5));
        d.extend(ba32(1e-5));
        d.extend(sa32(-34.505));
        d.extend(ba32(-58.595));
        d.extend(((5.5 * 128.0) as u16).to_be_bytes());
        d.extend(((10.0 / 90.0 * 16384.0) as u16).to_be_bytes());
        for (k, (la, lo)) in [(-34.5071, -58.5952), (-34.5033, -58.5911)].iter().enumerate() {
            d.extend((k as u16).to_be_bytes());
            d.extend(sa32(*la));
            d.extend(ba32(*lo));
            d.extend(12i16.to_be_bytes());
            d.extend((-1250i16).to_be_bytes());
            d.push(17);
        }
        let mut b = packet(&[seg(1, &m), seg(2, &d)]);
        b.extend(packet(&[seg(6, b"ORIGINATORRECIPIENT hello")]));
        let f = parse(&b).unwrap();
        assert_eq!(f.packets, 2);
        assert!(f.errors.is_empty(), "{:?}", f.errors);
        assert_eq!(f.missions[0].date, (2025, 10, 26));
        let dw = &f.dwells[0];
        assert_eq!(dw.targets.len(), 2);
        let t = &dw.targets[1];
        // BA32/SA32 resolution ≈ 8.4e-8° (9 mm).
        assert!((t.lat + 34.5033).abs() < 2e-7 && (t.lon + 58.5911).abs() < 2e-7);
        assert_eq!(t.vlos, Some(-12.5));
        assert_eq!(t.height, Some(12.0));
        assert!((dw.range_half_km - 5.5).abs() < 1e-9);
        assert!((dw.sensor.2 - 8000.0).abs() < 1e-9);
        assert_eq!(f.texts[0].2, "hello");
        let js = to_json(&f);
        assert!(js.contains("\"utcMs\":"));
        // Truncated input: an error, no panic.
        let f2 = parse(&b[..b.len() - 7]).unwrap();
        assert!(!f2.errors.is_empty());
        assert!(parse(b"not 4607 at all, not at all ok!!").is_err());
    }

    #[test]
    fn civil_days() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2025, 10, 26), 20387);
    }
}
