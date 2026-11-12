// build/check-d-drive.mjs keeps D: paths out of the tree, and verify runs it on every change.
// These cases pin what it counts as a D: path.
import { describe, it, expect } from 'vitest';
import { D_PATH, MAYBE, grep } from '../../build/check-d-drive.mjs';

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

  it('reads the text files .gitattributes marks binary', () => {
    expect(grep('E:/gwb25/data-aero', 'fixtures/fx25/aero/SOURCE.txt')).toHaveLength(1);
  });
});
