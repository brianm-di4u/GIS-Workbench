// Sidecar ▸ Native Stereo Viewer… and Sync with ArcGIS Pro… (REQ-GAP-33, REQ-GAP-65; Full only, lazy
// block js-sidecarnative). Both drive programs outside the browser, so both say plainly what the
// other program is doing, and neither starts anything until the analyst asks.

import { ProSyncHost } from './pro-sync.js';
import { invertView } from '../render/renderer.js';
import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, N_, tr, msgOf } from '../i18n/index.js';
import { num } from '../i18n/format.js';

const D2R = Math.PI / 180;

/** The modes of `POST /v1/stereo`, with their names in the dialog. */
export const STEREO_MODES = [
  ['auto', N_('Automatic: quad-buffer if this display has it')],
  ['quad', N_('Quad-buffer (active shutter)')],
  ['anaglyph', N_('Anaglyph')],
  ['side_by_side', N_('Side-by-side')],
];
const SHOWN = { quad: N_('quad-buffer'), anaglyph: N_('anaglyph'), side_by_side: N_('side-by-side') };

/** An affine of the stereo panel, `[c0, cu, cv, d0, du, dv]`, as the viewer takes it: `[a, b, c, d, e, f]`. */
export const viewerAffine = (A) => [A[1], A[2], A[0], A[4], A[5], A[3]];

/** The ground under a screen point of a pane, or null. */
function groundOf(p, l, sx, sy) {
  const { w, h: ph } = p.size();
  const q = invertView(p.view, w, ph, sx, sy);
  return l.groundAt(q.x, q.y);
}

/** Which way is up on the screen, in degrees clockwise from north, for this view of `p`. */
function bearingUp(p, l, view = p.view) {
  const { w, h: ph } = p.size();
  const at = (sy) => {
    const q = invertView(view, w, ph, w / 2, sy);
    return l.groundAt(q.x, q.y);
  };
  const a = at(ph / 2);
  const b = at(ph / 2 - 50);
  if (!a || !b) return NaN;
  return Math.atan2((b.lon - a.lon) * Math.cos(a.lat * D2R), b.lat - a.lat) / D2R;
}

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export function readView(app) {
  const p = app.activePane?.();
  const l = p?.geoLayer();
  if (!l?.modelId) return null;
  const g = l.groundAt(p.view.cx, p.view.cy);
  const mpp = p.groundScale();
  const rotation = bearingUp(p, l);
  if (!g || !Number.isFinite(mpp) || mpp <= 0 || !Number.isFinite(rotation)) return null;
  return { lon: g.lon, lat: g.lat, mpp, rotation };
}

export function applyView(app, v) {
  const p = app.activePane?.();
  const l = p?.geoLayer();
  if (!l?.modelId) return;
  p.centreOnGround(v.lat, v.lon);
  const own = p.groundScale();
  const next = {};
  if (Number.isFinite(own) && own > 0) next.zoom = p.view.zoom * (own / v.mpp);
  // Which way `rot` turns the ground depends on the image: try it, and keep the sign that lands.
  const up = bearingUp(p, l);
  if (Number.isFinite(up)) {
    const d = wrap180(v.rotation - up) * D2R;
    const off = (rot) => Math.abs(wrap180(bearingUp(p, l, { ...p.view, rot }) - v.rotation));
    next.rot = off(p.view.rot + d) <= off(p.view.rot - d) ? p.view.rot + d : p.view.rot - d;
  }
  p.setView(next, { link: false });
}

function installProSync(app) {
  const S = app.sidecar;
  const refresh = new Set();
  let cursor = null; // the add-in's, {lat, lon}
  let wasOn = false;
  const host = new ProSyncHost({
    client: S.client,
    name: `GIS Workbench ${app.gw?.manifest?.build?.version ?? ''}`.trim(),
    applyView: (v) => {
      following = true;
      try {
        applyView(app, v);
      } finally {
        following = false;
      }
    },
    showCursor: (c) => {
      cursor = c.visible ? c : null;
      app.activePane?.()?.invalidate();
    },
    onChange: () => {
      if (wasOn && !host.on && host.error) app.toast(t('Sync with ArcGIS Pro went off: {msg}', { msg: why(host.error) }), { kind: 'warn', ms: 9000 });
      wasOn = host.on;
      S.changed();
      app.emit('state');
      for (const f of refresh) f();
    },
  });
  let following = false;
  S.proSync = host;
  // A green cross where the add-in's cursor is, as a linked pane's (shell/pane.js).
  app.links.outside = (p) => {
    if (!cursor) return null;
    const q = p.geoLayer()?.imageAt?.(cursor.lat, cursor.lon, p.geoLayer().defaultHeight?.());
    return q ? p.screenPoint(q.x, q.y) : null;
  };
  // What moves here goes there. `following` is the move the add-in asked for; the echo rule in
  // ProSyncHost is the second lock, for what a map does a frame later.
  app.on('view', () => {
    if (host.on && !following) host.localView(readView(app));
  });
  app.on('cursor', ({ pane, x, y }) => {
    if (!host.canPublish) return;
    const l = pane?.geoLayer();
    const g = Number.isFinite(x) && l?.modelId ? l.groundAt(x, y) : null;
    host.localCursor(g ? { lon: g.lon, lat: g.lat, visible: true } : { lon: 0, lat: 0, visible: false });
  });
  // The Sidecar switch or a forgotten pairing ends it at once.
  app.on('sidecar', () => {
    if (host.on && !S.enabled()) host.stop();
  });

  function why(e) {
    if (e?.code === 'sync_held') return t('another page has sync on: turn it off there first');
    if (e?.code === 'not_found') return t('this sidecar is too old for sync with ArcGIS Pro: update it');
    if (e?.status === 401) return t('this page is not paired with the sidecar any more');
    if (e?.status === 404) return t('the sidecar ended sync');
    return msgOf(e);
  }

  async function setOn(on, direction) {
    if (!on) return host.stop();
    await S.ready();
    await host.start(direction);
    const v = readView(app);
    if (v) await host.localView(v);
  }

  async function dialog() {
    const box = h('input', { type: 'checkbox', checked: host.on, 'data-id': 'prosync:on' });
    const dir = h('select', { class: 'inp', 'data-id': 'prosync:direction', 'aria-label': t('Who follows whom') }, h('option', { value: 'both' }, t('Each follows the other')), h('option', { value: 'app_follows' }, t('This page follows ArcGIS Pro')), h('option', { value: 'pro_follows' }, t('ArcGIS Pro follows this page')));
    dir.value = host.direction;
    const status = h('p', { 'aria-live': 'polite', 'data-id': 'prosync:status' });
    const paint = () => {
      box.checked = host.on;
      dir.disabled = host.on;
      if (host.on) status.textContent = host.peer ? t('On, with ArcGIS Pro connected. {sent} sent, {received} received.', { sent: host.sent, received: host.received }) : t('On. Waiting for the add-in in ArcGIS Pro.');
      else status.textContent = host.error ? t('Off: {msg}', { msg: why(host.error) }) : t('Off.');
    };
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        await setOn(box.checked, dir.value);
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
      h('p', {}, t('Keeps the view and cursor of this page and of ArcGIS Pro together, through the sidecar on this computer. Only a position passes: no layers, no files and no tools.')),
      h('label', { class: 'fld fld-inline' }, box, h('span', {}, t('Sync with ArcGIS Pro'))),
      field(t('Who follows whom'), dir),
      status,
      h('p', { class: 'hint' }, t('It needs the GIS Workbench add-in in ArcGIS Pro, and an image with a sensor model or georeferencing here. It goes off when this page closes or reloads.')),
    );
    await modal({ title: t('Sync with ArcGIS Pro'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 520, id: 'pro-sync' });
    refresh.delete(paint);
  }

  app.commands.implement('sidecar.prosync', { run: dialog, checked: () => host.on });
}

function installStereo(app) {
  const S = app.sidecar;
  const open = new Map(); // id → the session's last state
  const fileLabel = (f) => (f ? f.name : t('Not chosen'));

  /** The eyes of the open stereo panel, when its files can reach the sidecar. */
  async function panelPair() {
    const st = app.stereo?.view?.();
    if (!st) return null;
    const rec = (e) => app.store.get(st.ids[e]);
    const [l, r] = [rec('L'), rec('R')];
    if (!(l?.file instanceof Blob) || !(r?.file instanceof Blob)) return null;
    return { l, r, affines: st.A?.L && st.A?.R ? [viewerAffine(st.A.L), viewerAffine(st.A.R)] : null };
  }

  async function dialog() {
    await S.ready();
    let left = null;
    let right = null;
    let session = null;
    let timer = null;
    const pair = await panelPair();
    const mode = h('select', { class: 'inp', 'data-id': 'stereo:mode', 'aria-label': t('Display') }, ...STEREO_MODES.map(([v, label]) => h('option', { value: v }, tr(label))));
    const status = h('p', { 'aria-live': 'polite', 'data-id': 'stereo:status' }, t('Choose the two images of the pair.'));
    const showBtn = h('button', { class: 'btn primary', type: 'button', disabled: !pair, 'data-id': 'stereo:show' }, t('Show in the Viewer'));
    const closeBtn = h('button', { class: 'btn', type: 'button', disabled: true, 'data-id': 'stereo:close' }, t('Close the Viewer'));
    const nameL = h('span', { 'data-id': 'stereo:left' }, pair ? pair.l.name : fileLabel(null));
    const nameR = h('span', { 'data-id': 'stereo:right' }, pair ? pair.r.name : fileLabel(null));
    const paintButtons = () => {
      showBtn.disabled = !!session || !((left && right) || pair);
      closeBtn.disabled = !session;
    };
    const say = (i) => {
      if (i.state === 'starting') status.textContent = t('Starting the viewer and reading the first tiles…');
      else if (i.state === 'showing') status.textContent = i.detail ? t('The pair is on the display: {mode}. {detail}', { mode: tr(SHOWN[i.shown] ?? i.shown), detail: i.detail }) : t('The pair is on the display: {mode}.', { mode: tr(SHOWN[i.shown] ?? i.shown) });
      else if (i.state === 'failed') status.textContent = t('The viewer stopped: {msg}', { msg: i.detail ?? '' });
      else status.textContent = t('The viewer is closed.');
    };
    const poll = async () => {
      if (!session) return;
      try {
        const i = await S.client.request('GET', `/v1/stereo/${session}`);
        open.set(session, i);
        say(i);
        if (i.state === 'closed' || i.state === 'failed') {
          session = null;
          paintButtons();
          return;
        }
      } catch (e) {
        status.textContent = msgOf(e);
        session = null;
        paintButtons();
        return;
      }
      timer = setTimeout(poll, 1000);
    };
    const choose = (set, name, which) => async () => {
      try {
        const r = await S.client.pick('file', t('Choose an image of the stereo pair'));
        const f = r.files.at(which);
        if (!f) return;
        set(f);
        name.textContent = f.name;
        paintButtons();
      } catch (e) {
        status.textContent = msgOf(e);
      }
    };
    const pickL = h('button', { class: 'btn', type: 'button', 'data-id': 'stereo:pick-left', onclick: choose((f) => (left = f), nameL, 0) }, t('Choose in Sidecar…'));
    const pickR = h('button', { class: 'btn', type: 'button', 'data-id': 'stereo:pick-right', onclick: choose((f) => (right = f), nameR, -1) }, t('Choose in Sidecar…'));
    showBtn.addEventListener('click', async () => {
      showBtn.disabled = true;
      try {
        const i = await app.activity.track(t('Opening the stereo pair in the sidecar…'), async () => {
          const req = { mode: mode.value };
          if (left && right) Object.assign(req, { left: left.id, right: right.id });
          else {
            req.left = (await S.client.upload(pair.l.file, { name: pair.l.name })).id;
            req.right = (await S.client.upload(pair.r.file, { name: pair.r.name })).id;
            if (pair.affines) [req.left_affine, req.right_affine] = pair.affines;
          }
          return S.client.request('POST', '/v1/stereo', { json: req });
        });
        session = i.id;
        say(i);
        poll();
      } catch (e) {
        status.textContent = e?.code === 'no_viewer' ? t('The native viewer is not available here: it is built for Windows, and comes with the sidecar.') : msgOf(e);
      }
      paintButtons();
    });
    closeBtn.addEventListener('click', async () => {
      const id = session;
      session = null;
      clearTimeout(timer);
      paintButtons();
      await S.client.request('DELETE', `/v1/stereo/${id}`).catch(() => {});
      status.textContent = t('The viewer is closed.');
    });
    paintButtons();
    const body = h(
      'div',
      {},
      h('p', {}, t('Shows a stereo pair in a native window, fed by the sidecar. Quad-buffer stereo needs a graphics card, driver and display that offer it, with shutter glasses; on any other display the viewer shows anaglyph and says so.')),
      field(t('Left image'), h('div', { class: 'row' }, pickL, nameL)),
      field(t('Right image'), h('div', { class: 'row' }, pickR, nameR)),
      pair ? h('p', { class: 'hint' }, t('With nothing chosen, the pair of the Stereo Panel is used, with its epipolar alignment.')) : null,
      field(t('Display'), mode),
      h('div', { class: 'row' }, showBtn, closeBtn),
      status,
      h('p', { class: 'hint' }, t('In the viewer: drag to pan, wheel to zoom, left and right arrows for parallax, M for the next mode, F for the whole screen, Esc to close.')),
    );
    await modal({ title: t('Native Stereo Viewer'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 560, id: 'stereo-viewer' });
    clearTimeout(timer);
  }

  app.commands.implement('sidecar.stereoviewer', { run: S.guard(dialog) });
}

export function install(app) {
  installProSync(app);
  installStereo(app);
}

export const _test = { bearingUp, groundOf, wrap180, clear, num };
