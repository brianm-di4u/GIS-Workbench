// `raster` bundle wrapper (analysis worker): orthorectification tiles (REQ-SNS-17), mosaic
// blending (REQ-SNS-18) and pan-sharpening tiles (REQ-GAP-14; spec layout in features/pansharpen-plan.js).

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

  /** Run a pan-sharpening job (gw_ps_stats | gw_ps_wald | gw_ps_fuse) → the output bytes. */
  _ps(fn, spec, ms, pan) {
    return this.guard(() => {
      const [a, an] = this.putF64(spec);
      const [m, mn] = this.putF32(ms);
      const [p, pn] = this.putF32(pan);
      try {
        this.check(this.x[fn](a, spec.length, m, ms.length, p, pan.length), 'pan-sharpen');
        return this.outBytes();
      } finally {
        this.free(a, an);
        this.free(m, mn);
        this.free(p, pn);
      }
    });
  }

  /** Statistics of one G_L tile → {s1, s2, low: {x0, y0, w, h, px}}; `n` = stats length. */
  psStats(spec, ms, pan, n) {
    const b = this._ps('gw_ps_stats', spec, ms, pan);
    const f = new Float64Array(b.buffer, 0, 2 * n + 4);
    const [x0, y0, w, h] = f.subarray(2 * n, 2 * n + 4);
    return { s1: f.slice(0, n), s2: f.slice(n, 2 * n), low: { x0, y0, w, h, px: new Float32Array(b.buffer.slice((2 * n + 4) * 8)) } };
  }

  /** Wald's synthesis check on one G_L tile → the quality accumulator (Float64Array). */
  psWald(spec, ms, panLow) {
    return new Float64Array(this._ps('gw_ps_wald', spec, ms, panLow).buffer);
  }

  /** One fused tile → {q (consistency accumulator, `nq` long), px (bytes of the core, interleaved)}. */
  psFuse(spec, ms, pan, nq) {
    const b = this._ps('gw_ps_fuse', spec, ms, pan);
    return { q: new Float64Array(b.buffer.slice(0, nq * 8)), px: new Uint8Array(b.buffer, nq * 8) };
  }
}
