// REQ-GAP-02: the page's end of the Python relay, over a real MCP server, registry and proposals
// (no browser, no sidecar). What matters here: every write is a proposal whatever the tool, tools
// of remote MCP servers are not reachable, and the relay goes off when the sidecar goes.
import { describe, it, expect } from 'vitest';
import { RelayHost, relayTool, RESULT_CAP, MAX_PENDING_PROPOSALS, MAX_REPLY_BYTES } from '../../app/src/sidecar/relay-host.js';
import { createMcpServer } from '../../app/src/ai/mcp-server.js';
import { installApiV2Tools, installAutomationTools } from '../../app/src/ai/tools-auto.js';
import { Registry, Proposals } from '../../app/src/ai/registry.js';
import { Store } from '../../app/src/core/store.js';
import { METHODS, mcpName } from '../../app/src/automation/v2-spec.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A fake sidecar: `deliveries` go out of the inbox one by one; replies are collected. */
function fakeSidecar(deliveries = []) {
  const queue = [...deliveries];
  const replies = [];
  const log = [];
  let release = null;
  const client = {
    request: async (method, path, { json, body, signal } = {}) => {
      log.push(`${method} ${path}`);
      const no = client.fail?.(method, path);
      if (no) throw no;
      if (path === '/v1/relay/attach') return { session: 'S', hold_s: 25 };
      if (path.endsWith('/inbox')) {
        if (queue.length) return queue.shift();
        await new Promise((res, rej) => {
          release = res;
          signal?.addEventListener('abort', () => rej(new Error('aborted')));
        });
        return null;
      }
      if (path.endsWith('/reply')) replies.push(JSON.parse(body));
      void json;
      return null;
    },
  };
  return { client, replies, log, send: (d) => (queue.push(d), release?.()), release: () => release?.() };
}

function rig(deliveries, { tools } = {}) {
  const app = { store: new Store() };
  app.proposals = new Proposals(app);
  const reg = new Registry(app);
  reg.tool({ name: 'gw_read', title: 'Read', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => ({ ok: 1 }) });
  reg.tool({ name: 'gw_big', title: 'Big', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => 'x'.repeat(30000) });
  reg.tool({ name: 'gw_huge', title: 'Huge', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => ''.repeat(RESULT_CAP) }); // six bytes each in JSON
  reg.tool({ name: 'gw_rename', title: 'Rename', inputSchema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] }, propose: ({ v }, tx) => (tx.set('project', 'name', v), { title: 'Rename' }) });
  reg.tool({ name: 'mcp__srv__remote', title: 'Remote', readOnly: true, inputSchema: { type: 'object' }, run: () => (app.leftTheComputer = true) });
  tools?.(reg, app);
  app.store.transact('init', (tx) => tx.create('project', { name: 'A' }, 'project'));
  const server = createMcpServer(reg);
  const s = fakeSidecar(deliveries);
  const host = new RelayHost({ client: s.client, serve: (m, ctx) => server.handle(m, ctx), toolDef: (n) => reg.tools.get(n), pending: () => app.proposals.pending().length, name: 'test page', wait: async () => {} });
  return { app, reg, host, ...s };
}

const call = (rid, name, args = {}) => ({ rid, client: 'my script', message: { jsonrpc: '2.0', id: rid, method: 'tools/call', params: { name, arguments: args } } });
const rpc = (rid, method, params) => ({ rid, client: 'my script', message: { jsonrpc: '2.0', id: rid, method, ...(params ? { params } : {}) } });

async function serveAll(r, n = 1) {
  await r.host.start();
  for (let i = 0; i < 50 && r.replies.length < n; i++) await flush();
  expect(r.replies.length).toBe(n);
  await r.host.stop();
  return r.replies;
}

describe('REQ-GAP-02 the relay reaches the page only when turned on', () => {
  it('asks the sidecar for nothing until started, and detaches when stopped', async () => {
    const r = rig([]);
    expect(r.log).toEqual([]);
    await r.host.start();
    await flush();
    expect(r.host.on).toBe(true);
    expect(r.log.slice(0, 2)).toEqual(['POST /v1/relay/attach', 'GET /v1/relay/S/inbox']);
    await r.host.stop();
    expect(r.host.on).toBe(false);
    expect(r.log.at(-1)).toBe('DELETE /v1/relay/S');
  });

  it('a refused start stays off, with the reason', async () => {
    const r = rig([]);
    r.client.fail = () => Object.assign(new Error('held'), { status: 409, code: 'relay_held' });
    await expect(r.host.start()).rejects.toThrow('held');
    expect(r.host.on).toBe(false);
  });

  it.each([[401], [404]])('goes off for good when the sidecar answers %i', async (status) => {
    const r = rig([]);
    let n = 0;
    r.client.fail = (m, p) => (p.endsWith('/inbox') && n++ === 0 ? Object.assign(new Error('gone'), { status }) : null);
    await r.host.start();
    await r.host.loop;
    expect(r.host.on).toBe(false);
    expect(r.host.error.status).toBe(status);
    expect(r.log.filter((x) => x.endsWith('/inbox'))).toHaveLength(1);
  });

  it('a lost connection gets three tries, then the relay is off', async () => {
    const r = rig([]);
    r.client.fail = (m, p) => (p.endsWith('/inbox') ? Object.assign(new Error('no answer'), { status: 0 }) : null);
    await r.host.start();
    await r.host.loop;
    expect(r.host.on).toBe(false);
    expect(r.log.filter((x) => x.endsWith('/inbox'))).toHaveLength(3);
  });
});

describe('REQ-GAP-02 what a script gets is what an outside agent gets', () => {
  it('initialize and a read run; the provenance is the relay', async () => {
    const r = rig([rpc('a', 'initialize', { protocolVersion: '2025-06-18' }), call('b', 'gw_read')]);
    const out = await serveAll(r, 2);
    expect(out.find((x) => x.rid === 'a').reply.result.serverInfo.name).toBe('gis-workbench');
    expect(JSON.parse(out.find((x) => x.rid === 'b').reply.result.content[0].text)).toEqual({ ok: 1 });
    expect(r.host.calls.map((c) => c.label).sort()).toEqual(['gw_read', 'initialize']);
    expect(r.host.count).toBe(2);
  });

  it('a write is a pending proposal with the script as provenance; the store does not change', async () => {
    const r = rig([call('w', 'gw_rename', { v: 'B' })]);
    const [{ reply }] = await serveAll(r);
    expect(reply.result.structuredContent.status).toBe('pending');
    expect(r.app.store.get('project').name).toBe('A');
    const p = r.app.proposals.pending()[0];
    expect(p.provenance).toMatchObject({ source: 'mcp:python-relay', connection: 'python-relay', model: 'my script' });
    expect(r.host.calls[0].proposal).toBe(p.id);
    expect(r.app.proposals.accept(p.id)).toBe(true);
    expect(r.app.store.get('project').name).toBe('B');
  });

  it('auto-apply never applies to an outside agent', async () => {
    const r = rig([call('w', 'gw_rename', { v: 'B' })]);
    r.app.proposals.autoApply = true;
    await serveAll(r);
    expect(r.app.store.get('project').name).toBe('A');
    expect(r.app.proposals.pending()).toHaveLength(1);
  });

  it('every API v2 write, and every effect flag of a read method, is a proposal that does not run', async () => {
    const ran = [];
    const r = rig([], {
      tools: (reg, app) => {
        app.api = { v2: { call: async (m) => (ran.push(m), {}) } };
        installApiV2Tools(app, reg);
      },
    });
    const server = createMcpServer(r.reg);
    const ctx = { origin: 'python-relay', client: 'my script' };
    let writes = 0;
    for (const [method, m] of Object.entries(METHODS)) {
      const name = mcpName(method);
      if (!name) continue;
      const props = m.params?.properties ?? {};
      const required = Object.fromEntries((m.params?.required ?? []).map((k) => [k, { string: 'x', number: 1, integer: 1, array: [], object: {}, boolean: true }[props[k]?.type] ?? 'x']));
      for (const k of Object.keys(required)) if (props[k]?.enum) required[k] = props[k].enum[0];
      const variants = m.readOnly ? ['save', 'show'].filter((k) => props[k]).map((k) => ({ ...required, [k]: true })) : [required];
      for (const args of variants) {
        const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx);
        expect(res.result.isError, `${method}: ${res.result.content[0].text}`).toBe(false);
        expect(res.result.structuredContent?.status, method).toBe('pending');
        writes++;
      }
    }
    expect(writes).toBeGreaterThan(30);
    expect(ran).toEqual([]);
    // The same read method without the flag runs.
    await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gw2_products_report', arguments: {} } }, ctx);
    expect(ran).toEqual(['products.report']);
  });

  it('gw_proposal_status reports a proposal to the client that made it, and nobody else', async () => {
    const r = rig([], {
      tools: (reg, app) => {
        app.commands = { list: () => [], get: () => ({ implemented: true, label: 'x' }), enabled: () => true, run: async () => {} };
        app.api = { v2: { call: async () => ({}) } };
        installAutomationTools(app, reg);
      },
    });
    const server = createMcpServer(r.reg);
    const mine = { origin: 'python-relay', client: 'my script' };
    const say = async (name, args, ctx) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx)).result;
    const id = (await say('gw_rename', { v: 'B' }, mine)).structuredContent.proposal;
    expect(JSON.parse((await say('gw_proposal_status', { id }, mine)).content[0].text).status).toBe('pending');
    r.app.proposals.reject(id);
    expect(JSON.parse((await say('gw_proposal_status', { id }, mine)).content[0].text).status).toBe('rejected');
    expect((await say('gw_proposal_status', { id }, { origin: 'python-relay', client: 'another script' })).isError).toBe(true);
    expect((await say('gw_proposal_status', { id }, { origin: 'https://agent.example' })).isError).toBe(true);
    expect(r.reg.listTools().map((t) => t.name)).not.toContain('gw_proposal_status'); // not the assistant's
  });
});

describe('REQ-GAP-02 the relay stays on this computer', () => {
  it('remote MCP tools are neither listed nor callable', async () => {
    const r = rig([rpc('l', 'tools/list'), call('c', 'mcp__srv__remote')]);
    const out = await serveAll(r, 2);
    const names = out.find((x) => x.rid === 'l').reply.result.tools.map((t) => t.name);
    expect(names).toContain('gw_read');
    expect(names.filter((n) => !relayTool(n))).toEqual([]);
    expect(out.find((x) => x.rid === 'c').reply.error.code).toBe(-32601);
    expect(r.app.leftTheComputer).toBeUndefined();
  });

  it.each([['mcp__a__b'], ['constructor'], [''], [null], [7], ['GW_READ'], ['xgw_read']])('tool name %j is refused', async (name) => {
    const r = rig([call('c', name)]);
    const [{ reply }] = await serveAll(r);
    expect(reply.error.code).toBe(-32601);
  });
});

describe('REQ-GAP-02 limits', () => {
  it('a script gets more than the assistant, a model still gets its cap', async () => {
    const r = rig([call('b', 'gw_big')]);
    const [{ reply }] = await serveAll(r);
    expect(reply.result.content[0].text).toHaveLength(30000);
    const direct = await r.reg.call('gw_big', {}, { source: 'assistant' });
    expect(direct.content).toMatch(/truncated 10000 characters/);
  });

  it('a reply too large for the relay becomes an error, not a cut message', async () => {
    const r = rig([call('h', 'gw_huge')]);
    const [{ reply }] = await serveAll(r);
    expect(reply.error.code).toBe(-32001);
    expect(reply.error.message).toContain(String(MAX_REPLY_BYTES));
  });

  it('writes are refused while too many proposals wait; reads go on', async () => {
    const r = rig([call('w', 'gw_rename', { v: 'B' }), call('r', 'gw_read')]);
    r.host.pending = () => MAX_PENDING_PROPOSALS;
    const out = await serveAll(r, 2);
    expect(out.find((x) => x.rid === 'w').reply.error.code).toBe(-32000);
    expect(out.find((x) => x.rid === 'r').reply.result.isError).toBe(false);
    expect(r.app.proposals.pending()).toHaveLength(0);
  });

  it('a tool that throws comes back as an error; the relay stays on', async () => {
    const r = rig([rpc('x', 'tools/call', { name: 'gw_read' })]);
    r.host.serve = async () => {
      throw new Error('broken');
    };
    await r.host.start();
    for (let i = 0; i < 50 && !r.replies.length; i++) await flush();
    expect(r.replies[0].reply.error).toEqual({ code: -32603, message: 'broken' });
    expect(r.host.on).toBe(true);
    await r.host.stop();
  });

  it('keeps a short list of calls, never their arguments', async () => {
    const r = rig(Array.from({ length: 20 }, (_, i) => call(`c${i}`, 'gw_read')));
    await serveAll(r, 20);
    expect(r.host.calls).toHaveLength(12);
    expect(r.host.count).toBe(20);
    expect(JSON.stringify(r.host.calls)).not.toContain('arguments');
  });
});
