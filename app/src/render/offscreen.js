// Offscreen rendering for chips and products (REQ-PRD-01/03): the same image passes as the
// screen (tiles, chain LUTs, filters, kernels), drawn into a framebuffer at any size in strips
// (≤ 4096 rows each, well under the 16 MP canvas limits), waiting for the tiles each strip
// needs. A ChipView stands in for a pane so graphics and measurements draw on products too.

import { levelFor } from './tiles.js';
import { invertView, forwardView, alignedBox, applyAffine, invertAffine } from './renderer.js';

const STRIP = 4096;

/** A pane-like view for products: a fixed view and size over a source pane's layers. */
export class ChipView {
  constructor(source, view, width, height, layers = null) {
    this.source = source;
    this.id = source.id;
    this.view = { ...view };
    this.width = width;
    this.height = height;
    this._layers = layers;
  }
  get rec() {
    return this.source.rec;
  }
  get app() {
    return this.source.app;
  }
  size() {
    return { w: this.width, h: this.height };
  }
  layers() {
    return this._layers ?? this.source.layers();
  }
  visibleLayers() {
    return this.layers().filter((l) => l.rec?.visible !== false);
  }
  activeLayer() {
    return this.source.activeLayer();
  }
  geoLayer() {
    return this.source.geoLayer();
  }
  imagePoint(sx, sy) {
    return invertView(this.view, this.width, this.height, sx, sy);
  }
  screenPoint(x, y) {
    return forwardView(this.view, this.width, this.height, x, y);
  }
  /** Metres per output pixel at the centre (geodesic, along x), on the horizontal plane at the
   * centre's terrain height (the scale a scale bar and a 1:n frame refer to). */
  groundScale(l = this.geoLayer()) {
    if (!l?.modelId) return NaN;
    const a = this.imagePoint(this.width / 2, this.height / 2);
    const b = this.imagePoint(this.width / 2 + 100, this.height / 2);
    const ga = l.groundWithTerrain?.(a.x, a.y) ?? l.groundAt(a.x, a.y);
    if (!ga) return NaN;
    let gb;
    try {
      gb = this.app.core.i2g(l.modelId, b.x, b.y, ga.h);
    } catch {
      gb = l.groundAt(b.x, b.y);
    }
    return gb && Number.isFinite(gb.lat) ? this.app.core.inverse(ga.lat, ga.lon, gb.lat, gb.lon).distance / 100 : NaN;
  }
}

/**
 * Render the imagery of a ChipView to RGBA (top-down rows). Waits (up to `timeoutMs`) for the
 * tiles of every strip. Returns ImageData-compatible {width, height, data}.
 */
export async function renderImagery(app, cv, { timeoutMs = 60000, background = [0, 0, 0, 1] } = {}) {
  const r = app.renderer;
  const gl = r.gl;
  const W = cv.width;
  const H = cv.height;
  const max = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  if (W > max) throw new Error(`chips wider than ${max} px need several frames (requested ${W} px)`);
  const out = new Uint8ClampedArray(W * H * 4);
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  const rb = gl.createRenderbuffer();
  const t0 = performance.now();
  try {
    for (let y0 = 0; y0 < H; y0 += STRIP) {
      const sh = Math.min(STRIP, H - y0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, sh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, W, sh);
      // The strip's own view: same zoom and rotation, centred on the strip's centre.
      const c = invertView(cv.view, W, H, W / 2, y0 + sh / 2);
      const view = { ...cv.view, cx: c.x, cy: c.y };
      const corners = [
        [0, 0],
        [W, 0],
        [0, sh],
        [W, sh],
      ].map(([x, y]) => invertView(view, W, sh, x, y));
      const bbox = { x0: Math.min(...corners.map((q) => q.x)), y0: Math.min(...corners.map((q) => q.y)), x1: Math.max(...corners.map((q) => q.x)), y1: Math.max(...corners.map((q) => q.y)) };
      for (;;) {
        let loading = 0;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
        gl.viewport(0, 0, W, sh);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, W, sh);
        gl.clearColor(...background);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        for (const l of cv.visibleLayers()) {
          if (!l.stats || !l.lutTex) {
            loading++;
            continue;
          }
          const L = levelFor(view.zoom, l.levels);
          // Upload everything this strip needs, not just a frame's worth.
          const saved = r.uploadsPerFrame;
          r.uploadsPerFrame = 1e9;
          const lb = l.align ? alignedBox(l.align, corners) : bbox;
          const lc = l.align ? applyAffine(invertAffine(l.align), view.cx, view.cy) : { x: view.cx, y: view.cy };
          const tiles = l.tiles.plan(L, lb, lc);
          r.uploadsPerFrame = saved;
          loading += l.tiles.loading;
          if (tiles.length) r.drawImageTiles(l, tiles, view, W, sh);
        }
        gl.disable(gl.SCISSOR_TEST);
        const done = !loading || performance.now() - t0 > timeoutMs;
        if (done) {
          // GL rows are bottom-up.
          const px = new Uint8Array(W * sh * 4);
          gl.readPixels(0, 0, W, sh, gl.RGBA, gl.UNSIGNED_BYTE, px);
          for (let y = 0; y < sh; y++) out.set(px.subarray((sh - 1 - y) * W * 4, (sh - y) * W * 4), (y0 + y) * W * 4);
          break;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        await new Promise((res) => setTimeout(res, 30));
      }
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
    gl.deleteRenderbuffer(rb);
    r.invalidate();
  }
  // Un-premultiply (the image passes write premultiplied colour).
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a && a < 255) {
      out[i] = Math.min(255, (out[i] * 255) / a);
      out[i + 1] = Math.min(255, (out[i + 1] * 255) / a);
      out[i + 2] = Math.min(255, (out[i + 2] * 255) / a);
    }
  }
  return { width: W, height: H, data: out };
}
