// Time series of images (REQ-GAP-83, SDP-2.7 §4.10; Full; the lazy js-timeseries block). A time
// series is a raster whose every band has a date: a CF NetCDF time axis as decoded, or a time
// stack built here from separate dated images resampled onto one grid. On it: the Time Series
// panel (slider, playback, recording, and the temporal profile at the cursor, a pinned point or
// the AOI, with CSV export), the per-pixel linear trend with its p-value, and the anomaly of each
// date against a baseline period, optionally by calendar month and as a z-score. Trend and
// anomaly run in the `spectral` WASM bundle in the analysis worker.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob, textBlob } from '../storage/files.js';
import { toCsv } from './panels.js';
import { acqTime } from '../products/tokens.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { num, int, date as fmtDate } from '../i18n/format.js';
import { dateFromName, decimalYear, layerDates, layerCalendar, groupsOf, baselineFlags, profileStats, profileRows, isoParts } from '../analysis/time-series.js';

/** Samples a time stack or a trend may read at once: the worker cube's own limit. */
const MAX_SAMPLES = 96e6;
/** Spacing of the control points that map the reference grid onto another image. */
const NODE = 16;

export function install(app) {
  const C = app.commands;
  const msi = () => app.msi;
  const pane = () => app.activePane();
  const toast = (m, o) => app.toast(m, o);
  const spec = (op, ...args) => app.pool.run('spectral', { op, args }, { kind: 'analysis', label: t('spectral {op}', { op }), timeout: 600000 }).then((r) => r.r);
  const run = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      toast(msgOf(e), { kind: e.code === 'E_NEED_SERIES' || e.code === 'E_NEED_DATES' ? 'warn' : 'error' });
      return undefined;
    }
  };
  const images = () => [...app.layers.values()].filter((l) => l.rec?.pane === pane()?.id && l.handle && l.rec?.kind !== 'dem');

  // ---- dates ----

  /** One date per band (ISO strings), or null when the layer is not a time series. */
  const datesOf = (l) => (l ? layerDates(msi().bandsOf(l), l.info) : null);
  /** The CF calendar of its dates, for their decimal years. */
  const calOf = (l) => layerCalendar(msi().bandsOf(l));
  /** The acquisition date of a single image: its file name, else its metadata. */
  function dateOfImage(l) {
    const d = dateFromName(l.rec?.name) ?? dateFromName(app.store.get(l.rec?.file)?.name);
    if (d) return d;
    const a = acqTime(l.info?.datetime);
    return a ? a.replace(' ', 'T') : null;
  }
  const series = (l = app.activeLayer()) => {
    const d = datesOf(l);
    if (!d || d.length < 2) throw gwError('{layer} is not a time series: it needs a date on every band (a NetCDF time axis, or Time Stack)', { layer: l?.rec?.name ?? '—' }, 'E_NEED_SERIES');
    return { l, dates: d };
  };
  const label = (iso) => {
    const p = isoParts(iso);
    if (!p) return String(iso ?? '');
    // setUTCFullYear, not Date.UTC, which reads years 0–99 as 1900–1999.
    const d = new Date(0);
    d.setUTCFullYear(p.y, p.m - 1, p.d);
    d.setUTCHours(p.hh, p.mm);
    // A model-calendar date (30 February) has no Date: show it as written.
    return d.getUTCDate() === p.d ? (p.hh || p.mm ? `${fmtDate(d)} ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}` : fmtDate(d)) : iso.slice(0, 10);
  };

  /** The AOI's bounding box in a layer's pixels, clipped to the layer, or null with no AOI. */
  function aoiWindow(l) {
    const b = app.aoiBox?.(pane(), l);
    if (!b) return null;
    const x0 = Math.min(l.width - 1, Math.max(0, Math.floor(b.x0)));
    const y0 = Math.min(l.height - 1, Math.max(0, Math.floor(b.y0)));
    return { x0, y0, w: Math.max(1, Math.min(l.width, Math.ceil(b.x1)) - x0), h: Math.max(1, Math.min(l.height, Math.ceil(b.y1)) - y0) };
  }

  // ---- time stack ----

  /** Window of the reference: the AOI when there is one, else the whole image; a step keeps it under the cube limit. */
  function stackWindow(ref, nt) {
    const w = aoiWindow(ref) ?? { x0: 0, y0: 0, w: ref.width, h: ref.height };
    w.step = Math.max(1, Math.ceil(Math.sqrt((w.w * w.h * nt) / MAX_SAMPLES)));
    return w;
  }

  /** Whether two images share a grid: the same size, and corners on the ground within a tenth of a pixel. */
  function sameGrid(a, b) {
    if (a === b) return true;
    if (a.width !== b.width || a.height !== b.height) return false;
    const tol = 0.1;
    for (const [x, y] of [[0, 0], [a.width, 0], [0, a.height], [a.width, a.height]]) {
      const g = a.groundAt(x, y, 0);
      const q = g && b.imageAt(g.lat, g.lon, 0);
      if (!q || Math.abs(q.x - x) > tol || Math.abs(q.y - y) > tol) return false;
    }
    return true;
  }

  /**
   * One band of `l` resampled (nearest neighbour) onto the output grid of `ref`'s window: control
   * points every NODE output pixels map ref → ground → l, and pixels between them interpolate
   * the mapping. NaN where `l` has no data. Returns w·h f32 (row-major).
   */
  async function resampleBand(ref, l, band, win, ow, oh) {
    const nx = Math.ceil(ow / NODE) + 1;
    const ny = Math.ceil(oh / NODE) + 1;
    const sx = new Float64Array(nx * ny);
    const sy = new Float64Array(nx * ny);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const ox = Math.min(i * NODE, ow);
        const oy = Math.min(j * NODE, oh);
        const g = ref.groundAt(win.x0 + (ox + 0.5) * win.step, win.y0 + (oy + 0.5) * win.step, 0);
        const q = g && l.imageAt(g.lat, g.lon, 0);
        const k = j * nx + i;
        sx[k] = q ? q.x : NaN;
        sy[k] = q ? q.y : NaN;
        if (q && Number.isFinite(q.x) && Number.isFinite(q.y)) {
          x0 = Math.min(x0, q.x);
          y0 = Math.min(y0, q.y);
          x1 = Math.max(x1, q.x);
          y1 = Math.max(y1, q.y);
        }
      }
    }
    const out = new Float32Array(ow * oh).fill(NaN);
    // The part of `l` the window covers, read at about the output's resolution.
    const rx0 = Math.max(0, Math.floor(x0) - 1);
    const ry0 = Math.max(0, Math.floor(y0) - 1);
    const rx1 = Math.min(l.width, Math.ceil(x1) + 2);
    const ry1 = Math.min(l.height, Math.ceil(y1) + 2);
    if (!(rx1 > rx0 && ry1 > ry0)) return out;
    // Full resolution unless the part is far larger than the output (nearest neighbour wants the real pixel).
    const step = Math.max(1, Math.ceil(Math.sqrt(((rx1 - rx0) * (ry1 - ry0)) / Math.max(4 * ow * oh, 16e6))));
    const c = await msi().cube(l, { x0: rx0, y0: ry0, w: rx1 - rx0, h: ry1 - ry0, step, bands: [band] });
    // The last control point of a row or column sits on the edge, nearer than NODE.
    const at = (n, i, len) => Math.min(i * NODE, len);
    for (let oy = 0; oy < oh; oy++) {
      const j = Math.min(ny - 2, Math.floor(oy / NODE));
      const v = (oy - at(ny, j, oh)) / (at(ny, j + 1, oh) - at(ny, j, oh) || 1);
      for (let ox = 0; ox < ow; ox++) {
        const i = Math.min(nx - 2, Math.floor(ox / NODE));
        const u = (ox - at(nx, i, ow)) / (at(nx, i + 1, ow) - at(nx, i, ow) || 1);
        const k = j * nx + i;
        const bl = (a) => (1 - u) * (1 - v) * a[k] + u * (1 - v) * a[k + 1] + (1 - u) * v * a[k + nx] + u * v * a[k + nx + 1];
        const cx = Math.floor((bl(sx) - rx0) / step);
        const cy = Math.floor((bl(sy) - ry0) / step);
        if (cx >= 0 && cy >= 0 && cx < c.w && cy < c.h) out[oy * ow + ox] = c.v[cy * c.w + cx];
      }
    }
    return out;
  }

  /**
   * A time stack (REQ-GAP-83): one band of each dated image, in date order, on the grid of `ref`
   * (default: the first by date); images on another grid are resampled to it. Dates come from the
   * file names or the metadata unless `dates` gives them (ISO, one per layer).
   */
  function stack(layers, opts = {}) {
    return app.activity.track(t('Building a time stack…'), (job) => buildStack(layers, opts, job));
  }
  async function buildStack(layers, { band = 0, ref = null, dates = null } = {}, job) {
    const items = layers.map((l, i) => ({ l, date: dates?.[i] ?? dateOfImage(l) }));
    const missing = items.filter((x) => !x.date).map((x) => x.l.rec?.name ?? x.l.id);
    if (missing.length) throw gwError('No date for {layers}: name the files with their date (YYYYMMDD) or use files with an acquisition date', { layers: missing.join(', ') }, 'E_NEED_DATES');
    if (items.length < 2) throw gwError('A time stack needs at least two dated images', {}, 'E_NEED_DATES');
    items.sort((a, b) => decimalYear(a.date) - decimalYear(b.date));
    const twin = items.find((x, i) => i && decimalYear(x.date) === decimalYear(items[i - 1].date));
    if (twin) throw gwError('Two images have the same date, {date}: stack one image per date', { date: twin.date }, 'E_NEED_DATES');
    const R = ref ?? items[0].l;
    const nt = items.length;
    const win = stackWindow(R, nt);
    const ow = Math.ceil(win.w / win.step);
    const oh = Math.ceil(win.h / win.step);
    const planes = [];
    let resampled = 0;
    for (const [k, x] of items.entries()) {
      job?.set?.(k / nt);
      const b = Math.min(band, x.l.bands - 1);
      if (sameGrid(R, x.l)) {
        const c = await msi().cube(x.l, { x0: win.x0, y0: win.y0, w: win.w, h: win.h, step: win.step, bands: [b] });
        planes.push(c.v);
      } else {
        planes.push(await resampleBand(R, x.l, b, win, ow, oh));
        resampled++;
      }
    }
    const bandsMeta = items.map((x) => ({ name: x.date.slice(0, 10), cw: NaN, fwhm: NaN, bad: false, time: x.date }));
    const l = await app.openMemoryLayer(R, {
      name: t('Time stack ({n} dates)', { n: nt }),
      bands: nt,
      sampleType: 'f32',
      planes,
      nodata: NaN,
      x0: win.x0,
      y0: win.y0,
      step: win.step,
      width: ow,
      height: oh,
      chain: { bands: [0], stretch: 'linear2' },
      info: { bandsMeta, radiometry: { state: 'time series', gain: null, offset: null, unit: R.radiometry?.unit ?? '', source: 'Time Stack' }, timeSeries: { dates: items.map((x) => x.date), sources: items.map((x) => x.l.rec?.name ?? '') } },
    });
    return Object.assign(l, { resampled });
  }

  // ---- display and playback ----

  const panel = { el: null, k: 0, pinned: null, mode: 'cursor', last: null, playing: null, finish: null, rate: 4, ui: null };
  function show(l, k) {
    const { dates } = series(l);
    const i = Math.max(0, Math.min(dates.length - 1, Math.round(k)));
    app.setChain((ch) => (ch.bands = [i]), t('Date {date}', { date: label(dates[i]) }), { layerId: l.id, mergeKey: `ts:${l.id}` });
    l.ensureStats().then(() => {
      l.updateLut(true);
      app.renderer.invalidate();
    });
    panel.k = i;
    draw();
    return dates[i];
  }
  /** Step through the dates at `rate` per second (`loops` times; 0 = until stopped). With `record`, a WebM or GIF of one pass. */
  function play(l, { rate = 4, loops = 1, record = false } = {}) {
    stop();
    const { dates } = series(l);
    if (record) C.run('cmp.record');
    let k = 0;
    const total = (loops || Infinity) * dates.length;
    return new Promise((resolve) => {
      let done = false;
      // The end of the pass, whether it ran out or was stopped: the recording is saved either way.
      const finish = () => {
        if (done) return;
        done = true;
        if (panel.playing && panel.playing !== -1) clearTimeout(panel.playing);
        panel.playing = null;
        panel.finish = null;
        if (record && app.compareRecording?.()) C.run('cmp.record');
        draw();
        resolve();
      };
      const step = () => {
        if (k >= total) return finish();
        show(l, k++ % dates.length);
        if (!done) panel.playing = setTimeout(step, 1000 / Math.max(0.25, rate));
      };
      panel.finish = finish;
      panel.playing = -1;
      step();
    });
  }
  function stop() {
    if (panel.finish) panel.finish();
    else panel.playing = null;
  }

  // ---- temporal profile ----

  /** Values over time at a pixel {x, y}, or per date the mean, σ and count over a rectangle {rect}. */
  async function profile(l, q) {
    const { dates } = series(l);
    const r = q.rect ?? { x0: Math.floor(q.x), y0: Math.floor(q.y), w: 1, h: 1 };
    const c = await msi().cube(l, { x0: r.x0, y0: r.y0, w: r.w, h: r.h });
    const s = profileStats(c.v, c.nb);
    return q.rect ? { kind: 'region', dates, rect: r, ...s } : { kind: 'point', dates, x: r.x0, y: r.y0, mean: s.mean };
  }
  async function exportProfile(l, q) {
    const p = await profile(l, q);
    const rows = profileRows(p.dates, p.kind === 'region' ? p : { mean: p.mean });
    await saveBlob(app, textBlob(toCsv(rows), 'text/csv'), { name: `${(l.rec?.name ?? 'series').replace(/[^\w.-]+/g, '_')}_profile.csv`, types: ['.csv'], description: 'CSV' });
    return p;
  }

  // ---- trend and anomaly ----

  function seriesCube(l) {
    const { dates } = series(l);
    const w = aoiWindow(l) ?? { x0: 0, y0: 0, w: l.width, h: l.height };
    if (w.w * w.h * dates.length > MAX_SAMPLES) throw gwError('{w}×{h} pixels × {n} dates is more than one pass takes ({max} M values): draw an AOI', { w: int(w.w), h: int(w.h), n: dates.length, max: int(MAX_SAMPLES / 1e6) }, 'E_NEED_SERIES');
    return { dates, w };
  }

  /** Linear trend per pixel: a layer of slope per year, two-sided p-value and the number of dates. */
  async function trend(l = app.activeLayer()) {
    const { dates, w } = seriesCube(l);
    const c = await msi().cube(l, w);
    const r = await spec('trend', c.v, c.w, c.h, c.nb, dates.map((d) => decimalYear(d, calOf(l))));
    const unit = l.radiometry?.unit;
    return app.openMemoryLayer(l, {
      name: t('Trend — {layer}', { layer: l.rec?.name ?? '' }),
      bands: 3,
      sampleType: 'f32',
      planes: [r.slope, r.pvalue, r.n],
      nodata: NaN,
      x0: w.x0,
      y0: w.y0,
      width: c.w,
      height: c.h,
      chain: { bands: [0], stretch: 'linear2', colour: { palette: 'diverging' } },
      info: {
        bandsMeta: [
          { name: unit ? t('Slope ({unit} per year)', { unit }) : t('Slope (per year)'), cw: NaN, fwhm: NaN, bad: false },
          { name: t('p-value'), cw: NaN, fwhm: NaN, bad: false },
          { name: t('Dates used'), cw: NaN, fwhm: NaN, bad: false },
        ],
        radiometry: { state: 'temporal trend', gain: null, offset: null, unit: '', source: t('{n} dates, {from} to {to}', { n: dates.length, from: label(dates[0]), to: label(dates.at(-1)) }) },
        timeSeries: undefined,
      },
    });
  }

  /** Anomaly of every date against the baseline `from`–`to` (ISO dates), by calendar month or not, as a difference or a z-score. */
  async function anomaly(l = app.activeLayer(), { from = '', to = '', by = 'none', z = false } = {}) {
    const { dates, w } = seriesCube(l);
    const base = baselineFlags(dates, from, to);
    if (!base.some(Boolean)) throw gwError('No date falls in the baseline {from} to {to}', { from: from || '…', to: to || '…' }, 'E_NEED_DATES');
    const c = await msi().cube(l, w);
    const r = await spec('anomaly', c.v, c.w, c.h, c.nb, { base, groups: groupsOf(dates, by), z });
    // BIP → one plane per date.
    const planes = dates.map((_, k) => {
      const p = new Float32Array(c.w * c.h);
      for (let i = 0; i < p.length; i++) p[i] = r.anomaly[i * c.nb + k];
      return p;
    });
    return app.openMemoryLayer(l, {
      name: z ? t('Anomaly z-score — {layer}', { layer: l.rec?.name ?? '' }) : t('Anomaly — {layer}', { layer: l.rec?.name ?? '' }),
      bands: dates.length,
      sampleType: 'f32',
      planes,
      nodata: NaN,
      x0: w.x0,
      y0: w.y0,
      width: c.w,
      height: c.h,
      chain: { bands: [0], stretch: 'linear2', colour: { palette: 'diverging' } },
      info: {
        // The calendar goes with the dates, or a model-calendar series stops reading as one.
        bandsMeta: dates.map((d) => ({ name: d.slice(0, 10), cw: NaN, fwhm: NaN, bad: false, time: d, calendar: calOf(l) })),
        radiometry: { state: z ? 'anomaly z-score' : 'anomaly', gain: null, offset: null, unit: z ? 'σ' : (l.radiometry?.unit ?? ''), source: t('Baseline {from} to {to}', { from: from || label(dates[0]), to: to || label(dates.at(-1)) }) },
        timeSeries: { dates: dates.slice(), baseline: [from, to], by, z },
      },
    });
  }

  // ---- the Time Series panel ----

  const active = () => {
    const l = app.activeLayer();
    return datesOf(l)?.length >= 2 ? l : null;
  };
  function chart(p, dates, cal) {
    // A fixed dark instrument panel, as the Spectral Plot is (GUI-078).
    const cv = h('canvas', { width: 320, height: 160, 'data-id': 'ts-chart', role: 'img', 'aria-label': t('Temporal profile') });
    const g = cv.getContext('2d');
    if (!g) return cv;
    const fg = '#d8dde3';
    const ac = '#5fd0ff';
    g.fillStyle = '#1b1f24';
    g.fillRect(0, 0, cv.width, cv.height);
    const xs = dates.map((d) => decimalYear(d, cal));
    const ys = p.mean;
    const fin = ys.filter(Number.isFinite);
    if (!fin.length) return cv;
    const [lo, hi] = [Math.min(...fin), Math.max(...fin)];
    const [x0, x1] = [xs[0], xs.at(-1)];
    const L = 40;
    const T = 8;
    const W = cv.width - L - 8;
    const H = cv.height - T - 22;
    const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * W;
    const Y = (y) => T + H - ((y - lo) / (hi - lo || 1)) * H;
    g.strokeStyle = fg;
    g.fillStyle = fg;
    g.font = '10px sans-serif';
    g.globalAlpha = 0.35;
    g.strokeRect(L, T, W, H);
    g.globalAlpha = 1;
    g.fillText(num(hi, 3), 2, T + 8);
    g.fillText(num(lo, 3), 2, T + H);
    g.fillText(String(Math.floor(x0)), L, cv.height - 6);
    g.fillText(String(Math.floor(x1)), L + W - 24, cv.height - 6);
    g.strokeStyle = ac;
    g.beginPath();
    let pen = false;
    ys.forEach((y, k) => {
      if (!Number.isFinite(y)) {
        pen = false;
        return;
      }
      if (pen) g.lineTo(X(xs[k]), Y(y));
      else g.moveTo(X(xs[k]), Y(y));
      pen = true;
    });
    g.stroke();
    // The date on show.
    g.globalAlpha = 0.6;
    g.beginPath();
    g.moveTo(X(xs[panel.k] ?? x0), T);
    g.lineTo(X(xs[panel.k] ?? x0), T + H);
    g.stroke();
    g.globalAlpha = 1;
    return cv;
  }

  // The panel's controls are built once per layer and updated in place, so the slider keeps its
  // drag and keyboard focus, and the rate keeps its value, while the date and profile change.
  function draw() {
    const el = panel.el;
    if (!el?.isConnected) return;
    const l = active();
    if (!l) {
      panel.ui = null;
      el.replaceChildren(h('p', { class: 'hint' }, t('Select a time series: a layer with a date on every band (a NetCDF time axis, or Analyze ▸ Time Stack).')));
      return;
    }
    const dates = datesOf(l);
    if (panel.ui?.l !== l || panel.ui.n !== dates.length || !el.contains(panel.ui.slider)) build(el, l, dates);
    const ui = panel.ui;
    const k = Math.min(panel.k, dates.length - 1);
    if (+ui.slider.value !== k) ui.slider.value = String(k);
    ui.slider.setAttribute('aria-valuetext', label(dates[k]));
    ui.date.textContent = label(dates[k]);
    ui.play.textContent = panel.playing ? t('Stop') : t('Play');
    ui.play.setAttribute('aria-pressed', String(!!panel.playing));
    ui.pin.disabled = !panel.cursor;
    ui.mode.value = panel.mode;
    const p = panel.last && panel.last.l === l ? panel.last.p : null;
    ui.body.replaceChildren(
      p ? chart(p, dates, calOf(l)) : h('p', { class: 'hint' }, t('Move the cursor over the image, pin a point, or draw an AOI.')),
      p ? h('p', { class: 'hint' }, p.kind === 'region' ? t('Mean of {n} pixels on the date shown: {v}', { n: int(p.n[k]), v: num(p.mean[k], 4) }) : t('Value on the date shown: {v}', { v: num(p.mean[k], 4) })) : '',
    );
  }
  function build(el, l, dates) {
    const slider = h('input', { type: 'range', min: '0', max: String(dates.length - 1), step: '1', value: '0', class: 'ts-slider', 'aria-label': t('Date') });
    slider.addEventListener('input', () => show(l, +slider.value));
    const play_ = h('button', { class: 'btn', type: 'button' }, t('Play'));
    play_.addEventListener('click', () => (panel.playing ? stop() : play(l, { rate: panel.rate, loops: 0 })));
    const rate = h('select', { class: 'inp', 'aria-label': t('Dates per second') }, ...[1, 2, 4, 8, 16].map((r) => h('option', { value: String(r), selected: r === panel.rate }, t('{n} per second', { n: r }))));
    rate.addEventListener('change', () => (panel.rate = +rate.value));
    const rec = h('button', { class: 'btn', type: 'button' }, t('Record'));
    rec.addEventListener('click', () => play(l, { rate: panel.rate, loops: 1, record: true }).catch((e) => toast(msgOf(e), { kind: 'error' })));
    const mode = h('select', { class: 'inp', 'aria-label': t('Profile of') }, h('option', { value: 'cursor' }, t('Cursor')), h('option', { value: 'pinned' }, t('Pinned point')), h('option', { value: 'aoi' }, t('AOI mean')));
    mode.addEventListener('change', () => {
      panel.mode = mode.value;
      refreshProfile(l);
    });
    const pin = h('button', { class: 'btn', type: 'button' }, t('Pin the cursor'));
    pin.addEventListener('click', () => {
      panel.pinned = panel.cursor ? { ...panel.cursor } : null;
      panel.mode = 'pinned';
      refreshProfile(l).catch((e) => toast(msgOf(e), { kind: 'error' }));
    });
    const csv = h('button', { class: 'btn', type: 'button' }, t('Export CSV…'));
    csv.addEventListener('click', () => {
      const q = query(l);
      if (!q) return toast(t('Point at the image, pin a point or draw an AOI first'), { kind: 'warn' });
      exportProfile(l, q).catch((e) => toast(msgOf(e), { kind: 'error' }));
    });
    const date = h('div', { class: 'ts-date', 'aria-live': 'polite' });
    const body = h('div');
    el.replaceChildren(date, slider, h('div', { class: 'ts-bar' }, play_, rate, rec), field(t('Profile of'), mode), body, h('div', { class: 'ts-bar' }, pin, csv));
    panel.ui = { l, n: dates.length, slider, date, play: play_, pin, mode, body };
  }
  function query(l) {
    if (panel.mode === 'aoi') {
      const w = aoiWindow(l);
      return w ? { rect: w } : null;
    }
    if (panel.mode === 'pinned') return panel.pinned;
    return panel.cursor ?? null;
  }
  async function refreshProfile(l) {
    const q = query(l);
    if (!q) {
      panel.last = null;
      draw();
      return;
    }
    panel.last = { l, p: await profile(l, q) };
    draw();
  }

  // The block loads after start-up: register the panel in every window now, and in new ones.
  const reg = (mp) =>
    mp?.docks?.register({
      id: 'timeseries',
      title: t('Time Series'),
      icon: 'curve',
      home: 'right',
      create: (a, m, el) => {
        panel.el = el;
        draw();
        return { onShow: draw };
      },
    });
  if (app._ready) app.desktop.multiports.forEach(reg);
  else app.on('ready', reg);
  const addMp = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const mp = addMp(id);
    if (app._ready) reg(mp);
    return mp;
  };
  // The panel follows the active layer, and the cursor while it is open.
  app.on('layers', () => draw());
  app.on('state', () => draw());
  let raf = 0;
  const prevMoved = app.cursorMoved;
  app.cursorMoved = (p, x, y) => {
    prevMoved?.(p, x, y);
    if (!panel.el?.isConnected || raf) return;
    const l = active();
    if (!l || !(x >= 0 && y >= 0 && x < l.width && y < l.height)) return;
    panel.cursor = { x, y };
    if (panel.mode !== 'cursor') return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      refreshProfile(l).catch(() => {});
    });
  };
  // A recording or playback stops with the layer it shows.
  app.on('layers', () => {
    if (panel.playing && !active()) stop();
  });

  const openPanel = () => pane()?.mp?.docks?.show('timeseries');

  // ---- commands ----

  C.implement('ts.stack', {
    enabled: () => images().length >= 2,
    run: run(async (args) => {
      const cands = images().filter((l) => !(datesOf(l)?.length > 1));
      const items = cands.map((l) => ({ l, date: dateOfImage(l) }));
      if (args?.layers) {
        const pick = items.filter((x) => args.layers.includes(x.l.id) || args.layers.includes(x.l.rec?.name));
        const l = await stack(pick.map((x) => x.l), { band: (args.band ?? 1) - 1, dates: args.dates ?? null });
        return { id: l.id, dates: datesOf(l), resampled: l.resampled };
      }
      const boxes = items.map((x) => h('input', { type: 'checkbox', checked: !!x.date, disabled: !x.date, 'aria-label': x.l.rec?.name ?? x.l.id }));
      const band = h('input', { class: 'inp inp-num', type: 'number', value: '1', min: '1', max: String(Math.max(...cands.map((l) => l.bands))), 'aria-label': t('Band') });
      const body = h(
        'div',
        {},
        ...items.map((x, i) => h('label', { class: 'fld fld-inline' }, boxes[i], h('span', {}, `${x.l.rec?.name ?? x.l.id} · ${x.date ? label(x.date) : t('no date')}`))),
        field(t('Band'), band, t('From images with more than one band, this band is stacked.')),
        h('p', { class: 'hint' }, t('Images on another grid are resampled to the grid of the earliest one, inside the AOI when there is one.')),
      );
      if ((await modal({ title: t('Time Stack'), body, buttons: [{ label: t('Stack'), value: 'stack', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 540, id: 'ts-stack' })) !== 'stack') return undefined;
      const l = await stack(items.filter((_, i) => boxes[i].checked).map((x) => x.l), { band: Math.max(0, +band.value - 1) });
      toast(t('Time stack of {n} dates ({w}×{h}); {r} resampled', { n: l.bands, w: int(l.width), h: int(l.height), r: l.resampled }), { kind: 'info' });
      openPanel();
      return { id: l.id };
    }),
  });

  C.implement('ts.panel', {
    enabled: () => true,
    run: run(async () => {
      openPanel();
    }),
  });

  C.implement('ts.trend', {
    enabled: () => !!active(),
    run: run(async (args) => {
      const l = active() ?? series().l;
      if (!args?.headless) {
        const { dates } = series(l);
        const body = h('div', {}, h('p', {}, t('Fits a straight line through each pixel over its {n} dates ({from} to {to}), skipping missing values. The result has three bands: the slope per year, its two-sided p-value, and the number of dates used.', { n: dates.length, from: label(dates[0]), to: label(dates.at(-1)) })), h('p', { class: 'hint' }, t('Inside the AOI when there is one.')));
        if ((await modal({ title: t('Temporal Trend'), body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'ts-trend' })) !== 'run') return undefined;
      }
      const r = await trend(l);
      toast(t('Trend of {n} pixels', { n: int(r.width * r.height) }), { kind: 'info' });
      return { id: r.id };
    }),
  });

  C.implement('ts.anomaly', {
    enabled: () => !!active(),
    run: run(async (args) => {
      const l = active() ?? series().l;
      const { dates } = series(l);
      let o = { from: args?.from ?? '', to: args?.to ?? '', by: args?.by ?? 'none', z: !!args?.z };
      if (!args?.headless) {
        const from = h('input', { class: 'inp', type: 'date', value: dates[0].slice(0, 10), 'aria-label': t('Baseline from') });
        const to = h('input', { class: 'inp', type: 'date', value: dates[Math.max(0, Math.floor(dates.length / 2) - 1)].slice(0, 10), 'aria-label': t('Baseline to') });
        const by = h('select', { class: 'inp', 'aria-label': t('Compare with') }, h('option', { value: 'month' }, t('The same calendar month of the baseline')), h('option', { value: 'none' }, t('The whole baseline')));
        const z = h('input', { type: 'checkbox', 'aria-label': t('As a z-score') });
        const body = h('div', {}, field(t('Baseline from'), from), field(t('Baseline to'), to), field(t('Compare with'), by), h('label', { class: 'fld fld-inline' }, z, h('span', {}, t('As a z-score (divided by the baseline standard deviation)'))));
        if ((await modal({ title: t('Temporal Anomaly'), body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'ts-anomaly' })) !== 'run') return undefined;
        o = { from: from.value, to: to.value, by: by.value, z: z.checked };
      }
      const r = await anomaly(l, o);
      openPanel();
      return { id: r.id };
    }),
  });

  Object.assign(app.timeseries, { datesOf, dateOfImage, label, stack, show, play, stop, profile, exportProfile, trend, anomaly, openPanel });
}
