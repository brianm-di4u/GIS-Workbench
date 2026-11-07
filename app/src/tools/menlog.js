// Mensuration Log rows (REQ-MEN-01, AC-02.2, Research/03 §5.3): the columns and one row as
// display strings, shared by the dock panel, CSV export and reports. Empty values say N/A.
//
// Localisation (REQ-L10N-06/08): column labels are marked with N_ (show them with tr(label); a
// CSV keeps the English). menRow(m) gives the display strings in the UI language;
// menRow(m, { machine: true }) gives the English, '.'-decimal strings a CSV file keeps.

import { t, tr, N_, locale, PSEUDO } from '../i18n/index.js';
import { num, height } from '../i18n/format.js';
import { textMatcher } from '../core/record-text.js';
import { modelLabel } from '../formats/model-names.js';

export const MENLOG_COLUMNS = [
  ['mid', N_('ID')],
  ['object', N_('Object')],
  ['type', N_('Type')],
  ['value', N_('Value')],
  ['units', N_('Units')],
  ['method', N_('Method')],
  ['ce90', N_('CE90 (m)')],
  ['le90', N_('LE90 (m)')],
  ['tag', N_('Abs/Rel')],
  ['coordinates', N_('Coordinates')],
  ['image', N_('Source images')],
  ['model', N_('Sensor model')],
  ['heightSource', N_('Elevation source')],
  ['chain', N_('Image chain')],
  ['sigmaText', N_('σ inputs')],
  ['analyst', N_('Analyst')],
  ['time', N_('Time (UTC)')],
];

// The record keeps its texts in English (the project file, CSV and JSON exports, tests). The log
// shows them in the UI language: each '; '-separated part of a text that matches one of these
// templates is rendered with t(), its numbers in the locale's notation; anything else (image ids,
// DEM names, MGRS) is data and stays as it is.
const TEXTS = [
  // methods
  N_('Mono, default height'), N_('Mono-DEM'), N_('Map (2-D model)'), N_('geodesic (Karney 2013, WGS 84)'),
  N_('Mono height by layover (sensor-model vertical, {ratio} px/m)'), N_('base default height'), N_('base on the DEM'),
  N_('Mono height by shadow on flat ground: h = L·tan(e)'), N_('L {length} m along azimuth {azimuth}°'), N_('sun az {azimuth}°, el {elevation}° ({source})'),
  N_('Depth below a reference point: h(bottom) − h(reference) = {bottom} − {reference} m HAE'), N_('{distance} m apart'),
  N_('Point-to-point LOS on {surface}'), N_('observer +{observer} m, target +{target} m'), N_('curvature and refraction k = {k}'),
  N_('Stereo ({left} + {right})'), N_('Manual count'), N_('Multi-image intersection ({n} images, least squares)'),
  N_('medial axis (distance transform, {cell} m cells)'), N_('geodesic-equivalent local ENU'), N_('halfway along {distance} m (geodesic)'),
  N_('DEM volume against the {reference}: cut (above) {cut} m³, fill (below) {fill} m³ over {area} m² in {n} cells of {step} m'),
  N_('constant {h} m HAE'), N_('lowest vertex {h} m HAE'), N_('plane through the vertices'),
  // height sources
  N_('default height {h} m HAE'), N_('none (2-D model)'), N_('feature vertices'), N_('line vertices'), N_('terrain'), N_('multi-image intersection'),
  N_('stereo ({source})'), N_('manual'), N_('terrain tracking'), N_('no correlation'),
  // types, tags, units and values
  N_('Point'), N_('Distance'), N_('Area'), N_('Range & Bearing'), N_('Bracket'), N_('Height'), N_('Depth'), N_('LOS'), N_('Count'),
  N_('Medial axis'), N_('Volume'), N_('Multi-image point'), N_('Stereo point'), N_('Stereo height'), N_('Stereo distance'), N_('Stereo slope'),
  N_('absolute'), N_('relative'), N_('relative (largest segment)'), N_('relative (base to top)'), N_('relative (below the reference)'), N_('relative (above the reference)'),
  N_('objects'), N_('visible'), N_('blocked'), N_('metadata'), N_('N/A'),
];
/** One English text of a Mensuration Log record in the UI language (each '; ' part on its own). */
export const menText = textMatcher(TEXTS, { split: '; ' });

/** A record's type as shown: range ring points keep the stored mtype 'Target'. */
export const menType = (type) => (type === 'Target' ? 'Point' : type);

/** English text of a message with params, for machine output (CSV). */
const enText = (src, params) => src.replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? ''));

/** A grouped number with up to 3 decimals: the UI locale for display, en-US for CSV (as before). */
function valueText(v, machine) {
  const l = machine || PSEUDO[locale()] ? 'en-US' : locale();
  try {
    return v.toLocaleString(l, { maximumFractionDigits: 3 });
  } catch {
    return v.toLocaleString('en-US', { maximumFractionDigits: 3 });
  }
}

/** One Mensuration Log row as display strings; empty values say N/A (AC-02.2). */
export function menRow(m, { machine = false } = {}) {
  const msg = machine ? enText : t;
  const fx = machine ? (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '–') : (v, d) => num(v, d);
  const hm = machine ? (v) => `${fx(v, 2)} m` : (v) => height(v, 2);
  const word = machine ? (s) => s : menText;
  const NA = machine ? 'N/A' : t('N/A');
  const noErr = machine ? 'error not available' : t('error not available');
  let coords = '';
  if (m.coords?.mgrs) {
    const p = { mgrs: m.coords.mgrs, lat: fx(m.coords.lat, 7), lon: fx(m.coords.lon, 7), hae: hm(m.coords.hae) };
    coords =
      m.coords.msl !== null && m.coords.msl !== undefined
        ? msg('{mgrs} · {lat}, {lon} WGS 84 · {hae} HAE · {msl} MSL ({geoid})', { ...p, msl: hm(m.coords.msl), geoid: m.coords.geoid })
        : msg('{mgrs} · {lat}, {lon} WGS 84 · {hae} HAE', p);
  } else if (m.coords?.from) coords = msg('{from} → {to} (WGS 84)', { from: m.coords.from, to: m.coords.to });
  const sig = m.sigma
    ? m.sigma.perPoint
      ? m.sigma.perPoint.map((s, i) => msg('P{i}: model {model}, pick {pick}, DEM {dem}', { i: String(i + 1), model: fx(s.model, 2), pick: fx(s.pick, 2), dem: fx(s.demH, 2) })).join('; ')
      : msg('model {model} m, pick {pick} m ({px} px), DEM→horiz {demH} m, DEM vert {demV} m; {method}', { model: fx(m.sigma.model, 2), pick: fx(m.sigma.pick, 2), px: String(m.sigma.pickPx), demH: fx(m.sigma.demH, 2), demV: fx(m.sigma.demV, 2), method: machine ? m.sigma.method ?? '' : tr(m.sigma.method ?? '') })
    : '';
  const v = {
    mid: m.mid,
    object: m.object,
    type: m.mtype ?? m.type ? word(menType(m.mtype ?? m.type)) : m.mtype ?? m.type,
    value: typeof m.value === 'number' ? valueText(m.value, machine) : word(m.value),
    units: m.units === 'm' || m.units === 'm²' || m.units === 'm³' || m.units === 'MGRS' ? m.units : word(m.units),
    method: word(m.method),
    ce90: Number.isFinite(m.ce90) ? fx(m.ce90, 2) : noErr,
    le90: Number.isFinite(m.le90) ? fx(m.le90, 2) : noErr,
    tag: m.tag ? word(m.tag) : m.tag,
    coordinates: coords,
    image: m.image,
    model: machine ? m.model : typeof m.model === 'string' ? m.model.split(' + ').map(modelLabel).join(' + ') : m.model,
    heightSource: word(m.heightSource),
    chain: m.chain,
    sigmaText: sig,
    analyst: m.analyst,
    time: m.time,
  };
  for (const k of Object.keys(v)) if (v[k] === undefined || v[k] === null || v[k] === '') v[k] = NA;
  return v;
}
