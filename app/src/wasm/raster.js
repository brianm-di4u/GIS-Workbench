// `raster` bundle wrapper (analysis worker): orthorectification tiles (REQ-SNS-17) and mosaic
// blending (REQ-SNS-18).

import { Bundle } from './abi.js';

export class Raster extends Bundle {
  constructor(module) {
    super(module, 'raster');
  }

  /** spec Float64Array, dem Float32Array (HAE, may be empty), src Float32Array (bands planar) → {cells, maxErr, bands, mask}. */
  ortho(spec, dem, src, w, h, nb) {
    return this.guard(() => {
      const [a, an] = this.putF64(spec);
      const [d, dn] = this.putF32(dem.length ? dem : new Float32Array(1));
      const [s, sn] = this.putF32(src);
      try {
        this.check(this.x.gw_ortho_tile(a, spec.length, d, dem.length, s, src.length), 'ortho');
        const b = this.outBytes();
        const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
        const n = w * h;
        return { cells: f[0], maxErr: f[1], worst: [f[2], f[3], f[4]], bands: Array.from({ length: nb }, (_, k) => f.slice(5 + k * n, 5 + (k + 1) * n)), mask: Uint8Array.from(f.subarray(5 + nb * n, 5 + (nb + 1) * n)) };
      } finally {
        this.free(a, an);
        this.free(d, dn);
        this.free(s, sn);
      }
    });
  }

  /** prm Float64Array, data Float32Array → {bands, mask}. */
  blend(prm, data, w, h, nb) {
    return this.guard(() => {
      const [a, an] = this.putF64(prm);
      const [d, dn] = this.putF32(data);
      try {
        this.check(this.x.gw_blend_tile(a, prm.length, d, data.length), 'blend');
        const b = this.outBytes();
        const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
        const n = w * h;
        return { bands: Array.from({ length: nb }, (_, k) => f.slice(k * n, (k + 1) * n)), mask: Uint8Array.from(f.subarray(nb * n, (nb + 1) * n)) };
      } finally {
        this.free(a, an);
        this.free(d, dn);
      }
    });
  }
}
