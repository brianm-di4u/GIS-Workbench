// #227: AnthropicProvider through the real SDK, loaded by its lazy block, with a fake fetch. The AI
// browser suites run on MockProvider, so without this an SDK bump that broke the request, the
// streaming, the fallback route or cancelling would pass CI.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicProvider, DEFAULT_BASE_URL, keys } from '../../app/src/ai/providers.js';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MESSAGE = { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const STREAM_HEAD = [
  event('message_start', { message: { ...MESSAGE, content: [], stop_reason: null } }),
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hel' } }),
].join('');
const STREAM = [
  STREAM_HEAD,
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }),
  event('content_block_stop', { index: 0 }),
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
  event('message_stop', {}),
].join('');

/** A fetch that records each request and answers like the Messages API. */
function fakeFetch() {
  const requests = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: new URL(url), headers: new Headers(init.headers), body });
    return body.stream
      ? new Response(STREAM, { headers: { 'content-type': 'text/event-stream' } })
      : new Response(JSON.stringify(MESSAGE), { headers: { 'content-type': 'application/json' } });
  };
  return { fetch, requests };
}

const TOOL = { name: 'zoom_to', description: 'Zoom the map', input_schema: { type: 'object', properties: {} } };
const ask = { system: 'You help with maps.', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] };
const provider = (conn, fetch) => {
  keys.set(conn.id, 'test-key');
  return new AnthropicProvider({ name: 'Claude', provider: 'anthropic', model: 'claude-test', ...conn }, fetch);
};

let gw;
beforeAll(() => {
  // The app runs the SDK's lazy block on the first request; here the same module, from npm.
  gw = globalThis.__gw;
  globalThis.__gw = {
    runScript: async (name) => {
      await import('../../app/src/lazy/anthropic.lazy.js');
      return globalThis.__lib?.[name];
    },
  };
});
afterAll(() => {
  globalThis.__gw = gw;
});

describe('AnthropicProvider with the SDK', () => {
  it('a direct connection sends to the Claude API on the fallback route, with the key', async () => {
    const { fetch, requests } = fakeFetch();
    const reply = await provider({ id: 'direct', baseURL: '' }, fetch).send(ask);
    expect(reply.content[0].text).toBe('hello');
    const [r] = requests;
    expect(r.url.origin).toBe(DEFAULT_BASE_URL);
    expect(r.url.pathname).toBe('/v1/messages');
    // The SDK may send the key as x-api-key or as a bearer token; either way it is this connection's.
    expect(r.headers.get('x-api-key') ?? r.headers.get('authorization')?.replace(/^Bearer /, '')).toBe('test-key');
    expect(r.headers.get('anthropic-beta')).toContain(FALLBACK_BETA);
    expect(r.body).toMatchObject({ model: 'claude-test', max_tokens: 16000, fallbacks: 'default', output_config: { effort: 'medium' } });
    expect(r.body.stream).toBeFalsy();
    expect(r.body.tools[0].eager_input_streaming).toBeUndefined();
  });

  it('streams text to onText and returns the whole message, with tool inputs streamed eagerly', async () => {
    const { fetch, requests } = fakeFetch();
    const deltas = [];
    const reply = await provider({ id: 'direct-stream', baseURL: '' }, fetch).send({ ...ask, onText: (d) => deltas.push(d) });
    expect(deltas).toEqual(['hel', 'lo']);
    expect(reply.content[0].text).toBe('hello');
    expect(requests[0].body.stream).toBe(true);
    expect(requests[0].headers.get('anthropic-beta')).toContain(FALLBACK_BETA);
    expect(requests[0].body.tools[0].eager_input_streaming).toBe(true);
  });

  it('a connection with its own base URL uses the plain route, without the beta or fallbacks', async () => {
    const { fetch, requests } = fakeFetch();
    const deltas = [];
    await provider({ id: 'proxy', baseURL: 'https://proxy.example.test' }, fetch).send({ ...ask, onText: (d) => deltas.push(d) });
    const [r] = requests;
    expect(r.url.origin).toBe('https://proxy.example.test');
    expect(r.headers.get('anthropic-beta') ?? '').not.toContain(FALLBACK_BETA);
    expect(r.body.fallbacks).toBeUndefined();
    expect(r.body.tools[0].eager_input_streaming).toBeUndefined();
    expect(deltas.join('')).toBe('hello');
  });

  it('cancelling while the reply streams stops it and rejects', { timeout: 10_000 }, async () => {
    // The reply sends its first text, then waits; only the request's signal can end it.
    const fetch = async (url, init) => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(STREAM_HEAD));
          init.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    };
    const ac = new AbortController();
    const deltas = [];
    const onText = (d) => {
      deltas.push(d);
      ac.abort();
    };
    await expect(provider({ id: 'cancel-mid', baseURL: '' }, fetch).send({ ...ask, signal: ac.signal, onText })).rejects.toThrow(/abort/i);
    expect(deltas).toEqual(['hel']);
  });

  it('a request cancelled before it starts rejects, streamed or not', async () => {
    const { fetch } = fakeFetch();
    const p = provider({ id: 'cancel', baseURL: '' }, fetch);
    const signal = AbortSignal.abort();
    await expect(p.send({ ...ask, signal })).rejects.toThrow(/abort/i);
    await expect(p.send({ ...ask, signal, onText: () => {} })).rejects.toThrow(/abort/i);
  });
});
