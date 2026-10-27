// REQ-WB-02 REQ-WB-09 REQ-WB-11 (feedback model and exchange format), REQ-AI-06 REQ-AI-13
// REQ-AI-17 (registry validation, proposals with stale detection and provenance) and the
// offline Prompt Helper reply checks. Untrusted inputs must not pollute prototypes or break
// out of the report's JSON block.
import { describe, it, expect } from 'vitest';
import { Marks, constrain, newPage, toJson, fromJson, extractJsonFromHtml, merge, emailBody, KIND } from '../../app/src/feedback/model.js';
import { reportHtml } from '../../app/src/feedback/review.js';
import { parseReply } from '../../app/src/ai/prompt-helper.js';
import { Registry, Proposals } from '../../app/src/ai/registry.js';
import { Store } from '../../app/src/core/store.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('feedback marks (REQ-WB-02)', () => {
  it('undo/redo, numbered pins and a bounded history', () => {
    const m = new Marks(3);
    m.add({ tool: 'pen', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    m.add({ tool: 'pin', points: [{ x: 5, y: 5 }] });
    m.add({ tool: 'pin', points: [{ x: 6, y: 6 }] });
    expect(m.pins().map((p) => p.n)).toEqual([1, 2]);
    m.undo();
    expect(m.items).toHaveLength(2);
    m.redo();
    expect(m.items).toHaveLength(3);
    for (let i = 0; i < 5; i++) m.add({ tool: 'rect', points: [{ x: i, y: i }, { x: i + 1, y: i + 1 }] });
    let undone = 0;
    while (m.undo() !== false && undone < 10) undone++;
    expect(undone).toBeLessThanOrEqual(3);
  });
  it('Shift constrains arrows to 45° and boxes to squares', () => {
    const a = constrain('arrow', { x: 0, y: 0 }, { x: 10, y: 9 });
    expect(Math.abs(a.x - a.y)).toBeLessThan(1e-9);
    expect(constrain('rect', { x: 0, y: 0 }, { x: 10, y: -3 })).toEqual({ x: 10, y: -10 });
  });
});

describe('feedback exchange format (REQ-WB-09, REQ-WB-11)', () => {
  const page = () => newPage({ image: PNG, width: 10, height: 10, marks: [{ tool: 'pin', n: 1, note: 'x', points: [], target: { id: 'layer:a', label: 'Layer A' } }], context: { image: 'img', centre: { mgrs: '21HUB0000000000' } } });
  it('round-trips through JSON and through the HTML report, merging without duplicates', () => {
    const p = page();
    p.summary = 'Close </script><script>alert(1)</script> tag';
    const s = { project: 'P', build: 'b', marking: { level: 'U' }, markingText: 'UNCLASSIFIED', pages: [p] };
    const json = JSON.stringify(toJson(s));
    expect(fromJson(json).pages[0]).toEqual(p);
    const html = reportHtml(s);
    // The summary cannot close the data block early.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    const back = fromJson(extractJsonFromHtml(html));
    expect(back.kind).toBe(KIND);
    expect(back.pages[0]).toEqual(p);
    const m = merge([p], back.pages);
    expect(m).toMatchObject({ added: 0, skipped: 1 });
    expect(emailBody(s)).toContain('Pin 1 → Layer A: x');
  });
  it('refuses foreign, newer and hostile documents', () => {
    expect(() => fromJson('{"kind":"other","pages":[]}')).toThrow(/not a GIS Workbench feedback/);
    expect(() => fromJson(JSON.stringify({ kind: KIND, version: 99, pages: [] }))).toThrow(/newer/);
    const evil = fromJson(`{"kind":"${KIND}","version":1,"pages":[{"id":"p","type":"rm -rf","image":"javascript:alert(1)","__proto__":{"polluted":1}}]}`);
    expect({}.polluted).toBeUndefined();
    expect(evil.pages[0].type).toBe('bug');
    expect(evil.pages[0].image).toBeNull();
    expect(() => extractJsonFromHtml('<html></html>')).toThrow(/not a GIS Workbench feedback report/);
  });
});

describe('Prompt Helper replies', () => {
  it('accepts a fenced, valid reply and reports every problem in a bad one', () => {
    const ok = parseReply('Here you go:\n```json\n{"graphics":[{"shape":"marker","coordinates":[[-58.59,-34.49]],"text":"A"}],"observations":[{"text":"Two hangars","confidence":"high"}]}\n```');
    expect(ok.ok).toBe(true);
    const bad = parseReply('{"graphics":[{"shape":"blob","coordinates":[[200,0],[1]],"extra":1}],"observations":[{"text":""}],"other":1}');
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' | ')).toMatch(/unexpected field "other".*shape must be one of.*out of range.*must be \[lon, lat\].*unexpected field "extra".*text is required/);
    expect(parseReply('not json').errors[0]).toMatch(/not valid JSON/);
    expect(parseReply('[1,2]').errors[0]).toMatch(/JSON object/);
    parseReply('{"__proto__":{"polluted":1}}');
    expect({}.polluted).toBeUndefined();
  });
});

describe('tool registry and proposals (REQ-AI-06, REQ-AI-13, REQ-AI-17)', () => {
  function rig() {
    const app = { store: new Store() };
    app.proposals = new Proposals(app);
    const reg = new Registry(app);
    reg.tool({ name: 'read', readOnly: true, inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 3 }, mode: { enum: ['a', 'b'] } }, required: ['n'], additionalProperties: false }, run: ({ n }) => 'x'.repeat(n * 15000) });
    reg.tool({ name: 'write', inputSchema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] }, propose: ({ v }, tx) => tx.set('project', 'name', v) });
    app.store.transact('init', (tx) => tx.create('project', { name: 'A' }, 'project'));
    return { app, reg };
  }
  it('validates arguments and caps long results', async () => {
    const { reg } = rig();
    expect((await reg.call('nope')).isError).toBe(true);
    expect((await reg.call('read', {})).content).toMatch(/missing "n"/);
    expect((await reg.call('read', { n: 1.5 })).content).toMatch(/must be integer/);
    expect((await reg.call('read', { n: 9 })).content).toMatch(/out of range/);
    expect((await reg.call('read', { n: 1, mode: 'c' })).content).toMatch(/one of a, b/);
    expect((await reg.call('read', { n: 1, x: 1 })).content).toMatch(/unknown argument "x"/);
    const long = await reg.call('read', { n: 2 });
    expect(long.content).toMatch(/truncated 10000 characters\]$/);
  });
  it('write tools only propose; accept applies with provenance; a changed base makes it stale', async () => {
    const { app, reg } = rig();
    const ctx = { source: 'assistant', connection: 'Mock', model: 'mock-model' };
    const a = (await reg.call('write', { v: 'B' }, ctx)).proposal;
    const b = (await reg.call('write', { v: 'C' }, ctx)).proposal;
    expect(app.store.get('project').name).toBe('A');
    expect(app.proposals.accept(a.id)).toBe(true);
    expect(app.store.get('project').name).toBe('B');
    expect(a.provenance).toMatchObject({ kind: 'ai', connection: 'Mock', model: 'mock-model' });
    expect(app.proposals.items.find((p) => p.id === b.id).status).toBe('stale');
    expect(app.proposals.accept(b.id)).toBe(false);
    expect(app.store.get('project').name).toBe('B');
    expect(app.proposals.reject(a.id)).toBe(false); // already decided
  });
});
