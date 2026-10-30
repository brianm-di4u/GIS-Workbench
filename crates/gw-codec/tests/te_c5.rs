//! Lossless JPEG (SOF3, NITF IC=C5): a synthetic 12-bit image encoded here with each predictor,
//! a point transform and restart intervals decodes bit-exact; the NTB baseline ns3437a.nsf (TE
//! corpus, when present) decodes both 1024 × 1024 blocks with 12-bit samples in range.

struct BitW {
    acc: u32,
    n: u32,
}

impl BitW {
    fn put(&mut self, out: &mut Vec<u8>, v: u32, k: u32) {
        for b in (0..k).rev() {
            self.acc = (self.acc << 1) | ((v >> b) & 1);
            self.n += 1;
            if self.n == 8 {
                out.push(self.acc as u8);
                if self.acc as u8 == 0xFF {
                    out.push(0);
                }
                self.acc = 0;
                self.n = 0;
            }
        }
    }
    /// Pad with 1-bits to a byte boundary.
    fn flush(&mut self, out: &mut Vec<u8>) {
        if self.n > 0 {
            let pad = 8 - self.n;
            self.put(out, (1 << pad) - 1, pad);
        }
    }
}

/// Minimal lossless encoder (one component, 5-bit canonical codes for categories 0..16).
fn encode(img: &[u16], w: usize, h: usize, prec: u8, sel: u8, pt: u8, restart: usize) -> Vec<u8> {
    let mut out = vec![0xFF, 0xD8];
    out.extend([0xFF, 0xC3, 0, 11, prec, (h >> 8) as u8, h as u8, (w >> 8) as u8, w as u8, 1, 1, 0x11, 0]);
    // DHT: class 0, table 0, 17 codes of length 5 → code k is k in 5 bits.
    let mut dht = vec![0xFF, 0xC4, 0, (2 + 17 + 17) as u8, 0x00];
    let mut bits = [0u8; 16];
    bits[4] = 17;
    dht.extend(bits);
    dht.extend(0..17u8);
    out.extend(dht);
    if restart > 0 {
        out.extend([0xFF, 0xDD, 0, 4, (restart >> 8) as u8, restart as u8]);
    }
    out.extend([0xFF, 0xDA, 0, 8, 1, 1, 0x00, sel, 0, pt]);
    let mut bw = BitW { acc: 0, n: 0 };
    let s: Vec<i32> = img.iter().map(|&v| (v >> pt) as i32).collect();
    let init = 1i32 << (prec - pt - 1);
    let (mut reset, mut first_row, mut rst) = (true, 0usize, 0u8);
    for y in 0..h {
        for x in 0..w {
            let k = y * w + x;
            if restart > 0 && k > 0 && k % restart == 0 {
                // Pad with 1-bits to a byte, then RSTn.
                bw.flush(&mut out);
                out.extend([0xFF, 0xD0 + rst]);
                rst = (rst + 1) & 7;
                reset = true;
                first_row = y;
            }
            let p = if reset {
                reset = false;
                init
            } else if y == first_row {
                if x > 0 { s[k - 1] } else { s[k - w] }
            } else if x == 0 {
                s[k - w]
            } else {
                let (ra, rb, rc) = (s[k - 1], s[k - w], s[k - w - 1]);
                match sel {
                    1 => ra,
                    2 => rb,
                    3 => rc,
                    4 => ra + rb - rc,
                    5 => ra + ((rb - rc) >> 1),
                    6 => rb + ((ra - rc) >> 1),
                    _ => (ra + rb) >> 1,
                }
            };
            let d = (s[k] - p) as i16 as i32; // modulo 2^16
            let cat = if d == 0 { 0 } else { 32 - (d.unsigned_abs()).leading_zeros() };
            bw.put(&mut out, cat, 5);
            if cat > 0 && cat < 16 {
                let v = if d < 0 { (d - 1) as u32 & ((1 << cat) - 1) } else { d as u32 };
                bw.put(&mut out, v, cat);
            }
        }
    }
    bw.flush(&mut out);
    out.extend([0xFF, 0xD9]);
    out
}

fn image(w: usize, h: usize, prec: u8) -> Vec<u16> {
    let max = (1u32 << prec) - 1;
    (0..w * h).map(|i| {
        let (x, y) = (i % w, i / w);
        let v = (x * 37 + y * 11 + (x * y) % 97 + if (x / 5 + y / 3) % 2 == 0 { 900 } else { 0 }) as u32;
        (v % (max + 1)) as u16
    }).collect()
}

#[test]
fn every_predictor_round_trips() {
    let (w, h) = (61, 23);
    let img = image(w, h, 12);
    for sel in 1..=7u8 {
        for restart in [0usize, 61, 100] {
            let j = encode(&img, w, h, 12, sel, 0, restart);
            let r = gw_codec::jpeg::decode(&j, 0, 1).unwrap_or_else(|e| panic!("sel {sel} restart {restart}: {e:?}"));
            assert_eq!((r.width, r.height, r.comps, r.bits), (w as u32, h as u32, 1, 12));
            assert_eq!(r.data, img, "sel {sel} restart {restart}");
        }
    }
}

#[test]
fn point_transform_and_16_bit() {
    let (w, h) = (17, 9);
    let img: Vec<u16> = image(w, h, 12).iter().map(|v| v & !3).collect();
    let r = gw_codec::jpeg::decode(&encode(&img, w, h, 12, 4, 2, 0), 0, 1).unwrap();
    assert_eq!(r.data, img);
    let img16: Vec<u16> = (0..w * h).map(|i| (i as u32 * 4099 % 65536) as u16).collect();
    let r = gw_codec::jpeg::decode(&encode(&img16, w, h, 16, 1, 0, 0), 0, 1).unwrap();
    assert_eq!(r.data, img16);
}

#[test]
fn ntb_ns3437a_decodes() {
    let p = std::path::Path::new("C:/GIS Workbench/TE-corpus/nitf-ntb-ns3437a-c5-lossless/ns3437a.nsf");
    let Ok(f) = std::fs::read(p) else { return };
    let starts: Vec<usize> = (0..f.len() - 1).filter(|&i| f[i] == 0xFF && f[i + 1] == 0xD8).collect();
    assert_eq!(starts.len(), 2);
    for (k, &s) in starts.iter().enumerate() {
        let end = starts.get(k + 1).copied().unwrap_or(f.len());
        let r = gw_codec::jpeg::decode(&f[s..end], 0, 1).expect("C5 block decodes");
        assert_eq!((r.width, r.height, r.bits), (1024, 1024, 12));
        assert!(r.data.iter().all(|&v| v < 4096));
        let mean = r.data.iter().map(|&v| v as f64).sum::<f64>() / r.data.len() as f64;
        assert!(mean > 10.0 && mean < 4000.0, "mean {mean}");
        if let Ok(dir) = std::env::var("GW_DUMP") {
            let b: Vec<u8> = r.data.iter().flat_map(|v| v.to_le_bytes()).collect();
            std::fs::write(format!("{dir}/ns3437a_block{k}.u16"), b).unwrap();
        }
    }
}
