import { describe, expect, it } from 'vitest';
import { affectedCrates, dataSkips, fixtureCrates, planSteps } from '../../build/verify-scope.mjs';
import { grepInvert, problems } from '../../build/check-quarantine.mjs';

const names = (input) => planSteps(input).map((step) => step.name);
const ALL = ['Quarantine list', 'Civilian-use check', 'D: drive paths', 'Changelog fragments', 'Crate licences and sources', 'Clippy', 'Rust tests', 'Source catalogue', 'Locale catalogues', 'Strict build', 'Size report', 'Unit and golden tests', 'Browser subset', 'Sidecar licences and sources', 'Sidecar clippy', 'Sidecar tests', 'Sidecar sfm clippy', 'Sidecar sfm tests'];

describe('verify scope', () => {
  it('runs everything when the change set is unknown', () => {
    expect(names({ paths: null })).toEqual(ALL);
  });

  it('runs everything when CI itself changed, because the scope can no longer be trusted', () => {
    expect(names({ paths: ['.github/workflows/ci.yml'] })).toEqual(ALL);
    expect(names({ paths: ['build/verify-scope.mjs'] })).toEqual(ALL);
    expect(names({ paths: ['.node-version'] })).toEqual(ALL);
  });

  it('runs only the two list checks for prose', () => {
    expect(names({ paths: ['docs/RUNBOOK.md', 'README.md'] })).toEqual(['Quarantine list', 'Civilian-use check', 'D: drive paths']);
  });

  it('checks changelog fragments when one or the checker changed', () => {
    expect(names({ paths: ['changes/fix-a.md'] })).toEqual(['Quarantine list', 'Civilian-use check', 'D: drive paths', 'Changelog fragments']);
    expect(names({ paths: ['build/release/changelog.mjs'] })).toContain('Changelog fragments');
    expect(names({ paths: ['app/src/a.js'] })).not.toContain('Changelog fragments');
  });

  it('checks the source catalogue for any code change', () => {
    expect(names({ paths: ['app/src/a.js'] })).toContain('Source catalogue');
    expect(names({ paths: ['docs/a.md'] })).not.toContain('Source catalogue');
  });

  // #266, #292: a translation that fails checkMessage shows in English with no error, so a change
  // to a locale catalogue, or to what checking one reads, checks them all. A stale key fails only in
  // the catalogues the branch changed; en.json alone is the source's.
  it('checks the locale catalogues, and strictly the ones the branch changed', () => {
    const args = (paths) => planSteps({ paths }).find((s) => s.name === 'Locale catalogues')?.args;
    expect(args(['app/src/i18n/catalog/de.json', 'app/src/i18n/state/de.json', 'app/src/i18n/catalog/pt-BR.json'])).toEqual(['build/i18n.mjs', 'check', '--strict=de,pt-BR']);
    expect(args(['app/src/i18n/state/fr.json', 'app/src/i18n/catalog/en.json'])).toEqual(['build/i18n.mjs', 'check', '--strict=fr']);
    // Only a locale tag's shape reaches the command line, which is a shell on Windows.
    expect(args(['app/src/i18n/state/x&calc&.json', 'app/src/i18n/catalog/de.json'])).toEqual(['build/i18n.mjs', 'check', '--strict=de']);
    for (const path of ['build/i18n.mjs', 'app/src/i18n/glossary/dnt.json', 'app/src/i18n/locales.json']) expect(args([path]), path).toEqual(['build/i18n.mjs', 'check']);
    expect(args(['app/src/i18n/catalog/en.json'])).toBeUndefined();
    expect(args(['app/src/a.js'])).toBeUndefined();
    // On main a code change may leave stale keys until the next translation increment: errors only.
    expect(args(null)).toEqual(['build/i18n.mjs', 'check']);
  });

  // #312: a branch scans only the files it changed for civilian use; everything scans everything.
  it('scans changed files for civilian use on a branch, and every file otherwise', () => {
    const args = (paths) => planSteps({ paths }).find((s) => s.name === 'Civilian-use check')?.args;
    expect(args(['app/src/a.js'])).toEqual(['build/check-policy.mjs', '--changed']);
    expect(args(null)).toEqual(['build/check-policy.mjs']);
    expect(args(['build/verify-scope.mjs'])).toEqual(['build/check-policy.mjs']);
  });

  it('runs both Rust workspaces when the bundle adjuster cross-check block changes (decision 0020)', () => {
    const fixture = 'tests/fixtures/ba-cross-check/expected.json';
    const rustArgs = (input) => planSteps(input).find((s) => s.name === 'Rust tests')?.args;
    expect(fixtureCrates([fixture, 'app/src/a.js'])).toEqual(['gw-aero']);
    // Alone, it tests just gw-aero, not the whole workspace.
    expect(rustArgs({ paths: [fixture], crates: [] })).toEqual(['test', '--locked', '--no-fail-fast', '-p', 'gw-aero']);
    // With another crate's change, gw-aero still runs.
    expect(rustArgs({ paths: [fixture, 'crates/gw-raster/src/lib.rs'], crates: ['gw-raster'] })).toEqual(['test', '--locked', '--no-fail-fast', '-p', 'gw-raster', '-p', 'gw-aero']);
    expect(names({ paths: [fixture], crates: [] })).toContain('Sidecar sfm tests');
  });

  it('treats CHANGELOG.md as code, since the build embeds it', () => {
    expect(names({ paths: ['CHANGELOG.md'] })).toContain('Strict build');
  });

  it('skips Rust for an app change', () => {
    const steps = names({ paths: ['app/src/shell/commands.js'] });
    expect(steps).toEqual(['Quarantine list', 'Civilian-use check', 'D: drive paths', 'Source catalogue', 'Strict build', 'Size report', 'Unit and golden tests', 'Browser subset']);
  });

  it('tests only the affected crates', () => {
    const rust = planSteps({ paths: ['crates/gw-a/src/lib.rs'], crates: ['gw-a', 'gw-b'] }).find((s) => s.name === 'Rust tests');
    expect(rust.args).toEqual(['test', '--locked', '--no-fail-fast', '-p', 'gw-a', '-p', 'gw-b']);
    expect(rust.cwd).toBe('crates');
  });

  it('tests the whole workspace when shared Rust config changed', () => {
    for (const path of ['crates/Cargo.lock', 'crates/deny.toml', 'crates/.cargo/config.toml', 'crates/vendor/fax/src/lib.rs']) {
      const rust = planSteps({ paths: [path], crates: ['gw-a'] }).find((s) => s.name === 'Rust tests');
      expect(rust.args).toEqual(['test', '--locked', '--no-fail-fast', '--workspace']);
    }
  });

  it('tests the whole workspace when the crate list is unknown', () => {
    const rust = planSteps({ paths: ['crates/gw-a/src/lib.rs'], crates: null }).find((s) => s.name === 'Rust tests');
    expect(rust.args).toEqual(['test', '--locked', '--no-fail-fast', '--workspace']);
  });

  it('runs a crate change through the build and the browser, since it changes the app', () => {
    expect(names({ paths: ['crates/gw-a/src/lib.rs'], crates: ['gw-a'] })).toContain('Browser subset');
  });

  it('passes --locked to every cargo step, so a Cargo.toml-only dependency change cannot build', () => {
    const cargo = planSteps({ paths: null }).filter((step) => step.command === 'cargo');
    expect(cargo.length).toBeGreaterThanOrEqual(6);
    for (const step of cargo) expect(step.args, step.name).toContain('--locked');
  });

  it('keeps the legs apart', () => {
    expect(names({ paths: ['sidecar/gwb-sidecar/src/main.rs'], leg: 'sidecar' })).toEqual(['Sidecar licences and sources', 'Sidecar clippy', 'Sidecar tests', 'Sidecar sfm clippy', 'Sidecar sfm tests']);
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

  it('runs the crates that take crates/test-support by #[path] when only it changes (#308)', () => {
    const ws = ['gw-codec', 'gw-fuzz', 'gw-parse', 'gw-raster'].map((name) => ({ name, dir: `crates/${name}`, deps: [] }));
    expect(affectedCrates(ws, ['crates/test-support/research.rs'])).toEqual(['gw-codec', 'gw-fuzz', 'gw-parse']);
    const rustArgs = planSteps({ paths: ['crates/test-support/research.rs'], crates: affectedCrates(ws, ['crates/test-support/research.rs']) }).find((s) => s.name === 'Rust tests')?.args;
    expect(rustArgs).toEqual(['test', '--locked', '--no-fail-fast', '-p', 'gw-codec', '-p', 'gw-fuzz', '-p', 'gw-parse']);
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

describe('tests skipped for missing data', () => {
  const t = (status, description) => ({ status, annotations: description ? [{ type: 'skip', description }] : [] });
  const report = { suites: [{ specs: [{ tests: [t('expected'), t('skipped', 'sample missing')] }], suites: [{ specs: [{ tests: [t('skipped', 'sample missing'), t('skipped', 'needs data that only the release gate has'), t('skipped', 'a measurement: GW_SIGNOFF=dry')] }] }] }] };
  it('counts them by reason, nested suites included, leaving out opt-in measurements', () => {
    expect(dataSkips(report)).toEqual({ count: 3, reasons: { 'sample missing': 2, 'needs data that only the release gate has': 1 } });
    expect(dataSkips({})).toEqual({ count: 0, reasons: {} });
  });
});
