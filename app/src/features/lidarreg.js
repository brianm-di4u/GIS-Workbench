// Register an image to a point cloud (REQ-GAP-46, 2.5 group lidarreg; lazy block js-lidarreg).
// The cloud's DSM and mean intensity are gridded with the 2.4 rasterisers (app.pc.makeGrid), cut
// to the image's footprint; the image is read over that footprint; the analysis worker's photo
// bundle matches the image with the intensity (NIR band when the image has one) and the DSM's
// hillshade (phase correlation and NCC, peak thresholds and RANSAC), turns the matches into 3-D
// control from the cloud, and solves the image correction (RPC bias, or the model's own bias
// family) together with a 3- or 7-parameter datum shift of the cloud, each with a priori σ.
// Every n-th match is held back as a checkpoint; surveyed points on the cloud (a CSV) can control
// the shift or check it. The report gives the residuals, the shift with its covariance and the
// GPM-style propagated error; Apply stores the image correction as a triangulation solution.
// The cloud itself is not moved.

import { h } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { t, tr, N_, gwError, msgOf } from '../i18n/index.js';
import { num, int } from '../i18n/format.js';
import { saveBlob, pickFiles } from '../storage/files.js';

export const name = 'lidarreg';

/** Rows of a small CSV/TSV (comma, semicolon or tab; double-quoted fields), # lines skipped. */
export function parseRows(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  const d = ['\t', ';', ','].map((c) => [c, (lines[0] ?? '').split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  return lines.map((l) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) {
        if (ch === '"' && l[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"' && cur.trim() === '') q = true;
      else if (ch === d) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

const REFS = { intensity: 0, hillshade: 1, both: 2 };
const REF_NAMES = { intensity: N_('Intensity'), hillshade: N_('Hillshade'), both: N_('Intensity and hillshade') };
const BIAS = { shift: 0, drift: 1, affine: 2 };
// The datum parameters' names and units (as gw_adjust::block::DATUM_NAMES).
const DATUM_NAMES = [N_('dE (m)'), N_('dN (m)'), N_('dU (m)'), N_('rotation E (µrad)'), N_('rotation N (µrad)'), N_('rotation U (µrad)'), N_('scale (ppm)')];
const DATUM_SIGMA = [1, 1, 0.5, 50, 50, 50, 50];
const MAX_POSTS = 16e6;
const MAX_CHIP = 25e6;

/** Surveyed points from CSV text: id, lat, lon, h (the cloud's heights: HAE), role (control/check), sigma. */
export function parseSurvey(text) {
  const rows = parseRows(text);
  if (rows.length < 2) throw gwError('the survey file has no rows', null, 'E_LREG_SURVEY');
  const head = rows[0].map((c) => c.trim().toLowerCase());
  const col = (...n) => head.findIndex((c) => n.includes(c));
  const ci = { id: col('id', 'name', 'pid', 'point'), lat: col('lat', 'latitude'), lon: col('lon', 'long', 'longitude'), h: col('hae', 'h', 'height', 'z', 'elev'), role: col('role', 'kind', 'type'), s: col('sigma', 'sigma_v', 'sv') };
  if (ci.lat < 0 || ci.lon < 0 || ci.h < 0) throw gwError('the survey file needs lat, lon and hae (or h) columns', null, 'E_LREG_SURVEY');
  const out = [];
  for (const r of rows.slice(1)) {
    const lat = Number(r[ci.lat]);
    const lon = Number(r[ci.lon]);
    const hh = Number(r[ci.h]);
    if (![lat, lon, hh].every(Number.isFinite)) continue;
    out.push({ id: (ci.id >= 0 ? r[ci.id] : '') || `S${out.length + 1}`, lat, lon, h: hh, check: /^(check|chk)/i.test(ci.role >= 0 ? r[ci.role] : ''), sigma: Number(r[ci.s]) > 0 ? Number(r[ci.s]) : 0.05 });
  }
  if (!out.length) throw gwError('the survey file has no point with lat, lon and height', null, 'E_LREG_SURVEY');
  return out;
}

/**
 * The joint adjustment job (photo bundle block job version 3, REQ-GAP-46): one image (model record
 * `rec`, bias family `bias`), cloud control points {kind 3 control / 4 held out, lat, lon, h},
 * observations [image 0, point, x, y, σ px], a datum shift of k = 0/3/7 with a priori σ about
 * `centre`, and surveyed cloud points {lat, lon, h, z, gE, gN, sigma, check}.
 */
export function jointJob({ rec, bias = 'shift', centrePx, half, points, obs, sigmaH = 0.3, sigmaV = 0.5, datum = 0, datumSigma = [], centre, cloud = [], priorPx = 0 }) {
  const job = [3, 1, points.length, obs.length, 50, 3, 0, datum, cloud.length, centre.lat, centre.lon, centre.h, ...datumSigma.slice(0, datum)];
  job.push(rec.type, rec.rec.length, ...rec.rec, BIAS[bias] ?? 0, 0, centrePx.x, centrePx.y, half[0], half[1], priorPx, 0);
  for (const p of points) job.push(p.kind, p.lat, p.lon, p.h, sigmaH, sigmaV);
  for (const ob of obs) job.push(...ob);
  for (const c of cloud) job.push(c.lat, c.lon, c.h, c.z, c.gE, c.gN, c.sigma, c.check ? 1 : 0);
  return Float64Array.from(job);
}

export function install(app) {
  const C = app.commands;
  const toast = (m, o) => app.toast(m, o);
  const analysis = (op, args, transfer = []) => app.pool.run(op, args, { kind: 'analysis', transfer, timeout: 600000, label: t('LiDAR registration') });

  /** Whole (not streamed) point clouds open in any 3D panel. */
  const clouds = () => {
    const out = [];
    for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) for (const x of p.view3d?.clouds ?? []) if (!x.cloud.streamed && !out.includes(x.cloud)) out.push(x.cloud);
    return out;
  };
  const images = () => [...app.layers.values()].filter((l) => l.kind !== 'dem' && l.handle && l.modelId && !l.info?.footprint);

  /** The record of the image's base model that the photo bundle rebuilds: RPC, RSM/pushbroom/frame, or map geotransform. */
  function recordOf(l) {
    const want = l.rec?.triangulation?.base ?? l.modelName;
    const m = (l.models ?? []).find((x) => !x.error && x.name === want && !/triangulated/.test(x.name)) ?? (l.models ?? []).find((x) => x.id === l.modelId);
    if (m?.record) return { ...m.record, name: m.name, id: m.id };
    if (m?.mapRecord) return { ...m.mapRecord, name: m.name, id: m.id };
    if (m && /^RPC/.test(m.name)) {
      const rec = app.tri?.rpcRecordOf(l);
      if (rec) return { type: 0, rec, name: m.name, id: m.id };
    }
    throw gwError('{image}: its model ({model}) cannot be registered to a point cloud (RPC, RSM, pushbroom, frame and map models can)', { image: l.rec?.name ?? l.info?.iid, model: m?.name ?? '—' }, 'E_LREG_MODEL');
  }

  /** Ground sample distance of the image at its centre (m per pixel). */
  function gsdOf(l) {
    const a = l.groundAt(l.width / 2, l.height / 2);
    const b = l.groundAt(l.width / 2 + 1, l.height / 2);
    const c = l.groundAt(l.width / 2, l.height / 2 + 1);
    if (!a || !b || !c) return NaN;
    return (app.core.inverse(a.lat, a.lon, b.lat, b.lon).distance + app.core.inverse(a.lat, a.lon, c.lat, c.lon).distance) / 2;
  }

  /** A 1-2-5 step at or above v. */
  const nice = (v) => {
    const e = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 5, 10].map((k) => k * e).find((s) => s >= v * (1 - 1e-9));
  };

  /** Cut posts [i0, i1) × [j0, j1) out of a grid. */
  function crop(g, z, i0, j0, w, hh) {
    const out = new Float32Array(w * hh);
    for (let j = 0; j < hh; j++) out.set(z.subarray((j0 + j) * g.w + i0, (j0 + j) * g.w + i0 + w), j * w);
    return out;
  }

  const bilinear = (z, w, hh, fi, fj) => {
    if (!(fi >= 0 && fj >= 0 && fi <= w - 1 && fj <= hh - 1)) return NaN;
    const i0 = Math.min(w - 2, Math.floor(fi));
    const j0 = Math.min(hh - 2, Math.floor(fj));
    const tx = fi - i0;
    const ty = fj - j0;
    const a = (i, j) => z[j * w + i];
    return (a(i0, j0) * (1 - tx) + a(i0 + 1, j0) * tx) * (1 - ty) + (a(i0, j0 + 1) * (1 - tx) + a(i0 + 1, j0 + 1) * tx) * ty;
  };

  /**
   * Register image layer `layer` (id or layer) to cloud `cloud` (a cloud or its index in clouds()).
   * Returns the report; nothing is applied.
   */
  async function run({ layer, cloud = 0, reference = 'both', cell = null, sunAz = NaN, sunEl = 45, maxOffset = 60, bias = 'shift', datum = 0, datumSigma = null, lidarSigmaH = 0.3, lidarSigmaV = 0.5, holdOut = 5, survey = null, tile = 64, spacing = null, minPeak = 0.05, minRatio = 1.3, minNcc = 0.3, ransacTol = null, signal = null, onProgress = () => {} } = {}) {
    const t0 = performance.now();
    const l = typeof layer === 'string' ? app.layers.get(layer) : layer;
    if (!l?.handle || !l.modelId) throw gwError('choose an image with a sensor model', null, 'E_STEP_FIRST');
    const c = typeof cloud === 'number' ? clouds()[cloud] : cloud;
    if (!c?.pos) throw gwError('open a point cloud (LAS or LAZ) first', null, 'E_STEP_FIRST');
    if (!(reference in REFS)) throw gwError('unknown reference {ref}', { ref: reference }, 'E_LREG_REF');
    if (![0, 3, 7].includes(datum)) throw gwError('the datum shift has 0, 3 or 7 parameters', null, 'E_LREG_DATUM');
    const hasIntensity = c.intensity?.some?.((v) => v > 0);
    if (reference === 'intensity' && !hasIntensity) throw gwError('{cloud} has no intensity: use the hillshade', { cloud: c.name }, 'E_LREG_NO_INTENSITY');
    const rec = recordOf(l);
    const gsd = gsdOf(l);
    if (!(gsd > 0)) throw gwError('{image}: the ground sample distance could not be found from its model', { image: l.rec.name }, 'E_LREG_GSD');
    const st = c.stats;
    const spacingM = Math.sqrt(Math.max(1, (st.max[0] - st.min[0]) * (st.max[1] - st.min[1])) / Math.max(1, c.n));
    let cellM = cell ?? nice(Math.max(gsd, spacingM, 0.25));
    while (((st.max[0] - st.min[0]) / cellM) * ((st.max[1] - st.min[1]) / cellM) > MAX_POSTS) cellM = nice(cellM * 1.01);
    const cancelled = () => {
      if (signal?.cancelled) throw Object.assign(gwError('LiDAR registration cancelled', null, 'E_CANCELLED'), { cancelled: true });
    };
    // 1. Grids from the cloud (2.4 rasterisers).
    onProgress(0.02, t('Gridding the cloud'));
    const dsm = await app.pc.makeGrid(c, 'dsm', { cell: cellM });
    cancelled();
    const inten = reference !== 'hillshade' && hasIntensity ? await app.pc.makeGrid(c, 'intensity', { cell: cellM }) : null;
    const g = dsm.grid;
    const tGrid = performance.now();
    // 2. The image's footprint on the grid (corners at the cloud's mean height).
    const zs = [st.min[2], st.max[2]];
    const zMid = (zs[0] + zs[1]) / 2;
    const toLocal = (lat, lon) => [(lon - c.origin.lon0) * c.origin.kx, (lat - c.origin.lat0) * c.origin.ky];
    const toGeo = (e, n) => ({ lat: c.origin.lat0 + n / c.origin.ky, lon: c.origin.lon0 + e / c.origin.kx });
    const corners = [[0, 0], [l.width, 0], [l.width, l.height], [0, l.height]].map(([x, y]) => l.groundAt(x, y, zMid)).filter(Boolean).map((q) => toLocal(q.lat, q.lon));
    if (corners.length < 4) throw gwError('{image}: its footprint could not be found from its model', { image: l.rec.name }, 'E_LREG_FOOTPRINT');
    const ix = (e) => (e - g.e0) / g.ce;
    const jx = (n) => (g.n0 - n) / g.cn;
    const i0 = Math.max(0, Math.ceil(Math.min(...corners.map((q) => ix(q[0])))));
    const i1 = Math.min(g.w, Math.floor(Math.max(...corners.map((q) => ix(q[0])))));
    const j0 = Math.max(0, Math.ceil(Math.min(...corners.map((q) => jx(q[1])))));
    const j1 = Math.min(g.h, Math.floor(Math.max(...corners.map((q) => jx(q[1])))));
    const W = i1 - i0;
    const H = j1 - j0;
    if (W < tile * 2 || H < tile * 2) throw gwError('the image and the cloud overlap by under {n} × {n} posts of {cell} m', { n: tile * 2, cell: num(cellM, 2) }, 'E_LREG_OVERLAP');
    const sub = { e0: g.e0 + i0 * g.ce, n0: g.n0 - j0 * g.cn, w: W, h: H };
    const zdsm = crop(g, dsm.heights, i0, j0, W, H);
    const zint = inten ? crop(g, inten.heights, i0, j0, W, H) : new Float32Array(0);
    // 3. The image over that area plus the search margin.
    const margin = maxOffset + 2 * cellM;
    const pts = [];
    for (const [e, n] of [[sub.e0 - margin, sub.n0 + margin], [sub.e0 + W * cellM + margin, sub.n0 + margin], [sub.e0 + W * cellM + margin, sub.n0 - H * cellM - margin], [sub.e0 - margin, sub.n0 - H * cellM - margin]])
      for (const z of zs) {
        const q = toGeo(e, n);
        const p = l.imageAt(q.lat, q.lon, z);
        if (p) pts.push(p);
      }
    if (pts.length < 4) throw gwError('{image}: the cloud area could not be projected into it', { image: l.rec.name }, 'E_LREG_FOOTPRINT');
    const step = Math.max(1, Math.round(cellM / gsd));
    const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x))));
    const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
    const x1 = Math.min(l.width, Math.ceil(Math.max(...pts.map((p) => p.x))));
    const y1 = Math.min(l.height, Math.ceil(Math.max(...pts.map((p) => p.y))));
    const cw = Math.ceil((x1 - x0) / step);
    const ch = Math.ceil((y1 - y0) / step);
    if (cw < 16 || ch < 16) throw gwError('the cloud lies outside {image}', { image: l.rec.name }, 'E_LREG_OVERLAP');
    if (cw * ch > MAX_CHIP) throw gwError('the image area under the cloud is {w} × {h} samples; use a coarser grid cell', { w: int(cw), h: int(ch) }, 'E_LREG_SIZE');
    // The displayed bands that exist (a one-band image may be shown as [0, 0, 0] or [0, 1, 2]).
    const nb = Math.max(1, l.bands ?? 1);
    const shown = [...new Set((l.chain?.bands ?? [0]).filter((b) => b >= 0 && b < nb))];
    if (!shown.length) shown.push(0);
    const nir = nb >= 4 ? 3 : shown[0];
    const want = [];
    if (reference !== 'hillshade' && hasIntensity) want.push(['intensity', [nir]]);
    if (reference !== 'intensity') want.push(['hillshade', shown.slice(0, 3)]);
    onProgress(0.25, t('Reading the image'));
    const chips = [];
    for (const [k, bands] of want) {
      const r = await app.pool.run('window', { handle: l.handle, x0, y0, w: cw, h: ch, step, bands }, { affinity: l.affinity, label: t('LiDAR registration: read the image') });
      const px = new Float32Array(r.w * r.h);
      for (const p of r.planes) for (let q = 0; q < px.length; q++) px[q] += p[q] / r.planes.length;
      // The window samples full-resolution pixel x0 + i·step (its centre at + 0.5): chip x0 so
      // that chip centre (i + 0.5)·step + x0 lands there.
      chips.push({ k, px, w: r.w, h: r.h, x0: r.x0 + 0.5 - 0.5 * step, y0: r.y0 + 0.5 - 0.5 * step, step });
      cancelled();
    }
    const tRead = performance.now();
    // 4. Match per reference.
    const o = c.origin;
    const regs = [];
    for (const [n, ck] of chips.entries()) {
      onProgress(0.35 + 0.35 * (n / chips.length), t('Matching the image to the {ref}', { ref: tr(REF_NAMES[ck.k]) }));
      const prm = Float64Array.from([rec.type, rec.rec.length, ...rec.rec, o.lat0, o.lon0, o.kx, o.ky, sub.e0, sub.n0, cellM, W, H, ck.w, ck.h, ck.x0, ck.y0, ck.step, REFS[ck.k], sunAz, sunEl, tile, spacing ?? tile, maxOffset, minPeak, minRatio, minNcc, ransacTol ?? Math.max(1.5, 3 * cellM), holdOut]);
      const d = Float32Array.from(zdsm);
      const iv = ck.k === 'intensity' ? Float32Array.from(zint) : new Float32Array(0);
      try {
        const r = await analysis('lidarreg', { prm, dsm: d, inten: iv, chip: ck.px }, [prm.buffer, d.buffer, iv.buffer, ck.px.buffer]);
        regs.push({ reference: ck.k, ...r });
      } catch (e) {
        regs.push({ reference: ck.k, error: msgOf(e) });
      }
      cancelled();
    }
    const tMatch = performance.now();
    // Two references must agree: one whose median shift is far from the stronger one's is dropped.
    const med = (v) => v.slice().sort((a, b) => a - b)[v.length >> 1];
    const shiftOf = (r) => {
      const inl = r.matches.filter((m) => m[11]);
      return [med(inl.map((m) => m[3])), med(inl.map((m) => m[4]))];
    };
    const good = regs.filter((r) => !r.error).sort((a, b) => b.inliers - a.inliers);
    if (good.length > 1) {
      const [e0, n0] = shiftOf(good[0]);
      const tol = 3 * (ransacTol ?? Math.max(1.5, 3 * cellM));
      for (const r of good.slice(1)) {
        const [e1, n1] = shiftOf(r);
        if (Math.hypot(e1 - e0, n1 - n0) > tol) r.error = t('its shift ({e}, {n} m) disagrees with the {ref} ({e0}, {n0} m); not used', { e: num(e1, 1), n: num(n1, 1), ref: tr(REF_NAMES[good[0].reference]), e0: num(e0, 1), n0: num(n0, 1) });
      }
    }
    const ok = regs.filter((r) => !r.error);
    if (!ok.length) throw gwError('the image did not match the cloud: {msg}', { msg: regs.map((r) => r.error).join('; ') }, 'E_LREG_NOMATCH');
    // 5. Control and the joint adjustment (block job version 3).
    onProgress(0.75, t('Solving the image and the datum shift'));
    const pxPerM = 1 / gsd;
    const sigmaPx = 0.5 * cellM * pxPerM;
    const points = [];
    const obs = [];
    for (const r of ok)
      for (const m of r.matches) {
        const [e, n, z, de, dn, x, y, peak, ratio, ncc, src, inlier, check] = m;
        if (!inlier) continue;
        const q = toGeo(e, n);
        points.push({ kind: check ? 4 : 3, lat: q.lat, lon: q.lon, h: z, e, n, de, dn, peak, ratio, ncc, src });
        obs.push([0, points.length - 1, x, y, sigmaPx]);
      }
    if (points.filter((p) => p.kind === 3).length < 3) throw gwError('only {n, plural, one {# match} other {# matches}} passed the checks: too few to solve', { n: points.length }, 'E_LREG_NOMATCH');
    const centreGeo = toGeo(sub.e0 + (W * cellM) / 2, sub.n0 - (H * cellM) / 2);
    const centre = { ...centreGeo, h: bilinear(zdsm, W, H, W / 2, H / 2) };
    if (!Number.isFinite(centre.h)) centre.h = zMid;
    const dsig = (datumSigma ?? DATUM_SIGMA).slice(0, datum);
    // Surveyed points on the cloud: the surface height and slope there (DTM when the cloud is classified).
    let cloudObs = [];
    if (survey?.length) {
      const hasGround = c.class?.some?.((v) => v === 2);
      const surf = hasGround ? await app.pc.makeGrid(c, 'dtm', { cell: cellM }) : dsm;
      const zs2 = crop(g, surf.heights, i0, j0, W, H);
      for (const s of survey) {
        const [e, n] = toLocal(s.lat, s.lon);
        const fi = (e - sub.e0) / cellM;
        const fj = (sub.n0 - n) / cellM;
        const z = bilinear(zs2, W, H, fi, fj);
        if (!Number.isFinite(z)) continue;
        const gE = (bilinear(zs2, W, H, fi + 1, fj) - bilinear(zs2, W, H, fi - 1, fj)) / (2 * cellM);
        const gN = (bilinear(zs2, W, H, fi, fj - 1) - bilinear(zs2, W, H, fi, fj + 1)) / (2 * cellM);
        cloudObs.push({ id: s.id, lat: s.lat, lon: s.lon, h: s.h, z, gE: Number.isFinite(gE) ? gE : 0, gN: Number.isFinite(gN) ? gN : 0, sigma: Math.hypot(s.sigma, 0.1), check: s.check });
      }
    }
    const centrePx = l.imageAt(centre.lat, centre.lon, centre.h) ?? { x: l.width / 2, y: l.height / 2 };
    const half = [Math.max(1, (cw * step) / 2), Math.max(1, (ch * step) / 2)];
    const f = jointJob({ rec, bias, centrePx, half, points, obs, sigmaH: lidarSigmaH, sigmaV: lidarSigmaV, datum, datumSigma: dsig, centre, cloud: cloudObs });
    const sol = await analysis('adjust', { job: f }, [f.buffer]);
    const tSolve = performance.now();
    // 6. GPM-style propagation of the datum shift's covariance (global part) and the cloud control's
    // σ (local part, uncorrelated) to the area's centre and corners.
    let gpm = null;
    const probes = [[W / 2, H / 2], [0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]].map(([i, j]) => {
      const q = toGeo(sub.e0 + i * cellM, sub.n0 - j * cellM);
      const z = bilinear(zdsm, W, H, i, j);
      return [q.lat, q.lon, Number.isFinite(z) ? z : centre.h, lidarSigmaH, lidarSigmaH, lidarSigmaV];
    });
    if (datum) {
      const gj = Float64Array.from([datum, centre.lat, centre.lon, centre.h, ...sol.datumCov, probes.length, ...probes.flat(), 0, 0, 0, 1]);
      gpm = await analysis('gpm', { job: gj }, [gj.buffer]);
    }
    const img = sol.images[0];
    const k = Math.round(Math.sqrt(img.cov.length));
    // The correction in ground metres at the centre (bias c: Δy terms 0..2, Δx terms 3..5).
    const corr = { dx: img.c[3], dy: img.c[0], sx: Math.sqrt(Math.max(0, img.cov[(k / 2) * k + k / 2] ?? NaN)), sy: Math.sqrt(Math.max(0, img.cov[0] ?? NaN)) };
    const report = {
      kind: 'gisworkbench-lidar-registration',
      version: 1,
      created: new Date().toISOString(),
      image: { layer: l.id, name: l.rec.name, iid: l.info.iid, model: rec.name, gsd },
      cloud: { name: c.name, points: c.n, cell: cellM, posts: [W, H] },
      reference,
      options: { sunAz, sunEl, maxOffset, bias, datum, datumSigma: dsig, lidarSigmaH, lidarSigmaV, holdOut, tile, sigmaPx },
      registration: regs.map((r) => ({ reference: r.reference, error: r.error ?? null, tiles: r.tiles, accepted: r.accepted, inliers: r.inliers, coarse: r.coarse, sunAz: r.sunAz, rmsM: r.rmsM })),
      counts: { control: points.filter((p) => p.kind === 3).length, heldOut: points.filter((p) => p.kind === 4).length, survey: cloudObs.length },
      solution: { sigma0: sol.sigma0, dof: sol.dof, iterations: sol.iterations, converged: sol.converged, bias: img.c, biasCov: img.cov, centre: [centrePx.x, centrePx.y], half, correctionPx: corr, correctionM: { e: corr.dx * gsd, n: -corr.dy * gsd } },
      datum: { k: datum, names: DATUM_NAMES.slice(0, datum), values: sol.datum, cov: sol.datumCov, sigma: (sol.datum ?? []).map((_, m) => Math.sqrt(Math.max(0, sol.datumCov[m * datum + m]))) },
      heldOut: { before: sol.lidarBefore, after: sol.lidarAfter },
      survey: cloudObs.map((s, q) => ({ id: s.id, check: s.check, before: sol.cloud[q][0], after: sol.cloud[q][1], sigmaAfter: sol.cloud[q][2] })),
      surveyChecks: { before: sol.cloudBefore, after: sol.cloudAfter },
      gpm: gpm ? { probes: ['centre', 'NW', 'NE', 'SE', 'SW'], ce90: gpm.ce90, le90: gpm.le90, relCe90: gpm.relCe90, relLe90: gpm.relLe90 } : null,
      seconds: { grid: (tGrid - t0) / 1000, read: (tRead - tGrid) / 1000, match: (tMatch - tRead) / 1000, solve: (tSolve - tMatch) / 1000, total: (performance.now() - t0) / 1000 },
      _base: { name: rec.name },
    };
    onProgress(1, t('Done'));
    app.lidarreg.last = report;
    return report;
  }

  /** Store the image correction as a triangulation solution (undoable); returns its label. */
  function apply(rep) {
    if (!app.tri?.applySolution) throw gwError('the triangulation feature is not available', null, 'E_LREG_TRI');
    const s = rep.solution;
    const r = {
      kind: rep.options.bias,
      layers: [rep.image.layer],
      sigma0: s.sigma0,
      dof: s.dof,
      counts: { images: 1, gcps: rep.counts.control, checkpoints: rep.counts.heldOut, ties: 0, observations: rep.counts.control + rep.counts.heldOut },
      before: rep.heldOut.before,
      after: rep.heldOut.after,
      gcpResiduals: [],
      images: [{ layer: rep.image.layer, image: rep.image.iid, base: rep.image.model, c: s.bias, cov: s.biasCov, params: null, paramNames: null, centre: s.centre, half: s.half, fixed: false }],
      residuals: [],
    };
    return app.tri.applySolution(r);
  }

  const reportText = (rep) => JSON.stringify(rep, null, 1);

  // ---- the dialog and the report ----
  function reportView(rep) {
    const fmt = (v, d = 2) => (Number.isFinite(v) ? num(v, d) : '—');
    const stats = (s) => (s?.n ? t('{n, plural, one {# point} other {# points}}: RMSE E {e} · N {n2} · horizontal {r} m · CE90 {ce} m', { n: s.n, e: fmt(s.rmse[0]), n2: fmt(s.rmse[1]), r: fmt(s.rmseR), ce: fmt(s.ce90) }) : t('none'));
    const zstats = (s) => (s?.n ? t('{n, plural, one {# point} other {# points}}: RMSE {u} m, largest {m} m', { n: s.n, u: fmt(s.rmse[2], 3), m: fmt(s.max[2], 3) }) : t('none'));
    const th = (...cols) => h('thead', {}, h('tr', {}, ...cols.map((x) => h('th', { scope: 'col' }, x))));
    const regRows = rep.registration.map((r) => h('tr', {}, h('td', {}, tr(REF_NAMES[r.reference])), ...(r.error ? [h('td', { colspan: '4' }, r.error)] : [h('td', {}, int(r.tiles)), h('td', {}, int(r.accepted)), h('td', {}, int(r.inliers)), h('td', {}, t('{e}, {n} m', { e: fmt(r.coarse[0], 1), n: fmt(r.coarse[1], 1) }))])));
    const datumRows = rep.datum.values.map((v, m) => h('tr', {}, h('td', {}, tr(rep.datum.names[m])), h('td', {}, fmt(v, 3)), h('td', {}, fmt(rep.datum.sigma[m], 3))));
    const s = rep.solution;
    return h(
      'div',
      { class: 'lreg-report', 'data-id': 'lreg:report' },
      h('p', {}, t('{image} to {cloud} ({cell} m posts, {w} × {h})', { image: rep.image.name, cloud: rep.cloud.name, cell: fmt(rep.cloud.cell, 2), w: int(rep.cloud.posts[0]), h: int(rep.cloud.posts[1]) })),
      h('table', { class: 'grid-table', 'data-id': 'lreg:matches' }, h('caption', {}, t('Matching')), th(t('Reference'), t('Tiles'), t('Passed'), t('Inliers'), t('Coarse shift')), h('tbody', {}, ...regRows)),
      h('p', {}, t('{control, plural, one {# control point} other {# control points}} from the cloud, {held, plural, one {# held out} other {# held out}} as checkpoints · σ₀ {s0} (dof {dof})', { control: rep.counts.control, held: rep.counts.heldOut, s0: fmt(s.sigma0, 3), dof: s.dof })),
      h('p', {}, t('Image correction at the centre: {dx} × {dy} px (σ {sx}, {sy}) = {e} m east, {n} m north', { dx: fmt(s.correctionPx.dx), dy: fmt(s.correctionPx.dy), sx: fmt(s.correctionPx.sx), sy: fmt(s.correctionPx.sy), e: fmt(s.correctionM.e), n: fmt(s.correctionM.n) })),
      h('p', { 'data-id': 'lreg:before' }, t('Held-out checkpoints before: {stats}', { stats: stats(rep.heldOut.before) })),
      h('p', { 'data-id': 'lreg:after' }, t('Held-out checkpoints after: {stats}', { stats: stats(rep.heldOut.after) })),
      rep.datum.k ? h('table', { class: 'grid-table', 'data-id': 'lreg:datum' }, h('caption', {}, t('Datum shift of the cloud (posterior σ)')), th(t('Parameter'), t('Value'), t('σ')), h('tbody', {}, ...datumRows)) : h('p', { class: 'hint' }, t('No datum shift was estimated.')),
      rep.counts.survey ? h('p', {}, t('Surveyed checkpoints on the cloud before: {b}; after: {a}', { b: zstats(rep.surveyChecks.before), a: zstats(rep.surveyChecks.after) })) : null,
      rep.gpm ? h('p', {}, t('Propagated from the shift and the cloud σ (GPM-style, global and local error): CE90 {ce} m and LE90 {le} m at the centre; between the corners CE90 {rce} m', { ce: fmt(rep.gpm.ce90[0]), le: fmt(rep.gpm.le90[0]), rce: fmt(Math.max(...rep.gpm.relCe90)) })) : null,
      h('p', { class: 'hint' }, t('Grid {g} s · image {r} s · matching {m} s · solve {s} s', { g: fmt(rep.seconds.grid, 1), r: fmt(rep.seconds.read, 1), m: fmt(rep.seconds.match, 1), s: fmt(rep.seconds.solve, 2) })),
      h('p', { class: 'hint' }, t('A single image cannot tell its own horizontal error from a horizontal shift of the cloud: their split follows the a priori σ. Surveyed points on the cloud fix the vertical shift.')),
    );
  }

  async function dialog() {
    const ls = images();
    const cs = clouds();
    if (!ls.length || !cs.length) return toast(t('Open an image with a sensor model and a point cloud first'), { kind: 'warn' });
    const sel = (label, opts, value) => {
      const s = h('select', { class: 'inp', 'aria-label': label }, ...opts.map(([v, txt]) => h('option', { value: v }, txt)));
      if (value != null) s.value = value;
      return s;
    };
    const active = app.activeLayer?.() ?? null;
    const image = sel(t('Image'), ls.map((l) => [l.id, l.rec.name]), ls.includes(active) ? active.id : ls[0].id);
    const cloud = sel(t('Point cloud'), cs.map((c, k) => [String(k), t('{cloud} ({n} points)', { cloud: c.name, n: int(c.n) })]), String(cs.length - 1));
    const ref = sel(t('Reference'), Object.keys(REFS).map((k) => [k, tr(REF_NAMES[k])]), 'both');
    const bias = sel(t('Image correction'), [['shift', t('Shift')], ['drift', t('Shift + drift')], ['affine', t('Affine')]], 'shift');
    const datum = sel(t('Datum shift of the cloud'), [['0', t('None')], ['3', t('3 parameters (translations)')], ['7', t('7 parameters (translations, rotations, scale)')]], '0');
    const numIn = (label, v, stepv = 'any') => h('input', { class: 'inp', type: 'number', step: stepv, value: String(v), 'aria-label': label });
    const maxOff = numIn(t('Largest image error to search (m)'), 60);
    const cell = numIn(t('Grid cell (m, empty: automatic)'), '');
    cell.value = '';
    const sigmaH = numIn(t('Cloud horizontal σ (m)'), 0.3);
    const sigmaV = numIn(t('Cloud vertical σ (m)'), 0.5);
    const dsH = numIn(t('Shift a priori σ, horizontal (m)'), 1);
    const dsV = numIn(t('Shift a priori σ, vertical (m)'), 0.5);
    const hold = numIn(t('Hold out every n-th match as a checkpoint'), 5, '1');
    const sun = numIn(t('Sun azimuth for the hillshade (°, empty: search)'), '');
    sun.value = '';
    let survey = null;
    const surveyNote = h('span', { class: 'hint' }, t('none'));
    const surveyBtn = h('button', { type: 'button', class: 'btn', 'data-id': 'lreg:survey' }, t('Surveyed Points (CSV)…'));
    surveyBtn.addEventListener('click', async () => {
      const [file] = (await pickFiles(app, { multiple: false, accept: ['.csv', '.txt', '.tsv'], description: t('Surveyed points') })) ?? [];
      if (!file) return;
      try {
        survey = parseSurvey(await file.text());
        surveyNote.textContent = t('{n, plural, one {# point} other {# points}} ({c} checkpoints)', { n: survey.length, c: survey.filter((s) => s.check).length });
      } catch (e) {
        survey = null;
        surveyNote.textContent = msgOf(e);
      }
    });
    const body = h(
      'div',
      { 'data-id': 'lreg:dialog' },
      field(t('Image'), image),
      field(t('Point cloud'), cloud),
      field(t('Reference'), ref, t('Intensity is matched with the near-infrared band when the image has one; the hillshade with the displayed bands.')),
      section(t('Adjustment'), field(t('Image correction'), bias), field(t('Datum shift of the cloud'), datum), field(t('Shift a priori σ, horizontal (m)'), dsH), field(t('Shift a priori σ, vertical (m)'), dsV), field(t('Cloud horizontal σ (m)'), sigmaH), field(t('Cloud vertical σ (m)'), sigmaV)),
      section(t('Matching'), field(t('Largest image error to search (m)'), maxOff), field(t('Grid cell (m, empty: automatic)'), cell), field(t('Sun azimuth for the hillshade (°, empty: search)'), sun), field(t('Hold out every n-th match as a checkpoint'), hold)),
      section(t('Surveyed points on the cloud'), h('div', { class: 'row' }, surveyBtn, surveyNote), h('p', { class: 'hint' }, t('CSV with id, lat, lon, hae (heights as the cloud: above the ellipsoid), role (control or check) and sigma. Control points fix the datum shift; checkpoints test it.'))),
    );
    if ((await modal({ title: t('Register Image to LiDAR'), body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'lidar-register', width: 560 })) !== 'run') return;
    const k = Number(datum.value);
    const sH = Number(dsH.value) > 0 ? Number(dsH.value) : 1;
    const sV = Number(dsV.value) > 0 ? Number(dsV.value) : 0.5;
    const signal = { cancelled: false };
    toast(t('LiDAR registration started'), { kind: 'info', action: { label: t('Cancel'), run: () => (signal.cancelled = true) } });
    let rep;
    try {
      rep = await app.activity.track(t('LiDAR registration…'), (job) => run({
        layer: image.value,
        cloud: cs[Number(cloud.value)],
        reference: ref.value,
        bias: bias.value,
        datum: k,
        datumSigma: [sH, sH, sV, 50, 50, 50, 50],
        maxOffset: Number(maxOff.value) > 0 ? Number(maxOff.value) : 60,
        cell: Number(cell.value) > 0 ? Number(cell.value) : null,
        sunAz: sun.value.trim() === '' ? NaN : Number(sun.value),
        lidarSigmaH: Number(sigmaH.value) > 0 ? Number(sigmaH.value) : 0.3,
        lidarSigmaV: Number(sigmaV.value) > 0 ? Number(sigmaV.value) : 0.5,
        holdOut: Math.max(0, Math.round(Number(hold.value) || 0)),
        survey,
        signal,
        onProgress: (f, what) => job.set(f, what),
      }), { cancel: () => (signal.cancelled = true) });
    } catch (e) {
      return toast(t('LiDAR registration: {msg}', { msg: msgOf(e) }), { kind: e?.cancelled || /^E_(STEP_FIRST|LREG_OVERLAP|LREG_NO_INTENSITY|CANCELLED)$/.test(e?.code ?? '') ? 'warn' : 'error', ms: 9000 });
    }
    await showReport(rep);
  }

  async function showReport(rep) {
    const r = await modal({ title: t('LiDAR Registration Report'), body: reportView(rep), buttons: [{ label: t('Apply'), value: 'apply', primary: true }, { label: t('Save Report…'), value: 'save' }, { label: t('Close'), value: 'close' }], id: 'lidar-register-report', width: 640 });
    if (r === 'apply') {
      const label = apply(rep);
      toast(t('{image}: corrected by solution {label}', { image: rep.image.name, label }), { kind: 'info' });
    } else if (r === 'save') {
      await saveBlob(app, new Blob([reportText(rep)], { type: 'application/json' }), { name: `${rep.image.name.replace(/\.[^.]+$/, '')}_lidar-registration.json`, description: t('Registration report') });
    }
  }

  C.implement('pc.registerimage', { enabled: () => images().length > 0 && clouds().length > 0, run: dialog });
  Object.assign(app.lidarreg, { run, apply, parseSurvey, reportText, reportView, showReport, clouds, images, recordOf, last: app.lidarreg.last ?? null });
}
