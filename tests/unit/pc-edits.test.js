// REQ-GAP-81: point-cloud edits from the profile view. The replay of `pcedit` records over the
// file's own classes and flags, the one deleted mask, the compacted cloud the exports write, and
// box and lasso selection in the profile's plane.
import { describe, it, expect } from 'vitest';
import { replay, kept, keptIndex, compact, selectBox, selectLasso, WITHHELD } from '../../app/src/analysis/pc-edits.js';

/** A small cloud with every column the LAS reader makes. */
function cloud(n = 6) {
  const c = {
    n,
    pos: Float32Array.from({ length: 3 * n }, (_, k) => k),
    time: Float64Array.from({ length: n }, (_, k) => 100 + k),
    intensity: Uint16Array.from({ length: n }, (_, k) => 10 * k),
    source: new Uint16Array(n),
    scan: new Int16Array(n),
    rgb: null,
    class: Uint8Array.from({ length: n }, () => 2),
    ret: new Uint8Array(n),
    flags: new Uint8Array(n),
    user: new Uint8Array(n),
    hag: Float32Array.from({ length: n }, (_, k) => k / 2),
  };
  c.class0 = c.class.slice();
  c.flags0 = c.flags.slice();
  return c;
}

describe('REQ-GAP-81 point edits replay', () => {
  it('replays classes, flags and deletions in sequence; undo is replaying fewer records', () => {
    const c = cloud();
    const ops = [
      { id: 'a', params: { to: 7 } },
      { id: 'b', params: { field: 'flags' } },
      { id: 'c', params: { field: 'deleted' } },
      { id: 'd', params: { field: 'deleted' } },
    ];
    const diffs = {
      a: { index: Uint32Array.of(0, 1), value: Uint8Array.of(7, 7) },
      b: { index: Uint32Array.of(1), value: Uint8Array.of(WITHHELD) },
      c: { index: Uint32Array.of(0, 5), value: null },
      d: { index: Uint32Array.of(5, 3), value: null }, // 5 again: counted once
    };
    const r = replay(c, ops, (o) => diffs[o.id]);
    expect(Array.from(r.class)).toEqual([7, 7, 2, 2, 2, 2]);
    expect(Array.from(r.flags)).toEqual([0, WITHHELD, 0, 0, 0, 0]);
    expect(Array.from(r.deleted)).toEqual([1, 0, 0, 1, 0, 1]);
    expect(r.nDeleted).toBe(3);
    // The file's own columns are never changed.
    expect(Array.from(c.class0)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(Array.from(c.flags0)).toEqual([0, 0, 0, 0, 0, 0]);
    // Undoing the deletions: no mask at all, so consumers take their fast path.
    const u = replay(c, ops.slice(0, 2), (o) => diffs[o.id]);
    expect(u.deleted).toBeNull();
    expect(u.nDeleted).toBe(0);
    // A record whose change is not in memory (a project reopened without it) is skipped.
    expect(replay(c, [{ id: 'x' }], () => undefined).class).toEqual(c.class0);
  });

  it('kept, keptIndex and compact agree, and compact copies every column', () => {
    const c = cloud();
    expect(compact(c)).toBe(c);
    expect(keptIndex(c)).toBeNull();
    c.deleted = Uint8Array.of(1, 0, 0, 1, 0, 1);
    c.nDeleted = 3;
    c.class = Uint8Array.of(7, 7, 2, 2, 6, 2);
    expect([0, 1, 2, 3, 4, 5].filter((k) => kept(c, k))).toEqual([1, 2, 4]);
    expect(Array.from(keptIndex(c))).toEqual([1, 2, 4]);
    const s = compact(c);
    expect(s.n).toBe(3);
    expect(s.deleted).toBeNull();
    expect(Array.from(s.pos)).toEqual([3, 4, 5, 6, 7, 8, 12, 13, 14]);
    expect(Array.from(s.class)).toEqual([7, 2, 6]);
    expect(Array.from(s.time)).toEqual([101, 102, 104]);
    expect(Array.from(s.intensity)).toEqual([10, 20, 40]);
    expect(Array.from(s.hag)).toEqual([0.5, 1, 2]);
    expect(Array.from(s.class0)).toEqual([2, 2, 2]);
    // The cloud itself is untouched.
    expect(c.n).toBe(6);
    expect(c.pos.length).toBe(18);
  });

  it('selects by box and by lasso in the profile plane', () => {
    const pr = { index: Uint32Array.of(10, 11, 12, 13), along: Float32Array.of(1, 2, 3, 4), z: Float32Array.of(100, 130, 101, 99) };
    // A box above the ground line picks the high outlier, whichever corner the drag began at.
    expect(Array.from(selectBox(pr, [1.5, 120, 2.5, 140]))).toEqual([11]);
    expect(Array.from(selectBox(pr, [2.5, 140, 1.5, 120]))).toEqual([11]);
    expect(Array.from(selectBox(pr, [0, 0, 10, 1000]))).toEqual([10, 11, 12, 13]);
    // A lasso: a triangle round points 2 and 3 only.
    expect(Array.from(selectLasso(pr, [[2, 95], [5, 95], [3.5, 110]]))).toEqual([12, 13]);
    expect(Array.from(selectLasso(pr, [[0, 0], [1, 1]]))).toEqual([]);
  });
});
