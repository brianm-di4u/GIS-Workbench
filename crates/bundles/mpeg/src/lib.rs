//! `mpeg` bundle (lazy; decode worker): MPEG program-stream demux, MPEG-1 video (FC-22) and
//! MPEG-2 video (MP@ML/MP@HL; REQ-GAP-48).
//! Split from `legacy` so the 200 KB legacy budget holds the image readers; it loads only when
//! a program stream or MPEG-1 clip opens.

gw_abi::export_abi!();

mod ps;
