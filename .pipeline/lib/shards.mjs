// Issue 273 (extends decision 0015): a seat's turn budget stops growing at about 2,950 changed lines, so on a
// larger diff one full round reads only part of the change. A full round of a diff over SHARD_MAX lines
// gives each seat one run per shard instead: whole files where they fit, and a file too big for one
// shard split between its hunks, never inside one. The planning is pure; the git reads around it are thin.
import { excludeSpecs, tryGit } from './git.mjs';

// A shard has at most this many changed lines, unless one hunk alone is bigger: a hunk is never split.
export const SHARD_MAX = 800;
// At most this many shards, so a round's runs stay bounded (seats × shards). A diff that would need
// more gets bigger shards instead, about diff lines / SHARD_CAP each.
export const SHARD_CAP = 8;
// The paths a shard names go on the seat's git command line: keep them well inside Windows' 32k limit.
export const SHARD_CHARS = 16000;

/** `git diff --numstat -z` → [{ path, lines }]. A binary file counts 0 lines but keeps its place. */
export function parseNumstatZ(text) {
  const fields = text.split('\0');
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i];
    if (!head) continue;
    // A file name may hold a tab: the path is everything after the second one.
    const t1 = head.indexOf('\t');
    const t2 = head.indexOf('\t', t1 + 1);
    const [added, deleted, path] = [head.slice(0, t1), head.slice(t1 + 1, t2), head.slice(t2 + 1)];
    const lines = added === '-' || deleted === '-' ? 0 : Number(added) + Number(deleted);
    // A rename or copy has an empty path here, then its old and new paths as the next two fields.
    if (path !== '') {
      files.push({ path, lines });
    } else {
      files.push({ path: fields[i + 2], old: fields[i + 1], lines });
      i += 2;
    }
  }
  return files;
}

/** `git diff -U0` of one file → its hunks as new-file line ranges, with the lines each changes. */
export function parseHunks(patch) {
  const hunks = [];
  for (const m of patch.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const removed = m[1] === undefined ? 1 : Number(m[1]);
    const start = Number(m[2]);
    const added = m[3] === undefined ? 1 : Number(m[3]);
    // A hunk that only removes lines sits after new line `start`: name that line.
    hunks.push({ from: Math.max(1, start), to: Math.max(1, start + Math.max(added, 1) - 1), lines: removed + added });
  }
  return hunks;
}

/**
 * Whether the parsed files can be shard paths: every name git lists is planned, and no path holds a
 * control character other than tab (paths go into a seat's brief) or a byte that isn't UTF-8. If not, the round runs unsharded.
 */
export function shardable(files, names) {
  const planned = new Set(files.map((f) => f.path));
  // eslint-disable-next-line no-control-regex
  const control = /[\x00-\x08\x0a-\x1f\x7f]/;
  // U+FFFD too: a name that isn't valid UTF-8 reads back as it, and no pathspec would match it.
  const replaced = String.fromCharCode(0xfffd);
  const odd = (p) => control.test(p) || p.includes(replaced);
  return names.every((name) => planned.has(name)) && files.every((f) => !odd(f.path) && !odd(f.old ?? ''));
}

const chars = (part) => part.path.length + (part.old ? part.old.length + 16 : 0) + 16;

/**
 * Pack the changed files into shards of at most `max` lines and `maxChars` of paths, in diff order. A
 * file over `max` is split into runs of whole hunks (a single hunk over `max` stays whole). `hunksOf(file)`
 * is asked only for those files. Returns [{ lines, parts: [{ path, old?, from?, to? }] }]: `old` is a
 * renamed file's old path, and a part with from/to is that range of new-file lines of a split file.
 */
export function planShards(files, hunksOf, { max = SHARD_MAX, maxChars = SHARD_CHARS } = {}) {
  const units = [];
  for (const file of files) {
    const named = file.old ? { path: file.path, old: file.old } : { path: file.path };
    const hunks = file.lines > max ? hunksOf(file) : [];
    const runs = [];
    let run = null;
    for (const h of hunks) {
      if (run && run.lines + h.lines > max) {
        runs.push(run);
        run = null;
      }
      run ??= { lines: 0, part: { ...named, from: h.from, to: h.to } };
      run.lines += h.lines;
      run.part.to = Math.max(run.part.to, h.to);
    }
    if (run) runs.push(run);
    // A file whose hunks all fit in one run isn't split: it goes whole, without a range.
    if (runs.length > 1) units.push(...runs);
    else units.push({ lines: file.lines, part: named });
  }
  const shards = [];
  let shard = null;
  for (const unit of units) {
    if (shard && (shard.lines + unit.lines > max || shard.chars + chars(unit.part) > maxChars)) {
      shards.push(shard);
      shard = null;
    }
    shard ??= { lines: 0, chars: 0, parts: [] };
    shard.lines += unit.lines;
    shard.chars += chars(unit.part);
    shard.parts.push(unit.part);
  }
  if (shard) shards.push(shard);
  return shards.map(({ lines, parts }) => ({ lines, parts }));
}

/**
 * The shards of from..to, at most SHARD_CAP of them, or null for one run per seat: when the diff is not
 * over SHARD_MAX lines, or when its paths can't be shard paths (see shardable).
 */
export function diffShards(from, to, globs, { diffLines, cwd } = {}) {
  if (!(diffLines > SHARD_MAX)) return null;
  // Options, then the two revisions, then any pathspec after `--`. Attributes come from `from`, the base.
  const diff = (options, paths) => tryGit([`--attr-source=${from}`, 'diff', '--no-ext-diff', '--no-textconv', '-M', ...options, from, to, ...paths], cwd);
  const numstat = diff(['--numstat', '-z'], excludeSpecs(globs));
  const names = diff(['--name-only', '-z'], excludeSpecs(globs));
  if (numstat === null || names === null) return null;
  const files = parseNumstatZ(numstat);
  if (!shardable(files, names.split('\0').filter(Boolean))) return null;
  // A renamed file is diffed with its old path too, so it still reads as a rename with its edits.
  const literal = (p) => `:(literal)${p}`;
  const hunks = new Map();
  const hunksOf = (f) => {
    if (!hunks.has(f.path)) hunks.set(f.path, parseHunks(diff(['-U0'], ['--', literal(f.path), ...(f.old ? [literal(f.old)] : [])]) ?? ''));
    return hunks.get(f.path);
  };
  const total = files.reduce((sum, f) => sum + f.lines, 0);
  let shards = planShards(files, hunksOf);
  // Too many shards: plan bigger ones, up to the whole diff in SHARD_CAP shards.
  for (let max = Math.ceil(total / SHARD_CAP); shards.length > SHARD_CAP && max <= total; max = Math.ceil(max * 1.25)) {
    shards = planShards(files, hunksOf, { max });
  }
  return shards.length > 1 && shards.length <= SHARD_CAP ? shards : null;
}
