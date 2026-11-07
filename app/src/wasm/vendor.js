// `vendor` bundle wrapper (analysis worker, REQ-GAP-20): the vendor sensor-metadata readers. The
// record it returns is registered by the core bundle (Core.recordModel).

import { Bundle } from './abi.js';

export class VendorBundle extends Bundle {
  constructor(module) {
    super(module, 'vendor');
  }

  /**
   * A model from vendor metadata (REQ-GAP-20): kind 1 DigitalGlobe [IMD, EPH, ATT, GEO], 2 Landsat
   * [ANG], 3 Sentinel-2 [MTD_TL] (strings). Returns {header {type, rows, cols, flags, sigma}, record}:
   * type 2 line scanner, 4 map + line of sight; flags the reader notes (NOTE_* of gw_sensor::vendor::dg);
   * sigma the a priori [in-track, cross-track, radial m, attitude µrad] or null.
   */
  vendorModel(kind, parts, band = 0, step = 32, href = 0) {
    const enc = new TextEncoder();
    const bytes = parts.map((t) => enc.encode(t ?? ''));
    const buf = new Uint8Array(bytes.reduce((s, b) => s + 4 + b.length, 0));
    const dv = new DataView(buf.buffer);
    let o = 0;
    for (const b of bytes) {
      dv.setUint32(o, b.length, true);
      buf.set(b, o + 4);
      o += 4 + b.length;
    }
    return this.guard(() => {
      const [p, n] = this.put(buf);
      try {
        this.check(this.x.gw_vendor_model(kind, p, n, band, step, href), 'vendorModel');
        const out = this.outBytes();
        const v = new Float64Array(out.buffer, out.byteOffset, out.byteLength / 8);
        const sigma = Array.from(v.subarray(4, 8));
        const header = { type: v[0], rows: v[1], cols: v[2], flags: v[3], sigma: sigma.every(Number.isFinite) ? sigma : null };
        return { header, record: v.slice(8) };
      } finally {
        this.free(p, n);
      }
    });
  }
}
