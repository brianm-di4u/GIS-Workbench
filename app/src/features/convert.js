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
import { openImageFile, isImageName, helperOpens, closeHelpers } from '../formats/open.js';
import { sniffName } from '../formats/sniff.js';
import { toGeoJSON } from '../vector/geom.js';
import { modal, field } from '../shell/dialogs.js';
import { encodeHfa, encodeNetcdf3 } from '../formats/raster-writers.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { num, pct } from '../i18n/format.js';

export const name = 'convert';

const VECTOR_RE = /\.(geojson|json|kml|kmz|shp|zip|gpkg|csv|gml|gpx|fgb|parquet)$/i;
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

  /** An open vector layer as GeoParquet, FlatGeobuf or GeoJSON: {blob, name, types, description}. */
  async function encodeVector(id, target) {
    // An empty layer gave files the app cannot reopen, and FlatGeobuf failed on it (TE 2.0.4 cross).
    if (!app.vectorLayerOut(id).features.length) {
      const nm = app.store.get(id)?.name;
      throw nm ? gwError('{layer} has no features to save', { layer: nm }, 'E_NO_FEATURES') : gwError('the layer has no features to save', null, 'E_NO_FEATURES');
    }
    const stem = (app.store.get(id)?.name || 'layer').replace(/[^\w.-]+/g, '_');
    if (target === 'geoparquet') {
      Parquet ??= await app.gw.runScript('js-parquet');
      const buf = geoParquet(Parquet, app.vectorLayerOut(id));
      return { blob: new Blob([buf], { type: 'application/vnd.apache.parquet' }), name: `${stem}.parquet`, types: ['.parquet'], description: 'GeoParquet' };
    }
    if (target === 'flatgeobuf') {
      // FlatGeobuf from the layer's GeoJSON (WGS 84), without a spatial index (DN-59).
      Fgb ??= await app.gw.runScript('js-fgb');
      const fc = JSON.parse(await app.encodeLayer(id, 'geojson').blob.text());
      // Nested values (lists, structs, maps from GeoParquet) go as JSON text: the library's Json
      // columns did not read back ("Unexpected end of JSON input", GDAL's GeoParquet test file).
      for (const f of fc.features) for (const [k, v] of Object.entries(f.properties ?? {})) if (v && typeof v === 'object') f.properties[k] = JSON.stringify(v);
      return { blob: new Blob([Fgb.serialize(fc, 4326)], { type: 'application/flatgeobuf' }), name: `${stem}.fgb`, types: ['.fgb'], description: 'FlatGeobuf' };
    }
    return { ...app.encodeLayer(id, 'geojson'), description: 'GeoJSON' };
  }
  app.encodeVector = encodeVector;

  async function vectorTo(files, target) {
    const before = new Set(app.store.all('vlayer').map((v) => v.id));
    await app.openVectorFiles(files);
    const made = app.store.all('vlayer').filter((v) => !before.has(v.id));
    if (!made.length) throw new Error('no vector layer could be read');
    for (const v of made) {
      const out = await encodeVector(v.id, target);
      await saveBlob(app, out.blob, { name: out.name, types: out.types, description: out.description });
    }
    return t('{n, plural, one {# layer} other {# layers}} written', { n: made.length });
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

  /**
   * The bands a COG carries: all of them, except a complex SAR image's derived bands (amplitude,
   * phase, I, Q, power, β0, σ0, γ0), of which it takes the displayed one(s): all of them made a
   * 13 377 × 8 908 Umbra SICD a 3.2 GB COG in six minutes (TE 2.0.4 cross). The complex data stays in the source.
   */
  const cogBands = (l) => (l.info?.sar && l.bands > 3 ? [...new Set(l.chain?.bands ?? [0])] : [...Array(l.bands).keys()]);
  const sarNote = (l) => {
    if (!(l.info?.sar && l.bands > 3)) return '';
    const names = [t('amplitude'), t('phase'), 'I', 'Q', t('power'), 'β0', 'σ0', 'γ0'];
    const bands = cogBands(l);
    return t('SAR: the displayed {n, plural, one {band} other {bands}} ({bands}); the complex data stays in the source', { n: bands.length, bands: bands.map((b) => names[b] ?? t('band {n}', { n: b + 1 })).join(', ') });
  };

  /** Larger images: the streaming writer (formats/cog-stream.js), one tile row in memory at a time. */
  async function layerToCogStream(l, onProgress) {
    const bands = cogBands(l);
    const n = bands.length;
    const probe = await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: 4, h: 4, step: 1, bands }, { affinity: l.affinity, label: t('COG: sample type') });
    const Arr = probe.planes[0].constructor;
    const type = TYPES[Arr.name];
    if (!type) throw gwError('no COG writer for {type} samples', { type: Arr.name }, 'E_COG_SAMPLE_TYPE');
    // The temporary tiles need about the result's size in browser storage (raw × 0.7 allows for poor compression).
    const est = await navigator.storage?.estimate?.().catch(() => null);
    const need = l.width * l.height * n * Arr.BYTES_PER_ELEMENT * 0.7;
    if (est?.quota && est.quota - (est.usage ?? 0) < need) throw gwError('converting {layer} needs about {need} GB of free browser storage; {free} GB is available', { layer: l.rec?.name ?? '', need: num(need / 1e9, 1), free: num((est.quota - (est.usage ?? 0)) / 1e9, 1) }, 'E_STORAGE_QUOTA');
    // A large file is also opened in other decode workers and strips are read from all of them at
    // once: a whole WorldView J2K strip decoded on one worker took over 300 s (TE 2.0.4 cross).
    const stripBytes = Math.min(16384, l.width) * 512 * n * Arr.BYTES_PER_ELEMENT;
    const extra = l.width * l.height > 64e6 ? Math.max(0, Math.min(app.pool.size - 1, Math.floor(512e6 / stripBytes) - 1)) : 0;
    const helpers = extra ? await helperOpens(app, l, extra) : [];
    const srcs = [{ handle: l.handle, affinity: l.affinity }, ...helpers];
    let turn = 0;
    const read = async (k, x0, y0, w, h) => {
      const s = 2 ** k;
      const src = srcs[turn++ % srcs.length];
      // One output tile of every band (512² × 285 EMIT bands is past the window's 64 M default).
      const r = await app.pool.run('window', { handle: src.handle, x0: x0 * s, y0: y0 * s, w, h, step: s, bands, maxSamples: Math.max(64e6, w * h * n) }, { affinity: src.affinity, timeout: 600000, label: t('COG: read level {k}', { k }) });
      const out = new Arr(w * h * n);
      const rw = Math.min(w, r.w);
      for (let y = 0; y < Math.min(h, r.h); y++) for (let x = 0; x < rw; x++) for (let b = 0; b < n; b++) out[(y * w + x) * n + b] = r.planes[b][y * r.w + x];
      return out;
    };
    const opts = cogGeo(l, { tile: 512, compress: 'deflate', nodata: l.nodata ?? undefined, description: `${l.rec?.name} — Cloud-Optimized GeoTIFF by GIS Workbench` });
    let r;
    try {
      // Tiles are encoded in the decode workers too (any of them: no file needed).
      const encode = (b, o) => app.pool.run('tileenc', { bytes: b.buffer, ...o }, { kind: 'decode', transfer: [b.buffer], priority: 'background', label: t('COG: encode tile') }).then((r) => r.c);
      r = await writeCogStream({ width: l.width, height: l.height, bands: n, type, read, parallel: srcs.length, encode }, opts, onProgress);
    } finally {
      closeHelpers(app, helpers);
    }
    // The temporary tiles behind the blob stay until a browser download has read them: removed at
    // once, they cut a multi-GB download short (TE 2.0.4 cross, Capella COGs "not saved").
    let keep = 0;
    try {
      const saved = await saveBlob(app, r.blob, { name: `${stemOf(l)}_cog.tif`, types: ['.tif'], description: 'Cloud-Optimized GeoTIFF' });
      if (saved?.how === 'download') keep = saved.keepMs ?? 0;
    } finally {
      if (keep) setTimeout(() => r.cleanup(), keep);
      else await r.cleanup();
    }
    const note = sarNote(l);
    const args = { size: num(r.blob.size / 1048576, 1), big: r.bigTiff ? 'yes' : 'no', levels: r.levels, note };
    return note ? t('{size} MB COG written (streamed{big, select, yes {, BigTIFF} other {}}, {levels, plural, one {# level} other {# levels}}; {note})', args) : t('{size} MB COG written (streamed{big, select, yes {, BigTIFF} other {}}, {levels, plural, one {# level} other {# levels}})', args);
  }

  async function layerToCog(l, onProgress = () => {}, { stream = false } = {}) {
    const W = l.width;
    const H = l.height;
    const sel = cogBands(l);
    const n = sel.length;
    if (stream || W * H * n > CAP_SAMPLES) return layerToCogStream(l, onProgress);
    const win = await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: W, h: H, step: 1, bands: sel, maxSamples: CAP_SAMPLES }, { affinity: l.affinity, timeout: 600000, label: t('COG: read {layer}', { layer: l.rec?.name ?? '' }) });
    const Arr = win.planes[0].constructor;
    const type = TYPES[Arr.name];
    if (!type) throw gwError('no COG writer for {type} samples', { type: Arr.name }, 'E_COG_SAMPLE_TYPE');
    const data = new Arr(win.w * win.h * n);
    for (let b = 0; b < n; b++) for (let i = 0; i < win.w * win.h; i++) data[i * n + b] = win.planes[b][i];
    const opts = cogGeo(l, { tile: 512, compress: 'deflate', overviews: true, nodata: l.nodata ?? undefined, description: `${l.rec?.name} — Cloud-Optimized GeoTIFF by GIS Workbench` });
    const bytes = await writeGeoTiff({ width: win.w, height: win.h, bands: n, type, data }, opts);
    await saveBlob(app, new Blob([bytes], { type: 'image/tiff' }), { name: `${stemOf(l)}_cog.tif`, types: ['.tif'], description: 'Cloud-Optimized GeoTIFF' });
    const note = sarNote(l);
    return note ? t('{size} MB COG written ({note})', { size: num(bytes.byteLength / 1048576, 1), note }) : t('{size} MB COG written', { size: num(bytes.byteLength / 1048576, 1) });
  }
  app.convertToCog = async (layerId, opts = {}) => {
    const l = app.layers.get(layerId);
    if (!l) throw new Error('the layer is gone');
    // A MrSID/ECW footprint has no pixels (REQ-FMT-22): the sidecar converts it (REQ-FMT-23).
    if (l.info?.footprint) throw gwError('{format} is shown as a footprint only: use Convert with Sidecar to make a COG of its pixels', { format: l.info.footprint.format }, 'E_FOOTPRINT_ONLY');
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
        q.detail = msgOf(e);
      }
      render();
    }
    for (const f of rasters) {
      const q = job(f.name, 'COG');
      try {
        q.detail = await rasterToCog(f, (fr) => {
          q.detail = pct(fr, 0);
          render();
        });
        q.state = 'done';
      } catch (e) {
        q.state = 'failed';
        q.detail = msgOf(e);
      }
      render();
    }
    for (const f of other) {
      queue.unshift({ name: f.name, target: '—', state: 'skipped', detail: t('not a vector or raster format this tool converts') });
      render();
    }
    const failed = queue.filter((q) => q.state === 'failed').length;
    app.toast(failed ? t('Convert: {n} failed — see the Convert panel', { n: failed }) : t('Convert: done.'), { kind: failed ? 'warn' : 'info' });
  }
  app.convertFiles = run;

  function render() {
    if (!panelEl) return;
    clear(panelEl);
    const target = h('select', { class: 'inp', 'data-id': 'convert:target', 'aria-label': t('Vector output') }, h('option', { value: 'geojson' }, t('Vectors → {format}', { format: 'GeoJSON' })), h('option', { value: 'geoparquet', selected: app.prefs.get('convertTarget') === 'geoparquet' }, t('Vectors → {format}', { format: 'GeoParquet' })), h('option', { value: 'flatgeobuf', selected: app.prefs.get('convertTarget') === 'flatgeobuf' }, t('Vectors → {format}', { format: 'FlatGeobuf' })));
    target.addEventListener('change', () => app.prefs.set('convertTarget', target.value));
    const zone = h('div', { class: 'drop-zone', tabindex: '0', role: 'button', 'data-id': 'convert:drop' }, h('strong', {}, t('Drop files here, or click to choose them')) /* GUI-051 */, h('span', {}, t('Shapefile (zip), KML/KMZ, GPX, GeoPackage, CSV, GML → GeoJSON, GeoParquet or FlatGeobuf · GeoTIFF, NITF, JPEG 2000, DTED → Cloud-Optimized GeoTIFF')));
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
    const pick = async () => run(await pickFiles(app, { multiple: true, accept: [], description: t('Files to convert') }), target.value);
    zone.addEventListener('click', pick);
    zone.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && pick());
    const list = h('ul', { class: 'cat-results', 'data-id': 'convert:queue' }, queue.slice(0, 50).map((q) => h('li', { class: ['cat-item', `cv-${q.state}`] }, h('div', {}, h('strong', {}, q.name), h('div', { class: 'small muted' }, q.detail ? t('→ {target} · {state, select, working {working} done {done} failed {failed} skipped {skipped} other {{state}}} · {detail}', q) : t('→ {target} · {state, select, working {working} done {done} failed {failed} skipped {skipped} other {{state}}}', q))))));
    panelEl.append(h('div', { class: 'cat' }, h('div', { class: 'btn-row' }, target), zone, list));
  }

  const reg = (mp) => mp.docks.register({ id: 'convert', title: t('Convert'), icon: 'save', home: 'right', create: (a, m, el) => {
    panelEl = el;
    render();
    return { onShow: render };
  } });
  app.on('ready', (mp) => reg(mp));
  C.implement('cnv.open', { run: () => app.panels?.toggle('convert', 'right'), checked: () => !!app.activeMp()?.docks.isOpen('convert') });
  // ERDAS Imagine and NetCDF-3 (2.1, REQ-FMT-25/27): the active image in its own format again.
  app.encodeRaster = async (layerId, fmt, opts = {}) => {
    const l = app.layers.get(layerId);
    if (!l?.handle) throw new Error('the layer has no image to save');
    if (fmt === 'hfa') return encodeHfa(app, l, opts);
    if (fmt === 'nc3' || fmt === 'netcdf3') return encodeNetcdf3(app, l, opts);
    throw gwError('no raster writer "{format}"', { format: fmt }, 'E_NO_RASTER_WRITER');
  };
  const saveRaster = async (fmt) => {
    const l = app.activeLayer();
    const what = fmt === 'hfa' ? 'ERDAS Imagine' : 'NetCDF-3';
    app.toast(t('Writing {layer} as {format}…', { layer: l.rec?.name ?? '', format: what }), { kind: 'info' });
    try {
      const r = await app.activity.track(t('Writing {layer} as {format}…', { layer: l.rec?.name ?? '', format: what }), (job) => app.encodeRaster(l.id, fmt, { onProgress: (f) => job.set(f) }));
      await saveBlob(app, r.blob, { name: r.name, types: r.types, description: r.description });
      app.toast(t('{file}: {size} MB {format} written ({note})', { file: r.name, size: num(r.blob.size / 1048576, 1), format: what, note: r.note }), { kind: 'info' });
    } catch (e) {
      app.toast(t('{format} of {layer}: {msg}', { format: what, layer: l.rec?.name ?? '', msg: msgOf(e) }), { kind: e.cancelled ? 'info' : 'error', ms: 8000 });
    }
  };
  C.implement('cnv.hfa', { enabled: () => !!app.activeLayer()?.handle, run: () => saveRaster('hfa') });
  C.implement('cnv.nc3', { enabled: () => !!app.activeLayer()?.handle, run: () => saveRaster('nc3') });
  C.implement('cnv.saveimage', {
    enabled: () => !!app.activeLayer()?.handle,
    run: async () => {
      const l = app.activeLayer();
      const fmt = h('select', { class: 'inp', 'aria-label': t('Format'), 'data-id': 'saveimage:format' }, h('option', { value: 'cog' }, t('Cloud-Optimized GeoTIFF (.tif)')), h('option', { value: 'hfa' }, t('ERDAS Imagine (.img, with overviews and statistics)')), h('option', { value: 'nc3' }, t('NetCDF-3 CF-1.8 (.nc, 64-bit offset)')));
      const buttons = [{ label: t('Save'), value: 'save', primary: true }, { label: t('Cancel'), value: 'cancel' }];
      if ((await modal({ title: t('Save Image As — {layer}', { layer: l.rec?.name ?? '' }), body: field(t('Format'), fmt), buttons, id: 'save-image' })) !== 'save') return;
      if (fmt.value === 'cog') return C.run('cnv.cog');
      return saveRaster(fmt.value);
    },
  });
  C.implement('cnv.cog', {
    enabled: () => !!app.activeLayer()?.handle,
    run: async () => {
      const l = app.activeLayer();
      app.toast(t('Making a Cloud-Optimized GeoTIFF of {layer}…', { layer: l.rec?.name ?? '' }), { kind: 'info' });
      try {
        app.toast(await app.activity.track(t('Making a Cloud-Optimized GeoTIFF of {layer}…', { layer: l.rec?.name ?? '' }), (job) => layerToCog(l, (f) => job.set(f))), { kind: 'info' });
      } catch (e) {
        app.toast(t('Cloud-Optimized GeoTIFF of {layer}: {msg}', { layer: l.rec?.name ?? '', msg: msgOf(e) }), { kind: e.cancelled ? 'info' : 'error', ms: 8000 });
      }
    },
  });
}
