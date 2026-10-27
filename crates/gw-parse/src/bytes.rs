//! Bounded big-endian reader for hostile input (REQ-SEC-02): every read is checked against
//! the buffer; ASCII fields are read as text without interpretation.

use gw_abi::{Error, Result};

pub struct Reader<'a> {
    pub b: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Reader { b, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.b.len().saturating_sub(self.pos)
    }

    pub fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or_else(|| Error::range("length overflow"))?;
        if end > self.b.len() {
            return Err(Error::new(gw_abi::RANGE, format!("need {} bytes at offset {}, have {}", n, self.pos, self.b.len())));
        }
        let s = &self.b[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    /// A fixed-length ASCII (BCS) field, returned raw (trailing spaces kept).
    pub fn text(&mut self, n: usize) -> Result<String> {
        Ok(latin1(self.bytes(n)?))
    }

    /// A fixed-length field trimmed of spaces.
    pub fn trimmed(&mut self, n: usize) -> Result<String> {
        Ok(self.text(n)?.trim().to_string())
    }

    /// A fixed-length unsigned decimal field. Blank → 0.
    pub fn num(&mut self, n: usize, name: &str) -> Result<u64> {
        let t = self.text(n)?;
        let t = t.trim();
        if t.is_empty() {
            return Ok(0);
        }
        t.parse::<u64>().map_err(|_| Error::invalid(format!("field {name} is not a number: \"{t}\"")))
    }

    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.bytes(1)?[0])
    }
    pub fn u16be(&mut self) -> Result<u16> {
        let b = self.bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    pub fn u32be(&mut self) -> Result<u32> {
        let b = self.bytes(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// ISO 8859-1 bytes → String (every byte maps to one char; never fails).
pub fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

/// Printable preview of binary data for display.
pub fn printable(b: &[u8], max: usize) -> String {
    b.iter().take(max).map(|&c| if (0x20..0x7f).contains(&c) { c as char } else { '·' }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds() {
        let mut r = Reader::new(b"0012AB");
        assert_eq!(r.num(4, "x").unwrap(), 12);
        assert!(r.bytes(3).is_err());
        assert_eq!(r.text(2).unwrap(), "AB");
        let mut r = Reader::new(b"12x4");
        assert!(r.num(4, "x").is_err());
    }
}
