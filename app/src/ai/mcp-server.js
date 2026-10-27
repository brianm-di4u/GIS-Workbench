// The registry as an MCP server (REQ-AI-15): one JSON-RPC 2.0 dispatcher (initialize, ping,
// tools/list, tools/call, resources/list, resources/read, prompts/list) used by the console API,
// a postMessage bridge that answers only allow-listed origins, and WebMCP where the browser
// offers navigator.modelContext. Writes from outside agents become Proposals, like the
// assistant's: nothing changes until the analyst accepts.

export const SERVER_INFO = { name: 'gis-workbench', version: '1' };

export function createMcpServer(reg, { protocolVersion = '2025-06-18' } = {}) {
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  /** Handle one JSON-RPC message; returns the response (null for notifications). */
  async function handle(msg, ctx = {}) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id ?? null, -32600, 'invalid request');
    const { id, method, params = {} } = msg;
    const note = id === undefined || id === null;
    try {
      let result;
      switch (method) {
        case 'initialize':
          result = { protocolVersion: params.protocolVersion ?? protocolVersion, capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} }, serverInfo: SERVER_INFO, instructions: 'GIS Workbench tools. Write tools create proposals that the analyst accepts or rejects; numbers come from the tool, not the model.' };
          break;
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: reg.listTools() };
          break;
        case 'tools/call': {
          const r = await reg.call(params.name, params.arguments ?? {}, { source: `mcp:${ctx.origin ?? ctx.source ?? 'console'}`, connection: ctx.origin ?? 'console', model: ctx.client ?? 'external agent' });
          result = { content: [{ type: 'text', text: r.content }], isError: !!r.isError, ...(r.proposal ? { structuredContent: { proposal: r.proposal.id, status: 'pending' } } : {}) };
          break;
        }
        case 'resources/list':
          result = { resources: [...reg.resources.values()].map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType })) };
          break;
        case 'resources/read': {
          const v = await reg.readResource(params.uri);
          result = { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(v) }] };
          break;
        }
        case 'prompts/list':
          result = { prompts: [...reg.prompts.values()].map((p) => ({ name: p.name, description: p.description, arguments: p.arguments ?? [] })) };
          break;
        default:
          return note ? null : err(id, -32601, `method ${method} not found`);
      }
      return note ? null : ok(id, result);
    } catch (e) {
      return note ? null : err(id, -32603, e.message);
    }
  }
  return { handle };
}

/**
 * postMessage bridge: messages {gwMcp: 1, message} from allow-listed origins get a reply
 * {gwMcp: 1, message} posted back to that origin only. Returns a detach function.
 */
export function attachBridge(win, server, { origins }) {
  const onMsg = async (e) => {
    const d = e.data;
    if (!d || d.gwMcp !== 1 || !d.message) return;
    const allowed = origins();
    if (!allowed.includes(e.origin)) return; // silently ignored: never answer an unlisted origin
    const reply = await server.handle(d.message, { origin: e.origin });
    if (reply && e.source) e.source.postMessage({ gwMcp: 1, message: reply }, e.origin === 'null' ? '*' : e.origin);
  };
  win.addEventListener('message', onMsg);
  return () => win.removeEventListener('message', onMsg);
}

/** WebMCP (where the browser has navigator.modelContext): offer the tools with executors. */
export function provideWebMcp(nav, reg) {
  const mc = nav?.modelContext;
  if (!mc?.provideContext) return false;
  mc.provideContext({
    tools: reg.listTools().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
      execute: async (args) => {
        const r = await reg.call(t.name, args ?? {}, { source: 'webmcp', connection: 'browser agent', model: 'external agent' });
        return { content: [{ type: 'text', text: r.content }], isError: !!r.isError };
      },
    })),
  });
  return true;
}
