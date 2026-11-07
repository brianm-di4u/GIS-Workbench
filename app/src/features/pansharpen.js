// Pan-sharpened products (REQ-GAP-14): a fused image at pan resolution and the native bit depth,
// written as a streamed Cloud-Optimized GeoTIFF. Weighted Brovey, Laben–Brower Gram–Schmidt with a
// simulated pan, PCA, Ehlers and HCS run in the Rust `raster` bundle in the analysis workers, tile by
// tile (crates/gw-raster/src/pansharp.rs; the plan in analysis/pansharpen.js):
//   1. statistics: the MS on the work grid G_L (r × r pan pixels per sample) against the pan degraded
//      to it (Gaussian, gain `gnyq` at the MS Nyquist), and both degraded once more (Wald's reduced
//      scale); the method parameters come from these sums;
//   2. Wald's synthesis check: the degraded MS fused with the degraded pan, against the MS
//      (ERGAS, SAM, Q2ⁿ / Q4);
//   3. the product: fused tiles, each also degraded back to the MS grid against the MS (Wald's
//      consistency check), streamed into the COG (formats/cog-stream.js; BigTIFF past 4 GB).
// The display-only fusion (features/fusion.js, Enhance ▸ Pan Sharpen) is unchanged.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { writeCogStream } from '../formats/cog-stream.js';
import { openImageFile, helperOpens, closeHelpers } from '../formats/open.js';
import { SENSORS, detectSensor, sensorWeights, estimateWeights, simulatedPanFit, planParams, qualityOf, qualityLen, affineFromGeotransforms, fitAffine, ratioOf, statsTiles, statsPass, waldPass, fuseCore, eachWith } from '../analysis/pansharpen.js';
import { t, N_, tr, gwError, msgOf } from '../i18n/index.js';
import { num, int } from '../i18n/format.js';

export const name = 'pansharpen';

export const PRODUCT_METHODS = [
  ['gs', N_('Gram–Schmidt (Laben–Brower, simulated pan)')],
  ['pca', N_('Principal components (PCA)')],
  ['ehlers', N_('Ehlers (IHS and FFT filter)')],
  ['hcs', N_('Hyperspherical colour sharpening (HCS)')],
  ['brovey', N_('Weighted Brovey')],
];

const TILE = 512; // product tiles (pan pixels) and statistics tiles (G_L samples)
const TYPES = { Uint8Array: 'u8', Uint16Array: 'u16', Int16Array: 'i16', Float32Array: 'f32' };
const ARR = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array };
const MAX_WALD_TILES = 64; // degraded-pan tiles kept for the Wald pass (≈ 100 MB)

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const images = (p) => (p?.visibleLayers() ?? []).filter((l) => l.kind !== 'dem' && l.handle);

  /** Metadata text a sensor is recognised from (file names, NITF and TIFF fields, DG/Airbus XML). */
  const metaText = (l) => [l.rec?.name, l.info?.iid, l.info?.subheader?.ISORCE, l.info?.meta?.description, JSON.stringify(l.info?.meta?.tags ?? {}), JSON.stringify(l.info?.msi ?? l.info?.meta?.msi ?? {}), JSON.stringify(l.info?.meta?.imd ?? {})].filter(Boolean).join(' ').slice(0, 20000);

  /** Text of a layer's metadata sidecars (DigitalGlobe XML / IMD / TIL, DIMAP): the first 256 KB of each. */
  async function sidecarText(l) {
    const fref = l.rec?.file ? app.store.get(l.rec.file) : null;
    const ent = fref ? app.files.get(fref.id) : null;
    const out = [];
    for (const f of ent?.sidecars ?? []) if (/\.(xml|imd|til|dim)$/i.test(f.name ?? '')) out.push(await f.slice(0, 262144).text().catch(() => ''));
    return out.join(' ');
  }

  /** Native bit depth: NITF ABPP, TIFF MaxSampleValue or NBITS, else the sample type's. */
  function bitsOf(l, type) {
    const abpp = Number(l.info?.subheader?.ABPP);
    if (abpp > 0 && abpp <= 16) return abpp;
    const mx = Number(l.info?.meta?.maxSampleValue ?? l.info?.meta?.tags?.MaxSampleValue ?? l.info?.meta?.tags?.TIFFTAG_MAXSAMPLEVALUE);
    if (mx > 0 && mx < 65536) return Math.ceil(Math.log2(mx + 1));
    const nbits = Number(l.info?.meta?.nbits ?? l.info?.meta?.tags?.NBITS);
    if (nbits > 0) return nbits;
    return { u8: 8, u16: 16, i16: 16, f32: 32 }[type];
  }

  /** Pan pixel → MS pixel affine: from the geotransforms when both are map grids in one CRS, else through the sensor models. */
  function affineOf(ms, pan) {
    const gm = ms.info?.meta?.geotransform;
    const gp = pan.info?.meta?.geotransform;
    if (gm && gp && ms.info.meta.epsg && ms.info.meta.epsg === pan.info.meta.epsg) return { a: affineFromGeotransforms(gp, gm), by: 'geotransform' };
    if (!ms.modelId || !pan.modelId) throw gwError('the multispectral and pan images need georeferencing or sensor models to be placed on one grid', null, 'E_PS_NO_MODEL');
    const pairs = [];
    const hgt = pan.defaultHeight?.() ?? 0;
    for (let j = 0; j <= 8; j++)
      for (let i = 0; i <= 8; i++) {
        const X = (pan.width * i) / 8;
        const Y = (pan.height * j) / 8;
        const g = pan.groundAt(X, Y, hgt);
        const q = g ? ms.imageAt(g.lat, g.lon, g.h ?? hgt) : null;
        if (q) pairs.push({ X, Y, u: q.x, v: q.y });
      }
    if (pairs.length < 9) throw gwError('the two images do not overlap', null, 'E_PS_NO_OVERLAP');
    return { a: fitAffine(pairs), by: 'sensor models' };
  }

  /**
   * Run a pan-sharpened product. opts: {ms, pan (layer ids), method, weights | sensor, kernel
   * ('cubic' | 'bilinear'), gnyq (0.3), window {x0, y0, w, h} (pan pixels; default the whole pan),
   * quality (true), wald (true), roundMs (false), save (true), open (true), onProgress, signal {cancelled}}.
   * → the report.
   */
  async function product(opts) {
    const t0 = performance.now();
    const ms = app.layers.get(opts.ms);
    const pan = app.layers.get(opts.pan);
    if (!ms || !pan) throw gwError('choose the multispectral and the pan layer', null, 'E_STEP_FIRST');
    if (ms === pan) throw gwError('the multispectral and the pan layer must differ', null, 'E_STEP_FIRST');
    const method = opts.method ?? 'gs';
    const nb = ms.bands;
    if (nb < 2) throw gwError('the multispectral layer needs two bands or more', null, 'E_PS_BANDS');
    if (method === 'ehlers' && nb < 3) throw gwError('Ehlers fusion needs three bands or more', null, 'E_PS_BANDS');
    const { a, by } = affineOf(ms, pan);
    const ratio = 1 / Math.sqrt(Math.abs(a[1] * a[5] - a[2] * a[4]));
    const r = ratioOf(a);
    if (r < 2 || r > 16 || Math.abs(ratio - r) > 0.05 * r) throw gwError('the pan is {ratio} times finer than the MS; a product needs a whole ratio from 2 to 16', { ratio: num(ratio, 2) }, 'E_PS_RATIO');
    const type = ['u8', 'u16', 'i16', 'f32'].includes(pan.sampleType) ? pan.sampleType : 'f32';
    const bits = bitsOf(pan, type);
    const outMax = type === 'f32' ? 0 : 2 ** Math.min(bits, type === 'u8' ? 8 : 16) - 1;
    const sensor = opts.sensor === 'estimate' ? null : opts.sensor ?? detectSensor(`${metaText(ms)} ${metaText(pan)}`) ?? detectSensor(`${await sidecarText(ms)} ${await sidecarText(pan)}`);
    const sw = opts.weights ? null : sensor ? sensorWeights(sensor, nb) : null;
    let weights = opts.weights ?? sw?.weights ?? null; // null: estimated after the statistics
    const q4 = opts.q4 ?? (sensor ? sensorWeights(sensor, nb)?.q4 : null) ?? null;
    if (weights && weights.length !== nb) throw gwError('{n, plural, one {# weight} other {# weights}} for {b, plural, one {# band} other {# bands}}', { n: weights.length, b: nb }, 'E_PS_WEIGHTS');
    const job = { nb, r, kernel: opts.kernel ?? 'cubic', gnyq: opts.gnyq ?? 0.3, mw: ms.width, mh: ms.height, pw: pan.width, ph: pan.height, affine: a, type, max: outMax, roundMs: !!opts.roundMs, quality: opts.quality !== false, q4, method };
    // The product window (pan pixels), its origin on the 32-sample block grid of G_L.
    const W0 = opts.window ?? { x0: 0, y0: 0, w: pan.width, h: pan.height };
    const snap = 32 * r;
    const win = { x0: Math.max(0, Math.floor(W0.x0 / snap) * snap), y0: Math.max(0, Math.floor(W0.y0 / snap) * snap) };
    win.w = Math.min(pan.width, Math.ceil(W0.x0 + W0.w)) - win.x0;
    win.h = Math.min(pan.height, Math.ceil(W0.y0 + W0.h)) - win.y0;
    if (win.w < 4 * r || win.h < 4 * r) throw gwError('the product area is too small', null, 'E_PS_AREA');
    const progress = opts.onProgress ?? (() => {});
    const signal = opts.signal ?? { cancelled: false };
    const stop = () => {
      if (signal.cancelled) throw Object.assign(gwError('pan-sharpening cancelled', null, 'E_CANCELLED'), { cancelled: true });
    };
    const big = pan.width * pan.height > 64e6;
    const panSrc = [{ handle: pan.handle, affinity: pan.affinity }, ...(big ? await helperOpens(app, pan, Math.max(0, (app.pool.size ?? 2) - 1)) : [])];
    const msSrc = [{ handle: ms.handle, affinity: ms.affinity }, ...(big ? await helperOpens(app, ms, Math.max(0, Math.min(2, (app.pool.size ?? 2) - 1))) : [])];
    let turn = 0;
    const readPan = (rc) => {
      const s = panSrc[turn++ % panSrc.length];
      return app.pool.run('patch', { handle: s.handle, x: rc.x0, y: rc.y0, w: rc.w, h: rc.h, band: 0 }, { affinity: s.affinity, priority: 'background', timeout: 600000, label: t('pan-sharpen: read pan') }).then((p) => p.px);
    };
    const readMs = (rc) => {
      const s = msSrc[turn++ % msSrc.length];
      return app.pool.run('patch', { handle: s.handle, x: rc.x0, y: rc.y0, w: rc.w, h: rc.h, bands: [...Array(nb).keys()] }, { affinity: s.affinity, priority: 'background', timeout: 600000, label: t('pan-sharpen: read MS') }).then((p) => {
        const out = new Float32Array(rc.w * rc.h * nb);
        p.pxs.forEach((b, k) => out.set(b, k * rc.w * rc.h));
        return out;
      });
    };
    const conc = Math.max(1, app.pool.size ?? 2);
    const run = (op, label) => (spec, msPx, panPx, n) => app.pool.run(op, { spec, ms: msPx, pan: panPx, n, nq: n }, { kind: 'analysis', transfer: [spec.buffer, msPx.buffer, ...(op === 'ps.wald' ? [] : [panPx.buffer])], priority: 'background', timeout: 600000, label });
    const io = { readPan, readMs, stats: run('ps.stats', t('pan-sharpen: statistics')), wald: run('ps.wald', t('pan-sharpen: Wald check')), fuse: run('ps.fuse', t('pan-sharpen: fuse')), each: eachWith(conc, stop) };
    const report = { method, sensor: sensor ? SENSORS[sensor]?.name ?? sensor : null, registration: by, ratio: r, kernel: job.kernel, gnyq: job.gnyq, window: win, type, bits, bands: nb, tiles: {} };
    try {
      // ---- 1. statistics on G_L ----
      const stiles = statsTiles(job, win, TILE);
      const { S1, S2, lows } = await statsPass(io, job, stiles, { keepEvery: Math.max(1, Math.ceil(stiles.length / MAX_WALD_TILES)), wald: opts.wald !== false, progress: (f) => progress(0.25 * f) });
      report.tiles.stats = stiles.length;
      if (!weights) {
        weights = estimateWeights(S1, nb);
        report.weightsFrom = 'estimated';
      } else report.weightsFrom = opts.weights ? 'given' : 'sensor';
      report.weights = weights.map((w) => Math.round(w * 1e4) / 1e4);
      report.simulatedPanCorrelation = simulatedPanFit(S1, nb, weights);
      const P1 = planParams(S1, nb, method, weights, r);
      const P2 = planParams(S2, nb, method, weights, r);
      report.params = P1;
      // ---- 2. Wald's synthesis check at the reduced scale ----
      if (opts.wald !== false && lows.size) {
        const Q = await waldPass(io, job, P2, stiles, lows, { progress: (f) => progress(0.25 + 0.1 * f) });
        report.synthesis = { ...qualityOf(Q, nb, r), tiles: lows.size, of: stiles.length };
        lows.clear();
      }
      // ---- 3. the product ----
      const Qc = new Float64Array(qualityLen(nb));
      const Arr = ARR[type];
      let ftiles = 0;
      const read = async (level, x0, y0, w, hh) => {
        const out = new Arr(w * hh * nb);
        const cores = [];
        for (let ox = 0; ox < w; ox += TILE) cores.push({ x0: win.x0 + x0 + ox, y0: win.y0 + y0, w: Math.min(TILE, w - ox), h: hh, ox });
        await io.each(cores, async (core) => {
          const res = await fuseCore(io, job, P1, core);
          for (let k = 0; k < Qc.length; k++) Qc[k] += res.q[k];
          const src = new Arr(res.px.buffer, res.px.byteOffset, core.w * core.h * nb);
          for (let y = 0; y < core.h; y++) out.set(src.subarray(y * core.w * nb, (y + 1) * core.w * nb), (y * w + core.ox) * nb);
          ftiles++;
        });
        return out;
      };
      const gt = pan.info?.meta?.geotransform;
      const geo = {};
      if (gt && pan.info.meta.epsg && !gt[2] && !gt[4]) {
        geo.epsg = pan.info.meta.epsg;
        geo.geotransform = [gt[0] + win.x0 * gt[1], gt[1], 0, gt[3] + win.y0 * gt[5], 0, gt[5]];
      } else if (pan.modelId) {
        geo.epsg = 4326;
        geo.gcps = [];
        for (let j = 0; j <= 8; j++)
          for (let i = 0; i <= 8; i++) {
            const x = (i / 8) * win.w;
            const y = (j / 8) * win.h;
            const g = pan.groundAt(win.x0 + x, win.y0 + y);
            if (g) geo.gcps.push({ x, y, lon: g.lon, lat: g.lat, h: g.h ?? 0 });
          }
      }
      const label = PRODUCT_METHODS.find((m) => m[0] === method)?.[1] ?? method;
      const cogOpts = {
        tile: TILE,
        compress: 'deflate',
        ...geo,
        nodata: undefined,
        // Read when the header is written, after every tile: the consistency figures are known then.
        get description() {
          const c = qualityOf(Qc, nb, r);
          return `GIS Workbench pan-sharpened product | ${tr(label)} | ${nb} bands, ${bits}-bit | weights ${report.weights.join(' ')} | consistency ERGAS ${c.ergas.toFixed(3)} SAM ${c.sam.toFixed(3)} Q ${c.q.toFixed(4)} | ${ms.rec?.name} + ${pan.rec?.name}`;
        },
      };
      const encode = (b, o) => app.pool.run('tileenc', { bytes: b.buffer, ...o }, { kind: 'decode', transfer: [b.buffer], priority: 'background', label: t('COG: encode tile') }).then((x) => x.c);
      const cog = await writeCogStream({ width: win.w, height: win.h, bands: nb, type, read, parallel: 2, encode }, cogOpts, (f) => progress(0.35 + 0.65 * f));
      report.tiles.product = ftiles;
      report.consistency = qualityOf(Qc, nb, r);
      report.bytes = cog.blob.size;
      report.bigTiff = cog.bigTiff;
      report.levels = cog.levels;
      report.ms = Math.round(performance.now() - t0);
      const stem = `${(pan.rec?.name ?? 'pan').replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_')}_${method}_pansharpened`;
      report.name = `${stem}.tif`;
      if (opts.keepBlob) report.blob = cog.blob;
      let keep = 0;
      try {
        if (opts.save !== false) {
          const saved = await saveBlob(app, cog.blob, { name: report.name, types: ['.tif'], description: t('Pan-sharpened COG') });
          if (saved?.how === 'download') keep = saved.keepMs ?? 0;
        }
        if (opts.open !== false) {
          const file = new File([cog.blob], report.name, { type: 'image/tiff', lastModified: Date.now() });
          const { layers } = await openImageFile(app, file);
          report.layer = layers?.[0]?.id ?? null;
        }
      } finally {
        // The temporary tiles back the blob: kept while an opened layer or the caller reads it.
        if (opts.open !== false || opts.keepBlob) report.cleanup = cog.cleanup;
        else if (keep) setTimeout(() => cog.cleanup(), keep);
        else await cog.cleanup();
      }
      app.pansharpen.last = report;
      return report;
    } finally {
      closeHelpers(app, panSrc.slice(1));
      closeHelpers(app, msSrc.slice(1));
    }
  }

  const fmtQ = (q) => (q ? t('ERGAS {e}, SAM {s}°, Q {q}', { e: num(q.ergas, 2), s: num(q.sam, 2), q: Number.isFinite(q.q) ? num(q.q, 3) : '—' }) : '—');

  C.implement('enh.pansharpenproduct', {
    enabled: () => images(pane()).length >= 2,
    run: async () => {
      const p = pane();
      const ls = images(p);
      const opt = (l) => h('option', { value: l.id }, t('{layer} ({n, plural, one {# band} other {# bands}}, {w} × {h})', { layer: l.rec.name, n: l.bands, w: int(l.width), h: int(l.height) }));
      const ms = h('select', { class: 'inp', 'aria-label': t('Multispectral layer') }, ...ls.map(opt));
      const pan = h('select', { class: 'inp', 'aria-label': t('Pan layer') }, ...ls.map(opt));
      ms.value = (ls.find((l) => l.bands >= 3) ?? ls[0]).id;
      pan.value = (ls.find((l) => l.bands === 1) ?? ls.at(-1)).id;
      const method = h('select', { class: 'inp', 'aria-label': t('Method') }, ...PRODUCT_METHODS.map(([v, label]) => h('option', { value: v }, tr(label))));
      const sensor = h('select', { class: 'inp', 'aria-label': t('Sensor band weights') }, h('option', { value: 'auto' }, t('From the metadata')), h('option', { value: 'estimate' }, t('Estimated from the image')), ...Object.entries(SENSORS).map(([k, s]) => h('option', { value: k, disabled: !s.pan }, s.pan ? s.name : t('{sensor} (no pan band)', { sensor: s.name }))));
      const weights = h('input', { class: 'inp', placeholder: t('optional: one weight per band, comma separated'), 'aria-label': t('Band weights') });
      const kernel = h('select', { class: 'inp', 'aria-label': t('Resampling') }, h('option', { value: 'cubic' }, t('Cubic convolution')), h('option', { value: 'bilinear' }, t('Bilinear')));
      const area = h('select', { class: 'inp', 'aria-label': t('Area') }, h('option', { value: 'image' }, t('Whole pan image')), h('option', { value: 'view' }, t('The view')));
      const hint = h('p', { class: 'hint' }, t('Writes a Cloud-Optimized GeoTIFF at the pan resolution and bit depth, then opens it. Quality follows Wald’s protocol: the product degraded back to the MS grid against the MS, and the fusion repeated at a reduced scale against the MS.'));
      const body = h('div', {}, field(t('Multispectral'), ms), field(t('Pan'), pan), field(t('Method'), method), field(t('Band weights'), sensor), field(t('Custom weights'), weights), field(t('Resampling'), kernel), field(t('Area'), area), hint);
      if ((await modal({ title: t('Pan-Sharpened Product'), body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'pansharpen-product', width: 520 })) !== 'run') return;
      const custom = weights.value.trim() ? weights.value.split(/[,;\s]+/).filter(Boolean).map(Number) : null;
      if (custom && custom.some((v) => !Number.isFinite(v) || v < 0)) return app.toast(t('Band weights must be numbers of zero or more'), { kind: 'warn' });
      const sum = custom?.reduce((s, v) => s + v, 0);
      let window = null;
      if (area.value === 'view') {
        // The view's corners in pan pixels (through the ground when the pan is not the view's reference image).
        const pl = app.layers.get(pan.value);
        const ref = p.geoLayer?.() ?? pl;
        const { w, h: hh } = p.size();
        const cs = [[0, 0], [w, 0], [w, hh], [0, hh], [w / 2, hh / 2]].map(([x, y]) => {
          const q = p.imagePoint(x, y);
          if (ref === pl) return q;
          const g = ref.groundAt(q.x, q.y);
          return g ? pl.imageAt(g.lat, g.lon, g.h) : null;
        }).filter(Boolean);
        if (cs.length < 4) return app.toast(t('The view does not cover the pan image'), { kind: 'warn' });
        const x0 = Math.max(0, Math.min(...cs.map((c) => c.x)));
        const y0 = Math.max(0, Math.min(...cs.map((c) => c.y)));
        window = { x0, y0, w: Math.min(pl.width, Math.max(...cs.map((c) => c.x))) - x0, h: Math.min(pl.height, Math.max(...cs.map((c) => c.y))) - y0 };
      }
      const signal = { cancelled: false };
      app.toast(t('Pan-sharpened product started (the Job Queue shows the tiles)'), { kind: 'info', action: { label: t('Cancel'), run: () => (signal.cancelled = true) } });
      try {
        const r = await app.activity.track(t('Pan-sharpening…'), (job) => product({ ms: ms.value, pan: pan.value, method: method.value, weights: custom ? custom.map((v) => v / (sum || 1)) : null, sensor: sensor.value === 'auto' ? undefined : sensor.value, kernel: kernel.value, window, signal, onProgress: (f) => job.set(f) }));
        app.toast(t('Pan-sharpened product {name}: consistency {c}; reduced scale {s}', { name: r.name, c: fmtQ(r.consistency), s: fmtQ(r.synthesis) }), { kind: 'info', ms: 12000 });
      } catch (e) {
        app.toast(t('Pan-sharpened product: {msg}', { msg: msgOf(e) }), { kind: e?.cancelled || e?.code === 'E_STEP_FIRST' || e?.code === 'E_PS_RATIO' ? 'warn' : 'error', ms: 9000 });
      }
    },
  });

  app.pansharpen = { product, affineOf, bitsOf, last: null };
}
