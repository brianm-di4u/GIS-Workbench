//! Same-origin fallback (REQ-SDC-15, S-42): `http://127.0.0.1:<port>/app/` serves the released
//! HTML, but only after its SHA-256 matches the line for it in the release's SHA256SUMS.

use std::path::Path;

pub const FILES: [(&str, &str); 3] = [("", "gis-workbench.html"), ("lite", "gis-workbench-lite.html"), ("airgap", "gis-workbench-airgap.html")];

/// `sha256  name` lines (sha256sum format; `*name` binary marker accepted).
pub fn parse_sums(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let h = it.next()?.to_ascii_lowercase();
            let n = it.next()?.trim_start_matches('*').to_string();
            (h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())).then_some((h, n))
        })
        .collect()
}

/// The verified bytes of one released file, or why it cannot be served.
pub fn load(app_dir: &Path, which: &str) -> Result<Vec<u8>, String> {
    let name = FILES.iter().find(|(k, _)| *k == which).map(|(_, n)| *n).ok_or("no such file")?;
    let sums = std::fs::read_to_string(app_dir.join("SHA256SUMS")).map_err(|_| "the sidecar has no copy of the app (app/SHA256SUMS is missing)".to_string())?;
    let want = parse_sums(&sums).into_iter().find(|(_, n)| n == name).map(|(h, _)| h).ok_or_else(|| format!("SHA256SUMS does not list {name}"))?;
    let bytes = std::fs::read(app_dir.join(name)).map_err(|_| format!("the sidecar has no copy of {name}"))?;
    let got = crate::util::sha256_hex(&bytes);
    if !crate::util::ct_eq(got.as_bytes(), want.as_bytes()) {
        return Err(format!("{name} does not match SHA256SUMS (expected {want}, found {got}); it is not served"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_check() {
        let d = std::env::temp_dir().join(format!("gwb-app-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("gis-workbench.html"), b"<html>ok</html>").unwrap();
        let h = crate::util::sha256_hex(b"<html>ok</html>");
        std::fs::write(d.join("SHA256SUMS"), format!("{h}  gis-workbench.html\n{}  other\n", "0".repeat(64))).unwrap();
        assert_eq!(load(&d, "").unwrap(), b"<html>ok</html>");
        std::fs::write(d.join("gis-workbench.html"), b"<html>tampered</html>").unwrap();
        assert!(load(&d, "").unwrap_err().contains("does not match"));
        assert!(load(&d, "lite").is_err());
        assert!(load(&d, "../x").is_err());
        std::fs::remove_dir_all(&d).ok();
    }
}
