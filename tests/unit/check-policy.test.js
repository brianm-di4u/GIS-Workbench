import { describe, expect, it } from 'vitest';
import { filesToScan, findTerms, hashTerm, words } from '../../build/check-policy.mjs';

const banned = new Set([hashTerm('blue widget'), hashTerm('gizmo')]);
const found = (text) => findTerms(text, banned).size;

describe('civilian-use check', () => {
  it('normalises case and punctuation, so a term can be spelled any way', () => {
    expect(hashTerm('Blue-Widget')).toBe(hashTerm('blue widget'));
    expect(words('Blue_Widget 2')).toEqual(['blue', 'widget', '2']);
  });

  it('finds a term of one word and of several', () => {
    expect(found('a gizmo here')).toBe(1);
    expect(found('the BLUE-WIDGET view')).toBe(1);
    expect(found('import x from "blue/widget"')).toBe(1);
  });

  it('matches whole words only', () => {
    expect(found('gizmos and gizmology')).toBe(0);
    expect(found('blue paint, widget box')).toBe(0);
  });

  it('counts each term once', () => {
    expect(found('gizmo gizmo gizmo')).toBe(1);
  });
});

// #312: a branch scans only the files it changed; main, an unknown change set, and a change to the
// list or the checker scan everything.
describe('files to scan', () => {
  const tracked = ['a.md', 'b.js', 'c.json'];
  it('scans everything with no change set', () => {
    expect(filesToScan(tracked, null)).toEqual(tracked);
  });
  it('scans only the tracked files a branch changed', () => {
    expect(filesToScan(tracked, ['b.js', 'fixtures/x.bin', 'gone.md'])).toEqual(['b.js']);
    expect(filesToScan(tracked, [])).toEqual([]);
  });
  it('scans everything when the list or the checker changed', () => {
    expect(filesToScan(tracked, ['b.js', 'build/check-policy.terms.json'])).toEqual(tracked);
    expect(filesToScan(tracked, ['build/check-policy.mjs'])).toEqual(tracked);
  });
});
