// Generated files are left out of the change hash (issue 174). The list comes from the base's
// pipeline.config.json, so a change can't exempt its own files.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../../.pipeline/lib/config.mjs';
import { changeSet, excludeSpecs } from '../../.pipeline/lib/git.mjs';

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
const CONFIG = JSON.stringify({ generatedPaths: ['gen/*.json'] });
const BASE = 'one\ntwo\nthree\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gwb-gen-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  write('f.txt', BASE);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// The base lists the generated files (or something else), then a PR branch starts from it.
const start = (config = CONFIG) => {
  if (config !== null) write('pipeline.config.json', config);
  commit('base');
  git('switch', '-q', '-c', 'pr');
};

describe('generated files', () => {
  it('are left out of the hash, but still listed as changed', () => {
    start();
    write('f.txt', BASE.replace('two', 'TWO'));
    commit('pr');
    const before = hash();
    write('gen/en.json', '{"a":1}\n');
    commit('regenerate');
    const after = changeSet('main', 'pr', dir);
    expect(after.hash).toBe(before);
    expect(after.changes.map((c) => c.path).sort()).toEqual(['f.txt', 'gen/en.json']);
    expect(after.generated).toEqual(['gen/en.json']);
    expect(after.generatedGlobs).toEqual(['gen/*.json']);
  });

  it('do not loosen any other file', () => {
    start();
    write('f.txt', BASE.replace('two', 'TWO'));
    commit('pr');
    const before = hash();
    write('f.txt', BASE.replace('two', 'TWO!'));
    commit('edit');
    expect(hash()).not.toBe(before);
  });

  it('are read from the base, so a change cannot exempt its own files', () => {
    start(null);
    write('pipeline.config.json', CONFIG);
    write('gen/en.json', '{"a":1}\n');
    commit('pr adds the list and the file');
    expect(changeSet('main', 'pr', dir).generated).toEqual([]);
    const before = hash();
    write('gen/en.json', '{"a":2}\n');
    commit('edit');
    expect(hash()).not.toBe(before);
  });

  it('exempt only a path as the glob names it, not a differently cased twin that a floor would fold', () => {
    start();
    write('f.txt', BASE.replace('two', 'TWO'));
    commit('pr');
    write('gen/EN.json', '{"a":1}\n');
    commit('twin');
    const set = changeSet('main', 'pr', dir);
    expect(set.generated).toEqual([]);
    expect(set.hash).not.toBe(changeSet('main', 'pr~1', dir).hash);
  });

  it('exempt nothing when the list is malformed', () => {
    start('{ not json');
    write('gen/en.json', '{"a":1}\n');
    commit('pr');
    expect(changeSet('main', 'pr', dir).generated).toEqual([]);
  });

  it('exempt nothing when the list holds something that is not a glob', () => {
    start(JSON.stringify({ generatedPaths: ['gen/*.json', 3] }));
    write('gen/en.json', '{"a":1}\n');
    commit('pr');
    expect(changeSet('main', 'pr', dir).generated).toEqual([]);
  });
});

describe('this repository\'s list', () => {
  it('is the English catalogue, which verify checks against the source, and loads without a warning', () => {
    const warnings = [];
    const config = loadConfig('pipeline.config.json', { warn: (message) => warnings.push(message) });
    expect(warnings).toEqual([]);
    expect(config.generatedPaths).toEqual(['app/src/i18n/catalog/en.json']);
    expect(config.council.maxMechanicalLines).toBe(40);
  });

  it('drops a list that is not globs, with a warning', () => {
    const warnings = [];
    const config = parseConfig(JSON.stringify({ admins: ['a'], tiers: {}, merge: {}, verify: {}, generatedPaths: 'en.json' }), { warn: (message) => warnings.push(message) });
    expect(config.generatedPaths).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
});

describe('excludeSpecs', () => {
  it('is empty without globs, and otherwise a pathspec that keeps everything else', () => {
    expect(excludeSpecs([])).toEqual([]);
    expect(excludeSpecs(['gen/*.json'])).toEqual(['--', '.', ':(exclude,glob)gen/*.json']);
  });

  it('leaves the file out of a real diff', () => {
    start();
    write('f.txt', BASE.replace('two', 'TWO'));
    write('gen/en.json', '{"a":1}\n');
    commit('pr');
    const names = git('diff', '-M', '--name-only', 'main', 'pr', ...excludeSpecs(['gen/*.json'])).trim().split('\n');
    expect(names).toEqual(['f.txt']);
  });
});
