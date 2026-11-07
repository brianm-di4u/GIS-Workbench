// REQ-AI-14 (MCP client: Streamable HTTP with JSON and SSE replies, session and version
// headers, bearer token, elicitation, sampling behind two confirmations, OAuth PKCE) and
// REQ-AI-15 (the registry as an MCP server; writes become proposals; the postMessage bridge
// answers allow-listed origins only).
import { describe, it, expect } from 'vitest';
import { McpClient, parseSse, pkce, discoverAuth, authorizeUrl, exchangeCode, PROTOCOL_VERSION } from '../../app/src/ai/mcp-client.js';
import { createMcpServer, attachBridge } from '../../app/src/ai/mcp-server.js';
import { Registry, Proposals } from '../../app/src/ai/registry.js';
import { Store } from '../../app/src/core/store.js';

const reply = (body, { status = 200, type = 'application/json', headers = {} } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => ({ 'content-type': type, ...Object.fromEntries(Object.entries(headers).map(([a, b]) => [a.toLowerCase(), b])) })[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body,
});

/** A fake MCP server: handler(msg, headers) → response object; records every request. */
function fakeServer(handler) {
  const log = [];
  const fetch = async (url, init) => {
    const msg = init.body ? JSON.parse(init.body) : null;
    log.push({ url, method: init.method, headers: init.headers, msg });
    return handler(msg, init.headers, init);
  };
  return { fetch, log };
}

const initResult = { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };

describe('MCP client (REQ-AI-14)', () => {
  it('parses SSE events', () => {
    expect(parseSse('event: message\ndata: {"a":1}\n\n: comment\n\ndata: {"b":\ndata: 2}\n\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('initialises, keeps the session id and sends the version and bearer headers', async () => {
    const s = fakeServer((m) => {
      if (m?.method === 'initialize') return reply({ jsonrpc: '2.0', id: m.id, result: initResult }, { headers: { 'Mcp-Session-Id': 'S1' } });
      if (m?.method === 'notifications/initialized') return reply('', { status: 202 });
      if (m?.method === 'tools/list') return reply({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } });
      if (m?.method === 'tools/call') return reply(`data: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: m.params.arguments.s }] } })}\n\n`, { type: 'text/event-stream' });
      return reply('', { status: 405 });
    });
    const c = new McpClient({ url: 'https://mcp.example/mcp', fetch: s.fetch, token: () => 'TKN' });
    await c.connect();
    expect((await c.listTools()).map((t) => t.name)).toEqual(['echo']);
    expect((await c.callTool('echo', { s: 'hi' })).content[0].text).toBe('hi');
    expect(s.log[0].headers['Mcp-Session-Id']).toBeUndefined();
    expect(s.log[0].headers.Authorization).toBe('Bearer TKN');
    expect(s.log[1].headers['Mcp-Session-Id']).toBe('S1');
    expect(s.log[2].headers['MCP-Protocol-Version']).toBe(PROTOCOL_VERSION);
    await c.close();
    expect(s.log.at(-1).method).toBe('DELETE');
  });

  it('reports 401 so the app can ask for authorisation', async () => {
    const c = new McpClient({ url: 'https://mcp.example/mcp', fetch: async () => reply('', { status: 401 }) });
    await expect(c.connect()).rejects.toThrow(/authorisation/);
  });

  it('answers elicitation on the stream and returns the user content', async () => {
    let answered = null;
    const s = fakeServer((m) => {
      if (m?.method === 'tools/call') return reply([`data: ${JSON.stringify({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } } })}`, '', `data: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [] } })}`, '', ''].join('\n'), { type: 'text/event-stream' });
      if (m?.id === 'e1') {
        answered = m.result;
        return reply('', { status: 202 });
      }
      return reply('', { status: 202 });
    });
    const c = new McpClient({ url: 'https://x/mcp', fetch: s.fetch, onElicit: async (p) => ({ action: 'accept', content: { name: p.message === 'Name?' ? 'Ada' : '' } }) });
    await c.callTool('ask', {});
    expect(answered).toEqual({ action: 'accept', content: { name: 'Ada' } });
  });

  it('serves sampling only after two confirmations', async () => {
    const run = async (answers) => {
      let got = null;
      let sampled = 0;
      const confirms = [];
      const s = fakeServer((m) => {
        if (m?.method === 'tools/call') return reply(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 's1', method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }] } })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} })}\n\n`, { type: 'text/event-stream' });
        if (m?.id === 's1') got = m;
        return reply('', { status: 202 });
      });
      const c = new McpClient({
        url: 'https://x/mcp',
        fetch: s.fetch,
        confirm: async (t) => (confirms.push(t), answers.shift()),
        onSample: async () => (sampled++, { role: 'assistant', content: { type: 'text', text: 'ok' }, model: 'm' }),
      });
      await c.callTool('t', {});
      return { got, sampled, confirms };
    };
    const yes = await run([true, true]);
    expect(yes.confirms).toHaveLength(2);
    expect(yes.sampled).toBe(1);
    expect(yes.got.result.content.text).toBe('ok');
    const second = await run([true, false]);
    expect(second.sampled).toBe(0);
    expect(second.got.error.message).toMatch(/declined/);
    const first = await run([false]);
    expect(first.confirms).toHaveLength(1);
    expect(first.sampled).toBe(0);
  });

  it('PKCE S256 and the OAuth discovery, authorise and token steps', async () => {
    const { verifier, challenge, method } = await pkce();
    expect(method).toBe('S256');
    expect(verifier).toMatch(/^[\w-]{43}$/);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    expect(challenge).toBe(Buffer.from(digest).toString('base64url'));
    const calls = [];
    const f = async (url, init = {}) => {
      calls.push({ url, init });
      if (url === 'https://mcp.example/.well-known/oauth-protected-resource/mcp') return reply({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://auth.example'] });
      if (url === 'https://auth.example/.well-known/oauth-authorization-server') return reply({ authorization_endpoint: 'https://auth.example/authorize', token_endpoint: 'https://auth.example/token', code_challenge_methods_supported: ['S256'] });
      if (url === 'https://auth.example/token') return reply({ access_token: 'AT', token_type: 'Bearer' });
      return reply('', { status: 404 });
    };
    const meta = await discoverAuth('https://mcp.example/mcp', f);
    expect(meta.resource).toBe('https://mcp.example/mcp');
    const u = new URL(authorizeUrl(meta, { clientId: 'gw', redirectUri: 'http://localhost/cb', state: 'st', challenge, resource: meta.resource }));
    expect(u.origin + u.pathname).toBe('https://auth.example/authorize');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(challenge);
    expect(u.searchParams.get('resource')).toBe('https://mcp.example/mcp');
    const t = await exchangeCode(meta, { code: 'C', verifier, clientId: 'gw', redirectUri: 'http://localhost/cb', resource: meta.resource }, f);
    expect(t.access_token).toBe('AT');
    const body = new URLSearchParams(String(calls.at(-1).init.body));
    expect(body.get('code_verifier')).toBe(verifier);
    expect(body.get('grant_type')).toBe('authorization_code');
    await expect(discoverAuth('https://none.example/mcp', async () => reply('', { status: 404 }))).rejects.toThrow(/no OAuth/);
  });
});

describe('MCP server (REQ-AI-15)', () => {
  function rig() {
    const app = { store: new Store() };
    app.proposals = new Proposals(app);
    const reg = new Registry(app);
    reg.tool({ name: 'gw_read', title: 'Read', readOnly: true, inputSchema: { type: 'object', properties: {} }, run: () => ({ ok: 1 }) });
    reg.tool({ name: 'gw_rename', title: 'Rename', inputSchema: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] }, propose: ({ v }, tx) => (tx.set('project', 'name', v), { title: 'Rename' }) });
    reg.resource({ uri: 'gw://project', name: 'Project', mimeType: 'application/json', read: () => ({ name: app.store.get('project').name }) });
    app.store.transact('init', (tx) => tx.create('project', { name: 'A' }, 'project'));
    return { app, reg, server: createMcpServer(reg) };
  }

  it('initialize, tools/list, read calls, unknown methods and notifications', async () => {
    const { server } = rig();
    const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init.result.serverInfo.name).toBe('gis-workbench');
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.result.tools.map((t) => [t.name, t.annotations.readOnlyHint])).toEqual([['gw_read', true], ['gw_rename', false]]);
    const r = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gw_read', arguments: {} } });
    expect(JSON.parse(r.result.content[0].text)).toEqual({ ok: 1 });
    expect((await server.handle({ jsonrpc: '2.0', id: 4, method: 'nope' })).error.code).toBe(-32601);
    expect((await server.handle({ id: 5, method: 'x' })).error.code).toBe(-32600);
    const bad = await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'gw_rename', arguments: {} } });
    expect(bad.result.isError).toBe(true);
  });

  it('a write from an outside agent is a proposal with its origin as provenance', async () => {
    const { app, server } = rig();
    const r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gw_rename', arguments: { v: 'B' } } }, { origin: 'https://agent.example' });
    expect(r.result.structuredContent.status).toBe('pending');
    expect(app.store.get('project').name).toBe('A');
    const p = app.proposals.pending().find((x) => x.id === r.result.structuredContent.proposal);
    expect(p.provenance.source).toBe('mcp:https://agent.example');
    expect(app.proposals.accept(p.id)).toBe(true);
    expect(app.store.get('project').name).toBe('B');
    const res = await server.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'gw://project' } });
    expect(JSON.parse(res.result.contents[0].text)).toEqual({ name: 'B' });
  });

  it('the postMessage bridge answers allow-listed origins only', async () => {
    const { server } = rig();
    const listeners = [];
    const win = { addEventListener: (t, f) => listeners.push(f), removeEventListener: (t, f) => listeners.splice(listeners.indexOf(f), 1) };
    const posted = [];
    const source = { postMessage: (m, o) => posted.push({ m, o }) };
    const detach = attachBridge(win, server, { origins: () => ['https://agent.example'] });
    const send = (origin) => listeners[0]({ origin, source, data: { gwMcp: 1, message: { jsonrpc: '2.0', id: 1, method: 'ping' } } });
    await send('https://evil.example');
    expect(posted).toHaveLength(0);
    await send('https://agent.example');
    expect(posted).toEqual([{ m: { gwMcp: 1, message: { jsonrpc: '2.0', id: 1, result: {} } }, o: 'https://agent.example' }]);
    detach();
    expect(listeners).toHaveLength(0);
  });
});
