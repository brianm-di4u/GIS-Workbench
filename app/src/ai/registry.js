// MCP-shaped capability registry (REQ-AI-06, REQ-ARC-17/18): tools, resources and prompts
// declared once and shared by the assistant, the Prompt Helper and (R1) the MCP server.
// Read tools run directly. Write tools run as a dry run against the store and become a
// Proposal the user accepts or rejects; a proposal whose basis changed is marked stale.

import { Emitter, newId } from '../core/util.js';

const RESULT_CAP = 20000; // characters returned to a model per tool call (REQ-AI-07)

export class Registry {
  constructor(app) {
    this.app = app;
    this.tools = new Map();
    this.resources = new Map();
    this.prompts = new Map();
  }

  tool(def) {
    // def: {name, title, description, inputSchema, readOnly, run(args, ctx), propose?(args, tx, ctx),
    // action?(args, ctx) → {title, preview, run()}: an effect outside the store (REQ-ARC-18)}
    this.tools.set(def.name, def);
  }

  resource(def) {
    this.resources.set(def.uri, def);
  }

  prompt(def) {
    this.prompts.set(def.name, def);
  }

  listTools() {
    return [...this.tools.values()].map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !!t.readOnly } }));
  }

  /** Validate args against a (small) JSON schema subset: required, types, enum, bounds. */
  validate(schema, args) {
    const errs = [];
    if (schema?.type === 'object') {
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return ['arguments must be an object'];
      for (const r of schema.required ?? []) if (args[r] === undefined) errs.push(`missing "${r}"`);
      for (const [k, v] of Object.entries(args)) {
        const p = schema.properties?.[k];
        if (!p) {
          if (schema.additionalProperties === false) errs.push(`unknown argument "${k}"`);
          continue;
        }
        const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
        const want = p.type;
        if (want && !(want === t || (want === 'integer' && t === 'number' && Number.isInteger(v)) || (Array.isArray(want) && want.includes(t)))) errs.push(`"${k}" must be ${want}`);
        if (p.enum && !p.enum.includes(v)) errs.push(`"${k}" must be one of ${p.enum.join(', ')}`);
        if (typeof v === 'number' && ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum))) errs.push(`"${k}" is out of range`);
      }
    }
    return errs;
  }

  /**
   * Call a tool. Returns {content: string, isError?, proposal?}. `ctx` carries provenance
   * ({source: 'assistant'|'prompt-helper'|'mcp', connection, model}).
   */
  async call(name, args = {}, ctx = {}) {
    const t = this.tools.get(name);
    if (!t) return { content: `unknown tool "${name}"`, isError: true };
    const errs = this.validate(t.inputSchema, args);
    if (errs.length) return { content: `invalid arguments: ${errs.join('; ')}`, isError: true };
    try {
      if (t.readOnly) {
        const out = await t.run(args, ctx);
        const s = typeof out === 'string' ? out : JSON.stringify(out);
        return { content: s.length > RESULT_CAP ? `${s.slice(0, RESULT_CAP)}… [truncated ${s.length - RESULT_CAP} characters]` : s };
      }
      const proposal = this.app.proposals.create(t, args, ctx);
      return { content: `Proposal ${proposal.id} created: "${proposal.title}". It waits for the user to accept or reject it; nothing has changed yet.`, proposal };
    } catch (e) {
      return { content: `tool error: ${e.message}`, isError: true };
    }
  }

  async readResource(uri) {
    const r = this.resources.get(uri);
    if (!r) throw new Error(`unknown resource ${uri}`);
    return r.read();
  }
}

export class Proposals extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.items = [];
    this.autoApply = false; // off by default (REQ-AI-06)
    app.store.on('commit', () => this.refreshStale());
  }

  create(tool, args, ctx) {
    const app = this.app;
    let title = tool.title ?? tool.name;
    let preview = '';
    if (tool.action) {
      // An action proposal: a described effect that runs only when the user accepts it.
      const a = tool.action(args, ctx);
      const p = { id: newId('prop'), tool: tool.name, args, title: a.title ?? title, preview: a.preview ?? '', cs: null, run: a.run, status: 'pending', created: new Date().toISOString(), provenance: { kind: 'ai', source: ctx.source ?? 'assistant', connection: ctx.connection ?? null, model: ctx.model ?? null, time: new Date().toISOString() } };
      this.items.unshift(p);
      this.emit('change');
      if (this.autoApply) this.accept(p.id);
      return p;
    }
    const cs = app.store.dryRun(`AI: ${title}`, (tx) => {
      const r = tool.propose(args, tx, ctx);
      if (r?.title) title = r.title;
      if (r?.preview) preview = r.preview;
    });
    if (!cs) throw new Error('the proposal would change nothing');
    const p = {
      id: newId('prop'),
      tool: tool.name,
      args,
      title,
      preview,
      cs,
      status: 'pending',
      created: new Date().toISOString(),
      provenance: { kind: 'ai', source: ctx.source ?? 'assistant', connection: ctx.connection ?? null, model: ctx.model ?? null, time: new Date().toISOString() },
    };
    this.items.unshift(p);
    this.emit('change');
    if (this.autoApply) this.accept(p.id);
    return p;
  }

  refreshStale() {
    let changed = false;
    for (const p of this.items) {
      if (p.status === 'pending' && p.cs && !this.app.store.isCurrent(p.cs)) {
        p.status = 'stale';
        changed = true;
      }
    }
    if (changed) this.emit('change');
  }

  accept(id) {
    const p = this.items.find((x) => x.id === id);
    if (!p || p.status !== 'pending') return false;
    if (p.run) {
      p.status = 'running';
      this.emit('change');
      p.result = Promise.resolve()
        .then(() => p.run())
        .then(
          (r) => {
            p.status = 'accepted';
            p.outcome = r === undefined ? 'done' : typeof r === 'string' ? r : JSON.stringify(r).slice(0, 2000);
            this.emit('change');
            return r;
          },
          (e) => {
            p.status = 'failed';
            p.outcome = e.message;
            this.emit('change');
            throw e;
          },
        );
      p.result.catch(() => {});
      return true;
    }
    if (!this.app.store.isCurrent(p.cs)) {
      p.status = 'stale';
      this.emit('change');
      return false;
    }
    // Provenance rides on the change set and on every created record (REQ-AI-17).
    for (const o of p.cs.ops) if (o.op === 'create') o.rec.provenance = p.provenance;
    this.app.store.applyChangeSet(p.cs, { label: p.cs.label, author: 'ai', provenance: p.provenance, kind: 'edit' });
    p.status = 'accepted';
    this.emit('change');
    this.app.renderer?.invalidate();
    for (const mp of this.app.desktop?.multiports ?? []) for (const pane of mp.panes) pane.invalidate();
    return true;
  }

  reject(id) {
    const p = this.items.find((x) => x.id === id);
    if (!p || p.status !== 'pending') return false;
    p.status = 'rejected';
    this.emit('change');
    return true;
  }

  pending() {
    return this.items.filter((p) => p.status === 'pending');
  }
}
