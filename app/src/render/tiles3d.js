// OGC 3D Tiles in the 3D pane (REQ-STR-15, REQ-FMT-36): a tileset.json from an online source (its
// origin in this file's network allow-list; every request through the network log), a .3tz
// archive, a local folder or a single content file (a synthetic one-tile tileset) is traversed each
// frame by screen-space error: a tile whose geometric error spans more than `maxSse` pixels refines
// to its children (REPLACE hides the parent once they are ready; ADD keeps it).
// Content is dispatched by magic (tiles3d-content.js): b3dm (glTF, RTC_CENTER), glb/gltf (1.1),
// pnts (THREE.Points: RTC, quantised positions, oct-encoded normals, RGB/RGBA/RGB565/constant
// colour, batch table, Draco), i3dm (InstancedMesh: positions, quantised, normal up/right incl.
// oct-encoded, scale, east-north-up, embedded or external glTF), cmpt (recursion) and external
// tilesets. Implicit tiling (3D Tiles 1.1 and 3DTILES_implicit_tiling): quadtree and octree,
// subtree files (binary or JSON) with availability bitstreams and content URI templates; child
// subtrees load as the camera refines. glTF is Y-up; the tile frame is Z-up; tile transforms chain
// to ECEF; every vertex is converted to the view's local frame (east, north metres from the view
// origin; up = HAE), so tiles line up with terrain and clouds. A tileset with no transform to ECEF
// (test packages in a unit box) is shown in a local frame instead, with a warning.

import { gltfExtensions, parseGltf, refuseUndecodable, decodeDraco } from './gltf-ext.js';
import { isGltf1, upgradeGltf1 } from './gltf1.js';
import { gwError } from '../i18n/index.js';
import { tileMagic, parsePnts, parseI3dm, parseB3dm, parseCmpt, parseSubtree, subtreeIndex, morton, fillTemplate, implicitVolume } from './tiles3d-content.js';

const A = 6378137;
const E2 = 0.0066943799901413165;

export function ecefToGeo(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat);
    const n = A / Math.sqrt(1 - E2 * s * s);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - (E2 * n) / (n + h)));
  }
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, h };
}

export function geoToEcef(lat, lon, h) {
  const [la, lo] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
  const s = Math.sin(la);
  const n = A / Math.sqrt(1 - E2 * s * s);
  return [(n + h) * Math.cos(la) * Math.cos(lo), (n + h) * Math.cos(la) * Math.sin(lo), (n * (1 - E2) + h) * s];
}

export const mul4 = (a, b) => {
  // Column-major 4 × 4.
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
export const apply4 = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
// glTF (Y-up) → 3D Tiles (Z-up): +90° about X.
const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
const ON_EARTH = 6.0e6; // m from the Earth's centre: anything nearer is not georeferenced

/** Bounding sphere (centre in the tileset's world frame, radius) of a bounding volume under `m`. */
function sphereOf(bv, m) {
  if (!bv) return null;
  if (bv.region) {
    const [w, s, e, n, h0, h1] = bv.region;
    const lat = ((s + n) / 2) * (180 / Math.PI);
    const lon = ((w + e) / 2) * (180 / Math.PI);
    const c = geoToEcef(lat, lon, (h0 + h1) / 2);
    const corner = geoToEcef(s * (180 / Math.PI), w * (180 / Math.PI), h0);
    return { c, r: Math.max(1, Math.hypot(c[0] - corner[0], c[1] - corner[1], c[2] - corner[2])) };
  }
  if (bv.box) {
    const b = bv.box;
    const c = apply4(m, b[0], b[1], b[2]);
    const r = Math.hypot(b[3], b[4], b[5]) + Math.hypot(b[6], b[7], b[8]) + Math.hypot(b[9], b[10], b[11]);
    return { c, r };
  }
  const s = bv.sphere ?? [0, 0, 0, 1];
  return { c: apply4(m, s[0], s[1], s[2]), r: s[3] };
}

/** Bounding sphere of decoded parts (world coordinates). */
function sphereOfParts(parts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const w = p.world;
    for (let i = 0; i < w.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k], w[i + k])), (max[k] = Math.max(max[k], w[i + k]));
  }
  if (!Number.isFinite(min[0])) return null;
  const c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  return { c, r: Math.max(1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2), min, max };
}

export class Tileset {
  /**
   * view: View3D; url: tileset.json URL (or a content file for a single tile); fetch: the logged
   * fetch (or a local file server). opts.json: a tileset object to use instead of fetching `url`.
   */
  constructor(view, url, fetch, { maxSse = 16, name = '3D Tiles', json = null } = {}) {
    this.view = view;
    this.url = url;
    this.fetch = fetch;
    this.maxSse = maxSse;
    this.name = name;
    this.json = json;
    this.group = new view.T.Group();
    view.world.add(this.group);
    this.root = null;
    this.stats = { requested: 0, loaded: 0, failed: 0, visible: 0, triangles: 0, vertices: 0, points: 0, instances: 0, subtrees: 0 };
    this.contents = []; // per loaded content: {uri, magic, points, instances, vertices, triangles, batchLength, properties, min, max}
    this.loading = 0;
    this.local = null; // offset [e, n, z] when the tileset is not georeferenced
    this.errors = [];
  }

  async load() {
    let ts = this.json;
    if (!ts) {
      const r = await this.fetch(this.url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`${this.url}: HTTP ${r.status}`);
      ts = await r.json();
    }
    if (!ts?.root) throw new Error('not a 3D Tiles tileset (no root)');
    this.asset = ts.asset ?? {};
    this.schema = ts.schema ?? null;
    this.yUp = !(this.asset.gltfUpAxis && String(this.asset.gltfUpAxis).toUpperCase() === 'Z');
    this.root = this._node(ts.root, IDENT, this.url, null);
    if (this.root.implicit) await this._loadSubtree(this.root);
    // A one-tile tileset made for a single local file has no bounding volume: decode its content
    // first and bound that.
    let eager = null;
    if (!this.root.sphere) {
      eager = await this._decodeNode(this.root);
      this.root.sphere = sphereOfParts(eager) ?? { c: [0, 0, 0], r: 1 };
    }
    const c = this.root.sphere.c;
    const v = this.view;
    const hadOrigin = !!v.origin;
    if (Math.hypot(...c) < ON_EARTH) {
      // Not georeferenced: nothing places it on the Earth. Show it in a local frame (metres, Z up)
      // about the view's content (or a frame at 0°, 0° when the view is empty).
      if (!v.origin) v.setOrigin({ lat0: 0, lon0: 0, ...frame(0) });
      const { min, max } = v.bounds();
      const at = Number.isFinite(min[0]) ? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, max[2]] : [0, 0, 0];
      this.local = [at[0] - c[0], at[1] - c[1], at[2] - (c[2] - this.root.sphere.r)];
      this.warning = 'not georeferenced: no transform places the tileset on the Earth, so it is shown in a local frame (metres)';
      v.app?.log?.('warn', `3D Tiles ${this.name}: ${this.warning}`);
      const [e, n, z] = this.toView(...c);
      if (!hadOrigin) v.lookAtLocal?.(e, n, z, this.root.sphere.r * 2);
    } else if (!v.origin) {
      // The view's frame: the root's centre when nothing else fixed it.
      const g = ecefToGeo(...c);
      v.setOrigin({ lat0: g.lat, lon0: g.lon, ...frame(g.lat) });
      v.lookAtLocal?.(0, 0, g.h, this.root.sphere.r);
    }
    if (eager) this._ready(this.root, eager, this.root.uris[0] ?? this.url);
    v.invalidate();
    return this;
  }

  /** World (ECEF, or tile frame when local) → the view's local frame [e, n, up]. */
  toView(x, y, z) {
    if (this.local) return [x + this.local[0], y + this.local[1], z + this.local[2]];
    const g = ecefToGeo(x, y, z);
    const [e, n] = this.view.toLocal(g.lat, g.lon);
    return [e, n, g.h];
  }

  _node(j, parentM, base, parent) {
    const m = j.transform ? mul4(parentM, j.transform) : parentM;
    const n = { j, m, base, parent, children: [], state: 'none', object: null, sphere: sphereOf(j.boundingVolume, m), refine: (j.refine ?? parent?.refine ?? 'REPLACE').toUpperCase() };
    // 3D Tiles 1.1 tiles may carry several contents (`contents`); 1.0 has one (`content`).
    const contents = j.contents ?? (j.content ? [j.content] : []);
    const it = j.implicitTiling ?? j.extensions?.['3DTILES_implicit_tiling'];
    if (it) {
      const octree = String(it.subdivisionScheme).toUpperCase() === 'OCTREE';
      const levels = it.subtreeLevels;
      const avail = it.availableLevels ?? (it.maximumLevel !== undefined ? it.maximumLevel + 1 : undefined);
      const subTpl = it.subtrees?.uri ?? it.subtrees?.url;
      if (!Number.isInteger(levels) || levels < 1 || levels > 30 || !Number.isInteger(avail) || avail < 1 || !subTpl) throw new Error('3D Tiles implicit tiling: subtreeLevels, availableLevels and subtrees.uri are required');
      if (!j.boundingVolume?.box && !j.boundingVolume?.region) throw new Error('3D Tiles implicit tiling: the root bounding volume must be a box or a region');
      const impl = { octree, branching: octree ? 8 : 4, levels, avail, subTpl, tpls: contents.map((c) => c.uri ?? c.url).filter(Boolean), bv: j.boundingVolume, ge: j.geometricError, refine: n.refine, m, base };
      n.implicit = { impl, level: 0, x: 0, y: 0, z: 0 };
      n.uris = [];
      return n;
    }
    n.uris = contents.map((c) => c.uri ?? c.url).filter(Boolean);
    n.children = (j.children ?? []).map((c) => this._node(c, m, base, n));
    return n;
  }

  /** A node for implicit tile (level, x, y, z). */
  _implicitNode(impl, level, x, y, z, parent) {
    const j = { boundingVolume: implicitVolume(impl.bv, level, x, y, z, impl.octree), geometricError: impl.ge / 2 ** level, refine: impl.refine };
    return { j, m: impl.m, base: impl.base, parent, children: [], state: 'none', object: null, sphere: sphereOf(j.boundingVolume, impl.m), refine: impl.refine, uris: [], implicit: { impl, level, x, y, z } };
  }

  /** Load the subtree rooted at implicit node `root` and build its available tiles. */
  async _loadSubtree(root) {
    const { impl, level, x, y, z } = root.implicit;
    const url = new URL(fillTemplate(impl.subTpl, { level, x, y, z }), impl.base).href;
    const r = await this.fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error(`subtree ${level}.${x}.${y}${impl.octree ? `.${z}` : ''}: HTTP ${r.status}`);
    const sub = await parseSubtree(new Uint8Array(await r.arrayBuffer()), {
      levels: impl.levels,
      branching: impl.branching,
      loadBuffer: async (uri) => {
        const b = await this.fetch(new URL(uri, url).href, { credentials: 'omit' });
        if (!b.ok) throw new Error(`subtree buffer ${uri}: HTTP ${b.status}`);
        return new Uint8Array(await b.arrayBuffer());
      },
    });
    this.stats.subtrees++;
    const kids = impl.octree ? 8 : 4;
    const build = (n, ll, lx, ly, lz) => {
      const i = subtreeIndex(ll, lx, ly, lz, impl.branching);
      const { level: L, x: gx, y: gy, z: gz } = n.implicit;
      n.uris = impl.tpls.filter((t, k) => sub.content(i, k)).map((t) => fillTemplate(t, { level: L, x: gx, y: gy, z: gz }));
      if (L + 1 >= impl.avail) return;
      n.pendingSubtrees = [];
      for (let c = 0; c < kids; c++) {
        const [dx, dy, dz] = [c & 1, (c >> 1) & 1, (c >> 2) & 1];
        const [cx, cy, cz] = [2 * lx + dx, 2 * ly + dy, 2 * lz + dz];
        const g = [L + 1, 2 * gx + dx, 2 * gy + dy, impl.octree ? 2 * gz + dz : 0];
        if (ll + 1 < impl.levels) {
          if (!sub.tile(subtreeIndex(ll + 1, cx, cy, cz, impl.branching))) continue;
          const ch = this._implicitNode(impl, ...g, n);
          n.children.push(ch);
          build(ch, ll + 1, cx, cy, cz);
        } else if (sub.child(morton(cx, cy, impl.octree ? cz : undefined))) n.pendingSubtrees.push(g);
      }
      if (!n.pendingSubtrees.length) delete n.pendingSubtrees;
    };
    if (!sub.tile(0)) return;
    build(root, 0, 0, 0, 0);
  }

  async _expand(n) {
    n.expanding = true;
    const list = n.pendingSubtrees;
    delete n.pendingSubtrees;
    for (const g of list) {
      const ch = this._implicitNode(n.implicit.impl, ...g, n);
      try {
        await this._loadSubtree(ch);
        n.children.push(ch);
      } catch (e) {
        this.view.app?.log?.('warn', `3D Tiles ${this.name}: ${e.message}`);
      }
    }
    n.expanding = false;
    this.view.invalidate();
  }

  /** Called before each render: traverse, request, show/hide. */
  update() {
    if (!this.root) return;
    const v = this.view;
    const cam = v.camera;
    const hpx = v.canvas.height || 1;
    const k = hpx / (2 * Math.tan((cam.fov * Math.PI) / 360));
    const camLocal = cam.position;
    const want = new Set();
    let visible = 0;
    const visit = (n) => {
      if (!n.viewC) n.viewC = this.toView(...n.sphere.c);
      const [e, nn, h] = n.viewC;
      const d = Math.max(1e-3, Math.hypot(camLocal.x - e, camLocal.y - nn, camLocal.z - h) - n.sphere.r);
      const sse = (n.j.geometricError * k) / d;
      const canRefine = n.children.length || n.pendingSubtrees;
      const refine = sse > this.maxSse && canRefine;
      if (refine) {
        if (n.pendingSubtrees && !n.expanding) this._expand(n);
        const ready = n.children.every((c) => !c.uris.length || c.state === 'ready' || c.state === 'failed');
        if (n.refine === 'ADD' || !ready || !n.children.length) want.add(n);
        n.children.forEach(visit);
      } else want.add(n);
    };
    visit(this.root);
    // Hide everything, then show the wanted nodes that are ready; request the rest.
    const all = [];
    const walk = (n) => (all.push(n), n.children.forEach(walk));
    walk(this.root);
    for (const n of all) {
      const on = want.has(n);
      if (n.object) n.object.visible = on && n.state === 'ready';
      if (on && n.uris.length && n.state === 'none') this._request(n);
      if (on && n.state === 'ready') visible++;
    }
    this.stats.visible = visible;
  }

  async _request(n) {
    n.state = 'loading';
    this.stats.requested++;
    this.loading++;
    try {
      const parts = await this._decodeNode(n);
      this._ready(n, parts, n.uris.join(', '));
    } catch (e) {
      n.state = 'failed';
      this.stats.failed++;
      this.errors.push(e.message);
      this.view.app?.log?.('warn', `3D Tiles ${this.name}: ${e.message}`);
    } finally {
      this.loading--;
      this.view.invalidate();
    }
  }

  /** Fetch and decode a node's contents → parts (external tilesets are grafted as children). */
  async _decodeNode(n) {
    const parts = [];
    for (const uri of n.uris) {
      const url = new URL(uri, n.base).href;
      const r = await this.fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error(`${uri}: HTTP ${r.status}`);
      const b = new Uint8Array(await r.arrayBuffer());
      if (b[0] === 0x7b && !/\.gltf$/i.test(new URL(url).pathname)) {
        // An external tileset: graft its root under this node.
        const ts = JSON.parse(new TextDecoder().decode(b));
        if (ts.root) {
          n.children.push(this._node(ts.root, n.m, url, n));
          continue;
        }
      }
      const before = parts.length;
      await this._content(b, n.m, url, parts);
      this._record(uri, b, parts.slice(before));
    }
    return parts;
  }

  /** Per-content statistics (c54 oracles, Layer Properties). */
  _record(uri, b, parts) {
    const s = sphereOfParts(parts);
    const info = { uri, magic: tileMagic(b), points: 0, instances: 0, vertices: 0, triangles: 0, batchLength: 0, properties: [], min: s?.min ?? null, max: s?.max ?? null };
    for (const p of parts) {
      if (p.kind === 'points') info.points += p.world.length / 3;
      if (p.kind === 'instanced' && p.first) info.instances += p.count; // a multi-mesh model's parts share the instances
      if (p.kind === 'mesh' || p.kind === 'instanced') {
        info.vertices += p.vertices;
        info.triangles += p.triangles;
      }
      info.batchLength = Math.max(info.batchLength, p.batchLength ?? 0);
      for (const k of p.properties ?? []) if (!info.properties.includes(k)) info.properties.push(k);
      if (p.attributes) info.attributes = [...new Set([...(info.attributes ?? []), ...p.attributes])];
      if (p.stats) info.stats = { ...(info.stats ?? {}), ...p.stats };
    }
    this.contents.push(info);
    this.stats.points += info.points;
    this.stats.instances += info.instances;
    this.stats.vertices += info.vertices;
  }

  /** Content bytes → parts appended to `out`. */
  async _content(b, m, url, out, depth = 0) {
    const magic = tileMagic(b);
    if (magic === 'b3dm') {
      const t = parseB3dm(b);
      const M = t.rtc ? mul4(m, translate(t.rtc)) : m;
      const parts = await this._gltfParts(t.glb, M, url);
      for (const p of parts) Object.assign(p, { batchLength: t.batchLength, properties: Object.keys(t.batch) });
      out.push(...parts);
    } else if (magic === 'pnts') out.push(await this._pnts(b, m));
    else if (magic === 'i3dm') out.push(...(await this._i3dm(b, m, url)));
    else if (magic === 'cmpt') {
      for (const inner of parseCmpt(b, depth)) await this._content(inner, m, url, out, depth + 1);
    } else if (magic === 'glTF' || magic === '{') out.push(...(await this._gltfParts(b, m, url)));
    else throw gwError('unsupported tile content "{magic}"', { magic: magic.replace(/[^\x20-\x7e]/g, '?') }, 'E_TILE_CONTENT');
  }

  /** pnts → a points part (world positions, colours). */
  async _pnts(b, m) {
    const T = this.view.T;
    const t = parsePnts(b);
    let pos = t.positions;
    let colors = t.colors;
    let colorSize = t.colorSize;
    let normals = t.normals;
    let batchIds = t.batchIds;
    const attributes = [];
    if (t.draco) {
      const ids = {};
      const types = {};
      const map = { POSITION: ['position', 'Float32Array'], POSITION_QUANTIZED: ['position', 'Float32Array'], RGBA: ['color', 'Uint8Array'], RGB: ['color', 'Uint8Array'], NORMAL: ['normal', 'Float32Array'], BATCH_ID: ['batchId', 'Uint16Array'] };
      for (const [k, id] of Object.entries(t.draco.properties)) if (map[k]) [ids[map[k][0]], types[map[k][0]]] = [id, map[k][1]];
      for (const [k, id] of Object.entries(t.draco.batchProperties)) [ids[`_bt_${k}`], types[`_bt_${k}`]] = [id, 'Float32Array'];
      const gw = this.view.app?.gw;
      if (!gw?.manifest?.blocks?.['wasm-draco']) throw new Error('Draco point compression (3DTILES_draco_point_compression) needs the Draco decoder, which this file leaves out: open the Standard file');
      const g = await decodeDraco(T, gw, t.draco.bytes, ids, types);
      const a = (k) => g.attributes[k]?.array;
      if (a('position')) pos = new Float32Array(a('position'));
      if (a('color')) [colors, colorSize] = [new Uint8Array(a('color')), g.attributes.color.itemSize];
      if (a('normal')) normals = a('normal');
      if (a('batchId')) batchIds = a('batchId');
      for (const k of Object.keys(t.draco.batchProperties)) if (a(`_bt_${k}`)) t.batch[k] = { size: g.attributes[`_bt_${k}`].itemSize, values: a(`_bt_${k}`) };
      attributes.push('draco');
    }
    if (!pos || pos.length < t.count * 3) throw new Error('3D Tiles pnts: positions are missing');
    const M = t.rtc ? mul4(m, translate(t.rtc)) : m;
    const n = t.count;
    const world = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) world.set(apply4(M, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]), 3 * i);
    if (colors) attributes.push(colorSize === 4 ? 'RGBA' : 'RGB');
    if (normals) attributes.push('NORMAL');
    if (batchIds) attributes.push('BATCH_ID');
    if (t.constantRgba) attributes.push('CONSTANT_RGBA');
    // Batch-table statistics: per numeric scalar property, min / max / mean.
    const stats = {};
    for (const [k, v] of Object.entries(t.batch)) {
      const vals = Array.isArray(v) ? v : v.values && v.size === 1 ? v.values : null;
      if (!vals?.length || typeof vals[0] !== 'number') continue;
      let lo = Infinity;
      let hi = -Infinity;
      let sum = 0;
      for (const x of vals) (lo = Math.min(lo, x)), (hi = Math.max(hi, x)), (sum += x);
      stats[k] = { min: lo, max: hi, mean: sum / vals.length, n: vals.length };
    }
    return { kind: 'points', world, colors, colorSize, constantRgba: t.constantRgba, batchLength: t.batchLength, properties: Object.keys(t.batch), attributes, stats };
  }

  /** i3dm → instanced parts (one per glTF mesh). */
  async _i3dm(b, m, url) {
    const t = parseI3dm(b);
    let glb = t.gltf.bytes;
    let gurl = url;
    if (!glb) {
      gurl = new URL(t.gltf.uri, url).href;
      const r = await this.fetch(gurl, { credentials: 'omit' });
      if (!r.ok) throw new Error(`i3dm model ${t.gltf.uri}: HTTP ${r.status}`);
      glb = new Uint8Array(await r.arrayBuffer());
    }
    const meshes = await this._gltfMeshes(glb, gurl);
    const M = t.rtc ? mul4(m, translate(t.rtc)) : m;
    const n = t.count;
    const inst = new Float64Array(16 * n);
    const world = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const p = [t.positions[3 * i], t.positions[3 * i + 1], t.positions[3 * i + 2]];
      let right = [1, 0, 0];
      let up = [0, 1, 0];
      let fwd = [0, 0, 1];
      if (t.up && t.right) {
        up = [t.up[3 * i], t.up[3 * i + 1], t.up[3 * i + 2]];
        right = [t.right[3 * i], t.right[3 * i + 1], t.right[3 * i + 2]];
        fwd = cross(right, up);
      } else if (t.eastNorthUp) {
        const e = [p[0] + (t.rtc?.[0] ?? 0), p[1] + (t.rtc?.[1] ?? 0), p[2] + (t.rtc?.[2] ?? 0)];
        if (Math.hypot(...e) > ON_EARTH) {
          const g = ecefToGeo(...e);
          const [la, lo] = [(g.lat * Math.PI) / 180, (g.lon * Math.PI) / 180];
          right = [-Math.sin(lo), Math.cos(lo), 0];
          fwd = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
          up = cross(fwd, right);
        }
      }
      const s = t.scaleNonUniform ? [t.scaleNonUniform[3 * i], t.scaleNonUniform[3 * i + 1], t.scaleNonUniform[3 * i + 2]] : t.scale ? [t.scale[i], t.scale[i], t.scale[i]] : [1, 1, 1];
      const R = [right[0] * s[0], right[1] * s[0], right[2] * s[0], 0, up[0] * s[1], up[1] * s[1], up[2] * s[1], 0, fwd[0] * s[2], fwd[1] * s[2], fwd[2] * s[2], 0, p[0], p[1], p[2], 1];
      const W = mul4(M, R);
      inst.set(W, 16 * i);
      world.set([W[12], W[13], W[14]], 3 * i);
    }
    const props = Object.keys(t.batch);
    return meshes.map((g, k) => ({ kind: 'instanced', first: k === 0, geometry: g.geometry, material: g.material, inst, world: k === 0 ? world : new Float64Array(0), count: n, vertices: g.geometry.attributes.position.count * n, triangles: ((g.geometry.index ? g.geometry.index.count : g.geometry.attributes.position.count) / 3) * n, batchLength: t.batchLength, properties: props, attributes: ['INSTANCES'] }));
  }

  /** glTF → [{geometry (model frame, Z-up, node transforms applied), material}]. */
  async _gltfMeshes(bytes, url) {
    const T = this.view.T;
    const gw = this.view.app?.gw;
    // Legacy content: binary glTF 1.0 (KHR_binary_glTF, CESIUM_RTC) is upgraded to 2.0 first.
    let rtc = null;
    if (isGltf1(bytes)) ({ glb: bytes, rtc } = upgradeGltf1(bytes));
    refuseUndecodable(bytes, '3D Tiles content', gw);
    // External buffers and images (a .gltf beside its .bin in a tileset or a .3tz) come through the
    // tileset's own fetch — the archive, the local folder, or the network log for an online source —
    // as blob: URLs; embedded data: URIs become blobs too. Left to the loader they resolved against
    // the page and broke the CSP (TE archive: 3d-tiles-3tz-cesium-test-packages).
    const blobs = new Map();
    const { json } = gltfExtensions(bytes);
    for (const r of [...(json?.buffers ?? []), ...(json?.images ?? [])]) {
      if (!r.uri || /^blob:/i.test(r.uri) || blobs.has(r.uri)) continue;
      let data;
      if (/^data:/i.test(r.uri)) {
        const mm = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(r.uri);
        if (!mm) continue;
        data = new Blob([mm[2] ? Uint8Array.from(atob(mm[3]), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(mm[3]))], { type: mm[1] || 'application/octet-stream' });
      } else {
        const res = await this.fetch(new URL(r.uri, url).href, { credentials: 'omit' });
        if (!res.ok) throw new Error(`${r.uri}: HTTP ${res.status}`);
        data = await res.blob();
      }
      blobs.set(r.uri, URL.createObjectURL(data));
    }
    const manager = new T.LoadingManager();
    manager.setURLModifier((u) => blobs.get(u) ?? blobs.get(decodeURIComponent(u)) ?? u);
    let gltf;
    try {
      gltf = await parseGltf(T, manager, bytes, { gw, renderer: this.view.renderer });
    } finally {
      for (const b of blobs.values()) URL.revokeObjectURL(b);
    }
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const up = this.yUp ? Y_UP_TO_Z_UP : IDENT;
    const out = [];
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      g.applyMatrix4(new T.Matrix4().fromArray(up));
      const mat = o.material?.clone?.() ?? new T.MeshLambertMaterial({ color: 0xcccccc });
      mat.side = T.DoubleSide;
      out.push({ geometry: g, material: mat, rtc });
    });
    return out;
  }

  /** glTF content → mesh parts with world positions (tile matrix `m`). */
  async _gltfParts(bytes, m, url) {
    const meshes = await this._gltfMeshes(bytes, url);
    return meshes.map(({ geometry: g, material, rtc }) => {
      const p = g.attributes.position;
      const world = new Float64Array(3 * p.count);
      const M = rtc ? mul4(m, translate(rtc)) : m; // CESIUM_RTC (glTF 1.0), in double precision
      for (let i = 0; i < p.count; i++) world.set(apply4(M, p.getX(i), p.getY(i), p.getZ(i)), 3 * i);
      return { kind: 'mesh', geometry: g, material, world, vertices: p.count, triangles: (g.index ? g.index.count : p.count) / 3 };
    });
  }

  /** Place decoded parts in the view's frame and attach them to node `n`. */
  _ready(n, parts, what) {
    const T = this.view.T;
    const objs = [];
    for (const p of parts) {
      if (p.kind === 'mesh') {
        const g = p.geometry;
        const a = g.attributes.position;
        const local = new Float32Array(3 * a.count);
        for (let i = 0; i < a.count; i++) local.set(this.toView(p.world[3 * i], p.world[3 * i + 1], p.world[3 * i + 2]), 3 * i);
        g.setAttribute('position', new T.BufferAttribute(local, 3));
        g.computeVertexNormals();
        g.computeBoundingSphere();
        this.stats.triangles += p.triangles;
        objs.push(new T.Mesh(g, p.material));
      } else if (p.kind === 'points') {
        const nPts = p.world.length / 3;
        const local = new Float32Array(3 * nPts);
        for (let i = 0; i < nPts; i++) local.set(this.toView(p.world[3 * i], p.world[3 * i + 1], p.world[3 * i + 2]), 3 * i);
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(local, 3));
        const opts = { size: 3, sizeAttenuation: false };
        if (p.colors) {
          g.setAttribute('color', new T.BufferAttribute(p.colors, p.colorSize, true));
          Object.assign(opts, { vertexColors: true, transparent: p.colorSize === 4 });
        } else if (p.constantRgba) Object.assign(opts, { color: new T.Color(p.constantRgba[0] / 255, p.constantRgba[1] / 255, p.constantRgba[2] / 255), transparent: p.constantRgba[3] < 255, opacity: p.constantRgba[3] / 255 });
        else opts.color = new T.Color(0.85, 0.85, 0.85);
        g.computeBoundingSphere();
        objs.push(new T.Points(g, new T.PointsMaterial(opts)));
      } else if (p.kind === 'instanced') {
        const mesh = new T.InstancedMesh(p.geometry, p.material, p.count);
        const mat = new T.Matrix4();
        for (let i = 0; i < p.count; i++) {
          const W = p.inst.subarray(16 * i, 16 * i + 16);
          mesh.setMatrixAt(i, mat.fromArray(mul4(this._affine(W[12], W[13], W[14]), Array.from(W))));
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere?.();
        mesh.frustumCulled = false;
        this.stats.triangles += p.triangles;
        objs.push(mesh);
      }
    }
    if (objs.length) {
      const obj = objs.reduce((g, o) => (g.add(o), g), new T.Group()); // a group per tile, as before (callers read object.children)
      obj.name = what;
      n.object = obj;
      obj.visible = false;
      this.group.add(obj);
    }
    n.state = 'ready';
    this.stats.loaded++;
  }

  /** Affine approximation (4 × 4, column-major) of toView about world point P (1 m differences). */
  _affine(x, y, z) {
    if (this.local) return translate(this.local);
    const q0 = this.toView(x, y, z);
    const cols = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ].map((d) => {
      const q = this.toView(x + d[0], y + d[1], z + d[2]);
      return [q[0] - q0[0], q[1] - q0[1], q[2] - q0[2]];
    });
    const J = [...cols[0], 0, ...cols[1], 0, ...cols[2], 0, 0, 0, 0, 1];
    const jp = apply4(J, x, y, z);
    J[12] = q0[0] - jp[0];
    J[13] = q0[1] - jp[1];
    J[14] = q0[2] - jp[2];
    return J;
  }

  /** Traverse and wait until the tiles the current view wants have loaded (or failed), up to `ms`. */
  async settle(ms = 60000) {
    const t0 = performance.now();
    this.update();
    while ((this.loading > 0 || [...this._expanding()].length) && performance.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 40));
      this.update();
    }
    return this.stats;
  }

  *_expanding() {
    const walk = function* (n) {
      if (n.expanding) yield n;
      for (const c of n.children) yield* walk(c);
    };
    if (this.root) yield* walk(this.root);
  }

  /** Geographic bounds of everything loaded: {min: [lat, lon, h], max} (world bounds when local). */
  bounds() {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const c of this.contents) {
      if (!c.min) continue;
      for (const corner of [c.min, c.max]) {
        const g = this.local ? { lat: corner[1], lon: corner[0], h: corner[2] } : ecefToGeo(...corner);
        [g.lat, g.lon, g.h].forEach((v, k) => ((min[k] = Math.min(min[k], v)), (max[k] = Math.max(max[k], v))));
      }
    }
    return { min, max };
  }

  dispose() {
    this.view.world.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose?.();
    });
  }
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Metres per degree of longitude and latitude on WGS 84 at `lat`. */
function frame(lat) {
  const s = Math.sin((lat * Math.PI) / 180);
  const w = 1 - E2 * s * s;
  return { kx: ((A / Math.sqrt(w)) * Math.cos((lat * Math.PI) / 180) * Math.PI) / 180, ky: (((A * (1 - E2)) / (w * Math.sqrt(w))) * Math.PI) / 180 };
}

// ---- local tilesets: files from disk served like a web server ----

/**
 * A fetch over local files: `files` is a Map of relative path → File/Blob/Uint8Array, served under
 * `https://<host>.invalid/`. A path not found by its full relative name is matched by its last
 * segments (files dropped flat, without their folders). gzip-compressed entries are inflated.
 */
export function localServer(files, host = 'local-3d') {
  const norm = (p) => p.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
  const byPath = new Map([...files].map(([k, v]) => [norm(k), v]));
  const byName = new Map();
  for (const [k, v] of byPath) {
    const nm = k.split('/').pop();
    byName.set(nm, byName.has(nm) ? null : v); // ambiguous names are not guessed
  }
  const lookup = (path) => {
    const p = norm(path);
    if (byPath.has(p)) return byPath.get(p);
    // Longest suffix match: "content/0/0/0.glb" against "tiles/content/0/0/0.glb".
    for (const [k, v] of byPath) if (k.endsWith(`/${p}`)) return v;
    return byName.get(p.split('/').pop()) ?? null;
  };
  const base = `https://${host}.invalid/`;
  const serve = async (url) => {
    const u = new URL(url);
    // Quantized-mesh templates put the tile in the query ("tile.terrain?x=…"): match the path alone.
    const path = decodeURIComponent(u.pathname.slice(1));
    const f = lookup(path);
    if (!f) return new Response('', { status: 404 });
    const b = f instanceof Uint8Array ? f : new Uint8Array(await f.arrayBuffer());
    if (b[0] === 0x1f && b[1] === 0x8b) return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip')), { status: 200 });
    return new Response(b, { status: 200 });
  };
  return { base, serve, lookup };
}

/** A one-tile tileset for a single content file (b3dm, pnts, i3dm, cmpt, glb). */
export function syntheticTileset(name) {
  return { asset: { version: '1.0', generator: 'GIS Workbench (single content file)' }, geometricError: 0, root: { geometricError: 0, refine: 'ADD', content: { uri: encodeURIComponent(name) } } };
}
