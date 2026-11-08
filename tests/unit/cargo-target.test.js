import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cargoTargetDir, scopeCargoTarget } from '../../build/cargo-target.mjs';

// #42: a machine-wide CARGO_TARGET_DIR let one worktree's build overwrite another's WASM and
// let tests reuse binaries from deleted worktrees.
const SHARED = resolve(tmpdir(), 'gwb-shared-target-should-not-be-used');

describe('cargo target scoping', () => {
  it('ignores a machine-wide CARGO_TARGET_DIR by default', () => {
    expect(cargoTargetDir({ CARGO_TARGET_DIR: SHARED })).toBeNull();
    expect(scopeCargoTarget({ CARGO_TARGET_DIR: SHARED, PATH: 'p' })).toEqual({ PATH: 'p' });
  });

  it('shares a directory only on explicit opt-in', () => {
    const env = scopeCargoTarget({ CARGO_TARGET_DIR: '/elsewhere', GWB_CARGO_TARGET: SHARED });
    expect(env.CARGO_TARGET_DIR).toBe(SHARED);
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
