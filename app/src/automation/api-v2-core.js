// Automation API v2 (REQ-GAP-01), the part present from boot: `gisworkbench.api.v2` itself, with
// call(), the namespaced functions, on()/off(), the event ring and the wiring of the app's events
// to it (wireEvents), so events are recorded from boot. The method implementations
// (automation/api-v2-impl.js makeV2Impl) are bound on the first call: in the app they come from the
// lazy js-apiv2 block (features/automation.js). Arguments are checked against the spec
// (automation/v2-spec.js) before anything loads.
//
// Errors and results are developer API text (DN-62 rule 7): English.

import { METHODS, EVENTS, API_VERSION, parseSemver, mcpName } from './v2-spec.js';
import { Registry } from '../ai/registry.js';

const RING = 500;

/** Validate arguments with the registry's schema checker (the same rules MCP calls get). */
const checker = /* @__PURE__ */ new Registry({ store: { on() {} } });

export function apiError(message, code = 'E_API') {
  return Object.assign(new Error(message), { code });
}

/**
 * The v2 API object for an app: {version, call, on, off, methods, …namespaces}. `getImpl()` gives
 * the implementations keyed like METHODS (or a promise of them); it is asked on the first call and
 * its result kept. `api._ring` is the event ring (events.recent), `api._spec` the spec and
 * `api._impl` the bound implementations (null until bound).
 */
export function makeV2Api(app, getImpl) {
  const listeners = new Map(Object.keys(EVENTS).map((k) => [k, new Set()]));
  const ring = [];
  let seq = 0;
  const emit = (type, body) => {
    const e = { seq: ++seq, type, time: new Date().toISOString(), ...body };
    ring.push(e);
    if (ring.length > RING) ring.shift();
    for (const fn of listeners.get(type) ?? []) {
      try {
        fn(e);
      } catch (err) {
        app.log?.('warn', `api.v2 ${type} listener: ${err.message}`);
      }
    }
    for (const fn of listeners.get('*') ?? []) fn(e);
  };

  let impl = null;
  let binding = null;
  const bind = () =>
    impl ??
    (binding ??= (async () => {
      try {
        impl = await getImpl(api);
        return impl;
      } finally {
        binding = null;
      }
    })());

  /** Call a method by name with its parameters (checked against the schema). */
  async function call(method, params = {}) {
    const m = METHODS[method];
    if (!m) throw apiError(`no method "${method}"; call api.describe`, 'E_NO_METHOD');
    const args = params ?? {};
    if (!m.files) {
      const errs = checker.validate(m.params, args);
      if (errs.length) throw apiError(`${method}: ${errs.join('; ')}`, 'E_API_ARGS');
    } else if (typeof args !== 'object') throw apiError(`${method}: arguments must be an object`, 'E_API_ARGS');
    for (const r of m.params.required ?? []) if (args[r] === undefined) throw apiError(`${method}: missing "${r}"`, 'E_API_ARGS');
    const fn = (impl ?? (await bind()))[method];
    if (!fn) throw apiError(`no method "${method}"; call api.describe`, 'E_NO_METHOD');
    return fn(args);
  }

  const api = {
    version: API_VERSION,
    call,
    on(type, fn) {
      if (type !== '*' && !EVENTS[type]) throw apiError(`no event "${type}"; events are ${Object.keys(EVENTS).join(', ')}`, 'E_NO_EVENT');
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    off(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    methods: () => Object.keys(METHODS),
    _emit: emit,
    get _impl() {
      return impl;
    },
  };
  Object.defineProperty(api, '_ring', { value: ring, enumerable: false });
  // The spec, for the implementations (so the lazy block carries no second copy of it).
  Object.defineProperty(api, '_spec', { value: { METHODS, API_VERSION, parseSemver, mcpName, apiError }, enumerable: false });
  /** Bind the implementations now (tests; the app binds on the first call). */
  Object.defineProperty(api, '_bind', { value: (x) => (impl = x), enumerable: false });
  // Namespaced functions: api.layers.list(), api.ai.models.run({...}).
  for (const name of Object.keys(METHODS)) {
    const parts = name.split('.');
    let o = api;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts.at(-1)] = (params) => call(name, params);
  }
  return api;
}

/**
 * Wire the app's own events to api.v2 events: store commits on layer records, the selection
 * (an observed Set, also when replaced), panel views (one per panel per frame) and pool jobs.
 */
export function wireEvents(app, api) {
  const S = app.store;
  const LAYER_TYPES = new Set(['layer', 'vlayer']);
  S.on('commit', (cs) => {
    const seen = new Set();
    for (const o of cs.ops ?? []) {
      if (seen.has(o.id)) continue;
      const rec = o.op === 'create' ? o.rec : o.op === 'delete' ? o.prev : S.get(o.id);
      if (!rec || !LAYER_TYPES.has(rec.type)) continue;
      seen.add(o.id);
      api._emit('layer', { action: o.op === 'create' ? 'added' : o.op === 'delete' ? 'removed' : 'changed', layer: o.id, kind: rec.type === 'vlayer' ? 'vector' : rec.kind ?? 'image' });
    }
  });
  S.on('reset', () => api._emit('layer', { action: 'changed', layer: '*', kind: 'project' }));

  // Selection: features replace app.selection or mutate it; both are seen.
  let pending = false;
  const selChanged = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      api._emit('selection', { ids: [...(app.selection ?? [])] });
    });
  };
  const observe = (set) => {
    if (!set || set.__gwObserved) return set;
    const s = set instanceof Set ? set : new Set(set);
    for (const k of ['add', 'delete', 'clear']) {
      const orig = s[k].bind(s);
      Object.defineProperty(s, k, {
        value: (...a) => {
          const before = s.size;
          const r = orig(...a);
          if (k === 'add' ? s.size !== before : k === 'clear' ? before > 0 : r) selChanged();
          return r;
        },
        configurable: true,
      });
    }
    Object.defineProperty(s, '__gwObserved', { value: true });
    return s;
  };
  let sel = observe(app.selection ?? new Set());
  Object.defineProperty(app, 'selection', {
    configurable: true,
    enumerable: true,
    get: () => sel,
    set: (v) => {
      sel = observe(v ?? new Set());
      selChanged();
    },
  });

  // Views, coalesced per panel per animation frame.
  const views = new Map();
  let raf = 0;
  const raf_ = globalThis.requestAnimationFrame ?? ((f) => setTimeout(f, 16));
  app.on('view', (p) => {
    if (!p?.id) return;
    views.set(p.id, p);
    if (!raf)
      raf = raf_(() => {
        raf = 0;
        for (const [id, q] of views) api._emit('view', { pane: id, cx: q.view.cx, cy: q.view.cy, zoom: q.view.zoom, rot: q.view.rot });
        views.clear();
      });
  });

  // Jobs: every state change; progress at most every 250 ms per job. Tile reads are left out.
  const last = new Map();
  app.pool?.on('job', (j) => {
    if (j.op === 'tile') return;
    const prev = last.get(j.id);
    const now = performance.now();
    if (prev && prev.state === j.state && now - prev.t < 250) return;
    last.set(j.id, { state: j.state, t: now });
    if (last.size > 2000) last.delete(last.keys().next().value);
    api._emit('job', { id: j.id, op: j.op, label: String(j.label ?? j.op), state: j.state, progress: Number.isFinite(j.progress) ? j.progress : 0 });
  });
}
