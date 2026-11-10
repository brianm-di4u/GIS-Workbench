// `geoproc` bundle wrapper (analysis worker, REQ-GAP-79): buffer and dissolve on planar
// coordinates (crates/gw-geoproc). The geometry encoding and the frames are analysis/geoproc.js.

import { Bundle } from './abi.js';
import { decodeShapes } from '../analysis/geoproc.js';

export class GeoprocBundle extends Bundle {
  constructor(module) {
    super(module, 'geoproc');
  }

  call(name, arrays, fn, count) {
    return this.guard(() => {
      const ptrs = arrays.map((a) => (a.length ? this.putF64(a) : [0, 0]));
      try {
        this.check(fn(...ptrs.map(([p], i) => [p, arrays[i].length])), name);
        const o = this.outBytes();
        return decodeShapes(new Float64Array(o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength)), count);
      } finally {
        for (const [p, n] of ptrs) if (p) this.free(p, n);
      }
    });
  }

  /** One multipolygon per encoded geometry. cap: 0 round, 1 flat, 2 square. */
  buffer(flat, distance, cap, quadSegs, count) {
    return this.call('buffer', [flat], ([g, n]) => this.x.gw_geo_buffer(g, n, distance, cap, quadSegs), count);
  }

  /** One multipolygon per group (0 … max). */
  dissolve(flat, groups) {
    const count = groups.reduce((m, v) => Math.max(m, v + 1), 0);
    return this.call('dissolve', [flat, groups], ([g, n], [k, nk]) => this.x.gw_geo_dissolve(g, n, k, nk), count);
  }
}
