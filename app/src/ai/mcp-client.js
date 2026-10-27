// MCP client over Streamable HTTP (REQ-AI-14): JSON-RPC 2.0 POSTs answered with JSON or an
// SSE stream, the session id and protocol version headers, bearer or OAuth 2.1 (PKCE S256)
// authorisation, server-to-client requests for elicitation (a form the user fills) and sampling
// (served only after two separate confirmations), and ping. DOM-free, so it tests in Node; the
// app gives it the logged, allow-listed fetch.

export const PROTOCOL_VERSION = '2025-06-18';

/** Parse a text/event-stream body into the JSON payloads of its `data:` events. */
export function parseSse(text) {
  const out = [];
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data.trim()) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* not JSON: ignore */
    }
  }
  return out;
}

const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** PKCE pair: a random verifier and its S256 challenge. */
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge, method: 'S256' };
}

/** OAuth discovery: protected-resource metadata, then the authorisation server's metadata. */
export async function discoverAuth(serverUrl, fetchFn) {
  const u = new URL(serverUrl);
  const pr = await fetchFn(`${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`).then((r) => (r.ok ? r.json() : null), () => null);
  const issuer = pr?.authorization_servers?.[0] ?? u.origin;
  const iu = new URL(issuer);
  const meta = await fetchFn(`${iu.origin}/.well-known/oauth-authorization-server${iu.pathname === '/' ? '' : iu.pathname}`).then((r) => (r.ok ? r.json() : null), () => null);
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) throw new Error('the server publishes no OAuth authorisation metadata');
  if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes('S256')) throw new Error('the authorisation server does not offer PKCE S256');
  return { resource: pr?.resource ?? serverUrl, ...meta };
}

export function authorizeUrl(meta, { clientId, redirectUri, scope = '', state, challenge, resource }) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, ...(scope ? { scope } : {}), ...(resource ? { resource } : {}) });
  return `${meta.authorization_endpoint}?${q}`;
}

export async function exchangeCode(meta, { code, verifier, clientId, redirectUri, resource }, fetchFn) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri, ...(resource ? { resource } : {}) });
  const r = await fetchFn(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`token exchange failed (${r.status})`);
  const t = await r.json();
  if (!t.access_token) throw new Error('the token response has no access token');
  return t;
}

export class McpClient {
  /**
   * opts: url, fetch, token() → bearer token or null, onElicit(params) → {action, content},
   * onSample(params) → CreateMessageResult, confirm(title, message) → bool, clientInfo.
   */
  constructor(opts) {
    this.o = opts;
    this.url = opts.url;
    this.session = null;
    this.version = PROTOCOL_VERSION;
    this.next = 1;
    this.server = null;
  }

  headers() {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.session) h['Mcp-Session-Id'] = this.session;
    if (this.server) h['MCP-Protocol-Version'] = this.version;
    const t = this.o.token?.();
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }

  async post(msg) {
    const r = await this.o.fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(msg) });
    if (r.status === 401) throw Object.assign(new Error('the MCP server needs authorisation (401)'), { status: 401 });
    if (r.status === 404 && this.session) throw new Error('the MCP session expired');
    if (!r.ok && r.status !== 202) throw new Error(`MCP server error ${r.status}`);
    const sid = r.headers.get('Mcp-Session-Id') ?? r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (r.status === 202) return [];
    const ct = r.headers.get('Content-Type') ?? '';
    const text = await r.text();
    if (!text.trim()) return [];
    if (ct.includes('text/event-stream')) return parseSse(text);
    const j = JSON.parse(text);
    return Array.isArray(j) ? j : [j];
  }

  /** One request; server requests arriving on the stream are answered on the way. */
  async request(method, params) {
    const id = this.next++;
    const msgs = await this.post({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
    let result;
    for (const m of msgs) {
      if (m.id === id && ('result' in m || 'error' in m)) result = m;
      else if (m.method && m.id !== undefined) await this.serve(m);
    }
    if (!result) throw new Error(`no reply to ${method}`);
    if (result.error) throw Object.assign(new Error(`${method}: ${result.error.message}`), { code: result.error.code });
    return result.result;
  }

  notify(method, params) {
    return this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  /** Answer a server-to-client request (elicitation, sampling, ping). */
  async serve(m) {
    let reply;
    try {
      if (m.method === 'ping') reply = { result: {} };
      else if (m.method === 'elicitation/create') {
        const r = this.o.onElicit ? await this.o.onElicit(m.params) : { action: 'decline' };
        reply = { result: r };
      } else if (m.method === 'sampling/createMessage') {
        // Two separate confirmations before any prompt reaches the user's AI provider.
        const who = this.server?.serverInfo?.name ?? this.url;
        const ok1 = await this.o.confirm?.('MCP sampling request', `The MCP server "${who}" asks your AI provider to generate a reply. Allow?`);
        const ok2 = ok1 && (await this.o.confirm?.('Confirm sampling', `Send the server's prompt (${JSON.stringify(m.params?.messages ?? []).length} characters) to your AI provider now?`));
        reply = ok2 && this.o.onSample ? { result: await this.o.onSample(m.params) } : { error: { code: -1, message: 'the user declined the sampling request' } };
      } else reply = { error: { code: -32601, message: `method ${m.method} not supported` } };
    } catch (e) {
      reply = { error: { code: -32603, message: e.message } };
    }
    await this.post({ jsonrpc: '2.0', id: m.id, ...reply });
  }

  async connect() {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: { elicitation: {}, sampling: {} }, clientInfo: this.o.clientInfo ?? { name: 'GIS Workbench', version: '1' } });
    this.server = r;
    this.version = r.protocolVersion ?? PROTOCOL_VERSION;
    await this.notify('notifications/initialized');
    return r;
  }

  async listTools() {
    const out = [];
    let cursor;
    for (let i = 0; i < 20; i++) {
      const r = await this.request('tools/list', cursor ? { cursor } : undefined);
      out.push(...(r.tools ?? []));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args ?? {} });
  }

  async close() {
    if (!this.session) return;
    try {
      await this.o.fetch(this.url, { method: 'DELETE', headers: this.headers() });
    } catch {
      /* the server may not support DELETE */
    }
    this.session = null;
  }
}
