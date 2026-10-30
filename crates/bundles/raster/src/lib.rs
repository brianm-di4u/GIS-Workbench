//! `raster` bundle (lazy; analysis worker): orthorectification tiles (REQ-SNS-17) and mosaic
//! blending (REQ-SNS-18). Jobs are flat records (Appendix D §3.1); results go to the output
//! buffer as little-endian f32.

use gw_abi::{set_out, slice, status, Error};
use gw_raster::mosaic::blend;
use gw_raster::ortho::{ortho_tile, OrthoSpec};
use gw_raster::resample::{Kernel, Patch};
use gw_sensor::adjusted::{Adjusted, ImageBias};
use gw_sensor::rpc::{Rpc, RPC_RECORD_LEN};
use gw_sensor::terrain::DemGrid;
use gw_sensor::SensorModel;
use std::rc::Rc;

gw_abi::export_abi!();

fn put_f32(v: &[f32]) {
    let mut b = Vec::with_capacity(v.len() * 4);
    for x in v {
        b.extend_from_slice(&x.to_le_bytes());
    }
    set_out(b);
}

/// Orthorectify one tile. `spec` = [model type 0, RPC record, bias c(6), cx, cy, hx, hy, zone,
/// north, e0, n0, res, w, h, kernel, bound px, fallback h, DEM lat0, lon0, dlat, dlon, width,
/// height (0 = none), source x0, y0, w, h, bands]; `dem` = DEM heights (HAE); `src` = source
/// patch, bands planar. Output (f32): cells, max error, worst cell (column, row, size), then the bands (w·h each), then the mask.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_ortho_tile(spec: *const f64, len: usize, dem: *const f32, dlen: usize, src: *const f32, slen: usize) -> i32 {
    let a = slice(spec, len);
    status((|| {
        let r = 1 + RPC_RECORD_LEN;
        // A trailing element is the source patch scale (a pyramid level), 1 when absent.
        if (a.len() != r + 31 && a.len() != r + 32) || a[0] != 0.0 {
            return Err(Error::invalid("ortho tile: bad spec"));
        }
        let base: Rc<dyn SensorModel> = Rc::new(Rpc::from_record(&a[1..r])?);
        let b = &a[r..];
        let model = Adjusted { base, bias: ImageBias { c: [b[0], b[1], b[2], b[3], b[4], b[5]], centre: (b[6], b[7]), half: (b[8].max(1.0), b[9].max(1.0)) }, sigma: None, name: "ortho".into() };
        let o = &b[10..];
        let s = OrthoSpec { zone: o[0] as i32, north: o[1] != 0.0, e0: o[2], n0: o[3], res: o[4], w: o[5] as usize, h: o[6] as usize, kernel: Kernel::from_i32(o[7] as i32), bound_px: o[8].max(0.01), fallback_h: o[9] };
        let d = &o[10..];
        let (dw, dh) = (d[4] as usize, d[5] as usize);
        let grid = if dw >= 2 && dh >= 2 {
            if dlen != dw * dh {
                return Err(Error::invalid("ortho tile: DEM size"));
            }
            Some(DemGrid::new(d[0], d[1], d[2], d[3], dw, dh, std::slice::from_raw_parts(dem, dlen).to_vec(), true, f64::NAN)?)
        } else {
            None
        };
        let p = &d[6..];
        let (sx0, sy0, sw, sh, nb) = (p[0], p[1], p[2] as usize, p[3] as usize, p[4] as usize);
        let scale = p.get(5).copied().filter(|v| *v >= 1.0).unwrap_or(1.0);
        if s.w * s.h == 0 || s.w * s.h > 4096 * 4096 || nb == 0 || slen != sw * sh * nb {
            return Err(Error::invalid("ortho tile: sizes"));
        }
        let all = std::slice::from_raw_parts(src, slen);
        let patches: Vec<Patch<'_>> = (0..nb).map(|k| Patch { x0: sx0, y0: sy0, w: sw, h: sh, px: &all[k * sw * sh..(k + 1) * sw * sh], scale }).collect();
        let none = |_: f64, _: f64| 0.0;
        let out = ortho_tile(&model, grid.as_ref(), &none, &s, &patches)?;
        let mut v = Vec::with_capacity(2 + (nb + 1) * s.w * s.h);
        v.push(out.cells as f32);
        v.push(out.max_err_px as f32);
        v.extend_from_slice(&[out.worst_cell.0 as f32, out.worst_cell.1 as f32, out.worst_cell.2 as f32]);
        for band in &out.bands {
            v.extend_from_slice(band);
        }
        v.extend(out.mask.iter().map(|m| f32::from(*m)));
        put_f32(&v);
        Ok(())
    })())
}

/// Blend a mosaic tile. `prm` = [w, h, images, bands, feather, then gain and offset per image];
/// `data` (f32) = labels (w·h, 255 = none), then per image its mask (w·h) and bands (w·h each).
/// Output (f32): the blended bands, then the mask.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_blend_tile(prm: *const f64, plen: usize, data: *const f32, dlen: usize) -> i32 {
    let a = slice(prm, plen);
    status((|| {
        if a.len() < 5 {
            return Err(Error::invalid("blend tile: short parameters"));
        }
        let (w, h, ni, nb, feather) = (a[0] as usize, a[1] as usize, a[2] as usize, a[3] as usize, a[4] as usize);
        let n = w * h;
        if a.len() != 5 + 2 * ni || dlen != n * (1 + ni * (1 + nb)) || ni > 16 {
            return Err(Error::invalid("blend tile: sizes"));
        }
        let d = std::slice::from_raw_parts(data, dlen);
        let labels: Vec<u8> = d[..n].iter().map(|v| *v as u8).collect();
        let mut masks = Vec::with_capacity(ni);
        let mut bands = Vec::with_capacity(ni);
        let mut o = n;
        for _ in 0..ni {
            masks.push(d[o..o + n].iter().map(|v| u8::from(*v > 0.5)).collect::<Vec<u8>>());
            o += n;
            let mut bs = Vec::with_capacity(nb);
            for _ in 0..nb {
                bs.push(d[o..o + n].to_vec());
                o += n;
            }
            bands.push(bs);
        }
        let gains: Vec<(f32, f32)> = (0..ni).map(|i| (a[5 + 2 * i] as f32, a[6 + 2 * i] as f32)).collect();
        let (out, mask) = blend(w, h, &bands, &masks, &labels, &gains, feather);
        let mut v = Vec::with_capacity((nb + 1) * n);
        for b in &out {
            v.extend_from_slice(b);
        }
        v.extend(mask.iter().map(|m| f32::from(*m)));
        put_f32(&v);
        Ok(())
    })())
}
