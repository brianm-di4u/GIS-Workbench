// `geod` bundle wrapper (main thread): grid datum and height transformations and
// time-dependent frame transformations (REQ-GAP-16). Points are [lon°, lat°, h m] triples.

import { Bundle } from './abi.js';

export const ROLE = { horizontal: 0, vertical: 1, generic: 2 };
export const KIND = { hgridshift: 0, gridshift: 1, vgridshift: 2 };

export class GeodBundle extends Bundle {
  constructor(module) {
    super(module, 'geod');
  }

  /** Open a grid file (GeoTIFF, NTv2 .gsb, GTX) for a role; returns its id. */
  open(bytes, role, name, { cacheMb = 64 } = {}) {
    return this.guard(() => {
      const [p, n] = this.put(bytes);
      try {
        const id = this.withStr(name, (np, nn) => this.x.gw_grid_open(p, n, ROLE[role] ?? 2, np, nn, cacheMb));
        if (id <= 0) this.check(-id, 'grid_open');
        return id;
      } finally {
        this.free(p, n);
      }
    });
  }

  close(id) {
    this.x.gw_grid_free(id);
  }

  /** {name, format, role, cachedBytes, grids: [{name, width, height, type, biquadratic, children, west, south, east, north, resX, resY}]} */
  info(id) {
    return this.guard(() => {
      this.check(this.x.gw_grid_info(id), 'grid_info');
      const info = this.outJson();
      const n = info.grids.length;
      const { v } = this.outF64(6 * n, (o) => this.x.gw_grid_extents(id, o, 6 * n));
      info.grids.forEach((g, k) => Object.assign(g, { west: v[6 * k], south: v[6 * k + 1], east: v[6 * k + 2], north: v[6 * k + 3], resX: v[6 * k + 4], resY: v[6 * k + 5] }));
      return info;
    });
  }

  /**
   * Apply grids to points. kind 'hgridshift' | 'gridshift' | 'vgridshift'; ids = grid ids in
   * the order PROJ lists them. Options: inverse, interpolation ('bilinear'|'biquadratic', or
   * 'cubic': Catmull-Rom for vgridshift, which PROJ lacks),
   * noZ, multiplier (vgridshift; PROJ default −1). Returns {pts, failed, grids: {name: count}};
   * a point outside every grid (or on nodata) comes back as NaN.
   */
  apply(kind, ids, pts, { inverse = false, interpolation = null, noZ = false, multiplier = -1 } = {}) {
    return this.guard(() => {
      const n = pts.length;
      const flat = new Float64Array(3 * n);
      pts.forEach((q, i) => flat.set([q[0], q[1], q[2] ?? 0], 3 * i));
      const [a, an] = this.putF64(flat);
      const idArr = new Int32Array(ids);
      const ip = this.x.gw_alloc(idArr.byteLength);
      new Int32Array(this.mem, ip, idArr.length).set(idArr);
      try {
        const flags = interpolation === 'cubic' ? 8 | (noZ ? 4 : 0) : (interpolation ? 1 : 0) | (interpolation === 'biquadratic' ? 2 : 0) | (noZ ? 4 : 0);
        this.check(this.x.gw_grid_apply(KIND[kind], ip, idArr.length, inverse ? 1 : 0, a, n, flags, multiplier), 'grid_apply');
        const r = new Float64Array(this.mem, a, 3 * n).slice();
        const meta = this.outJson();
        return { pts: pts.map((_, i) => [r[3 * i], r[3 * i + 1], r[3 * i + 2]]), failed: meta.failed, grids: meta.grids };
      } finally {
        this.free(a, an);
        this.free(ip, idArr.byteLength);
      }
    });
  }

  /** Grid value × multiplier at one point (NaN outside or on nodata): geoid N with multiplier 1; Catmull-Rom when cubic. */
  value(id, lon, lat, multiplier = 1, cubic = false) {
    return this.x.gw_vgrid_value(id, lon, lat, multiplier, cubic ? 1 : 0);
  }

  /** [{name, geocentric, geographic3d, geographic2d, ellipsoid}] */
  frames() {
    return this.guard(() => {
      this.check(this.x.gw_frames(), 'frames');
      return this.outJson();
    });
  }

  /** The EPSG operation chain between two frames (names or EPSG codes). */
  framePath(src, dst) {
    return this.guard(() => {
      this.withStr(String(src), (sp, sn) => this.withStr(String(dst), (dp, dn) => this.check(this.x.gw_frame_path(sp, sn, dp, dn), 'frame_path')));
      return pathOf(this.outJson());
    });
  }

  /** Transform [lon, lat, h] between frames at a coordinate epoch (decimal year, or null). */
  frameTransform(src, dst, pts, epoch = null) {
    return this.guard(() => {
      const n = pts.length;
      const flat = new Float64Array(3 * n);
      pts.forEach((q, i) => flat.set([q[0], q[1], q[2] ?? 0], 3 * i));
      const [a, an] = this.putF64(flat);
      try {
        this.withStr(String(src), (sp, sn) => this.withStr(String(dst), (dp, dn) => this.check(this.x.gw_frame_transform(sp, sn, dp, dn, epoch ?? NaN, a, n), 'frame_transform')));
        const r = new Float64Array(this.mem, a, 3 * n).slice();
        return { pts: pts.map((_, i) => [r[3 * i], r[3 * i + 1], r[3 * i + 2]]), path: pathOf(this.outJson()) };
      } finally {
        this.free(a, an);
      }
    });
  }
}

const pathOf = (p) => ({ ...p, accuracy: p.accuracyUm == null ? NaN : p.accuracyUm / 1e6, steps: p.steps.map((s) => ({ ...s, accuracy: s.accuracyUm == null ? NaN : s.accuracyUm / 1e6 })) });
