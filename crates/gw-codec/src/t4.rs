//! ITU-T T.4 bi-level blocks (NITF IC=C1): one-dimensional Modified Huffman (COMRAT "1D") and
//! two-dimensional Modified READ (COMRAT "2DS"/"2DH", TE-020, through the vendored fax crate).
//! Output: one byte per pixel, 1 = white, 0 = black.

use gw_abi::{Error, Result};

pub fn decode(data: &[u8], width: u32, height: u32, comrat: &str) -> Result<Vec<u8>> {
    let mode = comrat.trim().to_ascii_uppercase();
    let two_d = mode.starts_with("2D");
    if !mode.is_empty() && mode != "1D" && !two_d {
        return Err(Error::unsupported(format!("T.4 mode {mode} is not a T.4 coding (expected 1D, 2DS or 2DH)")));
    }
    let (w, h) = (width as usize, height as usize);
    if w == 0 || h == 0 || w * h > 1 << 28 {
        return Err(Error::limit("T.4: bad block size"));
    }
    let mut out = vec![1u8; w * h];
    let mut row = 0usize;
    let mut put = |line: &[u32]| {
        if row < h {
            for (x, c) in fax::decoder::pels(line, width).enumerate() {
                out[row * w + x] = u8::from(c == fax::Color::White);
            }
        }
        row += 1;
    };
    if two_d {
        fax::decoder::decode_g3_2d(data.iter().copied(), width, &mut put);
    } else {
        fax::decoder::decode_g3(data.iter().copied(), &mut put);
    }
    if row == 0 {
        return Err(Error::invalid("T.4: no coded lines"));
    }
    Ok(out)
}
