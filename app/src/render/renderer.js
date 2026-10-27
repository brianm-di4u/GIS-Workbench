// The renderer: ONE WebGL2 context on one full-window canvas behind the chrome
// (REQ-IMG-01, D3). Each pane is a DOM rectangle drawn with viewport + scissor. Image layers
// are tile pyramids in native integer / float textures; the chain LUT and palette are small
// textures per layer. Context loss rebuilds everything from CPU state (REQ-ARC-22).

import { IMAGE_VS, imageFS, bandMathFS, FLAT_VS, FLAT_FS, TEX_VS, TEX_FS } from './shaders.js';
import { filterKernel } from './chain.js';
import { TILE, GUTTER } from './tiles.js';

const KERNEL = { nearest: 0, bilinear: 1, bicubic: 2, lanczos3: 3 };

const PS_VS = `#version 300 es
in vec2 a_unit;
void main() { gl_Position = vec4(a_unit * 2.0 - 1.0, 0.0, 1.0); }`;
const PS_FS = `#version 300 es
precision highp float;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_c;
uniform int u_method;
uniform vec2 u_vp0;
uniform vec2 u_vpSize;
uniform vec4 u_mean;
uniform vec4 u_std;
uniform vec2 u_pan;
out vec4 o;
void main() {
  vec2 uv = (gl_FragCoord.xy - u_vp0) / u_vpSize;
  vec4 A = texture(u_a, uv);
  vec4 B = texture(u_b, uv);
  float alpha = A.a * B.a;
  if (alpha <= 0.0) discard;
  vec3 ms = A.rgb / max(A.a, 1e-6);
  float pan = B.r / max(B.a, 1e-6);
  float nir = texture(u_c, uv).r / max(texture(u_c, uv).a, 1e-6);
  bool four = u_method == 2;
  float I = four ? (ms.r + ms.g + ms.b + nir) / 4.0 : (ms.r + ms.g + ms.b) / 3.0;
  float mI = four ? dot(u_mean, vec4(0.25)) : dot(u_mean.rgb, vec3(1.0 / 3.0));
  float sI = four ? sqrt(dot(u_std * u_std, vec4(0.25))) : sqrt(dot(u_std.rgb * u_std.rgb, vec3(1.0 / 3.0)));
  // Pan matched to the intensity's statistics.
  float P = (pan - u_pan.x) * sI / max(u_pan.y, 1e-6) + mI;
  vec3 rgb;
  if (u_method == 0) rgb = ms * P / max(I, 1e-3);
  else if (u_method == 3) rgb = ms + (u_std.rgb / max(sI, 1e-6)) * (P - I);
  else rgb = ms + vec3(P - I);
  o = vec4(clamp(rgb, 0.0, 1.0) * alpha, alpha);
}`;

// Stereo composite (REQ-STR-04/05, Research/07 §4): two eye targets (premultiplied) → one view.
// Modes: 0 Dubois, 1 true, 2 grey, 3 half-colour anaglyph; 4 side-by-side parallel, 5 cross-eyed,
// 6 over-under, 7 row-interleaved, 8 split screen (side-by-side with a divider), 9 spanned.
const ST_FS = `#version 300 es
precision highp float;
uniform sampler2D u_l;
uniform sampler2D u_r;
uniform int u_mode;
uniform int u_swap;
uniform int u_parity;
uniform int u_linear;
uniform vec2 u_vp0;
uniform vec2 u_vpSize;
uniform vec2 u_mirror;
out vec4 o;
vec3 lin(vec3 c) { return u_linear == 1 ? pow(c, vec3(2.2)) : c; }
vec3 enc(vec3 c) { return u_linear == 1 ? pow(max(c, 0.0), vec3(1.0 / 2.2)) : c; }
vec4 eye(sampler2D t, vec2 uv, float mirror) {
  if (mirror > 0.5) uv.x = 1.0 - uv.x;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec4 c = texture(t, uv);
  return vec4(c.rgb / max(c.a, 1e-6), c.a);
}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 p = gl_FragCoord.xy - u_vp0;
  vec2 uv = p / u_vpSize;
  bool sw = u_swap == 1;
  if (u_mode <= 3) {
    vec4 e0 = eye(u_l, uv, u_mirror.x);
    vec4 e1 = eye(u_r, uv, u_mirror.y);
    vec4 L = sw ? e1 : e0;
    vec4 R = sw ? e0 : e1;
    float a = max(L.a, R.a);
    if (a <= 0.0) discard;
    vec3 rgb;
    if (u_mode == 0) {
      vec3 l = lin(L.rgb), r = lin(R.rgb);
      mat3 ml = mat3(0.4561, -0.0400822, -0.0152161, 0.500484, -0.0378246, -0.0205971, 0.176381, -0.0157589, -0.00546856);
      mat3 mr = mat3(-0.0434706, 0.378476, -0.0721527, -0.0879388, 0.73364, -0.112961, -0.00155529, -0.0184503, 1.2264);
      rgb = enc(clamp(ml * l + mr * r, 0.0, 1.0));
    } else if (u_mode == 1) rgb = vec3(lum(L.rgb), 0.0, lum(R.rgb));
    else if (u_mode == 2) rgb = vec3(lum(L.rgb), lum(R.rgb), lum(R.rgb));
    else rgb = vec3(lum(L.rgb), R.g, R.b);
    o = vec4(rgb * a, a);
    return;
  }
  if (u_mode == 10) {
    // One eye only (dual output and WebXR per-eye views): the left target, or the right when swapped.
    vec4 c = sw ? eye(u_r, uv, u_mirror.y) : eye(u_l, uv, u_mirror.x);
    if (c.a <= 0.0) discard;
    o = vec4(c.rgb * c.a, c.a);
    return;
  }
  bool left;
  vec2 q = uv;
  if (u_mode == 6) {
    left = p.y >= u_vpSize.y * 0.5;
    q.y = left ? uv.y - 0.25 : uv.y + 0.25;
  } else if (u_mode == 7) {
    left = (int(floor(gl_FragCoord.y)) + u_parity) % 2 == 0;
  } else {
    left = p.x < u_vpSize.x * 0.5;
    if (u_mode == 5) left = !left;
    q.x = p.x < u_vpSize.x * 0.5 ? uv.x + 0.25 : uv.x - 0.25;
    if (u_mode == 8 && abs(p.x - u_vpSize.x * 0.5) < 1.0) { o = vec4(0.6, 0.6, 0.6, 1.0); return; }
  }
  if (sw) left = !left;
  vec4 c = left ? eye(u_l, q, u_mirror.x) : eye(u_r, q, u_mirror.y);
  if (c.a <= 0.0) discard;
  o = vec4(c.rgb * c.a, c.a);
}`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a_unit');
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.bindAttribLocation(p, 1, 'a_uv');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

/**
 * The view's 2 × 2 screen matrix z·R(θ)·L, row-major [m11, m12, m21, m22]. `view.lin` is an
 * optional linear display transform L of image pixels (SAR anamorphic squaring and the
 * slant-to-ground display, REQ-SAR-04); the centre (cx, cy) stays in image pixels.
 */
export function viewLinear(view) {
  const { zoom: z, rot = 0, lin } = view;
  const c = Math.cos(rot) * z;
  const s = Math.sin(rot) * z;
  if (!lin) return [c, -s, s, c];
  const [a, b, d, e] = lin;
  return [c * a - s * d, c * b - s * e, s * a + c * d, s * b + c * e];
}

export function viewMatrix(view, paneW, paneH) {
  // s = z·R(θ)·L·(p − c) + s0, column-major mat3.
  const { cx, cy } = view;
  const [m11, m12, m21, m22] = viewLinear(view);
  const tx = paneW / 2 - (m11 * cx + m12 * cy);
  const ty = paneH / 2 - (m21 * cx + m22 * cy);
  return new Float32Array([m11, m21, 0, m12, m22, 0, tx, ty, 1]);
}

/** Image-pixel displacement for a screen displacement (pans, roams). */
export function screenToImageDelta(view, dx, dy) {
  const [m11, m12, m21, m22] = viewLinear(view);
  const det = m11 * m22 - m12 * m21;
  return { x: (m22 * dx - m12 * dy) / det, y: (-m21 * dx + m11 * dy) / det };
}

/**
 * View matrix for a layer with a registration affine `a` = [a0..a5] (layer pixel → pane
 * reference pixel: x' = a0 + a1·x + a2·y, y' = a3 + a4·x + a5·y; REQ-SNS-09).
 */
export function alignedView(view, paneW, paneH, a) {
  const V = viewMatrix(view, paneW, paneH);
  if (!a) return V;
  // Column-major V·A with A = [[a1, a2, a0], [a4, a5, a3], [0, 0, 1]].
  const A = [a[1], a[4], 0, a[2], a[5], 0, a[0], a[3], 1];
  const out = new Float32Array(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 3 + r] = V[r] * A[c * 3] + V[3 + r] * A[c * 3 + 1] + V[6 + r] * A[c * 3 + 2];
  return out;
}

/** Inverse of a registration affine (pane reference pixel → layer pixel). */
export function invertAffine(a) {
  const det = a[1] * a[5] - a[2] * a[4];
  const i1 = a[5] / det;
  const i2 = -a[2] / det;
  const i4 = -a[4] / det;
  const i5 = a[1] / det;
  return [-(i1 * a[0] + i2 * a[3]), i1, i2, -(i4 * a[0] + i5 * a[3]), i4, i5];
}

export const applyAffine = (a, x, y) => ({ x: a[0] + a[1] * x + a[2] * y, y: a[3] + a[4] * x + a[5] * y });

/** Bounding box, in a registered layer's own pixels, of reference-pixel corners. */
export function alignedBox(a, corners) {
  const ia = invertAffine(a);
  const q = corners.map((c) => applyAffine(ia, c.x, c.y));
  return { x0: Math.min(...q.map((p) => p.x)), y0: Math.min(...q.map((p) => p.y)), x1: Math.max(...q.map((p) => p.x)), y1: Math.max(...q.map((p) => p.y)) };
}

export function invertView(view, paneW, paneH, sx, sy) {
  const d = screenToImageDelta(view, sx - paneW / 2, sy - paneH / 2);
  return { x: view.cx + d.x, y: view.cy + d.y };
}

export function forwardView(view, paneW, paneH, x, y) {
  const [m11, m12, m21, m22] = viewLinear(view);
  const dx = x - view.cx;
  const dy = y - view.cy;
  return { x: paneW / 2 + m11 * dx + m12 * dy, y: paneH / 2 + m21 * dx + m22 * dy };
}

export class Renderer {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.panes = new Set();
    this.dirty = true;
    this.lost = false;
    this.frame = 0;
    this.stats = { fps: 0, frameMs: 0, gpuBytes: 0, tiles: 0, uploads: 0 };
    this.gpuBudget = 384 << 20;
    this.uploadsPerFrame = 8;
    // The shared canvas follows the window; panels that only move still need a redraw (GUI-011).
    window.addEventListener('resize', () => this.invalidate());
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.app.emit('gl-lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
      for (const p of this.panes) p.onContextRestored?.();
      this.app.emit('gl-restored');
      this.invalidate();
    });
    this.init();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  init() {
    this.targets = []; // offscreen targets belong to the old context
    const gl = this.canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true, stencil: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.prog = { u: compile(gl, IMAGE_VS, imageFS('u')), i: compile(gl, IMAGE_VS, imageFS('i')), f: compile(gl, IMAGE_VS, imageFS('f')), flat: compile(gl, FLAT_VS, FLAT_FS), tex: compile(gl, TEX_VS, TEX_FS) };
    this.texBuf = gl.createBuffer();
    this.texVao = gl.createVertexArray();
    gl.bindVertexArray(this.texVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.flatBuf = gl.createBuffer();
    this.flatVao = gl.createVertexArray();
    gl.bindVertexArray(this.flatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    // A 1×1 dummy for unused band samplers of each kind.
    this.dummy = {
      u: this._tex(1, 1, 'u8', new Uint8Array(1)),
      i: this._tex(1, 1, 'i16', new Int16Array(1)),
      f: this._tex(1, 1, 'f32', new Float32Array(1)),
    };
    this.gpuBytes = 0;
    this.textures = new Set();
    this.progF = {}; // filtered variants, recompiled lazily after a context loss
  }

  _tex(w, h, type, data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = {
      u8: [gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE],
      u16: [gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT],
      i16: [gl.R16I, gl.RED_INTEGER, gl.SHORT],
      f32: [gl.R32F, gl.RED, gl.FLOAT],
      r8: [gl.R8, gl.RED, gl.UNSIGNED_BYTE],
      rgba8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE],
    }[type];
    gl.texImage2D(gl.TEXTURE_2D, 0, f[0], w, h, 0, f[1], f[2], data);
    return t;
  }

  /** Upload one tile band; returns {tex, bytes}. */
  uploadBand(w, h, type, data) {
    const t = this._tex(w, h, type, data);
    const bytes = w * h * ({ u8: 1, u16: 2, i16: 2, f32: 4 }[type] ?? 4);
    this.gpuBytes += bytes;
    return { tex: t, bytes };
  }

  freeTexture(t, bytes = 0) {
    if (!t || this.lost) return;
    this.gl.deleteTexture(t);
    this.gpuBytes -= bytes;
  }

  /** LUT texture (256 × 768 R8) from up to three 65 536-entry LUTs, and a palette (256×1 RGBA). */
  makeLut(luts) {
    const data = new Uint8Array(256 * 768);
    luts.forEach((l, k) => data.set(l, k * 65536));
    return this._tex(256, 768, 'r8', data);
  }

  makePalette(rgba) {
    return this._tex(256, 1, 'rgba8', rgba);
  }

  addPane(p) {
    this.panes.add(p);
    this.invalidate();
  }

  removePane(p) {
    this.panes.delete(p);
    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
  }

  _loop(t) {
    requestAnimationFrame(this._loop);
    const animating = [...this.panes].some((p) => p.animating?.());
    if (!this.dirty && !animating) return;
    this.dirty = false;
    this.render(t);
  }

  /** Draw every pane now. Called by the frame loop and by capture (whiteboard, chips). */
  render(t = performance.now()) {
    if (this.lost) return;
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(window.innerWidth * dpr);
    const H = Math.round(window.innerHeight * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const t0 = performance.now();
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.uploads = 0;
    for (const p of this.panes) {
      if (!p.el.isConnected || p.el.offsetParent === null) continue;
      const r = p.el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const x = Math.round(r.left * dpr);
      const y = Math.round(H - r.bottom * dpr);
      const w = Math.round(r.width * dpr);
      const h = Math.round(r.height * dpr);
      gl.viewport(x, y, w, h);
      gl.scissor(Math.max(0, x), Math.max(0, y), w, h);
      const bg = p.background ?? [0, 0, 0, 1];
      gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
      gl.clear(gl.COLOR_BUFFER_BIT);
      try {
        p.draw(this, { x, y, w, h, dpr, t });
      } catch (e) {
        console.error('pane draw failed', e);
      }
    }
    gl.disable(gl.SCISSOR_TEST);
    for (const f of this.afterRender ?? []) f(this);
    this.frame++;
    const dt = performance.now() - t0;
    this.stats.frameMs = this.stats.frameMs * 0.9 + dt * 0.1;
    this.stats.gpuBytes = this.gpuBytes;
    if (this.uploads >= this.uploadsPerFrame) this.dirty = true; // more uploads pending
  }

  canUpload() {
    return this.uploads < this.uploadsPerFrame;
  }

  noteUpload() {
    this.uploads++;
    this.stats.uploads++;
  }

  /** Draw one image layer's tiles into the current pane viewport. */
  /** The S6 (filtered) program for a sampler kind, compiled on first use. */
  filteredProgram(kind) {
    this.progF ??= {};
    return (this.progF[kind] ??= compile(this.gl, IMAGE_VS, imageFS(kind, true)));
  }

  /** The Band Math program of an expression, compiled on first use (REQ-MSI-04). */
  bandMathProgram(kind, bm) {
    this.progBM ??= new Map();
    const key = `${kind}|${bm.glsl}|${bm.bands.length}`;
    if (!this.progBM.has(key)) {
      if (this.progBM.size > 32) this.progBM.clear();
      this.progBM.set(key, compile(this.gl, IMAGE_VS, bandMathFS(kind, bm.glsl, bm.bands.length)));
    }
    return this.progBM.get(key);
  }

  drawBandMath(layer, tiles, view, paneW, paneH, opts = {}) {
    const gl = this.gl;
    const bm = layer.chain.bandMath;
    const kind = layer.texKind;
    const pr = this.bandMathProgram(kind, bm);
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix3fv(pr.u.u_view, false, alignedView(view, paneW, paneH, layer.align));
    gl.uniform2f(pr.u.u_pane, paneW, paneH);
    gl.uniform1i(pr.u.u_kernel, (layer.kernelEffective ?? layer.chain.kernel) === 'nearest' ? 0 : 1);
    const ls = layer.lutParams[0] ?? { scale: 1, offset: 0 };
    gl.uniform1f(pr.u.u_lutScale, ls.scale);
    gl.uniform1f(pr.u.u_lutOffset, ls.offset);
    const nd = layer.nodata;
    const hasNd = nd !== null && nd !== undefined && !Number.isNaN(nd);
    gl.uniform1f(pr.u.u_nodataV, hasNd ? nd : 0);
    gl.uniform1i(pr.u.u_hasNodata, hasNd ? 1 : 0);
    gl.uniform1i(pr.u.u_usePal, layer.chain.colour.palette !== 'grey' ? 1 : 0);
    gl.uniform1f(pr.u.u_opacity, opts.opacity ?? layer.opacity ?? 1);
    const r = layer.radiometryFor?.(bm.bands) ?? { gain: bm.bands.map(() => 1), offset: bm.bands.map(() => 0) };
    gl.uniform1fv(pr.u.u_bmGain, Float32Array.from({ length: 8 }, (_, i) => r.gain[i] ?? 1));
    gl.uniform1fv(pr.u.u_bmOff, Float32Array.from({ length: 8 }, (_, i) => r.offset[i] ?? 0));
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, layer.lutTex);
    gl.uniform1i(pr.u.u_lut, 8);
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D, layer.palTex);
    gl.uniform1i(pr.u.u_pal, 9);
    for (const t of tiles) {
      for (let k = 0; k < 8; k++) {
        gl.activeTexture(gl.TEXTURE0 + k);
        gl.bindTexture(gl.TEXTURE_2D, t.tex[k] ?? t.tex[0] ?? this.dummy[kind]);
        if (pr.u[`u_b${k}`]) gl.uniform1i(pr.u[`u_b${k}`], k);
      }
      const s = 2 ** t.level;
      gl.uniform2i(pr.u.u_size, t.w, t.h);
      gl.uniform2f(pr.u.u_origin, t.x0, t.y0);
      gl.uniform1f(pr.u.u_scale, s);
      const cx0 = (t.x0 + GUTTER) * s;
      const cy0 = (t.y0 + GUTTER) * s;
      const cw = Math.min((t.w - 2 * GUTTER) * s, layer.width - cx0);
      const ch = Math.min((t.h - 2 * GUTTER) * s, layer.height - cy0);
      gl.uniform4f(pr.u.u_rect, cx0, cy0, cw, ch);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
  }

  drawImageTiles(layer, tiles, view, paneW, paneH, opts = {}) {
    if (layer.chain.bandMath?.glsl) return this.drawBandMath(layer, tiles, view, paneW, paneH, opts);
    const gl = this.gl;
    const kind = layer.texKind;
    const fk = filterKernel(layer.chain);
    const pr = fk.mode ? this.filteredProgram(kind) : this.prog[kind];
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix3fv(pr.u.u_view, false, alignedView(view, paneW, paneH, layer.align));
    gl.uniform2f(pr.u.u_pane, paneW, paneH);
    const nb = layer.chain.bands.length === 3 ? 3 : 1;
    gl.uniform1i(pr.u.u_nb, nb);
    gl.uniform1i(pr.u.u_kernel, KERNEL[layer.kernelEffective ?? layer.chain.kernel] ?? 2);
    const ls = layer.lutParams;
    gl.uniform3f(pr.u.u_lutScale, ls[0].scale, ls[1]?.scale ?? 1, ls[2]?.scale ?? 1);
    gl.uniform3f(pr.u.u_lutOffset, ls[0].offset, ls[1]?.offset ?? 0, ls[2]?.offset ?? 0);
    const nd = layer.nodata;
    const hasNd = nd !== null && nd !== undefined && !Number.isNaN(nd) && layer.chain.voids;
    gl.uniform3f(pr.u.u_nodata, hasNd ? nd : 0, hasNd ? nd : 0, hasNd ? nd : 0);
    gl.uniform1i(pr.u.u_hasNodata, hasNd ? 1 : 0);
    gl.uniform1i(pr.u.u_usePal, nb === 1 && (layer.chain.colour.palette !== 'grey' || layer.chain.colour.table) ? 1 : 0);
    gl.uniform1f(pr.u.u_opacity, opts.opacity ?? layer.opacity ?? 1);
    gl.uniform1f(pr.u.u_saturation, (layer.chain.enabled.colour ? layer.chain.colour.saturation : 0) / 100 * (layer.chain.colour.saturation > 0 ? 2 : 1));
    gl.uniform1i(pr.u.u_filt, fk.mode);
    gl.uniform1i(pr.u.u_fr, fk.radius);
    gl.uniform1fv(pr.u.u_fk, fk.k);
    if (pr.u.u_sarL) gl.uniform1f(pr.u.u_sarL, fk.looks ?? 1);
    if (pr.u.u_sarK) gl.uniform1f(pr.u.u_sarK, fk.damping ?? 2);
    const dm = layer.chain.dem;
    gl.uniform1i(pr.u.u_dem, { hillshade: 1, slope: 2, aspect: 3, relief: 4 }[dm?.mode] ?? 0);
    const cell = layer.demCell?.() ?? [1, 1, 0];
    gl.uniform2f(pr.u.u_cell, cell[0], cell[1]);
    gl.uniform1f(pr.u.u_gridRot, cell[2]);
    gl.uniform3f(pr.u.u_sun, (((dm?.az ?? 315) - 0) * Math.PI) / 180, ((dm?.el ?? 45) * Math.PI) / 180, dm?.z ?? 1);
    gl.uniform1f(pr.u.u_contour, dm?.contour > 0 ? dm.contour : 0);
    const clip = layer.chain.clip;
    gl.uniform1i(pr.u.u_hasClip, clip?.on ? 1 : 0);
    gl.uniform2f(pr.u.u_clip, clip?.lo ?? 0, clip?.hi ?? 65535);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, layer.lutTex);
    gl.uniform1i(pr.u.u_lut, 3);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, layer.palTex);
    gl.uniform1i(pr.u.u_pal, 4);
    // CLAHE maps (filtered program only).
    const cl = layer.chain.clahe?.on && layer.claheTex ? layer.claheTex : null;
    if (pr.u.u_clahe !== undefined && pr.u.u_clahe !== null) {
      gl.uniform1i(pr.u.u_clahe, cl ? 1 : 0);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, cl ?? layer.lutTex);
      gl.uniform1i(pr.u.u_claheTex, 5);
      gl.uniform1i(pr.u.u_claheGrid, layer.claheGrid ?? 8);
      gl.uniform2f(pr.u.u_imgSize, layer.width, layer.height);
    }
    for (const t of tiles) {
      for (let k = 0; k < 3; k++) {
        gl.activeTexture(gl.TEXTURE0 + k);
        gl.bindTexture(gl.TEXTURE_2D, t.tex[k] ?? t.tex[0] ?? this.dummy[kind]);
        gl.uniform1i(pr.u[`u_b${k}`], k);
      }
      const s = 2 ** t.level;
      gl.uniform2i(pr.u.u_size, t.w, t.h);
      gl.uniform2f(pr.u.u_origin, t.x0, t.y0);
      gl.uniform1f(pr.u.u_scale, s);
      // Draw only the core (excluding the gutter) so tiles never overlap.
      const cx0 = (t.x0 + GUTTER) * s;
      const cy0 = (t.y0 + GUTTER) * s;
      const cw = Math.min((t.w - 2 * GUTTER) * s, layer.width - cx0);
      const ch = Math.min((t.h - 2 * GUTTER) * s, layer.height - cy0);
      gl.uniform4f(pr.u.u_rect, cx0, cy0, cw, ch);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
  }

  // ---- offscreen targets and pan-sharpening (REQ-IMG-10) ----

  /** Render into offscreen target i (an RGBA8 texture the size of the viewport). */
  beginTarget(i, w, h) {
    const gl = this.gl;
    this.targets ??= [];
    let t = this.targets[i];
    if (!t || t.w !== w || t.h !== h) {
      if (t) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fb);
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      t = this.targets[i] = { tex, fb, w, h };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, w, h);
    gl.scissor(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return t.tex;
  }

  /** Back to the screen, in the pane viewport vp = {x, y, w, h} (device px, GL origin). */
  endTarget(vp) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(vp.x, vp.y, vp.w, vp.h);
    gl.scissor(Math.max(0, vp.x), Math.max(0, vp.y), vp.w, vp.h);
  }

  /** RGBA of render target i (bottom row first), for the dual-output window (REQ-STR-06). */
  readTarget(i) {
    const gl = this.gl;
    const t = this.targets?.[i];
    if (!t) return null;
    const out = new Uint8Array(t.w * t.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { data: out, w: t.w, h: t.h };
  }

  /** Composite two eye targets (REQ-STR-04/05). opts: {mode, swap, parity, linear, mirror: [l, r]}. */
  drawStereo(tl, tr, opts, vp) {
    const gl = this.gl;
    this.prog.st ??= compile(gl, PS_VS, ST_FS);
    const pr = this.prog.st;
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.vao);
    [tl, tr].forEach((t, k) => {
      gl.activeTexture(gl.TEXTURE0 + k);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
    gl.uniform1i(pr.u.u_l, 0);
    gl.uniform1i(pr.u.u_r, 1);
    gl.uniform1i(pr.u.u_mode, opts.mode ?? 0);
    gl.uniform1i(pr.u.u_swap, opts.swap ? 1 : 0);
    gl.uniform1i(pr.u.u_parity, opts.parity ?? 0);
    gl.uniform1i(pr.u.u_linear, opts.linear === false ? 0 : 1);
    gl.uniform2f(pr.u.u_vp0, vp.x, vp.y);
    gl.uniform2f(pr.u.u_vpSize, vp.w, vp.h);
    gl.uniform2f(pr.u.u_mirror, opts.mirror?.[0] ? 1 : 0, opts.mirror?.[1] ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** Thick line segments [[x0, y0, x1, y1], …] in pane device px (y down) into the current target. */
  drawSegments(segs, color, width, paneW, paneH) {
    const v = new Float32Array(segs.length * 12);
    segs.forEach(([x0, y0, x1, y1], i) => {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * width * 0.5;
      const ny = (dx / len) * width * 0.5;
      v.set([x0 + nx, y0 + ny, x0 - nx, y0 - ny, x1 + nx, y1 + ny, x1 + nx, y1 + ny, x0 - nx, y0 - ny, x1 - nx, y1 - ny], i * 12);
    });
    this.drawFlat(v, this.gl.TRIANGLES, color, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), paneW, paneH);
  }

  /**
   * Composite pan-sharpening in screen space: a = MS RGB, b = pan (grey), c = MS NIR (grey).
   * method 0 Brovey, 1 fast IHS, 2 IHS-NIR, 3 Gram-Schmidt. s = display statistics
   * {mean: [R, G, B, N], std: [R, G, B, N], panMean, panStd}.
   */
  drawPanSharpen(a, b, c, method, s, vp) {
    const gl = this.gl;
    this.prog.ps ??= compile(gl, PS_VS, PS_FS);
    const pr = this.prog.ps;
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.vao);
    [a, b, c ?? b].forEach((t, k) => {
      gl.activeTexture(gl.TEXTURE0 + k);
      gl.bindTexture(gl.TEXTURE_2D, t);
    });
    gl.uniform1i(pr.u.u_a, 0);
    gl.uniform1i(pr.u.u_b, 1);
    gl.uniform1i(pr.u.u_c, 2);
    gl.uniform1i(pr.u.u_method, method);
    gl.uniform2f(pr.u.u_vp0, vp.x, vp.y);
    gl.uniform2f(pr.u.u_vpSize, vp.w, vp.h);
    gl.uniform4fv(pr.u.u_mean, s.mean);
    gl.uniform4fv(pr.u.u_std, s.std);
    gl.uniform2f(pr.u.u_pan, s.panMean, s.panStd);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  /** RGBA texture from an ImageBitmap (online tiles); linear filtering. */
  bitmapTexture(bmp) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    this.gpuBytes += bmp.width * bmp.height * 4;
    return t;
  }

  /** Textured triangles: verts = [x, y, u, v]·n (TRIANGLES) in world coordinates. */
  drawTextured(tex, verts, mat, paneW, paneH, opacity = 1) {
    const gl = this.gl;
    const pr = this.prog.tex;
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.texVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.uniformMatrix3fv(pr.u.u_view, false, mat);
    gl.uniform2f(pr.u.u_pane, paneW, paneH);
    gl.uniform1f(pr.u.u_opacity, opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(pr.u.u_tex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 4);
    gl.bindVertexArray(null);
  }

  /** Flat geometry in pane space: mode = gl.LINES / LINE_STRIP / TRIANGLES; matrix maps world → pane px. */
  drawFlat(verts, mode, color, mat, paneW, paneH) {
    const gl = this.gl;
    const pr = this.prog.flat;
    gl.useProgram(pr.p);
    gl.bindVertexArray(this.flatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.uniformMatrix3fv(pr.u.u_view, false, mat);
    gl.uniform2f(pr.u.u_pane, paneW, paneH);
    gl.uniform4fv(pr.u.u_color, color);
    gl.drawArrays(mode, 0, verts.length / 2);
    gl.bindVertexArray(null);
  }

  /**
   * Mark a disc (pane device px, y down) in the stencil buffer of the current viewport, for
   * the porthole (REQ-IMG-24). Later draws test against it with stencilFunc.
   */
  stencilDisc(cx, cy, r, paneW, paneH) {
    const gl = this.gl;
    const n = 64;
    const v = new Float32Array((n + 2) * 2);
    v[0] = cx;
    v[1] = cy;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      v[2 + i * 2] = cx + r * Math.cos(a);
      v[3 + i * 2] = cy + r * Math.sin(a);
    }
    gl.enable(gl.STENCIL_TEST);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    this.drawFlat(v, gl.TRIANGLE_FAN, [0, 0, 0, 1], new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), paneW, paneH);
    gl.colorMask(true, true, true, true);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  }

  /** Fill polygons (any winding, holes by even-odd) with the stencil buffer. */
  fillPolygons(rings, color, mat, paneW, paneH) {
    const gl = this.gl;
    gl.enable(gl.STENCIL_TEST);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    for (const r of rings) this.drawFlat(r, gl.TRIANGLE_FAN, color, mat, paneW, paneH);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    const big = new Float32Array([-1e7, -1e7, 1e7, -1e7, -1e7, 1e7, 1e7, 1e7]);
    this.drawFlat(big, gl.TRIANGLE_STRIP, color, new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), paneW, paneH);
    gl.disable(gl.STENCIL_TEST);
  }

  /**
   * Render now and read the whole canvas back (whiteboard capture, REQ-WB-04; chips).
   * Returns an ImageData-sized RGBA array in top-down order plus the CSS→device scale.
   */
  capture() {
    this.render();
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    // Un-premultiply.
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (a && a < 255) {
        out[i] = Math.min(255, (out[i] * 255) / a);
        out[i + 1] = Math.min(255, (out[i + 1] * 255) / a);
        out[i + 2] = Math.min(255, (out[i + 2] * 255) / a);
      }
    }
    return { width: w, height: h, data: out, dpr: w / window.innerWidth };
  }

  /** PT-08: lose and restore the context on demand (WEBGL_lose_context). */
  simulateContextLoss(ms = 200) {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext();
    setTimeout(() => ext.restoreContext(), ms);
    return true;
  }
}

export { TILE, GUTTER };
