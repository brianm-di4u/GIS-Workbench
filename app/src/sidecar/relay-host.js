// The page's end of the Python relay (REQ-GAP-02, OD-2.20; lazy block js-relay). A script in the
// user's own Python talks to the sidecar on loopback; this page, once the analyst turns the relay
// on, long-polls the sidecar for its messages and answers them with its own MCP server, so a
// script gets exactly what an outside agent gets: read tools run, and every write is a Proposal
// the analyst accepts or rejects. The relay is off until turned on, stays off across reloads, and
// goes off for good when the sidecar stops answering. DOM-free, so it tests in Node.

/** The name a relay call carries in its provenance (`mcp:python-relay`). */
export const RELAY_SOURCE = 'python-relay';
/** A tool result through the relay; the assistant's cap is for a model's context, not a script. */
export const RESULT_CAP = 4_000_000;
/** The sidecar's limit on a reply (MAX_RELAY_REPLY). */
export const MAX_REPLY_BYTES = 8 << 20;
/** Writes a script may leave waiting; beyond this it is refused until the analyst catches up. */
export const MAX_PENDING_PROPOSALS = 200;
const KEEP_CALLS = 12;
const RETRIES = 3;

/**
 * Tools a script may name: the app's own. Tools of remote MCP servers joined to the registry
 * (`mcp__…`) would take the call, and the analyst's credentials for it, off this computer.
 */
export const relayTool = (name) => /^gw2?_/.test(String(name));

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export class RelayHost {
  /**
   * `client`: the page's SidecarClient. `serve(message, ctx)`: the MCP server. `toolDef(name)`:
   * the registry's tool. `pending()`: how many proposals wait. `name`: this page, for the sidecar
   * window. `onChange()`: state or log changed. `wait(ms)`: for tests.
   */
  constructor({ client, serve, toolDef, pending, name, onChange = () => {}, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    Object.assign(this, { client, serve, toolDef, pending, name, onChange, wait });
    this.on = false;
    this.session = null;
    this.error = null; // why it went off by itself
    this.calls = []; // newest first: {at, client, label, proposal}
    this.count = 0;
    this.ac = null;
  }

  async start() {
    if (this.on) return;
    this.error = null;
    const r = await this.client.request('POST', '/v1/relay/attach', { json: { client: this.name } });
    this.session = r.session;
    this.on = true;
    this.ac = new AbortController();
    this.onChange();
    this.loop = this.run(this.session, this.ac.signal);
  }

  /** Turn it off: the sidecar ends whatever still waits. */
  async stop() {
    if (!this.on) return;
    const session = this.session;
    this.on = false;
    this.session = null;
    this.ac.abort();
    this.onChange();
    await this.client.request('DELETE', `/v1/relay/${session}`).catch(() => {});
  }

  lost(e) {
    this.on = false;
    this.session = null;
    this.error = e;
    this.ac?.abort();
    this.onChange();
  }

  async run(session, signal) {
    let fails = 0;
    while (this.on && this.session === session) {
      try {
        const d = await this.client.request('GET', `/v1/relay/${session}/inbox`, { signal });
        fails = 0;
        // Answered side by side: a long read does not hold up the polling that keeps the relay alive.
        if (d) this.answer(session, d);
      } catch (e) {
        if (!this.on || this.session !== session) return;
        // Revoked, taken over or forgotten: off now. A connection error gets a few tries.
        if (e.status === 401 || e.status === 404 || ++fails >= RETRIES) return this.lost(e);
        await this.wait(500 * fails);
      }
    }
  }

  /** A refusal, or null. The sidecar checked the envelope; which tools are open is decided here. */
  refusal(m) {
    if (m.method !== 'tools/call') return null;
    const name = m.params?.name;
    if (!relayTool(name)) return rpcError(m.id, -32601, `tool "${String(name).slice(0, 64)}" is not available through the relay`);
    const def = this.toolDef(name);
    if (def && (!def.readOnly || def.proposeWhen) && this.pending() >= MAX_PENDING_PROPOSALS) return rpcError(m.id, -32000, `${MAX_PENDING_PROPOSALS} proposals are waiting for the analyst; try again when they have been decided`);
    return null;
  }

  async reply(d) {
    const m = d.message;
    const no = this.refusal(m);
    if (no) return no;
    const r = await this.serve(m, { origin: RELAY_SOURCE, client: d.client, resultCap: RESULT_CAP });
    if (m.method === 'tools/list' && r?.result?.tools) r.result.tools = r.result.tools.filter((t) => relayTool(t.name));
    return r;
  }

  async answer(session, d) {
    const m = d.message;
    let reply;
    try {
      reply = await this.reply(d);
    } catch (e) {
      reply = rpcError(m.id, -32603, e.message);
    }
    let body = JSON.stringify({ rid: d.rid, reply });
    if (new TextEncoder().encode(body).length > MAX_REPLY_BYTES - 1024) body = JSON.stringify({ rid: d.rid, reply: rpcError(m.id, -32001, `the reply is larger than the relay carries (${MAX_REPLY_BYTES} bytes)`) });
    this.count++;
    this.calls.unshift({ at: new Date(), client: d.client, label: m.method === 'tools/call' ? String(m.params?.name) : m.method, proposal: reply?.result?.structuredContent?.proposal ?? null });
    this.calls.length = Math.min(this.calls.length, KEEP_CALLS);
    this.onChange();
    if (session !== this.session) return; // turned off meanwhile: the sidecar has ended the call
    await this.client.request('POST', `/v1/relay/${session}/reply`, { body, headers: { 'Content-Type': 'application/json' } }).catch(() => {}); // the call may have timed out: nothing waits
  }
}
