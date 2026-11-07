// Localisation runtime (REQ-L10N-01..04, PRD §6.25). Messages are keyed by their English source
// text, as gettext msgids are, with an optional context for words that translate differently
// (tc('verb', 'Open')). The build extracts every t()/tc()/N_() literal into the source catalogue
// and ships each locale as the translations in key order (data block or .gwpack). English needs
// no catalogue at all.
//
//   t('Jump to Point: {msg}', { msg })          → localised and formatted
//   tc('menu', 'View')                          → with a context
//   N_('Open Image…')                           → marks a literal for extraction only (tables)
//   tr(label)                                   → translates a value marked with N_ elsewhere
//
// Pseudo-locales for testing need no catalogue: en-XA (accented, ~40 % longer, bracketed) and
// ar-XB (right to left). This module has no DOM dependency except in applyDocument(), so workers
// and the build can import it.

import { parse, format, mapText } from './icu.js';

export const CTX_SEP = '\u0004';
export const PSEUDO = { 'en-XA': { dir: 'ltr' }, 'ar-XB': { dir: 'rtl' } };
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ckb', 'ug']);

const state = {
  locale: 'en',
  base: 'en',
  dir: 'ltr',
  messages: null, // Map key → translated message (string), or null for English
  meta: null,
  missing: new Set(),
};
const asts = new Map(); // `${locale}|${message}` → AST

export const keyOf = (src, ctx) => (ctx ? `${ctx}${CTX_SEP}${src}` : src);

/** The language part of a tag, lower case: 'pt-BR' → 'pt'. */
export const langOf = (tag) => String(tag ?? 'en').split(/[-_]/)[0].toLowerCase();
export const dirOf = (tag) => (PSEUDO[tag]?.dir ?? (RTL.has(langOf(tag)) ? 'rtl' : 'ltr'));

/**
 * The best locale for a list of wanted tags among the available ones: exact tag, then same
 * language (pt-BR wanted, pt-PT available), then English.
 */
export function negotiate(wanted, available) {
  const av = [...available];
  const lower = new Map(av.map((a) => [a.toLowerCase(), a]));
  for (const w of wanted ?? []) {
    if (!w) continue;
    const hit = lower.get(String(w).toLowerCase());
    if (hit) return hit;
    const l = langOf(w);
    const same = av.find((a) => langOf(a) === l);
    if (same) return same;
  }
  return 'en';
}

function pseudoXA(text) {
  const map = { a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž', A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž' };
  const body = text.replace(/[A-Za-z]/g, (c) => map[c] ?? c);
  const pad = Math.ceil(text.replace(/\s/g, '').length * 0.4);
  return body + (pad ? `·${'~'.repeat(Math.max(0, pad - 1))}` : '');
}

function pseudoMessage(msg, locale) {
  try {
    const ast = parse(msg);
    if (locale === 'en-XA') return ['⟦', ...mapText(ast, pseudoXA), '⟧'];
    // ar-XB: right-to-left override around each text run, so a Latin string still lays out RTL.
    return mapText(ast, (s) => (s.trim() ? `‮${s}‬` : s));
  } catch {
    return [msg];
  }
}

function astFor(locale, msg) {
  const k = `${locale}|${msg}`;
  let a = asts.get(k);
  if (!a) {
    if (PSEUDO[locale]) a = pseudoMessage(msg, locale);
    else {
      try {
        a = parse(msg);
      } catch {
        a = [msg];
      }
    }
    if (asts.size > 20000) asts.clear();
    asts.set(k, a);
  }
  return a;
}

function render(src, params, ctx) {
  const key = keyOf(src, ctx);
  let msg = src;
  let loc = 'en';
  if (state.messages) {
    const m = state.messages.get(key);
    if (m !== undefined && m !== '') {
      msg = m;
      loc = state.locale;
    } else if (state.missing.size < 5000) state.missing.add(key);
  } else if (PSEUDO[state.locale]) loc = state.locale;
  // Fast path: a message with no placeholder and no quote needs no formatting.
  if (loc === 'en' && !params && !/[{}'#]/.test(msg)) return msg;
  const ast = astFor(loc, msg);
  return format(ast, params ?? {}, loc === 'en' || PSEUDO[loc] ? 'en' : state.locale);
}

/** Translate and format an English source message. */
export const t = (src, params) => render(src, params, null);
/** Translate with a context: tc('verb', 'Open'). */
export const tc = (ctx, src, params) => render(src, params, ctx);
/** Mark a literal for extraction; it is translated where it is shown, through tr(). */
export const N_ = (src) => src;
/** A marked literal with a context, for tables: shown through tr(). It reads as its English source where a string is expected (keys, logs, the API). */
export const NC_ = (ctx, src) => ({ src, ctx, toString: () => src });
/** Translate a value that may be a marked literal, a {src, params} pair, or anything else. */
export function tr(v, params) {
  if (v === null || v === undefined || v === '') return v;
  if (typeof v === 'object' && typeof v.src === 'string') return v.ctx ? tc(v.ctx, v.src, v.params) : t(v.src, v.params);
  return typeof v === 'string' ? t(v, params) : v;
}

/** English formatting of a message with params (for logs, errors and the build). */
export function en(src, params) {
  if (!params && !/[{}'#]/.test(src)) return src;
  try {
    return format(parse(src), params ?? {}, 'en');
  } catch {
    return src;
  }
}

// ---- errors that keep their message key across workers (REQ-L10N-05) ----

/** An Error whose message is the English text, carrying the key and params to localise it. */
export function gwError(src, params, code) {
  const e = new Error(en(src, params));
  e.i18n = { src, params: params ?? null };
  if (code) e.code = code;
  return e;
}

/** The message of an error in the UI language. */
export function msgOf(e) {
  if (e === null || e === undefined) return '';
  if (typeof e === 'string') return t(e);
  if (e.i18n?.src) {
    // A wrapped static detail (a Rust or worker message passed as {detail}) is translated too.
    const p = e.i18n.params;
    const d = p?.detail;
    return t(e.i18n.src, typeof d === 'string' && state.messages?.has(d) ? { ...p, detail: t(d) } : (p ?? undefined));
  }
  const m = e.message ?? String(e);
  // A static message from a worker or the Rust core may be in the catalogue as it is.
  // A pseudo-locale marks it too, so sweeps can tell shown errors from text that bypasses t().
  return state.messages?.has(m) || PSEUDO[state.locale] ? t(m) : m;
}

// ---- locale state ----

export const locale = () => state.locale;
export const dir = () => state.dir;
export const isRtl = () => state.dir === 'rtl';
export const missing = () => [...state.missing];

/**
 * Switch the locale. data: {keys: string[], values: string[]} (values in key order; '' = not
 * translated) or null for English and the pseudo-locales.
 */
export function setLocale(tag, data = null, meta = null) {
  state.locale = tag || 'en';
  state.base = langOf(state.locale);
  state.dir = dirOf(state.locale);
  state.meta = meta;
  state.missing = new Set();
  asts.clear();
  if (data && Array.isArray(data.keys) && Array.isArray(data.values)) {
    const m = new Map();
    for (let i = 0; i < data.keys.length; i++) if (data.values[i]) m.set(data.keys[i], data.values[i]);
    state.messages = m;
  } else state.messages = null;
}

/** Set lang and dir on the document (main thread only). */
export function applyDocument(doc = globalThis.document) {
  if (!doc?.documentElement) return;
  const tag = PSEUDO[state.locale] ? (state.dir === 'rtl' ? 'ar' : 'en') : state.locale;
  doc.documentElement.lang = tag;
  doc.documentElement.dir = state.dir;
  doc.documentElement.dataset.locale = state.locale;
}
