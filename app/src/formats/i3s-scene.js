// I3S scene layers, full read (REQ-GAP-35; OGC Community Standard I3S 1.7–1.9, Esri i3s-spec):
// 3DObject, IntegratedMesh and Point layers from a scene layer package (.slpk) or a scene
// service, and the 3DObject sublayers of a Building scene layer. What is read:
// - the layer document, the node pages (lazily, page by page), each node's OBB, lodThreshold
//   (maxScreenThresholdSQ), children and mesh references: the node tree and its LOD;
// - geometry: the uncompressed buffer (decoded in Rust, crates/gw-tiles/src/i3s.rs, in the
//   analysis worker) or, when the layer has only a Draco buffer, the Draco one (render/i3s-draco.js);
// - textures: JPEG and PNG (the formats a browser decodes), KTX2 through the Basis transcoder;
//   DDS and KTX-ETC2 only sets give an untextured mesh and a warning;
// - binary attributes (connectors/i3s.js decodeAttribute) of the features of a node, on request.
// Refused by name: PointCloud layers (PCSL: LEPCC-compressed points), I3S 1.6 stores without node
// pages (convert them with Esri's i3s_converter), and layers in a CRS the build does not know.
// Coordinates: for a global layer (WGS 84, wkid 4326) vertex positions are offsets from the
// node's OBB centre in degrees (x, y) and metres (z); a local layer's are in its CRS units.
// Heights of a gravity-related layer (heightModelInfo, vcsWkid) get the EGM96 undulation added,
// so they sit on the app's ellipsoidal heights.

import { gunzipSync, inflateSync } from 'fflate';
import { decodeAttribute } from '../connectors/i3s.js';
import { crsOf, converter } from '../geo/crs.js';
import { gwError } from '../i18n/index.js';

const isGz = (u) => u.length > 2 && u[0] === 0x1f && u[1] === 0x8b;
const jsonOf = (u) => JSON.parse(new TextDecoder().decode(isGz(u) ? gunzipSync(u) : u));

/**
 * A scene layer package: the ZIP central directory is read from the file's tail (Rust, analysis
 * worker); each resource is then one byte range of the file. `run(op, data)` runs a job on the
 * analysis worker (app.pool.run).
 */
export class SlpkStore {
  constructor(file, entries, prefix = '') {
    this.file = file;
    this.name = file.name;
    this.prefix = prefix;
    this.entries = entries;
    // name without its extensions (.json.gz, .bin.gz, .jpg, .bin.dds.gz …) → entries.
    this.byBase = new Map();
    for (const e of entries) {
      const k = e.name.toLowerCase();
      const base = k.replace(/\.(bin\.dds|bin\.ktx2|json|bin|jpg|jpeg|png|ktx2|ktx|dds)(\.gz)?$/, '');
      if (!this.byBase.has(base)) this.byBase.set(base, []);
      this.byBase.get(base).push(e);
    }
  }

  static async open(file, run, { maxDirectory = 512 * 2 ** 20 } = {}) {
    const len = file.size;
    if (len < 22) throw gwError('{file} is not a scene layer package (too short for a ZIP archive)', { file: file.name }, 'E_SLPK_NOT_ZIP');
    const tailLen = Math.min(len, 2 ** 20);
    const tail = new Uint8Array(await file.slice(len - tailLen, len).arrayBuffer());
    const end = await run('i3s.slpkEnd', { tail, length: len });
    if (end.cdSize > maxDirectory) throw gwError('{file}: the archive directory is {mb} MB, more than this build reads', { file: file.name, mb: Math.round(end.cdSize / 2 ** 20) }, 'E_SLPK_DIRECTORY');
    const cd = end.cdOffset >= len - tailLen ? tail.slice(end.cdOffset - (len - tailLen), end.cdOffset - (len - tailLen) + end.cdSize) : new Uint8Array(await file.slice(end.cdOffset, end.cdOffset + end.cdSize).arrayBuffer());
    const entries = await run('i3s.slpkDir', { cd });
    return new SlpkStore(file, entries);
  }

  /** The same package seen from a sublayer folder (Building scene layers). */
  sub(prefix) {
    const s = Object.create(SlpkStore.prototype);
    Object.assign(s, this, { prefix });
    return s;
  }

  find(path) {
    return this.byBase.get(`${this.prefix}${path}`.toLowerCase()) ?? [];
  }

  async read(e) {
    // Local header (30 bytes, its name and extra field), then the data: one range when the
    // header's lengths match the central directory's, which is the usual case.
    const guess = 30 + new TextEncoder().encode(e.name).length + 64;
    let head = new Uint8Array(await this.file.slice(e.offset, e.offset + guess + e.csize).arrayBuffer());
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || dv.getUint32(0, true) !== 0x04034b50) throw gwError('{file}: the entry {entry} is damaged', { file: this.name, entry: e.name }, 'E_SLPK_ENTRY');
    const start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
    if (start + e.csize > head.length) head = new Uint8Array(await this.file.slice(e.offset, e.offset + start + e.csize).arrayBuffer());
    const data = head.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateSync(data);
    throw gwError('{file}: the entry {entry} uses ZIP compression method {method}, which is not read', { file: this.name, entry: e.name, method: e.method }, 'E_SLPK_METHOD');
  }

  async bytes(path) {
    const e = this.find(path)[0];
    if (!e) throw gwError('{file} has no {entry}', { file: this.name, entry: path }, 'E_SLPK_MISSING');
    return this.read(e);
  }

  async layerDocument() {
    if (!this.find('3dSceneLayer').length) throw gwError('{file} is not a scene layer package (no 3dSceneLayer.json)', { file: this.name }, 'E_SLPK_NO_LAYER');
    return jsonOf(await this.bytes('3dSceneLayer'));
  }

  async nodePage(p) {
    return jsonOf(await this.bytes(`nodepages/${p}`));
  }

  /** Geometry buffer `b` of node resource `r`: bytes, gzip-compressed or not. */
  async geometry(r, b) {
    return this.bytes(`nodes/${r}/geometries/${b}`);
  }

  async attribute(r, key) {
    const u = await this.bytes(`nodes/${r}/attributes/${key}/0`);
    return isGz(u) ? gunzipSync(u) : u;
  }

  /** Texture `name` of node resource `r` → bytes (gzip removed). */
  async texture(r, name) {
    const u = await this.bytes(`nodes/${r}/textures/${name}`);
    return isGz(u) ? gunzipSync(u) : u;
  }

  /** Building scene layers: the sublayers' folders that hold a layer document. */
  hasSublayer(id) {
    return this.byBase.has(`sublayers/${id}/3dscenelayer`);
  }
}

/**
 * An I3S scene service layer (REST): `layerUrl` = …/SceneServer/layers/<id>; `fetch` is the
 * logged, allow-listed fetch of the app (connectors fetch nothing themselves).
 */
export class ServiceStore {
  constructor(layerUrl, fetch) {
    this.base = String(layerUrl).replace(/[?#].*$/, '').replace(/\/+$/, '');
    this.name = this.base.split('/').slice(-3).join('/');
    this.fetch = fetch;
  }
  async get(path, json = false) {
    const url = `${this.base}${path ? `/${path}` : ''}${json ? '?f=json' : ''}`;
    const r = await this.fetch(url, { credentials: 'omit' });
    if (!r.ok) throw gwError('{url}: HTTP {status}', { url, status: r.status }, 'E_I3S_HTTP');
    return new Uint8Array(await r.arrayBuffer());
  }
  sub(prefix) {
    return new ServiceStore(`${this.base}/${prefix.replace(/\/$/, '')}`, this.fetch);
  }
  async layerDocument() {
    const j = jsonOf(await this.get('', true));
    if (j?.error) throw gwError('{url}: {msg}', { url: this.base, msg: String(j.error.message ?? j.error) }, 'E_I3S_SERVICE');
    return j;
  }
  async nodePage(p) {
    return jsonOf(await this.get(`nodepages/${p}`));
  }
  async geometry(r, b) {
    return this.get(`nodes/${r}/geometries/${b}`);
  }
  async attribute(r, key) {
    const u = await this.get(`nodes/${r}/attributes/${key}/0`);
    return isGz(u) ? gunzipSync(u) : u;
  }
  async texture(r, name) {
    const u = await this.get(`nodes/${r}/textures/${name}`);
    return isGz(u) ? gunzipSync(u) : u;
  }
  hasSublayer() {
    return true;
  }
}

/** True when the vertical CRS is gravity-related (heights above the geoid). */
export function gravityHeights(doc) {
  const hm = doc.heightModelInfo?.heightModel;
  if (hm === 'gravity_related_height' || hm === 'orthometric') return true;
  if (hm === 'ellipsoidal') return false;
  const v = doc.spatialReference?.latestVcsWkid ?? doc.spatialReference?.vcsWkid;
  return !!v && v !== 115700 && v !== 4979;
}

/**
 * The layer's description, with refusals by name: {layerType, name, version, wkid, global,
 * toLonLat (local layers), gravity, nodePages {nodesPerPage, rootIndex}, geometry (the buffer
 * chosen: {index, layout} or {index, draco}), textures (per textureSetDefinition the format
 * picked), materials, attributes, fields, extent, sublayers (Building)}.
 */
export function describeLayer(doc, name = '') {
  if (!doc || typeof doc !== 'object' || !doc.layerType) throw gwError('{file} is not an I3S scene layer', { file: name }, 'E_NOT_I3S');
  const type = doc.layerType;
  const out = { layerType: type, name: doc.name ?? doc.alias ?? name, version: doc.store?.version ?? doc.version ?? '', doc };
  if (type === 'PointCloud') throw gwError('{file}: I3S point cloud scene layers (PCSL, LEPCC-compressed points) are not read', { file: name }, 'E_I3S_POINTCLOUD');
  if (type === 'Building') {
    const subs = [];
    const walk = (list, path) => {
      for (const s of list ?? []) {
        if (s.layerType === 'group') walk(s.sublayers, [...path, s.name]);
        else if (s.layerType === '3DObject' && !s.isEmpty) subs.push({ id: s.id, name: s.name ?? s.alias ?? String(s.id), group: path.join(' / '), visible: s.visibility !== false, modelName: s.modelName });
        else if (s.layerType === 'Point') subs.push({ id: s.id, name: s.name ?? String(s.id), group: path.join(' / '), visible: false, point: true });
      }
    };
    walk(doc.sublayers, []);
    return { ...out, sublayers: subs };
  }
  if (!['3DObject', 'IntegratedMesh', 'Point'].includes(type)) throw gwError('{file}: I3S {type} layers are not read', { file: name, type }, 'E_I3S_TYPE');
  const np = type === 'Point' ? (doc.pointNodePages ?? doc.nodePages) : doc.nodePages;
  if (!np?.nodesPerPage) throw gwError('{file}: this scene layer has no node pages (I3S 1.6 or older); Esri’s i3s_converter (-u) upgrades it to 1.9', { file: name }, 'E_I3S_NO_NODEPAGES');
  if (np.lodSelectionMetricType && np.lodSelectionMetricType !== 'maxScreenThresholdSQ') throw gwError('{file}: the LOD metric {metric} is not read', { file: name, metric: np.lodSelectionMetricType }, 'E_I3S_LOD_METRIC');
  const sr = doc.spatialReference ?? {};
  const wkid = sr.latestWkid ?? sr.wkid ?? 4326;
  let toLonLat = null;
  if (wkid !== 4326) {
    const crs = crsOf({ epsg: wkid, wkt: sr.wkt ?? null });
    if (!crs) throw gwError('{file}: the layer’s CRS (EPSG:{epsg}) is not known to this build', { file: name, epsg: wkid }, 'E_I3S_CRS');
    const c = converter(crs);
    toLonLat = (x, y) => c.toLonLat(x, y);
  }
  // Geometry: the uncompressed buffer of definition 0 where there is one, else its Draco buffer.
  const defs = type === 'Point' ? (doc.geometryDefinitions ?? (doc.geometryDefinition ? [doc.geometryDefinition] : [])) : (doc.geometryDefinitions ?? []);
  const geometry = defs.map((d) => {
    const bufs = d.geometryBuffers ?? [];
    const plain = bufs.findIndex((b) => !b.compressedAttributes && b.position);
    if (plain >= 0) return { index: plain, layout: bufs[plain] };
    const draco = bufs.findIndex((b) => b.compressedAttributes?.encoding === 'draco');
    if (draco >= 0) return { index: draco, draco: bufs[draco].compressedAttributes.attributes ?? [] };
    return null;
  });
  if (!geometry.some(Boolean)) throw gwError('{file}: no geometry buffer this build reads (uncompressed or Draco)', { file: name }, 'E_I3S_GEOMETRY_KIND');
  // Textures: per texture set, the format to fetch (JPEG/PNG first; KTX2 when that is all).
  const textures = (doc.textureSetDefinitions ?? []).map((ts) => {
    const f = ts.formats ?? [];
    const pick = f.find((x) => x.format === 'jpg' || x.format === 'png') ?? f.find((x) => x.format === 'ktx2') ?? null;
    return { pick, atlas: !!ts.atlas, formats: f.map((x) => x.format) };
  });
  return {
    ...out,
    wkid,
    global: wkid === 4326,
    toLonLat,
    gravity: gravityHeights(doc),
    nodePages: { nodesPerPage: np.nodesPerPage, rootIndex: np.rootIndex ?? 0 },
    geometry,
    textures,
    materials: doc.materialDefinitions ?? [],
    attributes: doc.attributeStorageInfo ?? [],
    fields: doc.fields ?? [],
    extent: doc.fullExtent ? [doc.fullExtent.xmin, doc.fullExtent.ymin, doc.fullExtent.xmax, doc.fullExtent.ymax] : (doc.store?.extent ?? null),
    elevationMode: doc.elevationInfo?.mode ?? null,
    pointColour: doc.drawingInfo?.renderer?.symbol?.symbolLayers?.[0]?.material?.color ?? null,
  };
}

/**
 * The node tree, loaded a page at a time: node(i) → the node record ({index, obb, lodThreshold,
 * children, mesh, parentIndex}) or null.
 */
export class NodeTree {
  constructor(store, info, { maxPages = 100000 } = {}) {
    this.store = store;
    this.info = info;
    this.pages = new Map();
    this.maxPages = maxPages;
  }
  async node(i) {
    const per = this.info.nodePages.nodesPerPage;
    const p = Math.floor(i / per);
    if (!this.pages.has(p)) {
      if (this.pages.size >= this.maxPages) return null;
      const pr = this.store.nodePage(p).then((j) => j.nodes ?? []);
      this.pages.set(p, pr);
      pr.catch(() => this.pages.delete(p));
    }
    const nodes = await this.pages.get(p);
    return nodes[i - p * per]?.index === i ? nodes[i - p * per] : (nodes.find((n) => n.index === i) ?? null);
  }
  /** Every node (all pages), for counts and tests. */
  async all(limit = 1e6) {
    const out = [];
    const queue = [this.info.nodePages.rootIndex];
    while (queue.length && out.length < limit) {
      const n = await this.node(queue.shift());
      if (!n) continue;
      out.push(n);
      if (n.children?.length) queue.push(...n.children);
    }
    return out;
  }
}

/**
 * Node positions to longitude, latitude and height above the ellipsoid: geo(node, pos) → a
 * Float64Array [lon, lat, h, …]. `undulation(lat, lon)` gives N (gravity-related layers).
 */
export function nodeGeo(info, node, pos, undulation = () => 0) {
  const c = node.obb?.center ?? node.mbs ?? [0, 0, 0];
  const n = pos.length / 3;
  const out = new Float64Array(pos.length);
  const N = info.gravity ? undulation(info.global ? c[1] : 0, info.global ? c[0] : 0) : 0;
  let Nc = N;
  if (!info.global && info.gravity) {
    const [lon, lat] = info.toLonLat(c[0], c[1]);
    Nc = undulation(lat, lon);
  }
  for (let v = 0; v < n; v++) {
    const x = c[0] + pos[3 * v];
    const y = c[1] + pos[3 * v + 1];
    const z = c[2] + pos[3 * v + 2];
    if (info.global) {
      out[3 * v] = x;
      out[3 * v + 1] = y;
    } else {
      const [lon, lat] = info.toLonLat(x, y);
      out[3 * v] = lon;
      out[3 * v + 1] = lat;
    }
    out[3 * v + 2] = z + Nc;
  }
  return out;
}

/** The node's bounding sphere: {lon, lat, h, r} (r in metres for a global layer). */
export function nodeSphere(info, node) {
  const c = node.obb?.center ?? node.mbs;
  if (!c) return null;
  const r = node.obb?.halfSize ? Math.hypot(...node.obb.halfSize) : (node.mbs?.[3] ?? 0);
  if (info.global) return { lon: c[0], lat: c[1], h: c[2], r };
  const [lon, lat] = info.toLonLat(c[0], c[1]);
  return { lon, lat, h: c[2], r };
}

/**
 * Decode a node's geometry → {kind, vertexCount, geo (Float64Array lon/lat/h), normal, uv0,
 * color, uvRegion, featureOf (Uint32Array per vertex: the feature's position in the node),
 * featureIds, indices}. `decode` = {plain(bytes, layout), draco(bytes)} (worker calls).
 */
export async function nodeGeometry(store, info, node, decode, undulation) {
  const m = node.mesh?.geometry;
  if (!m) return null;
  const def = info.geometry[m.definition ?? 0];
  if (!def) throw gwError('{file}: node {node} uses geometry definition {def}, which the layer does not describe', { file: store.name, node: node.index, def: m.definition ?? 0 }, 'E_I3S_GEOMETRY_DEF');
  const resource = m.resource ?? node.resourceId ?? node.index;
  const bytes = await store.geometry(resource, def.index);
  if (def.layout) {
    const g = await decode.plain(bytes, def.layout);
    const featureOf = new Uint32Array(g.vertexCount);
    if (g.faceRange)
      for (let f = 0; f < g.featureCount; f++) {
        const a = g.faceRange[2 * f];
        const b = g.faceRange[2 * f + 1];
        featureOf.fill(f, 3 * a, 3 * b + 3);
      }
    return { kind: 'mesh', vertexCount: g.vertexCount, geo: nodeGeo(info, node, g.position, undulation), normal: g.normal, uv0: g.uv0, color: g.color, uvRegion: g.uvRegion, featureOf, featureIds: g.featureId, indices: null, resource };
  }
  const d = await decode.draco(bytes);
  return { kind: info.layerType === 'Point' ? 'points' : d.kind, vertexCount: d.vertexCount, geo: nodeGeo(info, node, d.position, undulation), normal: d.normal, uv0: d.uv0, color: d.color, uvRegion: d.uvRegion, featureOf: d.featureIndex, featureIds: d.featureIds, indices: d.indices, resource };
}

/** The attribute values of a node's features: {field name: values[]} (the layer's fields that have binary storage). */
export async function nodeAttributes(store, info, node, { fields = null } = {}) {
  const r = node.mesh?.attribute?.resource ?? node.mesh?.geometry?.resource ?? node.index;
  const out = {};
  for (const s of info.attributes) {
    if (fields && !fields.includes(s.name)) continue;
    try {
      const u = await store.attribute(r, s.key);
      out[s.name] = decodeAttribute(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength), s);
    } catch (e) {
      if (e?.code !== 'E_SLPK_MISSING') throw e;
    }
  }
  return out;
}

/** The texture of a node's material, if the layer has one this build decodes → {bytes, format} or null (with `why`). */
export async function nodeTexture(store, info, node) {
  const mm = node.mesh?.material;
  if (!mm || mm.resource == null || mm.resource < 0) return null;
  const mat = info.materials[mm.definition ?? 0];
  const tsId = mat?.pbrMetallicRoughness?.baseColorTexture?.textureSetDefinitionId;
  if (tsId == null) return null;
  const ts = info.textures[tsId];
  if (!ts?.pick) return { bytes: null, format: null, why: ts ? ts.formats.join(', ') : 'none' };
  return { bytes: await store.texture(mm.resource, ts.pick.name), format: ts.pick.format, atlas: ts.atlas };
}
