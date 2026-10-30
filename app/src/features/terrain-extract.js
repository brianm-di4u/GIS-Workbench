// Terrain extraction (R2.4, REQ-DEM-04/06, Research/08 §4): a DSM from a stereo pair by
// semi-global matching. The pair's display plane (shared with the stereo panel) is cut into
// tiles; for each tile the two source windows are rectified through the eye affines, matched by
// census + 8-path SGM on a pyramid (per-pixel tSGM ranges, left-right check, sub-pixel, median,
// speckle filter) in the analysis workers, and every matched pixel is mapped to ground through a
// trilinear lookup of exact two-ray intersections, then binned on the DSM posts. The product is a
// two-band float32 GeoTIFF (height HAE, figure of merit) that opens as terrain.

import { h, clear } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { StereoView } from './stereo.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { openImageFile } from '../formats/open.js';
import { applyAffine } from '../render/renderer.js';

export const name = 'terrain-extract';

/** Strategy presets (neutral names, REQ-DEM-06). */
export const PRESETS = {
  default: { label: 'Balanced', p1: 7, p2: 86, uniqueness: 0.05, lrTol: 1, speckle: 50, pyramid: 4, radius: 6, postFactor: 2 },
  urban: { label: 'Sharp edges (urban)', p1: 5, p2: 60, uniqueness: 0.04, lrTol: 1, speckle: 40, pyramid: 4, radius: 8, postFactor: 2 },
  open: { label: 'Smooth surfaces (open terrain)', p1: 9, p2: 120, uniqueness: 0.06, lrTol: 1, speckle: 80, pyramid: 4, radius: 5, postFactor: 3 },
  fast: { label: 'Quick look', p1: 7, p2: 86, uniqueness: 0.05, lrTol: 1.5, speckle: 30, pyramid: 4, radius: 4, postFactor: 4 },
  // REQ-DEM-05: window NCC, much faster than SGM and blunt at depth edges (flagged edge-poor).
  ncc: { label: 'NCC Fast (edge-poor)', engine: 'ncc', p1: 7, p2: 86, uniqueness: 0.6, lrTol: 1.5, speckle: 30, pyramid: 4, radius: 4, postFactor: 3 },
};

const ID = (a, u0, v0) => [a[0] + a[1] * u0 + a[2] * v0, a[1], a[2], a[3] + a[4] * u0 + a[5] * v0, a[4], a[5]];

/**
 * Extract a DSM. Returns {grid {lat0, lon0, dlat, dlon, nx, ny}, heights Float32Array, fom
 * Uint8Array, stats}. opts: aoi {north, south, west, east}, postM, hMin, hMax, preset, tile,
 * onProgress(frac), signal {cancelled}.
 */
export async function extractDsm(app, L, R, opts = {}) {
  const t0 = performance.now();
  const pr = { ...PRESETS[opts.preset ?? 'default'], ...(opts.params ?? {}) };
  const geo = new StereoView(app, null, L, R);
  const core = app.core;
  // AOI in the display plane: the overlap of both footprints at h_ref (or the given box).
  const footprint = (l) =>
    [
      [0, 0],
      [l.width, 0],
      [l.width, l.height],
      [0, l.height],
    ].map(([x, y]) => {
      const g = core.i2g(l.modelId, x, y, geo.hRef);
      return geo.ground2plane(g.lat, g.lon);
    });
  const bb = (ps) => ({ x0: Math.min(...ps.map((p) => p.x)), x1: Math.max(...ps.map((p) => p.x)), y0: Math.min(...ps.map((p) => p.y)), y1: Math.max(...ps.map((p) => p.y)) });
  const fl = bb(footprint(L));
  const fr = bb(footprint(R));
  let box = { x0: Math.max(fl.x0, fr.x0) + 8, x1: Math.min(fl.x1, fr.x1) - 8, y0: Math.max(fl.y0, fr.y0) + 8, y1: Math.min(fl.y1, fr.y1) - 8 };
  if (opts.aoi) {
    const a = bb([geo.ground2plane(opts.aoi.north, opts.aoi.west), geo.ground2plane(opts.aoi.north, opts.aoi.east), geo.ground2plane(opts.aoi.south, opts.aoi.west), geo.ground2plane(opts.aoi.south, opts.aoi.east)]);
    box = { x0: Math.max(box.x0, a.x0), x1: Math.min(box.x1, a.x1), y0: Math.max(box.y0, a.y0), y1: Math.min(box.y1, a.y1) };
  }
  if (!(box.x1 - box.x0 > 32 && box.y1 - box.y0 > 32)) throw new Error('the images do not overlap enough for terrain extraction');
  // Height range: the terrain under the AOI when one is loaded, else the reference ± relief.
  let hMin = opts.hMin;
  let hMax = opts.hMax;
  if (!Number.isFinite(hMin) || !Number.isFinite(hMax)) {
    const hs = [];
    for (let j = 0; j <= 8; j++)
      for (let i = 0; i <= 8; i++) {
        const g = geo.plane2ground(box.x0 + ((box.x1 - box.x0) * i) / 8, box.y0 + ((box.y1 - box.y0) * j) / 8);
        const t = app.terrain.sample(g.lat, g.lon);
        if (t) hs.push(t.hae);
      }
    const relief = app.prefs.get('dsmRelief') ?? [-40, 80];
    hMin ??= hs.length ? Math.min(...hs) - 20 : geo.hRef + relief[0];
    hMax ??= hs.length ? Math.max(...hs) + 60 : geo.hRef + relief[1];
  }
  // DSM posts (geographic), postM apart.
  const postM = opts.postM ?? pr.postFactor * geo.s;
  const corners = [geo.plane2ground(box.x0, box.y0), geo.plane2ground(box.x1, box.y0), geo.plane2ground(box.x0, box.y1), geo.plane2ground(box.x1, box.y1)];
  const north = Math.max(...corners.map((c) => c.lat));
  const south = Math.min(...corners.map((c) => c.lat));
  const west = Math.min(...corners.map((c) => c.lon));
  const east = Math.max(...corners.map((c) => c.lon));
  const dlat = postM * geo.O.kLat;
  const dlon = postM * geo.O.kLon;
  const grid = { lat0: north - dlat / 2, lon0: west + dlon / 2, dlat, dlon, nx: Math.max(1, Math.floor((east - west) / dlon)), ny: Math.max(1, Math.floor((north - south) / dlat)) };
  const N = grid.nx * grid.ny;
  const sum = new Float32Array(N);
  const count = new Float32Array(N);
  const fomM = new Uint8Array(N);
  const fomU = new Uint8Array(N);
  // Tiles over the plane box.
  const T = Math.min(opts.tile ?? 1024, Math.ceil(Math.max(box.x1 - box.x0, box.y1 - box.y0)));
  const ov = 48;
  const tiles = [];
  for (let v0 = box.y0; v0 < box.y1 - ov / 2; v0 += T - ov) for (let u0 = box.x0; u0 < box.x1 - ov / 2; u0 += T - ov) tiles.push({ u0: Math.floor(u0), v0: Math.floor(v0), w: Math.min(T, Math.ceil(box.x1 - u0)), h: Math.min(T, Math.ceil(box.y1 - v0)) });
  // A whole-strip overlap is thousands of matching tiles (two full WorldView-3 scenes ran past ten
  // minutes and then failed to allocate, TE 2.0.4 cross): refused by name, with what to do instead.
  if (tiles.length > (opts.maxTiles ?? 400)) throw new Error(`the area is ${tiles.length} matching tiles (a whole scene pair); choose Area ▸ Panel view, draw an AOI, or zoom in first`);
  const sig = app.prefs.get('pickSigmaPx') ?? 0.5;
  // Build each tile's job on the main thread (affines, ranges, lookup), then match in workers.
  const prepare = (t) => {
    geo.fitBounds(t.u0, t.v0, t.u0 + t.w, t.v0 + t.h, [hMin - geo.hRef, (hMin + hMax) / 2 - geo.hRef, hMax - geo.hRef]);
    const AL = ID(geo.A.L, t.u0, t.v0);
    const AR = ID(geo.A.R, t.u0, t.v0);
    const gc = geo.plane2ground(t.u0 + t.w / 2, t.v0 + t.h / 2, (hMin + hMax) / 2);
    const g = geo.gain(gc);
    const dmin = Math.floor(g * (hMin - geo.hRef)) - 2;
    const dmax = Math.ceil(g * (hMax - geo.hRef)) + 2;
    const bboxOf = (A, us) => {
      const ps = [];
      for (const u of us) for (const v of [0, t.h]) ps.push(applyAffine(A, u, v));
      return { x0: Math.floor(Math.min(...ps.map((p) => p.x))) - 4, y0: Math.floor(Math.min(...ps.map((p) => p.y))) - 4, x1: Math.ceil(Math.max(...ps.map((p) => p.x))) + 4, y1: Math.ceil(Math.max(...ps.map((p) => p.y))) + 4 };
    };
    const lb = bboxOf(AL, [0, t.w]);
    const rb = bboxOf(AR, [dmin, t.w + dmax]);
    // Exact ground at a 9 × 9 × 9 lattice of (u, v, d).
    const G = 9;
    const lut = new Float64Array(G * G * G * 3);
    let o = 0;
    let latMin = Infinity;
    let latMax = -Infinity;
    let lonMin = Infinity;
    let lonMax = -Infinity;
    for (let k = 0; k < G; k++)
      for (let j = 0; j < G; j++)
        for (let i = 0; i < G; i++) {
          const u = (t.w * i) / (G - 1);
          const v = (t.h * j) / (G - 1);
          const d = dmin + ((dmax - dmin) * k) / (G - 1);
          const pl = applyAffine(AL, u, v);
          const prt = applyAffine(AR, u + d, v);
          const s0 = geo.plane2ground(t.u0 + u, t.v0 + v, geo.hRef + d / g);
          let x;
          try {
            x = core.intersect([
              { model: L.modelId, x: pl.x, y: pl.y, sigma: sig },
              { model: R.modelId, x: prt.x, y: prt.y, sigma: sig },
            ], s0);
          } catch {
            x = s0;
          }
          lut.set([x.lat, x.lon, x.h], o);
          o += 3;
          latMin = Math.min(latMin, x.lat);
          latMax = Math.max(latMax, x.lat);
          lonMin = Math.min(lonMin, x.lon);
          lonMax = Math.max(lonMax, x.lon);
        }
    const ix0 = Math.max(0, Math.floor((lonMin - grid.lon0) / dlon) - 1);
    const ix1 = Math.min(grid.nx - 1, Math.ceil((lonMax - grid.lon0) / dlon) + 1);
    const iy0 = Math.max(0, Math.floor((grid.lat0 - latMax) / dlat) - 1);
    const iy1 = Math.min(grid.ny - 1, Math.ceil((grid.lat0 - latMin) / dlat) + 1);
    if (ix1 < ix0 || iy1 < iy0) return null;
    const sub = { lat0: grid.lat0 - iy0 * dlat, lon0: grid.lon0 + ix0 * dlon, nx: ix1 - ix0 + 1, ny: iy1 - iy0 + 1, ix0, iy0 };
    const prm = Float64Array.from([t.w, t.h, ...AL, ...AR, lb.x0, lb.y0, 0, 0, rb.x0, rb.y0, 0, 0, dmin, dmax, pr.pyramid, pr.radius, pr.p1, pr.p2, pr.uniqueness, pr.lrTol, pr.speckle, G, G, G, sub.lat0, sub.lon0, dlat, dlon, sub.nx, sub.ny, pr.censusX ?? 4, pr.censusY ?? 3, ...(pr.engine === 'ncc' ? [1] : []), ...lut]);
    return { t, prm, lb, rb, sub };
  };
  const runTile = async (job) => {
    const { lb, rb, prm, sub } = job;
    const [lp, rp] = await Promise.all([
      app.pool.run('patch', { handle: L.handle, x: lb.x0, y: lb.y0, w: lb.x1 - lb.x0, h: lb.y1 - lb.y0, band: 0 }, { affinity: L.affinity, priority: 'background' }),
      app.pool.run('patch', { handle: R.handle, x: rb.x0, y: rb.y0, w: rb.x1 - rb.x0, h: rb.y1 - rb.y0, band: 0 }, { affinity: R.affinity, priority: 'background' }),
    ]);
    // The patch op clamps windows to the image: record the actual origins and sizes.
    prm[14] = lp.x0;
    prm[15] = lp.y0;
    prm[16] = lp.w;
    prm[17] = lp.h;
    prm[18] = rp.x0;
    prm[19] = rp.y0;
    prm[20] = rp.w;
    prm[21] = rp.h;
    const n = sub.nx * sub.ny;
    const op = useGpu ? 'dsmTileGpu' : 'dsmTile';
    const r = await app.pool.run(op, { prm, left: lp.px, right: rp.px, n }, { kind: 'analysis', transfer: [prm.buffer, lp.px.buffer, rp.px.buffer], timeout: 600000, priority: 'background' });
    engines.add(r.engine ?? 'worker');
    if (r.gpuError && !engines.has('gpu-error')) {
      engines.add('gpu-error');
      app.log('warn', `WebGPU DSM tile failed, the worker matched it: ${r.gpuError}`);
    }
    for (let y = 0; y < sub.ny; y++)
      for (let x = 0; x < sub.nx; x++) {
        const s = y * sub.nx + x;
        const gI = (sub.iy0 + y) * grid.nx + sub.ix0 + x;
        sum[gI] += r.sum[s];
        count[gI] += r.count[s];
        if (r.fomM[s] > fomM[gI]) fomM[gI] = r.fomM[s];
        if (r.fomU[s] > fomU[gI]) fomU[gI] = r.fomU[s];
      }
    return r;
  };
  // Tiles are prepared on the main thread just before they are dispatched, so the lookups of
  // later tiles are built while earlier ones match.
  let prepMs = 0;
  const jobs = [];
  // REQ-PRF-06: SGM tiles on the GPU (engine 'auto' with WebGPU and the pref on, or 'gpu').
  const useGpu = pr.engine !== 'ncc' && (opts.engine === 'gpu' || (opts.engine !== 'worker' && app.prefs.get('webgpu') !== false && !!globalThis.navigator?.gpu));
  const engines = new Set();
  let done = 0;
  let matched = 0;
  let pixels = 0;
  const conc = Math.max(1, Math.min(opts.concurrency ?? app.pool.size ?? 2, tiles.length));
  let next = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < tiles.length) {
        if (opts.signal?.cancelled) throw new Error('terrain extraction cancelled');
        const tp = performance.now();
        const j = prepare(tiles[next++]);
        prepMs += performance.now() - tp;
        done++;
        if (j) {
          jobs.push(j);
          const r = await runTile(j);
          matched += r.matched;
          pixels += r.pixels;
        }
        opts.onProgress?.(done / tiles.length);
        // Let the other dispatchers prepare and send their tiles.
        await new Promise((res) => setTimeout(res, 0));
      }
    }),
  );
  // Heights, then small holes filled from their neighbours (the FOM keeps them unmatched).
  const heights = new Float32Array(N).fill(NaN);
  for (let i = 0; i < N; i++) if (count[i] > 0) heights[i] = sum[i] / count[i];
  for (let pass = 0; pass < 3; pass++) {
    const src = heights.slice();
    for (let y = 1; y < grid.ny - 1; y++)
      for (let x = 1; x < grid.nx - 1; x++) {
        const i = y * grid.nx + x;
        if (Number.isFinite(src[i]) || !(fomU[i] || fomM[i] || pass < 3)) continue;
        let s = 0;
        let c = 0;
        for (const j of [i - 1, i + 1, i - grid.nx, i + grid.nx, i - grid.nx - 1, i - grid.nx + 1, i + grid.nx - 1, i + grid.nx + 1]) {
          if (Number.isFinite(src[j])) {
            s += src[j];
            c++;
          }
        }
        if (c >= 3) heights[i] = s / c;
      }
  }
  // A post is matched only with real support: at least half the pixels that fall on a post
  // ((post / GSD)²). Occluded ground gets no pixels of its own, only stray ones from edges.
  const minSupport = Math.max(1, 0.5 * (postM / geo.s) ** 2);
  const fom = new Uint8Array(N);
  for (let i = 0; i < N; i++) fom[i] = count[i] >= minSupport ? fomM[i] : fomU[i] || (count[i] > 0 ? 1 : 0);
  // Occlusion borders: a matched post next to an unmatched one (occluded, ambiguous or speckle)
  // sits on an edge whose position is only known to about one post; it is not called matched.
  const border = [];
  for (let y = 0; y < grid.ny; y++)
    for (let x = 0; x < grid.nx; x++) {
      const i = y * grid.nx + x;
      if (fom[i] < 4) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < grid.nx && yy < grid.ny && fom[yy * grid.nx + xx] >= 1 && fom[yy * grid.nx + xx] <= 3) {
            edge = true;
            break;
          }
        }
      if (edge) border.push(i);
    }
  for (const i of border) fom[i] = 1;
  const stats = { tiles: jobs.length, posts: N, postM, matchedPixels: matched, pixels, matchedFraction: pixels ? matched / pixels : 0, hMin, hMax, hRef: geo.hRef, ms: Math.round(performance.now() - t0), preset: opts.preset ?? 'default', engine: pr.engine === 'ncc' ? 'NCC Fast' : 'SGM', matcher: [...engines].filter((e) => e !== 'gpu-error').join(', ') || 'worker', prepMs: Math.round(prepMs), edgePoor: pr.engine === 'ncc' };
  return { grid, heights, fom, stats, pair: [L.info.iid, R.info.iid] };
}

/** Write the DSM as a two-band float32 GeoTIFF (height HAE, FOM) and open it as terrain. */
export async function saveDsmLayer(app, dsm, { name, pane = app.activePane(), open = true } = {}) {
  const { grid, heights, fom } = dsm;
  const n = grid.nx * grid.ny;
  const data = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    data[2 * i] = heights[i];
    data[2 * i + 1] = fom[i];
  }
  const bytes = await writeGeoTiff(
    { width: grid.nx, height: grid.ny, bands: 2, type: 'f32', data },
    { epsg: 4326, vertical: 'hae', geotransform: [grid.lon0 - grid.dlon / 2, grid.dlon, 0, grid.lat0 + grid.dlat / 2, 0, -grid.dlat], nodata: NaN, description: `GIS Workbench DSM (band 1 height above the WGS 84 ellipsoid, m; band 2 figure of merit: 0 no data, 1 occlusion, 2 ambiguous, 3 speckle, 4–100 matched) from ${dsm.pair.join(' + ')}`, overviews: true },
  );
  const fname = name ?? `DSM_${dsm.pair.join('_')}.tif`;
  const file = new File([bytes], fname, { type: 'image/tiff', lastModified: Date.now() });
  if (!open) return { file };
  const st = pane?.stereo;
  const eye = st ? st.layer('L') : null;
  const { layers } = await openImageFile(app, file, { pane });
  const l = layers[0];
  await app.useAsTerrain(l, 'hae');
  const te = app.terrain.entry(l.id);
  if (te) te.kind = 'DSM';
  if (eye) app.store.transact('Keep the stereo eye active', (tx) => tx.set(pane.id, 'activeLayer', eye.id), { kind: 'edit' });
  return { file, layer: l };
}

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const pairOf = () => {
    const s = pane()?.stereo;
    if (s) return [s.layer('L'), s.layer('R')];
    const ls = (pane()?.layers() ?? []).filter((l) => l.kind !== 'dem' && l.modelId && l.modelInfo?.is3d);
    return ls.length >= 2 ? ls.slice(0, 2) : null;
  };
  app.extractDsm = (L, R, o) => extractDsm(app, L, R, o);
  app.saveDsmLayer = (d, o) => saveDsmLayer(app, d, o);

  /** Ground box of the active panel's view (corners and centre through its image's model). */
  function viewBounds() {
    const p = pane();
    const l = p?.geoLayer?.();
    const { w, h: hh } = p.size();
    const gs = [[0, 0], [w, 0], [w, hh], [0, hh], [w / 2, hh / 2]].map(([x, y]) => {
      const v = p.viewPoint(x, y);
      return l?.groundAt(v.x, v.y);
    }).filter((g) => g && Number.isFinite(g.lat));
    if (gs.length < 3) throw new Error('the panel view has no ground position: zoom onto the image');
    return { north: Math.max(...gs.map((g) => g.lat)), south: Math.min(...gs.map((g) => g.lat)), east: Math.max(...gs.map((g) => g.lon)), west: Math.min(...gs.map((g) => g.lon)) };
  }

  C.implement('dem.extract', {
    enabled: () => !!pairOf(),
    run: async () => {
      const pair = pairOf();
      if (!pair) return app.toast('Terrain extraction needs a stereo pair (two images with 3-D sensor models in the panel)', { kind: 'warn' });
      const [L, R] = pair;
      // Tab 1 Input, 2 Strategy, 3 Output, 4 Run.
      const tabs = ['Input', 'Strategy', 'Output', 'Run'];
      const pages = tabs.map(() => h('div', { class: 'tab-page' }));
      const bar = h('div', { class: 'tabs', role: 'tablist' });
      let cur = 0;
      const show = (i) => {
        cur = i;
        pages.forEach((p, k) => (p.hidden = k !== i));
        [...bar.children].forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
      };
      tabs.forEach((t, i) => {
        const b = h('button', { class: 'tab', role: 'tab', 'data-id': `dsm:tab:${i}` }, t);
        b.addEventListener('click', () => show(i));
        bar.appendChild(b);
      });
      // Large scenes start from the panel view (or the AOI): the whole overlap of two full strips is not a
      // browser-sized job (TE 2.0.4 cross).
      const hasAoi = !!app.aoiFor?.(pane());
      const large = L.width * L.height > 64e6 || R.width * R.height > 64e6;
      const aoiSel = h('select', { class: 'inp', 'aria-label': 'Area' }, h('option', { value: 'overlap', selected: !large }, 'Whole overlap'), h('option', { value: 'view', selected: large && !hasAoi }, 'Panel view'), h('option', { value: 'aoi', disabled: !hasAoi, selected: large && hasAoi }, 'Panel AOI'));
      const hmin = h('input', { class: 'inp', type: 'number', placeholder: 'auto', 'aria-label': 'Lowest height (m HAE)' });
      const hmax = h('input', { class: 'inp', type: 'number', placeholder: 'auto', 'aria-label': 'Highest height (m HAE)' });
      pages[0].append(h('p', {}, `Pair: ${L.info.iid} + ${R.info.iid}`), field('Area', aoiSel), field('Lowest height (m HAE)', hmin, 'Leave empty to take it from the loaded terrain, or the pair reference −40 m.'), field('Highest height (m HAE)', hmax, 'Leave empty for the terrain maximum + 60 m, or reference + 80 m.'));
      const preset = h('select', { class: 'inp', 'aria-label': 'Strategy' }, ...Object.entries(PRESETS).map(([k, p]) => h('option', { value: k }, p.label)));
      pages[1].append(field('Strategy', preset, 'Census cost, 8-path semi-global aggregation on a 4× pyramid with per-pixel ranges, left-right check, sub-pixel fit, median and speckle filtering.'));
      const post = h('input', { class: 'inp', type: 'number', step: '0.1', placeholder: 'auto', 'aria-label': 'Post spacing (m)' });
      pages[2].append(field('Post spacing (m)', post, 'Default: twice the GSD for the balanced strategy.'), h('p', { class: 'hint' }, 'Output: a float32 GeoTIFF with heights above the ellipsoid (band 1) and a figure-of-merit band (band 2), opened as terrain.'));
      const prog = h('progress', { max: '1', value: '0', 'aria-label': 'Progress' });
      const msg = h('p', { class: 'hint', 'data-id': 'dsm:msg' }, 'Press Extract.');
      pages[3].append(prog, msg);
      show(0);
      const signal = { cancelled: false };
      const body = h('div', {}, bar, ...pages);
      const r = await modal({ title: 'Terrain Extraction', body, buttons: ['Extract', 'Cancel'], width: 560, id: 'dsm-extract' });
      if (r !== 'Extract') return;
      app.toast('Terrain extraction started (Job Queue shows the tiles)');
      try {
        const aoi = aoiSel.value === 'aoi' ? app.aoiFor(pane()) : null;
        const bounds = aoiSel.value === 'view' ? viewBounds() : aoi?.bounds ?? null;
        const dsm = await extractDsm(app, L, R, { preset: preset.value, hMin: hmin.value === '' ? undefined : Number(hmin.value), hMax: hmax.value === '' ? undefined : Number(hmax.value), postM: post.value === '' ? undefined : Number(post.value), aoi: bounds, signal });
        const { layer } = await saveDsmLayer(app, dsm);
        app.toast(`DSM ${dsm.grid.nx}×${dsm.grid.ny} posts at ${dsm.stats.postM.toFixed(2)} m: ${(dsm.stats.matchedFraction * 100).toFixed(0)} % matched in ${(dsm.stats.ms / 1000).toFixed(1)} s (${layer.rec.name})`, { ms: 8000 });
      } catch (e) {
        app.toast(`Terrain extraction: ${e.message}`, { kind: 'error' });
      }
      void clear;
      void section;
      void cur;
    },
  });
}
