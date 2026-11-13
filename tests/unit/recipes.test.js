// REQ-PIP-01 REQ-PIP-02 REQ-PIP-03: recipe validation and the step runner (order, gates, failures,
// stale steps, re-run from a step, round trip as a file).
import { describe, it, expect } from 'vitest';
import { validateRecipe, RecipeRunner, FORMAT, unattended } from '../../app/src/recipes/recipe.js';

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

// #177: why a recipe can't run with nobody at the page (gwb-run), checked before anything runs.
describe('unattended runs', () => {
  const ops = {
    add: OPS.add,
    gate: OPS.gate,
    read: { title: 'Read', files: true, dialog: (p) => !p.files?.length, run: () => ({}) },
    command: { title: 'Command', dialog: () => true, run: () => ({}) },
  };
  const why = (steps, opts) => unattended(R(steps), ops, opts);
  it('passes a recipe that needs nobody', () => {
    expect(why([{ op: 'add' }, { op: 'gate' }])).toBe(null);
    expect(why([{ op: 'read', id: 'in' }], { params: { in: { files: ['a.tif'] } } })).toBe(null);
  });
  it('names the first step that would wait for someone, and why', () => {
    expect(why([{ op: 'add' }, { op: 'gate', id: 'g', title: 'Check' }], { gates: 'stop' })).toEqual({ step: 'g', title: 'Check', reason: 'is a review gate, and gates are set to stop' });
    expect(why([{ op: 'add', id: 'a' }], { params: { a: { files: ['x.tif'] } } })).toMatchObject({ step: 'a', reason: 'takes no files, so the files given to it would be ignored' });
    expect(why([{ op: 'read', id: 'in' }])).toMatchObject({ step: 'in', reason: 'opens a dialog unless the command line gives it files' });
    expect(why([{ op: 'command', id: 'c' }, { op: 'gate' }], { gates: 'stop' })).toMatchObject({ step: 'c', reason: 'runs a command, which may open a dialog' });
  });
  it('refuses a recipe that is not valid, as validation does', () => {
    expect(() => why([{ op: 'rm' }])).toThrow(/unknown operation "rm"/);
  });
});
