#!/usr/bin/env node
// The D: drive on the build machine is failing (#161, #162): it dropped off the bus and wrote a
// zero-filled file. A tracked default, path or instruction that names a D: path would send output
// there or read suspect input from it, so none may come back. Its copy is on E: at the same paths.
// verify runs this on every change, prose included.
//
//   node build/check-d-drive.mjs
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Each form a D: path takes in the tree. Not \d:\d in a regex, "2-D:", a key named D, or a PDF date.
export const D_PATH = new RegExp([
  /(?<![A-Za-z0-9_\\-])[Dd]:[\\/]/, // D:/x, D:\x, --out=D:/x
  /\/mnt\/d(?![A-Za-z0-9_])/, // its WSL mount, /mnt/d/x
  /['"`][Dd]:['"`]/, // the drive alone as a string, 'D:'
  /\\{2,}[?.]\\+[Dd]:/, // a long or device path, \\?\D:\x, \\.\D:
  /(?:^|[\s'"`=])-[A-Za-z][Dd]:[\\/]/, // a flag glued to its value, -oD:/x
  /`D:\$\{(?![^`]*Z`)/, // a template that starts with the drive, `D:${sep}x`, but not a PDF date `D:${…}Z`
  /(?:^|[\s(]|(?:=|:-)['"]?)\/[Dd]\/(?=[\w.-])/, // Git Bash, cd /d/x, X="/d/x" and ${VAR:-/d/x}
].map((r) => r.source).join('|'));

// A wider pattern git grep can run, so only the lines that might match reach D_PATH.
export const MAYBE = String.raw`[Dd]:[\\/]|/mnt/d|['"${'`'}][Dd]:|\\[?.]\\|[Dd]:[$][{]|/[Dd]/`;

// GitHub's Windows runners have a D: of their own. This script and its test name D: paths on purpose.
const SKIP = /^\.github\/|^build\/check-d-drive\.mjs$|^tests\/unit\/no-d-drive\.test\.js$/;

// Tracked lines matching `pattern`, as [file, line, text]. -I skips binaries without reading them.
// .gitattributes marks fixtures/** binary, text files included, so the attributes come from the
// empty tree instead: a file counts as binary only by its content.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export function grep(pattern, ...paths) {
  let out;
  try {
    out = execFileSync('git', [`--attr-source=${EMPTY_TREE}`, 'grep', '-nI', '--null', '-E', '-e', pattern, '--', ...paths], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) {
    if (e.status === 1) return []; // git grep found no line
    throw e;
  }
  return out.split('\n').filter(Boolean).map((l) => l.split('\0'));
}

/** Tracked lines that name a D: path, as `file:line: text`. */
export function dDrivePaths() {
  return grep(MAYBE).filter(([f, , text]) => !SKIP.test(f) && D_PATH.test(text)).map(([f, n, text]) => `${f}:${n}: ${text.trim().slice(0, 120)}`);
}

function main() {
  const hits = dDrivePaths();
  if (hits.length > 0) {
    console.error('These lines name a path on the failing D: drive. Use the E: copy at the same path:');
    for (const hit of hits) console.error(`  ${hit}`);
    return 1;
  }
  console.log('D: drive paths: none tracked.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
