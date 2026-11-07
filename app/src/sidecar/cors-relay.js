// The page's end of the CORS relay (REQ-GAP-08, OD-2.17; Full only, lazy block js-corsrelay). The
// relay stays off in every shipped build: the sidecar reports `cors_relay: false`, so the command is
// disabled, and this block is not in the air-gapped file at all. With a test build it does what the
// row asks: a page that cannot read an origin with no CORS headers gets the bytes through the sidecar,
// only for origins the analyst named here and listed in the sidecar window, never while Offline.
// Every call is in the page's request log, under this name, as well as in the sidecar's.

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, msgOf } from '../i18n/index.js';
import { originOf } from '../ai/netlog.js';

const KEPT = ['content-type', 'content-range', 'content-length', 'accept-ranges', 'etag', 'last-modified'];

export class CorsRelayHost {
  /** `client`: the page's SidecarClient. `allowed()`: the gate as the app sees it. */
  constructor({ client, allowed }) {
    Object.assign(this, { client, allowed });
    this.origins = new Set(); // for this page's life only
  }

  /** Whether a request to `origin` goes through the relay. Only reads, only origins named here. */
  covers(origin, method = 'GET') {
    return this.allowed() && this.origins.has(origin) && (method === 'GET' || method === 'HEAD');
  }

  /** A `fetch` to `url` through the sidecar. A refusal rejects with the sidecar's code and message. */
  async fetch(url, init = {}) {
    const headers = new Headers(init.headers ?? {});
    const body = { url, method: (init.method ?? 'GET').toUpperCase() };
    if (headers.has('accept')) body.accept = headers.get('accept');
    if (headers.has('range')) body.range = headers.get('range');
    const r = await this.client.request('POST', '/v1/cors-relay/fetch', { json: body, raw: true, signal: init.signal });
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw Object.assign(new Error(j?.error ?? `HTTP ${r.status}`), { status: r.status, code: j?.code ?? '' });
    }
    const out = new Headers();
    for (const k of KEPT) {
      const v = r.headers.get(`x-gwb-relay-${k}`);
      if (v) out.set(k, v);
    }
    const status = Number(r.headers.get('x-gwb-relay-status')) || 200;
    return new Response([204, 304].includes(status) || body.method === 'HEAD' ? null : r.body, { status, headers: out });
  }
}

export function install(app) {
  const S = app.sidecar;
  const airgap = () => app.gw?.manifest?.build?.profile === 'airgap' || app.network?.airgap;
  const host = new CorsRelayHost({ client: S.client, allowed: () => !airgap() && !!S.state.caps?.features?.cors_relay });
  S.corsRelay = host;

  async function dialog() {
    await S.ready();
    const input = h('input', { class: 'inp', type: 'url', placeholder: 'https://data.example.org', 'data-id': 'cors:origin', 'aria-label': t('Origin') });
    const list = h('ul', { class: 'cat-results', tabindex: '0', 'aria-label': t('Origins relayed for this page'), 'data-id': 'cors:list' });
    const status = h('p', { 'aria-live': 'polite', 'data-id': 'cors:status' });
    const paint = () => {
      clear(list);
      for (const o of host.origins) {
        const rm = h('button', { class: 'btn', type: 'button', onclick: () => (host.origins.delete(o), paint()) }, t('Remove'));
        list.append(h('li', { class: 'cat-item small' }, h('span', {}, `${o} `), rm));
      }
    };
    const add = h('button', {
      class: 'btn',
      type: 'button',
      'data-id': 'cors:add',
      onclick: () => {
        try {
          host.origins.add(originOf(input.value.trim()));
          input.value = '';
          status.textContent = '';
          paint();
        } catch (e) {
          status.textContent = msgOf(e);
        }
      },
    }, t('Add'));
    paint();
    const body = h(
      'div',
      {},
      h('p', {}, t('Reads an https origin that sends no CORS headers through the sidecar. It needs the origin listed in the sidecar window as well as here, and it stops while GIS Workbench is offline. Only GET and HEAD go through, with no cookies and no sign-in.')),
      field(t('Origin'), h('div', { class: 'row' }, input, add)),
      list,
      status,
    );
    await modal({ title: t('CORS Relay'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 520, id: 'cors-relay' });
  }

  app.commands.implement('sidecar.corsrelay', { run: S.guard(dialog), enabled: () => host.allowed() });
}
