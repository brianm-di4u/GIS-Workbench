// REQ-GAP-01 automation API v2: the contract (semantic versioning; the frozen 2.0.0 surface stays
// compatible), the typed reference (docs/api/gisworkbench-api-3.d.ts is generated from the spec
// and parses as TypeScript), the run-time binding (every method implemented, arguments checked,
// events delivered and kept), the MCP tools generated from it, and v1 unchanged.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transform } from 'esbuild';
import { METHODS, EVENTS, TYPES, API_VERSION, parseSemver, compatBreaks, mcpName } from '../../app/src/automation/v2-spec.js';
import { makeV2, wireEvents } from '../../app/src/automation/api-v2.js';
import { installApiV2Tools, mcpSafe } from '../../app/src/ai/tools-auto.js';
import { Registry, Proposals } from '../../app/src/ai/registry.js';
import { createMcpServer } from '../../app/src/ai/mcp-server.js';
import { Store } from '../../app/src/core/store.js';
import { Emitter } from '../../app/src/core/util.js';
import { generate, DTS_PATH, ALIAS_PATH, aliasText } from '../../build/api-dts.mjs';

const FROZEN = JSON.parse(readFileSync(resolve('tests/unit/fixtures/api-v2-2.0.0.json'), 'utf8'));

/** A small app: store, layers, panes, pool events, commands. */
function stubApp() {
  const app = new Emitter();
  app.store = new Store();
  app.layers = new Map();
  app.prefs = { get: () => undefined, set() {} };
  app.pool = Object.assign(new Emitter(), { jobs: new Map(), history: [], cancel() {} });
  app.commands = { list: () => [{ id: 'nav.jump', label: 'Jump', implemented: true }], get: (id) => (id === 'nav.jump' ? { label: 'Jump', implemented: true } : null), enabled: () => true, checked: () => false, run: async () => {} };
  app.activePane = () => null;
  app.activeLayer = () => null;
  app.build = { version: '2.4.0-test', id: 'b1' };
  app.log = () => {};
  return app;
}

describe('REQ-GAP-01 API v2 contract', () => {
  it('has a semantic version and well-formed methods', () => {
    expect(parseSemver(API_VERSION)).toEqual({ major: 3, minor: 0, patch: 0 });
    for (const [name, m] of Object.entries(METHODS)) {
      expect(name).toMatch(/^[a-z]+(\.[a-z][A-Za-z]*)+$/);
      expect(() => parseSemver(m.since)).not.toThrow();
      expect(m.params.type).toBe('object');
      expect(m.params.additionalProperties).toBe(false);
      for (const r of m.params.required ?? []) expect(m.params.properties).toHaveProperty(r);
      expect(typeof m.summary).toBe('string');
      expect(m.summary.length).toBeGreaterThan(10);
      expect(typeof m.returns).toBe('string');
    }
    expect(Object.keys(METHODS).length).toBeGreaterThanOrEqual(70);
    expect(Object.keys(EVENTS).sort()).toEqual(['job', 'layer', 'selection', 'view']);
  });

  it('every recipe operation and the main tool families are in the surface', () => {
    const names = Object.keys(METHODS);
    for (const fam of ['layers.', 'vectors.', 'view.', 'selection.', 'geo.', 'measure.', 'analysis.', 'extract.', 'catalogs.', 'detections.', 'ai.', 'products.', 'recipes.', 'jobs.', 'events.']) expect(names.some((n) => n.startsWith(fam))).toBe(true);
    for (const n of ['recipes.op', 'recipes.run', 'recipes.resume', 'ai.find', 'ai.describe', 'ai.changeMask', 'ai.models.add', 'ai.models.run', 'analysis.viewshed', 'extract.createFeature', 'products.cog']) expect(names).toContain(n);
  });

  it('keeps the frozen 2.0.0 surface compatible (no removal, no new required parameter, no type change)', () => {
    expect(FROZEN.api).toBe('2.0.0');
    expect(compatBreaks(FROZEN.methods, METHODS)).toEqual([]);
  });

  it('compatBreaks catches each kind of break', () => {
    const cur = JSON.parse(JSON.stringify(METHODS));
    delete cur['layers.list'];
    cur['geo.parse'].params.required = ['text', 'extra'];
    cur['geo.format'].params.properties.format.type = 'string';
    cur['view.get'].readOnly = false;
    delete cur['ai.find'].params.properties.threshold;
    const b = compatBreaks(FROZEN.methods, cur);
    expect(b).toContain('layers.list: removed');
    expect(b).toContain('geo.parse: parameter extra became required');
    expect(b).toContain('geo.format: parameter format changed type');
    expect(b).toContain('view.get: readOnly changed');
    expect(b).toContain('ai.find: parameter threshold removed');
  });

  it('the committed .d.ts is the generated one and parses as TypeScript', async () => {
    const text = generate();
    expect(readFileSync(DTS_PATH, 'utf8').replace(/\r\n/g, '\n')).toBe(text);
    const r = await transform(text, { loader: 'ts' });
    expect(r.warnings).toEqual([]);
    for (const n of Object.keys(TYPES)) expect(text).toContain(`export type ${n} =`);
    expect(text).toContain('interface GisWorkbenchApiV2');
    expect(text).toContain('find(params: AiFindParams): Promise<FindResult>;');
    expect(text).toContain('add(params: AiModelsAddParams): Promise<ModelInfo>;');
    expect(text).toMatch(/files: File\[\];/);
  });

  it('the reference is named for the major version, and the old name only points to it (REG-179)', () => {
    expect(DTS_PATH).toMatch(new RegExp(`gisworkbench-api-${parseSemver(API_VERSION).major}\\.d\\.ts$`));
    expect(readFileSync(ALIAS_PATH, 'utf8').replace(/\r\n/g, '\n')).toBe(aliasText());
    expect(aliasText()).toContain('/// <reference path="./gisworkbench-api-3.d.ts" />');
    expect(aliasText()).toContain("export * from './gisworkbench-api-3';");
  });
});

describe('REQ-GAP-01 API v2 run time', () => {
  it('implements every method and nests them by namespace', () => {
    const v2 = makeV2(stubApp());
    for (const name of Object.keys(METHODS)) {
      expect(typeof v2._impl[name]).toBe('function');
      const parts = name.split('.');
      let o = v2;
      for (const p of parts) o = o[p];
      expect(typeof o).toBe('function');
    }
    expect(Object.keys(v2._impl).filter((k) => !METHODS[k])).toEqual([]);
  });

  it('checks the arguments against the schema before calling', async () => {
    const v2 = makeV2(stubApp());
    await expect(v2.call('geo.parse', {})).rejects.toMatchObject({ code: 'E_API_ARGS' });
    await expect(v2.call('geo.parse', { text: 'x', bogus: 1 })).rejects.toThrow(/unknown argument "bogus"/);
    await expect(v2.call('measure.lineOfSight', { from: 'a', to: [0, 0] })).rejects.toThrow(/"from" must be array/);
    await expect(v2.call('jobs.list', { limit: 0 })).rejects.toThrow(/out of range/);
    await expect(v2.call('nope.nothing', {})).rejects.toMatchObject({ code: 'E_NO_METHOD' });
    await expect(v2.call('ai.find', { objects: ['x'], scope: 'galaxy' })).rejects.toThrow(/must be one of view, scene/);
  });

  it('answers the read-only methods that need no image', async () => {
    const app = stubApp();
    const v2 = makeV2(app);
    expect(await v2.api.version()).toMatchObject({ api: '3.0.0', major: 3, v1: 1, app: '2.4.0-test' });
    const d = await v2.api.describe({ method: 'ai.find' });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ method: 'ai.find', readOnly: false, mcp: 'gw2_ai_find' });
    expect(await v2.layers.list()).toEqual([]);
    expect(await v2.commands.list({ filter: 'jump' })).toEqual([{ id: 'nav.jump', label: 'Jump', enabled: true, checked: false, implemented: true }]);
    expect(await v2.jobs.list()).toEqual([]);
    expect(await v2.view.get()).toMatchObject({ pane: null });
    await expect(v2.view.set({ zoom: 2 })).rejects.toMatchObject({ code: 'E_STEP_FIRST' });
  });

  it('delivers layer, selection, view and job events and keeps them for events.recent', async () => {
    const app = stubApp();
    const v2 = makeV2(app);
    wireEvents(app, v2);
    const got = [];
    const off = v2.on('layer', (e) => got.push(e));
    const all = [];
    v2.on('*', (e) => all.push(e.type));
    let id;
    app.store.transact('add', (tx) => {
      id = tx.create('vlayer', { name: 'v' });
    });
    app.store.transact('rename', (tx) => tx.set(id, 'name', 'w'));
    app.store.transact('del', (tx) => tx.delete(id));
    expect(got.map((e) => e.action)).toEqual(['added', 'changed', 'removed']);
    expect(got[0]).toMatchObject({ type: 'layer', layer: id, kind: 'vector' });
    off();
    app.store.transact('add2', (tx) => tx.create('vlayer', { name: 'x' }));
    expect(got).toHaveLength(3);
    // Selection: replacing and mutating the set both count; one event per microtask.
    app.selection = new Set(['a']);
    app.selection.add('b');
    await Promise.resolve();
    app.selection.clear();
    await Promise.resolve();
    const sel = (await v2.events.recent({ types: ['selection'] })).map((e) => e.ids);
    expect(sel).toEqual([['a', 'b'], []]);
    // Jobs: states always, progress at most every 250 ms; tile reads are left out.
    app.pool.emit('job', { id: 'j1', op: 'decode', label: 'Decode', state: 'queued', progress: 0 });
    app.pool.emit('job', { id: 'j1', op: 'decode', label: 'Decode', state: 'running', progress: 0.1 });
    app.pool.emit('job', { id: 'j1', op: 'decode', label: 'Decode', state: 'running', progress: 0.2 });
    app.pool.emit('job', { id: 't', op: 'tile', state: 'running' });
    app.pool.emit('job', { id: 'j1', op: 'decode', label: 'Decode', state: 'done', progress: 1 });
    const jobs = await v2.events.recent({ types: ['job'] });
    expect(jobs.map((e) => e.state)).toEqual(['queued', 'running', 'done']);
    // View: coalesced per panel.
    await new Promise((res) => {
      const p = { id: 'pane1', view: { cx: 1, cy: 2, zoom: 1, rot: 0 } };
      app.emit('view', p);
      app.emit('view', { ...p, view: { cx: 5, cy: 6, zoom: 2, rot: 0 } });
      setTimeout(res, 60);
    });
    const views = await v2.events.recent({ types: ['view'] });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ pane: 'pane1', cx: 5, cy: 6, zoom: 2 });
    // since filters by sequence number.
    const last = (await v2.events.recent())[0].seq;
    expect((await v2.events.recent({ since: last })).every((e) => e.seq > last)).toBe(true);
    expect(all).toContain('selection');
    expect(() => v2.on('nothing', () => {})).toThrow(/no event/);
  });

  it('runs a headless recipe through recipes.run with the gates option', async () => {
    const app = stubApp();
    const calls = [];
    app.recipes = {
      builtin: [],
      ops: {},
      validate: (r) => r,
      headless: (src, o) => {
        calls.push([src.id, o]);
        return { id: 'run-1', start: async () => {}, resume: async () => {}, status: () => ({ run: 'run-1', recipe: src.id, state: o.gates === 'stop' ? 'waiting' : 'done', ok: true, steps: [], files: [] }) };
      },
      runOp: async (op, p) => ({ summary: `${op} ${JSON.stringify(p)}`, files: [] }),
    };
    const v2 = makeV2(app);
    const r = await v2.recipes.run({ recipe: { id: 'r1' }, gates: 'stop' });
    expect(r).toMatchObject({ run: 'run-1', state: 'waiting' });
    expect(calls[0][1]).toEqual({ gates: 'stop', params: {} });
    expect((await v2.recipes.status({ run: 'run-1' })).recipe).toBe('r1');
    await expect(v2.recipes.status({ run: 'run-9' })).rejects.toMatchObject({ code: 'E_NO_RUN' });
    expect(await v2.recipes.op({ op: 'contrast', params: {} })).toEqual({ summary: 'contrast {}', files: [] });
    await expect(v2.recipes.run({ id: 'missing' })).rejects.toMatchObject({ code: 'E_NO_RECIPE' });
  });
});

describe('REQ-GAP-01 MCP tools map onto API v2', () => {
  it('one gw2_* tool per JSON method, listed to MCP clients only; writes become proposals', async () => {
    const app = stubApp();
    app.proposals = new Proposals(app);
    const reg = new Registry(app);
    app.registry = reg;
    installApiV2Tools(app, reg);
    app.api = { v2: makeV2(app) };
    const mcp = reg.listTools({ mcp: true });
    const plain = reg.listTools();
    expect(plain).toHaveLength(0); // the in-app assistant keeps its own tools
    const want = Object.keys(METHODS).filter((k) => !METHODS[k].files);
    expect(mcp.map((x) => x.name).sort()).toEqual(want.map(mcpName).sort());
    for (const tl of mcp) {
      expect(tl.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      const method = tl._meta['gisworkbench/apiMethod'];
      expect(tl.inputSchema).toEqual(METHODS[method].params);
      expect(tl.annotations.readOnlyHint).toBe(!!METHODS[method].readOnly);
      expect(tl._meta['gisworkbench/apiVersion']).toBe(API_VERSION);
    }
    const server = createMcpServer(reg);
    const list = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(list.result.tools.length).toBe(want.length);
    const ver = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gw2_api_version', arguments: {} } });
    expect(JSON.parse(ver.result.content[0].text)).toMatchObject({ api: '3.0.0' });
    const w = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gw2_commands_run', arguments: { id: 'nav.jump' } } });
    expect(w.result.structuredContent).toMatchObject({ status: 'pending' });
    expect(app.proposals.pending()).toHaveLength(1);
    const bad = await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gw2_geo_parse', arguments: { nope: 1 } } });
    expect(bad.result.isError).toBe(true);
  });

  it('mcpSafe turns binary results into notes', () => {
    const r = mcpSafe({ a: 1, file: { name: 'x.tif', blob: new Blob([new Uint8Array(10)], { type: 'image/tiff' }) }, raw: new Uint8Array(4) });
    expect(r).toEqual({ a: 1, file: { name: 'x.tif', blob: { binary: true, size: 10, type: 'image/tiff', note: expect.stringMatching(/JavaScript/) } }, raw: { binary: true, size: 4 } });
  });
});
