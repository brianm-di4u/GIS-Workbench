// SDP-2.8 §7.1 (REG-282): the library fields of a gw-recipe/2 file (recipes/recipe.js recipeMeta),
// the recipe's own parameters, the preconditions the runner checks before the first step, and that
// every library recipe (recipes/catalog.js) has what the definition of done asks and an oracle case.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { validateRecipe, recipeParams, RecipeRunner, FORMAT2 } from '../../app/src/recipes/recipe.js';
import { LIBRARY } from '../../app/src/recipes/catalog.js';

const OPS = {
  num: { title: 'Number', schema: { value: { type: 'number', default: 0, min: 0, max: 10 } }, outputs: [{ name: 'out', type: 'number' }], run: ({ value }) => ({ outputs: { out: value } }) },
  files: { title: 'Files', files: true, schema: { mode: { type: 'enum', values: ['a', 'b'], default: 'a' } }, run: () => ({}) },
};
const base = { format: FORMAT2, name: 'r', steps: [{ id: 'n', op: 'num' }, { id: 'f', op: 'files' }] };

describe('library fields', () => {
  it('keeps the fields it knows, ignores the ones it does not, and writes them back', () => {
    const r = validateRecipe({ ...base, category: 'test', keywords: ['one', 'two'], lite: true, explanation: { what: 'does', when: 'now' }, later: 'a field from a later version' }, OPS);
    expect([r.category, r.keywords, r.lite, r.explanation, r.later]).toEqual(['test', ['one', 'two'], true, { what: 'does', when: 'now', limits: '' }, undefined]);
    const runner = new RecipeRunner(OPS);
    runner.load(r);
    expect(validateRecipe(runner.toJSON(), OPS)).toEqual(r);
    // A file without them has none.
    expect(Object.keys(validateRecipe(base, OPS)).sort()).toEqual(['description', 'format', 'id', 'name', 'steps', 'version']);
  });

  it('refuses an explanation without "what", or keywords that are not a list', () => {
    expect(() => validateRecipe({ ...base, explanation: { when: 'x' } }, OPS)).toThrow(/explanation needs "what"/);
    expect(() => validateRecipe({ ...base, keywords: 'a b' }, OPS)).toThrow(/keywords must be a list/);
  });

  it("maps a recipe parameter onto its steps' parameters, checked by the target's schema", () => {
    const r = validateRecipe({ ...base, params: { v: { to: ['n.value'] }, m: { to: ['f.mode'], default: 'b' } } }, OPS);
    expect(r.params.v).toMatchObject({ type: 'number', min: 0, max: 10, to: ['n.value'] });
    expect(recipeParams(r, { v: '4', m: 'a' })).toEqual({ n: { value: 4 }, f: { mode: 'a' } });
    expect(() => recipeParams(r, { v: 11 })).toThrow(/at most 10|≤ 10|10/);
    expect(() => recipeParams(r, { nope: 1 })).toThrow(/no parameter nope/);
  });

  it('refuses a recipe parameter that sets nothing: no target, an unknown step or an unknown parameter', () => {
    expect(() => validateRecipe({ ...base, params: { v: {} } }, OPS)).toThrow(/sets no step parameter/);
    expect(() => validateRecipe({ ...base, params: { v: { to: ['x.value'] } } }, OPS)).toThrow(/no step "x"/);
    expect(() => validateRecipe({ ...base, params: { v: { to: ['n.valu'] } } }, OPS)).toThrow(/step n has no parameter "valu"/);
    // The files a step reads are a parameter only of a step that reads files.
    expect(validateRecipe({ ...base, params: { v: { to: ['f.files'] } } }, OPS).params.v.to).toEqual(['f.files']);
    expect(() => validateRecipe({ ...base, params: { v: { to: ['n.files'] } } }, OPS)).toThrow(/no parameter "files"/);
  });

  it("refuses names that would reach an object's prototype, so a shared file cannot set a global", () => {
    const proto = { format: FORMAT2, name: 'r', steps: [{ id: '__proto__', op: 'num' }] };
    expect(() => validateRecipe({ ...proto, params: { v: { to: ['__proto__.value'] } } }, OPS)).toThrow(/no step "__proto__"/);
    expect(() => validateRecipe({ ...base, params: { v: { to: ['n.constructor'] } } }, OPS)).toThrow(/no parameter "constructor"/);
    expect(() => validateRecipe({ ...base, params: JSON.parse('{"__proto__": {"to": ["n.value"]}}') }, OPS)).toThrow(/not a name a parameter may have/);
    expect(() => validateRecipe({ ...proto, requires: JSON.parse('{"__proto__": {"kind": "raster"}}') }, OPS)).toThrow(/requires: no step "__proto__"/);
    const r = validateRecipe({ ...base, params: { v: { to: ['n.value'] } } }, OPS);
    expect(() => recipeParams(r, JSON.parse('{"__proto__": 1}'))).toThrow(/no parameter __proto__/);
    expect(({}).value).toBeUndefined();
  });

  it('refuses a requirement on a step it does not have, or one it cannot check', () => {
    expect(validateRecipe({ ...base, requires: { n: { kind: 'raster', bands: 1, nodata: true } } }, OPS).requires).toEqual({ n: { kind: 'raster', bands: 1, nodata: true } });
    expect(() => validateRecipe({ ...base, requires: { x: { kind: 'raster' } } }, OPS)).toThrow(/no step "x"/);
    expect(() => validateRecipe({ ...base, requires: { n: { kind: 'tin' } } }, OPS)).toThrow(/kind cannot be "tin"/);
    expect(() => validateRecipe({ ...base, requires: { n: { projected: true } } }, OPS)).toThrow(/projected cannot be/);
  });
});

describe('preflight', () => {
  it('runs before the first step: a refusal fails the step it names and nothing else runs', async () => {
    const ran = [];
    const ops = { ...OPS, num: { ...OPS.num, run: (p) => (ran.push('n'), OPS.num.run(p)) } };
    const R = new RecipeRunner(ops, { preflight: async (r) => ({ step: r.steps[1].id, reason: 'f is unsuitable' }) });
    R.load(base);
    expect(await R.run()).toEqual({ ok: false, failed: 1, error: 'f is unsuitable', refused: true });
    expect([ran, R.state.map((s) => s.status)]).toEqual([[], ['skipped', 'failed']]);
    // A run from a later step has passed it already.
    expect((await R.run(1)).ok).toBe(true);
  });

  it('a check that throws refuses the run as well, instead of leaving every step pending', async () => {
    const R = new RecipeRunner(OPS, { preflight: async () => { throw new Error('two layers are named dem'); } });
    R.load(base);
    expect(await R.run()).toEqual({ ok: false, failed: 0, error: 'two layers are named dem', refused: true });
    expect(R.state.map((s) => s.status)).toEqual(['failed', 'skipped']);
  });
});

describe('the library', () => {
  for (const r of LIBRARY) {
    it(`${r.id} has what SDP-2.8 §7.1 asks of a recipe, and an oracle case`, () => {
      const ops = Object.fromEntries(r.steps.map((s) => [s.op, { title: s.op, files: true, schema: Object.fromEntries(Object.keys(s.params ?? {}).map((k) => [k, { type: 'text' }])) }]));
      const v = validateRecipe(r, ops);
      expect([v.format, !!v.category, Array.isArray(v.keywords), typeof v.lite, !!v.explanation?.what, !!v.explanation?.when, !!v.explanation?.limits]).toEqual([FORMAT2, true, true, 'boolean', true, true, true]);
      expect(existsSync(`tests/oracles/${r.id}/case.json`) && existsSync(`tests/oracles/${r.id}/provenance.json`), `tests/oracles/${r.id}`).toBe(true);
      expect(existsSync(`fixtures/recipes/${r.id}/SOURCE.txt`), `fixtures/recipes/${r.id}/SOURCE.txt`).toBe(true);
    });
  }
  it('has an oracle case for each recipe and no case for a recipe it does not have', () => {
    expect(readdirSync('tests/oracles', { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()).toEqual(LIBRARY.map((r) => r.id).sort());
  });
});
