// Convert (2.0 plan P4; REQ-CNV-01..03): one drop zone that turns legacy formats into cloud-native
// ones without schema dialogs. Vectors (Shapefile, KML/KMZ, GPX, GeoPackage, CSV-WKT, GML,
// GeoJSON) go to GeoJSON, GeoParquet 1.1 (WKB + "geo" metadata) or FlatGeobuf (flatgeobuf 4.4.0,
// BSD-3-Clause, lazy block js-fgb; no spatial index); rasters (GeoTIFF, NITF,
// JPEG 2000, DTED…) go to a Cloud-Optimized GeoTIFF: 512 px tiles, Deflate with a predictor and
// overviews. Up to CAP_SAMPLES samples the COG is built in memory; larger images go through the
// streaming writer (formats/cog-stream.js: one tile row in memory, BigTIFF past 4 GB; DN-59).

import { h, clear } from '../shell/dom.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { writeCogStream } from '../formats/cog-stream.js';
import { openImageFile, isImageName } from '../formats/open.js';
import { sniffName } from '../formats/sniff.js';
import { toGeoJSON } from '../vector/geom.js';

export const name = 'convert';

const VECTOR_RE = /\.(geojson|json|kml|kmz|shp|zip|gpkg|csv|gml|gpx)$/i;
export const CAP_SAMPLES = 256e6; // width × height × bands held in memory for one COG

/** A GeoParquet 1.1 file (WKB geometry, "geo" metadata) from an app vector layer. */
export function geoParquet(P, layer) {
  const feats = layer.features.filter((f) => f.geom);
  const geoms = feats.map((f) => toGeoJSON(f.geom, 9));
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const types = new Set();
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      bbox[0] = Math.min(bbox[0], c[0]);
      bbox[1] = Math.min(bbox[1], c[1]);
      bbox[2] = Math.max(bbox[2], c[0]);
      bbox[3] = Math.max(bbox[3], c[1]);
    } else c.forEach(walk);
  };
  for (const g of geoms) {
    types.add(g.type);
    walk(g.coordinates);
  }
  const names = [...new Set(feats.flatMap((f) => Object.keys(f.attrs ?? {})))];
  const columnData = names.map((n) => {
    const vals = feats.map((f) => f.attrs?.[n]);
    const num = vals.every((v) => v === null || v === undefined || typeof v === 'number');
    return { name: n, data: vals.map((v) => (v === undefined ? null : num ? v : v === null ? null : String(v))), type: num ? 'DOUBLE' : 'STRING' };
  });
  if (feats.some((f) => f.name)) columnData.unshift({ name: 'name', data: feats.map((f) => f.name ?? null), type: 'STRING' });
  columnData.push({ name: 'geometry', data: geoms.map((g) => P.geojsonToWkb(g)), type: 'BYTE_ARRAY' });
  const geo = { version: '1.1.0', primary_column: 'geometry', columns: { geometry: { encoding: 'WKB', geometry_types: [...types], bbox: bbox.every(Number.isFinite) ? bbox : undefined } } };
  return P.parquetWriteBuffer({ columnData, kvMetadata: [{ key: 'geo', value: JSON.stringify(geo) }] });
}

export function install(app) {
  const C = app.commands;
  const queue = []; // {name, target, state, detail}
  let panelEl = null;
  let Parquet = null;
  let Fgb = null;

  async function vectorTo(files, target) {
    const before = new Set(app.store.all('vlayer').map((v) => v.id));
    await app.openVectorFiles(files);
    const made = app.store.all('vlayer').filter((v) => !before.has(v.id));
    if (!made.length) throw new Error('no vector layer could be read');
    for (const v of made) {
      if (target === 'geoparquet') {
        Parquet ??= await app.gw.runScript('js-parquet');
        const buf = geoParquet(Parquet, app.vectorLayerOut(v.id));
        const stem = (v.name || 'layer').replace(/[^\w.-]+/g, '_');
        await saveBlob(app, new Blob([buf], { type: 'application/vnd.apache.parquet' }), { name: `${stem}.parquet`, types: ['.parquet'], description: 'GeoParquet' });
      } else if (target === 'flatgeobuf') {
        // FlatGeobuf from the layer's GeoJSON (WGS 84), without a spatial index (DN-59).
        Fgb ??= await app.gw.runScript('js-fgb');
        const fc = JSON.parse(await app.encodeLayer(v.id, 'geojson').blob.text());
        const stem = (v.name || 'layer').replace(/[^w.-]+/g, '_');
        await saveBlob(app, new Blob([Fgb.serialize(fc, 4326)], { type: 'application/flatgeobuf' }), { name: `${stem}.fgb`, types: ['.fgb'], description: 'FlatGeobuf' });
      } else {
        const out = app.encodeLayer(v.id, 'geojson');
        await saveBlob(app, out.blob, { name: out.name, types: out.types, description: 'GeoJSON' });
      }
    }
    return `${made.length} layer${made.length > 1 ? 's' : ''} written`;
  }

  /** A COG of an open image layer (REQ-CNV-01): full resolution, all bands. */
  /** Georeference options of a COG of layer l: its geotransform, or a 9 × 9 GCP grid of its sensor model. */
  function cogGeo(l, opts) {
    const gt = l.info.meta?.geotransform;
    const epsg = l.info.meta?.epsg;
    if (gt && epsg && !gt[2] && !gt[4]) {
      opts.epsg = epsg;
      opts.geotransform = gt;
    } else if (l.modelId) {
      // A sensor-model image: ground control points on a 9 × 9 grid (EPSG:4326).
      opts.epsg = 4326;
      opts.gcps = [];
      for (let j = 0; j <= 8; j++)
        for (let i = 0; i <= 8; i++) {
          const x = (i / 8) * l.width;
          const y = (j / 8) * l.height;
          const g = l.groundAt(x, y);
          if (g) opts.gcps.push({ x, y, lon: g.lon, lat: g.lat, h: g.h ?? 0 });
        }
    }
    return opts;
  }
  const TYPES = { Uint8Array: 'u8', Uint16Array: 'u16', Int16Array: 'i16', Float32Array: 'f32' };
  const stemOf = (l) => (l.rec?.name ?? 'image').replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_');

  /** Larger images: the streaming writer (formats/cog-stream.js), one tile row in memory at a time. */
  async function layerToCogStream(l, onProgress) {
    const n = l.bands;
    const bands = [...Array(n).keys()];
    const probe = await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: 4, h: 4, step: 1, bands }, { affinity: l.affinity, label: 'COG: sample type' });
    const Arr = probe.planes[0].constructor;
    const type = TYPES[Arr.name];
    if (!type) throw new Error(`no COG writer for ${Arr.name} samples`);
    // The temporary tiles need about the result's size in browser storage (raw × 0.7 allows for poor compression).
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const need = l.width * l.height * n * Arr.BYTES_PER_ELEMENT * 0.7;
    if (est?.quota && est.quota - (est.usage ?? 0) < need) throw new Error(`converting ${l.rec?.name} needs about ${(need / 1e9).toFixed(1)} GB of free browser storage; ${((est.quota - (est.usage ?? 0)) / 1e9).toFixed(1)} GB is available`);
    const read = async (k, x0, y0, w, h) => {
      const s = 2 ** k;
      const r = await app.pool.run('window', { handle: l.handle, x0: x0 * s, y0: y0 * s, w, h, step: s, bands }, { affinity: l.affinity, timeout: 600000, label: `COG: read level ${k}` });
      const out = new Arr(w * h * n);
      const rw = Math.min(w, r.w);
      for (let y = 0; y < Math.min(h, r.h); y++) for (let x = 0; x < rw; x++) for (let b = 0; b < n; b++) out[(y * w + x) * n + b] = r.planes[b][y * r.w + x];
      return out;
    };
    const opts = cogGeo(l, { tile: 512, compress: 'deflate', nodata: l.nodata ?? undefined, description: `${l.rec?.name} — Cloud-Optimized GeoTIFF by GIS Workbench` });
    const r = await writeCogStream({ width: l.width, height: l.height, bands: n, type, read }, opts, onProgress);
    try {
      await saveBlob(app, r.blob, { name: `${stemOf(l)}_cog.tif`, types: ['.tif'], description: 'Cloud-Optimized GeoTIFF' });
    } finally {
      await r.cleanup();
    }
    return `${(r.blob.size / 1048576).toFixed(1)} MB COG written (streamed${r.bigTiff ? ', BigTIFF' : ''}, ${r.levels} levels)`;
  }

  async function layerToCog(l, onProgress = () => {}, { stream = false } = {}) {
    const W = l.width;
    const H = l.height;
    const n = l.bands;
    if (stream || W * H * n > CAP_SAMPLES) return layerToCogStream(l, onProgress);
    const win = await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: W, h: H, step: 1, bands: [...Array(n).keys()], maxSamples: CAP_SAMPLES }, { affinity: l.affinity, timeout: 600000, label: `COG: read ${l.rec?.name}` });
    const Arr = win.planes[0].constructor;
    const type = TYPES[Arr.name];
    if (!type) throw new Error(`no COG writer for ${Arr.name} samples`);
    const data = new Arr(win.w * win.h * n);
    for (let b = 0; b < n; b++) for (let i = 0; i < win.w * win.h; i++) data[i * n + b] = win.planes[b][i];
    const opts = cogGeo(l, { tile: 512, compress: 'deflate', overviews: true, nodata: l.nodata ?? undefined, description: `${l.rec?.name} — Cloud-Optimized GeoTIFF by GIS Workbench` });
    const bytes = await writeGeoTiff({ width: win.w, height: win.h, bands: n, type, data }, opts);
    await saveBlob(app, new Blob([bytes], { type: 'image/tiff' }), { name: `${stemOf(l)}_cog.tif`, types: ['.tif'], description: 'Cloud-Optimized GeoTIFF' });
    return `${(bytes.byteLength / 1048576).toFixed(1)} MB COG written`;
  }
  app.convertToCog = async (layerId, opts = {}) => {
    const l = app.layers.get(layerId);
    if (!l) throw new Error('the layer is gone');
    return layerToCog(l, opts.onProgress, opts);
  };

  async function rasterToCog(file, onProgress) {
    const r = await openImageFile(app, file, { pane: app.activePane() });
    const l = r.layers?.[0];
    if (!l) throw new Error('the file has no image');
    return layerToCog(l, onProgress);
  }

  async function run(files, target) {
    files = await Promise.all([...files].map((f) => sniffName(f).catch(() => f)));
    const vectors = files.filter((f) => VECTOR_RE.test(f.name));
    const rasters = files.filter((f) => !vectors.includes(f) && isImageName(f.name));
    const other = files.filter((f) => !vectors.includes(f) && !rasters.includes(f));
    const job = (name, t) => {
      const q = { name, target: t, state: 'working', detail: '' };
      queue.unshift(q);
      render();
      return q;
    };
    if (vectors.length) {
      const vt = ['geoparquet', 'flatgeobuf'].includes(target) ? target : 'geojson';
      const q = job(vectors.map((f) => f.name).join(', '), { geoparquet: 'GeoParquet', flatgeobuf: 'FlatGeobuf', geojson: 'GeoJSON' }[vt]);
      try {
        q.detail = await vectorTo(vectors, vt);
        q.state = 'done';
      } catch (e) {
        q.state = 'failed';
        q.detail = e.message;
      }
      render();
    }
    for (const f of rasters) {
      const q = job(f.name, 'COG');
      try {
        q.detail = await rasterToCog(f, (fr) => {
          q.detail = `${Math.round(fr * 100)} %`;
          render();
        });
        q.state = 'done';
      } catch (e) {
        q.state = 'failed';
        q.detail = e.message;
      }
      render();
    }
    for (const f of other) {
      queue.unshift({ name: f.name, target: '—', state: 'skipped', detail: 'not a vector or raster format this tool converts' });
      render();
    }
    const failed = queue.filter((q) => q.state === 'failed').length;
    app.toast(failed ? `Convert: ${failed} failed — see the Convert panel` : 'Convert: done.', { kind: failed ? 'warn' : 'info' });
  }
  app.convertFiles = run;

  function render() {
    if (!panelEl) return;
    clear(panelEl);
    const target = h('select', { class: 'inp', 'data-id': 'convert:target', 'aria-label': 'Vector output' }, h('option', { value: 'geojson' }, 'Vectors → GeoJSON'), h('option', { value: 'geoparquet', selected: app.prefs.get('convertTarget') === 'geoparquet' }, 'Vectors → GeoParquet'), h('option', { value: 'flatgeobuf', selected: app.prefs.get('convertTarget') === 'flatgeobuf' }, 'Vectors → FlatGeobuf'));
    target.addEventListener('change', () => app.prefs.set('convertTarget', target.value));
    const zone = h('div', { class: 'drop-zone', tabindex: '0', role: 'button', 'data-id': 'convert:drop' }, h('strong', {}, 'Drop files here, or click to choose them') /* GUI-051 */, h('span', {}, 'Shapefile (zip), KML/KMZ, GPX, GeoPackage, CSV, GML → GeoJSON, GeoParquet or FlatGeobuf · GeoTIFF, NITF, JPEG 2000, DTED → Cloud-Optimized GeoTIFF'));
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('over');
      run([...(e.dataTransfer?.files ?? [])], target.value);
    });
    const pick = async () => run(await pickFiles(app, { multiple: true, accept: [], description: 'Files to convert' }), target.value);
    zone.addEventListener('click', pick);
    zone.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && pick());
    const list = h('ul', { class: 'cat-results', 'data-id': 'convert:queue' }, queue.slice(0, 50).map((q) => h('li', { class: ['cat-item', `cv-${q.state}`] }, h('div', {}, h('strong', {}, q.name), h('div', { class: 'small muted' }, `→ ${q.target} · ${q.state}${q.detail ? ` · ${q.detail}` : ''}`)))));
    panelEl.append(h('div', { class: 'cat' }, h('div', { class: 'btn-row' }, target), zone, list));
  }

  const reg = (mp) => mp.docks.register({ id: 'convert', title: 'Convert', icon: 'save', home: 'right', create: (a, m, el) => {
    panelEl = el;
    render();
    return { onShow: render };
  } });
  app.on('ready', (mp) => reg(mp));
  C.implement('cnv.open', { run: () => app.panels?.toggle('convert', 'right'), checked: () => !!app.activeMp()?.docks.isOpen('convert') });
  C.implement('cnv.cog', {
    enabled: () => !!app.activeLayer()?.handle,
    run: async () => {
      const l = app.activeLayer();
      app.toast(`Making a Cloud-Optimized GeoTIFF of ${l.rec?.name}…`);
      app.toast(await layerToCog(l));
    },
  });
}
