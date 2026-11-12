// Glass-box recipes and workflows (2.0 plan P6, REQ-PIP-01..04; the workflow builder REQ-GAP-84,
// SDP-2.7 §4.11). A recipe is a versioned JSON document of steps run in view of the analyst, which
// a person can read, edit, pause at gates and share as a file (.gwrecipe.json).
//
//   gw-recipe/1: {format, id, name, description, steps: [{id, op, title, params, note, pythonHint}]}
//                a chain: each step acts on the app's state in turn.
//   gw-recipe/2: the same, and a step names its inputs, each wired to an earlier step's output by
//                reference ({from: 'stepId', output: 'name'}) or given a value. The steps form a
//                graph; the runner goes in topological order (Kahn), branches one after another,
//                the heavy work in the worker pool. Steps may carry an editor position {x, y}.
//                A gw-recipe/1 file loads as a chain.
//
// An operation (features/recipes.js OPS) may declare a parameter `schema` ({name: {type, min, max,
// unit, values, default, label}}; types number, integer, boolean, enum, lonlat, numbers, texts, text,
// date), typed `inputs` and `outputs` ([{name, type}]; types like 'layer:raster', 'layer:vector',
// 'layer' (either), 'number', 'text', 'any'), and
// runs as run(params, ctx) → {summary?, outputs?: {name: value}}, with ctx.inputs holding its
// wired inputs' values.

import { Emitter } from '../core/util.js';
import { gwError } from '../i18n/index.js';

export const FORMAT = 'gw-recipe/1';
export const FORMAT2 = 'gw-recipe/2';
export const MAX_STEPS = 200;

const stepErr = (msg, params) => gwError(msg, params, 'E_RECIPE_STEP');

/** A port reference "stepId.port" as [stepId, port]. Step ids may hold a '.', port names never do. */
export function splitPort(key) {
  const i = String(key).lastIndexOf('.');
  return i < 0 ? [String(key), ''] : [key.slice(0, i), key.slice(i + 1)];
}

/** Whether an output of type `out` may feed an input of type `want` ('layer' takes either layer; 'any' takes all). */
export function fits(out, want) {
  if (!want || want === 'any' || !out || out === 'any') return true;
  if (out === want) return true;
  return want === 'layer' && out.startsWith('layer:');
}

/**
 * A parameter against its schema entry: the value, coerced where a form gives text ('3' → 3), or
 * an Error naming the step and parameter. Unknown parameters pass (an op may take free ones).
 */
export function checkParam(spec, v, where) {
  if (!spec || v === undefined || v === null || v === '') return v;
  const num = (x) => (typeof x === 'number' ? x : Number(x));
  switch (spec.type) {
    case 'number':
    case 'integer': {
      const x = num(v);
      if (!Number.isFinite(x) || (spec.type === 'integer' && !Number.isInteger(x))) throw stepErr('{where}: {param} must be {kind}', { ...where, kind: spec.type === 'integer' ? 'a whole number' : 'a number' });
      if ((spec.min !== undefined && x < spec.min) || (spec.max !== undefined && x > spec.max)) throw stepErr('{where}: {param} must be from {min} to {max}', { ...where, min: String(spec.min ?? '−∞'), max: String(spec.max ?? '∞') });
      return x;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      throw stepErr('{where}: {param} must be true or false', where);
    case 'enum':
      if (!(spec.values ?? []).map((x) => (typeof x === 'object' ? x.value : x)).includes(v)) throw stepErr('{where}: {param} must be one of {values}', { ...where, values: (spec.values ?? []).map((x) => (typeof x === 'object' ? x.value : x)).join(', ') });
      return v;
    case 'lonlat': {
      const xs = typeof v === 'string' ? v.split(/[,;\s]+/).filter(Boolean).map(Number) : Array.isArray(v) ? v.map(num) : v;
      if (!Array.isArray(xs) || xs.length !== 2 || !xs.every(Number.isFinite) || Math.abs(xs[1]) > 90 || Math.abs(xs[0]) > 360) throw stepErr('{where}: {param} must be [longitude, latitude]', where);
      return xs;
    }
    case 'numbers': {
      const xs = typeof v === 'string' ? v.split(/[,;\s]+/).filter(Boolean).map(Number) : Array.isArray(v) ? v.map(num) : v;
      if (!Array.isArray(xs) || !xs.every(Number.isFinite)) throw stepErr('{where}: {param} must be a list of numbers', where);
      return xs;
    }
    case 'texts': {
      const xs = typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v;
      if (!Array.isArray(xs) || !xs.every((x) => typeof x === 'string')) throw stepErr('{where}: {param} must be a list of words', where);
      return xs;
    }
    case 'text':
    case 'date':
      if (typeof v !== 'string') throw stepErr('{where}: {param} must be text', where);
      if (spec.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}/.test(v)) throw stepErr('{where}: {param} must be a date (YYYY-MM-DD)', where);
      return v;
    default:
      return v;
  }
}

/** Steps in run order (Kahn), or an Error naming a step in a cycle. Ties keep the file's order. */
export function order(steps) {
  const idx = new Map(steps.map((s, i) => [s.id, i]));
  const indeg = steps.map(() => 0);
  const out = steps.map(() => []);
  steps.forEach((s, i) => {
    for (const w of Object.values(s.inputs ?? {})) {
      if (w && typeof w === 'object' && 'from' in w) {
        indeg[i]++;
        out[idx.get(w.from)].push(i);
      }
    }
  });
  const ready = indeg.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  const res = [];
  while (ready.length) {
    ready.sort((a, b) => a - b);
    const i = ready.shift();
    res.push(i);
    for (const j of out[i]) if (--indeg[j] === 0) ready.push(j);
  }
  if (res.length !== steps.length) {
    const stuck = steps.find((_, i) => indeg[i] > 0);
    throw stepErr('step {id} is part of a loop: a step cannot depend on itself', { id: stuck?.id ?? '?' });
  }
  return res;
}

/** The steps downstream of step i (by wires), and i itself. A chain (no wires) has every later step downstream. */
export function downstream(steps, i) {
  const wired = steps.some((s) => Object.values(s.inputs ?? {}).some((w) => w && typeof w === 'object' && 'from' in w));
  if (!wired) return new Set(steps.map((_, k) => k).filter((k) => k >= i));
  const ids = new Set([steps[i].id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of steps) {
      if (ids.has(s.id)) continue;
      if (Object.values(s.inputs ?? {}).some((w) => w && typeof w === 'object' && ids.has(w.from))) {
        ids.add(s.id);
        grew = true;
      }
    }
  }
  return new Set(steps.map((s, k) => (ids.has(s.id) ? k : -1)).filter((k) => k >= 0));
}

/** A checked copy of a recipe (gw-recipe/1 or /2; always returned as /2), or an Error naming what is wrong. */
export function validateRecipe(r, ops) {
  if (!r || typeof r !== 'object') throw new Error('a recipe is a JSON object');
  if (r.format !== FORMAT && r.format !== FORMAT2) throw gwError('not a GIS Workbench recipe (format "{format}", expected "{expected}")', { format: String(r.format ?? '?'), expected: FORMAT2 }, 'E_RECIPE_FORMAT');
  if (typeof r.name !== 'string' || !r.name.trim()) throw new Error('the recipe has no name');
  if (!Array.isArray(r.steps) || !r.steps.length) throw new Error('the recipe has no steps');
  if (r.steps.length > MAX_STEPS) throw gwError('a recipe has at most {n} steps', { n: String(MAX_STEPS) }, 'E_RECIPE_STEP');
  const ids = new Set();
  const steps = r.steps.map((s, i) => {
    if (!s || typeof s !== 'object') throw stepErr('step {n} is not an object', { n: String(i + 1) });
    const op = ops[s.op];
    if (!op) throw stepErr('step {n}: unknown operation "{op}"', { n: String(i + 1), op: String(s.op) });
    if (s.params !== undefined && (typeof s.params !== 'object' || Array.isArray(s.params) || s.params === null)) throw stepErr('step {n}: params must be an object', { n: String(i + 1) });
    const id = String(s.id ?? `s${i + 1}`);
    if (!/^[\w.-]{1,40}$/.test(id)) throw stepErr('step {n}: the id "{id}" must be 1–40 letters, digits or . _ -', { n: String(i + 1), id });
    if (ids.has(id)) throw stepErr('step {n}: duplicate id "{id}"', { n: String(i + 1), id });
    ids.add(id);
    const params = { ...defaults(op), ...(s.params ?? {}) };
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'function') throw stepErr('step {n}: parameter {param} is not data', { n: String(i + 1), param: k });
      params[k] = checkParam(op.schema?.[k], v, { where: `step ${i + 1} (${id})`, param: k });
    }
    const inputs = {};
    for (const [k, w] of Object.entries(s.inputs ?? {})) {
      if (op.inputs && !op.inputs.some((x) => x.name === k)) throw stepErr('step {n}: operation {op} has no input {input}', { n: String(i + 1), op: s.op, input: k });
      if (w && typeof w === 'object' && 'from' in w) inputs[k] = { from: String(w.from), output: String(w.output ?? 'out') };
      else inputs[k] = { value: w?.value ?? w };
    }
    const at = s.at && Number.isFinite(s.at.x) && Number.isFinite(s.at.y) ? { x: s.at.x, y: s.at.y } : null;
    return { id, op: s.op, title: String(s.title ?? op.title), params, inputs, note: String(s.note ?? ''), pythonHint: s.pythonHint ?? op.pythonHint ?? null, ...(at ? { at } : {}) };
  });
  // Wires: to a known step and output, of a fitting type.
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const [i, s] of steps.entries()) {
    for (const [k, w] of Object.entries(s.inputs)) {
      if (!('from' in w)) continue;
      const src = byId.get(w.from);
      if (!src) throw stepErr('step {n}: input {input} is wired to a step "{from}" the recipe does not have', { n: String(i + 1), input: k, from: w.from });
      const out = ops[src.op].outputs?.find((o) => o.name === w.output);
      if (ops[src.op].outputs && !out) throw stepErr('step {n}: step {from} has no output {output}', { n: String(i + 1), from: w.from, output: w.output });
      const want = ops[s.op].inputs?.find((x) => x.name === k)?.type;
      if (out && !fits(out.type, want)) throw stepErr('step {n}: input {input} takes {want}, but {from}.{output} gives {got}', { n: String(i + 1), input: k, want, from: w.from, output: w.output, got: out.type });
    }
  }
  order(steps);
  return { format: FORMAT2, id: String(r.id ?? r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')), name: r.name.trim(), description: String(r.description ?? ''), version: Math.max(1, Math.trunc(Number(r.version)) || 1), steps };
}

/** An op's defaults: its `defaults`, and its schema's defaults where `defaults` gives none. */
export function defaults(op) {
  const fromSchema = Object.fromEntries(Object.entries(op.schema ?? {}).filter(([, s]) => s.default !== undefined).map(([k, s]) => [k, s.default]));
  return { ...fromSchema, ...(op.defaults ?? {}) };
}

/**
 * Runs a recipe. Step states: pending → running → done | failed | waiting (a gate) | skipped; a
 * parameter change marks that step and the ones downstream of it stale. Events: 'change'.
 * ops[op].run(params, ctx) → {summary?, outputs?}; ops[op].gate: the step waits for resume().
 * `inputs` (run(from, {inputs})) gives values for unwired inputs by "stepId.input".
 */
export class RecipeRunner extends Emitter {
  constructor(ops, ctx = {}) {
    super();
    this.ops = ops;
    this.ctx = ctx;
    this.recipe = null;
    this.state = [];
    this.outputs = new Map();
    this.running = false;
    this.current = -1;
    this._gate = null;
    this._stop = false;
  }

  load(recipe) {
    if (this.running) throw new Error('a recipe is running: stop it first');
    this.recipe = validateRecipe(recipe, this.ops);
    this.order = order(this.recipe.steps);
    this.state = this.recipe.steps.map(() => ({ status: 'pending', ms: null, summary: '', error: null }));
    this.outputs = new Map();
    this.current = -1;
    this.emit('change');
    return this.recipe;
  }

  /** Change one parameter (checked against the op's schema); that step and those downstream become stale. */
  setParam(i, key, value) {
    const s = this.recipe?.steps[i];
    if (!s) throw gwError('no step {n}', { n: String(i + 1) }, 'E_RECIPE_NO_STEP');
    s.params = { ...s.params, [key]: checkParam(this.ops[s.op].schema?.[key], value, { where: `step ${i + 1} (${s.id})`, param: key }) };
    for (const k of downstream(this.recipe.steps, i)) if (this.state[k].status !== 'pending') this.state[k].status = 'stale';
    this.emit('change');
  }

  /** The values of step `s`'s inputs: wired ones from upstream outputs, given ones as given. */
  inputsOf(s, given = {}) {
    const out = {};
    for (const [k, w] of Object.entries(s.inputs ?? {})) {
      if ('from' in w) {
        const o = this.outputs.get(w.from);
        if (!o || !(w.output in o)) throw stepErr('input {input} of {id} has no value: step {from} gave no {output}', { input: k, id: s.id, from: w.from, output: w.output });
        out[k] = o[w.output];
      } else out[k] = w.value;
    }
    for (const [k, v] of Object.entries(given)) {
      const [sid, name] = splitPort(k);
      if (sid === s.id && name && out[name] === undefined) out[name] = v;
    }
    return out;
  }

  /**
   * Run every step (from = 0), or step `from` (its index in the file) and the steps downstream of
   * it, which use the outputs the others gave last time; in run order, to the end, or until a step
   * fails or stop() is called. For a chain, "downstream" is every later step, as before.
   */
  async run(from = 0, { inputs = {} } = {}) {
    if (!this.recipe) throw new Error('no recipe loaded');
    if (this.running) throw new Error('the recipe is already running');
    this.running = true;
    this._stop = false;
    const keep = from === 0 ? null : downstream(this.recipe.steps, from);
    const seq = this.order.filter((i) => !keep || keep.has(i));
    for (const k of seq) this.state[k] = { status: 'pending', ms: null, summary: '', error: null };
    this.emit('change');
    try {
      for (const i of seq) {
        if (this._stop) {
          for (const k of seq.slice(seq.indexOf(i))) this.state[k].status = 'skipped';
          break;
        }
        const step = this.recipe.steps[i];
        const op = this.ops[step.op];
        const st = this.state[i];
        this.current = i;
        st.status = 'running';
        this.emit('change');
        const t0 = performance.now();
        try {
          const ctx = { ...this.ctx, step, index: i, runner: this, inputs: this.inputsOf(step, inputs) };
          const r = (await op.run(step.params, ctx)) ?? {};
          st.summary = r.summary ?? '';
          this.outputs.set(step.id, r.outputs ?? {});
          if (op.gate) {
            st.status = 'waiting';
            this.emit('change');
            await new Promise((resolve) => (this._gate = resolve));
            this._gate = null;
            if (this._stop) {
              st.status = 'skipped';
              continue;
            }
            st.summary = (await op.after?.(step.params, ctx))?.summary ?? st.summary;
          }
          st.status = 'done';
          this.ctx.provenance?.(step, r.outputs ?? {}, this.recipe);
        } catch (e) {
          st.status = 'failed';
          st.error = e.message; // English; i18n is its message key (show with msgOf({ message: error, i18n }))
          st.i18n = e.i18n ?? null;
          this.emit('change');
          return { ok: false, failed: i, error: e.message, ...(e.i18n ? { i18n: e.i18n } : {}) };
        } finally {
          st.ms = Math.round(performance.now() - t0);
        }
        this.emit('change');
      }
      return { ok: !this._stop };
    } finally {
      this.running = false;
      this.current = -1;
      this.emit('change');
    }
  }

  /** Continue past a gate. */
  resume() {
    if (!this._gate) return false;
    this._gate();
    return true;
  }

  get waiting() {
    return !!this._gate;
  }

  stop() {
    this._stop = true;
    this._gate?.();
  }

  /** The recipe as a file (gw-recipe/2, parameters as edited). */
  toJSON() {
    const r = this.recipe;
    return r && { format: FORMAT2, id: r.id, name: r.name, description: r.description, version: r.version, steps: r.steps.map((s) => ({ id: s.id, op: s.op, title: s.title, params: s.params, ...(Object.keys(s.inputs ?? {}).length ? { inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, w]) => [k, 'from' in w ? { from: w.from, output: w.output } : { value: w.value }])) } : {}), note: s.note, ...(s.pythonHint ? { pythonHint: s.pythonHint } : {}), ...(s.at ? { at: s.at } : {}) })) };
  }
}
