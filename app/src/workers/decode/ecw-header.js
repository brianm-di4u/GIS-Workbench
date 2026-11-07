// ECW container header (FC-02, REQ-FMT-22): Hexagon's ECW codestream has no open decoder (a paid
// SDK), so an .ecw opens as a footprint layer from its header — v2 'e' header (size, bands, cell sizes,
// origin, ER Mapper datum and projection) or v3 boxes (ihdr, gtif) — read by the Rust `legacy` bundle;
// pixels come through the sidecar. Also: the ER Mapper datum/projection names of an .ers header.

import { gwError } from '../../i18n/index.js';
import { nested } from '../errors.js';

/** An ECW file: the v2 header byte with an .ecw name, or the v3 'ecw ' signature box. */
export function isEcw(h, name = '') {
  if (h.length >= 8 && h[4] === 0x65 && h[5] === 0x63 && h[6] === 0x77 && h[7] === 0x20) return true;
  return /\.ecw$/i.test(name);
}

/** The refusal for an ECW file whose header cannot be read (REQ-FMT-56: names the route). */
export function ecwRefusal(why = '') {
  return ecwRefusalError(why).message;
}

/** The same as an Error with its message key; `why` is the reason (text or a caught Error). */
export function ecwRefusalError(why = '') {
  const reason = why instanceof Error ? nested(why) : String(why ?? '');
  return String(reason)
    ? gwError("ECW (Hexagon's proprietary wavelet format): {why}. Its pixels have no open decoder: convert it with the GIS Workbench sidecar (Convert with Sidecar, profile raster-cog) or a licensed tool (gdal_translate with the ECW SDK)", { why: reason })
    : gwError("ECW (Hexagon's proprietary wavelet format). Its pixels have no open decoder: convert it with the GIS Workbench sidecar (Convert with Sidecar, profile raster-cog) or a licensed tool (gdal_translate with the ECW SDK)");
}

/** EPSG code for an ER Mapper datum and projection pair naming a common CRS, else null. */
export function ermapperEpsg(datum, proj) {
  const d = String(datum ?? '').toUpperCase();
  const p = String(proj ?? '').toUpperCase();
  const e = /^EPSG:(\d+)$/.exec(p);
  if (e) return Number(e[1]);
  if (p === 'GEODETIC' || p === 'LL') return { WGS84: 4326, NAD83: 4269, NAD27: 4267, GDA94: 4283, ETRS89: 4258, ETRF89: 4258 }[d] ?? null;
  const z = /^(N|S)UTM(\d{1,2})$/.exec(p);
  if (z) {
    const zone = Number(z[2]);
    if (zone < 1 || zone > 60) return null;
    if (d === 'WGS84') return (z[1] === 'N' ? 32600 : 32700) + zone;
    if (z[1] === 'N' && d === 'NAD83' && zone <= 23) return 26900 + zone;
    if (z[1] === 'N' && d === 'NAD27' && zone <= 22) return 26700 + zone;
    return null;
  }
  const m = /^MGA(\d{2})$/.exec(p);
  if (m) return d === 'GDA94' ? 28300 + Number(m[1]) : d === 'GDA2020' ? 7800 + Number(m[1]) : null;
  return null;
}

/** ER Mapper .ers header → {gt, epsg, datum, projection, width, height, bands} (fields it has). */
export function parseErs(text) {
  const get = (k) => new RegExp(`\\b${k}\\s*=\\s*"?([^"\\r\\n]+?)"?\\s*$`, 'mi').exec(text)?.[1]?.trim();
  const num = (k) => (get(k) !== undefined ? Number(get(k)) : NaN);
  const datum = get('Datum');
  const projection = get('Projection');
  const dx = num('Xdimension');
  const dy = num('Ydimension');
  const e = Number.isFinite(num('Eastings')) ? num('Eastings') : num('Longitude');
  const n = Number.isFinite(num('Northings')) ? num('Northings') : num('Latitude');
  const rx = Number.isFinite(num('RegistrationCellX')) ? num('RegistrationCellX') : 0;
  const ry = Number.isFinite(num('RegistrationCellY')) ? num('RegistrationCellY') : 0;
  const gt = [dx, dy, e, n].every(Number.isFinite) ? [e - rx * dx, dx, 0, n + ry * dy, 0, -dy] : null;
  return { gt, epsg: ermapperEpsg(datum, projection), datum: datum ?? null, projection: projection ?? null, width: num('NrOfCellsPerLine'), height: num('NrOfLines'), bands: num('NrOfBands') };
}

/** FGDC metadata bounding coordinates (west, east, north, south in degrees), or null. */
export function fgdcBounds(text) {
  const v = (t) => Number(new RegExp(`<${t}>\\s*([-+0-9.eE]+)\\s*</${t}>`, 'i').exec(text)?.[1]);
  const b = { west: v('westbc'), east: v('eastbc'), north: v('northbc'), south: v('southbc') };
  return Object.values(b).every(Number.isFinite) && b.east > b.west && b.north > b.south ? b : null;
}
