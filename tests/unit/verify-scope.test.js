import { describe, expect, it } from 'vitest';
import { affectedCrates, planSteps } from '../../build/verify-scope.mjs';
import { grepInvert, problems } from '../../build/check-quarantine.mjs';

const names = (input) => planSteps(input).map((step) => step.name);
const ALL = ['Quarantine list', 'Crate licences and sources', 'Rust tests', 'Strict build', 'Unit and golden tests', 'Browser subset', 'Sidecar licences and sources', 'Sidecar tests'];

describe('verify scope', () => {
  it('runs everything when the change set is unknown', () => {
    expect(names({ paths: null })).toEqual(ALL);
  });

  it('runs everything when CI itself changed, because the scope can no longer be trusted', () => {
    expect(names({ paths: ['.github/workflows/ci.yml'] })).toEqual(ALL);
    expect(names({ paths: ['build/verify-scope.mjs'] })).toEqual(ALL);
    expect(names({ paths: ['.node-version'] })).toEqual(ALL);
  });

  it('runs only the quarantine check for prose', () => {
    expect(names({ paths: ['docs/RUNBOOK.md', 'README.md'] })).toEqual(['Quarantine list']);
  });

  it('treats CHANGELOG.md as code, since the build embeds it', () => {
    expect(names({ paths: ['CHANGELOG.md'] })).toContain('Strict build');
  });

  it('skips Rust for an app change', () => {
    const steps = names({ paths: ['app/src/shell/commands.js'] });
    expect(steps).toEqual(['Quarantine list', 'Strict build', 'Unit and golden tests', 'Browser subset']);
  });

  it('tests only the affected crates', () => {
    const rust = planSteps({ paths: ['crates/gw-a/src/lib.rs'], crates: ['gw-a', 'gw-b'] }).find((s) => s.name === 'Rust tests');
    expect(rust.args).toEqual(['test', '--no-fail-fast', '-p', 'gw-a', '-p', 'gw-b']);
    expect(rust.cwd).toBe('crates');
  });

  it('tests the whole workspace when shared Rust config changed', () => {
    for (const path of ['crates/Cargo.lock', 'crates/deny.toml', 'crates/.cargo/config.toml', 'crates/vendor/fax/src/lib.rs']) {
      const rust = planSteps({ paths: [path], crates: ['gw-a'] }).find((s) => s.name === 'Rust tests');
      expect(rust.args).toEqual(['test', '--no-fail-fast', '--workspace']);
    }
  });

  it('tests the whole workspace when the crate list is unknown', () => {
    const rust = planSteps({ paths: ['crates/gw-a/src/lib.rs'], crates: null }).find((s) => s.name === 'Rust tests');
    expect(rust.args).toEqual(['test', '--no-fail-fast', '--workspace']);
  });

  it('runs a crate change through the build and the browser, since it changes the app', () => {
    expect(names({ paths: ['crates/gw-a/src/lib.rs'], crates: ['gw-a'] })).toContain('Browser subset');
  });

  it('keeps the legs apart', () => {
    expect(names({ paths: ['sidecar/gwb-sidecar/src/main.rs'], leg: 'sidecar' })).toEqual(['Sidecar licences and sources', 'Sidecar tests']);
    expect(names({ paths: ['app/src/a.js'], leg: 'sidecar' })).toEqual([]);
    expect(names({ paths: ['sidecar/gwb-sidecar/src/main.rs'], leg: 'linux' })).not.toContain('Sidecar tests');
  });
});

describe('affected crates', () => {
  const packages = [
    { name: 'a', dir: 'crates/a', deps: [] },
    { name: 'b', dir: 'crates/b', deps: ['a'] },
    { name: 'c', dir: 'crates/c', deps: ['b'] },
    { name: 'd', dir: 'crates/d', deps: [] },
    { name: 'ab', dir: 'crates/ab', deps: [] },
  ];

  it('follows dependents through the graph', () => {
    expect(affectedCrates(packages, ['crates/a/src/lib.rs'])).toEqual(['a', 'b', 'c']);
  });

  it('leaves out crates that do not depend on the change', () => {
    expect(affectedCrates(packages, ['crates/c/src/lib.rs'])).toEqual(['c']);
  });

  it('matches whole folder names', () => {
    expect(affectedCrates(packages, ['crates/ab/src/lib.rs'])).toEqual(['ab']);
  });
});

describe('quarantine list', () => {
  const good = { test: 'REQ-1 a title', issue: 12, expires: '2026-12-31' };

  it('accepts a complete entry that has not expired', () => {
    expect(problems([good], '2026-12-31')).toEqual([]);
  });

  it('fails an expired entry', () => {
    expect(problems([good], '2027-01-01')[0]).toMatch(/expired on 2026-12-31/);
  });

  it('fails an entry with no issue or expiry', () => {
    expect(problems([{ test: 'x' }], '2026-01-01')).toHaveLength(2);
  });

  it('turns titles into one literal filter', () => {
    expect(grepInvert([])).toBeUndefined();
    const re = grepInvert([good, { ...good, test: 'a (b)' }]);
    expect(re.test('REQ-1 a title and more')).toBe(true);
    expect(re.test('a (b)')).toBe(true);
    expect(re.test('a b')).toBe(false);
  });
});
