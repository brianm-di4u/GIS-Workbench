// Git plumbing. Everything here reads objects only. Nothing checks out or runs
// PR content, so it is safe on untrusted refs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function mergeBase(base, head, cwd) {
  return git(['merge-base', base, head], cwd).trim();
}

// `-z` output is `:oldMode newMode oldSha newSha status\0path\0`. Rename
// detection is off, so a move shows up as a delete of the source and an add of
// the destination, and both paths reach the tier floors.
export function parseRawDiff(raw) {
  const fields = raw.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha, status] = fields[i].replace(/^:/, '').split(' ');
    changes.push({ oldMode, newMode, oldSha, newSha, status, path: fields[i + 1] });
  }
  return changes;
}

export function rawChanges(from, to, cwd) {
  const raw = git(
    ['diff-tree', '-r', '-z', '--no-renames', '--raw', '--no-abbrev', '--ignore-submodules=none', from, to],
    cwd,
  );
  return parseRawDiff(raw);
}

// The change hash binds a verdict or approval to what the PR itself changes, not to the files it
// touches. For each changed path it covers the path, the old and new modes, and, for a text file,
// the exact lines the PR adds and removes, in order, with whitespace kept and with hunk line
// numbers and context dropped (as `git patch-id --verbatim`, but without its context lines, and
// computed here). So where in a file the lines sit is not part of it. A binary file or a
// submodule covers its old and new blob IDs instead. So a rebase onto a main that changed the same
// files elsewhere keeps the hash, and any edit, addition or removal of a PR line voids it. Records
// are sorted, so `diff.orderFile` can't affect them. A hash made under the old definition (blob
// IDs at the merge base and the head) matches nothing, so an old verdict fails as "different
// content" and evidence is looked up under a new name. Each record is a JSON array, so no path
// can run into the next field or record.
//
// `patches` is patchLines' result for the same changes: path -> lines, or null for a binary.
export function hashChanges(changes, patches) {
  const records = changes
    .map((c) => {
      const lines = patches.get(c.path);
      const head = [c.path, c.oldMode, c.newMode];
      if (!lines || c.oldMode === '160000' || c.newMode === '160000') {
        return JSON.stringify([...head, 'blob', c.oldSha, c.newSha]);
      }
      const body = createHash('sha256');
      for (const line of lines) body.update(Buffer.from(`${line}\n`, 'latin1'));
      return JSON.stringify([...head, 'text', body.digest('hex')]);
    })
    .sort();
  return createHash('sha256').update(records.join('\n')).digest('hex');
}

// Fixed, so no user or repository setting changes what a patch looks like: no rename detection, no
// external diff or text conversion, no context, one algorithm and no slider heuristic. Attributes
// in the tree are ignored (an empty tree), so a PR can't change how its own files are read. A
// machine's own attributes files can still mark a file binary; that only voids a match.
const PATCH_ARGS = [
  '-c', 'core.quotepath=false', '--literal-pathspecs', '--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  'diff-tree', '-r', '-p', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color', '--no-abbrev',
  '--unified=0', '--diff-algorithm=myers', '--no-indent-heuristic', '--submodule=short', '--ignore-submodules=none',
];

function patchText(from, to, path, cwd) {
  const args = [...PATCH_ARGS, from, to, ...(path ? ['--', path] : [])];
  // latin1 keeps every byte distinct, so two different non-UTF-8 lines never decode alike.
  return execFileSync('git', args, { cwd, encoding: 'latin1', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
}

// The PR's added and removed lines for each change, as path -> lines (null for a binary file). One
// `git diff-tree -p` covers every path and its sections are matched to the raw changes in order.
// If the counts differ (a type change prints two sections for one path), each path is read alone.
export function patchLines(from, to, changes, cwd) {
  const patches = new Map();
  const sections = splitPatch(patchText(from, to, null, cwd));
  if (sections.length === changes.length) {
    changes.forEach((c, i) => patches.set(c.path, sections[i]));
    return patches;
  }
  for (const c of changes) {
    const own = splitPatch(patchText(from, to, c.path, cwd));
    patches.set(c.path, own.some((s) => s === null) ? null : own.flat());
  }
  return patches;
}

// The sections of `diff-tree -p` output: each file's + - and "\ No newline" lines in order, or
// null for a binary. Content lines are taken only after a section's first `@@`, so a header line
// (`--- a/x`, `+++ b/x`) is never mistaken for content, and `diff --git` starts no content line.
export function splitPatch(text) {
  const sections = [];
  let current = null;
  let inHunks = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = [];
      sections.push(current);
      inHunks = false;
    } else if (current === null) {
      continue;
    } else if (!inHunks && line.startsWith('Binary files ')) {
      sections[sections.length - 1] = null;
      current = null;
    } else if (line.startsWith('@@')) {
      inHunks = true;
    } else if (inHunks && (line[0] === '+' || line[0] === '-' || line[0] === '\\')) {
      current.push(line);
    }
  }
  return sections;
}

export function changeSet(baseRef, headRef, cwd) {
  const base = mergeBase(baseRef, headRef, cwd);
  const changes = rawChanges(base, headRef, cwd);
  return { mergeBase: base, changes, hash: hashChanges(changes, patchLines(base, headRef, changes, cwd)) };
}

export function readBlob(ref, path, cwd) {
  return tryGit(['show', `${ref}:${path}`], cwd);
}

export function commitMessage(ref, cwd) {
  return git(['log', '-1', '--format=%B', ref], cwd);
}

export function isAncestor(ancestor, descendant, cwd) {
  return tryGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd) !== null;
}
