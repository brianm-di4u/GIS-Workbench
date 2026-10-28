// REQ-PIP-01 REQ-PIP-02 REQ-PIP-03: recipe validation and the step runner (order, gates, failures,
// stale steps, re-run from a step, round trip as a file).
import { describe, it, expect } from 'vitest';
import { validateRecipe, RecipeRunner, FORMAT } from '../../app/src/recipes/recipe.js';

const log = [];
const OPS = {
  add: { title: 'Add', defaults: { n: 1 }, run: ({ n }) => (log.push(`add${n}`), { summary: `+${n}` }) },
  gate: { title: 'Gate', gate: true, run: () => (log.push('gate'), { summary: 'waiting' }), after: () => ({ summary: 'reviewed' }) },
  boom: { title: 'Boom', run: () => {
    throw new Error('broken');
  } },
};
const R = (steps) => ({ format: FORMAT, name: 'Test', steps });

describe('recipe validation', () => {
  it('fills defaults, ids and titles', () => {
    const r = validateRecipe(R([{ op: 'add' }, { op: 'add', params: { n: 3 }, title: 'Three' }]), OPS);
    expect(r.steps.map((s) => [s.id, s.title, s.params.n])).toEqual([['s1', 'Add', 1], ['s2', 'Three', 3]]);
    expect(r.id).toBe('test');
  });
  it('refuses foreign formats, unknown operations and duplicate ids', () => {
    expect(() => validateRecipe({ format: 'x', name: 'a', steps: [{ op: 'add' }] }, OPS)).toThrow(/not a GIS Workbench recipe/);
    expect(() => validateRecipe(R([{ op: 'rm' }]), OPS)).toThrow(/unknown operation "rm"/);
    expect(() => validateRecipe(R([{ op: 'add', id: 'a' }, { op: 'add', id: 'a' }]), OPS)).toThrow(/duplicate id/);
    expect(() => validateRecipe(R([]), OPS)).toThrow(/no steps/);
    expect(() => validateRecipe(R([{ op: 'add', params: [] }]), OPS)).toThrow(/params must be an object/);
  });
});

describe('recipe runner', () => {
  it('runs in order, waits at a gate until resumed, and records summaries', async () => {
    log.length = 0;
    const run = new RecipeRunner(OPS);
    run.load(R([{ op: 'add' }, { op: 'gate' }, { op: 'add', params: { n: 2 } }]));
    const p = run.run();
    await new Promise((r) => setTimeout(r, 10));
    expect(run.waiting).toBe(true);
    expect(run.state.map((s) => s.status)).toEqual(['done', 'waiting', 'pending']);
    expect(log).toEqual(['add1', 'gate']);
    run.resume();
    expect(await p).toEqual({ ok: true });
    expect(log).toEqual(['add1', 'gate', 'add2']);
    expect(run.state.map((s) => s.summary)).toEqual(['+1', 'reviewed', '+2']);
  });
  it('stops at a failing step, marks later steps stale after a change, re-runs from a step', async () => {
    log.length = 0;
    const run = new RecipeRunner(OPS);
    run.load(R([{ op: 'add' }, { op: 'boom' }, { op: 'add', params: { n: 5 } }]));
    expect(await run.run()).toEqual({ ok: false, failed: 1, error: 'broken' });
    expect(run.state.map((s) => s.status)).toEqual(['done', 'failed', 'pending']);
    run.recipe.steps[1].op = 'add';
    run.setParam(0, 'n', 7);
    expect(run.state[0].status).toBe('stale');
    log.length = 0;
    expect((await run.run(2)).ok).toBe(true);
    expect(log).toEqual(['add5']);
    expect(run.toJSON().steps[0].params).toEqual({ n: 7 });
    expect(validateRecipe(JSON.parse(JSON.stringify(run.toJSON())), OPS).steps).toHaveLength(3);
  });
});
