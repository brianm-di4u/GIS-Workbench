// The sidecar window. It trades the one-time launch code in its URL for a session secret, then
// polls its state. Text from pages (origins, client names) is set with textContent only.
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let secret = null;
  try {
    secret = sessionStorage.getItem('gwb-ui');
  } catch {}

  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) e.append(k instanceof Node ? k : document.createTextNode(String(k ?? '')));
    return e;
  };
  const mb = (n) => (n ? `${(n / 1e6).toFixed(0)} MB` : '');

  async function api(path, body) {
    const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Gwb-Admin': secret ?? '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
    return j;
  }

  async function start() {
    const u = new URL(location.href);
    const launch = u.searchParams.get('launch');
    if (launch) {
      history.replaceState(null, '', '/ui/');
      try {
        const r = await fetch('/ui/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ launch }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        secret = j.secret;
        try {
          sessionStorage.setItem('gwb-ui', secret);
        } catch {}
      } catch (e) {
        return locked(e.message);
      }
    }
    if (!secret) return locked('Open the sidecar window from the GIS Workbench Sidecar tray icon or Start menu entry.');
    poll();
  }

  function locked(msg) {
    $('locked').hidden = false;
    $('locked').textContent = msg;
    for (const s of document.querySelectorAll('section')) s.hidden = true;
    $('quit').hidden = true;
  }

  async function poll() {
    try {
      render(await api('/ui/api/state'));
    } catch (e) {
      if (e.status === 403) return locked('This window was replaced by a newer one, or its link expired. Open it again from the tray icon.');
      $('locked').hidden = false;
      $('locked').textContent = `The sidecar is not answering (${e.message}).`;
    }
    setTimeout(poll, 1000);
  }

  let lastPending = '';
  const RELAY = 'python-relay';
  const ADDIN = 'arcgis-pro-addin';
  const originName = (o) => (o === 'null' ? 'null (a page opened from a local file)' : o === RELAY ? 'a program on this computer (Python relay)' : o === ADDIN ? 'the ArcGIS Pro add-in on this computer' : o);
  const asking = (o) => (o === RELAY ? ' to drive the page that has the Python relay on?' : o === ADDIN ? ' to exchange its view and cursor with the page that has sync on?' : ' to use this sidecar?');

  function render(s) {
    $('locked').hidden = true;
    $('ver').textContent = s.version;
    $('where').textContent = `Listening on 127.0.0.1:${s.port} · data in ${s.data_dir} · since ${s.started}`;
    const pend = JSON.stringify(s.pending.map((p) => p.id));
    if (pend !== lastPending) {
      lastPending = pend;
      $('pending-box').hidden = !s.pending.length;
      $('pending').replaceChildren(
        ...s.pending.map((p) =>
          el(
            'li',
            {},
            el('div', {}, 'Allow ', el('b', {}, originName(p.origin)), asking(p.origin)),
            el('div', { class: 'muted' }, `Client: ${p.client}`),
            el('div', { class: 'code', 'aria-label': 'Pairing code' }, p.code),
            el('div', {}, el('button', { class: 'primary', onclick: () => api('/ui/api/decide', { id: p.id, approve: true }).then(poll) }, 'Allow'), ' ', el('button', { onclick: () => api('/ui/api/decide', { id: p.id, approve: false }).then(poll) }, 'Deny')),
          ),
        ),
      );
      if (s.pending.length) window.focus();
    }
    // Shown only with the test gate open (OD-2.18): the state is null otherwise.
    $('csm-section').hidden = !s.csm;
    if (s.csm) {
      const decide = (sha256, approve) => () => api('/ui/api/csm/decide', { sha256, approve }).catch(() => {});
      $('csm').replaceChildren(
        ...s.csm.map((p) =>
          el('div', {}, el('b', {}, p.name), ` ${p.state}. SHA-256 ${p.sha256}. Signer: ${p.signer.status}${p.signer.subject ? `, ${p.signer.subject}` : ''}. `, p.state === 'approved' ? '' : el('button', { onclick: decide(p.sha256, true) }, 'Approve'), p.state === 'refused' ? '' : el('button', { onclick: decide(p.sha256, false) }, 'Refuse')),
        ),
      );
    }
    $('relay').textContent = s.relay.on ? `On for ${s.relay.client} (${originName(s.relay.origin)}), since ${s.relay.since}. ${s.relay.calls} call(s), ${s.relay.outstanding} waiting.` : 'Off: no page has the Python relay on.';
    $('sync').textContent = s.sync.on ? `On for ${s.sync.client} (${originName(s.sync.origin)}), since ${s.sync.since}. Add-in: ${s.sync.addin ?? 'not connected'}. ${s.sync.from_app} update(s) from the app, ${s.sync.from_pro} from Pro.` : 'Off: no page has sync on.';
    $('stereo').textContent = s.stereo.open ? `${s.stereo.open} viewer(s) open.` : 'None open.';
    // The relay's section exists only in a test build with its gate open (OD-2.17).
    $('cors-box').hidden = !s.cors_relay;
    if (s.cors_relay) $('cors').replaceChildren(...s.cors_relay.origins.map((o) => el('li', {}, `${o.origin}${o.private ? ' (private)' : ''} `, el('button', { onclick: () => api('/ui/api/cors-origin', { origin: o.origin, remove: true }) }, 'Remove'))));
    $('paired').replaceChildren(...s.paired.map((p) => el('tr', {}, el('td', {}, originName(p.origin)), el('td', {}, p.tokens), el('td', {}, p.since), el('td', {}, el('button', { class: 'danger', onclick: () => api('/ui/api/revoke', { origin: p.origin }) }, 'Revoke')))));
    if (!s.paired.length) $('paired').replaceChildren(el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'No page is paired.')));
    $('origins-fixed').textContent = [s.origins.null ? 'null (local files)' : null, `${s.origins.app} (served by this sidecar)`, ...s.origins.config].filter(Boolean).join(', ');
    $('origins').replaceChildren(...s.origins.added.map((o) => el('li', {}, o, ' ', el('button', { onclick: () => api('/ui/api/origin', { origin: o, allow: false }) }, 'Remove'))));
    $('jobs').replaceChildren(
      ...s.jobs.slice(0, 50).map(({ owner, job }) =>
        el('tr', {}, el('td', {}, job.profile), el('td', {}, job.state + (job.error ? ` — ${job.error}` : '')), el('td', {}, job.progress == null ? '' : `${Math.round(job.progress * 100)} %`), el('td', {}, owner), el('td', {}, job.created), el('td', {}, ['queued', 'running'].includes(job.state) ? el('button', { onclick: () => api(`/ui/api/jobs/${job.id}/cancel`, {}) }, 'Cancel') : '')),
      ),
    );
    $('modules').replaceChildren(...s.modules.map((m) => el('tr', {}, el('td', {}, m.title), el('td', {}, m.installed ? `yes${m.version ? ` (${m.version})` : ''}` : 'no'), el('td', {}, mb(m.size)), el('td', { class: 'muted' }, m.licence))));
    $('vendor').textContent = s.vendor.map((v) => `${v.name}: ${v.installed ? 'installed' : 'not installed'}${v.licence_accepted ? ', licence accepted' : ''} (${v.drivers.join(', ')})`).join(' · ');
    $('caps-errors').textContent = s.caps_errors.join(' · ');
    $('log').textContent = s.log.join('\n');
  }

  $('add-origin').addEventListener('submit', (e) => {
    e.preventDefault();
    api('/ui/api/origin', { origin: $('origin-input').value, allow: true }).then(() => ($('origin-input').value = ''), (err) => alert(err.message));
  });
  $('add-cors').addEventListener('submit', (e) => {
    e.preventDefault();
    api('/ui/api/cors-origin', { origin: $('cors-input').value, private: $('cors-private').checked }).then(() => ($('cors-input').value = ''), (err) => alert(err.message));
  });
  $('refresh').addEventListener('click', () => api('/ui/api/refresh', {}).catch((e) => alert(e.message)));
  $('manage').addEventListener('click', () => api('/ui/api/modules', {}).catch((e) => alert(e.message)));
  $('quit').addEventListener('click', () => confirm('Quit the sidecar? Running jobs are stopped.') && api('/ui/api/quit', {}).then(() => locked('The sidecar has stopped.')));
  start();
})();
