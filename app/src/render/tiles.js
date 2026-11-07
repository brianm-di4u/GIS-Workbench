// Main-thread tile management for one image layer (REQ-IMG-03): level choice, visible tile
// set, request queue to the decode worker, GPU texture LRU and the CPU copies used for the
// viewport-scope DRA histogram. Coarser tiles stand in while finer ones load.

export const TILE = 512;
export const GUTTER = 4;

export function levelFor(zoom, levels) {
  // Never sample coarser than the screen: L = floor(log2(1/z)).
  const L = Math.floor(Math.log2(1 / Math.max(zoom, 1e-9)) + 1e-9);
  return Math.max(0, Math.min(levels - 1, L));
}

export function visibleTiles(layer, L, bbox) {
  const s = 2 ** L;
  const lw = Math.ceil(layer.width / s);
  const lh = Math.ceil(layer.height / s);
  const nx = Math.ceil(lw / TILE);
  const ny = Math.ceil(lh / TILE);
  const x0 = Math.max(0, Math.floor(bbox.x0 / s / TILE));
  const y0 = Math.max(0, Math.floor(bbox.y0 / s / TILE));
  const x1 = Math.min(nx - 1, Math.floor(bbox.x1 / s / TILE));
  const y1 = Math.min(ny - 1, Math.floor(bbox.y1 / s / TILE));
  const out = [];
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push([tx, ty]);
  return out;
}

export class TileSet {
  constructor(layer, renderer, fetchTile) {
    this.layer = layer;
    this.r = renderer;
    this.fetch = fetchTile; // (L, tx, ty, bands) → Promise<{w,h,x0,y0,bands}>
    this.gpu = new Map(); // key → {tex[], w, h, x0, y0, level, bytes, used}
    this.pending = new Map();
    this.failed = new Map();
    this.ready = []; // decoded tiles waiting for upload
    this.bandsKey = '';
  }

  /** Tile key; a MIE4NITF sequence layer (layer.frame set, REQ-GAP-47) keys tiles by frame too. */
  key(L, tx, ty, f = this.layer.frame) {
    return f === null || f === undefined ? `${L}/${tx}/${ty}` : `${f}:${L}/${tx}/${ty}`;
  }

  /** [L, tx, ty] of the tiles held or loading for frame f (read-ahead copies them to the next frames). */
  frameTiles(f = this.layer.frame) {
    const pre = f === null || f === undefined ? null : `${f}:`;
    const out = [];
    for (const k of [...this.gpu.keys(), ...this.pending.keys()]) {
      if (pre ? !k.startsWith(pre) : k.includes(':')) continue;
      const [L, tx, ty] = (pre ? k.slice(pre.length) : k).split('/').map(Number);
      out.push([L, tx, ty]);
    }
    return out;
  }

  /** Free the GPU tiles of frames `keep(f)` rejects (a sequence keeps only the frames around the shown one). */
  dropFrames(keep) {
    for (const [k, t] of this.gpu) {
      const i = k.indexOf(':');
      if (i < 0) continue;
      if (keep(Number(k.slice(0, i)))) continue;
      for (const x of t.tex) this.r.freeTexture(x, t.bytesPer);
      this.gpu.delete(k);
    }
  }

  /** Throw everything away (band selection changed or context restored). */
  reset({ keepCpu = false } = {}) {
    for (const t of this.gpu.values()) for (let k = 0; k < t.tex.length; k++) this.r.freeTexture(t.tex[k], t.bytesPer);
    this.gpu.clear();
    if (!keepCpu) {
      this.ready.length = 0;
      this.pending.clear();
    }
    this.failed.clear();
  }

  /**
   * Tiles to draw for the pane's view: the visible set at level L, falling back to the best
   * loaded ancestor. Requests missing tiles (nearest the centre first).
   */
  plan(L, bbox, centre) {
    // Band math reads the bands its expression references (REQ-MSI-04).
    const bands = this.layer.chain.bandMath?.bands ?? this.layer.chain.bands;
    const bk = bands.join(',');
    if (bk !== this.bandsKey) {
      this.reset();
      this.bandsKey = bk;
    }
    this._uploadReady();
    // A frame change: the previous frame's tiles stand in until the new frame's arrive.
    const frame = this.layer.frame;
    if (frame !== this.frameNow) {
      if (this.frameNow !== undefined) this.framePrev = this.frameNow;
      this.frameNow = frame;
    }
    const prev = frame === null || frame === undefined ? undefined : this.framePrev;
    const want = visibleTiles(this.layer, L, bbox);
    const draw = new Map();
    const missing = [];
    const now = performance.now();
    for (const [tx, ty] of want) {
      const k = this.key(L, tx, ty);
      const t = this.gpu.get(k);
      if (t) {
        t.used = now;
        draw.set(k, t);
        continue;
      }
      missing.push([tx, ty]);
      if (prev !== undefined) {
        const pt = this.gpu.get(this.key(L, tx, ty, prev));
        if (pt) {
          pt.used = now;
          draw.set(this.key(L, tx, ty, prev), pt);
          continue;
        }
      }
      // Ancestor fallback.
      for (const f of prev === undefined ? [frame] : [frame, prev]) {
        let found = false;
        for (let a = L + 1; a < this.layer.levels; a++) {
          const d = 2 ** (a - L);
          const ak = this.key(a, Math.floor(tx / d), Math.floor(ty / d), f);
          const at = this.gpu.get(ak);
          if (at) {
            at.used = now;
            draw.set(ak, at);
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
    // Request missing tiles, nearest the centre first.
    const s = 2 ** L;
    missing.sort((a, b) => Math.hypot((a[0] + 0.5) * TILE * s - centre.x, (a[1] + 0.5) * TILE * s - centre.y) - Math.hypot((b[0] + 0.5) * TILE * s - centre.x, (b[1] + 0.5) * TILE * s - centre.y));
    for (const [tx, ty] of missing) this.request(L, tx, ty, bands);
    // Ensure the coarsest level exists as a backstop.
    const top = this.layer.levels - 1;
    if (!this.gpu.has(this.key(top, 0, 0))) this.request(top, 0, 0, bands);
    // Coarse first so finer tiles paint over them.
    return [...draw.values()].sort((a, b) => b.level - a.level);
  }

  request(L, tx, ty, bands, frame = this.layer.frame, priority = 'interactive') {
    const k = this.key(L, tx, ty, frame);
    if (this.pending.has(k) || this.gpu.has(k)) return;
    const f = this.failed.get(k);
    if (f && performance.now() - f < 10000) return;
    const bk = bands.join(',');
    const p = this.fetch(L, tx, ty, bands, frame, priority)
      .then((t) => {
        this.pending.delete(k);
        if (bk !== this.bandsKey) return;
        this.ready.push({ k, L, t });
        this.r.invalidate();
        this.layer.onTile?.(L, t);
      })
      .catch((e) => {
        this.pending.delete(k);
        this.failed.set(k, performance.now());
        if (!e.cancelled) this.layer.onTileError?.(e);
      });
    this.pending.set(k, p);
  }

  _uploadReady() {
    while (this.ready.length && this.r.canUpload()) {
      const { k, L, t } = this.ready.shift();
      if (this.gpu.has(k)) continue;
      const type = this.layer.sampleType;
      const tex = [];
      let bytes = 0;
      let per = 0;
      for (const b of t.bands) {
        const u = this.r.uploadBand(t.w, t.h, type, b);
        tex.push(u.tex);
        bytes += u.bytes;
        per = u.bytes;
      }
      this.r.noteUpload();
      this.gpu.set(k, { tex, w: t.w, h: t.h, x0: t.x0, y0: t.y0, level: L, bytes, bytesPer: per, used: performance.now(), cpu: t.bands });
    }
    this._evict();
  }

  _evict() {
    if (this.r.gpuBytes <= this.r.gpuBudget) return;
    const all = [...this.gpu.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, t] of all) {
      if (this.r.gpuBytes <= this.r.gpuBudget * 0.85) break;
      if (t.level === this.layer.levels - 1) continue;
      for (const x of t.tex) this.r.freeTexture(x, t.bytesPer);
      this.gpu.delete(k);
    }
  }

  /** CPU arrays of the drawn tiles at level L (viewport DRA). */
  cpuArrays(L, bbox) {
    const out = [[], [], []];
    for (const [tx, ty] of visibleTiles(this.layer, L, bbox)) {
      const t = this.gpu.get(this.key(L, tx, ty));
      if (!t?.cpu) continue;
      t.cpu.forEach((b, i) => out[i].push(b));
    }
    return out;
  }

  get loading() {
    return this.pending.size + this.ready.length;
  }

  dispose() {
    this.reset();
  }
}
