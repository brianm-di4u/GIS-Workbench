// Time series of images (REQ-GAP-83): the pure parts. Dates of a layer (from its bands, as CF time
// gives them, or from its file name), decimal years for the trend, calendar-month groups for the
// anomaly, and the temporal profile's statistics and CSV rows. No DOM and no app state.

const pad = (n, w = 2) => String(n).padStart(w, '0');
const iso = (y, m, d, hh = 0, mm = 0, ss = 0) => `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:${pad(ss)}Z`;
const valid = (y, m, d) => y >= 1950 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const fromDoy = (y, doy) => {
  if (!(y >= 1950 && y <= 2100 && doy >= 1 && doy <= (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 366 : 365))) return null;
  const t = new Date(Date.UTC(y, 0, doy));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};

/**
 * Acquisition date of an image from its file name, or null. Knows Landsat Collection 1 and 2
 * product names (LC08_L2SP_044034_20200715_…, LC80440342020197LGN00), Sentinel-2 product and tile
 * names (S2A_MSIL2A_20200715T183921_…, T10SFG_20200715T183921_B04_10m) and MODIS (MOD13Q1.A2020193…),
 * then any one unambiguous YYYYMMDD or YYYY-MM-DD date in the name.
 */
export function dateFromName(name) {
  const s = String(name ?? '').replace(/^.*[\\/]/, '');
  let m = /^L[COTEM]0\d_[A-Z0-9]{4}_\d{6}_(\d{4})(\d{2})(\d{2})_/i.exec(s);
  if (m && valid(+m[1], +m[2], +m[3])) return iso(+m[1], +m[2], +m[3]);
  m = /^L[COTEM]\d\d{6}(\d{4})(\d{3})[A-Z]{3}\d{2}/i.exec(s);
  if (m) return fromDoy(+m[1], +m[2]);
  m = /(?:^S2[ABCD]_MSIL[12][AC]_|^T\d{2}[A-Z]{3}_)(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/i.exec(s);
  if (m && valid(+m[1], +m[2], +m[3])) return iso(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  m = /^M[OY]D\w*\.A(\d{4})(\d{3})\./i.exec(s);
  if (m) return fromDoy(+m[1], +m[2]);
  const found = new Set();
  for (const x of s.matchAll(/(?<!\d)(\d{4})-?(\d{2})-?(\d{2})(?!\d)/g)) if (valid(+x[1], +x[2], +x[3])) found.add(iso(+x[1], +x[2], +x[3]));
  return found.size === 1 ? [...found][0] : null;
}

/** An ISO date ("2020-07-15", "2020-07-15T18:39:21Z", or the "YYYY-MM-DD hh:mm:ssZ" the app writes) → its parts, or null. */
export function isoParts(s) {
  const m = /^(-?\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/.exec(String(s ?? ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3], hh: +(m[4] ?? 0), mm: +(m[5] ?? 0), ss: +(m[6] ?? 0) } : null;
}

/** Month lengths of a year in a CF calendar (gregorian and standard as proleptic Gregorian). */
function monthsOf(y, calendar) {
  const c = String(calendar ?? 'standard').toLowerCase();
  if (c === '360_day') return Array(12).fill(30);
  const leap = c === 'noleap' || c === '365_day' ? false : c === 'all_leap' || c === '366_day' ? true : c === 'julian' ? y % 4 === 0 : (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
}

/**
 * The year and its fraction elapsed in the date's own calendar: 2020-07-02T12:00Z → 2020.5. The
 * trend's slope is per one of these years. Counted from the date's parts, so model calendars
 * (2001-02-30 in 360_day) and years before 100 keep their order.
 */
export function decimalYear(s, calendar = 'standard') {
  const p = isoParts(s);
  if (!p) return NaN;
  const ms = monthsOf(p.y, calendar);
  let before = 0;
  for (let i = 0; i < p.m - 1; i++) before += ms[i];
  const len = ms.reduce((a, b) => a + b, 0);
  return p.y + (before + p.d - 1 + (p.hh + p.mm / 60 + p.ss / 3600) / 24) / len;
}

/** The CF calendar of a layer's band dates ('standard' when none is given). */
/**
 * A grid read every `step` pixels from `x0` (the cube reader's decimation, and gw_model_window's
 * model of it): output pixel `o` is source pixel x0 + o·step, so its centre is at x0 + o·step + 0.5.
 */
export const gridCentre = (x0, step, o) => x0 + o * step + 0.5;
/** The index, in a grid read every `step` pixels from `x0`, of the sample nearest image coordinate `x` (pixel i spans [i, i + 1)). */
export const nearestSample = (x, x0, step) => Math.round((x - 0.5 - x0) / step);

export const layerCalendar = (bandsMeta) => bandsMeta?.[0]?.calendar ?? 'standard';

/**
 * Dates of a layer as ISO strings, one per band, or null: every band's own time, else the layer's
 * dates. Only dates in strictly increasing order make a series: a variable with a level as well
 * as a time (time × level bands) repeats its dates and is not one.
 */
export function layerDates(bandsMeta, info = {}) {
  const b = bandsMeta ?? [];
  const cal = layerCalendar(b);
  const rising = (d) => d.every((x, i) => isoParts(x) && (!i || decimalYear(x, cal) > decimalYear(d[i - 1], cal)));
  const own = b.map((x) => x?.time);
  if (b.length && rising(own)) return own;
  const d = info?.timeSeries?.dates;
  return Array.isArray(d) && d.length === b.length && rising(d) ? d.slice() : null;
}

/** Group of each date for the anomaly: 0 for all ('none'), or the calendar month 0–11 ('month'). */
export const groupsOf = (dates, by = 'none') => dates.map((s) => (by === 'month' ? (isoParts(s)?.m ?? 1) - 1 : 0));

/** Baseline flags: the dates from `from` to `to` inclusive (ISO date strings; either may be empty). */
export function baselineFlags(dates, from, to) {
  const key = (s) => String(s ?? '').slice(0, 10);
  return dates.map((s) => (!from || key(s) >= key(from)) && (!to || key(s) <= key(to)));
}

/**
 * Temporal profile of a block of pixels (BIP f32, nt values each): per date, the mean, standard
 * deviation and count of the values present. A missing value (not finite) drops only that date
 * of that pixel, so a cloud on one date does not remove the pixel from the others.
 */
export function profileStats(v, nt) {
  const n = new Array(nt).fill(0);
  const s = new Array(nt).fill(0);
  const s2 = new Array(nt).fill(0);
  for (let i = 0; i + nt <= v.length; i += nt) {
    for (let k = 0; k < nt; k++) {
      const x = v[i + k];
      if (Number.isFinite(x)) {
        n[k]++;
        s[k] += x;
        s2[k] += x * x;
      }
    }
  }
  const mean = s.map((x, k) => (n[k] ? x / n[k] : NaN));
  const std = s2.map((x, k) => (n[k] ? Math.sqrt(Math.max(0, x / n[k] - mean[k] ** 2)) : NaN));
  return { mean, std, n };
}

/** CSV rows of a profile: date, value, and for a region its standard deviation and pixel count. */
export function profileRows(dates, p) {
  const region = Array.isArray(p.std);
  const rows = [region ? ['date', 'mean', 'std', 'pixels'] : ['date', 'value']];
  dates.forEach((d, k) => rows.push(region ? [d, p.mean[k], p.std[k], p.n[k]] : [d, p.mean[k]]));
  return rows;
}
