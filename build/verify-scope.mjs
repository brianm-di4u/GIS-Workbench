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
import { pathToFileURL } from 'node:url';
import { scopeCargoTarget } from './cargo-target.mjs';

const RUST_EVERYTHING = /^crates\/(Cargo\.toml|Cargo\.lock|deny\.toml|rust-toolchain\.toml|\.cargo\/|vendor\/)/;
const SCOPE_EVERYTHING = /^(\.github\/workflows\/|build\/verify-scope\.mjs$|\.node-version$)/;
const SIDECAR_EVERYTHING = /^sidecar\/(Cargo\.toml|Cargo\.lock|deny\.toml|rust-toolchain\.toml)/;

// CHANGELOG.md is the exception: the build embeds it.
const isProse = (path) => path.endsWith('.md') && path !== 'CHANGELOG.md';

/** The workspace crates a change affects: those it touched, and everything depending on them. */
export function affectedCrates(packages, paths) {
  const touched = new Set(
    packages.filter((p) => paths.some((path) => path.startsWith(`${p.dir}/`))).map((p) => p.name),
  );
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

/**
 * What to run. `paths` is null when the change set is unknown or this is main: then everything.
 * `crates` is the crate list from affectedCrates, or null to test the whole workspace.
 */
export function planSteps({ paths, leg = 'all', crates = null }) {
  const everything = paths === null || paths.some((path) => SCOPE_EVERYTHING.test(path));
  const code = everything || paths.some((path) => !isProse(path));
  const rust = everything || paths.some((path) => path.startsWith('crates/') && !isProse(path));
  const rustAll = everything || crates === null || paths.some((path) => RUST_EVERYTHING.test(path));
  // The checker's own changes count too, so a stricter rule is tried on the fragments already there.
  const fragments = everything || paths.some((path) => path.startsWith('changes/') || path === 'build/release/changelog.mjs');
  const sidecar = everything || paths.some((path) => path.startsWith('sidecar/') && !isProse(path));

  const steps = [];
  const step = (name, command, args, cwd, after) => steps.push({ name, command, args, ...(cwd ? { cwd } : {}), ...(after ? { after } : {}) });
  const cargoDeny = ['deny', '--locked', '--all-features', 'check', 'licenses', 'bans', 'sources'];
  // Bug-class lints only: correctness and suspicious. Style lints stay off.
  const clippy = (targets) => ['clippy', '--locked', '--all-targets', '--keep-going', ...targets, '--', '-A', 'clippy::all', '-D', 'clippy::correctness', '-D', 'clippy::suspicious'];

  if (leg !== 'sidecar') {
    step('Quarantine list', 'node', ['build/check-quarantine.mjs']);
    step('Civilian-use check', 'node', ['build/check-policy.mjs']);
    step('D: drive paths', 'node', ['build/check-d-drive.mjs']);
    if (fragments) step('Changelog fragments', 'node', ['build/release/changelog.mjs', 'check']);
    if (rust) {
      step('Crate licences and sources', 'cargo', cargoDeny, 'crates');
      const targets = rustAll ? ['--workspace'] : crates.flatMap((name) => ['-p', name]);
      if (targets.length > 0) {
        step('Clippy', 'cargo', clippy(targets), 'crates');
        step('Rust tests', 'cargo', ['test', '--locked', '--no-fail-fast', ...targets], 'crates');
      }
    }
    if (code) {
      step('Source catalogue', 'node', ['build/i18n.mjs', 'extract', '--check']);
      step('Strict build', 'node', ['build/build.mjs', '--strict']);
      step('Size report', 'node', ['build/size-report.mjs'], undefined, 'Strict build');
      step('Unit and golden tests', 'npx', ['vitest', 'run']);
      step('Browser subset', 'npx', ['playwright', 'test', '--project=ci']);
    }
  }
  if (leg !== 'linux' && sidecar) {
    step('Sidecar licences and sources', 'cargo', cargoDeny, 'sidecar');
    // The default members, as `cargo test` there: the no_std stubs can't build as test targets.
    step('Sidecar clippy', 'cargo', clippy([]), 'sidecar');
    step('Sidecar tests', 'cargo', ['test', '--locked', '--no-fail-fast'], 'sidecar');
  }
  return steps;
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd, shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

function changedPaths() {
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

function main() {
  scopeCargoTarget(); // this checkout's target, not a machine-wide one shared with other worktrees (#42)
  const paths = changedPaths();
  const packages = paths?.some((path) => path.startsWith('crates/')) ? workspaceCrates() : null;
  const crates = packages ? affectedCrates(packages, paths) : null;
  const steps = planSteps({ paths, leg: process.env.GWB_LEG ?? 'all', crates });

  console.log(paths === null ? 'Scope: everything.' : `Scope: ${paths.length} changed paths.`);
  for (const { name } of steps) console.log(`  ${name}`);
  if (steps.length === 0) console.log('  Nothing to run on this leg.');
  if (process.argv.includes('--dry')) return 0;

  // Every step runs even after a failure: a CI run is too slow to find problems one at a time.
  const failed = [];
  const env = { ...process.env, GWB_PARTIAL_DATA: '1' };
  for (const { name, command, args, cwd, after } of steps) {
    // A step that reads another's output says so, and skips when that step failed, rather than
    // reporting on a stale or half-written file.
    if (after && failed.includes(after)) {
      console.log(`\n=== ${name}: skipped, because ${after} failed`);
      continue;
    }
    console.log(`\n=== ${name}`);
    const started = Date.now();
    const { status } = spawnSync(command, args, { stdio: 'inherit', cwd, env, shell: process.platform === 'win32' });
    console.log(`=== ${name}: ${status === 0 ? 'ok' : 'FAILED'} in ${Math.round((Date.now() - started) / 1000)} s`);
    if (status !== 0) failed.push(name);
  }
  if (failed.length > 0) console.error(`\nFailed: ${failed.join(', ')}`);
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
