// The CSM host-model bridge (REQ-GAP-24): implements the `gw_host.csm_*` imports of the Rust
// bundles (gw_sensor::host, stubbed in wasm/abi.js until this is installed) over the usgscsm
// module (sensor/csm-wasm.js). A Rust HostModel holds a usgscsm handle; every call here reads its
// inputs from, and writes its answers into, the calling bundle's own memory. Nothing throws back
// into Rust: errors become −status with their text kept for csm_error, and a usgscsm trap restarts
// that module (its models are gone; their calls then fail by name). DOM-free.

import { isTrap } from '../wasm/abi.js';

const enc = new TextEncoder();

/** Install the bridge over `csm` (a Usgscsm) in this context (main thread or worker). */
export function installCsmBridge(csm) {
  const errors = new Map(); // handle → last error text (0: loads)
  const gen = new Map(); // handle → the module restart count it was made in
  const meta = new Map(); // handle → cached info
  const live = (h) => gen.get(h) === csm.restarts;
  const remember = (h) => {
    gen.set(h, csm.restarts);
    return h;
  };
  const fail = (h, e) => {
    if (isTrap(e)) {
      try {
        csm.instantiate();
      } catch {
        /* the next call reports it */
      }
      errors.set(h, `usgscsm: WebAssembly trap (${e.message}); the module was restarted and its models are gone`);
      return -5;
    }
    errors.set(h, String(e?.message ?? e));
    return -(Number.isInteger(e?.code) && e.code >= 1 && e.code <= 5 ? e.code : 5);
  };
  const gone = (h) => {
    errors.set(h, 'usgscsm was restarted after an error: attach the ISD again');
    return -1;
  };
  const f64 = (b, p, n) => new Float64Array(b.mem, p, n);
  const run = (h, fn) => {
    if (h && !live(h)) return gone(h);
    try {
      return fn();
    } catch (e) {
      return fail(h, e);
    }
  };
  const infoOf = (h) => {
    let m = meta.get(h);
    if (!m) meta.set(h, (m = csm.info(h)));
    return m;
  };
  const write = (b, p, cap, u8) => {
    if (cap > 0) new Uint8Array(b.mem, p, Math.min(cap, u8.length)).set(u8.subarray(0, Math.min(cap, u8.length)));
    return u8.length;
  };

  const bridge = {
    csm,
    /** Register a handle made outside the bridge (sensor/csm.js) so its calls are checked. */
    adopt: remember,
    csm_g2i: (b, h, lat, lon, hae, out) =>
      run(h, () => {
        const r = csm.g2i1(h, lat, lon, hae);
        if (!r) {
          errors.set(h, csm.lastError() || 'no image point for this ground point');
          return -2;
        }
        f64(b, out, 2).set(r);
        return 0;
      }),
    csm_i2g: (b, h, x, y, hae, out) =>
      run(h, () => {
        const r = csm.i2g1(h, x, y, hae);
        if (!r) {
          errors.set(h, csm.lastError() || 'the line of sight misses the surface');
          return -2;
        }
        f64(b, out, 3).set(r);
        return 0;
      }),
    csm_partials: (b, h, lat, lon, hae, out, cap) =>
      run(h, () => {
        const n = infoOf(h).params.length;
        const v = csm.partials(h, lat, lon, hae, n);
        f64(b, out, Math.min(cap, v.length)).set(v.subarray(0, Math.min(cap, v.length)));
        return v.length / 2;
      }),
    csm_with_params: (b, h, p, n) => run(h, () => remember(csm.withParams(h, f64(b, p, n).slice()))),
    csm_unmodelled: (b, h, x, y, out) =>
      run(h, () => {
        f64(b, out, 3).set(csm.unmodelled(h, x, y));
        return 0;
      }),
    csm_meta: (b, h, out, cap) =>
      run(h, () => {
        const m = infoOf(h);
        const n = m.params.length;
        // No a priori covariance is stated. usgscsm ISDs carry none: getParameterCovariance gives
        // usgscsm's built-in defaults (identity for the frame model, a fixed table for the line
        // scanner), which are not the image's accuracy, so measurements say "error not available"
        // rather than a CE90 from them. A triangulated model gets its posterior from the adjustment.
        const v = [n, m.hmin, m.hmax, m.a, m.b, 0];
        f64(b, out, Math.min(cap, v.length)).set(v.slice(0, Math.min(cap, v.length)));
        return v.length;
      }),
    csm_names: (b, h, out, cap) =>
      run(h, () => {
        const m = infoOf(h);
        const name = csmModelName(m.model);
        const lines = [name, ...m.params.map((p) => paramLabel(p))];
        return write(b, out, cap, enc.encode(lines.join('\n')));
      }),
    csm_load: (b, p, n) =>
      run(0, () => {
        // The state is copied out of the caller's memory before usgscsm runs.
        const state = new Uint8Array(b.mem, p, n).slice();
        return remember(csm.fromState(state));
      }),
    csm_error: (b, h, out, cap) => write(b, out, cap, enc.encode(errors.get(h) ?? '')),
    csm_free: (b, h) => {
      if (live(h)) csm.free(h);
      gen.delete(h);
      meta.delete(h);
      errors.delete(h);
    },
  };
  globalThis.__gwCsmBridge = bridge;
  return bridge;
}

/** A parameter's name with its unit, as usgscsm states them ("IT Pos. Bias (m)"). */
export function paramLabel(p) {
  const name = String(p.name ?? '').trim();
  const u = String(p.units ?? '').trim();
  return u && !name.includes(`(${u})`) ? `${name} (${u})` : name;
}

/** The GIS Workbench model name of a usgscsm model (an identifier; formats/model-names.js shows it). */
export function csmModelName(model) {
  const kind = { USGS_ASTRO_FRAME_SENSOR_MODEL: 'frame camera', USGS_ASTRO_LINE_SCANNER_SENSOR_MODEL: 'line scanner', USGS_ASTRO_PUSH_FRAME_SENSOR_MODEL: 'push frame', USGS_ASTRO_SAR_SENSOR_MODEL: 'SAR' }[model];
  return kind ? `CSM ${kind} (usgscsm)` : `CSM ${model} (usgscsm)`;
}
