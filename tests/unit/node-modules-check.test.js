// verify stops early when node_modules doesn't match package-lock.json (issue 169).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installProblem, staleModules } from '../../.pipeline/lib/node-modules.mjs';

const lock = (packages) => ({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });

describe('staleModules', () => {
  it('is empty when every version matches', () => {
    const wanted = lock({ 'node_modules/a': { version: '1.0.0' } });
    expect(staleModules(wanted, { packages: { 'node_modules/a': { version: '1.0.0' } } })).toEqual([]);
  });

  it('reports a version that differs, naming both', () => {
    const wanted = lock({ 'node_modules/flatgeobuf': { version: '4.6.1' } });
    expect(staleModules(wanted, { packages: { 'node_modules/flatgeobuf': { version: '4.4.0' } } })).toEqual([{ path: 'node_modules/flatgeobuf', want: '4.6.1', have: '4.4.0' }]);
  });

  it('reports a missing package, unless it is optional, a peer, or for another platform', () => {
    const wanted = lock({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '1.0.0', optional: true },
      'node_modules/c': { version: '1.0.0', os: ['darwin'] },
      'node_modules/d': { version: '1.0.0', peer: true },
      'node_modules/e': { version: '1.0.0', devOptional: true },
    });
    expect(staleModules(wanted, { packages: {} }).map((s) => s.path)).toEqual(['node_modules/a']);
  });

  it('still reports a version difference on an optional package', () => {
    const wanted = lock({ 'node_modules/b': { version: '2.0.0', optional: true } });
    expect(staleModules(wanted, { packages: { 'node_modules/b': { version: '1.0.0' } } })).toHaveLength(1);
  });

  it('skips links and the root, and caps the list', () => {
    const packages = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`node_modules/p${i}`, { version: '1.0.0' }]));
    expect(staleModules(lock({ 'node_modules/w': { link: true, resolved: 'w' }, ...packages }), { packages: {} })).toHaveLength(5);
  });
});

describe('installProblem', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gwb-nm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (path, value) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof value === 'string' ? value : JSON.stringify(value));
  };

  it('says nothing without a lockfile', () => {
    expect(installProblem(dir)).toBeNull();
  });

  it('says to run npm ci when there is no install record', () => {
    put('package-lock.json', lock({}));
    expect(installProblem(dir)).toMatch(/npm ci --ignore-scripts/);
  });

  it('names the stale package and the fix, and says nothing when they match', () => {
    put('package-lock.json', lock({ 'node_modules/a': { version: '2.0.0' } }));
    put('node_modules/.package-lock.json', { packages: { 'node_modules/a': { version: '1.0.0' } } });
    expect(installProblem(dir)).toMatch(/node_modules\/a: lockfile 2\.0\.0, installed 1\.0\.0[\s\S]*npm ci --ignore-scripts/);
    put('node_modules/.package-lock.json', { packages: { 'node_modules/a': { version: '2.0.0' } } });
    expect(installProblem(dir)).toBeNull();
  });

  it('does not block a run on a file it cannot read', () => {
    put('package-lock.json', lock({}));
    put('node_modules/.package-lock.json', '{ nope');
    expect(installProblem(dir)).toBeNull();
  });
});
