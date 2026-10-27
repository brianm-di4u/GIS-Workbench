// `sar` bundle wrapper (analysis worker): speckle filters (REQ-SAR-07), log-ratio (REQ-SAR-08),
// CCD (REQ-SAR-09/14), the pair finder (REQ-SAR-10), sub-apertures and CSI (REQ-SAR-11) and
// Pauli composites (REQ-SAR-13). Complex arrays are interleaved (re, im) Float32Array.

import { Bundle } from './abi.js';

export const FILTERS = { mean: 0, median: 1, lee: 2, kuan: 3, gammamap: 4, frost: 5, refinedlee: 6 };

/** Split `[u32 json length][json][pad][f32 arrays…]` into {json, arrays} of `n` samples each. */
function unpack(bytes, n, count) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jl = dv.getUint32(0, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jl)));
  let off = 4 + jl;
  off += (4 - (off % 4)) % 4;
  const f = new Float32Array(bytes.buffer.slice(bytes.byteOffset + off, bytes.byteOffset + off + count * n * 4));
  return { json, arrays: Array.from({ length: count }, (_, k) => f.subarray(k * n, (k + 1) * n)) };
}

export class SarBundle extends Bundle {
  constructor(module) {
    super(module, 'sar');
  }

  f32(bytes) {
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  speckle(kind, v, w, h, { win = 7, looks = 1, damping = 2 } = {}) {
    return this.guard(() => {
      const [p, n] = this.putF32(v);
      try {
        this.check(this.x.gw_sar_speckle(FILTERS[kind] ?? kind, win, looks, damping, w, h, p, v.length), 'speckle');
        return this.f32(this.outBytes());
      } finally {
        this.free(p, n);
      }
    });
  }

  logRatio(i1, i2, w, h, win = 5) {
    return this.guard(() => {
      const [a, an] = this.putF32(i1);
      const [b, bn] = this.putF32(i2);
      try {
        this.check(this.x.gw_sar_logratio(win, w, h, a, b, i1.length), 'logRatio');
        return this.f32(this.outBytes());
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }

  /** CCD of two complex chips → {json: {ties, warp, rms, fringe}, gamma, phase, i1, i2}. */
  ccd(f, g, w, h, o = {}) {
    const prm = [w, h, o.win ?? 5, o.register === false ? 0 : 1, o.spacing ?? 64, o.patch ?? 64, o.maxShift ?? 8, o.flatEarth === false ? 0 : 1, o.noise?.[0] ?? 0, o.noise?.[1] ?? 0, o.compensate ? 1 : 0, o.cnrDb ?? NaN, o.goldstein ?? 0];
    return this.guard(() => {
      const [pp, pn] = this.putF64(prm);
      const [a, an] = this.putF32(f);
      const [b, bn] = this.putF32(g);
      try {
        this.check(this.x.gw_sar_ccd(pp, a, b, f.length), 'ccd');
        const { json, arrays } = unpack(this.outBytes(), w * h, 4);
        return { ...json, gamma: arrays[0], phase: arrays[1], i1: arrays[2], i2: arrays[3] };
      } finally {
        this.free(pp, pn);
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }

  subaperture(z, w, h, { dim = 1, frames = 9, fraction = 0.2, fill = 1 } = {}) {
    return this.guard(() => {
      const [pp, pn] = this.putF64([w, h, dim, frames, fraction, fill]);
      const [a, an] = this.putF32(z);
      try {
        this.check(this.x.gw_sar_subaperture(pp, a, z.length), 'subaperture');
        return this.f32(this.outBytes());
      } finally {
        this.free(pp, pn);
        this.free(a, an);
      }
    });
  }

  csi(z, w, h, { dim = 1, fill = 1 } = {}) {
    return this.guard(() => {
      const [pp, pn] = this.putF64([w, h, dim, fill]);
      const [a, an] = this.putF32(z);
      try {
        this.check(this.x.gw_sar_csi(pp, a, z.length), 'csi');
        return this.f32(this.outBytes());
      } finally {
        this.free(pp, pn);
        this.free(a, an);
      }
    });
  }

  pauli(hh, hv, vv) {
    return this.guard(() => {
      const [a, an] = this.putF32(hh);
      const [b, bn] = this.putF32(hv);
      const [c, cn] = this.putF32(vv);
      try {
        this.check(this.x.gw_sar_pauli(a, b, c, hh.length), 'pauli');
        return this.f32(this.outBytes());
      } finally {
        this.free(a, an);
        this.free(b, bn);
        this.free(c, cn);
      }
    });
  }

  /** collects: [{family, core, mode, pol, side (ids), start (s), incidence, azimuth, footprint [[lat, lon]], matches [ids]}]. */
  pairs(collects, { minOverlap = 0.5, maxDays = 60, maxIncidence = 2, maxAzimuth = 5 } = {}) {
    const prm = [minOverlap, maxDays, maxIncidence, maxAzimuth];
    for (const c of collects) prm.push(c.family, c.core, c.mode, c.pol, c.side, c.start, c.incidence, c.azimuth, c.footprint.length, ...c.footprint.flat(), c.matches.length, ...c.matches);
    return this.guard(() => {
      const [p, n] = this.putF64(prm);
      try {
        this.check(this.x.gw_sar_pairs(p, prm.length), 'pairs');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }
}
