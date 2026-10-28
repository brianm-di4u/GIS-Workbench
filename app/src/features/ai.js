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
import { parseIntent, LOCAL_HELP } from '../ai/intent.js';

export const name = 'ai';

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
  const providerFor = (c) => (c.provider === 'mock' ? mockProvider : new AnthropicProvider(c, app.netlog.fetchFor(`AI: ${c.name}`)));

  /** One-shot completion for product drafting (REQ-AI-10), with the chat's key, allow-list and consent checks. */
  app.ai.complete = async ({ system, text, images = [] }) => {
    const c = active();
    if (!c) throw new Error('no AI connection is set up (AI Assistant ▸ Connections)');
    if (c.provider !== 'mock') {
      if (!keys.has(c.id) && !(await secretDialog(c))) return null;
      if (!cspAllows(`${c.baseURL || DEFAULT_BASE_URL}/v1/messages`)) throw new Error(`${originOf(c.baseURL || DEFAULT_BASE_URL)} is not in this file's network allow-list`);
    }
    if (!(await asst.consent(c, ({ title, message, ok }) => confirmBox(title, message, { ok, cancel: 'Cancel' })))) return null;
    const pr = providerFor(c);
    const content = images.length ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType ?? 'image/jpeg', data: im.data } })), { type: 'text', text }] : text;
    const r = await pr.send({ system, messages: [{ role: 'user', content }] });
    return { text: (r.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'), model: pr.model, connection: c.name };
  };

  async function secretDialog(c) {
    const inp = h('input', { class: 'inp', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'sk-ant-…', 'aria-label': 'API key' });
    const sess = h('input', { type: 'checkbox' });
    const body = h('div', {}, field('API key', inp), h('label', { class: 'fld fld-inline' }, sess, h('span', {}, 'Keep it for this browser session (sessionStorage)')), h('p', { class: 'hint' }, 'The key stays in memory (or sessionStorage if ticked). It is never written to localStorage, the project, products, exports or a saved copy of this file.'));
    const r = await modal({ title: `API key — ${c.name}`, body, buttons: ['OK', 'Cancel'], id: 'ai-key' });
    if (r === 'OK' && inp.value.trim()) keys.set(c.id, inp.value.trim(), { session: sess.checked });
    inp.value = '';
    return r === 'OK';
  }

  async function connectionsDialog() {
    const list = conns().slice();
    const body = h('div');
    const render = () => {
      clear(body);
      body.appendChild(h('p', { class: 'hint' }, 'The assistant is off until a connection exists. Requests go only to the connection\'s origin, and only after the origin is in this file\'s network allow-list.'));
      const tbl = h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, ['Name', 'Provider', 'Base URL', 'Model', 'Effort', 'Key', 'Origin allowed', ''].map((x) => h('th', {}, x)))));
      const tb = h('tbody');
      for (const c of list) {
        const del = h('button', { class: 'btn btn-small' }, 'Remove');
        del.addEventListener('click', () => {
          list.splice(list.indexOf(c), 1);
          keys.clear(c.id);
          render();
        });
        const key = h('button', { class: 'btn btn-small' }, keys.has(c.id) ? 'Change key' : 'Set key');
        key.addEventListener('click', async () => {
          await secretDialog(c);
          render();
        });
        const use = h('input', { type: 'radio', name: 'aiActive', checked: app.prefs.get('aiActive') === c.id, 'aria-label': `Use ${c.name}` });
        use.addEventListener('change', () => app.prefs.set('aiActive', c.id));
        tb.appendChild(h('tr', {}, h('td', {}, use, ' ', c.name), h('td', {}, c.provider), h('td', {}, c.provider === 'mock' ? '—' : c.baseURL || DEFAULT_BASE_URL), h('td', {}, c.model), h('td', {}, c.effort ?? 'medium'), h('td', {}, c.provider === 'mock' ? 'n/a' : key), h('td', {}, c.provider === 'mock' ? 'n/a' : cspAllows(`${c.baseURL || DEFAULT_BASE_URL}/v1/messages`) ? 'yes' : 'no — add it'), h('td', {}, del)));
      }
      tbl.appendChild(tb);
      body.appendChild(list.length ? tbl : h('p', {}, 'No connections yet.'));
      const nm = h('input', { class: 'inp', value: 'Anthropic' });
      const prov = h('select', { class: 'inp' }, h('option', { value: 'anthropic' }, 'Anthropic Messages API'), h('option', { value: 'mock' }, 'Mock (offline, for testing)'));
      const base = h('input', { class: 'inp', value: DEFAULT_BASE_URL, spellcheck: 'false' });
      const model = h('input', { class: 'inp', value: DEFAULT_MODEL, spellcheck: 'false' });
      const effort = h('select', { class: 'inp' }, ['low', 'medium', 'high', 'xhigh', 'max'].map((e) => h('option', { value: e }, e)));
      effort.value = 'medium';
      const fb = h('input', { type: 'checkbox', checked: true });
      const add = h('button', { class: 'btn' }, 'Add connection');
      add.addEventListener('click', () => {
        const c = { id: newId('conn'), name: nm.value || 'Connection', provider: prov.value, baseURL: prov.value === 'mock' ? '' : base.value.trim().replace(/\/+$/, ''), model: prov.value === 'mock' ? 'mock-model' : model.value.trim() || DEFAULT_MODEL, effort: effort.value, fallbacks: fb.checked };
        list.push(c);
        if (!app.prefs.get('aiActive')) app.prefs.set('aiActive', c.id);
        render();
      });
      body.appendChild(section('Add a connection', field('Name', nm), field('Provider', prov), field('Base URL', base, 'A custom base URL is allowed (for example an approved gateway).'), field('Model ID', model, `Build default: ${DEFAULT_MODEL}`), field('Effort', effort), h('label', { class: 'fld fld-inline' }, fb, h('span', {}, 'Server-side refusal fallback (Claude API only; routes declined requests to another model by category)')), add));
    };
    render();
    await modal({ title: 'AI Connections', body, buttons: ['Close'], width: 820, id: 'ai-connections' });
    saveConns(list);
    if (!list.find((c) => c.id === app.prefs.get('aiActive'))) app.prefs.set('aiActive', list[0]?.id ?? null);
    app.emit('state');
    app.emit('ai');
  }

  app.allowListDialog = (preset) => allowListDialog(preset);
  async function allowListDialog(preset = []) {
    const cur = cspConnectSources().filter((s) => s !== 'blob:');
    const proj = [...(app.project()?.origins ?? []), ...(Array.isArray(preset) ? preset : [])];
    const inp = h('input', { class: 'inp', placeholder: 'https://api.anthropic.com', spellcheck: 'false', 'aria-label': 'Origin to allow' });
    const listEl = h('ul');
    const pending = new Set([...cur, ...proj]);
    const render = () => {
      clear(listEl);
      for (const o of pending) {
        const rm = h('button', { class: 'btn btn-small' }, 'Remove');
        rm.addEventListener('click', () => {
          pending.delete(o);
          render();
        });
        listEl.appendChild(h('li', {}, `${o} ${cur.includes(o) ? '(active in this file)' : '(takes effect after save + reload)'} `, rm));
      }
      if (!pending.size) listEl.appendChild(h('li', {}, 'No network origins: this file cannot reach the network (default).'));
    };
    render();
    const add = h('button', { class: 'btn' }, 'Add');
    add.addEventListener('click', () => {
      try {
        pending.add(normaliseOrigin(inp.value));
        inp.value = '';
        render();
      } catch (e) {
        app.toast(e.message, { kind: 'warn' });
      }
    });
    for (const c of conns()) if (c.provider !== 'mock') {
      const o = originOf(`${c.baseURL || DEFAULT_BASE_URL}/`);
      if (o && !pending.has(o)) {
        const b = h('button', { class: 'btn btn-small' }, `Add ${o} (connection ${c.name})`);
        b.addEventListener('click', () => {
          pending.add(o);
          render();
        });
        listEl.after?.(b);
      }
    }
    const body = h('div', {}, h('p', {}, 'This file\'s Content Security Policy is fixed when it loads. To let it reach an origin, add the origin here, save a new copy of the file, and reload that copy (REQ-ARC-16). Wildcards are refused.'), section('Origins', listEl, h('div', { class: 'btn-row' }, inp, add)), h('p', { class: 'hint' }, 'Every request is listed in View ▸ Network Log.'));
    const r = await modal({ title: 'Network Allow-List', body, buttons: ['Save New Copy…', 'Cancel'], width: 640, id: 'allowlist' });
    if (r !== 'Save New Copy…') return;
    const origins = [...pending];
    app.store.transact('Network origins', (tx) => tx.set('project', 'origins', origins));
    if (!hasTemplate()) return app.toast('This copy cannot rewrite itself (template missing)', { kind: 'error' });
    const html = htmlWithOrigins(origins);
    const res = await saveBlob(app, textBlob(html, 'text/html'), { name: 'gis-workbench.html', types: ['.html'], description: 'GIS Workbench' });
    if (res.how !== 'cancelled') app.toast('Saved. Close this tab and open the new copy to use the added origins.', { ms: 9000 });
  }

  async function promptHelper() {
    const task = h('textarea', { class: 'inp', rows: '2', spellcheck: 'true' }, 'Suggest graphics marking the main features in view, and one or two draft observations.');
    const out = h('textarea', { class: 'inp mono', rows: '10', readOnly: true, 'aria-label': 'Prompt' });
    const reply = h('textarea', { class: 'inp mono', rows: '8', placeholder: 'Paste the JSON reply here', spellcheck: 'false', 'aria-label': 'Reply' });
    const status = h('div', { class: 'hint', 'aria-live': 'polite' });
    const ctx = async () => ({ view: (await reg.call('gw_get_view', {})).content, layers: JSON.parse((await reg.call('gw_list_layers', {})).content), mensuration: JSON.parse((await reg.call('gw_read_mensuration_log', {})).content).slice(0, 30) });
    const build = h('button', { class: 'btn' }, 'Build prompt');
    build.addEventListener('click', async () => {
      out.value = buildPrompt(app, task.value, await ctx());
    });
    const copy = h('button', { class: 'btn' }, 'Copy prompt');
    copy.addEventListener('click', async () => {
      if (!out.value) out.value = buildPrompt(app, task.value, await ctx());
      await copyText(out.value);
      app.toast('Prompt copied');
    });
    const check = h('button', { class: 'btn' }, 'Validate reply');
    check.addEventListener('click', () => {
      const r = parseReply(reply.value);
      status.textContent = r.ok ? `Valid: ${r.value.graphics?.length ?? 0} graphic(s), ${r.value.observations?.length ?? 0} observation(s).` : `✗ ${r.errors.join('; ')}`;
    });
    const prop = h('button', { class: 'btn btn-primary' }, 'Preview as Proposals');
    prop.addEventListener('click', async () => {
      const r = parseReply(reply.value);
      if (!r.ok) return (status.textContent = `✗ ${r.errors.join('; ')}`);
      const res = await proposeReply(app, reg, r.value);
      const bad = res.filter((x) => x.isError);
      status.textContent = `${res.length - bad.length} proposal(s) created${bad.length ? `; ${bad.length} rejected: ${bad.map((b) => b.content).join('; ')}` : ''}. Review them in the AI Assistant ▸ Proposals.`;
      app.panels.show('ai', 'right');
    });
    await modal({ title: 'Prompt Helper (offline)', body: h('div', {}, h('p', { class: 'hint' }, 'Builds a prompt you can paste into any approved AI system. Nothing is sent from here.'), field('Task', task), h('div', { class: 'btn-row' }, build, copy), out, section('Reply', reply, h('div', { class: 'btn-row' }, check, prop), status)), buttons: ['Close'], width: 760, id: 'prompt-helper' });
  }

  // ---- dock panel ----
  function dock(a, mp, el) {
    const transcript = h('div', { class: 'ai-transcript', role: 'log', 'aria-live': 'polite', 'aria-label': 'Assistant transcript' });
    const input = h('textarea', { class: 'inp ai-input', rows: '3', placeholder: 'Ask about the imagery, or ask for graphics (proposals)…', spellcheck: 'true', 'aria-label': 'Message to the assistant' });
    const attachView = h('input', { type: 'checkbox', 'aria-label': 'Attach the current view metadata' });
    const attachChip = h('input', { type: 'checkbox', 'aria-label': 'Attach a chip of the active panel' });
    const send = h('button', { class: 'btn btn-primary' }, 'Send');
    const stop = h('button', { class: 'btn', hidden: true }, 'Stop');
    const status = h('div', { class: 'ai-status hint' });
    const tabs = h('div', { class: 'ai-tabs', role: 'tablist' });
    const pages = { chat: h('div', { class: 'ai-page' }), proposals: h('div', { class: 'ai-page', hidden: true }), tools: h('div', { class: 'ai-page', hidden: true }) };
    for (const [k, label] of [['chat', 'Chat'], ['proposals', 'Proposals'], ['tools', 'Tools']]) {
      const b = h('button', { class: 'btn btn-small', role: 'tab', 'data-id': `ai:tab:${k}` }, label);
      b.addEventListener('click', () => {
        for (const [kk, p] of Object.entries(pages)) p.hidden = kk !== k;
        renderProposals();
      });
      tabs.appendChild(b);
    }
    pages.chat.append(status, transcript, h('div', { class: 'ai-attach' }, h('label', {}, attachView, ' attach view metadata'), h('label', {}, attachChip, ' attach chip of the panel')), input, h('div', { class: 'btn-row' }, send, stop, h('span', { style: { flex: 1 } }), (() => {
      const b = h('button', { class: 'btn btn-small' }, 'New chat');
      b.addEventListener('click', () => asst.reset());
      return b;
    })()));
    el.append(tabs, ...Object.values(pages));

    const renderTranscript = () => {
      clear(transcript);
      const c = active();
      status.textContent = c ? `Connection: ${c.name} · ${c.model}${c.provider !== 'mock' && !keys.has(c.id) ? ' · no key set' : ''}${c.provider !== 'mock' && !cspAllows(`${c.baseURL || DEFAULT_BASE_URL}/v1/messages`) ? ' · origin not in the allow-list' : ''}` : 'No assistant connected: requests run on the local AI tools (“detect aircraft in view”, “search for an unpaved runway”, “auto contrast”). ';
      // The way to add one, as a button: its menu path differs between the layouts (GUI-038).
      if (!c && app.network?.airgap) status.append('The air-gapped file cannot reach a remote assistant.');
      else if (!c) {
        const setup = h('button', { class: 'btn btn-small', type: 'button', 'data-id': 'ai:setup' }, 'Add a connection…');
        setup.addEventListener('click', () => app.commands.run('ai.connections'));
        status.appendChild(setup);
      }
      for (const t of asst.transcript) {
        const msg = h('div', { class: `ai-msg ai-${t.who}` }, t.text);
        if (t.provenance) msg.appendChild(h('div', { class: 'ai-prov' }, `AI-drafted · ${t.provenance.model} · ${t.provenance.time.slice(11, 19)}`));
        transcript.appendChild(msg);
      }
      transcript.scrollTop = transcript.scrollHeight;
      send.disabled = asst.busy; // with no connection, Send runs the local tools (REQ-LAI-09)
      stop.hidden = !asst.busy;
    };
    const renderProposals = () => {
      clear(pages.proposals);
      const items = app.proposals.items;
      if (!items.length) pages.proposals.appendChild(h('p', { class: 'muted pad' }, 'No proposals. Write tools (graphics, chain changes, observations) create proposals here; nothing changes until you accept.'));
      for (const p of items) {
        const acc = h('button', { class: 'btn btn-small btn-primary', disabled: p.status !== 'pending', 'data-id': `ai:accept:${p.id}` }, 'Accept');
        acc.addEventListener('click', () => app.proposals.accept(p.id) || app.toast('The proposal is stale: the project changed since it was made', { kind: 'warn' }));
        const rej = h('button', { class: 'btn btn-small', disabled: p.status !== 'pending', 'data-id': `ai:reject:${p.id}` }, 'Reject');
        rej.addEventListener('click', () => app.proposals.reject(p.id));
        pages.proposals.appendChild(h('div', { class: `ai-prop ai-prop-${p.status}`, 'data-id': `proposal:${p.id}` }, h('b', {}, p.title), h('span', { class: 'ai-prop-status' }, p.status), h('div', { class: 'hint' }, p.preview), h('div', { class: 'hint' }, `${p.cs ? `${p.cs.ops.length} change(s)` : `action${p.outcome ? `: ${p.outcome}` : ''}`} · from ${p.provenance.source} · ${p.provenance.model ?? ''}`), h('div', { class: 'btn-row' }, acc, rej)));
      }
    };
    const renderTools = () => {
      clear(pages.tools);
      for (const t of reg.listTools()) {
        const form = h('form', { class: 'ai-tool' });
        form.appendChild(h('b', {}, `${t.name}${t.annotations.readOnlyHint ? '' : ' (proposal)'}`));
        form.appendChild(h('div', { class: 'hint' }, t.description));
        const inputs = {};
        for (const [k, p] of Object.entries(t.inputSchema.properties ?? {})) {
          const ctl = p.enum ? h('select', { class: 'inp' }, h('option', { value: '' }, '—'), ...p.enum.map((v) => h('option', { value: String(v) }, String(v)))) : p.type === 'boolean' ? h('select', { class: 'inp' }, h('option', { value: '' }, '—'), h('option', { value: 'true' }, 'true'), h('option', { value: 'false' }, 'false')) : h('input', { class: 'inp', placeholder: p.type === 'array' ? 'JSON array' : p.type });
          inputs[k] = [ctl, p];
          form.appendChild(field(`${k}${t.inputSchema.required?.includes(k) ? ' *' : ''}`, ctl));
        }
        const out = h('pre', { class: 'mono small', hidden: true });
        const run = h('button', { class: 'btn btn-small', type: 'submit' }, 'Run');
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
          const r = await reg.call(t.name, args, { source: 'tool browser', connection: 'user', model: 'n/a' });
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
      if (!intent) asst.transcript.push({ who: 'sys', text: LOCAL_HELP });
      else {
        const live = { who: 'ai', text: 'Working on this device…', provenance: prov };
        asst.transcript.push(live);
        renderTranscript();
        try {
          live.text = (await app.aiLocal.route(text)).text;
        } catch (e) {
          live.text = `Could not do that here: ${e.message}`;
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
          app.toast(`${originOf(c.baseURL || DEFAULT_BASE_URL)} is not in this file's network allow-list. Add it (Add-Ins ▸ Network Allow-List), save the new copy and reload.`, { kind: 'warn', ms: 9000 });
          return;
        }
      }
      if (!(await asst.consent(c, ({ title, message, ok }) => confirmBox(title, message, { ok, cancel: 'Cancel' })))) return;
      const attachments = [];
      if (attachView.checked) attachments.push({ type: 'text', label: 'Current view (from the tool)', text: (await reg.call('gw_get_view', {})).content });
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

  app.on('ready', (mp) => mp.docks.register({ id: 'ai', title: 'AI Assistant', icon: 'ai', home: 'right', create: dock }));
  const origAdd = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const mp = origAdd(id);
    if (app._ready) mp.docks.register({ id: 'ai', title: 'AI Assistant', icon: 'ai', home: 'right', create: dock });
    return mp;
  };

  /** A PNG chip (base64, no prefix) of the active panel including the banners (for "attach chip"). */
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
