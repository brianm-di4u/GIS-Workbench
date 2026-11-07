// Glass-box recipes (2.0 plan P6; REQ-PIP-01..04): a recipe is a versioned JSON list of steps run
// one after another in view of the analyst. No node graph: a linear list a person can read,
// edit, pause at gates and share as a file (.gwrecipe.json). Each step names an operation of the
// runner (features/recipes.js OPS), its parameters and a note; `pythonHint` keeps what the later
// "Copy as Python" (2.x) will need.
//
//   {format: 'gw-recipe/1', id, name, description, steps: [{id, op, title, params, note, pythonHint}]}

import { Emitter } from '../core/util.js';
import { gwError } from '../i18n/index.js';

export const FORMAT = 'gw-recipe/1';

/** A checked copy of a recipe, or an Error naming what is wrong. `ops`: the known operations. */
export function validateRecipe(r, ops) {
  if (!r || typeof r !== 'object') throw new Error('a recipe is a JSON object');
  if (r.format !== FORMAT) throw gwError('not a GIS Workbench recipe (format "{format}", expected "{expected}")', { format: String(r.format ?? '?'), expected: FORMAT }, 'E_RECIPE_FORMAT');
  if (typeof r.name !== 'string' || !r.name.trim()) throw new Error('the recipe has no name');
  if (!Array.isArray(r.steps) || !r.steps.length) throw new Error('the recipe has no steps');
  if (r.steps.length > 50) throw new Error('a recipe has at most 50 steps');
  const ids = new Set();
  const steps = r.steps.map((s, i) => {
    if (!s || typeof s !== 'object') throw gwError('step {n} is not an object', { n: String(i + 1) }, 'E_RECIPE_STEP');
    if (!ops[s.op]) throw gwError('step {n}: unknown operation "{op}"', { n: String(i + 1), op: String(s.op) }, 'E_RECIPE_STEP');
    if (s.params !== undefined && (typeof s.params !== 'object' || Array.isArray(s.params) || s.params === null)) throw gwError('step {n}: params must be an object', { n: String(i + 1) }, 'E_RECIPE_STEP');
    const id = String(s.id ?? `s${i + 1}`);
    if (ids.has(id)) throw gwError('step {n}: duplicate id "{id}"', { n: String(i + 1), id }, 'E_RECIPE_STEP');
    ids.add(id);
    const params = { ...(ops[s.op].defaults ?? {}), ...(s.params ?? {}) };
    for (const [k, v] of Object.entries(params)) if (typeof v === 'function') throw gwError('step {n}: parameter {param} is not data', { n: String(i + 1), param: k }, 'E_RECIPE_STEP');
    return { id, op: s.op, title: String(s.title ?? ops[s.op].title), params, note: String(s.note ?? ''), pythonHint: s.pythonHint ?? ops[s.op].pythonHint ?? null };
  });
  return { format: FORMAT, id: String(r.id ?? r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')), name: r.name.trim(), description: String(r.description ?? ''), version: Number(r.version ?? 1), steps };
}

/**
 * Runs a recipe step by step. Step states: pending → running → done | failed | waiting (a gate)
 * | skipped; a parameter change marks that step and the later ones stale. Events: 'change'.
 * ops[op].run(params, ctx) → {summary?} ; ops[op].gate: the step waits for resume().
 */
export class RecipeRunner extends Emitter {
  constructor(ops, ctx = {}) {
    super();
    this.ops = ops;
    this.ctx = ctx;
    this.recipe = null;
    this.state = [];
    this.running = false;
    this.current = -1;
    this._gate = null;
    this._stop = false;
  }

  load(recipe) {
    if (this.running) throw new Error('a recipe is running: stop it first');
    this.recipe = validateRecipe(recipe, this.ops);
    this.state = this.recipe.steps.map(() => ({ status: 'pending', ms: null, summary: '', error: null }));
    this.current = -1;
    this.emit('change');
    return this.recipe;
  }

  /** Change one parameter; that step and the ones after it become stale. */
  setParam(i, key, value) {
    const s = this.recipe?.steps[i];
    if (!s) throw gwError('no step {n}', { n: String(i + 1) }, 'E_RECIPE_NO_STEP');
    s.params = { ...s.params, [key]: value };
    for (let k = i; k < this.state.length; k++) if (this.state[k].status !== 'pending') this.state[k].status = 'stale';
    this.emit('change');
  }

  /** Run from step `from` (0-based) to the end, or until a step fails or stop() is called. */
  async run(from = 0) {
    if (!this.recipe) throw new Error('no recipe loaded');
    if (this.running) throw new Error('the recipe is already running');
    this.running = true;
    this._stop = false;
    for (let k = from; k < this.state.length; k++) this.state[k] = { status: 'pending', ms: null, summary: '', error: null };
    this.emit('change');
    try {
      for (let i = from; i < this.recipe.steps.length; i++) {
        if (this._stop) {
          for (let k = i; k < this.state.length; k++) this.state[k].status = 'skipped';
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
          const r = (await op.run(step.params, { ...this.ctx, step, index: i, runner: this })) ?? {};
          st.summary = r.summary ?? '';
          if (op.gate) {
            st.status = 'waiting';
            this.emit('change');
            await new Promise((resolve) => (this._gate = resolve));
            this._gate = null;
            if (this._stop) {
              st.status = 'skipped';
              continue;
            }
            st.summary = (await op.after?.(step.params, { ...this.ctx, step, index: i, runner: this }))?.summary ?? st.summary;
          }
          st.status = 'done';
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

  /** The recipe as a file (parameters as edited). */
  toJSON() {
    const r = this.recipe;
    return r && { format: FORMAT, id: r.id, name: r.name, description: r.description, version: r.version, steps: r.steps.map((s) => ({ id: s.id, op: s.op, title: s.title, params: s.params, note: s.note, ...(s.pythonHint ? { pythonHint: s.pythonHint } : {}) })) };
  }
}
