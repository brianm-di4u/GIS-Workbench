// The 3D pane for terrain (REQ-STR-11..14; D18): a DEM as an RTIN mesh (Rust, in a worker) in
// the shared local frame, the image draped through its sensor model, vertical exaggeration,
// Orbit / Free / Route navigation, a 3D cursor with mensuration and 3D line of sight, glTF/GLB
// models, and fly-through recording to WebM. Point clouds share the same view (pointcloud.js).

import { compressGlb } from '../formats/gltf-compress.js';
import { codecEncoders, hasCodecPack } from '../formats/codec-pack.js';
import { h } from '../shell/dom.js';
import { loadQuantizedMesh, localTiles } from '../render/qmesh.js';
import { localServer, syntheticTileset } from '../render/tiles3d.js';
import { unzipSync } from 'fflate';
import { openModelFile } from './imaging-lazy.js'; // the COLLADA reader is in the lazy js-imaging block
import { modal, field } from '../shell/dialogs.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { View3D } from '../render/view3d.js';
import { parts, isLinear } from '../vector/geom.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { num, length, height, list } from '../i18n/format.js';

export const name = 'scene3d';

/** Errors that ask the user to do something first: guidance (a warning), not a failure (GUI-053). */
const STEP_CODES = new Set(['E_NO_TERRAIN', 'E_ROUTE_NEEDS_LINE', 'E_QMESH_NEEDS_BOX', 'E_URL_MISSING']);
/** Buttons of a plain OK/Cancel dialog, compared by value. */
const okCancel = () => [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }];

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const view = (p = pane()) => p?.view3d ?? null;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(msgOf(e), { kind: STEP_CODES.has(e?.code) ? 'warn' : 'error', ms: 8000 });
    }
  };

  async function ensureView(p = pane()) {
    if (!p.view3d) p.view3d = await View3D.create(app, p);
    app.emit('state');
    return p.view3d;
  }

  /**
   * Terrain from a terrain entry over its bounds (or `box` = [south, west, north, east]):
   * resampled to (2^k + 1)² posts (HAE from the core), meshed by RTIN to `maxError` m, draped
   * with `image` (a layer with a sensor model) at up to `texture` pixels.
   */
  async function openTerrain({ p = pane(), dem = null, image = null, box = null, size = 513, maxError = 0.5, texture = 2048, exaggeration = 1 } = {}) {
    dem ??= app.terrain.dems[0];
    if (!dem) throw gwError('no terrain: use a DEM as terrain first', null, 'E_NO_TERRAIN');
    const b = dem.bounds;
    const [s, w, n, e] = box ?? [b.south, b.west, b.north, b.east];
    const dlat = (n - s) / (size - 1);
    const dlon = (e - w) / (size - 1);
    const heights = new Float32Array(size * size);
    let fillv = NaN;
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const v = app.core.demHae(dem.coreId, n - j * dlat, w + i * dlon);
        heights[j * size + i] = v;
        if (Number.isFinite(v) && !Number.isFinite(fillv)) fillv = v;
      }
    // A terrain entry that covers none of the box (all voids) would mesh NaN positions (THREE refuses them).
    if (!Number.isFinite(fillv)) throw gwError('{terrain} has no heights over this area', { terrain: dem.name }, 'E_TERRAIN_NO_HEIGHTS');
    for (let k = 0; k < heights.length; k++) if (!Number.isFinite(heights[k])) heights[k] = fillv;
    const t0 = performance.now();
    const mesh = await app.pool.run('rtin', { z: heights.slice(), size, maxError }, { kind: 'analysis', label: t('terrain mesh'), timeout: 120000 });
    const meshMs = performance.now() - t0;
    const grid = { lat0: n, lon0: w, dlat, dlon, size };
    let drape = null;
    if (image?.modelId) drape = await drapeFor(image, grid, heights, mesh, texture);
    const v = await ensureView(p);
    const entry = v.addTerrain({ grid, heights, mesh, drape, name: dem.name });
    if (exaggeration !== 1) v.setExaggeration(exaggeration);
    entry.meshMs = meshMs;
    return entry;
  }

  /** Texture and UVs from an image: vertex lat/lon/HAE → image pixels; a decimated chip. */
  async function drapeFor(l, grid, heights, mesh, maxTex) {
    const nv = mesh.xy.length / 2;
    const pts = new Float64Array(3 * nv);
    for (let k = 0; k < nv; k++) {
      const i = mesh.xy[2 * k];
      const j = mesh.xy[2 * k + 1];
      pts[3 * k] = grid.lat0 - j * grid.dlat;
      pts[3 * k + 1] = grid.lon0 + i * grid.dlon;
      pts[3 * k + 2] = heights[j * grid.size + i];
    }
    const xy = app.core.g2iBatch(l.modelId, pts);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < nv; k++) {
      const x = xy[2 * k];
      const y = xy[2 * k + 1];
      if (!Number.isFinite(x)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(l.width, Math.ceil(x1));
    y1 = Math.min(l.height, Math.ceil(y1));
    if (!(x1 > x0 && y1 > y0)) throw new Error('the terrain lies outside the image');
    const step = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / maxTex));
    const nb = Math.min(3, l.bands);
    const bands = [...Array(nb).keys()].map((b) => l.chain?.bands?.[b] ?? b);
    const r = await app.pool.run('window', { handle: l.handle, x0, y0, w: Math.ceil((x1 - x0) / step), h: Math.ceil((y1 - y0) / step), step, bands }, { affinity: l.affinity, timeout: 300000 });
    const W = r.w;
    const H = r.h;
    const data = new Uint8Array(W * H * 4);
    const st = l.stats ?? [];
    for (let c = 0; c < 3; c++) {
      const bi = Math.min(c, nb - 1); // one or two bands: the last one fills the remaining channels (GUI-043)
      const src = r.planes[bi];
      const lo = st[bands[bi]]?.p2 ?? st[bands[bi]]?.min ?? 0;
      const hi = st[bands[bi]]?.p98 ?? st[bands[bi]]?.max ?? 255;
      for (let k = 0; k < W * H; k++) data[4 * k + c] = Math.max(0, Math.min(255, Math.round((255 * (src[k] - lo)) / Math.max(1e-6, hi - lo))));
    }
    for (let k = 0; k < W * H; k++) data[4 * k + 3] = 255;
    const uv = new Float32Array(2 * nv);
    for (let k = 0; k < nv; k++) {
      uv[2 * k] = (xy[2 * k] - x0) / (W * step);
      uv[2 * k + 1] = (xy[2 * k + 1] - y0) / (H * step);
    }
    return { data, width: W, height: H, uv, image: l.rec.name, step };
  }

  /** 3D measurement between two local points of the view (horizontal geodesic, Δh, slant). */
  function measure(v, a, b) {
    const ga = v.toGeo(...a);
    const gb = v.toGeo(...b);
    const inv = app.core.inverse(ga.lat, ga.lon, gb.lat, gb.lon);
    const dz = b[2] - a[2];
    return { horizontal: inv.distance, dz, slant: Math.hypot(inv.distance, dz), azimuth: inv.azi1, slopeDeg: (Math.atan2(dz, inv.distance) * 180) / Math.PI, a: ga, b: gb };
  }

  /** A route in the view's frame from a selected line feature. */
  function routeFromFeature(v, f) {
    if (!f || !isLinear(f.geom)) throw gwError('select a line feature for the route', null, 'E_ROUTE_NEEDS_LINE');
    return parts(f.geom)[0].map(([lon, lat, z]) => [...v.toLocal(lat, lon), z]);
  }

  app.scene3d = { openTerrain, drapeFor, measure, routeFromFeature, ensureView };

  // ---- commands ----
  const has = () => !!view();
  C.implement('3d.open', {
    enabled: () => app.terrain?.available || app.pointClouds?.size > 0,
    run: run(async () => {
      const p = pane();
      const img = p.geoLayer?.();
      const dem = app.terrain.dems.find((d) => d.kind !== 'DSM') ?? app.terrain.dems[0];
      const ex = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', max: '20', step: '0.1', value: '1', 'aria-label': t('Vertical exaggeration') });
      const err = h('input', { class: 'inp inp-num', type: 'number', min: '0.05', step: 'any', value: '0.5', 'aria-label': t('Mesh error (m)') });
      const body = h('div', {}, field(t('Terrain'), h('span', {}, dem?.name ?? t('none'))), field(t('Drape'), h('span', {}, img?.modelId ? img.rec.name : t('none (elevation colours)'))), field(t('Vertical exaggeration'), ex), field(t('Mesh error (m)'), err, t('RTIN: smaller is finer.')));
      if ((await modal({ title: t('Open 3D View'), body, buttons: okCancel(), id: '3d-open' })) !== 'ok') return;
      const ter = await openTerrain({ p, dem, image: img?.modelId ? img : null, exaggeration: Number(ex.value) || 1, maxError: Number(err.value) || 0.5 });
      app.toast(ter.draped ? t('3D terrain: {n, plural, one {# triangle} other {# triangles}}, draped with {image}', { n: ter.triangles, image: img.rec.name }) : t('3D terrain: {n, plural, one {# triangle} other {# triangles}}', { n: ter.triangles }), { kind: 'info' });
    }),
  });
  C.implement('3d.close', { enabled: has, run: () => app.pc?.close() });
  C.implement('3d.exag', {
    enabled: has,
    run: run(async () => {
      const v = view();
      const ex = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', max: '20', step: '0.1', value: String(v.exaggeration), 'aria-label': t('Vertical exaggeration') });
      if ((await modal({ title: t('Vertical Exaggeration'), body: field(t('Factor'), ex), buttons: okCancel(), id: '3d-exag' })) !== 'ok') return;
      v.setExaggeration(Number(ex.value) || 1);
    }),
  });
  C.implement('3d.navorbit', { enabled: has, checked: () => (view()?.nav ?? 'orbit') === 'orbit', run: () => view()?.setNavigation('orbit') });
  C.implement('3d.navfree', { enabled: has, checked: () => view()?.nav === 'free', run: () => view()?.setNavigation('free') });
  C.implement('3d.navroute', {
    enabled: () => has() && [...app.selection].some((id) => S.get(id)?.type === 'feature'),
    run: run(async () => {
      const v = view();
      const f = S.get([...app.selection].find((id) => S.get(id)?.type === 'feature'));
      v.setNavigation('route', { route: routeFromFeature(v, f), height: 80, speed: 60 });
    }),
  });
  const twoClicks = (v, onPair, pick = (sx, sy) => v.pickSurface(sx, sy)) => {
    const pts = [];
    let down = null;
    v.tool = {
      pointerdown: (e) => (down = { x: e.clientX, y: e.clientY }),
      pointerup: (e) => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        const r = v.canvas.getBoundingClientRect();
        const q = pick(e.clientX - r.left, e.clientY - r.top);
        if (!q) return;
        pts.push(q);
        v.setOverlay(pts.map((x) => ({ kind: 'marker', points: [x] })));
        if (pts.length === 2) {
          v.tool = null;
          onPair(pts[0], pts[1]);
        }
      },
    };
  };
  C.implement('3d.measure', {
    enabled: has,
    run: run(async () => {
      const v = view();
      app.toast(t('3D cursor: click two points on the terrain'), { kind: 'info' });
      twoClicks(v, (a, b) => {
        const m = measure(v, a, b);
        app.scene3d.last = m;
        v.setOverlay([{ kind: 'line', points: [a, b] }, { kind: 'marker', points: [a, b] }]);
        app.toast(t('3D {slant} · horizontal {horizontal} · Δh {dz} · slope {slope}°', { slant: length(m.slant, 2), horizontal: length(m.horizontal, 2), dz: height(m.dz, 2), slope: num(m.slopeDeg, 1) }), { kind: 'info', ms: 10000 });
      });
    }),
  });
  C.implement('3d.los', {
    enabled: () => has() && view()?.terrains.length > 0,
    run: run(async () => {
      const v = view();
      app.toast(t('3D line of sight: click the observer, then the target (2 m above the ground)'), { kind: 'info' });
      twoClicks(v, (a, b) => {
        const A = [a[0], a[1], a[2] + 2];
        const B = [b[0], b[1], b[2] + 2];
        const r = v.lineOfSight(A, B);
        app.scene3d.lastLos = r;
        v.setOverlay([{ kind: 'line', points: [A, r.blockedAt ?? B], colour: 0x00e676 }, ...(r.blockedAt ? [{ kind: 'line', points: [r.blockedAt, B], colour: 0xff1744 }] : []), { kind: 'marker', points: [A, B] }]);
        app.toast(r.visible ? t('Visible: clearance {clearance} over {distance}', { clearance: height(r.clearance, 1), distance: length(r.distance, 0) }) : t('Blocked {distance} from the observer', { distance: length(Math.hypot(r.blockedAt[0] - A[0], r.blockedAt[1] - A[1]), 0) }), { kind: 'info', ms: 10000 });
      });
    }),
  });
  C.implement('3d.import', {
    run: run(async () => {
      const [f, ...rest] = await pickFiles(app, { multiple: true, accept: ['.glb', '.gltf', '.dae', '.kmz', '.png', '.jpg', '.jpeg'], description: t('3D models (glTF, COLLADA, KMZ)') });
      if (!f) return;
      const v = await ensureView();
      // COLLADA and model KMZ (REQ-GAP-34) through hub/mesh-import.js; textures picked with them.
      const m = /\.(dae|kmz)$/i.test(f.name) ? await openModelFile(app, f, rest) : await v.addGltf(new Uint8Array(await f.arrayBuffer()), f.name);
      app.toast(t('{file}: {n, plural, one {# mesh} other {# meshes}}, placed by its {by, select, origin {origin} other {centre}}', { file: f.name, n: m.meshes, by: m.placedBy }), { kind: 'info' });
    }),
  });
  // ---- Sync Always (REQ-STR-11): the 3D target follows the 2D panel's ground centre and back ----
  const sync = { on: false, busy: false, raf: 0 };
  const allPanes = () => (app.desktop?.multiports ?? []).flatMap((mp) => mp.panes);
  const threeD = () => view() ?? allPanes().find((p) => p.view3d)?.view3d ?? null;
  const twoD = () => allPanes().find((p) => !p.view3d && !p.video && p.geoLayer?.()?.modelId);
  function syncFrom2d(p2) {
    const v = threeD();
    if (!sync.on || sync.busy || !v?.origin || !p2 || p2.view3d) return;
    const l = p2.geoLayer?.();
    const t = v.controls.target;
    // The panel centre's ray meets the terrain (or the 3D target's height when there is none).
    let z = Number.isFinite(t.z) ? t.z : 0;
    let g = l?.groundAt?.(p2.view.cx, p2.view.cy, z);
    for (let k = 0; g && k < 4; k++) {
      const s = app.terrain?.sample?.(g.lat, g.lon)?.hae;
      if (!Number.isFinite(s) || Math.abs(s - z) < 0.05) break;
      z = s;
      g = l.groundAt(p2.view.cx, p2.view.cy, z);
    }
    if (!g) return;
    const [e, n] = v.toLocal(g.lat, g.lon);
    const d = [e - t.x, n - t.y, z - t.z];
    if (Math.hypot(...d) < 0.01) return;
    sync.busy = true;
    try {
      v.camera.position.set(v.camera.position.x + d[0], v.camera.position.y + d[1], v.camera.position.z + d[2]);
      t.set(e, n, z);
      v.controls.update();
      v.invalidate();
    } finally {
      sync.busy = false;
    }
    sync.last = { from: '2d', lat: g.lat, lon: g.lon };
  }
  function syncFrom3d() {
    const v = threeD();
    const p2 = twoD();
    if (!sync.on || sync.busy || !v?.origin || !p2) return;
    cancelAnimationFrame(sync.raf);
    sync.raf = requestAnimationFrame(() => {
      const t = v.controls.target;
      const g = v.toGeo(t.x, t.y, t.z);
      const l = p2.geoLayer();
      let q;
      try {
        q = app.core.g2i(l.modelId, g.lat, g.lon, g.hae);
      } catch {
        return;
      }
      if (!Number.isFinite(q?.x) || Math.hypot(q.x - p2.view.cx, q.y - p2.view.cy) < 0.05) return;
      sync.busy = true;
      try {
        p2.setView({ cx: q.x, cy: q.y }, { link: false });
      } finally {
        sync.busy = false;
      }
      sync.last = { from: '3d', lat: g.lat, lon: g.lon };
    });
  }
  app.on('view', (p2) => syncFrom2d(p2));
  function setSyncAlways(on) {
    sync.on = on;
    const v = threeD();
    if (on && v && !v._syncBound) {
      v._syncBound = true;
      v.controls.addEventListener('change', () => syncFrom3d());
    }
    if (on) syncFrom2d(twoD());
    app.emit('state');
  }
  C.implement('3d.syncalways', { enabled: () => !!threeD(), checked: () => sync.on, run: () => setSyncAlways(!sync.on) });
  app.scene3d.sync = { set: setSyncAlways, state: sync };

  // OGC 3D Tiles from an online source (REQ-STR-15): the origin must be allowed.
  async function addTiles(url, { p = pane(), maxSse = 16 } = {}) {
    const v = await ensureView(p);
    const t = await v.addTileset(url, app.netlog.fetchFor(`3D Tiles: ${new URL(url).host}`), { maxSse, name: url.split('/').slice(-2).join('/') });
    app.emit('state');
    return t;
  }
  app.scene3d.addTiles = addTiles;
  /** A .3tz archive (3D Tiles in one ZIP, local): the tiles are served from memory. */
  async function addTilesArchive(file, { p = pane(), maxSse = 16 } = {}) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const root = Object.keys(files).find((k) => /(^|\/)tileset\.json$/.test(k) && k.split('/').length <= 2);
    if (!root) throw gwError('{file}: no tileset.json in the archive', { file: file.name }, 'E_3TZ_NO_TILESET');
    const base = `https://3tz.invalid/${root}`;
    const serve = async (url) => {
      const path = decodeURIComponent(new URL(url).pathname.slice(1));
      const b = files[path];
      if (!b) return new Response('', { status: 404 });
      // 3TZ entries may be gzip-compressed on their own (Content-Encoding gzip in a web server).
      if (b[0] === 0x1f && b[1] === 0x8b) return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip')), { status: 200 });
      return new Response(b, { status: 200 });
    };
    const v = await ensureView(p);
    const t = await v.addTileset(base, serve, { maxSse, name: file.name });
    await t.settle();
    app.emit('state');
    return t;
  }
  app.scene3d.addTilesArchive = addTilesArchive;

  // ---- local 3D Tiles and terrain (REQ-FMT-36, REQ-FMT-38): folders, ZIPs and single tiles ----
  const relPath = (f) => String(f.webkitRelativePath || f.relPath || f.name).replace(/\\/g, '/');
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
  const PART = /\.(json|b3dm|pnts|i3dm|cmpt|subtree|glb|gltf|bin|png|jpe?g|webp|ktx2|terrain)$/i;
  const CONTENT = /\.(b3dm|pnts|i3dm|cmpt)$/i;
  /** Files under `dir` (all 3D parts when dir is ''), keyed by their path relative to it. */
  const under = (entries, dir) => new Map(entries.filter(([k]) => k.startsWith(dir) && PART.test(k)).map(([k, v]) => [k.slice(dir.length), v]));
  /**
   * A tileset folder (files with their relative paths, or dropped flat) or a single content file,
   * served from memory as a tileset. `entries`: [[relative path, File|Uint8Array]]; `root`: the
   * tileset JSON's path, or a content file's path (a synthetic one-tile tileset).
   */
  async function addTilesLocal(entries, root, { p = pane(), maxSse = 16, name = root.split('/').pop() } = {}) {
    const dir = dirOf(root);
    const { base, serve } = localServer(under(entries, dir), 'local-3dtiles');
    const v = await ensureView(p);
    const leaf = root.slice(dir.length);
    const json = CONTENT.test(root) || /\.glb$/i.test(root) ? syntheticTileset(leaf) : null;
    const t = await v.addTileset(base + (json ? '_synthetic_tileset.json' : leaf.split('/').map(encodeURIComponent).join('/')), serve, { maxSse, name, json });
    await t.settle();
    app.emit('state');
    if (!t.stats.loaded && t.errors.length) throw new Error(t.errors[0]);
    return t;
  }
  app.scene3d.addTilesLocal = addTilesLocal;
  /** A local quantized-mesh set: `root` is the layer.json path; tiles are found under its folder. */
  async function addQuantizedMeshLocal(entries, root, { p = pane(), maxTiles = 64, name = root } = {}) {
    const dir = dirOf(root);
    const files = under(entries, dir);
    const { base, serve } = localServer(files, 'local-terrain');
    const v = await ensureView(p);
    const layerUrl = base + root.slice(dir.length).split('/').map(encodeURIComponent).join('/');
    let layer;
    try {
      layer = await (await serve(layerUrl)).json();
    } catch {
      throw gwError('{name}: the layer.json is not JSON', { name }, 'E_QMESH_LAYER_NOT_JSON');
    }
    const tiles = localTiles(layer, [...files.keys()].filter((k) => /\.terrain$/i.test(k)), maxTiles);
    if (!tiles.length) throw gwError('{name}: no .terrain tiles beside the layer.json match its template {template}', { name, template: layer.tiles?.[0] ?? t('(none)') }, 'E_QMESH_NO_TILES');
    const e = await loadQuantizedMesh(v, layerUrl, serve, { tiles, maxTiles, name: layer.name || name });
    app.emit('state');
    return e;
  }
  app.scene3d.addQuantizedMeshLocal = addQuantizedMeshLocal;

  /** File names in a ZIP's central directory (nothing is inflated), or null when it is not a ZIP we read. */
  async function zipNames(f) {
    const tail = new Uint8Array(await f.slice(Math.max(0, f.size - 65558)).arrayBuffer());
    const dv = new DataView(tail.buffer);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOff = dv.getUint32(eocd + 16, true);
    if (cdOff === 0xffffffff || cdSize > 64e6 || cdOff + cdSize > f.size) return null; // ZIP64 or damaged
    const cd = new Uint8Array(await f.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const cv = new DataView(cd.buffer);
    const names = [];
    for (let q = 0; q + 46 <= cd.length && cv.getUint32(q, true) === 0x02014b50; ) {
      const n = cv.getUint16(q + 28, true);
      const m = cv.getUint16(q + 30, true);
      const k = cv.getUint16(q + 32, true);
      names.push(new TextDecoder().decode(cd.subarray(q + 46, q + 46 + n)));
      q += 46 + n + m + k;
    }
    return names;
  }
  const isTilesetJson = async (v) => {
    const head = v instanceof Uint8Array ? new TextDecoder().decode(v.subarray(0, 4096)) : await v.slice(0, 4096).text();
    return /"root"\s*:/.test(head) || /"asset"\s*:/.test(head);
  };
  const tilesSummary = (ts) => {
    const s = ts.stats;
    const bits = [];
    if (s.points) bits.push(t('{n, plural, one {# point} other {# points}}', { n: s.points }));
    if (s.instances) bits.push(t('{n, plural, one {# instance} other {# instances}}', { n: s.instances }));
    if (s.triangles) bits.push(t('{n, plural, one {# triangle} other {# triangles}}', { n: Math.round(s.triangles) }));
    if (s.subtrees) bits.push(t('{n, plural, one {# subtree} other {# subtrees}}', { n: s.subtrees }));
    if (ts.local) bits.push(t('not georeferenced, shown in a local frame'));
    const tiles = t('{n, plural, one {# tile} other {# tiles}}', { n: s.loaded });
    return bits.length ? t('{tiles}, {details}', { tiles, details: list(bits, 'unit') }) : tiles;
  };
  /**
   * Open the 3D Tiles and quantized-mesh sets in a dropped set: folders keep their relative paths;
   * ZIPs that hold a tileset.json or layer.json are read from memory; single b3dm/pnts/i3dm/cmpt
   * tiles become one-tile tilesets. Returns {rest, done: [{file, what} | {file, error}]}.
   */
  async function openLocalSets(files, p = pane()) {
    const done = [];
    const entries = [];
    const rest = [];
    for (const f of files) {
      if (/\.zip$/i.test(f.name) && f.size < 2 ** 31) {
        const names = await zipNames(f).catch(() => null);
        if (names?.some((n) => /(^|\/)(tileset[^/]*\.json|layer\.json)$/i.test(n))) {
          try {
            const z = unzipSync(new Uint8Array(await f.arrayBuffer()));
            entries.push(...Object.entries(z).filter(([k]) => !k.endsWith('/')).map(([k, v]) => [`${f.name}/${k}`, v]));
          } catch (e) {
            done.push({ file: f.name, error: t('the ZIP cannot be read ({msg})', { msg: msgOf(e) }) });
          }
          continue;
        }
      }
      entries.push([relPath(f), f]);
    }
    // Roots: layer.json and tileset*.json files that hold a tileset, shallowest first; one inside
    // another root's folder belongs to it (an external tileset, a tile).
    const roots = { tiles: [], terrain: [] };
    const sorted = [...entries].sort((a, b) => a[0].split('/').length - b[0].split('/').length || a[0].localeCompare(b[0]));
    const covered = (k) => [...roots.tiles, ...roots.terrain].some((r) => k.startsWith(dirOf(r)) && PART.test(k));
    for (const [k, v] of sorted) {
      if (/(^|\/)layer\.json$/i.test(k) && !covered(k)) roots.terrain.push(k);
      else if (/(^|\/)tileset[^/]*\.json$/i.test(k) && !covered(k) && (await isTilesetJson(v))) roots.tiles.push(k);
    }
    for (const r of roots.tiles) {
      try {
        const ts = await addTilesLocal(entries, r, { p, name: r });
        done.push({ file: r.split('/').pop(), what: t('3D Tiles {version} in the 3D view: {summary}', { version: ts.asset?.version ?? '1.x', summary: tilesSummary(ts) }) });
      } catch (e) {
        done.push({ file: r.split('/').pop(), error: msgOf(e) });
      }
    }
    for (const r of roots.terrain) {
      try {
        const e = await addQuantizedMeshLocal(entries, r, { p, name: r });
        done.push({ file: r.split('/').pop(), what: t('quantized-mesh terrain ({projection}) in the 3D view: {tiles, plural, one {# tile} other {# tiles}}, {tris, plural, one {# triangle} other {# triangles}}', { projection: e.stats.projection, tiles: e.stats.tiles, tris: e.stats.triangles }) });
      } catch (e) {
        done.push({ file: r.split('/').pop(), error: msgOf(e) });
      }
    }
    for (const [k, v] of entries) {
      if (covered(k)) continue;
      const nm = k.split('/').pop();
      if (CONTENT.test(k)) {
        try {
          const ts = await addTilesLocal(entries, k, { p, name: nm });
          done.push({ file: nm, what: t('3D Tiles {version} in the 3D view: {summary}', { version: k.split('.').pop(), summary: tilesSummary(ts) }) });
        } catch (e) {
          done.push({ file: nm, error: msgOf(e) });
        }
      } else if (/\.subtree$/i.test(k)) done.push({ file: nm, error: t('an implicit-tiling subtree: open its tileset.json with its folder (or drop the folder)') });
      else if (/\.terrain$/i.test(k)) done.push({ file: nm, error: t('a quantized-mesh terrain tile: open its folder with the layer.json (drop the folder or a ZIP of it, or 3D ▸ Add Quantized-Mesh Terrain ▸ Folder)') });
      else if (v instanceof Uint8Array) continue; // other ZIP members
      else rest.push(v);
    }
    return { rest, done };
  }
  app.scene3d.openLocalSets = openLocalSets;
  /** Open local sets and toast what happened (the folder and file commands). */
  async function reportLocal(files) {
    const { done } = await openLocalSets(files);
    if (!done.length) throw new Error('no 3D Tiles tileset, tile or quantized-mesh layer.json in the selection');
    for (const d of done) {
      app.importLog.push({ file: d.file, errors: d.error ? [d.error] : [], warnings: [] });
      app.toast(t('{file}: {msg}', { file: d.file, msg: d.error ?? d.what }), d.error ? { kind: 'error', ms: 9000 } : { kind: 'info' });
    }
  }
  async function openFolder() {
    const files = await pickFiles(app, { dir: true, description: t('Tileset or terrain folder') });
    if (files.length) await reportLocal(files);
  }
  app.scene3d.openFolder = openFolder;
  // Draco / KTX2 glTF compression with the codec pack (REQ-FMT-35): for exports and automation.
  app.scene3d.codec = {
    available: () => hasCodecPack(app),
    compressGlb: async (glb, { draco = true, ktx2 = true } = {}) => {
      const enc = await codecEncoders(app);
      return compressGlb(glb, { draco: draco ? enc.draco : null, ktx2: ktx2 ? enc.ktx2 : null });
    },
  };
  /** Quantized-mesh terrain (REQ-ARC-16) over a box [south, west, north, east] at a level. */
  async function addQuantizedMesh(url, { p = pane(), box, level = 12 } = {}) {
    const v = await ensureView(p);
    if (!box) {
      if (!v.origin) throw gwError('give a box, or open other 3D content first', null, 'E_QMESH_NEEDS_BOX');
      const { min, max } = v.bounds();
      const a = v.toGeo(min[0], min[1], 0);
      const b = v.toGeo(max[0], max[1], 0);
      box = [a.lat, a.lon, b.lat, b.lon];
    }
    const e = await loadQuantizedMesh(v, url, app.netlog.fetchFor(`Terrain: ${new URL(url).host}`), { box, level });
    app.emit('state');
    return e;
  }
  app.scene3d.addQuantizedMesh = addQuantizedMesh;
  C.implement('3d.qmesh', {
    run: run(async () => {
      const url = h('input', { class: 'inp', type: 'url', placeholder: 'https://…/layer.json', 'aria-label': t('Terrain layer.json URL') });
      const lvl = h('input', { class: 'inp inp-num', type: 'number', min: '0', max: '20', value: '12', 'aria-label': t('Level') });
      const buttons = [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Folder…'), value: 'folder' }, { label: t('Cancel'), value: 'cancel' }];
      const ans = await modal({ title: t('Add Quantized-Mesh Terrain'), body: h('div', {}, field(t('layer.json URL'), url), field(t('Level'), lvl), h('p', { class: 'hint' }, t('Tiles over the 3D view’s content are loaded. The origin must be in this file’s network allow-list. Folder… opens a local tile set (layer.json with its \'{z}/{x}/{y}\'.terrain tiles, EPSG:4326 or EPSG:3857).'))), buttons, id: '3d-qmesh' });
      if (ans === 'folder') return openFolder();
      if (ans !== 'ok') return;
      const r = await addQuantizedMesh(httpUrl(url.value, 'layer.json'), { level: Number(lvl.value) || 12 });
      app.toast(t('Terrain: {tiles, plural, one {# tile} other {# tiles}}, {tris, plural, one {# triangle} other {# triangles}}', { tiles: r.stats.tiles, tris: r.stats.triangles }), { kind: 'info' });
    }),
  });
  C.implement('3d.tiles', {
    run: run(async () => {
      const url = h('input', { class: 'inp', type: 'url', placeholder: 'https://…/tileset.json', 'aria-label': t('Tileset URL') });
      const buttons = [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Folder…'), value: 'folder' }, { label: t('Cancel'), value: 'cancel' }];
      const ans = await modal({ title: t('Add 3D Tiles'), body: h('div', {}, field(t('tileset.json URL'), url), h('p', { class: 'hint' }, t('The origin must be in this file’s network allow-list (Add-Ins ▸ Network Allow-List). Tiles stream by screen-space error as you move. Folder… opens a local tileset folder (tileset.json with its tiles and subtrees).'))), buttons, id: '3d-tiles' });
      if (ans === 'folder') return openFolder();
      if (ans !== 'ok') return;
      const ts = await addTiles(httpUrl(url.value, 'tileset.json'));
      app.toast(t('3D Tiles: {name} ({version})', { name: ts.name, version: ts.asset?.version ?? '1.x' }), { kind: 'info' });
    }),
  });
  C.implement('3d.tiles3tz', {
    run: run(async () => {
      const fs = await pickFiles(app, { multiple: true, accept: ['.3tz', '.b3dm', '.pnts', '.i3dm', '.cmpt', '.glb', '.json', '.zip'], description: t('3D Tiles archive, tileset or tile') });
      if (!fs.length) return;
      const tz = fs.filter((f) => /\.3tz$/i.test(f.name));
      for (const f of tz) {
        const ts = await addTilesArchive(f);
        app.toast(t('3D Tiles archive {file} ({version})', { file: f.name, version: ts.asset?.version ?? '1.x' }), { kind: 'info' });
      }
      if (fs.length > tz.length) await reportLocal(fs.filter((f) => !tz.includes(f)));
    }),
  });
  C.implement('3d.record', {
    enabled: has,
    run: run(async () => {
      const v = view();
      const secs = h('input', { class: 'inp inp-num', type: 'number', min: '1', max: '120', value: '8', 'aria-label': t('Seconds') });
      if ((await modal({ title: t('Record Fly-Through (WebM)'), body: field(t('Seconds of orbit (or the route, when flying one)'), secs), buttons: okCancel(), id: '3d-record' })) !== 'ok') return;
      const sec = Number(secs.value) || 8;
      const blob = await v.recordWebM({ seconds: sec, pose: orbitPose(v, sec) });
      await saveBlob(app, blob, { name: 'flythrough.webm', types: ['.webm'], description: t('WebM video') });
    }),
  });
  /** Camera pose t seconds into one orbit of `seconds` about the current target. */
  function orbitPose(v, seconds) {
    const c = v.controls.target.clone();
    const p0 = v.camera.position.clone().sub(c);
    return (t) => {
      const a = (t / seconds) * Math.PI * 2;
      v.camera.position.set(c.x + p0.x * Math.cos(a) - p0.y * Math.sin(a), c.y + p0.x * Math.sin(a) + p0.y * Math.cos(a), c.z + p0.z);
      v.camera.lookAt(c);
    };
  }
  app.scene3d.orbitPose = orbitPose;
  /** One slow orbit about the target for `seconds`. */
  function orbit(v, seconds) {
    return new Promise((res) => {
      const t0 = performance.now();
      const c = v.controls.target.clone();
      const p0 = v.camera.position.clone().sub(c);
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        const a = (t / seconds) * Math.PI * 2;
        v.camera.position.set(c.x + p0.x * Math.cos(a) - p0.y * Math.sin(a), c.y + p0.x * Math.sin(a) + p0.y * Math.cos(a), c.z + p0.z);
        v.camera.lookAt(c);
        v.invalidate();
        if (t >= seconds) return res();
        requestAnimationFrame(step);
      };
      step();
    });
  }
  app.scene3d.orbit = orbit;
  const syncPartner = () => (app.desktop?.multiports ?? []).flatMap((mp) => mp.panes).find((p) => !p.view3d && p.geoLayer?.()?.modelId);
  C.implement('3d.sync', {
    enabled: () => has() && !!syncPartner(), // GUI-022
    run: run(async () => {
      const v = view();
      const other = syncPartner();
      if (!other) throw new Error('no 2D panel with a sensor model to sync with');
      const l = other.geoLayer();
      const g = l.groundAt(other.view.cx, other.view.cy, 0);
      const [e, n] = v.toLocal(g.lat, g.lon);
      v.lookDown(e, n, 400);
    }),
  });
}

// A named message for an empty or malformed service URL, instead of the URL constructor's (TE-037).
function httpUrl(v, what) {
  const u = String(v ?? '').trim();
  if (!/^https?:\/\/[^\s/]+/i.test(u)) throw gwError('enter the {what} URL (http:// or https://) first', { what }, 'E_URL_MISSING'); // a warning, not an error (GUI-053)
  return u;
}
