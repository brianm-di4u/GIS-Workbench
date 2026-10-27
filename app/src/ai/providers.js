// AI providers (REQ-AI-02/03/07). The default is the Anthropic Messages API through the
// official SDK, sending requests only through the logging, CSP-checked fetch. A mock
// provider serves tests and offline demos. API keys are held in memory (or sessionStorage
// when the user asks) and never written to localStorage, projects, products or exports.

import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
// The default model id is a build setting (REQ-AI-02).
export const DEFAULT_MODEL = typeof __DEFAULT_MODEL__ === 'string' ? __DEFAULT_MODEL__ : 'claude-opus-5-5';

const memKeys = new Map();
const SS = 'gisworkbench.ai.key.';

export const keys = {
  set(connId, key, { session = false } = {}) {
    memKeys.set(connId, key);
    try {
      if (session) sessionStorage.setItem(SS + connId, key);
      else sessionStorage.removeItem(SS + connId);
    } catch {
      /* sessionStorage blocked: memory only */
    }
  },
  get(connId) {
    if (memKeys.has(connId)) return memKeys.get(connId);
    try {
      const k = sessionStorage.getItem(SS + connId);
      if (k) memKeys.set(connId, k);
      return k;
    } catch {
      return null;
    }
  },
  clear(connId) {
    memKeys.delete(connId);
    try {
      sessionStorage.removeItem(SS + connId);
    } catch {}
  },
  has(connId) {
    return !!this.get(connId);
  },
};

export class AnthropicProvider {
  constructor(conn, fetchFn) {
    this.conn = conn;
    this.client = new Anthropic({
      apiKey: keys.get(conn.id),
      baseURL: conn.baseURL || DEFAULT_BASE_URL,
      dangerouslyAllowBrowser: true, // the key is the user's own, held in memory, sent only to their origin
      fetch: fetchFn,
      maxRetries: 2,
    });
  }

  get model() {
    return this.conn.model || DEFAULT_MODEL;
  }

  /**
   * One Messages request. With `onText` the response streams (REQ-AI-16): text deltas go to
   * `onText(delta)` as they arrive and the final message is returned as without streaming.
   * The `signal` cancels either form.
   */
  async send({ system, messages, tools, signal, onText = null }) {
    const direct = !this.conn.baseURL || this.conn.baseURL === DEFAULT_BASE_URL;
    const params = {
      model: this.model,
      max_tokens: 16000,
      system,
      messages,
      // Streamed tool inputs arrive as generated; the registry validates every input against
      // its schema before a tool runs, and the assistant stops on max_tokens before tools.
      tools: onText && direct ? tools.map((t) => ({ ...t, eager_input_streaming: true })) : tools,
      output_config: { effort: this.conn.effort || 'medium' },
    };
    const fallback = this.conn.fallbacks !== false && direct;
    // Server-side refusal fallback, routed by category (Claude API only).
    const body = fallback ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : params;
    const api = fallback ? this.client.beta.messages : this.client.messages;
    if (!onText) return api.create(body, { signal });
    const stream = api.stream(body, { signal });
    stream.on('text', (delta) => onText(delta));
    return stream.finalMessage();
  }
}

/**
 * Deterministic offline provider for tests and demos. `script` is a queue of responses (or
 * functions of the request); without a script it answers from simple rules.
 */
export class MockProvider {
  constructor(conn) {
    this.conn = conn;
    this.script = [];
    this.requests = [];
  }

  get model() {
    return 'mock-model';
  }

  async send(req) {
    const r = await this.reply(req);
    // Streaming: the text arrives in small pieces, and the signal stops it part-way.
    if (req.onText)
      for (const b of r.content.filter((x) => x.type === 'text'))
        for (let i = 0; i < b.text.length; i += 8) {
          if (req.signal?.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
          req.onText(b.text.slice(i, i + 8));
          await new Promise((res) => setTimeout(res, this.delayMs ?? 0));
        }
    if (req.signal?.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
    return r;
  }

  async reply(req) {
    this.requests.push(structuredClone({ system: req.system, messages: req.messages, tools: req.tools?.map((t) => t.name) }));
    const next = this.script.shift();
    if (next) return typeof next === 'function' ? next(req) : next;
    const last = req.messages.at(-1);
    const hasToolResults = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    const text = typeof last.content === 'string' ? last.content : last.content.map((b) => b.text ?? '').join(' ');
    if (!hasToolResults && /graphic|draw|mark|propose/i.test(text)) {
      return { id: 'mock1', role: 'assistant', model: 'mock-model', stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will look at the view first.' }, { type: 'tool_use', id: 'tu_view', name: 'gw_get_view', input: {} }], usage: {} };
    }
    if (hasToolResults) {
      const r = last.content.find((b) => b.type === 'tool_result');
      if (r?.tool_use_id === 'tu_view') {
        let centre = null;
        try {
          centre = JSON.parse(r.content).centre;
        } catch {}
        if (centre) return { id: 'mock2', role: 'assistant', model: 'mock-model', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_draw', name: 'gw_create_graphic', input: { shape: 'marker', coordinates: [[centre.lon, centre.lat]], text: 'Area of interest (AI proposal)' } }], usage: {} };
      }
      return { id: 'mock3', role: 'assistant', model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: 'I proposed a marker at the view centre. Accept or reject it in the Proposals list.' }], usage: {} };
    }
    return { id: 'mock0', role: 'assistant', model: 'mock-model', stop_reason: 'end_turn', content: [{ type: 'text', text: `Mock reply: I can list layers, read the view and propose graphics. You said: ${text.slice(0, 200)}` }], usage: {} };
  }
}
