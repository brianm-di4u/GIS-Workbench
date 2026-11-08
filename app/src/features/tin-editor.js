// TIN layers and their editor (REQ-GAP-39, GR-13; Full; the lazy js-tin block).
//
// A TIN layer is a 'tin' store record: its plane frame, vertical datum, display and source (DEM
// posts thinned to a vertical tolerance, point-cloud ground points, or imported points and lines,
// kept in the record). Each edit is a 'tinedit' record, so undo, redo and project files carry it.
// The analysis worker builds the source with the `tin` WASM bundle and hands the state over; the
// main thread's instance replays the edits (each one local: insertion with Lawson flips,
// constraint flips, ear removal) and answers display queries. Undo reloads the built state and
// replays the remaining edits.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, gwError, msgOf, N_, tr } from '../i18n/index.js';
import { num, int, height, length } from '../i18n/format.js';
import { pointText } from '../i18n/fonts.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { openImageFile } from '../formats/open.js';
import { crsOf, converter } from '../geo/crs.js';
import { readGeoJSON, writeGeoJSON, readShapefile, writeShapefile, shapefileSets } from '../vector/io.js';
import { fromParts } from '../vector/geom.js';
import { unzipSync, zipSync } from 'fflate';
import { TinBundle, KIND_NAME, FILE_KEY0, encodeTinEdits } from '../wasm/tin.js';
import { frameAt, toPlane, toGeo, gridSpec, rasterGrid, importForm, exportForm, fromFeatures, fromTable, writeLandXml, writeCsv, shadeColour, lambertOf } from '../analysis/tin-io.js';

const COLOUR = { hard: '#ff4848', soft: '#4fd2ff', void: '#ff4fff', outer: '#f0f0f0', swap: '#ffd400', drain: '#3f8cff', ridge: '#ff9a2e', outline: '#c8c8c8' };
const DRAW_CAP = 60000;
const HEIGHT_LINES = ['hard', 'ridge', 'drain'];
const USER_KEY0 = 1e6; // line keys below this are the source's lines
const VERTICALS = { egm96: N_('orthometric (MSL, EGM96)'), egm2008: N_('orthometric (MSL, EGM2008)'), navd88: N_('orthometric (NAVD88)'), hae: N_('ellipsoidal (HAE, WGS 84)') };

export function install(app) {
  const S = app.store;
  const C = app.commands;
  const toast = (m, o) => app.toast(m, o);
  const pane = () => app.activePane();

  // ---- the main-thread bundle; a trap loses every handle, so the TINs are reloaded ----
  let B = null;
  const bundle = async () => (B ??= new TinBundle(await app.gw.wasm('wasm-tin')));
  const rts = new Map(); // tin id → {id, state, sig, applied, skipped, version, info, report, buildMs, error, cache}
  const guard = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (e?.trapped) for (const rt of rts.values()) rt.id = 0;
      throw e;
    }
  };

  const tins = () => S.all('tin');
  const recOf = (id) => S.get(id) ?? null;
  const editsOf = (tinId) => S.all('tinedit').filter((e) => e.tin === tinId).sort((a, b) => a.seq - b.seq);
  let activeId = null;
  const active = () => (activeId && recOf(activeId) ? activeId : (tins().at(-1)?.id ?? null));
  const undulation = (lat, lon) => {
    const N = app.core.undulation(lat, lon);
    return Number.isFinite(N) ? N : 0;
  };
  /** A HAE height in the TIN's vertical datum (orthometric datums through EGM96, as DEM edits do). */
  const fromHae = (rec, lat, lon, hae) => (rec.vertical === 'hae' ? hae : hae - undulation(lat, lon));
  const toHae = (rec, lat, lon, z) => (rec.vertical === 'hae' ? z : z + undulation(lat, lon));

  // ---- sources ----
  const sourceSig = (rec) => JSON.stringify([rec.id, rec.source.kind, rec.source.layer, rec.source.pc, rec.source.tolerance, rec.source.maxPoints, rec.source.cell, rec.source.box, rec.source.points?.length, rec.source.lines?.length, rec.source.tris?.length]);

  /** The DEM entry's posts inside an optional box [south, west, north, east] (source posts: DEM edits are not included). */
  function demPosts(d, box) {
    const g = d.grid;
    let [i0, j0, i1, j1] = [0, 0, g.width - 1, g.height - 1];
    if (box) {
      i0 = Math.max(0, Math.floor((box[1] - g.lon0) / g.dlon));
      i1 = Math.min(g.width - 1, Math.ceil((box[3] - g.lon0) / g.dlon));
      j0 = Math.max(0, Math.floor((g.lat0 - box[2]) / g.dlat));
      j1 = Math.min(g.height - 1, Math.ceil((g.lat0 - box[0]) / g.dlat));
    }
    if (i1 < i0 || j1 < j0) throw gwError('the area is outside the DEM', null, 'E_TIN_BOX');
    const w = i1 - i0 + 1;
    const hh = j1 - j0 + 1;
    const z = new Float32Array(w * hh);
    for (let j = 0; j < hh; j++) z.set(g.heights.subarray((j0 + j) * g.width + i0, (j0 + j) * g.width + i0 + w), j * w);
    return { grid: { lat0: g.lat0 - j0 * g.dlat, lon0: g.lon0 + i0 * g.dlon, dlat: g.dlat, dlon: g.dlon, width: w, height: hh }, z };
  }

  async function sourceOf(rec) {
    const s = rec.source;
    if (s.kind === 'dem') {
      const d = app.terrain.entry(s.layer);
      if (!d?.grid) throw gwError('{tin}: its DEM is not loaded as terrain', { tin: rec.name }, 'E_TIN_SOURCE');
      const { grid, z } = demPosts(d, s.box);
      return { kind: 'dem', grid: gridSpec(rec.frame, grid), z, tolerance: s.tolerance, maxPoints: s.maxPoints ?? 3e6 };
    }
    if (s.kind === 'lidar') {
      const c = app.pointClouds?.get(s.pc);
      if (!c) throw gwError('{tin}: its point cloud is not open', { tin: rec.name }, 'E_TIN_SOURCE');
      const classes = new Set(s.classes ?? [2]);
      const [ox, oy] = toPlane(rec.frame, c.origin.lon0, c.origin.lat0);
      const sx = c.origin.kx / rec.frame.kx;
      const sy = c.origin.ky / rec.frame.ky;
      let n = 0;
      for (let k = 0; k < c.n; k++) if (classes.has(c.class[k])) n++;
      const pts = new Float64Array(3 * n);
      let m = 0;
      for (let k = 0; k < c.n; k++) {
        if (!classes.has(c.class[k]) || c.deleted?.[k]) continue; // deleted points (REQ-GAP-81) are not ground
        const x = ox + c.pos[3 * k] * sx;
        const y = oy + c.pos[3 * k + 1] * sy;
        if (s.box && (x < s.box[0] || y < s.box[1] || x > s.box[2] || y > s.box[3])) continue;
        pts[m++] = x;
        pts[m++] = y;
        pts[m++] = c.pos[3 * k + 2];
      }
      if (m < 9) throw gwError('{cloud} has no ground-classified points (class 2): run Classify ▸ Ground Filter first', { cloud: c.name }, 'E_NO_GROUND');
      return { kind: 'points', pts: m === pts.length ? pts : pts.slice(0, m), cell: s.cell ?? 0, maxPoints: s.maxPoints ?? 3e6 };
    }
    const pts = new Float64Array(3 * s.points.length);
    s.points.forEach((p, k) => pts.set(p, 3 * k));
    // A LandXML surface's own faces (OD-2.41): kept as they are, hidden ones excluded.
    if (Array.isArray(s.tris)) {
      const hidden = new Uint8Array(s.tris.length / 3);
      for (const k of s.hidden ?? []) hidden[k] = 1;
      return { kind: 'points', pts, cell: 0, maxPoints: s.maxPoints ?? 3e6, faces: Uint32Array.from(s.tris), hidden };
    }
    return { kind: 'points', pts, cell: 0, maxPoints: s.maxPoints ?? 3e6 };
  }
  const sourceOps = (rec) => encodeTinEdits((rec.source.lines ?? []).map((l, k) => ({ kind: 'addline', params: { key: k + 1, type: l.type, closed: l.closed, pts: l.pts } })));

  async function build(rec, rt) {
    const src = await sourceOf(rec);
    const t0 = performance.now();
    const r = await app.pool.run('tin.build', { src, ops: sourceOps(rec) }, { kind: 'analysis', label: t('TIN {name}', { name: rec.name }), timeout: 900000, transfer: [(src.z ?? src.pts).buffer] });
    const b = await bundle();
    if (rt.id) b.dispose(rt.id);
    const t1 = performance.now();
    rt.id = guard(() => b.load(r.state));
    Object.assign(rt, { state: r.state, report: r.report, kept: r.kept, sourceResults: r.results, buildMs: r.buildMs, opsMs: r.opsMs, loadMs: performance.now() - t1, totalMs: performance.now() - t0, applied: [], skipped: new Map(), error: null });
    const bad = (r.results ?? []).filter((x) => !x.ok).length;
    if (bad) toast(t('{tin}: {n, plural, one {# source line was} other {# source lines were}} not put in (see the TIN Editor)', { tin: rec.name, n: bad }), { kind: 'warn' });
  }

  /** Reload the built state (undo, or after a broken edit) with no edits applied. */
  function reload(rt) {
    if (rt.id) B.dispose(rt.id);
    rt.id = guard(() => B.load(rt.state));
    rt.applied = [];
    rt.skipped = new Map();
  }

  function applyRec(rt, e) {
    const [res] = guard(() => B.apply(rt.id, encodeTinEdits([e])));
    if (!res.ok) {
      rt.skipped.set(e.id, res.msg);
      if (res.broken) {
        // It stopped part way: rebuild from the built state without it.
        const keep = rt.applied.filter((id) => !rt.skipped.has(id));
        const skipped = rt.skipped;
        reload(rt);
        rt.skipped = skipped;
        for (const id of keep) {
          const r = recOf(id);
          if (r) guard(() => B.apply(rt.id, encodeTinEdits([r])));
          rt.applied.push(id);
        }
      }
    }
    rt.applied.push(e.id);
    return res;
  }

  // ---- sync: one at a time ----
  let queue = Promise.resolve();
  const serial = (fn) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  async function syncNow() {
    await bundle();
    const live = new Set(tins().map((r) => r.id));
    for (const [id, rt] of rts)
      if (!live.has(id)) {
        if (rt.id) B.dispose(rt.id);
        rts.delete(id);
      }
    let changed = false;
    for (const rec of tins()) {
      let rt = rts.get(rec.id);
      if (!rt) rts.set(rec.id, (rt = { id: 0, applied: [], skipped: new Map(), version: 0 }));
      const sig = sourceSig(rec);
      if (rt.sig !== sig || !rt.id) {
        if (!rt.state || rt.sig !== sig) {
          try {
            await build(rec, rt);
          } catch (e) {
            rt.error = msgOf(e);
            rt.sig = sig;
            continue;
          }
        } else reload(rt);
        rt.sig = sig;
        changed = true;
      }
      const log = editsOf(rec.id);
      const prefix = rt.applied.length <= log.length && rt.applied.every((id, k) => log[k].id === id);
      if (!prefix) {
        reload(rt);
        changed = true;
      }
      for (const e of log.slice(rt.applied.length)) {
        applyRec(rt, e);
        changed = true;
      }
      if (changed || !rt.info) {
        rt.info = guard(() => B.info(rt.id));
        rt.version++;
        rt.cache = null;
        rt.linesCache = null;
      }
    }
    if (changed) redraw();
  }
  const sync = () => serial(syncNow);
  S.on('change', () => sync().catch((e) => toast(t('TIN: {msg}', { msg: msgOf(e) }), { kind: 'error' })));

  function redraw() {
    for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) p.invalidate?.();
    app.renderer?.invalidate?.();
    app.emit('state');
  }

  // ---- create, edit, remove ----
  /**
   * Make a TIN layer: {from: 'dem', layer, tolerance (m; < 0 every post), maxPoints, box} or
   * {from: 'lidar', pc, classes, cell, maxPoints, box (plane)}; name. Resolves with its id once built.
   */
  async function create(o = {}) {
    let rec;
    if (o.from === 'lidar') {
      const c = app.pointClouds?.get(o.pc ?? [...(app.pointClouds?.keys() ?? [])][0]);
      if (!c) throw gwError('open a point cloud first', null, 'E_TIN_SOURCE');
      rec = { name: o.name ?? t('TIN of {cloud}', { cloud: c.name }), frame: { lat0: c.origin.lat0, lon0: c.origin.lon0, kx: c.origin.kx, ky: c.origin.ky }, vertical: 'hae', source: { kind: 'lidar', pc: c.id, classes: o.classes ?? [2], cell: o.cell ?? 0, maxPoints: o.maxPoints ?? 3e6, box: o.box ?? null } };
    } else {
      const d = (o.layer && app.terrain.entry(o.layer)) || app.demEdit?.target?.() || app.terrain.dems.find((x) => x.grid);
      if (!d?.grid) throw gwError('no DEM to make a TIN from: use a DEM as terrain first', null, 'E_TIN_SOURCE');
      const g = d.grid;
      const latC = g.lat0 - ((g.height - 1) * g.dlat) / 2;
      const lonC = g.lon0 + ((g.width - 1) * g.dlon) / 2;
      rec = { name: o.name ?? t('TIN of {dem}', { dem: app.layers.get(d.layerId)?.rec?.name ?? d.name }), frame: frameAt(latC, lonC), vertical: d.vertical ?? 'egm96', source: { kind: 'dem', layer: d.layerId, tolerance: o.tolerance ?? 0.5, maxPoints: o.maxPoints ?? 3e6, box: o.box ?? null, post: Math.min(g.dlat * frameAt(latC, lonC).ky, g.dlon * frameAt(latC, lonC).kx) } };
    }
    return addRecord(rec);
  }

  async function addRecord(rec) {
    let id;
    S.transact(t('New TIN {name}', { name: rec.name }), (tx) => (id = tx.create('tin', { ...rec, display: rec.display ?? 'wireframe', created: new Date().toISOString(), analyst: app.prefs.get('analyst') ?? 'analyst' })));
    activeId = id;
    await sync();
    const rt = rts.get(id);
    if (rt?.error) throw gwError('{tin}: {msg}', { tin: rec.name, msg: rt.error }, 'E_TIN_BUILD');
    return id;
  }

  // A deleted file line (a forced edge or an outline ring) has its key in an edit too: not the user's.
  const nextKey = (tinId) => Math.max(USER_KEY0 - 1, ...editsOf(tinId).map((e) => e.params?.key ?? 0).filter((k) => k < FILE_KEY0)) + 1;

  /** Apply one edit to a TIN (default the active one) and record it (undoable) → the edit's result. */
  function edit(kind, params, tinId = active()) {
    return serial(async () => {
      await syncNow();
      const rec = recOf(tinId);
      const rt = rts.get(tinId);
      if (!rec || !rt?.id) throw gwError('no TIN to edit: make one with New TIN first', null, 'E_TIN_NONE');
      const p = { ...params };
      if (['addline', 'profile', 'swap'].includes(kind) && p.key === undefined) p.key = nextKey(tinId);
      const t0 = performance.now();
      const [res] = guard(() => B.apply(rt.id, encodeTinEdits([{ kind, params: p }])));
      const ms = performance.now() - t0;
      if (!res.ok) {
        if (res.broken) {
          const keep = rt.applied.slice();
          reload(rt);
          for (const id of keep) applyRec(rt, recOf(id));
        }
        throw Object.assign(new Error(res.msg), { code: res.broken ? 'E_TIN_BROKEN' : 'E_TIN_REFUSED' });
      }
      const seq = editsOf(tinId).reduce((m, e) => Math.max(m, e.seq), 0) + 1;
      let id;
      S.transact(t('TIN {kind}', { kind: tr(EDIT_LABEL[kind] ?? kind) }), (tx) => (id = tx.create('tinedit', { tin: tinId, seq, kind, params: p, created: new Date().toISOString(), analyst: app.prefs.get('analyst') ?? 'analyst' })));
      rt.applied.push(id);
      rt.info = guard(() => B.info(rt.id));
      rt.version++;
      rt.cache = null;
      rt.linesCache = null;
      rt.lastMs = ms;
      redraw();
      return { ...res, id, key: p.key, ms };
    });
  }

  function remove(tinId = active()) {
    const rec = recOf(tinId);
    if (!rec) return;
    S.transact(t('Delete TIN {name}', { name: rec.name }), (tx) => {
      for (const e of editsOf(tinId)) tx.delete(e.id);
      tx.delete(tinId);
    });
  }

  // ---- queries ----
  async function ready(tinId = active()) {
    await sync();
    const rt = rts.get(tinId);
    if (!rt?.id) throw gwError(rt?.error ?? t('no TIN to edit: make one with New TIN first'), null, 'E_TIN_NONE');
    return rt;
  }
  async function info(tinId = active()) {
    const rt = await ready(tinId);
    return { ...rt.info, report: rt.report, buildMs: rt.buildMs, opsMs: rt.opsMs, loadMs: rt.loadMs, totalMs: rt.totalMs, lastMs: rt.lastMs, edits: rt.applied.length, skipped: [...rt.skipped].map(([id, msg]) => ({ id, msg })) };
  }
  const list = () => tins().map((r) => ({ id: r.id, name: r.name, display: r.display, vertical: r.vertical, source: r.source.kind, error: rts.get(r.id)?.error ?? null, info: rts.get(r.id)?.info ?? null }));
  const toPlaneOf = (tinId, lon, lat) => toPlane(recOf(tinId).frame, lon, lat);
  const toGeoOf = (tinId, x, y) => toGeo(recOf(tinId).frame, x, y);
  async function mesh(tinId = active(), box = null, cap = -1) {
    const rt = await ready(tinId);
    return guard(() => B.mesh(rt.id, box, cap));
  }
  async function lines(tinId = active()) {
    const rt = await ready(tinId);
    return guard(() => B.lines(rt.id)).map((l) => ({ ...l, type: KIND_NAME[l.kind] }));
  }
  /** Heights at [[lon, lat]…] in the TIN's vertical datum (NaN outside or excluded). */
  async function heights(tinId, lonlat) {
    const rt = await ready(tinId);
    const f = recOf(tinId).frame;
    const xy = new Float64Array(2 * lonlat.length);
    lonlat.forEach(([lon, lat], k) => xy.set(toPlane(f, lon, lat), 2 * k));
    return Array.from(guard(() => B.heights(rt.id, xy)));
  }
  async function snap(tinId, lon, lat, rM) {
    const rt = await ready(tinId);
    const [x, y] = toPlane(recOf(tinId).frame, lon, lat);
    return guard(() => B.snap(rt.id, x, y, rM));
  }

  // ---- TIN → grid, TIN → DEM layer ----
  /** {grid (geographic), z (Float32Array)} at about postM metres over the TIN (or a plane box). */
  async function raster(tinId = active(), { postM = null, box = null } = {}) {
    const rt = await ready(tinId);
    const rec = recOf(tinId);
    const i = rt.info;
    const step = postM ?? rec.source.post ?? Math.max(0.1, Math.sqrt(((i.x1 - i.x0) * (i.y1 - i.y0)) / Math.max(1, i.vertices)));
    const { grid, spec } = rasterGrid(rec.frame, box ?? [i.x0, i.y0, i.x1, i.y1], step);
    const t0 = performance.now();
    let z;
    if (grid.width * grid.height > 4e6) z = (await app.pool.run('tin.raster', { state: guard(() => B.save(rt.id)), grid: spec }, { kind: 'analysis', label: t('TIN to DEM'), timeout: 900000 })).z;
    else z = guard(() => B.raster(rt.id, spec));
    return { grid, spec, z, ms: performance.now() - t0, postM: step };
  }

  async function toDem(tinId = active(), o = {}) {
    const rec = recOf(tinId);
    const { grid, z, postM } = await raster(tinId, o);
    const vertical = rec.vertical === 'hae' ? 'hae' : rec.vertical === 'egm2008' ? 'egm2008' : 'egm96';
    const bytes = await writeGeoTiff({ width: grid.width, height: grid.height, bands: 1, type: 'f32', data: z }, { epsg: 4326, vertical, geotransform: [grid.lon0 - grid.dlon / 2, grid.dlon, 0, grid.lat0 + grid.dlat / 2, 0, -grid.dlat], nodata: NaN, overviews: true, tile: 256, description: `GIS Workbench DEM from TIN ${rec.name} (linear interpolation in each triangle, ${postM.toFixed(3)} m posts)` });
    const file = new File([bytes], `${rec.name.replace(/[^\w.-]+/g, '_')}_DEM.tif`, { type: 'image/tiff' });
    const { layers } = await openImageFile(app, file);
    await app.useAsTerrain(layers[0], rec.vertical === 'hae' ? 'hae' : rec.vertical === 'egm2008' ? 'egm2008' : 'egm96');
    const te = app.terrain.entry(layers[0].id);
    if (te) te.kind = 'TIN';
    return { layer: layers[0], grid, postM };
  }

  // ---- import ----
  const epsgConv = (epsg) => {
    const crs = epsg ? crsOf({ epsg: Number(epsg) }) : null;
    if (!crs) throw gwError('EPSG:{epsg} is not a coordinate system the app knows', { epsg: String(epsg) }, 'E_TIN_CRS');
    return converter(crs);
  };
  /** Centre a frame on plane-less points (lon, lat pairs). */
  const frameOver = (ll) => {
    let [a, b, c, d] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lon, lat] of ll) {
      a = Math.min(a, lon);
      b = Math.min(b, lat);
      c = Math.max(c, lon);
      d = Math.max(d, lat);
    }
    return frameAt((b + d) / 2, (a + c) / 2);
  };

  /**
   * Import a TIN file (LandXML) as a new TIN layer, or mass points and breaklines (Shapefile, GeoJSON,
   * CSV) as a new TIN, or into an existing one (`into`). o: {epsg (for projected coordinates without
   * one), vertical, into, name, surface}. Other forms are refused by name.
   */
  async function importFile(files, o = {}) {
    const list = Array.isArray(files) ? files : [files];
    const main = list.find((f) => /\.(shp|zip)$/i.test(f.name)) ?? list[0];
    const form = importForm(main.name);
    const b = await bundle();
    const vertical = o.vertical ?? 'egm96';
    let points = [];
    let lines = [];
    let name = o.name ?? main.name.replace(/\.[^.]+$/, '');
    let note = [];
    let crsInfo = null;
    if (form === 'landxml') {
      const xb = new Uint8Array(await main.arrayBuffer());
      const r = guard(() => b.landxml(xb, o.surface ?? 0));
      const epsg = o.epsg ?? r.doc.epsg;
      if (!epsg) throw gwError('the LandXML file names no coordinate system: give its EPSG code', null, 'E_TIN_CRS');
      const conv = epsgConv(epsg);
      crsInfo = { epsg: Number(epsg), name: r.doc.crsName };
      const ll = [];
      for (let k = 0; k < r.points.length / 3; k++) ll.push(conv.toLonLat(r.points[3 * k], r.points[3 * k + 1]));
      const f = frameOver(ll);
      const P = (e, n, z) => {
        const [lon, lat] = conv.toLonLat(e, n);
        return [...toPlane(f, lon, lat), z];
      };
      points = ll.map(([lon, lat], k) => [...toPlane(f, lon, lat), r.points[3 * k + 2]]);
      // With faces, the surface is the file's own triangles (OD-2.41): points no face uses, and its
      // source data points, are not put in, since they would split faces. Without faces they are mass points.
      const faces = r.faces.length > 0;
      let tris = r.faces;
      let onNoFace = 0;
      if (faces) {
        const use = new Int32Array(points.length).fill(-1);
        for (const k of r.faces) use[k] = 0;
        let m = 0;
        for (let k = 0; k < use.length; k++) if (use[k] === 0) use[k] = m++;
        if (m < points.length) {
          onNoFace = points.length - m;
          points = points.filter((_, k) => use[k] >= 0);
          tris = Uint32Array.from(r.faces, (k) => use[k]);
        }
      }
      if (!faces) for (let k = 0; k < r.extra.length / 3; k++) points.push(P(r.extra[3 * k], r.extra[3 * k + 1], r.extra[3 * k + 2]));
      lines = r.lines.map((l) => ({ type: KIND_NAME[l.kind], closed: l.closed, name: l.name, pts: Array.from({ length: l.n }, (_, k) => P(l.pts[3 * k], l.pts[3 * k + 1], l.pts[3 * k + 2])) }));
      name = o.name ?? r.doc.surfaces[r.doc.surface]?.name ?? name;
      note = [...r.doc.refused.map((x) => refusedText(x)), ...r.doc.warnings.map((x) => warningText(x))];
      if (onNoFace) note.push(t('{n, plural, one {# point is} other {# points are}} on no face: not put in', { n: onNoFace }));
      if (r.doc.surfaces.length > 1) note.push(t('The file has {n} TIN surfaces; only {name} was imported.', { n: r.doc.surfaces.length, name }));
      if (faces && r.extra.length) note.push(t('{n, plural, one {# source data point is} other {# source data points are}} not put in: the file’s faces are the surface', { n: r.extra.length / 3 }));
      const hidden = [];
      r.hidden.forEach((v, k) => v && hidden.push(k));
      const source = { kind: 'import', format: 'LandXML', file: main.name, points, lines, faces: r.doc.faces, maxPoints: 3e6 };
      if (faces) Object.assign(source, { tris: Array.from(tris), hidden });
      const id = await addRecord({ name, frame: f, vertical, crs: crsInfo, source });
      const kept = rts.get(id)?.kept ?? null;
      if (kept?.skipped) note.push(t('{n, plural, one {# face was} other {# faces were}} left out: a corner repeats another, the three are on one line, or the face overlaps another', { n: kept.skipped }));
      // A file whose faces are all hidden has no surface of its own to keep (#77): say so.
      if (kept && kept.faces > 0 && kept.visible === 0) note.push(t('every face in the file is hidden: the TIN covers the area between its points'));
      if (kept?.open) note.push(t('the outline of the file’s faces could not be traced: the TIN covers the area between its points'));
      return { id, points: points.length, lines: lines.length, faces: r.doc.faces, hidden: hidden.length, kept, notes: note, agreement: await faceAgreement(id, r, conv) };
    }
    // Mass points and breaklines.
    let feats = null;
    let tab = null;
    if (form === 'csv') {
      const cb = new Uint8Array(await main.arrayBuffer());
      tab = guard(() => b.pointsText(cb));
    }
    else if (form === 'geojson') feats = readGeoJSON(await main.text(), { name, reproject: (n) => {
      const m = /EPSG:+(\d+)/.exec(n);
      const crs = m ? crsOf({ epsg: Number(m[1]) }) : null;
      if (!crs) return null;
      const c = converter(crs);
      return (x, y) => c.toLonLat(x, y);
    } }).layer.features;
    else {
      const bytes = {};
      for (const f of list) {
        if (/\.zip$/i.test(f.name)) Object.assign(bytes, unzipSync(new Uint8Array(await f.arrayBuffer())));
        else bytes[f.name] = new Uint8Array(await f.arrayBuffer());
      }
      // One shapefile holds one geometry family: points, lines and polygons come as separate sets.
      const sets = shapefileSets(bytes);
      if (!sets.length) throw gwError('{file}: no shapefile (.shp) in it', { file: main.name }, 'E_TIN_FORM');
      feats = sets.flatMap((set) => readShapefile(set, { name, reproject: (wkt) => {
        const crs = crsOf({ wkt });
        if (!crs) return null;
        const c = converter(crs);
        return (x, y) => c.toLonLat(x, y);
      } }).layer.features);
    }
    const target = o.into ? recOf(o.into) : null;
    let f = target?.frame;
    if (!f) {
      const ll = [];
      if (feats) for (const ft of feats) for (let k = 0; k < ft.geom.xyz.length; k += 3) ll.push([ft.geom.xyz[k], ft.geom.xyz[k + 1]]);
      else {
        const conv = o.epsg ? epsgConv(o.epsg) : null;
        const geo = tab.header.some((s) => /^(lon|long|longitude|lng)$/i.test(s));
        const cx = geo ? tab.header.findIndex((s) => /^(lon|long|longitude|lng)$/i.test(s)) : (tab.header.length ? tab.header.findIndex((s) => /^(x|easting|east|e)$/i.test(s)) : 0);
        const cy = geo ? tab.header.findIndex((s) => /^(lat|latitude)$/i.test(s)) : (tab.header.length ? tab.header.findIndex((s) => /^(y|northing|north|n)$/i.test(s)) : 1);
        for (let r = 0; r < tab.rows; r += Math.max(1, Math.floor(tab.rows / 2000))) {
          const X = tab.values[r * tab.cols + cx];
          const Y = tab.values[r * tab.cols + cy];
          if (Number.isFinite(X) && Number.isFinite(Y)) ll.push(geo ? [X, Y] : conv ? conv.toLonLat(X, Y) : [NaN, NaN]);
        }
        if (!geo && !conv) throw gwError('the table has projected x and y: give its coordinate system (EPSG code)', null, 'E_TIN_CRS');
      }
      f = frameOver(ll.filter((p) => p.every(Number.isFinite)));
    }
    const vrec = target ?? { vertical };
    // Feature heights: GeoJSON and Shapefile z are taken as heights in the chosen vertical datum.
    const got = feats ? fromFeatures(feats, f) : fromTable(tab, f, { toLonLat: o.epsg ? epsgConv(o.epsg).toLonLat : null });
    points = got.points;
    lines = got.lines;
    if (got.skipped) note.push(t('{n, plural, one {# feature or row was} other {# features or rows were}} skipped (no geometry or no height)', { n: got.skipped }));
    if (target) {
      if (points.length + lines.length > 5000) throw gwError('{n} points and lines are too many to add as single edits (at most 5000): import them as a new TIN', { n: String(points.length + lines.length) }, 'E_TIN_INTO');
      const results = [];
      for (const p of points) results.push(await edit('addpoint', { x: p[0], y: p[1], z: p[2] }, target.id).then((r) => r, (e) => ({ ok: false, msg: msgOf(e) })));
      for (const l of lines) results.push(await edit('addline', { type: l.type, closed: l.closed, pts: l.pts }, target.id).then((r) => r, (e) => ({ ok: false, msg: msgOf(e) })));
      return { id: target.id, points: points.length, lines: lines.length, failed: results.filter((r) => !r.ok).length, notes: note };
    }
    if (points.length + lines.reduce((s, l) => s + l.pts.length, 0) < 3) throw gwError('the file has fewer than three points with heights: no TIN', null, 'E_TIN_FEW');
    // A new TIN from lines only takes their vertices as mass points too (soft lines need a surface).
    if (points.length < 3) for (const l of lines) for (const p of l.pts) if (Number.isFinite(p[2])) points.push(p);
    const id = await addRecord({ name, frame: f, vertical: vrec.vertical, crs: o.epsg ? { epsg: Number(o.epsg) } : null, source: { kind: 'import', format: form, file: main.name, points, lines, maxPoints: 3e6 } });
    return { id, points: points.length, lines: lines.length, notes: note };
  }

  /** How many of a LandXML surface's faces the imported TIN has (all of a valid file's; a breakline that crosses faces splits them). */
  async function faceAgreement(id, r, conv) {
    if (!r.faces.length) return null;
    const m = await mesh(id);
    const key = (a, b, c) => [a, b, c].sort((p, q) => p - q).join(',');
    // Vertex ids of the rebuilt TIN by position: the nearest within 1.5 mm (it snaps to a 1 mm grid
    // about its own origin, and the file's coordinates are rounded).
    const CELL = 0.002;
    const cell = (v) => Math.floor(v / CELL);
    const at = new Map();
    for (let k = 0; k < m.xyz.length / 3; k++) {
      const c = `${cell(m.xyz[3 * k])},${cell(m.xyz[3 * k + 1])}`;
      if (at.has(c)) at.get(c).push(k);
      else at.set(c, [k]);
    }
    const f = recOf(id).frame;
    const idOf = (k) => {
      const [lon, lat] = conv.toLonLat(r.points[3 * k], r.points[3 * k + 1]);
      const [x, y] = toPlane(f, lon, lat);
      let best;
      let bd = 0.0015;
      for (const dx of [-1, 0, 1])
        for (const dy of [-1, 0, 1])
          for (const w of at.get(`${cell(x) + dx},${cell(y) + dy}`) ?? []) {
            const d = Math.hypot(m.xyz[3 * w] - x, m.xyz[3 * w + 1] - y);
            if (d < bd) [best, bd] = [w, d];
          }
      return best;
    };
    const mine = new Set();
    for (let k = 0; k < m.tris.length / 3; k++) mine.add(key(m.tris[3 * k], m.tris[3 * k + 1], m.tris[3 * k + 2]));
    const ids = new Map();
    let same = 0;
    let unmatched = 0;
    const differ = [];
    for (let k = 0; k < r.faces.length / 3; k++) {
      const v = [0, 1, 2].map((i) => {
        const p = r.faces[3 * k + i];
        if (!ids.has(p)) ids.set(p, idOf(p));
        return ids.get(p);
      });
      if (!v.every((x) => x !== undefined)) unmatched++;
      else if (mine.has(key(...v))) same++;
      else if (differ.length < 20000) differ.push(k);
    }
    return { faces: r.faces.length / 3, same, unmatched, differ };
  }

  const refusedText = (x) =>
    x.what === 'surface' ? t('surface "{name}": a {type} surface is not read (only TIN surfaces)', x) : x.what === 'breakline' ? t('breakline "{name}": brkType "{type}" is not read (wall breaklines are not)', x) : t('boundary "{name}": bndType "{type}" is not read (outer, void and island boundaries are)', x);
  const warningText = (x) => (x.what === 'contours' ? t('the contours in the source data are not read') : t('breakline "{name}" has no elevations: read as a soft (non-destructive) line', x));

  // ---- export ----
  const utmEpsg = (lat, lon) => (lat >= 0 ? 32600 : 32700) + Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  /**
   * Export a TIN: 'landxml' (the surface, its breaklines and boundaries, in `epsg`, default the
   * file's own or the UTM zone), or 'geojson' / 'shapefile' / 'csv' (mass points and breaklines,
   * WGS 84 lon/lat, z in the TIN's vertical datum). Others are refused by name. → {name, blob}.
   */
  async function exportFile(tinId = active(), form = 'landxml', o = {}) {
    exportForm(form);
    const rec = recOf(tinId);
    const rt = await ready(tinId);
    const f = rec.frame;
    // Swapped edges and a file's face outline are in the faces themselves, not lines to write.
    const ls = guard(() => B.lines(rt.id)).filter((l) => !['swap', 'outline'].includes(KIND_NAME[l.kind]));
    const stem = (o.name ?? rec.name).replace(/[^\w.-]+/g, '_');
    let blob;
    let name;
    if (form === 'landxml') {
      const m = guard(() => B.mesh(rt.id));
      const epsg = Number(o.epsg ?? rec.crs?.epsg ?? utmEpsg(f.lat0, f.lon0));
      const conv = epsgConv(epsg);
      const en = new Float64Array(m.xyz.length);
      for (let k = 0; k < m.xyz.length / 3; k++) {
        const [lon, lat] = toGeo(f, m.xyz[3 * k], m.xyz[3 * k + 1]);
        const [e, n] = conv.fromLonLat(lon, lat);
        en[3 * k] = e;
        en[3 * k + 1] = n;
        en[3 * k + 2] = m.xyz[3 * k + 2];
      }
      const lineOut = ls.map((l) => {
        const pts = [];
        for (let k = 0; k < l.path.length / 3; k++) {
          const [lon, lat] = toGeo(f, l.path[3 * k], l.path[3 * k + 1]);
          const [e, n] = conv.fromLonLat(lon, lat);
          pts.push([e, n, l.path[3 * k + 2]]);
        }
        return { type: KIND_NAME[l.kind], closed: l.closed, name: `${KIND_NAME[l.kind]}-${l.key}`, pts };
      });
      const now = new Date().toISOString();
      const text = writeLandXml({ name: rec.name, epsg, crsName: crsOf({ epsg })?.label ?? '', vertical: tr(VERTICALS[rec.vertical] ?? rec.vertical), date: now.slice(0, 10), time: now.slice(11, 19), version: app.build?.version ?? '' }, en, m.tris, lineOut, m.excluded);
      blob = new Blob([text], { type: 'application/xml' });
      name = `${stem}.xml`;
    } else {
      const masses = await massPoints(rt, f);
      // A ridge's or drain's heights are on every vertex of its path, not only the drawn ones.
      const lineGeo = ls.map((l) => {
        const v = HEIGHT_LINES.includes(KIND_NAME[l.kind]) ? l.path : l.defs;
        return { key: l.key, type: KIND_NAME[l.kind], closed: l.closed, pts: Array.from({ length: v.length / 3 }, (_, k) => [...toGeo(f, v[3 * k], v[3 * k + 1]), v[3 * k + 2]]) };
      });
      if (form === 'csv') {
        blob = new Blob([writeCsv(masses, lineGeo)], { type: 'text/csv' });
        name = `${stem}.csv`;
      } else {
        const features = [
          ...masses.map((p) => ({ geom: fromParts('Point', [[p]]), attrs: { kind: 'mass', z_datum: rec.vertical }, name: null })),
          ...lineGeo.map((l) => ({ geom: l.closed ? fromParts('Polygon', [[...l.pts, l.pts[0]]]) : fromParts('LineString', [l.pts]), attrs: { kind: l.type, key: l.key, z_datum: rec.vertical }, name: null })),
        ];
        const layer = { name: stem, fields: [{ name: 'kind', type: 'string' }, { name: 'key', type: 'number' }, { name: 'z_datum', type: 'string' }], features };
        if (form === 'geojson') {
          blob = new Blob([writeGeoJSON(layer).text], { type: 'application/geo+json' });
          name = `${stem}.geojson`;
        } else {
          const { files } = writeShapefile(layer);
          blob = new Blob([zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? new TextEncoder().encode(v) : v])))], { type: 'application/zip' });
          name = `${stem}_shp.zip`;
        }
      }
    }
    if (o.save !== false) await saveBlob(app, blob, { name, description: t('TIN export') });
    return { name, blob };
  }

  /** Mass points that are TIN vertices now, as [lon, lat, z]. */
  async function massPoints(rt, f) {
    const m = guard(() => B.mesh(rt.id));
    // Only lines that carry their path's heights hold these vertices; the rest stay mass points.
    const lineVerts = new Set();
    for (const l of guard(() => B.lines(rt.id))) if (HEIGHT_LINES.includes(KIND_NAME[l.kind])) for (let k = 0; k < l.path.length / 3; k++) lineVerts.add(`${l.path[3 * k]},${l.path[3 * k + 1]}`);
    const out = [];
    for (let k = 0; k < m.xyz.length / 3; k++) {
      const x = m.xyz[3 * k];
      const y = m.xyz[3 * k + 1];
      if (lineVerts.has(`${x},${y}`)) continue;
      out.push([...toGeo(f, x, y), m.xyz[3 * k + 2]]);
    }
    return out;
  }

  // ---- 3D ----
  async function show3d(tinId = active(), p = pane()) {
    const rec = recOf(tinId);
    const rt = await ready(tinId);
    const m = guard(() => B.mesh(rt.id));
    const nt = m.tris.length / 3;
    if (nt > 2e6) throw gwError('{tin} has {n} million triangles: the 3D view shows TINs of up to 2 million; rasterise it (TIN to DEM) to see it there', { tin: rec.name, n: num(nt / 1e6, 1) }, 'E_TIN_3D');
    const v = await app.scene3d.ensureView(p);
    const T = v.T;
    const f = rec.frame;
    const i = rt.info;
    // Geoid separation on a 3 × 3 grid over the TIN, interpolated (orthometric TINs; display only).
    const [w0, s0] = toGeo(f, i.x0, i.y0);
    const [e0, n0] = toGeo(f, i.x1, i.y1);
    const Ng = [];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) Ng.push(rec.vertical === 'hae' ? 0 : undulation(s0 + ((n0 - s0) * a) / 2, w0 + ((e0 - w0) * b) / 2));
    const Nat = (lon, lat) => {
      const u = Math.max(0, Math.min(2, (2 * (lon - w0)) / (e0 - w0 || 1)));
      const vv = Math.max(0, Math.min(2, (2 * (lat - s0)) / (n0 - s0 || 1)));
      const a = Math.min(1, Math.floor(vv));
      const b = Math.min(1, Math.floor(u));
      const fu = u - b;
      const fv = vv - a;
      const g = (r, c) => Ng[r * 3 + c];
      return (g(a, b) * (1 - fu) + g(a, b + 1) * fu) * (1 - fv) + (g(a + 1, b) * (1 - fu) + g(a + 1, b + 1) * fu) * fv;
    };
    if (!v.origin) v.setOrigin({ lat0: f.lat0, lon0: f.lon0, kx: f.kx, ky: f.ky });
    const nv = m.xyz.length / 3;
    const pos = new Float32Array(3 * nv);
    const col = new Float32Array(3 * nv);
    for (let k = 0; k < nv; k++) {
      const [lon, lat] = toGeo(f, m.xyz[3 * k], m.xyz[3 * k + 1]);
      const [e, n] = v.toLocal(lat, lon);
      pos[3 * k] = e;
      pos[3 * k + 1] = n;
      pos[3 * k + 2] = m.xyz[3 * k + 2] + Nat(lon, lat);
      const tt = (m.xyz[3 * k + 2] - i.zmin) / Math.max(1e-6, i.zmax - i.zmin);
      col[3 * k] = 0.35 + 0.45 * tt;
      col[3 * k + 1] = 0.45 + 0.25 * tt;
      col[3 * k + 2] = 0.3 + 0.2 * tt;
    }
    let keep = 0;
    for (let k = 0; k < nt; k++) if (!m.excluded[k]) keep++;
    const idx = new Uint32Array(3 * keep);
    for (let k = 0, o2 = 0; k < nt; k++) if (!m.excluded[k]) idx.set(m.tris.subarray(3 * k, 3 * k + 3), 3 * o2++);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setIndex(new T.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const old = v.world.children.find((o) => o.userData?.tin === tinId);
    if (old) {
      v.world.remove(old);
      old.traverse?.((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
    }
    const group = new T.Group();
    group.userData = { tin: tinId };
    group.name = rec.name;
    group.add(new T.Mesh(g, new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide })));
    // Breaklines on top.
    const segs = [];
    for (let k = 0; k < m.edges.length / 2; k++) {
      for (const w of [m.edges[2 * k], m.edges[2 * k + 1]]) segs.push(pos[3 * w], pos[3 * w + 1], pos[3 * w + 2] + 0.05);
    }
    if (segs.length) {
      const lg = new T.BufferGeometry();
      lg.setAttribute('position', new T.BufferAttribute(new Float32Array(segs), 3));
      group.add(new T.LineSegments(lg, new T.LineBasicMaterial({ color: 0xff4848 })));
    }
    v.world.add(group);
    const [ce, cn] = v.toLocal((s0 + n0) / 2, (w0 + e0) / 2);
    v.lookAtLocal(ce, cn, (i.zmin + i.zmax) / 2 + Nat((w0 + e0) / 2, (s0 + n0) / 2), Math.max(i.x1 - i.x0, i.y1 - i.y0, 10));
    v.invalidate();
    return { vertices: nv, triangles: keep };
  }

  function setDisplay(tinId, mode) {
    if (!['off', 'wireframe', 'shaded'].includes(mode)) throw gwError('unknown TIN display "{mode}"', { mode: String(mode) }, 'E_TIN_DISPLAY');
    S.transact(t('TIN display'), (tx) => tx.set(tinId, 'display', mode));
  }

  // ---- 2D display ----
  /** The panel's view as a plane box of TIN `f` (corners and centre through its image's model). */
  function viewBox(p, l, f) {
    const { w, h: hh } = p.size();
    const gs = [[0, 0], [w, 0], [w, hh], [0, hh], [w / 2, hh / 2]].map(([x, y]) => {
      const q = p.imagePoint(x, y);
      return l.groundAt(q.x, q.y);
    }).filter((g) => g && Number.isFinite(g.lat));
    if (gs.length < 3) return null;
    const xy = gs.map((g) => toPlane(f, g.lon, g.lat));
    const xs = xy.map((q) => q[0]);
    const ys = xy.map((q) => q[1]);
    const mx = (Math.max(...xs) - Math.min(...xs)) * 0.05;
    const my = (Math.max(...ys) - Math.min(...ys)) * 0.05;
    return [Math.min(...xs) - mx, Math.min(...ys) - my, Math.max(...xs) + mx, Math.max(...ys) + my];
  }

  function drawTin(p, g, w, hh, rec, rt, l) {
    const f = rec.frame;
    const box = viewBox(p, l, f);
    if (!box) return;
    // The query walks every triangle: keep its result while the view drifts inside the box's margin.
    const stepM = Math.max(1, Math.max(box[2] - box[0], box[3] - box[1]) / 32);
    const q = (v) => Math.round(v / stepM);
    const key = `${rt.version}|${l.id}|${Math.round(Math.log2(stepM) * 4)}|${box.map(q).join(',')}`;
    if (rt.cache?.key !== key || rt.cache?.pane !== p.id) {
      const m = guard(() => B.mesh(rt.id, box, DRAW_CAP));
      let xy = null;
      if (m.tris.length) {
        const nv = m.xyz.length / 3;
        const pts = new Float64Array(3 * nv);
        for (let k = 0; k < nv; k++) {
          const [lon, lat] = toGeo(f, m.xyz[3 * k], m.xyz[3 * k + 1]);
          pts[3 * k] = lat;
          pts[3 * k + 1] = lon;
          pts[3 * k + 2] = l.modelInfo?.is3d ? toHae(rec, lat, lon, m.xyz[3 * k + 2]) : 0;
        }
        xy = app.core.g2iBatch(l.modelId, pts);
      }
      rt.cache = { key, pane: p.id, m, xy };
    }
    const { m, xy } = rt.cache;
    g.save();
    if (!m.tris.length) {
      // Too many triangles in view: the lines only, and a note.
      drawLines(p, g, rec, rt, l);
      pointText(g, 11, 'ui');
      g.fillStyle = '#ffffff';
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.lineWidth = 3;
      const msg = t('TIN {name}: {n} triangles in view; zoom in to see them', { name: rec.name, n: int(m.total) });
      g.strokeText(msg, 10, hh - 12);
      g.fillText(msg, 10, hh - 12);
      g.restore();
      return;
    }
    const nv = m.xyz.length / 3;
    const sx = new Float32Array(nv);
    const sy = new Float32Array(nv);
    for (let k = 0; k < nv; k++) {
      const s = Number.isFinite(xy[2 * k]) ? p.screenPoint(xy[2 * k], xy[2 * k + 1]) : null;
      sx[k] = s ? s.x : NaN;
      sy[k] = s ? s.y : NaN;
    }
    const nt = m.tris.length / 3;
    const info = rt.info;
    if (rec.display === 'shaded') {
      for (let k = 0; k < nt; k++) {
        if (m.excluded[k]) continue;
        const [a, b, c] = [m.tris[3 * k], m.tris[3 * k + 1], m.tris[3 * k + 2]];
        if (!(sx[a] === sx[a] && sx[b] === sx[b] && sx[c] === sx[c])) continue;
        const za = m.xyz[3 * a + 2];
        const lam = lambertOf(m.xyz[3 * a], m.xyz[3 * a + 1], za, m.xyz[3 * b], m.xyz[3 * b + 1], m.xyz[3 * b + 2], m.xyz[3 * c], m.xyz[3 * c + 1], m.xyz[3 * c + 2]);
        const zt = ((za + m.xyz[3 * b + 2] + m.xyz[3 * c + 2]) / 3 - info.zmin) / Math.max(1e-6, info.zmax - info.zmin);
        g.fillStyle = shadeColour(zt, lam);
        g.beginPath();
        g.moveTo(sx[a], sy[a]);
        g.lineTo(sx[b], sy[b]);
        g.lineTo(sx[c], sy[c]);
        g.closePath();
        g.fill();
      }
    }
    // Wireframe (also faint over the shaded view).
    g.strokeStyle = rec.display === 'shaded' ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 0; k < nt; k++) {
      if (m.excluded[k] && rec.display === 'shaded') continue;
      const [a, b, c] = [m.tris[3 * k], m.tris[3 * k + 1], m.tris[3 * k + 2]];
      if (!(sx[a] === sx[a] && sx[b] === sx[b] && sx[c] === sx[c])) continue;
      g.moveTo(sx[a], sy[a]);
      g.lineTo(sx[b], sy[b]);
      g.lineTo(sx[c], sy[c]);
      g.closePath();
    }
    g.stroke();
    // Breaklines and rings by kind.
    g.lineWidth = 2.5;
    const byKind = new Map();
    for (let k = 0; k < m.edges.length / 2; k++) {
      const kind = KIND_NAME[m.kinds[k]] ?? 'hard';
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(m.edges[2 * k], m.edges[2 * k + 1]);
    }
    for (const [kind, es] of byKind) {
      g.strokeStyle = COLOUR[kind] ?? '#ff4848';
      g.beginPath();
      for (let k = 0; k < es.length; k += 2) {
        const [a, b] = [es[k], es[k + 1]];
        if (!(sx[a] === sx[a] && sx[b] === sx[b])) continue;
        g.moveTo(sx[a], sy[a]);
        g.lineTo(sx[b], sy[b]);
      }
      g.stroke();
    }
    g.restore();
  }

  function drawLines(p, g, rec, rt, l) {
    if (!rt.linesCache || rt.linesCache.version !== rt.version || rt.linesCache.layer !== l.id) {
      const ls = guard(() => B.lines(rt.id));
      const out = [];
      let n = 0;
      for (const ln of ls) {
        if (n > 200000) break;
        const k3 = ln.path.length / 3;
        n += k3;
        const pts = new Float64Array(3 * k3);
        for (let k = 0; k < k3; k++) {
          const [lon, lat] = toGeo(rec.frame, ln.path[3 * k], ln.path[3 * k + 1]);
          pts.set([lat, lon, l.modelInfo?.is3d ? toHae(rec, lat, lon, ln.path[3 * k + 2]) : 0], 3 * k);
        }
        out.push({ kind: KIND_NAME[ln.kind], closed: ln.closed, xy: app.core.g2iBatch(l.modelId, pts) });
      }
      rt.linesCache = { version: rt.version, layer: l.id, lines: out };
    }
    g.lineWidth = 2;
    for (const ln of rt.linesCache.lines) {
      g.strokeStyle = COLOUR[ln.kind] ?? '#ff4848';
      g.beginPath();
      for (let k = 0; k < ln.xy.length / 2; k++) {
        const s = p.screenPoint(ln.xy[2 * k], ln.xy[2 * k + 1]);
        if (k) g.lineTo(s.x, s.y);
        else g.moveTo(s.x, s.y);
      }
      if (ln.closed) g.closePath();
      g.stroke();
    }
  }

  const prevDeco = app.paneDecorations;
  app.paneDecorations = (p, g, w, hh, l) => {
    prevDeco?.(p, g, w, hh, l);
    if (!B || !l?.modelId) return;
    for (const rec of tins()) {
      const rt = rts.get(rec.id);
      if (!rt?.id || rec.display === 'off') continue;
      try {
        drawTin(p, g, w, hh, rec, rt, l);
      } catch (e) {
        app.log?.('warn', `TIN display: ${e?.message ?? e}`);
      }
    }
  };

  // ---- tools ----
  const EDIT_LABEL = { addpoint: N_('add point'), delpoint: N_('delete point'), movepoint: N_('move point'), addline: N_('breakline'), setline: N_('edit breakline'), delline: N_('delete breakline'), profile: N_('ridge or drain'), delin: N_('delete points in an area'), swap: N_('swap edge'), retri: N_('re-triangulate an area') };
  const opts = { height: 'tin', value: NaN, lineType: 'hard', snap: true, mode: 'drain' };
  const groundAt = (p, sx, sy) => {
    const l = p.geoLayer();
    if (!l?.modelId) return null;
    const q = p.imagePoint(sx, sy);
    const g = l.groundWithTerrain(q.x, q.y);
    return g && Number.isFinite(g.lat) ? { ...g, sx, sy } : null;
  };
  /** Ground metres per screen pixel near (sx, sy). */
  const metresPerPx = (p, sx, sy, rec) => {
    const a = groundAt(p, sx, sy);
    const b = groundAt(p, sx + 10, sy);
    if (!a || !b) return 1;
    const [x0, y0] = toPlane(rec.frame, a.lon, a.lat);
    const [x1, y1] = toPlane(rec.frame, b.lon, b.lat);
    return Math.hypot(x1 - x0, y1 - y0) / 10;
  };
  /** The plane point of a click, snapped to a TIN vertex or line within 10 px when snapping is on; z per the height option. */
  async function pick(p, sx, sy, { snapTo = opts.snap } = {}) {
    const tinId = active();
    const rec = recOf(tinId);
    const g = groundAt(p, sx, sy);
    if (!rec || !g) return null;
    const rt = await ready(tinId);
    let [x, y] = toPlane(rec.frame, g.lon, g.lat);
    const r = 10 * metresPerPx(p, sx, sy, rec);
    let z = NaN;
    if (snapTo) {
      const s = guard(() => B.snap(rt.id, x, y, r));
      if (s.vertex) [x, y, z] = [s.vertex.x, s.vertex.y, s.vertex.z];
      else if (s.line) [x, y, z] = [s.line.x, s.line.y, s.line.z];
    }
    if (!Number.isFinite(z)) {
      if (opts.height === 'value' && Number.isFinite(opts.value)) z = opts.value;
      else if (opts.height === 'terrain') z = fromHae(rec, g.lat, g.lon, g.h);
      else {
        z = guard(() => B.heights(rt.id, new Float64Array([x, y])))[0];
        if (!Number.isFinite(z)) z = fromHae(rec, g.lat, g.lon, g.h);
      }
    }
    return { x, y, z, r, sx, sy, tinId };
  }
  const fail = (e) => toast(t('TIN: {msg}', { msg: msgOf(e) }), { kind: e?.code === 'E_TIN_REFUSED' ? 'warn' : 'error' });

  // snapOf(state): snap this click to a vertex or line? (A new point or an edge is not a vertex.)
  const pointTool = (id, cue, run, snapOf = () => true) =>
    app.tools.register({
      id,
      cue,
      onDown(p, e, sx, sy) {
        pick(p, sx, sy, { snapTo: snapOf(this.state) })
          .then((q) => q && run(q, this.state, p))
          .catch(fail);
        return true;
      },
      draw(p, g, w, hh, s) {
        if (!s.sel) return;
        g.strokeStyle = '#ffd400';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(s.sel.sx, s.sel.sy, 7, 0, 2 * Math.PI);
        g.stroke();
      },
    });
  pointTool('tin.addpoint', t('Add mass points: click on the surface; Esc ends.'), (q) => edit('addpoint', { x: q.x, y: q.y, z: q.z }).catch(fail), () => false);
  pointTool('tin.delpoint', t('Delete mass points: click on a point; Esc ends.'), (q) => edit('delpoint', { x: q.x, y: q.y, r: q.r }).catch(fail));
  pointTool('tin.movepoint', t('Move a mass point: click the point, then where it goes; Esc ends.'), (q, s, p) => {
    if (!s.sel) {
      s.sel = q;
      p.invalidate();
      return;
    }
    const from = s.sel;
    s.sel = null;
    edit('movepoint', { x: from.x, y: from.y, r: from.r, nx: q.x, ny: q.y, nz: opts.height === 'value' && Number.isFinite(opts.value) ? opts.value : NaN }).catch(fail);
  }, (s) => !s.sel);
  pointTool('tin.swap', t('Swap an edge: click on the edge; Esc ends.'), (q) => edit('swap', { x: q.x, y: q.y }).catch(fail), () => false);

  /** Line tools: click the vertices (snapped); double-click or Enter finishes. */
  const lineTool = (id, cue, finish, ring = false) =>
    app.tools.register({
      id,
      cue,
      onDown(p, e, sx, sy) {
        const s = this.state;
        s.pts ??= [];
        const mark = { sx, sy, pending: true };
        s.pts.push(mark);
        (s.picks ??= []).push(
          pick(p, sx, sy, { snapTo: id === 'tin.line' && opts.snap })
            .then((q) => {
              const k = s.pts.indexOf(mark);
              if (q) s.pts[k] = q;
              else s.pts.splice(k, 1);
              p.invalidate();
            })
            .catch(fail),
        );
        p.invalidate();
        return true;
      },
      onDblClick(p) {
        this.onEnter(p);
        return true;
      },
      onEnter() {
        // A double-click ends the line while its clicks are still being picked (and adds the last
        // vertex twice): wait for them, and drop repeats.
        const s = this.state;
        this.state = {};
        app.tools.done();
        Promise.all(s.picks ?? []).then(() => {
          const pts = [];
          for (const q of s.pts ?? []) if (!q.pending && !(pts.at(-1)?.x === q.x && pts.at(-1)?.y === q.y)) pts.push(q);
          if (pts.length >= (ring ? 3 : 2)) finish(pts);
        });
      },
      draw(p, g, w, hh, s) {
        const pts = s.pts ?? [];
        if (!pts.length) return;
        g.strokeStyle = COLOUR[id === 'tin.line' ? opts.lineType : id === 'tin.profile' ? opts.mode : 'void'] ?? '#ffd400';
        g.lineWidth = 2;
        g.setLineDash([6, 3]);
        g.beginPath();
        pts.forEach((q, k) => (k ? g.lineTo(q.sx, q.sy) : g.moveTo(q.sx, q.sy)));
        if (ring) g.closePath();
        g.stroke();
        g.setLineDash([]);
      },
    });
  lineTool('tin.line', t('Breakline: click the vertices (they snap to points and lines); double-click finishes.'), (pts) => {
    const ring = opts.lineType === 'void' || opts.lineType === 'outer';
    edit('addline', { type: opts.lineType, closed: ring, pts: pts.map((q) => [q.x, q.y, q.z]) }).catch(fail);
  });
  lineTool('tin.profile', t('Ridge or drain: click along the line; double-click finishes. Heights are made to fall along it.'), (pts) => edit('profile', { mode: opts.mode, pts: pts.map((q) => [q.x, q.y]) }).then((r) => {
    toast(t('{kind}: {n, plural, one {# vertex} other {# vertices}} lowered or raised by up to {dz}', { kind: opts.mode === 'ridge' ? t('Ridge') : t('Drain'), n: r.profile?.changed ?? 0, dz: height(r.profile?.maxChange ?? 0, 2) }), { kind: 'info' });
    if (r.profile?.conflicts) toast(t('This line changed {n, plural, one {# vertex} other {# vertices}} of another ridge or drain: that line may no longer fall through {n, plural, one {it} other {them}}', { n: r.profile.conflicts }), { kind: 'warn', ms: 9000 });
  }).catch(fail));
  lineTool('tin.delin', t('Delete mass points in an area: click the corners; double-click finishes.'), (pts) => edit('delin', { ring: pts.map((q) => [q.x, q.y]) }).catch(fail), true);
  lineTool('tin.retri', t('Re-triangulate an area (swapped edges in it are undone): click the corners; double-click finishes.'), (pts) => edit('retri', { ring: pts.map((q) => [q.x, q.y]) }).catch(fail), true);

  // Edit a breakline: click near a line to pick it, then a vertex of it, then where it goes; Delete removes the line.
  app.tools.register({
    id: 'tin.editline',
    cue: t('Edit a breakline: click the line, then one of its vertices, then where it goes; Delete removes the line.'),
    onDown(p, e, sx, sy) {
      const s = this.state;
      pick(p, sx, sy, { snapTo: false })
        .then(async (q) => {
          if (!q) return;
          const rt = await ready(q.tinId);
          if (!s.line) {
            const hit = guard(() => B.snap(rt.id, q.x, q.y, q.r)).line;
            if (!hit) return;
            const l = guard(() => B.lines(rt.id)).find((x) => x.key === hit.key);
            // A file's outline rings go with its faces: deleting one alone would turn the fill inside out.
            if (!l || l.key < 1 || KIND_NAME[l.kind] === 'outline') return;
            s.line = { key: l.key, type: KIND_NAME[l.kind], closed: l.closed, defs: Array.from({ length: l.defs.length / 3 }, (_, k) => [l.defs[3 * k], l.defs[3 * k + 1], l.defs[3 * k + 2]]) };
            toast(t('Breakline picked: click one of its vertices, then where it goes'), { kind: 'info' });
          } else if (s.vertex === undefined) {
            let best = -1;
            let bd = Infinity;
            s.line.defs.forEach((d, k) => {
              const dd = Math.hypot(d[0] - q.x, d[1] - q.y);
              if (dd < bd) [best, bd] = [k, dd];
            });
            if (bd <= q.r * 2) s.vertex = best;
          } else {
            const defs = s.line.defs.map((d) => d.slice());
            defs[s.vertex] = [q.x, q.y, ['hard', 'ridge', 'drain'].includes(s.line.type) ? (opts.height === 'value' && Number.isFinite(opts.value) ? opts.value : defs[s.vertex][2]) : NaN];
            const { key, type, closed } = s.line;
            this.state = {};
            if (['ridge', 'drain'].includes(type)) return edit('delline', { key }).then(() => edit('profile', { mode: type, pts: defs.map((d) => [d[0], d[1]]) }));
            return edit('setline', { key, type, closed, pts: defs });
          }
        })
        .catch(fail);
      return true;
    },
    onKey(p, e) {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.state.line) {
        const { key } = this.state.line;
        this.state = {};
        edit('delline', { key }).catch(fail);
        return true;
      }
      return false;
    },
  });

  // ---- dialogs ----
  const numInp = (lab, v, step = 'any') => h('input', { class: 'inp inp-num', type: 'number', step, value: v, 'aria-label': lab });
  const select = (lab, entries, value) => {
    const s = h('select', { class: 'inp', 'aria-label': lab }, ...entries.map(([k, v]) => h('option', { value: k }, v)));
    s.value = value;
    return s;
  };

  async function newDialog() {
    const dems = app.terrain.dems.filter((d) => d.grid);
    const clouds = [...(app.pointClouds?.values() ?? [])];
    const srcs = [...dems.map((d) => [`dem:${d.layerId}`, t('DEM posts: {dem}', { dem: d.name })]), ...clouds.map((c) => [`pc:${c.id}`, t('Ground points (class 2): {cloud}', { cloud: c.name })])];
    if (!srcs.length) return toast(t('A TIN is made from a DEM used as terrain or an open point cloud: open one first'), { kind: 'warn' });
    const src = select(t('Source'), srcs, srcs[0][0]);
    const tol = numInp(t('Vertical tolerance (m)'), '0.5');
    const all = h('input', { type: 'checkbox', style: { width: '18px', height: '18px', margin: '3px' }, 'aria-label': t('Every post') });
    const cell = numInp(t('Thinning cell (m, 0 = every point)'), '0');
    const maxv = numInp(t('Largest number of points'), '3000000', '1');
    const nm = h('input', { class: 'inp', type: 'text', 'aria-label': t('Name') });
    const body = h('div', { 'data-id': 'tin:new' }, field(t('Source'), src), field(t('Vertical tolerance (m)'), tol, t('DEM posts are added, the farthest from the TIN first, until every post is within this height of it.')), h('label', { class: 'fld fld-inline' }, all, h('span', {}, t('Every post (no thinning)'))), field(t('Thinning cell (m, 0 = every point)'), cell, t('Ground points: one per cell, the one nearest its centre.')), field(t('Largest number of points'), maxv), field(t('Name'), nm));
    const r = await modal({ title: t('New TIN'), body, buttons: [{ label: t('Make TIN'), value: 'make', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 520, id: 'tin-new' });
    if (r !== 'make') return;
    const [kind, id] = src.value.split(/:(.*)/s);
    toast(t('Making the TIN (Job Queue shows it)'), { kind: 'info' });
    try {
      const tid = kind === 'dem' ? await create({ from: 'dem', layer: id, tolerance: all.checked ? -1 : +tol.value, maxPoints: +maxv.value, name: nm.value || undefined }) : await create({ from: 'lidar', pc: id, cell: +cell.value, maxPoints: +maxv.value, name: nm.value || undefined });
      const i = await info(tid);
      toast(t('TIN {name}: {v} points, {tr} triangles in {s} s; largest post error {e}', { name: recOf(tid).name, v: int(i.vertices), tr: int(i.triangles), s: num(i.totalMs / 1000, 1), e: height(i.report?.maxError ?? 0, 3) }), { kind: 'info', ms: 9000 });
    } catch (e) {
      fail(e);
    }
  }

  const ACTIONS = [
    ['tin.addpoint', N_('Add mass points')],
    ['tin.movepoint', N_('Move a mass point')],
    ['tin.delpoint', N_('Delete mass points')],
    ['tin.delin', N_('Delete mass points in an area')],
    ['tin.line', N_('Draw a breakline or ring')],
    ['tin.editline', N_('Edit or delete a breakline')],
    ['tin.profile', N_('Ridge or drain profile')],
    ['tin.swap', N_('Swap an edge')],
    ['tin.retri', N_('Re-triangulate an area')],
  ];

  async function editorDialog() {
    if (!tins().length) return toast(t('No TIN: make one with New TIN or Import TIN first'), { kind: 'warn' });
    const tin = select(t('TIN'), tins().map((r) => [r.id, r.name]), active());
    const act = select(t('Action'), ACTIONS.map(([k, v]) => [k, tr(v)]), app.tools.current?.id?.startsWith('tin.') ? app.tools.current.id : 'tin.addpoint');
    const ltype = select(t('Line kind'), [['hard', t('Hard breakline (its own heights)')], ['soft', t('Soft breakline (the surface heights)')], ['void', t('Exclusion area (a hole in the TIN)')], ['outer', t('Outer boundary (the TIN is cut to it)')]], opts.lineType);
    const mode = select(t('Profile'), [['drain', t('Drain: cut so heights fall along the line')], ['ridge', t('Ridge: fill so heights fall along the line')]], opts.mode);
    const hmode = select(t('Heights of new vertices'), [['tin', t('From the TIN')], ['terrain', t('From the terrain under the cursor')], ['value', t('This value')]], opts.height);
    const hval = numInp(t('Height (m)'), Number.isFinite(opts.value) ? String(opts.value) : '');
    const snapBox = h('input', { type: 'checkbox', style: { width: '18px', height: '18px', margin: '3px' }, 'aria-label': t('Snap to points and lines') });
    snapBox.checked = opts.snap;
    const disp = select(t('Display'), [['wireframe', t('Wireframe')], ['shaded', t('Shaded')], ['off', t('Off')]], recOf(tin.value)?.display ?? 'wireframe');
    const stats = h('p', { class: 'hint', 'data-id': 'tin:stats' });
    const showStats = async () => {
      try {
        const i = await info(tin.value);
        const rec = recOf(tin.value);
        stats.textContent = t('{v} points ({m} mass), {tr} triangles, {l} lines; heights {datum}; {e} edits ({s} skipped)', { v: int(i.vertices), m: int(i.mass), tr: int(i.triangles), l: int(i.lines.length), datum: tr(VERTICALS[rec.vertical] ?? rec.vertical), e: int(i.edits), s: int(i.skipped.length) });
      } catch (e) {
        stats.textContent = msgOf(e);
      }
    };
    tin.addEventListener('change', () => {
      disp.value = recOf(tin.value)?.display ?? 'wireframe';
      showStats();
    });
    showStats();
    const body = h('div', { 'data-id': 'tin:editor' }, field(t('TIN'), tin), field(t('Display'), disp), field(t('Action'), act), field(t('Line kind'), ltype), field(t('Profile'), mode, t('Ridge and drain lines are drawn downhill or uphill; they are turned to run from the higher end.')), field(t('Heights of new vertices'), hmode), field(t('Height (m)'), hval), h('label', { class: 'fld fld-inline' }, snapBox, h('span', {}, t('Snap to points and lines'))), stats, h('p', { class: 'hint' }, t('Each edit is kept in the project and undoes with Ctrl+Z. Esc ends the tool.')));
    const r = await modal({ title: t('TIN Editor'), body, buttons: [{ label: t('Start'), value: 'start', primary: true }, { label: t('Apply Display'), value: 'display' }, { label: t('Delete TIN'), value: 'delete' }, { label: t('Close'), value: 'close' }], width: 560, id: 'tin-editor' });
    activeId = tin.value;
    Object.assign(opts, { lineType: ltype.value, mode: mode.value, height: hmode.value, value: hval.value === '' ? NaN : +hval.value, snap: snapBox.checked });
    if (disp.value !== recOf(tin.value)?.display) setDisplay(tin.value, disp.value);
    if (r === 'delete') return remove(tin.value);
    if (r !== 'start') return;
    app.tools.select(act.value, { sticky: true });
  }

  async function importDialog(given = null) {
    const files = given ?? await pickFiles(app, { multiple: true, accept: ['.xml', '.landxml', '.csv', '.txt', '.xyz', '.geojson', '.json', '.shp', '.dbf', '.prj', '.shx', '.cpg', '.zip'], description: t('LandXML, Shapefile, GeoJSON or CSV') });
    if (!files?.length) return;
    const main = files.find((f) => /\.(shp|zip)$/i.test(f.name)) ?? files[0];
    let form;
    try {
      form = importForm(main.name);
    } catch (e) {
      return toast(msgOf(e), { kind: 'warn', ms: 9000 });
    }
    const epsg = numInp(t('EPSG code of projected coordinates (empty: from the file)'), '', '1');
    const vert = select(t('Heights are'), Object.entries(VERTICALS).map(([k, v]) => [k, tr(v)]), 'egm96');
    const into = select(t('Into'), [['', t('A new TIN')], ...(form === 'landxml' ? [] : tins().map((r) => [r.id, t('Add to {tin}', { tin: r.name })]))], '');
    const body = h('div', { 'data-id': 'tin:import' }, h('p', {}, t('{file} ({form})', { file: main.name, form: { landxml: 'LandXML', csv: 'CSV', geojson: 'GeoJSON', shapefile: 'Shapefile' }[form] })), field(t('EPSG code of projected coordinates (empty: from the file)'), epsg), field(t('Heights are'), vert), field(t('Into'), into));
    const r = await modal({ title: t('Import TIN'), body, buttons: [{ label: t('Import'), value: 'import', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 520, id: 'tin-import' });
    if (r !== 'import') return;
    try {
      const out = await importFile(files, { epsg: epsg.value ? +epsg.value : undefined, vertical: vert.value, into: into.value || undefined });
      for (const n of out.notes ?? []) app.importLog?.push({ file: main.name, errors: [], warnings: [n] });
      const agree = out.agreement ? t('; {same} of {faces} of the file’s faces are in the TIN', { same: int(out.agreement.same), faces: int(out.agreement.faces) }) : '';
      toast(t('{file}: {p} points and {l} lines read{agree}', { file: main.name, p: int(out.points), l: int(out.lines), agree }), { kind: out.notes?.length ? 'warn' : 'info', ms: 10000 });
    } catch (e) {
      fail(e);
    }
  }

  async function exportDialog() {
    if (!tins().length) return toast(t('No TIN: make one with New TIN or Import TIN first'), { kind: 'warn' });
    const tin = select(t('TIN'), tins().map((r) => [r.id, r.name]), active());
    const form = select(t('Export as'), [['landxml', t('LandXML surface')], ['shapefile', t('Mass points and breaklines: Shapefile (ZIP)')], ['geojson', t('Mass points and breaklines: GeoJSON')], ['csv', t('Mass points and breaklines: CSV')]], 'landxml');
    const epsg = numInp(t('EPSG code (LandXML; empty: the file’s own, else the UTM zone)'), '', '1');
    const body = h('div', { 'data-id': 'tin:export' }, field(t('TIN'), tin), field(t('Export as'), form), field(t('EPSG code (LandXML; empty: the file’s own, else the UTM zone)'), epsg), h('p', { class: 'hint' }, t('Shapefile, GeoJSON and CSV are in WGS 84 longitude and latitude; heights stay in the TIN’s vertical datum (the z_datum field).')));
    const r = await modal({ title: t('Export TIN'), body, buttons: [{ label: t('Export'), value: 'export', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 520, id: 'tin-export' });
    if (r !== 'export') return;
    try {
      const out = await exportFile(tin.value, form.value, { epsg: epsg.value ? +epsg.value : undefined });
      toast(t('Saved {file}', { file: out.name }), { kind: 'info' });
    } catch (e) {
      fail(e);
    }
  }

  async function rasterDialog() {
    if (!tins().length) return toast(t('No TIN: make one with New TIN or Import TIN first'), { kind: 'warn' });
    const tin = select(t('TIN'), tins().map((r) => [r.id, r.name]), active());
    const rec0 = recOf(tin.value);
    const post = numInp(t('Post spacing (m)'), String(Number((rec0.source.post ?? 1).toFixed(3))));
    const body = h('div', { 'data-id': 'tin:raster' }, field(t('TIN'), tin), field(t('Post spacing (m)'), post, t('Each post takes the height of the triangle it is in (linear interpolation); posts outside the TIN or in an exclusion area are voids.')));
    const r = await modal({ title: t('TIN to DEM'), body, buttons: [{ label: t('Make DEM'), value: 'make', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 480, id: 'tin-raster' });
    if (r !== 'make') return;
    try {
      const out = await toDem(tin.value, { postM: +post.value });
      toast(t('DEM {layer}: {w} × {h} posts of {s}', { layer: out.layer.rec.name, w: int(out.grid.width), h: int(out.grid.height), s: length(out.postM) }), { kind: 'info' });
    } catch (e) {
      fail(e);
    }
  }

  C.implement('tin.new', { enabled: () => app.terrain.dems.length > 0 || (app.pointClouds?.size ?? 0) > 0, run: () => newDialog() });
  C.implement('tin.editor', { enabled: () => tins().length > 0, run: () => editorDialog() });
  C.implement('tin.import', { run: () => importDialog() });
  C.implement('tin.export', { enabled: () => tins().length > 0, run: () => exportDialog() });
  C.implement('tin.raster', { enabled: () => tins().length > 0, run: () => rasterDialog() });
  C.implement('tin.view3d', {
    enabled: () => tins().length > 0,
    run: () =>
      show3d()
        .then((r) => toast(t('TIN in 3D: {n} triangles', { n: int(r.triangles) }), { kind: 'info' }))
        .catch(fail),
  });

  Object.assign(app.tin, { create, importFile, edit, sync, list, info, mesh, lines, heights, raster, toDem, exportFile, show3d, remove, setDisplay, snap, open: editorDialog, importDialog, ready, toPlane: toPlaneOf, toGeo: toGeoOf, active, setActive: (id) => (activeId = id), options: opts });
  sync().catch(fail);
}
