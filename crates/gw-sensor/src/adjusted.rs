//! A sensor model corrected by an image-space bias (REQ-SNS-11, REQ-SNS-15, Grodecki & Dial
//! 2003): x = x₀ + Δx(x₀, y₀), y = y₀ + Δy(x₀, y₀), where (x₀, y₀) is the base model's
//! projection. The base model is never changed; the bias is the adjustment record.

use crate::{Ground, SensorModel};
use gw_abi::Result;
use std::rc::Rc;

/// Bias families: shift (2 parameters), shift + drift along lines (4), affine (6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BiasKind {
    Shift,
    ShiftDrift,
    Affine,
}

impl BiasKind {
    pub fn from_i32(v: i32) -> Option<Self> {
        match v {
            0 => Some(Self::Shift),
            1 => Some(Self::ShiftDrift),
            2 => Some(Self::Affine),
            _ => None,
        }
    }
    /// Number of parameters per image.
    pub fn len(self) -> usize {
        match self {
            Self::Shift => 2,
            Self::ShiftDrift => 4,
            Self::Affine => 6,
        }
    }
    /// Which of the six affine terms [a0, a1, a2, b0, b1, b2] this family uses
    /// (Δy = a0 + a1·u + a2·v, Δx = b0 + b1·u + b2·v, u and v the normalised x and y).
    pub fn terms(self) -> &'static [usize] {
        match self {
            Self::Shift => &[0, 3],
            Self::ShiftDrift => &[0, 2, 3, 5],
            Self::Affine => &[0, 1, 2, 3, 4, 5],
        }
    }
}

/// Image-space bias with its normalisation (centre and half-size of the image, pixels).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImageBias {
    /// [a0, a1, a2, b0, b1, b2]: Δy (lines) then Δx (samples), pixels.
    pub c: [f64; 6],
    pub centre: (f64, f64),
    pub half: (f64, f64),
}

impl ImageBias {
    pub fn zero(centre: (f64, f64), half: (f64, f64)) -> Self {
        Self { c: [0.0; 6], centre, half }
    }
    /// Normalised coordinates (u, v) of an image point.
    pub fn uv(&self, x: f64, y: f64) -> (f64, f64) {
        ((x - self.centre.0) / self.half.0, (y - self.centre.1) / self.half.1)
    }
    /// (Δx, Δy) at base image position (x₀, y₀).
    pub fn delta(&self, x0: f64, y0: f64) -> (f64, f64) {
        let (u, v) = self.uv(x0, y0);
        (self.c[3] + self.c[4] * u + self.c[5] * v, self.c[0] + self.c[1] * u + self.c[2] * v)
    }
    pub fn apply(&self, x0: f64, y0: f64) -> (f64, f64) {
        let (dx, dy) = self.delta(x0, y0);
        (x0 + dx, y0 + dy)
    }
    /// Base position (x₀, y₀) whose biased position is (x, y).
    pub fn unapply(&self, x: f64, y: f64) -> (f64, f64) {
        let (mut x0, mut y0) = (x, y);
        for _ in 0..8 {
            let (dx, dy) = self.delta(x0, y0);
            x0 = x - dx;
            y0 = y - dy;
        }
        (x0, y0)
    }
}

pub struct Adjusted {
    pub base: Rc<dyn SensorModel>,
    pub bias: ImageBias,
    /// Horizontal σ after adjustment (m), if the solution states one.
    pub sigma: Option<f64>,
    pub name: String,
}

impl SensorModel for Adjusted {
    fn name(&self) -> &str {
        &self.name
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let (x0, y0) = self.base.ground_to_image(g)?;
        Ok(self.bias.apply(x0, y0))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let (x0, y0) = self.bias.unapply(x, y);
        self.base.image_to_ground(x0, y0, h)
    }
    fn height_range(&self) -> (f64, f64) {
        self.base.height_range()
    }
    fn horizontal_sigma(&self) -> Option<f64> {
        self.sigma.or_else(|| self.base.horizontal_sigma())
    }
    fn horizontal_sigma_parts(&self) -> Option<(f64, f64)> {
        match self.sigma {
            Some(s) => Some((0.0, s)),
            None => self.base.horizontal_sigma_parts(),
        }
    }
    fn is_3d(&self) -> bool {
        self.base.is_3d()
    }
}

impl SensorModel for Rc<dyn SensorModel> {
    fn name(&self) -> &str {
        (**self).name()
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        (**self).ground_to_image(g)
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        (**self).image_to_ground(x, y, h)
    }
    fn height_range(&self) -> (f64, f64) {
        (**self).height_range()
    }
    fn horizontal_sigma(&self) -> Option<f64> {
        (**self).horizontal_sigma()
    }
    fn horizontal_sigma_parts(&self) -> Option<(f64, f64)> {
        (**self).horizontal_sigma_parts()
    }
    fn is_3d(&self) -> bool {
        (**self).is_3d()
    }
    fn ground_partials(&self, g: Ground) -> Result<[[f64; 3]; 2]> {
        (**self).ground_partials(g)
    }
}
