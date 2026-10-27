// Wrapper over the eager `core` bundle (geodesy + sensor point API). The same module runs
// synchronously on the main thread for cursor read-outs (REQ-RUST-10, REQ-PRF-04) and in
// every worker. All numbers come from here, never from JavaScript re-implementations.

import { Bundle, WasmError } from './abi.js';

export const FMT = { DD: 0, DMS: 1, DDM: 2, MGRS: 3, UTM: 4, USNG: 5, GARS: 6, GEOREF: 7 };

const BATCH = 1 << 20; // points per core call in g2iBatch / i2gBatch

export class Core extends Bundle {
  constructor(module) {
    super(module, 'core');
  }

  // ---- coordinates ----
  mgrs(lat, lon, prec = 5) {
    return this.guard(() => {
      this.check(this.x.gw_mgrs_forward(lat, lon, prec), 'mgrs');
      return this.outText();
    });
  }

  mgrsToLatLon(s) {
    return this.guard(() =>
      this.withStr(s, (p, n) => {
        const { r, v } = this.outF64(4, (o) => this.x.gw_mgrs_reverse(p, n, o));
        this.check(r, 'mgrsReverse');
        return { lat: v[0], lon: v[1], cellM: v[2], digits: v[3] };
      }),
    );
  }

  format(lat, lon, fmt, prec) {
    return this.guard(() => {
      this.check(this.x.gw_coord_format(lat, lon, fmt, prec), 'format');
      return this.outText();
    });
  }

  /** Parse typed coordinates in any supported format (REQ-GEO-07). */
  parse(text, lonFirst = false) {
    return this.guard(() =>
      this.withStr(text, (p, n) => {
        this.check(this.x.gw_coord_parse(p, n, lonFirst ? 1 : 0), 'parse');
        return this.outJson();
      }),
    );
  }

  utm(lat, lon, zone = -1) {
    return this.guard(() => {
      const { r, v } = this.outF64(6, (o) => this.x.gw_utm_forward(lat, lon, zone, o));
      this.check(r, 'utm');
      return { zone: v[0], north: v[1] === 1, easting: v[2], northing: v[3], gamma: v[4], k: v[5] };
    });
  }

  /** UTM/UPS (zone 0) easting/northing → {lat, lon, gamma, k}; throws outside the zone. */
  utmReverse(zone, north, e, n) {
    const { r, v } = this.outF64(4, (o) => this.x.gw_utm_reverse(zone, north ? 1 : 0, e, n, o));
    this.check(r, 'utmReverse');
    return { lat: v[0], lon: v[1], gamma: v[2], k: v[3] };
  }

  // ---- geodesics and geometry ----
  inverse(lat1, lon1, lat2, lon2) {
    const { v } = this.outF64(3, (o) => this.x.gw_geodesic_inverse(lat1, lon1, lat2, lon2, o));
    return { distance: v[0], azi1: v[1], azi2: v[2] };
  }

  direct(lat1, lon1, azi1, s12) {
    const { v } = this.outF64(3, (o) => this.x.gw_geodesic_direct(lat1, lon1, azi1, s12, o));
    return { lat: v[0], lon: v[1], azi2: v[2] };
  }

  /** pts: [[lat, lon], …] → {area m², perimeter m}. */
  polygonArea(pts) {
    const flat = pts.flat();
    const [p, n] = this.putF64(flat);
    try {
      const { v } = this.outF64(2, (o) => this.x.gw_polygon_area(p, pts.length, o));
      return { area: v[0], perimeter: v[1] };
    } finally {
      this.free(p, n);
    }
  }

  /** Square a building ring [[lon, lat, h], …] (REQ-EXT-05) → {ring, maxCornerErrorDeg, axisDeg, method}. */
  squareRing(ring, diagonals = false) {
    return this.guard(() => {
      const [p, n] = this.putF64(ring.flat());
      try {
        this.check(this.x.gw_square_ring(p, ring.length, diagonals ? 1 : 0), 'squareRing');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Medial axis of a ring [[lon, lat, h], …] (REQ-MEN-08) → {length, meanWidth, maxWidth, minWidth, cellM, path}. */
  medialAxis(ring, cells = 600) {
    return this.guard(() => {
      const [p, n] = this.putF64(ring.flat());
      try {
        this.check(this.x.gw_medial_axis(p, ring.length, cells), 'medialAxis');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }

  polylineLength(pts) {
    const [p, n] = this.putF64(pts.flat());
    try {
      return this.x.gw_polyline_length(p, pts.length);
    } finally {
      this.free(p, n);
    }
  }

  ecef(lat, lon, h) {
    return Array.from(this.outF64(3, (o) => this.x.gw_geodetic_to_ecef(lat, lon, h, o)).v);
  }

  enu(lat, lon, h, lat0, lon0, h0) {
    return Array.from(this.outF64(3, (o) => this.x.gw_geodetic_to_enu(lat, lon, h, lat0, lon0, h0, o)).v);
  }

  slant(a, b) {
    const { v } = this.outF64(3, (o) => this.x.gw_slant_geometry(a.lat, a.lon, a.h, b.lat, b.lon, b.h, o));
    return { slant: v[0], elevation: v[1], depression: v[2] };
  }

  curvatureDrop(d, k = 0.13) {
    return this.x.gw_curvature_drop(d, k);
  }

  ce90(see, sen, snn) {
    return this.x.gw_ce90(see, sen, snn);
  }

  ce95(see, sen, snn) {
    return this.x.gw_ce95(see, sen, snn);
  }

  le90(sv) {
    return this.x.gw_le90(sv);
  }

  ellipse(see, sen, snn) {
    const { v } = this.outF64(3, (o) => this.x.gw_error_ellipse(see, sen, snn, o));
    return { sigmaMax: v[0], sigmaMin: v[1], azimuth: v[2] };
  }

  sun(unixUtc, lat, lon) {
    const { v } = this.outF64(2, (o) => this.x.gw_sun_position(unixUtc, lat, lon, o));
    return { azimuth: v[0], elevation: v[1] };
  }

  gpsToUnix(gps) {
    return this.x.gw_gps_to_unix_utc(gps);
  }

  // ---- geoid ----
  loadGeoid(bytes, { kind = 0, width = 1440, height = 721, name = 'EGM96' } = {}) {
    return this.guard(() => {
      const [p, n] = this.put(bytes);
      try {
        this.withStr(name, (np, nn) => this.check(this.x.gw_geoid_load(p, n, kind, width, height, np, nn), 'geoid'));
      } finally {
        this.free(p, n);
      }
      this.geoidName = name;
    });
  }

  undulation(lat, lon) {
    return this.x.gw_geoid_undulation(lat, lon);
  }

  // ---- sensor models ----
  _id(r) {
    if (r <= 0) throw new WasmError(-r, this.lastError(), 'model');
    return r;
  }

  rpcModel(record) {
    return this.guard(() => {
      const [p, n] = this.putF64(record);
      try {
        return this._id(this.x.gw_model_rpc(p, record.length));
      } finally {
        this.free(p, n);
      }
    });
  }

  geotransformModel(gt, epsg) {
    return this.guard(() => {
      const [p, n] = this.putF64(gt);
      try {
        return this._id(this.x.gw_model_geotransform(p, epsg));
      } finally {
        this.free(p, n);
      }
    });
  }

  /** gcps: [{x, y, lat, lon}]; kind 1–3 polynomial order, 4 projective. */
  gcpModel(gcps, kind, name = '') {
    return this.guard(() => {
      const [p, n] = this.putF64(gcps.flatMap((g) => [g.x, g.y, g.lat, g.lon]));
      try {
        return this.withStr(name, (np, nn) => this._id(this.x.gw_model_gcp(p, gcps.length, kind, np, nn)));
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Frame camera (REQ-SNS-04/14): camera {focalMm, pixelMm, cx, cy, k:[3], p:[2], width, height}, eo {lat, lon, h, omega, phi, kappa}. */
  frameModel(camera, eo, name = '') {
    const c = camera;
    const prm = [c.focalMm, c.pixelMm, c.cx, c.cy, ...(c.k ?? [0, 0, 0]), ...(c.p ?? [0, 0]), c.width, c.height, eo.lat, eo.lon, eo.h, eo.omega ?? 0, eo.phi ?? 0, eo.kappa ?? 0];
    return this.guard(() => {
      const [p, n] = this.putF64(prm);
      try {
        return this.withStr(name, (np, nn) => this._id(this.x.gw_model_frame(p, prm.length, np, nn)));
      } finally {
        this.free(p, n);
      }
    });
  }

  /** KLV frame model (REQ-SNS-20): {lat, lon, hae, heading, pitch, roll, az, el, sroll, hfov, width, height}. */
  klvModel(k, name = '') {
    const prm = [k.lat, k.lon, k.hae, k.heading ?? 0, k.pitch ?? 0, k.roll ?? 0, k.az ?? 0, k.el ?? 0, k.sroll ?? 0, k.hfov, k.width, k.height];
    return this.guard(() => {
      const [p, n] = this.putF64(prm);
      try {
        return this.withStr(name, (np, nn) => this._id(this.x.gw_model_klv(p, prm.length, np, nn)));
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Pushbroom (REQ-SNS-04): camera as frameModel, {origin {lat, lon, h}, p0, v, a, angles, rates, lineTime}. */
  pushbroomModel(camera, o, name = '') {
    const c = camera;
    const prm = [c.focalMm, c.pixelMm, c.cx, c.cy, ...(c.k ?? [0, 0, 0]), ...(c.p ?? [0, 0]), c.width, c.height, o.origin.lat, o.origin.lon, o.origin.h, ...o.p0, ...o.v, ...(o.a ?? [0, 0, 0]), ...o.angles, ...(o.rates ?? [0, 0, 0]), o.lineTime];
    return this.guard(() => {
      const [p, n] = this.putF64(prm);
      try {
        return this.withStr(name, (np, nn) => this._id(this.x.gw_model_pushbroom(p, prm.length, np, nn)));
      } finally {
        this.free(p, n);
      }
    });
  }

  /** RSM polynomial (REQ-SNS-03, experimental): {domain 0|1|2, origin, axes (9), off (5), scale (5), rows, cols, polys: 4 × {px, py, pz, c}}. */
  rsmModel(r) {
    const prm = [r.domain ?? 0, ...(r.origin ?? [0, 0, 0]), ...(r.axes ?? [0, 0, 0, 0, 0, 0, 0, 0, 0]), ...r.off, ...r.scale, r.rows, r.cols];
    for (const q of r.polys) prm.push(q.px, q.py, q.pz, q.c.length, ...q.c);
    return this.guard(() => {
      const [p, n] = this.putF64(prm);
      try {
        return this._id(this.x.gw_model_rsm(p, prm.length));
      } finally {
        this.free(p, n);
      }
    });
  }

  /** SICD Volume 3 / SIDD PlaneProjection model from the parse bundle's record (REQ-SAR-05). */
  sicdModel(record, name = '') {
    return this.guard(() => {
      const [p, n] = this.putF64(record);
      try {
        return this.withStr(name, (np, nn) => this._id(this.x.gw_model_sicd(p, record.length, np, nn)));
      } finally {
        this.free(p, n);
      }
    });
  }

  /**
   * SICD helpers (REQ-SAR-05): op 'plane' (image → ground plane through the SCP), 'hae' (image →
   * constant HAE) take [[x, y, h]] and return ECF; 'scene' takes ECF [[X, Y, Z]] and returns
   * [x, y, Δgp]. NaN where there is no solution.
   */
  sicdProject(id, op, pts) {
    return this.guard(() => {
      const flat = pts.flat();
      const [p, n] = this.putF64(flat);
      try {
        const { r, v } = this.outF64(flat.length, (o) => this.x.gw_sicd_project(id, { plane: 0, hae: 1, scene: 2 }[op], p, pts.length, o));
        this.check(r, 'sicdProject');
        return pts.map((_, i) => [v[3 * i], v[3 * i + 1], v[3 * i + 2]]);
      } finally {
        this.free(p, n);
      }
    });
  }

  /** A model on a sub-window of the base model's image: (x, y) → (x + dx, y + dy). */
  offsetModel(base, dx, dy) {
    return this.guard(() => this._id(this.x.gw_model_offset(base, dx, dy)));
  }

  /** A model corrected by an image-space bias (REQ-SNS-11/15); the base stays registered. */
  adjustedModel(base, c, { centre, half, sigma = NaN, name = '' } = {}) {
    return this.guard(() => {
      const [p, n] = this.putF64(c);
      try {
        return this.withStr(name, (np, nn) => this._id(this.x.gw_model_adjusted(base, p, centre[0], centre[1], half[0], half[1], sigma, np, nn)));
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Multi-image point (REQ-MEN-11): obs [{model, x, y, sigma}] → {lat, lon, h, covEnu, residuals, sigma0, …}. */
  intersect(obs, start = null) {
    return this.guard(() => {
      const [p, n] = this.putF64(obs.flatMap((o) => [o.model, o.x, o.y, o.sigma]));
      try {
        this.check(this.x.gw_intersect(p, obs.length, start?.lat ?? NaN, start?.lon ?? NaN, start?.h ?? NaN), 'intersect');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }

  /** Image-space σ (px) of a measurement: pick σ with the model's horizontal σ over the GSD. */
  observationSigma(id, x, y, h, sigmaPickPx = 0.5) {
    return this.x.gw_observation_sigma(id, x, y, h, sigmaPickPx);
  }

  freeModel(id) {
    this.x.gw_model_free(id);
  }

  modelInfo(id) {
    return this.guard(() => {
      this.check(this.x.gw_model_info(id), 'modelInfo');
      return this.outJson();
    });
  }

  /** One point image → ground at height h. Returns {lat, lon} (NaN on failure). */
  i2g(id, x, y, h) {
    const [p, n] = this.putF64([x, y, h]);
    try {
      const { r, v } = this.outF64(2, (o) => this.x.gw_i2g(id, p, 1, o));
      this.check(r, 'i2g');
      return { lat: v[0], lon: v[1] };
    } finally {
      this.free(p, n);
    }
  }

  g2i(id, lat, lon, h) {
    const [p, n] = this.putF64([lat, lon, h]);
    try {
      const { r, v } = this.outF64(2, (o) => this.x.gw_g2i(id, p, 1, o));
      this.check(r, 'g2i');
      return { x: v[0], y: v[1] };
    } finally {
      this.free(p, n);
    }
  }

  /** Batch: pts Float64Array of (lat, lon, h)·n → Float64Array (x, y)·n. */
  g2iBatch(id, pts) {
    const n = pts.length / 3;
    // Large batches go through the 256 MiB core in 1 M-point chunks (TE-044).
    if (n > BATCH) {
      const out = new Float64Array(2 * n);
      for (let k = 0; k < n; k += BATCH) out.set(this.g2iBatch(id, pts.subarray(3 * k, 3 * Math.min(n, k + BATCH))), 2 * k);
      return out;
    }
    const [p, pl] = this.putF64(pts);
    const o = this.x.gw_alloc(n * 16);
    try {
      this.check(this.x.gw_g2i(id, p, n, o), 'g2i');
      return new Float64Array(this.mem, o, 2 * n).slice();
    } finally {
      this.free(p, pl);
      this.free(o, n * 16);
    }
  }

  i2gBatch(id, pts) {
    const n = pts.length / 3;
    // Large batches go through the 256 MiB core in 1 M-point chunks (TE-044).
    if (n > BATCH) {
      const out = new Float64Array(2 * n);
      for (let k = 0; k < n; k += BATCH) out.set(this.i2gBatch(id, pts.subarray(3 * k, 3 * Math.min(n, k + BATCH))), 2 * k);
      return out;
    }
    const [p, pl] = this.putF64(pts);
    const o = this.x.gw_alloc(n * 16);
    try {
      this.check(this.x.gw_i2g(id, p, n, o), 'i2g');
      return new Float64Array(this.mem, o, 2 * n).slice();
    } finally {
      this.free(p, pl);
      this.free(o, n * 16);
    }
  }

  pointError(id, x, y, h, sigmaPickPx = 0.5, sigmaDemV = NaN) {
    return this.guard(() => {
      this.check(this.x.gw_point_error(id, x, y, h, sigmaPickPx, sigmaDemV), 'pointError');
      return this.outJson();
    });
  }

  // ---- DEMs ----
  loadDem({ lat0, lon0, dlat, dlon, width, height, heights, hae = false, sigmaV = NaN }) {
    return this.guard(() => {
      const [p, n] = this.putF32(heights);
      try {
        return this._id(this.x.gw_dem_load(lat0, lon0, dlat, dlon, width, height, p, hae ? 1 : 0, sigmaV));
      } finally {
        this.free(p, n);
      }
    });
  }

  freeDem(id) {
    this.x.gw_dem_free(id);
  }

  demHae(id, lat, lon) {
    return this.x.gw_dem_sample_hae(id, lat, lon);
  }

  rayDem(model, dem, x, y) {
    return this.guard(() => {
      this.check(this.x.gw_ray_dem(model, dem, x, y), 'rayDem');
      return this.outJson();
    });
  }
}
