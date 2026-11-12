// CF conventions shared by the NetCDF readers (REQ-FMT-26, REQ-MSI-02): grid mappings → CRS,
// 1-D coordinate variables → geotransform, packed data (scale_factor/add_offset, _FillValue,
// _Unsigned), rotated-pole grids and 2-D latitude/longitude geolocation → GCPs.
// Pure functions on {name, value} attribute lists, so the NetCDF-3 reader (attributes from the
// Rust header parser) and the HDF5/NetCDF-4 reader (h5wasm attributes) share them.

const D2R = Math.PI / 180;

/** Attribute value by name from a [{name, value}] list or a plain object. NaN strings → NaN. */
export function att(list, name) {
  const a = Array.isArray(list) ? list.find((x) => x.name === name) : list?.[name] !== undefined ? { value: list[name] } : null;
  if (!a) return undefined;
  const fix = (v) => (v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v);
  return Array.isArray(a.value) ? a.value.map(fix) : fix(a.value);
}
export const num = (list, name) => {
  const v = att(list, name);
  const x = Array.isArray(v) ? v[0] : v;
  return x === undefined || x === null || x === '' ? undefined : Number(x);
};
export const nums = (list, name) => {
  const v = att(list, name);
  return v === undefined ? [] : (Array.isArray(v) ? v : [v]).map(Number);
};

/** Packing and missing data: {scale, offset, fill, unsigned}. */
export function packing(attrs) {
  const fill = num(attrs, '_FillValue') ?? num(attrs, 'missing_value');
  return {
    scale: num(attrs, 'scale_factor') ?? 1,
    offset: num(attrs, 'add_offset') ?? 0,
    fill: fill === undefined ? null : fill,
    unsigned: /^true$/i.test(String(att(attrs, '_Unsigned') ?? '')),
  };
}

/** Axis role of a coordinate variable: 'x', 'y', 'lon', 'lat', 't', 'z' or null. */
export function axisOf(name, attrs) {
  const sn = String(att(attrs, 'standard_name') ?? '').toLowerCase();
  const units = String(att(attrs, 'units') ?? '').toLowerCase();
  const ax = String(att(attrs, 'axis') ?? '').toUpperCase();
  const n = String(name).toLowerCase();
  if (sn === 'projection_x_coordinate' || sn === 'grid_longitude' || ax === 'X' && !/degree/.test(units)) return 'x';
  if (sn === 'projection_y_coordinate' || sn === 'grid_latitude' || ax === 'Y' && !/degree/.test(units)) return 'y';
  if (sn === 'longitude' || /^degrees?_?e(ast)?$/.test(units) || (ax === 'X' && /degree/.test(units))) return 'lon';
  if (sn === 'latitude' || /^degrees?_?n(orth)?$/.test(units) || (ax === 'Y' && /degree/.test(units))) return 'lat';
  if (sn === 'time' || ax === 'T' || / since /.test(units)) return 't';
  if (ax === 'Z' || /^(lev|level|height|depth|plev|pressure)$/.test(n)) return 'z';
  if (/^(x|xc|x_?coord|easting|rlon)$/.test(n)) return 'x';
  if (/^(y|yc|y_?coord|northing|rlat)$/.test(n)) return 'y';
  if (/^(lon|longitude|long)$/.test(n)) return 'lon';
  if (/^(lat|latitude)$/.test(n)) return 'lat';
  return null;
}

/** Metres per coordinate unit of a projected axis (CF allows km). */
export function unitScale(attrs) {
  const u = String(att(attrs, 'units') ?? '').trim().toLowerCase();
  if (/^(km|kilomet(er|re)s?)$/.test(u)) return 1000;
  if (/^(us_survey_f(ee|oo)t|us-ft|ftus|survey_foot)$/.test(u)) return 0.304800609601219;
  return /^(f(ee|oo)?t|international_foot)$/.test(u) ? 0.3048 : 1;
}

/**
 * A regular 1-D axis → {start, step} (centre of the first cell, signed spacing), or null when the
 * spacing varies by more than `tol` of a step (then GCPs are used).
 */
export function regular(vals, tol = 0.02) {
  const n = vals.length;
  if (n < 2) return n === 1 ? { start: vals[0], step: NaN } : null;
  const step = (vals[n - 1] - vals[0]) / (n - 1);
  if (!Number.isFinite(step) || step === 0) return null;
  for (let i = 1; i < n; i++) if (Math.abs(vals[i] - vals[i - 1] - step) > Math.abs(step) * tol) return null;
  return { start: vals[0], step };
}

/**
 * Geotransform of a grid with x and y coordinate values (cell centres). The image is shown north
 * up: `flip` is true when the file's rows run south to north (y increasing), as GDAL presents it.
 */
export function geotransform(xs, ys, xScale = 1, yScale = 1) {
  const rx = regular(xs);
  const ry = regular(ys);
  if (!rx || !ry || !Number.isFinite(rx.step) || !Number.isFinite(ry.step)) return null;
  const dx = rx.step * xScale;
  const dy = ry.step * yScale;
  const flip = dy > 0;
  const top = flip ? ys[ys.length - 1] * yScale + dy / 2 : ys[0] * yScale - dy / 2;
  return { gt: [xs[0] * xScale - dx / 2, dx, 0, top, 0, -Math.abs(dy)], flip };
}

function ellipsoid(gm) {
  const a = num(gm, 'semi_major_axis') ?? num(gm, 'earth_radius') ?? num(gm, 'spherical_earth_radius_meters');
  let b = num(gm, 'semi_minor_axis');
  let rf = num(gm, 'inverse_flattening');
  const datum = String(att(gm, 'horizontal_datum_name') ?? att(gm, 'reference_ellipsoid_name') ?? '');
  const tw = nums(gm, 'towgs84');
  const shift = tw.length >= 3 && tw.some((v) => v) ? ` +towgs84=${[...tw, 0, 0, 0, 0].slice(0, 7).join(',')}` : '';
  if (a === undefined) return { def: ' +datum=WGS84', wgs84: true };
  if (b === undefined) b = rf ? a - a / rf : a;
  if (!rf && b !== a) rf = a / (a - b);
  // WGS 84 by its flattening (GRS 1980 differs by 0.1 mm in b: it is not WGS 84).
  if (Math.abs(a - 6378137) < 0.01 && rf && Math.abs(rf - 298.257223563) < 1e-6 && !shift) return { def: ' +datum=WGS84', wgs84: true };
  if (/nad.?83|north_american_datum_1983/i.test(datum)) return { def: ' +datum=NAD83' };
  if (/nad.?27|north_american_datum_1927/i.test(datum) && !shift) return { def: ' +ellps=clrk66 +towgs84=-8,160,176,0,0,0,0' };
  return { def: ` +a=${a} +b=${b}${shift}` };
}

/**
 * CF grid mapping (attributes of the grid_mapping variable) → {epsg, wkt, proj4, label, rotated,
 * error}. A WKT written beside the CF parameters (crs_wkt, GDAL's spatial_ref) is preferred.
 */
export function gridMapping(gm, { toMeters = 1 } = {}) {
  if (!gm) return null;
  const wkt = String(att(gm, 'crs_wkt') ?? att(gm, 'spatial_ref') ?? '');
  const cf = fromParams(gm, toMeters);
  if (/^(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS)\[/.test(wkt)) {
    // The WKT names the CRS (and its EPSG code); the CF parameters stay as the proj4 fallback for
    // a WKT proj4js cannot read (Mercator_2SP, WKT2 methods).
    const code = Number(/AUTHORITY\["EPSG","(\d+)"\]\]\s*$/.exec(wkt)?.[1] ?? /ID\["EPSG",(\d+)\]\]\s*$/.exec(wkt)?.[1] ?? NaN);
    const geo = /^GEOG/.test(wkt) && /WGS.?84|WGS_1984/.test(wkt) ? 4326 : null;
    const base = cf && !cf.error ? cf : {};
    return { ...base, epsg: Number.isFinite(code) ? code : geo ?? base.epsg ?? null, wkt, label: /^(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS)\["([^"]+)"/.exec(wkt)?.[1] ?? base.label ?? 'CRS' };
  }
  return cf;
}

/** CF parameters → proj4; false easting/northing are in the projection coordinates' units (toMeters). */
function fromParams(gm, toMeters = 1) {
  const name = String(att(gm, 'grid_mapping_name') ?? (num(gm, 'grid_north_pole_latitude') !== undefined ? 'rotated_latitude_longitude' : ''));
  const p = (k) => num(gm, k);
  const sp = nums(gm, 'standard_parallel');
  const fe = ` +x_0=${(p('false_easting') ?? 0) * toMeters} +y_0=${(p('false_northing') ?? 0) * toMeters}`;
  const ell = ellipsoid(gm);
  const label = name || 'CF grid mapping';
  let def = null;
  let epsg = null;
  switch (name) {
    case 'latitude_longitude':
      return { epsg: ell.wgs84 ? 4326 : null, proj4: `+proj=longlat${ell.def} +title=CF latitude_longitude +no_defs`, label: 'latitude_longitude' };
    case 'rotated_latitude_longitude':
      return { rotated: { poleLat: p('grid_north_pole_latitude') ?? 90, poleLon: p('grid_north_pole_longitude') ?? 0, gridLon: p('north_pole_grid_longitude') ?? 0 }, label: 'rotated pole' };
    case 'transverse_mercator': {
      const k = p('scale_factor_at_central_meridian') ?? 1;
      const lon0 = p('longitude_of_central_meridian') ?? 0;
      const lat0 = p('latitude_of_projection_origin') ?? 0;
      const z = (lon0 + 183) / 6;
      if (ell.wgs84 && Math.abs(k - 0.9996) < 1e-9 && lat0 === 0 && (p('false_easting') ?? 0) === 500000 && Number.isInteger(z) && z >= 1 && z <= 60) epsg = ((p('false_northing') ?? 0) === 10000000 ? 32700 : (p('false_northing') ?? 0) === 0 ? 32600 : NaN) + z;
      if (!Number.isFinite(epsg)) epsg = null;
      def = `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=${k}${fe}`;
      break;
    }
    case 'lambert_conformal_conic':
      def = `+proj=lcc +lat_1=${sp[0] ?? p('latitude_of_projection_origin')} +lat_2=${sp[1] ?? sp[0] ?? p('latitude_of_projection_origin')} +lat_0=${p('latitude_of_projection_origin') ?? sp[0]} +lon_0=${p('longitude_of_central_meridian') ?? 0}${fe}`;
      break;
    case 'polar_stereographic': {
      const lat0 = p('latitude_of_projection_origin') ?? 90;
      const k = p('scale_factor_at_projection_origin');
      const ts = sp[0] ?? p('standard_parallel');
      def = `+proj=stere +lat_0=${lat0} +lon_0=${p('straight_vertical_longitude_from_pole') ?? p('longitude_of_projection_origin') ?? 0}${ts !== undefined ? ` +lat_ts=${ts}` : ` +k=${k ?? 1}`}${fe}`;
      break;
    }
    case 'stereographic':
      def = `+proj=stere +lat_0=${p('latitude_of_projection_origin') ?? 0} +lon_0=${p('longitude_of_projection_origin') ?? 0} +k=${p('scale_factor_at_projection_origin') ?? 1}${fe}`;
      break;
    case 'mercator':
      def = `+proj=merc +lon_0=${p('longitude_of_projection_origin') ?? 0}${sp.length ? ` +lat_ts=${sp[0]}` : ` +k=${p('scale_factor_at_projection_origin') ?? 1}`}${fe}`;
      break;
    case 'albers_conical_equal_area':
      def = `+proj=aea +lat_1=${sp[0]} +lat_2=${sp[1] ?? sp[0]} +lat_0=${p('latitude_of_projection_origin') ?? 0} +lon_0=${p('longitude_of_central_meridian') ?? 0}${fe}`;
      break;
    case 'lambert_azimuthal_equal_area':
      def = `+proj=laea +lat_0=${p('latitude_of_projection_origin') ?? 0} +lon_0=${p('longitude_of_projection_origin') ?? 0}${fe}`;
      break;
    case 'azimuthal_equidistant':
      def = `+proj=aeqd +lat_0=${p('latitude_of_projection_origin') ?? 0} +lon_0=${p('longitude_of_projection_origin') ?? 0}${fe}`;
      break;
    case 'orthographic':
      def = `+proj=ortho +lat_0=${p('latitude_of_projection_origin') ?? 0} +lon_0=${p('longitude_of_projection_origin') ?? 0}${fe}`;
      break;
    case 'sinusoidal':
      def = `+proj=sinu +lon_0=${p('longitude_of_central_meridian') ?? p('longitude_of_projection_origin') ?? 0}${fe}`;
      break;
    case 'lambert_cylindrical_equal_area':
      def = `+proj=cea +lon_0=${p('longitude_of_central_meridian') ?? 0} +lat_ts=${sp[0] ?? 0}${fe}`;
      break;
    case 'geostationary':
      def = `+proj=geos +h=${p('perspective_point_height')} +lon_0=${p('longitude_of_projection_origin') ?? 0} +sweep=${att(gm, 'sweep_angle_axis') ?? 'y'}${fe}`;
      break;
    default:
      return { error: `the CF grid mapping "${name || '(unnamed)'}" is not read`, label };
  }
  // Kilometre coordinates are scaled to metres by the reader; other length units stay (to_meter).
  const units = toMeters === 1 || toMeters === 1000 ? " +units=m" : ` +to_meter=${toMeters}`;
  return { epsg, proj4: `${def}${ell.def}${units} +title=CF ${label} +no_defs`, label };
}

/** Rotated-pole grid coordinates (degrees) → geographic {lat, lon} (CF rotated_latitude_longitude). */
export function unrotate(rlon, rlat, { poleLat, poleLon, gridLon = 0 }) {
  const lr = (rlon - gridLon) * D2R;
  const pr = rlat * D2R;
  const pp = poleLat * D2R;
  const lat = Math.asin(Math.cos(pp) * Math.cos(pr) * Math.cos(lr) + Math.sin(pp) * Math.sin(pr));
  let lon = poleLon + 180 + Math.atan2(Math.cos(pr) * Math.sin(lr), Math.sin(pp) * Math.cos(pr) * Math.cos(lr) - Math.cos(pp) * Math.sin(pr)) / D2R;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: lat / D2R, lon };
}

/**
 * GCPs on an n × n grid of a W × H image from a sampler `at(col, row)` → {lat, lon} over a
 * `lw` × `lh` geolocation grid (pixel-centre convention). The HDF5 swath products and NetCDF
 * 2-D latitude/longitude and rotated-pole grids use it.
 */
export function gcpGrid(at, lw, lh, W, H, n = 12) {
  const out = [];
  // A small grid gives each of its cells once (repeated points made the fit degenerate).
  const nx = Math.max(2, Math.min(n, lw));
  const ny = Math.max(2, Math.min(n, lh));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const r = Math.min(lh - 1, Math.round((j * (lh - 1)) / (ny - 1)));
      const c = Math.min(lw - 1, Math.round((i * (lw - 1)) / (nx - 1)));
      const g = at(c, r);
      const la = Number(g?.lat);
      const lo = Number(g?.lon);
      if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 360) out.push({ x: ((c + 0.5) * W) / lw, y: ((r + 0.5) * H) / lh, lat: la, lon: lo > 180 ? lo - 360 : lo });
    }
  }
  return out.length >= 4 ? out : null;
}

// ---- CF time (REQ-GAP-83): "<unit> since <reference>" with the CF calendars → ISO 8601 UTC. ----

const SECS = { s: 1, sec: 1, second: 1, seconds: 1, secs: 1, ms: 1e-3, millisecond: 1e-3, milliseconds: 1e-3, msec: 1e-3, us: 1e-6, microsecond: 1e-6, microseconds: 1e-6, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400 };
const CUM = (feb) => [0, 31, 31 + feb, 62 + feb, 92 + feb, 123 + feb, 153 + feb, 184 + feb, 215 + feb, 245 + feb, 276 + feb, 306 + feb, 337 + feb];
const fdiv = (a, b) => Math.floor(a / b);
// Day numbers (Julian Day Number for the real calendars; any fixed origin for the model ones).
const gregJdn = (y, m, d) => {
  const a = fdiv(14 - m, 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + fdiv(153 * mm + 2, 5) + 365 * yy + fdiv(yy, 4) - fdiv(yy, 100) + fdiv(yy, 400) - 32045;
};
const julJdn = (y, m, d) => {
  const a = fdiv(14 - m, 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + fdiv(153 * mm + 2, 5) + 365 * yy + fdiv(yy, 4) - 32083;
};
function fromJdn(J, gregorian) {
  let c, b;
  if (gregorian) {
    const a = J + 32044;
    b = fdiv(4 * a + 3, 146097);
    c = a - fdiv(146097 * b, 4);
  } else {
    b = 0;
    c = J + 32082;
  }
  const d = fdiv(4 * c + 3, 1461);
  const e = c - fdiv(1461 * d, 4);
  const m = fdiv(5 * e + 2, 153);
  return [100 * b + d - 4800 + fdiv(m, 10), m + 3 - 12 * fdiv(m, 10), e - fdiv(153 * m + 2, 5) + 1];
}
const fixedYear = (len, feb) => ({
  day: (y, m, d) => y * len + CUM(feb)[m - 1] + d - 1,
  date: (n) => {
    const y = fdiv(n, len);
    let r = n - y * len;
    const cum = CUM(feb);
    let m = 1;
    while (m < 12 && r >= cum[m]) m++;
    return [y, m, r - cum[m - 1] + 1];
  },
});
const CALENDARS = {
  proleptic_gregorian: { day: gregJdn, date: (n) => fromJdn(n, true) },
  julian: { day: julJdn, date: (n) => fromJdn(n, false) },
  // The default: Julian before 1582-10-15, Gregorian from then on.
  standard: {
    day: (y, m, d) => (y > 1582 || (y === 1582 && (m > 10 || (m === 10 && d >= 15))) ? gregJdn(y, m, d) : julJdn(y, m, d)),
    date: (n) => fromJdn(n, n >= 2299161),
  },
  noleap: fixedYear(365, 28),
  all_leap: fixedYear(366, 29),
  '360_day': {
    day: (y, m, d) => y * 360 + (m - 1) * 30 + d - 1,
    date: (n) => {
      const y = fdiv(n, 360);
      const r = n - y * 360;
      return [y, fdiv(r, 30) + 1, (r % 30) + 1];
    },
  },
};
const ALIAS = { gregorian: 'standard', '365_day': 'noleap', '366_day': 'all_leap', none: null };

/**
 * A CF time coordinate's decoder, or null when `units` is not "<unit> since <date>" or the calendar
 * is not a CF one. The decoder turns a value into an ISO 8601 UTC string ("2001-02-03T04:05:06Z",
 * with milliseconds only when there are any). Model calendars give dates no real calendar has
 * (2001-02-30 in 360_day), which is why the result is a string and not a Date.
 */
export function cfTime(units, calendar = 'standard') {
  const u = /^\s*([a-z]+)\s+since\s+(-?\d{1,4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?)?\s*(Z|UTC|GMT|[+-]\d{1,2}(?::?\d{2})?)?\s*$/i.exec(String(units ?? ''));
  if (!u) return null;
  const key = String(calendar ?? 'standard').trim().toLowerCase() || 'standard';
  const name = key in ALIAS ? ALIAS[key] : key;
  const cal = name && CALENDARS[name];
  if (!cal) return null;
  const unit = u[1].toLowerCase();
  // Months and years count calendar months from the reference (a monthly axis keeps each value in its
  // month, which UDUNITS' fixed 30.44-day month does not); a fraction is of the month, or the year, it
  // falls in.
  const step = /^(years?|yr)$/.test(unit) ? 12 : /^months?$/.test(unit) ? 1 : 0;
  const per = SECS[unit] ?? (step ? 0 : undefined);
  if (per === undefined) return null;
  let tz = 0;
  if (u[8] && /^[+-]/.test(u[8])) {
    const [, sg, hh, mm] = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(u[8]);
    tz = (sg === '-' ? -1 : 1) * (Number(hh) * 60 + Number(mm ?? 0));
  }
  const [y0, m0, d0] = [Number(u[2]), Number(u[3]), Number(u[4])];
  const tod = Number(u[5] ?? 0) * 3600 + Number(u[6] ?? 0) * 60 + Number(u[7] ?? 0) - tz * 60;
  const ref = cal.day(y0, m0, d0) * 86400 + tod;
  const monthStart = (k) => cal.day(fdiv(k, 12), (k % 12 + 12) % 12 + 1, 1);
  const calendarSteps = (x) => {
    const n = Math.floor(x);
    const k = y0 * 12 + m0 - 1 + n * step;
    const first = monthStart(k);
    return (first + Math.min(d0, monthStart(k + 1) - first) - 1 + (x - n) * (monthStart(k + step) - first)) * 86400 + tod;
  };
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (v) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return null;
    const t = Math.round((step ? calendarSteps(x) : ref + x * per) * 1000) / 1000;
    const day = Math.floor(t / 86400);
    const s = t - day * 86400;
    const [y, m, d] = cal.date(day);
    const ms = Math.round((s % 1) * 1000);
    const ys = y < 0 ? `-${p(-y, 4)}` : p(y, 4);
    return `${ys}-${p(m)}-${p(d)}T${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(Math.floor(s) % 60)}${ms ? `.${p(ms, 3)}` : ''}Z`;
  };
}
