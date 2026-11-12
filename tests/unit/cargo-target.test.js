import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { cargoTargetDir, scopeCargoTarget } from '../../build/cargo-target.mjs';

// #42: a machine-wide CARGO_TARGET_DIR let one worktree's build overwrite another's WASM and
// let tests reuse binaries from deleted worktrees.
const SHARED = resolve(tmpdir(), 'gwb-shared-target-should-not-be-used');

describe('cargo target scoping', () => {
  it('ignores a machine-wide CARGO_TARGET_DIR by default', () => {
    expect(cargoTargetDir({ CARGO_TARGET_DIR: SHARED })).toBeNull();
    expect(scopeCargoTarget({ CARGO_TARGET_DIR: SHARED, PATH: 'p' })).toEqual({ PATH: 'p' });
  });

  it('uses the opted-in directory only on explicit opt-in, in a folder of its own', () => {
    const env = scopeCargoTarget({ CARGO_TARGET_DIR: '/elsewhere', GWB_CARGO_TARGET: SHARED });
    expect(resolve(env.CARGO_TARGET_DIR, '..')).toBe(SHARED);
    // By default the folder is named from this checkout's root, the folder that holds package.json.
    const root = resolve(import.meta.dirname, '..', '..');
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    const folder = basename(env.CARGO_TARGET_DIR);
    expect(folder.slice(0, -11)).toBe(basename(root));
    expect(folder.slice(-11)).toMatch(/^-[0-9a-f]{10}$/);
  });

  // #220: two worktrees that both set GWB_CARGO_TARGET shared one target, so one built against the
  // other's version of a crate.
  it('gives two checkouts different folders under GWB_CARGO_TARGET, and one checkout the same each time', () => {
    const env = { GWB_CARGO_TARGET: SHARED };
    const a = cargoTargetDir(env, join(tmpdir(), 'wt', 'gwb-a'));
    const b = cargoTargetDir(env, join(tmpdir(), 'wt', 'gwb-b'));
    const sameName = cargoTargetDir(env, join(tmpdir(), 'other', 'gwb-a'));
    expect(new Set([a, b, sameName]).size).toBe(3);
    for (const dir of [a, b, sameName]) expect(resolve(dir, '..')).toBe(SHARED);
    expect(cargoTargetDir(env, join(tmpdir(), 'wt', 'gwb-a'))).toBe(a);
    expect(basename(a)).toMatch(/^gwb-a-[0-9a-f]{10}$/);
  });

  it('keeps two worktrees on different commits apart, even with the shared variable set', () => {
    const base = mkdtempSync(join(tmpdir(), 'gwb-cargo-target-'));
    try {
      const outputs = ['a', 'b'].map((name) => {
        const tree = join(base, name);
        mkdirSync(join(tree, 'src'), { recursive: true });
        writeFileSync(join(tree, 'Cargo.toml'), '[package]\nname = "probe"\nversion = "0.0.0"\nedition = "2021"\n');
        // The "commit": the two trees differ in their one function.
        writeFileSync(join(tree, 'src', 'lib.rs'), `pub fn which() -> &'static str { "${name}" }\n`);
        // A developer who opted in to sharing must not leak that into this test.
        const { GWB_CARGO_TARGET: _optIn, ...inherited } = process.env;
        const env = scopeCargoTarget({ ...inherited, CARGO_TARGET_DIR: SHARED });
        const opts = { cwd: tree, env, encoding: 'utf8' };
        execFileSync('cargo', ['build', '--offline', '--quiet'], opts);
        const meta = JSON.parse(execFileSync('cargo', ['metadata', '--offline', '--no-deps', '--format-version', '1'], opts));
        return { tree, target: meta.target_directory };
      });
      for (const { tree, target } of outputs) {
        expect(resolve(target)).toBe(resolve(tree, 'target'));
        expect(readdirSync(join(target, 'debug')).some((f) => f.startsWith('libprobe'))).toBe(true);
      }
      expect(outputs[0].target).not.toBe(outputs[1].target);
      expect(existsSync(SHARED)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 120_000);
});
