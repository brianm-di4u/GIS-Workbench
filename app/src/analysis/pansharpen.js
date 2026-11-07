// Pan-sharpening plan (REQ-GAP-14): sensor band weights, the statistics → parameters step of each
// method, the quality figures, tile extents and the flat tile specs of the Rust `raster` bundle
// (crates/gw-raster/src/pansharp.rs, TileSpec). Pure functions: the app (features/pansharpen.js)
// and the oracle script (build/campaign/s24-pansharpen.mjs) share them.
//
// Weights are the overlap of each multispectral band's nominal band-pass with the pan band-pass
// (rectangular approximations of the published band edges, normalised to sum 1); they are a
// starting point, editable in the dialog, and the run reports how well the simulated pan they
// give correlates with the pan degraded to the MS grid. "Estimated" weights are a non-negative
// least-squares fit of the degraded pan on the MS bands (Aiazzi et al.'s GSA idea).

export const METHODS = ['brovey', 'gs', 'pca', 'ehlers', 'hcs'];
const CODE = { brovey: 0, gs: 1, pca: 2, ehlers: 3, hcs: 4 };

/** Nominal band-passes (nm) and pan; `order` names the bands as a standard product stores them. */
export const SENSORS = {
  wv3: { name: 'WorldView-3', pan: [450, 800], bands: { C: [400, 450], B: [450, 510], G: [510, 580], Y: [585, 625], R: [630, 690], RE: [705, 745], N: [770, 895], N2: [860, 1040] }, order: { 8: ['C', 'B', 'G', 'Y', 'R', 'RE', 'N', 'N2'], 4: ['B', 'G', 'R', 'N'] }, ratio: 4 },
  wv2: { name: 'WorldView-2', pan: [450, 800], bands: { C: [400, 450], B: [450, 510], G: [510, 580], Y: [585, 625], R: [630, 690], RE: [705, 745], N: [770, 895], N2: [860, 1040] }, order: { 8: ['C', 'B', 'G', 'Y', 'R', 'RE', 'N', 'N2'], 4: ['B', 'G', 'R', 'N'] }, ratio: 4 },
  ge1: { name: 'GeoEye-1', pan: [450, 800], bands: { B: [450, 510], G: [510, 580], R: [655, 690], N: [780, 920] }, order: { 4: ['B', 'G', 'R', 'N'], 3: ['R', 'G', 'B'] }, ratio: 4 },
  phr: { name: 'Pléiades 1A/1B', pan: [480, 830], bands: { B: [430, 550], G: [490, 610], R: [600, 720], N: [750, 950] }, order: { 4: ['B', 'G', 'R', 'N'], 3: ['R', 'G', 'B'] }, ratio: 4 },
  oli: { name: 'Landsat 8/9 OLI', pan: [500, 680], bands: { B1: [430, 450], B2: [450, 510], B3: [530, 590], B4: [640, 670], B5: [850, 880], B6: [1570, 1650], B7: [2110, 2290] }, order: { 7: ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'], 4: ['B2', 'B3', 'B4', 'B5'], 3: ['B4', 'B3', 'B2'] }, ratio: 2 },
  // Sentinel-2 MSI has no panchromatic band: no weights (the dialog says so).
  s2: { name: 'Sentinel-2 MSI', pan: null, bands: {}, order: {}, ratio: null },
};

/** The sensor of a layer from its metadata and file name, or null. */
export function detectSensor(text) {
  const s = String(text ?? '');
  if (/WV0?3|WORLDVIEW-?3/i.test(s)) return 'wv3';
  if (/WV0?2|WORLDVIEW-?2/i.test(s)) return 'wv2';
  if (/GE0?1|GEOEYE-?1/i.test(s)) return 'ge1';
  if (/PHR1[AB]|PLEIADES|PLÉIADES|IMG_PHR/i.test(s)) return 'phr';
  if (/\bL[CO]0?[89]\b|L[CO]0[89]_|LANDSAT[ _-]?[89]|\bOLI\b/i.test(s)) return 'oli';
  if (/\bS2[AB]\b|S2[AB]_MSI|SENTINEL-?2/i.test(s)) return 's2';
  return null;
}

/** Band-pass overlap weights of `sensor` for an image of `nb` bands → {weights, names, q4} or null. */
export function sensorWeights(sensor, nb) {
  const S = SENSORS[sensor];
  const names = S?.order?.[nb];
  if (!S?.pan || !names) return null;
  const ov = names.map((n) => {
    const [a, b] = S.bands[n];
    return Math.max(0, Math.min(b, S.pan[1]) - Math.max(a, S.pan[0]));
  });
  const sum = ov.reduce((s, v) => s + v, 0);
  if (!sum) return null;
  const idx = (n) => names.indexOf(n);
  const q4 = nb > 4 && ['B', 'G', 'R', 'N'].every((n) => idx(n) >= 0) ? ['B', 'G', 'R', 'N'].map(idx) : null;
  return { weights: ov.map((v) => v / sum), names, q4 };
}

// ---- statistics ----
export const statsLen = (nb) => 1 + nb + nb * nb + 2 + nb + 2 + 4;
export const qualityLen = (nb) => 1 + 2 * nb + 6;

/** Moments of an accumulator: {n, mu, C (nb × nb), muP, varP, cmp (cov(m, p)), muI2, varI2, fine {mu, var, mu2, var2}}. */
export function moments(S, nb) {
  const n = S[0];
  const mu = Array.from({ length: nb }, (_, k) => S[1 + k] / n);
  const C = Array.from({ length: nb }, (_, k) => Array.from({ length: nb }, (_, j) => S[1 + nb + k * nb + j] / n - mu[k] * mu[j]));
  const o = 1 + nb + nb * nb;
  const muP = S[o] / n;
  const varP = S[o + 1] / n - muP * muP;
  const cmp = mu.map((m, k) => S[o + 2 + k] / n - m * muP);
  const oi = o + 2 + nb;
  const muI2 = S[oi] / n;
  const varI2 = S[oi + 1] / n - muI2 * muI2;
  const of = oi + 2;
  const nf = S[of];
  const fm = S[of + 1] / nf;
  const fm2 = S[of + 2] / nf;
  return { n, mu, C, muP, varP, cmp, muI2, varI2, fine: { n: nf, mu: fm, var: fm2 - fm * fm, mu2: fm2, var2: S[of + 3] / nf - fm2 * fm2 } };
}

/** Eigen-decomposition of a symmetric matrix (cyclic Jacobi) → {values (descending), vectors (columns)}. */
export function eigSym(A) {
  const n = A.length;
  const a = A.map((r) => r.slice());
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-22 * Math.max(1, a.reduce((s, r, i) => s + r[i] * r[i], 0))) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const tt = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(tt * tt + 1);
        const s = tt * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const order = [...Array(n).keys()].sort((i, j) => a[j][j] - a[i][i]);
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => v.map((r) => r[i])) };
}

/** Solve A x = b (Gaussian elimination with partial pivoting); null when singular. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * Non-negative least squares of the degraded pan on the MS bands (no intercept) from an
 * accumulator, normalised to sum 1 → weights (Lawson–Hanson active set on the normal equations).
 */
export function estimateWeights(S, nb) {
  const n = S[0];
  const G = Array.from({ length: nb }, (_, k) => Array.from({ length: nb }, (_, j) => S[1 + nb + k * nb + j] / n));
  const o = 1 + nb + nb * nb;
  const h = Array.from({ length: nb }, (_, k) => S[o + 2 + k] / n);
  let free = new Set([...Array(nb).keys()]);
  let x = new Array(nb).fill(0);
  for (let it = 0; it < 4 * nb; it++) {
    const idx = [...free];
    const sol = idx.length ? solve(idx.map((i) => idx.map((j) => G[i][j])), idx.map((i) => h[i])) : [];
    if (!sol) break;
    const neg = idx.filter((_, k) => sol[k] < 0);
    x = new Array(nb).fill(0);
    idx.forEach((i, k) => (x[i] = Math.max(0, sol[k])));
    if (!neg.length) break;
    // Drop the most negative and refit.
    const worst = idx[sol.indexOf(Math.min(...sol))];
    free = new Set(idx.filter((i) => i !== worst));
  }
  const s = x.reduce((a, b) => a + b, 0);
  return s > 0 ? x.map((v) => v / s) : new Array(nb).fill(1 / nb);
}

/** Correlation of the simulated pan Σ w m with the degraded pan, from an accumulator. */
export function simulatedPanFit(S, nb, w) {
  const M = moments(S, nb);
  const Cw = M.C.map((r) => r.reduce((s, c, j) => s + c * w[j], 0));
  const varI = w.reduce((s, x, k) => s + x * Cw[k], 0);
  const cov = w.reduce((s, x, k) => s + x * M.cmp[k], 0);
  return cov / Math.sqrt(Math.max(1e-300, varI * M.varP));
}

/** Default Ehlers band triples: (0,1,2), (3,4,5), … with the last filled from the bands before it. */
export function ehlersTriples(nb) {
  if (nb < 3) return [];
  const out = [];
  for (let k = 0; k < nb; k += 3) out.push(k + 3 <= nb ? [k, k + 1, k + 2] : [nb - 3, nb - 2, nb - 1]);
  return out;
}

/**
 * Parameters of a method from a statistics accumulator (S1 for the product, S2 for Wald's reduced
 * scale) → {method, c, c0, g, aP, bP, a2, b2, triples [[i, j, k, aP, bP]], rc, beta, box}.
 */
export function planParams(S, nb, method, weights, r, { triples = ehlersTriples(nb), beta = 0.5 } = {}) {
  const M = moments(S, nb);
  const w = weights;
  const base = { method, c: w.slice(), c0: 0, g: new Array(nb).fill(0), aP: 0, bP: 0, a2: 0, b2: 0, triples: [], rc: 0.5 / r, beta, box: 2 * r - 1 };
  const sdP = Math.sqrt(Math.max(1e-300, M.fine.var));
  if (method === 'brovey') return base;
  if (method === 'gs') {
    const Cw = M.C.map((row) => row.reduce((s, c, j) => s + c * w[j], 0));
    const varI = Math.max(1e-300, w.reduce((s, x, k) => s + x * Cw[k], 0));
    const muI = w.reduce((s, x, k) => s + x * M.mu[k], 0);
    const aP = Math.sqrt(varI) / sdP;
    return { ...base, g: Cw.map((v) => v / varI), aP, bP: muI - aP * M.fine.mu };
  }
  if (method === 'pca') {
    const { values, vectors } = eigSym(M.C);
    let v1 = vectors[0];
    if (v1.reduce((s, x, k) => s + x * M.cmp[k], 0) < 0) v1 = v1.map((x) => -x);
    const aP = Math.sqrt(Math.max(0, values[0])) / sdP;
    return { ...base, c: v1, c0: -v1.reduce((s, x, k) => s + x * M.mu[k], 0), g: v1, aP, bP: -aP * M.fine.mu };
  }
  if (method === 'hcs') {
    const a2 = Math.sqrt(Math.max(0, M.varI2) / Math.max(1e-300, M.fine.var2));
    return { ...base, a2, b2: M.muI2 - a2 * M.fine.mu2 };
  }
  if (method === 'ehlers') {
    const tr = triples.map((t) => {
      const mu = t.reduce((s, k) => s + M.mu[k], 0) / 3;
      let v = 0;
      for (const i of t) for (const j of t) v += M.C[i][j];
      const aP = Math.sqrt(Math.max(0, v / 9)) / sdP;
      return [...t, aP, mu - aP * M.fine.mu];
    });
    return { ...base, triples: tr };
  }
  throw new Error(`unknown pan-sharpening method ${method}`);
}

/** ERGAS, SAM (degrees), Q2ⁿ, Q4 of a quality accumulator (r: the resolution ratio). */
export function qualityOf(acc, nb, r) {
  const n = Math.max(1, acc[0]);
  let s = 0;
  const rmse = [];
  for (let k = 0; k < nb; k++) {
    const m = acc[1 + k] / n;
    const e = acc[1 + nb + k] / n;
    rmse.push(Math.sqrt(e));
    s += e / Math.max(1e-300, m * m);
  }
  const ergas = (100 / r) * Math.sqrt(s / nb);
  const sam = acc[1 + 2 * nb] / Math.max(1, acc[2 + 2 * nb]);
  const q = acc[4 + 2 * nb] > 0 ? acc[3 + 2 * nb] / acc[4 + 2 * nb] : NaN;
  const q4 = acc[6 + 2 * nb] > 0 ? acc[5 + 2 * nb] / acc[6 + 2 * nb] : NaN;
  return { ergas, sam, q, q4, rmse, samples: acc[0], blocks: acc[4 + 2 * nb] };
}

// ---- extents ----
export const sigmaFor = (r, g) => (r * Math.sqrt(-2 * Math.log(Math.min(0.999, Math.max(1e-3, g))))) / Math.PI;
export const degradeRadius = (r, g) => Math.ceil(3 * sigmaFor(r, g)) + r;
export const methodApron = (method, r) => (method === 'ehlers' ? 32 : method === 'hcs' ? r : 0);
export const glApron = (method, r, g) => Math.ceil((methodApron(method, r) + 3 * r + degradeRadius(r, g)) / r) * r;

/** A rectangle {x0, y0, w, h} grown by m on every side and clamped to [0, W) × [0, H). */
export function grow(rc, m, W, H) {
  const x0 = Math.max(0, rc.x0 - m);
  const y0 = Math.max(0, rc.y0 - m);
  return { x0, y0, w: Math.max(0, Math.min(W, rc.x0 + rc.w + m) - x0), h: Math.max(0, Math.min(H, rc.y0 + rc.h + m) - y0) };
}

/** MS pixels a pan corner rectangle (pan pixels) reaches through affine `a`, with a kernel margin. */
export function msBox(a, rc, MW, MH, margin = 3) {
  const xs = [];
  const ys = [];
  for (const [X, Y] of [[rc.x0, rc.y0], [rc.x0 + rc.w, rc.y0], [rc.x0, rc.y0 + rc.h], [rc.x0 + rc.w, rc.y0 + rc.h]]) {
    xs.push(a[0] + a[1] * X + a[2] * Y);
    ys.push(a[3] + a[4] * X + a[5] * Y);
  }
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - margin);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - margin);
  const x1 = Math.min(MW, Math.ceil(Math.max(...xs)) + margin);
  const y1 = Math.min(MH, Math.ceil(Math.max(...ys)) + margin);
  return { x0, y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Patches of a fusion tile (core in pan pixels) → {pan, ms}. */
export function fuseExtents(job, core) {
  const R = job.quality ? degradeRadius(job.r, job.gnyq) : 0;
  const pan = grow(grow(core, R, job.pw, job.ph), methodApron(job.method, job.r), job.pw, job.ph);
  return { pan, ms: msBox(job.affine, pan, job.mw, job.mh) };
}

/** Patches of a statistics (and Wald) tile (core in G_L samples) → {pan, ms, e}. */
export function statsExtents(job, core) {
  const { r } = job;
  const GW = Math.ceil(job.pw / r);
  const GH = Math.ceil(job.ph / r);
  const e = grow(core, glApron(job.method, r, job.gnyq), GW, GH);
  const fine = { x0: e.x0 * r, y0: e.y0 * r, w: e.w * r, h: e.h * r };
  const pan = grow(fine, degradeRadius(r, job.gnyq), job.pw, job.ph);
  return { pan, ms: msBox(job.affine, fine, job.mw, job.mh), e };
}

const TYPE_CODE = { f32: 0, u8: 1, u16: 2, i16: 3 };

/**
 * The flat spec of one tile for the Rust bundle. `job` = {nb, r, kernel ('bilinear'|'cubic'),
 * gnyq, mw, mh, pw, ph, affine [6], type, max, roundMs, quality, q4, method}; `p` = planParams.
 */
export function tileSpec(job, p, { ms, src, core }) {
  const head = [1, job.nb, job.r, job.kernel === 'cubic' ? 2 : job.kernel === 'nearest' ? 0 : 1, job.gnyq, job.mw, job.mh, job.pw, job.ph, ...job.affine, ms.x0, ms.y0, ms.w, ms.h, src.x0, src.y0, src.w, src.h, core.x0, core.y0, core.w, core.h, TYPE_CODE[job.type] ?? 0, job.max ?? 0, job.roundMs ? 1 : 0, job.quality ? 1 : 0, ...(job.q4 ?? [-1, -1, -1, -1]), 0];
  const tr = p.triples.flatMap((t) => t);
  return Float64Array.from([...head, CODE[p.method], ...p.c, p.c0, ...p.g, p.aP, p.bP, p.a2, p.b2, p.triples.length, ...tr, p.rc, p.beta, p.box]);
}

/** Pan pixel → MS pixel affine (corner coordinates) of two geotransforms in one CRS. */
export function affineFromGeotransforms(panGt, msGt) {
  // pan pixel (X, Y) → map (x, y) → MS pixel (u, v).
  const [x0, dx, rx, y0, ry, dy] = msGt;
  const det = dx * dy - rx * ry;
  const inv = [(dy * 1) / det, (-rx * 1) / det, (-ry * 1) / det, (dx * 1) / det];
  const [px0, pdx, prx, py0, pry, pdy] = panGt;
  // map = (px0 + pdx X + prx Y, py0 + pry X + pdy Y); u = inv · (map − (x0, y0)).
  const ax = [px0 - x0, pdx, prx];
  const ay = [py0 - y0, pry, pdy];
  return [inv[0] * ax[0] + inv[1] * ay[0], inv[0] * ax[1] + inv[1] * ay[1], inv[0] * ax[2] + inv[1] * ay[2], inv[2] * ax[0] + inv[3] * ay[0], inv[2] * ax[1] + inv[3] * ay[1], inv[2] * ax[2] + inv[3] * ay[2]];
}

/** Least-squares affine (6 numbers, u = a0 + a1 X + a2 Y; v = a3 + a4 X + a5 Y) from point pairs [{X, Y, u, v}]. */
export function fitAffine(pairs) {
  const N = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const bu = [0, 0, 0];
  const bv = [0, 0, 0];
  for (const p of pairs) {
    const row = [1, p.X, p.Y];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) N[i][j] += row[i] * row[j];
      bu[i] += row[i] * p.u;
      bv[i] += row[i] * p.v;
    }
  }
  const a = solve(N, bu);
  const b = solve(N, bv);
  if (!a || !b) throw new Error('the two images do not overlap');
  return [...a, ...b];
}

/** The resolution ratio of an affine (MS pixels per pan pixel → pan pixels per MS pixel), rounded. */
export const ratioOf = (a) => Math.round(1 / Math.sqrt(Math.abs(a[1] * a[5] - a[2] * a[4])));

// ---- the passes (shared by the app's workers and the Node oracle) ----
// io = {readPan(rect) → Float32Array, readMs(rect) → Float32Array (bands planar), stats(spec, ms, pan, n),
// wald(spec, ms, panLow), fuse(spec, ms, pan, nq) (the raster bundle's psStats / psWald / psFuse),
// each(items, fn) (bounded concurrency, see eachWith)}.

/** G_L statistics tiles of a product window {x0, y0, w, h} (pan pixels), `tile` samples a side. */
export function statsTiles(job, win, tile = 512) {
  const GW = Math.ceil(job.pw / job.r);
  const GH = Math.ceil(job.ph / job.r);
  const x0 = Math.floor(win.x0 / job.r);
  const y0 = Math.floor(win.y0 / job.r);
  const x1 = Math.min(GW, Math.ceil((win.x0 + win.w) / job.r));
  const y1 = Math.min(GH, Math.ceil((win.y0 + win.h) / job.r));
  const out = [];
  for (let y = y0; y < y1; y += tile) for (let x = x0; x < x1; x += tile) out.push({ x0: x, y0: y, w: Math.min(tile, x1 - x), h: Math.min(tile, y1 - y) });
  return out;
}

/** Parameters with no values: what a statistics tile needs (its method, for the apron). */
export const blankParams = (job) => ({ method: job.method, c: new Array(job.nb).fill(1 / job.nb), c0: 0, g: new Array(job.nb).fill(0), aP: 0, bP: 0, a2: 0, b2: 0, triples: job.method === 'ehlers' ? [[0, 1, 2, 1, 0]] : [], rc: 0.5 / job.r, beta: 0.5, box: 1 });

/** Pass 1 → {S1, S2, lows (Map tile index → degraded pan)}; keeps every `keepEvery`-th degraded pan. */
export async function statsPass(io, job, tiles, { keepEvery = 1, wald = true, progress = () => {} } = {}) {
  const S1 = new Float64Array(statsLen(job.nb));
  const S2 = new Float64Array(statsLen(job.nb));
  const lows = new Map();
  const blank = blankParams(job);
  let done = 0;
  await io.each(tiles, async (core, i) => {
    const ex = statsExtents(job, core);
    const [pp, mp] = await Promise.all([io.readPan(ex.pan), io.readMs(ex.ms)]);
    const out = await io.stats(tileSpec(job, blank, { ms: ex.ms, src: ex.pan, core }), mp, pp, statsLen(job.nb));
    for (let k = 0; k < S1.length; k++) {
      S1[k] += out.s1[k];
      S2[k] += out.s2[k];
    }
    if (wald && i % keepEvery === 0) lows.set(i, out.low);
    progress(++done / tiles.length);
  });
  return { S1, S2, lows };
}

/** Pass 2: Wald's synthesis check on the kept tiles → the quality accumulator. */
export async function waldPass(io, job, P2, tiles, lows, { progress = () => {} } = {}) {
  const Q = new Float64Array(qualityLen(job.nb));
  let done = 0;
  await io.each([...lows.keys()], async (i) => {
    const ex = statsExtents(job, tiles[i]);
    const low = lows.get(i);
    const mp = await io.readMs(ex.ms);
    const q = await io.wald(tileSpec(job, P2, { ms: ex.ms, src: low, core: tiles[i] }), mp, low.px);
    for (let k = 0; k < Q.length; k++) Q[k] += q[k];
    progress(++done / lows.size);
  });
  return Q;
}

/** Pass 3, one product tile (core in pan pixels) → {px (bytes, interleaved), q (consistency accumulator)}. */
export async function fuseCore(io, job, P1, core) {
  const ex = fuseExtents(job, core);
  const [pp, mp] = await Promise.all([io.readPan(ex.pan), io.readMs(ex.ms)]);
  return io.fuse(tileSpec(job, P1, { ms: ex.ms, src: ex.pan, core }), mp, pp, qualityLen(job.nb));
}

/** Bounded concurrency: run fn(item, index) over items, `n` at a time; `stop` is called before each. */
export function eachWith(n, stop = () => {}) {
  return async (items, fn) => {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(n, items.length) }, async () => {
        while (next < items.length) {
          stop();
          const i = next++;
          await fn(items[i], i);
        }
      }),
    );
  };
}
