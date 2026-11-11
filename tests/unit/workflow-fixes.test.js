// #191: the workflow model's parameter checks and provenance, and the catalogue converters' name
// tables and nulls. Each case failed before its fix.
import { describe, expect, it } from 'vitest';
import { RecipeRunner, checkParam, FORMAT2 } from '../../app/src/recipes/recipe.js';
import { fromIdPresets } from '../../app/src/vector/catalog-import.js';
import { validateCatalog, nullOf } from '../../app/src/vector/schema.js';

const where = { where: 'step 1 (s1)', param: 'k' };

describe('#191 workflow parameters', () => {
  it('gives a cleared number field its default', () => {
    const spec = { type: 'number', default: 5 };
    for (const v of ['', '  ', null, undefined]) expect(checkParam(spec, v, where), JSON.stringify(v)).toBe(5);
    // The op's own default, when it gives one, wins over the schema's.
    expect(checkParam(spec, '', where, 7)).toBe(7);
    expect(checkParam({ type: 'integer', default: 2 }, ' ', where)).toBe(2);
    expect(checkParam(spec, ' 3.5 ', where)).toBe(3.5);
  });
  it('takes only numbers and number text as numbers', () => {
    for (const v of [true, false, [], [4], {}]) expect(() => checkParam({ type: 'number' }, v, where), JSON.stringify(v)).toThrow(/must be a number/);
  });
  it('takes a longitude from -180 to 180', () => {
    expect(checkParam({ type: 'lonlat' }, '-180, 45', where)).toEqual([-180, 45]);
    expect(() => checkParam({ type: 'lonlat' }, [200, 45], where)).toThrow(/longitude, latitude/);
    expect(() => checkParam({ type: 'lonlat' }, [-181, 0], where)).toThrow(/longitude, latitude/);
  });
  it('applies the default when a loaded step leaves a number blank', async () => {
    const OPS = { num: { title: 'Number', schema: { value: { type: 'number', default: 4 } }, outputs: [{ name: 'out', type: 'number' }], run: ({ value }) => ({ outputs: { out: value } }) } };
    const run = new RecipeRunner(OPS);
    run.load({ format: FORMAT2, name: 'blank', steps: [{ id: 'a', op: 'num', params: { value: '' } }] });
    await run.run();
    expect(run.outputs.get('a').out).toBe(4);
    run.setParam(0, 'value', ' ');
    await run.run();
    expect(run.outputs.get('a').out).toBe(4);
  });
  it('keeps a finished step done when its provenance record fails', async () => {
    const OPS = { num: { title: 'Number', outputs: [{ name: 'out', type: 'number' }], run: () => ({ outputs: { out: 1 } }) } };
    const logs = [];
    const run = new RecipeRunner(OPS, {
      app: { log: (level, m) => logs.push([level, m]) },
      provenance: () => {
        throw new Error('store closed');
      },
    });
    run.load({ format: FORMAT2, name: 'p', steps: [{ id: 'a', op: 'num' }] });
    expect(await run.run()).toEqual({ ok: true });
    expect(run.state[0].status).toBe('done');
    expect(logs).toEqual([['warn', 'workflow provenance for step a: store closed']]);
  });
});

describe('#191 catalogue import', () => {
  it('keeps a tag called toString or valueOf as an attribute', () => {
    const c = validateCatalog(fromIdPresets({ 'x/y': { geometry: ['point'], tags: { toString: 'a', valueOf: '*' } } }));
    expect(c.types[0].attributes).toEqual(['toString', 'valueOf']);
    expect(c.attributes.toString).toMatchObject({ type: 'text' });
    expect(c.types[0].subtypes[0].fixed).toEqual({ toString: 'a' });
  });
  it('gives an integer enum an empty null as null, not text', () => {
    const cat = { nulls: { enum: '' } };
    expect(nullOf(cat, { type: 'integer', domain: { 1: 'one' } })).toBeNull();
    expect(nullOf(cat, { type: 'text', domain: { a: 'A' } })).toBe('');
    expect(nullOf({ nulls: { enum: -1 } }, { type: 'integer', domain: { 1: 'one' } })).toBe(-1);
  });
});
