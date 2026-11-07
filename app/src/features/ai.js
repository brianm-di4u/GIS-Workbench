// AI Assistant feature (REQ-AI-01..07, 13, 17): the dock (chat, transcript, attachable
// context, tool browser with schema-generated forms, Proposals), the Connections dialog,
// the secret key dialog, the Network Allow-List ("add origin → save → reload") and the
// offline Prompt Helper. AI is off until the user adds a connection.

import { h, clear, copyText } from '../shell/dom.js';
import { icon } from '../shell/icons.js';
import { modal, field, section, confirmBox } from '../shell/dialogs.js';
import { Registry, Proposals } from '../ai/registry.js';
import { installGisTools } from '../ai/tools-gis.js';
import { installAutomationTools } from '../ai/tools-auto.js';
import { Assistant } from '../ai/assistant.js';
import { AnthropicProvider, MockProvider, keys, DEFAULT_BASE_URL, DEFAULT_MODEL } from '../ai/providers.js';
import { NetLog, cspAllows, cspConnectSources, normaliseOrigin, originOf } from '../ai/netlog.js';
import { buildPrompt, parseReply, proposeReply } from '../ai/prompt-helper.js';
import { htmlWithOrigins, hasTemplate } from '../storage/selfsave.js';
import { saveBlob, textBlob } from '../storage/files.js';
import { newId } from '../core/util.js';
import { parseIntent, localHelp } from '../ai/intent.js';
import { t, tc, gwError, msgOf } from '../i18n/index.js';

export const name = 'ai';

/** Effort levels: the API's values, shown in the UI language. */
const effortLabel = (e) => t('{effort, select, low {low} medium {medium} high {high} xhigh {extra high} max {max} other {{effort}}}', { effort: e });
/** A proposal's status in the UI language. */
const proposalStatus = (s) => t('{status, select, pending {pending} accepted {accepted} rejected {rejected} stale {stale} other {{status}}}', { status: s });

export function install(app) {
  app.netlog = new NetLog(app);
  const reg = new Registry(app);
  app.registry = reg;
  app.proposals = new Proposals(app);
  installGisTools(app, reg);
  installAutomationTools(app, reg);
  const asst = new Assistant(app, reg);
  const mockProvider = new MockProvider({ id: 'mock', name: 'Mock (offline)' });
  app.ai = { assistant: asst, registry: reg, mock: mockProvider, keys };
  app.ai.activeConnection = () => active();
  app.ai.providerFor = (c) => providerFor(c);
  app.__test = { ...(app.__test ?? {}), htmlWithOrigins };

  const conns = () => app.prefs.get('aiConnections') ?? [];
  const saveConns = (list) => app.prefs.set('aiConnections', list.map(({ key, ...c }) => c)); // keys never stored here
  const active = () => conns().find((c) => c.id === app.prefs.get('aiActive')) ?? conns()[0] ?? null;
  const providerFor = (c) => (c.provider === 'mock' ? mockProvider : new AnthropicProvider(c, app.netlog.fetchFor(t('AI: {name}', { name: c.name }))));

  /** One-shot completion for product drafting (REQ-AI-10), with the chat's key, allow-list and consent checks. */
  app.ai.complete = async ({ system, text, images = [] }) => {
    const c = active();
    if (!c) throw gwError('no AI connection is set up (AI Assistant ▸ Connections)', null, 'E_NO_AI_CONNECTION');
    if (c.provider !== 'mock') {
      if (!keys.has(c.id) && !(await secretDialog(c))) return null;
      if (!cspAllows(`${c.baseURL || DEFAULT_BASE_URL}/v1/messages`)) throw gwError("{origin} is not in this file's network allow-list", { origin: originOf(c.baseURL || DEFAULT_BASE_URL) }, 'E_NET_NOT_ALLOWED');
    }
    if (!(await asst.consent(c, ({ title, message, ok }) => confirmBox(title, message, { ok, cancel: t('Cancel') })))) return null;
    const pr = providerFor(c);
    const content = images.length ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType ?? 'image/jpeg', data: im.data } })), { type: 'text', text }] : text;
    const r = await pr.send({ system, messages: [{ role: 'user', content }] });
    return { text: (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'), model: pr.model, connection: c.name };
  };

  async function secretDialog(c) {
    const inp = h('input', { class: 'inp', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-ant-…', 'aria-label': t('API key') }); // i18n-ignore: key format
    const sess = h('input', { type: 'checkbox' });
    const body = h('div', {}, field(t('API key'), inp), h('label', { class: 'fld fld-inline' }, sess, h('span', {}, t('Keep it for this browser session (sessionStorage)'))), h('p', { class: 'hint' }, t('The key stays in memory (or sessionStorage if ticked). It is never written to localStorage, the project, products, exports or a saved copy of this file.')));
    const r = await modal({ title: t('API key — {name}', { name: c.name }), body, buttons: [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'ai-key' });
    if (r === 'ok' && inp.value.trim()) keys.set(c.id, inp.value.trim(), { session: sess.checked });
    inp.value = '';
    return r === 'ok';
  }

  async function connectionsDialog() {
    const list = conns().slice();
    const body = h('div');
    const render = () => {
      clear(body);
      body.appendChild(h('p', { class: 'hint' }, t('The assistant is off until a connection exists. Requests go only to the connection\'s origin, and only after the origin is in this file\'s network allow-list.')));
      const tbl = h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, [t('Name'), t('Provider'), t('Base URL'), t('Model'), t('Effort'), tc('credential', 'Key'), t('Origin allowed'), ''].map((x) => h('th', {}, x)))));
      const tb = h('tbody');
      for (const c of list) {
        const del = h('button', { class: 'btn btn-small' }, t('Remove'));
        del.addEventListener('click', () => {
          list.splice(list.indexOf(c), 1);
          keys.clear(c.id);
          render();
        });
        const key = h('button', { class: 'btn btn-small' }, keys.has(c.id) ? t('Change key') : t('Set key'));
        key.addEventListener('click', async () => {
          await secretDialog(c);
          render();
        });
        const use = h('input', { type: 'radio', name: 'aiActive', checked: app.prefs.get('aiActive') === c.id, 'aria-label': t('Use {name}', { name: c.name }) });
        use.addEventListener('change', () => app.prefs.set('aiActive', c.id));
        tb.appendChild(h('tr', {}, h('td', {}, use, ' ', c.name), h('td', {}, c.provider), h('td', {}, c.provider === 'mock' ? '—' : c.baseURL || DEFAULT_BASE_URL), h('td', {}, c.model), h('td', {}, effortLabel(c.effort ?? 'medium')), h('td', {}, c.provider === 'mock' ? t('n/a') : key), h('td', {}, c.provider === 'mock' ? t('n/a') : cspAllows(`${c.baseURL || DEFAULT_BASE_URL}/v1/messages`) ? t('yes') : t('no — add it')), h('td', {}, del)));
      }
      tbl.appendChild(tb);
      body.appendChild(list.length ? tbl : h('p', {}, t('No connections yet.')));
      const nm = h('input', { class: 'inp', value: 'Anthropic' });
      const prov = h('select', { class: 'inp' }, h('option', { value: 'anthropic' }, 'Anthropic Messages API'), h('option', { value: 'mock' }, t('Mock (offline, for testing)'))); // i18n-ignore: product name
      const base = h('input', { class: 'inp', value: DEFAULT_BASE_URL, spellcheck: 'false' });
      const model = h('input', { class: 'inp', value: DEFAULT_MODEL, spellcheck: 'false' });
      const effort = h('select', { class: 'inp' }, ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => h('option', { value: e }, effortLabel(e))));
      effort.value = 'medium';
      const fb = h('input', { type: 'checkbox', checked: true });
      const add = h('button', { class: 'btn' }, t('Add connection'));
      add.addEventListener('click', () => {
        const c = { id: newId('conn'), name: nm.value || t('Connection'), provider: prov.value, baseURL: prov.value === 'mock' ? '' : base.value.trim().replace(/\/+$/, ''), model: prov.value === 'mock' ? 'mock-model' : model.value.trim() || DEFAULT_MODEL, effort: effort.value, fallbacks: fb.checked };
        list.push(c);
        if (!app.prefs.get('aiActive')) app.prefs.set('aiActive', c.id);
        render();
      });
      body.appendChild(section(t('Add a connection'), field(t('Name'), nm), field(t('Provider'), prov), field(t('Base URL'), base, t('A custom base URL is allowed (for example an approved gateway).')), field(t('Model ID'), model, t('Build default: {model}', { model: DEFAULT_MODEL })), field(t('Effort'), effort), h('label', { class: 'fld fld-inline' }, fb, h('span', {}, t('Server-side refusal fallback (Claude API only; routes declined requests to another model by category)'))), add));
    };
    render();
    await modal({ title: t('AI Connections'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 820, id: 'ai-connections' });
    saveConns(list);
    if (!list.find((c) => c.id === app.prefs.get('aiActive'))) app.prefs.set('aiActive', list[0]?.id ?? null);
    app.emit('state');
    app.emit('ai');
  }

  app.allowListDialog = (preset) => allowListDialog(preset);
  async function allowListDialog(preset = []) {
    const cur = cspConnectSources().filter((s) => s !== 'blob:');
    const proj = [...(app.project()?.origins ?? []), ...(Array.isArray(preset) ? preset : [])];
    const inp = h('input', { class: 'inp', placeholder: 'https://api.anthropic.com', spellcheck: 'false', 'aria-label': t('Origin to allow') }); // i18n-ignore: URL
    const listEl = h('ul');
    const pending = new Set([...cur, ...proj]);
    const render = () => {
      clear(listEl);
      for (const o of pending) {
        const rm = h('button', { class: 'btn btn-small' }, t('Remove'));
        rm.addEventListener('click', () => {
          pending.delete(o);
          render();
        });
        listEl.appendChild(h('li', {}, cur.includes(o) ? t('{origin} (active in this file)', { origin: o }) : t('{origin} (takes effect after save + reload)', { origin: o }), ' ', rm));
      }
      if (!pending.size) listEl.appendChild(h('li', {}, t('No network origins: this file cannot reach the network (default).')));
    };
    render();
    const add = h('button', { class: 'btn' }, t('Add'));
    add.addEventListener('click', () => {
      try {
        pending.add(normaliseOrigin(inp.value));
        inp.value = '';
        render();
      } catch (e) {
        app.toast(msgOf(e), { kind: 'warn' });
      }
    });
    for (const c of conns()) if (c.provider !== 'mock') {
      const o = originOf(`${c.baseURL || DEFAULT_BASE_URL}/`);
      if (o && !pending.has(o)) {
        const b = h('button', { class: 'btn btn-small' }, t('Add {origin} (connection {name})', { origin: o, name: c.name }));
        b.addEventListener('click', () => {
          pending.add(o);
          render();
        });
        listEl.after?.(b);
      }
    }
    const body = h('div', {}, h('p', {}, t('This file\'s Content Security Policy is fixed when it loads. To let it reach an origin, add the origin here, save a new copy of the file, and reload that copy (REQ-ARC-16). Wildcards are refused.')), section(t('Origins'), listEl, h('div', { class: 'btn-row' }, inp, add)), h('p', { class: 'hint' }, t('Every request is listed in View ▸ Network Log.')));
    const r = await modal({ title: t('Network Allow-List'), body, buttons: [{ label: t('Save New Copy…'), value: 'save', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 640, id: 'allowlist' });
    if (r !== 'save') return;
    const origins = [...pending];
    app.store.transact(t('Network origins'), (tx) => tx.set('project', 'origins', origins));
    if (!hasTemplate()) return app.toast(t('This copy cannot rewrite itself (template missing)'), { kind: 'error' });
    const html = htmlWithOrigins(origins);
    const res = await saveBlob(app, textBlob(html, 'text/html'), { name: 'gis-workbench.html', types: ['.html'], description: 'GIS Workbench' });
    if (res.how !== 'cancelled') app.toast(t('Saved. Close this tab and open the new copy to use the added origins.'), { kind: 'info', ms: 9000 });
  }

  async function promptHelper() {
    const task = h('textarea', { class: 'inp', rows: '2', spellcheck: 'true' }, t('Suggest graphics marking the main features in view, and one or two draft observations.'));
    const out = h('textarea', { class: 'inp mono', rows: '10', readOnly: true, 'aria-label': t('Prompt') });
    const reply = h('textarea', { class: 'inp mono', rows: '8', placeholder: t('Paste the JSON reply here'), spellcheck: 'false', 'aria-label': t('Reply') });
    const status = h('div', { class: 'hint', 'aria-live': 'polite' });
    const ctx = async () => ({ view: (await reg.call('gw_get_view', {})).content, layers: JSON.parse((await reg.call('gw_list_layers', {})).content), mensuration: JSON.parse((await reg.call('gw_read_mensuration_log', {})).content).slice(0, 30) });
    const build = h('button', { class: 'btn' }, t('Build prompt'));
    build.addEventListener('click', async () => {
      out.value = buildPrompt(app, task.value, await ctx());
    });
    const copy = h('button', { class: 'btn' }, t('Copy prompt'));
    copy.addEventListener('click', async () => {
      if (!out.value) out.value = buildPrompt(app, task.value, await ctx());
      await copyText(out.value);
      app.toast(t('Prompt copied'), { kind: 'info' });
    });
    const check = h('button', { class: 'btn' }, t('Validate reply'));
    check.addEventListener('click', () => {
      const r = parseReply(reply.value);
      status.textContent = r.ok ? t('Valid: {g, plural, one {# graphic} other {# graphics}}, {o, plural, one {# observation} other {# observations}}.', { g: r.value.graphics?.length ?? 0, o: r.value.observations?.length ?? 0 }) : t('✗ {errors}', { errors: r.errors.join('; ') });
    });
    const prop = h('button', { class: 'btn btn-primary' }, t('Preview as Proposals'));
    prop.addEventListener('click', async () => {
      const r = parseReply(reply.value);
      if (!r.ok) return (status.textContent = t('✗ {errors}', { errors: r.errors.join('; ') }));
      const res = await proposeReply(app, reg, r.value);
      const bad = res.filter((x) => x.isError);
      const made = res.length - bad.length;
      status.textContent = bad.length
        ? t('{n, plural, one {# proposal} other {# proposals}} created; {bad} rejected: {why}. Review them in the AI Assistant ▸ Proposals.', { n: made, bad: bad.length, why: bad.map((b) => b.content).join('; ') })
        : t('{n, plural, one {# proposal} other {# proposals}} created. Review them in the AI Assistant ▸ Proposals.', { n: made });
      app.panels.show('ai', 'right');
    });
    await modal({ title: t('Prompt Helper (offline)'), body: h('div', {}, h('p', { class: 'hint' }, t('Builds a prompt you can paste into any approved AI system. Nothing is sent from here.')), field(t('Task'), task), h('div', { class: 'btn-row' }, build, copy), out, section(t('Reply'), reply, h('div', { class: 'btn-row' }, check, prop), status)), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 760, id: 'prompt-helper' });
  }

  // ---- dock panel ----
  function dock(a, mp, el) {
    const transcript = h('div', { class: 'ai-transcript', role: 'log', 'aria-live': 'polite', 'aria-label': t('Assistant transcript') });
    const input = h('textarea', { class: 'inp ai-input', rows: '3', placeholder: t('Ask about the imagery, or ask for graphics (proposals)…'), spellcheck: 'true', 'aria-label': t('Message to the assistant') });
    const attachView = h('input', { type: 'checkbox', 'aria-label': t('Attach the current view metadata') });
    const attachChip = h('input', { type: 'checkbox', 'aria-label': t('Attach a chip of the active panel') });
    const send = h('button', { class: 'btn btn-primary' }, t('Send'));
    const stop = h('button', { class: 'btn', hidden: true }, t('Stop'));
    const status = h('div', { class: 'ai-status hint' });
    const tabs = h('div', { class: 'ai-tabs', role: 'tablist' });
    const pages = { chat: h('div', { class: 'ai-page' }), proposals: h('div', { class: 'ai-page', hidden: true }), tools: h('div', { class: 'ai-page', hidden: true }) };
    for (const [k, label] of [['chat', t('Chat')], ['proposals', t('Proposals')], ['tools', t('Tools')]]) {
      const b = h('button', { class: 'btn btn-small', role: 'tab', 'data-id': `ai:tab:${k}` }, label);
      b.addEventListener('click', () => {
        for (const [kk, p] of Object.entries(pages)) p.hidden = kk !== k;
        renderProposals();
      });
      tabs.appendChild(b);
    }
    pages.chat.append(status, transcript, h('div', { class: 'ai-attach' }, h('label', {}, attachView, ' ', t('attach view metadata')), h('label', {}, attachChip, ' ', t('attach chip of the panel'))), input, h('div', { class: 'btn-row' }, send, stop, h('span', { style: { flex: 1 } }), (() => {
      const b = h('button', { class: 'btn btn-small' }, t('New chat'));
      b.addEventListener('click', () => asst.reset());
      return b;
    })()));
    el.append(tabs, ...Object.values(pages));

    const renderTranscript = () => {
      clear(transcript);
      const c = active();
      if (c) {
        const parts = [t('Connection: {name} · {model}', { name: c.name, model: c.model })];
        if (c.provider !== 'mock' && !keys.has(c.id)) parts.push(t('no key set'));
        if (c.provider !== 'mock' && !cspAllows(`${c.baseURL || DEFAULT_BASE_URL}/v1/messages`)) parts.push(t('origin not in the allow-list'));
        status.textContent = parts.join(' · ');
      } else {
        // The examples are requests the local intent parser understands (ai/intent.js, English).
        status.textContent = `${t('No assistant connected: requests run on the local AI tools ({examples}).', { examples: '“detect aircraft in view”, “search for an unpaved runway”, “auto contrast”' })} `;
      }
      // The way to add one, as a button: its menu path differs between the layouts (GUI-038).
      if (!c && app.network?.airgap) status.append(t('The air-gapped file cannot reach a remote assistant.'));
      else if (!c) {
        const setup = h('button', { class: 'btn btn-small', type: 'button', 'data-id': 'ai:setup' }, t('Add a connection…'));
        setup.addEventListener('click', () => app.commands.run('ai.connections'));
        status.appendChild(setup);
      }
      for (const m of asst.transcript) {
        const msg = h('div', { class: `ai-msg ai-${m.who}` }, m.text);
        if (m.provenance) msg.appendChild(h('div', { class: 'ai-prov' }, t('AI-drafted · {model} · {time}', { model: m.provenance.model, time: m.provenance.time.slice(11, 19) })));
        transcript.appendChild(msg);
      }
      transcript.scrollTop = transcript.scrollHeight;
      send.disabled = asst.busy; // with no connection, Send runs the local tools (REQ-LAI-09)
      stop.hidden = !asst.busy;
    };
    const renderProposals = () => {
      clear(pages.proposals);
      const items = app.proposals.items;
      if (!items.length) pages.proposals.appendChild(h('p', { class: 'muted pad' }, t('No proposals. Write tools (graphics, chain changes, observations) create proposals here; nothing changes until you accept.')));
      for (const p of items) {
        const acc = h('button', { class: 'btn btn-small btn-primary', disabled: p.status !== 'pending', 'data-id': `ai:accept:${p.id}` }, t('Accept'));
        acc.addEventListener('click', () => app.proposals.accept(p.id) || app.toast(t('The proposal is stale: the project changed since it was made'), { kind: 'warn' }));
        const rej = h('button', { class: 'btn btn-small', disabled: p.status !== 'pending', 'data-id': `ai:reject:${p.id}` }, t('Reject'));
        rej.addEventListener('click', () => app.proposals.reject(p.id));
        pages.proposals.appendChild(h('div', { class: `ai-prop ai-prop-${p.status}`, 'data-id': `proposal:${p.id}` }, h('b', {}, p.title), h('span', { class: 'ai-prop-status' }, proposalStatus(p.status)), h('div', { class: 'hint' }, p.preview), h('div', { class: 'hint' }, t('{what} · from {source} · {model}', { what: p.cs ? t('{n, plural, one {# change} other {# changes}}', { n: p.cs.ops.length }) : p.outcome ? t('action: {outcome}', { outcome: p.outcome }) : t('action'), source: p.provenance.source, model: p.provenance.model ?? '' })), h('div', { class: 'btn-row' }, acc, rej)));
      }
    };
    const renderTools = () => {
      clear(pages.tools);
      for (const tool of reg.listTools()) {
        const form = h('form', { class: 'ai-tool' });
        form.appendChild(h('b', {}, tool.annotations.readOnlyHint ? tool.name : t('{tool} (proposal)', { tool: tool.name })));
        form.appendChild(h('div', { class: 'hint' }, tool.description)); // the MCP description stays English (DN-62 rule 7)
        const inputs = {};
        for (const [k, p] of Object.entries(tool.inputSchema.properties ?? {})) {
          const ctl = p.enum ? h('select', { class: 'inp' }, h('option', { value: '' }, '—'), ...p.enum.map((v) => h('option', { value: String(v) }, String(v)))) : p.type === 'boolean' ? h('select', { class: 'inp' }, h('option', { value: '' }, '—'), h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false')) /* i18n-ignore: JSON literals */ : h('input', { class: 'inp', placeholder: p.type === 'array' ? t('JSON array') : p.type });
          inputs[k] = [ctl, p];
          form.appendChild(field(`${k}${tool.inputSchema.required?.includes(k) ? ' *' : ''}`, ctl));
        }
        const out = h('pre', { class: 'mono small', hidden: true });
        const run = h('button', { class: 'btn btn-small', type: 'submit' }, t('Run'));
        form.append(run, out);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const args = {};
          for (const [k, [ctl, p]] of Object.entries(inputs)) {
            if (ctl.value === '') continue;
            try {
              args[k] = p.type === 'number' || p.type === 'integer' ? Number(ctl.value) : p.type === 'boolean' ? ctl.value === 'true' : p.type === 'array' || p.type === 'object' ? JSON.parse(ctl.value) : ctl.value;
            } catch {
              args[k] = ctl.value;
            }
          }
          const r = await reg.call(tool.name, args, { source: 'tool browser', connection: 'user', model: 'n/a' });
          out.hidden = false;
          out.textContent = r.content.slice(0, 4000);
        });
        pages.tools.appendChild(form);
      }
    };
    /**
     * Local tools first (REQ-LAI-09): a request a local model can do (find, search, auto contrast,
     * align, segment, go to) runs on this device. Offline, anything else gets the list of what
     * works here; with a connection it goes to the assistant. → true when handled here.
     */
    const localTurn = async (text, offline) => {
      if (!app.aiLocal) return false;
      const intent = parseIntent(text);
      if (!intent && !offline) return false;
      asst.transcript.push({ who: 'user', text });
      const prov = { model: 'local tools on this device', time: new Date().toISOString() };
      if (!intent) asst.transcript.push({ who: 'sys', text: localHelp() });
      else {
        const live = { who: 'ai', text: t('Working on this device…'), provenance: prov };
        asst.transcript.push(live);
        renderTranscript();
        try {
          live.text = (await app.aiLocal.route(text)).text;
        } catch (e) {
          live.text = t('Could not do that here: {msg}', { msg: msgOf(e) });
        }
      }
      renderTranscript();
      return true;
    };
    send.addEventListener('click', async () => {
      const c = active();
      const text = input.value.trim();
      if (!text) return;
      if (await localTurn(text, !c)) {
        input.value = '';
        return;
      }
      if (!c) return;
      if (c.provider !== 'mock') {
        if (!keys.has(c.id) && !(await secretDialog(c))) return;
        if (!cspAllows(`${c.baseURL || DEFAULT_BASE_URL}/v1/messages`)) {
          app.toast(t("{origin} is not in this file's network allow-list. Add it (Add-Ins ▸ Network Allow-List), save the new copy and reload.", { origin: originOf(c.baseURL || DEFAULT_BASE_URL) }), { kind: 'warn', ms: 9000 });
          return;
        }
      }
      if (!(await asst.consent(c, ({ title, message, ok }) => confirmBox(title, message, { ok, cancel: t('Cancel') })))) return;
      const attachments = [];
      if (attachView.checked) attachments.push({ type: 'text', label: 'Current view (from the tool)', text: (await reg.call('gw_get_view', {})).content }); // i18n-ignore: sent to the model (rule 8)
      if (attachChip.checked) {
        const chip = app.chipOfActivePane?.();
        if (chip) attachments.push({ type: 'image', data: chip });
      }
      input.value = '';
      await asst.ask(text, { provider: providerFor(c), conn: c, attachments });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send.click();
    });
    stop.addEventListener('click', () => asst.stop());
    asst.on('change', renderTranscript);
    app.proposals.on('change', renderProposals);
    app.on('ai', renderTranscript);
    renderTranscript();
    renderProposals();
    renderTools();
    return { onShow: renderTranscript };
  }

  app.on('ready', (mp) => mp.docks.register({ id: 'ai', title: t('AI Assistant'), icon: 'ai', home: 'right', create: dock }));
  const origAdd = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const mp = origAdd(id);
    if (app._ready) mp.docks.register({ id: 'ai', title: t('AI Assistant'), icon: 'ai', home: 'right', create: dock });
    return mp;
  };

  /** A PNG chip (base64, no prefix) of the active panel (for "attach chip"). */
  app.chipOfActivePane = () => {
    const p = app.activePane();
    if (!p) return null;
    const cap = app.renderer.capture();
    const r = p.el.getBoundingClientRect();
    const s = cap.dpr;
    const c = document.createElement('canvas');
    c.width = Math.round(r.width * s);
    c.height = Math.round(r.height * s);
    const tmp = document.createElement('canvas');
    tmp.width = cap.width;
    tmp.height = cap.height;
    tmp.getContext('2d').putImageData(new ImageData(cap.data, cap.width, cap.height), 0, 0);
    const g = c.getContext('2d');
    g.drawImage(tmp, r.left * s, r.top * s, c.width, c.height, 0, 0, c.width, c.height);
    g.drawImage(p.overlay, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  };

  const C = app.commands;
  C.implement('ai.assistant', { run: () => app.panels.toggle('ai', 'right'), checked: () => !!app.activeMp()?.docks.isOpen('ai') });
  C.implement('ai.proposals', { run: () => app.panels.show('ai', 'right') });
  C.implement('ai.connections', { run: connectionsDialog });
  C.implement('ai.allowlist', { run: allowListDialog });
  C.implement('ai.prompthelper', { run: promptHelper });
}
