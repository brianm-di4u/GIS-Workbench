// Point clouds (REQ-LDR-01..10, SCN-14): open LAS/LAZ into a 3D panel, the header panel, colour
// modes and class visibility, the point budget and EDL, elevation shaving, profiles with a swath,
// 3D measurement, DSM/DTM/nDSM/intensity/density grids as layers, SMRF ground filtering and
// classification edits (undoable through `pcedit` records), clipping, colourising from an image
// and LAS 1.4 export (LAS or LAZ).

import { readLas, POINTCLOUD_EXT, inverseLattice, statsOf, reorder } from '../formats/las.js';
import { openCopc, openEpt, rangeFile } from '../formats/copc.js';
import { parseBpf, parseAscii, cloudFromXyz } from '../formats/points-io.js';
import { View3D, CLASSES, COLOUR_MODES } from '../render/view3d.js';
import { packColumns } from '../wasm/pointcloud.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { openImageFile } from '../formats/open.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { modal, field, section } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { newId, errorText } from '../core/util.js';

export const name = 'pointcloud';

const NOISE = new Set([7, 18]);
const GRID_MODE = { max: 0, min: 1, mean: 2, plane: 3, value: 4, density: 5 };
export const SMRF_DEFAULTS = { cell: 1, slope: 0.15, window: 18, threshold: 0.5, scalar: 1.25, lowNoise: 2 };

/** Local frame (DN-36) ↔ geographic. */
export const toGeo = (c, e, n, z) => ({ lat: c.origin.lat0 + n / c.origin.ky, lon: c.origin.lon0 + e / c.origin.kx, hae: z });
export const toLocal = (c, lat, lon) => [(lon - c.origin.lon0) * c.origin.kx, (lat - c.origin.lat0) * c.origin.ky];

/** Rows for the header panel (AT-14.2). */
export function headerRows(c) {
  const i = c.info;
  const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : String(v));
  return [
    ['File', c.name],
    ['LAS version', i.version],
    ['Point data record format', `${i.format}${i.compressed ? ' (LAZ)' : ''}`],
    ['Record length', `${i.recordLen} B (${i.recordLen - i.baseSize} extra)`],
    ['Points', String(i.nPoints)],
    ['Points by return', i.byReturn.filter((v, k) => v || k < 5).join(', ')],
    ['File source ID', String(i.fileSourceId)],
    ['Global encoding', `${i.globalEncoding} (${i.globalEncoding & 1 ? 'adjusted standard GPS time' : 'GPS week time'}${i.globalEncoding & 16 ? ', WKT' : ''})`],
    ['System identifier', i.systemId],
    ['Generating software', i.software],
    ['Creation day/year', `${i.day}/${i.year}`],
    ['Header size', `${i.headerSize} B`],
    ['Offset to point data', `${i.pointOffset} B`],
    ['VLRs / EVLRs', `${i.nVlrs} / ${i.nEvlrs}`],
    ['Scale', i.scale.map((v) => String(v)).join(', ')],
    ['Offset', i.offset.map((v) => f(v)).join(', ')],
    ['Min X, Y, Z', i.min.map((v) => f(v)).join(', ')],
    ['Max X, Y, Z', i.max.map((v) => f(v)).join(', ')],
    ['Horizontal CRS', c.crs.label],
    ['Vertical', `${c.crs.vname || c.crs.vertical} (${c.crs.vertical === 'hae' || c.crs.vertical === 'unstated' ? 'used as HAE' : 'converted to HAE'}); unit ${c.crs.vUnit} m`],
    ['Horizontal unit', `${c.crs.hUnit} m`],
    ...(i.laz ? [['LAZ', `${i.laz.variable ? 'variable' : `${i.laz.chunkSize}-point`} chunks; ${i.laz.items.join(', ')}`]] : []),
    ['COPC', i.copc ? 'yes (read as LAZ)' : 'no'],
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

  /** BPF (REQ-LDR-11): UTM coordinates from the header, heights taken as HAE. */
  const readBpf = async (file) => {
    const src = await parseBpf(file);
    return cloudFromXyz({ ...src, size: file.size }, { epsg: src.epsg, ...geoOpts() });
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
      const cx = inp(by('x', 'easting', 'lon', 'longitude') ?? '0', 'X column');
      const cy = inp(by('y', 'northing', 'lat', 'latitude') ?? '1', 'Y column');
      const cz = inp(by('z', 'elevation', 'height', 'alt') ?? '2', 'Z column');
      const ci = inp(by('intensity', 'i') ?? '', 'Intensity column');
      const cc = inp(by('classification', 'class') ?? '', 'Class column');
      const skip = inp(/[a-df-z]/i.test(first) ? '1' : '0', 'Header lines');
      // Longitude/latitude is proposed when the first data row (not a header or a .pts point count)
      // has X and Y in range in the proposed columns.
      const row = lines.map(split).find((t) => t.length >= 3 && t.every((v) => v === '' || Number.isFinite(Number(v.replace(/^"|"$/g, ''))))) ?? [];
      const geo = Math.abs(Number(row[Number(cx.value)])) <= 180 && Math.abs(Number(row[Number(cy.value)])) <= 90;
      const epsg = h('input', { class: 'inp inp-num', type: 'number', value: geo ? '4326' : '', placeholder: 'e.g. 32611', 'aria-label': 'EPSG code' });
      const vert = h('select', { class: 'inp', 'aria-label': 'Heights' }, h('option', { value: 'hae' }, 'Ellipsoidal (HAE)'), h('option', { value: 'egm96' }, 'EGM96 (MSL)'));
      const body = h('div', {}, h('p', { class: 'hint mono' }, first.slice(0, 120)), field('X, Y, Z columns (0 = first)', h('span', { class: 'btn-row' }, cx, cy, cz)), field('Intensity, class columns (blank = none)', h('span', { class: 'btn-row' }, ci, cc)), field('Header lines to skip', skip), field('Coordinate system (EPSG)', epsg), field('Heights', vert));
      // Automation and tests (like zipPick): 'default' takes the proposed columns without the dialog;
      // an object ({epsg, vertical}) also sets those fields.
      const auto = app.asciiPick === 'default' || (app.asciiPick && typeof app.asciiPick === 'object');
      if (app.asciiPick?.epsg) epsg.value = String(app.asciiPick.epsg);
      if (app.asciiPick?.vertical) vert.value = app.asciiPick.vertical;
      if (!auto && (await modal({ title: `ASCII Points — ${file.name}`, body, id: 'pc-ascii' })) !== 'OK') return null;
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
    const cloud = /\.bpf$/i.test(file.name) ? await readBpf(file) : /\.(xyz|pts|txt|csv)$/i.test(file.name) ? await readAscii(file, ascii) : await readLas(file, geoOpts());
    if (!cloud) return null;
    cloud.id = newId('pc');
    cloud.file = file;
    cloud.class0 = cloud.class.slice();
    app.pointClouds.set(cloud.id, cloud);
    S.transact('Open point cloud', (tx) => tx.create('pointcloud', { pcId: cloud.id, name: cloud.name, points: cloud.n, crs: cloud.crs.label, vertical: cloud.crs.vertical, pane: p?.id ?? null }), { kind: 'load' });
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
    S.transact('Stream point cloud', (tx) => tx.create('pointcloud', { name: src.name, points: src.total, crs: src.crs.label, vertical: src.crs.vertical, pane: p.id, streamed: src.kind, url: src.url ?? src.file?.url ?? null }), { kind: 'load' });
    app.importLog.push({ file: src.name, errors: [], warnings: [`${src.kind}: streamed by node (${src.total.toLocaleString()} points in the octree)`, ...(src.crs.warnings ?? [])] });
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
          app.toast(`Streaming ${f.name} by range (${e.stream.total.toLocaleString()} points)`);
          continue;
        }
        const c = await open(f, p);
        if (!c) continue;
        out.push(c);
        app.toast(`Opened ${f.name}: ${c.n.toLocaleString()} points in ${c.ms.total} ms${c.crs.warnings.length ? ` (${c.crs.warnings.length} note${c.crs.warnings.length > 1 ? 's' : ''} in the import log)` : ''}`);
      } catch (e) {
        app.log('warn', `${f.name}: ${e.message}`);
        app.toast(`${f.name}: ${errorText(e)}`, { kind: 'error', ms: 8000 });
        app.importLog.push({ file: f.name, errors: [errorText(e)], warnings: [] });
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
    for (const f of extra) app.importLog.push({ file: f.name, errors: [], warnings: [`${f.name}: kept with its point cloud (not read)`] });
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
    S.transact(label, (tx) => (id = tx.create('pcedit', { pc: c.id, seq, label, params, changed: idx.length, created: new Date().toISOString(), analyst: app.prefs.get('analyst') ?? 'analyst' })));
    diffs.set(id, { index, value });
    sigs.delete(c.id);
    syncEdits();
    return { id, changed: idx.length };
  }

  // ---- worker jobs ----
  const job = (op, args, transfer = []) => app.pool.run(op, args, { kind: 'pointcloud', transfer, label: `${op} point cloud`, timeout: 600000 });
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
    const r = recordClasses(c, next, 'Ground filter (SMRF)', p);
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
    if (w * hh > MAX_POSTS) throw new Error(`${w.toLocaleString()} × ${hh.toLocaleString()} posts at ${cell} m is too many for the browser; use ${defaultCell(c, cell * Math.sqrt((w * hh) / MAX_POSTS))} m or more`);
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
      if (!mask.includes(1)) throw new Error(`${c.name} has no ground-classified points (class 2): run Classify ▸ Ground Filter first`);
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
    throw new Error(`unknown grid kind ${kind}`);
  }

  const LABEL = { dsm: 'DSM', dtm: 'DTM', ndsm: 'nDSM', intensity: 'Intensity', density: 'Density' };
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
    if (!p || !app.store.get(p.id)) throw new Error(`the panel the ${LABEL[kind]} was made for has been closed`);
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
    const sub = { ...c, id: newId('pc'), name: `${c.name} (clipped)`, dtm: null, hag: null, order: null };
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
    S.transact('Clip point cloud', (tx) => tx.create('pointcloud', { pcId: sub.id, name: sub.name, points: sub.n, crs: sub.crs.label, vertical: sub.crs.vertical, pane: p?.id ?? null, derivedFrom: c.id }), { kind: 'edit' });
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

  C.implement('pc.stream', {
    run: async () => {
      const url = h('input', { class: 'inp', type: 'url', placeholder: 'https://…/cloud.copc.laz  or  https://…/ept.json', 'aria-label': 'Point cloud URL' });
      if ((await modal({ title: 'Stream Point Cloud', body: h('div', {}, field('COPC or EPT URL', url), h('p', { class: 'hint' }, 'The origin must be in this file’s network allow-list. COPC needs HTTP Range support (and Content-Range exposed to CORS).')), id: 'pc-stream' })) !== 'OK') return;
      const u = url.value.trim();
      // A missing or partial address is a step to take, not a failure (GUI-053).
      if (!/^https?:\/\/[^\s/]+/i.test(u)) return app.toast('Stream Point Cloud: enter a COPC or EPT address (https://…) first', { kind: 'warn' });
      try {
        await (/ept\.json(\?|$)/i.test(u) ? streamEpt(u) : streamCopc(u));
      } catch (e) {
        app.toast(e.message, { kind: 'error', ms: 9000 });
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

  app.pc = { open, show, dod, extractFromPoints, close, view, cloudOf, stream, streamCopc, streamEpt, headerRows, groundFilter, makeGrid, generate, profile, measure, reclassPolygon, recordClasses, clip, colourise, exportLas, heightAboveGround, toGeo, toLocal, gridFor, syncEdits, edits: (c) => S.all('pcedit').filter((o) => o.pc === c.id).sort((a, b) => a.seq - b.seq) };

  // ---- hover read-out ----
  app.pointCloudHover = (v, p) => {
    const c = p.cloud;
    const g = toGeo(c, ...p.pos);
    const r = c.ret[p.index];
    const msg = `${g.lat.toFixed(7)}, ${g.lon.toFixed(7)} · ${g.hae.toFixed(2)} m HAE · class ${c.class[p.index]} ${CLASSES[c.class[p.index]]?.[0] ?? ''} · I ${c.intensity[p.index]} · return ${r & 15}/${r >> 4}${c.hag ? ` · ${c.hag[p.index].toFixed(2)} m above ground` : ''}`;
    if (v.pane.readout) v.pane.readout.textContent = msg;
    app.emit('pc-hover', { pane: v.pane, ...p, geo: g, text: msg });
  };

  // ---- commands ----
  const has = () => !!cloudOf();
  const run = (fn) => async () => {
    const c = cloudOf();
    if (!c) return app.toast('Open a point cloud first (File ▸ Open Point Cloud)', { kind: 'warn' });
    try {
      await fn(c, view());
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };
  C.implement('file.openpointcloud', { run: async () => app.openPointClouds(await pickFiles(app, { accept: ['.las', '.laz', '.bpf', '.xyz', '.pts', '.txt', '.csv'], description: 'Point clouds (LAS, LAZ, BPF, ASCII)' })) });
  C.implement('pc.dod', {
    enabled: () => app.pointClouds.size >= 2,
    run: async () => {
      const list = [...app.pointClouds.values()];
      const sel = (label, k) => h('select', { class: 'inp', 'aria-label': label }, list.map((c, i) => h('option', { value: c.id, selected: i === k }, c.name)));
      const a = sel('Earlier cloud', 0);
      const b = sel('Later cloud', 1);
      const cell = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: '1', 'aria-label': 'Post spacing' });
      const thr = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: '1', 'aria-label': 'Change threshold' });
      if ((await modal({ title: 'DSM of Difference', body: h('div', {}, field('Earlier', a), field('Later', b), field('Posts (m)', cell), field('Change threshold (m)', thr)), id: 'pc-dod' })) !== 'OK') return;
      try {
        const r = await dod(app.pointClouds.get(a.value), app.pointClouds.get(b.value), { cell: Number(cell.value) || 1, threshold: Number(thr.value) || 1 });
        app.toast(`DoD: ${r.stats.raisedM2.toFixed(0)} m² raised, ${r.stats.loweredM2.toFixed(0)} m² lowered (|Δ| ≥ ${r.stats.threshold} m)`);
      } catch (e) {
        app.toast(`DoD: ${e.message}`, { kind: 'error' });
      }
    },
  });
  C.implement('pc.extract', {
    enabled: () => !!cloudOf(),
    run: async () => {
      try {
        const r = await extractFromPoints(cloudOf());
        app.toast(`From points: ${r.buildings} building(s), ${r.trees} tree(s)`);
      } catch (e) {
        app.toast(`Extraction: ${e.message}`, { kind: 'error' });
      }
    },
  });
  C.implement('pc.close', { enabled: () => !!view(), run: () => close() });
  C.implement('pc.header', {
    enabled: has,
    run: run(async (c) => {
      const rows = headerRows(c);
      const tbl = h('table', { class: 'tbl' }, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))));
      const classes = h('table', { class: 'tbl' }, [h('tr', {}, h('th', {}, 'Class'), h('th', {}, 'Name'), h('th', {}, 'Points')), ...Object.entries(c.stats.classes).map(([k, n]) => h('tr', {}, h('td', {}, k), h('td', {}, CLASSES[k]?.[0] ?? 'user defined'), h('td', {}, n.toLocaleString())))]);
      const vlrs = h('table', { class: 'tbl' }, [h('tr', {}, h('th', {}, 'User ID'), h('th', {}, 'Record'), h('th', {}, 'Bytes'), h('th', {}, 'Description')), ...[...(c.info.vlrs ?? []), ...(c.info.evlrs ?? [])].map((v) => h('tr', {}, h('td', {}, v.user), h('td', {}, String(v.id)), h('td', {}, String(v.len)), h('td', {}, v.desc)))]);
      const body = h('div', { class: 'pc-header' }, section('Header', tbl), section('Classes', classes), section('Variable-length records', vlrs), c.crs.warnings.length ? h('p', { class: 'hint' }, c.crs.warnings.join(' ')) : null);
      await modal({ title: `Point Cloud Header — ${c.name}`, body, buttons: ['Close'], width: 640, id: 'pc-header' });
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
        const cb = h('input', { type: 'checkbox', 'aria-label': `Show class ${k}` });
        cb.checked = v.classVisible[k];
        cb.addEventListener('change', () => v.setClassVisible(+k, cb.checked));
        const col = h('input', { type: 'color', value: v.palette[k] ?? '#b0b0b0', 'aria-label': `Colour of class ${k}` });
        col.addEventListener('input', () => v.setPaletteColour(+k, col.value));
        return h('tr', {}, h('td', {}, cb), h('td', {}, col), h('td', {}, `${k} ${CLASSES[k]?.[0] ?? 'user defined'}`), h('td', {}, c.stats.classes[k].toLocaleString()));
      });
      await modal({ title: 'Class Visibility and Palette', body: h('table', { class: 'tbl' }, rows), buttons: ['Close'], modeless: true, id: 'pc-classes' });
    }),
  });
  C.implement('pc.budget', {
    enabled: has,
    run: run(async (c, v) => {
      const inp = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', max: '30', step: '0.1', value: String(v.settings.budget / 1e6), 'aria-label': 'Point budget in millions' });
      const size = h('input', { class: 'inp inp-num', type: 'number', min: '0.2', max: '6', step: '0.1', value: String(v.settings.size), 'aria-label': 'Point size factor' });
      if ((await modal({ title: 'Point Budget', body: h('div', {}, field('Points drawn (millions)', inp, 'Default 3 M (REQ-LDR-04)'), field('Point size (× spacing)', size)), id: 'pc-budget' })) !== 'OK') return;
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
      const mode = h('select', { class: 'inp' }, [['0', 'Off'], ['1', 'Keep points below the level'], ['2', 'Keep points above the level']].map(([val, t]) => h('option', { value: val }, t)));
      mode.value = String(s.mode);
      const against = h('select', { class: 'inp' }, [['plane', 'A horizontal plane (height, m HAE)'], ['ground', 'The ground (height above the DTM, m)']].map(([val, t]) => h('option', { value: val, disabled: val === 'ground' && !c.hag }, t)));
      against.value = s.against;
      const level = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: String(s.mode ? s.level : Math.round((c.stats.min[2] + c.stats.max[2]) / 2)), 'aria-label': 'Shaving level' });
      if ((await modal({ title: 'Elevation Shaving', body: h('div', {}, field('Shaving', mode), field('Against', against, c.hag ? '' : 'Generate a DTM first to shave against the ground'), field('Level (m)', level)), id: 'pc-shave' })) !== 'OK') return;
      v.setShave(+mode.value, +level.value, against.value);
    }),
  });
  C.implement('pc.groundfilter', {
    enabled: has,
    run: run(async (c) => {
      const num = (v, lbl, step = 'any') => h('input', { class: 'inp inp-num', type: 'number', step, value: String(v), 'aria-label': lbl });
      const f = Object.fromEntries(Object.entries(SMRF_DEFAULTS).map(([k, v]) => [k, num(v, k)]));
      // A sparse cloud gets a cell near its point spacing, and a window of at least four cells.
      const cell0 = defaultCell(c, SMRF_DEFAULTS.cell);
      f.cell.value = String(cell0);
      f.window.value = String(Math.max(SMRF_DEFAULTS.window, 4 * cell0));
      const body = h('div', {}, field('Cell size (m)', f.cell), field('Slope (rise/run)', f.slope), field('Largest window (m)', f.window), field('Elevation threshold (m)', f.threshold), field('Elevation scaling', f.scalar), field('Low-noise depth (m, 0 = off)', f.lowNoise), h('p', { class: 'hint' }, 'SMRF (Pingel et al. 2013). Ground becomes class 2; former ground that fails becomes 1; low outliers become 7. Undo restores the previous classes.'));
      if ((await modal({ title: 'Ground Filter (SMRF)', body, id: 'pc-smrf' })) !== 'OK') return;
      const r = await groundFilter(c, Object.fromEntries(Object.entries(f).map(([k, el]) => [k, +el.value])));
      app.toast(`Ground filter: ${r.changed.toLocaleString()} points changed, ${r.ground.toLocaleString()} ground, ${r.ms} ms`);
    }),
  });
  for (const kind of ['dsm', 'dtm', 'ndsm', 'intensity', 'density'])
    C.implement(`pc.${kind}`, {
      enabled: has,
      run: run(async (c) => {
        const cell = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', step: 'any', value: String(defaultCell(c, 1)), 'aria-label': 'Post spacing in metres' });
        if ((await modal({ title: `Generate ${LABEL[kind]}`, body: field('Post spacing (m)', cell, kind === 'dtm' ? 'From class 2 (ground) points; run the ground filter first if the file is not classified.' : ''), id: `pc-${kind}` })) !== 'OK') return;
        const r = await generate(c, kind, { cell: Math.max(0.05, +cell.value || 1) });
        app.toast(`${LABEL[kind]} ${r.grid.w} × ${r.grid.h} posts opened as ${r.file.name}`);
      }),
    });
  C.implement('pc.export', {
    enabled: has,
    run: run(async (c) => {
      const fmt = h('select', { class: 'inp' }, [['las', 'LAS 1.4'], ['laz', 'LAZ (LAS 1.4, compressed)']].map(([v, t]) => h('option', { value: v }, t)));
      const hz = h('select', { class: 'inp' }, [['hae', 'Ellipsoidal (WGS 84)'], ['egm96', 'Orthometric (EGM96)']].map(([v, t]) => h('option', { value: v }, t)));
      if ((await modal({ title: 'Export Point Cloud', body: h('div', {}, field('Format', fmt, `Point format ${c.rgb ? 7 : 6}; WGS 84 / UTM; classes as edited`), field('Heights', hz)), id: 'pc-export' })) !== 'OK') return;
      const r = await exportLas(c, { compress: fmt.value === 'laz', heights: hz.value });
      await saveBlob(app, new Blob([r.bytes], { type: 'application/octet-stream' }), { name: r.name, types: [`.${fmt.value}`], description: 'Point cloud' });
    }),
  });
  C.implement('pc.colourise', {
    enabled: () => has() && [...app.layers.values()].some((l) => l.kind === 'image' && l.modelId),
    run: run(async (c) => {
      const imgs = [...app.layers.values()].filter((l) => l.kind === 'image' && l.modelId);
      const sel = h('select', { class: 'inp' }, imgs.map((l) => h('option', { value: l.id }, l.rec.name)));
      if ((await modal({ title: 'Colourise from Image', body: field('Image', sel, 'RGB from the first three bands (one band: grey), stretched 2–98 %, sampled through the image’s sensor model at each point’s HAE.'), id: 'pc-colourise' })) !== 'OK') return;
      const r = await colourise(c, app.layers.get(sel.value));
      view()?.setColour('rgb');
      app.toast(`Colourised ${r.inside.toLocaleString()} of ${c.n.toLocaleString()} points`);
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
      app.toast('Profile: click the start and end on the cloud (Esc to stop)');
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
      app.toast('Measure 3D: click two points (Esc to stop)');
      clickTool(v, (sx, sy) => {
        const pk = v.pick(sx, sy, 8);
        if (!pk) return;
        pts.push(pk.pos);
        if (pts.length === 2) {
          const m = measure(c, pts[0], pts[1]);
          v.setOverlay([{ kind: 'line', points: pts.slice() }, { kind: 'marker', points: pts.slice() }]);
          app.toast(`3D ${m.slant.toFixed(2)} m · horizontal ${m.horizontal.toFixed(2)} m · Δh ${m.dz.toFixed(2)} m${m.hagB != null ? ` · ${m.hagB.toFixed(2)} m above the DTM` : ''}`, { ms: 10000 });
          app.pc.lastMeasure = m;
          pts.length = 0;
        } else v.setOverlay([{ kind: 'marker', points: pts.slice() }]);
      });
    }),
  });
  C.implement('pc.classedit', {
    enabled: has,
    run: run(async (c, v) => {
      const to = h('select', { class: 'inp' }, Object.entries(CLASSES).map(([k, [n]]) => h('option', { value: k }, `${k} ${n}`)));
      to.value = '6';
      if ((await modal({ title: 'Edit Classes', body: field('New class for the points inside the polygon', to, 'Click the polygon vertices on the view; double-click to finish. Only visible classes change.'), id: 'pc-classedit' })) !== 'OK') return;
      const poly = [];
      clickTool(v, (sx, sy, e) => {
        poly.push([sx, sy]);
        if (e.detail >= 2 && poly.length >= 3) {
          v.tool = null;
          const r = reclassPolygon(c, v, poly, +to.value);
          app.toast(`${r.changed.toLocaleString()} points reclassified to ${to.value}`);
        }
      });
    }),
  });
  C.implement('pc.clip', {
    enabled: has,
    run: run(async (c, v) => {
      const poly = [];
      app.toast('Clip: click the polygon on the view (looking down works best); double-click to finish');
      clickTool(v, async (sx, sy, e) => {
        const pk = v.pick(sx, sy, 12);
        if (pk) poly.push([pk.pos[0], pk.pos[1]]);
        if (e.detail >= 2 && poly.length >= 3) {
          v.tool = null;
          const sub = await clip(c, poly);
          app.toast(`Clipped: ${sub.n.toLocaleString()} points kept`);
        }
      });
    }),
  });

  function openProfileDialog(pr, v) {
    const c = pr.cloud;
    const W = 600;
    const H = 260;
    const cv = h('canvas', { width: String(W), height: String(H), class: 'pc-profile', 'aria-label': 'Profile' });
    const out = h('div', { class: 'hint' }, `${pr.index.length.toLocaleString()} points within ${pr.half} m of the line; click two points to measure`);
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
        out.textContent = `Δh ${m.dz.toFixed(3)} m · horizontal ${m.horizontal.toFixed(3)} m · 3D ${m.slant.toFixed(3)} m`;
        picks.length = 0;
      }
    });
    app.pc.lastProfile = pr;
    modal({ title: 'Profile', body: h('div', {}, cv, out), buttons: ['Close'], width: W + 40, modeless: true, id: 'pc-profile' }).then(() => {
      v.uniforms.uHighlight.value.set(0, 0, 0, 0);
      v.setOverlay([]);
    });
    v.setOverlay([{ kind: 'line', points: [pr.a, pr.b] }]);
  }
}
