// Data hub (2.0 plan P4; REQ-CON-01..06): one Catalog panel for data that is not a file on the
// desk — a URL, an S3-compatible bucket (public, presigned, or signed with keys held in memory),
// a STAC API (Earth Search, Microsoft Planetary Computer with SAS signing) and local folders the
// analyst bookmarks, watched for new files while the app is open. Everything opens by range:
// only the header, the overviews and the tiles in view are read (connectors/remote.js).

import { minOf, maxOf } from '../core/util.js';
import { h, clear } from '../shell/dom.js';
import { modal, field, promptBox } from '../shell/dialogs.js';
import { remoteFile, httpsUrl, KNOWN_REGIONS } from '../connectors/remote.js';
import { signV4 } from '../connectors/sigv4.js';
import { openImageFile, isImageName } from '../formats/open.js';

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
        const t = await sasToken(col);
        return (href, init) => ({ url: `${href}${href.includes('?') ? '&' : '?'}${t}`, init });
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
    if (!r.ok) throw new Error(`Planetary Computer did not sign ${collection} (HTTP ${r.status})`);
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
    app.toast(`Opening ${f.name} by range (${(f.size / 1048576).toFixed(1)} MB on the server; only what is shown is read)…`);
    const r = await openImageFile(app, f, { pane: pane ?? app.activePane() });
    const lid = r.layers?.[0]?.id;
    app.toast(`Opened ${f.name}: ${f.stats.ranges} range request${f.stats.ranges === 1 ? '' : 's'}, ${(f.stats.bytes / 1048576).toFixed(2)} MB read so far.`, lid ? { action: { label: 'Zoom to layer', run: () => app.zoomToLayer?.(lid) } } : undefined);
    return r;
  }
  app.openUrl = openUrl;
  C.implement('file.openurl', {
    run: async (u) => {
      const url = typeof u === 'string' ? u : await promptBox('Open from URL', 'Address', '', { placeholder: 'https://…/image.tif · s3://bucket/key.tif · gs://bucket/key.tif', hint: 'Cloud-Optimized GeoTIFFs stream: only the header, the overviews and the tiles in view are read.' });
      if (url) await openUrl(url.trim());
    },
  });

  // ---------------- STAC (REQ-CON-06) ----------------
  async function stacSearch(api, { bbox, datetime, collections, limit = 24 }) {
    const body = { bbox, limit, collections, ...(datetime ? { datetime } : {}), sortby: [{ field: 'properties.datetime', direction: 'desc' }] };
    const fetch = app.netlog.fetchFor(`STAC: ${api.name}`);
    let r = await fetch(`${api.url}/search`, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 400 || r.status === 422) {
      // Some APIs refuse sortby; ask again without it.
      delete body.sortby;
      r = await fetch(`${api.url}/search`, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    }
    if (!r.ok) throw new Error(`${api.name}: search failed (HTTP ${r.status})`);
    const j = await r.json();
    return j.features ?? [];
  }
  app.stacSearch = stacSearch;

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
    if (!best) throw new Error(`${item.id}: no GeoTIFF asset to open`);
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
    if (r.status === 403) throw new Error(`${bucket}: listing is not allowed (private or requester-pays bucket; add keys, or open a presigned URL)`);
    if (!r.ok) throw new Error(`${bucket}: HTTP ${r.status}`);
    const doc = new DOMParser().parseFromString(await r.text(), 'application/xml');
    const txt = (n, t) => n.getElementsByTagName(t)[0]?.textContent ?? '';
    const folders = [...doc.getElementsByTagName('CommonPrefixes')].map((n) => txt(n, 'Prefix'));
    const files = [...doc.getElementsByTagName('Contents')].map((n) => ({ key: txt(n, 'Key'), size: Number(txt(n, 'Size')) }));
    return { bucket, prefix, folders, files, base };
  }
  app.listBucket = listBucket;
  C.implement('cat.s3keys', {
    run: async () => {
      const b = h('input', { class: 'inp', placeholder: 'bucket name', spellcheck: 'false' });
      const id = h('input', { class: 'inp', placeholder: 'Access key ID', spellcheck: 'false', autocomplete: 'off' });
      const sec = h('input', { class: 'inp', type: 'password', placeholder: 'Secret access key', autocomplete: 'off' });
      const tok = h('input', { class: 'inp', type: 'password', placeholder: 'Session token (optional, preferred)', autocomplete: 'off' });
      const reg = h('input', { class: 'inp', placeholder: 'us-east-1', spellcheck: 'false' });
      const ep = h('input', { class: 'inp', placeholder: 'https://minio.example.org (MinIO or another S3-compatible service; empty for AWS)', spellcheck: 'false' });
      const r = await modal({ title: 'Connect a Bucket', body: h('div', {}, field('Bucket', b), field('Access key ID', id), field('Secret access key', sec), field('Session token', tok), field('Region', reg), field('Endpoint', ep), h('p', { class: 'hint' }, 'Keys stay in this tab\'s memory only: they are never written to disk, the project or an export. Prefer short-lived session credentials or presigned URLs. A private bucket must allow this page in its CORS settings, and a custom endpoint must be added to the Network Allow-List. GCS works the same way with HMAC keys and the endpoint https://storage.googleapis.com.')), buttons: ['Connect', 'Cancel'], width: 560, id: 's3keys' });
      if (r !== 'Connect' || !b.value.trim()) return;
      keys.set(b.value.trim(), { accessKeyId: id.value.trim(), secretAccessKey: sec.value, sessionToken: tok.value || null, region: reg.value.trim() || 'us-east-1', endpoint: ep.value.trim() || null });
      app.toast(`Keys for ${b.value.trim()} are held in memory for this session.`);
    },
  });

  // ---------------- Local folders (REQ-CON-02) ----------------
  const folders = []; // {name, handle, files: Map(name → {size, lastModified}), watcher}
  async function scan(dir, base = '', out = new Map(), depth = 0) {
    for await (const [name, hnd] of dir.entries()) {
      if (hnd.kind === 'directory' && depth < 3) await scan(hnd, `${base}${name}/`, out, depth + 1);
      else if (hnd.kind === 'file' && (isImageName(name) || /\.(geojson|kml|kmz|shp|zip|gpkg|las|laz|pmtiles)$/i.test(name))) {
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
    app.toast(`${fo.name}: ${names.length} new file${names.length > 1 ? 's' : ''} (${first}${names.length > 1 ? ', …' : ''}).`, { action: { label: 'Open', run: async () => app.openFiles([await fo.files.get(first).handle.getFile()]) } });
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
      app.toast(`${fo.name}: ${fo.files.size} file${fo.files.size === 1 ? '' : 's'} catalogued; new files will appear while GIS Workbench is open.`);
      app.panels?.show('catalog', 'right');
    },
  });

  // ---------------- The Catalog panel ----------------
  let panelEl = null;
  let results = [];
  let listing = null;
  function renderPanel() {
    if (!panelEl) return;
    clear(panelEl);
    const api0 = app.prefs.get('stacApi') ?? STAC_APIS[0].id;
    // URL
    const url = h('input', { class: 'inp', placeholder: 'https://…/image.tif · s3://… · gs://…', spellcheck: 'false', 'data-id': 'catalog:url', 'aria-label': 'Image address' });
    const go = h('button', { class: 'btn', 'data-id': 'catalog:open-url' }, 'Open');
    // An empty box says so instead of doing nothing (GUI-051).
    const typeFirst = (input, what) => (input.value.trim() ? true : (app.toast(`Type ${what} first.`, { kind: 'warn' }), input.focus(), false));
    go.addEventListener('click', () => typeFirst(url, 'an image address (https://, s3:// or gs://)') && openUrl(url.value.trim()).catch((e) => app.toast(e.message, { kind: 'warn', ms: 8000 })));
    url.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
    // STAC
    const apiSel = h('select', { class: 'inp', 'data-id': 'catalog:api' }, STAC_APIS.map((a) => h('option', { value: a.id, selected: a.id === api0 }, a.name)));
    const api = () => STAC_APIS.find((a) => a.id === apiSel.value);
    const colSel = h('select', { class: 'inp', 'data-id': 'catalog:collection' });
    const fillCols = () => clear(colSel).append(...api().collections.map((c) => h('option', { value: c }, c)));
    fillCols();
    apiSel.addEventListener('change', () => {
      app.prefs.set('stacApi', apiSel.value);
      fillCols();
    });
    const from = h('input', { class: 'inp', type: 'date', 'aria-label': 'From date' });
    const to = h('input', { class: 'inp', type: 'date', 'aria-label': 'To date' });
    const search = h('button', { class: 'btn btn-primary', 'data-id': 'catalog:search' }, 'Search this view');
    const status = h('div', { class: 'hint', 'aria-live': 'polite' });
    search.addEventListener('click', async () => {
      const bbox = viewBox();
      if (!bbox) return app.toast('Search this view: open a georeferenced image first (or type a place with Ctrl+K), so the search knows where to look', { kind: 'warn' });
      status.textContent = 'Searching…';
      try {
        const dt = from.value || to.value ? `${from.value ? `${from.value}T00:00:00Z` : '..'}/${to.value ? `${to.value}T23:59:59Z` : '..'}` : null;
        results = (await stacSearch(api(), { bbox, datetime: dt, collections: [colSel.value] })).map((it) => ({ api: api(), item: it }));
        status.textContent = `${results.length} item${results.length === 1 ? '' : 's'} over this view.`;
        drawFootprints();
        renderResults();
      } catch (e) {
        status.textContent = e.message;
      }
    });
    const resultsEl = h('ul', { class: 'cat-results', 'data-id': 'catalog:results' });
    const renderResults = () => {
      clear(resultsEl);
      for (const { api: a, item } of results) {
        const p = item.properties ?? {};
        const cloud = Number.isFinite(p['eo:cloud_cover']) ? ` · ${Math.round(p['eo:cloud_cover'])} % cloud` : '';
        const b = h('button', { class: 'btn btn-small', 'data-id': `catalog:open:${item.id}` }, 'Open');
        b.addEventListener('click', () => openItem(a, item).catch((e) => app.toast(e.message, { kind: 'warn', ms: 8000 })));
        resultsEl.appendChild(h('li', { class: 'cat-item' }, h('div', {}, h('strong', {}, item.id), h('div', { class: 'small muted' }, `${(p.datetime ?? '').slice(0, 10)} · ${item.collection}${cloud}`)), b));
      }
    };
    renderResults();
    // S3
    const s3 = h('input', { class: 'inp', placeholder: 's3://maxar-opendata/events/', spellcheck: 'false', 'data-id': 'catalog:s3', 'aria-label': 'Bucket address', value: listing ? `s3://${listing.bucket}/${listing.prefix}` : '' });
    const ls = h('button', { class: 'btn', 'data-id': 'catalog:list' }, 'List');
    const keysBtn = h('button', { class: 'btn' }, 'Keys…');
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
        const open = h('button', { class: 'btn btn-small' }, 'Open');
        open.addEventListener('click', () => openUrl(`${listing.base}/${f.key}`).catch((e) => app.toast(e.message, { kind: 'warn', ms: 8000 })));
        lsOut.appendChild(h('li', { class: 'cat-item' }, h('span', {}, `${name} · ${(f.size / 1048576).toFixed(1)} MB`), isImageName(name) || /\.tiff?$/i.test(name) ? open : null));
      }
    };
    const browse = async (path) => {
      try {
        listing = await listBucket(path);
        s3.value = path;
        renderListing();
      } catch (e) {
        app.toast(e.message, { kind: 'warn', ms: 8000 });
      }
    };
    ls.addEventListener('click', () => typeFirst(s3, 'a bucket address (s3://bucket/prefix/)') && browse(s3.value.trim()));
    renderListing();
    // Folders
    const addF = h('button', { class: 'btn', 'data-id': 'catalog:add-folder' }, 'Add Folder…');
    addF.addEventListener('click', () => C.run('cat.folder'));
    const fl = h('ul', { class: 'cat-results' });
    for (const fo of folders) {
      fl.appendChild(h('li', { class: 'cat-head' }, `${fo.name} (${fo.files.size}${fo.watcher ? ', watched' : ', checked every 10 s'})`));
      for (const [k, v] of [...fo.files.entries()].slice(0, 200)) {
        const b = h('button', { class: 'btn btn-small' }, 'Open');
        b.addEventListener('click', async () => app.openFiles([await v.handle.getFile()]));
        fl.appendChild(h('li', { class: 'cat-item' }, h('span', {}, `${k} · ${(v.size / 1048576).toFixed(1)} MB`), b));
      }
    }
    const offline = app.network && !app.network.isOnline() ? h('p', { class: 'hint warn' }, app.network.airgap ? 'This is the air-gapped file: only local folders are available.' : 'Offline: go online (status bar) to search catalogues and open cloud data.') : null;
    panelEl.append(
      h('div', { class: 'cat' }, offline,
        h('h4', {}, 'Open from a URL'), h('div', { class: 'btn-row' }, url, go),
        h('h4', {}, 'Search a catalogue (STAC)'), field('Catalogue', apiSel), field('Collection', colSel), h('div', { class: 'btn-row' }, field('From', from), field('To', to)), h('div', { class: 'btn-row' }, search), status, resultsEl,
        h('h4', {}, 'Browse a bucket'), h('div', { class: 'btn-row' }, s3, ls, keysBtn), lsOut,
        h('h4', {}, 'Local folders'), h('div', { class: 'btn-row' }, addF), fl),
    );
  }

  // Footprints of the search results as graphics in their own layer.
  function drawFootprints() {
    const p = app.activePane();
    if (!p) return;
    const h0 = p.geoLayer?.()?.defaultHeight?.() ?? 0;
    app.store.transact('Search results', (tx) => {
      for (const g of app.store.all('graphic')) if (g.tag === 'stac') tx.delete(g.id);
      let gl = p.rec.graphicsLayer;
      if (!gl) {
        gl = tx.create('glayer', { pane: p.id, name: 'Graphics', visible: true, saved: false });
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

  const reg = (mp) => mp.docks.register({ id: 'catalog', title: 'Catalog', icon: 'list', home: 'right', create: (a, m, el) => {
    panelEl = el;
    renderPanel();
    return { onShow: renderPanel };
  } });
  app.on('ready', (mp) => reg(mp));
  app.on('network', renderPanel);
  C.implement('cat.panel', { run: () => app.panels?.toggle('catalog', 'right'), checked: () => !!app.activeMp()?.docks.isOpen('catalog') });
}
