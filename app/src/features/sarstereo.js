// SAR stereo terrain (REQ-GAP-42, GR-15; 2.5 group sarstereo): radargrammetry from two SICDs.
// Lazy (js-sarstereo block, features/sarstereo-lazy.js holds the commands until it loads).
//
// * SAR ▸ Stereo ▸ Stereo Pair Finder: every pair of the open SICDs with its intersection angle,
//   same or opposite side, look directions, incidences, days apart, overlap and height
//   sensitivity (gw_sar::radargram::find_pairs, analysis worker).
// * SAR ▸ Stereo ▸ SAR Stereo DSM: the AOI's posts are sampled in both images through the SICD
//   models on the ground (multilooked over each post's ground cell), matched on log intensity
//   (ZNCC or log-ratio) coarse to fine about the prior DEM (Copernicus GLO-30), with layover and
//   shadow masks from the geometry and the prior, the cross-parallax shift of the second image
//   searched, and a height and σ per post (gw_sar::radargram::Job, stepped in the analysis
//   worker). The image chips are read in tiles (decode worker) and multilooked in the analysis
//   worker. The product is a four-band float32 GeoTIFF (height HAE, σ, score, flags) opened as
//   terrain.
// * SAR ▸ Stereo ▸ DSM Accuracy Report: a DSM (this one or any terrain) against a reference
//   terrain (analysis/sarstereo-report.js).

import { h } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { writeGeoTiff, gdalMetadataXml } from '../formats/geotiff-writer.js';
import { openImageFile } from '../formats/open.js';
import { saveBlob, textBlob } from '../storage/files.js';
import { t, N_, tr, gwError, msgOf } from '../i18n/index.js';
import { num, int, pct } from '../i18n/format.js';
import { dsmAccuracy, reportCsv, levelDsm, FLAG } from '../analysis/sarstereo-report.js';

export const name = 'sarstereo';

/** Matching costs and speckle filters offered (codes of gw_sar::radargram and the speckle filters). */
export const COSTS = [
  ['zncc', 0, N_('ZNCC of log intensity')],
  ['logratio', 1, N_('Log-ratio')],
];
export const DESPECKLE = [
  ['none', 0, N_('None (multilooked over each post)')],
  ['lee', 2, N_('Lee filter, then multilooked')],
  ['refinedlee', 6, N_('Refined Lee filter, then multilooked')],
];

/** Defaults of a DSM job (gw_sar_stereo_new parameters). */
export const DEFAULTS = { levels: 3, window: 4, searchM: 60, stepFrac: 0.5, cost: 'zncc', minScore: 0.3, minMargin: 0.03, shiftM: 30, anchor: false, maskStepM: 5, maskTol: 0.5, subs: 2, priorSigma: 4, despeckle: 'none', latticeStep: 8, sizeM: 1000 };

/**
 * GDAL metadata for a saved DSM ({dataset, bands}, for gdalMetadataXml): the items a reopened file is
 * read by (GWB_PRODUCT, GWB_SAME_SIDE, GWB_PRIOR) and band names other tools show. `full` is the
 * four-band product.
 */
export function dsmItems(dsm, full) {
  const dataset = full ? { GWB_PRODUCT: 'SAR_STEREO_DSM', GWB_SAME_SIDE: dsm.stats?.geometry?.sameSide === false ? '0' : '1' } : {};
  if (dsm.prior) dataset.GWB_PRIOR = dsm.prior;
  return { dataset, bands: full ? ['height', 'sigma', 'score', 'flags'] : [] };
}

/**
 * What a reopened file says about itself, from its GDAL items (meta.gdalItems) and, for a file 2.6
 * wrote (prose only, never levelled, so never cut short), its ImageDescription. A tagged product
 * whose pair side is missing reads as opposite-side, so it is refused rather than levelled.
 * Returns {product, sameSide, prior}.
 */
export function dsmFileFacts(items = {}, desc = '') {
  if (items.GWB_PRODUCT != null) return { product: items.GWB_PRODUCT === 'SAR_STEREO_DSM', sameSide: items.GWB_SAME_SIDE === '1', prior: items.GWB_PRIOR ?? null };
  const legacy = /SAR stereo DSM \(radargrammetry\)/.test(desc);
  return { product: legacy, sameSide: !/opposite-side pair/.test(desc), prior: items.GWB_PRIOR ?? (legacy ? /; prior (.*?)(?:; opposite-side pair, not recommended)?$/.exec(desc)?.[1] ?? null : null) };
}

const RUN_CANCEL = () => [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }];

/** Metres per degree of latitude and longitude (WGS 84 series). */
export function metresPerDegree(lat) {
  const p = (lat * Math.PI) / 180;
  return [111_132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p), 111_412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p)];
}

/** Yield to the event loop (long main-thread loops stay responsive). */
const tick = () => new Promise((r) => setTimeout(r, 0));

export function install(app) {
  const C = app.commands;
  const core = app.core;
  const sarOf = (l) => l?.info?.sar ?? null;
  const isSicd = (l) => sarOf(l)?.kind === 'SICD' && Array.isArray(sarOf(l)?.record) && !!l.modelId && !!l.handle;
  const sicds = () => [...app.layers.values()].filter(isSicd);
  const terrains = () => app.terrain?.dems ?? [];
  const pane = () => app.activePane();

  // ---- pair finder ----

  async function findPairs(layers = sicds(), limits = {}) {
    if (layers.length < 2) throw gwError('the stereo pair finder needs two or more SICD images', null, 'E_SARSTEREO_NEED_TWO');
    const collects = layers.map((l) => ({ start: Date.parse(sarOf(l).collectStart ?? '') / 1000, record: sarOf(l).record }));
    const pairs = await app.pool.run('sar.stereoPairs', { collects, limits }, { kind: 'analysis', label: t('SAR stereo pair finder') });
    return pairs.map((q) => ({ ...q, a: layers[q.a], b: layers[q.b] }));
  }

  const REASON = { overlap: N_('too little overlap'), geometry: N_('no common ground'), weak: N_('intersection angle too small'), wide: N_('intersection angle too wide for a same-side pair'), days: N_('too long between the collects') };
  const opposite = (q) => q.ok && q.notes.includes('opposite');
  const verdict = (q) => (q.ok ? (opposite(q) ? t('poor: opposite side, not recommended') : t('suitable')) : q.reasons.map((r) => tr(REASON[r] ?? r)).join('; '));

  async function pairsDialog() {
    const pairs = await findPairs();
    let pick = pairs.findIndex((q) => q.ok && !opposite(q));
    if (pick < 0) pick = 0;
    const rows = pairs.map((q, k) => {
      const g = q.geometry;
      const radio = h('input', { type: 'radio', name: 'sarstereo-pair', value: String(k), checked: k === pick, 'aria-label': t('Use {a} + {b}', { a: q.a.rec?.name ?? '', b: q.b.rec?.name ?? '' }) });
      radio.addEventListener('change', () => (pick = k));
      return h(
        'tr',
        { class: q.ok && !opposite(q) ? '' : 'muted', 'data-id': `sarstereo:pair:${k}` },
        h('td', {}, radio),
        h('td', {}, q.a.rec?.name ?? ''),
        h('td', {}, q.b.rec?.name ?? ''),
        h('td', {}, g ? (g.sameSide ? t('same') : t('opposite')) : '–'),
        h('td', {}, g ? num(g.intersectionDeg, 1) : '–'),
        h('td', {}, g ? num(g.dAzimuthDeg, 1) : '–'),
        h('td', {}, g ? `${num(g.incidenceDeg[0], 1)} / ${num(g.incidenceDeg[1], 1)}` : '–'),
        h('td', {}, g ? `${g.left[0] ? 'L' : 'R'} / ${g.left[1] ? 'L' : 'R'}` : '–'), // i18n-ignore: SICD SideOfTrack codes
        h('td', {}, num(q.days, 1)),
        h('td', {}, pct(q.overlap, 0)),
        h('td', {}, g ? num(g.parallax, 2) : '–'),
        h('td', {}, g && g.parallax > 0 ? num((0.25 * 2) / g.parallax, 1) : '–'),
        h('td', {}, verdict(q)),
      );
    });
    const head = [' ', t('Image A'), t('Image B'), t('Side'), t('Intersection °'), t('ΔAzimuth °'), t('Incidence °'), t('Look'), t('Days'), t('Overlap'), t('Parallax (m/m)'), t('σ a priori (m)'), t('Result')];
    const body = h(
      'div',
      {},
      h('div', { class: 'tbl-wrap', style: { overflowX: 'auto' } }, h('table', { class: 'tbl', 'data-id': 'sarstereo-pairs' }, h('thead', {}, h('tr', {}, ...head.map((x, i) => h('th', { scope: 'col' }, i === 0 ? h('span', { class: 'sr-only' }, t('Use')) : x)))), h('tbody', {}, ...rows))),
      h('p', { class: 'hint' }, t('Same-side pairs with an intersection angle of about 3° to 20° suit X band (measured: 10° and 16° pairs matched, a 22° pair did not); wider angles give more height per pixel but the two images decorrelate. Parallax is the ground shift between the images per metre of height; the a priori σ is for a quarter-post matching error at 2 m posts, not a measurement.')),
    );
    const r = await modal({ title: t('SAR Stereo Pair Finder'), body, buttons: [{ label: t('Extract DSM…'), value: 'dsm', primary: true }, { label: t('Close'), value: 'close' }], width: 980, id: 'sarstereo-pairs' });
    if (r === 'dsm' && pairs[pick]) return dsmDialog(pairs[pick].a, pairs[pick].b);
    return pairs;
  }

  // ---- DSM ----

  /** Ground box of the active panel's view. */
  function viewBounds() {
    const p = pane();
    const l = p?.geoLayer?.();
    const { w, h: hh } = p.size();
    const gs = [[0, 0], [w, 0], [w, hh], [0, hh], [w / 2, hh / 2]].map(([x, y]) => {
      const v = p.viewPoint(x, y);
      return l?.groundAt(v.x, v.y);
    }).filter((g) => g && Number.isFinite(g.lat));
    if (gs.length < 3) throw gwError('the panel view has no ground position: zoom onto the image', null, 'E_DSM_VIEW_NO_GROUND');
    return { north: Math.max(...gs.map((g) => g.lat)), south: Math.min(...gs.map((g) => g.lat)), east: Math.max(...gs.map((g) => g.lon)), west: Math.min(...gs.map((g) => g.lon)) };
  }

  const coverOf = (d, lat, lon) => !d.bounds || (lat <= d.bounds.north && lat >= d.bounds.south && lon >= d.bounds.west && lon <= d.bounds.east);

  /** Read a chip of `l` over image box [x0, x1) × [y0, y1), multilooked by (mx, my) → mean intensity. */
  async function readChip(l, x0, y0, x1, y1, mx, my, onFrac) {
    const W = Math.floor((x1 - x0) / mx);
    const H = Math.floor((y1 - y0) / my);
    const out = new Float32Array(W * H).fill(NaN);
    // Bands of whole chip rows, read one after the other: a SICD's NITF blocks are often the full
    // image width, and the decoder caches row strips, so each strip is read once.
    const tw = W * mx;
    const th = Math.max(my, Math.floor(Math.max(1, 4e6 / tw) / my) * my);
    const tiles = [];
    for (let ty = 0; ty < H * my; ty += th) for (let tx = 0; tx < W * mx; tx += tw) tiles.push([tx, ty, Math.min(tw, W * mx - tx), Math.min(th, H * my - ty)]);
    let done = 0;
    const one = async ([tx, ty, w, hh]) => {
      const p = await app.pool.run('patch', { handle: l.handle, x: x0 + tx, y: y0 + ty, w, h: hh, band: 0 }, { affinity: l.affinity, label: t('SAR stereo chip {layer}', { layer: l.rec?.name ?? '' }), timeout: 900000 });
      if (p.x0 !== x0 + tx || p.y0 !== y0 + ty || p.w !== w || p.h !== hh) throw gwError('the image tile was not read where asked', null, 'E_SARSTEREO_TILE');
      const m = await app.pool.run('sar.multilook', { v: p.px, w, h: hh, mx, my, amplitude: true }, { kind: 'analysis', transfer: [p.px.buffer], label: t('multilook') });
      const u0 = tx / mx;
      const v0 = ty / my;
      for (let v = 0; v < m.h && v0 + v < H; v++) out.set(m.v.subarray(v * m.w, v * m.w + Math.min(m.w, W - u0)), (v0 + v) * W + u0);
      onFrac?.(++done / tiles.length);
    };
    let next = 0;
    const lanes = Array.from({ length: Math.min(1, tiles.length) }, async () => {
      while (next < tiles.length) await one(tiles[next++]);
    });
    const t0 = performance.now();
    await Promise.all(lanes);
    return { x0, y0, mx, my, w: W, h: H, v: out, tiles: tiles.length, readMs: Math.round(performance.now() - t0) };
  }

  /**
   * Extract a DSM from SICDs L and R. opts: aoi {north, south, west, east} (default: a sizeM box
   * at the centre of the overlap), postM, prior (terrain entry; default the first covering the
   * AOI), searchM, levels, window, cost, despeckle, shiftM, anchor, priorSigma, minScore,
   * minMargin, allowOpposite (an opposite-side pair runs only with this), onProgress(frac), job
   * (gets the pool job, to cancel). Returns {grid, heights,
   * sigma, score, flags, stats, pair, prior, params, ms}.
   */
  async function extract(L, R, opts = {}) {
    const t0 = performance.now();
    if (!isSicd(L) || !isSicd(R)) throw gwError('SAR stereo needs two SICD images with their projection models', null, 'E_SARSTEREO_NOT_SICD');
    if (L === R) throw gwError('choose two different SICD images', null, 'E_SARSTEREO_SAME');
    const o = { ...DEFAULTS, ...opts };
    const progress = (f) => o.onProgress?.(Math.max(0, Math.min(1, f)));
    // Pair geometry at the overlap centre (pair finder) gives the AOI default and the sensitivity.
    const [pq] = await findPairs([L, R]);
    if (!pq?.geometry) throw gwError('the two images do not overlap', null, 'E_SARSTEREO_NO_OVERLAP');
    if (!pq.geometry.sameSide && !o.allowOpposite) throw gwError('this is an opposite-side pair, which is not recommended: tick Run an opposite-side pair to run it anyway', null, 'E_SARSTEREO_OPPOSITE');
    const c = pq.centre;
    let aoi = o.aoi;
    if (!aoi) {
      const [kn0, ke0] = metresPerDegree(c.lat);
      const hs = o.sizeM / 2;
      aoi = { north: c.lat + hs / kn0, south: c.lat - hs / kn0, west: c.lon - hs / ke0, east: c.lon + hs / ke0 };
    }
    const latc = (aoi.north + aoi.south) / 2;
    const lonc = (aoi.west + aoi.east) / 2;
    const prior = o.prior ?? terrains().find((d) => coverOf(d, latc, lonc));
    if (!prior) throw gwError('load a prior DEM as terrain first (for example Copernicus GLO-30 with Use as Terrain)', null, 'E_SARSTEREO_NO_PRIOR');
    const [kn, ke] = metresPerDegree(latc);
    // Post spacing: about four ground resolution cells, at least 1 m.
    const res = Math.max(...[sarOf(L), sarOf(R)].map((m) => Math.max(m.rowRes ?? m.rowSS ?? 1, m.colRes ?? m.colSS ?? 1) / Math.max(0.2, Math.sin((Math.min(80, 90 - (m.graze ?? 45)) * Math.PI) / 180) || 1)));
    const postM = o.postM ?? Math.max(1, Math.round(4 * res));
    const dlat = postM / kn;
    const dlon = postM / ke;
    const nx = Math.floor((aoi.east - aoi.west) / dlon) + 1;
    const ny = Math.floor((aoi.north - aoi.south) / dlat) + 1;
    if (nx < 16 || ny < 16) throw gwError('the area is smaller than 16 × 16 posts', null, 'E_SARSTEREO_SMALL');
    if (nx * ny > 4e6) throw gwError('{n} posts are more than SAR stereo takes (4 M): use a smaller area or larger posts', { n: int(nx * ny) }, 'E_SARSTEREO_TOO_LARGE');
    const grid = { lat0: aoi.north, lon0: aoi.west, dlat, dlon, nx, ny };
    // Prior heights over the area and a margin wide enough for the layover and shadow marches.
    const hae = (lat, lon) => core.demHae(prior.coreId, lat, lon);
    let hmin = Infinity;
    let hmax = -Infinity;
    for (let j = 0; j <= 20; j++)
      for (let i = 0; i <= 20; i++) {
        const v = hae(aoi.south + ((aoi.north - aoi.south) * j) / 20, aoi.west + ((aoi.east - aoi.west) * i) / 20);
        if (Number.isFinite(v)) {
          hmin = Math.min(hmin, v);
          hmax = Math.max(hmax, v);
        }
      }
    if (!Number.isFinite(hmin)) throw gwError('the prior DEM does not cover the area', null, 'E_SARSTEREO_PRIOR_COVER');
    const margin = Math.min(3000, Math.max(300, 2.5 * (hmax - hmin) + 200));
    const pp = Math.max(postM, o.maskStepM);
    const pnx = Math.ceil(((aoi.east - aoi.west) * ke + 2 * margin) / pp) + 1;
    const pny = Math.ceil(((aoi.north - aoi.south) * kn + 2 * margin) / pp) + 1;
    if (pnx * pny > 16e6) throw gwError('the prior DEM area is too large', null, 'E_SARSTEREO_TOO_LARGE');
    const pg = { lat0: aoi.north + margin / kn, lon0: aoi.west - margin / ke, dlat: pp / kn, dlon: pp / ke, nx: pnx, ny: pny };
    const pz = new Float32Array(pnx * pny);
    for (let j = 0; j < pny; j++) {
      for (let i = 0; i < pnx; i++) pz[j * pnx + i] = hae(pg.lat0 - j * pg.dlat, pg.lon0 + i * pg.dlon);
      if (j % 64 === 63) await tick();
    }
    progress(0.02);
    // Image chips: the AOI (plus the shift search and the window) at the lowest and highest heights.
    const pad = o.shiftM + 2 ** o.levels * postM * (o.window + 3) + 30;
    const box = { north: aoi.north + pad / kn, south: aoi.south - pad / kn, west: aoi.west - pad / ke, east: aoi.east + pad / ke };
    const ring = [];
    for (let k = 0; k <= 16; k++) {
      const f = k / 16;
      ring.push([box.north, box.west + f * (box.east - box.west)], [box.south, box.west + f * (box.east - box.west)], [box.south + f * (box.north - box.south), box.west], [box.south + f * (box.north - box.south), box.east]);
    }
    const chipBox = (l) => {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const hh of [hmin - o.searchM - 40, hmax + o.searchM + 40])
        for (const [la, lo] of ring) {
          const p = l.imageAt(la, lo, hh);
          if (!p) continue;
          x0 = Math.min(x0, p.x);
          y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x);
          y1 = Math.max(y1, p.y);
        }
      x0 = Math.max(0, Math.floor(x0) - 16);
      y0 = Math.max(0, Math.floor(y0) - 16);
      x1 = Math.min(l.width, Math.ceil(x1) + 16);
      y1 = Math.min(l.height, Math.ceil(y1) + 16);
      if (!(x1 - x0 >= 32 && y1 - y0 >= 32)) throw gwError('{layer} does not cover the area', { layer: l.rec?.name ?? '' }, 'E_SARSTEREO_NO_COVER');
      // The area itself (not its margins) must lie in the image: a stripmap swath is narrow.
      let inside = 0;
      let total = 0;
      for (let j = 0; j <= 8; j++)
        for (let i = 0; i <= 8; i++) {
          const p = l.imageAt(aoi.south + ((aoi.north - aoi.south) * j) / 8, aoi.west + ((aoi.east - aoi.west) * i) / 8, (hmin + hmax) / 2);
          total++;
          if (p && p.x >= 0 && p.y >= 0 && p.x <= l.width && p.y <= l.height) inside++;
        }
      if (inside < 0.9 * total) throw gwError('{layer} covers only {share} of the area', { layer: l.rec?.name ?? '', share: pct(inside / total, 0) }, 'E_SARSTEREO_NO_COVER');
      // Look factors: a post spans at least three chip samples on each image axis.
      const p0 = l.imageAt(latc, lonc, (hmin + hmax) / 2);
      const pe = l.imageAt(latc, lonc + postM / ke, (hmin + hmax) / 2);
      const pn = l.imageAt(latc + postM / kn, lonc, (hmin + hmax) / 2);
      const ex = Math.abs(pe.x - p0.x) + Math.abs(pn.x - p0.x);
      const ey = Math.abs(pe.y - p0.y) + Math.abs(pn.y - p0.y);
      let mx = Math.max(1, Math.floor(ex / 3));
      let my = Math.max(1, Math.floor(ey / 3));
      while (((x1 - x0) / mx) * ((y1 - y0) / my) > 12e6) {
        mx++;
        my++;
      }
      return { x0, y0, x1: x0 + Math.floor((x1 - x0) / mx) * mx, y1: y0 + Math.floor((y1 - y0) / my) * my, mx, my };
    };
    const ba = chipBox(L);
    const bb = chipBox(R);
    const fr = [0, 0];
    const both = () => progress(0.02 + 0.28 * ((fr[0] + fr[1]) / 2));
    const [ca, cb] = await Promise.all([readChip(L, ba.x0, ba.y0, ba.x1, ba.y1, ba.mx, ba.my, (f) => ((fr[0] = f), both())), readChip(R, bb.x0, bb.y0, bb.x1, bb.y1, bb.mx, bb.my, (f) => ((fr[1] = f), both()))]);
    const code = (list, v) => list.find((x) => x[0] === v)?.[1] ?? 0;
    const prm = [1, grid.lat0, grid.lon0, grid.dlat, grid.dlon, grid.nx, grid.ny, pg.lat0, pg.lon0, pg.dlat, pg.dlon, pg.nx, pg.ny, ca.x0, ca.y0, ca.mx, ca.my, ca.w, ca.h, cb.x0, cb.y0, cb.mx, cb.my, cb.w, cb.h, o.levels, o.window, o.searchM, o.stepFrac, code(COSTS, o.cost), o.minScore, o.minMargin, o.shiftM, o.anchor ? 1 : 0, o.maskStepM, o.maskTol, o.subs, o.priorSigma, code(DESPECKLE, o.despeckle), o.latticeStep];
    const job = app.pool.run('sar.stereoDsm', { prm, recA: sarOf(L).record, recB: sarOf(R).record, prior: pz, chipA: ca.v, chipB: cb.v, posts: nx * ny }, { kind: 'analysis', transfer: [pz.buffer, ca.v.buffer, cb.v.buffer], timeout: 3_600_000, label: t('SAR stereo DSM {a} + {b}', { a: L.rec?.name ?? '', b: R.rec?.name ?? '' }), onProgress: (f) => progress(0.3 + 0.7 * f) });
    o.job?.(job);
    const r = await job;
    progress(1);
    const params = { ...o, postM, prior: prior.name, onProgress: undefined, job: undefined, aoi };
    const dsm = { grid, heights: r.heights, sigma: r.sigma, score: r.score, flags: Uint8Array.from(r.flags), stats: r.stats, pair: [L.info?.iid ?? L.rec?.name, R.info?.iid ?? R.rec?.name], names: [L.rec?.name, R.rec?.name], prior: prior.name, priorLayerId: prior.layerId, params, chips: [ca, cb].map((x) => ({ x0: x.x0, y0: x.y0, mx: x.mx, my: x.my, w: x.w, h: x.h, tiles: x.tiles, readMs: x.readMs })), ms: Math.round(performance.now() - t0) };
    app.sarStereo.last = dsm;
    return dsm;
  }

  /** Write the DSM as a four-band float32 GeoTIFF (height HAE, σ, score, flags) and open it as terrain. */
  async function saveDsm(dsm, { name: fname, open = true } = {}) {
    const { grid: g } = dsm;
    const n = g.nx * g.ny;
    // A DSM with no flags (any DEM levelled, not a SAR stereo product) is written as heights only:
    // a flags band of zeros would read as "every post clean".
    const full = !!dsm.flags;
    const nb = full ? 4 : 1;
    const data = new Float32Array(n * nb);
    for (let i = 0; i < n; i++) {
      data[nb * i] = dsm.heights[i];
      if (!full) continue;
      data[4 * i + 1] = dsm.sigma?.[i] ?? NaN;
      data[4 * i + 2] = dsm.score?.[i] ?? NaN;
      data[4 * i + 3] = dsm.flags[i];
    }
    const desc = full
      ? `GIS Workbench SAR stereo DSM (radargrammetry) from ${dsm.names.join(' + ')}: band 1 height above the WGS 84 ellipsoid (m), band 2 per-post sigma (m), band 3 matching score, band 4 flags (1/2 layover A/B, 4/8 shadow A/B, 16 weak, 32 ambiguous, 64 rejected, 128 no data); prior ${dsm.prior}${dsm.stats?.geometry?.sameSide === false ? '; opposite-side pair, not recommended' : ''}`
      : `GIS Workbench DSM from ${dsm.names.join(' + ')}: height above the WGS 84 ellipsoid (m); ${dsm.prior ?? ''}`;
    const bytes = await writeGeoTiff({ width: g.nx, height: g.ny, bands: nb, type: 'f32', data }, { epsg: 4326, vertical: 'hae', geotransform: [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], nodata: NaN, description: desc, gdalMetadata: gdalMetadataXml(dsmItems(dsm, full)), overviews: true });
    const file = new File([bytes], fname ?? `SARDSM_${dsm.pair.join('_')}.tif`.replace(/[^\w.-]+/g, '_'), { type: 'image/tiff', lastModified: Date.now() });
    if (!open) return { file };
    const { layers } = await openImageFile(app, file, { pane: pane() });
    const l = layers[0];
    await app.useAsTerrain(l, 'hae');
    const te = app.terrain.entry(l.id);
    if (te) te.kind = 'DSM';
    dsm.layerId = l.id;
    return { file, layer: l };
  }

  /** Accuracy of a DSM against a terrain entry (default: the DSM's prior). */
  function report(dsm, ref = terrains().find((d) => d.layerId === dsm.priorLayerId)) {
    if (!ref) throw gwError('load a reference DEM as terrain first', null, 'E_SARSTEREO_NO_REF');
    const rep = dsmAccuracy(dsm, (la, lo) => (coverOf(ref, la, lo) ? core.demHae(ref.coreId, la, lo) : NaN));
    return { ...rep, reference: ref.name, dsm: dsm.names?.join(' + ') ?? '', stats: dsm.stats, anchored: !!dsm.stats?.anchored, ...(dsm.stats?.geometry?.sameSide === false ? { warning: 'opposite-side pair, not recommended' } : {}) };
  }

  /**
   * A terrain entry's DSM-like view: its grid and its heights on the ellipsoid (an orthometric DEM is
   * converted as the terrain converts it, so levelling never fits the geoid as a bias).
   */
  function dsmOfTerrain(d) {
    const last = app.sarStereo.last;
    if (last && last.layerId === d.layerId) return last;
    const g = d.grid;
    return { grid: { lat0: g.lat0, lon0: g.lon0, dlat: g.dlat, dlon: g.dlon, nx: g.width, ny: g.height }, heights: app.terrain.haeHeights(d), sigma: null, flags: null, names: [d.name], stats: null, layerId: d.layerId };
  }

  /**
   * dsmOfTerrain, with a SAR stereo DSM's σ, score and flags read back from its bands 2 to 4, and
   * its pair side and prior from what the file says about itself (dsmFileFacts), so a reopened
   * product reports and levels as it was made.
   */
  async function dsmFromTerrain(d) {
    const dsm = dsmOfTerrain(d);
    if (dsm.flags) return dsm;
    const l = app.layers.get(d.layerId);
    const f = dsmFileFacts(l?.info?.meta?.gdalItems ?? {}, String(l?.info?.meta?.imageDescription ?? ''));
    if (f.prior) dsm.prior = f.prior;
    if (l?.bands !== 4 || !f.product) return dsm;
    const g = dsm.grid;
    const r = await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: g.nx, h: g.ny, bands: [1, 2, 3], maxSamples: 3 * g.nx * g.ny }, { affinity: l.affinity, label: t('Reading {layer}', { layer: d.name }) });
    return { ...dsm, sigma: r.planes[0], score: r.planes[1], flags: Uint8Array.from(r.planes[2], (v) => (Number.isFinite(v) ? v : 128)), stats: { geometry: { sameSide: f.sameSide } } };
  }

  const fmtStats = (s) => (s ? [int(s.n), num(s.mean, 2), num(s.median, 2), num(s.nmad, 2), num(s.rmse, 2), num(s.le90, 2)] : ['0', '–', '–', '–', '–', '–']);

  async function reportDialog(rep, dsm) {
    const head = [t('Posts'), t('Bias (mean)'), t('Median'), t('NMAD'), t('RMSE'), t('LE90')];
    const row = (label, s) => h('tr', {}, h('th', { scope: 'row' }, label), ...fmtStats(s).map((v) => h('td', {}, v)));
    const SLOPE = { flat: N_('Slope under 10°'), moderate: N_('Slope 10° to 25°'), steep: N_('Slope over 25°') };
    const table = h('table', { class: 'tbl', 'data-id': 'sarstereo-report' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('Posts (m)')), ...head.map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, row(t('All matched posts'), rep.error), ...Object.entries(rep.bySlope).map(([k, s]) => row(tr(SLOPE[k]), s))));
    const st = rep.stats;
    const lines = [
      t('Reference: {ref}', { ref: rep.reference }),
      t('Completeness: {c} of the posts with a reference height ({m} of {n})', { c: pct(rep.completeness, 1), m: int(rep.matched), n: int(rep.covered) }),
      t('Masked: {all} (layover {lay}, shadow {sh})', { all: pct(rep.masked.share, 1), lay: pct(rep.covered ? rep.masked.layover / rep.covered : 0, 1), sh: pct(rep.covered ? rep.masked.shadow / rep.covered : 0, 1) }),
      t('Not matched: {weak} weak, {amb} ambiguous, {rej} rejected, {nd} without image data', { weak: int(rep.rejected.weak), amb: int(rep.rejected.ambiguous), rej: int(rep.rejected.rejected), nd: int(rep.rejected.noData) }),
    ];
    if (rep.calibration) {
      lines.push(t('Stated σ: {w1} of the posts within 1σ, {w2} within 2σ; RMSE / RMS σ = {r}', { w1: pct(rep.calibration.within1, 0), w2: pct(rep.calibration.within2, 0), r: num(rep.calibration.ratio, 2) }));
      lines.push(t('About the median error: {w1} within 1σ, {w2} within 2σ; NMAD / RMS σ = {r}', { w1: pct(rep.calibration.centredWithin1, 0), w2: pct(rep.calibration.centredWithin2, 0), r: num(rep.calibration.centredRatio, 2) }));
    }
    if (st && st.sigmaSysSource === 'none') lines.push(t('The σ leaves out the models’ bias: the SICDs state no CompositeSCP error.'));
    if (st) {
      const ge = st.geometry;
      lines.push(t('Pair: intersection {ang}°, {side, select, same {same side} other {opposite side}}, parallax {par} m per m of height', { ang: num(ge.intersectionDeg, 1), side: ge.sameSide ? 'same' : 'opposite', par: num(ge.parallax, 3) }));
      if (!ge.sameSide) lines.push(t('Not recommended: on the one opposite-side pair measured, 28–43 % of the posts matched, NMAD was 8.5–13.7 m, and the σ under-stated the error.'));
      lines.push(t('Relative orientation: cross-parallax shift {s} m', { s: num(st.shiftM, 1) }));
      if (st.anchored) lines.push(t('Levelled on the prior by {d} m: the bias against that same DEM is zero by construction.', { d: num(-st.anchorOffset, 2) }));
      else lines.push(t('Heights are the SICD models’ own (not levelled on the prior).'));
      lines.push(t('Check: lattice against exact projections {px} px; two-ray intersection of the conjugates within {m} m of the post height ({n} posts)', { px: num(st.latticeMaxPx, 4), m: num(st.intersectMaxM, 4), n: int(st.intersectN) }));
    }
    const body = h('div', {}, h('div', { class: 'tbl-wrap', style: { overflowX: 'auto' } }, table), ...lines.map((x) => h('p', { class: 'hint' }, x)));
    const r = await modal({ title: t('DSM Accuracy Report'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }, { label: t('Save CSV…'), value: 'csv' }, { label: t('Save JSON…'), value: 'json' }], width: 720, id: 'sarstereo-report' });
    const base = (dsm?.names?.join('_') || 'dsm').replace(/[^\w.-]+/g, '_');
    if (r === 'csv') await saveBlob(app, textBlob(reportCsv(rep, base), 'text/csv'), { name: `${base}_accuracy.csv`, types: ['.csv'], description: 'CSV' });
    if (r === 'json') await saveBlob(app, textBlob(JSON.stringify(rep, null, 2), 'application/json'), { name: `${base}_accuracy.json`, types: ['.json'], description: 'JSON' });
    return rep;
  }

  const sel = (opts, value, label) => {
    const s = h('select', { class: 'inp', 'aria-label': label }, ...opts.map(([v, text]) => h('option', { value: v }, text)));
    if (value !== undefined) s.value = value;
    return s;
  };
  const numIn = (v, label, step = 'any') => h('input', { class: 'inp inp-num', type: 'number', step, value: String(v), 'aria-label': label });

  async function dsmDialog(L0, R0) {
    const list = sicds();
    if (list.length < 2) return app.toast(t('SAR stereo needs two SICD images: open a stereo pair first'), { kind: 'warn' });
    if (!terrains().length) return app.toast(t('load a prior DEM as terrain first (for example Copernicus GLO-30 with Use as Terrain)'), { kind: 'warn' });
    const opt = list.map((l, k) => [String(k), l.rec?.name ?? `#${k + 1}`]);
    const a = sel(opt, String(Math.max(0, list.indexOf(L0 ?? list[0]))), t('Image A'));
    const b = sel(opt, String(Math.max(0, list.indexOf(R0 ?? list[1]))), t('Image B'));
    const hasAoi = !!app.aoiFor?.(pane());
    const area = sel([['centre', t('Centre of the overlap')], ['view', t('Panel view')], ['aoi', t('Panel AOI')]], hasAoi ? 'aoi' : 'centre', t('Area'));
    const size = numIn(DEFAULTS.sizeM, t('Size (m)'), '50');
    const post = h('input', { class: 'inp inp-num', type: 'number', step: '0.5', min: '0.5', placeholder: t('auto'), 'aria-label': t('Post spacing (m)') });
    const tl = terrains().map((d) => [d.layerId, d.name]);
    const prior = sel(tl, tl[0]?.[0], t('Prior DEM'));
    const ref = sel([['', t('None')], ...tl], tl[0]?.[0], t('Reference DEM for the report'));
    const search = numIn(DEFAULTS.searchM, t('Search range (± m)'), '1');
    const cost = sel(COSTS.map(([v, , text]) => [v, tr(text)]), DEFAULTS.cost, t('Matching cost'));
    const desp = sel(DESPECKLE.map(([v, , text]) => [v, tr(text)]), DEFAULTS.despeckle, t('Speckle'));
    const shift = numIn(DEFAULTS.shiftM, t('Cross-parallax shift search (± m)'), '1');
    const allowOpp = h('input', { type: 'checkbox', 'data-id': 'sarstereo:allow-opposite', 'aria-label': t('Run an opposite-side pair') });
    const anchor = h('input', { type: 'checkbox', 'aria-label': t('Level the DSM on the prior') });
    const sigma = numIn(DEFAULTS.priorSigma, t('Prior vertical σ (m)'), '0.5');
    const body = h(
      'div',
      {},
      section(t('Pair'), field(t('Image A'), a), field(t('Image B'), b), field(t('Run an opposite-side pair'), allowOpp, t('Not recommended: the two images share little beyond large-scale pattern, and the fine posts mostly repeat coarse matches.'))),
      section(t('Area and posts'), field(t('Area'), area), field(t('Size (m)'), size, t('For the centre of the overlap: the side of the square.')), field(t('Post spacing (m)'), post, t('Default: about four ground resolution cells.'))),
      section(t('Prior and matching'), field(t('Prior DEM'), prior, t('Guides the search and gives the layover and shadow masks (Copernicus GLO-30 or better).')), field(t('Search range (± m)'), search), field(t('Matching cost'), cost), field(t('Speckle'), desp)),
      section(t('Relative orientation'), field(t('Cross-parallax shift search (± m)'), shift, t('Searches the offset of image B across the parallax direction (0 = none).')), field(t('Level the DSM on the prior'), anchor, t('Removes the median height difference to the prior; the bias against that same DEM is then zero by construction.')), field(t('Prior vertical σ (m)'), sigma)),
      section(t('Report'), field(t('Reference DEM for the report'), ref)),
    );
    if ((await modal({ title: t('SAR Stereo DSM'), body, buttons: RUN_CANCEL(), width: 600, id: 'sarstereo-dsm' })) !== 'run') return null;
    const L = list[Number(a.value)];
    const R = list[Number(b.value)];
    app.toast(t('SAR stereo DSM started (Job Queue shows the progress)'), { kind: 'info' });
    try {
      const aoi = area.value === 'aoi' ? app.aoiFor(pane())?.bounds ?? null : area.value === 'view' ? viewBounds() : null;
      const dsm = await extract(L, R, { allowOpposite: allowOpp.checked, aoi, sizeM: Number(size.value) || DEFAULTS.sizeM, postM: post.value === '' ? undefined : Number(post.value), prior: terrains().find((d) => d.layerId === prior.value), searchM: Number(search.value) || DEFAULTS.searchM, cost: cost.value, despeckle: desp.value, shiftM: Math.max(0, Number(shift.value) || 0), anchor: anchor.checked, priorSigma: Number(sigma.value) || DEFAULTS.priorSigma });
      const { layer } = await saveDsm(dsm);
      app.toast(t('SAR stereo DSM {nx}×{ny} posts at {post} m: {matched} matched in {s} s ({layer})', { nx: int(dsm.grid.nx), ny: int(dsm.grid.ny), post: num(dsm.params.postM, 1), matched: pct(dsm.stats.matched / dsm.stats.posts, 0), s: num(dsm.ms / 1000, 1), layer: layer.rec.name }), { kind: 'info', ms: 8000 });
      const rd = terrains().find((d) => d.layerId === ref.value);
      if (rd) await reportDialog(report(dsm, rd), dsm);
      return dsm;
    } catch (e) {
      const step = /^E_SARSTEREO_(NO_PRIOR|SMALL|TOO_LARGE|NO_COVER|NO_OVERLAP|SAME|NEED_TWO|OPPOSITE)$|^E_DSM_VIEW_NO_GROUND$/.test(e?.code ?? '');
      app.toast(t('SAR stereo DSM: {msg}', { msg: msgOf(e) }), { kind: step ? 'warn' : 'error' });
      return null;
    }
  }

  async function reportCommand() {
    const tl = terrains();
    if (tl.length < 2) return app.toast(t('the accuracy report needs a DSM and a reference DEM loaded as terrain'), { kind: 'warn' });
    const opts = tl.map((d) => [d.layerId, d.name]);
    const last = app.sarStereo.last;
    const dsmSel = sel(opts, last?.layerId && tl.some((d) => d.layerId === last.layerId) ? last.layerId : opts[opts.length - 1][0], t('DSM'));
    const refSel = sel(opts, opts[0][0], t('Reference DEM'));
    const body = h('div', {}, field(t('DSM'), dsmSel), field(t('Reference DEM'), refSel), h('p', { class: 'hint' }, t('Both are compared as heights above the ellipsoid at the DSM posts.')));
    if ((await modal({ title: t('DSM Accuracy Report'), body, buttons: RUN_CANCEL(), id: 'sarstereo-report-pick' })) !== 'run') return null;
    if (dsmSel.value === refSel.value) return app.toast(t('choose a reference other than the DSM'), { kind: 'warn' });
    const d = tl.find((x) => x.layerId === dsmSel.value);
    const dsm = await dsmFromTerrain(d);
    return reportDialog(report(dsm, tl.find((x) => x.layerId === refSel.value)), dsm);
  }

  /**
   * Level a DSM on a reference DEM (REQ-GAP-91, REG-084): offset, and with tilt a plane, fitted over
   * stable terrain (levelDsm), removed, and the result saved as a new DSM opened as terrain. An
   * opposite-side pair is refused unless allowOpposite. Returns {layer, offset, tilt, sigma, …}.
   */
  async function level(dsm, ref, { tilt = false, slopeMax = 10, allowOpposite = false } = {}) {
    if (!ref) throw gwError('load a reference DEM as terrain first', null, 'E_SARSTEREO_NO_REF');
    let lv;
    try {
      lv = levelDsm(dsm, (la, lo) => (coverOf(ref, la, lo) ? core.demHae(ref.coreId, la, lo) : NaN), { tilt, slopeMax, allowOpposite });
    } catch (e) {
      if (e.code === 'E_SARSTEREO_OPPOSITE') throw gwError('{dsm} comes from an opposite-side pair: its errors are not a bias levelling removes, so it is not levelled', { dsm: dsm.names?.join(' + ') ?? '' }, e.code);
      if (e.code === 'E_SARSTEREO_FEW_POSTS') throw gwError('levelling needs at least 50 stable posts (unflagged, under {slope}° of slope) with a reference height', { slope: num(slopeMax, 0) }, e.code);
      throw e;
    }
    const levelled = { ...dsm, heights: lv.heights, names: [...(dsm.names ?? [])], prior: `${dsm.prior ? `${dsm.prior}; ` : ''}levelled on ${ref.name} by ${(-lv.offset).toFixed(2)} m${lv.tilt ? ` and ${(-lv.tilt[0]).toFixed(3)} / ${(-lv.tilt[1]).toFixed(3)} m per km east / north` : ''}, residual NMAD ${lv.sigma.toFixed(2)} m over ${lv.used} stable posts` };
    const base = (app.layers.get(dsm.layerId)?.rec?.name ?? `SARDSM_${(dsm.pair ?? []).join('_')}`).replace(/\.[^.]+$/, '');
    const { layer } = await saveDsm(levelled, { name: `${base}_LEVELLED.tif`.replace(/[^\w.-]+/g, '_') });
    const out = { layer, dsm: levelled, offset: lv.offset, tilt: lv.tilt, sigma: lv.sigma, offsetSigma: lv.offsetSigma, used: lv.used, before: lv.before, after: lv.after, reference: ref.name };
    return out;
  }

  async function levelCommand() {
    const tl = terrains();
    if (tl.length < 2) return app.toast(t('levelling needs a DSM and a reference DEM loaded as terrain'), { kind: 'warn' });
    const opts = tl.map((d) => [d.layerId, d.name]);
    const last = app.sarStereo.last;
    const dsmSel = sel(opts, last?.layerId && tl.some((d) => d.layerId === last.layerId) ? last.layerId : opts[opts.length - 1][0], t('DSM'));
    const refSel = sel(opts, opts[0][0], t('Reference DEM'));
    const tiltBox = h('input', { type: 'checkbox', 'aria-label': t('Also remove a tilt') });
    const slope = h('input', { class: 'inp inp-num', type: 'number', min: '1', max: '45', step: '1', value: '10', 'aria-label': t('Steepest slope used (°)') });
    const body = h('div', {}, field(t('DSM'), dsmSel), field(t('Reference DEM'), refSel), field(t('Also remove a tilt'), tiltBox, t('Fits a plane (offset and slope east and north) instead of an offset alone.')), field(t('Steepest slope used (°)'), slope), h('p', { class: 'hint' }, t('The offset is fitted robustly over stable terrain: posts with no layover, shadow or matching flag, on gentle slopes of the reference.')));
    if ((await modal({ title: t('Level DSM on Reference'), body, buttons: RUN_CANCEL(), id: 'sarstereo-level' })) !== 'run') return null;
    if (dsmSel.value === refSel.value) return app.toast(t('choose a reference other than the DSM'), { kind: 'warn' });
    try {
      const dsm = await dsmFromTerrain(tl.find((x) => x.layerId === dsmSel.value));
      const r = await level(dsm, tl.find((x) => x.layerId === refSel.value), { tilt: tiltBox.checked, slopeMax: Number(slope.value) || 10 });
      app.toast(t('Levelled by {d} m on {ref}; residual {s} m (NMAD) over {n} stable posts.', { d: num(-r.offset, 2), ref: r.reference, s: num(r.sigma, 2), n: int(r.used) }), { kind: 'info', ms: 8000 });
      return r;
    } catch (e) {
      app.toast(t('Level DSM: {msg}', { msg: msgOf(e) }), { kind: e?.code?.startsWith?.('E_SARSTEREO') ? 'warn' : 'error', ms: 8000 });
      return null;
    }
  }

  Object.assign(app.sarStereo, { findPairs, extract, saveDsm, report, reportDialog, pairsDialog, dsmDialog, level, dsmFromTerrain, FLAG });
  C.implement('sar.stereopairs', { enabled: () => sicds().length >= 2, run: () => pairsDialog().catch((e) => app.toast(t('SAR stereo pair finder: {msg}', { msg: msgOf(e) }), { kind: e?.code === 'E_SARSTEREO_NEED_TWO' ? 'warn' : 'error' })) });
  C.implement('sar.stereodsm', { enabled: () => sicds().length >= 2, run: () => dsmDialog() });
  C.implement('sar.stereoreport', { enabled: () => terrains().length >= 2, run: () => reportCommand() });
  C.implement('sar.stereolevel', { enabled: () => terrains().length >= 2, run: () => levelCommand() });
}
