// RSM TREs (REQ-SNS-03, REQ-GAP-18; STDI-0002 Vol. 1 App. U), read from their fixed-width ASCII
// fields and written back. Layouts follow GDAL's TRE tables (nitf_spec.xml); the specification
// was not read, so meanings flagged [unverified] in crates/gw-sensor/src/rsm.rs are
// reconstructions. One object describes an image's RSM:
//
//   { iid, domain 0 G | 1 H | 2 R, origin[3], axes[9], rows, cols, minr, minc, grp[3] | null,
//     index (RSMPIA) | null, sections (RSMPCA) [], gindex (RSMGIA) | null, grids (RSMGGA) [],
//     applied (RSMAPA/APB values) | null, adjustable | null, cov (n × n) | null,
//     unmodelled [URR, URC, UCC] | null, errorSource, notes [] }
//   index = { r[10], c[10], rnis, cnis, rssiz, cssiz }
//   section = { rsn, csn, rfep, cfep, off[5], scale[5], polys: 4 × { px, py, pz, c[] } }
//   grid = { rsn, csn, rfep, cfep, intord, z0, dz, dx, dy, planes: [{ x0, y0, nx, ny, row[], col[] }] }
//   paramSet = { frame 0 rect | 1 domain, origin[3], axes[9], noff[3], nscale[3],
//                terms: [[type 0 row | 1 col | 2 ground, a, b, c]], values[] }
//
// The core gets the flat record of `rsmFlat` (crates/gw-sensor/src/rsm.rs `from_record`). The
// writers (TRE text, the RSM form of an RPC00B) are in sensor/writers.js, outside the app bundle.

import { gwError, N_ } from '../i18n/index.js';

const num = (s) => {
  const t = String(s ?? '').trim();
  return t === '' ? NaN : Number(t);
};

/** A cursor over fixed-width text. */
function cursor(text, tag) {
  let o = 0;
  const take = (n) => {
    if (o + n > text.length) throw gwError('{tre} is shorter than its fields', { tre: tag }, 'E_RSM_SHORT');
    const v = text.slice(o, o + n);
    o += n;
    return v;
  };
  return { take, num: (n) => num(take(n)), int: (n) => Math.trunc(num(take(n))), skip: (n) => void take(n), get pos() { return o; }, rest: () => text.length - o };
}

// Set A index fields: image-space row and column terms (powers of local x, y, z) and the 16
// ground-space terms, in TRE order.
const IMG_POWERS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [2, 0, 0], [1, 1, 0], [1, 0, 1], [0, 2, 0], [0, 1, 1], [0, 0, 2]];
export const GROUND_IDS = ['GXO', 'GYO', 'GZO', 'GXR', 'GYR', 'GZR', 'GS', 'GXX', 'GXY', 'GXZ', 'GYX', 'GYY', 'GYZ', 'GZX', 'GZY', 'GZZ'];
export const SET_A_FIELDS = [...IMG_POWERS.map((p) => [0, ...p]), ...IMG_POWERS.map((p) => [1, ...p]), ...GROUND_IDS.map((_, i) => [2, i, 0, 0])];

/** RSMIDA → {iid, rows, cols, domain, origin, axes, minr, minc, grp}. */
export function parseRsmida(t) {
  const c = cursor(t, 'RSMIDA');
  const iid = c.take(80).trim();
  c.skip(40 + 40 + 40 + 40); // EDITION, ISID, SID, STID
  c.skip(4 + 2 + 2 + 2 + 2 + 9); // date and time
  const nrg = c.num(8);
  const ncg = c.num(8);
  c.skip(21 + 21); // TRG, TCG
  const grndd = c.take(1);
  const v = [];
  for (let i = 0; i < 12; i++) v.push(c.num(21));
  c.skip(24 * 21); // V1X … V8Z
  const grp = [c.num(21), c.num(21), c.num(21)];
  c.skip(16); // FULLR, FULLC
  const minr = c.num(8);
  c.skip(8);
  const minc = c.num(8);
  const domain = grndd === 'R' ? 2 : grndd === 'H' ? 1 : 0;
  // Rectangular: origin XUOR… then rows of unit vectors (XUXR XUYR XUZR), (YU…), (ZU…).
  return { iid, rows: nrg, cols: ncg, domain, origin: domain === 2 ? v.slice(0, 3) : [0, 0, 0], axes: domain === 2 ? v.slice(3, 12) : [0, 0, 0, 0, 0, 0, 0, 0, 0], minr: Number.isFinite(minr) ? minr : 0, minc: Number.isFinite(minc) ? minc : 0, grp: grp.every(Number.isFinite) ? grp : null };
}

/** RSMPCA → section {rsn, csn, rfep, cfep, off, scale, polys}. */
export function parseRsmpca(t) {
  const c = cursor(t, 'RSMPCA');
  c.skip(80 + 40); // IID, EDITION
  const rsn = c.num(3);
  const csn = c.num(3);
  const rfep = c.num(21);
  const cfep = c.num(21);
  const off = [0, 0, 0, 0, 0].map(() => c.num(21));
  const scale = [0, 0, 0, 0, 0].map(() => c.num(21));
  const polys = [];
  for (let p = 0; p < 4; p++) {
    const px = c.num(1);
    const py = c.num(1);
    const pz = c.num(1);
    const n = c.num(3);
    if (n !== (px + 1) * (py + 1) * (pz + 1)) throw gwError('RSMPCA polynomial {p}: {n} terms for powers {powers}', { p: String(p + 1), n: String(n), powers: `${px}${py}${pz}` }, 'E_RSM_POLY');
    const cc = [];
    for (let i = 0; i < n; i++) cc.push(c.num(21));
    polys.push({ px, py, pz, c: cc });
  }
  return { rsn, csn, rfep, cfep, off, scale, polys };
}

/** RSMPIA / RSMGIA → {r[10], c[10], rnis, cnis, rssiz, cssiz}. */
export function parseIndex(t, tag = 'RSMPIA') {
  const c = cursor(t, tag);
  c.skip(120);
  const r = Array.from({ length: 10 }, () => c.num(21));
  const cc = Array.from({ length: 10 }, () => c.num(21));
  const rnis = c.num(3);
  const cnis = c.num(3);
  c.skip(3); // TNIS
  return { r, c: cc, rnis, cnis, rssiz: c.num(21), cssiz: c.num(21) };
}

/** RSMGGA → grid section. */
export function parseRsmgga(t) {
  const c = cursor(t, 'RSMGGA');
  c.skip(120);
  const rsn = c.num(3);
  const csn = c.num(3);
  const rfep = c.num(21);
  const cfep = c.num(21);
  const intord = c.num(1);
  const npln = c.num(3);
  const [dz, dx, dy, z0, x1, y1] = [0, 0, 0, 0, 0, 0].map(() => c.num(21));
  const refrow = c.num(9);
  const refcol = c.num(9);
  const tr = c.num(2);
  const tc = c.num(2);
  const fr = c.num(1);
  const fc = c.num(1);
  if (!(npln >= 2) || !(tr >= 3 && tc >= 3)) throw gwError('RSMGGA: needs two or more planes and coordinate widths of three or more digits', null, 'E_RSM_GRID');
  const offs = [[0, 0]];
  for (let k = 1; k < npln; k++) offs.push([c.num(4), c.num(4)]);
  const planes = [];
  for (let k = 0; k < npln; k++) {
    const nx = c.num(3);
    const ny = c.num(3);
    const row = new Array(nx * ny);
    const col = new Array(nx * ny);
    // Nodes y outer, x inner [unverified]; a blank field is a node without a value.
    for (let i = 0; i < nx * ny; i++) {
      const rs = c.take(tr);
      const cs = c.take(tc);
      row[i] = rs.trim() === '' ? NaN : refrow + Number(rs) / 10 ** fr;
      col[i] = cs.trim() === '' ? NaN : refcol + Number(cs) / 10 ** fc;
    }
    planes.push({ x0: x1 + offs[k][0] * dx, y0: y1 + offs[k][1] * dy, nx, ny, row, col });
  }
  return { rsn, csn, rfep, cfep, intord, z0, dz, dx, dy, planes };
}

function frame12(c) {
  const v = Array.from({ length: 12 }, () => c.num(21));
  return { origin: v.slice(0, 3), axes: v.slice(3, 12) };
}

/** Set A index fields (36 × 2) → parameter terms in parameter order. */
function setATerms(c, npar) {
  const terms = new Array(npar).fill(null);
  for (const f of SET_A_FIELDS) {
    const s = c.take(2);
    const k = num(s);
    if (Number.isFinite(k) && k >= 1 && k <= npar) terms[k - 1] = f;
  }
  if (terms.some((x) => !x)) throw gwError('RSM: the index fields do not define all {n} adjustable parameters', { n: npar }, 'E_RSM_PARAMS');
  return terms;
}

/** Set B parameter definition: APTYP, LOCTYP, normalisation, frame, APBASE, terms. */
function setBDef(c, npar, tag) {
  const aptyp = c.take(1);
  const loctyp = c.take(1);
  const nscale = [c.num(21), c.num(21), c.num(21)];
  const noff = [c.num(21), c.num(21), c.num(21)];
  const fr = loctyp === 'R' ? frame12(c) : null;
  const apbase = c.take(1);
  const terms = [];
  if (aptyp === 'I') {
    c.skip(2); // NISAP
    const nr = c.num(2);
    for (let i = 0; i < nr; i++) terms.push([0, c.num(1), c.num(1), c.num(1)]);
    const nc = c.num(2);
    for (let i = 0; i < nc; i++) terms.push([1, c.num(1), c.num(1), c.num(1)]);
  } else if (aptyp === 'G') {
    const ng = c.num(2);
    for (let i = 0; i < ng; i++) {
      const id = c.take(4).trim();
      const k = GROUND_IDS.indexOf(id);
      if (k < 0) throw gwError('{tre}: unknown ground-space parameter {id}', { tre: tag, id }, 'E_RSM_PARAMS');
      terms.push([2, k, 0, 0]);
    }
  } else throw gwError('{tre}: unknown adjustable-parameter type {t}', { tre: tag, t: aptyp }, 'E_RSM_PARAMS');
  let basis = null;
  if (apbase === 'Y') {
    const nb = c.num(2);
    basis = Array.from({ length: npar * nb }, () => c.num(21));
  }
  const set = { frame: fr ? 0 : 1, origin: fr?.origin ?? [0, 0, 0], axes: fr?.axes ?? [0, 0, 0, 0, 0, 0, 0, 0, 0], noff: noff.map((v) => (Number.isFinite(v) ? v : 0)), nscale: nscale.map((v) => (Number.isFinite(v) && v !== 0 ? v : 1)), terms, values: new Array(terms.length).fill(0) };
  return { set, basis };
}

// A set A frame left blank is taken as the ground domain itself [unverified].
const setA = (fr, terms) => {
  const rect = [...fr.origin, ...fr.axes].every(Number.isFinite);
  return { frame: rect ? 0 : 1, origin: rect ? fr.origin : [0, 0, 0], axes: rect ? fr.axes : [0, 0, 0, 0, 0, 0, 0, 0, 0], noff: [0, 0, 0], nscale: [1, 1, 1], terms, values: new Array(terms.length).fill(0) };
};

/** RSMAPA → applied parameter set. */
export function parseRsmapa(t) {
  const c = cursor(t, 'RSMAPA');
  c.skip(160);
  const npar = c.num(2);
  const fr = frame12(c);
  const s = setA(fr, setATerms(c, npar));
  s.values = Array.from({ length: npar }, () => c.num(21));
  return s;
}

/** RSMAPB → applied parameter set. */
export function parseRsmapb(t) {
  const c = cursor(t, 'RSMAPB');
  c.skip(160);
  const npar = c.num(2);
  const { set } = setBDef(c, npar, 'RSMAPB');
  if (set.terms.length !== npar) throw gwError('{tre}: {n} terms for {k} parameters', { tre: 'RSMAPB', n: set.terms.length, k: npar }, 'E_RSM_PARAMS');
  set.values = Array.from({ length: npar }, () => c.num(21));
  return set;
}

/** Upper triangle (row-major) → full symmetric n × n. */
function fromUpper(v, n) {
  const m = new Array(n * n).fill(0);
  let k = 0;
  for (let i = 0; i < n; i++)
    for (let j = i; j < n; j++) {
      m[i * n + j] = v[k];
      m[j * n + i] = v[k];
      k++;
    }
  return m;
}

/** cov = MAP Σ MAPᵀ (MAP npar × nparo, Σ nparo × nparo). */
function mapCov(map, sig, npar, nparo) {
  const out = new Array(npar * npar).fill(0);
  for (let i = 0; i < npar; i++)
    for (let j = 0; j < npar; j++) {
      let s = 0;
      for (let a = 0; a < nparo; a++) for (let b = 0; b < nparo; b++) s += map[i * nparo + a] * sig[a * nparo + b] * map[j * nparo + b];
      out[i * npar + j] = s;
    }
  return out;
}

/** The error groups of RSMECA/ECB: a block-diagonal Σ over the original parameters. */
function groups(c, ign, nparo, setB) {
  const sig = new Array(nparo * nparo).fill(0);
  let o = 0;
  const corr = [];
  for (let g = 0; g < ign; g++) {
    const k = c.num(2);
    const v = Array.from({ length: (k * (k + 1)) / 2 }, () => c.num(21));
    const m = fromUpper(v, k);
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) if (o + i < nparo && o + j < nparo) sig[(o + i) * nparo + o + j] = m[i * k + j];
    o += k;
    const tcdf = c.num(1);
    if (setB && c.take(1) === 'Y') corr.push({ tcdf, csm: [c.num(21), c.num(21), c.num(21), c.num(21)] });
    else {
      const ns = c.num(1);
      corr.push({ tcdf, segments: Array.from({ length: ns }, () => [c.num(21), c.num(21)]) });
    }
  }
  if (o !== nparo) throw gwError('RSM error groups cover {n} of {k} original parameters', { n: o, k: nparo }, 'E_RSM_PARAMS');
  return { sig, corr };
}

function unmodelled(c, setB) {
  const u = [c.num(21), c.num(21), c.num(21)];
  if (setB && c.take(1) === 'Y') c.skip(8 * 21);
  else {
    const nr = c.num(1);
    c.skip(nr * 42);
    const nc = c.num(1);
    c.skip(nc * 42);
  }
  return u;
}

/** RSMECA → {set, cov, unmodelled, corr}. */
export function parseRsmeca(t) {
  const c = cursor(t, 'RSMECA');
  c.skip(160);
  const inclic = c.take(1) === 'Y';
  const incluc = c.take(1) === 'Y';
  let set = null;
  let cov = null;
  let corr = null;
  if (inclic) {
    const npar = c.num(2);
    const nparo = c.num(2);
    const ign = c.num(2);
    c.skip(8);
    const fr = frame12(c);
    set = setA(fr, setATerms(c, npar));
    const g = groups(c, ign, nparo, false);
    corr = g.corr;
    const map = Array.from({ length: npar * nparo }, () => c.num(21));
    cov = mapCov(map, g.sig, npar, nparo);
  }
  return { set, cov, unmodelled: incluc ? unmodelled(c, false) : null, corr };
}

/** RSMECB → {set, cov, unmodelled, corr}. */
export function parseRsmecb(t) {
  const c = cursor(t, 'RSMECB');
  c.skip(160);
  const inclic = c.take(1) === 'Y';
  const incluc = c.take(1) === 'Y';
  let set = null;
  let cov = null;
  let corr = null;
  if (inclic) {
    const nparo = c.num(2);
    const ign = c.num(2);
    c.skip(8);
    const npar = c.num(2);
    const d = setBDef(c, npar, 'RSMECB');
    if (d.set.terms.length !== npar) throw gwError('{tre}: {n} terms for {k} parameters', { tre: 'RSMECB', n: d.set.terms.length, k: npar }, 'E_RSM_PARAMS');
    set = d.set;
    const g = groups(c, ign, nparo, true);
    corr = g.corr;
    const map = Array.from({ length: npar * nparo }, () => c.num(21));
    cov = mapCov(map, g.sig, npar, nparo);
  }
  return { set, cov, unmodelled: incluc ? unmodelled(c, true) : null, corr };
}

/** RSMDCA → {set, cov} for image `iid` (its block of the joint covariance), plus the image list. */
export function parseRsmdca(t, iid) {
  const c = cursor(t, 'RSMDCA');
  c.skip(160);
  const npar = c.num(2);
  const nimge = c.num(3);
  const npart = c.num(5);
  const imgs = Array.from({ length: nimge }, () => ({ iid: c.take(80).trim(), n: c.num(2) }));
  const fr = frame12(c);
  const set = setA(fr, setATerms(c, npar));
  const all = fromUpper(Array.from({ length: (npart * (npart + 1)) / 2 }, () => c.num(21)), npart);
  let o = 0;
  let k = imgs.findIndex((x) => x.iid === String(iid ?? '').trim());
  if (k < 0) k = 0;
  for (let i = 0; i < k; i++) o += imgs[i].n;
  if (imgs[k].n !== npar) throw gwError('RSMDCA: image {iid} has {n} parameters, not {k}', { iid: imgs[k].iid, n: imgs[k].n, k: npar }, 'E_RSM_PARAMS');
  const cov = [];
  for (let i = 0; i < npar; i++) for (let j = 0; j < npar; j++) cov.push(all[(o + i) * npart + o + j]);
  return { set, cov, images: imgs };
}

/** RSMDCB → {set | null, cov | null} for image `iid` (its own block, when listed). */
export function parseRsmdcb(t, iid) {
  const c = cursor(t, 'RSMDCB');
  c.skip(160);
  const nrow = c.num(2);
  const nimge = c.num(3);
  const imgs = Array.from({ length: nimge }, () => ({ iid: c.take(80).trim(), n: c.num(2) }));
  let set = null;
  if (c.take(1) === 'Y') {
    const npar = c.num(2);
    set = setBDef(c, npar, 'RSMDCB').set;
  }
  let cov = null;
  for (const im of imgs) {
    const block = Array.from({ length: nrow * im.n }, () => c.num(21));
    if (im.iid === String(iid ?? '').trim() && im.n === nrow) cov = block;
  }
  return { set, cov, images: imgs };
}

const sameDef = (a, b) => a && b && a.frame === b.frame && JSON.stringify(a.terms) === JSON.stringify(b.terms) && [...a.origin, ...a.axes, ...a.noff, ...a.nscale].every((v, i) => Math.abs(v - [...b.origin, ...b.axes, ...b.noff, ...b.nscale][i]) <= 1e-9 * Math.max(1, Math.abs(v)));

/**
 * The RSM object of an image from its TRE texts: {RSMIDA, RSMPIA, RSMPCA: [], RSMGIA, RSMGGA: [],
 * RSMAPA, RSMAPB, RSMECA, RSMECB, RSMDCA, RSMDCB} (absent ones null or empty).
 */
export function parseRsm(tres) {
  if (!tres?.RSMIDA) throw gwError('RSM: no RSMIDA', null, 'E_RSM_NO_IDA');
  const a = parseRsmida(tres.RSMIDA);
  const r = { ...a, index: tres.RSMPIA ? parseIndex(tres.RSMPIA, 'RSMPIA') : null, sections: (tres.RSMPCA ?? []).filter(Boolean).map(parseRsmpca), gindex: tres.RSMGIA ? parseIndex(tres.RSMGIA, 'RSMGIA') : null, grids: (tres.RSMGGA ?? []).filter(Boolean).map(parseRsmgga), applied: null, adjustable: null, cov: null, unmodelled: null, errorSource: null, notes: [] };
  if (tres.RSMAPB) r.applied = parseRsmapb(tres.RSMAPB);
  else if (tres.RSMAPA) r.applied = parseRsmapa(tres.RSMAPA);
  // The covariance: indirect (ECA/ECB) first, then direct (DCA/DCB).
  const err = tres.RSMECB ? parseRsmecb(tres.RSMECB) : tres.RSMECA ? parseRsmeca(tres.RSMECA) : null;
  if (err) {
    r.errorSource = tres.RSMECB ? 'RSMECB' : 'RSMECA';
    r.unmodelled = err.unmodelled;
    if (err.set) {
      r.adjustable = err.set;
      r.cov = err.cov;
    }
    if (err.corr?.some((g) => g.tcdf || g.segments?.length > 2 || g.csm)) r.notes.push(N_('time correlation between images is read but not applied'));
  }
  if (!r.adjustable) {
    const d = tres.RSMDCB ? parseRsmdcb(tres.RSMDCB, a.iid) : tres.RSMDCA ? parseRsmdca(tres.RSMDCA, a.iid) : null;
    const set = d?.set ?? (tres.RSMDCB ? r.applied && { ...r.applied, values: r.applied.values.map(() => 0) } : null);
    if (d && set && d.cov) {
      r.adjustable = { ...set, values: set.values.map(() => 0) };
      r.cov = d.cov;
      r.errorSource = tres.RSMDCB ? 'RSMDCB' : 'RSMDCA';
      if (d.images.length > 1) r.notes.push(N_('cross-image covariance is read for this image only'));
    }
  }
  // Without a covariance the applied set (if any) is also the adjustable one.
  if (!r.adjustable && r.applied) r.adjustable = { ...r.applied, values: r.applied.values.map(() => 0) };
  if (r.applied && r.adjustable && !sameDef(r.applied, r.adjustable)) r.notes.push(N_('the applied and adjustable parameter sets differ; both are used'));
  if (!r.sections.length && !r.grids.length) throw gwError('RSM: no polynomial (RSMPCA) or grid (RSMGGA) sections', null, 'E_RSM_NO_SECTIONS');
  return r;
}

const flatSet = (s) => (s ? [1, s.frame, ...s.origin, ...s.axes, ...s.noff, ...s.nscale, s.terms.length, ...s.terms.flat(), ...s.values] : [0]);

/**
 * The core's record (version 2) for the polynomial (`grid` false) or the grid sections of an RSM
 * object. A single-section model needs no index.
 */
export function rsmFlat(r, { grid = false } = {}) {
  const secs = grid ? r.grids : r.sections;
  const ix = grid ? r.gindex : r.index;
  if (!secs?.length) throw gwError('RSM: no {kind} sections', { kind: grid ? 'grid' : 'polynomial' }, 'E_RSM_NO_SECTIONS');
  if (secs.length > 1 && !ix) throw gwError('RSM: {n} sections but no section index ({tre})', { n: secs.length, tre: grid ? 'RSMGIA' : 'RSMPIA' }, 'E_RSM_NO_INDEX');
  const out = [2, r.domain ?? 0, ...(r.origin ?? [0, 0, 0]), ...(r.axes ?? [0, 0, 0, 0, 0, 0, 0, 0, 0]), r.rows, r.cols, r.minr ?? 0, r.minc ?? 0, ...(r.grp ?? [NaN, NaN, NaN]), grid ? 1 : 0];
  if (ix && secs.length > 1) out.push(1, ...ix.r, ...ix.c, ix.rnis, ix.cnis, ix.rssiz, ix.cssiz);
  else out.push(0);
  out.push(secs.length);
  for (const s of secs) {
    if (grid) {
      out.push(s.rsn, s.csn, s.intord, s.planes.length, s.z0, s.dz, s.dx, s.dy);
      for (const p of s.planes) out.push(p.x0, p.y0, p.nx, p.ny, ...p.row, ...p.col);
    } else {
      out.push(s.rsn, s.csn, ...s.off, ...s.scale);
      for (const q of s.polys) out.push(q.px, q.py, q.pz, q.c.length, ...q.c);
    }
  }
  out.push(...flatSet(r.applied), ...flatSet(r.adjustable));
  if (r.cov && r.adjustable && r.cov.length === r.adjustable.terms.length ** 2) out.push(1, ...r.cov);
  else out.push(0);
  if (r.unmodelled?.every(Number.isFinite)) out.push(1, ...r.unmodelled);
  else out.push(0);
  return out;
}

/** The 2.2 single-section record from RSMIDA and RSMPCA text (kept for callers and tests). */
export function rsmRecord(ida, pca) {
  const a = parseRsmida(ida);
  const p = parseRsmpca(pca);
  return { domain: a.domain, origin: a.origin, axes: a.axes, off: p.off, scale: p.scale, rows: a.rows, cols: a.cols, polys: p.polys, iid: a.iid, rsn: p.rsn, csn: p.csn };
}

/** A 2.2 single-section record as an RSM object. */
export function rsmFromSection(rec) {
  if (rec.sections || rec.grids) return rec;
  return { iid: rec.iid ?? '', domain: rec.domain ?? 0, origin: rec.origin ?? [0, 0, 0], axes: rec.axes ?? [0, 0, 0, 0, 0, 0, 0, 0, 0], rows: rec.rows, cols: rec.cols, minr: 0, minc: 0, grp: null, index: null, sections: [{ rsn: 1, csn: 1, rfep: NaN, cfep: NaN, off: rec.off, scale: rec.scale, polys: rec.polys }], gindex: null, grids: [], applied: null, adjustable: null, cov: null, unmodelled: null, errorSource: null, notes: [] };
}
