// 3D pane (D18; REQ-LDR-04..07, REQ-STR-11 base): three.js, lazily loaded, in the local frame
// (DN-36: east, north metres from the cloud origin; up = HAE). Point clouds render through their
// LOD tiles with a point budget shared by screen size, adaptive point size and eye-dome lighting;
// colour by elevation, intensity, class, RGB, return, source, GPS time or height above ground;
// per-class visibility; elevation shaving against a plane or the ground. Picking is on the CPU
// over the drawn points.

import { h } from '../shell/dom.js';
import { gltfLoader, refuseUndecodable } from './gltf-ext.js';
import { Tileset } from './tiles3d.js';
import { encodeCanvasWebM } from '../media/webm.js';

/** ASPRS LAS 1.4 standard classes: [name, colour]. */
export const CLASSES = {
  0: ['Created, never classified', '#9a9a9a'],
  1: ['Unclassified', '#c8c8c8'],
  2: ['Ground', '#a0703c'],
  3: ['Low vegetation', '#9ccc65'],
  4: ['Medium vegetation', '#43a047'],
  5: ['High vegetation', '#1b5e20'],
  6: ['Building', '#e65100'],
  7: ['Low point (noise)', '#d500f9'],
  8: ['Reserved / model key', '#ffd54f'],
  9: ['Water', '#1e88e5'],
  10: ['Rail', '#795548'],
  11: ['Road surface', '#424242'],
  12: ['Overlap / reserved', '#fff176'],
  13: ['Wire – guard', '#80deea'],
  14: ['Wire – conductor', '#4dd0e1'],
  15: ['Transmission tower', '#ff7043'],
  16: ['Wire-structure connector', '#ba68c8'],
  17: ['Bridge deck', '#8d6e63'],
  18: ['High noise', '#ff4081'],
};

export const COLOUR_MODES = ['elevation', 'intensity', 'class', 'rgb', 'return', 'source', 'time', 'hag'];

const VS = /* glsl */ `
in float intensity;
in float classification;
in float ret;
in vec3 rgb;
in float gpsTime;
in float source;
in float hag;
uniform int uMode;
uniform vec2 uZRange;
uniform vec2 uIRange;
uniform vec2 uTRange;
uniform vec2 uHagRange;
uniform float uRgbScale;
uniform sampler2D uPalette;
uniform sampler2D uRamp;
uniform float uSize;
uniform float uScale;
uniform float uSpacing;
uniform vec3 uShave;      // mode (0 off, 1 keep below, 2 keep above), level, against (0 plane z, 1 height above ground)
uniform vec4 uHighlight;  // xyz, radius (m)
out vec3 vColor;
vec3 ramp(float t) { return texture(uRamp, vec2(clamp(t, 0.0, 1.0), 0.5)).rgb; }
void main() {
  vec4 pal = texelFetch(uPalette, ivec2(int(classification + 0.5), 0), 0);
  float sv = uShave.z > 0.5 ? hag : position.z;
  bool hidden = pal.a < 0.5 || (uShave.x > 0.5 && uShave.x < 1.5 && sv > uShave.y) || (uShave.x > 1.5 && sv < uShave.y);
  if (hidden) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 c;
  if (uMode == 0) c = ramp((position.z - uZRange.x) / max(uZRange.y - uZRange.x, 1e-3));
  else if (uMode == 1) { float g = clamp((intensity * 65535.0 - uIRange.x) / max(uIRange.y - uIRange.x, 1.0), 0.0, 1.0); c = vec3(g); }
  else if (uMode == 2) c = pal.rgb;
  else if (uMode == 3) c = clamp(rgb * uRgbScale, 0.0, 1.0);
  else if (uMode == 4) {
    float rn = mod(ret, 16.0); float nr = floor(ret / 16.0);
    c = nr <= 1.0 ? vec3(0.95, 0.85, 0.3) : rn <= 1.0 ? vec3(0.9, 0.25, 0.2) : rn >= nr ? vec3(0.2, 0.45, 0.95) : vec3(0.3, 0.8, 0.35);
  } else if (uMode == 5) { float s = fract(sin(source * 12.9898) * 43758.5453); c = ramp(s); }
  else if (uMode == 6) c = ramp((gpsTime - uTRange.x) / max(uTRange.y - uTRange.x, 1e-6));
  else c = ramp((hag - uHagRange.x) / max(uHagRange.y - uHagRange.x, 1e-3));
  if (uHighlight.w > 0.0 && distance(position, uHighlight.xyz) < uHighlight.w) c = vec3(1.0, 1.0, 0.0);
  vColor = c;
  gl_PointSize = clamp(uSize * uSpacing * uScale / max(-mv.z, 1e-3), 1.0, 14.0);
}`;

const FS = /* glsl */ `
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  outColor = vec4(vColor, 1.0);
}`;

const EDL_VS = /* glsl */ `
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const EDL_FS = /* glsl */ `
in vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uStrength;
uniform float uRadius;
uniform vec3 uBg;
uniform bool uEdl;
out vec4 outColor;
float logDepth(vec2 uv) {
  float d = texture(tDepth, uv).r;
  if (d >= 1.0) return 0.0;
  float z = (uNear * uFar) / (uFar - d * (uFar - uNear));
  return log2(z);
}
void main() {
  float d0 = texture(tDepth, vUv).r;
  if (d0 >= 1.0) { outColor = vec4(uBg, 1.0); return; }
  vec3 col = texture(tColor, vUv).rgb;
  if (!uEdl) { outColor = vec4(col, 1.0); return; }
  float l0 = logDepth(vUv);
  float sum = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853981634;
    vec2 o = vec2(cos(a), sin(a)) * uRadius * uTexel;
    float ln = logDepth(vUv + o);
    if (ln > 0.0) sum += max(0.0, l0 - ln); // gaps to the background do not darken
  }
  float shade = exp(-(sum / 8.0) * 300.0 * uStrength);
  outColor = vec4(col * shade, 1.0);
}`;

function rampTexture(T) {
  const stops = [
    [0, [0.17, 0.26, 0.6]],
    [0.25, [0.13, 0.6, 0.73]],
    [0.45, [0.3, 0.72, 0.3]],
    [0.65, [0.93, 0.85, 0.3]],
    [0.85, [0.85, 0.35, 0.18]],
    [1, [0.98, 0.95, 0.95]],
  ];
  const d = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    for (let a = 0; a < 3; a++) d[4 * i + a] = Math.round(255 * (c0[a] + (c1[a] - c0[a]) * f));
    d[4 * i + 3] = 255;
  }
  const tx = new T.DataTexture(d, 256, 1, T.RGBAFormat);
  tx.magFilter = T.LinearFilter;
  tx.minFilter = T.LinearFilter;
  tx.needsUpdate = true;
  return tx;
}

const hex3 = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));

/** Metres per degree of longitude and latitude on WGS 84 (the local frame, DN-36). */
export function frameAt(lat) {
  const a = 6378137;
  const e2 = 0.0066943799901413165;
  const s = Math.sin((lat * Math.PI) / 180);
  const w = 1 - e2 * s * s;
  return { kx: ((a / Math.sqrt(w)) * Math.cos((lat * Math.PI) / 180) * Math.PI) / 180, ky: (((a * (1 - e2)) / (w * Math.sqrt(w))) * Math.PI) / 180 };
}

export class View3D {
  /** Load three.js and make the view inside `pane`. */
  static async create(app, pane) {
    const T = await app.gw.runScript('js-three');
    if (!T) throw new Error('the 3D library block did not load');
    return new View3D(app, pane, T);
  }

  constructor(app, pane, T) {
    this.app = app;
    this.pane = pane;
    this.T = T;
    this.canvas = h('canvas', { class: 'pane-3d', tabindex: '0', 'aria-label': '3D view' });
    pane.el.prepend(this.canvas);
    this.renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.autoClear = true;
    this.scene = new T.Scene();
    // Everything lives in one local frame (DN-36) about this.origin; vertical exaggeration scales
    // the world group about this.zBase.
    this.world = new T.Group();
    this.scene.add(this.world);
    this.overlay = new T.Group();
    this.world.add(this.overlay);
    this.origin = null;
    this.zBase = 0;
    this.exaggeration = 1;
    this.terrains = [];
    this.models = [];
    this.tilesets = [];
    this.scene.add(new T.AmbientLight(0xffffff, 0.55));
    this.sun = new T.DirectionalLight(0xffffff, 1.1);
    this.sun.position.set(-0.6, -0.4, 1);
    this.scene.add(this.sun);
    this.camera = new T.PerspectiveCamera(55, 1, 0.5, 50000);
    this.camera.up.set(0, 0, 1);
    this.controls = new T.OrbitControls(this.camera, this.canvas);
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.invalidate());
    this.settings = { colour: 'elevation', budget: 3_000_000, size: 2, edl: true, edlStrength: 0.6, edlRadius: 1.4, shave: { mode: 0, level: 0, against: 'plane' }, zRange: null, hagRange: [0, 20], background: [0.08, 0.09, 0.11] };
    this.classVisible = new Array(256).fill(true);
    this.palette = {};
    for (const [k, [, c]] of Object.entries(CLASSES)) this.palette[k] = c;
    this.clouds = []; // {cloud, group, tiles: [{t, points, count, area}], mat}
    this.uniforms = this._uniforms();
    this._makeEdl();
    this.frames = 0;
    this.drawn = 0;
    this._dirty = true;
    this._raf = 0;
    this.continuous = false;
    // Keep pointer input from reaching the 2D pane underneath.
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'dblclick', 'contextmenu']) {
      this.canvas.addEventListener(ev, (e) => {
        if (ev === 'pointerdown') {
          pane.mp.setActivePane(pane);
          this.canvas.focus({ preventScroll: true });
        }
        e.stopPropagation();
        this.tool?.[ev]?.(e);
      });
    }
    this.canvas.addEventListener('pointermove', (e) => this._hover(e));
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(pane.el);
    this.resize();
    this._loop();
  }

  _uniforms() {
    const T = this.T;
    this.paletteData = new Uint8Array(256 * 4);
    this.paletteTex = new T.DataTexture(this.paletteData, 256, 1, T.RGBAFormat);
    this.paletteTex.magFilter = T.NearestFilter;
    this.paletteTex.minFilter = T.NearestFilter;
    this._updatePalette();
    return {
      uMode: { value: 0 },
      uZRange: { value: new T.Vector2(0, 1) },
      uIRange: { value: new T.Vector2(0, 65535) },
      uTRange: { value: new T.Vector2(0, 1) },
      uHagRange: { value: new T.Vector2(0, 20) },
      uRgbScale: { value: 1 },
      uPalette: { value: this.paletteTex },
      uRamp: { value: rampTexture(T) },
      uSize: { value: 1.4 },
      uScale: { value: 1 },
      uShave: { value: new T.Vector3(0, 0, 0) },
      uHighlight: { value: new T.Vector4(0, 0, 0, 0) },
    };
  }

  _updatePalette() {
    for (let i = 0; i < 256; i++) {
      const c = hex3(this.palette[i] ?? '#b0b0b0');
      this.paletteData.set([...c, this.classVisible[i] ? 255 : 0], 4 * i);
    }
    this.paletteTex.needsUpdate = true;
  }

  _makeEdl() {
    const T = this.T;
    this.rt = new T.WebGLRenderTarget(4, 4, { depthBuffer: true });
    this.rt.depthTexture = new T.DepthTexture(4, 4, T.UnsignedIntType);
    this.edlMat = new T.ShaderMaterial({
      glslVersion: T.GLSL3,
      vertexShader: EDL_VS,
      fragmentShader: EDL_FS,
      depthTest: false,
      depthWrite: false,
      uniforms: { tColor: { value: this.rt.texture }, tDepth: { value: this.rt.depthTexture }, uTexel: { value: new T.Vector2(1, 1) }, uNear: { value: 0.5 }, uFar: { value: 50000 }, uStrength: { value: 0.6 }, uRadius: { value: 1.4 }, uBg: { value: new T.Vector3(0.08, 0.09, 0.11) }, uEdl: { value: true } },
    });
    this.quadScene = new T.Scene();
    this.quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene.add(new T.Mesh(new T.PlaneGeometry(2, 2), this.edlMat));
  }

  resize() {
    const r = this.pane.el.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const hh = Math.max(1, Math.round(r.height));
    this.renderer.setSize(w, hh, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hh}px`;
    this.camera.aspect = w / hh;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.rt.setSize(Math.round(w * pr), Math.round(hh * pr));
    this.edlMat.uniforms.uTexel.value.set(1 / (w * pr), 1 / (hh * pr));
    this.invalidate();
  }

  /** One drawable tile from column arrays [start, start + count) (whole clouds and streamed nodes). */
  _tile(cloud, t) {
    const T = this.T;
    const attr = (arr, size, normalized = false) => new T.BufferAttribute(arr, size, normalized);
    const s = t.start;
    const e = t.start + t.count;
    const g = new T.BufferGeometry();
    g.setAttribute('position', attr(cloud.pos.subarray(3 * s, 3 * e), 3));
    g.setAttribute('intensity', attr(cloud.intensity.subarray(s, e), 1, true));
    g.setAttribute('classification', attr(cloud.class.subarray(s, e), 1));
    g.setAttribute('ret', attr(cloud.ret.subarray(s, e), 1));
    g.setAttribute('gpsTime', attr(cloud.time.subarray(s, e), 1));
    g.setAttribute('source', attr(cloud.source.subarray(s, e), 1));
    if (cloud.rgb) g.setAttribute('rgb', attr(cloud.rgb.subarray(3 * s, 3 * e), 3, true));
    if (cloud.hag) g.setAttribute('hag', attr(cloud.hag.subarray(s, e), 1));
    g.boundingBox = new T.Box3(new T.Vector3(...t.min), new T.Vector3(...t.max));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new T.Sphere());
    const uSpacing = { value: 1 };
    const mat = new T.ShaderMaterial({ glslVersion: T.GLSL3, vertexShader: VS, fragmentShader: FS, uniforms: { ...this.uniforms, uSpacing } });
    const pts = new T.Points(g, mat);
    pts.frustumCulled = false; // the budget pass culls per tile
    const area = Math.max(1, (t.max[0] - t.min[0]) * (t.max[1] - t.min[1]));
    return { t, points: pts, geom: g, uSpacing, count: 0, area };
  }

  /** Add a point cloud (from formats/las.js) and frame it. */
  addCloud(cloud) {
    const T = this.T;
    const group = new T.Group();
    const entry = { cloud, group, tiles: [] };
    for (const t of cloud.tiles) {
      const tile = this._tile(cloud, t);
      group.add(tile.points);
      entry.tiles.push(tile);
    }
    this.setOrigin(cloud.origin);
    const off = this.offsetOf(cloud.origin);
    group.position.set(off[0], off[1], 0);
    entry.offset = off;
    this.world.add(group);
    this.clouds.push(entry);
    const st = cloud.stats;
    this.settings.zRange ??= st.zRange ?? [st.min[2], st.max[2]];
    this.uniforms.uZRange.value.set(...this.settings.zRange);
    this.uniforms.uIRange.value.set(...st.intensity);
    this.uniforms.uTRange.value.set(st.time[0], st.time[1]);
    this.uniforms.uRgbScale.value = st.rgb16 ? 1 : 65535 / 255;
    if (this.clouds.length === 1) this.fit();
    this.pane._updateBanners?.();
    this.invalidate();
    return entry;
  }

  /** Re-upload attributes after edits (classification, colours, height above ground). */
  refresh(cloud, fields = ['classification']) {
    const e = this.clouds.find((c) => c.cloud === cloud);
    if (!e) return;
    for (const tl of e.tiles) {
      const s = tl.t.start;
      const n = tl.t.count;
      for (const f of fields) {
        if (f === 'hag' && cloud.hag && !tl.geom.getAttribute('hag')) tl.geom.setAttribute('hag', new this.T.BufferAttribute(cloud.hag.subarray(s, s + n), 1));
        else if (f === 'rgb' && cloud.rgb && !tl.geom.getAttribute('rgb')) tl.geom.setAttribute('rgb', new this.T.BufferAttribute(cloud.rgb.subarray(3 * s, 3 * (s + n)), 3, true));
        else {
          const a = tl.geom.getAttribute(f);
          if (a) {
            // The attribute views the cloud's arrays, which may have been replaced.
            const src = { classification: cloud.class, hag: cloud.hag, rgb: cloud.rgb }[f];
            if (src) a.array = f === 'rgb' ? src.subarray(3 * s, 3 * (s + n)) : src.subarray(s, s + n);
            a.needsUpdate = true;
          }
        }
      }
    }
    if (fields.includes('rgb')) this.uniforms.uRgbScale.value = cloud.stats.rgb16 ? 1 : 65535 / 255;
    this.invalidate();
  }

  removeCloud(cloud) {
    const i = this.clouds.findIndex((c) => c.cloud === cloud);
    if (i < 0) return;
    const e = this.clouds[i];
    for (const tl of e.tiles) {
      tl.geom.dispose();
      tl.points.material.dispose();
    }
    this.world.remove(e.group);
    this.clouds.splice(i, 1);
    this.invalidate();
  }

  bounds() {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const c of this.clouds)
      for (let a = 0; a < 3; a++) {
        const o = a < 2 ? c.offset?.[a] ?? 0 : 0;
        min[a] = Math.min(min[a], c.cloud.stats.min[a] + o);
        max[a] = Math.max(max[a], c.cloud.stats.max[a] + o);
      }
    for (const t of this.terrains)
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], t.min[a]);
        max[a] = Math.max(max[a], t.max[a]);
      }
    return { min, max };
  }

  /** Fix the view's local frame on the first content; later content is offset into it. */
  setOrigin(o) {
    if (this.origin) return;
    this.origin = { lat0: o.lat0, lon0: o.lon0, kx: o.kx, ky: o.ky };
  }

  /** Local offset (east, north) of another frame's origin in this view's frame. */
  offsetOf(o) {
    const v = this.origin;
    return [(o.lon0 - v.lon0) * v.kx, (o.lat0 - v.lat0) * v.ky];
  }

  toLocal(lat, lon) {
    const v = this.origin;
    return [(lon - v.lon0) * v.kx, (lat - v.lat0) * v.ky];
  }

  toGeo(e, n, z) {
    const v = this.origin;
    return { lat: v.lat0 + n / v.ky, lon: v.lon0 + e / v.kx, hae: z };
  }

  /** Vertical exaggeration about the lowest terrain/cloud height (REQ-STR-11). */
  setExaggeration(ex) {
    this.exaggeration = Math.max(0.1, ex);
    this.zBase = this.bounds().min[2];
    if (!Number.isFinite(this.zBase)) this.zBase = 0;
    this.world.scale.set(1, 1, this.exaggeration);
    this.world.position.set(0, 0, this.zBase * (1 - this.exaggeration));
    this.world.updateMatrixWorld(true);
    this.invalidate();
  }

  /** Oblique view of everything. */
  fit() {
    const { min, max } = this.bounds();
    if (!Number.isFinite(min[0])) return;
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const r = Math.max(max[0] - min[0], max[1] - min[1], 1) * 0.75;
    this.controls.target.set(...c);
    this.camera.position.set(c[0] - r * 0.4, c[1] - r * 1.1, c[2] + r * 0.9);
    this.camera.near = Math.max(0.1, r / 2000);
    this.camera.far = r * 40;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  /** Aim at local (e, n, z) from about `r` metres (3D Tiles with no other content). */
  lookAtLocal(e, n, z, r) {
    this.controls.target.set(e, n, z);
    this.camera.position.set(e - r * 0.3, n - r * 1.2, z + r * 0.9);
    this.camera.near = Math.max(0.1, r / 5000);
    this.camera.far = Math.max(this.camera.far, r * 60);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  /** Stream an OGC 3D Tiles tileset (REQ-STR-15). */
  async addTileset(url, fetch, opts = {}) {
    const t = new Tileset(this, url, fetch, opts);
    await t.load();
    this.tilesets.push(t);
    this.invalidate();
    return t;
  }

  /** Look straight down on (e, n) from `height` m above the top. */
  lookDown(e, n, height = 300) {
    const { max } = this.bounds();
    this.controls.target.set(e, n, max[2] - height * 0.0);
    this.camera.position.set(e, n - 0.01, max[2] + height);
    this.controls.update();
    this.invalidate();
  }

  setColour(mode) {
    const i = COLOUR_MODES.indexOf(mode);
    if (i < 0) throw new Error(`unknown colour mode ${mode}`);
    this.settings.colour = mode;
    this.uniforms.uMode.value = i;
    this.invalidate();
  }

  setClassVisible(c, on) {
    this.classVisible[c] = on;
    this._updatePalette();
    this.invalidate();
  }

  setPaletteColour(c, hex) {
    this.palette[c] = hex;
    this._updatePalette();
    this.invalidate();
  }

  /** Shaving: mode 0 off, 1 keep below, 2 keep above `level` (plane z, or height above ground). */
  setShave(mode, level, against = 'plane') {
    this.settings.shave = { mode, level, against };
    this.uniforms.uShave.value.set(mode, level, against === 'ground' ? 1 : 0);
    this.invalidate();
  }

  invalidate() {
    this._dirty = true;
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    if (!this._dirty && !this.continuous) return;
    if (!this.canvas.isConnected) return;
    this._dirty = false;
    this.render();
  }

  /** Share the point budget among visible tiles by projected size (water-filling). */
  _budget() {
    const T = this.T;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const fr = new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const all = [];
    for (const c of this.clouds)
      for (const tl of c.tiles) {
        const bb = tl.geom.boundingBox;
        if (!fr.intersectsBox(bb)) {
          tl.count = 0;
          tl.points.visible = false;
          continue;
        }
        const sph = tl.geom.boundingSphere;
        const d = Math.max(cam.position.distanceTo(sph.center) - sph.radius * 0.5, sph.radius * 0.1, 1e-3);
        tl.w = (sph.radius / d) ** 2;
        all.push(tl);
      }
    let B = this.settings.budget;
    let open = all.slice();
    for (const tl of all) tl.count = 0;
    for (let iter = 0; iter < 8 && open.length && B > 0; iter++) {
      const W = open.reduce((s, t) => s + t.w, 0);
      const full = open.filter((t) => (B * t.w) / W >= t.t.count);
      if (!full.length) {
        for (const t of open) t.count = Math.floor((B * t.w) / W);
        B = 0;
        break;
      }
      for (const t of full) {
        t.count = t.t.count;
        B -= t.t.count;
      }
      open = open.filter((t) => !full.includes(t));
    }
    let drawn = 0;
    for (const tl of all) {
      tl.points.visible = tl.count > 0;
      tl.geom.setDrawRange(0, tl.count);
      tl.uSpacing.value = Math.sqrt(tl.area / Math.max(1, tl.count));
      drawn += tl.count;
    }
    this.drawn = drawn;
  }

  render() {
    const t0 = performance.now();
    for (const t of this.tilesets) t.update();
    this._updateStreams();
    this._budget();
    const hpx = this.canvas.height || 1;
    this.uniforms.uScale.value = hpx / (2 * Math.tan((this.camera.fov * Math.PI) / 360)); // device pixels, as gl_PointSize
    this.uniforms.uSize.value = this.settings.size;
    const bg = this.settings.background;
    this.renderer.setClearColor(new this.T.Color(...bg), 1);
    const u = this.edlMat.uniforms;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uStrength.value = this.settings.edlStrength;
    u.uRadius.value = this.settings.edlRadius;
    u.uBg.value.set(...bg);
    u.uEdl.value = this.settings.edl;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);
    this.frames++;
    this.lastFrameMs = performance.now() - t0;
    const msg = `3D · ${(this.drawn / 1e6).toFixed(2)} M of ${(this.totalPoints() / 1e6).toFixed(2)} M points`;
    if (this.pane.status && this.pane.status.textContent !== msg) this.pane.status.textContent = msg;
  }

  /**
   * A streamed octree cloud (COPC/EPT, REQ-LDR-02): nodes load as the camera needs them — a node
   * refines while its point spacing spans more than `px` screen pixels — and each loaded node is
   * an ordinary tile of the cloud (all levels draw together: COPC/EPT nodes are additive).
   */
  addStream(src, { px = 2, maxInFlight = 4, maxPoints = 4e6 } = {}) {
    const T = this.T;
    const group = new T.Group();
    this.setOrigin(src.origin);
    const off = this.offsetOf(src.origin);
    group.position.set(off[0], off[1], 0);
    const cloud = { name: src.name, n: 0, origin: src.origin, crs: src.crs, info: src.info ?? null, stats: null, streamed: true, stream: src };
    const entry = { cloud, group, tiles: [], offset: off, stream: src, inFlight: 0, opts: { px, maxInFlight, maxPoints } };
    this.world.add(group);
    this.clouds.push(entry);
    this._streams ??= [];
    this._streams.push(entry);
    const s0 = src.sphere(src.root);
    if (this.clouds.length === 1) this.lookAtLocal(s0.c[0] + off[0], s0.c[1] + off[1], s0.c[2], s0.r * 2);
    this.invalidate();
    return entry;
  }

  _updateStreams() {
    for (const entry of this._streams ?? []) {
      const src = entry.stream;
      const cam = this.camera.position;
      const k = (this.canvas.height || 1) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
      const want = [];
      const visit = (key, depth) => {
        const n = src.nodes.get(key);
        if (!n || depth > 24) return;
        const sp = src.sphere(key);
        const d = Math.max(1e-3, Math.hypot(cam.x - sp.c[0] - entry.offset[0], cam.y - sp.c[1] - entry.offset[1], cam.z - sp.c[2]) - sp.r);
        if (n.count > 0) want.push({ key, priority: d });
        const pxs = (src.spacingOf(key) * k) / d;
        if (pxs > entry.opts.px) {
          if (src.children(key).some((c) => src.nodes.get(c)?.page && !src.nodes.get(c)?.pageLoaded)) {
            if (!n.expanding) {
              n.expanding = true;
              src.expand(key).finally(() => this.invalidate());
            }
          }
          for (const c of src.children(key)) visit(c, depth + 1);
        }
      };
      visit(src.root, 0);
      want.sort((a, b) => a.priority - b.priority);
      for (const w of want) {
        const n = src.nodes.get(w.key);
        if (n.state !== 'none' || entry.inFlight >= entry.opts.maxInFlight || entry.cloud.n + n.count > entry.opts.maxPoints) continue;
        n.state = 'loading';
        entry.inFlight++;
        src.stats.requested++;
        src
          .load(w.key)
          .then((c) => {
            n.state = 'ready';
            if (!c) return;
            const cube = src.cube(w.key);
            const sp = src.sphere(w.key);
            const t = { start: 0, count: c.n, min: [sp.c[0] - sp.r, sp.c[1] - sp.r, cube.lo[2]], max: [sp.c[0] + sp.r, sp.c[1] + sp.r, cube.hi[2]] };
            const tile = this._tile({ ...c, rgb: c.rgb }, t);
            tile.key = w.key;
            entry.group.add(tile.points);
            entry.tiles.push(tile);
            entry.cloud.n += c.n;
            src.stats.loaded++;
            src.stats.points += c.n;
            if (!entry.cloud.stats) {
              const st = src.statsOf ? src.statsOf(c, src.hasRgb) : null;
              entry.cloud.stats = st;
              if (st) {
                this.settings.zRange ??= st.zRange;
                this.uniforms.uZRange.value.set(...this.settings.zRange);
                this.uniforms.uIRange.value.set(...st.intensity);
                this.uniforms.uRgbScale.value = st.rgb16 ? 1 : 65535 / 255;
              }
            }
          })
          .catch((e) => {
            n.state = 'failed';
            src.stats.failed++;
            this.app.log('warn', `${src.kind} ${src.name} node ${w.key}: ${e.message}`);
          })
          .finally(() => {
            entry.inFlight--;
            this.invalidate();
          });
      }
    }
  }

  totalPoints() {
    return this.clouds.reduce((s, c) => s + c.cloud.n, 0);
  }

  /** Frames per second over `n` frames of continuous orbiting (PRF-05 / AT-14.1). */
  async measureFps(n = 120, orbit = true) {
    this.continuous = true;
    const gl = this.renderer.getContext();
    const start = performance.now();
    const f0 = this.frames;
    await new Promise((res) => {
      const step = () => {
        if (orbit) {
          const p = this.camera.position.clone().sub(this.controls.target);
          const a = 0.01;
          this.camera.position.set(this.controls.target.x + p.x * Math.cos(a) - p.y * Math.sin(a), this.controls.target.y + p.x * Math.sin(a) + p.y * Math.cos(a), this.camera.position.z);
          this.camera.lookAt(this.controls.target);
        }
        if (this.frames - f0 >= n) return res();
        requestAnimationFrame(step);
      };
      step();
    });
    gl.finish();
    this.continuous = false;
    const s = (performance.now() - start) / 1000;
    return { fps: (this.frames - f0) / s, frames: this.frames - f0, drawn: this.drawn };
  }

  /** Screen position (CSS px) of a local point. */
  project(p, group = this.clouds[0]?.group ?? this.world) {
    group.updateMatrixWorld(true);
    const v = new this.T.Vector3(...p).applyMatrix4(group.matrixWorld).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { sx: ((v.x + 1) / 2) * r.width, sy: ((1 - v.y) / 2) * r.height, z: v.z };
  }

  /** Nearest drawn, visible point within `rad` CSS px of (sx, sy), front-most first. */
  pick(sx, sy, rad = 6) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.world.updateMatrixWorld(true);
    const vp = new this.T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const r = this.canvas.getBoundingClientRect();
    const W = r.width;
    const H = r.height;
    const sh = this.settings.shave;
    let best = null;
    for (const c of this.clouds) {
      const cl = c.cloud;
      const m = new this.T.Matrix4().multiplyMatrices(vp, c.group.matrixWorld).elements;
      for (const tl of c.tiles) {
        if (!tl.count) continue;
        const s = tl.t.start;
        for (let k = s; k < s + tl.count; k++) {
          if (!this.classVisible[cl.class[k]]) continue;
          const x = cl.pos[3 * k];
          const y = cl.pos[3 * k + 1];
          const z = cl.pos[3 * k + 2];
          if (sh.mode) {
            const v = sh.against === 'ground' ? cl.hag?.[k] ?? z : z;
            if ((sh.mode === 1 && v > sh.level) || (sh.mode === 2 && v < sh.level)) continue;
          }
          const w = m[3] * x + m[7] * y + m[11] * z + m[15];
          if (w <= 0) continue;
          const px = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * W;
          const py = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5 * H;
          const d2 = (px - sx) ** 2 + (py - sy) ** 2;
          if (d2 > rad * rad) continue;
          const depth = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
          // Prefer the nearest to the cursor, then the front-most.
          const score = d2 + depth * 4;
          if (!best || score < best.score) best = { score, cloud: cl, index: k, pos: [x, y, z], d: Math.sqrt(d2) };
        }
      }
    }
    return best;
  }

  _hover(e) {
    clearTimeout(this._hoverT);
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    this._hoverT = setTimeout(() => {
      const p = this.pick(sx, sy, 5);
      this.hovered = p;
      if (p) this.app.pointCloudHover?.(this, p);
    }, 90);
  }

  /** Overlay graphics in the local frame: polylines and markers (measurements, swaths). */
  setOverlay(items) {
    const T = this.T;
    for (const o of [...this.overlay.children]) {
      o.geometry?.dispose();
      o.material?.dispose();
      this.overlay.remove(o);
    }
    for (const it of items) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(it.points.flat()), 3));
      if (it.kind === 'marker') {
        const m = new T.Points(g, new T.ShaderMaterial({ glslVersion: T.GLSL3, depthTest: false, transparent: true, vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = 9.0; }', fragmentShader: `out vec4 o; void main(){ vec2 d = gl_PointCoord - 0.5; if (dot(d,d) > 0.25) discard; o = vec4(${it.colour ?? '1.0,0.85,0.1'},1.0); }` }));
        m.renderOrder = 10;
        this.overlay.add(m);
      } else {
        const line = new (it.closed ? T.LineLoop : T.Line)(g, new T.LineBasicMaterial({ color: it.colour ?? 0xffd400, depthTest: false }));
        line.renderOrder = 10;
        this.overlay.add(line);
      }
    }
    this.invalidate();
  }

  // ---- terrain (REQ-STR-11) ----
  /**
   * Add a terrain mesh: `grid` = {lat0, lon0, dlat, dlon, size} posts, `heights` (size², HAE, no
   * NaN), `mesh` = RTIN {xy, tris}; `drape` = {data (Uint8 RGBA), width, height, uv (2 per mesh
   * vertex)} or null for elevation colours with lighting.
   */
  addTerrain({ grid, heights, mesh, drape = null, name = 'terrain' }) {
    const T = this.T;
    const latC = grid.lat0 - ((grid.size - 1) * grid.dlat) / 2;
    this.setOrigin({ lat0: latC, lon0: grid.lon0 + ((grid.size - 1) * grid.dlon) / 2, ...frameAt(latC) });
    const nv = mesh.xy.length / 2;
    const pos = new Float32Array(3 * nv);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < nv; k++) {
      const i = mesh.xy[2 * k];
      const j = mesh.xy[2 * k + 1];
      const [e, n] = this.toLocal(grid.lat0 - j * grid.dlat, grid.lon0 + i * grid.dlon);
      const z = heights[j * grid.size + i];
      pos[3 * k] = e;
      pos[3 * k + 1] = n;
      pos[3 * k + 2] = z;
      const v = [e, n, z];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], v[a]);
        max[a] = Math.max(max[a], v[a]);
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    // Rows run south in the grid: flip the winding so faces point up.
    const idx = new Uint32Array(mesh.tris.length);
    for (let t = 0; t < mesh.tris.length; t += 3) {
      idx[t] = mesh.tris[t];
      idx[t + 1] = mesh.tris[t + 2];
      idx[t + 2] = mesh.tris[t + 1];
    }
    g.setIndex(new T.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    let mat;
    if (drape) {
      g.setAttribute('uv', new T.BufferAttribute(drape.uv, 2));
      const tex = new T.DataTexture(drape.data, drape.width, drape.height, T.RGBAFormat);
      tex.flipY = false;
      tex.magFilter = T.LinearFilter;
      tex.minFilter = T.LinearFilter;
      tex.needsUpdate = true;
      mat = new T.MeshBasicMaterial({ map: tex, side: T.DoubleSide });
    } else {
      const col = new Float32Array(3 * nv);
      for (let k = 0; k < nv; k++) {
        const t = (pos[3 * k + 2] - min[2]) / Math.max(1, max[2] - min[2]);
        col[3 * k] = 0.35 + 0.45 * t;
        col[3 * k + 1] = 0.45 + 0.25 * t;
        col[3 * k + 2] = 0.3 + 0.2 * t;
      }
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      mat = new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide });
    }
    const m = new T.Mesh(g, mat);
    m.name = name;
    this.world.add(m);
    const entry = { mesh: m, grid, heights, min, max, name, vertices: nv, triangles: mesh.tris.length / 3, draped: !!drape };
    this.terrains.push(entry);
    if (this.clouds.length === 0 && this.terrains.length === 1) this.fit();
    this.invalidate();
    return entry;
  }

  /** Height of the terrain grid at a local point (bilinear), or NaN. */
  terrainHeight(e, n) {
    for (const t of this.terrains) {
      const g = t.grid;
      const p = this.toGeo(e, n, 0);
      const fx = (p.lon - g.lon0) / g.dlon;
      const fy = (g.lat0 - p.lat) / g.dlat;
      if (fx < 0 || fy < 0 || fx > g.size - 1 || fy > g.size - 1) continue;
      const x0 = Math.min(g.size - 2, Math.floor(fx));
      const y0 = Math.min(g.size - 2, Math.floor(fy));
      const tx = fx - x0;
      const ty = fy - y0;
      const H = t.heights;
      const a = (i, j) => H[j * g.size + i];
      return (a(x0, y0) * (1 - tx) + a(x0 + 1, y0) * tx) * (1 - ty) + (a(x0, y0 + 1) * (1 - tx) + a(x0 + 1, y0 + 1) * tx) * ty;
    }
    return NaN;
  }

  /** 3D cursor on the terrain or models under (sx, sy): local [e, n, z] (unexaggerated) or null. */
  pickSurface(sx, sy) {
    const T = this.T;
    const r = this.canvas.getBoundingClientRect();
    const rc = new T.Raycaster();
    this.world.updateMatrixWorld(true);
    rc.setFromCamera(new T.Vector2((sx / r.width) * 2 - 1, -(sy / r.height) * 2 + 1), this.camera);
    const hits = rc.intersectObjects([...this.terrains.map((t) => t.mesh), ...this.models.map((m) => m.object)], true);
    if (!hits.length) return null;
    const p = this.world.worldToLocal(hits[0].point.clone());
    return [p.x, p.y, p.z];
  }

  /** Screen position of a local point of the world frame (terrain, models). */
  projectWorld(p) {
    return this.project(p, this.world);
  }

  /** 3D line of sight between two local points over the terrain (REQ-STR-12). */
  lineOfSight(a, b, { step = 1 } = {}) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(2, Math.ceil(L / step));
    let first = null;
    let clearance = Infinity;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const e = a[0] + (b[0] - a[0]) * t;
      const nn = a[1] + (b[1] - a[1]) * t;
      const zr = a[2] + (b[2] - a[2]) * t;
      const zt = this.terrainHeight(e, nn);
      if (!Number.isFinite(zt)) continue;
      clearance = Math.min(clearance, zr - zt);
      if (zt > zr && !first) first = [e, nn, zt];
    }
    return { visible: !first, blockedAt: first, clearance, distance: Math.hypot(L, b[2] - a[2]) };
  }

  // ---- models (REQ-STR-13) ----
  /** Import glTF/GLB bytes; placed by the GIS Workbench origin in asset.extras, else at the centre. */
  async addGltf(bytes, name = 'model', resources = []) {
    const T = this.T;
    // External buffers and textures (a .gltf with its .bin / images) resolve to blob: URLs of the
    // files dropped with it (IMP-13); nothing is fetched from the network.
    // A .gltf whose buffers or images were not dropped with it is refused by name before loading,
    // so nothing is requested from the page's own location (TE-035).
    if (bytes[0] === 0x7b) {
      let json = null;
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        /* the loader reports malformed JSON */
      }
      const have = new Set(resources.map((f) => f.name.toLowerCase()));
      const missing = [...(json?.buffers ?? []), ...(json?.images ?? [])]
        .map((r) => r.uri)
        .filter((u) => u && !/^(data|blob):/i.test(u))
        .map((u) => decodeURIComponent(u.split(/[\\/]/).pop()))
        .filter((u) => !have.has(u.toLowerCase()));
      if (missing.length) throw new Error(`${name} needs ${[...new Set(missing)].join(', ')}; open the files with the .gltf`);
    }
    const urls = new Map(resources.map((f) => [f.name.toLowerCase(), URL.createObjectURL(f)]));
    const manager = new T.LoadingManager();
    manager.setURLModifier((u) => {
      // Embedded data: buffers and images become blob: URLs, which the page's CSP lets the loader
      // fetch (connect-src blob:; TE-035).
      if (/^data:/i.test(u)) {
        const m = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(u);
        if (!m) return u;
        const bytes = m[2] ? Uint8Array.from(atob(m[3]), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
        const b = URL.createObjectURL(new Blob([bytes], { type: m[1] || 'application/octet-stream' }));
        urls.set(`\0${urls.size}`, b);
        return b;
      }
      return urls.get(decodeURIComponent(u.split(/[\\/]/).pop()).toLowerCase()) ?? u;
    });
    refuseUndecodable(bytes, name);
    const loader = gltfLoader(T, manager);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    let gltf;
    try {
      gltf = await new Promise((res, rej) => loader.parse(buf, '', res, rej));
    } finally {
      for (const u of urls.values()) URL.revokeObjectURL(u);
    }
    const obj = gltf.scene;
    // glTF is Y-up (−Z north): turn it to this Z-up frame.
    obj.rotation.x = Math.PI / 2;
    const o = gltf.asset?.extras?.origin ?? gltf.parser?.json?.asset?.extras?.origin ?? null;
    if (o && !this.origin) this.setOrigin({ lat0: o.lat, lon0: o.lon, ...frameAt(o.lat) });
    if (o) {
      const [e, n] = this.toLocal(o.lat, o.lon);
      obj.position.set(e, n, o.h);
    } else {
      const { min, max } = this.bounds();
      if (Number.isFinite(min[0])) {
        const ce = (min[0] + max[0]) / 2;
        const cn = (min[1] + max[1]) / 2;
        obj.position.set(ce, cn, this.terrainHeight(ce, cn) || 0);
      }
    }
    this.world.add(obj);
    let meshes = 0;
    obj.traverse((x) => {
      if (x.isMesh) meshes++;
    });
    const entry = { object: obj, name, meshes, placedBy: o ? 'origin' : 'centre' };
    this.models.push(entry);
    this.invalidate();
    return entry;
  }

  // ---- navigation (REQ-STR-11) ----
  /** 'orbit' | 'free' | 'route'. Free: W/S forward/back, A/D sideways, Q/E down/up, drag to look. */
  setNavigation(mode, opts = {}) {
    this.nav = mode;
    this.controls.enabled = mode === 'orbit';
    this._routeStop?.();
    if (mode === 'free' && !this._freeBound) {
      this._freeBound = true;
      const keys = new Set();
      this.canvas.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
      this.canvas.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
      let drag = null;
      this.canvas.addEventListener('pointerdown', (e) => {
        if (this.nav === 'free') drag = { x: e.clientX, y: e.clientY };
      });
      window.addEventListener('pointerup', () => (drag = null));
      this.canvas.addEventListener('pointermove', (e) => {
        if (this.nav !== 'free' || !drag) return;
        this.look(-(e.clientX - drag.x) * 0.004, -(e.clientY - drag.y) * 0.004);
        drag = { x: e.clientX, y: e.clientY };
      });
      const tick = () => {
        if (!this.canvas.isConnected) return;
        if (this.nav === 'free' && keys.size) {
          const sp = (opts.speed ?? this.flySpeed ?? 4) * (keys.has('shift') ? 4 : 1);
          this.fly((keys.has('w') ? sp : 0) - (keys.has('s') ? sp : 0), (keys.has('d') ? sp : 0) - (keys.has('a') ? sp : 0), (keys.has('e') ? sp : 0) - (keys.has('q') ? sp : 0));
        }
        requestAnimationFrame(tick);
      };
      tick();
    }
    if (mode === 'route' && opts.route) return this.flyRoute(opts.route, opts);
    this.invalidate();
    return null;
  }

  /** Move the camera forward, right and up (m). */
  fly(fwd, right, up) {
    const T = this.T;
    const dir = new T.Vector3();
    this.camera.getWorldDirection(dir);
    const r = new T.Vector3().crossVectors(dir, this.camera.up).normalize();
    for (const v of [this.camera.position, this.controls.target]) v.addScaledVector(dir, fwd).addScaledVector(r, right).addScaledVector(this.camera.up, up);
    this.invalidate();
  }

  /** Turn the camera (yaw about up, pitch about its right axis), radians. */
  look(yaw, pitch) {
    const T = this.T;
    const dir = new T.Vector3();
    this.camera.getWorldDirection(dir);
    dir.applyAxisAngle(new T.Vector3(0, 0, 1), yaw);
    const r = new T.Vector3().crossVectors(dir, new T.Vector3(0, 0, 1)).normalize();
    const d2 = dir.clone().applyAxisAngle(r, pitch);
    if (Math.abs(d2.z) < 0.99) dir.copy(d2);
    this.controls.target.copy(this.camera.position).addScaledVector(dir, 50);
    this.camera.lookAt(this.controls.target);
    this.invalidate();
  }

  /**
   * Fly along a route of local points `height` m above the terrain at `speed` m/s.
   * Returns {promise (resolves {length, seconds}), stop, length}.
   */
  flyRoute(route, { height = 80, speed = 60, lookAhead = 60 } = {}) {
    const seg = [];
    let total = 0;
    for (let i = 1; i < route.length; i++) {
      const L = Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]);
      seg.push([total, L]);
      total += L;
    }
    const at = (s) => {
      const ss = Math.max(0, Math.min(total, s));
      let i = seg.findIndex(([s0, L]) => ss <= s0 + L);
      if (i < 0) i = seg.length - 1;
      const t = seg[i][1] ? (ss - seg[i][0]) / seg[i][1] : 0;
      const a = route[i];
      const b = route[i + 1];
      const e = a[0] + (b[0] - a[0]) * t;
      const n = a[1] + (b[1] - a[1]) * t;
      const zt = this.terrainHeight(e, n);
      return [e, n, (Number.isFinite(zt) ? zt : a[2] ?? 0) + height];
    };
    let stopped = false;
    const t0 = performance.now();
    this.continuous = true;
    this.controls.enabled = false;
    const promise = new Promise((res) => {
      const step = () => {
        const s = ((performance.now() - t0) / 1000) * speed;
        const p = at(s);
        const q = at(s + lookAhead);
        const ex = this.exaggeration;
        const zb = this.zBase;
        this.camera.position.set(p[0], p[1], zb + (p[2] - zb) * ex);
        this.controls.target.set(q[0], q[1], zb + (q[2] - height * 0.6 - zb) * ex);
        this.camera.lookAt(this.controls.target);
        if (stopped || s >= total) {
          this.continuous = false;
          this.nav = 'orbit';
          this.controls.enabled = true;
          res({ length: total, seconds: (performance.now() - t0) / 1000 });
          return;
        }
        requestAnimationFrame(step);
      };
      step();
    });
    this._routeStop = () => (stopped = true);
    return { promise, stop: () => (stopped = true), length: total };
  }

  // ---- recording (REQ-STR-14) ----
  /**
   * Record a fly-through to WebM: `pose(t)` places the camera at t seconds; frames are rendered
   * and encoded one by one (WebCodecs VP8), so the video keeps its frame rate whatever the
   * rendering speed. Resolves to a Blob.
   */
  async recordWebM({ seconds = 3, fps = 30, pose = null } = {}) {
    const frames = Math.max(1, Math.round(seconds * fps));
    const wasContinuous = this.continuous;
    this.continuous = false;
    try {
      const bytes = await encodeCanvasWebM(this.canvas, {
        frames,
        fps,
        draw: (i, t) => {
          pose?.(t);
          this.render();
        },
      });
      return new Blob([bytes], { type: 'video/webm' });
    } finally {
      this.continuous = wasContinuous;
    }
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    for (const c of [...this.clouds]) this.removeCloud(c.cloud);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}
