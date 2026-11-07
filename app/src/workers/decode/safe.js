// Sentinel-1 SAFE in the decode worker (FC-26, REQ-FMT-55): the `legacy` bundle parses the manifest and
// the annotation, calibration and noise XML; this module turns the calibration vectors into the β⁰, σ⁰
// and γ⁰ scale factors of a window (bilinear in line and pixel, as ESA's toolbox does) and the noise
// vectors into the thermal-noise power to remove (range LUT × azimuth LUT), for `sicdSource`'s
// calibrated bands: value = (|DN|² − η) / A².

import { gwError } from '../../i18n/index.js';
import { wasmError, nested } from '../errors.js';

const KIND = { manifest: 1, annotation: 2, calibration: 3, noise: 4 };

/** One SAFE XML document → its JSON (kind: manifest | annotation | calibration | noise). */
export function safeXml(B, kind, bytes) {
  const [p, n] = B.put(bytes);
  try {
    if (B.x.gw_safe_xml(KIND[kind], p, n) !== 0) throw gwError('Sentinel-1 {kind}: {msg}', { kind, msg: nested(wasmError(B)) });
    return B.outJson();
  } finally {
    B.free(p, n);
  }
}

/** Interval index i (nodes[i] ≤ v < nodes[i+1], clamped) and weight t of v. */
function locate(nodes, v) {
  let lo = 0;
  let hi = nodes.length - 1;
  if (hi <= 0) return [0, 0];
  if (v <= nodes[0]) return [0, 0];
  if (v >= nodes[hi]) return [hi - 1, 1];
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (nodes[m] <= v) lo = m;
    else hi = m;
  }
  return [lo, (v - nodes[lo]) / (nodes[lo + 1] - nodes[lo])];
}

/**
 * Calibration (and noise) JSON → {beta0, sigma0, gamma0, noise}: each a function (x0, y0, w, h, sc, half)
 * of a window of level 2^L (sample (x0 + i)·sc + half of the full image) → Float32Array of w·h values:
 * 1/A² for the calibrated bands, η for the noise.
 */
export function s1Luts(cal, noise) {
  const L = cal.lines;
  const P = cal.pixels;
  const np = P.length;
  const field = (lut) => (x0, y0, w, h, sc = 1, half = 0) => {
    const out = new Float32Array(w * h);
    const cols = new Array(w);
    for (let i = 0; i < w; i++) cols[i] = locate(P, (x0 + i) * sc + half);
    for (let j = 0; j < h; j++) {
      const [r, u] = locate(L, (y0 + j) * sc + half);
      const a = r * np;
      const b = Math.min(L.length - 1, r + 1) * np;
      for (let i = 0; i < w; i++) {
        const [k, t] = cols[i];
        const k1 = Math.min(np - 1, k + 1);
        const v = (1 - u) * ((1 - t) * lut[a + k] + t * lut[a + k1]) + u * ((1 - t) * lut[b + k] + t * lut[b + k1]);
        out[j * w + i] = 1 / (v * v);
      }
    }
    return out;
  };
  return { beta0: field(cal.beta), sigma0: field(cal.sigma), gamma0: field(cal.gamma), noise: noise ? noiseField(noise) : null, absolute: cal.absolute };
}

/** Thermal noise η at window samples: the range vectors (interpolated in line and pixel) × the azimuth block's LUT. */
function noiseField(nz) {
  const rv = nz.range.filter((v) => Number.isFinite(v.line) && v.pixels.length >= 2);
  if (!rv.length) return null;
  const rl = rv.map((v) => v.line);
  const at = (v, x) => {
    const [k, t] = locate(v.pixels, x);
    return (1 - t) * v.values[k] + t * v.values[Math.min(v.values.length - 1, k + 1)];
  };
  const blocks = nz.azimuth ?? [];
  return (x0, y0, w, h, sc = 1, half = 0) => {
    const out = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      const y = (y0 + j) * sc + half;
      const [r, u] = locate(rl, y);
      const a = rv[r];
      const b = rv[Math.min(rv.length - 1, r + 1)];
      for (let i = 0; i < w; i++) {
        const x = (x0 + i) * sc + half;
        let n = (1 - u) * at(a, x) + u * at(b, x);
        if (blocks.length) {
          const blk = blocks.find((q) => y >= q.firstAzimuthLine && y <= q.lastAzimuthLine && x >= q.firstRangeSample && x <= q.lastRangeSample);
          if (blk) {
            const [k, t] = locate(blk.lines, y);
            n *= (1 - t) * blk.values[k] + t * blk.values[Math.min(blk.values.length - 1, k + 1)];
          }
        }
        out[j * w + i] = n;
      }
    }
    return out;
  };
}

/** The radiometry record the SAR tools read (features/sar.js viewAvailable). */
export function s1Radiometry(luts) {
  return { beta0: true, sigma0: true, gamma0: true, noise: null, derived: { beta0: 'file', sigma0: 'file', gamma0: 'file' }, reason: null, note: `Sentinel-1 calibration look-up tables${luts.noise ? ', thermal noise removed' : ''}`, lut: true };
}
