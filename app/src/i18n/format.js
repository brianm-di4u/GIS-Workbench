// Locale-aware display formatting (REQ-L10N-06, REQ-L10N-08). For text the user reads only:
// files, exports, the project file, CSV/GeoJSON and "copy as value" keep invariant '.' decimals
// and ISO 8601 (call toFixed / toISOString there). Coordinates keep their standard notation in
// every locale (REQ-L10N-07) and are formatted by the core, not here.

import { locale, PSEUDO } from './index.js';
import { t } from './index.js';

const fmts = new Map();
const loc = () => (PSEUDO[locale()] ? 'en' : locale());
function nf(opts) {
  const l = loc();
  const k = `${l}|${JSON.stringify(opts)}`;
  let f = fmts.get(k);
  if (!f) {
    try {
      f = new Intl.NumberFormat(l, opts);
    } catch {
      f = new Intl.NumberFormat('en', opts);
    }
    fmts.set(k, f);
  }
  return f;
}

/** A number with exactly d decimals ('–' when not finite) and the locale's decimal sign; no digit grouping unless asked, so analytic values read the same in every view. */
export function num(v, d = 2, { group = false } = {}) {
  return Number.isFinite(v) ? nf({ minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: group, signDisplay: 'negative' }).format(Number(v.toFixed(Math.min(100, Math.max(0, d))))) : '–'; // the digits toFixed gives, in the locale's notation
}
/** Up to d decimals, trailing zeros dropped. */
export const numMax = (v, d = 2) => (Number.isFinite(v) ? nf({ maximumFractionDigits: d, useGrouping: false }).format(v) : '–');
/** A whole number with grouping (1 234 567 / 1,234,567 / 1.234.567). */
export const int = (v) => (Number.isFinite(v) ? nf({ maximumFractionDigits: 0 }).format(v) : '–');
/** 0.123 → "12.3 %" in the locale's style. */
export const pct = (v, d = 1) => (Number.isFinite(v) ? nf({ style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d }).format(v) : '–');

const dfmt = (opts) => {
  try {
    return new Intl.DateTimeFormat(loc(), opts);
  } catch {
    return new Intl.DateTimeFormat('en', opts);
  }
};
/** A date for display; UTC by default, which imagery metadata uses. */
export const date = (d, { utc = true, style = 'medium' } = {}) => {
  const x = d instanceof Date ? d : new Date(d);
  return Number.isFinite(x.getTime()) ? dfmt({ dateStyle: style, timeZone: utc ? 'UTC' : undefined }).format(x) : '–';
};
/** Date and time for display, with "UTC" when utc. */
export const dateTime = (d, { utc = true, seconds = true } = {}) => {
  const x = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(x.getTime())) return '–';
  const s = dfmt({ dateStyle: 'medium', timeStyle: seconds ? 'medium' : 'short', timeZone: utc ? 'UTC' : undefined, hourCycle: 'h23' }).format(x);
  return utc ? `${s} UTC` : s;
};

/** ['a','b','c'] → "a, b and c" in the locale. */
export function list(items, type = 'conjunction') {
  const a = [...items].map(String);
  try {
    return new Intl.ListFormat(loc(), { style: 'long', type }).format(a);
  } catch {
    return a.join(', ');
  }
}

/** Byte counts: "12.4 MB". */
export function bytes(n) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (Math.abs(v) >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${numMax(v, i === 0 ? 0 : v < 10 ? 2 : 1)} ${u[i]}`;
}

/** A locale-aware collator for sorting labels. */
export const collator = () => {
  try {
    return new Intl.Collator(loc(), { sensitivity: 'base', numeric: true });
  } catch {
    return new Intl.Collator('en', { sensitivity: 'base', numeric: true });
  }
};

/** Words of a string for search: Intl.Segmenter for scripts without spaces (CJK, Thai). */
export function words(s) {
  const str = String(s ?? '');
  if (typeof Intl.Segmenter === 'function' && /[฀-๿぀-ヿ㐀-鿿가-힯]/.test(str)) {
    try {
      return [...new Intl.Segmenter(loc(), { granularity: 'word' }).segment(str)].filter((x) => x.isWordLike).map((x) => x.segment.toLowerCase());
    } catch {
      /* fall through */
    }
  }
  return str.toLowerCase().split(/[\s/,.;:()[\]–—-]+/).filter(Boolean);
}

// ---- units (REQ-L10N-08): stored values stay SI; the preference picks what is shown ----
let unitSystem = 'metric';
export const setUnits = (u) => {
  unitSystem = ['metric', 'imperial', 'nautical'].includes(u) ? u : 'metric';
};
export const units = () => unitSystem;
const FT = 0.3048;
const MI = 1609.344;
const NMI = 1852;

/** A length in metres for display: "12.3 m", "4.56 km", "40.4 ft", "2.15 mi", "1.21 NM". */
export function length(m, d = null) {
  if (!Number.isFinite(m)) return '–';
  const a = Math.abs(m);
  if (unitSystem === 'imperial') return a < MI * 0.1 ? `${num(m / FT, d ?? (a / FT < 100 ? 1 : 0))} ${t('ft')}` : `${num(m / MI, d ?? 2)} ${t('mi')}`;
  if (unitSystem === 'nautical') return a < NMI * 0.1 ? `${num(m / FT, d ?? (a / FT < 100 ? 1 : 0))} ${t('ft')}` : `${num(m / NMI, d ?? 2)} ${t('NM')}`;
  return a < 1000 ? `${num(m, d ?? (a < 100 ? 2 : 1))} ${t('m')}` : `${num(m / 1000, d ?? 3)} ${t('km')}`;
}
/** A height or elevation in metres: always m or ft (never miles). */
export function height(m, d = 1) {
  if (!Number.isFinite(m)) return '–';
  return unitSystem === 'metric' ? `${num(m, d)} ${t('m')}` : `${num(m / FT, d)} ${t('ft')}`;
}
/** An area in square metres: m², km², ha; ft², acres, mi². */
export function area(m2) {
  if (!Number.isFinite(m2)) return '–';
  const a = Math.abs(m2);
  if (unitSystem === 'metric') return a < 1e6 ? `${num(m2, a < 100 ? 2 : 0)} ${t('m²')}` : `${num(m2 / 1e6, 3)} ${t('km²')}`;
  const ft2 = m2 / (FT * FT);
  const acres = m2 / 4046.8564224;
  if (acres < 1) return `${num(ft2, 0)} ${t('ft²')}`;
  return acres < 640 ? `${num(acres, 2)} ${t('acres')}` : `${num(m2 / (MI * MI), 3)} ${t('mi²')}`;
}
/** A speed in m/s: km/h, mph or knots. */
export function speed(ms) {
  if (!Number.isFinite(ms)) return '–';
  if (unitSystem === 'imperial') return `${num(ms * 2.2369362921, 1)} ${t('mph')}`;
  if (unitSystem === 'nautical') return `${num(ms * 1.9438444924, 1)} ${t('kn')}`;
  return `${num(ms * 3.6, 1)} ${t('km/h')}`;
}
