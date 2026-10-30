// Multispectral and hyperspectral exploitation (R3, `Research/10`): band metadata and the band
// list (REQ-MSI-01, AC-13.4), sensor-aware composite presets with wavelength fallback and Band
// Preview (REQ-MSI-03), Band Math compiled to shaders with the index presets (REQ-MSI-04),
// radiometric conversion and correction as stored chain steps with the state labelled
// (REQ-MSI-05/06), band statistics and SNR, the dockable spectral plot (REQ-MSI-07), and the
// cube read every algorithm uses. Classification, accuracy, detection and transforms are in
// `spectral-analysis.js`.

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { pickFiles } from '../storage/files.js';
import { parse as bmParse, toGlsl, INDICES, BAND_NAMES, bandByName, evaluate as bmEvaluate } from '../render/bandmath.js';
import { openMemoryLayer } from '../formats/open.js';
import { invertView } from '../render/renderer.js';

export const name = 'spectral';

/** Composite presets by band name (wavelength fallback through BAND_NAMES). */
export const PRESETS = {
  natural: ['Natural colour', ['red', 'green', 'blue']],
  cir: ['Colour infrared', ['nir', 'red', 'green']],
  swir: ['SWIR (geology / burn)', ['swir2', 'swir1', 'red']],
  agriculture: ['Agriculture', ['swir1', 'nir', 'blue']],
  rededge: ['Red edge (vegetation stress)', ['nir', 'rededge', 'red']],
  bathymetric: ['Bathymetric / coastal', ['red', 'green', 'coastal']],
};

/** WorldView-3 VNIR radiometric table (Maxar 2018v0 gain/offset, Thuillier ESUN) [unverified]. */
export const WV3_TABLE = {
  C: { gain: 0.938, offset: -13.099, esun: 1757.89 },
  B: { gain: 0.946, offset: -9.409, esun: 2004.61 },
  G: { gain: 0.958, offset: -7.771, esun: 1830.18 },
  Y: { gain: 0.979, offset: -5.489, esun: 1712.07 },
  R: { gain: 0.969, offset: -4.579, esun: 1535.33 },
  RE: { gain: 1.027, offset: -5.552, esun: 1348.08 },
  N: { gain: 0.977, offset: -6.508, esun: 1055.94 },
  N2: { gain: 1.007, offset: -3.699, esun: 858.77 },
};

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const layer = () => app.activeLayer();
  const pane = () => app.activePane();
  const toast = (m, o) => app.toast(m, o);

  /** Band metadata of a layer: [{name, cw (µm), fwhm (µm), bad}] (file or defaults). */
  // Landsat 8/9 OLI/TIRS (by band number) and Sentinel-2 MSI (by MTD band_id) names, centre
  // wavelengths and FWHM in µm, for band files that carry none (TE-056).
  const SENSOR_BANDS = {
    landsat: { 1: ['Coastal', 0.443, 0.016], 2: ['Blue', 0.482, 0.06], 3: ['Green', 0.561, 0.057], 4: ['Red', 0.655, 0.037], 5: ['NIR', 0.865, 0.028], 6: ['SWIR1', 1.609, 0.085], 7: ['SWIR2', 2.201, 0.187], 8: ['Pan', 0.59, 0.172], 9: ['Cirrus', 1.373, 0.02], 10: ['TIRS1', 10.895, 0.59], 11: ['TIRS2', 12.005, 1.01] },
    sentinel2: { 0: ['B01', 0.443, 0.02], 1: ['B02', 0.49, 0.065], 2: ['B03', 0.56, 0.035], 3: ['B04', 0.665, 0.03], 4: ['B05', 0.705, 0.015], 5: ['B06', 0.74, 0.015], 6: ['B07', 0.783, 0.02], 7: ['B08', 0.842, 0.115], 8: ['B8A', 0.865, 0.02], 9: ['B09', 0.945, 0.02], 10: ['B10', 1.375, 0.03], 11: ['B11', 1.61, 0.09], 12: ['B12', 2.19, 0.18] },
  };
  const S2_IDS = ['01', '02', '03', '04', '05', '06', '07', '08', '8A', '09', '10', '11', '12'];

  /** The sensor band of a one-band file from its name: Landsat `…_B10.TIF` → 10, Sentinel-2 `…_B8A.jp2` → band_id 8. */
  function bandFromName(name, sensor) {
    const m = /_B(\d{1,2}|8A)\.(tif|tiff|jp2)$/i.exec(name ?? '');
    if (!m) return null;
    if (sensor === 'sentinel2') {
      const i = S2_IDS.indexOf(m[1].toUpperCase().padStart(2, '0'));
      return i >= 0 ? i : null;
    }
    return sensor === 'landsat' ? Number(m[1]) : null;
  }

  function bandsOf(l) {
    const b = l?.rec?.bandsMeta ?? l?.info?.bandsMeta;
    if (b?.length === l.bands) return b;
    return Array.from({ length: l?.bands ?? 0 }, (_, i) => ({ name: `Band ${i + 1}`, cw: NaN, fwhm: NaN, bad: false }));
  }
  const hasWl = (l) => bandsOf(l).some((b) => Number.isFinite(b.cw));

  // ---- composites and Band Preview (REQ-MSI-03) ----

  function presetBands(l, key) {
    const [, names] = PRESETS[key];
    const bands = bandsOf(l);
    const idx = names.map((n) => bandByName(n, bands));
    const missing = names.filter((_, i) => idx[i] < 0);
    return { idx, missing };
  }
  function applyPreset(l, key) {
    const { idx, missing } = presetBands(l, key);
    if (missing.length) throw new Error(`${PRESETS[key][0]} needs ${missing.join(', ')} band(s), which this image does not have${hasWl(l) ? '' : ' (no wavelengths are known: use Band Selection)'}`);
    app.setChain(
      (c) => {
        c.bands = idx;
        c.bandMath = null;
        c.stretch = 'dra';
        c.enabled.stretch = true;
      },
      `Composite: ${PRESETS[key][0]}`,
      { layerId: l.id },
    );
    return l.ensureStats().then(() => {
      l.updateLut(true);
      app.renderer.invalidate();
      return idx;
    });
  }

  let preview = null;
  function bandPreview(l, on = !preview) {
    preview = on ? { layer: l.id, band: l.chain.bands[0] ?? 0 } : null;
    if (on) showBand(l, preview.band);
    app.emit('state');
    return preview;
  }
  function showBand(l, b) {
    const n = l.bands;
    const k = ((b % n) + n) % n;
    if (preview) preview.band = k;
    app.setChain(
      (c) => {
        c.bands = [k];
        c.bandMath = null;
        c.colour.palette = 'grey';
      },
      `Band ${k + 1}`,
      { layerId: l.id, mergeKey: `bandpreview:${l.id}` },
    );
    const m = bandsOf(l)[k];
    pane()?.mp?.status?.set?.({ dn: `Band ${k + 1}/${n}: ${m.name}${Number.isFinite(m.cw) ? ` · ${(m.cw * 1000).toFixed(1)} nm` : ''}${m.bad ? ' (bad band)' : ''}` });
    return l.ensureStats().then(() => {
      l.updateLut(true);
      app.renderer.invalidate();
      return k;
    });
  }
  window.addEventListener('keydown', (e) => {
    if (!preview || e.target?.closest?.('input, textarea, select')) return;
    const l = app.layers.get(preview.layer);
    if (!l) return (preview = null);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') showBand(l, preview.band + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') showBand(l, preview.band - 1);
    else if (e.key === 'Escape') bandPreview(l, false);
    else return;
    e.preventDefault();
  });

  // ---- Band Math (REQ-MSI-04) ----

  function setBandMath(l, text, { palette = 'diverging', range = null, label = null } = {}) {
    const r = bmParse(text, { bands: bandsOf(l), nb: l.bands });
    const bm = { text: r.text, ast: r.ast, bands: r.bands, glsl: toGlsl(r.ast), range, label: label ?? r.text };
    app.setChain(
      (c) => {
        c.bandMath = bm;
        c.bands = [r.bands[0]];
        c.colour.palette = palette;
        c.stretch = range ? 'none' : 'linear1';
        c.enabled.stretch = true;
      },
      `Band Math: ${bm.label}`,
      { layerId: l.id },
    );
    l.bmHist = null;
    return l.ensureStats().then(() => {
      l.updateLut(true);
      app.renderer.invalidate();
      return bm;
    });
  }
  function clearBandMath(l) {
    app.setChain((c) => (c.bandMath = null), 'Band Math off', { layerId: l.id });
    l.updateLut(true);
    app.renderer.invalidate();
  }
  function indexAvailable(l, key) {
    const r = (() => {
      try {
        bmParse(INDICES[key][1], { bands: bandsOf(l), nb: l.bands });
        return null;
      } catch (e) {
        return e.message;
      }
    })();
    return { ok: !r, reason: r };
  }
  function setIndex(l, key) {
    const [label, expr] = INDICES[key];
    return setBandMath(l, expr, { label, range: key === 'savi' ? [-1.5, 1.5] : [-1, 1] });
  }
  /** Full-resolution Band Math values over a window (export, checks). */
  async function bandMathValues(l, { x0 = 0, y0 = 0, w = l.width, h: hh = l.height, step = 1, text = null } = {}) {
    const bm = text ? bmParse(text, { bands: bandsOf(l), nb: l.bands }) : l.chain.bandMath;
    if (!bm) throw new Error('no Band Math expression');
    const r = l.radiometryFor(bm.bands);
    const c = await cube(l, { x0, y0, w, h: hh, step, bands: bm.bands, raw: true });
    const n = c.w * c.h;
    const planes = bm.bands.map((_, k) => {
      const p = new Float32Array(n);
      for (let i = 0; i < n; i++) p[i] = c.v[i * c.nb + k];
      return p;
    });
    return { v: bmEvaluate(bm.ast, planes, r), w: c.w, h: c.h, x0: c.x0, y0: c.y0 };
  }
  async function exportBandMath(l) {
    const bm = l.chain.bandMath;
    if (!bm) throw new Error('no Band Math expression on this layer');
    const r = await bandMathValues(l);
    return app.openMemoryLayer(l, { name: `${bm.label} — ${l.rec?.name ?? ''}`, bands: 1, sampleType: 'f32', planes: [r.v], nodata: NaN, chain: { stretch: bm.range ? 'none' : 'linear1', colour: { palette: 'diverging' } }, info: { radiometry: { state: `index (${bm.label})`, gain: null, offset: null, unit: bm.label, source: 'Band Math' }, bandsMeta: [{ name: bm.label, cw: NaN, fwhm: NaN, bad: false }] } });
  }

  // ---- the cube every algorithm reads (BIP f32 with the radiometric state applied) ----

  async function cube(l, { x0 = 0, y0 = 0, w = l.width, h: hh = l.height, step = 1, bands = null, raw = false, maxSamples } = {}) {
    const bs = bands ?? Array.from({ length: l.bands }, (_, i) => i);
    const r = raw ? { gain: null, offset: null } : l.radiometryFor(bs);
    return app.pool.run('cube', { handle: l.handle, x0, y0, w, h: hh, step, bands: bs, gain: r.gain, offset: r.offset, maxSamples }, { affinity: l.affinity, label: `cube ${l.rec?.name}`, timeout: 300000 });
  }

  // ---- radiometric state (REQ-MSI-05/06) ----

  function setRadiometry(l, r, label = `Radiometry: ${r.state}`, { bandsMeta = null } = {}) {
    S.transact(label, (tx) => {
      tx.set(l.id, 'radiometry', { ...r, at: new Date().toISOString() });
      if (bandsMeta) tx.set(l.id, 'bandsMeta', bandsMeta);
    });
    l.bmHist = null;
    if (l.chain.bandMath) l.ensureStats().then(() => l.updateLut(true));
    app.emit('state');
    return l.radiometry;
  }

  /**
   * Conversion from sensor metadata (parsed by the Rust `parse` bundle): Landsat MTL (L1 TOA
   * reflectance with the sun elevation, L2 surface reflectance, radiance), Sentinel-2 MTD
   * ((DN + offset)/quantification), WorldView IMD (radiance with the shipped gain/offset, then
   * TOA reflectance with ESUN, the Earth–Sun distance and the sun zenith). `bandMap` maps image
   * band k to the metadata band (default k + 1, or the IMD band order).
   */
  async function fromMetadata(l, file, { target = 'reflectance', bandMap = null } = {}) {
    const text = new Uint8Array(await file.arrayBuffer());
    const kind = /MTD_MSI|\.xml$/i.test(file.name) ? 2 : /\.imd$/i.test(file.name) ? 3 : 1;
    const parse = app.pool.run('msimeta', { kind, bytes: text }, { label: `metadata ${file.name}` });
    const m = await parse;
    const nb = l.bands;
    // TE-054/056: Landsat and Sentinel-2 deliver one file per band; its name says which band it is.
    if (!bandMap && nb === 1) {
      const b = bandFromName(l.rec?.name ?? l.info?.fileName, m.sensor);
      if (b !== null) bandMap = [b];
    }
    const gain = new Array(nb).fill(1);
    const offset = new Array(nb).fill(0);
    let state;
    let unit;
    if (m.sensor === 'landsat') {
      const bandNo = (k) => bandMap?.[k] ?? k + 1;
      for (let k = 0; k < nb; k++) {
        const b = m.bands.find((x) => x.band === bandNo(k));
        if (!b) continue;
        if (m.level2 && target !== 'radiance') {
          gain[k] = m.level2.srMult;
          offset[k] = m.level2.srAdd;
        } else if (target === 'radiance') {
          gain[k] = b.radMult;
          offset[k] = b.radAdd;
        } else {
          const s = Math.sin((m.sunElevation * Math.PI) / 180);
          gain[k] = b.reflMult / s;
          offset[k] = b.reflAdd / s;
        }
      }
      state = m.level2 && target !== 'radiance' ? 'surface reflectance (Landsat L2)' : target === 'radiance' ? 'radiance' : 'TOA reflectance';
      unit = target === 'radiance' ? 'W m⁻² sr⁻¹ µm⁻¹' : 'reflectance';
    } else if (m.sensor === 'sentinel2') {
      for (let k = 0; k < nb; k++) {
        const id = bandMap?.[k] ?? k;
        const b = m.bands.find((x) => x.bandId === id);
        gain[k] = 1 / m.quantification;
        offset[k] = (b?.offset ?? 0) / m.quantification;
      }
      state = m.level === 'L2A' ? 'surface reflectance (Sentinel-2 L2A)' : 'TOA reflectance (Sentinel-2 L1C)';
      unit = 'reflectance';
    } else {
      // WorldView: L = GAIN·DN·(absCal/effBw) + OFFSET; ρ = π L d² / (ESUN cos θs).
      const names = ['C', 'B', 'G', 'Y', 'R', 'RE', 'N', 'N2'];
      const day = new Date(m.time || Date.now());
      const doy = (day - new Date(Date.UTC(day.getUTCFullYear(), 0, 0))) / 864e5;
      const d = 1 - 0.01672 * Math.cos(((2 * Math.PI) / 365.256) * (doy - 4));
      const cz = Math.cos(((90 - m.sunElevation) * Math.PI) / 180);
      for (let k = 0; k < nb; k++) {
        const b = m.bands[bandMap?.[k] ?? k];
        const t = WV3_TABLE[names[bandMap?.[k] ?? k]] ?? { gain: 1, offset: 0, esun: NaN };
        if (!b) continue;
        const lg = t.gain * (b.absCalFactor / b.effectiveBandwidth);
        if (target === 'radiance') {
          gain[k] = lg;
          offset[k] = t.offset;
        } else {
          const r = (Math.PI * d * d) / (t.esun * cz);
          gain[k] = lg * r;
          offset[k] = t.offset * r;
        }
      }
      state = target === 'radiance' ? 'radiance (WorldView)' : 'TOA reflectance (WorldView)';
      unit = target === 'radiance' ? 'W m⁻² sr⁻¹ µm⁻¹' : 'reflectance';
    }
    // Band names and centre wavelengths from the sensor table when the file carries none (indices,
    // presets and the Layer Stack find red/NIR by wavelength).
    const table = SENSOR_BANDS[m.sensor];
    const sensorBand = (k) => bandMap?.[k] ?? (m.sensor === 'landsat' ? k + 1 : k);
    const bandsMeta = table && !hasWl(l) ? Array.from({ length: nb }, (_, k) => table[sensorBand(k)]).map((t, k) => (t ? { name: t[0], cw: t[1], fwhm: t[2], bad: false } : bandsOf(l)[k])) : null;
    return setRadiometry(l, { state, gain, offset, unit, source: `${file.name} (${m.sensor}${m.level ? ` ${m.level}` : ''})`, meta: m, bandMap }, undefined, { bandsMeta });
  }

  /** DOS, IARR and flat field (REQ-MSI-06): parameters from the image, stored as a chain step. */
  async function correction(l, kind, { percentile = 0.0001, aoi = null } = {}) {
    const step = Math.max(1, Math.floor(Math.sqrt((l.width * l.height) / 768 ** 2)));
    const c = await cube(l, { step, ...(aoi ?? {}) });
    const base = l.radiometryFor(Array.from({ length: l.bands }, (_, i) => i));
    let gain = base.gain.slice();
    let offset = base.offset.slice();
    let state;
    if (kind === 'dos') {
      const r = await app.pool.run('spectral', { op: 'correct', args: ['dos', c.v, c.w, c.h, c.nb, { param: percentile }] }, { kind: 'analysis', label: 'dark objects' });
      offset = offset.map((o, k) => o - r.r.dark[k]);
      state = `${l.radiometry.state} − dark object (DOS, p ${percentile})`;
      return setRadiometry(l, { ...l.radiometry, state, gain, offset, dark: r.r.dark, source: 'DOS' });
    }
    const r = await app.pool.run('spectral', { op: 'correct', args: ['mean', c.v, c.w, c.h, c.nb, {}] }, { kind: 'analysis', label: 'mean spectrum' });
    const mean = r.r.mean;
    gain = gain.map((g, k) => g / (mean[k] || 1));
    offset = offset.map((o, k) => o / (mean[k] || 1));
    state = kind === 'iarr' ? 'relative reflectance (IARR)' : 'relative reflectance (flat field)';
    return setRadiometry(l, { state, gain, offset, unit: 'relative', source: kind === 'iarr' ? 'IARR (scene mean)' : 'flat field (AOI mean)', mean });
  }

  /** Empirical line: targets [{rect, reflectance [nb]}] (≥ 2). */
  async function empiricalLine(l, targets) {
    if (targets.length < 2) throw new Error('the empirical line needs at least two targets of known reflectance');
    const means = [];
    for (const t of targets) {
      const c = await cube(l, { ...t.rect });
      const m = new Array(c.nb).fill(0);
      let n = 0;
      for (let i = 0; i < c.w * c.h; i++) {
        const px = c.v.subarray(i * c.nb, (i + 1) * c.nb);
        if (px.every(Number.isFinite)) {
          px.forEach((v, k) => (m[k] += v));
          n++;
        }
      }
      means.push(m.map((v) => v / Math.max(1, n)));
    }
    const f = await app.pool.run('spectral', { op: 'elm', args: [means, targets.map((t) => t.reflectance)] }, { kind: 'analysis', label: 'empirical line' });
    const base = l.radiometryFor(Array.from({ length: l.bands }, (_, i) => i));
    const gain = base.gain.map((g, k) => f.r.gain[k] * g);
    const offset = base.offset.map((o, k) => f.r.gain[k] * o + f.r.offset[k]);
    return setRadiometry(l, { state: 'surface reflectance (empirical line)', gain, offset, unit: 'reflectance', source: `ELM, ${targets.length} targets, r² ≥ ${Math.min(...f.r.r2).toFixed(3)}`, r2: f.r.r2 });
  }

  // ---- spectral plot (REQ-MSI-07) ----

  const plot = { pinned: [], library: [], mode: 'point', continuum: false, last: null, el: null };
  /** Spectrum at a point, the mean ± σ of a polygon/rectangle, or samples along a line. */
  async function spectrumAt(l, q, kind = 'point') {
    const bands = bandsOf(l);
    if (kind === 'point') {
      const c = await cube(l, { x0: Math.floor(q.x), y0: Math.floor(q.y), w: 1, h: 1 });
      return { kind, x: q.x, y: q.y, values: Array.from(c.v), std: null, bands, unit: l.radiometry.unit };
    }
    const r = q.rect ?? { x0: Math.min(q.x0, q.x1), y0: Math.min(q.y0, q.y1), w: Math.abs(q.x1 - q.x0) + 1, h: Math.abs(q.y1 - q.y0) + 1 };
    const c = await cube(l, r);
    const nb = c.nb;
    const m = new Array(nb).fill(0);
    const m2 = new Array(nb).fill(0);
    let n = 0;
    for (let i = 0; i < c.w * c.h; i++) {
      const px = c.v.subarray(i * nb, (i + 1) * nb);
      if (!px.every(Number.isFinite)) continue;
      for (let k = 0; k < nb; k++) {
        m[k] += px[k];
        m2[k] += px[k] * px[k];
      }
      n++;
    }
    const mean = m.map((v) => v / Math.max(1, n));
    return { kind: 'region', rect: r, values: mean, std: m2.map((v, k) => Math.sqrt(Math.max(0, v / Math.max(1, n) - mean[k] ** 2))), n, bands, unit: l.radiometry.unit };
  }
  const sam = (a, b) => {
    let d = 0;
    let x = 0;
    let y = 0;
    for (let i = 0; i < a.length; i++) {
      if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
      d += a[i] * b[i];
      x += a[i] * a[i];
      y += b[i] * b[i];
    }
    return Math.acos(Math.min(1, Math.max(-1, d / Math.sqrt(x * y))));
  };
  function drawPlot() {
    const el = plot.el;
    if (!el) return;
    clear(el);
    const l = layer();
    const W = 300;
    const H = 180;
    const cv = h('canvas', { width: W, height: H, 'aria-label': 'Spectral plot', 'data-id': 'spectral-plot' });
    const series = [...plot.pinned, ...(plot.last ? [{ ...plot.last, colour: '#ffffff', label: 'cursor' }] : []), ...plot.library.map((s) => ({ ...s, colour: s.colour ?? '#ffcb5f' }))];
    const bands = series[0]?.bands ?? (l ? bandsOf(l) : []);
    const xs = bands.map((b, i) => (Number.isFinite(b.cw) ? b.cw : i + 1));
    const useWl = bands.some((b) => Number.isFinite(b.cw));
    const val = (s) => (plot.continuum && useWl ? continuum(xs, s.values) : s.values);
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) for (const v of val(s)) if (Number.isFinite(v)) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
    if (!(hi > lo)) [lo, hi] = [0, 1];
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const g = cv.getContext('2d');
    g.fillStyle = '#1b1f24';
    g.fillRect(0, 0, W, H);
    // Bad bands greyed (REQ-MSI-07: bad-band masking).
    bands.forEach((b, i) => {
      if (!b.bad) return;
      const px = 30 + ((xs[i] - x0) / (x1 - x0 || 1)) * (W - 40);
      g.fillStyle = 'rgba(120,120,120,0.35)';
      g.fillRect(px - 2, 10, 4, H - 30);
    });
    for (const s of series) {
      g.strokeStyle = s.colour ?? '#5fd0ff';
      g.lineWidth = 1.5;
      g.beginPath();
      val(s).forEach((v, i) => {
        if (!Number.isFinite(v) || bands[i]?.bad) return;
        const px = 30 + ((xs[i] - x0) / (x1 - x0 || 1)) * (W - 40);
        const py = H - 20 - ((v - lo) / (hi - lo)) * (H - 30);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.stroke();
    }
    g.fillStyle = '#c8ccd0';
    g.font = '10px Arial, sans-serif';
    g.fillText(useWl ? 'Wavelength (µm)' : 'Band', W / 2 - 30, H - 4);
    g.fillText(`${plot.continuum ? 'continuum removed' : l?.radiometry?.unit ?? ''}`, 2, 10);
    g.fillText(hi.toPrecision(3), 2, 22);
    g.fillText(lo.toPrecision(3), 2, H - 22);
    const tbl = plot.pinned.length >= 2 ? h('table', { class: 'tbl', 'data-id': 'spectral-sam' }, h('tbody', {}, ...plot.pinned.slice(1).map((s) => h('tr', {}, h('td', {}, `${plot.pinned[0].label} vs ${s.label}`), h('td', {}, `SAM ${sam(plot.pinned[0].values, s.values).toFixed(4)} rad`))))) : '';
    const pins = h('div', {}, ...plot.pinned.map((s, i) => h('span', { style: `color:${s.colour};margin-right:8px` }, `■ ${s.label}`)));
    const bar = h('div', { class: 'tb-row' }, ...['point', 'line', 'polygon'].map((m) => h('button', { class: `btn ${plot.mode === m ? 'on' : ''}`, onclick: () => ((plot.mode = m), drawPlot()) }, m)), h('button', { class: 'btn', onclick: () => pin() }, 'Pin'), h('button', { class: 'btn', onclick: () => ((plot.pinned = []), drawPlot()) }, 'Clear'), h('label', {}, h('input', { type: 'checkbox', checked: plot.continuum, onchange: (e) => ((plot.continuum = e.target.checked), drawPlot()) }), ' Continuum removed'));
    el.append(bar, cv, pins, tbl);
  }
  function continuum(xs, v) {
    // Upper convex hull division (as gw-spectral, for display).
    const pts = xs.map((x, i) => [x, v[i]]).filter(([, y]) => Number.isFinite(y));
    const hull = [];
    for (const p of pts) {
      while (hull.length >= 2) {
        const [a, b] = [hull[hull.length - 2], hull[hull.length - 1]];
        if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0) hull.pop();
        else break;
      }
      hull.push(p);
    }
    return xs.map((x, i) => {
      let k = 0;
      while (k < hull.length - 2 && x > hull[k + 1][0]) k++;
      const [a, b] = [hull[k], hull[Math.min(k + 1, hull.length - 1)]];
      const c = b[0] > a[0] ? a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]) : a[1];
      return c > 0 ? v[i] / c : NaN;
    });
  }
  const COLOURS = ['#ff6060', '#60ff80', '#6080ff', '#ffd060', '#ff60ff', '#60ffff', '#ffa040', '#a0ff40'];
  function pin(s = plot.last, label = null) {
    if (!s) return;
    plot.pinned.push({ ...s, label: label ?? `#${plot.pinned.length + 1}`, colour: COLOURS[plot.pinned.length % COLOURS.length] });
    drawPlot();
    return plot.pinned.at(-1);
  }
  app.on('ready', (mp) =>
    mp.docks.register({
      id: 'spectral',
      title: 'Spectral Plot',
      icon: 'curve',
      home: 'right',
      create: (a, m, el) => {
        plot.el = el;
        drawPlot();
        return { onShow: drawPlot };
      },
    }),
  );
  // Cursor tracking (throttled to animation frames) while the plot is open in point mode.
  let raf = 0;
  const prevMoved = app.cursorMoved;
  app.cursorMoved = (p, x, y) => {
    prevMoved?.(p, x, y);
    if (!plot.el?.isConnected || plot.mode !== 'point' || raf) return;
    const l = p?.geoLayer?.();
    if (!l || l.bands < 2 || !(x >= 0 && y >= 0 && x < l.width && y < l.height)) return;
    raf = requestAnimationFrame(async () => {
      raf = 0;
      try {
        plot.last = await spectrumAt(l, { x, y }, 'point');
        drawPlot();
      } catch {}
    });
  };

  app.msi = { bandsOf, presetBands, applyPreset, bandPreview, showBand, setBandMath, clearBandMath, setIndex, indexAvailable, bandMathValues, exportBandMath, cube, setRadiometry, fromMetadata, correction, empiricalLine, spectrumAt, plot, pin, drawPlot, sam };

  // ---- commands ----
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 8000 });
    }
  };
  const multi = () => (layer()?.bands ?? 0) >= 2;
  /** The band list with names, wavelengths and FWHM (AC-13.4) and the radiometric state. */
  async function bandDialog(l = layer()) {
    const bands = bandsOf(l);
    const nm = (v) => (Number.isFinite(v) ? (v * 1000).toFixed(1) : '–');
    const rows = bands.map((b, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, b.name), h('td', {}, nm(b.cw)), h('td', {}, nm(b.fwhm)), h('td', {}, b.bad ? 'bad' : '')));
    const sel = (k, lab) => h('select', { class: 'inp', 'aria-label': lab }, ...bands.map((b, i) => h('option', { value: String(i), selected: (l.chain.bands[k] ?? l.chain.bands[0]) === i }, `${i + 1}: ${b.name}`)));
    const [r, g, b] = [sel(0, 'Red'), sel(1, 'Green'), sel(2, 'Blue')];
    const presets = h('select', { class: 'inp', 'aria-label': 'Preset' }, h('option', { value: '' }, '—'), ...Object.entries(PRESETS).map(([k, [lab]]) => h('option', { value: k, disabled: presetBands(l, k).missing.length > 0 }, lab)));
    const body = h('div', {}, h('table', { class: 'tbl', 'data-id': 'band-list' }, h('thead', {}, h('tr', {}, ...['#', 'Name', 'Centre (nm)', 'FWHM (nm)', ''].map((t) => h('th', {}, t)))), h('tbody', {}, ...rows)), h('p', { class: 'hint' }, `Radiometric state: ${l.radiometry.state} (${l.radiometry.source}).`), field('Preset', presets), field('Red', r), field('Green', g), field('Blue', b));
    const res = await modal({ title: `Band Selection — ${l.rec?.name ?? ''}`, body, buttons: ['Apply', 'Cancel'], width: 560, id: 'band-select' });
    if (res !== 'Apply') return;
    if (presets.value) return applyPreset(l, presets.value);
    app.setChain((c) => ((c.bands = [Number(r.value), Number(g.value), Number(b.value)]), (c.bandMath = null)), 'Band selection', { layerId: l.id });
  }
  C.implement('bands.select', { enabled: () => !!layer(), run: run(() => bandDialog()) });
  C.implement('bands.preview', { enabled: multi, checked: () => !!preview, run: run(() => bandPreview(layer())) });
  C.implement('bands.snr', {
    enabled: multi,
    run: run(async () => {
      const l = layer();
      const step = Math.max(1, Math.floor(Math.sqrt((l.width * l.height) / 1024 ** 2)));
      // Shift-difference noise needs neighbouring full-resolution pixels: a centred window, no wider
      // than the cube limit allows for this many bands (224 AVIRIS bands at 1024² was refused, TE 2.0.4).
      const side = Math.max(64, Math.min(1024, Math.floor(Math.sqrt(90e6 / Math.max(1, l.bands)))));
      const w = Math.min(l.width, side);
      const hh = Math.min(l.height, side);
      const c = await cube(l, { step: 1, x0: Math.floor((l.width - w) / 2), y0: Math.floor((l.height - hh) / 2), w, h: hh });
      const r = await app.pool.run('spectral', { op: 'stats', args: [c.v, c.w, c.h, c.nb] }, { kind: 'analysis', label: 'SNR' });
      const bands = bandsOf(l);
      await modal({ title: `Band Statistics and SNR — ${l.rec?.name ?? ''}`, body: h('table', { class: 'tbl', 'data-id': 'snr-table' }, h('thead', {}, h('tr', {}, ...['Band', 'Mean', 'σ', 'SNR (shift-difference noise)'].map((t) => h('th', {}, t)))), h('tbody', {}, ...r.r.bands.map((s, i) => h('tr', {}, h('td', {}, `${i + 1}: ${bands[i].name}`), h('td', {}, s.mean.toPrecision(5)), h('td', {}, s.std.toPrecision(4)), h('td', {}, Number.isFinite(s.snr) ? s.snr.toFixed(1) : '∞'))))), buttons: ['Close'], id: 'snr', width: 560 });
      return step;
    }),
  });
  C.implement('profile.spectral', { enabled: multi, run: () => pane()?.mp?.docks.toggle('spectral') });
  C.implement('msi.bandmath', {
    enabled: () => !!layer(),
    run: run(async () => {
      const l = layer();
      const names = Object.keys(BAND_NAMES).filter((n) => bandByName(n, bandsOf(l)) >= 0);
      // The suggested expression uses only what this image can resolve (TE-039): NDVI by name when
      // red and NIR are known, else a normalised difference of the last two bands.
      const sugg = names.includes('nir') && names.includes('red') ? '(nir - red) / (nir + red)' : l.bands >= 2 ? `(b${l.bands} - b${l.bands - 1}) / (b${l.bands} + b${l.bands - 1})` : 'b1';
      const inp = h('input', { class: 'inp', value: l.chain.bandMath?.text ?? sugg, 'aria-label': 'Expression', spellcheck: 'false' });
      const res = await modal({ title: 'Band Math', body: h('div', {}, field('Expression', inp, `Bands b1…b${l.bands}${names.length ? `, or ${names.join(', ')}` : ''}; + − × ÷ ^, abs sqrt log log10 exp min max pow clamp, comparisons and c ? a : b. Division by zero is no-data.`)), buttons: ['Apply', 'Export', 'Off', 'Cancel'], id: 'bandmath' });
      if (res === 'Apply') await setBandMath(l, inp.value);
      else if (res === 'Export') {
        await setBandMath(l, inp.value);
        await exportBandMath(l);
      } else if (res === 'Off') clearBandMath(l);
    }),
  });
  for (const k of Object.keys(INDICES)) C.implement(`msi.index.${k}`, { enabled: () => multi() && indexAvailable(layer(), k).ok, run: run(() => setIndex(layer(), k)) });
  for (const k of Object.keys(PRESETS)) C.implement(`msi.preset.${k}`, { enabled: () => multi() && !presetBands(layer(), k).missing.length, run: run(() => applyPreset(layer(), k)) });
  // ---- Layer Stack (TE-056) ----

  const STACK_MAX = 4096;

  /** One-band layers in the active panel on the active layer's grid (Landsat/Sentinel-2 band files). */
  function stackCandidates(l = layer()) {
    if (!l || l.bands !== 1) return [];
    const p = pane();
    return [...app.layers.values()].filter((x) => x.rec?.pane === p?.id && x.bands === 1 && !x.error && x.width === l.width && x.height === l.height);
  }

  /** The window to stack: the whole grid when it fits STACK_MAX², else the panel's view (clipped to STACK_MAX²). */
  function stackWindow(l) {
    if (l.width <= STACK_MAX && l.height <= STACK_MAX) return { x0: 0, y0: 0, w: l.width, h: l.height };
    const p = pane();
    const r = p.el.getBoundingClientRect();
    const c = [[0, 0], [r.width, 0], [0, r.height], [r.width, r.height]].map(([x, y]) => invertView(p.view, r.width, r.height, x, y));
    const fit = (lo, hi, n) => {
      let a = Math.max(0, Math.floor(lo));
      let b = Math.min(n, Math.ceil(hi));
      if (b - a > STACK_MAX) [a, b] = [Math.round((a + b - STACK_MAX) / 2), Math.round((a + b + STACK_MAX) / 2)];
      return [a, Math.max(a + 1, b)];
    };
    const [x0, x1] = fit(Math.min(...c.map((q) => q.x)), Math.max(...c.map((q) => q.x)), l.width);
    const [y0, y1] = fit(Math.min(...c.map((q) => q.y)), Math.max(...c.map((q) => q.y)), l.height);
    return { x0, y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Stack same-grid one-band layers into one multiband product, so composites, indices, Band Math
   * and Radiometric Conversion apply across band files. Each band keeps its source's DN, radiometry
   * (gain/offset, metadata band) and band metadata.
   */
  async function stack(layers, { window = null } = {}) {
    if (layers.length < 2) throw new Error('Layer Stack needs at least two one-band layers on the same grid');
    const L0 = layers[0];
    if (layers.some((x) => x.bands !== 1 || x.width !== L0.width || x.height !== L0.height)) throw new Error('Layer Stack takes one-band layers of the same size');
    const win = window ?? stackWindow(L0);
    const st = layers.every((x) => x.sampleType === 'u8') ? 'u8' : layers.every((x) => ['u8', 'u16'].includes(x.sampleType)) ? 'u16' : 'f32';
    const T = { u8: Uint8Array, u16: Uint16Array, f32: Float32Array }[st];
    const planes = [];
    for (const x of layers) planes.push(T.from((await cube(x, { ...win, raw: true })).v));
    const rad = layers.map((x) => x.radiometry);
    const same = (k) => (rad.every((r) => r[k] === rad[0][k]) ? rad[0][k] : 'mixed');
    const radiometry = { state: same('state'), unit: same('unit'), gain: rad.map((r) => r.gain?.[0] ?? 1), offset: rad.map((r) => r.offset?.[0] ?? 0), source: `stack of ${layers.length} band files`, meta: rad.find((r) => r.meta)?.meta ?? null, bandMap: rad.map((r) => r.bandMap?.[0] ?? null) };
    const bandsMeta = layers.map((x) => {
      const b = bandsOf(x)[0];
      return /^Band 1$/.test(b.name) ? { ...b, name: x.rec?.name ?? b.name } : b;
    });
    const full = win.w === L0.width && win.h === L0.height;
    return openMemoryLayer(app, L0, { name: `Stack of ${layers.length} bands${full ? '' : ` (${win.w}×${win.h} window)`} — ${L0.rec?.name ?? ''}`, bands: layers.length, sampleType: st, planes, nodata: L0.nodata, x0: win.x0, y0: win.y0, width: win.w, height: win.h, info: { bandsMeta, radiometry } });
  }
  app.msi.stack = stack;

  C.implement('msi.stack', {
    enabled: () => stackCandidates().length >= 2,
    run: run(async () => {
      const cands = stackCandidates().sort((a, b) => (bandsOf(a)[0].cw || Infinity) - (bandsOf(b)[0].cw || Infinity));
      const boxes = cands.map((x) => h('input', { type: 'checkbox', checked: true, 'aria-label': x.rec?.name ?? x.id }));
      const win = stackWindow(layer());
      const body = h('div', {}, ...cands.map((x, i) => h('label', { class: 'fld fld-inline' }, boxes[i], h('span', {}, `${x.rec?.name ?? x.id}${Number.isFinite(bandsOf(x)[0].cw) ? ` (${(bandsOf(x)[0].cw * 1000).toFixed(0)} nm)` : ''} · ${x.radiometry.state}`))), h('p', { class: 'hint' }, win.w === layer().width && win.h === layer().height ? 'The whole grid is stacked.' : `The grid is larger than ${STACK_MAX}²: the panel's view (${win.w}×${win.h} pixels) is stacked. Zoom or pan first to choose the area.`));
      if ((await modal({ title: 'Layer Stack', body, buttons: ['Stack', 'Cancel'], width: 520, id: 'msi-stack' })) !== 'Stack') return;
      const l = await stack(cands.filter((_, i) => boxes[i].checked), { window: win });
      toast(`Stacked ${l.bands} bands (${l.width}×${l.height})`);
    }),
  });

  C.implement('msi.radiometric', {
    enabled: () => !!layer(),
    run: run(async () => {
      const l = layer();
      const kind = h('select', { class: 'inp', 'aria-label': 'Conversion' }, ...[['meta', 'From metadata (Landsat MTL, Sentinel-2 MTD, WorldView IMD)…'], ['dos', 'Dark-object subtraction'], ['iarr', 'IARR (relative reflectance)'], ['flat', 'Flat field (AOI)'], ['reset', 'Back to the file’s state']].map(([v, t]) => h('option', { value: v }, t)));
      const target = h('select', { class: 'inp', 'aria-label': 'Target' }, h('option', { value: 'reflectance' }, 'Reflectance'), h('option', { value: 'radiance' }, 'Radiance'));
      if ((await modal({ title: 'Radiometric Conversion', body: h('div', {}, h('p', {}, `Now: ${l.radiometry.state} (${l.radiometry.source})`), field('Conversion', kind), field('Target', target)), buttons: ['OK', 'Cancel'], id: 'radiometric' })) !== 'OK') return;
      if (kind.value === 'meta') {
        const [f] = await pickFiles(app, { multiple: false, accept: ['.txt', '.xml', '.imd', '.IMD'], description: 'Sensor metadata' });
        if (f) await fromMetadata(l, f, { target: target.value });
      } else if (kind.value === 'reset') setRadiometry(l, l.info.radiometry ?? { state: 'DN', gain: null, offset: null, unit: 'DN', source: 'file' }, 'Radiometry reset');
      else await correction(l, kind.value, { aoi: kind.value === 'flat' ? (() => {
        const b = app.aoiBox?.(pane(), l);
        if (!b) throw new Error('flat field needs an AOI over a bright, spectrally flat area');
        return { x0: b.x0, y0: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
      })() : null });
      toast(`Radiometric state: ${l.radiometry.state}`);
    }),
  });
}
