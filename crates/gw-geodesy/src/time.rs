//! Time scales and the sun position (REQ-GEO-11).
//! Leap-second table 1972–2017 (TAI − UTC = 37 s since 2017-01-01; no further leap seconds
//! were announced before the end of discontinuous UTC). Sun position: NOAA/Meeus equations.

/// (Unix seconds at which the offset starts, TAI − UTC in seconds).
const LEAPS: [(i64, i32); 28] = [
    (63_072_000, 10),
    (78_796_800, 11),
    (94_694_400, 12),
    (126_230_400, 13),
    (157_766_400, 14),
    (189_302_400, 15),
    (220_924_800, 16),
    (252_460_800, 17),
    (283_996_800, 18),
    (315_532_800, 19),
    (362_793_600, 20),
    (394_329_600, 21),
    (425_865_600, 22),
    (489_024_000, 23),
    (567_993_600, 24),
    (631_152_000, 25),
    (662_688_000, 26),
    (709_948_800, 27),
    (741_484_800, 28),
    (773_020_800, 29),
    (820_454_400, 30),
    (867_715_200, 31),
    (915_148_800, 32),
    (1_136_073_600, 33),
    (1_230_768_000, 34),
    (1_341_100_800, 35),
    (1_435_708_800, 36),
    (1_483_228_800, 37),
];

/// TAI − UTC at a UTC instant (Unix seconds). 0 before 1972.
pub fn tai_minus_utc(unix_utc: i64) -> i32 {
    LEAPS.iter().rev().find(|(t, _)| unix_utc >= *t).map_or(0, |(_, d)| *d)
}

/// GPS epoch 1980-01-06T00:00:00Z as Unix seconds.
pub const GPS_EPOCH_UNIX: i64 = 315_964_800;

/// GPS seconds → Unix UTC seconds (GPS − UTC = TAI − UTC − 19 s).
pub fn gps_to_unix_utc(gps_seconds: f64) -> f64 {
    let approx = GPS_EPOCH_UNIX as f64 + gps_seconds;
    let mut off = (tai_minus_utc(approx as i64) - 19) as f64;
    // Re-evaluate once in case the shift crosses a leap boundary.
    off = (tai_minus_utc((approx - off) as i64) - 19) as f64;
    approx - off
}

/// Civil date from Unix days (proleptic Gregorian).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Unix days from a civil date.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// ISO 8601 UTC text for Unix seconds.
pub fn iso8601(unix: f64) -> String {
    let secs = unix.floor() as i64;
    let frac = unix - secs as f64;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let ms = (frac * 1000.0).round() as i64;
    if ms > 0 {
        format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z", sod / 3600, (sod / 60) % 60, sod % 60)
    } else {
        format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", sod / 3600, (sod / 60) % 60, sod % 60)
    }
}

/// Sun azimuth (° clockwise from true north) and elevation (°, refraction-corrected)
/// at a UTC instant and place, from the NOAA solar calculator (Meeus).
pub fn sun_position(unix_utc: f64, lat: f64, lon: f64) -> (f64, f64) {
    let jd = unix_utc / 86_400.0 + 2_440_587.5;
    let t = (jd - 2_451_545.0) / 36_525.0;
    let l0 = (280.466_46 + t * (36_000.769_83 + t * 0.000_303_2)).rem_euclid(360.0);
    let m = 357.529_11 + t * (35_999.050_29 - 0.000_153_7 * t);
    let e = 0.016_708_634 - t * (0.000_042_037 + 0.000_000_126_7 * t);
    let mr = m.to_radians();
    let c = mr.sin() * (1.914_602 - t * (0.004_817 + 0.000_014 * t)) + (2.0 * mr).sin() * (0.019_993 - 0.000_101 * t) + (3.0 * mr).sin() * 0.000_289;
    let true_long = l0 + c;
    let omega = 125.04 - 1_934.136 * t;
    let app_long = true_long - 0.005_69 - 0.004_78 * omega.to_radians().sin();
    let seconds = 21.448 - t * (46.815 + t * (0.000_59 - t * 0.001_813));
    let eps0 = 23.0 + (26.0 + seconds / 60.0) / 60.0;
    let eps = eps0 + 0.002_56 * omega.to_radians().cos();
    let decl = (eps.to_radians().sin() * app_long.to_radians().sin()).asin();
    let y = (eps.to_radians() / 2.0).tan().powi(2);
    let l0r = l0.to_radians();
    let eq_time = 4.0
        * (y * (2.0 * l0r).sin() - 2.0 * e * mr.sin() + 4.0 * e * y * mr.sin() * (2.0 * l0r).cos()
            - 0.5 * y * y * (4.0 * l0r).sin()
            - 1.25 * e * e * (2.0 * mr).sin())
        .to_degrees();
    let minutes = (unix_utc.rem_euclid(86_400.0)) / 60.0;
    let true_solar = (minutes + eq_time + 4.0 * lon).rem_euclid(1440.0);
    let hour_angle = if true_solar / 4.0 < 0.0 { true_solar / 4.0 + 180.0 } else { true_solar / 4.0 - 180.0 };
    let latr = lat.to_radians();
    let ha = hour_angle.to_radians();
    let cos_zen = (latr.sin() * decl.sin() + latr.cos() * decl.cos() * ha.cos()).clamp(-1.0, 1.0);
    let zen = cos_zen.acos();
    let elev0 = 90.0 - zen.to_degrees();
    let refr = if elev0 > 85.0 {
        0.0
    } else {
        let te = elev0.to_radians().tan();
        let r = if elev0 > 5.0 {
            58.1 / te - 0.07 / te.powi(3) + 0.000_086 / te.powi(5)
        } else if elev0 > -0.575 {
            1735.0 + elev0 * (-518.2 + elev0 * (103.4 + elev0 * (-12.79 + elev0 * 0.711)))
        } else {
            -20.772 / te
        };
        r / 3600.0
    };
    let elev = elev0 + refr;
    let az_denom = latr.cos() * zen.sin();
    let az = if az_denom.abs() > 1e-9 {
        let a = ((latr.sin() * zen.cos()) - decl.sin()) / az_denom;
        let a = a.clamp(-1.0, 1.0).acos().to_degrees();
        if hour_angle > 0.0 {
            (a + 180.0).rem_euclid(360.0)
        } else {
            (540.0 - a).rem_euclid(360.0)
        }
    } else if lat > 0.0 {
        180.0
    } else {
        0.0
    };
    (az, elev)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gps_example() {
        // GPS second 1 400 000 000 is 2024-05-17T16:53:02Z (Research/05 §7).
        assert_eq!(iso8601(gps_to_unix_utc(1_400_000_000.0)), "2024-05-17T16:53:02Z");
        assert_eq!(tai_minus_utc(1_700_000_000), 37);
    }

    #[test]
    fn civil_round_trip() {
        for d in [-1_000_000i64, -1, 0, 1, 19_000, 2_932_896] {
            let (y, m, dd) = civil_from_days(d);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
    }

    #[test]
    fn sun_noon_equinox() {
        // 2024-03-20 ~12:07 UTC at 0°N 0°E: the sun is near the zenith.
        let t = days_from_civil(2024, 3, 20) as f64 * 86_400.0 + 12.0 * 3600.0 + 7.0 * 60.0;
        let (_az, el) = sun_position(t, 0.0, 0.0);
        assert!(el > 88.0, "{el}");
        // Washington DC, 2024-06-21 17:00 UTC (≈ local solar noon): elevation ≈ 74.6°, azimuth ≈ 180°.
        let t2 = days_from_civil(2024, 6, 21) as f64 * 86_400.0 + 17.0 * 3600.0 + 12.0 * 60.0;
        let (az2, el2) = sun_position(t2, 38.8895, -77.0353);
        assert!((el2 - 74.6).abs() < 0.6, "{el2}");
        assert!((az2 - 180.0).abs() < 8.0, "{az2}");
    }
}
