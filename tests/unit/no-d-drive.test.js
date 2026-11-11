// The D: drive on the build machine is failing (#161, #162): it dropped off the bus and wrote a
// zero-filled file. A tracked default, path or instruction that names a D: path would send output
// there or read suspect input from it, so none may come back. Its copy is on E: at the same paths.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

// Each form a D: path takes in the tree. Not \d:\d in a regex, "2-D:", a key named D, or a PDF date.
const D_PATH = new RegExp([
  /(?<![A-Za-z0-9_\\-])[Dd]:[\\/]/, // D:/x, D:\x, --out=D:/x
  /\/mnt\/d(?![A-Za-z0-9_])/, // its WSL mount, /mnt/d/x
  /['"`][Dd]:['"`]/, // the drive alone as a string, 'D:'
  /\\{2,}[?.]\\+[Dd]:/, // a long or device path, \\?\D:\x, \\.\D:
  /(?:^|[\s'"`=])-[A-Za-z][Dd]:[\\/]/, // a flag glued to its value, -oD:/x
  /`D:\$\{(?![^`]*Z`)/, // a template that starts with the drive, `D:${sep}x`, but not a PDF date `D:${…}Z`
  /(?:^|[\s(]|(?:=|:-)['"]?)\/[Dd]\/(?=[\w.-])/, // Git Bash, cd /d/x, X="/d/x" and ${VAR:-/d/x}
].map((r) => r.source).join('|'));

// A wider pattern git grep can run, so only the lines that might match reach D_PATH. -I skips
// binaries without reading them as text.
const MAYBE = String.raw`[Dd]:[\\/]|/mnt/d|['"${'`'}][Dd]:|\\[?.]\\|[Dd]:[$][{]|/[Dd]/`;

/** Tracked lines that name a D: path, as `file:line: text`, outside the files `skip` matches. */
function dDrivePaths(skip) {
  let out;
  try {
    out = execFileSync('git', ['grep', '-nI', '--null', '-E', '-e', MAYBE], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) {
    if (e.status === 1) return []; // git grep found no line
    throw e;
  }
  return out.split('\n').filter(Boolean).map((l) => l.split('\0')).filter(([f, , text]) => !skip.test(f) && D_PATH.test(text)).map(([f, n, text]) => `${f}:${n}: ${text.trim().slice(0, 120)}`);
}

describe('no tracked path on the failing D: drive', () => {
  it('finds D: paths and leaves look-alikes alone', () => {
    const hits = {
      a: "const OUT = 'D:/gwb25/x';", b: 'D:\\TE-corpus\\y', c: "'/mnt/d/TE-corpus'", d: "`${LINUX ? '/mnt/d' : 'D:'}/x`", e: "const R = 'D:';",
      l: '\\\\?\\D:\\x', m: "'\\\\\\\\.\\\\D:'", n: 'tool -oD:/out.tif', o: 'const p = `D:${sep}x`;', p: 'DEPS=${GWB_SIDECAR_DEPS:-/d/gwb-sidecar-deps}', q: 'cd /d/gwb && make', v: 'DEPS="/d/gwb"',
    };
    const alike = {
      f: '/^\\d\\d:\\d\\d$/', g: "'E:/gwb25/x'", h: 'ID:/x', i: 'every canvas is 2-D: one context', j: "{ C: 'C', D: 'D' }", k: '/mnt/data/x',
      r: 'const pdfDate = (d) => `D:${d.toISOString().slice(0, 14)}Z`;', s: '/CreationDate (D:${now}Z)', t: 'a/d/b', u: '/(\\d+)\\.\\d:/',
      w: 'inputs: vec!["/d/in.ts".into()], output: "/d/out.ts".into()', x: "id(`d:${r}`, 'D')",
    };
    expect(Object.keys(hits).filter((k) => !D_PATH.test(hits[k]))).toEqual([]);
    expect(Object.keys(alike).filter((k) => D_PATH.test(alike[k]))).toEqual([]);
    // git grep must see every line D_PATH can match.
    const maybe = new RegExp(MAYBE);
    expect(Object.keys(hits).filter((k) => !maybe.test(hits[k]))).toEqual([]);
  });

  it('has none in the repository', () => {
    // GitHub's Windows runners have a D: of their own. The sidecar and release scripts are T2 paths,
    // so their defaults move in a PR of their own, which drops them from this exclusion.
    const SKIP = /^(\.github|sidecar|build\/release)\/|^tests\/unit\/no-d-drive\.test\.js$/;
    expect(dDrivePaths(SKIP)).toEqual([]);
  });
});
