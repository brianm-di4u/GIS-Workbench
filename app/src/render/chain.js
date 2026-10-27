// Image chain model (REQ-IMG-04..07). The chain is a small JSON object recorded in the
// project, chips and measurement rows. All point operations of a band (stretch S7, tone S8,
// invert) fold into one 65 536-entry LUT; the shader maps DN → LUT index → display value.
// DOM-free and deterministic, so it is unit-tested in Node.

export const KERNELS = ['nearest', 'bilinear', 'bicubic', 'lanczos3'];
export const STRETCHES = [
  ['dra', 'DRA (SIPS)'],
  ['minmax', 'Min/max'],
  ['linear1', 'Linear 1%'],
  ['linear2', 'Linear 2%'],
  ['std', 'Normalization (±2.5σ)'],
  ['sqrt', 'Square root'],
  ['equalize', 'Equalization'],
  ['none', 'None (full range)'],
  ['manual', 'Manual (histogram editor)'],
];
export const PALETTES = ['grey', 'viridis', 'whitehot', 'blackhot', 'iron', 'diverging', 'terrain', 'cyclic'];
/** SAR display remaps (REQ-SAR-03, sarpy `remap.py` formulas, `Research/09` §4.2). */
export const SAR_REMAPS = [
  ['sar-density', 'Density'],
  ['sar-brighter', 'Brighter'],
  ['sar-darker', 'Darker'],
  ['sar-highcontrast', 'High-Contrast'],
  ['sar-linear', 'Linear'],
  ['sar-log', 'Logarithmic'],
  ['sar-pedf', 'PEDF'],
  ['sar-nrl', 'NRL (linear-log)'],
];
const DENSITY = { 'sar-density': [30, 40], 'sar-brighter': [60, 40], 'sar-darker': [0, 40], 'sar-highcontrast': [30, 4], 'sar-pedf': [30, 40] };

/**
 * The remap of one amplitude A (0–255 output, before tone) from global statistics st =
 * {mean, min, max, minNonZero, p99} of the image's amplitude (computed once from the overview).
 */
export function sarRemap(kind, A, st) {
  const clip = (v) => Math.min(255, Math.max(0, v));
  if (!(A >= 0)) return 0;
  if (DENSITY[kind]) {
    const [dmin, mmult] = DENSITY[kind];
    const cl = 0.8 * st.mean;
    const ch = mmult * cl;
    const slope = (255 - dmin) / Math.log10(ch / cl);
    const c = dmin - slope * Math.log10(cl);
    let d = clip(slope * Math.log10(Math.max(A, 1e-5)) + c);
    if (kind === 'sar-pedf' && d > 127.5) d = 0.5 * (d + 127.5);
    return d;
  }
  if (kind === 'sar-linear') return st.max > st.min ? 255 * Math.min(1, Math.max(0, (A - st.min) / (st.max - st.min))) : 0;
  if (kind === 'sar-log') {
    if (A === 0) return 0;
    const lo = st.minNonZero;
    const hi = st.max;
    if (!(hi > lo)) return 0;
    return clip(255 * Math.log2(Math.min(1, Math.max(0, (A - lo) / (hi - lo))) + 1));
  }
  if (kind === 'sar-nrl') {
    const knee = 0.8 * 255;
    const { min, max, p99: c } = st;
    if (!(max > min)) return 0;
    if (A <= c) return c > min ? clip(knee * Math.min(1, Math.max(0, (A - min) / (c - min)))) : 0;
    return max > c ? clip(knee + (255 - knee) * Math.log2(Math.min(1, (A - c) / (max - c)) + 1)) : 255;
  }
  return 0;
}

/** Global amplitude statistics for the remaps from the band-0 histogram. */
export function sarStats(h) {
  if (!h?.count) return { mean: 1, min: 0, max: 1, minNonZero: 0, p99: 1 };
  let s = 0;
  let nz = null;
  for (let i = 0; i < h.bins.length; i++) {
    if (!h.bins[i]) continue;
    const v = binValue(h, i);
    s += v * h.bins[i];
    if (nz === null && v > 0) nz = v;
  }
  return { mean: s / h.count, min: percentile(h, 0), max: percentile(h, 1), minNonZero: nz ?? 0, p99: percentile(h, 0.99) };
}
export const FILTERS = [
  ['none', 'No filter'],
  ['sharpen', 'Laplacian sharpen'],
  ['smooth', 'Smooth (Gaussian)'],
  ['edge', 'Edge (Sobel)'],
  ['median', 'Median 3×3'],
  ['dilate', 'Dilate (max)'],
  ['erode', 'Erode (min)'],
  ['mtf', 'MTF compensation (5×5 kernel)'],
];
const NO_FILTER = { op: 'none', size: 3, strength: 1, mtf: null };

/** Fill fields that older chains (projects, chips) lack. Returns the same object. */
export function normalizeChain(c) {
  if (!c) return c;
  c.filter = { ...NO_FILTER, ...(c.filter ?? {}) };
  c.sharpen = { usm: 0, ...(c.sharpen ?? {}) };
  c.tone = { gamma: 0, brightness: 0, contrast: 0, invert: false, curve: null, ...(c.tone ?? {}) };
  c.clip = { on: false, lo: 0, hi: 65535, ...(c.clip ?? {}) };
  c.dem = { mode: 'none', az: 315, el: 45, z: 1, contour: 0, ...(c.dem ?? {}) };
  c.enabled = { stretch: true, tone: true, colour: true, sharpen: true, ...(c.enabled ?? {}) };
  return c;
}

const gauss = (r, sigma) => {
  const k = new Float32Array(25);
  let sum = 0;
  for (let y = -2; y <= 2; y++)
    for (let x = -2; x <= 2; x++) {
      if (Math.abs(x) > r || Math.abs(y) > r) continue;
      const w = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
      k[(y + 2) * 5 + x + 2] = w;
      sum += w;
    }
  for (let i = 0; i < 25; i++) k[i] /= sum;
  return k;
};

/**
 * The S6 stage as shader parameters: {mode, radius, k} with mode 0 none, 1 linear 5×5 kernel,
 * 2 median, 3 dilate, 4 erode, 5 Sobel. The sharpness slider (USM, amount a) adds
 * a·(δ − G) in parallel to a linear filter; a negative amount softens. Nonlinear filters
 * ignore the slider.
 */
export function filterKernel(chain) {
  const f = { ...NO_FILTER, ...(chain.filter ?? {}) };
  // DEM display modes and contours need the filtered program (neighbour reads).
  const demOn = chain.dem && (chain.dem.mode !== 'none' || chain.dem.contour > 0);
  const claheOn = !!chain.clahe?.on;
  const on = chain.enabled?.sharpen !== false;
  const a = on ? (chain.sharpen?.usm ?? 0) : 0;
  const r = f.size >= 5 ? 2 : 1;
  // SAR speckle preview on the GPU (REQ-SAR-07): the window radius up to 4 (9 × 9).
  const sf = chain.sarFilter;
  const sarMode = sf && { mean: 6, lee: 7, kuan: 8, gammamap: 9, frost: 10, refinedlee: 11 }[sf.op];
  if (on && sarMode) return { mode: sarMode, radius: Math.min(4, Math.max(1, Math.floor((sf.win ?? 7) / 2))), k: new Float32Array(25), label: `speckle ${sf.op}`, looks: sf.looks ?? 1, damping: sf.damping ?? 2 };
  if (on && sf?.op === 'median') return { mode: 2, radius: 1, k: new Float32Array(25), label: 'speckle median' };
  const nonlinear = { median: 2, dilate: 3, erode: 4, edge: 5 }[f.op];
  if (on && nonlinear) return { mode: nonlinear, radius: r, k: new Float32Array(25), label: f.op };
  const k = new Float32Array(25);
  k[12] = 1;
  let linear = false;
  if (on && f.op === 'smooth') {
    k.set(gauss(r, r === 2 ? 1.2 : 0.8));
    linear = true;
  } else if (on && f.op === 'sharpen') {
    const s = f.strength ?? 1;
    k[12] = 1 + 4 * s;
    k[7] = k[11] = k[13] = k[17] = -s;
    linear = true;
  } else if (on && f.op === 'mtf' && Array.isArray(f.mtf) && f.mtf.length === 25) {
    k.set(f.mtf.map(Number));
    linear = true;
  }
  if (a) {
    const g = gauss(2, 1);
    const amt = Math.max(-1, a);
    for (let i = 0; i < 25; i++) k[i] += amt * ((i === 12 ? 1 : 0) - g[i]);
    linear = true;
  }
  if (linear) return { mode: 1, radius: 2, k, label: f.op === 'none' ? (a > 0 ? 'usm' : 'soften') : f.op };
  // DEM modes: no S6 filter, but the filtered program (identity kernel).
  return demOn || claheOn ? { mode: 1, radius: 1, k, label: 'none', dem: demOn } : { mode: 0, radius: 1, k, label: 'none' };
}

/** Piecewise-linear tone curve through control points [[x, y], …] in 0..1 (sorted by x). */
export function applyCurve(u, pts) {
  if (!pts || pts.length < 2) return u;
  if (u <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (u <= x1) {
      const [x0, y0] = pts[i - 1];
      return x1 > x0 ? y0 + ((u - x0) / (x1 - x0)) * (y1 - y0) : y1;
    }
  }
  return pts[pts.length - 1][1];
}

/** Default first-display chain by sensor type and bit depth (REQ-IMG-07, Research/04 §2.13). */
export function autoChain(info) {
  const { bands = 1, sampleType = 'u8', abpp, irep = '', icat = '', bandRoles } = info;
  let sel = [0];
  if (bands >= 3) {
    if (bandRoles) {
      const idx = (r) => bandRoles.findIndex((x) => x === r);
      const r = idx('R');
      const g = idx('G');
      const b = idx('B');
      sel = r >= 0 && g >= 0 && b >= 0 ? [r, g, b] : [0, 1, 2];
    } else sel = [0, 1, 2];
  }
  if (/^(MONO|NODISPLY)$/.test(irep) || bands === 2) sel = [0];
  if (info.sar) sel = [0];
  const isFloat = sampleType === 'f32';
  const highBit = sampleType === 'u16' || sampleType === 'i16' || (abpp && abpp > 8);
  const dem = icat === 'DTEM' || info.kind === 'dem';
  return {
    v: 1,
    bands: sel,
    kernel: 'bicubic',
    stretch: info.sar ? 'sar-density' : dem ? 'linear1' : isFloat ? 'linear1' : highBit || sel.length === 3 ? 'dra' : 'minmax',
    dra: { scope: 'full', lock: false, pmin: 0.02, pmax: 0.98, a: 0.2, b: 0.4, linked: false },
    tone: { gamma: 0, brightness: 0, contrast: 0, invert: false, curve: null },
    colour: { saturation: 0, palette: dem ? 'terrain' : 'grey' },
    sharpen: { usm: 0 }, // the sharpness slider; 0 keeps the bicubic kernel (DN-12)
    filter: { ...NO_FILTER },
    clip: { on: false, lo: 0, hi: 65535 },
    dem: { mode: 'none', az: 315, el: 45, z: 1, contour: 0 },
    voids: true,
    enabled: { stretch: true, tone: true, colour: true, sharpen: true },
    auto: true,
  };
}

/** Ordered stage list for recording (Research/04 §2.2, §2.14). */
export { percentile as histPercentile, meanStd as histMeanStd, binValue as histBinValue };

export function chainRecord(chain) {
  return [
    { stage: 'S3', op: 'band-select', params: { bands: chain.bands } },
    { stage: 'S4', op: 'resample', params: { kernel: chain.kernel } },
    { stage: 'S6', op: filterKernel(chain).label === 'none' ? 'usm' : filterKernel(chain).label, enabled: chain.enabled.sharpen && filterKernel(chain).mode > 0, params: { usm: chain.sharpen?.usm ?? 0, ...(chain.filter ?? NO_FILTER) } },
    { stage: 'S7', op: chain.stretch, enabled: chain.enabled.stretch, params: chain.stretch === 'dra' ? { ...chain.dra } : {} },
    { stage: 'S8', op: 'tone', enabled: chain.enabled.tone, params: { ...chain.tone } },
    { stage: 'S9', op: 'colour', enabled: chain.enabled.colour, params: { ...chain.colour } },
  ];
}

/** One-line summary for the whiteboard context, measurement rows and chips. */
export function chainSummary(chain) {
  const t = chain.tone;
  const parts = [`bands ${chain.bands.map((b) => b + 1).join(',')}`, chain.kernel, chain.enabled.stretch ? chain.stretch : 'no stretch'];
  if (chain.clahe?.on) parts.push(`CLAHE ${chain.clahe.grid ?? 8}×${chain.clahe.grid ?? 8} clip ${chain.clahe.clip ?? 2.5}`);
  if (chain.stretch === 'dra') parts.push(`${chain.dra.scope}${chain.dra.lock ? ' locked' : ''}`);
  if (t.gamma) parts.push(`γ${t.gamma > 0 ? '+' : ''}${t.gamma}`);
  if (t.brightness) parts.push(`B${t.brightness > 0 ? '+' : ''}${t.brightness}`);
  if (t.contrast) parts.push(`C${t.contrast > 0 ? '+' : ''}${t.contrast}`);
  if (t.invert) parts.push('inverted');
  if (t.curve?.length > 2 || (t.curve && (t.curve[0][1] !== 0 || t.curve.at(-1)[1] !== 1))) parts.push('curve');
  const fk = filterKernel(chain);
  if (fk.mode) parts.push(fk.label);
  if (chain.clip?.on) parts.push(`clip ${chain.clip.lo}–${chain.clip.hi}`);
  if (chain.colour.palette !== 'grey' && chain.bands.length === 1) parts.push(chain.colour.palette);
  return parts.join(' · ');
}

// ---- statistics → stretch range ----

/** DN of histogram bin i. */
function binValue(h, i) {
  return h.type === 'f32' ? h.min + (i + 0.5) * h.binWidth : i - h.offset;
}

function cumulative(h) {
  const c = new Float64Array(h.bins.length);
  let s = 0;
  for (let i = 0; i < h.bins.length; i++) {
    s += h.bins[i];
    c[i] = s;
  }
  return c;
}

/** SIPS DRA (Research/04 §2.5): Dmin = max(Amin, Emin − A(Emax − Emin)), Dmax = min(Amax, Emax + B(Emax − Emin)). */
export function draRange(h, { pmin = 0.02, pmax = 0.98, a = 0.2, b = 0.4 } = {}) {
  const n = h.count;
  if (!n) return { dmin: 0, dmax: 1, amin: 0, amax: 1, emin: 0, emax: 1 };
  let ia = 0;
  while (ia < h.bins.length && !h.bins[ia]) ia++;
  let ib = h.bins.length - 1;
  while (ib > 0 && !h.bins[ib]) ib--;
  const c = cumulative(h);
  let ie = 0;
  while (ie < c.length && c[ie] < pmin * n) ie++;
  let iE = 0;
  while (iE < c.length && c[iE] < pmax * n) iE++;
  const amin = binValue(h, ia);
  const amax = binValue(h, ib);
  const emin = binValue(h, ie);
  const emax = binValue(h, iE);
  const dmin = Math.max(amin, emin - a * (emax - emin));
  const dmax = Math.min(amax, emax + b * (emax - emin));
  return { dmin, dmax: dmax > dmin ? dmax : dmin + 1, amin, amax, emin, emax };
}

function percentile(h, p) {
  const c = cumulative(h);
  const want = Math.max(1, p * h.count); // p = 0 → first non-empty bin
  let i = 0;
  while (i < c.length && c[i] < want) i++;
  return binValue(h, Math.min(i, h.bins.length - 1));
}

function meanStd(h) {
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < h.bins.length; i++) {
    if (!h.bins[i]) continue;
    const v = binValue(h, i);
    s += v * h.bins[i];
    s2 += v * v * h.bins[i];
  }
  const m = s / h.count;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / h.count - m * m)) };
}

/** Low/high stretch limits for a band (`band` = source band index, for manual limits). */
export function stretchRange(h, chain, band = 0) {
  if (!h || !h.count) return { lo: 0, hi: h?.type === 'u8' ? 255 : 1 };
  switch (chain.stretch) {
    case 'manual': {
      const m = chain.manual?.[band];
      if (m && Number.isFinite(m.lo) && Number.isFinite(m.hi) && m.hi > m.lo) return { lo: m.lo, hi: m.hi };
      return { lo: percentile(h, 0.02), hi: percentile(h, 0.98) };
    }
    case 'dra': {
      const r = draRange(h, chain.dra);
      return { lo: r.dmin, hi: r.dmax, dra: r };
    }
    case 'minmax':
      return { lo: percentile(h, 0), hi: percentile(h, 1) };
    case 'linear1':
      return { lo: percentile(h, 0.01), hi: percentile(h, 0.99) };
    case 'linear2':
    case 'sqrt':
      return { lo: percentile(h, 0.02), hi: percentile(h, 0.98) };
    case 'std': {
      const { mean, std } = meanStd(h);
      return { lo: mean - 2.5 * std, hi: mean + 2.5 * std };
    }
    case 'phase':
      return { lo: -Math.PI, hi: Math.PI };
    case 'symmetric': {
      // I and Q: a linear stretch symmetric about zero (2nd/98th percentiles).
      const m = Math.max(Math.abs(percentile(h, 0.02)), Math.abs(percentile(h, 0.98))) || 1;
      return { lo: -m, hi: m };
    }
    default:
      return { lo: h.type === 'u8' ? 0 : h.type === 'f32' ? h.min : -h.offset, hi: h.type === 'u8' ? 255 : h.type === 'f32' ? h.max : h.bins.length - 1 - h.offset };
  }
}

// ---- LUT ----

/** DN ↔ LUT index mapping for a band type. Floats map their [min, max] onto 0..65535. */
export function lutDomain(h, type) {
  if (type === 'u8') return { scale: 1, offset: 0, size: 256 };
  if (type === 'u16') return { scale: 1, offset: 0, size: 65536 };
  if (type === 'i16') return { scale: 1, offset: 32768, size: 65536 };
  const min = h?.min ?? 0;
  const max = h?.max ?? 1;
  const scale = 65535 / (max - min || 1);
  return { scale, offset: -min * scale, size: 65536, min, max };
}

function tone(u, t) {
  // Slider values −100..100 → parameters (order: stretch, curve, gamma, contrast, brightness, invert).
  let v = Math.min(1, Math.max(0, u));
  if (t.curve) v = applyCurve(v, t.curve);
  if (t.gamma) {
    const g = 2 ** (t.gamma / 50);
    v = v ** (1 / g);
  }
  if (t.contrast) v = (v - 0.5) * 2 ** (t.contrast / 50) + 0.5;
  if (t.brightness) v += t.brightness / 200;
  v = Math.min(1, Math.max(0, v));
  return t.invert ? 1 - v : v;
}

/**
 * Build the band LUT: Uint8Array(65536) of display values for each LUT index.
 * `h` is the band histogram from the chain's DRA scope.
 */
export function buildLut(h, type, chain, band = 0) {
  const dom = lutDomain(h, type);
  const out = new Uint8Array(65536);
  const { lo, hi } = chain.enabled.stretch ? stretchRange(h, chain, band) : stretchRange(h, { ...chain, stretch: 'none' });
  const t = chain.enabled.tone ? chain.tone : { gamma: 0, brightness: 0, contrast: 0, invert: false };
  let eq = null;
  if (chain.enabled.stretch && chain.stretch === 'equalize' && h?.count) {
    const c = cumulative(h);
    const c0 = c.find((x) => x > 0) ?? 0;
    eq = { c, c0, n: h.count };
  }
  const span = hi - lo || 1;
  const sar = chain.enabled.stretch && String(chain.stretch).startsWith('sar-') ? sarStats(h) : null;
  for (let i = 0; i < dom.size; i++) {
    const dn = (i - dom.offset) / dom.scale;
    let u;
    if (sar) u = sarRemap(chain.stretch, dn, sar) / 255;
    else if (eq) {
      const bi = type === 'f32' ? Math.min(h.bins.length - 1, Math.max(0, Math.floor((dn - h.min) / h.binWidth))) : Math.min(h.bins.length - 1, Math.max(0, Math.round(dn + h.offset)));
      u = (eq.c[bi] - eq.c0) / Math.max(1, eq.n - eq.c0);
    } else {
      u = (dn - lo) / span;
      if (chain.enabled.stretch && chain.stretch === 'sqrt') u = Math.sqrt(Math.max(0, u));
    }
    out[i] = Math.round(tone(u, t) * 255);
  }
  if (dom.size < 65536) out.fill(out[dom.size - 1], dom.size);
  return { lut: out, domain: dom, lo, hi };
}

// ---- palettes (pseudo-colour, S9) ----

function ramp(stops) {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    for (let j = 0; j < 3; j++) out[i * 4 + j] = Math.round(c0[j] + (c1[j] - c0[j]) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function palette(name, table = null) {
  // A class colour table (classification products): entry i is the colour of value i.
  if (Array.isArray(table) && table.length) {
    const out = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const c = table[i] ?? [0, 0, 0];
      out.set([c[0], c[1], c[2], 255], i * 4);
    }
    return out;
  }
  switch (name) {
    case 'viridis':
      return ramp([[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]]);
    case 'whitehot':
      return ramp([[0, [0, 0, 0]], [1, [255, 255, 255]]]);
    case 'blackhot':
      return ramp([[0, [255, 255, 255]], [1, [0, 0, 0]]]);
    case 'iron':
      return ramp([[0, [0, 0, 20]], [0.3, [80, 0, 130]], [0.6, [220, 60, 30]], [0.85, [250, 180, 30]], [1, [255, 255, 230]]]);
    case 'diverging':
      return ramp([[0, [5, 48, 180]], [0.5, [247, 247, 247]], [1, [178, 24, 43]]]);
    case 'cyclic':
      // Phase: hue around the colour circle (red at ±π), so wrapping is seamless.
      return ramp([[0, [0, 255, 255]], [1 / 6, [0, 0, 255]], [2 / 6, [255, 0, 255]], [3 / 6, [255, 0, 0]], [4 / 6, [255, 255, 0]], [5 / 6, [0, 255, 0]], [1, [0, 255, 255]]]);
    case 'terrain':
      return ramp([[0, [40, 80, 160]], [0.15, [80, 160, 90]], [0.4, [200, 200, 110]], [0.7, [140, 100, 60]], [1, [250, 250, 250]]]);
    default:
      return ramp([[0, [0, 0, 0]], [1, [255, 255, 255]]]);
  }
}

/** Viewport-scope histogram from CPU-cached tile data (every `step`-th pixel). */
export function histogramFromArrays(arrays, type, nodata, base, step = 4) {
  const isNd = nodata === null || nodata === undefined ? (v) => Number.isNaN(v) : Number.isNaN(nodata) ? (v) => Number.isNaN(v) : (v) => v === nodata;
  if (type === 'f32') {
    const bins = new Uint32Array(base?.bins.length ?? 4096);
    const min = base?.min ?? 0;
    const bw = base?.binWidth ?? 1 / 4096;
    let count = 0;
    for (const a of arrays)
      for (let i = 0; i < a.length; i += step) {
        const v = a[i];
        if (isNd(v) || !Number.isFinite(v)) continue;
        bins[Math.min(bins.length - 1, Math.max(0, Math.floor((v - min) / bw)))]++;
        count++;
      }
    return { bins, offset: 0, min, max: base?.max ?? 1, binWidth: bw, count, type };
  }
  const n = type === 'u8' ? 256 : 65536;
  const off = type === 'i16' ? 32768 : 0;
  const bins = new Uint32Array(n);
  let count = 0;
  for (const a of arrays)
    for (let i = 0; i < a.length; i += step) {
      const v = a[i];
      if (isNd(v)) continue;
      bins[v + off]++;
      count++;
    }
  return { bins, offset: off, min: -off, binWidth: 1, count, type };
}
