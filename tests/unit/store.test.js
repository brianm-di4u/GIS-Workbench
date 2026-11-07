// REQ-ARC-12 REQ-ARC-13 PT-06: store ops are invertible; random op sequences undo to an
// identical state; transactions roll back; vertex ops do not clone whole geometries.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Store } from '../../app/src/core/store.js';
import { UndoManager } from '../../app/src/core/undo.js';
import { keyBetween, setPath, deepEqual } from '../../app/src/core/util.js';

// Canonical serialisation: records by id, keys sorted (key order is not part of the state).
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const snap = (s) => JSON.stringify(canon([...s.records.values()].sort((a, b) => (a.id < b.id ? -1 : 1))));

describe('Store', () => {
  it('REQ-ARC-12 PT-06 random op sequences undo to the starting state', () => {
    const opArb = fc.oneof(
      fc.record({ k: fc.constant('create'), n: fc.integer({ min: 0, max: 5 }), v: fc.integer() }),
      fc.record({ k: fc.constant('set'), n: fc.integer({ min: 0, max: 5 }), v: fc.oneof(fc.integer(), fc.string(), fc.constant(undefined)) }),
      fc.record({ k: fc.constant('delete'), n: fc.integer({ min: 0, max: 5 }) }),
      fc.record({ k: fc.constant('vins'), n: fc.integer({ min: 0, max: 5 }), i: fc.nat(10), v: fc.double({ noNaN: true }) }),
      fc.record({ k: fc.constant('vset'), n: fc.integer({ min: 0, max: 5 }), i: fc.nat(10), v: fc.double({ noNaN: true }) }),
      fc.record({ k: fc.constant('vdel'), n: fc.integer({ min: 0, max: 5 }), i: fc.nat(10) }),
    );
    fc.assert(
      fc.property(fc.array(fc.array(opArb, { maxLength: 6 }), { maxLength: 25 }), (txs) => {
        const s = new Store();
        const u = new UndoManager(s);
        s.transact('seed', (tx) => tx.create('graphic', { a: 1, geom: { coords: [[0, 0]] } }, 'g0'));
        u.clear();
        const start = snap(s);
        let committed = 0;
        for (const ops of txs) {
          const cs = s.transact('t', (tx) => {
            for (const o of ops) {
              const id = `g${o.n}`;
              const rec = tx.get(id);
              if (o.k === 'create' && !rec) tx.create('graphic', { a: o.v, geom: { coords: [] } }, id);
              else if (o.k === 'set' && rec) tx.set(id, 'a', o.v);
              else if (o.k === 'delete' && rec) tx.delete(id);
              else if (o.k === 'vins' && rec && o.i <= rec.geom.coords.length) tx.vins(id, 'geom.coords', o.i, [o.v, -o.v]);
              else if (o.k === 'vset' && rec && o.i < rec.geom.coords.length) tx.vset(id, 'geom.coords', o.i, [o.v, o.v]);
              else if (o.k === 'vdel' && rec && o.i < rec.geom.coords.length) tx.vdel(id, 'geom.coords', o.i);
            }
          });
          if (cs) committed++;
        }
        const end = snap(s);
        for (let i = 0; i < committed; i++) u.undo();
        expect(snap(s)).toBe(start);
        for (let i = 0; i < committed; i++) u.redo();
        expect(snap(s)).toBe(end);
      }),
      { numRuns: 300 },
    );
  });

  it('REQ-ARC-12 rolls back a failing transaction completely', () => {
    const s = new Store();
    s.transact('a', (tx) => tx.create('layer', { name: 'x' }, 'L1'));
    const before = snap(s);
    expect(() =>
      s.transact('b', (tx) => {
        tx.set('L1', 'name', 'y');
        tx.create('layer', {}, 'L2');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(snap(s)).toBe(before);
  });

  it('REQ-ARC-12 vertex ops touch one vertex and keep array identity', () => {
    const s = new Store();
    const coords = Array.from({ length: 10000 }, (_, i) => [i, i]);
    s.transact('a', (tx) => tx.create('feature', { geom: { coords } }, 'F'));
    const arr = s.get('F').geom.coords;
    const cs = s.transact('drag', (tx) => tx.vset('F', 'geom.coords', 5000, [1, 2]));
    expect(s.get('F').geom.coords).toBe(arr);
    expect(cs.ops).toHaveLength(1);
    expect(JSON.stringify(cs.ops[0]).length).toBeLessThan(200);
  });

  it('REQ-ARC-13 coalesces edits with a mergeKey until seal()', () => {
    const s = new Store();
    const u = new UndoManager(s);
    s.transact('mk', (tx) => tx.create('graphic', { x: 0 }, 'g'));
    for (let i = 1; i <= 10; i++) s.transact('move', (tx) => tx.set('g', 'x', i), { mergeKey: 'drag:g' });
    u.seal();
    s.transact('move', (tx) => tx.set('g', 'x', 99), { mergeKey: 'drag:g' });
    expect(u.undoStack).toHaveLength(3);
    u.undo();
    expect(s.get('g').x).toBe(10);
    u.undo();
    expect(s.get('g').x).toBe(0);
  });

  it('REQ-AI-06 dry runs leave the store unchanged and detect staleness', () => {
    const s = new Store();
    s.transact('a', (tx) => tx.create('graphic', { label: 'A' }, 'g'));
    const before = snap(s);
    const cs = s.dryRun('proposal', (tx) => tx.set('g', 'label', 'B'));
    expect(snap(s)).toBe(before);
    expect(s.isCurrent(cs)).toBe(true);
    s.transact('user edit', (tx) => tx.set('g', 'label', 'C'));
    expect(s.isCurrent(cs)).toBe(false);
  });

  it('refuses prototype-polluting paths and immutable fields', () => {
    const s = new Store();
    s.transact('a', (tx) => tx.create('graphic', {}, 'g'));
    expect(() => s.transact('x', (tx) => tx.set('g', '__proto__.polluted', 1))).toThrow();
    expect(() => s.transact('x', (tx) => tx.set('g', 'id', 'h'))).toThrow();
    expect({}.polluted).toBeUndefined();
    expect(() => setPath({}, 'constructor.prototype.x', 1)).toThrow();
  });
});

describe('util', () => {
  it('keyBetween orders strictly', () => {
    let a = '';
    const keys = [];
    for (let i = 0; i < 50; i++) {
      a = keyBetween(a, '');
      keys.push(a);
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i] > keys[i - 1]).toBe(true);
    const m = keyBetween('a', 'b');
    expect(m > 'a' && m < 'b').toBe(true);
  });
  it('deepEqual handles typed arrays and NaN', () => {
    expect(deepEqual(new Float64Array([1, NaN]), new Float64Array([1, NaN]))).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
  });
});
