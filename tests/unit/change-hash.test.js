// The change hash binds a verdict and an approval to what the PR changes, not to the files it
// touches (decision 0008). These tests build real repositories, because the property is about git.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeSet, hashChanges, splitPatch } from '../../.pipeline/lib/git.mjs';
import { buildVerdict } from '../../.pipeline/lib/ledger.mjs';

let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
const write = (path, content) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const commit = (message) => {
  git('add', '-A');
  git('commit', '-q', '-m', message);
};
const hash = () => changeSet('main', 'pr', dir).hash;
const lines = (...rows) => `${rows.join('\n')}\n`;
const BASE = lines('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gwb-hash-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  write('f.txt', BASE);
  write('other.txt', 'x\n');
  write('bin.dat', Buffer.from([0, 1, 2, 3, 0, 255]));
  commit('base');
  git('switch', '-q', '-c', 'pr');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Make a commit on main, then come back to the PR branch.
const onMain = (fn) => {
  git('switch', '-q', 'main');
  fn();
  git('switch', '-q', 'pr');
};

describe('change hash binds to the PR diff', () => {
  it('keeps the hash when main changes the same file elsewhere and the PR is rebased', () => {
    write('f.txt', BASE.replace('three', 'THREE'));
    commit('pr');
    const before = hash();
    onMain(() => {
      write('f.txt', BASE.replace('nine', 'NINE'));
      commit('main edits the same file');
    });
    expect(hash()).toBe(before); // the merge base is still the old one
    git('rebase', '-q', 'main');
    expect(git('show', 'main:f.txt')).toContain('NINE');
    expect(hash()).toBe(before);
  });

  it('keeps the hash when an append conflict is resolved by keeping both sides', () => {
    write('f.txt', `${BASE}pr line\n`);
    commit('pr appends');
    const before = hash();
    onMain(() => {
      write('f.txt', `${BASE}main line\n`);
      commit('main appends');
    });
    expect(() => git('rebase', 'main')).toThrow(); // a real conflict
    write('f.txt', `${BASE}main line\npr line\n`);
    git('add', 'f.txt');
    git('rebase', '--continue');
    expect(hash()).toBe(before);
  });

  it.each([
    ['editing a PR line', (s) => s.replace('THREE', 'THREE!')],
    ['adding a line', (s) => `${s}eleven\n`],
    ['removing a line', (s) => s.replace('THREE\n', '')],
  ])('changes the hash on %s', (_name, edit) => {
    write('f.txt', BASE.replace('three', 'THREE'));
    commit('pr');
    const before = hash();
    write('f.txt', edit(BASE.replace('three', 'THREE')));
    commit('amend');
    expect(hash()).not.toBe(before);
  });

  it('changes the hash on a whitespace-only edit', () => {
    write('f.txt', BASE.replace('three', 'THREE'));
    commit('pr');
    const before = hash();
    write('f.txt', BASE.replace('three', 'THREE '));
    commit('trailing space');
    const trailing = hash();
    write('f.txt', BASE.replace('three', 'THREE\t'));
    commit('tab instead');
    write('f.txt', BASE.replace('three', 'THREE').replaceAll('\n', '\r\n'));
    commit('CRLF');
    expect(new Set([before, trailing, hash()]).size).toBe(3);
  });

  it('changes the hash when the PR changes a mode or a path, or adds a file', () => {
    write('f.txt', BASE.replace('three', 'THREE'));
    commit('pr');
    const before = hash();
    git('update-index', '--chmod=+x', 'f.txt');
    git('commit', '-q', '-m', 'mode');
    const mode = hash();
    write('new.txt', 'new\n');
    commit('add');
    expect(new Set([before, mode, hash()]).size).toBe(3);
  });

  it('uses blob IDs for a binary file', () => {
    write('bin.dat', Buffer.from([0, 1, 2, 3, 0, 254]));
    commit('pr changes the binary');
    const before = hash();
    const { changes } = changeSet('main', 'pr', dir);
    expect(changes.map((c) => c.path)).toEqual(['bin.dat']);
    onMain(() => {
      write('other.txt', 'y\n');
      commit('main edits another file');
    });
    git('rebase', '-q', 'main');
    expect(hash()).toBe(before);
    write('bin.dat', Buffer.from([0, 1, 2, 3, 0, 253]));
    commit('one byte differs');
    expect(hash()).not.toBe(before);
  });

  it('is the same whatever order the changes come in', () => {
    write('f.txt', BASE.replace('three', 'THREE'));
    write('other.txt', 'z\n');
    write('a/b.txt', 'b\n');
    commit('pr');
    const { changes } = changeSet('main', 'pr', dir);
    expect(changes.length).toBe(3);
    const patches = new Map(changes.map((c) => [c.path, ['+x']]));
    expect(hashChanges([...changes].reverse(), patches)).toBe(hashChanges(changes, patches));
  });

  it('shows a move as a delete plus an add', () => {
    git('mv', 'other.txt', 'moved.txt');
    commit('move');
    const { changes } = changeSet('main', 'pr', dir);
    expect(changes.map((c) => `${c.status}:${c.path}`).sort()).toEqual(['A:moved.txt', 'D:other.txt']);
    const moved = hash();
    git('mv', 'moved.txt', 'elsewhere.txt');
    commit('move again');
    expect(hash()).not.toBe(moved);
  });

  it('hashes a file that becomes a symlink, where git prints two sections for one path', () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'f.txt', encoding: 'utf8' }).trim();
    git('update-index', '--cacheinfo', `120000,${blob},other.txt`);
    git('commit', '-q', '-m', 'type change');
    const { changes } = changeSet('main', 'pr', dir);
    expect(changes.map((c) => `${c.status}:${c.path}`)).toEqual(['T:other.txt']);
    const before = hash();
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    const other = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'g.txt', encoding: 'utf8' }).trim();
    git('update-index', '--cacheinfo', `120000,${other},other.txt`);
    git('commit', '-q', '-m', 'different target');
    expect(hash()).not.toBe(before);
  });
});

describe('patch parsing', () => {
  it('takes only hunk lines, keeps "No newline" markers, and reads a binary as null', () => {
    const text = [
      'diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -1 +1 @@', '--- not a header', '+++ not a header', '\\ No newline at end of file',
      'diff --git a/b b/b', 'index 1..2 100644', 'Binary files a/b and b/b differ',
      'diff --git a/g b/g', 'new file mode 100644', '--- /dev/null', '+++ b/g', '@@ -0,0 +1 @@', '+x', '',
    ].join('\n');
    expect(splitPatch(text)).toEqual([['--- not a header', '+++ not a header', '\\ No newline at end of file'], null, ['+x']]);
  });
});

describe('an old hash', () => {
  it('fails a verdict as different content instead of crashing', () => {
    const ledger = { rounds: [{ hash: 'a'.repeat(64), complete: true, findings: [] }], findings: [] };
    expect(() => buildVerdict({ ledger, tier: 1, hash: 'b'.repeat(64) })).toThrow(/different content/);
  });
});
