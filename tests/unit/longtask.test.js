// #63: the pieces that took the freezes out of large imports and project save and open.
import { describe, it, expect } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { clone, uuid } from '../../app/src/core/util.js';
import { Store } from '../../app/src/core/store.js';
import { needsReviver, readProject, readProjectAsync, serialiseProject, serialiseProjectAsync } from '../../app/src/storage/project.js';

describe('REQ-ING-04 #63 clone copies as structuredClone does', () => {
  it('copies plain data deeply, and leaves other kinds to structuredClone', () => {
    const src = { a: [1, [2, { b: 'x' }]], n: null, u: undefined, f: new Float64Array([1, 2]), d: new Date(5), m: new Map([[1, 2]]) };
    const c = clone(src);
    expect(c).toEqual(src);
    expect(c.a[1][1]).not.toBe(src.a[1][1]);
    expect(c.f).toBeInstanceOf(Float64Array);
    expect(c.f).not.toBe(src.f);
    expect(c.d).toBeInstanceOf(Date);
    expect(c.m.get(1)).toBe(2);
    expect('u' in c).toBe(true);
  });
  it('keeps an own "__proto__" key as a key, never as the prototype', () => {
    const src = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    const c = clone(src);
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(c.polluted).toBeUndefined();
    expect(Object.keys(c)).toEqual(['__proto__', 'ok']);
    expect({}.polluted).toBeUndefined();
  });
  it('falls back to structuredClone for a cycle, and throws on a function as it does', () => {
    const cyc = { a: 1 };
    cyc.self = cyc;
    const c = clone(cyc);
    expect(c.self).toBe(c);
    expect(() => clone({ f: () => 1 })).toThrow();
  });
});

describe('REQ-ING-04 #63 uuid', () => {
  it('gives version 4 UUIDs, all different, across refills of its pool', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const u = uuid();
      expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      seen.add(u);
    }
    expect(seen.size).toBe(2000);
  });
});

describe('REQ-ING-04 #63 store.load takes parsed records without a copy only when told', () => {
  it('copies by default and takes them as they are with owned', () => {
    const recs = [{ id: 'a', type: 'x', v: [1] }];
    const s = new Store();
    s.load(recs);
    expect(s.get('a')).not.toBe(recs[0]);
    s.load(recs, { owned: true });
    expect(s.get('a')).toBe(recs[0]);
    expect(s.all('x')).toHaveLength(1);
  });
});

const fakeApp = (records) => {
  const store = new Store();
  store.load(records);
  return { store, desktop: { multiports: [], arrange: 'tile' }, undo: { history: () => [] }, project: () => ({ name: 'P' }), build: { version: 'test' } };
};

describe('REQ-ING-04 #63 project save and open', () => {
  const records = [
    { id: 'project', type: 'project', name: 'P' },
    { id: 'f1', type: 'feature', geom: { type: 'Point', xyz: [1, 2, 3] }, attrs: { name: 'ü — non-ASCII stays unescaped' } },
  ];
  it('the worker zip and unzip read and write what the synchronous ones do', async () => {
    const app = fakeApp(records);
    const a = readProject(await serialiseProjectAsync(app));
    const b = await readProjectAsync(serialiseProject(app));
    expect(a.records).toEqual(records);
    expect(b.records).toEqual(records);
  });
  it('drops a "__proto__" key on open, spelled out or escaped', () => {
    for (const key of ['"__proto__"', '"\\u005f_proto__"']) {
      const text = `[{"id":"a","type":"x","bad":{${key}:{"polluted":true}}}]`;
      const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'gis-workbench-project', version: 1 })), 'records.json': strToU8(text) });
      const [r] = readProject(bytes).records;
      expect(Object.prototype.hasOwnProperty.call(r.bad, '__proto__'), key).toBe(false);
      expect(r.bad.polluted, key).toBeUndefined();
    }
  });
  it('only text that could hold the key takes the slow parse', () => {
    expect(needsReviver(JSON.stringify(records))).toBe(false); // non-ASCII is written as it is
    expect(needsReviver(String.raw`{"__proto__":1}`)).toBe(true);
    expect(needsReviver(String.raw`{"\u005f_proto__":1}`)).toBe(true);
    expect(needsReviver(String.raw`{"a":"\u0001"}`)).toBe(true);
    expect(needsReviver(String.raw`{"u":"plain u, and a backslash \\ before n"}`)).toBe(false);
  });
  it('a Windows path keeps the fast parse, and a real escape after a backslash still takes the slow one (#131)', () => {
    expect(needsReviver(JSON.stringify([{ id: 'a', type: 'x', src: 'C:\\users\\me\\data.shp' }]))).toBe(false);
    expect(needsReviver(String.raw`{"p":"\\\\u"}`)).toBe(false);
    expect(needsReviver(String.raw`{"__\u0070roto__":1}`)).toBe(true); // any letter can be escaped
    expect(needsReviver(String.raw`{"p":"\\\u005f"}`)).toBe(true); // an escaped backslash, then an escape
    expect(needsReviver(String.raw`\u005b`)).toBe(true);
  });
});
