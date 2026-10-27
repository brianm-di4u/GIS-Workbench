//! REQ-FMV-01/02 (parse layer) on FX-10 (`Research/samples/mpegts-klv-synthetic`): the demuxer
//! indexes every frame and every synchronous KLV packet; checksums validate; Items 1, 2 and 65
//! are present; the decoded corners of frame 0 match the truth.

use gw_parse::{klv, ts};
use std::path::Path;

#[test]
fn fx10_index() {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../Research/samples/mpegts-klv-synthetic/fx10_synthetic_klv.ts");
    let Ok(b) = std::fs::read(&p) else {
        eprintln!("FX-10 not present; skipped");
        return;
    };
    let mut d = ts::Demux::new();
    let mut off = 0u64;
    for c in b.chunks(65536 + 17) {
        d.push(c, off).unwrap();
        off += c.len() as u64;
    }
    d.finish();
    assert_eq!(d.aus.len(), 300);
    assert!(d.aus[0].key);
    assert!(d.codec.starts_with("avc1."), "{}", d.codec);
    assert_eq!(d.size, Some((640, 360)));
    assert_eq!(d.klv.len(), 300);
    assert_eq!(d.resyncs, 0);
    let p0 = &d.klv[0].packets[0];
    assert_eq!(p0.kind, klv::Kind::Uas);
    for k in &d.klv {
        assert!(k.sync);
        assert_eq!(k.packets.len(), 1);
        assert_eq!(k.packets[0].checksum_ok, Some(true));
        for t in [1, 2, 65] {
            assert!(k.packets[0].item(t).is_some(), "item {t}");
        }
    }
    // Synchronous KLV carries frame PTS (video PES are in decode order, so match by value).
    let vpts: std::collections::HashSet<_> = d.aus.iter().map(|a| a.pts).collect();
    assert!(d.klv.iter().all(|k| vpts.contains(&k.pts)));
    assert_eq!(p0.num(2), Some(1_761_436_800_000_000.0));
    let truth = [(-34.50629763736962, -58.590207518984926), (-34.513702362630376, -58.590207518984926), (-34.51303845048671, -58.59666949332041), (-34.506961549513285, -58.59666949332041)];
    for (k, (la, lo)) in truth.iter().enumerate() {
        let lat = p0.num(82 + 2 * k as u32).unwrap();
        let lon = p0.num(83 + 2 * k as u32).unwrap();
        // 1 m ≈ 9e-6°.
        assert!((lat - la).abs() < 1e-6 && (lon - lo).abs() < 1e-6, "corner {k}: {lat} {lon}");
    }
    let (data, idx) = ts::extract_pes(&b[..200_000], 0, d.video_pid.unwrap(), false);
    assert!(idx.len() > 3 && data.len() == idx.iter().map(|x| x.2).sum::<usize>());
}

fn index(path: &Path) -> Option<ts::Demux> {
    let b = std::fs::read(path).ok()?;
    let mut d = ts::Demux::new();
    d.push(&b, 0).unwrap();
    d.finish();
    Some(d)
}

#[test]
fn fx10_variants() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx10");
    let Some(b) = index(&dir.join("fx10_b.ts")) else {
        eprintln!("fixtures/fx10 not built; skipped");
        return;
    };
    // Async KLV: no PES PTS, timed by the multiplex.
    assert_eq!(b.klv.len(), 300);
    assert!(b.klv.iter().all(|k| !k.sync && k.pts.is_none() && k.mux_pts.is_some()));
    let bad: Vec<usize> = b.klv.iter().enumerate().filter(|(_, k)| k.packets[0].checksum_ok != Some(true)).map(|(i, _)| i).collect();
    assert_eq!(bad, vec![100, 101]);
    let p = &b.klv[5].packets[0];
    let unk = p.item(150).unwrap();
    assert!(!unk.known && unk.raw == [0xde, 0xad, 0xbe, 0xef]);
    let klv::Value::Set(sec) = &p.item(48).unwrap().value else { panic!("no security set") };
    assert_eq!(sec.iter().find(|i| i.tag == 1).unwrap().value, klv::Value::Num(1.0));
    let klv::Value::Set(vm) = &p.item(74).unwrap().value else { panic!("no VMTI set") };
    let klv::Value::Targets(t) = &vm.iter().find(|i| i.tag == 101).unwrap().value else { panic!("no targets") };
    assert_eq!(t.len(), 2);
    assert!(t[0].location.is_some());
    assert_eq!(p.num(136), Some(37.0));
    assert!(p.item(26).is_some() && p.item(82).is_none());
    let c = index(&dir.join("fx10_c.ts")).unwrap();
    assert!(c.klv.iter().all(|k| k.sync && k.packets[0].checksum_ok == Some(true) && k.packets[0].item(82).is_none() && k.packets[0].item(26).is_none()));
    assert_eq!(c.aus.len(), 300);
}

#[test]
fn fx11_gmti() {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx11/fx11.4607");
    let Ok(b) = std::fs::read(&p) else {
        eprintln!("fixtures/fx11 not built; skipped");
        return;
    };
    let f = gw_parse::s4607::parse(&b).unwrap();
    assert!(f.errors.is_empty(), "{:?}", f.errors);
    assert_eq!(f.packets, 32);
    assert_eq!(f.dwells.len(), 30);
    assert_eq!(f.jobs.len(), 1);
    assert_eq!(f.platform.len(), 30);
    assert_eq!(f.missions[0].date, (2025, 10, 25));
    let d0 = &f.dwells[10];
    assert_eq!(d0.targets.len(), 6);
    // Dwell 10 is the clip start: 23:59:31.000 UTC.
    assert_eq!(d0.time_ms, 86_371_000);
    let t = &d0.targets[0];
    assert!((t.lat - (-34.51 - 0.0012)).abs() < 1e-7, "{}", t.lat);
    assert!(t.vlos.is_some() && t.snr.is_some() && t.class == Some(2));
}
