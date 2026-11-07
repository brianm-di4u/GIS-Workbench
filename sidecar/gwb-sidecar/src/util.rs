//! Small helpers: random ids and secrets, hashing, UTC timestamps.

use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

/// `n` random bytes from the OS generator, hex encoded.
pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    getrandom::fill(&mut b).expect("OS random generator");
    hex::encode(b)
}

/// A six-digit pairing code, uniform over 000000–999999.
pub fn pairing_code() -> String {
    loop {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).expect("OS random generator");
        let v = u32::from_le_bytes(b);
        // Rejection sampling keeps the distribution uniform.
        if v < 4_294_000_000 {
            return format!("{:06}", v % 1_000_000);
        }
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// Equality that takes the same time wherever the inputs differ.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for (x, y) in a.iter().zip(b) {
        d |= x ^ y;
    }
    d == 0
}

/// RFC 3339 UTC timestamp, second precision.
pub fn now_rfc3339() -> String {
    rfc3339(SystemTime::now())
}

pub fn rfc3339(t: SystemTime) -> String {
    let s = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (s.div_euclid(86400), s.rem_euclid(86400));
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem / 60) % 60, rem % 60)
}

/// Days since 1970-01-01 → (year, month, day) (H. Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn unix_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn dates() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(UNIX_EPOCH + Duration::from_secs(1_793_534_400)), "2026-11-01T12:00:00Z");
        assert_eq!(rfc3339(UNIX_EPOCH + Duration::from_secs(951_782_400)), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn codes_and_ids() {
        for _ in 0..1000 {
            let c = pairing_code();
            assert_eq!(c.len(), 6);
            assert!(c.bytes().all(|b| b.is_ascii_digit()));
        }
        assert_eq!(random_hex(16).len(), 32);
        assert_ne!(random_hex(16), random_hex(16));
        assert!(ct_eq(b"abc", b"abc") && !ct_eq(b"abc", b"abd") && !ct_eq(b"ab", b"abc"));
    }
}
