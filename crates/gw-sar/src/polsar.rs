//! Polarimetric decomposition (REQ-GAP-40, GR-14): covariance and coherency matrices from quad-pol
//! complex data or from multi-looked covariance products, boxcar and refined Lee (Lee, Grunes and
//! De Grandi 1999) filtering, the Freeman–Durden three-component and Yamaguchi four-component
//! scattering powers (2005, with the optional de-orientation of Yamaguchi et al. 2011), the
//! Cloude–Pottier H/A/α eigen-decomposition, the H/α (and H/A/α) Wishart classification of Lee et
//! al. (1999), and the dual-pol and compact-pol (CTLR) H/α of Cloude (2007).
//!
//! Matrices are stored planar as `f32`, one plane per element:
//! * 3 × 3 (T3 or C3): `[M11, M22, M33, M12re, M12im, M13re, M13im, M23re, M23im]`;
//! * 2 × 2 (C2): `[M11, M22, M12re, M12im]`.
//!
//! Scattering vectors: Pauli `k = [HH + VV, HH − VV, 2·HV] / √2` (T3) and lexicographic
//! `k = [HH, √2·HV, VV]` (C3). With VH present, HV is the reciprocal mean (HV + VH) / 2.

use crate::fft::Cx;

pub const T3_PLANES: [&str; 9] = ["T11", "T22", "T33", "T12_real", "T12_imag", "T13_real", "T13_imag", "T23_real", "T23_imag"];
pub const C3_PLANES: [&str; 9] = ["C11", "C22", "C33", "C12_real", "C12_imag", "C13_real", "C13_imag", "C23_real", "C23_imag"];
pub const C2_PLANES: [&str; 4] = ["C11", "C22", "C12_real", "C12_imag"];

/// A planar stack of `k` matrix-element planes, `w × h` each.
#[derive(Clone, Debug)]
pub struct Planes {
    pub w: usize,
    pub h: usize,
    pub k: usize,
    pub d: Vec<f32>,
}

impl Planes {
    pub fn new(w: usize, h: usize, k: usize) -> Planes {
        Planes { w, h, k, d: vec![0f32; w * h * k] }
    }
    pub fn n(&self) -> usize {
        self.w * self.h
    }
    pub fn plane(&self, c: usize) -> &[f32] {
        let n = self.n();
        &self.d[c * n..(c + 1) * n]
    }
    #[inline]
    pub fn at(&self, c: usize, i: usize) -> f64 {
        self.d[c * self.n() + i] as f64
    }
    /// The 9 elements of pixel `i` (3 × 3 stacks).
    #[inline]
    pub fn m9(&self, i: usize) -> [f64; 9] {
        let n = self.n();
        let mut m = [0.0; 9];
        for (c, v) in m.iter_mut().enumerate() {
            *v = self.d[c * n + i] as f64;
        }
        m
    }
    #[inline]
    fn set9(&mut self, i: usize, m: &[f64; 9]) {
        let n = self.n();
        for (c, v) in m.iter().enumerate() {
            self.d[c * n + i] = *v as f32;
        }
    }
    /// Trace (span) of each pixel's matrix (the first 3 planes of a 3 × 3 stack, 2 of a 2 × 2).
    pub fn span(&self) -> Vec<f32> {
        let n = self.n();
        let diag = if self.k == 9 { 3 } else { 2 };
        (0..n).map(|i| (0..diag).map(|c| self.d[c * n + i]).sum()).collect()
    }
}

const R2: f64 = std::f64::consts::SQRT_2;

fn outer3(k: [Cx; 3]) -> [f64; 9] {
    let p = |a: Cx, b: Cx| a.mul(b.conj());
    let m12 = p(k[0], k[1]);
    let m13 = p(k[0], k[2]);
    let m23 = p(k[1], k[2]);
    [k[0].norm2(), k[1].norm2(), k[2].norm2(), m12.re, m12.im, m13.re, m13.im, m23.re, m23.im]
}

/// Single-look T3 (`pauli` true) or C3 from HH, HV, VV (and VH when given) complex samples.
pub fn from_quad(hh: &[Cx], hv: &[Cx], vh: Option<&[Cx]>, vv: &[Cx], w: usize, h: usize, pauli: bool) -> Planes {
    let n = w * h;
    let mut o = Planes::new(w, h, 9);
    for i in 0..n {
        let x = match vh {
            Some(vh) => hv[i].add(vh[i]).scale(0.5),
            None => hv[i],
        };
        let k = if pauli {
            [hh[i].add(vv[i]).scale(1.0 / R2), hh[i].sub(vv[i]).scale(1.0 / R2), x.scale(R2)]
        } else {
            [hh[i], x.scale(R2), vv[i]]
        };
        let m = outer3(k);
        if m.iter().all(|v| v.is_finite()) {
            o.set9(i, &m);
        } else {
            o.set9(i, &[f64::NAN; 9]);
        }
    }
    o
}

/// Single-look C2 from two co-registered complex channels (dual-pol: co-pol first).
pub fn from_dual(a: &[Cx], b: &[Cx], w: usize, h: usize) -> Planes {
    let n = w * h;
    let mut o = Planes::new(w, h, 4);
    for i in 0..n {
        let m = a[i].mul(b[i].conj());
        let v = [a[i].norm2(), b[i].norm2(), m.re, m.im];
        for (c, x) in v.iter().enumerate() {
            o.d[c * n + i] = if v.iter().all(|q| q.is_finite()) { *x as f32 } else { f32::NAN };
        }
    }
    o
}

/// Compact-pol channels simulated from quad-pol data: right-circular transmit, linear H and V
/// receive (CTLR, Raney 2007), transmit vector (1, −i)/√2: `E_H = (HH − i·HV)/√2`,
/// `E_V = (HV − i·VV)/√2` (reciprocal HV).
pub fn ctlr(hh: &[Cx], hv: &[Cx], vh: Option<&[Cx]>, vv: &[Cx]) -> (Vec<Cx>, Vec<Cx>) {
    let mi = Cx::new(0.0, -1.0);
    let n = hh.len();
    let mut eh = Vec::with_capacity(n);
    let mut ev = Vec::with_capacity(n);
    for i in 0..n {
        let x = match vh {
            Some(vh) => hv[i].add(vh[i]).scale(0.5),
            None => hv[i],
        };
        eh.push(hh[i].add(mi.mul(x)).scale(1.0 / R2));
        ev.push(x.add(mi.mul(vv[i])).scale(1.0 / R2));
    }
    (eh, ev)
}

/// T3 ↔ C3 of one pixel. `T = N·C·Nᴴ` with `N = [[1,0,1],[1,0,−1],[0,√2,0]]/√2`; the map is its
/// own inverse up to the transpose, so `to_t` false applies `C = Nᴴ·T·N`.
pub fn convert3(m: &[f64; 9], to_t: bool) -> [f64; 9] {
    let a = h3(m);
    let s = 1.0 / R2;
    let nn = [[Cx::new(s, 0.0), Cx::ZERO, Cx::new(s, 0.0)], [Cx::new(s, 0.0), Cx::ZERO, Cx::new(-s, 0.0)], [Cx::ZERO, Cx::new(1.0, 0.0), Cx::ZERO]];
    let r = if to_t { mul3(&mul3(&nn, &a), &adj3(&nn)) } else { mul3(&mul3(&adj3(&nn), &a), &nn) };
    pack3(&r)
}

/// Convert a whole 3 × 3 stack (C3 → T3 with `to_t`, T3 → C3 otherwise).
pub fn convert_planes(p: &Planes, to_t: bool) -> Planes {
    let mut o = Planes::new(p.w, p.h, 9);
    for i in 0..p.n() {
        let m = p.m9(i);
        o.set9(i, &if m.iter().all(|v| v.is_finite()) { convert3(&m, to_t) } else { [f64::NAN; 9] });
    }
    o
}

// ---- filtering ----

/// Boxcar mean of every plane over a `win × win` window (truncated at the image edges; samples
/// whose span is not finite are left out).
pub fn boxcar(p: &Planes, win: usize) -> Planes {
    let (w, h, n) = (p.w, p.h, p.n());
    let r = (win.max(1) / 2) as isize;
    let span = p.span();
    let ok: Vec<f64> = span.iter().map(|v| if v.is_finite() { 1.0 } else { 0.0 }).collect();
    let sat = |v: &dyn Fn(usize) -> f64| -> Vec<f64> {
        let mut s = vec![0f64; (w + 1) * (h + 1)];
        for y in 0..h {
            let mut row = 0.0;
            for x in 0..w {
                row += v(y * w + x);
                s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
            }
        }
        s
    };
    let cnt = sat(&|i| ok[i]);
    let mut o = Planes::new(w, h, p.k);
    for c in 0..p.k {
        let pl = p.plane(c);
        let s = sat(&|i| if ok[i] > 0.0 { pl[i] as f64 } else { 0.0 });
        for y in 0..h as isize {
            let (y0, y1) = ((y - r).max(0) as usize, ((y + r).min(h as isize - 1) + 1) as usize);
            for x in 0..w as isize {
                let (x0, x1) = ((x - r).max(0) as usize, ((x + r).min(w as isize - 1) + 1) as usize);
                let box_sum = |t: &[f64]| t[y1 * (w + 1) + x1] - t[y0 * (w + 1) + x1] - t[y1 * (w + 1) + x0] + t[y0 * (w + 1) + x0];
                let k = box_sum(&cnt);
                let i = y as usize * w + x as usize;
                o.d[c * n + i] = if k > 0.5 && ok[i] > 0.0 { (box_sum(&s) / k) as f32 } else { f32::NAN };
            }
        }
    }
    o
}

/// Refined Lee polarimetric filter (Lee, Grunes and De Grandi 1999): on the span, a 7 × 7 window
/// of 3 × 3 block means gives four directional gradients; the strongest picks one of eight
/// half-window masks (the half whose mean is nearer the centre block); the Lee weight
/// `b = var(x)/var(y)` with `var(x) = (var(y) − ȳ²σᵥ²)/(1 + σᵥ²)`, `σᵥ² = 1/looks`, comes from the
/// span inside that mask, and every element is filtered with the same mask and weight:
/// `M̂ = M̄ + b·(M − M̄)`. Edges replicate the border pixel.
pub fn refined_lee(p: &Planes, looks: f64) -> Planes {
    let (w, h, n) = (p.w, p.h, p.n());
    let cu2 = 1.0 / looks.max(0.1);
    let span = p.span();
    let cl = |x: isize, y: isize| -> usize { y.clamp(0, h as isize - 1) as usize * w + x.clamp(0, w as isize - 1) as usize };
    let sp = |x: isize, y: isize| -> f64 { span[cl(x, y)] as f64 };
    let in_mask = |d: usize, dx: isize, dy: isize| -> bool {
        match d {
            0 => dy <= 0,
            1 => dy >= 0,
            2 => dx <= 0,
            3 => dx >= 0,
            4 => dx + dy <= 0,
            5 => dx + dy >= 0,
            6 => dx - dy <= 0,
            _ => dx - dy >= 0,
        }
    };
    let mut o = Planes::new(w, h, p.k);
    o.d.iter_mut().for_each(|v| *v = f32::NAN);
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let z = span[i];
            if !z.is_finite() {
                continue;
            }
            let (xi, yi) = (x as isize, y as isize);
            let mut bm = [[0f64; 3]; 3];
            for (by, row) in bm.iter_mut().enumerate() {
                for (bx, v) in row.iter_mut().enumerate() {
                    let (cx, cy) = (xi + 2 * (bx as isize - 1), yi + 2 * (by as isize - 1));
                    let (mut s, mut c) = (0.0, 0.0);
                    for dy in -1..=1 {
                        for dx in -1..=1 {
                            let a = sp(cx + dx, cy + dy);
                            if a.is_finite() {
                                s += a;
                                c += 1.0;
                            }
                        }
                    }
                    *v = if c > 0.0 { s / c } else { z as f64 };
                }
            }
            let gh = (bm[0][0] + bm[0][1] + bm[0][2]) - (bm[2][0] + bm[2][1] + bm[2][2]);
            let gv = (bm[0][0] + bm[1][0] + bm[2][0]) - (bm[0][2] + bm[1][2] + bm[2][2]);
            let gd = (bm[0][1] + bm[0][0] + bm[1][0]) - (bm[1][2] + bm[2][2] + bm[2][1]);
            let ga = (bm[0][1] + bm[0][2] + bm[1][2]) - (bm[1][0] + bm[2][0] + bm[2][1]);
            let g = [gh.abs(), gv.abs(), gd.abs(), ga.abs()];
            // First maximum wins (ties keep the lower direction index).
            let mut kk = 0;
            for q in 1..4 {
                if g[q] > g[kk] {
                    kk = q;
                }
            }
            let (pa, pb) = [(0usize, 1usize), (2, 3), (4, 5), (6, 7)][kk];
            let c = bm[1][1];
            let half = |d: usize| -> f64 {
                match d {
                    0 => (bm[0][0] + bm[0][1] + bm[0][2]) / 3.0,
                    1 => (bm[2][0] + bm[2][1] + bm[2][2]) / 3.0,
                    2 => (bm[0][0] + bm[1][0] + bm[2][0]) / 3.0,
                    3 => (bm[0][2] + bm[1][2] + bm[2][2]) / 3.0,
                    4 => (bm[0][1] + bm[0][0] + bm[1][0]) / 3.0,
                    5 => (bm[1][2] + bm[2][2] + bm[2][1]) / 3.0,
                    6 => (bm[1][0] + bm[2][0] + bm[2][1]) / 3.0,
                    _ => (bm[0][1] + bm[0][2] + bm[1][2]) / 3.0,
                }
            };
            let d = if (half(pa) - c).abs() <= (half(pb) - c).abs() { pa } else { pb };
            let (mut s1, mut s2, mut cnt) = (0.0, 0.0, 0.0);
            let mut means = [0f64; 9];
            for dy in -3..=3isize {
                for dx in -3..=3isize {
                    if !in_mask(d, dx, dy) {
                        continue;
                    }
                    let j = cl(xi + dx, yi + dy);
                    let a = span[j] as f64;
                    if !a.is_finite() {
                        continue;
                    }
                    s1 += a;
                    s2 += a * a;
                    cnt += 1.0;
                    for (ch, m) in means.iter_mut().enumerate().take(p.k) {
                        *m += p.d[ch * n + j] as f64;
                    }
                }
            }
            let m = s1 / cnt;
            let var_y = (s2 / cnt - m * m).max(0.0);
            let var_x = ((var_y - m * m * cu2) / (1.0 + cu2)).max(0.0);
            let b = if var_y > 0.0 { var_x / var_y } else { 0.0 };
            for (ch, mean) in means.iter().enumerate().take(p.k) {
                let mean = mean / cnt;
                o.d[ch * n + i] = (mean + b * (p.d[ch * n + i] as f64 - mean)) as f32;
            }
        }
    }
    o
}

// ---- 3 × 3 Hermitian algebra ----

type M3 = [[Cx; 3]; 3];

pub fn h3(m: &[f64; 9]) -> M3 {
    let c = |re: f64, im: f64| Cx::new(re, im);
    [[c(m[0], 0.0), c(m[3], m[4]), c(m[5], m[6])], [c(m[3], -m[4]), c(m[1], 0.0), c(m[7], m[8])], [c(m[5], -m[6]), c(m[7], -m[8]), c(m[2], 0.0)]]
}

fn pack3(a: &M3) -> [f64; 9] {
    [a[0][0].re, a[1][1].re, a[2][2].re, a[0][1].re, a[0][1].im, a[0][2].re, a[0][2].im, a[1][2].re, a[1][2].im]
}

fn mul3(a: &M3, b: &M3) -> M3 {
    let mut o = [[Cx::ZERO; 3]; 3];
    for (i, row) in o.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = a[i][0].mul(b[0][j]).add(a[i][1].mul(b[1][j])).add(a[i][2].mul(b[2][j]));
        }
    }
    o
}

fn adj3(a: &M3) -> M3 {
    let mut o = [[Cx::ZERO; 3]; 3];
    for (i, row) in o.iter_mut().enumerate() {
        for (j, v) in row.iter_mut().enumerate() {
            *v = a[j][i].conj();
        }
    }
    o
}

/// Eigenvalues (descending) and unit eigenvectors (columns `v[row][col]`) of a Hermitian 3 × 3
/// matrix by cyclic complex Jacobi rotations.
pub fn eig3(m: &[f64; 9]) -> ([f64; 3], M3) {
    let mut a = h3(m);
    let mut v = [[Cx::ZERO; 3]; 3];
    for (i, row) in v.iter_mut().enumerate() {
        row[i] = Cx::new(1.0, 0.0);
    }
    let scale = (m[0].abs() + m[1].abs() + m[2].abs()).max(1e-300);
    for _ in 0..40 {
        let off = a[0][1].norm2() + a[0][2].norm2() + a[1][2].norm2();
        if off <= 1e-30 * scale * scale {
            break;
        }
        for (p, q) in [(0usize, 1usize), (0, 2), (1, 2)] {
            let apq = a[p][q];
            let r = apq.abs();
            if r <= 1e-300 {
                continue;
            }
            let e = Cx::cis(-apq.arg());
            let th = 0.5 * (2.0 * r).atan2(a[p][p].re - a[q][q].re);
            let (c, s) = (th.cos(), th.sin());
            let mut u = [[Cx::ZERO; 3]; 3];
            for (i, row) in u.iter_mut().enumerate() {
                row[i] = Cx::new(1.0, 0.0);
            }
            u[p][p] = Cx::new(c, 0.0);
            u[p][q] = Cx::new(-s, 0.0);
            u[q][p] = e.scale(s);
            u[q][q] = e.scale(c);
            a = mul3(&mul3(&adj3(&u), &a), &u);
            a[p][q] = Cx::ZERO;
            a[q][p] = Cx::ZERO;
            v = mul3(&v, &u);
        }
    }
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&i, &j| a[j][j].re.partial_cmp(&a[i][i].re).unwrap_or(std::cmp::Ordering::Equal));
    let mut l = [0.0; 3];
    let mut vs = [[Cx::ZERO; 3]; 3];
    for (k, &i) in idx.iter().enumerate() {
        l[k] = a[i][i].re;
        for r in 0..3 {
            vs[r][k] = v[r][i];
        }
    }
    (l, vs)
}

fn det3(a: &M3) -> Cx {
    let t1 = a[1][1].mul(a[2][2]).sub(a[1][2].mul(a[2][1]));
    let t2 = a[1][0].mul(a[2][2]).sub(a[1][2].mul(a[2][0]));
    let t3 = a[1][0].mul(a[2][1]).sub(a[1][1].mul(a[2][0]));
    a[0][0].mul(t1).sub(a[0][1].mul(t2)).add(a[0][2].mul(t3))
}

/// Inverse of a 3 × 3 matrix (adjugate over determinant) and the determinant; None when singular.
fn inv3(a: &M3) -> Option<(M3, f64)> {
    let d = det3(a);
    if !(d.re.is_finite()) || d.abs() <= 1e-300 {
        return None;
    }
    let inv_d = Cx::new(d.re, -d.im).scale(1.0 / d.norm2());
    let cof = |r0: usize, r1: usize, c0: usize, c1: usize| a[r0][c0].mul(a[r1][c1]).sub(a[r0][c1].mul(a[r1][c0]));
    let mut o = [[Cx::ZERO; 3]; 3];
    // o[j][i] = cofactor(i, j) / det.
    let rows = [(1, 2), (0, 2), (0, 1)];
    for i in 0..3 {
        for j in 0..3 {
            let (r0, r1) = rows[i];
            let (c0, c1) = rows[j];
            let mut c = cof(r0, r1, c0, c1);
            if (i + j) % 2 == 1 {
                c = c.scale(-1.0);
            }
            o[j][i] = c.mul(inv_d);
        }
    }
    Some((o, d.re))
}

// ---- decompositions ----

/// Freeman–Durden three-component powers (Ps, Pd, Pv) of one C3 (Freeman and Durden 1998).
/// Volume: `fv = 3/2·C22`, `Pv = 8/3·fv`; the remainder's `Re⟨HH·VV*⟩` sign picks surface
/// (α = −1) or double-bounce (β = 1) dominance; `|⟨HH·VV*⟩|²` is capped at `⟨|HH|²⟩⟨|VV|²⟩`.
/// When the volume takes more than `⟨|HH|²⟩` or `⟨|VV|²⟩`, all the span is volume. Each power is
/// clamped to [0, span].
pub fn freeman(c: &[f64; 9]) -> [f64; 3] {
    let span = c[0] + c[1] + c[2];
    let fv = 1.5 * c[1];
    let a = c[0] - fv;
    let b = c[2] - fv;
    let (mut cr, mut ci) = (c[5] - fv / 3.0, c[6]);
    let pv = 8.0 * fv / 3.0;
    if a <= 0.0 || b <= 0.0 {
        return [0.0, 0.0, span.max(0.0)];
    }
    let rho2 = cr * cr + ci * ci;
    if rho2 > a * b {
        let k = (a * b / rho2).sqrt();
        cr *= k;
        ci *= k;
    }
    let rho2 = cr * cr + ci * ci;
    let (ps, pd) = if cr >= 0.0 {
        let fd = (a * b - rho2) / (a + b + 2.0 * cr);
        let fs = b - fd;
        (fs + ((cr + fd).powi(2) + ci * ci) / fs, 2.0 * fd)
    } else {
        let fs = (a * b - rho2) / (a + b - 2.0 * cr);
        let fd = b - fs;
        (2.0 * fs, fd + ((cr - fs).powi(2) + ci * ci) / fd)
    };
    let cl = |v: f64| v.clamp(0.0, span.max(0.0));
    [cl(ps), cl(pd), cl(pv)]
}

/// De-orientation of a T3 (Yamaguchi et al. 2011): the rotation about the line of sight by
/// `φ = ½·atan2(2·Re T23, T22 − T33)` that minimises T33 (and zeroes Re T23).
pub fn deorient(t: &[f64; 9]) -> [f64; 9] {
    let phi = 0.5 * (2.0 * t[7]).atan2(t[1] - t[2]);
    let (c, s) = (phi.cos(), phi.sin());
    let r = [[Cx::new(1.0, 0.0), Cx::ZERO, Cx::ZERO], [Cx::ZERO, Cx::new(c, 0.0), Cx::new(s, 0.0)], [Cx::ZERO, Cx::new(-s, 0.0), Cx::new(c, 0.0)]];
    pack3(&mul3(&mul3(&r, &h3(t)), &adj3(&r)))
}

/// Yamaguchi four-component powers (Ps, Pd, Pv, Pc) of one T3 (Yamaguchi et al. 2005, in the T3
/// form of Yamaguchi et al. 2011): helix `Pc = 2|Im T23|`; the volume model by
/// `10·log10(⟨|VV|²⟩/⟨|HH|²⟩)` (≤ −2 dB and ≥ +2 dB: cos² dipole distributions with
/// `Pv = 15/4·(T33 − Pc/2)`; otherwise uniform with `Pv = 4·(T33 − Pc/2)`); surface or
/// double-bounce dominance by the sign of `C0 = T11 − T22 − T33 + Pc`. Power constraints: a
/// negative volume drops the helix and then floors at 0; `Pv + Pc > span` leaves no surface or
/// double bounce; a negative Ps or Pd is set to 0 and the other takes the rest. With `rotate`,
/// the T3 is de-oriented first (Y4R).
pub fn yamaguchi(t0: &[f64; 9], rotate: bool) -> [f64; 4] {
    let t = if rotate { deorient(t0) } else { *t0 };
    let tp = t[0] + t[1] + t[2];
    let mut pc = 2.0 * t[8].abs();
    let hh = 0.5 * (t[0] + t[1] + 2.0 * t[3]);
    let vv = 0.5 * (t[0] + t[1] - 2.0 * t[3]);
    let ratio = if hh > 0.0 && vv > 0.0 { 10.0 * (vv / hh).log10() } else { 0.0 };
    let (kv, t12v, t22v) = if ratio <= -2.0 {
        (15.0 / 4.0, 1.0 / 6.0, 7.0 / 30.0)
    } else if ratio >= 2.0 {
        (15.0 / 4.0, -1.0 / 6.0, 7.0 / 30.0)
    } else {
        (4.0, 0.0, 0.25)
    };
    let mut pv = kv * (t[2] - pc / 2.0);
    if pv < 0.0 {
        pc = 0.0;
        pv = (kv * t[2]).max(0.0);
    }
    if pv + pc > tp {
        return [0.0, 0.0, (tp - pc).max(0.0), pc];
    }
    let s = t[0] - pv / 2.0;
    let d = t[1] - t22v * pv - pc / 2.0;
    let c2 = (t[3] - t12v * pv).powi(2) + t[4] * t[4];
    let c0 = t[0] - t[1] - t[2] + pc;
    let rest = tp - pv - pc;
    let (mut ps, mut pd) = if c0 > 0.0 {
        if s > 1e-30 {
            (s + c2 / s, d - c2 / s)
        } else {
            (0.0, rest)
        }
    } else if d > 1e-30 {
        (s - c2 / d, d + c2 / d)
    } else {
        (rest, 0.0)
    };
    if ps > 0.0 && pd < 0.0 {
        pd = 0.0;
        ps = rest;
    } else if pd > 0.0 && ps < 0.0 {
        ps = 0.0;
        pd = rest;
    } else if ps < 0.0 && pd < 0.0 {
        ps = 0.0;
        pd = 0.0;
        pv = tp - pc;
    }
    [ps.max(0.0), pd.max(0.0), pv.max(0.0), pc]
}

/// Cloude–Pottier entropy H (log base 3), anisotropy A, mean α (degrees) and the eigenvalues of a
/// T3. `α_i = acos|u_1i|`, `α = Σ p_i·α_i`, `A = (λ2 − λ3)/(λ2 + λ3)`.
pub fn h_a_alpha(t: &[f64; 9]) -> [f64; 6] {
    let (l, v) = eig3(t);
    let l = [l[0].max(0.0), l[1].max(0.0), l[2].max(0.0)];
    let sum = l[0] + l[1] + l[2];
    if !(sum > 0.0) {
        return [f64::NAN; 6];
    }
    let mut hh = 0.0;
    let mut al = 0.0;
    for k in 0..3 {
        let p = l[k] / sum;
        if p > 0.0 {
            hh -= p * p.ln() / 3f64.ln();
        }
        al += p * v[0][k].abs().min(1.0).acos();
    }
    let a = if l[1] + l[2] > 0.0 { (l[1] - l[2]) / (l[1] + l[2]) } else { 0.0 };
    [hh.clamp(0.0, 1.0), a, al.to_degrees(), l[0], l[1], l[2]]
}

/// Dual-pol (or compact-pol) H/A/α of one C2 (Cloude 2007): eigenvalues in closed form, entropy
/// with log base 2, `α_i = acos|u_1i|` (the first channel), `A = (λ1 − λ2)/(λ1 + λ2)`.
pub fn h_alpha2(c: &[f64; 4]) -> [f64; 5] {
    let (a, d) = (c[0], c[1]);
    let b2 = c[2] * c[2] + c[3] * c[3];
    let m = 0.5 * (a + d);
    let q = (0.25 * (a - d) * (a - d) + b2).sqrt();
    let (l1, l2) = ((m + q).max(0.0), (m - q).max(0.0));
    let sum = l1 + l2;
    if !(sum > 0.0) {
        return [f64::NAN; 5];
    }
    // |u_11| of λ1's eigenvector [b, λ1 − a] (or an axis when b = 0); λ2's is orthogonal.
    let u1 = if b2 > 1e-300 * (a * a + d * d).max(1e-300) {
        (b2 / (b2 + (l1 - a).powi(2))).sqrt()
    } else if a >= d {
        1.0
    } else {
        0.0
    };
    let u2 = (1.0 - u1 * u1).max(0.0).sqrt();
    let (p1, p2) = (l1 / sum, l2 / sum);
    let ent = |p: f64| if p > 0.0 { -p * p.log2() } else { 0.0 };
    let hh = (ent(p1) + ent(p2)).clamp(0.0, 1.0);
    let al = p1 * u1.min(1.0).acos() + p2 * u2.min(1.0).acos();
    [hh, (l1 - l2) / sum, al.to_degrees(), l1, l2]
}

/// The H/α plane zone (Cloude and Pottier 1997) as 1–9: 1 high-entropy multiple, 2 high-entropy
/// vegetation, 3 high-entropy surface (not feasible), 4 medium-entropy multiple (dihedral),
/// 5 medium-entropy vegetation, 6 medium-entropy surface, 7 low-entropy multiple, 8 low-entropy
/// dipole, 9 low-entropy surface. H bounds 0.5 and 0.9.
pub fn zone(hh: f64, al: f64) -> u8 {
    if hh >= 0.9 {
        if al >= 55.0 {
            1
        } else if al >= 40.0 {
            2
        } else {
            3
        }
    } else if hh >= 0.5 {
        if al >= 50.0 {
            4
        } else if al >= 40.0 {
            5
        } else {
            6
        }
    } else if al >= 47.5 {
        7
    } else if al >= 42.5 {
        8
    } else {
        9
    }
}

/// One Wishart class: its label, the pixels in it and its centre (mean T3).
#[derive(Clone, Debug)]
pub struct WClass {
    pub label: u8,
    pub count: usize,
    pub centre: [f64; 9],
}

#[derive(Clone, Debug)]
pub struct Wishart {
    /// Class label per pixel (0 = no data).
    pub labels: Vec<u8>,
    pub classes: Vec<WClass>,
    pub iterations: usize,
    /// Fraction of pixels that changed class in the last iteration.
    pub changed: f64,
}

/// Unsupervised Wishart classification of a T3 stack (Lee et al. 1999): initial classes from the
/// H/α zones (with `use_a`, zones split by A > 0.5 into labels +9: H/A/α Wishart), then up to
/// `iterations` reassignments by the Wishart distance `ln|V_m| + Tr(V_m⁻¹·T)` to the class means,
/// stopping when fewer than `stop` of the pixels change. Classes with no pixels are dropped.
pub fn wishart(t: &Planes, haa: &[[f64; 6]], use_a: bool, iterations: usize, stop: f64) -> Wishart {
    let n = t.n();
    let mut labels = vec![0u8; n];
    for i in 0..n {
        let q = haa[i];
        if q[0].is_finite() && q[2].is_finite() && t.m9(i).iter().all(|v| v.is_finite()) {
            let z = zone(q[0], q[2]);
            labels[i] = if use_a && q[1] > 0.5 { z + 9 } else { z };
        }
    }
    let mut iters = 0;
    let mut changed = 0.0;
    let mut converged = false;
    let mut classes: Vec<WClass>;
    loop {
        // Centres of the current labels.
        let mut acc = [[0f64; 9]; 19];
        let mut cnt = [0usize; 19];
        for i in 0..n {
            let l = labels[i] as usize;
            if l == 0 {
                continue;
            }
            let m = t.m9(i);
            for c in 0..9 {
                acc[l][c] += m[c];
            }
            cnt[l] += 1;
        }
        classes = (1..19)
            .filter(|&l| cnt[l] > 0)
            .map(|l| {
                let mut c = [0.0; 9];
                for k in 0..9 {
                    c[k] = acc[l][k] / cnt[l] as f64;
                }
                WClass { label: l as u8, count: cnt[l], centre: c }
            })
            .collect();
        if iters >= iterations || converged {
            break;
        }
        let inv: Vec<Option<(M3, f64)>> = classes.iter().map(|c| inv3(&h3(&c.centre)).filter(|(_, d)| *d > 0.0)).collect();
        let mut moved = 0usize;
        let mut valid = 0usize;
        for i in 0..n {
            if labels[i] == 0 {
                continue;
            }
            valid += 1;
            let tm = h3(&t.m9(i));
            let mut best = (f64::INFINITY, labels[i]);
            for (k, c) in classes.iter().enumerate() {
                let Some((vi, det)) = &inv[k] else { continue };
                // Re Tr(V⁻¹·T) = Σ_ij Re(V⁻¹_ij · T_ji).
                let mut tr = 0.0;
                for a in 0..3 {
                    for b in 0..3 {
                        tr += vi[a][b].mul(tm[b][a]).re;
                    }
                }
                let dist = det.ln() + tr;
                if dist < best.0 {
                    best = (dist, c.label);
                }
            }
            if best.1 != labels[i] {
                labels[i] = best.1;
                moved += 1;
            }
        }
        iters += 1;
        changed = if valid > 0 { moved as f64 / valid as f64 } else { 0.0 };
        // The next pass recomputes the centres of the final labels, then stops.
        converged = changed < stop;
    }
    Wishart { labels, classes, iterations: iters, changed }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng(seed: &mut u64) -> f64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        (*seed >> 11) as f64 / (1u64 << 53) as f64
    }
    fn gauss(seed: &mut u64) -> f64 {
        let u = rng(seed).max(1e-12);
        let v = rng(seed);
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }

    #[test]
    fn eig_reconstructs_hermitian() {
        let mut s = 7u64;
        for _ in 0..200 {
            // A random positive semi-definite T3 = Σ k kᴴ.
            let mut m = [0.0; 9];
            for _ in 0..4 {
                let k = [Cx::new(gauss(&mut s), gauss(&mut s)), Cx::new(gauss(&mut s), gauss(&mut s)), Cx::new(gauss(&mut s), gauss(&mut s))];
                let o = outer3(k);
                for c in 0..9 {
                    m[c] += o[c];
                }
            }
            let (l, v) = eig3(&m);
            assert!(l[0] >= l[1] && l[1] >= l[2]);
            // V·diag(λ)·Vᴴ = M.
            let mut d = [[Cx::ZERO; 3]; 3];
            for k in 0..3 {
                d[k][k] = Cx::new(l[k], 0.0);
            }
            let r = pack3(&mul3(&mul3(&v, &d), &adj3(&v)));
            let tr = m[0] + m[1] + m[2];
            for c in 0..9 {
                assert!((r[c] - m[c]).abs() < 1e-9 * tr, "{c}: {} vs {}", r[c], m[c]);
            }
        }
    }

    #[test]
    fn canonical_targets() {
        // Trihedral (surface): HH = VV = 1, HV = 0 → T11 only, α = 0, Freeman all surface.
        let one = |re: f64| vec![Cx::new(re, 0.0)];
        let t = from_quad(&one(1.0), &one(0.0), None, &one(1.0), 1, 1, true);
        let tm = t.m9(0);
        let q = h_a_alpha(&tm);
        assert!(q[0] < 1e-6 && q[2].abs() < 1e-6);
        let c = convert3(&tm, false);
        let f = freeman(&c);
        assert!((f[0] - 2.0).abs() < 1e-9 && f[1].abs() < 1e-9 && f[2].abs() < 1e-9, "{f:?}");
        // Dihedral: HH = 1, VV = −1 → α = 90°, double bounce.
        let t = from_quad(&one(1.0), &one(0.0), None, &one(-1.0), 1, 1, true);
        let q = h_a_alpha(&t.m9(0));
        assert!((q[2] - 90.0).abs() < 1e-6);
        let y = yamaguchi(&t.m9(0), false);
        assert!((y[1] - 2.0).abs() < 1e-9 && y[0].abs() < 1e-9, "{y:?}");
        // Random volume (uniform cloud): T3 = diag(2, 1, 1) → H = 0.946, α = 60°, A = 0.
        let tv = [2.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let q = h_a_alpha(&tv);
        let hh = -(0.5f64 * 0.5f64.log(3.0) + 2.0 * 0.25 * 0.25f64.log(3.0));
        assert!((q[0] - hh).abs() < 1e-9 && (q[2] - 45.0).abs() < 1e-6 && q[1].abs() < 1e-9, "{q:?}");
        let y = yamaguchi(&tv, false);
        assert!((y[2] - 4.0).abs() < 1e-9 && y[0].abs() < 1e-9 && y[1].abs() < 1e-9, "{y:?}");
        // Freeman: the volume model itself is all volume.
        let cv = [1.0, 2.0 / 3.0, 1.0, 0.0, 0.0, 1.0 / 3.0, 0.0, 0.0, 0.0];
        let f = freeman(&cv);
        assert!(f[0].abs() < 1e-9 && f[1].abs() < 1e-9 && (f[2] - 8.0 / 3.0).abs() < 1e-9, "{f:?}");
    }

    #[test]
    fn conversions_round_trip_and_keep_the_span() {
        let m = [3.0, 2.0, 1.0, 0.4, -0.2, 0.3, 0.1, -0.5, 0.25];
        let t = convert3(&m, true);
        let c = convert3(&t, false);
        for k in 0..9 {
            assert!((c[k] - m[k]).abs() < 1e-12);
        }
        assert!((t[0] + t[1] + t[2] - 6.0).abs() < 1e-12);
    }

    #[test]
    fn yamaguchi_powers_sum_to_the_span_and_deorientation_zeroes_re_t23() {
        let mut s = 11u64;
        for _ in 0..500 {
            let mut m = [0.0; 9];
            for _ in 0..6 {
                let k = [Cx::new(gauss(&mut s), gauss(&mut s)), Cx::new(gauss(&mut s), gauss(&mut s)), Cx::new(0.4 * gauss(&mut s), 0.4 * gauss(&mut s))];
                let o = outer3(k);
                for c in 0..9 {
                    m[c] += o[c];
                }
            }
            let tp = m[0] + m[1] + m[2];
            for rot in [false, true] {
                let y = yamaguchi(&m, rot);
                assert!(y.iter().all(|v| *v >= 0.0));
                assert!((y.iter().sum::<f64>() - tp).abs() < 1e-9 * tp, "{y:?} {tp}");
            }
            let d = deorient(&m);
            assert!(d[7].abs() < 1e-9 * tp);
            assert!((d[0] + d[1] + d[2] - tp).abs() < 1e-9 * tp);
            let f = freeman(&convert3(&m, false));
            assert!(f.iter().all(|v| *v >= 0.0 && *v <= tp + 1e-9));
        }
    }

    #[test]
    fn dual_and_compact_h_alpha() {
        // Equal uncorrelated channels: H = 1, α = 45°.
        let q = h_alpha2(&[1.0, 1.0, 0.0, 0.0]);
        assert!((q[0] - 1.0).abs() < 1e-12 && (q[2] - 45.0).abs() < 1e-9);
        // Co-pol only: H = 0, α = 0.
        let q = h_alpha2(&[1.0, 0.0, 0.0, 0.0]);
        assert!(q[0].abs() < 1e-12 && q[2].abs() < 1e-9);
        // CTLR of a trihedral: E_H = 1/√2, E_V = −i/√2 → rank 1, H = 0.
        let one = |re: f64| vec![Cx::new(re, 0.0)];
        let (eh, ev) = ctlr(&one(1.0), &one(0.0), None, &one(1.0));
        let c = from_dual(&eh, &ev, 1, 1);
        let q = h_alpha2(&[c.at(0, 0), c.at(1, 0), c.at(2, 0), c.at(3, 0)]);
        assert!(q[0] < 1e-9, "{q:?}");
    }

    #[test]
    fn filters_keep_a_constant_field_and_reduce_speckle() {
        let (w, h) = (48, 40);
        let mut s = 5u64;
        let n = w * h;
        let mk = |s: &mut u64| (0..n).map(|_| Cx::new(gauss(s), gauss(s))).collect::<Vec<_>>();
        let (hh, hv, vv) = (mk(&mut s), mk(&mut s), mk(&mut s));
        let t = from_quad(&hh, &hv, None, &vv, w, h, true);
        for f in [boxcar(&t, 7), refined_lee(&t, 1.0)] {
            let sp = f.span();
            let raw = t.span();
            let cv = |v: &[f32]| {
                let m = v.iter().map(|x| *x as f64).sum::<f64>() / v.len() as f64;
                (v.iter().map(|x| (*x as f64 - m).powi(2)).sum::<f64>() / v.len() as f64).sqrt() / m
            };
            assert!(cv(&sp) < 0.6 * cv(&raw), "{} vs {}", cv(&sp), cv(&raw));
        }
        let mut c = Planes::new(16, 16, 9);
        for i in 0..256 {
            c.set9(i, &[2.0, 1.0, 1.0, 0.1, 0.2, 0.0, 0.0, 0.0, 0.0]);
        }
        for f in [boxcar(&c, 5), refined_lee(&c, 1.0)] {
            assert!(f.d.iter().zip(&c.d).all(|(a, b)| (a - b).abs() < 1e-6));
        }
    }

    #[test]
    fn wishart_separates_two_mechanisms() {
        // Left half surface-like, right half volume-like, 3-look speckle.
        let (w, h) = (40, 20);
        let n = w * h;
        let mut s = 3u64;
        let mut t = Planes::new(w, h, 9);
        for y in 0..h {
            for x in 0..w {
                let mut m = [0.0; 9];
                for _ in 0..3 {
                    let k = if x < w / 2 {
                        [Cx::new(2.0 * gauss(&mut s), 2.0 * gauss(&mut s)), Cx::new(0.3 * gauss(&mut s), 0.3 * gauss(&mut s)), Cx::new(0.1 * gauss(&mut s), 0.1 * gauss(&mut s))]
                    } else {
                        [Cx::new(gauss(&mut s), gauss(&mut s)), Cx::new(0.7 * gauss(&mut s), 0.7 * gauss(&mut s)), Cx::new(0.7 * gauss(&mut s), 0.7 * gauss(&mut s))]
                    };
                    let o = outer3(k);
                    for c in 0..9 {
                        m[c] += o[c] / 3.0;
                    }
                }
                t.set9(y * w + x, &m);
            }
        }
        let f = boxcar(&t, 3);
        let haa: Vec<[f64; 6]> = (0..n).map(|i| h_a_alpha(&f.m9(i))).collect();
        let r = wishart(&f, &haa, false, 10, 0.001);
        // Away from the boundary, no class holds more than 5 % of both halves (8 classes may
        // over-segment each mechanism, but they must not mix them).
        let mut hl = [0usize; 19];
        let mut hr = [0usize; 19];
        for y in 0..h {
            for x in 0..w {
                if x + 3 < w / 2 {
                    hl[r.labels[y * w + x] as usize] += 1;
                } else if x >= w / 2 + 3 {
                    hr[r.labels[y * w + x] as usize] += 1;
                }
            }
        }
        let (nl, nr) = (hl.iter().sum::<usize>() as f64, hr.iter().sum::<usize>() as f64);
        let mixed = (0..19).filter(|&k| hl[k] as f64 > 0.05 * nl && hr[k] as f64 > 0.05 * nr).count();
        assert_eq!(mixed, 0, "{hl:?} {hr:?}");
        assert!(r.iterations >= 1);
    }
}
