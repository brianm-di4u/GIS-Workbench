// The assistant's conversation and tool-use loop (REQ-AI-04/07/17, D30): consent before the
// first request of a session, up to 16 turns, pause_turn resume, refusal handling, tool results capped by the registry,
// provenance on everything produced.

import { Emitter } from '../core/util.js';
import { t, N_, msgOf, locale, langOf } from '../i18n/index.js';
import LOCALES from '../i18n/locales.json';

export const MAX_TURNS = 16;

export const SYSTEM_PROMPT = `You are the assistant inside GIS Workbench, an offline imagery analysis and photogrammetry tool for civilian use.

How to work:
- Use the gw_* tools to read the project (layers, view, metadata, Mensuration Log, feedback pages) before answering questions about it.
- Every coordinate, distance, area, height and error figure you state must come from a tool result. Never compute, estimate or invent a measurement, coordinate or accuracy value yourself; if no tool gives it, say the analyst should measure it with the Mensuration tools.
- Changes you want (graphics, image-chain settings, observations) are made with write tools. They become proposals that the analyst accepts or rejects; say so plainly and do not claim they are done.
- Be concise and use the analyst's terms (image chain, DRA, MGRS, CE90/LE90, NIIRS).`;

/**
 * REQ-L10N-19: the prompt and the tool descriptions stay English; the model is told the UI
 * language so that it answers in it. Nothing is added for English, nor for a pseudo-locale.
 */
export function languageLine(tag = locale()) {
  if (!tag || langOf(tag) === 'en') return '';
  const reg = LOCALES.locales ?? [];
  const lower = String(tag).toLowerCase();
  const hit = reg.find((l) => l.tag.toLowerCase() === lower) ?? reg.find((l) => langOf(l.tag) === langOf(tag));
  if (!hit) return '';
  return `The user's interface language is ${hit.english} (${hit.tag}); answer in that language unless asked otherwise.`;
}

/** The system prompt of a request: SYSTEM_PROMPT, plus the UI language when it is not English. */
export function systemPrompt(tag = locale()) {
  const line = languageLine(tag);
  return line ? `${SYSTEM_PROMPT}\n${line}` : SYSTEM_PROMPT;
}

/** A stop by the user: the request's signal, an AbortError, the SDK's APIUserAbortError or the code E_ABORTED (never the message text, DN-62 L0). */
const aborted = (e, controller) => !!controller?.signal.aborted || e?.name === 'AbortError' || e?.name === 'APIUserAbortError' || e?.code === 'E_ABORTED';

export class Assistant extends Emitter {
  constructor(app, registry) {
    super();
    this.app = app;
    this.reg = registry;
    this.messages = [];
    this.transcript = []; // display items
    this.consented = false;
    this.busy = false;
    this.controller = null;
  }

  toolsForModel() {
    return this.reg.listTools().map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }

  /** REQ-AI-04: consent per session. */
  async consent(conn, confirm) {
    if (this.consented) return true;
    const ok = await confirm({
      title: t('Send to an AI provider?'),
      message: t('Your message, the tool results the assistant asks for (layer lists, metadata, view centre, Mensuration Log rows) and any chip you attach will be sent to {url} ({name}, model {model}). Nothing is sent until you agree. This consent lasts until you reload the file.', { url: conn.baseURL || 'https://api.anthropic.com', name: conn.name, model: conn.model }),
      ok: t('Agree and send'),
    });
    if (!ok) return false;
    this.consented = true;
    return true;
  }

  stop() {
    this.controller?.abort();
  }

  /**
   * Send one user message and run the tool loop. `provider` is an AnthropicProvider or
   * MockProvider; `ctx` carries the connection for provenance.
   */
  async ask(text, { provider, conn, attachments = [] }) {
    if (this.busy) throw new Error('the assistant is still working');
    this.busy = true;
    this.controller = new AbortController();
    const start = this.messages.length;
    const content = [];
    for (const a of attachments) if (a.type === 'image') content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: a.data } });
    content.push({ type: 'text', text: attachments.filter((a) => a.type === 'text').map((a) => `${a.label}:\n${a.text}\n\n`).join('') + text });
    this.messages.push({ role: 'user', content });
    this.transcript.push({ who: 'user', text });
    this.emit('change');
    const ctx = { source: 'assistant', connection: conn.name, model: provider.model };
    try {
      let continuations = 0;
      for (let turn = 1; turn <= MAX_TURNS; turn++) {
        // The reply streams into a live transcript entry (REQ-AI-16); Stop cancels it.
        const live = { who: 'ai', text: '', streaming: true };
        let shown = 0;
        const onText = this.stream === false ? null : (d) => {
          if (!live.text) this.transcript.push(live);
          live.text += d;
          const now = performance.now();
          if (now - shown > 50) {
            shown = now;
            this.emit('change');
          }
        };
        let resp;
        try {
          resp = await provider.send({ system: systemPrompt(), messages: this.messages, tools: this.toolsForModel(), signal: this.controller.signal, onText });
        } finally {
          const k = this.transcript.indexOf(live);
          if (k >= 0) this.transcript.splice(k, 1);
          if (this.controller?.signal.aborted && live.text) this.transcript.push({ who: 'ai', text: `${live.text} …`, partial: true });
        }
        // Append the full content (thinking, fallback and tool blocks are kept as returned).
        this.messages.push({ role: 'assistant', content: resp.content });
        const prov = { connection: conn.name, model: resp.model ?? provider.model, time: new Date().toISOString(), label: N_('AI-drafted') };
        for (const b of resp.content) {
          if (b.type === 'text' && b.text.trim()) this.transcript.push({ who: 'ai', text: b.text, provenance: prov });
          if (b.type === 'fallback') this.transcript.push({ who: 'sys', text: t('{from} declined; {to} continued.', { from: String(b.from?.model), to: String(b.to?.model) }) });
        }
        this.emit('change');
        if (resp.stop_reason === 'refusal') {
          const category = resp.stop_details?.category;
          const explanation = resp.stop_details?.explanation ?? '';
          this.transcript.push({ who: 'sys', text: category ? t('The model declined this request ({category}). {explanation}', { category, explanation }) : t('The model declined this request. {explanation}', { explanation }) });
          break;
        }
        if (resp.stop_reason === 'pause_turn') {
          if (++continuations > 5) {
            this.transcript.push({ who: 'sys', text: t('The model paused too many times; stopped.') });
            break;
          }
          continue; // resend: the API resumes the paused turn
        }
        if (resp.stop_reason === 'max_tokens') {
          this.transcript.push({ who: 'sys', text: t('The reply hit the length limit and was cut off.') });
          break;
        }
        const uses = resp.content.filter((b) => b.type === 'tool_use');
        if (resp.stop_reason !== 'tool_use' || !uses.length) break;
        const results = [];
        for (const u of uses) {
          const r = await this.reg.call(u.name, u.input ?? {}, ctx);
          const call = `${u.name}(${JSON.stringify(u.input ?? {}).slice(0, 200)})`;
          const out = r.content.slice(0, 300);
          this.transcript.push({ who: 'tool', text: r.isError ? t('{call} → error: {result}', { call, result: out }) : `${call} → ${out}`, proposal: r.proposal?.id });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
        }
        // All results of one turn go back in a single user message.
        this.messages.push({ role: 'user', content: results });
        this.emit('change');
        if (turn === MAX_TURNS) this.transcript.push({ who: 'sys', text: t('Stopped after {n} turns.', { n: MAX_TURNS }) });
      }
    } catch (e) {
      this.transcript.push({ who: 'sys', text: aborted(e, this.controller) ? t('Stopped.') : t('Error: {msg}', { msg: msgOf(e) }) });
      // Roll the conversation back to before this question so it stays valid.
      this.messages.length = start;
    } finally {
      this.busy = false;
      this.controller = null;
      this.emit('change');
    }
  }

  reset() {
    this.messages = [];
    this.transcript = [];
    this.emit('change');
  }
}
