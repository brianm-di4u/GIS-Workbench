// REQ-GAP-84 the workflow model (recipes/recipe.js gw-recipe/2): typed inputs and outputs wired by
// reference, parameter schemas, the topological runner, stale marking downstream, and gw-recipe/1
// files loading as chains. A branching graph gives the same results as the equivalent linear recipes.
import { describe, expect, it } from 'vitest';
import { validateRecipe, RecipeRunner, order, downstream, checkParam, fits, splitPort, FORMAT2 } from '../../app/src/recipes/recipe.js';

// Ops on numbers: `num` makes one, `add` and `mul` combine two, `log` records what it saw.
const seen = [];
const OPS = {
  num: { title: 'Number', schema: { value: { type: 'number', default: 0 } }, outputs: [{ name: 'out', type: 'number' }], run: ({ value }) => ({ outputs: { out: value } }) },
  add: { title: 'Add', schema: { k: { type: 'number', default: 0, min: -100, max: 100 } }, inputs: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }], outputs: [{ name: 'out', type: 'number' }], run: ({ k }, ctx) => ({ outputs: { out: (ctx.inputs.a ?? 0) + (ctx.inputs.b ?? 0) + k } }) },
  mul: { title: 'Multiply', schema: { by: { type: 'integer', default: 2, min: 1, max: 10 } }, inputs: [{ name: 'a', type: 'number' }], outputs: [{ name: 'out', type: 'number' }], run: ({ by }, ctx) => ({ outputs: { out: ctx.inputs.a * by } }) },
  name: { title: 'Name', schema: { mode: { type: 'enum', values: ['a', 'b'], default: 'a' } }, outputs: [{ name: 'out', type: 'text' }], run: ({ mode }) => ({ outputs: { out: mode } }) },
  log: { title: 'Log', inputs: [{ name: 'x', type: 'any' }], run: (p, ctx) => (seen.push(ctx.inputs.x), {}) },
  gate: { title: 'Review', gate: true, run: () => ({ summary: 'waiting' }), after: () => ({ summary: 'reviewed' }) },
};
// num(3) → mul ×2 → add(+1) ; num(3) → add(b) — a diamond.
const DIAMOND = {
  format: FORMAT2,
  name: 'diamond',
  steps: [
    { id: 'sum', op: 'add', params: { k: 1 }, inputs: { a: { from: 'twice', output: 'out' }, b: { from: 'three', output: 'out' } } },
    { id: 'twice', op: 'mul', inputs: { a: { from: 'three', output: 'out' } } },
    { id: 'three', op: 'num', params: { value: 3 } },
    { id: 'show', op: 'log', inputs: { x: { from: 'sum', output: 'out' } } },
  ],
};

describe('REQ-GAP-84 gw-recipe/2', () => {
  it('reads an empty value as not given: the default for numbers, lists and choices, empty for text', () => {
    const ops = { o: { title: 'O', schema: { n: { type: 'number', default: 5, min: 1 }, cap: { type: 'number', min: 0 }, e: { type: 'enum', values: ['a', 'b'], default: 'b' }, s: { type: 'text', default: 'x' } }, run: () => ({}) } };
    const r = validateRecipe({ format: FORMAT2, name: 'e', steps: [{ id: 'a', op: 'o', params: { n: '', cap: '', e: '', s: '' } }] }, ops);
    expect(r.steps[0].params).toEqual({ n: 5, cap: null, e: 'b', s: '' });
    const run = new RecipeRunner(ops);
    run.load({ format: FORMAT2, name: 'e', steps: [{ id: 'a', op: 'o', params: { n: 7 } }] });
    run.setParam(0, 'n', '');
    expect(run.recipe.steps[0].params.n).toBe(5);
  });
  it('writes the wires, positions and given inputs it read, and reads them back the same', () => {
    const run = new RecipeRunner(OPS);
    run.load({ ...DIAMOND, steps: DIAMOND.steps.map((s, k) => ({ ...s, at: { x: 10 * k, y: 5 } })).concat([{ id: 'given', op: 'add', inputs: { a: { value: 2 }, b: { value: null } } }]) });
    const file = JSON.parse(JSON.stringify(run.toJSON()));
    expect(file.steps.find((s) => s.id === 'sum').inputs).toEqual({ a: { from: 'twice', output: 'out' }, b: { from: 'three', output: 'out' } });
    expect(file.steps.find((s) => s.id === 'given').inputs).toEqual({ a: { value: 2 }, b: { value: null } });
    expect(file.steps.map((s) => s.at)).toEqual([0, 1, 2, 3].map((k) => ({ x: 10 * k, y: 5 })).concat([undefined]));
    expect(validateRecipe(file, OPS).steps).toEqual(run.recipe.steps);
  });
  it('orders the steps by their wires, whatever the file order', () => {
    const r = validateRecipe(DIAMOND, OPS);
    expect(order(r.steps).map((i) => r.steps[i].id)).toEqual(['three', 'twice', 'sum', 'show']);
  });
  it('runs a branching graph and gives the same result as the equivalent linear recipes', async () => {
    seen.length = 0;
    const run = new RecipeRunner(OPS);
    run.load(DIAMOND);
    const r = await run.run();
    expect(r).toEqual({ ok: true });
    const sum = run.outputs.get('sum').out;
    expect(sum).toBe(3 * 2 + 3 + 1);
    expect(seen).toEqual([10]);
    // The same as two chains: (3 × 2) and then (+ 3 + 1).
    const lin = new RecipeRunner(OPS);
    lin.load({ format: FORMAT2, name: 'line', steps: [{ id: 'a', op: 'num', params: { value: 3 } }, { id: 'b', op: 'mul', inputs: { a: { from: 'a', output: 'out' } } }, { id: 'c', op: 'add', params: { k: 1 }, inputs: { a: { from: 'b', output: 'out' }, b: { value: 3 } } }] });
    await lin.run();
    expect(lin.outputs.get('c').out).toBe(sum);
  });
  it('reruns with new inputs given when run', async () => {
    const run = new RecipeRunner(OPS);
    run.load({ format: FORMAT2, name: 'open', steps: [{ id: 'm', op: 'mul', params: { by: 5 } }] });
    await run.run(0, { inputs: { 'm.a': 2 } });
    expect(run.outputs.get('m').out).toBe(10);
    await run.run(0, { inputs: { 'm.a': 7 } });
    expect(run.outputs.get('m').out).toBe(35);
    // A step id may hold a '.': a port reference splits on the last one.
    expect(splitPort('b.1.layer')).toEqual(['b.1', 'layer']);
    run.load({ format: FORMAT2, name: 'dotted', steps: [{ id: 'm.1', op: 'mul', params: { by: 5 } }] });
    await run.run(0, { inputs: { 'm.1.a': 3 } });
    expect(run.outputs.get('m.1').out).toBe(15);
  });
  it('marks a changed step and those downstream of it stale, not the others', async () => {
    const run = new RecipeRunner(OPS);
    const r = run.load(DIAMOND);
    await run.run();
    run.setParam(r.steps.findIndex((s) => s.id === 'twice'), 'by', 3);
    expect(Object.fromEntries(r.steps.map((s, i) => [s.id, run.state[i].status]))).toEqual({ sum: 'stale', twice: 'stale', three: 'done', show: 'stale' });
    expect([...downstream(r.steps, r.steps.findIndex((s) => s.id === 'three'))].length).toBe(4);
    // Rerunning the changed step runs it and its downstream from the outputs kept.
    await run.run(r.steps.findIndex((s) => s.id === 'twice'));
    expect(run.outputs.get('sum').out).toBe(3 * 3 + 3 + 1);
    expect(run.state[r.steps.findIndex((s) => s.id === 'three')].status).toBe('done');
  });
  it('refuses loops, unknown wires, wrong types and out-of-range parameters', () => {
    const bad = (steps) => () => validateRecipe({ format: FORMAT2, name: 'x', steps }, OPS);
    expect(bad([{ id: 'a', op: 'mul', inputs: { a: { from: 'b', output: 'out' } } }, { id: 'b', op: 'mul', inputs: { a: { from: 'a', output: 'out' } } }])).toThrow(/loop/);
    expect(bad([{ id: 'a', op: 'mul', inputs: { a: { from: 'zz', output: 'out' } } }])).toThrow(/does not have/);
    expect(bad([{ id: 'n', op: 'name' }, { id: 'a', op: 'mul', inputs: { a: { from: 'n', output: 'out' } } }])).toThrow(/takes number/);
    expect(bad([{ id: 'a', op: 'mul', params: { by: 11 } }])).toThrow(/from 1 to 10/);
    expect(bad([{ id: 'a', op: 'mul', params: { by: 2.5 } }])).toThrow(/whole number/);
    expect(bad([{ id: 'a', op: 'name', params: { mode: 'c' } }])).toThrow(/one of a, b/);
    expect(bad([{ id: 'a', op: 'mul', inputs: { nope: { value: 1 } } }])).toThrow(/no input nope/);
  });
  it('runs a gw-recipe/1 chain with a gate: it waits, resumes, reruns from a changed step, and stops', async () => {
    const run = new RecipeRunner(OPS);
    run.load({ format: 'gw-recipe/1', name: 'gated', steps: [{ op: 'num', params: { value: 2 } }, { op: 'gate' }, { op: 'mul', params: { by: 3 } }] });
    const done = run.run(0);
    await expect.poll(() => run.waiting).toBe(true);
    expect(run.state.map((s) => s.status)).toEqual(['done', 'waiting', 'pending']);
    run.resume();
    expect(await done).toEqual({ ok: true });
    expect(run.state.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(run.state[1].summary).toBe('reviewed');
    // A chain's steps take nothing from each other: the last step alone reruns after a change.
    run.setParam(2, 'by', 4);
    expect(run.state.map((s) => s.status)).toEqual(['done', 'done', 'stale']);
    expect(await run.run(2)).toEqual({ ok: true });
    expect(run.state[2].status).toBe('done');
    // Stopped at the gate: the gate and the steps after it are skipped.
    const again = run.run(0);
    await expect.poll(() => run.waiting).toBe(true);
    run.stop();
    expect(await again).toEqual({ ok: false });
    expect(run.state.map((s) => s.status)).toEqual(['done', 'skipped', 'skipped']);
  });
  it('keeps a step with no ports after every step before it, though other steps are wired', () => {
    const steps = [...DIAMOND.steps, { id: 'look', op: 'gate' }];
    const r = validateRecipe({ ...DIAMOND, steps }, OPS);
    const at = (id) => r.steps.findIndex((s) => s.id === id);
    const ids = (i) => [...downstream(r.steps, i, OPS)].map((k) => r.steps[k].id).sort();
    expect(ids(at('twice'))).toEqual(['look', 'show', 'sum', 'twice']);
    expect(ids(at('show'))).toEqual(['look', 'show']);
    expect(ids(at('look'))).toEqual(['look']);
    // And it runs after them, though a wire runs from a later step to an earlier one.
    const back = [{ id: 's1', op: 'mul', inputs: { a: { from: 's3', output: 'out' } } }, { id: 's2', op: 'gate' }, { id: 's3', op: 'num' }];
    expect(order(back, OPS).map((k) => back[k].id)).toEqual(['s3', 's1', 's2']);
    expect([...downstream(back, 0, OPS)].map((k) => back[k].id)).toEqual(['s1', 's2']);
    // A change to s3, which s1 reads, makes s1 and the step that runs after it stale too, and a run from s3 runs all three.
    expect([...downstream(back, 2, OPS)].map((k) => back[k].id).sort()).toEqual(['s1', 's2', 's3']);
    // Whatever runs after a downstream step is itself downstream: the run order and the stale set agree.
    const ord = order(back, OPS);
    const down = downstream(back, 2, OPS);
    expect(ord.slice(ord.findIndex((k) => down.has(k))).every((k) => down.has(k))).toBe(true);
    // Without the ops nothing is known of the ports: wires alone.
    expect([...downstream(r.steps, at('show'))].map((k) => r.steps[k].id)).toEqual(['show']);
  });
  it('loads a gw-recipe/1 chain and writes gw-recipe/2', () => {
    const run = new RecipeRunner(OPS);
    run.load({ format: 'gw-recipe/1', name: 'old', steps: [{ op: 'num', params: { value: 1 } }, { op: 'log' }] });
    const f = run.toJSON();
    expect(f.format).toBe(FORMAT2);
    expect(f.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    // A chain: changing the first step makes the second stale.
    expect([...downstream(run.recipe.steps, 0)]).toEqual([0, 1]);
  });
  it('checks and coerces parameters from their schema', () => {
    const w = { where: 'step 1', param: 'p' };
    expect(checkParam({ type: 'number' }, '3.5', w)).toBe(3.5);
    expect(checkParam({ type: 'boolean' }, 'true', w)).toBe(true);
    expect(checkParam({ type: 'lonlat' }, [-105, 40], w)).toEqual([-105, 40]);
    expect(() => checkParam({ type: 'lonlat' }, [0, 95], w)).toThrow(/longitude, latitude/);
    // A form gives text: as one string, or split into a list of strings (the Recipes dock).
    expect(checkParam({ type: 'lonlat' }, ['-120', '35'], w)).toEqual([-120, 35]);
    expect(checkParam({ type: 'lonlat' }, '-120, 35', w)).toEqual([-120, 35]);
    expect(checkParam({ type: 'numbers' }, ['1', '2.5'], w)).toEqual([1, 2.5]);
    expect(() => checkParam({ type: 'lonlat' }, ['east', '35'], w)).toThrow(/longitude, latitude/);
    expect(() => checkParam({ type: 'date' }, '2020/01/01', w)).toThrow(/date/);
    expect(fits('layer:raster', 'layer')).toBe(true);
    expect(fits('layer:vector', 'layer:raster')).toBe(false);
    expect(fits('number', 'any')).toBe(true);
  });
});
