// Orthorectification and orthomosaics (R2.5, REQ-SNS-17/18, Research/06 §7): images are mapped
// onto a UTM grid through their sensor model (with any triangulation correction) and the terrain,
// tile by tile in the analysis workers (adaptive grid, error bound 0.1 px by default; nearest,
// bilinear, cubic or Lanczos-3), written as cloud-optimised GeoTIFF and opened as layers. A
// mosaic puts several images on one grid: automatic seams by nadir proximity, gain/offset or
// histogram colour balance, feathering, and seam edits that re-blend only the tiles they touch.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { openImageFile, helperOpens, closeHelpers } from '../formats/open.js';
import { groundOf, poly } from '../tools/tools.js';

export const name = 'ortho';

const KERNELS = { nearest: 0, bilinear: 1, cubic: 2, lanczos3: 3 };
const ID6 = [0, 1, 0, 0, 0, 1];
const TILE = 512;

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const toast = (m, o) => app.toast(m, o);
  const core = app.core;

  const rpcRecordOf = (l) => app.tri?.rpcRecordOf(l) ?? null;
  const biasOf = (l) => {
    const t = l.rec?.triangulation;
    return t ? { c: t.c, centre: t.centre, half: t.half } : { c: [0, 0, 0, 0, 0, 0], centre: [l.width / 2, l.height / 2], half: [l.width / 2, l.height / 2] };
  };
  /** The terrain covering most of a footprint (lat/lon box), or null. */
  const terrainFor = (box) => app.terrain.dems.find((d) => d.grid && d.bounds.north >= box.north - 1e-9 && d.bounds.south <= box.south + 1e-9 && d.bounds.west <= box.west + 1e-9 && d.bounds.east >= box.east - 1e-9) ?? app.terrain.covering?.((box.north + box.south) / 2, (box.west + box.east) / 2) ?? null;
  /** DEM posts (HAE) over a lat/lon box with a margin, for one tile. */
  function demCrop(d, box) {
    if (!d?.grid) return null;
    const g = d.grid;
    const H = d.current ?? g.heights;
    const i0 = Math.max(0, Math.floor((box.west - g.lon0) / g.dlon) - 2);
    const i1 = Math.min(g.width - 1, Math.ceil((box.east - g.lon0) / g.dlon) + 2);
    const j0 = Math.max(0, Math.floor((g.lat0 - box.north) / g.dlat) - 2);
    const j1 = Math.min(g.height - 1, Math.ceil((g.lat0 - box.south) / g.dlat) + 2);
    if (i1 <= i0 || j1 <= j0) return null;
    const w = i1 - i0 + 1;
    const hh = j1 - j0 + 1;
    const out = new Float32Array(w * hh);
    const hae = d.vertical === 'hae';
    for (let j = 0; j < hh; j++)
      for (let i = 0; i < w; i++) {
        const v = H[(j0 + j) * g.width + i0 + i];
        out[j * w + i] = hae || !Number.isFinite(v) ? v : v + core.undulation(g.lat0 - (j0 + j) * g.dlat, g.lon0 + (i0 + i) * g.dlon);
      }
    return { lat0: g.lat0 - j0 * g.dlat, lon0: g.lon0 + i0 * g.dlon, dlat: g.dlat, dlon: g.dlon, w, h: hh, heights: out };
  }

  /** A UTM grid over a set of layers' footprints: {zone, north, e0, n0, res, w, h}. */
  const ORTHO_MAX = 300e6; // output samples held in memory
  /** The smallest cell (0.05 m steps) that keeps a grid within ORTHO_MAX samples. */
  const fitCell = (G, nb, max = ORTHO_MAX) => Math.ceil(G.res * Math.sqrt((G.w * G.h * nb) / max) * 20) / 20;

  function gridFor(layers, res) {
    const fps = layers.map((l) => l.footprint()).filter(Boolean);
    if (!fps.length) throw new Error('the images have no footprint');
    const all = fps.flat();
    const cLat = all.reduce((a, p) => a + p[0], 0) / all.length;
    const cLon = all.reduce((a, p) => a + p[1], 0) / all.length;
    const z = core.utm(cLat, cLon);
    const ens = all.map(([la, lo]) => core.utm(la, lo, z.zone));
    const e0 = Math.floor(Math.min(...ens.map((p) => p.easting)) / res) * res;
    const e1 = Math.ceil(Math.max(...ens.map((p) => p.easting)) / res) * res;
    const n0 = Math.ceil(Math.max(...ens.map((p) => p.northing)) / res) * res;
    const n1 = Math.floor(Math.min(...ens.map((p) => p.northing)) / res) * res;
    return { zone: z.zone, north: z.north, e0, n0, res, w: Math.round((e1 - e0) / res), h: Math.round((n0 - n1) / res) };
  }

  const gsdOf = (l) => {
    const a = l.groundAt(l.width / 2, l.height / 2);
    const b = l.groundAt(l.width / 2 + 1, l.height / 2);
    const c = l.groundAt(l.width / 2, l.height / 2 + 1);
    return 0.5 * (core.inverse(a.lat, a.lon, b.lat, b.lon).distance + core.inverse(a.lat, a.lon, c.lat, c.lon).distance);
  };

  /**
   * Orthorectify a layer onto a grid (default: its footprint at its GSD). Returns {grid, bands
   * [Float32Array], mask, stats}.
   */
  async function orthorectify(l, { grid = null, res = null, kernel = 'bilinear', bound = 0.1, dem: demIn = null, onProgress } = {}) {
    const rec = rpcRecordOf(l);
    if (!rec) throw new Error(`${l.rec.name}: orthorectification needs an RPC model`);
    const t0 = performance.now();
    const G = grid ?? gridFor([l], res ?? Math.round(gsdOf(l) * 20) / 20);
    const nb = l.chain?.bands?.length === 3 ? 3 : 1;
    // The output is built in memory: a whole WorldView strip at its native cell was ~8 GB and ran for
    // ever (TE 2.0.4 cross). Refused by name, with the cell size that fits.
    if (G.w * G.h * nb > ORTHO_MAX) throw new Error(`the orthoimage would be ${G.w.toLocaleString()} × ${G.h.toLocaleString()} at ${G.res} m; use a cell of ${fitCell(G, nb)} m or more`);
    const bandIdx = nb === 3 ? l.chain.bands : [l.chain?.bands?.[0] ?? 0];
    const bias = biasOf(l);
    const N = G.w * G.h;
    const bands = Array.from({ length: nb }, () => new Float32Array(N).fill(NaN));
    const mask = new Uint8Array(N);
    let cells = 0;
    let maxErr = 0;
    let worst = null;
    const tiles = [];
    for (let ty = 0; ty < G.h; ty += TILE) for (let tx = 0; tx < G.w; tx += TILE) tiles.push({ i: tiles.length, tx, ty, w: Math.min(TILE, G.w - tx), h: Math.min(TILE, G.h - ty) });
    const helpers = !grid && l.width * l.height > 64e6 ? await helperOpens(app, l, Math.max(0, (app.pool.size ?? 2) - 1)) : []; // full products only: OOTF refreshes stay on the one open
    const srcs = [{ handle: l.handle, affinity: l.affinity }, ...helpers];
    const fp = l.footprint();
    const box0 = { north: Math.max(...fp.map((p) => p[0])), south: Math.min(...fp.map((p) => p[0])), west: Math.min(...fp.map((p) => p[1])), east: Math.max(...fp.map((p) => p[1])) };
    const dem = demIn ?? terrainFor(box0);
    const hRange = l.modelInfo ? [l.modelInfo.hmin, l.modelInfo.hmax] : [0, 1000];
    const fallback = l.defaultHeight();
    let done = 0;
    const runTile = async (t) => {
      const e0 = G.e0 + t.tx * G.res;
      const n0 = G.n0 - t.ty * G.res;
      // Tile corners and edges → lat/lon box; source window from the box at the height range. The
      // adaptive grid's 64-px cells may reach past a partial edge tile, so the box covers them too.
      const pw0 = Math.ceil(t.w / 64) * 64;
      const ph0 = Math.ceil(t.h / 64) * 64;
      const pts = [];
      for (let k = 0; k <= 8; k++) for (const [a, b] of [[k / 8, 0], [k / 8, 1], [0, k / 8], [1, k / 8]]) pts.push(core.utmReverse(G.zone, G.north, e0 + a * pw0 * G.res, n0 - b * ph0 * G.res));
      const box = { north: Math.max(...pts.map((p) => p.lat)), south: Math.min(...pts.map((p) => p.lat)), west: Math.min(...pts.map((p) => p.lon)), east: Math.max(...pts.map((p) => p.lon)) };
      const crop = demCrop(dem, box);
      let hlo = fallback;
      let hhi = fallback;
      if (crop) {
        for (const v of crop.heights)
          if (Number.isFinite(v)) {
            hlo = Math.min(hlo, v);
            hhi = Math.max(hhi, v);
          }
      } else {
        hlo = Math.max(hRange[0], fallback - 100);
        hhi = Math.min(hRange[1], fallback + 100);
      }
      const ips = [];
      for (const p of pts) for (const hh of [hlo, hhi]) {
        const q = l.imageAt(p.lat, p.lon, hh);
        if (q) ips.push(q);
      }
      if (!ips.length) return;
      const pad = 4;
      const x0 = Math.max(0, Math.floor(Math.min(...ips.map((q) => q.x))) - pad);
      const y0 = Math.max(0, Math.floor(Math.min(...ips.map((q) => q.y))) - pad);
      const x1 = Math.min(l.width, Math.ceil(Math.max(...ips.map((q) => q.x))) + pad);
      const y1 = Math.min(l.height, Math.ceil(Math.max(...ips.map((q) => q.y))) + pad);
      if (x1 - x0 < 2 || y1 - y0 < 2) return;
      // An output much coarser than the image reads the pyramid level of its scale (2^L ≤ res/GSD):
      // at whole-image zoom a full WorldView-3 strip's full-resolution window failed to allocate.
      const L = Math.max(0, Math.floor(Math.log2(G.res / Math.max(1e-9, gsdOf(l)))));
      // Tiles take turns over the file's opens (helpers on other workers for a large image), and a
      // full-resolution patch reads every band at once: the CORE3D 8-band MSI strip read band by band
      // on one worker took 16–32 s a patch and starved the display (TE 2.0.4 cross).
      const S = srcs[t.i % srcs.length];
      const patches = L > 0
        ? await Promise.all(bandIdx.map((b) => app.pool.run('patchLevel', { handle: S.handle, level: L, x: x0, y: y0, w: x1 - x0, h: y1 - y0, band: b }, { affinity: S.affinity, priority: 'background', timeout: 300000 })))
        : await app.pool.run('patch', { handle: S.handle, x: x0, y: y0, w: x1 - x0, h: y1 - y0, bands: bandIdx }, { affinity: S.affinity, priority: 'background', timeout: 300000 }).then((r) => r.pxs.map((px) => ({ ...r, px })));
      const pw = patches[0].w;
      const ph = patches[0].h;
      const src = new Float32Array(pw * ph * nb);
      patches.forEach((p, k) => src.set(p.px, k * pw * ph));
      const spec = Float64Array.from([0, ...rec, ...bias.c, ...bias.centre, ...bias.half, G.zone, G.north ? 1 : 0, e0, n0, G.res, t.w, t.h, KERNELS[kernel] ?? 1, bound, fallback, ...(crop ? [crop.lat0, crop.lon0, crop.dlat, crop.dlon, crop.w, crop.h] : [0, 0, 0, 0, 0, 0]), patches[0].x0, patches[0].y0, pw, ph, nb, patches[0].scale ?? 1]);
      const demArr = crop ? crop.heights : new Float32Array(0);
      const r = await app.pool.run('ortho', { spec, dem: demArr, src, w: t.w, h: t.h, nb }, { kind: 'analysis', transfer: [spec.buffer, src.buffer, ...(crop ? [demArr.buffer] : [])], timeout: 600000, priority: 'background' });
      cells += r.cells;
      if (r.maxErr > maxErr) {
        maxErr = r.maxErr;
        worst = { tile: [t.tx, t.ty], cell: r.worst, dem: !!crop, hRange: [hlo, hhi] };
      }
      for (let y = 0; y < t.h; y++)
        for (let x = 0; x < t.w; x++) {
          const k = y * t.w + x;
          if (!r.mask[k]) continue;
          const g = (t.ty + y) * G.w + t.tx + x;
          mask[g] = 1;
          for (let b = 0; b < nb; b++) bands[b][g] = r.bands[b][k];
        }
      done++;
      onProgress?.(done / tiles.length);
    };
    const conc = Math.max(1, Math.min(app.pool.size ?? 2, tiles.length));
    let next = 0;
    try {
      await Promise.all(Array.from({ length: conc }, async () => {
        while (next < tiles.length) await runTile(tiles[next++]);
      }));
    } finally {
      closeHelpers(app, helpers);
    }
    return { grid: G, bands, mask, layer: l.id, image: l.info.iid, stats: { tiles: tiles.length, cells, maxErrPx: maxErr, worst, kernel, bound, dem: dem?.name ?? `none (${fallback.toFixed(0)} m HAE)`, ms: Math.round(performance.now() - t0) } };
  }

  /** COG bytes of an ortho or mosaic ({grid, bands, mask}); u8 output for 8-bit sources. */
  async function cogOf(o, { u8 = true, description = '' } = {}) {
    const { grid: G, bands, mask } = o;
    const n = G.w * G.h;
    const nb = bands.length;
    const data = u8 ? new Uint8Array(n * nb) : new Float32Array(n * nb);
    for (let i = 0; i < n; i++)
      for (let b = 0; b < nb; b++) {
        const v = bands[b][i];
        data[i * nb + b] = mask[i] ? (u8 ? Math.max(1, Math.min(255, Math.round(v))) : v) : u8 ? 0 : NaN;
      }
    return writeGeoTiff({ width: G.w, height: G.h, bands: nb, type: u8 ? 'u8' : 'f32', data }, { epsg: (G.north ? 32600 : 32700) + G.zone, geotransform: [G.e0, G.res, 0, G.n0, 0, -G.res], nodata: u8 ? 0 : NaN, photometric: nb === 3 ? 'rgb' : 'minisblack', overviews: true, tile: 256, description });
  }

  async function openProduct(o, name) {
    const bytes = await cogOf(o, { description: `GIS Workbench ${o.mosaic ? 'orthomosaic' : 'orthoimage'} ${name}` });
    const file = new File([bytes], name, { type: 'image/tiff', lastModified: Date.now() });
    const { layers } = await openImageFile(app, file);
    o.productLayer = layers[0].id;
    return { file, layer: layers[0], bytes };
  }

  /** Horizontal accuracy of an ortho at the block checkpoints (AT-09.1): measured in the source image, mapped by ray–DEM. */
  function orthoAccuracy(l, G) {
    const dem = terrainFor({ north: 90, south: -90, west: -180, east: 180 }) ?? app.terrain.dems[0];
    const rows = [];
    for (const p of app.tri?.points() ?? []) {
      if (p.kind !== 'check' || !p.known) continue;
      const o = p.obs?.[l.id];
      if (!o) continue;
      let g = null;
      try {
        const r = dem ? core.rayDem(l.modelId, dem.coreId, o.x, o.y) : null;
        g = r ? { lat: r.crossings[r.used][0], lon: r.crossings[r.used][1] } : l.groundAt(o.x, o.y);
      } catch {
        g = l.groundAt(o.x, o.y);
      }
      if (!g) continue;
      const a = core.utm(g.lat, g.lon, G.zone);
      const b = core.utm(p.known.lat, p.known.lon, G.zone);
      rows.push({ id: p.name, dx: a.easting - b.easting, dy: a.northing - b.northing });
    }
    const n = rows.length;
    const rx = n ? Math.sqrt(rows.reduce((s, r) => s + r.dx * r.dx, 0) / n) : NaN;
    const ry = n ? Math.sqrt(rows.reduce((s, r) => s + r.dy * r.dy, 0) / n) : NaN;
    const rr = Math.hypot(rx, ry);
    return { n, rows, rmseX: rx, rmseY: ry, rmseR: rr, ce90: 1.5175 * rr, method: 'checkpoints measured in the source image, mapped by ray–DEM; CE90 = 1.5175 · RMSE_r (circular approximation)' };
  }

  // ---- true ortho (REQ-SNS-19) ----
  /**
   * Visibility of DSM points from a layer's sensor: `hidden(lat, lon)` marches from the surface
   * point up the image ray (direction from the sensor model: the ground position of the same image
   * point 100 m higher) in half-post steps and reports a hit when the DSM rises above the ray by
   * more than `tol` metres. The DSM under the ray is the highest of the four surrounding posts
   * (`occluder: 'max'`), so walls stay walls: 96.5 % of the FX-02 truth's hidden posts are found
   * with 0.04 % false alarms (bilinear heights find 81 %). Ray directions come from a lattice of
   * 16 posts and are interpolated.
   */
  function visibility(l, dsm, box, { tol = 0.25, start = 2, occluder = 'max' } = {}) {
    const c = demCrop(dsm, box);
    if (!c) throw new Error('the DSM does not cover the image');
    let zmax = -Infinity;
    for (const v of c.heights) if (Number.isFinite(v) && v > zmax) zmax = v;
    const at = (lat, lon) => {
      const fx = (lon - c.lon0) / c.dlon;
      const fy = (c.lat0 - lat) / c.dlat;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      if (i < 0 || j < 0 || i + 1 >= c.w || j + 1 >= c.h) return NaN;
      const a = fx - i;
      const b = fy - j;
      const H = c.heights;
      const k = j * c.w + i;
      return H[k] * (1 - a) * (1 - b) + H[k + 1] * a * (1 - b) + H[k + c.w] * (1 - a) * b + H[k + c.w + 1] * a * b;
    };
    // Occluders as the highest of the four surrounding posts: walls stay walls, not ramps.
    const atMax = (lat, lon) => {
      const fx = (lon - c.lon0) / c.dlon;
      const fy = (c.lat0 - lat) / c.dlat;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      if (i < 0 || j < 0 || i + 1 >= c.w || j + 1 >= c.h) return NaN;
      const H = c.heights;
      const k = j * c.w + i;
      return Math.max(H[k], H[k + 1], H[k + c.w], H[k + c.w + 1]);
    };
    const occ = occluder === 'max' ? atMax : at;
    const latC = (box.north + box.south) / 2;
    const mN = core.inverse(latC, box.west, latC + 1e-4, box.west).distance / 1e-4;
    const mE = core.inverse(latC, box.west, latC, box.west + 1e-4).distance / 1e-4;
    const postM = Math.min(c.dlat * mN, c.dlon * mE);
    const L = 16;
    const dirs = new Map();
    const dirAt = (i, j) => {
      const key = j * 100000 + i;
      let d = dirs.get(key);
      if (!d) {
        const lat = c.lat0 - j * L * c.dlat;
        const lon = c.lon0 + i * L * c.dlon;
        const z = Number.isFinite(at(lat, lon)) ? at(lat, lon) : zmax;
        const q = l.imageAt(lat, lon, z);
        const g = q ? l.groundAt(q.x, q.y, z + 100) : null;
        d = g ? [(g.lat - lat) / 100, (g.lon - lon) / 100] : [0, 0];
        dirs.set(key, d);
      }
      return d;
    };
    const dir = (lat, lon) => {
      const fx = (lon - c.lon0) / c.dlon / L;
      const fy = (c.lat0 - lat) / c.dlat / L;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const a = fx - i;
      const b = fy - j;
      const [d00, d10, d01, d11] = [dirAt(i, j), dirAt(i + 1, j), dirAt(i, j + 1), dirAt(i + 1, j + 1)];
      return [0, 1].map((k) => d00[k] * (1 - a) * (1 - b) + d10[k] * a * (1 - b) + d01[k] * (1 - a) * b + d11[k] * a * b);
    };
    function hidden(lat, lon) {
      const z = at(lat, lon);
      if (!Number.isFinite(z)) return false;
      const [dLat, dLon] = dir(lat, lon);
      const run = Math.hypot(dLat * mN, dLon * mE); // horizontal metres per metre of rise
      if (run < 1e-6) return false; // looking straight down
      const dz = (0.5 * postM) / run;
      for (let k = start; ; k++) {
        const rise = k * dz;
        if (z + rise > zmax) return false;
        const s = occ(lat + dLat * rise, lon + dLon * rise);
        if (!Number.isFinite(s)) return false;
        if (s > z + rise + tol) return true;
      }
    }
    return { hidden, zmax, postM };
  }

  /**
   * True ortho from a DSM with occlusion handling: each image is rectified onto one grid through
   * the DSM, cells its sensor cannot see (by `visibility`) are masked, and every cell takes the
   * first image (in the order given) that sees it. Cells no image sees stay empty and are counted.
   */
  async function trueOrtho(layers, { dsm = app.terrain.dems.find((d) => d.grid) ?? null, res = null, kernel = 'bilinear', tol = 0.25, onProgress } = {}) {
    if (!dsm?.grid) throw new Error('a true ortho needs a DSM loaded as terrain');
    const t0 = performance.now();
    if (!layers.length) throw new Error('a true ortho needs images with RPC models');
    const G = gridFor(layers, res ?? Math.round(Math.min(...layers.map(gsdOf)) * 20) / 20);
    const N = G.w * G.h;
    const ll = new Float64Array(2 * N);
    for (let y = 0; y < G.h; y++)
      for (let x = 0; x < G.w; x++) {
        const g = core.utmReverse(G.zone, G.north, G.e0 + (x + 0.5) * G.res, G.n0 - (y + 0.5) * G.res);
        ll[2 * (y * G.w + x)] = g.lat;
        ll[2 * (y * G.w + x) + 1] = g.lon;
      }
    const box = { north: -Infinity, south: Infinity, west: Infinity, east: -Infinity };
    for (let k = 0; k < N; k++) {
      box.south = Math.min(box.south, ll[2 * k]);
      box.north = Math.max(box.north, ll[2 * k]);
      box.west = Math.min(box.west, ll[2 * k + 1]);
      box.east = Math.max(box.east, ll[2 * k + 1]);
    }
    const nb = Math.min(...layers.map((l) => (l.chain?.bands?.length === 3 ? 3 : 1)));
    const bands = Array.from({ length: nb }, () => new Float32Array(N).fill(NaN));
    const mask = new Uint8Array(N);
    const source = new Uint8Array(N);
    const per = [];
    const seenSome = new Uint8Array(N);
    for (const [i, l] of layers.entries()) {
      const o = await orthorectify(l, { grid: G, kernel, dem: dsm, onProgress: (f) => onProgress?.((i + f * 0.5) / layers.length) });
      const v = visibility(l, dsm, box, { tol });
      let hid = 0;
      let used = 0;
      for (let k = 0; k < N; k++) {
        if (!o.mask[k]) continue;
        seenSome[k] = 1;
        if (v.hidden(ll[2 * k], ll[2 * k + 1])) {
          hid++;
          continue;
        }
        if (mask[k]) continue;
        mask[k] = 1;
        source[k] = i + 1;
        used++;
        for (let b = 0; b < nb; b++) bands[b][k] = o.bands[b][k];
      }
      per.push({ layer: l.id, image: l.info.iid, occluded: hid, used });
      onProgress?.((i + 1) / layers.length);
    }
    let holes = 0;
    for (let k = 0; k < N; k++) if (seenSome[k] && !mask[k]) holes++;
    return { grid: G, bands, mask, source, mosaic: layers.length > 1, trueOrtho: true, stats: { images: per, holes, holeFraction: holes / N, dsm: dsm.name, tol, ms: Math.round(performance.now() - t0) } };
  }

  // ---- mosaics ----
  /** Orthorectify layers onto one grid and blend them (automatic seams, colour balance, feathering). */
  async function mosaic(layers, { res = null, grid = null, kernel = 'bilinear', balance = 'gainoffset', feather = 8, onProgress } = {}) {
    const t0 = performance.now();
    const G = grid ?? gridFor(layers, res ?? Math.round(Math.min(...layers.map(gsdOf)) * 20) / 20);
    const orthos = [];
    for (const [i, l] of layers.entries()) orthos.push(await orthorectify(l, { grid: G, kernel, onProgress: (f) => onProgress?.((i + f) / (layers.length + 1)) }));
    const N = G.w * G.h;
    // Automatic seams: each pixel from the image whose footprint centre (near nadir for a
    // satellite) is nearest, among the images with data there.
    const centres = layers.map((l) => {
      const c = l.groundAt(l.width / 2, l.height / 2);
      const u = core.utm(c.lat, c.lon, G.zone);
      return [(u.easting - G.e0) / G.res, (G.n0 - u.northing) / G.res];
    });
    const labels = new Uint8Array(N).fill(255);
    for (let y = 0; y < G.h; y++)
      for (let x = 0; x < G.w; x++) {
        const k = y * G.w + x;
        let best = 255;
        let bd = Infinity;
        orthos.forEach((o, i) => {
          if (!o.mask[k]) return;
          const d = Math.hypot(x - centres[i][0], y - centres[i][1]);
          if (d < bd) {
            bd = d;
            best = i;
          }
        });
        labels[k] = best;
      }
    const gains = balanceGains(orthos, balance);
    const m = { mosaic: true, grid: G, layers: layers.map((l) => l.id), orthos, labels, gains, feather, bands: Array.from({ length: orthos[0].bands.length }, () => new Float32Array(N).fill(NaN)), mask: new Uint8Array(N), stats: {} };
    const tiles = [];
    for (let ty = 0; ty < G.h; ty += TILE) for (let tx = 0; tx < G.w; tx += TILE) tiles.push({ tx, ty, w: Math.min(TILE, G.w - tx), h: Math.min(TILE, G.h - ty) });
    await reblend(m, tiles);
    m.stats = { tiles: tiles.length, images: layers.length, ms: Math.round(performance.now() - t0), balance, feather };
    onProgress?.(1);
    return m;
  }

  /** Gain/offset (overlap mean and spread) or histogram matching (quantile map, approximated by a linear fit of 32 quantiles). */
  function balanceGains(orthos, mode) {
    const n = orthos.length;
    const gains = Array.from({ length: n }, () => [1, 0]);
    if (mode === 'none' || n < 2) return gains;
    const band = (o) => o.bands[0];
    for (let i = 1; i < n; i++) {
      const a = [];
      const b = [];
      const step = Math.max(1, Math.floor(band(orthos[0]).length / 200000));
      for (let k = 0; k < band(orthos[i]).length; k += step) {
        if (!orthos[i].mask[k]) continue;
        for (let j = 0; j < i; j++)
          if (orthos[j].mask[k]) {
            a.push(band(orthos[j])[k] * gains[j][0] + gains[j][1]);
            b.push(band(orthos[i])[k]);
            break;
          }
      }
      if (a.length < 64) continue;
      if (mode === 'histogram') {
        a.sort((x, y) => x - y);
        b.sort((x, y) => x - y);
        const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
        let sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let k = 1; k < 32; k++) {
          const x = q(b, k / 32);
          const y = q(a, k / 32);
          sx += x;
          sy += y;
          sxx += x * x;
          sxy += x * y;
        }
        const m = 31;
        const g = (m * sxy - sx * sy) / Math.max(1e-9, m * sxx - sx * sx);
        gains[i] = [g, (sy - g * sx) / m];
      } else {
        const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
        const ma = mean(a);
        const mb = mean(b);
        const sa = Math.sqrt(a.reduce((s, x) => s + (x - ma) ** 2, 0) / a.length);
        const sb = Math.sqrt(b.reduce((s, x) => s + (x - mb) ** 2, 0) / b.length) || 1;
        const g = sa / sb;
        gains[i] = [g, ma - g * mb];
      }
    }
    return gains;
  }

  /** Blend the given tiles of a mosaic in the workers (with a feather margin around each tile). */
  async function reblend(m, tiles) {
    const G = m.grid;
    const ni = m.orthos.length;
    const nb = m.bands.length;
    const f = m.feather;
    const run = async (t) => {
      // Tile plus a feather margin, so seams near tile edges blend the same in every tile.
      const x0 = Math.max(0, t.tx - f);
      const y0 = Math.max(0, t.ty - f);
      const x1 = Math.min(G.w, t.tx + t.w + f);
      const y1 = Math.min(G.h, t.ty + t.h + f);
      const w = x1 - x0;
      const hh = y1 - y0;
      const n = w * hh;
      const data = new Float32Array(n * (1 + ni * (1 + nb)));
      for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) data[y * w + x] = m.labels[(y0 + y) * G.w + x0 + x];
      let o = n;
      for (const or of m.orthos) {
        for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) data[o + y * w + x] = or.mask[(y0 + y) * G.w + x0 + x];
        o += n;
        for (let b = 0; b < nb; b++) {
          for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) data[o + y * w + x] = or.bands[b][(y0 + y) * G.w + x0 + x];
          o += n;
        }
      }
      const prm = Float64Array.from([w, hh, ni, nb, f, ...m.gains.flat()]);
      const r = await app.pool.run('blend', { prm, data, w, h: hh, nb }, { kind: 'analysis', transfer: [prm.buffer, data.buffer], priority: 'interactive' });
      for (let y = t.ty; y < t.ty + t.h; y++)
        for (let x = t.tx; x < t.tx + t.w; x++) {
          const k = (y - y0) * w + (x - x0);
          const g = y * G.w + x;
          m.mask[g] = r.mask[k];
          for (let b = 0; b < nb; b++) m.bands[b][g] = r.bands[b][k];
        }
    };
    const conc = Math.max(1, Math.min(app.pool.size ?? 2, tiles.length));
    let next = 0;
    await Promise.all(Array.from({ length: conc }, async () => {
      while (next < tiles.length) await run(tiles[next++]);
    }));
  }

  /**
   * Seam edit (REQ-SNS-18): pixels inside a ring [[lon, lat]…] take image `index` where it has
   * data; only the tiles the ring touches (plus the feather) are blended again. The displayed
   * product is updated through the decode worker's overlay.
   */
  async function seamEdit(m, ring, index) {
    const t0 = performance.now();
    const G = m.grid;
    const px = ring.map(([lon, lat]) => {
      const u = core.utm(lat, lon, G.zone);
      return [(u.easting - G.e0) / G.res, (G.n0 - u.northing) / G.res];
    });
    const xs = px.map((p) => p[0]);
    const ys = px.map((p) => p[1]);
    const bx0 = Math.max(0, Math.floor(Math.min(...xs)));
    const bx1 = Math.min(G.w - 1, Math.ceil(Math.max(...xs)));
    const by0 = Math.max(0, Math.floor(Math.min(...ys)));
    const by1 = Math.min(G.h - 1, Math.ceil(Math.max(...ys)));
    const inside = (x, y) => {
      let c = false;
      for (let a = 0, b = px.length - 1; a < px.length; b = a++) if (px[a][1] > y !== px[b][1] > y && x < ((px[b][0] - px[a][0]) * (y - px[a][1])) / (px[b][1] - px[a][1]) + px[a][0]) c = !c;
      return c;
    };
    let changed = 0;
    const o = m.orthos[index];
    for (let y = by0; y <= by1; y++)
      for (let x = bx0; x <= bx1; x++) {
        const k = y * G.w + x;
        if (o.mask[k] && inside(x + 0.5, y + 0.5) && m.labels[k] !== index) {
          m.labels[k] = index;
          changed++;
        }
      }
    const f = m.feather;
    const tiles = [];
    for (let ty = Math.floor(Math.max(0, by0 - f) / TILE) * TILE; ty <= Math.min(G.h - 1, by1 + f); ty += TILE)
      for (let tx = Math.floor(Math.max(0, bx0 - f) / TILE) * TILE; tx <= Math.min(G.w - 1, bx1 + f); tx += TILE) tiles.push({ tx, ty, w: Math.min(TILE, G.w - tx), h: Math.min(TILE, G.h - ty) });
    await reblend(m, tiles);
    const blendMs = performance.now() - t0;
    // Show the change: the product layer's band 0 tiles replaced in the decode worker.
    const l = m.productLayer && app.layers.get(m.productLayer);
    if (l?.handle) {
      const ov = tiles.map((t) => {
        const data = new Float32Array(t.w * t.h);
        for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
          const g = (t.ty + y) * G.w + t.tx + x;
          data[y * t.w + x] = m.mask[g] ? Math.max(1, Math.min(255, Math.round(m.bands[0][g]))) : 0;
        }
        return { x0: t.tx, y0: t.ty, w: t.w, h: t.h, data };
      });
      m.overlay = [...(m.overlay ?? []).filter((a) => !ov.some((b) => b.x0 === a.x0 && b.y0 === a.y0)), ...ov];
      await app.pool.run('overlay', { handle: l.handle, tiles: m.overlay.map((t) => ({ ...t, data: t.data.slice() })) }, { affinity: l.affinity });
      l.tiles.reset?.();
      app.renderer?.invalidate();
    }
    return { tiles: tiles.length, of: Math.ceil(G.w / TILE) * Math.ceil(G.h / TILE), changed, ms: Math.round(blendMs) };
  }

  app.ortho = { orthorectify, mosaic, trueOrtho, visibility, seamEdit, cogOf, openProduct, accuracy: orthoAccuracy, gridFor, gsdOf, rpcRecordOf };
  C.implement('ortho.true', {
    enabled: () => imageLayers().length > 0 && app.terrain.dems.some((d) => d.grid),
    run: async () => {
      try {
        const ls = imageLayers();
        const o = await trueOrtho(ls, { onProgress: (f) => app.cue?.(`True ortho ${(f * 100).toFixed(0)} %`) });
        await openProduct(o, `true_ortho_${ls.length}.tif`);
        toast(`True ortho: ${(o.stats.holeFraction * 100).toFixed(2)} % of cells hidden from every image (${o.stats.dsm})`);
      } catch (e) {
        toast(`True ortho: ${e.message}`, { kind: 'error' });
      }
    },
  });

  // ---- commands ----
  const imageLayers = () => (pane()?.layers() ?? []).filter((l) => l.kind !== 'dem' && rpcRecordOf(l));
  C.implement('ortho.rectify', {
    enabled: () => !!pane()?.activeLayer() && !!rpcRecordOf(pane().activeLayer()),
    run: async () => {
      const l = pane().activeLayer();
      // The default cell keeps the output near 100 M pixels: a whole strip at its native cell is not a
      // browser-sized product (a smaller cell remains a choice, up to the limit).
      const native = Math.round(gsdOf(l) * 20) / 20;
      const nbOut = l.chain?.bands?.length === 3 ? 3 : 1;
      const G0 = gridFor([l], native);
      const cell0 = G0.w * G0.h * nbOut > 100e6 ? Math.max(native, fitCell(G0, nbOut, 100e6)) : native;
      const res = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: cell0.toFixed(2), 'aria-label': 'Cell size (m)' });
      const ker = h('select', { class: 'inp', 'aria-label': 'Resampling' }, ...Object.keys(KERNELS).map((k) => h('option', { value: k, selected: k === 'bilinear' }, { nearest: 'Nearest neighbour', bilinear: 'Bilinear', cubic: 'Cubic convolution', lanczos3: 'Lanczos (3 lobes)' }[k])));
      const bound = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: '0.1', 'aria-label': 'Error bound (px)' });
      const body = h('div', {}, field('Cell size (m)', res), field('Resampling', ker), field('Grid error bound (px)', bound, 'The mapping is exact at the grid vertices; cells split until interpolation is within this bound.'), cell0 > native ? h('p', { class: 'hint' }, `Native cell ${native} m would be ${G0.w.toLocaleString()} × ${G0.h.toLocaleString()} pixels; ${cell0} m keeps the orthoimage to about 100 M pixels.`) : null, h('p', { class: 'hint' }, `Terrain: ${app.terrain.dems[0]?.name ?? 'none (the model height)'}. Output: cloud-optimised GeoTIFF in UTM.`));
      if ((await modal({ title: `Orthorectify — ${l.info.iid}`, body, buttons: ['Run', 'Cancel'], id: 'ortho-rectify' })) !== 'Run') return;
      try {
        const o = await orthorectify(l, { res: Number(res.value), kernel: ker.value, bound: Number(bound.value) });
        const { layer, bytes } = await openProduct(o, `ORTHO_${l.info.iid}.tif`);
        const acc = orthoAccuracy(l, o.grid);
        toast(`Ortho ${o.grid.w}×${o.grid.h} at ${o.grid.res} m in ${(o.stats.ms / 1000).toFixed(1)} s (grid error ≤ ${o.stats.maxErrPx.toFixed(3)} px)${acc.n ? `; checkpoints RMSE_r ${acc.rmseR.toFixed(2)} m, CE90 ${acc.ce90.toFixed(2)} m` : ''}`, { ms: 9000 });
        await saveBlob(app, new Blob([bytes], { type: 'image/tiff' }), { name: layer.rec.name, description: 'Orthoimage (COG)' });
      } catch (e) {
        toast(`Orthorectify: ${e.message}`, { kind: 'error' });
      }
    },
  });
  let lastMosaic = null;
  C.implement('ortho.mosaic', {
    enabled: () => imageLayers().length >= 2,
    run: async () => {
      const ls = imageLayers();
      const bal = h('select', { class: 'inp', 'aria-label': 'Colour balance' }, h('option', { value: 'gainoffset' }, 'Gain and offset'), h('option', { value: 'histogram' }, 'Histogram matching'), h('option', { value: 'none' }, 'None'));
      const fe = h('input', { class: 'inp inp-num', type: 'number', value: '8', 'aria-label': 'Feather (px)' });
      const body = h('div', {}, h('p', {}, `Images: ${ls.map((l) => l.info.iid).join(', ')}`), field('Colour balance', bal), field('Feather (px)', fe));
      if ((await modal({ title: 'Orthomosaic', body, buttons: ['Run', 'Cancel'], id: 'ortho-mosaic' })) !== 'Run') return;
      try {
        lastMosaic = await mosaic(ls, { balance: bal.value, feather: Number(fe.value) || 0 });
        const { layer } = await openProduct(lastMosaic, 'ORTHOMOSAIC.tif');
        app.ortho.last = lastMosaic;
        toast(`Mosaic ${lastMosaic.grid.w}×${lastMosaic.grid.h} from ${ls.length} images in ${(lastMosaic.stats.ms / 1000).toFixed(1)} s (${layer.rec.name})`);
      } catch (e) {
        toast(`Mosaic: ${e.message}`, { kind: 'error' });
      }
    },
  });
  app.tools.register({
    id: 'ortho.seam',
    cue: 'Seamline Edit: draw the area, Enter; it takes the image you choose.',
    onDown(p, e, sx, sy) {
      const g = groundOf(app, p, sx, sy);
      if (g) (this.state.pts ??= []).push([g.lon, g.lat, sx, sy]);
      p.invalidate();
      return true;
    },
    onDblClick(p) {
      this.onEnter(p);
      return true;
    },
    async onEnter() {
      const pts = this.state.pts ?? [];
      this.state = {};
      app.tools.done();
      const m = app.ortho.last;
      if (!m || pts.length < 3) return;
      const sel = h('select', { class: 'inp', 'aria-label': 'Image' }, ...m.orthos.map((o, i) => h('option', { value: String(i) }, o.image)));
      if ((await modal({ title: 'Seamline Edit', body: field('Take this area from', sel), buttons: ['OK', 'Cancel'], id: 'seam-edit' })) !== 'OK') return;
      const r = await seamEdit(m, pts.map((q) => [q[0], q[1]]), Number(sel.value));
      toast(`Seam edit: ${r.changed} pixels, ${r.tiles} of ${r.of} tiles re-blended in ${r.ms} ms`);
    },
    draw(p, g, w, hh, s) {
      const pts = (s.pts ?? []).map((q) => ({ x: q[2], y: q[3] }));
      if (!pts.length) return;
      g.strokeStyle = '#ffd400';
      poly(g, pts, true);
      g.stroke();
    },
  });
  C.implement('ortho.seam', { enabled: () => !!app.ortho.last, run: () => app.tools.select('ortho.seam') });
  C.implement('ortho.balance', {
    enabled: () => !!app.ortho.last,
    run: async () => {
      const m = app.ortho.last;
      const bal = h('select', { class: 'inp', 'aria-label': 'Colour balance' }, h('option', { value: 'gainoffset' }, 'Gain and offset'), h('option', { value: 'histogram' }, 'Histogram matching'), h('option', { value: 'none' }, 'None'));
      if ((await modal({ title: 'Colour Balance', body: field('Method', bal), buttons: ['Apply', 'Cancel'], id: 'mosaic-balance' })) !== 'Apply') return;
      m.gains = balanceGains(m.orthos, bal.value);
      const G = m.grid;
      const tiles = [];
      for (let ty = 0; ty < G.h; ty += TILE) for (let tx = 0; tx < G.w; tx += TILE) tiles.push({ tx, ty, w: Math.min(TILE, G.w - tx), h: Math.min(TILE, G.h - ty) });
      await reblend(m, tiles);
      await openProduct(m, 'ORTHOMOSAIC_balanced.tif');
    },
  });
  void ID6;
}
