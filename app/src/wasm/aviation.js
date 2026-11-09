// `aviation` bundle wrapper (analysis worker, REQ-GAP-73): airfield obstruction surfaces of FAA
// Part 77 and ICAO Annex 14 (crates/gw-aviation). `def` is the definition list of
// analysis/obstruction.js encodeAirport().

import { Bundle } from './abi.js';

export class AviationBundle extends Bundle {
  constructor(module) {
    super(module, 'aviation');
  }

  putF64(arr) {
    // An empty list would be handed over at an unaligned dangling pointer.
    if (!arr?.length) throw new Error('obstruction surfaces: an empty list');
    return super.putF64(arr);
  }

  /** {surfaces: [{kind, runway, end, slopes}], bbox: [s, w, n, e], horizontal, conicalTop, facets: [{s, ring}]}. */
  surfaces(def) {
    return this.guard(() => {
      const [a, an] = this.putF64(def);
      try {
        this.check(this.x.gw_obs_surfaces(a, def.length), 'obsSurfaces');
        return decodeSurfaces(this.outBytes());
      } finally {
        this.free(a, an);
      }
    });
  }

  /**
   * Limiting height (Float32Array, NaN none) and surface index (Uint8Array, 255 none) per post, and
   * with an obstacle-free zone its own zoneLimit and zoneSid.
   */
  grid(def, geo, z) {
    return this.guard(() => {
      const [a, an] = this.putF64(def);
      const [b, bn] = this.putF64(geo);
      const [c, cn] = this.putF32(z);
      try {
        this.check(this.x.gw_obs_grid(a, def.length, b, c, z.length), 'obsGrid');
        return split(this.outBytes(), z.length);
      } finally {
        this.free(a, an);
        this.free(b, bn);
        this.free(c, cn);
      }
    });
  }

  /** As grid() for [lat, lon] pairs. */
  points(def, ll) {
    return this.guard(() => {
      const [a, an] = this.putF64(def);
      const [b, bn] = this.putF64(ll);
      try {
        this.check(this.x.gw_obs_points(a, def.length, b, ll.length), 'obsPoints');
        return split(this.outBytes(), ll.length / 2);
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }

  /** f64 heights and surface indices (−1 none), lowest and zone, for [lat, lon] pairs (oracle comparisons). */
  points64(def, ll) {
    return this.guard(() => {
      const [a, an] = this.putF64(def);
      const [b, bn] = this.putF64(ll);
      try {
        this.check(this.x.gw_obs_points64(a, def.length, b, ll.length), 'obsPoints64');
        const o = this.outBytes();
        const f = new Float64Array(o.buffer, o.byteOffset, o.byteLength / 8);
        const n = f.length / 4;
        const limit = new Float64Array(n);
        const sid = new Int16Array(n);
        const zoneLimit = new Float64Array(n);
        const zoneSid = new Int16Array(n);
        for (let k = 0; k < n; k++) {
          limit[k] = f[4 * k];
          sid[k] = f[4 * k + 1];
          zoneLimit[k] = f[4 * k + 2];
          zoneSid[k] = f[4 * k + 3];
        }
        return { limit, sid, zoneLimit, zoneSid };
      } finally {
        this.free(a, an);
        this.free(b, bn);
      }
    });
  }
}

function split(o, n) {
  const list = (at) => ({ limit: new Float32Array(o.buffer.slice(o.byteOffset + at, o.byteOffset + at + 4 * n)), sid: o.slice(at + 4 * n, at + 5 * n) });
  const low = list(0);
  if (o.length < 10 * n || !n) return low;
  const zone = list(5 * n);
  return { ...low, zoneLimit: zone.limit, zoneSid: zone.sid };
}

const KINDS = ['primary', 'approach', 'transitional', 'horizontal', 'conical', 'strip', 'innerHorizontal', 'takeoff', 'innerApproach', 'innerTransitional', 'balkedLanding', 'ofzStrip', 'straightIn', 'precisionApproach', 'precisionMissedApproach', 'precisionTransitional', 'precisionLower', 'departure'];
/**
 * The f64 list of gw_obs_surfaces → {surfaces, bbox, horizontal, conicalTop, facets, assumed}:
 * `assumed` holds the Amendment 18 assumption bits the model made (analysis/obstruction.js
 * A18_ASSUMPTIONS); horizontal and conicalTop are NaN for Amendment 18.
 */
function decodeSurfaces(o) {
  const v = new Float64Array(o.buffer, o.byteOffset, o.byteLength / 8);
  let k = 0;
  const surfaces = [];
  for (let n = v[k++]; n > 0; n--) {
    const kind = KINDS[v[k++]];
    const runway = v[k++];
    const end = v[k++];
    const ns = v[k++];
    surfaces.push({ kind, runway, end, slopes: [...v.subarray(k, k + ns)] });
    k += ns;
  }
  const bbox = [...v.subarray(k, k + 4)];
  k += 4;
  const horizontal = v[k++];
  const conicalTop = v[k++];
  const facets = [];
  for (let n = v[k++]; n > 0; n--) {
    const s = v[k++];
    const nv = v[k++];
    const ring = [];
    for (let i = 0; i < nv; i++, k += 3) ring.push([v[k], v[k + 1], v[k + 2]]);
    facets.push({ s, ring });
  }
  const assumed = k < v.length ? v[k] : 0;
  return { surfaces, bbox, horizontal, conicalTop, facets, assumed };
}
