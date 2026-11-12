// `sargeo` bundle wrapper (analysis worker, REQ-GAP-90, REG-085): a geocoding job behind a handle,
// stepped a few DEM rows at a time so the worker reports progress and takes a cancel between steps.
// The parameter list is analysis/sargeo-job.js's sargeoParams.

import { Bundle } from './abi.js';

export class SargeoBundle extends Bundle {
  constructor(module) {
    super(module, 'sargeo');
  }

  /** Create a job: prm (Float64Array), z (DEM HAE, Float32Array), beta (window β⁰, Float32Array). */
  open(prm, z, beta) {
    return this.guard(() => {
      const ps = [this.putF64(prm), this.putF32(z), this.putF32(beta)];
      try {
        this.check(this.x.gw_sargeo_new(ps[0][0], prm.length, ps[1][0], z.length, ps[2][0], beta.length), 'sargeo');
        return new DataView(this.outBytes().buffer).getUint32(0, true);
      } finally {
        for (const [p, n] of ps) this.free(p, n);
      }
    });
  }

  /** Run about `rows` DEM rows; returns progress (1 = done). */
  step(h, rows) {
    return this.guard(() => {
      this.check(this.x.gw_sargeo_step(h, rows), 'sargeo');
      return new DataView(this.outBytes().buffer).getFloat64(0, true);
    });
  }

  /** Outputs of a finished job: {value, mask, counts: [valid, layover, shadow], coords?}. */
  result(h, { coords = false } = {}) {
    return this.guard(() => {
      const take = (what) => {
        this.check(this.x.gw_sargeo_result(h, what), 'sargeo');
        return this.outBytes();
      };
      const v = take(0);
      const value = new Float32Array(v.buffer, v.byteOffset, v.byteLength / 4);
      const mask = take(1);
      const c = take(2);
      const counts = Array.from(new Float64Array(c.buffer, c.byteOffset, 3));
      let xy = null;
      if (coords) {
        const b = take(3);
        xy = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
      }
      return { value, mask, counts, coords: xy };
    });
  }

  close(h) {
    this.x.gw_sargeo_free(h);
  }

  /**
   * Run a whole job: `onStep(progress)` between steps (it may throw to cancel; the job is freed
   * either way). Returns result().
   */
  async run(prm, z, beta, { rows = 64, coords = false, onStep } = {}) {
    const h = this.open(prm, z, beta);
    try {
      for (;;) {
        const p = this.step(h, rows);
        if (p >= 1) break;
        await onStep?.(p);
      }
      return this.result(h, { coords });
    } finally {
      this.close(h);
    }
  }
}
