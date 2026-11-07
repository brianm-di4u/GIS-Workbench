// View with Sidecar (REQ-GAP-70, SDP-2.3 GR-25; lazy block js-sidecarview): MrSID and ECW pixels
// without converting. The sidecar answers with a view, a TIFF that exists only as ranges: its
// header is built there and its tiles are decoded by the vendor plug-in as they are read, so the
// app opens it by range through the logged fetch, like an online COG. It stays on 127.0.0.1.
//
// A file the page holds goes to the sidecar as a copy; a large one is better chosen in the
// sidecar, where it is read in place. A view closes when the project drops its layer (a removed
// layer stays for Undo), or by itself after a day unread.

import { modal } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { openImageFile } from '../formats/open.js';
import { t, gwError } from '../i18n/index.js';
import { bytes, int } from '../i18n/format.js';

/** Past this size a copy to the sidecar is not the default. */
export const COPY_LIMIT = 2e9;

const views = new Map(); // layer id → view id
let watching = false;

/** How the file reaches the sidecar: 'copy' it, or 'pick' it there. null: the user stopped. */
async function route(app, main) {
  if (!main || main.remote) return 'pick';
  if (main.size <= COPY_LIMIT) return 'copy';
  const body = h('p', {}, t('{file} is {size}. Choose it in the sidecar and it is read where it is, or send a copy to the sidecar.', { file: main.name, size: bytes(main.size) }));
  const r = await modal({ title: t('View with Sidecar'), body, buttons: [{ label: t('Choose in the Sidecar'), value: 'pick', primary: true }, { label: t('Send a Copy'), value: 'copy' }, { label: t('Cancel'), value: 'cancel' }], width: 520, id: 'sidecar-view' });
  return r === 'pick' || r === 'copy' ? r : null;
}

/** Long work that is neither a pool job nor a sidecar job (OD-2.27); the indicator offers Cancel. */
const tracked = (app, label, work) => (app.activity?.track ? app.activity.track(label, work, { cancel: true }) : work({}));

function watch(app, client) {
  if (watching) return;
  watching = true;
  app.on('layers', () => {
    for (const [layer, id] of views) {
      if (app.layers.has(layer)) continue;
      views.delete(layer);
      client.closeView(id).catch(() => {}); // already gone with a restarted sidecar
    }
  });
}

/**
 * Open a view. `files`: the main File and its companions (.sdw, .aux.xml…), or nothing to choose
 * in the sidecar; `sc`: what the sidecar feature lends ({client, ready, vendorCheck, remoteFile}).
 */
export async function viewFile(app, sc, { files = [], reason = '' } = {}) {
  await sc.ready();
  const { client } = sc;
  const list = [...(files ?? [])];
  if (list[0]) sc.vendorCheck(list[0].name, reason);
  const [main, ...rest] = list;
  const how = await route(app, main);
  if (!how) return null;
  let id = null;
  if (how === 'pick') {
    id = (await client.pick('file', t('Choose the MrSID or ECW file to view'))).files[0]?.id;
    if (!id) return null;
  } else app.toast(t('Sending {file} ({size}) to the sidecar…', { file: main.name, size: bytes(main.size) }), { kind: 'info' });
  let running = null;
  let v;
  try {
    v = await tracked(app, t('Opening a view through the sidecar…'), async (job) => {
      running = job;
      id ??= (await client.uploadSet(main, rest, { signal: job.signal })).id;
      return client.openView(id, { signal: job.signal });
    });
  } catch (e) {
    if (running?.cancelled) return null;
    if (e.status === 404 && /route/.test(e.message)) throw gwError('this sidecar is too old to show tiles: update it, or use Convert with Sidecar', null, 'E_SIDECAR_NO_VIEWS');
    throw e;
  }
  const name = `${v.name.replace(/\.\w+$/, '')}.view.tif`;
  const f = await sc.remoteFile(app, client.viewUrl(v.id), { name, size: v.size, purpose: 'sidecar', sign: client.signer() });
  let r;
  try {
    r = await openImageFile(app, f, { pane: app.activePane() });
  } catch (e) {
    await client.closeView(v.id).catch(() => {});
    throw e;
  }
  const lid = r.layers?.[0]?.id;
  if (lid) {
    views.set(lid, v.id);
    watch(app, client);
  }
  app.importLog?.push({ file: v.name, errors: [], warnings: [t('shown by tiles from the sidecar; nothing was converted')] });
  app.toast(t('{file}: {w} × {h} px, {driver}, shown by tiles from the sidecar. Tiles are decoded as you pan, so the first look at an area takes a moment.', { file: v.name, w: int(v.width), h: int(v.height), driver: v.driver }), lid ? { kind: 'info', ms: 7000, action: { label: t('Zoom to layer'), run: () => app.zoomToLayer?.(lid) } } : { kind: 'info', ms: 7000 });
  app.desktop?.workspace?.map?.zoomToFootprints?.();
  return { view: v, layers: r.layers };
}
