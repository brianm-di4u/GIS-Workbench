// Issue 257: the reviewer evals grade only a council round's own result. Anything else is no review,
// so it never passes a clean case.
import { describe, expect, it } from 'vitest';
import { gradeCase } from '../../.pipeline/lib/evals.mjs';

const clean = { id: 'c1', kind: 'clean', split: 'dev' };
const bug = { id: 'b1', kind: 'bug', split: 'dev', expect: [{ file: 'a.js', from: 10, to: 12, words: ['overflow'] }] };
const real = { findings: [], seats: ['council-bug-hunter'], missing: [], partial: [], refuted: 0 };

describe('grading a reviewer eval', () => {
  it('passes a clean case only on a real round that found nothing blocking', () => {
    expect(gradeCase(clean, real)).toMatchObject({ pass: true, incomplete: false });
    for (const bad of [null, {}, { findings: [] }, { findings: [], seats: [], missing: [] }, { summary: 's', result: real }, { ...real, findings: [{ severity: 'high', file: 'a.js', line: 1 }] }]) {
      expect(gradeCase(clean, bad), JSON.stringify(bad)).toMatchObject({ pass: false, incomplete: true });
    }
  });

  it('still finds a planted bug in a real round', () => {
    const found = { ...real, findings: [{ severity: 'should', file: 'a.js', line: 11, class: 'integer overflow', claim: 'c' }] };
    expect(gradeCase(bug, found)).toMatchObject({ pass: true, found: 1, incomplete: false });
    expect(gradeCase(bug, { ...found, missing: ['council-architect'] })).toMatchObject({ pass: false, incomplete: true });
  });
});
