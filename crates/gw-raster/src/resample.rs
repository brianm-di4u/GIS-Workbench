//! Resampling kernels on a planar f32 patch (corner-origin coordinates: the first pixel's centre
//! is (0.5, 0.5)): nearest neighbour, bilinear, cubic convolution (Keys, a = −0.5) and Lanczos-3.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kernel {
    Nearest,
    Bilinear,
    Cubic,
    Lanczos3,
}

impl Kernel {
    pub fn from_i32(v: i32) -> Self {
        match v {
            0 => Self::Nearest,
            2 => Self::Cubic,
            3 => Self::Lanczos3,
            _ => Self::Bilinear,
        }
    }
    /// Pixels the kernel reaches beyond the sample point (for source windows).
    pub fn radius(self) -> usize {
        match self {
            Self::Nearest => 1,
            Self::Bilinear => 1,
            Self::Cubic => 2,
            Self::Lanczos3 => 3,
        }
    }
}

/// One band of a patch.
pub struct Patch<'a> {
    pub x0: f64,
    pub y0: f64,
    pub w: usize,
    pub h: usize,
    pub px: &'a [f32],
}

fn cubic(t: f64) -> f64 {
    let a = -0.5;
    let t = t.abs();
    if t < 1.0 {
        (a + 2.0) * t * t * t - (a + 3.0) * t * t + 1.0
    } else if t < 2.0 {
        a * t * t * t - 5.0 * a * t * t + 8.0 * a * t - 4.0 * a
    } else {
        0.0
    }
}

fn lanczos3(t: f64) -> f64 {
    let t = t.abs();
    if t < 1e-9 {
        1.0
    } else if t < 3.0 {
        let p = std::f64::consts::PI * t;
        3.0 * p.sin() * (p / 3.0).sin() / (p * p)
    } else {
        0.0
    }
}

/// Sample at image coordinates (x, y); NaN outside the patch or when a needed pixel is NaN.
pub fn sample(p: &Patch<'_>, k: Kernel, x: f64, y: f64) -> f32 {
    let fx = x - p.x0 - 0.5;
    let fy = y - p.y0 - 0.5;
    let (w, h) = (p.w as i64, p.h as i64);
    match k {
        Kernel::Nearest => {
            let (i, j) = (fx.round() as i64, fy.round() as i64);
            if i < 0 || j < 0 || i >= w || j >= h {
                return f32::NAN;
            }
            p.px[(j * w + i) as usize]
        }
        Kernel::Bilinear => {
            let (i, j) = (fx.floor() as i64, fy.floor() as i64);
            if i < 0 || j < 0 || i + 1 >= w || j + 1 >= h {
                return f32::NAN;
            }
            let (a, b) = ((fx - i as f64) as f32, (fy - j as f64) as f32);
            let v = |ii: i64, jj: i64| p.px[(jj * w + ii) as usize];
            v(i, j) * (1.0 - a) * (1.0 - b) + v(i + 1, j) * a * (1.0 - b) + v(i, j + 1) * (1.0 - a) * b + v(i + 1, j + 1) * a * b
        }
        Kernel::Cubic | Kernel::Lanczos3 => {
            let r = k.radius() as i64;
            let (i, j) = (fx.floor() as i64, fy.floor() as i64);
            if i - r + 1 < 0 || j - r + 1 < 0 || i + r >= w || j + r >= h {
                return f32::NAN;
            }
            let f = if k == Kernel::Cubic { cubic } else { lanczos3 };
            let (mut s, mut ws) = (0.0f64, 0.0f64);
            for jj in j - r + 1..=j + r {
                let wy = f(fy - jj as f64);
                for ii in i - r + 1..=i + r {
                    let wgt = wy * f(fx - ii as f64);
                    s += wgt * f64::from(p.px[(jj * w + ii) as usize]);
                    ws += wgt;
                }
            }
            (s / ws) as f32
        }
    }
}
