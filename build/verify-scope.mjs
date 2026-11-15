#!/usr/bin/env node
// What `verify full` runs for this change. A branch tests only what it touched, because the
// council needs fresh `full` evidence after every fix and all the Rust tests take 20 minutes.
// Main, GWB_SCOPE=all, and anything this script can't work out run everything, so a scoping
// mistake costs time and never coverage. post-merge.yml runs everything on main regardless.
//
//   node build/verify-scope.mjs            run the steps
//   node build/verify-scope.mjs --dry      print them
//
// GWB_LEG picks a CI leg: `linux` for the app, `sidecar` for the native code on Windows. With
// neither set, a local run does both.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scopeCargoTarget } from './cargo-target.mjs';

const RUST_EVERYTHING = /^crates\/(Cargo\.toml|Cargo\.lock|deny\.toml|rust-toolchain\.toml|\.cargo\/|vendor\/)/;
const SCOPE_EVERYTHING = /^(\.github\/workflows\/|build\/verify-scope\.mjs$|\.node-version$)/;
const SIDECAR_EVERYTHING = /^sidecar\/(Cargo\.toml|Cargo\.lock|deny\.toml|rust-toolchain\.toml)/;

// CHANGELOG.md is the exception: the build embeds it.
const isProse = (path) => path.endsWith('.md') && path !== 'CHANGELOG.md';

// Source in crates/ that belongs to no package but is compiled into some by #[path], and those crates
// (#299, #308): a change to it alone must still run them.
const SHARED_SOURCES = { 'crates/test-support/': ['gw-codec', 'gw-fuzz', 'gw-parse'] };

/** The workspace crates a change affects: those it touched, and everything depending on them. */
export function affectedCrates(packages, paths) {
  const touched = new Set([
    ...packages.filter((p) => paths.some((path) => path.startsWith(`${p.dir}/`))).map((p) => p.name),
    ...Object.entries(SHARED_SOURCES).filter(([dir]) => paths.some((path) => path.startsWith(dir))).flatMap(([, users]) => users),
  ]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of packages) {
      if (!touched.has(p.name) && p.deps.some((dep) => touched.has(dep))) {
        touched.add(p.name);
        grew = true;
      }
    }
  }
  return [...touched].sort();
}

// Fixtures that tests in both Rust workspaces read, and the crates in crates/ whose tests read them
// (decision 0020). A change to one runs those crates and the sidecar.
const SHARED_FIXTURES = { 'tests/fixtures/ba-cross-check/': ['gw-aero'] };
export const fixtureCrates = (paths) => [...new Set((paths ?? []).flatMap((path) => Object.entries(SHARED_FIXTURES).filter(([dir]) => path.startsWith(dir)).flatMap(([, owners]) => owners)))];

/**
 * What to run. `paths` is null when the change set is unknown or this is main: then everything.
 * `crates` is the crate list from affectedCrates, or null to test the whole workspace.
 */
export function planSteps({ paths, leg = 'all', crates = null }) {
  const everything = paths === null || paths.some((path) => SCOPE_EVERYTHING.test(path));
  const code = everything || paths.some((path) => !isProse(path));
  const owners = fixtureCrates(paths);
  const shared = owners.length > 0;
  const rust = everything || shared || paths.some((path) => path.startsWith('crates/') && !isProse(path));
  const rustAll = everything || crates === null || paths.some((path) => RUST_EVERYTHING.test(path));
  // The checker's own changes count too, so a stricter rule is tried on the fragments already there.
  const fragments = everything || paths.some((path) => path.startsWith('changes/') || path === 'build/release/changelog.mjs');
  const sidecar = everything || shared || paths.some((path) => path.startsWith('sidecar/') && !isProse(path));
  // A locale catalogue, or what checking one reads, changed (en.json is the source, checked by
  // extract): every catalogue must pass checkMessage, or the build quietly shows English (#266).
  // The catalogues the branch changed must also hold no stale key (#292).
  const catalogues = everything || paths.some((path) => /^app\/src\/i18n\/(catalog\/(?!en\.json$)|state\/|glossary\/|locales\.json$)/.test(path) || path === 'build/i18n.mjs');
  // Only a locale tag's shape reaches the command line, which is a shell on Windows.
  const changedTags = everything ? [] : [...new Set(paths.map((path) => /^app\/src\/i18n\/(?:catalog|state)\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.json$/.exec(path)?.[1]).filter((tag) => tag && tag !== 'en'))].sort();

  const steps = [];
  const step = (name, command, args, cwd) => steps.push({ name, command, args, ...(cwd ? { cwd } : {}) });
  const cargoDeny = ['deny', '--locked', '--all-features', 'check', 'licenses', 'bans', 'sources'];
  // Bug-class lints only: correctness and suspicious. Style lints stay off.
  const clippy = (targets) => ['clippy', '--locked', '--all-targets', '--keep-going', ...targets, '--', '-A', 'clippy::all', '-D', 'clippy::correctness', '-D', 'clippy::suspicious'];

  if (leg !== 'sidecar') {
    step('Quarantine list', 'node', ['build/check-quarantine.mjs']);
    // A branch scans only what it changed: main scanned the rest (#312). Everything scans everything.
    step('Civilian-use check', 'node', ['build/check-policy.mjs', ...(everything ? [] : ['--changed'])]);
    step('D: drive paths', 'node', ['build/check-d-drive.mjs']);
    if (fragments) step('Changelog fragments', 'node', ['build/release/changelog.mjs', 'check']);
    if (rust) {
      step('Crate licences and sources', 'cargo', cargoDeny, 'crates');
      const targets = rustAll ? ['--workspace'] : [...new Set([...crates, ...owners])].flatMap((name) => ['-p', name]);
      if (targets.length > 0) {
        step('Clippy', 'cargo', clippy(targets), 'crates');
        step('Rust tests', 'cargo', ['test', '--locked', '--no-fail-fast', ...targets], 'crates');
      }
    }
    if (code) {
      step('Source catalogue', 'node', ['build/i18n.mjs', 'extract', '--check']);
      if (catalogues) step('Locale catalogues', 'node', ['build/i18n.mjs', 'check', ...(changedTags.length ? [`--strict=${changedTags.join(',')}`] : [])]);
      step('Strict build', 'node', ['build/build.mjs', '--strict']);
      step('Size report', 'node', ['build/size-report.mjs']);
      step('Unit and golden tests', 'npx', ['vitest', 'run']);
      step('Browser subset', 'npx', ['playwright', 'test', '--project=ci']);
    }
  }
  if (leg !== 'linux' && sidecar) {
    step('Sidecar licences and sources', 'cargo', cargoDeny, 'sidecar');
    // The default members, as `cargo test` there: the no_std stubs can't build as test targets.
    step('Sidecar clippy', 'cargo', clippy([]), 'sidecar');
    step('Sidecar tests', 'cargo', ['test', '--locked', '--no-fail-fast'], 'sidecar');
    // gwb-sfm is not a default member (the sfm module builds it on its own), so name it.
    step('Sidecar sfm clippy', 'cargo', clippy(['-p', 'gwb-sfm']), 'sidecar');
    step('Sidecar sfm tests', 'cargo', ['test', '--locked', '--no-fail-fast', '-p', 'gwb-sfm'], 'sidecar');
  }
  return steps;
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd, shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

/** The paths this branch changed against its base, or null on main, with GWB_SCOPE=all, or when unknown. */
export function changedPaths() {
  if (process.env.GWB_SCOPE === 'all') return null;
  if (process.env.GITHUB_REF === 'refs/heads/main') return null;
  if (capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim() === 'main') return null;
  const base = `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
  const from = capture('git', ['merge-base', base, 'HEAD'])?.trim();
  if (!from) return null;
  const names = capture('git', ['diff', '--name-only', '--no-renames', from, 'HEAD']);
  return names === null ? null : names.split('\n').filter(Boolean);
}

function workspaceCrates() {
  const metadata = capture('cargo', ['metadata', '--no-deps', '--format-version', '1'], 'crates');
  if (metadata === null) return null;
  const { packages, workspace_root: root } = JSON.parse(metadata);
  const prefix = root.replaceAll('\\', '/');
  return packages.map((p) => ({
    name: p.name,
    dir: `crates${p.manifest_path.replaceAll('\\', '/').slice(prefix.length).replace(/\/Cargo\.toml$/, '')}`,
    deps: p.dependencies.map((dep) => dep.name),
  }));
}

/**
 * The browser tests a Playwright JSON report skipped for want of data, by reason. With
 * GWB_PARTIAL_DATA a missing sample or pack skips its test instead of failing it, so a run can pass
 * having tested none of them. Opt-in measurements ("a measurement: …") aren't data skips.
 */
export function dataSkips(report) {
  const reasons = {};
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        if (t.status !== 'skipped') continue;
        const skip = [...(t.annotations ?? []), ...(t.results?.[0]?.annotations ?? [])].find((a) => a.type === 'skip');
        const reason = skip?.description ?? 'no reason given';
        if (/^a measurement:/.test(reason)) continue;
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report?.suites ?? []) walk(suite);
  return { count: Object.values(reasons).reduce((a, b) => a + b, 0), reasons };
}

/** After the browser subset: say how many tests it skipped for missing data, and keep the count. */
function reportDataSkips(since) {
  const file = 'reports/e2e.json';
  if (!existsSync(file) || statSync(file).mtimeMs < since) return;
  const skips = dataSkips(JSON.parse(readFileSync(file, 'utf8')));
  writeFileSync('reports/data-skips.json', `${JSON.stringify(skips, null, 2)}\n`);
  console.log(`=== Browser subset: ${skips.count} tests skipped for missing data`);
  for (const [reason, n] of Object.entries(skips.reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`      ${n} × ${reason}`);
}

function main() {
  scopeCargoTarget(); // this checkout's target, not a machine-wide one shared with other worktrees (#42)
  const paths = changedPaths();
  const packages = paths?.some((path) => path.startsWith('crates/')) ? workspaceCrates() : null;
  // A fixture-only change tests just the crates that read it, not the whole workspace.
  const crates = packages ? affectedCrates(packages, paths) : fixtureCrates(paths).length > 0 ? [] : null;
  const steps = planSteps({ paths, leg: process.env.GWB_LEG ?? 'all', crates });

  console.log(paths === null ? 'Scope: everything.' : `Scope: ${paths.length} changed paths.`);
  for (const { name } of steps) console.log(`  ${name}`);
  if (steps.length === 0) console.log('  Nothing to run on this leg.');
  if (process.argv.includes('--dry')) return 0;

  // Every step runs even after a failure: a CI run is too slow to find problems one at a time.
  const failed = [];
  const env = { ...process.env, GWB_PARTIAL_DATA: '1' };
  for (const { name, command, args, cwd } of steps) {
    console.log(`\n=== ${name}`);
    const started = Date.now();
    const { status } = spawnSync(command, args, { stdio: 'inherit', cwd, env, shell: process.platform === 'win32' });
    console.log(`=== ${name}: ${status === 0 ? 'ok' : 'FAILED'} in ${Math.round((Date.now() - started) / 1000)} s`);
    if (name === 'Browser subset') reportDataSkips(started);
    if (status !== 0) failed.push(name);
  }
  if (failed.length > 0) console.error(`\nFailed: ${failed.join(', ')}`);
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
