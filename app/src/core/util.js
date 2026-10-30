// Generic helpers: ids, deep clone/equal, dotted paths with a prototype guard, emitter,
// debounce, fractional order keys. DOM-free so it runs in workers and in Node tests.

let counter = 0;

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Short, readable, unique id with a type prefix, e.g. "gfx_k3x9…". */
export function newId(prefix = 'id') {
  counter = (counter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export function splitPath(path) {
  const parts = Array.isArray(path) ? path.map(String) : String(path).split('.');
  for (const p of parts) if (FORBIDDEN.has(p)) throw new Error(`forbidden path segment "${p}"`);
  return parts;
}

export function getPath(obj, path) {
  let o = obj;
  for (const p of splitPath(path)) {
    if (o == null) return undefined;
    o = o[p];
  }
  return o;
}

/** Set a dotted path, creating plain objects on the way. Returns the previous value. */
export function setPath(obj, path, value) {
  const parts = splitPath(path);
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (o[p] == null || typeof o[p] !== 'object') o[p] = {};
    o = o[p];
  }
  const last = parts[parts.length - 1];
  const had = Object.prototype.hasOwnProperty.call(o, last);
  const prev = o[last];
  if (value === undefined) delete o[last];
  else o[last] = value;
  return had ? prev : undefined;
}

export function clone(v) {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  return structuredClone(v);
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

export class Emitter {
  #h = new Map();
  on(ev, fn) {
    if (!this.#h.has(ev)) this.#h.set(ev, new Set());
    this.#h.get(ev).add(fn);
    return () => this.off(ev, fn);
  }
  once(ev, fn) {
    const off = this.on(ev, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }
  off(ev, fn) {
    this.#h.get(ev)?.delete(fn);
  }
  emit(ev, ...args) {
    const s = this.#h.get(ev);
    if (!s) return;
    for (const fn of [...s]) {
      try {
        fn(...args);
      } catch (e) {
        console.error(`listener for "${ev}" failed`, e);
      }
    }
  }
}

export function debounce(fn, ms) {
  let t = 0;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

/** Fractional order key strictly between a and b ("" = open end). Base-36 digits. */
export function keyBetween(a = '', b = '') {
  const D = '0123456789abcdefghijklmnopqrstuvwxyz';
  let i = 0;
  let out = '';
  for (;;) {
    const ca = i < a.length ? D.indexOf(a[i]) : 0;
    const cb = i < b.length ? D.indexOf(b[i]) : D.length;
    if (cb - ca > 1) return out + D[Math.floor((ca + cb) / 2)];
    out += D[ca];
    i++;
    if (i > 64) throw new Error('order keys too long');
  }
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** Object with no prototype, for attribute bags from files (keys like __proto__ stay data). */
export function bag(entries = []) {
  const o = Object.create(null);
  for (const [k, v] of entries) o[k] = v;
  return o;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Yield to the event loop (scheduler.yield where available). */
export function yieldNow() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  return new Promise((r) => setTimeout(r, 0));
}

/** Min and max of a numeric array of any length (Math.min(...a) overflows the stack past ~10⁵ items). */
export const minOf = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);
export const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);

/**
 * The reason for a failed open, in words. A parser reading past the end of a cut or damaged file
 * throws the browser's own text ("Offset is outside the bounds of the DataView", typed-array lengths),
 * and a decoder that hits a WebAssembly trap says "unreachable": both reached users as raw exceptions
 * (TE 2.0.4 cross, damaged-file pass c56).
 */
export function errorText(e) {
  const m = String(e?.message ?? e ?? '');
  if (/DataView|out of bounds|Invalid typed array|array buffer length|MAX_SAFE_INTEGER|offset is outside|Start offset/i.test(m)) return 'the file is cut short or damaged: it ends before the data it describes';
  if (/WebAssembly trap|unreachable|RuntimeError/.test(m)) return 'the decoder stopped on damaged or unsupported data (it was restarted)';
  return m;
}
