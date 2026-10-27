// Terrain folder (REQ-DEM-03): the user names a folder of elevation files once; when imagery
// opens, the DEMs that cover its footprint load as terrain (hidden layers, so the imagery stays
// on top) and the status bar shows the terrain source as for a DEM opened by hand. Files are
// indexed without reading their posts: SRTM HGT and DTED by their tile names (N34W117.hgt,
// w117/n34.dt2), GeoTIFF by its header (tie point and pixel scale, or the transformation
// matrix, with the GeoKey CRS). GeoTIFF heights follow the vertical GeoKey, a description that
// names HAE, or the folder's default (EGM96). In Chromium the folder handle is kept for the next session.

import { pickFiles } from '../storage/files.js';
import { openImageFile } from '../formats/open.js';
import { crsOf, converter } from '../geo/crs.js';

export const name = 'terrain-folder';

const DEM_RE = /\.(dt[012]|hgt|hgt\.gz|tif|tiff)$/i;

/** Tile bounds from an SRTM or DTED name, or null. */
export function boundsFromName(path) {
  const base = path.split(/[\\/]/).pop();
  let m = /^([NS])(\d{2})([EW])(\d{3})\.hgt(\.gz)?$/i.exec(base);
  if (m) {
    const s = (m[1].toUpperCase() === 'N' ? 1 : -1) * Number(m[2]);
    const w = (m[3].toUpperCase() === 'E' ? 1 : -1) * Number(m[4]);
    return { south: s, north: s + 1, west: w, east: w + 1 };
  }
  // DTED: <lon dir>/<lat file>, e.g. w117/n34.dt2.
  m = /(?:^|[\\/])([ew])(\d{3})[\\/]([ns])(\d{2})\.dt[012]$/i.exec(path);
  if (m) {
    const w = (m[1].toLowerCase() === 'e' ? 1 : -1) * Number(m[2]);
    const s = (m[3].toLowerCase() === 'n' ? 1 : -1) * Number(m[4]);
    return { south: s, north: s + 1, west: w, east: w + 1 };
  }
  return null;
}

/** GeoTIFF bounds (WGS 84 degrees) from the header, or null. */
export async function tiffBounds(file) {
  const head = new DataView(await file.slice(0, 16).arrayBuffer());
  const le = head.getUint16(0) === 0x4949;
  if (!le && head.getUint16(0) !== 0x4d4d) return null;
  const big = head.getUint16(2, le) === 43;
  if (!big && head.getUint16(2, le) !== 42) return null;
  const ifd = big ? Number(head.getBigUint64(8, le)) : head.getUint32(4, le);
  const nb = big ? 8 : 2;
  const cnt = new DataView(await file.slice(ifd, ifd + nb).arrayBuffer());
  const n = big ? Number(cnt.getBigUint64(0, le)) : cnt.getUint16(0, le);
  if (n > 4096) return null;
  const es = big ? 20 : 12;
  const dir = new DataView(await file.slice(ifd + nb, ifd + nb + n * es).arrayBuffer());
  const tags = new Map();
  const SIZE = { 1: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8, 2: 1 };
  for (let i = 0; i < n; i++) {
    const o = i * es;
    const tag = dir.getUint16(o, le);
    const type = dir.getUint16(o + 2, le);
    const count = big ? Number(dir.getBigUint64(o + 4, le)) : dir.getUint32(o + 4, le);
    tags.set(tag, { type, count, at: o + (big ? 12 : 8) });
  }
  const read = async (tag) => {
    const t = tags.get(tag);
    if (!t) return null;
    const sz = SIZE[t.type] ?? 1;
    const len = sz * t.count;
    let dv = dir;
    let off = t.at;
    if (len > (big ? 8 : 4)) {
      const p = big ? Number(dir.getBigUint64(t.at, le)) : dir.getUint32(t.at, le);
      dv = new DataView(await file.slice(p, p + len).arrayBuffer());
      off = 0;
    }
    const out = [];
    for (let k = 0; k < Math.min(t.count, 4096); k++) {
      const q = off + k * sz;
      out.push(t.type === 3 ? dv.getUint16(q, le) : t.type === 4 ? dv.getUint32(q, le) : t.type === 12 ? dv.getFloat64(q, le) : t.type === 16 ? Number(dv.getBigUint64(q, le)) : t.type === 11 ? dv.getFloat32(q, le) : dv.getUint8(q));
    }
    return out;
  };
  const W = (await read(256))?.[0];
  const H = (await read(257))?.[0];
  const scale = await read(33550);
  const tie = await read(33922);
  const mat = await read(34264);
  const keys = await read(34735);
  if (!W || !H || !keys) return null;
  let gt;
  if (mat) gt = [mat[3], mat[0], mat[1], mat[7], mat[4], mat[5]];
  else if (scale && tie) gt = [tie[3] - tie[0] * scale[0], scale[0], 0, tie[4] + tie[1] * scale[1], 0, -scale[1]];
  else return null;
  let epsg = null;
  let raster = 1;
  let vcs = null;
  for (let k = 4; k + 3 < keys.length; k += 4) {
    if (keys[k] === 1025) raster = keys[k + 3];
    if (keys[k] === 4096 && keys[k + 1] === 0) vcs = keys[k + 3];
    if ((keys[k] === 2048 || keys[k] === 3072) && keys[k + 1] === 0 && keys[k + 3] > 0 && keys[k + 3] < 32767) epsg = keys[k + 3];
  }
  // Heights: the vertical GeoKey, else a description that names HAE, else unknown (the folder's default).
  const desc = tags.has(270) ? new TextDecoder('latin1').decode(Uint8Array.from((await read(270)) ?? [])).replace(/\0+$/, '') : '';
  const vertical = vcs === 5773 ? 'egm96' : vcs === 3855 ? 'egm2008' : /\bHAE\b|ellipsoid/i.test(desc) ? 'hae' : null;
  // PixelIsArea: the tie point is the corner; PixelIsPoint: the post centre (half a post out).
  const half = raster === 2 ? 0.5 : 0;
  const xs = [-half, W - half].map((i) => gt[0] + i * gt[1]);
  const ys = [-half, H - half].map((j) => gt[3] + j * gt[5]);
  if (!epsg || epsg === 4326) return { west: Math.min(...xs), east: Math.max(...xs), south: Math.min(...ys), north: Math.max(...ys), vertical };
  const crs = crsOf({ epsg });
  if (!crs) return null;
  const c = converter(crs);
  const ll = [[xs[0], ys[0]], [xs[1], ys[0]], [xs[0], ys[1]], [xs[1], ys[1]]].map(([x, y]) => c.toLonLat(x, y));
  return { west: Math.min(...ll.map((p) => p[0])), east: Math.max(...ll.map((p) => p[0])), south: Math.min(...ll.map((p) => p[1])), north: Math.max(...ll.map((p) => p[1])), vertical };
}

async function* walk(dir, prefix = '', budget = { n: 20000 }) {
  for await (const [nm, hd] of dir.entries()) {
    if (--budget.n < 0) return;
    if (hd.kind === 'directory') yield* walk(hd, `${prefix}${nm}/`, budget);
    else if (DEM_RE.test(nm)) yield { path: `${prefix}${nm}`, handle: hd };
  }
}

export function install(app) {
  const C = app.commands;
  const state = { name: null, entries: [], loaded: new Set(), handle: null, seen: new Set(), vertical: 'egm96' };

  /** Index files [{path, file?, handle?}] → entries with bounds. */
  async function index(items, name) {
    const entries = [];
    for (const it of items) {
      let b = boundsFromName(it.path);
      if (!b && /\.tiff?$/i.test(it.path)) {
        try {
          b = await tiffBounds(it.file ?? (await it.handle.getFile()));
        } catch {
          b = null;
        }
      }
      if (b) entries.push({ ...it, bounds: b });
    }
    state.name = name;
    state.entries = entries;
    state.seen.clear();
    app.emit('state');
    return entries;
  }

  /** Use a folder: a FileSystemDirectoryHandle, or files from a directory input. */
  async function setFolder(src, { vertical = null } = {}) {
    if (vertical) state.vertical = vertical;
    if (src?.kind === 'directory') {
      state.handle = src;
      const items = [];
      for await (const e of walk(src)) items.push(e);
      await app.journal?.put('kv', 'terrainFolder', src);
      return index(items, src.name);
    }
    const files = [...(src ?? [])].filter((f) => DEM_RE.test(f.name));
    const name = (files[0]?.webkitRelativePath ?? '').split('/')[0] || 'terrain folder';
    return index(files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f })), name);
  }

  /** Load the folder's DEMs that cover a box [south, west, north, east]; returns the names loaded. */
  async function loadFor(box, p = app.activePane()) {
    const [s, w, n, e] = box;
    const hits = state.entries.filter((x) => !state.loaded.has(x.path) && x.bounds.south < n && x.bounds.north > s && x.bounds.west < e && x.bounds.east > w);
    const out = [];
    for (const x of hits) {
      state.loaded.add(x.path);
      try {
        const f = x.file ?? (await x.handle.getFile());
        const active = p?.rec.activeLayer;
        const { layers } = await openImageFile(app, f, { pane: p });
        // DTED and HGT become terrain (MSL) on opening; a GeoTIFF takes the heights it states.
        for (const l0 of layers) {
          const l = app.layers.get(l0.id) ?? l0;
          const e = app.terrain.entry(l.id);
          const v = x.bounds.vertical ?? state.vertical;
          if (e && (/\.(dt[012]|hgt|hgt\.gz)$/i.test(f.name) || e.vertical === v)) continue;
          if (e) app.terrain.remove(l.id);
          await app.useAsTerrain(l, v);
        }
        app.store.transact('Terrain folder', (tx) => {
          for (const l of layers) {
            tx.set(l.id, 'visible', false);
            tx.set(l.id, 'terrainFolder', state.name);
          }
          if (active) tx.set(p.id, 'activeLayer', active);
        }, { kind: 'load' });
        out.push(x.path);
      } catch (err) {
        app.log('warn', `terrain folder: ${x.path}: ${err.message}`);
      }
    }
    if (out.length) app.toast(`Terrain from ${state.name}: ${out.join(', ')}`);
    return out;
  }

  /** The ground box of an image layer from its corners, or null. */
  function footprint(l) {
    const c = [[0, 0], [l.width, 0], [l.width, l.height], [0, l.height]].map(([x, y]) => l.groundAt(x, y, 0)).filter(Boolean);
    if (c.length < 4) return null;
    return [Math.min(...c.map((q) => q.lat)), Math.min(...c.map((q) => q.lon)), Math.max(...c.map((q) => q.lat)), Math.max(...c.map((q) => q.lon))];
  }

  async function onLayers() {
    if (!state.entries.length) return;
    for (const l of app.layers.values()) {
      if (state.seen.has(l.id) || l.kind === 'dem' || !l.modelId) continue;
      state.seen.add(l.id);
      const b = footprint(l);
      if (b) await loadFor(b);
    }
  }
  app.on('layers', () => onLayers().catch((e) => app.log('warn', `terrain folder: ${e.message}`)));

  // A folder chosen in an earlier session (Chromium keeps the handle; permission is asked again).
  (async () => {
    const hd = await app.journal?.get('kv', 'terrainFolder');
    if (!hd?.queryPermission) return;
    if ((await hd.queryPermission({ mode: 'read' })) === 'granted') await setFolder(hd);
    else state.pending = hd;
  })().catch(() => {});

  app.terrainFolder = { setFolder, index, loadFor, state, boundsFromName, tiffBounds };

  C.implement('dem.folder', {
    checked: () => !!state.entries.length,
    run: async () => {
      try {
        let r;
        if (state.pending && (await state.pending.requestPermission({ mode: 'read' })) === 'granted') {
          r = await setFolder(state.pending);
          state.pending = null;
        } else if (window.showDirectoryPicker && app.runMode.caps.fsaPicker) {
          let hd;
          try {
            hd = await window.showDirectoryPicker({ id: 'gw-terrain', mode: 'read' });
          } catch (e) {
            if (e.name === 'AbortError') return;
            throw e;
          }
          r = await setFolder(hd);
        } else {
          const files = await pickFiles(app, { dir: true, description: 'Terrain folder' });
          if (!files.length) return;
          r = await setFolder(files);
        }
        app.toast(`Terrain folder ${state.name}: ${r.length} elevation file(s) indexed`);
        await onLayers();
      } catch (e) {
        app.toast(`Terrain folder: ${e.message}`, { kind: 'error' });
      }
    },
  });
}
