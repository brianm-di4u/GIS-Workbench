// Sign-In for Data Origins (REQ-GAP-09, REQ-GAP-10, OD-2.19), the windows: the per-origin setup
// dialog and the device-code and PKCE sign-in flows. This module is the lazy js-signin block
// (lazy/signin.lazy.js); features/signin.js keeps the policy, the token vault, the status-bar
// indicator and the project review eager (every request asks the policy) and loads this on the
// first sign-in or the first time the dialog opens.

import { h, clear, copyText } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { t, msgOf, gwError } from '../i18n/index.js';
import { dateTime } from '../i18n/format.js';
import { cspAllows, originOf } from '../ai/netlog.js';
import { CALLBACK_CHANNEL, discover, chooseGrant, deviceAuthorize, pollDevice, beginPkce, finishPkce, parseCallback, arcgisMeta, OOB_REDIRECT } from '../connectors/auth.js';

const grantLabel = (g) => t('{grant, select, device {device code} pkce {browser redirect (PKCE)} other {automatic}}', { grant: g });

/**
 * The sign-in windows for features/signin.js: ctx = {vault, policy, idpFetch, share, shared}.
 * Implements net.signin and returns {signIn, dialog}.
 */
export function installSignInUi(app, ctx) {
  const { vault, policy, idpFetch, share, shared } = ctx;
  const C = app.commands;
  const metas = new Map(); // issuer → discovery metadata (public)

  async function metaFor(issuer, kind = null) {
    // An ArcGIS portal publishes no discovery document: its endpoints are known (REQ-GAP-64).
    if (kind === 'arcgis') return arcgisMeta(issuer);
    if (!metas.has(issuer)) metas.set(issuer, await discover(issuer, idpFetch(issuer)));
    return metas.get(issuer);
  }

  /** Sign in to `origin` with its OIDC setup; resolves true when a token is held. */
  async function signIn(origin, { grant } = {}) {
    const e = policy.get(origin);
    if (!e?.oidc) throw gwError('{origin} has no OpenID Connect setup', { origin }, 'E_AUTH_NO_SETUP');
    if (!app.network?.isOnline?.()) throw gwError('GIS Workbench is offline (status bar ▸ Offline). Go online to reach {origin}.', { origin: e.oidc.issuer }, 'E_OFFLINE');
    const meta = await metaFor(e.oidc.issuer, e.oidc.kind);
    const how = chooseGrant(meta, { wanted: grant ?? e.oidc.grant, protocol: location.protocol });
    if (!how) throw gwError(location.protocol === 'file:' ? 'this sign-in server offers no device sign-in, which a file opened from disk needs; use the hosted copy or ask for the device grant to be enabled' : 'this sign-in server offers neither PKCE nor device sign-in for this client', null, 'E_AUTH_NO_GRANT');
    const tok = how === 'device' ? await deviceFlow(e, meta) : await pkceFlow(e, meta);
    if (!tok) return false;
    vault.set(origin, tok, { meta, clientId: e.oidc.clientId, scope: e.oidc.scope });
    app.toast(t('Signed in to {origin}. The token is kept in memory only.', { origin }), { kind: 'info' });
    return true;
  }

  /** RFC 8628: show the code, open the page on request, poll until the user has signed in. */
  async function deviceFlow(e, meta) {
    const d = await deviceAuthorize(meta, { clientId: e.oidc.clientId, scope: e.oidc.scope }, idpFetch(e.oidc.issuer));
    const ac = new AbortController();
    const status = h('p', { class: 'hint', 'aria-live': 'polite', 'data-id': 'signin:device-status' }, t('Waiting for you to sign in…'));
    const code = h('output', { class: 'signin-code mono', 'data-id': 'signin:user-code', style: { fontSize: '1.6em', letterSpacing: '0.12em', display: 'block', margin: '8px 0' } }, d.userCode);
    const page = d.verificationUriComplete ?? d.verificationUri;
    const uri = h('code', { class: 'mono', 'data-id': 'signin:verify-uri' }, d.verificationUri);
    const open = h('button', { class: 'btn btn-small', type: 'button', 'data-id': 'signin:verify-open' }, t('Open the sign-in page'));
    open.addEventListener('click', () => window.open(page, '_blank', 'noopener,noreferrer'));
    const copy = h('button', { class: 'btn btn-small', type: 'button' }, t('Copy code'));
    copy.addEventListener('click', () => copyText(d.userCode).then(() => app.toast(t('Code copied'), { kind: 'info' })));
    const body = h('div', {}, h('p', {}, t('To sign in to {origin}, open the page below on this or another device and enter the code.', { origin: e.origin })), code, h('p', {}, uri), h('div', { class: 'btn-row' }, open, copy), status, h('p', { class: 'hint' }, t('The code expires in {n, plural, one {# minute} other {# minutes}}. Nothing is stored: the token stays in memory until you close this tab.', { n: Math.max(1, Math.round(d.expiresIn / 60)) })));
    let result = null;
    let failure = null;
    const poll = pollDevice(meta, { clientId: e.oidc.clientId, deviceCode: d.deviceCode, interval: d.interval, expiresIn: d.expiresIn, signal: ac.signal, onWait: ({ left }) => (status.textContent = t('Waiting for you to sign in… ({s, plural, one {# second} other {# seconds}} left)', { s: left })) }, idpFetch(e.oidc.issuer))
      .then((tok) => (result = tok))
      .catch((err) => (failure = err))
      .finally(() => document.querySelector('[data-id="dialog:signin-device"] .dlg-x')?.click());
    await modal({ title: t('Sign In with a Code'), body, buttons: [{ label: t('Cancel'), value: 'cancel' }], width: 520, id: 'signin-device' });
    ac.abort();
    await poll;
    if (failure && failure.code !== 'E_CANCELLED') throw failure;
    return result;
  }

  /** RFC 7636 from the hosted copy: a sign-in window, the code back over a BroadcastChannel, or pasted. */
  async function pkceFlow(e, meta) {
    // From a file opened from disk there is no page to return to: a portal's out-of-band page
    // shows the code, which is pasted here (REQ-GAP-64).
    const oob = !!meta.oob && !/^https?:$/.test(location.protocol);
    const redirectUri = oob ? OOB_REDIRECT : `${location.origin}${location.pathname}`;
    const p = await beginPkce(meta, { clientId: e.oidc.clientId, redirectUri, scope: e.oidc.scope });
    let got = null;
    const ch = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CALLBACK_CHANNEL) : null;
    const status = h('p', { class: 'hint', 'aria-live': 'polite' }, oob ? t('Finish signing in in the window that opened, then paste the code it shows here.') : t('Finish signing in in the window that opened.'));
    const paste = h('input', { class: 'inp', spellcheck: 'false', 'aria-label': oob ? t('Code from the sign-in page') : t('Address you were sent back to'), autocomplete: 'off', 'data-id': 'signin:paste' });
    const close = () => document.querySelector('[data-id="dialog:signin-pkce"] .dlg-x')?.click();
    if (ch)
      ch.onmessage = (m) => {
        if (m.data?.type === 'oidc-callback' && m.data.state === p.state) {
          got = m.data;
          close();
        }
      };
    const win = window.open(p.url, 'gw-signin', 'popup,width=520,height=680');
    if (!win) status.textContent = t('The sign-in window was blocked. Allow pop-ups for this page, or open the sign-in page yourself and paste the address you are sent back to.');
    const again = h('button', { class: 'btn btn-small', type: 'button' }, t('Open the sign-in window again'));
    again.addEventListener('click', () => window.open(p.url, 'gw-signin', 'popup,width=520,height=680'));
    const body = h('div', {}, h('p', {}, t('Signing in to {origin} through {issuer}.', { origin: e.origin, issuer: meta.issuer })), status, h('div', { class: 'btn-row' }, again), oob ? field(t('Code from the sign-in page'), paste) : field(t('Address you were sent back to'), paste, t('Only needed when the window cannot hand the sign-in back by itself.')));
    const r = await modal({ title: t('Sign In'), body, buttons: [{ label: t('Continue'), value: 'paste', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 560, id: 'signin-pkce' });
    ch?.close();
    try {
      win?.close();
    } catch {
      /* already closed */
    }
    if (!got && r === 'paste' && paste.value.trim()) {
      const v = paste.value.trim();
      // The out-of-band page shows the bare code; the state stays with this window.
      got = parseCallback(v) ?? (oob && /^[\w.~-]{8,2048}$/.test(v) ? { code: v, state: p.state } : null);
    }
    if (!got) return null;
    if (got.state !== p.state) throw gwError('the sign-in reply does not belong to this sign-in (state differs)', null, 'E_AUTH_STATE');
    if (got.error) throw gwError('the sign-in server refused: {error}', { error: got.errorDescription ? `${got.error}: ${got.errorDescription}` : got.error }, 'E_AUTH_REFUSED');
    // RFC 9207: an iss parameter must name the issuer this sign-in started with (mix-up defence).
    if (got.iss && got.iss.replace(/\/+$/, '') !== String(meta.issuer).replace(/\/+$/, '')) throw gwError('the sign-in reply comes from another issuer ({other})', { other: got.iss }, 'E_AUTH_ISSUER_MISMATCH');
    return finishPkce(meta, { code: got.code, verifier: p.verifier, clientId: e.oidc.clientId, redirectUri }, idpFetch(e.oidc.issuer));
  }

  async function dialog() {
    const body = h('div');
    const render = () => {
      clear(body);
      const rows = [];
      for (const [origin, { entry, from }] of policy.pending) {
        const ok = h('button', { class: 'btn btn-small', 'data-id': `signin:confirm:${origin}` }, t('Confirm'));
        ok.addEventListener('click', () => {
          policy.confirm(origin);
          render();
        });
        const no = h('button', { class: 'btn btn-small', 'data-id': `signin:decline:${origin}` }, t('Decline'));
        no.addEventListener('click', () => {
          policy.decline(origin);
          render();
        });
        rows.push(h('tr', { class: 'signin-pending' }, h('td', { class: 'mono' }, origin), h('td', {}, entry.browser ? t('Yes') : t('No')), h('td', { class: 'mono small' }, entry.oidc?.issuer ?? ''), h('td', {}, t('From the project “{project}”: not used until you confirm', { project: from || t('Untitled') })), h('td', {}, ok, ' ', no)));
      }
      for (const e of policy.list()) {
        const info = vault.info(e.origin);
        const cells = [];
        if (e.oidc) {
          const b = h('button', { class: 'btn btn-small', 'data-id': `signin:${info ? 'out' : 'in'}:${e.origin}` }, info ? t('Sign out') : t('Sign in'));
          b.addEventListener('click', async () => {
            try {
              if (info) await vault.signOut(e.origin);
              else await signIn(e.origin);
            } catch (err) {
              app.toast(t('{origin}: {msg}', { origin: e.origin, msg: msgOf(err) }), { kind: 'error', ms: 9000 });
            }
            render();
          });
          cells.push(b, ' ');
        }
        const rm = h('button', { class: 'btn btn-small', 'data-id': `signin:remove:${e.origin}` }, t('Remove'));
        rm.addEventListener('click', () => {
          policy.remove(e.origin);
          share(e, false);
          render();
        });
        const sh = h('input', { type: 'checkbox', checked: shared().some((x) => x.origin === e.origin), 'aria-label': t('Share the setup of {origin} in the project (no tokens)', { origin: e.origin }) });
        sh.addEventListener('change', () => share(e, sh.checked));
        cells.push(rm);
        const state = [];
        if (e.browser) state.push(t('Your browser sign-in is used'));
        if (info) state.push(t('Signed in, token until {time}', { time: dateTime(new Date(info.expiresAt)) }));
        else if (e.oidc) state.push(t('Not signed in'));
        if (!cspAllows(`${e.origin}/`)) state.push(t('Not in this file’s allow-list yet'));
        rows.push(h('tr', { 'data-id': `signin:row:${e.origin}` }, h('td', { class: 'mono' }, e.origin), h('td', {}, e.browser ? t('Yes') : t('No')), h('td', { class: 'mono small' }, e.oidc ? `${e.oidc.issuer} (${grantLabel(e.oidc.grant)})` : ''), h('td', {}, state.join(' · ')), h('td', {}, ...cells, ' ', h('label', {}, sh, ' ', t('In project')))));
      }
      if (!rows.length) rows.push(h('tr', {}, h('td', { colspan: '5' }, t('No origins are set up: every request leaves without your sign-in.'))));
      body.append(
        h('p', { class: 'hint' }, t('Requests go out without your browser’s certificates and single sign-on cookies, except to the https origins you mark here. Marking an origin is separate from allowing it in the network allow-list. Tokens from an OpenID Connect sign-in are kept in memory only and never written to the project, exports or logs.')),
        h('table', { class: 'grid-table', 'aria-label': t('Sign-in for data origins') }, h('thead', {}, h('tr', {}, [t('Origin'), t('Use my sign-in'), t('OpenID Connect'), t('State'), t('Actions')].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)),
      );
      const origin = h('input', { class: 'inp', placeholder: 'https://data.example.org', spellcheck: 'false', 'data-id': 'signin:origin' }); // i18n-ignore: URL
      const browser = h('input', { type: 'checkbox', 'data-id': 'signin:browser' });
      const issuer = h('input', { class: 'inp', placeholder: 'https://login.example.org/realms/gis', spellcheck: 'false', 'data-id': 'signin:issuer' }); // i18n-ignore: URL
      const client = h('input', { class: 'inp', spellcheck: 'false', 'data-id': 'signin:client' });
      const scope = h('input', { class: 'inp', value: 'openid offline_access', spellcheck: 'false', 'data-id': 'signin:scope' }); // i18n-ignore: OAuth scope values
      const grant = h('select', { class: 'inp', 'data-id': 'signin:grant' }, ['auto', 'device', 'pkce'].map((g) => h('option', { value: g }, grantLabel(g))));
      const add = h('button', { class: 'btn', 'data-id': 'signin:add' }, t('Add or update'));
      add.addEventListener('click', () => {
        try {
          const e = policy.set({ origin: origin.value, browser: browser.checked, oidc: issuer.value.trim() ? { issuer: issuer.value, clientId: client.value, scope: scope.value, grant: grant.value } : null });
          if (!cspAllows(`${e.origin}/`) || (e.oidc && !cspAllows(`${e.oidc.issuer}/`))) app.toast(t('Also add {origin} to the network allow-list, save the copy and reload it.', { origin: !cspAllows(`${e.origin}/`) ? e.origin : originOf(e.oidc.issuer) }), { kind: 'warn', ms: 9000, action: { label: t('Allow-List…'), run: () => app.allowListDialog?.([e.origin, ...(e.oidc ? [originOf(e.oidc.issuer)] : [])]) } });
        } catch (err) {
          return app.toast(msgOf(err), { kind: 'warn' });
        }
        render();
      });
      body.appendChild(
        section(
          t('Set up an origin'),
          field(t('Origin'), origin),
          h('label', { class: 'fld fld-inline' }, browser, h('span', {}, t('Use my sign-in: send this browser’s client certificate (CAC/PIV) and single sign-on cookies to this origin (https only)'))),
          location.protocol === 'file:' ? h('p', { class: 'hint' }, t('This copy was opened from disk, so its requests say "Origin: null". A server that accepts your sign-in from that origin accepts it from every local file; prefer the hosted copy for “use my sign-in”.')) : null,
          field(t('OpenID Connect issuer (optional)'), issuer, t('The preferred route. From a file opened from disk the device-code sign-in is used; from the hosted copy, a sign-in window (PKCE).')),
          field(t('Client ID'), client, t('A public client registered for GIS Workbench; no client secret is used.')),
          field(t('Scope'), scope),
          field(t('Sign-in method'), grant),
          h('div', { class: 'btn-row' }, add),
        ),
      );
    };
    const off = app.on?.('signin', render);
    render();
    await modal({ title: t('Sign-In for Data Origins'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 900, id: 'signin' });
    if (typeof off === 'function') off();
  }

  C.implement('net.signin', { run: dialog });
  return { signIn, dialog };
}
