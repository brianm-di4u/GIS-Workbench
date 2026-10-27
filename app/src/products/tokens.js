// Autolabels (REQ-IMG-28, REQ-PRD-02, AT-16.3): tokens such as {IMAGE_ID}, {ACQ_DATE},
// {CLASSIFICATION}, {MGRS_CENTER}, {USER} and {NOW_UTC}, with substrings and fallbacks —
// {IMAGE_ID[0:12]|n/a} — resolved from the image, the view and the project. A token never
// prints blank: without a value or fallback it prints [n/a].

export const TOKENS = {
  IMAGE_ID: 'Image ID (IID2/IID1 or file name)',
  ACQ_DATE: 'Acquisition date and time, UTC',
  ACQ_DAY: 'Acquisition date, UTC',
  SENSOR: 'Sensor / platform',
  CLASSIFICATION: 'Banner text of the product marking',
  MGRS_CENTER: 'MGRS of the centre (10 digits, truncated)',
  LATLON_CENTER: 'Latitude, longitude of the centre (WGS 84)',
  GSD: 'Ground sample distance at the centre',
  SCALE: 'Nominal scale (1:n) of the frame',
  SUN: 'Sun azimuth / elevation',
  OBLIQUITY: 'Obliquity (sensor elevation)',
  MODEL: 'Sensor model',
  PROJECT: 'Project name',
  USER: 'Analyst (Preferences)',
  NOW_UTC: 'Current time, UTC',
  CHIP_NO: 'Chip number',
  FILE: 'File name',
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

/** Values for a view over a layer: ctx = {app, layer, view (ChipView or pane), chipNo, scale, marking}. */
export function tokenValues({ app, layer: l, view: v, chipNo = null, scale = null, marking = null }) {
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
  out.CLASSIFICATION = marking ?? '';
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
        out.GSD = Number.isFinite(e.gsd) ? `${e.gsd < 1 ? e.gsd.toFixed(2) : e.gsd.toFixed(1)} m` : '';
      } catch {
        out.GSD = '';
      }
      const sun = l.info.sun ?? app.sunFor?.(l, g);
      out.SUN = sun ? `${sun.azimuth.toFixed(1)}° / ${sun.elevation.toFixed(1)}°` : '';
      const s = app.sensorAzimuth?.(l, g);
      out.OBLIQUITY = s ? `${(90 - s.elevation).toFixed(1)}° (azimuth ${s.azimuth.toFixed(0)}°)` : '';
    }
  }
  out.SCALE = scale ? `1:${Math.round(scale).toLocaleString('en-GB')}` : '';
  return out;
}

/** Resolve {TOKEN[a:b]|fallback} occurrences in a template string. */
export function resolveTokens(text, values) {
  return String(text ?? '').replace(/\{([A-Z_]+)(?:\[(-?\d*):(-?\d*)\])?(?:\|([^}]*))?\}/g, (m, name, a, b, fb) => {
    let v = values[name];
    if (v === undefined || v === null || v === '') return fb !== undefined && fb !== '' ? fb : '[n/a]';
    v = String(v);
    if (a !== undefined || b !== undefined) v = v.slice(a === '' || a === undefined ? 0 : Number(a), b === '' || b === undefined ? undefined : Number(b));
    return v === '' ? (fb || '[n/a]') : v;
  });
}
