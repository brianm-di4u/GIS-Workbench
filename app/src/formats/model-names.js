// Sensor and map model names for display (REQ-L10N-06). formats/open.js and the tools name each
// model in English; the layer, the project and the Mensuration Log keep that name, and code
// tests it (/^RPC/, /^Map|World/). The model menu, Model Info, the status bar and the logs show
// it through modelLabel(). Product and standard names (RPC00B, SICD, RSM, GeoTIFF) stay as they
// are inside the translated text (DN-62 rule 7).

import { N_ } from '../i18n/index.js';
import { textMatcher } from '../core/record-text.js';

export const MODEL_NAMES = [
  N_('none'),
  N_('RPC00A (remapped)'),
  N_('RSM polynomial (experimental)'),
  N_('IGEOLO corners (approximate)'),
  N_('IGEOLO corners (approximate; {note})'),
  N_('RPC (.RPB sidecar)'),
  N_('RPC (.RPB sidecar, tile at {x},{y})'),
  N_('RPC (GeoTIFF tag)'),
  N_('FGDC bounding box (approximate, EPSG:4326)'),
  N_('Annotation geolocation grid ({lines} × {pixels} points)'),
  N_('GCPs ({n}, GeoTIFF)'),
  N_('GCPs ({n}, {crs})'),
  N_('GeoPDF viewport ({n} points, {crs})'),
  N_('GeoPDF LGIDict ({crs}, {n} points)'),
  N_('GeoPDF LGIDict ({crs}, no datum stated: WGS 84 assumed, {n} points)'),
  N_('Geolocation arrays ({width} × {height}, {product})'),
  N_('Geolocation arrays ({width} × {height}, every {step}, {product})'),
  N_('Geolocation grid ({n} points, {product})'),
  N_('{map} ({crs}, fitted)'),
  N_('Map ({source})'),
  N_('Map (world file)'),
  N_('Map (.ers header)'),
  N_('{kind} projection'),
  N_('GCP (projective)'),
  N_('GCP (polynomial {order})'),
  // 2.4 (REQ-GAP-18/19/23).
  N_('RSM polynomial ({rows} × {cols} sections, experimental)'),
  N_('RSM grid (experimental)'),
  N_('RSM grid ({rows} × {cols} sections, experimental)'),
  N_('Pushbroom (CSEPHA/CSATTA, rigorous)'),
  N_('Frame camera (EXIF/XMP, {source})'),
  N_('Frame camera (SENSRB, {source})'),
  N_('Frame camera (SENSRB, {source}, altitude MSL)'),
  N_('Frame camera (EO import)'),
  N_('{model} (triangulated: {solution})'),
  // 2.5 (REQ-GAP-24): usgscsm models (sensor/csm-host.js csmModelName).
  N_('CSM frame camera (usgscsm)'),
  N_('CSM line scanner (usgscsm)'),
  N_('CSM push frame (usgscsm)'),
  N_('CSM SAR (usgscsm)'),
  // 2.5 (REQ-GAP-20).
  N_('Pushbroom (DigitalGlobe EPH/ATT/GEO, rigorous)'),
  N_('Map + line of sight (Landsat ANG)'),
  N_('Map + line of sight (Sentinel-2 MTD_TL)'),
];

/** A model name in the UI language (the English name when no template matches). */
export const modelLabel = textMatcher(MODEL_NAMES);
