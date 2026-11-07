// Data hub (2.0 plan P4; REQ-CON-01..06): one Catalog panel for data that is not a file on the
// desk — a URL, an S3-compatible bucket (public, presigned, or signed with keys held in memory),
// a STAC API (Earth Search, Microsoft Planetary Computer with SAS signing) and local folders the
// analyst bookmarks, watched for new files while the app is open. Everything opens by range:
// only the header, the overviews and the tiles in view are read (connectors/remote.js).
// 2.4 (REQ-GAP-04): any STAC API the user adds joins the catalogue list (its landing page is
// checked for item search and its collections are read), and search results page through the
// API's "next" links.

import { minOf, maxOf } from '../core/util.js';
import { h, clear } from '../shell/dom.js';
import { modal, field, promptBox } from '../shell/dialogs.js';
import { remoteFile, httpsUrl, KNOWN_REGIONS } from '../connectors/remote.js';
import { signV4 } from '../connectors/sigv4.js';
import { openImageFile, isImageName } from '../formats/open.js';
import { t, tc, msgOf, gwError } from '../i18n/index.js';
import { num, int, date } from '../i18n/format.js';
import { stacLanding, nextLink, collectPages, withParams, resolveUrl } from '../connectors/ogc.js';

const MB = (n) => num(n / 1048576, 1);

export const name = 'catalog';

export const STAC_APIS = [
  { id: 'earth-search', name: 'Earth Search (Element 84)', url: 'https://earth-search.aws.element84.com/v1', collections: ['sentinel-2-l2a', 'landsat-c2-l2', 'naip', 'cop-dem-glo-30', 'sentinel-1-grd'] },
  { id: 'planetary-computer', name: 'Microsoft Planetary Computer', url: 'https://planetarycomputer.microsoft.com/api/stac/v1', collections: ['naip', 'sentinel-2-l2a', 'landsat-c2-l2', 'cop-dem-glo-30', 'esa-worldcover'], sas: 'https://planetarycomputer.microsoft.com/api/sas/v1/token/' },
];

/** The best asset of a STAC item to show: a visual COG, else the first GeoTIFF data asset. */
export function bestAsset(item) {
  const as = Object.entries(item.assets ?? {});
  const tif = ([, a]) => /geotiff|tiff/i.test(a.type ?? '') || /\.tiff?($|\?)/i.test(a.href ?? '');
  return (
    as.find(([k, a]) => /^(visual|rendered_preview_tif|image)$/i.test(k) && tif([k, a])) ??
    as.find(([k, a]) => (a.roles ?? []).includes('visual') && tif([k, a])) ??
    as.find(([k, a]) => /^(red|B04|data)$/i.test(k) && tif([k, a])) ??
    as.find(([k, a]) => tif([k, a]) && (a.roles ?? ['data']).includes('data')) ??
    null
  );
}

export function install(app) {
  const C = app.commands;
  const keys = new Map(); // bucket → {accessKeyId, secretAccessKey, sessionToken, region, endpoint}
  const sas = new Map(); // collection → {token, expiry}

  /** Sign a URL for the connection it belongs to (S3 keys, Planetary Computer SAS). */
  async function signer(url) {
    const u = new URL(url);
    // Planetary Computer storage accounts take a SAS token per collection.
    if (/\.blob\.core\.windows\.net$/.test(u.host) && !u.searchParams.has('sig')) {
      const col = SAS_ACCOUNTS[u.host.split('.')[0]];
      if (col) {
        const tok = await sasToken(col);
        return (href, init) => ({ url: `${href}${href.includes('?') ? '&' : '?'}${tok}`, init });
      }
    }
    const bucket = /^s3[.-]?([a-z0-9-]*)\.amazonaws\.com$/.test(u.host) || /^[^.]+\.s3/.test(u.host) ? (u.host.startsWith('s3') ? u.pathname.split('/')[1] : u.host.split('.')[0]) : null;
    const k = (bucket && keys.get(bucket)) || [...keys.values()].find((x) => x.endpoint && url.startsWith(x.endpoint));
    if (k) return (href, init) => signV4(href, init, k);
    return null;
  }
  const SAS_ACCOUNTS = { naipeuwest: 'naip', landsateuwest: 'landsat-c2-l2', sentinel2l2a01: 'sentinel-2-l2a' };
  async function sasToken(collection) {
    const c = sas.get(collection);
    if (c && c.expiry > Date.now() + 60000) return c.token;
    const r = await app.netlog.fetchFor('STAC: Planetary Computer SAS token')(`${STAC_APIS[1].sas}${collection}`, { credentials: 'omit' });
    if (!r.ok) throw gwError('Planetary Computer did not sign {collection} (HTTP {status})', { collection, status: r.status }, 'E_SAS_TOKEN');
    const j = await r.json();
    sas.set(collection, { token: j.token, expiry: Date.parse(j['msft:expiry'] ?? '') || Date.now() + 30 * 60000 });
    return j.token;
  }

  /** Open a URL (https, s3://, gs://) as imagery by range (REQ-CON-03). */
  async function openUrl(url, { name = null, pane = null } = {}) {
    const href = httpsUrl(url);
    if (!/^https:\/\//.test(href) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(href)) throw new Error('give an https:// (or s3://, gs://) address');
    const sign = await signer(href);
    const f = await remoteFile(app, href, { name, sign, purpose: `Open: ${new URL(href).host}` });
    if (!isImageName(f.name) && !/\.(tif|tiff|ntf|nitf|jp2)$/i.test(f.name)) f.name = `${f.name}.tif`;
    app.toast(t('Opening {file} by range ({mb} MB on the server; only what is shown is read)…', { file: f.name, mb: MB(f.size) }), { kind: 'info' });
    const r = await openImageFile(app, f, { pane: pane ?? app.activePane() });
    const lid = r.layers?.[0]?.id;
    app.toast(t('Opened {file}: {n, plural, one {# range request} other {# range requests}}, {mb} MB read so far.', { file: f.name, n: f.stats.ranges, mb: num(f.stats.bytes / 1048576, 2) }), lid ? { kind: 'info', action: { label: t('Zoom to layer'), run: () => app.zoomToLayer?.(lid) } } : { kind: 'info' });
    return r;
  }
  app.openUrl = openUrl;
  C.implement('file.openurl', {
    run: async (u) => {
      const url = typeof u === 'string' ? u : await promptBox(t('Open from URL'), t('Address'), '', { placeholder: 'https://…/image.tif · s3://bucket/key.tif · gs://bucket/key.tif', hint: t('Cloud-Optimized GeoTIFFs stream: only the header, the overviews and the tiles in view are read.') });
      if (url) await openUrl(url.trim());
    },
  });

  // ---------------- STAC (REQ-CON-06; any STAC API, REQ-GAP-04) ----------------
  const customApis = () => (app.prefs.get('stacCustom') ?? []).filter((a) => a && /^https?:\/\//.test(a.url ?? ''));
  const apis = () => [...STAC_APIS, ...customApis()];
  /**
   * Add a STAC API by its landing page URL: it must offer item search; its collections are read
   * (all pages, up to 1000). Kept in this browser's preferences (no keys or tokens).
   */
  async function addStacApi(url0) {
    const url = String(url0 ?? '').trim().replace(/\/+$/, '');
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) throw gwError('give an https:// address of a STAC API landing page', null, 'E_STEP_FIRST');
    const fetch = app.netlog.fetchFor(`STAC: ${url}`);
    const r = await fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (!r.ok) throw gwError('{url}: HTTP {status}', { url, status: r.status }, 'E_HTTP');
    const land = stacLanding(await r.json(), url);
    const got = await collectPages(
      async (href) => {
        const q = await fetch(href, { credentials: 'omit', headers: { Accept: 'application/json' } });
        if (!q.ok) throw gwError('{url}: HTTP {status}', { url: href, status: q.status }, 'E_HTTP');
        const j = await q.json();
        return { items: j.collections ?? [], next: nextLink(j, href)?.href ?? null };
      },
      { first: land.collections, max: 1000 },
    );
    const api = { id: `custom:${url}`, name: land.title, url, search: land.search, searchPost: land.searchPost, collections: got.items.map((c) => c.id).filter(Boolean), custom: true };
    if (!api.collections.length) throw gwError('{url} lists no collections to search', { url }, 'E_STAC_NO_COLLECTIONS');
    app.prefs.set('stacCustom', [...customApis().filter((a) => a.id !== api.id), api]);
    app.prefs.set('stacApi', api.id);
    renderPanel();
    return api;
  }
  function removeStacApi(id) {
    app.prefs.set('stacCustom', customApis().filter((a) => a.id !== id));
    if (app.prefs.get('stacApi') === id) app.prefs.set('stacApi', STAC_APIS[0].id);
    renderPanel();
  }
  /** One page of a search → {features, next, matched}; `next` (from the previous page) continues it. */
  async function stacSearchPage(api, { bbox, datetime, collections, limit = 24 } = {}, next = null) {
    const fetch = app.netlog.fetchFor(`STAC: ${api.name}`);
    const searchUrl = api.search ?? `${api.url}/search`;
    const json = { 'content-type': 'application/json' };
    let r;
    let body = null;
    if (next) {
      const m = (next.method ?? 'GET').toUpperCase();
      body = m === 'POST' ? (next.merge ? { ...(next.prev ?? {}), ...(next.body ?? {}) } : (next.body ?? next.prev)) : null;
      r = await fetch(next.href, { method: m, credentials: 'omit', headers: json, body: body ? JSON.stringify(body) : undefined });
    } else if (api.searchPost !== false) {
      body = { bbox, limit, collections, ...(datetime ? { datetime } : {}), sortby: [{ field: 'properties.datetime', direction: 'desc' }] };
      r = await fetch(searchUrl, { method: 'POST', credentials: 'omit', headers: json, body: JSON.stringify(body) });
      if (r.status === 400 || r.status === 422) {
        // Some APIs refuse sortby; ask again without it.
        delete body.sortby;
        r = await fetch(searchUrl, { method: 'POST', credentials: 'omit', headers: json, body: JSON.stringify(body) });
      }
    } else r = await fetch(withParams(searchUrl, { bbox: bbox?.join(','), limit, collections: collections?.join(','), datetime }), { credentials: 'omit' });
    if (!r.ok) throw gwError('{api}: search failed (HTTP {status})', { api: api.name, status: r.status }, 'E_STAC_SEARCH');
    const j = await r.json();
    const n = nextLink(j, next?.href ?? searchUrl);
    return { features: j.features ?? [], next: n ? { ...n, href: resolveUrl(n.href, searchUrl), prev: body ?? next?.prev ?? null } : null, matched: j.numberMatched ?? j.context?.matched ?? null };
  }
  async function stacSearch(api, opts) {
    return (await stacSearchPage(api, opts)).features;
  }
  app.stacSearch = stacSearch;
  app.stacSearchPage = stacSearchPage;
  app.stacApis = { list: apis, add: addStacApi, remove: removeStacApi };

  /** Ground box of the active panel's view (or of its image). */
  function viewBox() {
    const p = app.activePane();
    const l = p?.geoLayer?.();
    if (!l?.modelId) return null;
    const { w, h: hh } = p.size();
    const pts = [];
    for (const [x, y] of [[0, 0], [w, 0], [w, hh], [0, hh], [w / 2, hh / 2]]) {
      try {
        const v = p.viewPoint(x, y);
        const g = l.groundAt(v.x, v.y);
        if (g && Number.isFinite(g.lat)) pts.push(g);
      } catch {
        /* outside the model */
      }
    }
    if (!pts.length) return null;
    const lats = pts.map((g) => g.lat);
    const lons = pts.map((g) => g.lon);
    return [minOf(lons), minOf(lats), maxOf(lons), maxOf(lats)];
  }

  async function openItem(api, item) {
    const best = bestAsset(item);
    if (!best) throw gwError('{item}: no GeoTIFF asset to open', { item: item.id }, 'E_STAC_NO_ASSET');
    const [key, asset] = best;
    let href = asset.href;
    if (api.sas) href = `${href}${href.includes('?') ? '&' : '?'}${await sasToken(item.collection)}`;
    return openUrl(href, { name: `${item.id}_${key}.tif` });
  }
  app.stacOpenItem = openItem;

  // ---------------- S3 listing (REQ-CON-04) ----------------
  async function listBucket(path) {
    const m = /^s3:\/\/([^/]+)\/?(.*)$/i.exec(path.trim());
    if (!m) throw new Error('give a bucket as s3://bucket/prefix/');
    const [, bucket, prefix] = m;
    const k = keys.get(bucket);
    const region = k?.region ?? KNOWN_REGIONS[bucket] ?? 'us-east-1';
    const base = k?.endpoint ? `${k.endpoint.replace(/\/$/, '')}/${bucket}` : httpsUrl(`s3://${bucket}/`, { region }).replace(/\/$/, '');
    const url = `${base}?list-type=2&delimiter=%2F&max-keys=200&prefix=${encodeURIComponent(prefix)}`;
    const s = k ? await signV4(url, { credentials: 'omit' }, k) : { url, init: { credentials: 'omit' } };
    const r = await app.netlog.fetchFor(`S3: ${bucket}`)(s.url, s.init);
    if (r.status === 403) throw gwError('{bucket}: listing is not allowed (private or requester-pays bucket; add keys, or open a presigned URL)', { bucket }, 'E_S3_LIST_FORBIDDEN');
    if (!r.ok) throw gwError('{bucket}: HTTP {status}', { bucket, status: r.status }, 'E_HTTP');
    const doc = new DOMParser().parseFromString(await r.text(), 'application/xml');
    const txt = (n, tag) => n.getElementsByTagName(tag)[0]?.textContent ?? '';
    const folders = [...doc.getElementsByTagName('CommonPrefixes')].map((n) => txt(n, 'Prefix'));
    const files = [...doc.getElementsByTagName('Contents')].map((n) => ({ key: txt(n, 'Key'), size: Number(txt(n, 'Size')) }));
    return { bucket, prefix, folders, files, base };
  }
  app.listBucket = listBucket;
  C.implement('cat.s3keys', {
    run: async () => {
      const b = h('input', { class: 'inp', placeholder: t('bucket name'), spellcheck: 'false' });
      const id = h('input', { class: 'inp', placeholder: t('Access key ID'), spellcheck: 'false', autocomplete: 'off' });
      const sec = h('input', { class: 'inp', type: 'password', placeholder: t('Secret access key'), autocomplete: 'off' });
      const tok = h('input', { class: 'inp', type: 'password', placeholder: t('Session token (optional, preferred)'), autocomplete: 'off' });
      const reg = h('input', { class: 'inp', placeholder: 'us-east-1', spellcheck: 'false' });
      const ep = h('input', { class: 'inp', placeholder: t('https://minio.example.org (MinIO or another S3-compatible service; empty for AWS)'), spellcheck: 'false' });
      const r = await modal({ title: t('Connect a Bucket'), body: h('div', {}, field(t('Bucket'), b), field(t('Access key ID'), id), field(t('Secret access key'), sec), field(t('Session token'), tok), field(t('Region'), reg), field(t('Endpoint'), ep), h('p', { class: 'hint' }, t("Keys stay in this tab's memory only: they are never written to disk, the project or an export. Prefer short-lived session credentials or presigned URLs. A private bucket must allow this page in its CORS settings, and a custom endpoint must be added to the Network Allow-List. GCS works the same way with HMAC keys and the endpoint https://storage.googleapis.com."))), buttons: [{ label: t('Connect'), value: 'connect', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 560, id: 's3keys' });
      if (r !== 'connect' || !b.value.trim()) return;
      keys.set(b.value.trim(), { accessKeyId: id.value.trim(), secretAccessKey: sec.value, sessionToken: tok.value || null, region: reg.value.trim() || 'us-east-1', endpoint: ep.value.trim() || null });
      app.toast(t('Keys for {bucket} are held in memory for this session.', { bucket: b.value.trim() }), { kind: 'info' });
    },
  });

  // ---------------- Local folders (REQ-CON-02) ----------------
  const folders = []; // {name, handle, files: Map(name → {size, lastModified}), watcher}
  async function scan(dir, base = '', out = new Map(), depth = 0) {
    for await (const [name, hnd] of dir.entries()) {
      if (hnd.kind === 'directory' && depth < 3) await scan(hnd, `${base}${name}/`, out, depth + 1);
      else if (hnd.kind === 'file' && (isImageName(name) || /\.(geojson|kml|kmz|shp|zip|gpkg|las|laz|pmtiles|mbtiles)$/i.test(name))) {
        const f = await hnd.getFile();
        out.set(`${base}${name}`, { size: f.size, lastModified: f.lastModified, handle: hnd });
      }
    }
    return out;
  }
  async function addFolder(handle) {
    const files = await scan(handle);
    const fo = { name: handle.name, handle, files };
    folders.push(fo);
    watch(fo);
    try {
      await app.journal?.put('kv', `folder:${handle.name}`, handle);
    } catch {
      /* no persistent storage here */
    }
    renderPanel();
    return fo;
  }
  function announce(fo, names) {
    if (!names.length) return;
    renderPanel();
    const first = names[0];
    app.toast(names.length > 1 ? t('{folder}: {n, plural, one {# new file} other {# new files}} ({file}, …).', { folder: fo.name, n: names.length, file: first }) : t('{folder}: 1 new file ({file}).', { folder: fo.name, file: first }), { kind: 'info', action: { label: tc('verb', 'Open'), run: async () => app.openFiles([await fo.files.get(first).handle.getFile()]) } });
  }
  /** Watch with FileSystemObserver where the browser has it, else poll every 10 s (S-31). */
  function watch(fo) {
    const rescan = async () => {
      const now = await scan(fo.handle);
      const fresh = [...now.keys()].filter((k) => !fo.files.has(k) || fo.files.get(k).size !== now.get(k).size);
      // A file still being written changes size between polls: take it on the next stable poll.
      const stable = fresh.filter((k) => fo.pending?.get(k) === now.get(k).size);
      fo.pending = new Map(fresh.map((k) => [k, now.get(k).size]));
      for (const k of stable) fo.files.set(k, now.get(k));
      for (const k of [...fo.files.keys()]) if (!now.has(k)) fo.files.delete(k);
      announce(fo, stable);
    };
    if (typeof FileSystemObserver === 'function') {
      try {
        fo.watcher = new FileSystemObserver(() => setTimeout(rescan, 800));
        fo.watcher.observe(fo.handle, { recursive: true });
      } catch {
        fo.watcher = null;
      }
    }
    fo.poll = setInterval(rescan, fo.watcher ? 30000 : 10000);
    fo.rescan = rescan;
  }
  app.folders = { list: folders, add: addFolder };
  C.implement('cat.folder', {
    enabled: () => typeof showDirectoryPicker === 'function',
    run: async () => {
      let handle;
      try {
        handle = await showDirectoryPicker({ mode: 'read' });
      } catch (e) {
        if (e?.name === 'AbortError') return;
        throw new Error('this browser or embed cannot open folders');
      }
      const fo = await addFolder(handle);
      app.toast(t('{folder}: {n, plural, one {# file} other {# files}} catalogued; new files will appear while GIS Workbench is open.', { folder: fo.name, n: fo.files.size }), { kind: 'info' });
      app.panels?.show('catalog', 'right');
    },
  });

  // ---------------- The Catalog panel ----------------
  let panelEl = null;
  let results = [];
  let moreState = null;
  let listing = null;
  function renderPanel() {
    if (!panelEl) return;
    clear(panelEl);
    const api0 = apis().some((a) => a.id === app.prefs.get('stacApi')) ? app.prefs.get('stacApi') : STAC_APIS[0].id;
    // URL
    const url = h('input', { class: 'inp', placeholder: 'https://…/image.tif · s3://… · gs://…', spellcheck: 'false', 'data-id': 'catalog:url', 'aria-label': t('Image address') });
    const go = h('button', { class: 'btn', 'data-id': 'catalog:open-url' }, tc('verb', 'Open'));
    // An empty box says so instead of doing nothing (GUI-051).
    const typeFirst = (input, msg) => (input.value.trim() ? true : (app.toast(msg, { kind: 'warn' }), input.focus(), false));
    go.addEventListener('click', () => typeFirst(url, t('Type an image address (https://, s3:// or gs://) first.')) && openUrl(url.value.trim()).catch((e) => app.toast(msgOf(e), { kind: 'warn', ms: 8000 })));
    url.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
    // STAC
    const apiSel = h('select', { class: 'inp', 'data-id': 'catalog:api', 'aria-label': t('Catalogue') }, apis().map((a) => h('option', { value: a.id, selected: a.id === api0 }, a.name)));
    const api = () => apis().find((a) => a.id === apiSel.value);
    const addApi = h('button', { class: 'btn btn-small', 'data-id': 'catalog:add-api' }, t('Add a STAC API…'));
    addApi.addEventListener('click', async () => {
      const u = await promptBox(t('Add a STAC API'), t('Landing page address'), '', { placeholder: 'https://…/stac/v1', hint: t('Any STAC API with item search. Its origin must be in the Network Allow-List.') });
      if (!u) return;
      try {
        const a = await addStacApi(u);
        app.toast(t('{api}: {n, plural, one {# collection} other {# collections}} added to the catalogues.', { api: a.name, n: a.collections.length }), { kind: 'info' });
      } catch (e) {
        app.toast(msgOf(e), { kind: 'warn', ms: 9000 });
      }
    });
    const delApi = h('button', { class: 'btn btn-small', 'data-id': 'catalog:remove-api', hidden: !api()?.custom }, t('Remove'));
    delApi.addEventListener('click', () => api()?.custom && removeStacApi(api().id));
    const colSel = h('select', { class: 'inp', 'data-id': 'catalog:collection' });
    const fillCols = () => clear(colSel).append(...api().collections.map((c) => h('option', { value: c }, c)));
    fillCols();
    apiSel.addEventListener('change', () => {
      app.prefs.set('stacApi', apiSel.value);
      delApi.hidden = !api()?.custom;
      fillCols();
    });
    const from = h('input', { class: 'inp', type: 'date', 'aria-label': t('From date') });
    const to = h('input', { class: 'inp', type: 'date', 'aria-label': t('To date') });
    const search = h('button', { class: 'btn btn-primary', 'data-id': 'catalog:search' }, t('Search this view'));
    const status = h('div', { class: 'hint', 'aria-live': 'polite' });
    search.addEventListener('click', async () => {
      const bbox = viewBox();
      if (!bbox) return app.toast(t('Search this view: open a georeferenced image first (or type a place with Ctrl+K), so the search knows where to look'), { kind: 'warn' });
      status.textContent = t('Searching…');
      try {
        const dt = from.value || to.value ? `${from.value ? `${from.value}T00:00:00Z` : '..'}/${to.value ? `${to.value}T23:59:59Z` : '..'}` : null;
        const a = api();
        const pg = await stacSearchPage(a, { bbox, datetime: dt, collections: [colSel.value] });
        results = pg.features.map((it) => ({ api: a, item: it }));
        moreState = pg.next ? { api: a, next: pg.next } : null;
        more.hidden = !moreState;
        status.textContent = t('{n, plural, one {# item} other {# items}} over this view.', { n: results.length });
        drawFootprints();
        renderResults();
      } catch (e) {
        status.textContent = msgOf(e);
      }
    });
    const more = h('button', { class: 'btn btn-small', 'data-id': 'catalog:more', hidden: !moreState }, t('More results'));
    more.addEventListener('click', async () => {
      if (!moreState) return;
      status.textContent = t('Searching…');
      try {
        const pg = await stacSearchPage(moreState.api, {}, moreState.next);
        results = [...results, ...pg.features.map((it) => ({ api: moreState.api, item: it }))];
        moreState = pg.next ? { api: moreState.api, next: pg.next } : null;
        more.hidden = !moreState;
        status.textContent = t('{n, plural, one {# item} other {# items}} over this view.', { n: results.length });
        drawFootprints();
        renderResults();
      } catch (e) {
        status.textContent = msgOf(e);
      }
    });
    const resultsEl = h('ul', { class: 'cat-results', 'data-id': 'catalog:results' });
    const renderResults = () => {
      clear(resultsEl);
      for (const { api: a, item } of results) {
        const p = item.properties ?? {};
        const when = p.datetime ? date(p.datetime) : '';
        const meta = Number.isFinite(p['eo:cloud_cover']) ? t('{date} · {collection} · {cloud} % cloud', { date: when, collection: item.collection, cloud: int(Math.round(p['eo:cloud_cover'])) }) : `${when} · ${item.collection}`;
        const b = h('button', { class: 'btn btn-small', 'data-id': `catalog:open:${item.id}` }, tc('verb', 'Open'));
        b.addEventListener('click', () => openItem(a, item).catch((e) => app.toast(msgOf(e), { kind: 'warn', ms: 8000 })));
        resultsEl.appendChild(h('li', { class: 'cat-item' }, h('div', {}, h('strong', {}, item.id), h('div', { class: 'small muted' }, meta)), b));
      }
    };
    renderResults();
    // S3
    const s3 = h('input', { class: 'inp', placeholder: 's3://maxar-opendata/events/', spellcheck: 'false', 'data-id': 'catalog:s3', 'aria-label': t('Bucket address'), value: listing ? `s3://${listing.bucket}/${listing.prefix}` : '' });
    const ls = h('button', { class: 'btn', 'data-id': 'catalog:list' }, t('List'));
    const keysBtn = h('button', { class: 'btn' }, t('Keys…'));
    keysBtn.addEventListener('click', () => C.run('cat.s3keys'));
    const lsOut = h('ul', { class: 'cat-results', 'data-id': 'catalog:listing' });
    const renderListing = () => {
      clear(lsOut);
      if (!listing) return;
      if (listing.prefix) {
        const up = h('button', { class: 'btn btn-small' }, '..');
        up.addEventListener('click', () => browse(`s3://${listing.bucket}/${listing.prefix.replace(/[^/]+\/$/, '')}`));
        lsOut.appendChild(h('li', { class: 'cat-item' }, up));
      }
      for (const f of listing.folders) {
        const b = h('button', { class: 'btn btn-small' }, f.slice(listing.prefix.length));
        b.addEventListener('click', () => browse(`s3://${listing.bucket}/${f}`));
        lsOut.appendChild(h('li', { class: 'cat-item' }, b));
      }
      for (const f of listing.files) {
        const name = f.key.slice(listing.prefix.length);
        const open = h('button', { class: 'btn btn-small' }, tc('verb', 'Open'));
        open.addEventListener('click', () => openUrl(`${listing.base}/${f.key}`).catch((e) => app.toast(msgOf(e), { kind: 'warn', ms: 8000 })));
        lsOut.appendChild(h('li', { class: 'cat-item' }, h('span', {}, t('{file} · {mb} MB', { file: name, mb: MB(f.size) })), isImageName(name) || /\.tiff?$/i.test(name) ? open : null));
      }
    };
    const browse = async (path) => {
      try {
        listing = await listBucket(path);
        s3.value = path;
        renderListing();
      } catch (e) {
        app.toast(msgOf(e), { kind: 'warn', ms: 8000 });
      }
    };
    ls.addEventListener('click', () => typeFirst(s3, t('Type a bucket address (s3://bucket/prefix/) first.')) && browse(s3.value.trim()));
    renderListing();
    // Folders
    const addF = h('button', { class: 'btn', 'data-id': 'catalog:add-folder' }, t('Add Folder…'));
    addF.addEventListener('click', () => C.run('cat.folder'));
    const fl = h('ul', { class: 'cat-results' });
    for (const fo of folders) {
      fl.appendChild(h('li', { class: 'cat-head' }, fo.watcher ? t('{folder} ({n}, watched)', { folder: fo.name, n: int(fo.files.size) }) : t('{folder} ({n}, checked every 10 s)', { folder: fo.name, n: int(fo.files.size) })));
      for (const [k, v] of [...fo.files.entries()].slice(0, 200)) {
        const b = h('button', { class: 'btn btn-small' }, tc('verb', 'Open'));
        b.addEventListener('click', async () => app.openFiles([await v.handle.getFile()]));
        fl.appendChild(h('li', { class: 'cat-item' }, h('span', {}, t('{file} · {mb} MB', { file: k, mb: MB(v.size) })), b));
      }
    }
    const offline = app.network && !app.network.isOnline() ? h('p', { class: 'hint warn' }, app.network.airgap ? t('This is the air-gapped file: only local folders are available.') : t('Offline: go online (status bar) to search catalogues and open cloud data.')) : null;
    panelEl.append(
      h('div', { class: 'cat' }, offline,
        h('h4', {}, t('Open from a URL')), h('div', { class: 'btn-row' }, url, go),
        h('h4', {}, t('Search a catalogue (STAC)')), field(t('Catalogue'), apiSel), h('div', { class: 'btn-row' }, addApi, delApi), field(t('Collection'), colSel), h('div', { class: 'btn-row' }, field(t('From'), from), field(t('To'), to)), h('div', { class: 'btn-row' }, search), status, resultsEl, more,
        h('h4', {}, t('Browse a bucket')), h('div', { class: 'btn-row' }, s3, ls, keysBtn), lsOut,
        h('h4', {}, t('Local folders')), h('div', { class: 'btn-row' }, addF), fl),
    );
  }

  // Footprints of the search results as graphics in their own layer.
  function drawFootprints() {
    const p = app.activePane();
    if (!p) return;
    const h0 = p.geoLayer?.()?.defaultHeight?.() ?? 0;
    app.store.transact(t('Search results'), (tx) => {
      for (const g of app.store.all('graphic')) if (g.tag === 'stac') tx.delete(g.id);
      let gl = p.rec.graphicsLayer;
      if (!gl) {
        gl = tx.create('glayer', { pane: p.id, name: t('Graphics'), visible: true, saved: false });
        tx.set(p.id, 'graphicsLayer', gl);
      }
      for (const { item } of results) {
        const ring = item.geometry?.type === 'Polygon' ? item.geometry.coordinates[0] : item.geometry?.type === 'MultiPolygon' ? item.geometry.coordinates[0][0] : null;
        if (!ring) continue;
        tx.create('graphic', { glayer: gl, pane: p.id, shape: 'polygon', anchor: 'ground', coords: ring.map(([lon, lat]) => [lon, lat, h0]), text: item.id, style: { stroke: '#00e5ff', width: 1.5, fill: '#00e5ff10' }, created: new Date().toISOString(), tag: 'stac' });
      }
    });
    p.invalidate();
  }

  const reg = (mp) => mp.docks.register({ id: 'catalog', title: t('Catalog'), icon: 'list', home: 'right', create: (a, m, el) => {
    panelEl = el;
    renderPanel();
    return { onShow: renderPanel };
  } });
  app.on('ready', (mp) => reg(mp));
  app.on('network', renderPanel);
  C.implement('cat.panel', { run: () => app.panels?.toggle('catalog', 'right'), checked: () => !!app.activeMp()?.docks.isOpen('catalog') });
}
