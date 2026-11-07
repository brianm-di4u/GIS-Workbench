#!/usr/bin/env node
// Civilian use only (docs/POLICY.md): the functions removed in 2.6.0 must not come back. This
// fails if tracked text names one of them, or a dependency adds one.
//
// The list is hashed so the repository doesn't republish it. That hides it from a reader, and
// doesn't keep it secret: anyone can hash a guess. The plain list is in the private repo.
//
//   node build/check-policy.mjs                 check the tree
//   node build/check-policy.mjs --hash "term"   print the hash of a term to add
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SALT = 'gis-workbench-policy-v1';
const MAX_WORDS = 4;
const LIST = 'build/check-policy.terms.json';
// Test data isn't prose, and these paths hold bytes and third-party text the project doesn't write.
const SKIP = /^(fixtures|fixtures-perf|crates\/vendor|build\/natural-earth)\//;
const TEXT = /\.(js|mjs|cjs|ts|json|md|txt|rs|toml|html|css|py|cpp|h|cs|yml|yaml|sh|ps1)$/;

export const words = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
export const hashTerm = (term) => createHash('sha256').update(`${SALT}:${words(term).join(' ')}`).digest('hex');

/** The hashes in `banned` found in `text`, as a run of up to MAX_WORDS words. */
export function findTerms(text, banned, seen = new Map()) {
  const found = new Set();
  const tokens = words(text);
  for (let i = 0; i < tokens.length; i += 1) {
    let run = '';
    for (let n = 0; n < MAX_WORDS && i + n < tokens.length; n += 1) {
      run = n === 0 ? tokens[i] : `${run} ${tokens[i + n]}`;
      let hash = seen.get(run);
      if (hash === undefined) {
        hash = createHash('sha256').update(`${SALT}:${run}`).digest('hex');
        seen.set(run, hash);
      }
      if (banned.has(hash)) found.add(hash);
    }
  }
  return found;
}

function main() {
  const argument = process.argv.indexOf('--hash');
  if (argument !== -1) {
    console.log(hashTerm(process.argv[argument + 1] ?? ''));
    return 0;
  }
  const { terms, allow = [] } = JSON.parse(readFileSync(LIST, 'utf8'));
  const banned = new Set(terms);
  const allowed = new Set(allow.map(({ path, term }) => `${path}:${term}`));
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n')
    .filter((path) => path && TEXT.test(path) && !SKIP.test(path) && path !== LIST);

  const seen = new Map();
  const problems = [];
  for (const path of files) {
    for (const hash of findTerms(readFileSync(path, 'utf8'), banned, seen)) {
      if (!allowed.has(`${path}:${hash}`)) problems.push(`${path}: ${hash.slice(0, 12)}`);
    }
  }
  if (problems.length > 0) {
    console.error('These files name something docs/POLICY.md rules out. Check the term against the private list:');
    for (const problem of problems) console.error(`  ${problem}`);
    return 1;
  }
  console.log(`Civilian-use check: ${files.length} files clean.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
