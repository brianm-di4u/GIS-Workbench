// Coordinate reference systems beyond the Rust core's built-in set (REQ-GEO-04): proj4js
// with embedded EPSG definitions (Research/05 §4.1, §2.2 and common national grids), WKT from
// GeoTIFF/.prj/GeoPackage, and ~20 legacy datums with TR8350.2 / EPSG mean shifts passed as
// `towgs84`. WGS 84 stays the only internal datum; everything else converts on input.

import proj4 from 'proj4';

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
const UTM = (z, extra) => `+proj=utm +zone=${z} ${extra} +units=m +no_defs`;
const GRS80_0 = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0';

// Datum shifts (3- or 7-parameter, to WGS 84). Accuracy of 3-parameter mean shifts is
// about 5–10 m; the model info says so.
export const DATUMS = [
  { re: /North.?American.?Datum.?1927|NAD27|NAD_1927/i, name: 'NAD27 (CONUS mean)', ellps: 'clrk66', towgs84: '-8,160,176,0,0,0,0', acc: 5 },
  { re: /North.?American.?Datum.?1983|NAD83|NAD_1983/i, name: 'NAD83 (≈ WGS 84, ≤ 2 m)', ellps: 'GRS80', towgs84: '0,0,0,0,0,0,0', acc: 2 },
  { re: /European.?Datum.?1950|ED50/i, name: 'ED50 (mean)', ellps: 'intl', towgs84: '-87,-98,-121,0,0,0,0', acc: 5 },
  { re: /ETRS.?89|European.?Terrestrial/i, name: 'ETRS89 (≈ WGS 84, < 1 m)', ellps: 'GRS80', towgs84: '0,0,0,0,0,0,0', acc: 1 },
  { re: /OSGB.?1936|OSGB36/i, name: 'OSGB36', ellps: 'airy', towgs84: '446.448,-125.157,542.06,0.15,0.247,0.842,-20.489', acc: 2 },
  { re: /Tokyo/i, name: 'Tokyo (mean)', ellps: 'bessel', towgs84: '-146.414,507.337,680.507,0,0,0,0', acc: 10 },
  { re: /Pulkovo.?1942/i, name: 'Pulkovo 1942', ellps: 'krass', towgs84: '23.92,-141.27,-80.9,0,0.35,0.82,-0.12', acc: 5 },
  { re: /Deutsches.?Hauptdreiecksnetz|DHDN/i, name: 'DHDN', ellps: 'bessel', towgs84: '598.1,73.7,418.2,0.202,0.045,-2.455,6.7', acc: 3 },
  { re: /Amersfoort/i, name: 'Amersfoort', ellps: 'bessel', towgs84: '565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725', acc: 1 },
  { re: /CH1903/i, name: 'CH1903', ellps: 'bessel', towgs84: '674.374,15.056,405.346,0,0,0,0', acc: 1 },
  { re: /WGS.?72|WGS_1972/i, name: 'WGS 72', ellps: 'WGS72', towgs84: '0,0,4.5,0,0,0.554,0.2263', acc: 2 },
  { re: /Indian.?1975/i, name: 'Indian 1975 (Thailand)', ellps: 'evrstSS', towgs84: '210,814,289,0,0,0,0', acc: 5 },
  { re: /Arc.?1960/i, name: 'Arc 1960', ellps: 'clrk80', towgs84: '-160,-6,-302,0,0,0,0', acc: 20 },
  { re: /Adindan/i, name: 'Adindan', ellps: 'clrk80', towgs84: '-166,-15,204,0,0,0,0', acc: 5 },
  { re: /South.?American.?1969|SAD69/i, name: 'SAD69', ellps: 'aust_SA', towgs84: '-57,1,-41,0,0,0,0', acc: 5 },
  { re: /Campo.?Inchauspe/i, name: 'Campo Inchauspe', ellps: 'intl', towgs84: '-148,136,90,0,0,0,0', acc: 5 },
  { re: /Korean.?Datum.?1985|Korea.?1985/i, name: 'Korean 1985', ellps: 'bessel', towgs84: '-146,507,687,0,0,0,0', acc: 5 },
  { re: /Hong.?Kong.?1980/i, name: 'Hong Kong 1980', ellps: 'intl', towgs84: '-162.619,-276.959,-161.764,0.067753,-2.243649,-1.158827,-1.094246', acc: 1 },
  { re: /GDA94|Geocentric.?Datum.?of.?Australia.?1994/i, name: 'GDA94 (≈ WGS 84, ≤ 1.5 m)', ellps: 'GRS80', towgs84: '0,0,0,0,0,0,0', acc: 1.5 },
  { re: /GDA2020|SIRGAS|NZGD2000|RGF93|SWEREF/i, name: 'ITRF-aligned (≈ WGS 84)', ellps: 'GRS80', towgs84: '0,0,0,0,0,0,0', acc: 1 },
  // NGA TR8350.2 mean three-parameter shifts (σ per axis as accuracy), REQ-GEO-09.
  { re: /Indian.?1954/i, name: 'Indian 1954 (Thailand)', ellps: 'evrst30', towgs84: '217,823,299,0,0,0,0', acc: 15 },
  { re: /Kertau/i, name: 'Kertau 1948', ellps: 'evrst48', towgs84: '-11,851,5,0,0,0,0', acc: 10 },
  { re: /Luzon/i, name: 'Luzon 1911 (Philippines)', ellps: 'clrk66', towgs84: '-133,-77,-51,0,0,0,0', acc: 8 },
  { re: /Nahrwan/i, name: 'Nahrwan (UAE)', ellps: 'clrk80', towgs84: '-249,-156,381,0,0,0,0', acc: 25 },
  { re: /Merchich/i, name: 'Merchich', ellps: 'clrk80', towgs84: '31,146,47,0,0,0,0', acc: 25 },
  { re: /Hu.?Tzu.?Shan/i, name: 'Hu-Tzu-Shan', ellps: 'intl', towgs84: '-637,-549,-203,0,0,0,0', acc: 15 },
  { re: /Timbalai/i, name: 'Timbalai 1948', ellps: 'evrstSS', towgs84: '-679,669,-48,0,0,0,0', acc: 10 },
  { re: /Bogota/i, name: 'Bogotá Observatory', ellps: 'intl', towgs84: '307,304,-318,0,0,0,0', acc: 6 },
  { re: /PSAD.?56|Provisional.?South.?American/i, name: 'Provisional South American 1956 (mean)', ellps: 'intl', towgs84: '-288,175,-376,0,0,0,0', acc: 15 },
  { re: /Corrego.?Alegre/i, name: 'Córrego Alegre', ellps: 'intl', towgs84: '-206,172,-6,0,0,0,0', acc: 5 },
  { re: /Qatar.?National/i, name: 'Qatar National', ellps: 'intl', towgs84: '-128,-283,22,0,0,0,0', acc: 20 },
  { re: /Nouvelle.?Triangulation|\bNTF\b/i, name: 'NTF (France)', ellps: 'clrk80ign', towgs84: '-168,-60,320,0,0,0,0', acc: 2 },
];

/** True when a datum note came from a three-parameter mean shift (REQ-GEO-09). */
export const isThreeParameter = (note) => !!note && note.acc > 0 && DATUMS.some((d) => d.name === note.name && /^[-\d.]+,[-\d.]+,[-\d.]+,0,0,0,0$/.test(d.towgs84) && d.towgs84 !== '0,0,0,0,0,0,0');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** Embedded EPSG definitions (beyond what proj4js knows: 4326, 4269, 3857, UTM/UPS WGS 84). */
export const EPSG = {
  4979: WGS84,
  4978: '+proj=geocent +datum=WGS84 +units=m +no_defs',
  4087: '+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  3395: '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  3995: '+proj=stere +lat_0=90 +lat_ts=71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  3031: '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  3413: '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
  32661: '+proj=stere +lat_0=90 +lat_ts=90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs',
  32761: '+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs',
  3034: `+proj=lcc +lat_0=52 +lon_0=10 +lat_1=35 +lat_2=65 +x_0=4000000 +y_0=2800000 ${GRS80_0} +units=m +no_defs`,
  3035: `+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 ${GRS80_0} +units=m +no_defs`,
  2154: `+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 ${GRS80_0} +units=m +no_defs`,
  5070: `+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 ${GRS80_0} +units=m +no_defs`,
  3577: `+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${GRS80_0} +units=m +no_defs`,
  2193: `+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 ${GRS80_0} +units=m +no_defs`,
  3006: UTM(33, GRS80_0),
  27700: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
  31467: '+proj=tmerc +lat_0=0 +lon_0=9 +k=1 +x_0=3500000 +y_0=0 +ellps=bessel +towgs84=598.1,73.7,418.2,0.202,0.045,-2.455,6.7 +units=m +no_defs',
  28992: '+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725 +units=m +no_defs',
  2056: '+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs',
  4230: '+proj=longlat +ellps=intl +towgs84=-87,-98,-121,0,0,0,0 +no_defs',
  4267: '+proj=longlat +ellps=clrk66 +towgs84=-8,160,176,0,0,0,0 +no_defs',
  4277: '+proj=longlat +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +no_defs',
  4301: '+proj=longlat +ellps=bessel +towgs84=-146.414,507.337,680.507,0,0,0,0 +no_defs',
  4284: '+proj=longlat +ellps=krass +towgs84=23.92,-141.27,-80.9,0,0.35,0.82,-0.12 +no_defs',
  4258: `+proj=longlat ${GRS80_0} +no_defs`,
  4283: `+proj=longlat ${GRS80_0} +no_defs`,
  7844: `+proj=longlat ${GRS80_0} +no_defs`,
  4322: '+proj=longlat +ellps=WGS72 +towgs84=0,0,4.5,0,0,0.554,0.2263 +no_defs',
  // NAD83 / California zones 5 and 6 (US survey feet): common for US LiDAR deliveries.
  2229: `+proj=lcc +lat_0=33.5 +lon_0=-118 +lat_1=35.4666666666667 +lat_2=34.0333333333333 +x_0=2000000.0001016 +y_0=500000.0001016 ${GRS80_0} +units=us-ft +no_defs`,
  2230: `+proj=lcc +lat_0=32.1666666666667 +lon_0=-116.25 +lat_1=33.8833333333333 +lat_2=32.7833333333333 +x_0=2000000.0001016 +y_0=500000.0001016 ${GRS80_0} +units=us-ft +no_defs`,
};
for (const z of range(1, 22)) EPSG[26700 + z] = UTM(z, '+ellps=clrk66 +towgs84=-8,160,176,0,0,0,0'); // NAD27 UTM
for (const z of range(1, 23)) EPSG[26900 + z] = UTM(z, GRS80_0); // NAD83 UTM
for (const z of range(28, 38)) EPSG[23000 + z] = UTM(z, '+ellps=intl +towgs84=-87,-98,-121,0,0,0,0'); // ED50 UTM
for (const z of range(28, 38)) EPSG[25800 + z] = UTM(z, GRS80_0); // ETRS89 UTM
for (const z of range(48, 58)) EPSG[28300 + z] = UTM(z, `+south ${GRS80_0}`); // GDA94 MGA
for (const z of range(46, 59)) EPSG[7800 + z] = UTM(z, `+south ${GRS80_0}`); // GDA2020 MGA
for (const z of range(2, 32)) EPSG[28400 + z] = `+proj=tmerc +lat_0=0 +lon_0=${6 * z - 3} +k=1 +x_0=${z * 1e6 + 500000} +y_0=0 +ellps=krass +towgs84=23.92,-141.27,-80.9,0,0.35,0.82,-0.12 +units=m +no_defs`; // Pulkovo GK
for (const z of range(1, 60)) {
  EPSG[32200 + z] = UTM(z, '+ellps=WGS72 +towgs84=0,0,4.5,0,0,0.554,0.2263'); // WGS 72 UTM N
  EPSG[32300 + z] = UTM(z, '+south +ellps=WGS72 +towgs84=0,0,4.5,0,0,0.554,0.2263');
}

/** Datum accuracy note for a proj4 definition or WKT. */
export function datumNote(def) {
  if (/datum=WGS84|WGS.?(19)?84/i.test(def) && !/towgs84=(?!0,0,0,0,0,0,0)/.test(def)) return { name: 'WGS 84', acc: 0 };
  const d = DATUMS.find((x) => x.re.test(def));
  if (d) return { name: d.name, acc: d.acc };
  if (/ellps=clrk66/.test(def)) return { name: 'NAD27 (CONUS mean)', acc: 5 };
  if (/ellps=GRS80/.test(def) && /towgs84=0,0,0/.test(def)) return { name: 'GRS80 frame (≈ WGS 84)', acc: 2 };
  if (/towgs84=/.test(def)) return { name: 'datum with towgs84', acc: 5 };
  return { name: 'unknown datum (treated as WGS 84)', acc: NaN };
}

/** Add TOWGS84 to a WKT whose datum we know but which lacks one (proj4js would ignore the datum). */
function withTowgs84(wkt) {
  if (/TOWGS84/i.test(wkt)) return wkt;
  const d = DATUMS.find((x) => x.re.test(wkt));
  if (!d) return wkt;
  return wkt.replace(/(DATUM\s*\[\s*"[^"]*"\s*,\s*SPHEROID\s*\[[^\]]*\])/i, `$1,TOWGS84[${d.towgs84}]`);
}

/** CRS definitions the PROJ data pack supplied for codes outside the embedded table (REQ-GEO-12). */
export const PACK_DEFS = new Map();
export function registerPackDef(epsg, def, name = '', conv = null) {
  PACK_DEFS.set(Number(epsg), { def, name, conv });
}

/** Resolve an EPSG code or WKT/PROJ text to {def, label, note} or null. */
export function crsOf({ epsg = null, wkt = null } = {}) {
  if (epsg && EPSG[epsg]) return { def: EPSG[epsg], label: `EPSG:${epsg}`, note: datumNote(EPSG[epsg]) };
  if (epsg && PACK_DEFS.has(Number(epsg))) {
    const p = PACK_DEFS.get(Number(epsg));
    // With a PROJ converter, the datum shift is PROJ's best available transformation.
    return { def: p.def, label: `EPSG:${epsg}${p.name ? ` ${p.name}` : ''} (PROJ pack)`, note: p.conv ? { name: 'PROJ transformation to WGS 84', acc: 1 } : datumNote(p.def), pack: true, conv: p.conv };
  }
  if (epsg) {
    try {
      const d = proj4.defs(`EPSG:${epsg}`);
      if (d) return { def: `EPSG:${epsg}`, label: `EPSG:${epsg}`, note: { name: d.datumCode === 'WGS84' || d.datum?.datum_type === 4 ? 'WGS 84' : d.datumCode ?? 'datum', acc: d.datumCode === 'WGS84' ? 0 : 2 } };
    } catch {
      /* not known to proj4js */
    }
  }
  if (wkt && /PROJCS|GEOGCS|PROJCRS|GEOGCRS|\+proj=/i.test(wkt)) {
    const def = /\+proj=/.test(wkt) ? wkt : withTowgs84(wkt);
    try {
      proj4(def, WGS84, [0, 0]);
      const name = /(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS)\s*\[\s*"([^"]+)"/i.exec(wkt)?.[1] ?? 'WKT CRS';
      return { def, label: name, note: datumNote(wkt) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Forward and inverse converters between a CRS and WGS 84 lon/lat. */
export function converter(crs) {
  if (crs.conv) return crs.conv;
  const p = proj4(crs.def, WGS84);
  return { toLonLat: (x, y) => p.forward([x, y]), fromLonLat: (lon, lat) => p.inverse([lon, lat]) };
}

/**
 * A map model for a CRS the core does not know: lon/lat from proj4js on a grid over the
 * image, fitted with the core's third-order polynomial GCP model, then checked on a denser
 * grid. Returns {id, residualMax, residualRms} (metres) — the residual goes in the model note.
 */
export function fittedMapModel(core, gt, crs, width, height, name) {
  const conv = converter(crs);
  const pt = (px, py) => {
    const x = gt[0] + gt[1] * px + gt[2] * py;
    const y = gt[3] + gt[4] * px + gt[5] * py;
    const [lon, lat] = conv.toLonLat(x, y);
    return { x: px, y: py, lat, lon };
  };
  const n = 11;
  const gcps = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) gcps.push(pt((width * i) / (n - 1), (height * j) / (n - 1)));
  if (gcps.some((g) => !Number.isFinite(g.lat) || !Number.isFinite(g.lon))) throw new Error(`${crs.label}: the projection is undefined over part of the image`);
  const id = core.gcpModel(gcps, 3, name);
  let max = 0;
  let ss = 0;
  let k = 0;
  const m = 21;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < m; i++) {
      const t = pt((width * (i + 0.5)) / m, (height * (j + 0.5)) / m);
      const g = core.i2g(id, t.x, t.y, 0);
      const d = core.inverse(g.lat, g.lon, t.lat, t.lon).distance;
      max = Math.max(max, d);
      ss += d * d;
      k++;
    }
  return { id, residualMax: max, residualRms: Math.sqrt(ss / k) };
}
