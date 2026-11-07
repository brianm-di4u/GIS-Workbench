// Errors that keep their message key across the worker boundary (REQ-L10N-05, DN-62). A worker
// has no catalogue: it throws English errors carrying `.i18n = {src, params}` (gwError), the
// worker core posts the key with the message, and the pool rebuilds the Error on the main thread,
// where msgOf(e) shows it in the UI language.
//
// A Rust error with values carries its template too (gw-abi `err!`): `gw_last_error_i18n` gives
// `{"src": "zone {zone} not in [1,60]", "params": {"zone": "61"}}` next to the status code.
//
// A message that wraps another one ("JPEG 2000 tile {t}: {msg}") passes the inner error as
// `nested(e)`: a Msg, which reads as English in the worker and in the UI language once the pool
// has revived it. Number params are passed as strings: ICU would group them ("12,345"), and the
// English text must stay as it was.

import { t, en } from '../i18n/index.js';

const dec = new TextDecoder();

/** A message inside another message's params. String(m) is the message in the current language. */
export class Msg {
  constructor(src, params = null) {
    this.src = src;
    this.params = params;
  }
  toString() {
    return t(this.src, this.params ?? undefined);
  }
}

/**
 * The inner error of a wrapping message: a Msg when it has a key; a static message (which the
 * catalogue may hold as it is, like msgOf) as a Msg too, unless ICU would read its text
 * differently; else its text.
 */
export function nested(e) {
  if (e?.i18n?.src) return new Msg(e.i18n.src, e.i18n.params);
  const s = String(e?.message ?? e ?? '');
  return s && !/[{}'#]/.test(s) ? new Msg(s) : s;
}

/** {src, params} as plain data for postMessage (nested Msg values become plain objects). */
export function plain(i18n) {
  if (!i18n?.src) return undefined;
  const p = i18n.params;
  if (!p || typeof p !== 'object') return { src: String(i18n.src), params: null };
  const out = {};
  for (const [k, v] of Object.entries(p)) out[k] = v && typeof v === 'object' && typeof v.src === 'string' ? plain(v) : typeof v === 'number' || typeof v === 'boolean' ? v : v === null || v === undefined ? v : String(v);
  return { src: String(i18n.src), params: out };
}

/** The reverse of plain(), on the main thread: nested messages become Msg again. */
export function revive(i18n) {
  if (!i18n || typeof i18n.src !== 'string') return null;
  const p = i18n.params;
  if (!p || typeof p !== 'object') return { src: i18n.src, params: null };
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === 'object' && typeof v.src === 'string') {
      const r = revive(v);
      out[k] = new Msg(r.src, r.params);
    } else out[k] = v;
  }
  return { src: i18n.src, params: out };
}

/** The template of a WASM bundle's last error, or null (a bundle built before 2.3 has none). */
export function lastI18n(B) {
  const x = B?.x;
  if (typeof x?.gw_last_error_i18n !== 'function') return null;
  let cap = 2048;
  for (let tries = 0; tries < 2; tries++) {
    const p = x.gw_alloc(cap);
    if (!p) return null;
    try {
      const n = x.gw_last_error_i18n(p, cap);
      if (!n) return null;
      if (n > cap) {
        cap = n;
        continue;
      }
      const j = JSON.parse(dec.decode(new Uint8Array(x.memory.buffer, p, n)));
      return typeof j?.src === 'string' ? { src: j.src, params: j.params && typeof j.params === 'object' ? j.params : null } : null;
    } catch {
      return null;
    } finally {
      x.gw_free(p, cap);
    }
  }
  return null;
}

/** The key of a message with values whose English text is `msg`, from bundle B. */
export function keyFor(B, msg) {
  const k = lastI18n(B);
  return k && en(k.src, k.params) === msg ? k : null;
}

/**
 * The last error of WASM bundle B as an Error: the English message as before, with its key when
 * the Rust message has values. Extra fields (e.g. {code: rc}) are assigned to it.
 */
export function wasmError(B, extra) {
  const msg = B.lastError();
  const e = new Error(msg);
  const k = keyFor(B, msg);
  if (k) e.i18n = k;
  return extra ? Object.assign(e, extra) : e;
}
