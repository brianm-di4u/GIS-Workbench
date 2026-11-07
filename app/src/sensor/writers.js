// Writers for the sensor support data the app reads (REQ-GAP-18, REQ-GAP-23): the RSM TRE family
// and SENSRB as fixed-width text, and the exact RSM form of an RPC00B. They make the synthetic
// test data and conversions the validation uses (docs/validation/2.4/sensor.md); the app itself
// only reads these TREs, so this module stays out of its bundle (tests import it directly).

import { gwError } from '../i18n/index.js';
import { GROUND_IDS, SET_A_FIELDS, rsmFromSection } from './rsm.js';


/** A real in a 21-character field (±d.dddddddddddddE±dd). */
export const f21 = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return ' '.repeat(21);
  const x = Number(v);
  const s = (x < 0 ? '' : '+') + x.toExponential(14).replace(/e([+-])(\d)$/, 'E$10$2').replace('e', 'E');
  return (s.length > 21 ? (x < 0 ? '' : '+') + x.toExponential(13).replace(/e([+-])(\d)$/, 'E$10$2').replace('e', 'E') : s).padStart(21, ' ').slice(0, 21);
};
const pad = (s, n) => String(s ?? '').padEnd(n, ' ').slice(0, n);
const int = (v, n) => {
  const x = Math.round(Number(v));
  if (!Number.isFinite(x)) return ' '.repeat(n);
  const s = String(Math.abs(x)).padStart(x < 0 ? n - 1 : n, '0');
  if (s.length > n - (x < 0 ? 1 : 0)) throw gwError('RSM writer: {v} does not fit {n} digits', { v: String(x), n }, 'E_RSM_WIDTH');
  return x < 0 ? `-${s}` : s;
};
const head = (r, ed = '') => `${pad(r.iid ?? 'GIS WORKBENCH', 80)}${pad(ed, 40)}`;

function writeIda(r, date) {
  return [
    pad(r.iid ?? 'GIS WORKBENCH', 80),
    pad('', 40),
    pad('', 40),
    pad('', 40),
    pad('', 40),
    date.slice(0, 4),
    date.slice(4, 6),
    date.slice(6, 8),
    date.slice(8, 10),
    date.slice(10, 12),
    pad(date.slice(12, 14), 9),
    String(r.rows).padStart(8, '0'),
    String(r.cols).padStart(8, '0'),
    pad('', 21),
    pad('', 21),
    r.domain === 2 ? 'R' : r.domain === 1 ? 'H' : 'G',
    ...(r.domain === 2 ? [...r.origin, ...r.axes].map(f21) : Array(12).fill(pad('', 21))),
    ...Array(24).fill(pad('', 21)),
    ...(r.grp ? r.grp.map(f21) : Array(3).fill(pad('', 21))),
    String(r.rows).padStart(8, '0'),
    String(r.cols).padStart(8, '0'),
    String(r.minr ?? 0).padStart(8, '0'),
    String(Math.max(0, r.rows - 1 + (r.minr ?? 0))).padStart(8, '0'),
    String(r.minc ?? 0).padStart(8, '0'),
    String(Math.max(0, r.cols - 1 + (r.minc ?? 0))).padStart(8, '0'),
    ...Array(12).fill(pad('', 21)),
    ...Array(9).fill(pad('', 21)),
  ].join('');
}

const writePca = (r, s) => `${head(r)}${int(s.rsn, 3)}${int(s.csn, 3)}${f21(s.rfep)}${f21(s.cfep)}${s.off.map(f21).join('')}${s.scale.map(f21).join('')}${s.polys.map((q) => `${q.px}${q.py}${q.pz}${String(q.c.length).padStart(3, '0')}${q.c.map(f21).join('')}`).join('')}`;
const writeIndex = (r, ix) => `${head(r)}${ix.r.map(f21).join('')}${ix.c.map(f21).join('')}${int(ix.rnis, 3)}${int(ix.cnis, 3)}${int(ix.rnis * ix.cnis, 3)}${f21(ix.rssiz)}${f21(ix.cssiz)}`;

function writeGga(r, g) {
  const fr = 3;
  const all = g.planes.flatMap((p) => [...p.row, ...p.col]).filter(Number.isFinite);
  const rows = g.planes.flatMap((p) => p.row).filter(Number.isFinite);
  const cols = g.planes.flatMap((p) => p.col).filter(Number.isFinite);
  if (!all.length) throw gwError('RSM writer: the grid has no nodes', null, 'E_RSM_GRID');
  // Reference row and column at the minimum, so every stored coordinate is non-negative.
  const refrow = Math.floor(Math.min(...rows));
  const refcol = Math.floor(Math.min(...cols));
  const width = (v, ref) => String(Math.round((Math.max(...v) - ref) * 10 ** fr)).length;
  const tr = Math.max(3, width(rows, refrow));
  const tc = Math.max(3, width(cols, refcol));
  if (tr > 31 || tc > 31) throw gwError('RSM writer: grid coordinates need more than 31 digits', null, 'E_RSM_WIDTH');
  const p0 = g.planes[0];
  const offs = g.planes.slice(1).map((p) => `${int(Math.round((p.x0 - p0.x0) / g.dx), 4)}${int(Math.round((p.y0 - p0.y0) / g.dy), 4)}`).join('');
  const nodes = g.planes
    .map((p) => {
      let s = `${int(p.nx, 3)}${int(p.ny, 3)}`;
      for (let i = 0; i < p.nx * p.ny; i++) {
        s += Number.isFinite(p.row[i]) && Number.isFinite(p.col[i]) ? `${String(Math.round((p.row[i] - refrow) * 10 ** fr)).padStart(tr, '0')}${String(Math.round((p.col[i] - refcol) * 10 ** fr)).padStart(tc, '0')}` : ' '.repeat(tr + tc);
      }
      return s;
    })
    .join('');
  const t = `${head(r)}${int(g.rsn, 3)}${int(g.csn, 3)}${f21(g.rfep)}${f21(g.cfep)}${g.intord}${int(g.planes.length, 3)}${f21(g.dz)}${f21(g.dx)}${f21(g.dy)}${f21(g.z0)}${f21(p0.x0)}${f21(p0.y0)}${int(refrow, 9)}${int(refcol, 9)}${int(tr, 2)}${int(tc, 2)}${fr}${fr}${offs}${nodes}`;
  if (t.length > 99988) throw gwError('RSM writer: an RSMGGA of {n} bytes is over the 99,988-byte TRE limit; use fewer nodes or more sections', { n: t.length }, 'E_RSM_WIDTH');
  return t;
}

/** Set A index fields for a parameter set, or null when it is not representable in set A. */
function setAFields(s) {
  if (s.frame !== 0 || s.noff.some((v) => v !== 0) || s.nscale.some((v) => v !== 1)) return null;
  const idx = SET_A_FIELDS.map((f) => s.terms.findIndex((t) => t.every((v, i) => v === f[i])));
  if (s.terms.some((t) => !SET_A_FIELDS.some((f) => f.every((v, i) => v === t[i])))) return null;
  return idx.map((k) => (k >= 0 ? String(k + 1).padStart(2, '0') : '  ')).join('');
}

const frameText = (s) => [...s.origin, ...s.axes].map(f21).join('');
function setBText(s) {
  const img = s.terms.every((t) => t[0] < 2);
  const gnd = s.terms.every((t) => t[0] === 2);
  if (!img && !gnd) throw gwError('RSM writer: a set B parameter set is all image-space or all ground-space', null, 'E_RSM_PARAMS');
  let t = `${img ? 'I' : 'G'}${s.frame === 0 ? 'R' : 'N'}${s.nscale.map(f21).join('')}${s.noff.map(f21).join('')}${s.frame === 0 ? frameText(s) : ''}N`;
  if (img) {
    const rr = s.terms.filter((x) => x[0] === 0);
    const cc = s.terms.filter((x) => x[0] === 1);
    if (s.terms.some((x, i) => x[0] === 1 && i < rr.length)) throw gwError('RSM writer: set B lists row terms before column terms', null, 'E_RSM_PARAMS');
    t += `${int(s.terms.length, 2)}${int(rr.length, 2)}${rr.map((x) => `${x[1]}${x[2]}${x[3]}`).join('')}${int(cc.length, 2)}${cc.map((x) => `${x[1]}${x[2]}${x[3]}`).join('')}`;
  } else t += `${int(s.terms.length, 2)}${s.terms.map((x) => pad(GROUND_IDS[x[1]], 4)).join('')}`;
  return t;
}
const upper = (cov, n) => {
  const v = [];
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) v.push(cov[i * n + j]);
  return v;
};
const identity = (n) => Array.from({ length: n * n }, (_, k) => (k % (n + 1) === 0 ? 1 : 0));

/** RSMAPA (set A) or RSMAPB (set B) for an applied set. */
function writeAp(r, s, b) {
  if (!b) {
    const f = setAFields(s);
    if (f) return ['RSMAPA', `${head(r)}${pad('', 40)}${int(s.terms.length, 2)}${frameText(s)}${f}${s.values.map(f21).join('')}`];
  }
  return ['RSMAPB', `${head(r)}${pad('', 40)}${int(s.terms.length, 2)}${setBText(s)}${s.values.map(f21).join('')}`];
}

// A two-segment piecewise-linear correlation: 1 at Δ = 0, 0 at one day (or 10⁶ pixels).
const segs = (tau) => `2${f21(1)}${f21(0)}${f21(0)}${f21(tau)}`;

/** RSMECA (set A) or RSMECB (set B): one error group, MAP the identity; the unmodelled error. */
function writeEc(r, s, cov, un, b) {
  const n = s ? s.terms.length : 0;
  const f = s && !b ? setAFields(s) : null;
  const unA = un ? `${un.map(f21).join('')}${segs(1e6)}${segs(1e6)}` : '';
  if (!s || f) {
    let t = `${head(r)}${pad('', 40)}${s ? 'Y' : 'N'}${un ? 'Y' : 'N'}`;
    if (s) t += `${int(n, 2)}${int(n, 2)}01${pad('20260101', 8)}${frameText(s)}${f}${int(n, 2)}${upper(cov, n).map(f21).join('')}0${segs(86400)}${identity(n).map(f21).join('')}`;
    return ['RSMECA', t + unA];
  }
  let t = `${head(r)}${pad('', 40)}Y${un ? 'Y' : 'N'}${int(n, 2)}01${pad('20260101', 8)}${int(n, 2)}${setBText(s)}${int(n, 2)}${upper(cov, n).map(f21).join('')}0N${segs(86400)}${identity(n).map(f21).join('')}`;
  if (un) t += `${un.map(f21).join('')}N${segs(1e6)}${segs(1e6)}`;
  return ['RSMECB', t];
}

/** RSMDCA (set A) for this image alone. */
function writeDca(r, s, cov) {
  const n = s.terms.length;
  const f = setAFields(s);
  if (!f) throw gwError('RSM writer: RSMDCA needs a set A parameter set', null, 'E_RSM_PARAMS');
  return ['RSMDCA', `${head(r)}${pad('', 40)}${int(n, 2)}001${int(n, 5)}${pad(r.iid ?? 'GIS WORKBENCH', 80)}${int(n, 2)}${frameText(s)}${f}${upper(cov, n).map(f21).join('')}`];
}

/** RSMDCB for this image alone (its own block, with the parameter definition). */
function writeDcb(r, s, cov) {
  const n = s.terms.length;
  return ['RSMDCB', `${head(r)}${pad('', 40)}${int(n, 2)}001${pad(r.iid ?? 'GIS WORKBENCH', 80)}${int(n, 2)}Y${int(n, 2)}${setBText(s)}${cov.map(f21).join('')}`];
}

/**
 * Write an RSM object as TREs: [[tag, text], …] in NITF order (RSMIDA, RSMPIA, RSMPCA…,
 * RSMGIA, RSMGGA…, RSMAPA/B, RSMECA/B or RSMDCA/B). `setB` writes the set B family; `direct`
 * writes the covariance as RSMDCA/RSMDCB instead of RSMECA/RSMECB.
 */
export function rsmTreList(r, { date = '20260101000000', setB = false, direct = false } = {}) {
  const out = [['RSMIDA', writeIda(r, date)]];
  if (r.sections?.length > 1) out.push(['RSMPIA', writeIndex(r, r.index)]);
  for (const s of r.sections ?? []) out.push(['RSMPCA', writePca(r, s)]);
  if (r.grids?.length > 1) out.push(['RSMGIA', writeIndex(r, r.gindex)]);
  for (const g of r.grids ?? []) out.push(['RSMGGA', writeGga(r, g)]);
  if (r.applied) out.push(writeAp(r, r.applied, setB));
  const n = r.adjustable?.terms.length ?? 0;
  if (r.adjustable && r.cov?.length === n * n) out.push(direct ? (setB ? writeDcb(r, r.adjustable, r.cov) : writeDca(r, r.adjustable, r.cov)) : writeEc(r, r.adjustable, r.cov, r.unmodelled, setB));
  else if (r.unmodelled) out.push(writeEc(r, null, null, r.unmodelled, false));
  return out;
}

/** The 2.2 writer: RSMIDA and RSMPCA text for a one-section record. */
export function rsmTres(rec, { iid = 'GIS WORKBENCH', date = '20260101000000' } = {}) {
  const r = { ...rsmFromSection(rec), iid };
  const l = rsmTreList(r, { date });
  return { RSMIDA: l[0][1], RSMPCA: l[1][1] };
}

/** Group a TRE list by tag (RSMPCA and RSMGGA as arrays), the shape `parseRsm` reads. */
export function rsmTreMap(list) {
  const m = { RSMPCA: [], RSMGGA: [] };
  for (const [tag, text] of list) {
    if (tag === 'RSMPCA' || tag === 'RSMGGA') m[tag].push(text);
    else m[tag] = text;
  }
  return m;
}

// RPC00B term order (L = longitude, P = latitude, H = height): powers (L, P, H).
const RPC_TERMS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [2, 0, 0], [0, 2, 0], [0, 0, 2],
  [1, 1, 1], [3, 0, 0], [1, 2, 0], [1, 0, 2], [2, 1, 0], [0, 3, 0], [0, 1, 2], [2, 0, 1], [0, 2, 1], [0, 0, 3],
];

/** An RPC00B record (the core's 92 values: ERR_BIAS, ERR_RAND, offsets, scales, 4 × 20) as an exact RSM section. */
export function rsmFromRpc(rec, rows, cols) {
  const [lineOff, sampOff, latOff, lonOff, hOff, lineScale, sampScale, latScale, lonScale, hScale] = rec.slice(2, 12);
  const poly = (k) => {
    const c = new Array(64).fill(0);
    RPC_TERMS.forEach(([i, j, kz], t) => (c[kz * 16 + j * 4 + i] = rec[12 + 20 * k + t]));
    return { px: 3, py: 3, pz: 3, c };
  };
  const d2r = Math.PI / 180;
  return { domain: 0, origin: [0, 0, 0], axes: [0, 0, 0, 0, 0, 0, 0, 0, 0], off: [lineOff, sampOff, lonOff * d2r, latOff * d2r, hOff], scale: [lineScale, sampScale, lonScale * d2r, latScale * d2r, hScale], rows, cols, polys: [poly(0), poly(1), poly(2), poly(3)] };
}

// ---- SENSRB ----

/** Unsigned, zero padded: "0016.000". */
const unsigned = (v, w, d) => {
  const t = Math.abs(v).toFixed(d);
  if (t.length > w) throw gwError('SENSRB writer: {v} does not fit {w} characters', { v: String(v), w }, 'E_SENSRB_WIDTH');
  return t.padStart(w, '0');
};
const padS = (s, w) => String(s ?? '').padEnd(w, ' ').slice(0, w);
const intw = (v, w) => String(Math.round(v)).padStart(w, '0');

/** Sign first, then zero padding: "+0034.50000". */
const signed = (v, w, d) => {
  const s = Math.abs(v).toFixed(d);
  if (s.length + 1 > w) throw gwError('SENSRB writer: {v} does not fit {w} characters', { v: String(v), w }, 'E_SENSRB_WIDTH');
  return (v < 0 ? '-' : '+') + s.padStart(w - 1, '0');
};

/**
 * SENSRB text for a frame camera: s = {sensor, platform, width, height, focalMm, pixelMm,
 * ppx, ppy (mm), k[3], p[2], lat, lon, hae, icx, icy, icz (NED unit vectors)} (SI, degrees).
 */
export function writeSensrb(s) {
  let t = 'Y' + padS(s.sensor ?? 'GIS WORKBENCH TEST', 25) + padS('', 32) + padS(s.platform ?? 'SYNTHETIC', 25) + padS('', 32) + padS('Airborne', 10) + '4' + padS('WGS84', 5) + 'G' + 'HAE' + 'SI' + 'DEG' + padS('20260101', 8) + '00000000000000' + padS('20260101', 8) + '00000000000000' + '00' + padS('', 8) + padS('', 10);
  t += 'Y' + padS('VIS', 20) + intw(s.height, 8) + intw(s.width, 8) + unsigned(s.height * s.pixelMm, 8, 3) + unsigned(s.width * s.pixelMm, 8, 3) + unsigned(s.focalMm, 8, 3) + padS('', 8) + padS('', 8) + 'Y';
  t += 'Y' + 'mm' + signed(s.ppx ?? 0, 9, 4) + signed(s.ppy ?? 0, 9, 4) + (s.k ?? [0, 0, 0]).map((v) => padS(v.toExponential(4), 12)).join('') + padS('', 9) + (s.p ?? [0, 0]).map((v) => padS(v.toExponential(4), 12)).join('') + padS(0, 12) + padS(0, 12) + padS('20260101', 8);
  t += 'Y' + padS('', 15) + padS('', 3) + intw(s.height, 8) + intw(s.width, 8) + '00000001' + '00000001' + padS('', 10) + padS('', 10) + '00000000' + '00000000' + '0';
  t += padS('', 12) + padS('', 8) + padS('', 8) + signed(s.lat, 11, 7) + signed(s.lon, 12, 7) + signed(s.hae, 11, 3) + '00000000' + '00000000' + '00000000';
  t += 'N';
  t += 'Y' + [...s.icx, ...s.icy, ...s.icz].map((v) => signed(v, 10, 7)).join('');
  t += 'N' + 'N' + '00' + '00' + '00' + '000' + '000';
  return t;
}
