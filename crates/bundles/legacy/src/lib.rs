//! `legacy` bundle (lazy; decode worker): readers for the formats closed in 2.1 (Appendix D §2.2.1).
//! Kept out of `parse` and `core` so their code loads only when such a file opens.
//! One module per format; each holds that format's `extern "C"` exports.

gw_abi::export_abi!();

mod aridpcm;
mod cphd;
mod hfa;
mod netcdf3;
mod ojpeg;
mod rpf;
mod safe;
mod uavsar;
