// `sar` bundle wrapper (analysis worker): speckle filters (REQ-SAR-07), log-ratio (REQ-SAR-08),
// CCD (REQ-SAR-09/14), the pair finder (REQ-SAR-10), sub-apertures and CSI (REQ-SAR-11) and
// Pauli composites (REQ-SAR-13), polarimetry (REQ-GAP-40) and radargrammetry (REQ-GAP-42).
// Complex arrays are interleaved (re, im) Float32Array.

import { Bundle, WasmError } from './abi.js';

export const FILTERS = { mean: 0, median: 1, lee: 2, kuan: 3, gammamap: 4, frost: 5, refinedlee: 6 };
/** Polarimetric inputs: quad-pol complex (HH, HV, [VH], VV), C3 planes, two complex channels, quad-pol simulated as CTLR compact-pol, C2 planes, T3 planes. */
export const POL_INPUT = { quad: 0, c3: 1, dual: 2, compact: 3, c2: 4, t3: 5 };
export const POL_FILTER = { none: 0, boxcar: 1, refinedlee: 2 };
export const POL_PRODUCTS = { t3: 1, c3: 2, freeman: 4, yamaguchi: 8, haalpha: 16, wishart: 32, halpha2: 64, c2: 128, span: 256 };

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

// A SICD record reaches JS through JSON, where an absent value (NaN) is null. Float64Array would
// read that as 0, a stated CompositeSCP σ of zero: put the NaN back.
const sicdRecord = (r) => Float64Array.from(r, (v) => v ?? NaN);

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

  /**
   * Polarimetric matrices and decompositions (REQ-GAP-40). `data` is one Float32Array holding the
   * input channels back to back (see POL_INPUT); o: {input, filter, win, looks, products (names
   * from POL_PRODUCTS), rotate, useA, iterations, hasVH}. Returns {products: [{name, planes:
   * {plane name: Float32Array}}], wishart}.
   */
  polsar(data, w, h, o = {}) {
    const bits = (o.products ?? []).reduce((m, p) => m | (POL_PRODUCTS[p] ?? 0), 0);
    const prm = [w, h, POL_INPUT[o.input] ?? o.input, POL_FILTER[o.filter ?? 'none'] ?? 0, o.win ?? 7, o.looks ?? 1, bits, o.rotate ? 1 : 0, o.useA ? 1 : 0, o.iterations ?? 10, o.hasVH ? 1 : 0];
    return this.guard(() => {
      const [pp, pn] = this.putF64(prm);
      const [a, an] = this.putF32(data);
      try {
        this.check(this.x.gw_sar_polsar(pp, prm.length, a, data.length), 'polsar');
        const bytes = this.outBytes();
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const jl = dv.getUint32(0, true);
        const json = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jl)));
        const total = json.products.reduce((s, p) => s + p.planes.length, 0);
        const { arrays } = unpack(bytes, w * h, total);
        let k = 0;
        const products = json.products.map((p) => ({ name: p.name, planes: Object.fromEntries(p.planes.map((nm) => [nm, arrays[k++].slice()])) }));
        return { products, wishart: json.wishart ?? null };
      } finally {
        this.free(pp, pn);
        this.free(a, an);
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

  // ---- radargrammetry (REQ-GAP-42) ----

  /**
   * SAR stereo pair finder. collects: [{start (s), record (SICD model record)}]; limits
   * {minOverlap, minAngle, maxAngleSame, maxDays, targetAngle}. Returns the ranked pairs
   * [{a, b, ok, score, overlap, days, centre, reasons, notes, geometry}].
   */
  stereoPairs(collects, { minOverlap = 0.3, minAngle = 3, maxAngleSame = 20, maxDays = 90, targetAngle = 8 } = {}) {
    const prm = [minOverlap, minAngle, maxAngleSame, maxDays, targetAngle, collects.length];
    for (const c of collects) prm.push(Number.isFinite(c.start) ? c.start : NaN, c.record.length, ...sicdRecord(c.record));
    return this.guard(() => {
      const [p, n] = this.putF64(prm);
      try {
        this.check(this.x.gw_sar_stereo_pairs(p, prm.length), 'stereoPairs');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Block-average amplitude (or intensity) to mean intensity → {w, h, v}. */
  multilook(v, w, h, mx, my, amplitude = true) {
    return this.guard(() => {
      const [pp, pn] = this.putF64([w, h, mx, my, amplitude ? 1 : 0]);
      const [a, an] = this.putF32(v);
      try {
        this.check(this.x.gw_sar_multilook(pp, a, v.length), 'multilook');
        const bytes = this.outBytes();
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const jl = dv.getUint32(0, true);
        const d = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + jl)));
        const { arrays } = unpack(bytes, d.w * d.h, 1);
        return { w: d.w, h: d.h, v: arrays[0] };
      } finally {
        this.free(pp, pn);
        this.free(a, an);
      }
    });
  }

  /** Start a DSM job (see gw_sar_stereo_new for `prm`) → job id. */
  stereoNew(prm, recA, recB, prior, chipA, chipB) {
    return this.guard(() => {
      const bufs = [this.putF64(prm), this.putF64(sicdRecord(recA)), this.putF64(sicdRecord(recB)), this.putF32(prior), this.putF32(chipA), this.putF32(chipB)];
      try {
        const [[p], [ra], [rb], [pz], [ca], [cb]] = bufs;
        const id = this.x.gw_sar_stereo_new(p, prm.length, ra, recA.length, rb, recB.length, pz, prior.length, ca, chipA.length, cb, chipB.length);
        if (id <= 0) throw new WasmError(-id, this.lastError(), 'stereoNew');
        return id;
      } finally {
        for (const [p, n] of bufs) this.free(p, n);
      }
    });
  }

  /** Run up to n steps of a job; returns its progress (0…1, 1 = done). */
  stereoStep(id, n = 1) {
    return this.guard(() => {
      this.check(this.x.gw_sar_stereo_step(id, n), 'stereoStep');
      return this.x.gw_sar_stereo_progress(id);
    });
  }

  /** Outputs of a finished job: {stats, heights, sigma, score, flags} (Float32Array each). */
  stereoResult(id, posts) {
    return this.guard(() => {
      this.check(this.x.gw_sar_stereo_result(id), 'stereoResult');
      const bytes = this.outBytes();
      const { json, arrays } = unpack(bytes, posts, 4);
      return { stats: json, heights: arrays[0], sigma: arrays[1], score: arrays[2], flags: arrays[3] };
    });
  }

  stereoFree(id) {
    this.x.gw_sar_stereo_free(id);
  }
}
