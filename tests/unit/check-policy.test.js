import { describe, expect, it } from 'vitest';
import { findTerms, hashTerm, words } from '../../build/check-policy.mjs';

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
