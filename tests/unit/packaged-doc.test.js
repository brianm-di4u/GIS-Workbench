// #177: docs/runner.md ships in both sidecar packages as RUNNER.md, where links into the source tree are dead.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { packagedDoc } from '../../sidecar/installer/gates.mjs';

describe('packagedDoc', () => {
  it('keeps only the text of a link into the source, and keeps web and anchor links', () => {
    expect(packagedDoc('See [decision 0017](decisions/0017.md), [the site](https://example.org/a) and [below](#use).'))
      .toBe('See decision 0017, [the site](https://example.org/a) and [below](#use).');
  });

  it('leaves no link into the source in docs/runner.md', () => {
    const doc = packagedDoc(readFileSync('docs/runner.md', 'utf8'));
    expect(doc).toContain('decision 0017');
    expect(doc.match(/\]\((?!https?:|#)/g)).toBeNull();
  });
});
