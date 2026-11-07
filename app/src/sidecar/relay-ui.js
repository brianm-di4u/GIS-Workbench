// Sidecar ▸ Python Relay… (REQ-GAP-02; Full only, lazy block js-relay): the analyst's switch for the
// relay, which stays off until turned on here and is never restored at start-up (REQ-SDC-01), the
// calls so far, and the state the status bar shows.

import { RelayHost } from './relay-host.js';
import { h, clear } from '../shell/dom.js';
import { modal } from '../shell/dialogs.js';
import { t, msgOf } from '../i18n/index.js';
import { dateTime } from '../i18n/format.js';

const PAIR_COMMAND = 'python -m gis_workbench_client pair';

/** Why the relay could not start or went off, in the UI language. */
function why(e) {
  if (e?.code === 'relay_held') return t('another page has the Python relay on: turn it off there first');
  if (e?.code === 'not_found') return t('this sidecar is too old for the Python relay: update it');
  if (e?.status === 401) return t('this page is not paired with the sidecar any more');
  if (e?.status === 404) return t('the sidecar ended the relay');
  return msgOf(e);
}

export function install(app) {
  const S = app.sidecar;
  const refresh = new Set();
  let wasOn = false;
  const seen = new Set();
  const host = new RelayHost({
    client: S.client,
    serve: (m, ctx) => app.mcp.serve(m, ctx),
    toolDef: (n) => app.registry.tools.get(n),
    pending: () => app.proposals.pending().length,
    name: `GIS Workbench ${app.gw?.manifest?.build?.version ?? ''}`.trim(),
    onChange: () => {
      const latest = host.calls[0];
      if (latest && !seen.has(latest.client)) {
        seen.add(latest.client);
        app.toast(t('A Python script is using this page: {client}.', { client: latest.client }), { kind: 'info' });
      }
      if (wasOn && !host.on && host.error) app.toast(t('The Python relay went off: {msg}', { msg: why(host.error) }), { kind: 'warn', ms: 9000 });
      wasOn = host.on;
      S.changed();
      app.emit('state');
      for (const f of refresh) f();
    },
  });
  S.relay = host;
  // The Sidecar switch or a forgotten pairing ends the relay at once.
  app.on('sidecar', () => {
    if (host.on && !S.enabled()) host.stop();
  });

  async function setOn(on) {
    if (!on) return host.stop();
    await S.ready();
    return host.start();
  }

  async function dialog() {
    const box = h('input', { type: 'checkbox', checked: host.on, 'data-id': 'relay:on' });
    const status = h('p', { 'aria-live': 'polite', 'data-id': 'relay:status' });
    const list = h('ul', { class: 'cat-results', tabindex: '0', 'aria-label': t('Recent calls'), 'data-id': 'relay:calls' });
    const paint = () => {
      box.checked = host.on;
      status.textContent = host.on ? t('On. {n, plural, one {# call} other {# calls}} so far.', { n: host.count }) : host.error ? t('Off: {msg}', { msg: why(host.error) }) : t('Off.');
      clear(list);
      for (const c of host.calls) list.append(h('li', { class: 'cat-item small' }, h('span', { class: 'muted' }, `${dateTime(c.at, { utc: false })} `), h('span', {}, c.proposal ? t('{client}: {call}, held as a proposal', { client: c.client, call: c.label }) : t('{client}: {call}', { client: c.client, call: c.label }))));
    };
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        await setOn(box.checked);
      } catch (e) {
        host.error = e;
      }
      box.disabled = false;
      paint();
    });
    refresh.add(paint);
    paint();
    const body = h(
      'div',
      {},
      h('p', {}, t('A Python script on this computer can use this page through the sidecar. It sees what the MCP tools show, and everything it changes waits in Proposals for you to accept or reject.')),
      h('label', { class: 'fld fld-inline' }, box, h('span', {}, t('Answer the Python relay in this page'))),
      status,
      list,
      h('p', { class: 'hint' }, t('The relay stays on this computer (127.0.0.1) and goes off when this page closes or reloads. Scripts pair once in the sidecar window: {command}', { command: PAIR_COMMAND })),
    );
    await modal({ title: t('Python Relay'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 560, id: 'python-relay' });
    refresh.delete(paint);
  }

  app.commands.implement('sidecar.relay', { run: dialog, checked: () => host.on });
}
