// The CRS of an image layer in the terms the 2.1 raster writers need (REQ-FMT-25, REQ-FMT-27):
// a proj4js projection object from the layer's EPSG code, WKT or proj4 definition, then
//   * CF-1.8 grid-mapping attributes plus a WKT1 `crs_wkt` (NetCDF-3 writer),
//   * Eprj_ProParameters / Eprj_Datum / Eprj_MapInfo values (HFA writer).
// Only the projections both formats describe with parameters are mapped; any other CRS keeps the
// WKT (NetCDF) or is refused by name (HFA) rather than written wrongly.

import proj4 from 'proj4';
import { crsOf } from '../geo/crs.js';

const R2D = 180 / Math.PI;
const r = (v) => +(Number(v ?? 0) * R2D).toPrecision(15);
const KIND = ['longlat', 'utm', 'tmerc', 'lcc', 'stere', 'sterea', 'aea', 'laea', 'merc', 'eqc', 'sinu', 'aeqd', 'nzmg'];

/** {P, kind, epsg, wkt, label} for a layer (its open metadata), or null when it has no CRS. */
export function layerCrs(l) {
  const m = l.info?.meta ?? {};
  const epsg = Number(m.epsg) || null;
  const wkt = m.wkt || null;
  const def = m.proj4 || null;
  const c = crsOf({ epsg, wkt: wkt || def });
  let P = null;
  for (const d of [c?.def, wkt, def, epsg ? `EPSG:${epsg}` : null].filter(Boolean)) {
    try {
      P = proj4.Proj(d);
      if (P) break;
    } catch {
      /* try the next definition */
    }
  }
  if (!P) return epsg || wkt || def ? { P: null, epsg, wkt, label: c?.label ?? (epsg ? `EPSG:${epsg}` : 'CRS') } : null;
  const names = (P.names ?? [P.projName]).map((n) => String(n).toLowerCase());
  const kind = KIND.find((k) => names.includes(k)) ?? (names.some((n) => /transverse_mercator/.test(n)) ? 'tmerc' : String(P.projName).toLowerCase());
  return { P, kind: kind === 'utm' && P.zone ? 'utm' : kind === 'utm' ? 'tmerc' : kind, epsg, wkt, label: c?.label ?? P.srsCode ?? P.title ?? kind };
}

/** Datum of a projection object: {key: 'WGS84'|'NAD83'|'NAD27'|null, towgs84: [7] | null}. */
function datumOf(P, epsg = null) {
  const n = `${P.datumCode ?? ''} ${P.datumName ?? ''} ${P.srsCode ?? ''} ${P.title ?? ''}`;
  const p = P.datum?.datum_params ?? null;
  const zero = !p || p.every((v) => !v);
  const rf = P.rf || (P.b && P.a !== P.b ? P.a / (P.a - P.b) : 0);
  const wgsEll = Math.abs(P.a - 6378137) < 1e-3 && Math.abs(rf - 298.257223563) < 1e-6;
  const grsEll = Math.abs(P.a - 6378137) < 1e-3 && Math.abs(rf - 298.257222101) < 1e-6;
  const e = Number(epsg) || 0;
  const inR = (a, b) => e >= a && e <= b;
  // EPSG codes say what the embedded proj4 definitions (GRS80 + zero shift) do not.
  if (e === 4269 || e === 5070 || e === 3338 || e === 3310 || inR(26901, 26999) || inR(2222, 2290) || inR(32100, 32199)) return { key: 'NAD83', towgs84: null };
  if (e === 4267 || inR(26701, 26799) || inR(32001, 32099)) return { key: 'NAD27', towgs84: [-8, 160, 176, 0, 0, 0, 0] };
  if (e === 4258 || e === 3034 || e === 3035 || inR(25801, 25899)) return { key: 'ETRS89', towgs84: null };
  if (e === 4326 || inR(32601, 32660) || inR(32701, 32760) || e === 3857) return { key: 'WGS84', towgs84: null };
  if (/nad.?83|north_american_datum_1983/i.test(n)) return { key: 'NAD83', towgs84: null };
  if (/nad.?27|north_american_datum_1927/i.test(n) || P.ellps === 'clrk66') return { key: 'NAD27', towgs84: [-8, 160, 176, 0, 0, 0, 0] };
  if (/etrs.?89|european_terrestrial/i.test(n)) return { key: 'ETRS89', towgs84: null };
  if (/wgs.?84|wgs_1984/i.test(n) || (wgsEll && zero)) return { key: 'WGS84', towgs84: null };
  if (grsEll && zero) return { key: 'GRS80', towgs84: null };
  // proj4js keeps a 7-parameter shift internally in radians and as a scale factor: back to arc-seconds and ppm.
  const SEC = 4.84813681109536e-6;
  const tw = p && p.length >= 7 && P.datum?.datum_type === 2 ? [p[0], p[1], p[2], p[3] / SEC, p[4] / SEC, p[5] / SEC, (p[6] - 1) * 1e6].map((v) => +v.toPrecision(12)) : p ? [...p, 0, 0, 0, 0].slice(0, 7) : null;
  return { key: null, towgs84: p && p.length >= 3 && !zero ? tw : null };
}

const SPHEROID = { WGS84: ['WGS 84', 6378137, 298.257223563], NAD83: ['GRS 1980', 6378137, 298.257222101], NAD27: ['Clarke 1866', 6378206.4, 294.978698213898], ETRS89: ['GRS 1980', 6378137, 298.257222101], GRS80: ['GRS 1980', 6378137, 298.257222101] };
const DATUM = { WGS84: 'WGS_1984', NAD83: 'North_American_Datum_1983', NAD27: 'North_American_Datum_1927', ETRS89: 'European_Terrestrial_Reference_System_1989', GRS80: 'unknown' };
const GEOG = { WGS84: ['WGS 84', 4326], NAD83: ['NAD83', 4269], NAD27: ['NAD27', 4267], ETRS89: ['ETRS89', 4258], GRS80: ['unknown', 0] };

function ellipsoid(P, d) {
  if (d.key) return SPHEROID[d.key];
  const rf = P.rf || (P.b && P.a !== P.b ? P.a / (P.a - P.b) : 0);
  return ['unnamed', P.a, rf];
}

/** Metres per projection unit (US survey feet, feet or metres). */
export function unitsToMeters(P) {
  if (P.to_meter && P.to_meter !== 1) return P.to_meter;
  return P.units === 'us-ft' ? 0.304800609601219 : P.units === 'ft' ? 0.3048 : 1;
}

/** The CF units of the projection's x/y coordinates. */
export function cfUnits(P) {
  const m = unitsToMeters(P);
  return m === 1 ? 'm' : Math.abs(m - 0.304800609601219) < 1e-12 ? 'US_survey_foot' : 'foot';
}

/**
 * Latitude of true scale (radians, signed as the pole) of a polar stereographic projection given by
 * its scale factor at the pole (variant A): solves k0 = m_c √((1+e)^(1+e) (1−e)^(1−e)) / (2 t_c).
 */
function trueScaleLat(P) {
  const k0 = P.k0 ?? 1;
  if (k0 >= 1) return Math.sign(P.lat0 || 1) * (Math.PI / 2);
  const e = Math.sqrt(P.es ?? 0);
  const c = Math.sqrt((1 + e) ** (1 + e) * (1 - e) ** (1 - e));
  const k = (phi) => {
    const sp = Math.sin(phi);
    const m = Math.cos(phi) / Math.sqrt(1 - e * e * sp * sp);
    const t = Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * sp) / (1 + e * sp)) ** (e / 2);
    return (m * c) / (2 * t);
  };
  let lo = 0;
  let hi = Math.PI / 2 - 1e-12;
  if (k(lo) > k0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (k(mid) < k0) lo = mid;
    else hi = mid;
  }
  return Math.sign(P.lat0 || 1) * (lo + hi) / 2;
}

/** WKT1 (GDAL-style) of a projection object; EPSG authority when the code is known. */
export function wkt1(c) {
  const { P, kind, epsg } = c;
  const d = datumOf(P, c.epsg);
  const [sn, a, rf] = ellipsoid(P, d);
  const geogName = d.key ? GEOG[d.key][0] : 'unknown';
  const geogCode = d.key ? GEOG[d.key][1] : 0;
  const tw = d.towgs84 ? `,TOWGS84[${d.towgs84.join(',')}]` : '';
  const geog = `GEOGCS["${geogName}",DATUM["${d.key ? DATUM[d.key] : 'unknown'}",SPHEROID["${sn}",${a},${rf}]${tw}],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]${kind === 'longlat' && epsg ? `,AUTHORITY["EPSG","${epsg}"]` : geogCode && kind !== 'longlat' ? `,AUTHORITY["EPSG","${geogCode}"]` : ''}]`;
  if (kind === 'longlat') return geog;
  const par = (k, v) => `PARAMETER["${k}",${+Number(v).toPrecision(15)}]`;
  // WKT1: false easting/northing in the CRS's linear unit (proj4js keeps them in metres).
  const lu = unitsToMeters(P);
  const fe = [par('false_easting', (P.x0 ?? 0) / lu), par('false_northing', (P.y0 ?? 0) / lu)];
  let proj;
  let ps;
  switch (kind) {
    case 'utm':
    case 'tmerc':
      proj = 'Transverse_Mercator';
      ps = [par('latitude_of_origin', r(P.lat0)), par('central_meridian', r(P.long0)), par('scale_factor', P.k0 ?? 1), par('false_easting', (P.x0 ?? 0) / lu), par('false_northing', (kind === 'utm' && P.utmSouth ? 10000000 : P.y0 ?? 0) / lu)];
      break;
    case 'lcc':
      if (Math.abs((P.lat1 ?? 0) - (P.lat2 ?? P.lat1 ?? 0)) < 1e-12) {
        proj = 'Lambert_Conformal_Conic_1SP';
        ps = [par('latitude_of_origin', r(P.lat1 ?? P.lat0)), par('central_meridian', r(P.long0)), par('scale_factor', P.k0 ?? 1), ...fe];
      } else {
        proj = 'Lambert_Conformal_Conic_2SP';
        ps = [par('standard_parallel_1', r(P.lat1)), par('standard_parallel_2', r(P.lat2)), par('latitude_of_origin', r(P.lat0)), par('central_meridian', r(P.long0)), ...fe];
      }
      break;
    case 'stere':
      if (Math.abs(Math.abs(P.lat0 ?? 0) - Math.PI / 2) < 1e-9) {
        proj = 'Polar_Stereographic';
        ps = [par('latitude_of_origin', P.lat_ts !== undefined ? r(P.lat_ts) : r(P.lat0)), par('central_meridian', r(P.long0)), par('scale_factor', P.lat_ts !== undefined ? 1 : P.k0 ?? 1), ...fe];
      } else {
        proj = 'Oblique_Stereographic';
        ps = [par('latitude_of_origin', r(P.lat0)), par('central_meridian', r(P.long0)), par('scale_factor', P.k0 ?? 1), ...fe];
      }
      break;
    case 'sterea':
      proj = 'Oblique_Stereographic';
      ps = [par('latitude_of_origin', r(P.lat0)), par('central_meridian', r(P.long0)), par('scale_factor', P.k0 ?? 1), ...fe];
      break;
    case 'aea':
      proj = 'Albers_Conic_Equal_Area';
      ps = [par('standard_parallel_1', r(P.lat1)), par('standard_parallel_2', r(P.lat2)), par('latitude_of_center', r(P.lat0)), par('longitude_of_center', r(P.long0)), ...fe];
      break;
    case 'laea':
      proj = 'Lambert_Azimuthal_Equal_Area';
      ps = [par('latitude_of_center', r(P.lat0)), par('longitude_of_center', r(P.long0)), ...fe];
      break;
    case 'merc':
      proj = P.lat_ts ? 'Mercator_2SP' : 'Mercator_1SP';
      ps = P.lat_ts ? [par('standard_parallel_1', r(P.lat_ts)), par('central_meridian', r(P.long0)), ...fe] : [par('central_meridian', r(P.long0)), par('scale_factor', P.k0 ?? 1), ...fe];
      break;
    case 'eqc':
      proj = 'Equirectangular';
      ps = [par('standard_parallel_1', r(P.lat_ts ?? 0)), par('central_meridian', r(P.long0)), ...fe];
      break;
    case 'sinu':
      proj = 'Sinusoidal';
      ps = [par('longitude_of_center', r(P.long0)), ...fe];
      break;
    case 'aeqd':
      proj = 'Azimuthal_Equidistant';
      ps = [par('latitude_of_center', r(P.lat0)), par('longitude_of_center', r(P.long0)), ...fe];
      break;
    case 'nzmg':
      proj = 'New_Zealand_Map_Grid';
      ps = [par('latitude_of_origin', -41), par('central_meridian', 173), par('false_easting', 2510000), par('false_northing', 6023150)];
      break;
    default:
      return c.wkt || null;
  }
  const toM = P.to_meter && P.to_meter !== 1 ? P.to_meter : P.units === 'us-ft' ? 0.304800609601219 : P.units === 'ft' ? 0.3048 : 1;
  const unit = toM === 1 ? 'UNIT["metre",1]' : `UNIT["${Math.abs(toM - 0.304800609601219) < 1e-12 ? 'US survey foot' : 'foot'}",${toM}]`;
  const name = c.label && !/^EPSG:/.test(c.label) ? c.label : kind === 'utm' ? `${d.key ? GEOG[d.key][0] : 'unknown'} / UTM zone ${P.zone}${P.utmSouth ? 'S' : 'N'}` : 'unnamed';
  return `PROJCS["${name}",${geog},PROJECTION["${proj}"],${ps.join(',')},${unit}${epsg ? `,AUTHORITY["EPSG","${epsg}"]` : ''}]`;
}

/** CF-1.8 grid-mapping attributes [{name, type, value}] (numeric values as arrays). */
export function cfAttrs(c) {
  const { P, kind } = c;
  const d = datumOf(P, c.epsg);
  const [, a, rf] = ellipsoid(P, d);
  const out = [];
  const t = (n, v) => out.push({ name: n, type: 'char', value: String(v) });
  const n = (k, v) => out.push({ name: k, type: 'double', value: (Array.isArray(v) ? v : [v]).map(Number) });
  // CF: false easting/northing in the units of the x/y coordinates (proj4js keeps them in metres).
  const toM = unitsToMeters(P);
  const fe = () => {
    n('false_easting', (P.x0 ?? 0) / toM);
    n('false_northing', (kind === 'utm' && P.utmSouth ? 10000000 : P.y0 ?? 0) / toM);
  };
  switch (kind) {
    case 'longlat':
      t('grid_mapping_name', 'latitude_longitude');
      break;
    case 'utm':
    case 'tmerc':
      t('grid_mapping_name', 'transverse_mercator');
      n('longitude_of_central_meridian', r(P.long0));
      n('latitude_of_projection_origin', r(P.lat0));
      n('scale_factor_at_central_meridian', P.k0 ?? 1);
      fe();
      break;
    case 'lcc':
      t('grid_mapping_name', 'lambert_conformal_conic');
      n('standard_parallel', Math.abs((P.lat1 ?? 0) - (P.lat2 ?? P.lat1 ?? 0)) < 1e-12 ? [r(P.lat1 ?? P.lat0)] : [r(P.lat1), r(P.lat2)]);
      n('longitude_of_central_meridian', r(P.long0));
      n('latitude_of_projection_origin', r(P.lat0));
      fe();
      break;
    case 'stere':
    case 'sterea':
      if (kind === 'stere' && Math.abs(Math.abs(P.lat0 ?? 0) - Math.PI / 2) < 1e-9) {
        t('grid_mapping_name', 'polar_stereographic');
        n('straight_vertical_longitude_from_pole', r(P.long0));
        n('latitude_of_projection_origin', r(P.lat0));
        if (P.lat_ts !== undefined) n('standard_parallel', r(P.lat_ts));
        else n('scale_factor_at_projection_origin', P.k0 ?? 1);
      } else {
        t('grid_mapping_name', 'stereographic');
        n('longitude_of_projection_origin', r(P.long0));
        n('latitude_of_projection_origin', r(P.lat0));
        n('scale_factor_at_projection_origin', P.k0 ?? 1);
      }
      fe();
      break;
    case 'aea':
      t('grid_mapping_name', 'albers_conical_equal_area');
      n('standard_parallel', [r(P.lat1), r(P.lat2)]);
      n('longitude_of_central_meridian', r(P.long0));
      n('latitude_of_projection_origin', r(P.lat0));
      fe();
      break;
    case 'laea':
      t('grid_mapping_name', 'lambert_azimuthal_equal_area');
      n('longitude_of_projection_origin', r(P.long0));
      n('latitude_of_projection_origin', r(P.lat0));
      fe();
      break;
    case 'merc':
      t('grid_mapping_name', 'mercator');
      n('longitude_of_projection_origin', r(P.long0));
      if (P.lat_ts) n('standard_parallel', r(P.lat_ts));
      else n('scale_factor_at_projection_origin', P.k0 ?? 1);
      fe();
      break;
    case 'sinu':
      t('grid_mapping_name', 'sinusoidal');
      n('longitude_of_projection_origin', r(P.long0));
      fe();
      break;
    case 'aeqd':
      t('grid_mapping_name', 'azimuthal_equidistant');
      n('longitude_of_projection_origin', r(P.long0));
      n('latitude_of_projection_origin', r(P.lat0));
      fe();
      break;
    default:
      break;
  }
  n('semi_major_axis', a);
  if (rf) n('inverse_flattening', rf);
  else n('semi_minor_axis', P.b ?? a);
  n('longitude_of_prime_meridian', 0);
  if (d.key === 'WGS84') t('horizontal_datum_name', 'WGS_1984');
  if (d.key === 'NAD83') t('horizontal_datum_name', 'North_American_Datum_1983');
  if (d.key === 'NAD27') t('horizontal_datum_name', 'North_American_Datum_1927');
  if (d.key === 'ETRS89') t('horizontal_datum_name', 'European_Terrestrial_Reference_System_1989');
  if (d.towgs84) n('towgs84', d.towgs84);
  return out;
}

/**
 * HFA projection records: {mapProName, units, pro: {number, zone, a, b, proName, sphereName,
 * params[15]}, datum: {name, params[7]}} or {error}. Angles in radians, GCTP order (the inverse of
 * workers/decode/hfa.js hfaCrs).
 */
export function hfaProjection(c) {
  const { P, kind } = c;
  const d = datumOf(P, c.epsg);
  const [sn, a, rf] = ellipsoid(P, d);
  const b = rf ? a - a / rf : P.b ?? a;
  const p = new Array(15).fill(0);
  const rad = (v) => Number(v ?? 0);
  const fe = () => {
    p[6] = P.x0 ?? 0;
    p[7] = P.y0 ?? 0;
  };
  let number;
  let proName;
  let zone = 0;
  switch (kind) {
    case 'longlat':
      number = 0;
      proName = 'Geographic (Lat/Lon)';
      break;
    case 'utm':
      number = 1;
      proName = 'UTM';
      zone = P.zone;
      p[3] = P.utmSouth ? -1 : 1;
      break;
    case 'tmerc':
      number = 9;
      proName = 'Transverse Mercator';
      p[2] = P.k0 ?? 1;
      p[4] = rad(P.long0);
      p[5] = rad(P.lat0);
      fe();
      break;
    case 'lcc':
      number = 4;
      proName = 'Lambert Conformal Conic';
      p[2] = rad(P.lat1 ?? P.lat0);
      p[3] = rad(P.lat2 ?? P.lat1 ?? P.lat0);
      p[4] = rad(P.long0);
      p[5] = rad(P.lat0);
      fe();
      break;
    case 'aea':
      number = 3;
      proName = 'Albers Conical Equal Area';
      p[2] = rad(P.lat1);
      p[3] = rad(P.lat2);
      p[4] = rad(P.long0);
      p[5] = rad(P.lat0);
      fe();
      break;
    case 'merc':
      number = 5;
      proName = 'Mercator';
      p[4] = rad(P.long0);
      p[5] = rad(P.lat_ts ?? 0);
      fe();
      break;
    case 'stere':
      if (Math.abs(Math.abs(P.lat0 ?? 0) - Math.PI / 2) < 1e-9) {
        // HFA holds the latitude of true scale; variant A (scale factor at the pole) is converted.
        const ts = P.lat_ts !== undefined && !(Math.abs(Math.abs(P.lat_ts) - Math.PI / 2) < 1e-12 && (P.k0 ?? 1) !== 1) ? P.lat_ts : trueScaleLat(P);
        if (ts === null) return { error: 'this polar stereographic CRS has no latitude of true scale an ERDAS Imagine file can hold; save it as GeoTIFF' };
        number = 6;
        proName = 'Polar Stereographic';
        p[4] = rad(P.long0);
        p[5] = ts;
        fe();
        break;
      }
      return { error: 'an oblique stereographic CRS has no ERDAS Imagine parameter form in this writer; save it as GeoTIFF or NetCDF' };
    case 'nzmg':
      // External projection (GDAL and ERDAS: proExeName "nzmg") on the International 1924 ellipsoid.
      return { mapProName: 'New Zealand Map Grid', units: 'meters', pro: { number: -1, zone: 0, a: 6378388, b: 6356911.946128, proName: 'nzmg', sphereName: 'International 1909', params: new Array(15).fill(0) }, datum: { name: 'Geodetic Datum 1949', params: [0, 0, 0, 0, 0, 0, 0] } };
    case 'laea':
      number = 11;
      proName = 'Lambert Azimuthal Equal-area';
      p[4] = rad(P.long0);
      p[5] = rad(P.lat0);
      fe();
      break;
    case 'aeqd':
      number = 12;
      proName = 'Azimuthal Equidistant';
      p[4] = rad(P.long0);
      p[5] = rad(P.lat0);
      fe();
      break;
    case 'sinu':
      number = 16;
      proName = 'Sinusoidal';
      p[4] = rad(P.long0);
      fe();
      break;
    case 'eqc':
      number = 17;
      proName = 'Equirectangular';
      p[4] = rad(P.long0);
      p[5] = rad(P.lat_ts ?? 0);
      fe();
      break;
    default:
      return { error: `the ${c.label ?? kind} projection has no ERDAS Imagine parameter form in this writer; save it as GeoTIFF or NetCDF` };
  }
  const datumName = d.key === 'WGS84' ? 'WGS 84' : d.key === 'NAD83' ? 'NAD83' : d.key === 'NAD27' ? 'NAD27' : d.key === 'ETRS89' ? 'ETRS89' : 'unknown';
  // Eprj_Datum parametric parameters: GDAL's reading convention (rotations in radians, negated; scale in ppm × 1e-6).
  const tw = d.towgs84 && d.key !== 'NAD27' ? d.towgs84 : [0, 0, 0, 0, 0, 0, 0];
  const s = 206264.80624709636;
  const dp = [tw[0], tw[1], tw[2], -tw[3] / s, -tw[4] / s, -tw[5] / s, tw[6] / 1e6];
  const toM = P.to_meter && P.to_meter !== 1 ? P.to_meter : P.units === 'us-ft' ? 0.304800609601219 : P.units === 'ft' ? 0.3048 : 1;
  const units = kind === 'longlat' ? 'dd' : toM === 1 ? 'meters' : Math.abs(toM - 0.304800609601219) < 1e-12 ? 'us_survey_feet' : 'feet';
  const label = c.label && !/^EPSG:/.test(c.label) ? c.label : proName;
  return { mapProName: kind === 'longlat' ? 'Geographic (Lat/Lon)' : label, units, pro: { number, zone, a, b, proName, sphereName: sn, params: p }, datum: { name: datumName, params: dp } };
}
