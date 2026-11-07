// Service images as image layers (REQ-GAP-07), pure helpers: the request box of a lon/lat
// area in any CRS GIS Workbench knows, the image size that keeps ground pixels square, and the
// GDAL .aux.xml sidecar that georeferences the PNG a WMS GetMap, ArcGIS export or OGC API Maps
// request returns (formats/open.js reads it as it reads any world-file picture).

import { crsOf, converter } from '../geo/crs.js';
import { boxIn } from './ogc.js';
import { gwError } from '../i18n/index.js';

export const MERC_EPSG = new Set([3857, 900913, 102100, 102113, 3785]);

/** The lon/lat box of a list of lon/lat points. */
export const boxOf = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];

/**
 * A lon/lat box → {box, conv} in a CRS (x = east): the box of a 5 × 5 sample of the lon/lat box
 * projected through proj4js, or the box itself for EPSG:4326.
 */
export function boxInCrs(llbox, epsg) {
  if (epsg === 4326) return { box: llbox, conv: null };
  if (MERC_EPSG.has(epsg)) return { box: boxIn(3857, llbox), conv: null };
  const crs = crsOf({ epsg });
  if (!crs) throw gwError('EPSG:{epsg} is not in the embedded EPSG table; load the PROJ data pack or choose another CRS', { epsg: String(epsg) }, 'E_CRS_UNKNOWN');
  const conv = converter(crs);
  const pts = [];
  for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) pts.push(conv.fromLonLat(llbox[0] + ((llbox[2] - llbox[0]) * i) / 4, llbox[1] + ((llbox[3] - llbox[1]) * j) / 4));
  if (pts.some((p) => !p.every(Number.isFinite))) throw gwError('EPSG:{epsg} is not defined over this area', { epsg: String(epsg) }, 'E_CRS_UNDEFINED');
  return { box: boxOf(pts), conv };
}

/** An .aux.xml sidecar (GDAL PAM) with a geotransform and an EPSG code, as open.js reads it. */
export function auxXml(gt, epsg) {
  const srs = epsg === 4326 ? 'GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]]' : `PROJCS["EPSG:${epsg}",AUTHORITY["EPSG","${epsg}"]]`;
  return `<PAMDataset><SRS>${srs}</SRS><GeoTransform>${gt.map((v) => v.toPrecision(17)).join(', ')}</GeoTransform></PAMDataset>\n`;
}

/** Image size for a box: ground pixels close to square, the longer side `size` px (16…4096). */
export function imageSize(box, epsg, size = 1024) {
  const latc = (box[1] + box[3]) / 2;
  const gx = epsg === 4326 ? (box[2] - box[0]) * Math.cos((latc * Math.PI) / 180) : box[2] - box[0];
  const gy = box[3] - box[1];
  const s = Math.max(16, Math.min(4096, Math.round(size)));
  const [w, hh] = gx >= gy ? [s, Math.max(16, Math.round((s * gy) / gx))] : [Math.max(16, Math.round((s * gx) / gy)), s];
  return { width: w, height: hh, gt: [box[0], (box[2] - box[0]) / w, 0, box[3], 0, -(box[3] - box[1]) / hh] };
}
