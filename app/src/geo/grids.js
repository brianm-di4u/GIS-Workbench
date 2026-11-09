// Grid-based datum and height transformations and time-dependent frames (REQ-GAP-16, SDP-2.3
// GR-05). The arithmetic is the `geod` WASM bundle (crates/gw-geodesy/src/datum, PROJ 9.9's
// interpolation, held to 1 mm of PROJ cct by tests/golden/grids.test.js). This module knows the
// grid packs' catalogues (grids.json), opens grids on first use, and chains them with the EPSG
// frame transformations into routes from a legacy or regional datum to WGS 84 at an epoch.
//
// A route is [grid steps…] then a frame path. Each step carries its EPSG code, name and EPSG's
// accuracy; a route's accuracy is their sum (the EPSG convention for concatenated operations).

import { GeodBundle } from '../wasm/geod.js';
import { gwError } from '../i18n/index.js';

/** The realisation the app means by "WGS 84" (current since 2024-01-07, ≡ ITRF2020). */
export const WGS84_NOW = 'WGS 84 (G2296)';

/** Decimal year of a Date (UTC). */
export function decimalYear(d = new Date()) {
  const y = d.getUTCFullYear();
  const a = Date.UTC(y, 0, 1);
  const b = Date.UTC(y + 1, 0, 1);
  return y + (d.getTime() - a) / (b - a);
}

/**
 * Horizontal datum routes. `grids`: alternative chains tried in order per point (the first
 * whose grids all hold the point wins); each chain ends in `frame` (a frame of the geod
 * bundle). `ensemble`: extra accuracy (m) when the datum is an ensemble realised as `frame`.
 */
export const ROUTES = {
  NAD27: {
    name: 'NAD27',
    chains: [
      { grids: ['us_noaa_nadcon5_nad27_nad83_1986_conus', 'us_noaa_nadcon5_nad83_1986_nad83_harn_conus', 'us_noaa_nadcon5_nad83_harn_nad83_fbn_conus', 'us_noaa_nadcon5_nad83_fbn_nad83_2007_conus', 'us_noaa_nadcon5_nad83_2007_nad83_2011_conus'], frame: 'NAD83(2011)' },
      { grids: ['ca_nrc_ntv2_0'], frame: null },
    ],
  },
  NAD83: { name: 'NAD83', chains: [{ grids: ['us_noaa_nadcon5_nad83_1986_nad83_harn_conus', 'us_noaa_nadcon5_nad83_harn_nad83_fbn_conus', 'us_noaa_nadcon5_nad83_fbn_nad83_2007_conus', 'us_noaa_nadcon5_nad83_2007_nad83_2011_conus'], frame: 'NAD83(2011)' }] },
  'NAD83(HARN)': { name: 'NAD83(HARN)', chains: [{ grids: ['us_noaa_nadcon5_nad83_harn_nad83_fbn_conus', 'us_noaa_nadcon5_nad83_fbn_nad83_2007_conus', 'us_noaa_nadcon5_nad83_2007_nad83_2011_conus'], frame: 'NAD83(2011)' }] },
  'NAD83(2011)': { name: 'NAD83(2011)', chains: [{ grids: [], frame: 'NAD83(2011)' }] },
  OSGB36: { name: 'OSGB36', chains: [{ grids: ['uk_os_OSTN15_NTv2_OSGBtoETRS'], frame: 'ETRF2014', ensemble: 0.1, via: 'ETRS89' }] },
  DHDN: { name: 'DHDN', chains: [{ grids: ['de_adv_BETA2007'], frame: 'ETRF2014', ensemble: 0.1, via: 'ETRS89' }] },
  GDA94: { name: 'GDA94', chains: [{ grids: ['au_icsm_GDA94_GDA2020_conformal'], frame: 'GDA2020' }] },
  GDA2020: { name: 'GDA2020', chains: [{ grids: [], frame: 'GDA2020' }] },
  ETRS89: { name: 'ETRS89', chains: [{ grids: [], frame: 'ETRF2014', ensemble: 0.1, via: 'ETRS89' }] },
};

/** The grid-catalogue accuracy of a grid step, using the step that ends in a frame (not "to WGS 84"). */
function stepOf(g, toFrame) {
  // ca_nrc_ntv2_0, OSTN15 and BeTA2007 carry EPSG's direct "to WGS 84" operation as their main
  // entry and the "to NAD83/ETRS89" one in alsoEpsg; a chain that continues into a frame uses the latter.
  if (toFrame && g.alsoEpsg?.length) {
    const [epsg, name, accuracy] = g.alsoEpsg[0];
    return { epsg, name, accuracy };
  }
  return { epsg: g.epsg, name: g.name, accuracy: g.accuracy };
}

/** Recognise a datum from an EPSG code, a PROJ.4 string or a WKT; returns a ROUTES key or null. */
export function datumKeyOf({ epsg = null, def = '', wkt = '' } = {}) {
  const e = Number(epsg);
  if (e) {
    if (e === 4267 || (e > 26700 && e < 26723) || (e >= 26729 && e <= 26799) || (e >= 32001 && e <= 32099)) return 'NAD27';
    if (e === 4269 || (e > 26900 && e < 26924) || (e >= 26929 && e <= 26998) || (e >= 32100 && e <= 32161) || e === 2229 || e === 2230 || e === 5070) return 'NAD83';
    if (e === 4152 || (e >= 2759 && e <= 2866) || (e >= 3740 && e <= 3760)) return 'NAD83(HARN)';
    if (e === 6318 || e === 6319 || (e >= 6328 && e <= 6348)) return 'NAD83(2011)';
    if (e === 4277 || e === 27700) return 'OSGB36';
    if (e === 4314 || (e >= 31466 && e <= 31469)) return 'DHDN';
    if (e === 4283 || (e > 28347 && e < 28359)) return 'GDA94';
    if (e === 7844 || e === 7843 || (e > 7845 && e < 7860)) return 'GDA2020';
    if (e === 4258 || e === 4937 || (e > 25827 && e < 25839) || e === 3035 || e === 3034) return 'ETRS89';
  }
  const t = `${wkt} ${def}`;
  if (/NAD83\s*\(\s*2011\s*\)|NAD_1983_2011/i.test(t)) return 'NAD83(2011)';
  if (/NAD83\s*\(\s*HARN\s*\)|NAD_1983_HARN/i.test(t)) return 'NAD83(HARN)';
  if (/North.?American.?Datum.?1927|NAD27|NAD_1927/i.test(t)) return 'NAD27';
  if (/NAD83\s*\(\s*(CSRS|NSRS2007|FBN|PA11|MA11)/i.test(t)) return null;
  if (/North.?American.?Datum.?1983|NAD83|NAD_1983/i.test(t)) return 'NAD83';
  if (/OSGB.?1936|OSGB36/i.test(t)) return 'OSGB36';
  if (/Deutsches.?Hauptdreiecksnetz|DHDN/i.test(t)) return 'DHDN';
  if (/GDA2020|Geocentric.?Datum.?of.?Australia.?2020/i.test(t)) return 'GDA2020';
  if (/GDA94|Geocentric.?Datum.?of.?Australia.?1994/i.test(t)) return 'GDA94';
  if (/ETRS.?89|European.?Terrestrial/i.test(t)) return 'ETRS89';
  return null;
}

/** Vertical datums the hybrid geoid grids define, keyed as the app's `vertical` values. */
export const VERTICALS = {
  navd88: { grid: 'us_noaa_g2018u0', datum: 'NAD83(2011)', name: 'NAVD88' },
  odn: { grid: 'uk_os_OSGM15_GB', datum: 'ETRS89', name: 'ODN' },
  ahd: { grid: 'au_ga_AUSGeoid2020_20180201', datum: 'GDA2020', name: 'AHD' },
  cgvd2013: { grid: 'ca_nrc_CGG2013an83', datum: 'NAD83(CSRS)v7', name: 'CGVD2013' },
  egm2008: { grid: 'us_nga_egm08_25', datum: 'WGS 84', name: 'EGM2008' },
};

/** Parse "lat lon [h]" lines (spaces, commas or semicolons). */
export function parsePoints(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const v = line.trim().split(/[\s,;]+/).filter(Boolean).map(Number);
    if (!v.length) continue;
    if (v.length < 2 || v.some((x) => !Number.isFinite(x)) || Math.abs(v[0]) > 90 || Math.abs(v[1]) > 360) throw gwError('Line “{line}” is not latitude, longitude and an optional height in decimal degrees and metres', { line: line.trim() }, 'E_DATUM_POINT');
    out.push([v[1], v[0], v[2] ?? 0]);
  }
  return out;
}

/**
 * Grids interpolated Catmull-Rom bicubic rather than PROJ's bilinear (REG-024): EGM2008 2.5′,
 * whose worst bilinear error is 13.5 cm against 3.1 cm cubic (GeographicLib's figures).
 */
const CUBIC = new Set(['us_nga_egm08_25']);

export class GridEngine {
  constructor(app) {
    this.app = app;
    this.bundle = null;
    this.catalogue = new Map(); // grid id → {id, file, op, …, pack}
    this.open = new Map(); // grid id → WASM grid set id
    this.packs = new Map(); // pack name → pack record
    this.epoch = decimalYear();
    this.listeners = new Set();
    this.datumKeyOf = datumKeyOf;
  }

  /** Instantiate the WASM bundle (lazy block wasm-geod). */
  async ensure() {
    if (this.bundle) return this.bundle;
    const mod = await this.app.gw.wasm('wasm-geod');
    this.bundle = new GeodBundle(mod);
    return this.bundle;
  }

  /** Register a verified grid pack (its grids.json catalogue); grids open on first use. */
  async addPack(pack) {
    const raw = pack.entries.get('grids.json');
    if (!raw) return [];
    const cat = JSON.parse(new TextDecoder().decode(raw));
    if (cat.format !== 'gw-grids/1') return [];
    await this.ensure();
    this.packs.set(pack.name, pack);
    for (const g of cat.grids) this.catalogue.set(g.id, { ...g, ...(CUBIC.has(g.id) && { interpolation: 'cubic' }), pack: pack.name });
    this._emit();
    return cat.grids.map((g) => g.id);
  }

  /** A grid the user opened as a plain file (GeoTIFF, .gsb, .gtx): op from its kind. */
  async addFile(name, bytes, op) {
    await this.ensure();
    const id = `file:${name}`;
    const role = op === 'vgridshift' ? 'vertical' : op === 'gridshift' ? 'generic' : 'horizontal';
    const h = this.bundle.open(bytes, role, name);
    this.open.get(id) && this.bundle.close(this.open.get(id));
    this.open.set(id, h);
    const info = this.bundle.info(h);
    this.catalogue.set(id, { id, file: name, op, name, user: true, info });
    this._emit();
    return { id, info };
  }

  has(id) {
    return this.catalogue.has(id);
  }

  /** WASM grid id, opening it from its pack on first use. */
  handle(id) {
    if (this.open.has(id)) return this.open.get(id);
    const g = this.catalogue.get(id);
    if (!g) return null;
    const pack = this.packs.get(g.pack);
    const bytes = pack?.entries.get(g.file);
    if (!bytes) return null;
    const role = g.op === 'vgridshift' ? 'vertical' : g.op === 'gridshift' ? 'generic' : 'horizontal';
    const h = this.bundle.open(bytes, role, g.file, { cacheMb: g.op === 'vgridshift' && /egm08/.test(g.file) ? 96 : 64 });
    this.open.set(id, h);
    return h;
  }

  /** The chains of a datum that are usable now (all their grids loaded). */
  chainsOf(key) {
    const r = ROUTES[key];
    if (!r || !this.bundle) return [];
    return r.chains.filter((c) => c.grids.length > 0 && c.grids.every((g) => this.catalogue.has(g)) || (c.grids.length === 0 && c.frame));
  }

  /** True when a datum has a route through at least one loaded grid. */
  hasGridRoute(key) {
    return this.chainsOf(key).some((c) => c.grids.length > 0);
  }

  /** Describe a chain: steps (grid and frame), total accuracy (m), grid files. */
  describeChain(c, { epoch = this.epoch, target = WGS84_NOW } = {}) {
    const steps = [];
    let acc = 0;
    for (const [k, gid] of c.grids.entries()) {
      const g = this.catalogue.get(gid);
      const last = k === c.grids.length - 1;
      const s = stepOf(g, !last || !!c.frame);
      steps.push({ kind: 'grid', grid: g.file, op: g.op, epsg: s.epsg, name: s.name, accuracy: s.accuracy, interpolation: g.interpolation ?? (g.op === 'gridshift' ? 'biquadratic' : 'bilinear') });
      acc += s.accuracy;
    }
    if (c.ensemble) {
      steps.push({ kind: 'ensemble', name: `${c.via} realised as ${c.frame}`, accuracy: c.ensemble });
      acc += c.ensemble;
    }
    if (c.frame) {
      const p = this.bundle.framePath(c.frame, target);
      for (const s of p.steps) steps.push({ kind: 'frame', epsg: s.epsg, name: s.name, inverse: s.inverse, accuracy: s.accuracy, timeDependent: s.timeDependent });
      acc += Number.isFinite(p.accuracy) ? p.accuracy : NaN;
    }
    return { steps, accuracy: acc, epoch: c.frame && steps.some((s) => s.timeDependent) ? epoch : null, grids: c.grids.map((g) => this.catalogue.get(g).file), target: c.frame ? target : 'WGS 84' };
  }

  /**
   * Datum → WGS 84 (or the reverse) for [lon, lat, h] points. Returns {pts, used: [chain index per
   * point or -1], routes: [described chains]}; a point no chain covers is [NaN, NaN, NaN].
   */
  transformDatum(key, pts, { inverse = false, epoch = this.epoch, target = WGS84_NOW } = {}) {
    const chains = this.chainsOf(key);
    const out = pts.map(() => [NaN, NaN, NaN]);
    const used = pts.map(() => -1);
    let todo = pts.map((_, i) => i);
    chains.forEach((c, ci) => {
      if (!todo.length) return;
      let cur = todo.map((i) => [...pts[i]]);
      const ok = cur.map(() => true);
      const runGrids = (list) => {
        for (const gid of list) {
          const g = this.catalogue.get(gid);
          const h = this.handle(gid);
          const r = this.bundle.apply(g.op, [h], cur, { inverse, noZ: !g.heights, interpolation: g.interpolation === 'cubic' ? 'cubic' : null });
          cur = r.pts.map((p, k) => {
            if (!Number.isFinite(p[0])) ok[k] = false;
            return Number.isFinite(p[0]) ? p : cur[k];
          });
        }
      };
      const runFrame = () => {
        if (!c.frame) return;
        const r = inverse ? this.bundle.frameTransform(target, c.frame, cur, epoch) : this.bundle.frameTransform(c.frame, target, cur, epoch);
        cur = r.pts;
      };
      if (!inverse) {
        runGrids(c.grids);
        runFrame();
      } else {
        runFrame();
        runGrids([...c.grids].reverse());
      }
      const left = [];
      todo.forEach((i, k) => {
        if (ok[k]) {
          out[i] = cur[k];
          used[i] = ci;
        } else left.push(i);
      });
      todo = left;
    });
    return { pts: out, used, routes: chains.map((c) => this.describeChain(c, { epoch, target })) };
  }

  /** Geoid (or hybrid geoid) height N at a point from a loaded grid; NaN outside or on nodata. */
  undulation(gridId, lon, lat) {
    const h = this.handle(gridId);
    return h ? this.bundle.value(h, lon, lat, 1, this.cubic(gridId)) : NaN;
  }

  /** Many undulations at once (one WASM call). */
  undulations(gridId, pts) {
    const h = this.handle(gridId);
    if (!h) return pts.map(() => NaN);
    return this.bundle.apply('vgridshift', [h], pts.map((p) => [p[0], p[1], 0]), { multiplier: 1, interpolation: this.cubic(gridId) ? 'cubic' : null }).pts.map((p) => p[2]);
  }

  /** True when a grid is interpolated Catmull-Rom (EGM2008 2.5′). */
  cubic(gridId) {
    return this.catalogue.get(gridId)?.interpolation === 'cubic';
  }

  /**
   * DEM posts in a vertical datum ('egm2008', 'navd88', 'odn', 'ahd', 'cgvd2013') → heights above
   * the WGS 84 ellipsoid with the loaded geoid grid: h = H + N, plus the ellipsoidal height change
   * from the geoid's frame to WGS 84 (G2296) at the epoch (evaluated on a coarse lattice and
   * interpolated: it changes by well under a millimetre per kilometre). Posts outside the grid
   * fall back to `fallbackN(lat, lon)` (the active global geoid) and are counted. Returns
   * {convert(heights) → Float32Array, label, outside} or null when the grid is not loaded.
   * `g`: {lat0 (north), lon0 (west), dlat, dlon, width, height}.
   */
  demHeights(g, vertical, fallbackN) {
    const v = VERTICALS[vertical];
    if (!v || !this.bundle || !this.has(v.grid)) return null;
    const h = this.handle(v.grid);
    const cubic = this.cubic(v.grid);
    const { width: W, height: H } = g;
    // Frame height change on a lattice of at most 33 × 33 nodes.
    const frame = v.datum === 'WGS 84' ? null : v.datum === 'ETRS89' ? 'ETRF2014' : v.datum;
    const nx = Math.min(33, W);
    const ny = Math.min(33, H);
    const dh = new Float64Array(nx * ny);
    let path = null;
    if (frame) {
      const pts = [];
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push([g.lon0 + ((i * (W - 1)) / Math.max(1, nx - 1)) * g.dlon, g.lat0 - ((j * (H - 1)) / Math.max(1, ny - 1)) * g.dlat, 0]);
      const r = this.bundle.frameTransform(frame, WGS84_NOW, pts, this.epoch);
      r.pts.forEach((p, k) => (dh[k] = p[2]));
      path = r.path;
    }
    const dhAt = (r, c) => {
      if (!frame) return 0;
      const x = nx > 1 ? (c * (nx - 1)) / Math.max(1, W - 1) : 0;
      const y = ny > 1 ? (r * (ny - 1)) / Math.max(1, H - 1) : 0;
      const i = Math.min(nx - 2, Math.floor(x));
      const j = Math.min(ny - 2, Math.floor(y));
      if (nx < 2 || ny < 2) return dh[0];
      const fx = x - i;
      const fy = y - j;
      const a = dh[j * nx + i];
      const b = dh[j * nx + i + 1];
      const cc = dh[(j + 1) * nx + i];
      const d = dh[(j + 1) * nx + i + 1];
      return (1 - fy) * ((1 - fx) * a + fx * b) + fy * ((1 - fx) * cc + fx * d);
    };
    const n = new Float32Array(W * H);
    let outside = 0;
    for (let r = 0; r < H; r++) {
      const lat = g.lat0 - r * g.dlat;
      for (let c = 0; c < W; c++) {
        const lon = g.lon0 + c * g.dlon;
        let N = this.bundle.value(h, lon, lat, 1, cubic);
        if (!Number.isFinite(N)) {
          N = fallbackN ? fallbackN(lat, lon) : NaN;
          outside++;
        }
        n[r * W + c] = N + dhAt(r, c);
      }
    }
    const cat = this.catalogue.get(v.grid);
    const label = frame ? `${v.name} → HAE by ${cat.geoid ?? v.grid} (${cat.file}), ${frame} → ${WGS84_NOW} at ${this.epoch.toFixed(2)}` : `${v.name} → HAE by ${cat.geoid ?? v.grid} (${cat.file})`;
    // Voids (NaN, or sentinels such as −32767) stay as they are.
    return { convert: (heights) => Float32Array.from(heights, (z, k) => (Number.isFinite(z) && z > -10000 ? z + n[k] : z)), label, outside, path, accuracy: cat.accuracy + (path && Number.isFinite(path.accuracy) ? path.accuracy : 0) };
  }

  /** The geoid of the loaded grid that converts `vertical` heights, or null when none is loaded. */
  geoidFor(vertical) {
    const v = VERTICALS[vertical];
    return v && this.has(v.grid) ? this.catalogue.get(v.grid).geoid ?? v.grid : null;
  }

  /** Release every WASM grid of a pack (when a pack is forgotten). */
  dropPack(name) {
    for (const [id, g] of this.catalogue) {
      if (g.pack !== name) continue;
      if (this.open.has(id)) this.bundle.close(this.open.get(id));
      this.open.delete(id);
      this.catalogue.delete(id);
    }
    this.packs.delete(name);
    this._emit();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const f of this.listeners) f();
  }
}
