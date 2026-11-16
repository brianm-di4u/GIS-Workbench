// Decision 0027: type checking for app/src as a ratchet. build/check-types.mjs runs TypeScript and
// compares the errors in each module with build/typecheck-baseline.json. These are its pure parts;
// verify runs the check itself.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { compare, countByFile, lowered, parseErrors, raised } from '../../build/check-types.mjs';

const OUTPUT = [
  "app/src/core/a.js(12,5): error TS2339: Property 'x' does not exist on type 'A'.",
  "app\\src\\core\\a.js(40,1): error TS2554: Expected 0 arguments, but got 1.",
  "app/src/shell/b.js(3,9): error TS2322: Type 'string' is not assignable to type 'number'.",
  "  Type 'string' is not assignable to type 'number'.",
  '',
].join('\r\n');

describe('reading TypeScript output', () => {
  it('reads each error with its file, line and code, on either path separator, and skips continuation lines', () => {
    const errors = parseErrors(OUTPUT);
    expect(errors.map((e) => [e.file, e.line, e.code])).toEqual([
      ['app/src/core/a.js', 12, 'TS2339'],
      ['app/src/core/a.js', 40, 'TS2554'],
      ['app/src/shell/b.js', 3, 'TS2322'],
    ]);
    expect(countByFile(errors)).toEqual({ 'app/src/core/a.js': 2, 'app/src/shell/b.js': 1 });
  });

  it('keeps an error that names no file, such as a bad config, apart from the counts', () => {
    const errors = parseErrors("error TS5023: Unknown compiler option 'x'.\n");
    expect(errors).toEqual([{ file: null, line: 0, code: 'TS5023', message: "error TS5023: Unknown compiler option 'x'." }]);
    expect(countByFile(errors)).toEqual({});
  });
});

describe('the ratchet', () => {
  const baseline = { 'app/src/a.js': 2, 'app/src/b.js': 1, 'app/src/c.js': 4 };

  it('fails a listed file that gained an error and a file that is not listed', () => {
    expect(compare({ 'app/src/a.js': 3, 'app/src/b.js': 1, 'app/src/c.js': 4, 'app/src/new.js': 1 }, baseline).over).toEqual([
      { file: 'app/src/a.js', allowed: 2, found: 3 },
      { file: 'app/src/new.js', allowed: 0, found: 1 },
    ]);
  });

  it('reports a file whose number can come down, a file that is now clean included', () => {
    expect(compare({ 'app/src/a.js': 2, 'app/src/c.js': 1 }, baseline)).toEqual({
      over: [],
      under: [
        { file: 'app/src/b.js', allowed: 1, found: 0 },
        { file: 'app/src/c.js', allowed: 4, found: 1 },
      ],
    });
  });

  it('lowers numbers, drops a clean file, and never raises or adds one', () => {
    expect(lowered({ 'app/src/a.js': 5, 'app/src/c.js': 1, 'app/src/new.js': 2 }, baseline)).toEqual({ 'app/src/a.js': 2, 'app/src/c.js': 1 });
  });

  it('names a number that is higher than the one main has, and a file main did not list', () => {
    expect(raised({ 'app/src/a.js': 3, 'app/src/b.js': 1, 'app/src/new.js': 1 }, baseline)).toEqual(['app/src/a.js', 'app/src/new.js']);
    expect(raised({ 'app/src/a.js': 1 }, baseline)).toEqual([]);
  });
});

describe('the baseline (build/typecheck-baseline.json)', () => {
  const baseline = JSON.parse(readFileSync('build/typecheck-baseline.json', 'utf8'));

  it('lists modules that exist, each with a whole number above zero, in order', () => {
    const files = Object.keys(baseline);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !f.startsWith('app/src/') || !existsSync(f)), 'these modules are gone: run node build/check-types.mjs --lower').toEqual([]);
    expect(files.filter((f) => !Number.isInteger(baseline[f]) || baseline[f] < 1)).toEqual([]);
    expect(files).toEqual([...files].sort());
  });
});
