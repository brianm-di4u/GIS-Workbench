// Autolabels (REQ-IMG-28, REQ-PRD-02, AT-16.3): tokens such as {IMAGE_ID}, {ACQ_DATE},
// {MGRS_CENTER}, {USER} and {NOW_UTC}, with substrings and fallbacks —
// {IMAGE_ID[0:12]|n/a} — resolved from the image, the view and the project. A token never
// prints blank: without a value or fallback it prints [n/a].

import { t, N_ } from '../i18n/index.js';
import { num, int, length } from '../i18n/format.js';

/** Token descriptions, marked for translation: show them with tr(). */
export const TOKENS = {
  IMAGE_ID: N_('Image ID (IID2/IID1 or file name)'),
  ACQ_DATE: N_('Acquisition date and time, UTC'),
  ACQ_DAY: N_('Acquisition date, UTC'),
  SENSOR: N_('Sensor / platform'),
  MGRS_CENTER: N_('MGRS of the centre (10 digits, truncated)'),
  LATLON_CENTER: N_('Latitude, longitude of the centre (WGS 84)'),
  GSD: N_('Ground sample distance at the centre'),
  SCALE: N_('Nominal scale (1:n) of the frame'),
  SUN: N_('Sun azimuth / elevation'),
  OBLIQUITY: N_('Obliquity (sensor elevation)'),
  MODEL: N_('Sensor model'),
  PROJECT: N_('Project name'),
  USER: N_('Analyst (Preferences)'),
  NOW_UTC: N_('Current time, UTC'),
  CHIP_NO: N_('Chip number'),
  FILE: N_('File name'),
};

const pad = (n) => String(n).padStart(2, '0');
export const isoUtc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;

/** IDATIM (CCYYMMDDhhmmss), TIFF DateTime or ISO → 'YYYY-MM-DD hh:mm:ssZ'; '' when unknown. */
export function acqTime(s) {
  const t = String(s ?? '').replace(/\0/g, '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}Z`;
  m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(t);
  return t && !Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}/.test(t) ? isoUtc(d) : '';
}

/** Values for a view over a layer: ctx = {app, layer, view (ChipView or pane), chipNo, scale}. */
export function tokenValues({ app, layer: l, view: v, chipNo = null, scale = null }) {
  const out = {};
  const sh = l?.info?.subheader ?? {};
  out.IMAGE_ID = sh.IID2?.trim() || sh.IID1?.trim() || l?.info?.iid || l?.rec?.name || '';
  out.FILE = l?.info?.fileName ?? '';
  out.ACQ_DATE = acqTime(l?.info?.datetime);
  out.ACQ_DAY = out.ACQ_DATE.slice(0, 10);
  out.SENSOR = sh.ISORCE?.trim() || l?.info?.meta?.gdalMetadata?.match(/SATELLITEID[^>]*>([^<]+)/)?.[1] || '';
  out.MODEL = l?.modelName ?? '';
  out.PROJECT = app.project()?.name ?? '';
  out.USER = app.prefs.get('analyst') ?? '';
  out.NOW_UTC = isoUtc(new Date());
  out.CHIP_NO = chipNo === null ? '' : String(chipNo);
  if (l?.modelId && v) {
    const { w, h } = v.size();
    const c = v.imagePoint(w / 2, h / 2);
    const g = l.groundAt(c.x, c.y);
    if (g) {
      try {
        out.MGRS_CENTER = app.core.mgrs(g.lat, g.lon, 5);
      } catch {
        out.MGRS_CENTER = '';
      }
      out.LATLON_CENTER = `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}`;
      try {
        const e = app.core.pointError(l.modelId, c.x, c.y, g.h, 0.5);
        out.GSD = Number.isFinite(e.gsd) ? length(e.gsd, e.gsd < 1 ? 2 : 1) : '';
      } catch {
        out.GSD = '';
      }
      const sun = l.info.sun ?? app.sunFor?.(l, g);
      out.SUN = sun ? `${num(sun.azimuth, 1)}° / ${num(sun.elevation, 1)}°` : '';
      const s = app.sensorAzimuth?.(l, g);
      out.OBLIQUITY = s ? t('{obliquity}° (azimuth {azimuth}°)', { obliquity: num(90 - s.elevation, 1), azimuth: num(s.azimuth, 0) }) : '';
    }
  }
  out.SCALE = scale ? `1:${int(Math.round(scale))}` : '';
  return out;
}

/** Resolve {TOKEN[a:b]|fallback} occurrences in a template string. */
export function resolveTokens(text, values) {
  return String(text ?? '').replace(/\{([A-Z_]+)(?:\[(-?\d*):(-?\d*)\])?(?:\|([^}]*))?\}/g, (m, name, a, b, fb) => {
    if (name === 'CLASSIFICATION') return ''; // a retired token in an older template prints nothing
    let v = values[name];
    if (v === undefined || v === null || v === '') return fb !== undefined && fb !== '' ? fb : t('[n/a]');
    v = String(v);
    if (a !== undefined || b !== undefined) v = v.slice(a === '' || a === undefined ? 0 : Number(a), b === '' || b === undefined ? undefined : Number(b));
    return v === '' ? fb || t('[n/a]') : v;
  });
}
