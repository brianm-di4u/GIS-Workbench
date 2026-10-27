// Tile pyramid inside the decode worker (REQ-IMG-03). Core tiles are TILE² per band and
// level; level L+1 is a 2×2 average of level L (no-data aware) unless the source has native
// overviews. Emitted tiles add a GUTTER-pixel border taken from neighbouring cores so the
// display kernels (bicubic, Lanczos-3) read across seams.

export const TILE = 512;
export const GUTTER = 4;

const CTOR = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array };

export function ctorFor(t) {
  return CTOR[t] ?? Float32Array;
}

export class LRU {
  constructor(maxBytes) {
    this.max = maxBytes;
    this.bytes = 0;
    this.map = new Map();
  }
  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k, v, size) {
    if (this.map.has(k)) this.delete(k);
    this.map.set(k, v);
    v.__size = size;
    this.bytes += size;
    while (this.bytes > this.max && this.map.size > 1) {
      const [ok, ov] = this.map.entries().next().value;
      this.map.delete(ok);
      this.bytes -= ov.__size ?? 0;
    }
  }
  delete(k) {
    const v = this.map.get(k);
    if (v) {
      this.bytes -= v.__size ?? 0;
      this.map.delete(k);
    }
  }
}

/**
 * source: {width, height, sampleType, nodata (number|NaN|null), bands,
 *          readWindow(x, y, w, h, bands) → Promise<TypedArray[]>   (full resolution),
 *          readLevel?(L, x, y, w, h, bands) → Promise<TypedArray[]> (native overviews),
 *          hasLevel?(L) → bool}
 */
export class Pyramid {
  constructor(source, cache) {
    this.src = source;
    this.cache = cache;
    this.key = Math.random().toString(36).slice(2);
    this.levels = 1;
    while ((Math.max(source.width, source.height) >> (this.levels - 1)) > TILE) this.levels++;
    this.inflight = new Map();
  }

  dims(L) {
    return { w: Math.max(1, Math.ceil(this.src.width / 2 ** L)), h: Math.max(1, Math.ceil(this.src.height / 2 ** L)) };
  }

  tilesAt(L) {
    const { w, h } = this.dims(L);
    return { nx: Math.ceil(w / TILE), ny: Math.ceil(h / TILE) };
  }

  /** Core tile (TILE² or smaller at the image edge) for one band. */
  async core(L, tx, ty, band, job) {
    const k = `${this.key}/${L}/${tx}/${ty}/${band}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    if (this.inflight.has(k)) return this.inflight.get(k);
    const p = this._core(L, tx, ty, band, job).then((t) => {
      this.cache.set(k, t, t.data.byteLength);
      this.inflight.delete(k);
      return t;
    }, (e) => {
      this.inflight.delete(k);
      throw e;
    });
    this.inflight.set(k, p);
    return p;
  }

  async _core(L, tx, ty, band, job) {
    const { w: lw, h: lh } = this.dims(L);
    const x0 = tx * TILE;
    const y0 = ty * TILE;
    const w = Math.min(TILE, lw - x0);
    const h = Math.min(TILE, lh - y0);
    if (w <= 0 || h <= 0) throw new Error('tile outside the image');
    if (L === 0) {
      const [data] = await this.src.readWindow(x0, y0, w, h, [band], job);
      return { w, h, data };
    }
    if (this.src.readLevel && this.src.hasLevel?.(L)) {
      const [data] = await this.src.readLevel(L, x0, y0, w, h, [band], job);
      return { w, h, data };
    }
    // Compose from the four children at L-1.
    const C = ctorFor(this.src.sampleType);
    const out = new C(w * h);
    const sum = new Float64Array(w * h);
    const cnt = new Uint16Array(w * h);
    const nd = this.src.nodata;
    const isNd = nd === null || nd === undefined ? () => false : Number.isNaN(nd) ? (v) => Number.isNaN(v) : (v) => v === nd;
    const { nx, ny } = this.tilesAt(L - 1);
    // Bands that must not be averaged (SAR phase, I, Q) are decimated: one child sample each.
    const pick = !!this.src.pickBands?.includes(band);
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 2; cx++) {
        const ctx = 2 * tx + cx;
        const cty = 2 * ty + cy;
        if (ctx >= nx || cty >= ny) continue;
        job?.checkCancel?.();
        const c = await this.core(L - 1, ctx, cty, band, job);
        const ox = cx * (TILE / 2);
        const oy = cy * (TILE / 2);
        for (let y = 0; y < c.h; y++) {
          const yy = oy + (y >> 1);
          if (yy >= h) continue;
          for (let x = 0; x < c.w; x++) {
            const xx = ox + (x >> 1);
            if (xx >= w) continue;
            if (pick && ((x | y) & 1)) continue;
            const v = c.data[y * c.w + x];
            if (isNd(v)) continue;
            const i = yy * w + xx;
            sum[i] += v;
            cnt[i]++;
          }
        }
      }
    }
    const fill = nd === null || nd === undefined ? 0 : nd;
    const round = C === Float32Array ? (v) => v : (v) => Math.round(v);
    for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? round(sum[i] / cnt[i]) : fill;
    return { w, h, data: out };
  }

  /**
   * Emitted tile: (TILE + 2·GUTTER)² per band with the border from neighbours (edges
   * replicated at the image boundary). Returns {w, h, x0, y0, bands:[TypedArray]} where
   * w/h include the gutter and x0/y0 are the level coordinates of element (0, 0).
   */
  async tile(L, tx, ty, bands, job) {
    const { w: lw, h: lh } = this.dims(L);
    const { nx, ny } = this.tilesAt(L);
    const cw = Math.min(TILE, lw - tx * TILE);
    const ch = Math.min(TILE, lh - ty * TILE);
    const W = cw + 2 * GUTTER;
    const H = ch + 2 * GUTTER;
    const C = ctorFor(this.src.sampleType);
    const out = [];
    for (const band of bands) {
      const arr = new C(W * H);
      // Gather the 3×3 neighbourhood of cores that the gutter touches.
      const cores = new Map();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const cx = tx + dx;
          const cy = ty + dy;
          if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) continue;
          cores.set(`${dx},${dy}`, await this.core(L, cx, cy, band, job));
        }
      }
      const gx0 = tx * TILE - GUTTER;
      const gy0 = ty * TILE - GUTTER;
      for (let y = 0; y < H; y++) {
        const ly = Math.min(lh - 1, Math.max(0, gy0 + y));
        const cy = Math.floor(ly / TILE) - ty;
        const iy = ly - (ty + cy) * TILE;
        for (let x = 0; x < W; x++) {
          const lx = Math.min(lw - 1, Math.max(0, gx0 + x));
          const cx = Math.floor(lx / TILE) - tx;
          const c = cores.get(`${cx},${cy}`);
          const ix = lx - (tx + cx) * TILE;
          arr[y * W + x] = c ? c.data[iy * c.w + ix] : 0;
        }
      }
      out.push(arr);
    }
    return { w: W, h: H, x0: tx * TILE - GUTTER, y0: ty * TILE - GUTTER, bands: out };
  }

  /** Histogram per band from the level nearest 1024² (full-image DRA scope). */
  /**
   * Histograms of a grid × grid partition of the image at the statistics level (CLAHE maps,
   * REQ-IMG-08), in 4096 bins of the LUT index domain (index = DN·scale + offset, 0 … 65535).
   */
  async cellHist(band, grid, scale, offset, job) {
    let L = 0;
    while (L < this.levels - 1 && Math.max(this.dims(L).w, this.dims(L).h) > 1024) L++;
    const { w: W, h: H } = this.dims(L);
    const { nx, ny } = this.tilesAt(L);
    const hist = new Uint32Array(grid * grid * 4096);
    const nd = this.src.nodata;
    for (let ty = 0; ty < ny; ty++)
      for (let tx = 0; tx < nx; tx++) {
        const t = await this.core(L, tx, ty, band, job);
        for (let y = 0; y < t.h; y++) {
          const gy = Math.min(grid - 1, Math.floor(((ty * TILE + y) * grid) / H));
          for (let x = 0; x < t.w; x++) {
            const v = t.data[y * t.w + x];
            if (Number.isNaN(v) || (nd !== null && nd !== undefined && v === nd)) continue;
            const gx = Math.min(grid - 1, Math.floor(((tx * TILE + x) * grid) / W));
            const i = Math.max(0, Math.min(65535, Math.floor(v * scale + offset + 0.5)));
            hist[(gy * grid + gx) * 4096 + (i >> 4)]++;
          }
        }
      }
    return { grid, hist };
  }

  async stats(bands, job) {
    let L = 0;
    while (L < this.levels - 1 && Math.max(this.dims(L).w, this.dims(L).h) > 1024) L++;
    const { nx, ny } = this.tilesAt(L);
    const res = [];
    for (const band of bands) {
      const datas = [];
      for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) datas.push((await this.core(L, tx, ty, band, job)).data);
      res.push(histogram(datas, this.src.sampleType, this.src.nodata));
      job?.progress?.(res.length / bands.length);
    }
    return { level: L, bands: res };
  }
}

/** Histogram of typed arrays: 256 bins (u8), 65 536 (u16/i16) or 4096 over [min, max] (float). */
export function histogram(datas, type, nodata) {
  const isNd = nodata === null || nodata === undefined ? (v) => Number.isNaN(v) : Number.isNaN(nodata) ? (v) => Number.isNaN(v) : (v) => v === nodata || Number.isNaN(v);
  if (type === 'u8' || type === 'u16' || type === 'i16') {
    const n = type === 'u8' ? 256 : 65536;
    const off = type === 'i16' ? 32768 : 0;
    const bins = new Uint32Array(n);
    let count = 0;
    for (const d of datas)
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        if (isNd(v)) continue;
        bins[v + off]++;
        count++;
      }
    return { bins, offset: off, min: -off, binWidth: 1, count, type };
  }
  let mn = Infinity;
  let mx = -Infinity;
  for (const d of datas)
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (isNd(v) || !Number.isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  if (!Number.isFinite(mn)) {
    mn = 0;
    mx = 1;
  }
  if (mx === mn) mx = mn + 1;
  const n = 4096;
  const bw = (mx - mn) / n;
  const bins = new Uint32Array(n);
  let count = 0;
  for (const d of datas)
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (isNd(v) || !Number.isFinite(v)) continue;
      bins[Math.min(n - 1, Math.floor((v - mn) / bw))]++;
      count++;
    }
  return { bins, offset: 0, min: mn, max: mx, binWidth: bw, count, type };
}
