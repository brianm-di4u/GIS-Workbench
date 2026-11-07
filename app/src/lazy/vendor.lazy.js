// Lazy 2.5 vendor-model block (REQ-GAP-20; group vendor). Loaded the first time an image opens
// with DigitalGlobe/Maxar support files, or Sensor Model ▸ Load Vendor Model… runs
// (features/vendor-models.js). The readers are Rust (gw_sensor::vendor, vendor bundle, analysis
// worker); this block finds the files, runs the job, registers the model in the core and adds it
// to the layer beside the RPC, which stays the active model.
//
// Families:
// - DigitalGlobe/Maxar Level 1B: .IMD + .EPH + .ATT + .GEO → rigorous line scanner (model type 2,
//   adjustable through "Sensor parameters" in the block adjustment).
// - Landsat 8/9 L1 (…_ANG.txt, optional …_MTL.txt) and Sentinel-2 L1C (MTD_TL.xml) → map + line of
//   sight (model type 4): the map grid plus the relief displacement of points above the reference
//   surface, for heights from parallax and elevated objects. On the reference surface it is the
//   map model.

import { t, N_, msgOf, gwError } from '../i18n/index.js';
import { modal } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { pickFiles } from '../storage/files.js';
import { vendorNotes, landsatBand, s2Band, parseTilOffsets } from '../sensor/vendor.js';

const DG_NAME = N_('Pushbroom (DigitalGlobe EPH/ATT/GEO, rigorous)');
const LS_NAME = N_('Map + line of sight (Landsat ANG)');
const S2_NAME = N_('Map + line of sight (Sentinel-2 MTD_TL)');

function addModel(app, layer, { name, id, record, notes, activate }) {
  const info = app.core.modelInfo(id);
  layer.models = (layer.models ?? []).filter((m) => m.name !== name);
  layer.models.push({ name, id, info, record, notes });
  if (activate) {
    layer.modelId = id;
    layer.modelName = name;
    layer.modelInfo = info;
    app.activePane?.()?.applyOrientation?.();
  }
  app.emit('state');
}

/** Reference heights for a map + line-of-sight record (per node: e, n, u, h): the session's DEM. */
function referenceFromDem(app, rec, name) {
  const id0 = app.core.recordModel(4, rec, name);
  try {
    const nx = rec[7];
    const ny = rec[8];
    const [x0, y0, dx, dy] = [rec[9], rec[10], rec[11], rec[12]];
    let n = 0;
    let src = null;
    const hs = new Float64Array(nx * ny).fill(NaN);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const g = app.core.i2g(id0, x0 + i * dx, y0 + j * dy, 0);
        const s = Number.isFinite(g.lat) ? app.terrain?.sample?.(g.lat, g.lon) : null;
        if (s) {
          hs[j * nx + i] = s.hae;
          src = s.name;
          n++;
        }
      }
    if (!n) return { rec, source: null };
    let mean = 0;
    for (const v of hs) if (Number.isFinite(v)) mean += v / n;
    const out = Float64Array.from(rec);
    for (let k = 0; k < nx * ny; k++) out[13 + 4 * k + 3] = Number.isFinite(hs[k]) ? hs[k] : mean;
    return { rec: out, source: src, covered: n / (nx * ny) };
  } finally {
    app.core.freeModel(id0);
  }
}

async function run(app, kind, parts, band, label) {
  return app.pool.run('vendorModel', { kind, parts, band, step: 32, href: 0 }, { kind: 'analysis', timeout: 120000, label });
}

/** DigitalGlobe support files beside an opened image → the rigorous model, beside the RPC. */
async function attachDg(app, layer, side, wanted) {
  const dg = side.dg ?? {};
  const missing = ['imd', 'eph', 'att', 'geo'].filter((k) => !dg[k]);
  const file = layer.rec?.name ?? '';
  if (missing.length) {
    layer.models = [...(layer.models ?? []), { name: DG_NAME, error: t('the product has no {files} file', { files: missing.map((m) => `.${m.toUpperCase()}`).join(', ') }) }];
    app.emit('state');
    return null;
  }
  let r;
  try {
    r = await run(app, 1, [dg.imd, dg.eph, dg.att, dg.geo], 0, t('rigorous model for {file}', { file }));
  } catch (e) {
    layer.models = [...(layer.models ?? []), { name: DG_NAME, error: msgOf(e) }];
    app.importLog?.push({ file, errors: [], warnings: [t('{model}: {msg}', { model: t(DG_NAME), msg: msgOf(e) })], layer: layer.rec?.id });
    app.emit('state');
    return null;
  }
  // The image's size must be the product's (a tile of a multi-tile product is offset by its .TIL).
  const tile = side.tiles?.[String(side.fileName ?? '').toLowerCase()] ?? null;
  const fullW = r.header.cols;
  const fullH = r.header.rows;
  if (!tile && (Math.abs(fullW - layer.width) > 0.5 || Math.abs(fullH - layer.height) > 0.5)) {
    const msg = t('the IMD describes a {w} × {h} image, the file is {fw} × {fh}', { w: String(fullW), h: String(fullH), fw: String(layer.width), fh: String(layer.height) });
    layer.models = [...(layer.models ?? []), { name: DG_NAME, error: msg }];
    app.emit('state');
    return null;
  }
  let id = app.core.recordModel(2, r.record, DG_NAME);
  if (tile && (tile[0] || tile[1])) id = app.core.offsetModel(id, tile[0], tile[1]);
  const notes = vendorNotes(r.header);
  addModel(app, layer, { name: DG_NAME, id, record: tile && (tile[0] || tile[1]) ? null : { type: 2, rec: Array.from(r.record) }, notes, activate: wanted === DG_NAME });
  app.importLog?.push({ file, errors: [], warnings: [t('{model}: added beside the RPC ({scan}); choose it in Sensor Model ▸ Active Model', { model: t(DG_NAME), scan: r.record[4] < 0 ? t('reverse scan') : t('forward scan') }), ...notes.map((n) => t('{model}: {msg}', { model: t(DG_NAME), msg: n }))], layer: layer.rec?.id });
  return id;
}

/** Vendor metadata files picked for the active image → the model(s) they describe. */
async function loadFiles(app, layer, files) {
  const by = (re) => files.find((f) => re.test(f.name));
  const text = (f) => (f ? f.text() : null);
  const file = layer.rec?.name ?? '';
  const imd = by(/\.imd$/i);
  const ang = by(/_ANG\.txt$/i);
  const tl = by(/^MTD_TL\.xml$/i) ?? files.find((f) => /\.xml$/i.test(f.name) && f.size < 8 << 20 && /^MTD_TL/i.test(f.name));
  if (imd) {
    const side = { dg: {}, fileName: file };
    for (const f of files) {
      const ext = /\.(imd|eph|att|geo)$/i.exec(f.name)?.[1]?.toLowerCase();
      if (ext) side.dg[ext] = await f.text();
    }
    const til = by(/\.til$/i);
    if (til) side.tiles = parseTilOffsets(await til.text());
    return { kind: 'dg', id: await attachDg(app, layer, side, null) };
  }
  if (ang) {
    const band = landsatBand(file);
    if (!Number.isFinite(band)) throw gwError('{file}: the band of a Landsat image is read from its file name (…_B4.TIF); this name has none', { file }, 'E_VENDOR_BAND');
    const r = await run(app, 2, [await text(ang)], band, t('line of sight for {file}', { file }));
    const mtl = by(/_MTL\.txt$/i);
    const notes = [];
    if (mtl) {
      const zone = /UTM_ZONE\s*=\s*(-?\d+)/.exec(await mtl.text())?.[1];
      if (zone && Number(zone) !== r.record[6] % 100) notes.push(t('the MTL and the ANG name different UTM zones'));
    }
    return finishLos(app, layer, r, LS_NAME, notes);
  }
  if (tl) {
    const band = s2Band(file);
    if (!(band >= 0)) throw gwError('{file}: the band of a Sentinel-2 image is read from its file name (…_B04.jp2); this name has none', { file }, 'E_VENDOR_BAND');
    const r = await run(app, 3, [await text(tl)], band, t('line of sight for {file}', { file }));
    return finishLos(app, layer, r, S2_NAME, [t('in the overlap of two detectors the line of sight is the mean of the two (the detector footprint masks are not read)')]);
  }
  throw gwError('No vendor metadata this build reads: pick a DigitalGlobe .IMD with its .EPH, .ATT and .GEO, a Landsat …_ANG.txt, or a Sentinel-2 MTD_TL.xml', {}, 'E_VENDOR_FILES');
}

function finishLos(app, layer, r, name, notes) {
  if (Math.abs(r.header.cols - layer.width) > 0.5 || Math.abs(r.header.rows - layer.height) > 0.5) throw gwError('the metadata describes a {w} × {h} band, the image is {fw} × {fh}', { w: String(r.header.cols), h: String(r.header.rows), fw: String(layer.width), fh: String(layer.height) }, 'E_VENDOR_SIZE');
  const ref = referenceFromDem(app, r.record, name);
  notes.push(ref.source ? t('reference surface: the DEM {dem} ({pct} % of the line-of-sight grid; the rest at its mean)', { dem: ref.source, pct: String(Math.round(100 * ref.covered)) }) : t('reference surface: 0 m HAE (no DEM covers the image); heights are then relative to the terrain model the product was made on'));
  const id = app.core.recordModel(4, ref.rec, name);
  // No worker record: the block adjustment (photo bundle) does not take map + line-of-sight models.
  addModel(app, layer, { name, id, record: null, notes, activate: false });
  app.importLog?.push({ file: layer.rec?.name ?? '', errors: [], warnings: [t('{model}: added beside the map model; choose it in Sensor Model ▸ Active Model', { model: t(name) }), ...notes.map((n) => t('{model}: {msg}', { model: t(name), msg: n }))], layer: layer.rec?.id });
  return { kind: 'los', id };
}

(globalThis.__lib ??= {})['js-vendor'] = {
  install(app) {
    app.vendorModels.attachDg = (layer, side, wanted) => attachDg(app, layer, side, wanted);
    app.vendorModels.loadFiles = (layer, files) => loadFiles(app, layer, files);
    app.commands.implement('model.vendor', {
      enabled: () => {
        const l = app.activeLayer?.();
        return !!(l && l.kind !== 'dem' && l.handle);
      },
      run: async () => {
        const l = app.activeLayer();
        const files = await pickFiles(app, { multiple: true, accept: ['.imd', '.eph', '.att', '.geo', '.til', '.txt', '.xml'], description: t('Vendor metadata') });
        if (!files.length) return null;
        try {
          const r = await loadFiles(app, l, files);
          const m = l.models.find((x) => x.id === r?.id);
          if (m) app.toast(t('{model} added to {layer}', { model: t(m.name), layer: l.rec?.name ?? '' }), { kind: 'info' });
          else if (r?.kind === 'dg') {
            const bad = l.models.filter((x) => x.name === DG_NAME && x.error).at(-1);
            if (bad) app.toast(t('{model}: {msg}', { model: t(DG_NAME), msg: bad.error }), { kind: 'error', ms: 9000 });
          }
          return r;
        } catch (e) {
          await modal({ title: t('Load Vendor Model'), body: h('p', { role: 'alert' }, msgOf(e)), buttons: [{ label: t('Close'), value: 'close', primary: true }], id: 'vendor-model' });
          return null;
        }
      },
    });
  },
};
