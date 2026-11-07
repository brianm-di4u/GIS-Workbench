// DSM accuracy report (REQ-GAP-42, GR-15): a DSM's posts against a reference DEM (Copernicus
// GLO-30, 3DEP …), as the 2.4 c60 campaign measured the generic stereo path: bias, median,
// standard deviation, NMAD, RMSE, LE90/LE95, completeness and the masked share, overall and by
// the reference's slope, and how well the DSM's own per-post σ predicts the measured error.
// No DOM: the SAR stereo dialogs, the campaign and the unit tests share it.

/** Height errors (DSM − reference, m) → {n, mean, median, std, nmad, rmse, le90, le95, min, max}, or null. */
export function errorStats(errors) {
  const e = Float64Array.from(errors.filter(Number.isFinite)).sort();
  const n = e.length;
  if (!n) return null;
  let s = 0;
  let s2 = 0;
  for (const v of e) {
    s += v;
    s2 += v * v;
  }
  const mean = s / n;
  const q = (a, p) => a[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  const median = n % 2 ? e[(n - 1) / 2] : 0.5 * (e[n / 2 - 1] + e[n / 2]);
  const dev = Float64Array.from(e, (v) => Math.abs(v - median)).sort();
  const abs = Float64Array.from(e, Math.abs).sort();
  const mad = n % 2 ? dev[(n - 1) / 2] : 0.5 * (dev[n / 2 - 1] + dev[n / 2]);
  return { n, mean, median, std: n > 1 ? Math.sqrt(Math.max(0, (s2 - n * mean * mean) / (n - 1))) : 0, nmad: 1.4826 * mad, rmse: Math.sqrt(s2 / n), le90: q(abs, 0.9), le95: q(abs, 0.95), min: e[0], max: e[n - 1] };
}

/** Post flags of the radargrammetric DSM (gw_sar::radargram::flag). */
export const FLAG = { layoverA: 1, layoverB: 2, shadowA: 4, shadowB: 8, weak: 16, ambiguous: 32, rejected: 64, noData: 128 };
const MASKED = FLAG.layoverA | FLAG.layoverB | FLAG.shadowA | FLAG.shadowB;

/** Slope classes of the reference (degrees). */
export const SLOPE_CLASSES = [
  { id: 'flat', max: 10 },
  { id: 'moderate', max: 25 },
  { id: 'steep', max: 90 },
];

/**
 * The report. dsm: {grid {lat0, lon0, dlat, dlon, nx, ny}, heights (HAE), sigma?, flags?};
 * ref(lat, lon) → reference HAE or NaN. opts.region(lat, lon) → bool limits the posts (an AOI).
 * Returns {posts, covered, matched, completeness, masked {any, layover, shadow, share},
 * rejected {weak, ambiguous, rejected, noData}, error, bySlope {flat, moderate, steep},
 * calibration {n, within1, within2, centredWithin1, centredWithin2, rmsSigma, ratio, centredRatio (NMAD / RMS σ)} | null}.
 */
export function dsmAccuracy(dsm, ref, opts = {}) {
  const { grid: g, heights, sigma, flags } = dsm;
  const n = g.nx * g.ny;
  // Metres per degree at the centre latitude (WGS 84 series).
  const phi = ((g.lat0 - ((g.ny - 1) * g.dlat) / 2) * Math.PI) / 180;
  const kn = 111_132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
  const ke = 111_412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
  const at = (i, j) => [g.lat0 - j * g.dlat, g.lon0 + i * g.dlon];
  const refv = new Float64Array(n).fill(NaN);
  for (let j = 0; j < g.ny; j++)
    for (let i = 0; i < g.nx; i++) {
      const [la, lo] = at(i, j);
      if (opts.region && !opts.region(la, lo)) continue;
      refv[j * g.nx + i] = ref(la, lo);
    }
  const slopeAt = (i, j) => {
    const v = (a, b) => (a >= 0 && b >= 0 && a < g.nx && b < g.ny ? refv[b * g.nx + a] : NaN);
    // Central differences, one-sided where a neighbour has no reference height.
    const d1 = (lo, mid, hi, step) => (Number.isFinite(lo) && Number.isFinite(hi) ? (hi - lo) / (2 * step) : Number.isFinite(hi) ? (hi - mid) / step : (mid - lo) / step);
    const c = v(i, j);
    const dx = d1(v(i - 1, j), c, v(i + 1, j), g.dlon * ke);
    const dy = d1(v(i, j + 1), c, v(i, j - 1), g.dlat * kn);
    return (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
  };
  const errs = [];
  const bySlope = Object.fromEntries(SLOPE_CLASSES.map((c) => [c.id, []]));
  const cal = [];
  let covered = 0;
  const m = { any: 0, layover: 0, shadow: 0 };
  const rej = { weak: 0, ambiguous: 0, rejected: 0, noData: 0 };
  for (let j = 0; j < g.ny; j++)
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      if (!Number.isFinite(refv[k])) continue;
      covered++;
      const f = flags ? flags[k] : 0;
      if (f & MASKED) m.any++;
      if (f & (FLAG.layoverA | FLAG.layoverB)) m.layover++;
      if (f & (FLAG.shadowA | FLAG.shadowB)) m.shadow++;
      if (!(f & MASKED)) {
        if (f === FLAG.weak) rej.weak++;
        else if (f === FLAG.ambiguous) rej.ambiguous++;
        else if (f === FLAG.rejected) rej.rejected++;
        else if (f === FLAG.noData) rej.noData++;
      }
      const h = heights[k];
      if (!Number.isFinite(h)) continue;
      const e = h - refv[k];
      errs.push(e);
      const s = slopeAt(i, j);
      if (Number.isFinite(s)) bySlope[SLOPE_CLASSES.find((c) => s < c.max)?.id ?? 'steep'].push(e);
      const sg = sigma ? sigma[k] : NaN;
      if (Number.isFinite(sg) && sg > 0) cal.push([e, sg]);
    }
  const error = errorStats(errs);
  let calibration = null;
  if (cal.length) {
    // Against the error itself, and about the median error (the random part, when σ leaves out a
    // bias the models do not state).
    const med = error ? error.median : 0;
    let w1 = 0;
    let w2 = 0;
    let c1 = 0;
    let c2 = 0;
    let ss = 0;
    for (const [e, s] of cal) {
      if (Math.abs(e) <= s) w1++;
      if (Math.abs(e) <= 2 * s) w2++;
      if (Math.abs(e - med) <= s) c1++;
      if (Math.abs(e - med) <= 2 * s) c2++;
      ss += s * s;
    }
    const rmsSigma = Math.sqrt(ss / cal.length);
    calibration = { n: cal.length, within1: w1 / cal.length, within2: w2 / cal.length, centredWithin1: c1 / cal.length, centredWithin2: c2 / cal.length, rmsSigma, ratio: error ? error.rmse / rmsSigma : NaN, centredRatio: error ? error.nmad / rmsSigma : NaN };
  }
  return {
    posts: n,
    covered,
    matched: errs.length,
    completeness: covered ? errs.length / covered : 0,
    masked: { ...m, share: covered ? m.any / covered : 0 },
    rejected: rej,
    error,
    bySlope: Object.fromEntries(Object.entries(bySlope).map(([k, v]) => [k, errorStats(v)])),
    calibration,
  };
}

/** One CSV row per statistic group (invariant '.' decimals, for files). */
export function reportCsv(rep, label = '') {
  const cols = ['n', 'mean', 'median', 'std', 'nmad', 'rmse', 'le90', 'le95', 'min', 'max'];
  const row = (name, s) => [label, name, ...cols.map((c) => (s && Number.isFinite(s[c]) ? (c === 'n' ? String(s[c]) : s[c].toFixed(3)) : ''))].join(',');
  const lines = [['dsm', 'group', ...cols].join(','), row('all', rep.error), ...Object.entries(rep.bySlope).map(([k, s]) => row(`slope-${k}`, s))];
  lines.push(`${label},completeness,${rep.completeness.toFixed(4)}`, `${label},masked,${rep.masked.share.toFixed(4)}`);
  if (rep.calibration) lines.push(`${label},within1sigma,${rep.calibration.within1.toFixed(4)}`, `${label},within2sigma,${rep.calibration.within2.toFixed(4)}`);
  if (rep.warning) lines.push(`${label},warning,${rep.warning}`);
  return `${lines.join('\n')}\n`;
}
