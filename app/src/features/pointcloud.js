// Point clouds (REQ-LDR-01..10, SCN-14): open LAS/LAZ into a 3D panel, the header panel, colour
// modes and class visibility, the point budget and EDL, elevation shaving, profiles with a swath,
// 3D measurement, DSM/DTM/nDSM/intensity/density grids as layers, SMRF ground filtering and
// classification edits (undoable through `pcedit` records), clipping, colourising from an image
// and LAS 1.4 export (LAS or LAZ).

import { writePointCloudTileset, enuToEcef, geoToEcef, write3tz, zipTileset, md5 } from '../formats/tiles3d-write.js';
import { readLas, POINTCLOUD_EXT, inverseLattice, statsOf, reorder } from '../formats/las.js';
import { openCopc, openEpt, rangeFile } from '../formats/copc.js';
import { parseBpf, parseAscii, cloudFromXyz, writeBpf, geodeticToEcefJs } from '../formats/points-io.js';
import { View3D, CLASSES, COLOUR_MODES } from '../render/view3d.js';
import { packColumns } from '../wasm/pointcloud.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { openImageFile } from '../formats/open.js';
import { crsOf, converter } from '../geo/crs.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { modal, field, section } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { newId, errorText } from '../core/util.js';
import { t, tc, tr, N_, NC_, msgOf, gwError } from '../i18n/index.js';
import { num, int, area, length, height } from '../i18n/format.js';

const OK_CANCEL = () => [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }];
const CLOSE = () => [{ label: t('Close'), value: 'close', primary: true }];
/** A LAS class name in the UI language. */
const className = (k) => (CLASSES[k]?.[0] ? tr(CLASSES[k][0]) : t('user defined'));
/** An error for the user, in the UI language (errorText's wording for damaged data is in its catalogue). */
// errorText() is already in the UI language (its rewrite through t(), else msgOf(e)): no second t().
const errMsg = (e) => errorText(e);

export const name = 'pointcloud';

const NOISE = new Set([7, 18]);
const GRID_MODE = { max: 0, min: 1, mean: 2, plane: 3, value: 4, density: 5 };
export const SMRF_DEFAULTS = { cell: 1, slope: 0.15, window: 18, threshold: 0.5, scalar: 1.25, lowNoise: 2 };

/** Local frame (DN-36) ↔ geographic. */
export const toGeo = (c, e, n, z) => ({ lat: c.origin.lat0 + n / c.origin.ky, lon: c.origin.lon0 + e / c.origin.kx, hae: z });
export const toLocal = (c, lat, lon) => [(lon - c.origin.lon0) * c.origin.kx, (lat - c.origin.lat0) * c.origin.ky];

/**
 * Rows for the header panel (AT-14.2). The labels stay English (the panel shows them through tr)
 * and the numbers are the header's exact values.
 */
export function headerRows(c) {
  const i = c.info;
  const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : String(v));
  return [
    [N_('File'), c.name],
    [N_('LAS version'), i.version],
    [N_('Point data record format'), `${i.format}${i.compressed ? ' (LAZ)' : ''}`],
    [N_('Record length'), t('{len} B ({extra} extra)', { len: String(i.recordLen), extra: String(i.recordLen - i.baseSize) })],
    [N_('Points'), String(i.nPoints)],
    [N_('Points by return'), i.byReturn.filter((v, k) => v || k < 5).join(', ')],
    [N_('File source ID'), String(i.fileSourceId)],
    [N_('Global encoding'), `${i.globalEncoding} (${i.globalEncoding & 1 ? t('adjusted standard GPS time') : t('GPS week time')}${i.globalEncoding & 16 ? ', WKT' : ''})`],
    [N_('System identifier'), i.systemId],
    [N_('Generating software'), i.software],
    [N_('Creation day/year'), `${i.day}/${i.year}`],
    [N_('Header size'), `${i.headerSize} B`],
    [N_('Offset to point data'), `${i.pointOffset} B`],
    [N_('VLRs / EVLRs'), `${i.nVlrs} / ${i.nEvlrs}`],
    [NC_('factor', 'Scale'), i.scale.map((v) => String(v)).join(', ')],
    [N_('Offset'), i.offset.map((v) => f(v)).join(', ')],
    [N_('Min X, Y, Z'), i.min.map((v) => f(v)).join(', ')],
    [N_('Max X, Y, Z'), i.max.map((v) => f(v)).join(', ')],
    [N_('Horizontal CRS'), c.crs.label],
    [N_('Vertical'), c.crs.vertical === 'hae' || c.crs.vertical === 'unstated' ? t('{datum} (used as HAE); unit {unit} m', { datum: c.crs.vname || c.crs.vertical, unit: String(c.crs.vUnit) }) : t('{datum} (converted to HAE); unit {unit} m', { datum: c.crs.vname || c.crs.vertical, unit: String(c.crs.vUnit) })],
    [N_('Horizontal unit'), `${c.crs.hUnit} m`],
    ...(i.laz ? [['LAZ', i.laz.variable ? t('variable chunks; {items}', { items: i.laz.items.join(', ') }) : t('{n}-point chunks; {items}', { n: String(i.laz.chunkSize), items: i.laz.items.join(', ') })]] : []),
    ['COPC', i.copc ? t('yes (read as LAZ)') : t('no')],
  ];
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const view = (p = pane()) => p?.view3d ?? null;
  // Tools work on whole clouds; streamed COPC/EPT clouds are for viewing.
  const cloudOf = (p = pane()) => view(p)?.clouds.filter((c) => !c.cloud.streamed).at(-1)?.cloud ?? null;
  app.pointClouds = new Map();

  // ---- opening ----
  async function show(cloud, p = pane()) {
    if (!p) throw new Error('no panel');
    if (!p.view3d) {
      p.view3d = await View3D.create(app, p);
      p.view3d.onPick = (pk) => app.pc.onPick?.(p, pk);
    }
    p.view3d.addCloud(cloud);
    app.emit('state');
    return p.view3d;
  }

  /**
   * BPF (REQ-LDR-11, REQ-FMT-47): UTM from the header, TCR (ECEF) converted to WGS 84; Cartesian and
   * ENU in a local frame (REQ-LDR-13) that Assign CRS places later. Heights are taken as HAE.
   */
  const readBpf = async (file) => {
    const src = await parseBpf(file);
    const cloud = await cloudFromXyz({ ...src, size: file.size }, { epsg: src.epsg, local: src.local, ...geoOpts() });
    if (src.local) cloud.src = { ...src, size: file.size }; // the file's own coordinates, for Assign CRS
    return cloud;
  };
  const geoOpts = () => ({ pool: app.pool, undulation: (lat, lon) => app.core.undulation(lat, lon), ensureGeoid: () => app.ensureGeoid() });
  /** ASCII points (REQ-LDR-11): asks for the columns and the CRS unless `ascii` gives them. */
  async function readAscii(file, ascii = null) {
    const text = await file.text();
    let o = ascii;
    if (!o) {
      const lines = text.slice(0, 1 << 16).split(/\r?\n/).filter((l) => l.trim() && !/^[#/]/.test(l.trim()));
      const first = lines[0] ?? '';
      const split = (l) => l.trim().split(/\s*[,;\t|]\s*|\s+/);
      const inp = (v, label) => h('input', { class: 'inp inp-num', type: 'number', min: '0', value: v, 'aria-label': label });
      // A header line names the columns (PDAL text writer: "Red","Green","X","Y","Blue","Z"): propose
      // them by name rather than 0, 1, 2.
      const names = /[a-df-z]/i.test(first) ? first.trim().split(/\s*[,;\t|]\s*|\s+/).map((t) => t.replace(/^"|"$/g, '').toLowerCase()) : [];
      const by = (...ks) => {
        const i = names.findIndex((t) => ks.includes(t));
        return i >= 0 ? String(i) : null;
      };
      const cx = inp(by('x', 'easting', 'lon', 'longitude') ?? '0', t('X column'));
      const cy = inp(by('y', 'northing', 'lat', 'latitude') ?? '1', t('Y column'));
      const cz = inp(by('z', 'elevation', 'height', 'alt') ?? '2', t('Z column'));
      const ci = inp(by('intensity', 'i') ?? '', t('Intensity column'));
      const cc = inp(by('classification', 'class') ?? '', t('Class column'));
      const skip = inp(/[a-df-z]/i.test(first) ? '1' : '0', t('Header lines'));
      // Longitude/latitude is proposed when the first data row (not a header or a .pts point count)
      // has X and Y in range in the proposed columns.
      const row = lines.map(split).find((t) => t.length >= 3 && t.every((v) => v === '' || Number.isFinite(Number(v.replace(/^"|"$/g, ''))))) ?? [];
      const geo = Math.abs(Number(row[Number(cx.value)])) <= 180 && Math.abs(Number(row[Number(cy.value)])) <= 90;
      const epsg = h('input', { class: 'inp inp-num', type: 'number', value: geo ? '4326' : '', placeholder: t('e.g. {example}', { example: '32611' }), 'aria-label': t('EPSG code') });
      const vert = h('select', { class: 'inp', 'aria-label': t('Heights') }, h('option', { value: 'hae' }, t('Ellipsoidal (HAE)')), h('option', { value: 'egm96' }, t('EGM96 (MSL)')));
      const body = h('div', {}, h('p', { class: 'hint mono' }, first.slice(0, 120)), field(t('X, Y, Z columns (0 = first)'), h('span', { class: 'btn-row' }, cx, cy, cz)), field(t('Intensity, class columns (blank = none)'), h('span', { class: 'btn-row' }, ci, cc)), field(t('Header lines to skip'), skip), field(t('Coordinate system (EPSG)'), epsg), field(t('Heights'), vert));
      // Automation and tests (like zipPick): 'default' takes the proposed columns without the dialog;
      // an object ({epsg, vertical}) also sets those fields.
      const auto = app.asciiPick === 'default' || (app.asciiPick && typeof app.asciiPick === 'object');
      if (app.asciiPick?.epsg) epsg.value = String(app.asciiPick.epsg);
      if (app.asciiPick?.vertical) vert.value = app.asciiPick.vertical;
      if (!auto && (await modal({ title: t('ASCII Points — {file}', { file: file.name }), body, buttons: OK_CANCEL(), id: 'pc-ascii' })) !== 'ok') return null;
      const col = (e) => (e.value.trim() === '' ? undefined : Number(e.value));
      o = { columns: { x: col(cx), y: col(cy), z: col(cz), intensity: col(ci), class: col(cc) }, skip: Number(skip.value) || 0, epsg: Number(epsg.value), vertical: vert.value };
    }
    if (!(o.epsg > 0)) throw new Error('the coordinate system is not set: give the EPSG code of these coordinates (local scanner coordinates with no CRS cannot be placed)');
    // Codes only the PROJ pack knows (state planes in feet) are defined before the cloud is placed.
    await app.proj?.prepare?.([o.epsg]);
    const src = parseAscii(text, { columns: o.columns, skip: o.skip ?? 0, delimiter: o.delimiter ?? null, name: file.name });
    return cloudFromXyz({ ...src, size: file.size }, { epsg: o.epsg, vertical: o.vertical ?? 'hae', ...geoOpts() });
  }

  async function open(file, p = pane(), { ascii = null } = {}) {
    const cloud = /\.bpf$/i.test(file.name) ? await app.activity.track(t('Reading {file}…', { file: file.name }), () => readBpf(file)) : /\.(xyz|pts|txt|csv)$/i.test(file.name) ? await readAscii(file, ascii) : await app.activity.track(t('Reading {file}…', { file: file.name }), (job) => readLas(file, { ...geoOpts(), onProgress: (f) => job.set(f) }));
    if (!cloud) return null;
    cloud.id = newId('pc');
    cloud.file = file;
    cloud.class0 = cloud.class.slice();
    app.pointClouds.set(cloud.id, cloud);
    S.transact(t('Open point cloud'), (tx) => tx.create('pointcloud', { pcId: cloud.id, name: cloud.name, points: cloud.n, crs: cloud.crs.label, vertical: cloud.crs.vertical, pane: p?.id ?? null }), { kind: 'load' });
    app.importLog.push({ file: file.name, errors: [], warnings: cloud.crs.warnings });
    await show(cloud, p);
    return cloud;
  }

  // ---- streaming (REQ-LDR-02, REQ-ARC-16): COPC by range, EPT by node ----
  const geo = () => ({ pool: app.pool, undulation: (lat, lon) => app.core.undulation(lat, lon), ensureGeoid: () => app.ensureGeoid() });
  async function stream(src, p = pane(), opts = {}) {
    if (!p.view3d) {
      p.view3d = await View3D.create(app, p);
      p.view3d.onPick = (pk) => app.pc.onPick?.(p, pk);
    }
    const entry = p.view3d.addStream(src, opts);
    S.transact(t('Stream point cloud'), (tx) => tx.create('pointcloud', { name: src.name, points: src.total, crs: src.crs.label, vertical: src.crs.vertical, pane: p.id, streamed: src.kind, url: src.url ?? src.file?.url ?? null }), { kind: 'load' });
    app.importLog.push({ file: src.name, errors: [], warnings: [t('{kind}: streamed by node ({n} points in the octree)', { kind: src.kind, n: int(src.total) }), ...(src.crs.warnings ?? [])] });
    app.emit('state');
    return entry;
  }
  async function streamCopc(fileOrUrl, p = pane(), opts = {}) {
    const f = typeof fileOrUrl === 'string' ? await rangeFile(fileOrUrl, app.netlog.fetchFor(`COPC: ${new URL(fileOrUrl).host}`)) : fileOrUrl;
    return stream(await openCopc(f, geo()), p, opts);
  }
  async function streamEpt(url, p = pane(), opts = {}) {
    return stream(await openEpt(url, app.netlog.fetchFor(`EPT: ${new URL(url).host}`), geo()), p, opts);
  }

  app.openPointClouds = async (files, p = pane()) => {
    const out = [];
    for (const f of files) {
      try {
        // A large local COPC (or with the preference on) streams by range instead of loading whole.
        if (/\.copc\.laz$/i.test(f.name) && (f.size > 256 * 2 ** 20 || app.prefs.get('copcStream'))) {
          const e = await streamCopc(f, p);
          out.push(e.cloud);
          app.toast(t('Streaming {file} by range ({n} points)', { file: f.name, n: int(e.stream.total) }), { kind: 'info' });
          continue;
        }
        const c = await open(f, p);
        if (!c) continue;
        out.push(c);
        const opened = t('Opened {file}: {n} points in {ms} ms', { file: f.name, n: int(c.n), ms: c.ms.total });
        app.toast(c.crs.warnings.length ? `${opened} ${t('({n, plural, one {# note} other {# notes}} in the import log)', { n: c.crs.warnings.length })}` : opened, { kind: 'info' });
      } catch (e) {
        app.log('warn', `${f.name}: ${e.message}`);
        app.toast(t('{file}: {msg}', { file: f.name, msg: errMsg(e) }), { kind: 'error', ms: 8000 });
        app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] });
      }
    }
    return out;
  };
  app.splitPointCloudFiles = (files) => {
    // .txt is a cloud only when openFiles found X/Y/Z rows in it (f.__asciiCloud).
    const clouds = files.filter((f) => POINTCLOUD_EXT.test(f.name) || f.__asciiCloud);
    // TE-014: companions of a cloud (LAStools .lax index, .wdp waveform packets, .prj/.xml/.txt
    // metadata) travel with it instead of falling through to the image reader as "unrecognised".
    const stems = new Set(clouds.map((f) => f.name.replace(/\.(copc\.)?[^.]+$/i, '').toLowerCase()));
    const stemOf = (n) => n.replace(/\.[^.]+$/, '').replace(/\.(copc\.)?la[sz]$/i, '').toLowerCase(); // a.lax, a.laz.xml → a
    const companion = (f) => /\.(lax|wdp|prj|xml|txt|sha256|md5)$/i.test(f.name) && stems.has(stemOf(f.name));
    const extra = files.filter((f) => !clouds.includes(f) && companion(f));
    for (const f of extra) app.importLog.push({ file: f.name, errors: [], warnings: [t('{file}: kept with its point cloud (not read)', { file: f.name })] });
    return { clouds, rest: files.filter((f) => !clouds.includes(f) && !companion(f)) };
  };

  function close(p = pane()) {
    if (!p?.view3d) return;
    p.view3d.dispose();
    p.view3d = null;
    p.invalidate?.();
    app.renderer?.invalidate();
    app.emit('state');
  }

  // ---- classification edits (undoable) ----
  // Each `pcedit` record names its cloud and sequence; its change (indices and new classes) is
  // kept in memory under the record id, and the classes are replayed over the file's own.
  const diffs = new Map();
  const sigs = new Map();
  function syncEdits() {
    for (const c of app.pointClouds.values()) {
      const ops = S.all('pcedit').filter((o) => o.pc === c.id).sort((a, b) => a.seq - b.seq);
      const sig = ops.map((o) => o.id).join(',');
      if ((sigs.get(c.id) ?? '') === sig) continue;
      sigs.set(c.id, sig);
      const cls = c.class0.slice();
      for (const o of ops) {
        const d = diffs.get(o.id);
        if (!d) continue;
        for (let k = 0; k < d.index.length; k++) cls[d.index[k]] = d.value[k];
      }
      c.class = cls;
      c.stats.classes = countClasses(cls);
      for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) p.view3d?.refresh(c, ['classification']);
    }
  }
  S.on('change', syncEdits);
  function countClasses(cls) {
    const n = new Uint32Array(256);
    for (let k = 0; k < cls.length; k++) n[cls[k]]++;
    const o = {};
    for (let i = 0; i < 256; i++) if (n[i]) o[i] = n[i];
    return o;
  }
  /** Record a classification change: `next` = full new class array (only differences are kept). */
  function recordClasses(c, next, label, params = {}) {
    const idx = [];
    for (let k = 0; k < c.n; k++) if (next[k] !== c.class[k]) idx.push(k);
    const index = Uint32Array.from(idx);
    const value = Uint8Array.from(idx, (k) => next[k]);
    const seq = S.all('pcedit').filter((o) => o.pc === c.id).reduce((m, o) => Math.max(m, o.seq), 0) + 1;
    let id;
    S.transact(tr(label), (tx) => (id = tx.create('pcedit', { pc: c.id, seq, label, params, changed: idx.length, created: new Date().toISOString(), analyst: app.prefs.get('analyst') ?? 'analyst' })));
    diffs.set(id, { index, value });
    sigs.delete(c.id);
    syncEdits();
    return { id, changed: idx.length };
  }

  // ---- worker jobs ----
  const job = (op, args, transfer = []) => app.pool.run(op, args, { kind: 'pointcloud', transfer, label: t('{op} point cloud', { op }), timeout: 600000 });
  const maskOf = (c, keep) => {
    const m = new Uint8Array(c.n);
    for (let k = 0; k < c.n; k++) m[k] = keep(k) ? 1 : 0;
    return m;
  };
  const withheld = (c, k) => (c.flags[k] & 4) !== 0;

  /** SMRF ground filter (REQ-LDR-09). Returns {changed, agreement?, ms}. */
  async function groundFilter(c, params = {}) {
    const p = { ...SMRF_DEFAULTS, ...params };
    const t0 = performance.now();
    const mask = maskOf(c, (k) => c.class[k] !== 18 && !withheld(c, k));
    const out = await job('smrf', { pos: c.pos, mask, prm: [p.cell, p.slope, p.window, p.threshold, p.scalar, p.lowNoise] }, [mask.buffer]);
    const next = c.class.slice();
    for (let k = 0; k < c.n; k++) {
      const v = out[k];
      if (v === 2) next[k] = 2;
      else if (v === 7) next[k] = 7;
      else if (v === 1 && next[k] === 2) next[k] = 1;
    }
    const r = recordClasses(c, next, N_('Ground filter (SMRF)'), p); // the record keeps the English label
    return { ...r, ms: Math.round(performance.now() - t0), ground: next.reduce((s, v) => s + (v === 2 ? 1 : 0), 0) };
  }

  /**
   * A post spacing that suits the cloud: the largest 1-2-5 step at or below the mean point spacing
   * √(area / points), never below `min` (a COPC root of 1 065 points over 4 km has 120 m spacing,
   * where a 1 m grid would be 15 M mostly empty posts; Autzen's 2.4 m gives 2 m).
   */
  function defaultCell(c, min = 0.5) {
    const st = c.stats;
    const area = Math.max(1, (st.max[0] - st.min[0]) * (st.max[1] - st.min[1]));
    const spacing = Math.sqrt(area / Math.max(1, c.n));
    const next = (v) => [1, 2, 5].map((k) => k * 10 ** Math.floor(Math.log10(v) + 1e-9)).concat(10 ** (Math.floor(Math.log10(v) + 1e-9) + 1)).find((x) => x > v * (1 + 1e-9));
    let v = min;
    for (let nx = next(v); nx <= spacing; nx = next(v)) v = nx;
    return Number(v.toPrecision(3));
  }
  const MAX_POSTS = 40e6;

  /** Grid spec in the local frame for a cell size over the cloud (posts on multiples of the cell). */
  function gridFor(c, cell) {
    const st = c.stats;
    const e0 = Math.ceil(st.min[0] / cell) * cell;
    const n0 = Math.floor(st.max[1] / cell) * cell;
    const w = Math.max(2, Math.floor((st.max[0] - e0) / cell) + 1);
    const hh = Math.max(2, Math.floor((n0 - st.min[1]) / cell) + 1);
    if (w * hh > MAX_POSTS) throw gwError('{w} × {h} posts at {cell} m is too many for the browser; use {min} m or more', { w: int(w), h: int(hh), cell, min: defaultCell(c, cell * Math.sqrt((w * hh) / MAX_POSTS)) }, 'E_TOO_MANY_POSTS');
    const o = c.origin;
    return { e0, n0, ce: cell, cn: cell, w, h: hh, geo: { lat0: o.lat0 + n0 / o.ky, lon0: o.lon0 + e0 / o.kx, dlat: cell / o.ky, dlon: cell / o.kx, nx: w, ny: hh } };
  }

  /**
   * Grids (REQ-LDR-08): kind 'dsm' (highest non-noise point), 'dtm' (mean of the ground points at
   * each post, holes filled by Laplace interpolation; TE-041: on USGS 3DEP the 3 × 3 local plane it
   * replaces was 35–50 % worse at the delivered ground points), 'ndsm' (DSM − DTM), 'intensity' (mean)
   * or 'density' (points per m²). Returns {grid, heights}.
   */
  async function makeGrid(c, kind, { cell = 1, fill = true } = {}) {
    const g = gridFor(c, cell);
    const prm = (mode, iters) => [g.e0, g.n0, g.ce, g.cn, g.w, g.h, mode, iters];
    const pos = c.pos;
    if (kind === 'dsm') return { grid: g, heights: await job('grid', { pos, mask: maskOf(c, (k) => !NOISE.has(c.class[k]) && !withheld(c, k)), val: null, prm: prm(GRID_MODE.max, fill ? 300 : 0) }) };
    if (kind === 'dtm') {
      const mask = maskOf(c, (k) => c.class[k] === 2 && !withheld(c, k));
      // No ground points: the DTM was all voids and failed later as "no heights over this area" (TE 2.0.4 cross).
      if (!mask.includes(1)) throw gwError('{cloud} has no ground-classified points (class 2): run Classify ▸ Ground Filter first', { cloud: c.name }, 'E_NO_GROUND');
      return { grid: g, heights: await job('grid', { pos, mask, val: null, prm: prm(GRID_MODE.mean, fill ? 800 : 0) }) };
    }
    if (kind === 'ndsm') {
      const [a, b] = await Promise.all([makeGrid(c, 'dsm', { cell, fill }), makeGrid(c, 'dtm', { cell, fill })]);
      const z = new Float32Array(a.heights.length);
      for (let i = 0; i < z.length; i++) z[i] = a.heights[i] - b.heights[i];
      return { grid: g, heights: z, dsm: a.heights, dtm: b.heights };
    }
    if (kind === 'intensity') return { grid: g, heights: await job('grid', { pos, mask: maskOf(c, (k) => !NOISE.has(c.class[k])), val: Float32Array.from(c.intensity), prm: prm(GRID_MODE.value, fill ? 50 : 0) }) };
    if (kind === 'density') return { grid: g, heights: await job('grid', { pos, mask: null, val: null, prm: prm(GRID_MODE.density, 0) }) };
    throw gwError('unknown grid kind {kind}', { kind }, 'E_GRID_KIND');
  }

  const LABEL = { dsm: 'DSM', dtm: 'DTM', ndsm: 'nDSM', intensity: N_('Intensity'), density: N_('Density') };
  /** Make a grid and open it as a layer (DSM/DTM as terrain, kind recorded). */
  async function generate(c, kind, { cell = 1, open: doOpen = true, p = pane2d() } = {}) {
    const r = await makeGrid(c, kind, { cell });
    const G = r.grid.geo;
    const vertical = kind === 'dsm' || kind === 'dtm' ? 'hae' : null;
    const unit = { dsm: 'height above the WGS 84 ellipsoid, m', dtm: 'height above the WGS 84 ellipsoid, m', ndsm: 'height above ground, m', intensity: 'mean intensity', density: 'points per m²' }[kind];
    const bytes = await writeGeoTiff({ width: G.nx, height: G.ny, bands: 1, type: 'f32', data: r.heights }, { epsg: 4326, vertical, geotransform: [G.lon0 - G.dlon / 2, G.dlon, 0, G.lat0 + G.dlat / 2, 0, -G.dlat], nodata: NaN, description: `GIS Workbench ${LABEL[kind]} (${unit}) from ${c.name}, ${cell} m posts`, overviews: true });
    const fname = `${c.name.replace(/\.(las|laz)$/i, '')}_${LABEL[kind]}.tif`;
    const file = new File([bytes], fname, { type: 'image/tiff', lastModified: Date.now() });
    const res = { ...r, file, kind };
    if (kind === 'dtm') {
      c.dtm = r;
      heightAboveGround(c, r);
    }
    if (!doOpen) return res;
    // The panel can be gone by the time a long grid finishes (a new project, a closed window).
    if (!p || !app.store.get(p.id)) throw gwError('the panel the {product} was made for has been closed', { product: LABEL[kind] }, 'E_PANEL_CLOSED');
    const { layers } = await openImageFile(app, file, { pane: p });
    const l = layers[0];
    res.layer = l;
    if (vertical) {
      await app.useAsTerrain(l, 'hae');
      const te = app.terrain.entry(l.id);
      if (te) te.kind = kind === 'dsm' ? 'DSM' : 'DTM';
    }
    return res;
  }
  /** A panel without a 3D view for the generated layers (the next one, else the active). */
  function pane2d() {
    const all = (app.desktop?.multiports ?? []).flatMap((mp) => mp.panes);
    return all.find((p) => !p.view3d) ?? pane();
  }

  /** Height above ground per point from a DTM grid (colour and shaving against the ground). */
  function heightAboveGround(c, dtm) {
    const g = dtm.grid;
    const z = dtm.heights;
    const hag = new Float32Array(c.n);
    for (let k = 0; k < c.n; k++) {
      const fx = (c.pos[3 * k] - g.e0) / g.ce;
      const fy = (g.n0 - c.pos[3 * k + 1]) / g.cn;
      const x0 = Math.max(0, Math.min(g.w - 2, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(g.h - 2, Math.floor(fy)));
      const tx = Math.max(0, Math.min(1, fx - x0));
      const ty = Math.max(0, Math.min(1, fy - y0));
      const a = (i, j) => z[j * g.w + i];
      const ground = (a(x0, y0) * (1 - tx) + a(x0 + 1, y0) * tx) * (1 - ty) + (a(x0, y0 + 1) * (1 - tx) + a(x0 + 1, y0 + 1) * tx) * ty;
      hag[k] = c.pos[3 * k + 2] - ground;
    }
    c.hag = hag;
    for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) p.view3d?.refresh(c, ['hag']);
    return hag;
  }

  /** Profile (REQ-LDR-07): points within `half` m of a → b (local), ordered along. */
  async function profile(c, a, b, half = 1, { max = 200000, v = view() } = {}) {
    const vis = v ? (k) => v.classVisible[c.class[k]] : () => true;
    const mask = maskOf(c, vis);
    const r = await job('profile', { pos: c.pos, mask, prm: [a[0], a[1], b[0], b[1], half, max] }, [mask.buffer]);
    const z = Float32Array.from(r.index, (k) => c.pos[3 * k + 2]);
    return { ...r, z, a, b, half, cloud: c };
  }

  /** 3D measurement between two local points, with heights above the DTM when there is one. */
  function measure(c, p, q) {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const dz = q[2] - p[2];
    const ga = toGeo(c, ...p);
    const gb = toGeo(c, ...q);
    const horiz = app.core.inverse(ga.lat, ga.lon, gb.lat, gb.lon).distance;
    const hagAt = (pt) => {
      const g = c.dtm?.grid;
      if (!g) return null;
      const fx = Math.round((pt[0] - g.e0) / g.ce);
      const fy = Math.round((g.n0 - pt[1]) / g.cn);
      if (fx < 0 || fy < 0 || fx >= g.w || fy >= g.h) return null;
      return pt[2] - c.dtm.heights[fy * g.w + fx];
    };
    return { horizontal: horiz, slant: Math.hypot(horiz, dz), dz, local: Math.hypot(dx, dy, dz), azimuth: app.core.inverse(ga.lat, ga.lon, gb.lat, gb.lon).azi1, hagA: hagAt(p), hagB: hagAt(q), a: ga, b: gb };
  }

  /** Reclassify points inside a screen polygon (CSS px of the view), optionally only class `from`. */
  function reclassPolygon(c, v, poly, to, { from = null } = {}) {
    const inside = screenSelect(c, v, poly);
    const next = c.class.slice();
    for (let k = 0; k < c.n; k++) if (inside[k] && (from == null || c.class[k] === from) && v.classVisible[c.class[k]]) next[k] = to;
    return recordClasses(c, next, `Reclassify to ${to}`, { to, from, vertices: poly.length });
  }
  function screenSelect(c, v, poly) {
    const cam = v.camera;
    cam.updateMatrixWorld();
    const group = v.clouds.find((x) => x.cloud === c)?.group ?? v.world;
    group.updateMatrixWorld(true);
    const m = new v.T.Matrix4().multiplyMatrices(new v.T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse), group.matrixWorld).elements;
    const r = v.canvas.getBoundingClientRect();
    const out = new Uint8Array(c.n);
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    for (let k = 0; k < c.n; k++) {
      const x = c.pos[3 * k];
      const y = c.pos[3 * k + 1];
      const z = c.pos[3 * k + 2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 0) continue;
      const px = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * r.width;
      const py = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5 * r.height;
      if (px < x0 || px > x1 || py < y0 || py > y1) continue;
      let inside = false;
      for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) if (poly[a][1] > py !== poly[b][1] > py && px < ((poly[b][0] - poly[a][0]) * (py - poly[a][1])) / (poly[b][1] - poly[a][1]) + poly[a][0]) inside = !inside;
      out[k] = inside ? 1 : 0;
    }
    return out;
  }

  /** A new cloud with the points inside (or outside) a local-frame polygon or box (REQ-LDR-09 clip). */
  async function clip(c, ring, { keep = 'inside', p = pane() } = {}) {
    const idx = [];
    for (let k = 0; k < c.n; k++) {
      const x = c.pos[3 * k];
      const y = c.pos[3 * k + 1];
      let inside = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) if (ring[a][1] > y !== ring[b][1] > y && x < ((ring[b][0] - ring[a][0]) * (y - ring[a][1])) / (ring[b][1] - ring[a][1]) + ring[a][0]) inside = !inside;
      if (inside === (keep === 'inside')) idx.push(k);
    }
    const perm = Uint32Array.from(idx);
    const sub = { ...c, id: newId('pc'), name: t('{cloud} (clipped)', { cloud: c.name }), dtm: null, hag: null, order: null };
    reorder(sub, perm);
    sub.n = perm.length;
    sub.stats = statsOf(sub, !!sub.rgb);
    const area = Math.max(1, (sub.stats.max[0] - sub.stats.min[0]) * (sub.stats.max[1] - sub.stats.min[1]));
    const tile = Math.min(500, Math.max(15, Math.sqrt((area * 100000) / Math.max(1, sub.n))));
    const ix = await job('index', { pos: sub.pos, tile, s0: tile / 16, maxLevel: 12 });
    reorder(sub, ix.perm);
    sub.tiles = ix.tiles;
    sub.class0 = sub.class.slice();
    app.pointClouds.set(sub.id, sub);
    S.transact(t('Clip point cloud'), (tx) => tx.create('pointcloud', { pcId: sub.id, name: sub.name, points: sub.n, crs: sub.crs.label, vertical: sub.crs.vertical, pane: p?.id ?? null, derivedFrom: c.id }), { kind: 'edit' });
    if (p) {
      const v = p.view3d;
      if (v) v.removeCloud(c);
      await show(sub, p);
    }
    return sub;
  }

  /** Colourise from an image layer (REQ-LDR-10): RGB from its first three bands, stretched to 16 bit. */
  async function colourise(c, l) {
    if (!l?.modelId) throw new Error('the image has no sensor model');
    const n = c.n;
    const pts = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) {
      const g = toGeo(c, c.pos[3 * k], c.pos[3 * k + 1], c.pos[3 * k + 2]);
      pts[3 * k] = g.lat;
      pts[3 * k + 1] = g.lon;
      pts[3 * k + 2] = g.hae;
    }
    const xy = app.core.g2iBatch(l.modelId, pts); // chunked inside the core wrapper (TE-044)
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++) {
      const x = xy[2 * k];
      const y = xy[2 * k + 1];
      if (!Number.isFinite(x)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    x0 = Math.max(0, Math.floor(x0) - 1);
    y0 = Math.max(0, Math.floor(y0) - 1);
    x1 = Math.min(l.width, Math.ceil(x1) + 1);
    y1 = Math.min(l.height, Math.ceil(y1) + 1);
    if (!(x1 > x0 && y1 > y0)) throw new Error('the cloud lies outside the image');
    const w = x1 - x0;
    const hh = y1 - y0;
    if (w * hh > 64e6) throw new Error('the image window under the cloud is too large to colourise at full resolution');
    const nb = Math.min(3, l.bands);
    const bands = [];
    for (let b = 0; b < nb; b++) bands.push((await app.pool.run('patch', { handle: l.handle, x: x0, y: y0, w, h: hh, band: b }, { affinity: l.affinity, timeout: 300000 })).px);
    const st = l.stats ?? [];
    const lo = (b) => st[b]?.p2 ?? st[b]?.min ?? 0;
    const hi = (b) => st[b]?.p98 ?? st[b]?.max ?? 255;
    const rgb = new Uint16Array(3 * n);
    let inside = 0;
    for (let k = 0; k < n; k++) {
      const x = Math.floor(xy[2 * k]) - x0;
      const y = Math.floor(xy[2 * k + 1]) - y0;
      if (!(x >= 0 && y >= 0 && x < w && y < hh)) continue;
      inside++;
      for (let a = 0; a < 3; a++) {
        const b = Math.min(a, nb - 1); // a two-band image has no third band (GUI-043)
        const v = (bands[b][y * w + x] - lo(b)) / Math.max(1e-6, hi(b) - lo(b));
        rgb[3 * k + a] = Math.round(65535 * Math.max(0, Math.min(1, v)));
      }
    }
    c.rgb = rgb;
    c.hasRgb = true;
    c.stats.rgbMax = 65535;
    c.stats.rgb16 = true;
    c.colourSource = l.rec.name;
    for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) p.view3d?.refresh(c, ['rgb']);
    return { inside, window: [x0, y0, w, hh] };
  }

  /** LAS 1.4 export (REQ-LDR-10): format 7 with colour else 6, in WGS 84 / UTM, HAE or EGM96 heights. */
  async function exportLas(c, { compress = false, heights = 'hae' } = {}) {
    const zone = Math.floor((c.origin.lon0 + 180) / 6) + 1;
    const south = c.origin.lat0 < 0;
    const epsg = (south ? 32700 : 32600) + zone;
    const def = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
    const st = c.stats;
    const box = [st.min[0] - 1, st.min[1] - 1, st.max[0] + 1, st.max[1] + 1];
    await app.ensureGeoid?.();
    const inv = inverseLattice(c.origin, box, { def, label: `EPSG:${epsg}` }, heights === 'egm96' ? (lat, lon) => -app.core.undulation(lat, lon) : 0);
    const cm = -117 + (zone - 11) * 6;
    const proj = `PROJCS["WGS 84 / UTM zone ${zone}${south ? 'S' : 'N'}",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",${cm}],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",${south ? 10000000 : 0}],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","${epsg}"]]`;
    const wkt = heights === 'egm96' ? `COMPD_CS["WGS 84 / UTM zone ${zone}${south ? 'S' : 'N'} + EGM96 height",${proj},VERT_CS["EGM96 height",VERT_DATUM["EGM96 geoid",2005,AUTHORITY["EPSG","5171"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Gravity-related height",UP],AUTHORITY["EPSG","5773"]]]` : `COMPD_CS["WGS 84 / UTM zone ${zone}${south ? 'S' : 'N'} + WGS 84 ellipsoidal height",${proj},VERT_CS["WGS 84 ellipsoidal height",VERT_DATUM["World Geodetic System 1984",2002],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Ellipsoidal height",UP]]]`;
    const fmt = c.rgb ? 7 : 6;
    const now = new Date();
    const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    const cols = packColumns(c);
    const bytes = await job('write', { cols, n: c.n, rgb: !!c.rgb, inv, prm: [fmt, 0.001, 0.001, 0.001, doy, now.getFullYear(), c.info.globalEncoding & 1, c.t0, compress ? 1 : 0], text: `${wkt}\0GIS Workbench\0GIS Workbench ${app.build?.version ?? ''}`.slice(0, 1e6) }, [cols.buffer]);
    const name = `${c.name.replace(/\.(las|laz)$/i, '')}_export.${compress ? 'laz' : 'las'}`;
    return { bytes, name, format: fmt, epsg };
  }

  /**
   * A cloud as a 3D Tiles 1.1 implicit octree of pnts (REQ-FMT-37): ENU about the cloud's centre
   * (the root transform places it in ECEF), RGB (8-bit), Classification and Intensity per point.
   */
  function exportTiles(c, { archive = false, maxPoints = 50000 } = {}) {
    const o = c.origin;
    const st = c.stats;
    const ce = (st.min[0] + st.max[0]) / 2;
    const cn = (st.min[1] + st.max[1]) / 2;
    const lat = o.lat0 + cn / o.ky;
    const lon = o.lon0 + ce / o.kx;
    const h0 = st.min[2];
    const M = enuToEcef(lat, lon, h0);
    const pos = new Float64Array(3 * c.n);
    for (let k = 0; k < c.n; k++) {
      const [x, y, z] = geoToEcef(o.lat0 + c.pos[3 * k + 1] / o.ky, o.lon0 + c.pos[3 * k] / o.kx, c.pos[3 * k + 2]);
      const d = [x - M[12], y - M[13], z - M[14]];
      pos[3 * k] = M[0] * d[0] + M[1] * d[1] + M[2] * d[2];
      pos[3 * k + 1] = M[4] * d[0] + M[5] * d[1] + M[6] * d[2];
      pos[3 * k + 2] = M[8] * d[0] + M[9] * d[1] + M[10] * d[2];
    }
    const colors = c.rgb ? Uint8Array.from(c.rgb, (v) => v >> 8) : null;
    const batch = { Classification: Uint8Array.from(c.class), Intensity: Uint16Array.from(c.intensity) };
    const r = writePointCloudTileset({ positions: pos, colors, batch }, { lat, lon, h: h0 }, { maxPoints });
    const stem = c.name.replace(/\.(las|laz|copc\.laz|txt|xyz|pts)$/i, '').replace(/[^\w.-]+/g, '_');
    return { bytes: archive ? write3tz(r.files, md5) : zipTileset(r.files, `${stem}_3dtiles`), name: archive ? `${stem}.3tz` : `${stem}_3dtiles.zip`, stats: r.stats };
  }

  /**
   * BPF v3 export (REQ-FMT-48): coordType 1 WGS 84 / UTM (the cloud's zone), 2 TCR (ECEF, WGS 84),
   * 3 ENU about the cloud's centre on the ellipsoid, 0 Cartesian = the coordinates of the cloud's own
   * CRS (a local-frame cloud gets its file coordinates back). zlib or no compression; every attribute.
   */
  async function exportBpf(c, { coordType = 1, compression = 'zlib', interleave = 0 } = {}) {
    const n = c.n;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const z = new Float64Array(n);
    let coordId = 0;
    let conv = null;
    const noCrs = 'the cloud is in a local frame with no CRS: assign its CRS first (Point Cloud ▸ Assign CRS), or export Cartesian';
    if (coordType === 1) {
      if (c.crs.local) throw new Error(noCrs);
      const zone = Math.floor((c.origin.lon0 + 180) / 6) + 1;
      const south = c.origin.lat0 < 0;
      coordId = south ? -zone : zone;
      conv = converter(crsOf({ epsg: (south ? 32700 : 32600) + zone }));
    } else if (coordType === 0) conv = converter(c.crs.crs);
    else if (c.crs.local) throw new Error(noCrs);
    else if (coordType === 2) coordId = 1;
    const o = geodeticToEcefJs(c.origin.lat0, c.origin.lon0, 0);
    const r = Math.PI / 180;
    const [sl, cl, so, co] = [Math.sin(c.origin.lat0 * r), Math.cos(c.origin.lat0 * r), Math.sin(c.origin.lon0 * r), Math.cos(c.origin.lon0 * r)];
    for (let k = 0; k < n; k++) {
      const g = toGeo(c, c.pos[3 * k], c.pos[3 * k + 1], c.pos[3 * k + 2]);
      if (conv) {
        [x[k], y[k]] = conv.fromLonLat(g.lon, g.lat);
        z[k] = g.hae;
      } else {
        const e = geodeticToEcefJs(g.lat, g.lon, g.hae);
        if (coordType === 2) [x[k], y[k], z[k]] = e;
        else {
          const [dx, dy, dz] = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
          x[k] = -so * dx + co * dy;
          y[k] = -sl * co * dx - sl * so * dy + cl * dz;
          z[k] = cl * co * dx + cl * so * dy + sl * dz;
        }
      }
    }
    const time = c.hasTime ? Float64Array.from(c.time, (t) => t + c.t0) : null;
    const bytes = await writeBpf(c, { x, y, z, coordType, coordId, compression, interleave, time });
    const name = `${c.name.replace(/\.(las|laz|bpf|txt|xyz|pts|csv)$/i, '')}_export.bpf`;
    return { bytes, name, coordType, coordId, enuOrigin: coordType === 3 ? { lat: c.origin.lat0, lon: c.origin.lon0, h: 0 } : null };
  }

  /** A LAS/LAZ cloud read whole from a file it still holds (not a clip or a stream): Assign CRS can read it again. */
  const rereadable = (c) => !!(c?.info && c.order && c.file instanceof Blob && /\.la[sz]$/i.test(c.file.name));
  /**
   * Assign a CRS to a cloud (REQ-LDR-13, REQ-LDR-14, REQ-FMT-47): it is placed again from its file
   * coordinates — BPF from the coordinates kept at open, LAS and LAZ by reading the file again with
   * the CRS in place of the file's own. The new cloud replaces the old one in the panel.
   */
  async function assignCrs(c, { epsg, vertical = 'hae', p = pane() } = {}) {
    if (!c.src && !rereadable(c)) throw new Error('Assign CRS places BPF clouds opened in a local frame and LAS or LAZ clouds read from a file; this cloud is neither');
    if (!(epsg > 0)) throw new Error('give the EPSG code of the coordinates');
    await app.proj?.prepare?.([epsg]);
    const next = c.src ? await cloudFromXyz(c.src, { epsg, vertical, ...geoOpts() }) : await app.activity.track(t('Reading {file}…', { file: c.file.name }), (job) => readLas(c.file, { ...geoOpts(), assign: { epsg, vertical }, onProgress: (f) => job.set(f) }));
    Object.assign(next, { id: newId('pc'), file: c.file, ...(c.src ? { src: c.src } : {}) });
    next.class0 = next.class.slice();
    app.pointClouds.set(next.id, next);
    app.pointClouds.delete(c.id); // the old placement is not offered to other tools (obstruction, TIN sources)
    S.transact(t('Assign CRS to point cloud'), (tx) => tx.create('pointcloud', { pcId: next.id, name: next.name, points: next.n, crs: next.crs.label, vertical: next.crs.vertical, assigned: { epsg, vertical }, pane: p?.id ?? null, derivedFrom: c.id }), { kind: 'edit' });
    app.importLog.push({ file: c.name, errors: [], warnings: [t('CRS assigned: {crs}', { crs: next.crs.label }), ...next.crs.warnings] });
    if (p?.view3d) p.view3d.removeCloud(c);
    await show(next, p);
    return next;
  }

  C.implement('pc.stream', {
    run: async () => {
      const url = h('input', { class: 'inp', type: 'url', placeholder: t('https://…/cloud.copc.laz  or  https://…/ept.json'), 'aria-label': t('Point cloud URL') });
      if ((await modal({ title: t('Stream Point Cloud'), body: h('div', {}, field(t('COPC or EPT URL'), url), h('p', { class: 'hint' }, t('The origin must be in this file’s network allow-list. COPC needs HTTP Range support (and Content-Range exposed to CORS).'))), buttons: OK_CANCEL(), id: 'pc-stream' })) !== 'ok') return;
      const u = url.value.trim();
      // A missing or partial address is a step to take, not a failure (GUI-053).
      if (!/^https?:\/\/[^\s/]+/i.test(u)) return app.toast(t('Stream Point Cloud: enter a COPC or EPT address (https://…) first'), { kind: 'warn' });
      try {
        await (/ept\.json(\?|$)/i.test(u) ? streamEpt(u) : streamCopc(u));
      } catch (e) {
        app.toast(msgOf(e), { kind: 'error', ms: 9000 });
      }
    },
  });
  /**
   * DSM of Difference (REQ-LDR-11): DSMs of two clouds on `cell` posts, later minus earlier, as a
   * layer with statistics; |Δ| ≥ `threshold` counts as change.
   */
  async function dod(earlier, later, { cell = 1, threshold = 1, p = pane2d() } = {}) {
    const a = await generate(earlier, 'dsm', { cell, p });
    const b = await generate(later, 'dsm', { cell, p });
    const ea = app.terrain.entry(a.layer.id);
    const eb = app.terrain.entry(b.layer.id);
    const d = app.terrainAnalysis.demDifference(eb, ea, {});
    const g = eb.grid;
    let up = 0;
    let down = 0;
    let n = 0;
    for (const v of d.diff)
      if (Number.isFinite(v)) {
        n++;
        if (v >= threshold) up++;
        else if (v <= -threshold) down++;
      }
    const cellM = cell * cell;
    const bytes = await writeGeoTiff({ width: g.width, height: g.height, bands: 1, type: 'f32', data: d.diff }, { epsg: 4326, geotransform: [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], nodata: NaN, description: `GIS Workbench DSM of Difference: ${later.name} − ${earlier.name}, ${cell} m posts (m)`, overviews: true });
    const { layers } = await openImageFile(app, new File([bytes], `DoD_${later.name.replace(/\.\w+$/, '')}_minus_${earlier.name.replace(/\.\w+$/, '')}.tif`, { type: 'image/tiff' }), { pane: p });
    return { layer: layers[0], diff: d.diff, grid: g, stats: { ...d.stats, posts: n, raised: up, lowered: down, raisedM2: up * cellM, loweredM2: down * cellM, threshold } };
  }

  /** Buildings and trees from points (REQ-LDR-11): DSM and DTM from the cloud, then the DSM extractor. */
  async function extractFromPoints(c, { cell = defaultCell(c, 0.5) } = {}) {
    const dsm = await generate(c, 'dsm', { cell });
    const dtm = await generate(c, 'dtm', { cell });
    return app.extractR2.buildingsFromDsm({ dsm: app.terrain.entry(dsm.layer.id), dtm: app.terrain.entry(dtm.layer.id) });
  }

  app.pc = { open, show, dod, extractFromPoints, close, view, cloudOf, stream, streamCopc, streamEpt, headerRows, groundFilter, makeGrid, generate, profile, measure, reclassPolygon, recordClasses, clip, colourise, exportLas, exportTiles, exportBpf, assignCrs, heightAboveGround, toGeo, toLocal, gridFor, syncEdits, edits: (c) => S.all('pcedit').filter((o) => o.pc === c.id).sort((a, b) => a.seq - b.seq) };

  // ---- hover read-out ----
  app.pointCloudHover = (v, p) => {
    const c = p.cloud;
    const g = toGeo(c, ...p.pos);
    const r = c.ret[p.index];
    // The position stays in decimal degrees (REQ-L10N-07); heights follow Preferences ▸ Units.
    const facts = { pos: `${g.lat.toFixed(7)}, ${g.lon.toFixed(7)}`, h: height(g.hae, 2), cls: c.class[p.index], name: CLASSES[c.class[p.index]]?.[0] ? tr(CLASSES[c.class[p.index]][0]) : '', i: c.intensity[p.index], ret: r & 15, of: r >> 4 };
    const msg = c.hag ? t('{pos} · {h} HAE · class {cls} {name} · I {i} · return {ret}/{of} · {hag} above ground', { ...facts, hag: height(c.hag[p.index], 2) }) : t('{pos} · {h} HAE · class {cls} {name} · I {i} · return {ret}/{of}', facts);
    if (v.pane.readout) v.pane.readout.textContent = msg;
    app.emit('pc-hover', { pane: v.pane, ...p, geo: g, text: msg });
  };

  // ---- commands ----
  const has = () => !!cloudOf();
  const run = (fn) => async () => {
    const c = cloudOf();
    if (!c) return app.toast(t('Open a point cloud first (File ▸ Open Point Cloud)'), { kind: 'warn' });
    try {
      await fn(c, view());
    } catch (e) {
      app.toast(msgOf(e), { kind: 'error', ms: 8000 });
    }
  };
  C.implement('file.openpointcloud', { run: async () => app.openPointClouds(await pickFiles(app, { accept: ['.las', '.laz', '.bpf', '.xyz', '.pts', '.txt', '.csv'], description: t('Point clouds (LAS, LAZ, BPF, ASCII)') })) });
  C.implement('pc.dod', {
    enabled: () => app.pointClouds.size >= 2,
    run: async () => {
      const list = [...app.pointClouds.values()];
      const sel = (label, k) => h('select', { class: 'inp', 'aria-label': label }, list.map((c, i) => h('option', { value: c.id, selected: i === k }, c.name)));
      const a = sel(t('Earlier cloud'), 0);
      const b = sel(t('Later cloud'), 1);
      const cell = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: '1', 'aria-label': t('Post spacing') });
      const thr = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: '1', 'aria-label': t('Change threshold') });
      if ((await modal({ title: t('DSM of Difference'), body: h('div', {}, field(t('Earlier'), a), field(t('Later'), b), field(t('Posts (m)'), cell), field(t('Change threshold (m)'), thr)), buttons: OK_CANCEL(), id: 'pc-dod' })) !== 'ok') return;
      try {
        const r = await dod(app.pointClouds.get(a.value), app.pointClouds.get(b.value), { cell: Number(cell.value) || 1, threshold: Number(thr.value) || 1 });
        app.toast(t('DoD: {raised} raised, {lowered} lowered (|Δ| ≥ {th})', { raised: area(r.stats.raisedM2), lowered: area(r.stats.loweredM2), th: length(r.stats.threshold) }), { kind: 'info' });
      } catch (e) {
        app.toast(t('DoD: {msg}', { msg: msgOf(e) }), { kind: 'error' });
      }
    },
  });
  C.implement('pc.extract', {
    enabled: () => !!cloudOf(),
    run: async () => {
      try {
        const r = await extractFromPoints(cloudOf());
        app.toast(t('From points: {b, plural, one {# building} other {# buildings}}, {tr, plural, one {# tree} other {# trees}}', { b: r.buildings, tr: r.trees }), { kind: 'info' });
      } catch (e) {
        app.toast(t('Extraction: {msg}', { msg: msgOf(e) }), { kind: 'error' });
      }
    },
  });
  C.implement('pc.close', { enabled: () => !!view(), run: () => close() });
  C.implement('pc.header', {
    enabled: has,
    run: run(async (c) => {
      const rows = headerRows(c);
      const tbl = h('table', { class: 'tbl' }, rows.map(([k, v]) => h('tr', {}, h('th', {}, tr(k)), h('td', {}, v))));
      const classes = h('table', { class: 'tbl' }, [h('tr', {}, h('th', {}, t('Class')), h('th', {}, t('Name')), h('th', {}, t('Points'))), ...Object.entries(c.stats.classes).map(([k, n]) => h('tr', {}, h('td', {}, k), h('td', {}, className(k)), h('td', {}, int(n))))]);
      const vlrs = h('table', { class: 'tbl' }, [h('tr', {}, h('th', {}, t('User ID')), h('th', {}, tc('VLR record id', 'Record')), h('th', {}, t('Bytes')), h('th', {}, t('Description'))), ...[...(c.info.vlrs ?? []), ...(c.info.evlrs ?? [])].map((v) => h('tr', {}, h('td', {}, v.user), h('td', {}, String(v.id)), h('td', {}, String(v.len)), h('td', {}, v.desc)))]);
      const body = h('div', { class: 'pc-header' }, section(t('Header'), tbl), section(t('Classes'), classes), section(t('Variable-length records'), vlrs), c.crs.warnings.length ? h('p', { class: 'hint' }, c.crs.warnings.join(' ')) : null);
      await modal({ title: t('Point Cloud Header — {cloud}', { cloud: c.name }), body, buttons: CLOSE(), width: 640, id: 'pc-header' });
    }),
  });
  for (const m of COLOUR_MODES)
    C.implement(`pc.colour.${m}`, {
      enabled: () => has() && (m !== 'rgb' || !!cloudOf()?.rgb) && (m !== 'hag' || !!cloudOf()?.hag),
      checked: () => view()?.settings.colour === m,
      run: run((c, v) => v.setColour(m)),
    });
  C.implement('pc.classes', {
    enabled: has,
    run: run(async (c, v) => {
      const rows = Object.keys(c.stats.classes).map((k) => {
        const cb = h('input', { type: 'checkbox', 'aria-label': t('Show class {k}', { k }) });
        cb.checked = v.classVisible[k];
        cb.addEventListener('change', () => v.setClassVisible(+k, cb.checked));
        const col = h('input', { type: 'color', value: v.palette[k] ?? '#b0b0b0', 'aria-label': t('Colour of class {k}', { k }) });
        col.addEventListener('input', () => v.setPaletteColour(+k, col.value));
        return h('tr', {}, h('td', {}, cb), h('td', {}, col), h('td', {}, `${k} ${className(k)}`), h('td', {}, int(c.stats.classes[k])));
      });
      await modal({ title: t('Class Visibility and Palette'), body: h('table', { class: 'tbl' }, rows), buttons: CLOSE(), modeless: true, id: 'pc-classes' });
    }),
  });
  C.implement('pc.budget', {
    enabled: has,
    run: run(async (c, v) => {
      const inp = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', max: '30', step: '0.1', value: String(v.settings.budget / 1e6), 'aria-label': t('Point budget in millions') });
      const size = h('input', { class: 'inp inp-num', type: 'number', min: '0.2', max: '6', step: '0.1', value: String(v.settings.size), 'aria-label': t('Point size factor') });
      if ((await modal({ title: t('Point Budget'), body: h('div', {}, field(t('Points drawn (millions)'), inp, t('Default 3 M (REQ-LDR-04)')), field(t('Point size (× spacing)'), size)), buttons: OK_CANCEL(), id: 'pc-budget' })) !== 'ok') return;
      v.settings.budget = Math.round(Math.max(0.1, +inp.value || 3) * 1e6);
      v.settings.size = Math.max(0.2, +size.value || 1.4);
      v.invalidate();
    }),
  });
  C.implement('pc.edl', { enabled: has, checked: () => !!view()?.settings.edl, run: run((c, v) => ((v.settings.edl = !v.settings.edl), v.invalidate())) });
  C.implement('pc.fit', { enabled: has, run: run((c, v) => v.fit()) });
  C.implement('pc.shave', {
    enabled: has,
    run: run(async (c, v) => {
      const s = v.settings.shave;
      const mode = h('select', { class: 'inp' }, [['0', N_('Off')], ['1', N_('Keep points below the level')], ['2', N_('Keep points above the level')]].map(([val, text]) => h('option', { value: val }, tr(text))));
      mode.value = String(s.mode);
      const against = h('select', { class: 'inp' }, [['plane', N_('A horizontal plane (height, m HAE)')], ['ground', N_('The ground (height above the DTM, m)')]].map(([val, text]) => h('option', { value: val, disabled: val === 'ground' && !c.hag }, tr(text))));
      against.value = s.against;
      const level = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: String(s.mode ? s.level : Math.round((c.stats.min[2] + c.stats.max[2]) / 2)), 'aria-label': t('Shaving level') });
      if ((await modal({ title: t('Elevation Shaving'), body: h('div', {}, field(t('Shaving'), mode), field(t('Against'), against, c.hag ? '' : t('Generate a DTM first to shave against the ground')), field(t('Level (m)'), level)), buttons: OK_CANCEL(), id: 'pc-shave' })) !== 'ok') return;
      v.setShave(+mode.value, +level.value, against.value);
    }),
  });
  C.implement('pc.groundfilter', {
    enabled: has,
    run: run(async (c) => {
      const numIn = (v, lbl, step = 'any') => h('input', { class: 'inp inp-num', type: 'number', step, value: String(v), 'aria-label': lbl });
      // Each input is named as its field reads (it was the parameter key: "cell", "lowNoise").
      const lbl = { cell: t('Cell size (m)'), slope: t('Slope (rise/run)'), window: t('Largest window (m)'), threshold: t('Elevation threshold (m)'), scalar: t('Elevation scaling'), lowNoise: t('Low-noise depth (m, 0 = off)') };
      const f = Object.fromEntries(Object.entries(SMRF_DEFAULTS).map(([k, v]) => [k, numIn(v, lbl[k] ?? k)]));
      // A sparse cloud gets a cell near its point spacing, and a window of at least four cells.
      const cell0 = defaultCell(c, SMRF_DEFAULTS.cell);
      f.cell.value = String(cell0);
      f.window.value = String(Math.max(SMRF_DEFAULTS.window, 4 * cell0));
      const body = h('div', {}, field(lbl.cell, f.cell), field(lbl.slope, f.slope), field(lbl.window, f.window), field(lbl.threshold, f.threshold), field(lbl.scalar, f.scalar), field(lbl.lowNoise, f.lowNoise), h('p', { class: 'hint' }, t('SMRF (Pingel et al. 2013). Ground becomes class 2; former ground that fails becomes 1; low outliers become 7. Undo restores the previous classes.')));
      if ((await modal({ title: t('Ground Filter (SMRF)'), body, buttons: OK_CANCEL(), id: 'pc-smrf' })) !== 'ok') return;
      const r = await groundFilter(c, Object.fromEntries(Object.entries(f).map(([k, el]) => [k, +el.value])));
      app.toast(t('Ground filter: {changed} points changed, {ground} ground, {ms} ms', { changed: int(r.changed), ground: int(r.ground), ms: r.ms }), { kind: 'info' });
    }),
  });
  for (const kind of ['dsm', 'dtm', 'ndsm', 'intensity', 'density'])
    C.implement(`pc.${kind}`, {
      enabled: has,
      run: run(async (c) => {
        const cell = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', step: 'any', value: String(defaultCell(c, 1)), 'aria-label': t('Post spacing in metres') });
        if ((await modal({ title: t('Generate {product}', { product: tr(LABEL[kind]) }), body: field(t('Post spacing (m)'), cell, kind === 'dtm' ? t('From class 2 (ground) points; run the ground filter first if the file is not classified.') : ''), buttons: OK_CANCEL(), id: `pc-${kind}` })) !== 'ok') return;
        const r = await generate(c, kind, { cell: Math.max(0.05, +cell.value || 1) });
        app.toast(t('{product} {w} × {h} posts opened as {file}', { product: tr(LABEL[kind]), w: int(r.grid.w), h: int(r.grid.h), file: r.file.name }), { kind: 'info' });
      }),
    });
  C.implement('pc.export', {
    enabled: has,
    run: run(async (c) => {
      const fmt = h('select', { class: 'inp', 'aria-label': t('Format') }, [['las', 'LAS 1.4'], ['laz', N_('LAZ (LAS 1.4, compressed)')], ['bpf', 'BPF v3'], ['3dtiles', N_('3D Tiles: pnts implicit octree (ZIP folder)')], ['3tz', N_('3D Tiles: pnts implicit octree (.3tz)')]].map(([v, text]) => h('option', { value: v }, tr(text))));
      const hz = h('select', { class: 'inp', 'aria-label': t('Heights') }, [['hae', N_('Ellipsoidal (WGS 84)')], ['egm96', N_('Orthometric (EGM96)')]].map(([v, text]) => h('option', { value: v }, tr(text))));
      // BPF (REQ-FMT-48): coordinate type and compression; QuickLZ is GPL and is never written.
      const ct = h('select', { class: 'inp', 'aria-label': t('BPF coordinate type') }, [['1', 'UTM (WGS 84)'], ['2', 'TCR (ECEF, WGS 84)'], ['3', t('ENU (about the cloud centre)')], ['0', t('Cartesian ({crs})', { crs: c.crs.label })]].map(([v, text]) => h('option', { value: v, selected: c.crs.local ? v === '0' : v === '1' }, text)));
      const cz = h('select', { class: 'inp', 'aria-label': t('BPF compression') }, [['zlib', 'zlib'], ['fastlz', 'FastLZ'], ['none', t('None')]].map(([v, text]) => h('option', { value: v }, text)));
      const bpfRow = h('div', { hidden: true }, field(t('Coordinate type'), ct, t('Every attribute is written as a BPF dimension; heights are ellipsoidal')), field(t('Compression'), cz));
      const lasRow = field(t('Heights'), hz);
      fmt.addEventListener('change', () => {
        bpfRow.hidden = fmt.value !== 'bpf';
        lasRow.hidden = fmt.value !== 'las' && fmt.value !== 'laz';
      });
      if ((await modal({ title: t('Export Point Cloud'), body: h('div', {}, field(t('Format'), fmt, t('LAS/LAZ: point format {fmt}, WGS 84 / UTM; classes as edited. 3D Tiles: ECEF (heights above the ellipsoid), colour, class and intensity per point.', { fmt: c.rgb ? 7 : 6 })), lasRow, bpfRow), buttons: OK_CANCEL(), id: 'pc-export' })) !== 'ok') return;
      if (fmt.value === '3dtiles' || fmt.value === '3tz') {
        const t3 = exportTiles(c, { archive: fmt.value === '3tz' });
        await saveBlob(app, new Blob([t3.bytes], { type: 'application/zip' }), { name: t3.name, types: [`.${t3.name.split('.').pop()}`], description: t('3D Tiles point cloud') });
        app.toast(t('3D Tiles: {n} points in {tiles, plural, one {# tile} other {# tiles}}, {levels, plural, one {# level} other {# levels}}, {subtrees, plural, one {# subtree} other {# subtrees}}', { n: int(t3.stats.points), tiles: t3.stats.tiles, levels: t3.stats.levels, subtrees: t3.stats.subtrees }), { kind: 'info' });
        return;
      }
      const r = fmt.value === 'bpf' ? await exportBpf(c, { coordType: Number(ct.value), compression: cz.value }) : await exportLas(c, { compress: fmt.value === 'laz', heights: hz.value });
      await saveBlob(app, new Blob([r.bytes], { type: 'application/octet-stream' }), { name: r.name, types: [`.${fmt.value}`], description: t('Point cloud') });
      if (r.enuOrigin) app.toast(t('BPF ENU about {lat}, {lon}, 0 m HAE (BPF has no field for the origin: keep it with the file)', { lat: r.enuOrigin.lat.toFixed(6), lon: r.enuOrigin.lon.toFixed(6) }), { kind: 'info', ms: 9000 });
    }),
  });
  C.implement('pc.assigncrs', {
    enabled: () => !!cloudOf()?.src || rereadable(cloudOf()),
    run: run(async (c) => {
      // A LAS/LAZ cloud with a CRS from its file: changing it is confirmed first (SDP-2.7 §4.7).
      if (!c.src && !c.crs.local && (await modal({ title: t('Change CRS — {cloud}', { cloud: c.name }), body: h('p', {}, t('{cloud} is placed in {crs}, from its file. Read the file again in a CRS you give instead? Class edits made since it was opened are not carried over.', { cloud: c.name, crs: c.crs.label })), buttons: [{ label: t('Change CRS…'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'pc-changecrs' })) !== 'ok') return;
      const epsg = h('input', { class: 'inp inp-num', type: 'number', placeholder: t('e.g. {example}', { example: '32611' }), 'aria-label': t('EPSG code') });
      const vert = h('select', { class: 'inp', 'aria-label': t('Heights') }, h('option', { value: 'hae' }, t('Ellipsoidal (HAE)')), h('option', { value: 'egm96' }, t('EGM96 (MSL)')));
      if ((await modal({ title: t('Assign CRS — {cloud}', { cloud: c.name }), body: h('div', {}, h('p', { class: 'hint' }, t("{crs}: give the CRS the file's coordinates are in.", { crs: c.crs.label })), field(t('Coordinate system (EPSG)'), epsg), field(t('Heights'), vert)), buttons: OK_CANCEL(), id: 'pc-assigncrs' })) !== 'ok') return;
      const next = await assignCrs(c, { epsg: Number(epsg.value), vertical: vert.value });
      app.toast(t('{cloud}: placed in {crs}', { cloud: c.name, crs: next.crs.label }), { kind: 'info' });
    }),
  });
  C.implement('pc.colourise', {
    enabled: () => has() && [...app.layers.values()].some((l) => l.kind === 'image' && l.modelId),
    run: run(async (c) => {
      const imgs = [...app.layers.values()].filter((l) => l.kind === 'image' && l.modelId);
      const sel = h('select', { class: 'inp' }, imgs.map((l) => h('option', { value: l.id }, l.rec.name)));
      if ((await modal({ title: t('Colourise from Image'), body: field(t('Image'), sel, t('RGB from the first three bands (one band: grey), stretched 2–98 %, sampled through the image’s sensor model at each point’s HAE.')), buttons: OK_CANCEL(), id: 'pc-colourise' })) !== 'ok') return;
      const r = await colourise(c, app.layers.get(sel.value));
      view()?.setColour('rgb');
      app.toast(t('Colourised {n} of {total} points', { n: int(r.inside), total: int(c.n) }), { kind: 'info' });
    }),
  });

  // Click tools in the 3D view: profile (two points), measure (two points), reclassify (polygon).
  function clickTool(v, onClick, onMove) {
    let down = null;
    if (!v._escBound) {
      v._escBound = true;
      v.canvas.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && v.tool) {
          v.tool = null;
          v.setOverlay([]);
        }
      });
    }
    v.tool = {
      pointerdown: (e) => (down = { x: e.clientX, y: e.clientY }),
      pointerup: (e) => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        const r = v.canvas.getBoundingClientRect();
        onClick(e.clientX - r.left, e.clientY - r.top, e);
      },
      pointermove: (e) => {
        if (!onMove) return;
        const r = v.canvas.getBoundingClientRect();
        onMove(e.clientX - r.left, e.clientY - r.top);
      },
    };
  }
  C.implement('pc.profile', {
    enabled: has,
    run: run(async (c, v) => {
      const pts = [];
      app.toast(t('Profile: click the start and end on the cloud (Esc to stop)'), { kind: 'info' });
      clickTool(v, async (sx, sy) => {
        const pk = v.pick(sx, sy, 8);
        if (!pk) return;
        pts.push(pk.pos);
        v.setOverlay(pts.map((p) => ({ kind: 'marker', points: [p] })));
        if (pts.length === 2) {
          v.tool = null;
          const pr = await profile(c, pts[0], pts[1], 1);
          openProfileDialog(pr, v);
        }
      });
    }),
  });
  C.implement('pc.measure', {
    enabled: has,
    run: run(async (c, v) => {
      const pts = [];
      app.toast(t('Measure 3D: click two points (Esc to stop)'), { kind: 'info' });
      clickTool(v, (sx, sy) => {
        const pk = v.pick(sx, sy, 8);
        if (!pk) return;
        pts.push(pk.pos);
        if (pts.length === 2) {
          const m = measure(c, pts[0], pts[1]);
          v.setOverlay([{ kind: 'line', points: pts.slice() }, { kind: 'marker', points: pts.slice() }]);
          const dist = { slant: length(m.slant, 2), horizontal: length(m.horizontal, 2), dz: height(m.dz, 2) };
          app.toast(m.hagB != null ? t('3D {slant} · horizontal {horizontal} · Δh {dz} · {hag} above the DTM', { ...dist, hag: height(m.hagB, 2) }) : t('3D {slant} · horizontal {horizontal} · Δh {dz}', dist), { kind: 'info', ms: 10000 });
          app.pc.lastMeasure = m;
          pts.length = 0;
        } else v.setOverlay([{ kind: 'marker', points: pts.slice() }]);
      });
    }),
  });
  C.implement('pc.classedit', {
    enabled: has,
    run: run(async (c, v) => {
      const to = h('select', { class: 'inp' }, Object.entries(CLASSES).map(([k, [n]]) => h('option', { value: k }, `${k} ${tr(n)}`)));
      to.value = '6';
      if ((await modal({ title: t('Edit Classes'), body: field(t('New class for the points inside the polygon'), to, t('Click the polygon vertices on the view; double-click to finish. Only visible classes change.')), buttons: OK_CANCEL(), id: 'pc-classedit' })) !== 'ok') return;
      const poly = [];
      clickTool(v, (sx, sy, e) => {
        poly.push([sx, sy]);
        if (e.detail >= 2 && poly.length >= 3) {
          v.tool = null;
          const r = reclassPolygon(c, v, poly, +to.value);
          app.toast(t('{n} points reclassified to {cls}', { n: int(r.changed), cls: to.value }), { kind: 'info' });
        }
      });
    }),
  });
  C.implement('pc.clip', {
    enabled: has,
    run: run(async (c, v) => {
      const poly = [];
      app.toast(t('Clip: click the polygon on the view (looking down works best); double-click to finish'), { kind: 'info' });
      clickTool(v, async (sx, sy, e) => {
        const pk = v.pick(sx, sy, 12);
        if (pk) poly.push([pk.pos[0], pk.pos[1]]);
        if (e.detail >= 2 && poly.length >= 3) {
          v.tool = null;
          const sub = await clip(c, poly);
          app.toast(t('Clipped: {n} points kept', { n: int(sub.n) }), { kind: 'info' });
        }
      });
    }),
  });

  function openProfileDialog(pr, v) {
    const c = pr.cloud;
    const W = 600;
    const H = 260;
    const cv = h('canvas', { width: String(W), height: String(H), class: 'pc-profile', 'aria-label': t('Profile') });
    const out = h('div', { class: 'hint' }, t('{n} points within {half} of the line; click two points to measure', { n: int(pr.index.length), half: length(pr.half) }));
    const L = Math.hypot(pr.b[0] - pr.a[0], pr.b[1] - pr.a[1]);
    let zmin = Infinity;
    let zmax = -Infinity;
    for (const z of pr.z) {
      zmin = Math.min(zmin, z);
      zmax = Math.max(zmax, z);
    }
    const sx = (t) => 30 + ((W - 40) * t) / L;
    const sy = (z) => H - 20 - ((H - 30) * (z - zmin)) / Math.max(1e-3, zmax - zmin);
    const g = cv.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < pr.index.length; i++) {
      g.fillStyle = v.palette[c.class[pr.index[i]]] ?? '#ccc';
      g.fillRect(sx(pr.along[i]) - 1, sy(pr.z[i]) - 1, 2, 2);
    }
    const picks = [];
    const nearest = (x, y) => {
      let best = -1;
      let bd = 64;
      for (let i = 0; i < pr.index.length; i++) {
        const d = (sx(pr.along[i]) - x) ** 2 + (sy(pr.z[i]) - y) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    };
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      const i = nearest(e.clientX - r.left, e.clientY - r.top);
      if (i < 0) return;
      const k = pr.index[i];
      v.uniforms.uHighlight.value.set(c.pos[3 * k], c.pos[3 * k + 1], c.pos[3 * k + 2], 0.6);
      v.invalidate();
    });
    cv.addEventListener('click', (e) => {
      const r = cv.getBoundingClientRect();
      const i = nearest(e.clientX - r.left, e.clientY - r.top);
      if (i < 0) return;
      picks.push(i);
      if (picks.length === 2) {
        const [a, b] = picks.map((j) => pr.index[j]);
        const m = measure(c, [c.pos[3 * a], c.pos[3 * a + 1], c.pos[3 * a + 2]], [c.pos[3 * b], c.pos[3 * b + 1], c.pos[3 * b + 2]]);
        out.textContent = t('Δh {dz} · horizontal {horizontal} · 3D {slant}', { dz: height(m.dz, 3), horizontal: length(m.horizontal, 3), slant: length(m.slant, 3) });
        picks.length = 0;
      }
    });
    app.pc.lastProfile = pr;
    modal({ title: t('Profile'), body: h('div', {}, cv, out), buttons: CLOSE(), width: W + 40, modeless: true, id: 'pc-profile' }).then(() => {
      v.uniforms.uHighlight.value.set(0, 0, 0, 0);
      v.setOverlay([]);
    });
    v.setOverlay([{ kind: 'line', points: [pr.a, pr.b] }]);
  }
}
