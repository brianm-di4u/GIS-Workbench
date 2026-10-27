//! Deterministic mutation fuzzer (REQ-RUST-07). Seeds come from `Research/samples/`; each
//! target runs a realistic parse path over mutated inputs, catching panics and flagging slow
//! inputs as hangs. Coverage-guided fuzzing (cargo-fuzz) needs a nightly toolchain and is
//! run separately; this harness runs on stable in every CI build.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed.max(1))
    }
    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
}

const INTERESTING: [u8; 8] = [0, 0xFF, 0x7F, 0x80, b'9', b'0', b' ', b'-'];

/// One mutation of `seed`: bit flips, interesting bytes, ASCII digit runs (NITF lengths),
/// chunk insert/delete/duplicate, truncation.
pub fn mutate(rng: &mut Rng, seed: &[u8]) -> Vec<u8> {
    let mut v = seed.to_vec();
    let n = 1 + rng.below(8);
    for _ in 0..n {
        let len = v.len();
        match rng.below(8) {
            0 if len > 0 => {
                let i = rng.below(len);
                v[i] ^= 1 << rng.below(8);
            }
            1 if len > 0 => {
                let i = rng.below(len);
                v[i] = INTERESTING[rng.below(8)];
            }
            2 if len > 0 => {
                // A run of digits, e.g. a huge length field.
                let i = rng.below(len);
                let k = 1 + rng.below(12);
                for b in v.iter_mut().take((i + k).min(len)).skip(i) {
                    *b = if rng.below(3) == 0 { b'9' } else { b'0' + rng.below(10) as u8 };
                }
            }
            3 if len > 1 => {
                let i = rng.below(len);
                let k = 1 + rng.below((len - i).min(4096));
                v.drain(i..(i + k).min(len));
            }
            4 => {
                let i = rng.below(len + 1);
                let k = 1 + rng.below(256);
                let ins: Vec<u8> = (0..k).map(|_| rng.next() as u8).collect();
                v.splice(i..i, ins);
            }
            5 if len > 8 => {
                let a = rng.below(len);
                let k = 1 + rng.below((len - a).min(1024));
                let chunk = v[a..a + k].to_vec();
                let b = rng.below(len);
                v.splice(b..b, chunk);
            }
            6 if len > 0 => v.truncate(rng.below(len)),
            _ if len > 0 => {
                let i = rng.below(len);
                v[i] = rng.next() as u8;
            }
            _ => v.push(rng.next() as u8),
        }
    }
    v
}

pub struct Report {
    pub target: &'static str,
    pub runs: usize,
    pub crashes: Vec<(PathBuf, String)>,
    pub slowest: Duration,
}

/// Run `f` over `iters` inputs (the seeds first, then mutations). Panics and inputs slower
/// than `hang` are written to `out_dir` and reported.
pub fn run(target: &'static str, seeds: &[Vec<u8>], iters: usize, hang: Duration, out_dir: &Path, mut f: impl FnMut(&[u8])) -> Report {
    let mut rng = Rng::new(0x9E37_79B9_7F4A_7C15 ^ (target.len() as u64 * 0x1000_0001));
    let mut rep = Report { target, runs: 0, crashes: Vec::new(), slowest: Duration::ZERO };
    if seeds.is_empty() {
        return rep;
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    for i in 0..iters {
        let seed = &seeds[i % seeds.len()];
        let input = if i < seeds.len() { seed.clone() } else { mutate(&mut rng, seed) };
        let t0 = Instant::now();
        let r = catch_unwind(AssertUnwindSafe(|| f(&input)));
        let dt = t0.elapsed();
        rep.slowest = rep.slowest.max(dt);
        let problem = match r {
            Err(e) => Some(format!("panic: {}", e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())),
            Ok(()) if dt > hang => Some(format!("slow: {dt:?}")),
            _ => None,
        };
        if let Some(msg) = problem {
            std::fs::create_dir_all(out_dir).ok();
            let p = out_dir.join(format!("{target}-{i}.bin"));
            std::fs::write(&p, &input).ok();
            rep.crashes.push((p, msg));
        }
        rep.runs += 1;
    }
    std::panic::set_hook(prev);
    rep
}
