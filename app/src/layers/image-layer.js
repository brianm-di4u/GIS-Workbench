// Runtime object for one image layer: decoder handle, sensor model, chain → LUT textures,
// DRA statistics by scope, ground ↔ image through the Rust core. The store holds the
// layer's persistent state (name, chain, visibility); this holds what cannot be serialised.

import { TileSet } from '../render/tiles.js';
import { buildLut, palette, histogramFromArrays, chainSummary, normalizeChain, filterKernel } from '../render/chain.js';
import { clone } from '../core/util.js';
import { evaluate as bmEvaluate } from '../render/bandmath.js';

const TEXKIND = { u8: 'u', u16: 'u', i16: 'i', f32: 'f' };

export class ImageLayer {
  constructor(app, rec, raster, info) {
    this.app = app;
    this.id = rec.id;
    this.kind = rec.kind; // 'image' | 'dem'
    this.handle = raster.handle;
    this.affinity = info.affinity;
    this.width = raster.width;
    this.height = raster.height;
    this.bands = raster.bands;
    this.levels = raster.levels;
    this.sampleType = raster.sampleType;
    this.texKind = TEXKIND[raster.sampleType] ?? 'f';
    this.nodata = typeof raster.nodata === 'number' ? raster.nodata : null;
    this.info = info; // metadata for panels: format, header, security, model hints
    this.modelId = null;
    this.modelName = 'none';
    this.modelInfo = null;
    this.stats = null; // full-image histograms per band (by band index)
    this.viewHist = null;
    this.lutTex = null;
    this.palTex = null;
    this.lutParams = [{ scale: 1, offset: 0 }];
    // 180 s: a tile is slow, not stuck, while its worker builds first displays of several large files
    // (eleven 16k² JPEG GeoTIFFs from one ZIP: tiles past 60 s failed and were dropped, TE 2.0.4 cross).
    // A stuck job is still caught, and a timed-out one is cancelled without restarting the worker.
    this.tiles = new TileSet(this, app.renderer, (L, tx, ty, bands) =>
      app.pool.run('tile', { handle: this.handle, level: L, tx, ty, bands }, { affinity: this.affinity, priority: 'interactive', label: `tile ${L}/${tx}/${ty}`, timeout: 180000 }),
    );
    this._chainSig = '';
    this._statsPending = null;
  }

  get rec() {
    return this.app.store.get(this.id);
  }

  /** Registration affine (layer pixel → panel reference pixel), stored with the layer (REQ-SNS-09). */
  get align() {
    return this._stereoAlign ?? this._alignPreview ?? this.rec?.align ?? null;
  }

  get chain() {
    const c = this.rec?.chain;
    // Chains saved by older builds lack the filter/curve/clip fields: add the defaults.
    return c && (!c.filter || !c.clip) ? normalizeChain(c) : c;
  }

  get opacity() {
    return this.rec?.opacity ?? 1;
  }

  /**
   * DEM cell size in metres at full resolution and the grid-north angle of the raster's up
   * axis, measured through the model at the image centre (cached per model).
   */
  demCell() {
    if (this._cell && this._cellModel === this.modelId) return this._cell;
    let cell = [30, 30, 0];
    try {
      const cx = this.width / 2;
      const cy = this.height / 2;
      const a = this.groundAt(cx, cy, 0);
      const b = this.groundAt(cx + 1, cy, 0);
      const c = this.groundAt(cx, cy + 1, 0);
      const up = this.groundAt(cx, cy - 1, 0);
      const core = this.app.core;
      const north = core.inverse(a.lat, a.lon, up.lat, up.lon).azi1;
      cell = [core.inverse(a.lat, a.lon, b.lat, b.lon).distance, core.inverse(a.lat, a.lon, c.lat, c.lon).distance, (north * Math.PI) / 180];
    } catch {
      /* no model: 30 m posts, north up */
    }
    this._cell = cell;
    this._cellModel = this.modelId;
    return cell;
  }

  get kernelEffective() {
    // Software rendering falls back to bilinear (REQ-IMG-33), and so does a spatial filter
    // (a 5×5 filter under a bicubic kernel would cost 400 texel reads per pixel).
    const k = this.chain.kernel;
    const heavy = k === 'bicubic' || k === 'lanczos3';
    return heavy && (this.app.softwareGl || filterKernel(this.chain).mode > 0) ? 'bilinear' : k; // CLAHE uses the filtered program too
  }

  /**
   * The radiometric state (REQ-MSI-05/06): per-band gain/offset taking DN to the layer's unit,
   * from the file or a conversion the analyst applied (stored on the layer record).
   */
  get radiometry() {
    return this.rec?.radiometry ?? this.info.radiometry ?? { state: 'DN', gain: null, offset: null, unit: 'DN', source: 'file' };
  }

  radiometryFor(bands) {
    const r = this.radiometry;
    return { gain: bands.map((b) => r.gain?.[b] ?? 1), offset: bands.map((b) => r.offset?.[b] ?? 0) };
  }

  /** Histogram of the Band Math output at the statistics level (REQ-MSI-04). */
  async bandMathStats() {
    const bm = this.chain.bandMath;
    const key = JSON.stringify([bm.glsl, bm.bands, this.radiometry.gain, this.radiometry.offset]);
    if (this.bmHist && this._bmKey === key) return this.bmHist;
    const step = Math.max(1, Math.floor(Math.sqrt((this.width * this.height) / 512 ** 2)));
    // From the pyramid level of the step: a histogram needs no full-resolution read.
    const c = await this.app.pool.run('cube', { handle: this.handle, step, bands: bm.bands, pyramid: true }, { affinity: this.affinity, label: `band math statistics ${this.rec?.name}` });
    const n = c.w * c.h;
    const planes = bm.bands.map((_, k) => {
      const p = new Float32Array(n);
      for (let i = 0; i < n; i++) p[i] = c.v[i * c.nb + k];
      return p;
    });
    const r = this.radiometryFor(bm.bands);
    const v = bmEvaluate(bm.ast, planes, r);
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of v) if (Number.isFinite(x)) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (bm.range) [lo, hi] = bm.range;
    if (!(hi > lo)) [lo, hi] = [Number.isFinite(lo) ? lo - 1 : -1, Number.isFinite(lo) ? lo + 1 : 1];
    const bins = new Uint32Array(4096);
    const bw = (hi - lo) / 4096;
    let count = 0;
    for (const x of v) if (Number.isFinite(x)) {
      bins[Math.min(4095, Math.max(0, Math.floor((x - lo) / bw)))]++;
      count++;
    }
    this.bmHist = { bins, offset: 0, min: lo, max: hi, binWidth: bw, count, type: 'f32' };
    this.bmValues = { v, w: c.w, h: c.h, step };
    this._bmKey = key;
    return this.bmHist;
  }

  /** Full-image statistics for the selected bands (worker, level nearest 1024²). */
  async ensureStats() {
    if (!this.chain) return;
    if (this.chain.bandMath) await this.bandMathStats();
    const bands = this.chain.bands;
    const need = bands.filter((b) => !this.stats?.[b]);
    if (!need.length) return;
    if (!this._statsPending) {
      this._statsPending = this.app.pool
        .run('stats', { handle: this.handle, bands: need }, { affinity: this.affinity, label: `statistics ${this.rec?.name}`, timeout: 300000 })
        .then((s) => {
          this.stats ??= {};
          need.forEach((b, i) => (this.stats[b] = s.bands[i]));
        })
        .finally(() => (this._statsPending = null));
    }
    await this._statsPending;
    return this.ensureStats();
  }

  /**
   * Until its statistics arrive, an 8-bit layer is drawn with a flat histogram (a straight 0–255
   * stretch), so the first tile does not wait for them: a GeoPackage tile pyramid spent 490 ms on
   * statistics before anything showed, 1078 ms to first tile (CX-086). The real stretch replaces it.
   */
  provisionalStats() {
    if (this.sampleType !== 'u8' || !this.chain || this.chain.bandMath) return null;
    if (!this._provisional) {
      const bins = new Uint32Array(256).fill(1);
      this._provisional = { bins, offset: 0, min: 0, binWidth: 1, count: 256, type: 'u8' };
    }
    return Object.fromEntries(this.chain.bands.map((b) => [b, this._provisional]));
  }

  /** Rebuild LUT textures when the chain or the DRA statistics change. */
  updateLut(force = false) {
    const ch = this.chain;
    const stats = this.stats ?? this.provisionalStats();
    if (!ch || !stats) return false;
    const scope = ch.dra.scope;
    const useView = ch.stretch === 'dra' && (scope === 'viewport' || scope === 'aoi') && this.viewHist && !ch.dra.lock;
    const sig = JSON.stringify([ch.bands, ch.stretch, ch.dra, ch.tone, ch.colour, ch.enabled, ch.manual ?? null, ch.dem?.mode === 'relief' ? 'r' : '', ch.clahe ?? null, useView ? this.viewHistSig : 0, ch.bandMath ? this._bmKey : 0, ch.sarRemap ?? 0]);
    if (!force && sig === this._chainSig && this.lutTex) return false;
    if (ch.dra.lock && this.lutTex && this._lockedFor === JSON.stringify([ch.bands])) {
      // Locked DRA keeps the stretch; tone changes still rebuild with the frozen histograms.
    }
    this._chainSig = sig;
    const luts = [];
    const params = [];
    if (ch.bandMath) {
      // One float LUT over the expression's output range.
      if (!this.bmHist) return false;
      const r = buildLut(this.bmHist, 'f32', ch, 0);
      this.lutParams = [{ scale: r.domain.scale, offset: r.domain.offset, lo: r.lo, hi: r.hi }];
      const rr = this.app.renderer;
      if (this.lutTex) rr.freeTexture(this.lutTex);
      if (this.palTex) rr.freeTexture(this.palTex);
      this.lutTex = rr.makeLut([r.lut]);
      this.palTex = rr.makePalette(palette(ch.colour.palette, ch.colour.table));
      return true;
    }
    ch.bands.forEach((b, i) => {
      let h = stats[b];
      if (useView && this.viewHist?.[i]?.count > 500) h = this.viewHist[i];
      if (ch.dra.lock && this.lockedHist?.[i]) h = this.lockedHist[i];
      const r = buildLut(h, this.sampleType, ch, b);
      luts.push(r.lut);
      this._baseLuts = luts;
      params.push({ scale: r.domain.scale, offset: r.domain.offset, lo: r.lo, hi: r.hi });
    });
    this.lutParams = params;
    const r = this.app.renderer;
    if (this.lutTex) r.freeTexture(this.lutTex);
    if (this.palTex) r.freeTexture(this.palTex);
    this.lutTex = r.makeLut(luts);
    this.palTex = r.makePalette(palette(ch.colour.palette, ch.colour.table));
    if (ch.clahe?.on) this.updateClahe(params);
    return true;
  }

  /**
   * CLAHE maps (REQ-IMG-08): per-cell histograms of the displayed (stretched) values at the
   * statistics level, clipped at `clip` × the mean bin height with the excess spread evenly,
   * then equalised; one 256-entry map per cell and band, blended bilinearly in the shader.
   */
  async updateClahe(params = this.lutParams) {
    const ch = this.chain;
    const grid = Math.max(2, Math.min(32, Math.round(ch.clahe.grid ?? 8)));
    const clip = Math.max(1, ch.clahe.clip ?? 2.5);
    // Maps follow the chain but not every viewport-DRA refresh (that would re-read the image).
    const sig = JSON.stringify([grid, clip, ch.bands, ch.stretch, ch.dra.scope, ch.dra.pmin, ch.dra.pmax, ch.tone, ch.manual ?? null]);
    if (sig === this._claheSig) return;
    this._claheSig = sig;
    const luts = this._baseLuts;
    const nb = ch.bands.length === 3 ? 3 : 1;
    const out = new Uint8Array(256 * grid * grid * nb);
    for (let k = 0; k < nb; k++) {
      const { hist } = await this.app.pool.run('cellhist', { handle: this.handle, band: ch.bands[k], grid, scale: params[k].scale, offset: params[k].offset }, { affinity: this.affinity, label: `CLAHE ${this.rec?.name}` });
      if (sig !== this._claheSig) return; // superseded
      for (let c = 0; c < grid * grid; c++) {
        const h = new Float64Array(256);
        let n = 0;
        for (let j = 0; j < 4096; j++) {
          const v = hist[c * 4096 + j];
          if (!v) continue;
          h[luts[k][j * 16 + 8]] += v;
          n += v;
        }
        const map = out.subarray((k * grid * grid + c) * 256, (k * grid * grid + c + 1) * 256);
        if (!n) {
          for (let i = 0; i < 256; i++) map[i] = i;
          continue;
        }
        const lim = (clip * n) / 256;
        let excess = 0;
        for (let i = 0; i < 256; i++) if (h[i] > lim) {
          excess += h[i] - lim;
          h[i] = lim;
        }
        const add = excess / 256;
        let cdf = 0;
        for (let i = 0; i < 256; i++) {
          cdf += h[i] + add;
          map[i] = Math.max(0, Math.min(255, Math.round((255 * cdf) / n)));
        }
      }
    }
    const r = this.app.renderer;
    if (this.claheTex) r.freeTexture(this.claheTex);
    this.claheTex = r._tex(256, grid * grid * nb, 'r8', out);
    this.claheGrid = grid;
    this.claheMaps = out;
    r.invalidate();
    this.app.emit('state');
  }

  /** Lock DRA: freeze the histograms in use now. */
  lockDra(on) {
    if (on) {
      this.lockedHist = this.chain.bands.map((b, i) => (['viewport', 'aoi'].includes(this.chain.dra.scope) && this.viewHist?.[i]) || this.stats?.[b]);
    } else this.lockedHist = null;
  }

  /** Viewport or AOI DRA (REQ-IMG-30): histogram of the tiles under the box at the drawn level. */
  updateViewHist(L, bbox) {
    const ch = this.chain;
    if (ch.stretch !== 'dra' || !['viewport', 'aoi'].includes(ch.dra.scope) || ch.dra.lock || !this.stats) return;
    const now = performance.now();
    if (now - (this._vhT ?? 0) < 120) return;
    this._vhT = now;
    const arrays = this.tiles.cpuArrays(L, bbox);
    if (!arrays[0].length) return;
    this.viewHist = ch.bands.map((b, i) => histogramFromArrays(arrays[i], this.sampleType, this.nodata, this.stats[b], 4));
    this.viewHistSig = now;
  }

  onContextRestored() {
    this.claheTex = null;
    this._claheSig = '';
    this.lutTex = null;
    this.palTex = null;
    this._chainSig = '';
    this.tiles.gpu.clear();
    this.tiles.ready.length = 0;
    this.tiles.pending.clear();
  }

  // ---- geometry ----

  /** Image (x, y) → ground at height h (HAE). NaN when no model. */
  groundAt(x, y, h = this.defaultHeight()) {
    if (!this.modelId) return null;
    try {
      const g = this.app.core.i2g(this.modelId, x, y, h);
      if (!Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return null;
      return { lat: g.lat, lon: g.lon, h };
    } catch {
      return null;
    }
  }

  /** Ground → image. */
  imageAt(lat, lon, h = this.defaultHeight()) {
    if (!this.modelId) return null;
    try {
      const p = this.app.core.g2i(this.modelId, lat, lon, h);
      return Number.isFinite(p.x) ? p : null;
    } catch {
      return null;
    }
  }

  defaultHeight() {
    if (this.modelInfo?.is3d && Number.isFinite(this.info.heightOffset)) return this.info.heightOffset;
    return 0;
  }

  /** Ground point using the terrain when one covers the point (ray–DEM), else the default height. */
  groundWithTerrain(x, y) {
    const dem = this.app.terrain.demFor?.(this);
    if (dem && this.modelInfo?.is3d) {
      try {
        const r = this.app.core.rayDem(this.modelId, dem.coreId, x, y);
        const [lat, lon, h] = r.crossings[r.used];
        return { lat, lon, h, heightSource: dem.name, sigmaV: dem.sigmaV, crossings: r.crossings.length };
      } catch {
        /* fall through to the default height */
      }
    }
    const g = this.groundAt(x, y);
    if (!g) return null;
    if (!this.modelInfo?.is3d) {
      // 2-D models: report the DEM height at the point when one covers it.
      const d = this.app.terrain.sample?.(g.lat, g.lon);
      if (d && Number.isFinite(d.hae)) return { ...g, h: d.hae, heightSource: d.name, sigmaV: d.sigmaV };
    }
    return { ...g, heightSource: this.modelInfo?.is3d ? `default height ${g.h.toFixed(0)} m HAE` : 'none (2-D model)', sigmaV: NaN };
  }

  /** Footprint corners (lat, lon) through the model, for the map and overview. */
  footprint() {
    if (this.info.corners) return this.info.corners;
    if (!this.modelId) return null;
    const pts = [
      [0, 0],
      [this.width, 0],
      [this.width, this.height],
      [0, this.height],
    ].map(([x, y]) => this.groundAt(x, y));
    return pts.every(Boolean) ? pts.map((p) => [p.lat, p.lon]) : null;
  }

  chainSummary() {
    return this.chain ? chainSummary(this.chain) : '';
  }

  snapshotChain() {
    return clone(this.chain);
  }

  dispose() {
    this.tiles.dispose();
    if (this.modelId) this.app.core.freeModel(this.modelId);
    const r = this.app.renderer;
    r.freeTexture(this.lutTex);
    r.freeTexture(this.palTex);
    this.app.pool.run('close', { handle: this.handle }, { affinity: this.affinity }).catch(() => {});
  }
}
