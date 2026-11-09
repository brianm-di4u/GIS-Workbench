// DEM tools (R2.4): non-destructive DEM editing (REQ-DEM-08/09), contour lines with index lines
// and labels (REQ-DEM-11), Save DEM As GeoTIFF/COG with vertical keys and DTED Level 1/2 full
// cells (REQ-DEM-16), the DEM accuracy report (REQ-DEM-17), the SMRF ground filter
// (REQ-DEM-07) and multi-pair DSM fusion (REQ-DEM-05).
//
// Edits: the source DEM is never changed. Each edit is a 'demedit' record in the store (the
// command log), so undo, redo and project files carry it; the edited surface is the source with
// the log replayed, pushed to the core terrain and, as sparse 256² tiles, to the decode worker
// for display.

import { writeQuantizedMesh, levelFor, tileRange, zipTileSet } from '../formats/qmesh-write.js';
import { minOf, maxOf } from '../core/util.js';
import { h } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { parseDelimited } from './workspace-tools.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { fromParts } from '../vector/geom.js';
import { groundOf, poly } from '../tools/tools.js';
import { openImageFile } from '../formats/open.js';
import { dtedCell, hgtCell } from '../formats/dem-writers.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { TILE, idx, postOf, postsIn, cellM, median, applyEdit, dirtyTiles, smrf, encodeEdits, blockRows } from '../analysis/dem-edit.js';
import { num, numMax, pct, int, height } from '../i18n/format.js';

export const name = 'dem-tools';

export { applyEdit, dirtyTiles, smrf, encodeEdits, blockRows } from '../analysis/dem-edit.js';

// ---- contours (marching squares) ----
/** Contour polylines [{level, index, pts: [[lon, lat, h]…]}] of a grid at an interval. */
export function contourLines(g, H, interval, { indexEvery = 5, maxLines = 20000, levels = null } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of H)
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  if (!Number.isFinite(lo)) return [];
  const out = [];
  // Explicit levels (a 0/1 mask is traced at 0.5 only), else every multiple of the interval.
  const levs = levels ?? [];
  if (!levels) for (let lev = Math.ceil(lo / interval) * interval; lev <= hi; lev += interval) levs.push(lev);
  for (const lev of levs) {
    // Segments per cell, keyed by edge for joining.
    const segs = [];
    for (let j = 0; j < g.height - 1; j++)
      for (let i = 0; i < g.width - 1; i++) {
        const v = [H[idx(g, i, j)], H[idx(g, i + 1, j)], H[idx(g, i + 1, j + 1)], H[idx(g, i, j + 1)]];
        if (!v.every(Number.isFinite)) continue;
        const code = (v[0] >= lev ? 8 : 0) | (v[1] >= lev ? 4 : 0) | (v[2] >= lev ? 2 : 0) | (v[3] >= lev ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const e = (a, b, pa, pb) => {
          const t = (lev - v[a]) / (v[b] - v[a]);
          return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
        };
        const P = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
        const top = () => e(0, 1, P[0], P[1]);
        const right = () => e(1, 2, P[1], P[2]);
        const bottom = () => e(3, 2, P[3], P[2]);
        const left = () => e(0, 3, P[0], P[3]);
        const T = {
          1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[top, right]], 5: [[left, top], [bottom, right]], 6: [[top, bottom]], 7: [[left, top]],
          8: [[left, top]], 9: [[top, bottom]], 10: [[top, right], [left, bottom]], 11: [[top, right]], 12: [[left, right]], 13: [[bottom, right]], 14: [[left, bottom]],
        }[code];
        for (const [fa, fb] of T) segs.push([fa(), fb()]);
      }
    // Join segments into polylines by shared end points.
    const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    const ends = new Map();
    segs.forEach((s, k) => {
      for (const e of [0, 1]) {
        const kk = key(s[e]);
        if (!ends.has(kk)) ends.set(kk, []);
        ends.get(kk).push(k);
      }
    });
    const used = new Uint8Array(segs.length);
    for (let s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      const line = [segs[s0][0], segs[s0][1]];
      for (const dir of [1, 0]) {
        for (;;) {
          const endp = dir ? line.at(-1) : line[0];
          const next = (ends.get(key(endp)) ?? []).find((k) => !used[k]);
          if (next === undefined) break;
          used[next] = 1;
          const s = segs[next];
          const other = key(s[0]) === key(endp) ? s[1] : s[0];
          if (dir) line.push(other);
          else line.unshift(other);
        }
      }
      if (line.length >= 3) out.push({ level: lev, index: Math.round(lev / interval) % indexEvery === 0, pts: line.map(([fi, fj]) => [g.lon0 + fi * g.dlon, g.lat0 - fj * g.dlat, lev]) });
      if (out.length >= maxLines) return out;
    }
  }
  return out;
}

// ---- accuracy (REQ-DEM-17) ----
/** Residuals e = DEM − checkpoint; [{id, e, class}] → statistics and the ASPRS statement. */
export function accuracyStats(res) {
  const all = res.filter((r) => Number.isFinite(r.e));
  const stats = (rs) => {
    if (!rs.length) return null;
    const e = rs.map((r) => r.e);
    const n = e.length;
    const mean = e.reduce((a, b) => a + b, 0) / n;
    const rmse = Math.sqrt(e.reduce((a, b) => a + b * b, 0) / n);
    const sd = Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
    const abs = e.map(Math.abs).sort((a, b) => a - b);
    const q = (p) => abs[Math.min(n - 1, Math.ceil(p * n) - 1)];
    const med = median(e);
    const nmad = 1.4826 * median(e.map((v) => Math.abs(v - med)));
    return { n, mean, bias: mean, sd, rmse, le90: 1.6449 * rmse, le90Empirical: q(0.9), p95: q(0.95), nmad, min: Math.min(...e), max: Math.max(...e) };
  };
  const nva = stats(all.filter((r) => !/^v|veg/i.test(r.class ?? '')));
  const vva = stats(all.filter((r) => /^v|veg/i.test(r.class ?? '')));
  const total = stats(all);
  const warnings = [];
  if (all.length < 30) warnings.push(t('Only {n, plural, one {# checkpoint} other {# checkpoints}}: ASPRS Positional Accuracy Standards Edition 2 (2023) ask for at least 30.', { n: all.length }));
  const cm = (v) => num(v * 100, 1);
  const statement = nva
    ? vva
      ? t('This data set was tested to meet ASPRS Positional Accuracy Standards for Digital Geospatial Data, Edition 2 (2023), for a {rmse} cm RMSEz vertical accuracy class. Actual NVA accuracy was found to be RMSEz = {rmse} cm; VVA RMSEz = {vva} cm, from {n, plural, one {# checkpoint} other {# checkpoints}}.', { rmse: cm(nva.rmse), vva: cm(vva.rmse), n: all.length })
      : t('This data set was tested to meet ASPRS Positional Accuracy Standards for Digital Geospatial Data, Edition 2 (2023), for a {rmse} cm RMSEz vertical accuracy class. Actual NVA accuracy was found to be RMSEz = {rmse} cm, from {n, plural, one {# checkpoint} other {# checkpoints}}.', { rmse: cm(nva.rmse), n: all.length })
    : t('No non-vegetated checkpoints: no ASPRS statement.');
  return { total, nva, vva, warnings, statement };
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const toast = (m, o) => app.toast(m, o);

  /** The terrain entry being edited: the active layer's, else the first editable one. */
  const target = () => {
    const al = pane()?.activeLayer();
    const e = (al && app.terrain.entry(al.id)) || app.terrain.dems.find((d) => d.aligned);
    return e && e.aligned ? e : null;
  };

  // ---- the command log drives the edited surface ----
  const sigs = new Map();
  const inflight = new Map();
  const geoOf = (g) => [g.width, g.height, g.lat0, g.lon0, g.dlat, g.dlon];
  /**
   * The edit log replayed over the source heights by the Rust kernels in an analysis worker
   * (REQ-DEM-08); the JS applyEdit is the fallback (and the differential oracle) when the worker
   * cannot run it.
   */
  async function replay(d, ops) {
    const src = d.grid.heights;
    if (!ops.length) return src;
    try {
      const r = await app.pool.run('dem.replay', { geo: geoOf(d.grid), ops: encodeEdits(ops), z: src.slice() }, { kind: 'analysis', label: t('DEM edits'), timeout: 300000 });
      demEngine = 'rust';
      return r.v;
    } catch (e) {
      if (e?.code === 'E_DEM_EDIT_KIND') throw e;
      app.log('warn', `DEM edit replay in the worker failed, replayed in JS: ${e?.message ?? e}`);
      demEngine = 'js';
      const H = src.slice();
      for (const op of ops) applyEdit(d.grid, H, op);
      return H;
    }
  }
  let demEngine = null;
  async function sync() {
    for (const d of app.terrain.dems) {
      if (!d.aligned || !d.grid) continue;
      const ops = S.all('demedit').filter((o) => o.layer === d.layerId).sort((a, b) => a.seq - b.seq);
      const sig = JSON.stringify(ops.map((o) => [o.id, o.seq]));
      if ((sigs.get(d.layerId) ?? '[]') === sig) {
        // The same log is being replayed already: wait for it, so edit() resolves on the new heights.
        await inflight.get(d.layerId);
        continue;
      }
      sigs.set(d.layerId, sig);
      const job = syncOne(d, ops, sig);
      inflight.set(d.layerId, job);
      try {
        await job;
      } finally {
        if (inflight.get(d.layerId) === job) inflight.delete(d.layerId);
      }
    }
  }
  async function syncOne(d, ops, sig) {
    const src = d.grid.heights;
    const H = await replay(d, ops);
    // A newer log started while this one ran: it applies its own result.
    if (sigs.get(d.layerId) !== sig) return;
    app.terrain.setHeights(d.layerId, ops.length ? H : src);
    d.current = ops.length ? H : null;
    const l = app.layers.get(d.layerId);
    if (l?.handle) {
      const tiles = ops.length ? dirtyTiles(d.grid, src, H) : [];
      await app.pool.run('overlay', { handle: l.handle, tiles }, { affinity: l.affinity, transfer: tiles.map((t) => t.data.buffer) });
      l.tiles.reset?.();
      l.stats = l.stats; // display statistics stay those of the source
      app.renderer?.invalidate();
    }
  }
  S.on('change', () => sync().catch((e) => toast(t('DEM edit: {msg}', { msg: msgOf(e) }), { kind: 'error' })));
  const heightsOf = (d) => d.current ?? d.grid.heights;

  /** Record one edit (undoable). */
  function edit(kind, params, d = target()) {
    if (!d) throw new Error('no editable DEM: use a DTED cell or a geographic GeoTIFF as terrain');
    const seq = S.all('demedit').filter((o) => o.layer === d.layerId).reduce((m, o) => Math.max(m, o.seq), 0) + 1;
    let id;
    S.transact(t('DEM {kind}', { kind }), (tx) => (id = tx.create('demedit', { layer: d.layerId, seq, kind, params, created: new Date().toISOString(), analyst: app.prefs.get('analyst') ?? 'analyst' })));
    return sync().then(() => id);
  }
  // ---- re-correlation inside a polygon (REQ-GAP-38) ----
  /** The stereo pair of the active panel (its stereo eyes, else its first two 3-D images). */
  const pairOf = () => {
    const s = pane()?.stereo;
    if (s) return [s.layer('L'), s.layer('R')];
    const ls = (pane()?.layers() ?? []).filter((l) => l.kind !== 'dem' && l.modelId && l.modelInfo?.is3d);
    return ls.length >= 2 ? ls.slice(0, 2) : null;
  };
  /**
   * Re-correlate the stereo pair inside a ring with the SGM path of Terrain Extraction (census,
   * 8-path SGM, left-right check; REQ-DEM-04) and record the matched heights as one undoable edit:
   * the DSM posts are the DEM's spacing, only matched posts (figure of merit ≥ 4) are kept, and
   * they are put in the DEM's vertical datum. opts: {preset, pair [L, R], postM, signal, onProgress}.
   */
  async function recorrelate(ring, { preset = 'default', pair = pairOf(), postM, signal, onProgress, d = target() } = {}) {
    if (!d) throw gwError('no editable DEM: use a DTED cell or a geographic GeoTIFF as terrain', null, 'E_DEM_NONE');
    if (!pair) throw gwError('re-correlation needs a stereo pair (two images with 3-D sensor models in the panel)', null, 'E_RECORR_PAIR');
    if (!Array.isArray(ring) || ring.length < 3) throw gwError('re-correlation needs an area of at least three corners', null, 'E_RECORR_RING');
    const g = d.grid;
    const lats = ring.map((q) => q[1]);
    const lons = ring.map((q) => q[0]);
    const aoi = { north: maxOf(lats) + 2 * g.dlat, south: minOf(lats) - 2 * g.dlat, west: minOf(lons) - 2 * g.dlon, east: maxOf(lons) + 2 * g.dlon };
    const [cx, cy] = cellM(g, (aoi.north + aoi.south) / 2);
    const dsm = await app.extractDsm(pair[0], pair[1], { aoi, preset, postM: postM ?? Math.min(cx, cy), signal, onProgress });
    const G = dsm.grid;
    if (G.nx * G.ny > 1e6) throw gwError('the area is {n} re-correlation posts; draw a smaller area', { n: String(G.nx * G.ny) }, 'E_RECORR_LARGE');
    const heights = new Array(G.nx * G.ny).fill(null);
    const ks = [];
    for (let k = 0; k < heights.length; k++) if (dsm.fom[k] >= 4 && Number.isFinite(dsm.heights[k])) ks.push(k);
    // HAE to the DEM's datum as its terrain converts it (#105), in one call.
    const N = app.terrain.separations(d.vertical, ks.map((k) => [G.lon0 + (k % G.nx) * G.dlon, G.lat0 - Math.floor(k / G.nx) * G.dlat]), !!d.gridV);
    ks.forEach((k, i) => (heights[k] = Math.round((dsm.heights[k] - N[i]) * 1000) / 1000));
    const matched = ks.length;
    if (!matched) throw gwError('re-correlation matched no posts in the area (low texture, occlusion or the wrong height range)', null, 'E_RECORR_NONE');
    const patch = { lat0: G.lat0, lon0: G.lon0, dlat: G.dlat, dlon: G.dlon, nx: G.nx, ny: G.ny, heights };
    const before = heightsOf(d).slice();
    const id = await edit('recorrelate', { ring, patch, pair: dsm.pair, preset, matchedFraction: matched / heights.length, engine: dsm.stats.engine, matcher: dsm.stats.matcher }, d);
    const after = heightsOf(d);
    let changed = 0;
    for (const q of postsIn(g, ring).posts) if (after[q.k] !== before[q.k]) changed++;
    return { id, matched, patchPosts: heights.length, changed, inside: postsIn(g, ring).posts.length, stats: dsm.stats };
  }

  // ---- Block Status (REQ-GAP-37) ----
  const BLOCK = TILE;
  /** Rows per 256² post block: {tx, ty, posts, voids, edited, maxChange, edits, status, by, at}. */
  async function blocks(d = target()) {
    if (!d) throw gwError('no editable DEM: use a DTED cell or a geographic GeoTIFF as terrain', null, 'E_DEM_NONE');
    const src = d.grid.heights;
    const cur = heightsOf(d);
    let rows;
    try {
      rows = await app.pool.run('dem.blocks', { geo: geoOf(d.grid), src: src.slice(), cur: cur.slice(), tile: BLOCK }, { kind: 'analysis', label: t('Block Status') });
    } catch (e) {
      app.log('warn', `Block status in the worker failed, computed in JS: ${e?.message ?? e}`);
      rows = blockRows(d.grid, src, cur, BLOCK);
    }
    const marks = new Map(S.all('demblock').filter((r) => r.layer === d.layerId).map((r) => [`${r.tx},${r.ty}`, r]));
    // Edits per block: the ring (or line, post, whole grid) bounding box in posts.
    const g = d.grid;
    const touch = new Map();
    for (const op of app.demEdit.log(d)) {
      const p = op.params ?? {};
      const pts = p.ring ?? p.line ?? (Number.isFinite(p.lat) ? [[p.lon, p.lat]] : null);
      let tx0 = 0;
      let tx1 = Math.ceil(g.width / BLOCK) - 1;
      let ty0 = 0;
      let ty1 = Math.ceil(g.height / BLOCK) - 1;
      if (pts) {
        const a = postOf(g, maxOf(pts.map((q) => q[1])), minOf(pts.map((q) => q[0])));
        const b = postOf(g, minOf(pts.map((q) => q[1])), maxOf(pts.map((q) => q[0])));
        tx0 = Math.max(0, Math.floor(a.i / BLOCK));
        tx1 = Math.min(tx1, Math.floor(b.i / BLOCK));
        ty0 = Math.max(0, Math.floor(a.j / BLOCK));
        ty1 = Math.min(ty1, Math.floor(b.j / BLOCK));
      }
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) touch.set(`${tx},${ty}`, (touch.get(`${tx},${ty}`) ?? 0) + 1);
    }
    return rows.map((r) => {
      const m = marks.get(`${r.tx},${r.ty}`);
      const state = m?.status ?? (r.edited > 0 ? 'edited' : 'unedited');
      return { ...r, edits: touch.get(`${r.tx},${r.ty}`) ?? 0, status: state, by: m?.analyst ?? null, at: m?.at ?? null };
    });
  }
  /** Mark blocks [[tx, ty]…] 'reviewed', 'accepted' or 'clear' (back to the computed state); one undo step. */
  function setBlockStatus(cells, status, d = target()) {
    if (!d) throw gwError('no editable DEM: use a DTED cell or a geographic GeoTIFF as terrain', null, 'E_DEM_NONE');
    if (!['reviewed', 'accepted', 'clear'].includes(status)) throw gwError('unknown block status "{status}"', { status: String(status) }, 'E_DEM_BLOCK_STATUS');
    const marks = new Map(S.all('demblock').filter((r) => r.layer === d.layerId).map((r) => [`${r.tx},${r.ty}`, r]));
    S.transact(t('Block status: {n, plural, one {# block} other {# blocks}}', { n: cells.length }), (tx) => {
      for (const [bx, by] of cells) {
        const m = marks.get(`${bx},${by}`);
        if (status === 'clear') {
          if (m) tx.delete(m.id);
        } else if (m) {
          tx.set(m.id, 'status', status);
          tx.set(m.id, 'at', new Date().toISOString());
        } else tx.create('demblock', { layer: d.layerId, tx: bx, ty: by, status, analyst: app.prefs.get('analyst') ?? 'analyst', at: new Date().toISOString() });
      }
    });
  }
  app.demEdit = { edit, sync, target, heightsOf, applyEdit, recorrelate, blocks, setBlockStatus, engine: () => demEngine, log: (d = target()) => S.all('demedit').filter((o) => o.layer === d?.layerId).sort((a, b) => a.seq - b.seq) };

  C.implement('dem.blockstatus', {
    enabled: () => !!target(),
    run: async () => {
      const d = target();
      if (!d) return toast(t('No editable DEM'), { kind: 'warn' });
      let rows;
      try {
        rows = await blocks(d);
      } catch (e) {
        return toast(msgOf(e), { kind: 'error' });
      }
      const label = { unedited: t('Unedited'), edited: t('Edited'), reviewed: t('Reviewed'), accepted: t('Accepted') };
      const sel = new Set();
      const checks = [];
      const tbody = h('tbody', {});
      const render = () => {
        tbody.replaceChildren(
          ...rows.map((r, k) => {
            const cb = h('input', { type: 'checkbox', style: { width: '18px', height: '18px', margin: '3px' }, 'aria-label': t('Block {x}, {y}', { x: r.tx, y: r.ty }), 'data-id': `dem:block:${r.tx}:${r.ty}` });
            cb.checked = sel.has(k);
            cb.addEventListener('change', () => (cb.checked ? sel.add(k) : sel.delete(k)));
            checks[k] = cb;
            return h('tr', { class: `blk-${r.status}` }, h('td', {}, cb), h('td', {}, `${r.tx}, ${r.ty}`), h('td', {}, int(r.posts)), h('td', {}, int(r.voids)), h('td', {}, int(r.edited)), h('td', {}, r.edited ? height(r.maxChange, 2) : '—'), h('td', {}, int(r.edits)), h('td', { 'data-id': `dem:block-status:${r.tx}:${r.ty}` }, label[r.status] ?? r.status));
          }),
        );
      };
      render();
      const totals = rows.reduce((a, r) => ({ edited: a.edited + (r.edited > 0 ? 1 : 0), voids: a.voids + (r.voids > 0 ? 1 : 0), done: a.done + (r.status === 'reviewed' || r.status === 'accepted' ? 1 : 0) }), { edited: 0, voids: 0, done: 0 });
      const table = h('table', { class: 'tbl', 'data-id': 'dem:blocks' }, h('thead', {}, h('tr', {}, ...['', t('Block (column, row)'), t('Posts'), t('Voids'), t('Edited posts'), t('Largest change'), t('Edits'), t('Status')].map((x) => h('th', {}, x)))), tbody);
      const body = h('div', {}, h('p', {}, t('{dem}: {n, plural, one {# block} other {# blocks}} of {size} × {size} posts; {edited} with edits, {voids} with voids, {done} reviewed or accepted.', { dem: d.name, n: rows.length, size: BLOCK, edited: totals.edited, voids: totals.voids, done: totals.done })), h('div', { class: 'scroll', style: 'max-height: 340px; overflow: auto' }, table), h('p', { class: 'hint' }, t('Tick blocks, then mark them. Marks are kept in the project and undo with Ctrl+Z.')));
      const r = await modal({
        title: t('Block Status'),
        body,
        buttons: [
          { label: t('Mark Reviewed'), value: 'reviewed', primary: true },
          { label: t('Mark Accepted'), value: 'accepted' },
          { label: t('Clear Mark'), value: 'clear' },
          { label: t('Close'), value: 'close' },
        ],
        width: 720,
        id: 'dem-blocks',
      });
      if (!['reviewed', 'accepted', 'clear'].includes(r) || !sel.size) return;
      const cells = [...sel].map((k) => [rows[k].tx, rows[k].ty]);
      setBlockStatus(cells, r, d);
      toast(t('Block status: {n, plural, one {# block} other {# blocks}} marked', { n: cells.length }), { kind: 'info' });
    },
  });

  // ---- DEM Edit dialog and tools (REQ-DEM-09) ----
  let pending = null; // {kind, params} waiting for an area
  app.tools.register({
    id: 'dem.area',
    cue: t('DEM edit area: click the corners; Enter or a double-click applies the edit.'),
    onDown(p, e, sx, sy) {
      const g = groundOf(app, p, sx, sy);
      if (!g) return true;
      (this.state.pts ??= []).push([g.lon, g.lat, g.h, sx, sy]);
      p.invalidate();
      return true;
    },
    onDblClick(p) {
      this.onEnter(p);
      return true;
    },
    onEnter() {
      const pts = this.state.pts ?? [];
      this.state = {};
      app.tools.done();
      if (!pending) return;
      const job = pending;
      pending = null;
      if (job.kind === 'breakline') {
        if (pts.length < 2) return;
        edit('breakline', { ...job.params, line: pts.map((q) => [q[0], q[1], Number.isFinite(job.params.h) ? job.params.h : q[2]]) }).catch((e) => toast(msgOf(e), { kind: 'error' }));
        return;
      }
      if (pts.length < 3) return;
      const ring = pts.map((q) => [q[0], q[1]]);
      if (job.kind === 'recorrelate') {
        toast(t('Re-correlating the area (Job Queue shows the tiles)'), { kind: 'info' });
        recorrelate(ring, job.params)
          .then((r) => toast(t('Re-correlated: {changed, plural, one {# post} other {# posts}} of {inside} changed; {share} of the patch matched', { changed: r.changed, inside: int(r.inside), share: pct(r.matched / r.patchPosts, 0) }), { kind: 'info' }))
          .catch((e) => toast(t('Re-correlation: {msg}', { msg: msgOf(e) }), { kind: ['E_RECORR_PAIR', 'E_RECORR_NONE', 'E_RECORR_LARGE', 'E_DSM_TOO_LARGE'].includes(e?.code) ? 'warn' : 'error' }));
        return;
      }
      edit(job.kind, { ...job.params, ring }).catch((e) => toast(msgOf(e), { kind: 'error' }));
    },
    draw(p, g, w, hh, s) {
      const pts = (s.pts ?? []).map((q) => ({ x: q[3], y: q[4] }));
      if (!pts.length) return;
      g.strokeStyle = '#00e5ff';
      g.setLineDash([5, 3]);
      poly(g, pts, true);
      g.stroke();
      g.setLineDash([]);
    },
  });
  app.tools.register({
    id: 'dem.query',
    cue: t('Post Query: click a post to see its source and edited heights and the edits that touched it.'),
    onDown(p, e, sx, sy) {
      const d = target();
      const g = groundOf(app, p, sx, sy);
      if (!d || !g) return true;
      const { i, j } = postOf(d.grid, g.lat, g.lon);
      const k = idx(d.grid, i, j);
      const src = d.grid.heights[k];
      const cur = heightsOf(d)[k];
      const hv = (v) => (Number.isFinite(v) ? height(v, 2) : t('void'));
      const args = { i, j, src: hv(src), cur: hv(cur), datum: d.vertical === 'hae' ? 'HAE' : 'MSL' };
      toast(src !== cur ? t('Post ({i}, {j}): source {src}, now {cur} ({datum}) — edited', args) : t('Post ({i}, {j}): source {src}, now {cur} ({datum})', args), { kind: 'info' });
      return true;
    },
  });
  C.implement('dem.edit', {
    enabled: () => !!target(),
    run: async () => {
      const d = target();
      if (!d) return toast(t('No editable DEM'), { kind: 'warn' });
      const kinds = { raise: t('Raise / lower (feathered)'), flatten: t('Flatten'), plane: t('Plane fit'), lake: t('Lake fill (islands kept)'), smooth: t('Smooth'), interpolate: t('Interpolate from the edge'), despike: t('Remove spikes and wells'), breakline: t('Breakline'), bareearth: t('Bare earth (ground filter in the area)'), recorrelate: t('Re-correlate the area from the stereo pair'), post: t('Post edit (at the stereo cursor or a height)') };
      const sel = h('select', { class: 'inp', 'aria-label': t('Edit') }, ...Object.entries(kinds).map(([k, v]) => h('option', { value: k }, v)));
      const numInp = (lab, v) => h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: v, 'aria-label': lab });
      const dh = numInp(t('Height change (m)'), '2');
      const fe = numInp(t('Feather (m)'), '5');
      const lv = numInp(t('Height or level (m, empty = automatic)'), '');
      const rad = numInp(t('Radius (posts)'), '2');
      const thr = numInp(t('Threshold (m)'), '5');
      const whole = h('input', { type: 'checkbox', style: { width: '18px', height: '18px', margin: '3px' }, 'aria-label': t('Whole DEM') });
      const obj = numInp(t('Largest object width (m)'), '30');
      const body = h('div', {}, field(t('Edit'), sel), field(t('Height change (m)'), dh), field(t('Feather (m)'), fe), field(t('Height or level (m)'), lv, t('Flatten, lake level, breakline or post height; empty: mean, lowest shoreline post, or the clicked heights.')), field(t('Smoothing radius (posts)'), rad), field(t('Spike threshold (m)'), thr), h('label', { class: 'fld fld-inline' }, whole, h('span', {}, t('Whole DEM (spike removal)'))), field(t('Largest object width (m)'), obj, t('Bare earth: the widest building or tree group to remove inside the area. Re-correlation matches the stereo pair of this panel again inside the area.')), h('p', { class: 'hint' }, t('Editing {dem}. The source file is never changed; edits are in the project and undo with Ctrl+Z.', { dem: d.name })));
      const r = await modal({
        title: t('DEM Edit'),
        body,
        buttons: [
          { label: t('Draw Area'), value: 'draw', primary: true },
          { label: t('Query Posts'), value: 'query' },
          { label: t('Cancel'), value: 'cancel' },
        ],
        id: 'dem-edit',
      });
      const level = lv.value === '' ? NaN : Number(lv.value);
      if (r === 'query') return app.tools.select('dem.query');
      if (r !== 'draw') return;
      const params = { raise: { dh: Number(dh.value), feather: Number(fe.value) }, flatten: { h: level }, plane: {}, lake: { level }, smooth: { radius: Number(rad.value) }, interpolate: {}, despike: { threshold: Number(thr.value) }, breakline: { h: level, width: 1 }, bareearth: { maxWindowM: Number(obj.value) || 30 }, recorrelate: { preset: 'default' } }[sel.value];
      if (sel.value === 'post') {
        const st = pane()?.stereo;
        const c = st?.cursor;
        if (!c && !Number.isFinite(level)) return toast(t('Post edit needs the stereo cursor or a height'), { kind: 'warn' });
        const g = c ?? (await new Promise((res) => {
          app.tools.register({ id: 'dem.pick', cue: t('Click the post to set.'), onDown(p, e, sx, sy) {
            res(groundOf(app, p, sx, sy));
            app.tools.done();
            return true;
          } });
          app.tools.select('dem.pick');
        }));
        if (g) await edit('post', { lat: g.lat, lon: g.lon, h: c ? c.h : level });
        return;
      }
      if (sel.value === 'despike' && whole.checked) return edit('despike', { threshold: Number(thr.value) });
      if (sel.value === 'recorrelate' && !pairOf()) return toast(t('Re-correlation needs a stereo pair (two images with 3-D sensor models in the panel)'), { kind: 'warn' });
      pending = { kind: sel.value, params };
      app.tools.select('dem.area');
    },
  });

  // ---- contour lines (REQ-DEM-11) ----
  app.contourLines = (interval, { indexEvery = 5, d = target() ?? app.terrain.dems[0] } = {}) => {
    if (!d?.grid) throw new Error('contour lines need a DEM loaded as terrain');
    const lines = contourLines(d.grid, heightsOf(d), interval, { indexEvery });
    // To HAE as the terrain converts this DEM (#105), all vertices in one call.
    const N = app.terrain.separations(d.vertical, lines.flatMap((c) => c.pts.map(([lon, lat]) => [lon, lat])), !!d.gridV);
    let at = 0;
    let id;
    S.transact(t('Contours {interval} m', { interval: numMax(interval, 3) }), (tx) => {
      id = tx.create('vlayer', { name: t('Contours {interval} m ({datum})', { interval: numMax(interval, 3), datum: d.vertical === 'hae' ? 'HAE' : 'MSL' }), visible: true, style: { stroke: '#d8a040', width: 1, fill: '#00000000', labelField: 'ELEV', labelWhen: 'INDEX', stereo: true }, fields: [{ name: 'ELEV', type: 'real' }, { name: 'INDEX', type: 'integer' }], source: { format: 'contours', dem: d.name }, created: new Date().toISOString() });
      for (const c of lines) tx.create('feature', { vlayer: id, geom: fromParts('LineString', [c.pts.map(([lon, lat, hh]) => [lon, lat, hh + N[at++]])]), attrs: { ELEV: c.level, INDEX: c.index ? 1 : 0 }, style: c.index ? { width: 2.2, stroke: '#ffcc66' } : null, name: `${c.level} m`, prov: { kind: 'contour', dem: d.name } });
    });
    return { layer: id, lines: lines.length, index: lines.filter((c) => c.index).length };
  };
  C.implement('dem.contourlines', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const inp = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', step: 'any', value: '5', 'aria-label': t('Interval (m)') });
      const ix = h('input', { class: 'inp inp-num', type: 'number', min: '2', step: '1', value: '5', 'aria-label': t('Index every') });
      if ((await modal({ title: t('Contour Lines'), body: h('div', {}, field(t('Interval (m)'), inp), field(t('Index line every'), ix, t('Index lines are thicker and labelled with their height.'))), buttons: [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'contour-lines' })) !== 'ok') return;
      try {
        const r = app.contourLines(Number(inp.value) || 5, { indexEvery: Number(ix.value) || 5 });
        toast(t('{n, plural, one {# contour line} other {# contour lines}} ({index, plural, one {# index line} other {# index lines}}); they also show in stereo panels', { n: r.lines, index: r.index }), { kind: 'info' });
      } catch (e) {
        toast(msgOf(e), { kind: 'error' });
      }
    },
  });

  // ---- Save DEM As (REQ-DEM-16) ----
  /** GeoTIFF/COG bytes of a terrain entry (current heights, its vertical datum). */
  app.demGeoTiff = async (d = target() ?? app.terrain.dems[0]) => {
    const g = d.grid;
    return writeGeoTiff({ width: g.width, height: g.height, bands: 1, type: 'f32', data: heightsOf(d) }, { epsg: 4326, vertical: d.vertical, geotransform: [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], nodata: NaN, overviews: true, tile: 256, description: `GIS Workbench DEM (${d.vertical === 'hae' ? 'heights above the WGS 84 ellipsoid' : 'orthometric heights'}, metres) from ${d.name}` });
  };
  /** DTED Level 1/2 cells (MSL EGM96, whole metres) covering the terrain: [{name, bytes}]. */
  app.demDted = (level = 2, d = target() ?? app.terrain.dems[0]) => {
    const g = d.grid;
    const H = heightsOf(d);
    const south = g.lat0 - g.dlat * (g.height - 1);
    const east = g.lon0 + g.dlon * (g.width - 1);
    const cells = [];
    for (let la = Math.floor(south); la <= Math.floor(g.lat0 - 1e-9); la++) for (let lo = Math.floor(g.lon0); lo <= Math.floor(east - 1e-9); lo++) cells.push([la, lo]);
    return cells.map(([la, lo]) => ({ name: `${lo < 0 ? 'w' : 'e'}${String(Math.abs(lo)).padStart(3, '0')}_${la < 0 ? 's' : 'n'}${String(Math.abs(la)).padStart(2, '0')}.dt${level}`, bytes: dtedCell(app, g, H, d.vertical, la, lo, level) }));
  };
  /** SRTM HGT tiles (1″ 3601² or 3″ 1201², MSL EGM96, whole metres) covering the terrain: [{name, bytes}]. */
  app.demHgt = (arcsec = 1, d = target() ?? app.terrain.dems[0]) => {
    const g = d.grid;
    const H = heightsOf(d);
    const south = g.lat0 - g.dlat * (g.height - 1);
    const east = g.lon0 + g.dlon * (g.width - 1);
    const cells = [];
    for (let la = Math.floor(south); la <= Math.floor(g.lat0 - 1e-9); la++) for (let lo = Math.floor(g.lon0); lo <= Math.floor(east - 1e-9); lo++) cells.push([la, lo]);
    return cells.map(([la, lo]) => ({ name: `${la < 0 ? 'S' : 'N'}${String(Math.abs(la)).padStart(2, '0')}${lo < 0 ? 'W' : 'E'}${String(Math.abs(lo)).padStart(3, '0')}.hgt`, bytes: hgtCell(app, g, H, d.vertical, la, lo, arcsec) }));
  };
  /**
   * Quantized-mesh terrain (REQ-FMT-39) of a terrain entry: {zip, files, layer, tiles, folder}.
   * opts: {mercator, maxZoom (default: about the DEM's post spacing, capped at 4096 tiles), maxError}.
   */
  app.demQuantizedMesh = async (d = target() ?? app.terrain.dems[0], { mercator = false, maxZoom, maxError = 1, normals = true, maxTiles = 4096 } = {}) => {
    const g = d.grid;
    const bounds = { ...d.bounds };
    let z = maxZoom ?? levelFor(Math.min(g.dlat, g.dlon), 65, mercator);
    const count = (zz) => {
      let n = 0;
      for (let k = 0; k <= zz; k++) {
        const r = tileRange(k, bounds, mercator);
        n += (r.endX - r.startX + 1) * (r.endY - r.startY + 1);
      }
      return n;
    };
    while (maxZoom === undefined && z > 0 && count(z) > maxTiles) z--;
    const folder = `${(app.layers.get(d.layerId)?.rec?.name ?? 'dem').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_')}_qmesh_${mercator ? '3857' : '4326'}`;
    const encode = async (zz, prm) => (await app.pool.run('qmesh.tile', { z: zz, prm }, { kind: 'analysis', transfer: [zz.buffer], label: t('quantized-mesh tile') })).bytes;
    const r = await writeQuantizedMesh((lat, lon) => app.core.demHae(d.coreId, lat, lon), encode, { bounds, mercator, maxZoom: z, maxError, normals, name: folder });
    return { ...r, folder, zip: zipTileSet(r.files, folder) };
  };
  C.implement('dem.save', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const d = target() ?? app.terrain.dems[0];
      const fmt = h('select', { class: 'inp', 'aria-label': t('Format') }, h('option', { value: 'tif' }, t('GeoTIFF / COG (float32, vertical keys)')), h('option', { value: 'dt2' }, t('DTED Level 2 (full cells, MSL)')), h('option', { value: 'dt1' }, t('DTED Level 1 (full cells, MSL)')), h('option', { value: 'hgt1' }, t('SRTM HGT 1″ (3601 × 3601 tiles, MSL)')), h('option', { value: 'hgt3' }, t('SRTM HGT 3″ (1201 × 1201 tiles, MSL)')), h('option', { value: 'qm4326' }, t('Quantized-mesh terrain, {crs} (ZIP: tiles + layer.json, HAE)', { crs: 'EPSG:4326' })), h('option', { value: 'qm3857' }, t('Quantized-mesh terrain, {crs} (ZIP: tiles + layer.json, HAE)', { crs: 'EPSG:3857' })));
      const buttons = [{ label: t('Save'), value: 'save', primary: true }, { label: t('Cancel'), value: 'cancel' }];
      if ((await modal({ title: t('Save DEM As — {dem}', { dem: d.name }), body: field(t('Format'), fmt), buttons, id: 'dem-save' })) !== 'save') return;
      try {
        if (fmt.value === 'tif') {
          const bytes = await app.demGeoTiff(d);
          await saveBlob(app, new Blob([bytes], { type: 'image/tiff' }), { name: `${(app.layers.get(d.layerId)?.rec?.name ?? 'dem').replace(/\.[^.]+$/, '')}_edited.tif`, description: 'GeoTIFF' });
        } else if (fmt.value.startsWith('qm')) {
          const r = await app.demQuantizedMesh(d, { mercator: fmt.value === 'qm3857' });
          await saveBlob(app, new Blob([r.zip], { type: 'application/zip' }), { name: `${r.folder}.zip`, types: ['.zip'], description: t('Quantized-mesh terrain (ZIP)') });
          toast(t('Quantized-mesh: {n, plural, one {# tile} other {# tiles}}, levels 0–{max} ({projection})', { n: r.tiles, max: r.layer.maxzoom, projection: r.layer.projection }), { kind: 'info' });
        } else if (fmt.value.startsWith('hgt')) {
          for (const c of app.demHgt(fmt.value === 'hgt1' ? 1 : 3, d)) await saveBlob(app, new Blob([c.bytes]), { name: c.name, description: 'SRTM HGT' });
        } else {
          for (const c of app.demDted(fmt.value === 'dt2' ? 2 : 1, d)) await saveBlob(app, new Blob([c.bytes]), { name: c.name, description: 'DTED' });
        }
      } catch (e) {
        toast(msgOf(e), { kind: 'error' });
      }
    },
  });

  // ---- DEM accuracy (REQ-DEM-17) ----
  /** Checkpoints [{id, lat, lon, h, vertical: 'hae'|'msl', class}] against a terrain → report. */
  app.demAccuracy = (points, d = target() ?? app.terrain.dems[0]) => {
    const res = points.map((p) => {
      const t = app.core.demHae(d.coreId, p.lat, p.lon);
      const hae = p.vertical === 'msl' ? p.h + app.core.undulation(p.lat, p.lon) : p.h;
      return { id: p.id, class: p.class ?? '', dem: t, check: hae, e: t - hae };
    });
    return { dem: d.name, residuals: res, ...accuracyStats(res) };
  };
  C.implement('dem.accuracy', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const [f] = await pickFiles(app, { multiple: false, accept: ['.csv', '.txt'], description: t('Checkpoints ({columns})', { columns: 'id, lat, lon, h, class' }) });
      if (!f) return;
      const { rows } = parseDelimited(await f.text());
      const head = rows[0].map((c) => c.trim().toLowerCase());
      const col = (...n) => head.findIndex((c) => n.includes(c));
      const ci = { id: col('id', 'name'), lat: col('lat', 'latitude'), lon: col('lon', 'long', 'longitude'), h: col('h', 'hae', 'height', 'z', 'elev', 'msl'), cls: col('class', 'landcover', 'type'), v: col('vertical', 'datum') };
      const msl = head[ci.h] === 'msl';
      const pts = rows.slice(1).map((r) => ({ id: r[ci.id], lat: +r[ci.lat], lon: +r[ci.lon], h: +r[ci.h], class: ci.cls >= 0 ? r[ci.cls] : '', vertical: ci.v >= 0 ? (/msl|egm/i.test(r[ci.v]) ? 'msl' : 'hae') : msl ? 'msl' : 'hae' })).filter((p) => [p.lat, p.lon, p.h].every(Number.isFinite));
      const rep = app.demAccuracy(pts);
      const fmt = (s) => (s ? t('n {n} · bias {bias} m · RMSEz {rmse} m · LE90 {le90} m (1.6449·RMSE) / {le90e} m (empirical 90th percentile) · NMAD {nmad} m', { n: s.n, bias: num(s.bias, 3), rmse: num(s.rmse, 3), le90: num(s.le90, 3), le90e: num(s.le90Empirical, 3), nmad: num(s.nmad, 3) }) : '—');
      await modal({ title: t('DEM Accuracy — {dem}', { dem: rep.dem }), body: h('div', { 'data-id': 'dem:accuracy' }, ...rep.warnings.map((w) => h('p', { class: 'warn' }, w)), h('p', {}, t('All: {stats}', { stats: fmt(rep.total) })), h('p', {}, t('NVA (non-vegetated): {stats}', { stats: fmt(rep.nva) })), h('p', {}, t('VVA (vegetated): {stats}', { stats: fmt(rep.vva) })), h('p', { class: 'hint' }, rep.statement)), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 640, id: 'dem-accuracy' });
    },
  });

  // ---- ground filter (REQ-DEM-07) ----
  app.groundFilter = async (opts = {}, d = target() ?? app.terrain.dems[0]) => {
    const g = d.grid;
    const { dtm, ground } = smrf(g, heightsOf(d), opts);
    const bytes = await writeGeoTiff({ width: g.width, height: g.height, bands: 1, type: 'f32', data: dtm }, { epsg: 4326, vertical: d.vertical, geotransform: [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], nodata: NaN, description: `GIS Workbench DTM (SMRF ground filter) from ${d.name}` });
    const file = new File([bytes], `DTM_${(app.layers.get(d.layerId)?.rec?.name ?? 'dem').replace(/\.[^.]+$/, '')}.tif`, { type: 'image/tiff' });
    const { layers } = await openImageFile(app, file);
    await app.useAsTerrain(layers[0], d.vertical);
    const te = app.terrain.entry(layers[0].id);
    if (te) te.kind = 'DTM';
    return { layer: layers[0], groundFraction: ground.reduce((a, b) => a + b, 0) / ground.length, dtm };
  };
  C.implement('dem.groundfilter', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const numInp = (v) => h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: v });
      const win = numInp('30');
      const sl = numInp('0.15');
      const ht = numInp('0.5');
      const body = h('div', {}, field(t('Largest object width (m)'), win, t('The widest building or tree group to remove (the opening window).')), field(t('Slope threshold (rise/run)'), sl), field(t('Height threshold (m)'), ht, t('Posts within this height of the ground surface (plus the slope allowance) are ground.')));
      if ((await modal({ title: t('Ground Filter (SMRF)'), body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'ground-filter' })) !== 'run') return;
      try {
        const r = await app.groundFilter({ maxWindowM: +win.value, slope: +sl.value, height: +ht.value });
        toast(t('DTM {layer}: {share} of posts are ground', { layer: r.layer.rec.name, share: pct(r.groundFraction, 0) }), { kind: 'info' });
      } catch (e) {
        toast(msgOf(e), { kind: 'error' });
      }
    },
  });

  // ---- multi-pair fusion (REQ-DEM-05) ----
  /** Median of several DSMs from extractDsm on the first one's grid. */
  app.fuseDsms = (dsms) => {
    const base = dsms[0];
    const g = base.grid;
    const n = g.nx * g.ny;
    const heights = new Float32Array(n).fill(NaN);
    const fom = new Uint8Array(n);
    const vals = [];
    for (let k = 0; k < n; k++) {
      const iy = Math.floor(k / g.nx);
      const ix = k % g.nx;
      const lat = g.lat0 - iy * g.dlat;
      const lon = g.lon0 + ix * g.dlon;
      vals.length = 0;
      let best = 0;
      for (const d of dsms) {
        const jx = Math.round((lon - d.grid.lon0) / d.grid.dlon);
        const jy = Math.round((d.grid.lat0 - lat) / d.grid.dlat);
        if (jx < 0 || jy < 0 || jx >= d.grid.nx || jy >= d.grid.ny) continue;
        const kk = jy * d.grid.nx + jx;
        if (d.fom[kk] >= 4 && Number.isFinite(d.heights[kk])) vals.push(d.heights[kk]);
        best = Math.max(best, d.fom[kk]);
      }
      if (vals.length) heights[k] = median(vals);
      fom[k] = vals.length ? best : Math.max(...dsms.map(() => 0));
    }
    return { ...base, heights, fom, pair: [...new Set(dsms.flatMap((d) => d.pair))], stats: { ...base.stats, fused: dsms.length } };
  };
  void section;
}
