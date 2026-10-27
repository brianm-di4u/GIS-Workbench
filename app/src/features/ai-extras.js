// AI extras (R1 Shoulds): Describe View (REQ-AI-09) sends a marked chip and its metadata and
// returns the answer as a draft observation (a Proposal); Ask About Selection (REQ-AI-01) puts the
// selected items in front of the assistant; help, TRE and error-budget tools give the assistant
// the offline help as context (REQ-AI-11); MCP Servers… connects remote MCP servers (REQ-AI-14)
// and Expose as MCP Server… serves the registry to outside agents (REQ-AI-15).

import { h, clear } from '../shell/dom.js';
import { modal, field, section, confirmBox, promptBox } from '../shell/dialogs.js';
import { McpClient, discoverAuth, pkce, authorizeUrl, exchangeCode } from '../ai/mcp-client.js';
import { createMcpServer, attachBridge, provideWebMcp } from '../ai/mcp-server.js';
import { cspAllows, originOf } from '../ai/netlog.js';
import { tokenValues } from '../products/tokens.js';
import { HELP_TOPICS, LIMITS_TEXT } from './dialogs.js';

export const name = 'ai-extras';

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const reg = app.registry;
  const pane = () => app.activePane();

  // ---- help, TREs and the error budget as assistant tools (REQ-AI-11) ----
  reg.tool({
    name: 'gw_help_search',
    title: 'Search the help',
    description: 'Search the offline help pages, the accuracy-and-limits statement and the command cue texts; returns the matching passages. Use them to answer how-to and accuracy questions.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    run: ({ query }) => {
      const words = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const docs = [...HELP_TOPICS.map(([t, b]) => ({ source: 'help', title: t, text: b })), ...LIMITS_TEXT.map(([t, b]) => ({ source: 'limits', title: t, text: b })), ...[...app.commands.map.values()].filter((c) => c.tip).map((c) => ({ source: 'command', title: c.label, text: c.tip }))];
      const scored = docs.map((d) => ({ ...d, score: words.reduce((s, w) => s + (`${d.title} ${d.text}`.toLowerCase().includes(w) ? 1 : 0), 0) })).filter((d) => d.score > 0);
      return scored.sort((a, b) => b.score - a.score).slice(0, 6);
    },
  });
  reg.tool({
    name: 'gw_explain_tres',
    title: 'TREs of an image',
    description: 'List the tagged record extensions (TREs) of a layer with their decoded fields, so you can explain them. Values come from the file.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { layer: { type: 'string' }, tag: { type: 'string' } }, additionalProperties: false },
    run: ({ layer, tag }) => {
      const l = layer ? app.layers.get(layer) : app.activeLayer();
      if (!l) throw new Error('no such layer; call gw_list_layers');
      const tres = (l.info.subheader?.tres ?? []).filter((t) => !tag || t.tag === tag);
      return tres.map((t) => ({ tag: t.tag, complete: t.complete !== false, fields: (t.fields ?? []).slice(0, 120) }));
    },
  });
  reg.tool({
    name: 'gw_error_budget',
    title: 'Error budget at a point',
    description: 'The error budget of a ground point: model, pick and DEM sigmas, CE90/LE90 and the method, at an image point (default: the view centre). Numbers come from the core.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false },
    run: ({ x, y }) => {
      const p = pane();
      const l = p?.geoLayer();
      if (!l?.modelId) throw new Error('the active image has no sensor model');
      const px = x ?? p.view.cx;
      const py = y ?? p.view.cy;
      const g = l.groundWithTerrain(px, py);
      const e = app.core.pointError(l.modelId, px, py, g.h, app.prefs.get('pickSigmaPx') ?? 0.5, g.sigmaV);
      return { model: l.modelName, point: { lat: g.lat, lon: g.lon, hae: g.h, heightSource: g.heightSource ?? null }, ce90: Number.isFinite(e.ce90) ? e.ce90 : 'error not available', le90: Number.isFinite(e.le90) ? e.le90 : 'error not available', sigma: { model: e.sigmaModel ?? e.sigmaH ?? null, bias: e.sigmaBias ?? null, random: e.sigmaRand ?? null, pick: e.sigmaPick ?? null, demHorizontal: e.sigmaDemH ?? null, demVertical: e.sigmaDemV ?? null }, gsd: e.gsd ?? null };
    },
  });

  // ---- Describe View (REQ-AI-09) ----
  /** Send a marked chip and metadata; the reply becomes a draft observation proposal. */
  app.describeView = async ({ question = 'Describe what this image shows that matters to an imagery analyst.' } = {}) => {
    const p = pane();
    const l = p?.geoLayer() ?? p?.activeLayer();
    if (!l) throw new Error('the panel has no image');
    const chip = await app.makeChip({ ...(app.chipViewOpts?.(p) ?? {}), width: 1024, height: 768 });
    const data = chip.canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
    const v = tokenValues({ app, layer: l, view: chip.view, marking: chip.record.marking.text });
    const meta = { image: v.IMAGE_ID, acquired: v.ACQ_DATE || null, sensor: v.SENSOR || null, centreMgrs: v.MGRS_CENTER || null, gsd: v.GSD || null, sun: v.SUN || null, obliquity: v.OBLIQUITY || null, model: v.MODEL || null, marking: chip.record.marking.text, scaleBarM: chip.record.scaleBar?.metres ?? null };
    const r = await app.ai.complete({
      system: 'You describe imagery for an analyst. Use only what is visible and the metadata given. Do not state measurements; say what should be measured. Start with the portion mark of the banner shown on the chip.',
      text: `${question}\n\nMetadata (from the file, not estimated):\n${JSON.stringify(meta, null, 1)}\n\nReply with one paragraph of observation and end with "Confidence: low|moderate|high".`,
      images: [{ data, mediaType: 'image/jpeg' }],
    });
    if (!r) return null;
    const conf = /confidence:\s*(low|moderate|high)/i.exec(r.text)?.[1]?.toLowerCase() ?? 'moderate';
    const text = r.text.replace(/\s*confidence:\s*(low|moderate|high)\.?\s*$/i, '').trim();
    const res = await reg.call('gw_add_observation', { text, confidence: conf }, { source: 'describe view', connection: r.connection, model: r.model });
    return { text, confidence: conf, proposal: res.proposal?.id ?? null, chip: chip.record };
  };
  C.implement('ai.describe', {
    enabled: () => !!pane()?.layers().length,
    run: async () => {
      try {
        const r = await app.describeView();
        if (r) app.toast('The description is a draft observation in AI Assistant ▸ Proposals; accept it to keep it');
      } catch (e) {
        app.toast(`Describe View: ${e.message}`, { kind: 'error' });
      }
    },
  });

  // ---- Ask About Selection (REQ-AI-01) ----
  app.selectionContext = () =>
    [...(app.selection ?? [])]
      .map((id) => S.get(id))
      .filter(Boolean)
      .slice(0, 50)
      .map((r) => {
        if (r.type === 'feature') return { kind: 'feature', id: r.id, name: r.name, geometry: r.geom.type, vertices: r.geom.xyz.length / 3, attrs: r.attrs, first: r.geom.xyz.slice(0, 3) };
        if (r.type === 'graphic') return { kind: 'graphic', id: r.id, shape: r.shape, text: r.text, anchor: r.anchor, coords: r.coords?.slice(0, 20) };
        if (r.type === 'measurement') return { kind: 'measurement', id: r.mid, type: r.mtype, value: r.value, units: r.units, ce90: r.ce90 };
        return { kind: r.type, id: r.id };
      });
  C.implement('ai.askselection', {
    enabled: () => (app.selection?.size ?? 0) > 0,
    run: async () => {
      const q = await promptBox('Ask About Selection', 'Question', 'What are these, and what should I check next?');
      if (!q) return;
      const c = app.ai.activeConnection();
      if (!c) return app.toast('Add an AI connection first (AI Assistant ▸ Connections)', { kind: 'warn' });
      if (!(await app.ai.assistant.consent(c, ({ title, message, ok }) => confirmBox(title, message, { ok, cancel: 'Cancel' })))) return;
      app.panels.show?.('ai', 'right');
      await app.ai.assistant.ask(q, { provider: app.ai.providerFor(c), conn: c, attachments: [{ type: 'text', label: 'Selected items (from the tool)', text: JSON.stringify(app.selectionContext(), null, 1) }] });
    },
  });

  // ---- MCP client (REQ-AI-14) ----
  const servers = () => app.prefs.get('mcpServers') ?? [];
  const clients = new Map(); // id → {client, tools}
  const tokens = new Map(); // id → token (memory only; never saved)
  app.mcpClients = clients;

  /** Connect a configured server and register its tools for the assistant. */
  app.connectMcp = async (srv, { fetchFn } = {}) => {
    if (!fetchFn && !cspAllows(srv.url)) throw new Error(`${originOf(srv.url)} is not in this file's network allow-list. Add it (Add-Ins ▸ Network Allow-List), save the new copy and reload.`);
    const f = fetchFn ?? app.netlog.fetchFor(`MCP: ${srv.name}`);
    const client = new McpClient({
      url: srv.url,
      fetch: f,
      token: () => tokens.get(srv.id) ?? null,
      confirm: (title, message) => confirmBox(title, message, { ok: 'Allow', cancel: 'Decline' }),
      onElicit: (params) => elicit(srv, params),
      onSample: async (params) => {
        const r = await app.ai.complete({ system: params.systemPrompt ?? '', text: (params.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : m.content?.text ?? '')).join('\n\n') });
        if (!r) throw new Error('no AI connection');
        return { role: 'assistant', content: { type: 'text', text: r.text }, model: r.model, stopReason: 'endTurn' };
      },
    });
    const info = await client.connect();
    const tools = await client.listTools();
    for (const t of tools) {
      const nm = `mcp__${srv.id}__${t.name}`.replace(/[^\w-]/g, '_').slice(0, 64);
      reg.tool({
        name: nm,
        title: `${srv.name}: ${t.title ?? t.name}`,
        description: `[MCP server ${srv.name}] ${t.description ?? ''}`,
        readOnly: true, // the registry runs it; a server write asks the user first (below)
        inputSchema: t.inputSchema ?? { type: 'object' },
        run: async (args) => {
          if (!t.annotations?.readOnlyHint && !(await confirmBox('MCP tool call', `The assistant wants to run "${t.name}" on ${srv.name}, which may change data there. Run it?`, { ok: 'Run', cancel: 'Cancel' }))) throw new Error('the user declined the call');
          const r = await client.callTool(t.name, args);
          return (r.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') || JSON.stringify(r.structuredContent ?? {});
        },
      });
    }
    clients.set(srv.id, { client, tools, info });
    app.emit('ai');
    return { info, tools };
  };

  /** Elicitation: a form built from the server's flat schema; accept, decline or cancel. */
  async function elicit(srv, params) {
    const props = params.requestedSchema?.properties ?? {};
    const inputs = {};
    const body = h('div', {}, h('p', {}, `${srv.name} asks: ${params.message ?? ''}`));
    for (const [k, s] of Object.entries(props)) {
      const inp = s.enum ? h('select', { class: 'inp', 'aria-label': s.title ?? k }, ...s.enum.map((v) => h('option', { value: v }, v))) : h('input', { class: 'inp', type: s.type === 'number' || s.type === 'integer' ? 'number' : s.type === 'boolean' ? 'checkbox' : 'text', 'aria-label': s.title ?? k });
      inputs[k] = { inp, s };
      body.appendChild(field(s.title ?? k, inp, s.description));
    }
    body.appendChild(h('p', { class: 'hint' }, 'Only what you type here is sent back to the server.'));
    const r = await modal({ title: 'MCP Request for Information', body, buttons: ['Send', 'Decline', 'Cancel'], id: 'mcp-elicit' });
    if (r === 'Decline') return { action: 'decline' };
    if (r !== 'Send') return { action: 'cancel' };
    const content = {};
    for (const [k, { inp, s }] of Object.entries(inputs)) content[k] = s.type === 'boolean' ? inp.checked : s.type === 'number' || s.type === 'integer' ? Number(inp.value) : inp.value;
    return { action: 'accept', content };
  }

  /** OAuth 2.1 with PKCE: open the authorisation page; the user pastes the returned code. */
  async function oauth(srv) {
    const f = app.netlog.fetchFor(`MCP auth: ${srv.name}`);
    const meta = await discoverAuth(srv.url, f);
    const { verifier, challenge } = await pkce();
    const state = crypto.randomUUID();
    const redirectUri = srv.redirectUri || (location.protocol.startsWith('http') ? location.href.split('#')[0] : 'urn:ietf:wg:oauth:2.0:oob');
    window.open(authorizeUrl(meta, { clientId: srv.clientId || 'gis-workbench', redirectUri, scope: srv.scope ?? '', state, challenge, resource: meta.resource }), '_blank', 'noopener');
    const code = await promptBox('OAuth Sign-In', 'Authorisation code', '', { hint: 'After signing in, copy the "code" value from the page or its address and paste it here.' });
    if (!code) return false;
    const t = await exchangeCode(meta, { code: code.trim(), verifier, clientId: srv.clientId || 'gis-workbench', redirectUri, resource: meta.resource }, f);
    tokens.set(srv.id, t.access_token);
    return true;
  }

  C.implement('ai.mcp', {
    run: async () => {
      const list = h('div', {});
      const render = () => {
        clear(list);
        for (const s of servers()) {
          const st = clients.has(s.id) ? `connected: ${clients.get(s.id).tools.length} tool(s)` : 'not connected';
          const con = h('button', { class: 'btn btn-small' }, clients.has(s.id) ? 'Disconnect' : 'Connect');
          con.addEventListener('click', async () => {
            if (clients.has(s.id)) {
              await clients.get(s.id).client.close();
              clients.delete(s.id);
              return render();
            }
            try {
              if (s.auth === 'bearer' && !tokens.has(s.id)) {
                const t = await promptBox('Bearer Token', `Token for ${s.name}`, '', { hint: 'Kept in memory for this session only.' });
                if (!t) return;
                tokens.set(s.id, t);
              }
              if (s.auth === 'oauth' && !tokens.has(s.id) && !(await oauth(s))) return;
              const r = await app.connectMcp(s);
              app.toast(`${s.name}: ${r.tools.length} tool(s) available to the assistant`);
            } catch (e) {
              app.toast(`${s.name}: ${e.message}`, { kind: 'error', ms: 8000 });
            }
            render();
          });
          const del = h('button', { class: 'btn btn-small' }, 'Remove');
          del.addEventListener('click', () => {
            app.prefs.set('mcpServers', servers().filter((x) => x.id !== s.id));
            tokens.delete(s.id);
            render();
          });
          list.appendChild(h('div', { class: 'wb-action' }, h('b', {}, s.name), h('span', { class: 'hint' }, ` ${s.url} · ${s.auth} · ${st} `), con, del));
        }
        if (!servers().length) list.appendChild(h('p', { class: 'muted' }, 'No MCP servers yet.'));
      };
      const nm = h('input', { class: 'inp', placeholder: 'Name', 'aria-label': 'Server name' });
      const url = h('input', { class: 'inp', placeholder: 'https://example.org/mcp', 'aria-label': 'Server URL' });
      const auth = h('select', { class: 'inp', 'aria-label': 'Authorisation' }, h('option', { value: 'none' }, 'None'), h('option', { value: 'bearer' }, 'Bearer token'), h('option', { value: 'oauth' }, 'OAuth 2.1 (PKCE)'));
      const add = h('button', { class: 'btn' }, 'Add');
      add.addEventListener('click', () => {
        try {
          new URL(url.value);
        } catch {
          return app.toast('Enter the server URL', { kind: 'warn' });
        }
        app.prefs.set('mcpServers', [...servers(), { id: `mcp${Date.now().toString(36)}`, name: nm.value || originOf(url.value), url: url.value, auth: auth.value }]);
        render();
      });
      render();
      await modal({ title: 'MCP Servers', body: h('div', {}, list, section('Add a server', field('Name', nm), field('URL (Streamable HTTP)', url), field('Authorisation', auth), add), h('p', { class: 'hint' }, 'Remote tools join the assistant. A tool that may change data on the server asks you before each call; sampling requests need two confirmations; tokens stay in memory.')), buttons: ['Close'], width: 640, id: 'mcp-servers' });
    },
  });

  // ---- MCP server (REQ-AI-15) ----
  const server = createMcpServer(reg);
  app.mcp = { handle: (msg) => server.handle(msg, { source: 'console' }), listTools: () => reg.listTools(), callTool: (name, args) => server.handle({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }, { source: 'console' }) };
  const bridgeCfg = () => ({ on: false, origins: [], ...(app.prefs.get('mcpBridge') ?? {}) });
  let detach = null;
  const applyBridge = () => {
    detach?.();
    detach = null;
    if (bridgeCfg().on) detach = attachBridge(window, server, { origins: () => bridgeCfg().origins });
  };
  applyBridge();
  app.setMcpBridge = (cfg) => {
    app.prefs.set('mcpBridge', { ...bridgeCfg(), ...cfg });
    applyBridge();
  };
  app.webMcp = provideWebMcp(navigator, reg);
  C.implement('auto.mcpserver', {
    run: async () => {
      const c = bridgeCfg();
      const on = h('input', { type: 'checkbox', checked: c.on, 'aria-label': 'Answer postMessage MCP requests' });
      const origins = h('textarea', { class: 'inp mono', rows: '3', 'aria-label': 'Allowed origins' }, c.origins.join('\n'));
      const body = h('div', {}, h('label', { class: 'fld fld-inline' }, on, h('span', {}, 'Answer MCP requests sent by postMessage')), field('Allowed origins (one per line)', origins, 'Exact origins such as https://agent.example.org. Messages from other origins are ignored.'), h('p', { class: 'hint' }, `Console: window.gisworkbench.mcp.handle({jsonrpc: "2.0", id: 1, method: "tools/list"}). WebMCP: ${app.webMcp ? 'offered to this browser' : 'not available in this browser'}. Writes from outside agents become Proposals that you accept or reject.`));
      if ((await modal({ title: 'Expose as MCP Server', body, buttons: ['OK', 'Cancel'], id: 'mcp-server' })) !== 'OK') return;
      app.setMcpBridge({ on: on.checked, origins: origins.value.split(/\s+/).map((s) => s.trim()).filter(Boolean) });
    },
  });
}
