// The D: drive on the build machine is failing (#161, #162): it dropped off the bus and wrote a
// zero-filled file. A tracked default, path or instruction that names a D: path would send output
// there or read suspect input from it, so none may come back. Its copy is on E: at the same paths.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// A path on D: (D:/x, D:\x), its WSL mount (/mnt/d/x, '/mnt/d'), or the drive alone as a string
// ('D:'). Not \d:\d in a regex, "2-D:" or a key named D.
const D_PATH = /(?<![A-Za-z0-9_\\-])[Dd]:[\\/]|\/mnt\/d(?![A-Za-z0-9_])|['"`][Dd]:['"`]/;

function dDrivePaths(files, read) {
  const hits = [];
  for (const f of files) {
    const text = read(f);
    if (text == null || text.includes('\0')) continue;
    text.split('\n').forEach((line, i) => { if (D_PATH.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
  }
  return hits;
}

describe('no tracked path on the failing D: drive', () => {
  it('finds D: paths and leaves look-alikes alone', () => {
    const src = {
      a: "const OUT = 'D:/gwb25/x';", b: 'D:\\TE-corpus\\y', c: "'/mnt/d/TE-corpus'", d: "`${LINUX ? '/mnt/d' : 'D:'}/x`", e: "const R = 'D:';",
      f: '/^\\d\\d:\\d\\d$/', g: "'E:/gwb25/x'", h: 'ID:/x', i: 'every canvas is 2-D: one context', j: "{ C: 'C', D: 'D' }", k: '/mnt/data/x',
    };
    expect(dDrivePaths(Object.keys(src), (f) => src[f]).map((h) => h.split(':')[0])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('has none in the repository', () => {
    // GitHub's Windows runners have a D: of their own. The sidecar and release scripts are T2 paths,
    // so their defaults move in a PR of their own, which drops them from this exclusion.
    const SKIP = /^(\.github|sidecar|build\/release)\//;
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter((f) => f && f !== 'tests/unit/no-d-drive.test.js' && !SKIP.test(f));
    const hits = dDrivePaths(files, (f) => { try { return readFileSync(f, 'utf8'); } catch { return null; } });
    expect(hits).toEqual([]);
  });
});
