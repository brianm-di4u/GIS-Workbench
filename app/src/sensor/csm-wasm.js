// The usgscsm WebAssembly module (REQ-GAP-24, spike S-60): our own loader over its hand-written C
// ABI (build/csm/src/gw_csm.cpp). No embind and no Emscripten JS glue: the module is a WASI
// reactor (STANDALONE_WASM), instantiated here with a few WASI functions that do nothing a page
// cannot (no files, no environment, a clock, discarded stdout/stderr). DOM-free: used on the main
// thread and in the analysis worker.
//
// Image coordinates are GIS Workbench's (x = sample, y = line, first pixel centre at (0.5, 0.5),
// CSM's own convention); ground is (lat, lon, height) on the model's own ellipsoid, or body-fixed
// X, Y, Z in the *Ecef calls.

import { WasmError, wasmError, isTrap } from '../wasm/abi.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** usgscsm model names (CSM getModelName) → short kinds. */
export const CSM_MODELS = {
  USGS_ASTRO_FRAME_SENSOR_MODEL: 'frame',
  USGS_ASTRO_LINE_SCANNER_SENSOR_MODEL: 'linescan',
  USGS_ASTRO_PUSH_FRAME_SENSOR_MODEL: 'pushframe',
  USGS_ASTRO_SAR_SENSOR_MODEL: 'sar',
};

const ERRNO_BADF = 8;
const ERRNO_NOSYS = 52;
const ERRNO_SPIPE = 70;

/** The WASI imports the module may name; anything else is refused at instantiation. */
function wasi(self) {
  const view = () => new DataView(self.x.memory.buffer);
  return {
    fd_write(fd, iovs, n, nwritten) {
      const dv = view();
      let total = 0;
      for (let i = 0; i < n; i++) {
        const p = dv.getUint32(iovs + 8 * i, true);
        const len = dv.getUint32(iovs + 8 * i + 4, true);
        if (fd === 2 && self.stderr.length < 4096) self.stderr += dec.decode(new Uint8Array(self.x.memory.buffer, p, len));
        total += len;
      }
      dv.setUint32(nwritten, total, true);
      return fd === 1 || fd === 2 ? 0 : ERRNO_BADF;
    },
    fd_close: () => 0,
    fd_seek: () => ERRNO_SPIPE,
    fd_read: () => ERRNO_BADF,
    fd_fdstat_get: () => ERRNO_BADF,
    fd_prestat_get: () => ERRNO_BADF,
    fd_prestat_dir_name: () => ERRNO_BADF,
    path_open: () => ERRNO_NOSYS,
    environ_sizes_get(count, size) {
      const dv = view();
      dv.setUint32(count, 0, true);
      dv.setUint32(size, 0, true);
      return 0;
    },
    environ_get: () => 0,
    args_sizes_get(count, size) {
      const dv = view();
      dv.setUint32(count, 0, true);
      dv.setUint32(size, 0, true);
      return 0;
    },
    args_get: () => 0,
    clock_time_get(id, precision, out) {
      view().setBigUint64(out, BigInt(Math.round((id === 0 ? Date.now() : performance.now()) * 1e6)), true);
      return 0;
    },
    clock_res_get(id, out) {
      view().setBigUint64(out, 1000n, true);
      return 0;
    },
    random_get(buf, len) {
      crypto.getRandomValues(new Uint8Array(self.x.memory.buffer, buf, len));
      return 0;
    },
    sched_yield: () => 0,
    proc_exit(code) {
      throw wasmError(5, 'usgscsm: the module exited ({code})', { code }, 'proc_exit');
    },
  };
}

/** The usgscsm module, one instance; models are integer handles. */
export class Usgscsm {
  /** `module`: the compiled WebAssembly.Module of block wasm-usgscsm. */
  constructor(module) {
    this.module = module;
    this.restarts = -1;
    this.instantiate();
  }

  instantiate() {
    const w = wasi(this);
    const imports = { wasi_snapshot_preview1: {}, env: {} };
    for (const i of WebAssembly.Module.imports(this.module)) {
      if (i.module === 'wasi_snapshot_preview1') imports.wasi_snapshot_preview1[i.name] = w[i.name] ?? (() => ERRNO_NOSYS);
      else if (i.module === 'env' && i.name === 'emscripten_notify_memory_growth') imports.env[i.name] = () => {};
      else throw wasmError(4, 'usgscsm: the module imports {name}, which this loader does not provide', { name: `${i.module}.${i.name}` }, 'instantiate');
    }
    this.stderr = '';
    this.instance = new WebAssembly.Instance(this.module, imports);
    this.x = this.instance.exports;
    this.x._initialize?.(); // the reactor's static constructors (the usgscsm plugin registers itself)
    this.scratch = this.x.gwc_alloc(256);
    this.restarts++;
  }

  get mem() {
    return this.x.memory.buffer;
  }

  /** Run fn; a trap (C++ abort, out of bounds) restarts the module, losing every model, and throws. */
  guard(fn) {
    try {
      return fn();
    } catch (e) {
      if (isTrap(e)) {
        const err = wasmError(5, '{module}: WebAssembly trap ({detail}); the module was restarted', { module: 'usgscsm', detail: e.message }, 'trap');
        err.trapped = true;
        this.instantiate();
        throw err;
      }
      throw e;
    }
  }

  lastError() {
    const n = this.x.gwc_last_error(this.scratch, 0);
    const p = this.x.gwc_alloc(n + 1);
    try {
      this.x.gwc_last_error(p, n);
      return dec.decode(new Uint8Array(this.mem, p, n));
    } finally {
      this.x.gwc_free(p);
    }
  }

  check(r, fn) {
    if (r < 0) throw new WasmError(-r, this.lastError(), fn);
    return r;
  }

  out() {
    return dec.decode(new Uint8Array(this.mem, this.x.gwc_out_ptr(), this.x.gwc_out_len()));
  }

  /** Copy bytes in; returns [ptr, len]; the caller frees. */
  put(u8) {
    const p = this.x.gwc_alloc(u8.byteLength);
    if (!p) throw wasmError(3, '{module}: out of memory allocating {n, plural, one {# byte} other {# bytes}}', { module: 'usgscsm', n: u8.byteLength });
    new Uint8Array(this.mem, p, u8.byteLength).set(u8);
    return [p, u8.byteLength];
  }

  withBytes(u8, fn) {
    const [p, n] = this.put(u8);
    try {
      return fn(p, n);
    } finally {
      this.x.gwc_free(p);
    }
  }

  /** f64 in/out: fn(inPtr, outPtr) over `pts` (Float64Array or array) and `nOut` outputs. */
  withF64(pts, nOut, fn) {
    const a = pts instanceof Float64Array ? pts : Float64Array.from(pts);
    const pi = this.x.gwc_alloc(Math.max(8, a.byteLength));
    const po = this.x.gwc_alloc(Math.max(8, nOut * 8));
    try {
      new Float64Array(this.mem, pi, a.length).set(a);
      const r = fn(pi, po);
      return { r, v: new Float64Array(this.mem, po, nOut).slice() };
    } finally {
      this.x.gwc_free(pi);
      this.x.gwc_free(po);
    }
  }

  version() {
    return this.guard(() => {
      this.check(this.x.gwc_version(), 'version');
      return JSON.parse(this.out());
    });
  }

  /**
   * A model from ISD JSON text. `model`: a usgscsm model name, or '' for the ISD's own name_model;
   * `id`: the image identifier when the ISD has none (its file name). → {handle, warnings}.
   */
  fromIsd(text, { model = '', id = '' } = {}) {
    return this.guard(() => {
      const t = enc.encode(text);
      const m = enc.encode(model);
      const i = enc.encode(id);
      const [pt, nt] = this.put(t);
      const [pm, nm] = this.put(m);
      const [pi, ni] = this.put(i);
      try {
        const h = this.check(this.x.gwc_model_from_isd(pt, nt, pm, nm, pi, ni), 'fromIsd');
        let warnings = [];
        try {
          warnings = JSON.parse(this.out());
        } catch {
          warnings = [];
        }
        return { handle: h, warnings };
      } finally {
        this.x.gwc_free(pt);
        this.x.gwc_free(pm);
        this.x.gwc_free(pi);
      }
    });
  }

  /** A model from its saved state (string or UTF-8 bytes) → handle. */
  fromState(state) {
    return this.guard(() => this.withBytes(typeof state === 'string' ? enc.encode(state) : state, (p, n) => this.check(this.x.gwc_model_from_state(p, n), 'fromState')));
  }

  /** The model's state (usgscsm getModelState), a string. */
  state(h) {
    return this.guard(() => {
      this.check(this.x.gwc_model_state(h), 'state');
      return this.out();
    });
  }

  free(h) {
    this.x.gwc_model_free(h);
  }

  /** Model facts: model, sensor, platform, image, time, lines, samples, a, b, hmin, hmax, params [{name, units, type, value}], cov. */
  info(h) {
    return this.guard(() => {
      this.check(this.x.gwc_model_info(h), 'info');
      return JSON.parse(this.out());
    });
  }

  setPrecision(h, px, m) {
    return this.guard(() => this.check(this.x.gwc_set_precision(h, px, m), 'setPrecision'));
  }

  /** A copy with `delta` added to the first delta.length parameters → new handle. */
  withParams(h, delta) {
    return this.guard(() => {
      const { r } = this.withF64(delta, 0, (pi) => this.x.gwc_model_with_params(h, pi, delta.length));
      return this.check(r, 'withParams');
    });
  }

  /** Flat n × 3 in, n × k out through a batch entry point; returns {v, bad}. */
  batch(fn, h, flat, k) {
    const n = flat.length / 3;
    return this.guard(() => {
      const { r, v } = this.withF64(flat, n * k, (pi, po) => this.x[fn](h, pi, n, po));
      return { v, bad: this.check(r, fn) };
    });
  }

  /** [[x, y, hae], …] → [[lat, lon, hae] | null, …]. */
  i2g(h, pts) {
    const { v } = this.batch('gwc_i2g', h, pts.flat(), 3);
    return pts.map((_, i) => (Number.isFinite(v[3 * i]) ? [v[3 * i], v[3 * i + 1], v[3 * i + 2]] : null));
  }

  /** [[lat, lon, hae], …] → [[x, y] | null, …]. */
  g2i(h, pts) {
    const { v } = this.batch('gwc_g2i', h, pts.flat(), 2);
    return pts.map((_, i) => (Number.isFinite(v[2 * i]) ? [v[2 * i], v[2 * i + 1]] : null));
  }

  /** CSM order: flat n × (line, sample, h) → Float64Array n × (X, Y, Z), NaN on failure. */
  i2gEcef(h, flat) {
    return this.batch('gwc_i2g_ecef', h, flat, 3);
  }

  /** CSM order: flat n × (X, Y, Z) → Float64Array n × (line, sample, achieved precision). */
  g2iEcef(h, flat) {
    return this.batch('gwc_g2i_ecef', h, flat, 3);
  }

  /** Single point, no allocation (the host bridge's hot path): (lat, lon, hae) → [x, y] | null. */
  g2i1(h, lat, lon, hae) {
    const s = this.scratch;
    const f = new Float64Array(this.mem, s, 5);
    f[0] = lat;
    f[1] = lon;
    f[2] = hae;
    const r = this.x.gwc_g2i(h, s, 1, s + 24);
    if (r < 0) throw new WasmError(-r, this.lastError(), 'g2i');
    const o = new Float64Array(this.mem, s + 24, 2);
    return r === 0 ? [o[0], o[1]] : null;
  }

  /** Single point: (x, y, hae) → [lat, lon, hae] | null. */
  i2g1(h, x, y, hae) {
    const s = this.scratch;
    const f = new Float64Array(this.mem, s, 6);
    f[0] = x;
    f[1] = y;
    f[2] = hae;
    const r = this.x.gwc_i2g(h, s, 1, s + 24);
    if (r < 0) throw new WasmError(-r, this.lastError(), 'i2g');
    const o = new Float64Array(this.mem, s + 24, 3);
    return r === 0 ? [o[0], o[1], o[2]] : null;
  }

  /** Sensor partials at (lat, lon, hae): Float64Array n × (∂x, ∂y). */
  partials(h, lat, lon, hae, n) {
    return this.guard(() => {
      const { r, v } = this.withF64([], Math.max(1, 2 * n), (pi, po) => this.x.gwc_sensor_partials(h, lat, lon, hae, po));
      this.check(r, 'partials');
      return v.subarray(0, 2 * r);
    });
  }

  /** Ground partials ∂(line, sample)/∂(X, Y, Z) at an ECEF point (CSM order, 6 values). */
  groundPartialsEcef(h, x, y, z) {
    return this.guard(() => {
      const { r, v } = this.withF64([], 6, (pi, po) => this.x.gwc_ground_partials_ecef(h, x, y, z, po));
      this.check(r, 'groundPartials');
      return v;
    });
  }

  /** Unmodelled error [σxx, σxy, σyy] (px²) at image (x, y). */
  unmodelled(h, x, y) {
    return this.guard(() => {
      const { r, v } = this.withF64([], 3, (pi, po) => this.x.gwc_unmodeled(h, x, y, po));
      this.check(r, 'unmodelled');
      return v;
    });
  }

  /** Remote imaging locus at image (x, y): [Px, Py, Pz, Dx, Dy, Dz] (ECEF). */
  locus(h, x, y) {
    return this.guard(() => {
      const { r, v } = this.withF64([], 6, (pi, po) => this.x.gwc_locus(h, x, y, po));
      this.check(r, 'locus');
      return v;
    });
  }

  /** Geodetic ↔ ECEF on the model's ellipsoid: dir 0 (lat, lon, h) → XYZ, 1 the reverse; flat n × 3. */
  convert(h, dir, flat) {
    return this.guard(() => {
      const { r, v } = this.withF64(flat, flat.length, (pi, po) => this.x.gwc_convert(h, dir, pi, flat.length / 3, po));
      this.check(r, 'convert');
      return v;
    });
  }
}

/** A model state as a block-job record (gw_sensor::host::HostModel::from_record): [bytes, u32 LE words…]. */
export function stateRecord(state) {
  const b = typeof state === 'string' ? enc.encode(state) : state;
  const words = Math.ceil(b.length / 4);
  const pad = new Uint8Array(words * 4);
  pad.set(b);
  const u32 = new Uint32Array(pad.buffer);
  const r = new Float64Array(1 + words);
  r[0] = b.length;
  for (let i = 0; i < words; i++) r[1 + i] = u32[i];
  return r;
}
