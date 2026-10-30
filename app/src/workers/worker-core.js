// Shared worker core, concatenated in front of every worker kind (Research/15 §6.3). It
// instantiates the WASM modules posted by the pool, routes jobs to the kind's handlers,
// reports progress, honours cancel flags, and survives WASM traps (REQ-RUST-04).

import { Bundle, isTrap } from '../wasm/abi.js';
import { Core } from '../wasm/core.js';

const handlers = new Map();
const cancelled = new Set();
const ctx = { modules: {}, bundles: {}, kind: null };

function bundle(name) {
  if (!ctx.bundles[name]) {
    const m = ctx.modules[name];
    if (!m) throw new Error(`WASM bundle "${name}" was not given to this worker`);
    ctx.bundles[name] = name === 'core' ? new Core(m) : new Bundle(m, name);
  }
  return ctx.bundles[name];
}

const waiting = new Map(); // module name → [{resolve, reject}]

/** A bundle that is compiled on first use: ask the pool for its module, then instantiate. */
function ensure(name) {
  if (ctx.modules[name]) return Promise.resolve(bundle(name));
  return new Promise((resolve, reject) => {
    if (!waiting.has(name)) {
      waiting.set(name, []);
      postMessage({ type: 'need-module', name });
    }
    waiting.get(name).push({ resolve, reject });
  });
}

const libWaiting = new Map(); // library name → [{resolve, reject}]
const libs = new Map(); // library name → Promise (the script has run)

/**
 * A data-pack library (REQ-ARC-14): the pool hands over bytes the main thread verified against
 * the build manifest; they run once as a classic script from a Blob URL (CSP blob:).
 */
function lib(name) {
  if (!libs.has(name)) {
    libs.set(
      name,
      new Promise((resolve, reject) => {
        libWaiting.set(name, { resolve, reject });
        postMessage({ type: 'need-lib', name });
      }).catch((e) => {
        libs.delete(name);
        throw e;
      }),
    );
  }
  return libs.get(name);
}

// Remote files (connectors/remote.js): byte ranges come from the main thread, which fetches them
// through the logged, Online-gated and signed path; the worker never fetches on its own.
const ranges = new Map();
let nextRid = 1;
function remoteRange(remoteId, start, end) {
  return new Promise((resolve, reject) => {
    const rid = nextRid++;
    ranges.set(rid, { resolve, reject });
    postMessage({ type: 'range', rid, remoteId, start, end });
  });
}
function remoteFile(d) {
  const f = { name: d.name, size: d.size, type: '', remote: true, remoteId: d.remoteId };
  f.slice = (a = 0, b = d.size) => ({ size: Math.max(0, Math.min(d.size, b) - a), arrayBuffer: () => remoteRange(d.remoteId, a, Math.min(d.size, b)) });
  f.arrayBuffer = () => remoteRange(d.remoteId, 0, d.size);
  return f;
}

const GW = {
  register(op, fn) {
    handlers.set(op, fn);
  },
  remoteFile,
  bundle,
  ensure,
  lib,
  ctx,
};
self.GW = GW;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      ctx.modules = m.modules || {};
      ctx.kind = m.kind;
      postMessage({ type: 'ready' });
    } catch (err) {
      postMessage({ type: 'init-error', error: String(err?.message || err) });
    }
    return;
  }
  if (m.type === 'lib') {
    const w = libWaiting.get(m.name);
    libWaiting.delete(m.name);
    if (!w) return;
    if (m.error) return w.reject(new Error(m.error));
    try {
      const url = URL.createObjectURL(new Blob([m.code], { type: 'text/javascript' }));
      importScripts(url);
      URL.revokeObjectURL(url);
      w.resolve(true);
    } catch (err) {
      w.reject(err);
    }
    return;
  }
  if (m.type === 'range-result') {
    const w = ranges.get(m.rid);
    ranges.delete(m.rid);
    if (!w) return;
    if (m.error) w.reject(new Error(m.error));
    else w.resolve(m.buf);
    return;
  }
  if (m.type === 'module') {
    const list = waiting.get(m.name) ?? [];
    waiting.delete(m.name);
    if (m.module) ctx.modules[m.name] = m.module;
    for (const w of list) {
      try {
        if (m.error) throw new Error(m.error);
        w.resolve(bundle(m.name));
      } catch (err) {
        w.reject(err);
      }
    }
    return;
  }
  if (m.type === 'cancel') {
    cancelled.add(m.id);
    return;
  }
  if (m.type !== 'job') return;
  const fn = handlers.get(m.op);
  if (!fn) {
    postMessage({ type: 'error', id: m.id, error: `unknown worker operation "${m.op}"` });
    return;
  }
  const job = {
    id: m.id,
    progress(p, partial) {
      postMessage({ type: 'progress', id: m.id, progress: p, partial });
    },
    checkCancel() {
      if (cancelled.has(m.id)) {
        const err = new Error('cancelled');
        err.cancelled = true;
        throw err;
      }
    },
  };
  try {
    const out = await fn(m.args ?? {}, job);
    const { result, transfer } = out && out.__transfer ? out : { result: out, transfer: [] };
    postMessage({ type: 'result', id: m.id, result }, transfer);
  } catch (err) {
    const trapped = isTrap(err) || !!err?.trapped;
    if (isTrap(err)) {
      // Discard every instance; they are re-created from the cached modules on next use.
      ctx.bundles = {};
    }
    // A failed file read surfaces as the reader's event (geotiff.js rejects with it): say what failed,
    // not "[object ProgressEvent]" (TE 2.0.4 cross, NAIP chip).
    const ev = typeof Event !== 'undefined' && err instanceof Event;
    const text = ev ? `the file could not be read (${err.target?.error?.name ?? err.type}${err.target?.error?.message ? `: ${err.target.error.message}` : ''}); if it is on a removable or network drive, check that it is still connected` : String(err?.message || err);
    postMessage({ type: 'error', id: m.id, error: text, trapped, code: err?.code, cancelled: !!err?.cancelled });
  } finally {
    cancelled.delete(m.id);
  }
};

/** Return a result together with buffers to transfer. */
GW.transfer = (result, transfer) => ({ __transfer: true, result, transfer });
