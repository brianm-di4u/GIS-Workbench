// Sign-In for Data Origins (REQ-GAP-09, REQ-GAP-10, OD-2.19): the per-origin setup dialog in the
// Online group, the device-code and PKCE sign-in windows, the status-bar indicator, and the
// confirmation an imported project's setups wait for. The logic is in connectors/auth.js; every
// request picks it up in ai/netlog.js. Tokens stay in memory (REQ-SEC-10).
// The dialog and the sign-in flows (features/signin-ui.js) are the lazy js-signin block, loaded on
// the first sign-in or the first time the dialog opens; the policy and the vault stay here.

import { h } from '../shell/dom.js';
import { t } from '../i18n/index.js';
import { originOf } from '../ai/netlog.js';
import { TokenVault, SignInPolicy, PREF_KEY, originKey } from '../connectors/auth.js';
import { loadBlock, once, lazyCommands } from './lazy-host.js';

export const name = 'signin';

export function install(app) {
  const C = app.commands;
  const pageOrigin = /^https?:$/.test(location.protocol) ? location.origin : null;
  const idpFetch = (issuer) => app.netlog.fetchFor(t('Sign-in: {issuer}', { issuer: originOf(issuer) ?? issuer }), { auth: false });
  const vault = new TokenVault({ fetch: (u, init) => idpFetch(u)(u, init), onChange: () => changed() });
  const policy = new SignInPolicy({
    store: { get: () => app.prefs.user(PREF_KEY) ?? [], set: (v) => app.prefs.set(PREF_KEY, v) },
    vault,
    pageOrigin,
    onChange: () => changed(),
  });
  const changed = () => {
    app.emit('signin');
    app.emit('state');
  };

  /** Whether a project-provided setup waits for the user (and the toast that says so). */
  function reviewProject() {
    policy.pending.clear();
    const list = app.project()?.signIn;
    const waiting = policy.offer(list, app.project()?.name ?? '');
    if (waiting.length) app.toast(t('This project asks to use sign-in for {n, plural, one {# origin} other {# origins}}. Nothing is sent with your sign-in until you confirm.', { n: waiting.length }), { kind: 'warn', ms: 12000, action: { label: t('Review…'), run: () => C.run('net.signin') } });
  }
  app.store.on('reset', () => setTimeout(reviewProject, 0));

  /** The setups shared in the project (settings only, never tokens). */
  const shared = () => (Array.isArray(app.project()?.signIn) ? app.project().signIn : []);
  function share(entry, on) {
    const rest = shared().filter((x) => x.origin !== entry.origin);
    const next = on ? [...rest, { origin: entry.origin, browser: entry.browser, oidc: entry.oidc }] : rest;
    app.store.transact(t('Sign-in setup'), (tx) => tx.set('project', 'signIn', next));
  }

  // The dialog and the sign-in flows: the lazy js-signin block (features/signin-ui.js), which also
  // implements net.signin when it loads.
  const ui = once(async () => (await loadBlock(app, 'js-signin')).installSignInUi(app, { vault, policy, idpFetch, share, shared }));
  /** Sign in to `origin` with its OIDC setup; resolves true when a token is held. */
  const signIn = async (origin, opts) => (await ui()).signIn(origin, opts);

  // ---- status-bar indicator: shown while any origin is marked, signed in or waiting ----
  const pills = new Set();
  let lastUse = 0;
  const renderPill = (b) => {
    const s = policy.summary();
    const n = new Set([...s.marked, ...s.sessions]).size;
    b.style.display = !n && !s.pending.length ? 'none' : ''; // .status-net sets display, so `hidden` alone would not hide it
    b.textContent = s.pending.length ? t('Sign-in: {n, plural, one {# origin to confirm} other {# origins to confirm}}', { n: s.pending.length }) : t('Sign-in: {n, plural, one {# origin} other {# origins}}', { n });
    b.classList.toggle('on', Date.now() - lastUse < 4000);
    b.title = [s.marked.length ? t('Your browser sign-in goes to: {list}', { list: s.marked.join(', ') }) : '', s.sessions.length ? t('Signed in with a token to: {list}', { list: s.sessions.join(', ') }) : '', s.pending.length ? t('Waiting for your confirmation: {list}', { list: s.pending.join(', ') }) : ''].filter(Boolean).join('\n');
  };
  const addPill = (mp) => {
    const row = mp.status?.rows?.[0];
    if (!row) return;
    const b = h('button', { class: 'status-net status-signin', type: 'button', 'data-id': `status:signin:${mp.id}`, 'aria-label': t('Sign-in for data origins') });
    b.addEventListener('click', () => C.run('net.signin'));
    row.insertBefore(b, row.querySelector('.status-jobs'));
    pills.add(b);
    renderPill(b);
  };
  app.on('ready', (mp) => addPill(mp));
  if (app._ready) for (const mp of app.desktop?.multiports ?? []) addPill(mp);
  const origAdd = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const mp = origAdd(id);
    if (app._ready) addPill(mp);
    return mp;
  };
  let pillTimer = null;
  app.on('signin', () => pills.forEach(renderPill));
  app.on('signin-used', () => {
    lastUse = Date.now();
    pills.forEach(renderPill);
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => pills.forEach(renderPill), 4100);
  });

  app.auth = {
    vault,
    policy,
    signIn,
    signOut: (origin) => vault.signOut(origin),
    /** A logged fetch that refuses unless `url`'s origin is marked "use my sign-in" (a client-certificate service). */
    certificateFetch(purpose) {
      const f = app.netlog.fetchFor(purpose);
      return (input, init) => {
        policy.assertBrowserSignIn(typeof input === 'string' ? input : input.url);
        return f(input, init);
      };
    },
    originKey,
  };
  lazyCommands(app, ['net.signin'], ui);
}
