// Terrain manager (REQ-DEM-01/03 partial, REQ-GEO-03): loaded DEMs are registered in the
// Rust core for height look-ups and ray–DEM intersection. DTED/SRTM heights are MSL (EGM96)
// and are converted to HAE through the embedded geoid before any sensor-model call.

import { t, gwError } from '../i18n/index.js';

// Posts (f32) the core may hold for terrain, counting the copy a grid makes on its way in: the core is
// capped at 256 MiB (REQ-RUST-05) and sensor-model batches need tens of MB beside the terrains. Five
// 1″ SRTM/DTED tiles filled it and the next core call trapped, restarting the core and losing every
// terrain (CX-093).

export const TERRAIN_POSTS = 48e6;

/**
 * The declared no-data posts of a height grid become voids (NaN), in place. Call it before any
 * resampling: interpolated, a no-data value such as 1.7e38 leaks into its neighbours as heights that
 * nothing can tell from no-data any more. The tag is read as a double, and a tag Float32 cannot hold
 * exactly (GDAL writes 1.7014100000000001e+38) equals its own posts only once rounded to Float32.
 */
export function voidNoData(heights, nodata) {
  if (!Number.isFinite(nodata)) return heights; // none declared, or NaN: already voids
  const single = Math.fround(nodata);
  for (let i = 0; i < heights.length; i++) if (heights[i] === nodata || heights[i] === single) heights[i] = NaN;
  return heights;
}

/** Every `k`-th post of a geographic grid. */
export function decimateGrid(g, heights, k) {
  if (k === 1) return { ...g, heights };
  const w = Math.ceil(g.width / k);
  const h = Math.ceil(g.height / k);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = heights[y * k * g.width + x * k];
  return { lat0: g.lat0, lon0: g.lon0, dlat: g.dlat * k, dlon: g.dlon * k, width: w, height: h, heights: out };
}

/**
 * The geographic grid a DEM not in EPSG:4326 is resampled onto when used as terrain (REG-010): its own
 * post spacing (`cell` [x, y] m, times the `step` it was read at) over `bounds` {n, s, w, e} (degrees),
 * spaced out evenly only when that would pass `budget` posts (Terrain.room(): what the core can take
 * at full detail, so Terrain.load() does not thin it again). It used to stop at 2,048 posts a side,
 * which blurred any projected DEM larger than that. Returns {dlat, dlon, width, height}.
 */
export function geographicGridFor({ n, s, w, e }, cell, step = 1, budget = TERRAIN_POSTS) {
  let dlat = (Math.max(cell[1], 1e-3) * step) / 111000;
  let dlon = (Math.max(cell[0], 1e-3) * step) / (111000 * Math.cos(((n + s) / 2) * (Math.PI / 180)));
  const size = () => [Math.ceil((e - w) / dlon) + 1, Math.ceil((n - s) / dlat) + 1];
  let [width, height] = size();
  if (width * height > budget) {
    const k = Math.sqrt((width * height) / budget);
    dlat *= k;
    dlon *= k;
    for ([width, height] = size(); width * height > budget; [width, height] = size()) {
      dlat *= 1.002;
      dlon *= 1.002;
    }
  }
  return { dlat, dlon, width, height };
}

/** The post step that keeps `posts` within the budget beside `used` posts already loaded (0: none fits). */
export function terrainStep(width, height, used, budget = TERRAIN_POSTS) {
  for (let k = 1; k <= 16; k++) if (used + 2 * Math.ceil(width / k) * Math.ceil(height / k) <= budget) return k;
  return 0;
}

export class Terrain {
  constructor(app) {
    this.app = app;
    this.all = []; // {layerId, name, nameOf, coreId, bounds, sigmaV, vertical, posts, step}
    // The core converts a height when it is read, so a geoid pack opened later changes what is
    // already loaded, and the names must follow.
    this.app.on?.('geoid', () => this.relabel());
  }

  /** The geoid that puts `vertical` heights on the ellipsoid: a grid pack's, or the one in the core. */
  converter(vertical) {
    return this.app.grids?.geoidFor?.(vertical) ?? this.app.core.demGeoid ?? 'EGM96';
  }

  /** The vertical part of a terrain's name: the datum of its heights and what really converts them. */
  /**
   * h − H (m) at [lon, lat] points for heights in `vertical`, converted as a terrain converts them
   * (#105): 0 for HAE; the datum's geoid grid plus its frame's height change while that grid is
   * loaded; the core's geoid otherwise and outside the grid (NaN where it has none). `grid` false:
   * a DEM registered before its grid was loaded, whose heights went through the core's geoid.
   */
  separations(vertical, pts, grid = true) {
    if (vertical === 'hae') return pts.map(() => 0);
    const s = grid && vertical !== 'egm96' ? (this.app.grids?.separations?.(vertical, pts) ?? null) : null;
    return pts.map(([lon, lat], k) => (Number.isFinite(s?.[k]) ? s[k] : this.app.core.undulation(lat, lon)));
  }

  verticalName(vertical, gridV = null) {
    if (gridV) return gridV.label;
    const g = this.app.core.demGeoid ?? 'EGM96';
    if (vertical === 'hae') return 'HAE';
    if (vertical === 'egm96') return g === 'EGM96' ? 'MSL EGM96' : `MSL EGM96 (converted with ${g})`;
    if (vertical === 'egm2008') return `MSL EGM2008 (converted with ${g})`;
    // No GEOID18 grid: the core takes these heights as orthometric on its own geoid.
    if (vertical === 'navd88') return `NAVD88 (read as ${g} heights)`;
    return vertical;
  }

  relabel() {
    let changed = false;
    for (const d of this.all) {
      if (!d.nameOf) continue;
      const name = d.nameOf(this.verticalName(d.vertical, d.gridV));
      if (name !== d.name) {
        d.name = name;
        changed = true;
      }
    }
    if (changed) this.app.emit('terrain');
  }

  /**
   * The most posts one more grid can hold at full detail: load() counts the copy a grid makes on its
   * way in, so it is half of what the other terrains leave of the budget.
   */
  room() {
    const used = this.all.reduce((s, d) => s + (d.posts ?? d.grid.width * d.grid.height), 0);
    return Math.max(0, Math.floor((TERRAIN_POSTS - used) / 2));
  }

  /** Load a grid into the core within the terrain budget: {coreId, posts, step}. */
  load(name, g, heights, hae, sigmaV, replacing = null) {
    const used = this.all.reduce((s, d) => s + (d === replacing ? 0 : d.posts ?? d.grid.width * d.grid.height), 0);
    const step = terrainStep(g.width, g.height, used);
    if (!step) throw gwError('terrain memory is full ({n} M posts loaded); remove a DEM from terrain first', { n: String(Math.round(used / 1e6)) }, 'E_TERRAIN_FULL');
    const c = decimateGrid(g, heights, step);
    if (replacing) this.app.core.freeDem(replacing.coreId);
    const coreId = this.app.core.loadDem({ lat0: c.lat0, lon0: c.lon0, dlat: c.dlat, dlon: c.dlon, width: c.width, height: c.height, heights: c.heights, hae, sigmaV });
    if (step > 1) this.app.toast?.(t("{name}: terrain keeps every {step, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} post ({w} × {h}) to stay within the core's memory; close a DEM for full resolution", { name, step, w: String(c.width), h: String(c.height) }), { kind: 'warn', ms: 9000 });
    return { coreId, posts: c.width * c.height, step };
  }

  /**
   * The terrains whose layer is in the project. A layer removed by undo keeps its runtime (and its
   * terrain, for redo) but no longer counts: Save DEM As on a Ground Filter DTM undone had read the
   * removed layer's record (CX-081).
   */
  get dems() {
    return this.all.filter((d) => this.live(d));
  }

  live(d) {
    return !d.layerId || !!this.app.store.get(d.layerId);
  }

  addFromLayer(layer, res) {
    const g = res.gridInfo;
    const heights = res.heights;
    if (!g || !heights) return;
    const meta = res.meta ?? {};
    // DTED ACC/UHL accuracy is a 90 % linear error; σ = LE90 / 1.6449.
    const le = Number(meta.accAbsVertical || meta.absVerticalAccuracy);
    const sigmaV = Number.isFinite(le) && le > 0 ? le / 1.6449 : meta.format === 'SRTM HGT' ? 16 / 1.6449 : NaN;
    const hae = false; // DTED (MSL/E96) and SRTM are both orthometric on EGM96
    this.app.ensureGeoid?.();
    const { coreId, posts, step } = this.load(layer.rec.name, g, heights, hae, sigmaV);
    const nameOf = (vname) => `${layer.rec.name} (${meta.level || meta.format || 'DEM'}, ${vname}${step > 1 ? `, every ${step}th post` : ''})`;
    this.all.push({
      layerId: layer.id,
      vertical: 'egm96',
      name: nameOf(this.verticalName('egm96')),
      nameOf,
      coreId,
      posts,
      step,
      sigmaV,
      // The source grid (never changed) and whether its posts are the layer's pixels (edits, REQ-DEM-08).
      grid: { lat0: g.lat0, lon0: g.lon0, dlat: g.dlat, dlon: g.dlon, width: g.width, height: g.height, heights },
      aligned: true,
      bounds: { north: g.lat0, south: g.lat0 - g.dlat * (g.height - 1), west: g.lon0, east: g.lon0 + g.dlon * (g.width - 1) },
    });
    this.app.emit('terrain');
  }

  /**
   * Register a DEM from a geographic grid (Use as Terrain, REQ-DEM-02). `vertical`: 'egm96'
   * (orthometric; converted to HAE with the embedded geoid), 'hae', 'egm2008' or 'navd88'. Without
   * their grid pack, the last two go to HAE through the geoid in the core: EGM96, or EGM2008 5′ once
   * that pack is open. The name says which, and follows it.
   */
  addGrid(layer, g, { vertical = 'egm96', sigmaV = NaN, label = '', aligned = true } = {}) {
    // REQ-GAP-16: heights on a geoid whose grid is loaded (EGM2008 2.5′, GEOID18 for NAVD88, …)
    // become HAE here with that grid (geo/grids.js demHeights); otherwise as before.
    const gridV = vertical !== 'hae' && vertical !== 'egm96' ? (this.app.grids?.demHeights?.(g, vertical, (la, lo) => this.app.core.undulation(la, lo)) ?? null) : null;
    const hae = vertical === 'hae' || !!gridV;
    this.app.ensureGeoid?.();
    this.remove(layer.id);
    const { coreId, posts, step } = this.load(layer.rec.name, g, gridV ? gridV.convert(g.heights) : g.heights, hae, sigmaV);
    const nameOf = (vname) => (step > 1 ? t('{layer} ({label}, {vertical}, every {step, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} post)', { layer: layer.rec.name, label: label || 'DEM', vertical: vname, step }) : `${layer.rec.name} (${label || 'DEM'}, ${vname})`);
    this.all.push({
      layerId: layer.id,
      name: nameOf(this.verticalName(vertical, gridV)),
      nameOf,
      coreId,
      posts,
      step,
      sigmaV,
      vertical,
      gridV,
      grid: { lat0: g.lat0, lon0: g.lon0, dlat: g.dlat, dlon: g.dlon, width: g.width, height: g.height, heights: g.heights },
      aligned,
      bounds: { north: g.lat0, south: g.lat0 - g.dlat * (g.height - 1), west: g.lon0, east: g.lon0 + g.dlon * (g.width - 1) },
    });
    this.app.emit('terrain');
  }

  entry(layerId) {
    return this.dems.find((d) => d.layerId === layerId) ?? null;
  }

  /** Replace a terrain's heights in the core (edited DEMs); the source grid stays as it was. */
  setHeights(layerId, heights) {
    const d = this.entry(layerId);
    if (!d) return;
    const r = this.load(d.name, d.grid, d.gridV ? d.gridV.convert(heights) : heights, d.vertical === 'hae' || !!d.gridV, d.sigmaV, d);
    Object.assign(d, { coreId: r.coreId, posts: r.posts, step: r.step });
    d.current = heights;
    this.app.emit('terrain');
  }

  remove(layerId) {
    const i = this.all.findIndex((d) => d.layerId === layerId);
    if (i >= 0) {
      this.app.core.freeDem(this.all[i].coreId);
      this.all.splice(i, 1);
      this.app.emit('terrain');
    }
  }

  covering(lat, lon) {
    return this.all.find((d) => this.live(d) && lat <= d.bounds.north && lat >= d.bounds.south && lon >= d.bounds.west && lon <= d.bounds.east) ?? null;
  }

  /** DEM height (HAE) at a point, with its source, or null. */
  sample(lat, lon) {
    const d = this.covering(lat, lon);
    if (!d) return null;
    const hae = this.app.core.demHae(d.coreId, lat, lon);
    if (!Number.isFinite(hae)) return null;
    return { hae, msl: hae - this.app.core.undulation(lat, lon), name: d.name, sigmaV: d.sigmaV };
  }

  /** DEM under an image layer's centre, for ray–DEM. */
  demFor(layer) {
    const c = layer.groundAt(layer.width / 2, layer.height / 2);
    return c ? this.covering(c.lat, c.lon) : null;
  }

  get available() {
    return this.dems.length > 0;
  }
}
