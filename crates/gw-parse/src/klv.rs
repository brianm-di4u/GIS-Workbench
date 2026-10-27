//! KLV for motion imagery (REQ-FMV-02, REQ-FMV-03, REQ-FMV-12; `Research/12` §5–7): SMPTE 336
//! universal-label packets with BER lengths, the MISB ST 0601 UAS Datalink Local Set (BER-OID
//! tags, running-sum checksum, integer and IMAPB mappings, special values), the ST 0102 Security
//! Local Set and the ST 0903 VMTI Local Set, standalone or nested (Items 48 and 74).
//!
//! Every item is kept with its raw bytes. Items the table does not know are listed, not dropped
//! (AC-15.1). A packet whose checksum fails is returned with `checksum_ok = false`; callers must
//! not use its values (ST 0601 says such packets are discarded).

use gw_abi::{Error, Json, Result};

pub const UAS_KEY: [u8; 16] = [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01, 0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00];
pub const SECURITY_KEY: [u8; 16] = [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x03, 0x01, 0x01, 0x0E, 0x01, 0x03, 0x03, 0x02, 0x00, 0x00, 0x00];
pub const VMTI_KEY: [u8; 16] = [0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01, 0x0E, 0x01, 0x03, 0x03, 0x06, 0x00, 0x00, 0x00];

/// Packets decoded from one buffer at most (hostile input bound).
const MAX_PACKETS: usize = 1 << 20;
/// Nesting depth for local sets.
const MAX_DEPTH: usize = 4;

/// BER length (short or long form, at most 8 bytes). Returns (length, bytes used).
pub fn ber_length(b: &[u8]) -> Result<(usize, usize)> {
    let f = *b.first().ok_or_else(|| Error::range("BER length: no bytes"))?;
    if f < 0x80 {
        return Ok((f as usize, 1));
    }
    let n = (f & 0x7F) as usize;
    if n == 0 || n > 8 || b.len() < 1 + n {
        return Err(Error::range("BER length: bad long form"));
    }
    let mut v: u64 = 0;
    for &c in &b[1..=n] {
        v = (v << 8) | c as u64;
    }
    if v > usize::MAX as u64 / 2 {
        return Err(Error::range("BER length: too large"));
    }
    Ok((v as usize, 1 + n))
}

/// BER-OID tag (7 bits per byte, high bit = more). Returns (tag, bytes used).
pub fn ber_oid(b: &[u8]) -> Result<(u32, usize)> {
    let mut v: u32 = 0;
    for (i, &c) in b.iter().enumerate().take(5) {
        v = v.checked_shl(7).ok_or_else(|| Error::range("BER-OID: too large"))? | (c & 0x7F) as u32;
        if c & 0x80 == 0 {
            return Ok((v, i + 1));
        }
    }
    Err(Error::range("BER-OID: unterminated"))
}

/// ST 0601 running 16-bit checksum over `b` (key through the checksum item's length byte).
pub fn checksum(b: &[u8]) -> u16 {
    let mut s: u16 = 0;
    for (i, &c) in b.iter().enumerate() {
        s = s.wrapping_add((c as u16) << (8 * ((i + 1) % 2)));
    }
    s
}

/// Big-endian unsigned integer of up to 8 bytes.
fn be_u(b: &[u8]) -> u64 {
    b.iter().take(8).fold(0u64, |a, &c| (a << 8) | c as u64)
}

/// Big-endian two's-complement integer of 1–8 bytes.
fn be_i(b: &[u8]) -> i64 {
    let n = b.len().min(8);
    if n == 0 {
        return 0;
    }
    let u = be_u(&b[..n]);
    let shift = 64 - 8 * n as u32;
    ((u << shift) as i64) >> shift
}

/// ST 1201 IMAPB: L bytes → value in [a, b]; `None` for the reserved special values.
pub fn imapb(bytes: &[u8], a: f64, b: f64) -> Option<f64> {
    let l = bytes.len();
    if l == 0 || l > 8 {
        return None;
    }
    let y = be_u(bytes);
    let d_pow = 8 * l as i32 - 1;
    // Special values: the top bit set with any other bit set (ST 1201 §8.1.2).
    if l < 8 && y > (1u64 << d_pow) {
        return None;
    }
    let b_pow = (b - a).log2().ceil() as i32;
    let s_f = 2f64.powi(d_pow - b_pow);
    let s_r = 2f64.powi(b_pow - d_pow);
    let z = if a < 0.0 && b > 0.0 { s_f * a - (s_f * a).floor() } else { 0.0 };
    Some(s_r * (y as f64 - z) + a)
}

/// ST 1201 IMAPB encoder (fixtures and round-trip tests).
pub fn imapb_encode(x: f64, a: f64, b: f64, l: usize) -> Vec<u8> {
    let d_pow = 8 * l as i32 - 1;
    let b_pow = (b - a).log2().ceil() as i32;
    let s_f = 2f64.powi(d_pow - b_pow);
    let z = if a < 0.0 && b > 0.0 { s_f * a - (s_f * a).floor() } else { 0.0 };
    let y = (s_f * (x - a) + z).trunc().max(0.0) as u64;
    y.to_be_bytes()[8 - l..].to_vec()
}

/// How an item's bytes become a value.
#[derive(Clone, Copy, Debug)]
pub enum Fmt {
    /// Unsigned integer mapped onto [a, b].
    U(f64, f64),
    /// Signed integer mapped onto ±b; the most negative value is "out of range".
    S(f64),
    /// Plain unsigned integer (scaled by the factor).
    UInt(f64),
    /// Plain signed integer.
    Int,
    /// uint64 microseconds (Precision Time Stamp style).
    Time,
    Utf8,
    Bytes,
    Imapb(f64, f64),
    /// ST 0102 Security Local Set.
    Security,
    /// ST 0903 VMTI Local Set.
    Vmti,
    /// Another nested local set or pack, kept raw.
    Set,
}

pub struct ItemDef {
    pub tag: u32,
    pub name: &'static str,
    pub fmt: Fmt,
    pub units: &'static str,
}

const fn d(tag: u32, name: &'static str, fmt: Fmt, units: &'static str) -> ItemDef {
    ItemDef { tag, name, fmt, units }
}

use Fmt::*;

/// ST 0601.19 Table 1 (names, formats and ranges; ranges as ST 0601.8 keeps them).
pub static UAS_ITEMS: &[ItemDef] = &[
    d(1, "Checksum", UInt(1.0), ""),
    d(2, "Precision Time Stamp", Time, "µs"),
    d(3, "Mission ID", Utf8, ""),
    d(4, "Platform Tail Number", Utf8, ""),
    d(5, "Platform Heading Angle", U(0.0, 360.0), "°"),
    d(6, "Platform Pitch Angle", S(20.0), "°"),
    d(7, "Platform Roll Angle", S(50.0), "°"),
    d(8, "Platform True Airspeed", UInt(1.0), "m/s"),
    d(9, "Platform Indicated Airspeed", UInt(1.0), "m/s"),
    d(10, "Platform Designation", Utf8, ""),
    d(11, "Image Source Sensor", Utf8, ""),
    d(12, "Image Coordinate System", Utf8, ""),
    d(13, "Sensor Latitude", S(90.0), "°"),
    d(14, "Sensor Longitude", S(180.0), "°"),
    d(15, "Sensor True Altitude", U(-900.0, 19000.0), "m MSL"),
    d(16, "Sensor Horizontal Field of View", U(0.0, 180.0), "°"),
    d(17, "Sensor Vertical Field of View", U(0.0, 180.0), "°"),
    d(18, "Sensor Relative Azimuth Angle", U(0.0, 360.0), "°"),
    d(19, "Sensor Relative Elevation Angle", S(180.0), "°"),
    d(20, "Sensor Relative Roll Angle", U(0.0, 360.0), "°"),
    d(21, "Slant Range", U(0.0, 5_000_000.0), "m"),
    d(22, "Target Width", U(0.0, 10_000.0), "m"),
    d(23, "Frame Center Latitude", S(90.0), "°"),
    d(24, "Frame Center Longitude", S(180.0), "°"),
    d(25, "Frame Center Elevation", U(-900.0, 19000.0), "m MSL"),
    d(26, "Offset Corner Latitude Point 1", S(0.075), "°"),
    d(27, "Offset Corner Longitude Point 1", S(0.075), "°"),
    d(28, "Offset Corner Latitude Point 2", S(0.075), "°"),
    d(29, "Offset Corner Longitude Point 2", S(0.075), "°"),
    d(30, "Offset Corner Latitude Point 3", S(0.075), "°"),
    d(31, "Offset Corner Longitude Point 3", S(0.075), "°"),
    d(32, "Offset Corner Latitude Point 4", S(0.075), "°"),
    d(33, "Offset Corner Longitude Point 4", S(0.075), "°"),
    d(34, "Icing Detected", UInt(1.0), ""),
    d(35, "Wind Direction", U(0.0, 360.0), "°"),
    d(36, "Wind Speed", U(0.0, 100.0), "m/s"),
    d(37, "Static Pressure", U(0.0, 5000.0), "mbar"),
    d(38, "Density Altitude", U(-900.0, 19000.0), "m"),
    d(39, "Outside Air Temperature", Int, "°C"),
    d(40, "Target Location Latitude", S(90.0), "°"),
    d(41, "Target Location Longitude", S(180.0), "°"),
    d(42, "Target Location Elevation", U(-900.0, 19000.0), "m"),
    d(43, "Target Track Gate Width", UInt(2.0), "px"),
    d(44, "Target Track Gate Height", UInt(2.0), "px"),
    d(45, "Target Error Estimate - CE90", U(0.0, 4095.0), "m"),
    d(46, "Target Error Estimate - LE90", U(0.0, 4095.0), "m"),
    d(47, "Generic Flag Data", UInt(1.0), ""),
    d(48, "Security Local Set", Security, ""),
    d(49, "Differential Pressure", U(0.0, 5000.0), "mbar"),
    d(50, "Platform Angle of Attack", S(20.0), "°"),
    d(51, "Platform Vertical Speed", S(180.0), "m/s"),
    d(52, "Platform Sideslip Angle", S(20.0), "°"),
    d(53, "Airfield Barometric Pressure", U(0.0, 5000.0), "mbar"),
    d(54, "Airfield Elevation", U(-900.0, 19000.0), "m"),
    d(55, "Relative Humidity", U(0.0, 100.0), "%"),
    d(56, "Platform Ground Speed", UInt(1.0), "m/s"),
    d(57, "Ground Range", U(0.0, 5_000_000.0), "m"),
    d(58, "Platform Fuel Remaining", U(0.0, 10_000.0), "kg"),
    d(59, "Platform Call Sign", Utf8, ""),
    d(60, "Weapon Load", UInt(1.0), ""),
    d(61, "Weapon Fired", UInt(1.0), ""),
    d(62, "Laser PRF Code", UInt(1.0), ""),
    d(63, "Sensor Field of View Name", UInt(1.0), ""),
    d(64, "Platform Magnetic Heading", U(0.0, 360.0), "°"),
    d(65, "UAS Datalink LS Version Number", UInt(1.0), ""),
    d(66, "Deprecated", Bytes, ""),
    d(67, "Alternate Platform Latitude", S(90.0), "°"),
    d(68, "Alternate Platform Longitude", S(180.0), "°"),
    d(69, "Alternate Platform Altitude", U(-900.0, 19000.0), "m MSL"),
    d(70, "Alternate Platform Name", Utf8, ""),
    d(71, "Alternate Platform Heading", U(0.0, 360.0), "°"),
    d(72, "Event Start Time - UTC", Time, "µs"),
    d(73, "RVT Local Set", Set, ""),
    d(74, "VMTI Local Set", Vmti, ""),
    d(75, "Sensor Ellipsoid Height", U(-900.0, 19000.0), "m HAE"),
    d(76, "Alternate Platform Ellipsoid Height", U(-900.0, 19000.0), "m HAE"),
    d(77, "Operational Mode", UInt(1.0), ""),
    d(78, "Frame Center Height Above Ellipsoid", U(-900.0, 19000.0), "m HAE"),
    d(79, "Sensor North Velocity", S(327.0), "m/s"),
    d(80, "Sensor East Velocity", S(327.0), "m/s"),
    d(81, "Image Horizon Pixel Pack", Set, ""),
    d(82, "Corner Latitude Point 1 (Full)", S(90.0), "°"),
    d(83, "Corner Longitude Point 1 (Full)", S(180.0), "°"),
    d(84, "Corner Latitude Point 2 (Full)", S(90.0), "°"),
    d(85, "Corner Longitude Point 2 (Full)", S(180.0), "°"),
    d(86, "Corner Latitude Point 3 (Full)", S(90.0), "°"),
    d(87, "Corner Longitude Point 3 (Full)", S(180.0), "°"),
    d(88, "Corner Latitude Point 4 (Full)", S(90.0), "°"),
    d(89, "Corner Longitude Point 4 (Full)", S(180.0), "°"),
    d(90, "Platform Pitch Angle (Full)", S(90.0), "°"),
    d(91, "Platform Roll Angle (Full)", S(90.0), "°"),
    d(92, "Platform Angle of Attack (Full)", S(90.0), "°"),
    d(93, "Platform Sideslip Angle (Full)", S(180.0), "°"),
    d(94, "MIIS Core Identifier", Bytes, ""),
    d(95, "SAR Motion Imagery Local Set", Set, ""),
    d(96, "Target Width Extended", Imapb(0.0, 1_500_000.0), "m"),
    d(97, "Range Image Local Set", Set, ""),
    d(98, "Geo-Registration Local Set", Set, ""),
    d(99, "Composite Imaging Local Set", Set, ""),
    d(100, "Segment Local Set", Set, ""),
    d(101, "Amend Local Set", Set, ""),
    d(102, "SDCC-FLP", Bytes, ""),
    d(103, "Density Altitude Extended", Imapb(-900.0, 40_000.0), "m"),
    d(104, "Sensor Ellipsoid Height Extended", Imapb(-900.0, 40_000.0), "m HAE"),
    d(105, "Alternate Platform Ellipsoid Height Extended", Imapb(-900.0, 40_000.0), "m HAE"),
    d(106, "Stream Designator", Utf8, ""),
    d(107, "Operational Base", Utf8, ""),
    d(108, "Broadcast Source", Utf8, ""),
    d(109, "Range To Recovery Location", Imapb(0.0, 21_000.0), "km"),
    d(110, "Time Airborne", UInt(1.0), "s"),
    d(111, "Propulsion Unit Speed", UInt(1.0), "rpm"),
    d(112, "Platform Course Angle", Imapb(0.0, 360.0), "°"),
    d(113, "Altitude Above Ground Level (AGL)", Imapb(-900.0, 40_000.0), "m"),
    d(114, "Radar Altimeter", Imapb(-900.0, 40_000.0), "m"),
    d(115, "Control Command", Set, ""),
    d(116, "Control Command Verification List", Bytes, ""),
    d(117, "Sensor Azimuth Rate", Imapb(-1000.0, 1000.0), "°/s"),
    d(118, "Sensor Elevation Rate", Imapb(-1000.0, 1000.0), "°/s"),
    d(119, "Sensor Roll Rate", Imapb(-1000.0, 1000.0), "°/s"),
    d(120, "On-board MI Storage Percent Full", Imapb(0.0, 100.0), "%"),
    d(121, "Active Wavelength List", Bytes, ""),
    d(122, "Country Codes", Set, ""),
    d(123, "Number of NAVSATs in View", UInt(1.0), ""),
    d(124, "Positioning Method Source", UInt(1.0), ""),
    d(125, "Platform Status", UInt(1.0), ""),
    d(126, "Sensor Control Mode", UInt(1.0), ""),
    d(127, "Sensor Frame Rate Pack", Set, ""),
    d(128, "Wavelengths List", Set, ""),
    d(129, "Target ID", Utf8, ""),
    d(130, "Airbase Locations", Set, ""),
    d(131, "Take-off Time", Time, "µs"),
    d(132, "Transmission Frequency", Imapb(1.0, 99_999.0), "MHz"),
    d(133, "On-board MI Storage Capacity", UInt(1.0), "GB"),
    d(134, "Zoom Percentage", Imapb(0.0, 100.0), "%"),
    d(135, "Communications Method", Utf8, ""),
    d(136, "Leap Seconds", Int, "s"),
    d(137, "Correction Offset", Int, "µs"),
    d(138, "Payload List", Set, ""),
    d(139, "Active Payloads", Bytes, ""),
    d(140, "Weapons Stores", Set, ""),
    d(141, "Waypoint List", Set, ""),
    d(142, "View Domain", Set, ""),
    d(143, "Metadata Substream ID Pack", Bytes, ""),
];

/// ST 0102 Security Metadata Local Set.
pub static SECURITY_ITEMS: &[ItemDef] = &[
    d(1, "Security Classification", UInt(1.0), ""),
    d(2, "Classifying Country and Releasing Instructions Country Coding Method", UInt(1.0), ""),
    d(3, "Classifying Country", Utf8, ""),
    d(4, "Security-SCI/SHI Information", Utf8, ""),
    d(5, "Caveats", Utf8, ""),
    d(6, "Releasing Instructions", Utf8, ""),
    d(7, "Classified By", Utf8, ""),
    d(8, "Derived From", Utf8, ""),
    d(9, "Classification Reason", Utf8, ""),
    d(10, "Declassification Date", Utf8, ""),
    d(11, "Classification and Marking System", Utf8, ""),
    d(12, "Object Country Coding Method", UInt(1.0), ""),
    d(13, "Object Country Codes", Utf8, ""),
    d(14, "Classification Comments", Utf8, ""),
    d(15, "UMID", Bytes, ""),
    d(16, "Stream ID", UInt(1.0), ""),
    d(17, "Transport Stream ID", UInt(1.0), ""),
    d(21, "Item Designator ID", Bytes, ""),
    d(22, "Version", UInt(1.0), ""),
    d(23, "Classifying Country and Releasing Instructions Country Coding Method Version Date", Utf8, ""),
    d(24, "Object Country Coding Method Version Date", Utf8, ""),
];

/// ST 0903 VMTI Local Set.
pub static VMTI_ITEMS: &[ItemDef] = &[
    d(1, "Checksum", UInt(1.0), ""),
    d(2, "Precision Time Stamp", Time, "µs"),
    d(3, "VMTI System Name", Utf8, ""),
    d(4, "VMTI LS Version", UInt(1.0), ""),
    d(5, "Total Number of Targets Detected", UInt(1.0), ""),
    d(6, "Number of Reported Targets", UInt(1.0), ""),
    d(7, "Motion Imagery Frame Number", UInt(1.0), ""),
    d(8, "Frame Width", UInt(1.0), "px"),
    d(9, "Frame Height", UInt(1.0), "px"),
    d(10, "Source Sensor", Utf8, ""),
    d(11, "VMTI Horizontal FOV", Imapb(0.0, 180.0), "°"),
    d(12, "VMTI Vertical FOV", Imapb(0.0, 180.0), "°"),
    d(13, "MIIS ID", Bytes, ""),
    d(101, "VTarget Series", Set, ""),
    d(102, "Algorithm Series", Set, ""),
    d(103, "Ontology Series", Set, ""),
];

/// ST 0903 VTarget Pack items.
pub static VTARGET_ITEMS: &[ItemDef] = &[
    d(1, "Target Centroid", UInt(1.0), "px#"),
    d(2, "Bounding Box Top Left", UInt(1.0), "px#"),
    d(3, "Bounding Box Bottom Right", UInt(1.0), "px#"),
    d(4, "Target Priority", UInt(1.0), ""),
    d(5, "Target Confidence Level", UInt(1.0), "%"),
    d(6, "Target History", UInt(1.0), "frames"),
    d(7, "Percentage of Target Pixels", UInt(1.0), "%"),
    d(8, "Target Color", UInt(1.0), ""),
    d(9, "Target Intensity", UInt(1.0), ""),
    d(10, "Target Location Offset Latitude", Imapb(-19.2, 19.2), "°"),
    d(11, "Target Location Offset Longitude", Imapb(-19.2, 19.2), "°"),
    d(12, "Target Height", Imapb(-900.0, 19000.0), "m"),
    d(13, "Bounding Box Top Left Latitude Offset", Imapb(-19.2, 19.2), "°"),
    d(14, "Bounding Box Top Left Longitude Offset", Imapb(-19.2, 19.2), "°"),
    d(15, "Bounding Box Bottom Right Latitude Offset", Imapb(-19.2, 19.2), "°"),
    d(16, "Bounding Box Bottom Right Longitude Offset", Imapb(-19.2, 19.2), "°"),
    d(17, "Target Location", Set, ""),
    d(18, "Target Boundary Series", Set, ""),
    d(19, "Centroid Pix Row", UInt(1.0), "px"),
    d(20, "Centroid Pix Column", UInt(1.0), "px"),
    d(21, "FPA Index", Set, ""),
    d(22, "Algorithm ID", UInt(1.0), ""),
    d(101, "VMask", Set, ""),
    d(102, "VObject", Set, ""),
    d(103, "VFeature", Set, ""),
    d(104, "VTracker", Set, ""),
    d(105, "VChip", Set, ""),
    d(106, "VChip Series", Set, ""),
    d(107, "VObject Series", Set, ""),
];

fn def_of(table: &'static [ItemDef], tag: u32) -> Option<&'static ItemDef> {
    table.iter().find(|x| x.tag == tag)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Num(f64),
    Text(String),
    /// A reserved value: "out of range", "N/A", "special".
    Special(&'static str),
    /// A nested local set.
    Set(Vec<Item>),
    /// One VTarget per entry.
    Targets(Vec<VTarget>),
    /// Zero-length item: unknown (ST 0601).
    Empty,
    /// Raw bytes only.
    Raw,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    pub tag: u32,
    pub name: &'static str,
    pub units: &'static str,
    pub known: bool,
    pub raw: Vec<u8>,
    pub value: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VTarget {
    pub id: u32,
    pub items: Vec<Item>,
    /// Target Location pack (Item 17): lat, lon, HAE.
    pub location: Option<(f64, f64, f64)>,
}

fn decode_value(def: &ItemDef, v: &[u8], depth: usize) -> Value {
    if v.is_empty() {
        return Value::Empty;
    }
    match def.fmt {
        U(a, b) => {
            if v.len() > 8 {
                return Value::Raw;
            }
            let n = v.len() as i32;
            let max = if n == 8 { u64::MAX as f64 } else { ((1u64 << (8 * n)) - 1) as f64 };
            Value::Num(a + be_u(v) as f64 * (b - a) / max)
        }
        S(b) => {
            if v.len() > 8 {
                return Value::Raw;
            }
            let n = v.len() as i32;
            let raw = be_i(v);
            let min = if n == 8 { i64::MIN } else { -(1i64 << (8 * n - 1)) };
            if raw == min {
                return Value::Special("out of range");
            }
            let half = if n == 8 { i64::MAX as f64 } else { ((1i64 << (8 * n - 1)) - 1) as f64 };
            Value::Num(raw as f64 * (b / half))
        }
        UInt(k) => {
            if v.len() > 8 {
                return Value::Raw;
            }
            Value::Num(be_u(v) as f64 * k)
        }
        Int => {
            if v.len() > 8 {
                return Value::Raw;
            }
            Value::Num(be_i(v) as f64)
        }
        Time => {
            if v.len() != 8 {
                return Value::Raw;
            }
            Value::Num(be_u(v) as f64)
        }
        Utf8 => Value::Text(text(v)),
        Bytes => Value::Raw,
        Imapb(a, b) => match imapb(v, a, b) {
            Some(x) => Value::Num(x),
            None => Value::Special("special"),
        },
        Security => match local_set(v, SECURITY_ITEMS, depth + 1) {
            Ok(items) => Value::Set(items),
            Err(_) => Value::Raw,
        },
        Vmti => match local_set(v, VMTI_ITEMS, depth + 1) {
            Ok(items) => Value::Set(items),
            Err(_) => Value::Raw,
        },
        Set => Value::Raw,
    }
}

/// UTF-8 text with a lossy fallback; UTF-16BE when every other byte is zero (ST 0102 Item 13).
fn text(v: &[u8]) -> String {
    if v.len() >= 2 && v.len() % 2 == 0 && v.iter().step_by(2).all(|&c| c == 0) {
        let u: Vec<u16> = v.chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&u).trim_end_matches('\0').to_string();
    }
    String::from_utf8_lossy(v).trim_end_matches('\0').to_string()
}

/// Tag–length–value items of a local set.
pub fn local_set(b: &[u8], table: &'static [ItemDef], depth: usize) -> Result<Vec<Item>> {
    if depth > MAX_DEPTH {
        return Err(Error::limit("KLV: local sets nested too deep"));
    }
    let mut out = Vec::new();
    let mut p = 0;
    while p < b.len() {
        let (tag, nt) = ber_oid(&b[p..])?;
        p += nt;
        let (len, nl) = ber_length(&b[p..])?;
        p += nl;
        let end = p.checked_add(len).filter(|&e| e <= b.len()).ok_or_else(|| Error::range(format!("KLV: item {tag} runs past its set")))?;
        let v = &b[p..end];
        p = end;
        let def = def_of(table, tag);
        let mut item = Item { tag, name: def.map_or("Unknown item", |x| x.name), units: def.map_or("", |x| x.units), known: def.is_some(), raw: v.to_vec(), value: def.map_or(Value::Raw, |x| decode_value(x, v, depth)) };
        // VTarget series (VMTI Item 101): series of (BER length, VTarget pack).
        if std::ptr::eq(table, VMTI_ITEMS) && tag == 101 {
            if let Ok(t) = vtarget_series(v, depth) {
                item.value = Value::Targets(t);
            }
        }
        out.push(item);
    }
    Ok(out)
}

fn vtarget_series(b: &[u8], depth: usize) -> Result<Vec<VTarget>> {
    let mut out = Vec::new();
    let mut p = 0;
    while p < b.len() {
        let (len, nl) = ber_length(&b[p..])?;
        p += nl;
        let end = p.checked_add(len).filter(|&e| e <= b.len()).ok_or_else(|| Error::range("VMTI: VTarget runs past its series"))?;
        let pack = &b[p..end];
        p = end;
        let (id, ni) = ber_oid(pack)?;
        let items = local_set(&pack[ni..], VTARGET_ITEMS, depth + 1)?;
        let location = items.iter().find(|x| x.tag == 17).and_then(|x| {
            let r = &x.raw;
            if r.len() < 10 {
                return None;
            }
            Some((imapb(&r[0..4], -90.0, 90.0)?, imapb(&r[4..8], -180.0, 180.0)?, imapb(&r[8..10], -900.0, 19000.0)?))
        });
        out.push(VTarget { id, items, location });
        if out.len() > 100_000 {
            return Err(Error::limit("VMTI: too many targets"));
        }
    }
    Ok(out)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Uas,
    Security,
    Vmti,
    Other,
}

#[derive(Clone, Debug)]
pub struct Packet {
    pub kind: Kind,
    pub key: [u8; 16],
    /// Byte offset of the key in the input.
    pub offset: usize,
    /// Whole packet length (key + length + value).
    pub length: usize,
    /// None when the set carries no checksum item.
    pub checksum_ok: Option<bool>,
    pub items: Vec<Item>,
    pub error: Option<String>,
}

fn kind_of(key: &[u8]) -> Kind {
    // Byte 7 (registry version) varies between encoders; compare the rest.
    let same = |k: &[u8; 16]| key.iter().zip(k.iter()).enumerate().all(|(i, (a, b))| i == 7 || a == b);
    if same(&UAS_KEY) {
        Kind::Uas
    } else if same(&SECURITY_KEY) {
        Kind::Security
    } else if same(&VMTI_KEY) {
        Kind::Vmti
    } else {
        Kind::Other
    }
}

/// Every KLV packet in `b` (one or more back to back; garbage between packets is skipped to the
/// next SMPTE label).
pub fn decode_packets(b: &[u8]) -> Vec<Packet> {
    let mut out = Vec::new();
    let mut p = 0;
    while p + 17 <= b.len() && out.len() < MAX_PACKETS {
        if b[p..p + 4] != [0x06, 0x0E, 0x2B, 0x34] {
            match b[p + 1..].windows(4).position(|w| w == [0x06, 0x0E, 0x2B, 0x34]) {
                Some(k) => p += 1 + k,
                None => break,
            }
            continue;
        }
        let mut key = [0u8; 16];
        key.copy_from_slice(&b[p..p + 16]);
        let kind = kind_of(&key);
        let (len, nl) = match ber_length(&b[p + 16..]) {
            Ok(x) => x,
            Err(e) => {
                out.push(Packet { kind, key, offset: p, length: 16, checksum_ok: None, items: vec![], error: Some(e.msg) });
                p += 16;
                continue;
            }
        };
        let vstart = p + 16 + nl;
        let Some(vend) = vstart.checked_add(len).filter(|&e| e <= b.len()) else {
            out.push(Packet { kind, key, offset: p, length: b.len() - p, checksum_ok: None, items: vec![], error: Some(format!("KLV: packet of {len} bytes is truncated")) });
            break;
        };
        out.push(decode_one(&b[p..vend], kind, key, p, vstart - p));
        p = vend;
    }
    out
}

fn decode_one(pkt: &[u8], kind: Kind, key: [u8; 16], offset: usize, vstart: usize) -> Packet {
    let table = match kind {
        Kind::Uas => UAS_ITEMS,
        Kind::Security => SECURITY_ITEMS,
        Kind::Vmti => VMTI_ITEMS,
        Kind::Other => {
            return Packet { kind, key, offset, length: pkt.len(), checksum_ok: None, items: vec![], error: None };
        }
    };
    let (items, error) = match local_set(&pkt[vstart..], table, 0) {
        Ok(i) => (i, None),
        Err(e) => (partial_items(&pkt[vstart..], table), Some(e.msg)),
    };
    // Checksum: Item 1 of a UAS or VMTI set, last, 2 bytes, over the packet up to its length byte.
    let checksum_ok = if kind == Kind::Security {
        None
    } else if pkt.len() >= 4 && pkt[pkt.len() - 4] == 0x01 && pkt[pkt.len() - 3] == 0x02 {
        let want = u16::from_be_bytes([pkt[pkt.len() - 2], pkt[pkt.len() - 1]]);
        Some(checksum(&pkt[..pkt.len() - 2]) == want)
    } else if kind == Kind::Uas {
        Some(false)
    } else {
        None
    };
    Packet { kind, key, offset, length: pkt.len(), checksum_ok, items, error }
}

/// Items up to the first malformed one (for packets with a broken tail).
fn partial_items(b: &[u8], table: &'static [ItemDef]) -> Vec<Item> {
    let mut out = Vec::new();
    let mut p = 0;
    while p < b.len() {
        let Ok((_, nt)) = ber_oid(&b[p..]) else { break };
        let Ok((len, nl)) = ber_length(&b[p + nt..]) else { break };
        let Some(e) = (p + nt + nl).checked_add(len).filter(|&e| e <= b.len()) else { break };
        if let Ok(mut v) = local_set(&b[p..e], table, 0) {
            out.append(&mut v);
        }
        p = e;
    }
    out
}

impl Packet {
    pub fn item(&self, tag: u32) -> Option<&Item> {
        self.items.iter().rev().find(|x| x.tag == tag)
    }
    pub fn num(&self, tag: u32) -> Option<f64> {
        match self.item(tag)?.value {
            Value::Num(v) => Some(v),
            _ => None,
        }
    }
}

pub fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &c in b {
        s.push(H[(c >> 4) as usize] as char);
        s.push(H[(c & 15) as usize] as char);
    }
    s
}

fn items_json(j: &mut Json, items: &[Item]) {
    j.arr();
    for it in items {
        j.obj().kv_int("t", it.tag as i64).kv_str("n", it.name);
        if !it.units.is_empty() {
            j.kv_str("u", it.units);
        }
        if !it.known {
            j.kv_bool("unknown", true);
        }
        j.kv_str("h", &hex(&it.raw[..it.raw.len().min(256)]));
        if it.raw.len() > 256 {
            j.kv_int("hlen", it.raw.len() as i64);
        }
        match &it.value {
            Value::Num(v) => {
                j.kv_num("v", *v);
            }
            Value::Text(s) => {
                j.kv_str("v", s);
            }
            Value::Special(s) => {
                j.key("v").null().kv_str("s", s);
            }
            Value::Empty => {
                j.key("v").null().kv_str("s", "unknown (zero length)");
            }
            Value::Raw => {
                j.key("v").null();
            }
            Value::Set(sub) => {
                j.key("v").null().key("set");
                items_json(j, sub);
            }
            Value::Targets(ts) => {
                j.key("v").null().key("targets").arr();
                for t in ts {
                    j.obj().kv_int("id", t.id as i64);
                    if let Some((la, lo, h)) = t.location {
                        j.key("loc").arr().num(la).num(lo).num(h).end_arr();
                    }
                    j.key("items");
                    items_json(j, &t.items);
                    j.end_obj();
                }
                j.end_arr();
            }
        }
        j.end_obj();
    }
    j.end_arr();
}

/// One packet as JSON (shared by the TS index and standalone KLV files).
pub fn packet_json(j: &mut Json, p: &Packet, base: u64) {
    j.obj().kv_str("kind", match p.kind {
        Kind::Uas => "uas",
        Kind::Security => "security",
        Kind::Vmti => "vmti",
        Kind::Other => "other",
    });
    if p.kind == Kind::Other {
        j.kv_str("key", &hex(&p.key));
    }
    j.kv_num("off", (base + p.offset as u64) as f64).kv_int("len", p.length as i64);
    match p.checksum_ok {
        Some(ok) => j.kv_bool("ok", ok),
        None => j.key("ok").null(),
    };
    if let Some(e) = &p.error {
        j.kv_str("error", e);
    }
    j.key("items");
    items_json(j, &p.items);
    j.end_obj();
}

pub fn to_json(packets: &[Packet]) -> String {
    let mut j = Json::new();
    j.obj().kv_int("count", packets.len() as i64).key("packets").arr();
    for p in packets {
        packet_json(&mut j, p, 0);
    }
    j.end_arr().end_obj();
    j.finish()
}

// ---- encoder (fixtures and round-trip tests) ----

pub fn ber_length_encode(n: usize) -> Vec<u8> {
    if n < 128 {
        return vec![n as u8];
    }
    let b = (n as u64).to_be_bytes();
    let k = b.iter().position(|&c| c != 0).unwrap_or(7);
    let mut out = vec![0x80 | (8 - k) as u8];
    out.extend_from_slice(&b[k..]);
    out
}

pub fn ber_oid_encode(mut t: u32) -> Vec<u8> {
    let mut v = vec![(t & 0x7F) as u8];
    t >>= 7;
    while t > 0 {
        v.push(0x80 | (t & 0x7F) as u8);
        t >>= 7;
    }
    v.reverse();
    v
}

/// A UAS LS packet from (tag, value bytes) items; appends the checksum item.
pub fn encode_uas(items: &[(u32, Vec<u8>)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (t, v) in items {
        body.extend(ber_oid_encode(*t));
        body.extend(ber_length_encode(v.len()));
        body.extend(v);
    }
    body.extend([0x01, 0x02]);
    let mut pkt = UAS_KEY.to_vec();
    pkt.extend(ber_length_encode(body.len() + 2));
    pkt.extend(body);
    let cs = checksum(&pkt);
    pkt.extend(cs.to_be_bytes());
    pkt
}

/// Signed symmetric mapping encoder (n bytes, ±b).
pub fn s_encode(x: f64, b: f64, n: usize) -> Vec<u8> {
    let half = ((1i64 << (8 * n - 1)) - 1) as f64;
    let r = (x / b * half).round() as i64;
    r.to_be_bytes()[8 - n..].to_vec()
}

/// Unsigned mapping encoder (n bytes, [a, b]).
pub fn u_encode(x: f64, a: f64, b: f64, n: usize) -> Vec<u8> {
    let max = ((1u128 << (8 * n)) - 1) as f64;
    let r = ((x - a) / (b - a) * max).round().max(0.0) as u64;
    r.to_be_bytes()[8 - n..].to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ber_forms() {
        assert_eq!(ber_length(&[0x05]).unwrap(), (5, 1));
        assert_eq!(ber_length(&[0x81, 0xC8]).unwrap(), (200, 2));
        assert_eq!(ber_length(&[0x82, 0x01, 0x00]).unwrap(), (256, 3));
        assert!(ber_length(&[0x80]).is_err());
        assert_eq!(ber_oid(&[0x81, 0x01]).unwrap(), (129, 2));
        assert_eq!(ber_oid(&[0x41]).unwrap(), (65, 1));
        for t in [1u32, 65, 127, 128, 143, 16383, 16384, 1_000_000] {
            assert_eq!(ber_oid(&ber_oid_encode(t)).unwrap(), (t, ber_oid_encode(t).len()));
        }
        for n in [0usize, 127, 128, 255, 256, 70_000] {
            assert_eq!(ber_length(&ber_length_encode(n)).unwrap().0, n);
        }
    }

    #[test]
    fn st0601_examples() {
        // ST 0601.8 worked examples: Sensor Latitude 60.176822966978335 = 0x5595B66D;
        // Platform Heading 159.9744 = 0x71C2.
        let lat = decode_value(def_of(UAS_ITEMS, 13).unwrap(), &[0x55, 0x95, 0xB6, 0x6D], 0);
        assert_eq!(lat, Value::Num(0x5595B66Di64 as f64 * 90.0 / 2147483647.0));
        if let Value::Num(v) = lat {
            assert!((v - 60.176822966978335).abs() < 1e-9);
        }
        let hdg = decode_value(def_of(UAS_ITEMS, 5).unwrap(), &[0x71, 0xC2], 0);
        if let Value::Num(v) = hdg {
            assert!((v - 159.97436484321355).abs() < 1e-9);
        } else {
            panic!()
        }
        let oor = decode_value(def_of(UAS_ITEMS, 13).unwrap(), &[0x80, 0, 0, 0], 0);
        assert_eq!(oor, Value::Special("out of range"));
    }

    #[test]
    fn imapb_round_trip() {
        // ST 1201 example: [-900, 19000], 2 bytes, 10000 m → 0x2...; check round trip and range.
        for (a, b, l, x) in [(-900.0, 19000.0, 2, 10000.0), (0.0, 360.0, 4, 123.456), (-1000.0, 1000.0, 3, -12.5), (0.0, 1_500_000.0, 3, 1234.0)] {
            let e = imapb_encode(x, a, b, l);
            let y = imapb(&e, a, b).unwrap();
            let step = 2f64.powi((b - a).log2().ceil() as i32 - (8 * l as i32 - 1));
            assert!((y - x).abs() <= step, "{a} {b} {l} {x} → {y}");
        }
        assert_eq!(imapb(&[0xFF, 0xFF], 0.0, 360.0), None);
    }

    #[test]
    fn packet_round_trip_and_checksum() {
        let items = vec![
            (2u32, 1_761_436_800_000_000u64.to_be_bytes().to_vec()),
            (13, s_encode(-34.51, 90.0, 4)),
            (14, s_encode(-58.61, 180.0, 4)),
            (48, {
                let mut s = vec![0x01, 0x01, 0x01, 0x02, 0x01, 0x07, 0x03, 0x04];
                s.extend(b"//XX");
                s.extend([0x16, 0x02, 0x00, 0x0C]);
                s
            }),
            (65, vec![17]),
            (200, vec![0xAB, 0xCD]),
        ];
        let pkt = encode_uas(&items);
        let ps = decode_packets(&pkt);
        assert_eq!(ps.len(), 1);
        let p = &ps[0];
        assert_eq!(p.kind, Kind::Uas);
        assert_eq!(p.checksum_ok, Some(true));
        assert!((p.num(13).unwrap() + 34.51).abs() < 1e-7);
        assert_eq!(p.num(65), Some(17.0));
        let unk = p.item(200).unwrap();
        assert!(!unk.known);
        assert_eq!(unk.raw, vec![0xAB, 0xCD]);
        let Value::Set(sec) = &p.item(48).unwrap().value else { panic!() };
        assert_eq!(sec[0].value, Value::Num(1.0));
        assert_eq!(sec[2].value, Value::Text("//XX".into()));
        // Corrupt one byte: the checksum fails.
        let mut bad = pkt.clone();
        bad[30] ^= 0x10;
        assert_eq!(decode_packets(&bad)[0].checksum_ok, Some(false));
        // Two packets back to back with garbage between.
        let mut two = pkt.clone();
        two.extend([0u8, 1, 2, 3]);
        two.extend(&pkt);
        assert_eq!(decode_packets(&two).len(), 2);
        let js = to_json(&ps);
        assert!(js.contains("\"unknown\":true"));
    }

    #[test]
    fn vmti_targets() {
        // VTarget: id 7, centroid 1+(100*640+200), location pack.
        let mut tgt = ber_oid_encode(7);
        let cen = (100u64 * 640 + 200 + 1).to_be_bytes()[5..].to_vec();
        tgt.extend([0x01, cen.len() as u8]);
        tgt.extend(&cen);
        let mut loc = imapb_encode(-34.5, -90.0, 90.0, 4);
        loc.extend(imapb_encode(-58.6, -180.0, 180.0, 4));
        loc.extend(imapb_encode(10.0, -900.0, 19000.0, 2));
        tgt.push(17);
        tgt.push(loc.len() as u8);
        tgt.extend(&loc);
        let mut series = ber_length_encode(tgt.len());
        series.extend(&tgt);
        let mut set = vec![0x08, 0x02, 0x02, 0x80, 0x09, 0x02, 0x01, 0x68];
        set.push(101);
        set.extend(ber_length_encode(series.len()));
        set.extend(&series);
        let items = local_set(&set, VMTI_ITEMS, 0).unwrap();
        let Value::Targets(t) = &items[2].value else { panic!("{:?}", items[2]) };
        assert_eq!(t[0].id, 7);
        let (la, lo, h) = t[0].location.unwrap();
        assert!((la + 34.5).abs() < 1e-6 && (lo + 58.6).abs() < 1e-6 && (h - 10.0).abs() < 0.5);
    }
}
