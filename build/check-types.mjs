#!/usr/bin/env node
// Type checking for app/src as a ratchet (decision 0027). The app is JavaScript with no types, and
// a loose TypeScript check of it reports well over a thousand errors, nearly all from missing type
// information. This holds the line where it is: build/typecheck-baseline.json records how many
// errors each module has, a module may not have more than its number, and a module not listed,
// which includes every new one, must have none. A number may only go down. A module git sees as
// renamed since the branch left main keeps its number under its new path, and --lower writes it there.
//
//   node build/check-types.mjs               check
//   node build/check-types.mjs --lower       check, then write the numbers that went down
//   node build/check-types.mjs --regenerate  rewrite every number: for a TypeScript upgrade only
//
// The baseline may not raise a number that main has, unless the same change moves the pinned
// TypeScript version, because a newer checker counts differently.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BASELINE = 'build/typecheck-baseline.json';
const CONFIG = 'build/typecheck.tsconfig.json';
const ERROR = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/** tsc's plain output as errors. A line that reports an error outside any file (a bad config) comes back with file null. */
export function parseErrors(output) {
  const errors = [];
  for (const line of output.split(/\r?\n/)) {
    const m = ERROR.exec(line);
    if (m) errors.push({ file: m[1].replaceAll('\\', '/'), line: Number(m[2]), code: m[4], message: m[5] });
    else if (/^error TS\d+:/.test(line)) errors.push({ file: null, line: 0, code: line.slice(6, line.indexOf(':')), message: line });
  }
  return errors;
}

/** Errors per file. */
export function countByFile(errors) {
  const counts = {};
  for (const e of errors) if (e.file !== null) counts[e.file] = (counts[e.file] ?? 0) + 1;
  return counts;
}

/** Files with more errors than the baseline allows, and files whose number can come down. */
export function compare(counts, baseline) {
  const files = [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort();
  return {
    over: files.filter((f) => (counts[f] ?? 0) > (baseline[f] ?? 0)).map((f) => ({ file: f, allowed: baseline[f] ?? 0, found: counts[f] })),
    under: files.filter((f) => (counts[f] ?? 0) < (baseline[f] ?? 0)).map((f) => ({ file: f, allowed: baseline[f], found: counts[f] ?? 0 })),
  };
}

/**
 * The baseline with each renamed module's number moved to its new path. A number follows its code:
 * `renames` is [from, to] pairs from git's rename detection. A path that already has a number keeps
 * its own, and a module split into new files carries nothing.
 */
export function carry(baseline, renames) {
  const out = { ...baseline };
  for (const [from, to] of renames) {
    if (out[from] === undefined || out[to] !== undefined) continue;
    out[to] = out[from];
    delete out[from];
  }
  return out;
}

/** git's `diff --name-status -z` output as [from, to] rename pairs. */
export function parseRenames(output) {
  const parts = output.split('\0');
  const pairs = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (/^R\d*$/.test(status)) {
      pairs.push([parts[i + 1].replaceAll('\\', '/'), parts[i + 2].replaceAll('\\', '/')]);
      i += 3;
    } else i += /^C\d*$/.test(status) ? 3 : 2;
  }
  return pairs;
}

/** Files whose number in `baseline` is higher than in the baseline it started from. */
export function raised(baseline, before) {
  return Object.keys(baseline).filter((f) => baseline[f] > (before[f] ?? 0)).sort();
}

/** The baseline with each number lowered to what was found, and files with no errors left out. Never raises one. */
export function lowered(counts, baseline) {
  const out = {};
  for (const f of Object.keys(baseline).sort()) {
    const n = Math.min(baseline[f], counts[f] ?? 0);
    if (n > 0) out[f] = n;
  }
  return out;
}

const sorted = (counts) => Object.fromEntries(Object.keys(counts).sort().filter((f) => counts[f] > 0).map((f) => [f, counts[f]]));
const write = (counts) => writeFileSync(BASELINE, `${JSON.stringify(sorted(counts), null, 2)}\n`);
const git = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

/**
 * What this branch started from on main: the baseline (null before one existed), the pinned
 * TypeScript version, and the app modules renamed since. `{ onMain: true }` on main itself, and
 * null where git can't say.
 */
function atMergeBase() {
  const base = git(['merge-base', `origin/${process.env.GITHUB_BASE_REF || 'main'}`, 'HEAD'])?.trim();
  if (!base) return null;
  if (base === git(['rev-parse', 'HEAD'])?.trim()) return { onMain: true };
  const pkg = git(['show', `${base}:package.json`]);
  const names = git(['diff', '-M', '--name-status', '-z', base, 'HEAD', '--', 'app/src']);
  if (pkg === null || names === null) return null;
  const baseline = git(['show', `${base}:${BASELINE}`]);
  return { baseline: baseline === null ? null : JSON.parse(baseline), typescript: JSON.parse(pkg).devDependencies?.typescript ?? null, renames: parseRenames(names) };
}

function main(args) {
  const run = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', CONFIG, '--pretty', 'false'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.error || run.status === null) {
    console.error(`check-types: could not run TypeScript. Run: npm ci --ignore-scripts\n${run.error?.message ?? ''}`);
    return 1;
  }
  const errors = parseErrors(`${run.stdout}\n${run.stderr}`);
  const broken = errors.filter((e) => e.file === null);
  if (broken.length > 0 || (run.status !== 0 && errors.length === 0)) {
    console.error(`check-types: TypeScript did not check the code.\n${broken.map((e) => e.message).join('\n') || run.stdout || run.stderr}`);
    return 1;
  }
  const counts = countByFile(errors);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (args.includes('--regenerate')) {
    write(counts);
    console.log(`check-types: wrote ${BASELINE}: ${total} errors in ${Object.keys(counts).length} files.`);
    return 0;
  }

  let failed = false;
  const before = atMergeBase();
  const renames = before?.renames ?? [];
  // A renamed module's number moves with it, here and in main's baseline alike.
  const recorded = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const baseline = carry(recorded, renames);
  const moved = Object.keys(recorded).filter((f) => baseline[f] === undefined);

  const pinned = JSON.parse(readFileSync('package.json', 'utf8')).devDependencies?.typescript ?? null;
  if (before === null) {
    console.log("check-types: could not read this branch's start on main, so the rule that the baseline may not raise main's numbers was not checked here.");
  } else if (before.baseline && before.typescript === pinned) {
    const main = carry(before.baseline, renames);
    const up = raised(baseline, main);
    if (up.length > 0) {
      failed = true;
      console.error(`check-types: ${BASELINE} raises a number main has. A number may only go down (decision 0027): fix the new errors instead.`);
      for (const f of up) console.error(`  ${f}: ${main[f] ?? 0} on main, ${baseline[f]} here`);
    }
  }

  const { over, under } = compare(counts, baseline);
  if (over.length > 0) {
    failed = true;
    console.error('check-types: new type errors. Fix them: declare a property or a shape with a JSDoc @type or @typedef, and correct a misspelt name or a wrong argument count.');
    for (const { file, allowed, found } of over) {
      console.error(`\n  ${file}: ${found} errors, ${allowed} allowed${allowed > 0 ? ' (the new ones are among these)' : ''}`);
      for (const e of errors.filter((x) => x.file === file)) console.error(`    line ${e.line}: ${e.code} ${e.message}`);
    }
  }
  if (under.length > 0 || moved.length > 0) {
    if (args.includes('--lower')) {
      write(lowered(counts, baseline));
      console.log(`check-types: lowered ${under.length} numbers and moved ${moved.length} renamed modules in ${BASELINE}.`);
    } else {
      failed = true;
      console.error(`check-types: ${BASELINE} is out of date. Update it with: node build/check-types.mjs --lower`);
      for (const { file, allowed, found } of under) console.error(`  ${file}: ${allowed} recorded, ${found} found`);
      for (const file of moved) console.error(`  ${file}: renamed, its number goes under the new path`);
    }
  }
  if (!failed) console.log(`check-types: ok. ${total} recorded errors in ${Object.keys(counts).length} files, none new.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
