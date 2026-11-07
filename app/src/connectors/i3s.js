// I3S scene layers, read side (REQ-GAP-05; OGC Community Standard I3S 1.7–1.9): the layer
// document, its node pages, and for 3DObject layers the uncompressed geometry buffer and the
// binary attribute resources of leaf nodes. Each feature becomes a footprint (the convex hull of
// its vertices) with its base and top heights, so buildings from a scene service can be measured
// and compared over imagery. Draco-only geometry, textures and Point/PointCloud/IntegratedMesh
// content are not decoded; those layers give node extents only. No fetching here (REQ-SEC-12).

import { gwError } from '../i18n/index.js';

const SIZE = { UInt8: 1, Int8: 1, UInt16: 2, Int16: 2, UInt32: 4, Int32: 4, UInt64: 8, Int64: 8, Float32: 4, Float64: 8 };

/** The scene layer URL of a SceneServer URL (…/SceneServer → …/SceneServer/layers/0). */
export function sceneLayerUrl(url, id = 0) {
  const u = String(url).replace(/[?#].*$/, '').replace(/\/+$/, '');
  return /\/layers\/\d+$/.test(u) ? u : `${u}/layers/${id}`;
}

/** Summary of a scene layer document: {layerType, version, wkid, extent, nodesPerPage, fields, attributes, geometry}. */
export function sceneLayerInfo(j) {
  if (!j || !j.layerType) throw gwError('not an I3S scene layer document', null, 'E_NOT_I3S');
  const sr = j.spatialReference ?? {};
  const defs = j.geometryDefinitions ?? [];
  // The first geometry buffer of each definition that is not Draco-compressed.
  const plain = defs.map((d) => {
    const i = (d.geometryBuffers ?? []).findIndex((b) => !b.compressedAttributes);
    return i < 0 ? null : { index: i, layout: d.geometryBuffers[i] };
  });
  return {
    layerType: j.layerType,
    name: j.name ?? j.alias ?? '',
    version: j.version ?? '',
    wkid: sr.latestWkid ?? sr.wkid ?? 4326,
    extent: j.fullExtent ? [j.fullExtent.xmin, j.fullExtent.ymin, j.fullExtent.xmax, j.fullExtent.ymax] : j.store?.extent ?? null,
    z: j.fullExtent ? [j.fullExtent.zmin, j.fullExtent.zmax] : null,
    nodesPerPage: j.nodePages?.nodesPerPage ?? null,
    rootIndex: j.nodePages?.rootIndex ?? 0,
    fields: (j.fields ?? []).map((f) => ({ name: f.name, type: f.type, alias: f.alias })),
    attributes: j.attributeStorageInfo ?? [],
    plain,
  };
}

/**
 * Walk the node pages: getJson(url) → JSON. Returns the nodes (index, obb, children, lodThreshold,
 * mesh) up to `maxNodes`, and the leaves among them.
 */
export async function readNodePages(getJson, layerUrl, info, { maxNodes = 20000, signal = null } = {}) {
  if (!info.nodesPerPage) throw gwError('this scene layer has no node pages (I3S 1.6 or older), which GIS Workbench does not read', null, 'E_I3S_NO_NODEPAGES');
  const nodes = [];
  for (let p = 0; nodes.length < maxNodes; p++) {
    if (signal?.aborted) throw gwError('the request was cancelled', null, 'E_CANCELLED');
    const j = await getJson(`${layerUrl}/nodepages/${p}`);
    const page = j.nodes ?? [];
    nodes.push(...page);
    if (page.length < info.nodesPerPage) break;
  }
  const leaves = nodes.filter((n) => !n.children?.length && n.mesh);
  return { nodes: nodes.slice(0, maxNodes), leaves };
}

/**
 * The leaf nodes inside a lon/lat box, found top-down from the root: only the node pages holding a
 * node whose box meets the area are read. → {nodes (visited), leaves, pages (read)}.
 */
export async function nodesIn(getJson, layerUrl, info, box, { maxLeaves = 64, maxPages = 400, signal = null } = {}) {
  if (!info.nodesPerPage) throw gwError('this scene layer has no node pages (I3S 1.6 or older), which GIS Workbench does not read', null, 'E_I3S_NO_NODEPAGES');
  const pages = new Map();
  const node = async (i) => {
    const p = Math.floor(i / info.nodesPerPage);
    if (!pages.has(p)) {
      if (pages.size >= maxPages) return null;
      if (signal?.aborted) throw gwError('the request was cancelled', null, 'E_CANCELLED');
      pages.set(p, (await getJson(`${layerUrl}/nodepages/${p}`)).nodes ?? []);
    }
    return pages.get(p).find((n) => n.index === i) ?? pages.get(p)[i % info.nodesPerPage] ?? null;
  };
  const meets = (n) => {
    const b = nodeBox(n, info.wkid);
    return !b || !box || (b[0] <= box[2] && box[0] <= b[2] && b[1] <= box[3] && box[1] <= b[3]);
  };
  const visited = [];
  const leaves = [];
  const queue = [info.rootIndex ?? 0];
  while (queue.length && leaves.length < maxLeaves) {
    const n = await node(queue.shift());
    if (!n || !meets(n)) continue;
    visited.push(n);
    if (n.children?.length) queue.push(...n.children);
    else if (n.mesh) leaves.push(n);
  }
  return { nodes: visited, leaves, pages: pages.size };
}

/** A node's centre and horizontal half-size as a lon/lat box (approximate for rotated boxes). */
export function nodeBox(n, wkid = 4326) {
  const c = n.obb?.center;
  const hs = n.obb?.halfSize;
  if (!c || !hs) return null;
  const r = Math.hypot(hs[0], hs[1]);
  if (wkid !== 4326) return [c[0] - r, c[1] - r, c[0] + r, c[1] + r];
  const dLat = r / 111320;
  const dLon = r / (111320 * Math.max(0.05, Math.cos((c[1] * Math.PI) / 180)));
  return [c[0] - dLon, c[1] - dLat, c[0] + dLon, c[1] + dLat];
}

/**
 * Decode an uncompressed I3S geometry buffer (header vertexCount, featureCount; then position,
 * normal, uv0, color, uvRegion per vertex and featureId, faceRange per feature, in that order).
 * Returns {vertexCount, featureCount, position: Float32Array, featureId: number[], faceRange: Uint32Array}.
 */
export function decodeGeometry(buf, layout) {
  const dv = new DataView(buf);
  const vertexCount = dv.getUint32(0, true);
  const featureCount = dv.getUint32(4, true);
  let off = layout.offset ?? 8;
  const out = { vertexCount, featureCount, position: null, featureId: [], faceRange: null };
  const take = (desc, count) => {
    const bytes = SIZE[desc.type] * desc.component * count;
    if (off + bytes > buf.byteLength) throw gwError('I3S geometry buffer is shorter than its layout', null, 'E_I3S_GEOMETRY');
    const at = off;
    off += bytes;
    return at;
  };
  for (const k of ['position', 'normal', 'uv0', 'color', 'uvRegion']) {
    const d = layout[k];
    if (!d) continue;
    const at = take(d, vertexCount);
    if (k === 'position') out.position = new Float32Array(buf.slice(at, at + vertexCount * 12));
  }
  for (const k of ['featureId', 'faceRange']) {
    const d = layout[k];
    if (!d) continue;
    const at = take(d, featureCount);
    if (k === 'featureId') for (let i = 0; i < featureCount; i++) out.featureId.push(d.type === 'UInt64' ? dv.getUint32(at + 8 * i, true) + dv.getUint32(at + 8 * i + 4, true) * 2 ** 32 : dv.getUint32(at + 4 * i, true));
    else out.faceRange = new Uint32Array(buf.slice(at, at + featureCount * 8));
  }
  return out;
}

/** Decode one binary attribute resource (attributeStorageInfo entry) → an array of values. */
export function decodeAttribute(buf, storage) {
  const dv = new DataView(buf);
  let off = 0;
  const head = {};
  for (const h of storage.header ?? []) {
    head[h.property] = dv.getUint32(off, true);
    off += SIZE[h.valueType] ?? 4;
  }
  const count = head.count ?? 0;
  let vals = storage.attributeValues ?? {};
  const order = storage.ordering ?? ['attributeValues'];
  let lens = null;
  const out = [];
  for (const o of order) {
    if (o === 'attributeByteCounts') {
      lens = [];
      for (let i = 0; i < count; i++) lens.push(dv.getUint32(off + 4 * i, true));
      off += 4 * count;
    } else if (o === 'ObjectIds' || o === 'objectIds') off += 4 * count;
    else if (o === 'attributeValues') {
      if (vals.valueType === 'String') {
        const dec = new TextDecoder();
        for (let i = 0; i < count; i++) {
          const n = lens?.[i] ?? 0;
          let s = dec.decode(new Uint8Array(buf, off, n));
          if (s.endsWith('\0')) s = s.slice(0, -1);
          out.push(s);
          off += n;
        }
      } else {
        // Object ids (esriFieldTypeOID) are stored as Oid32 / Oid64: unsigned integers (2.5 fix: were NaN).
        const vt = vals.valueType === 'Oid32' ? 'UInt32' : vals.valueType === 'Oid64' ? 'UInt64' : vals.valueType;
        vals = { ...vals, valueType: vt };
        const sz = SIZE[vals.valueType] ?? 4;
        if (sz === 8 && off % 8) off += 8 - (off % 8); // 8-byte values are aligned
        for (let i = 0; i < count; i++, off += sz) {
          const v = vals.valueType === 'Float64' ? dv.getFloat64(off, true) : vals.valueType === 'Float32' ? dv.getFloat32(off, true) : vals.valueType === 'Int32' ? dv.getInt32(off, true) : vals.valueType === 'UInt32' ? dv.getUint32(off, true) : vals.valueType === 'Int16' ? dv.getInt16(off, true) : vals.valueType === 'UInt16' ? dv.getUint16(off, true) : vals.valueType === 'Int8' ? dv.getInt8(off) : vals.valueType === 'UInt8' ? dv.getUint8(off) : vals.valueType === 'UInt64' || vals.valueType === 'Int64' ? dv.getUint32(off, true) + dv.getUint32(off + 4, true) * 2 ** 32 : NaN;
          out.push(v);
        }
      }
    }
  }
  return out;
}

const hull = (pts) => {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop();
    lo.push(q);
  }
  const up = [];
  for (const q of p.reverse()) {
    while (up.length >= 2 && cross(up.at(-2), up.at(-1), q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
};

/**
 * The features of one decoded node: [{featureId, ring (lon/lat, counter-clockwise, closed), zmin,
 * zmax}]. Vertex positions are offsets from the node's OBB centre (degrees for x and y and
 * metres for z in a geographic layer; CRS units otherwise).
 */
export function nodeFeatures(node, geom) {
  const c = node.obb?.center ?? [0, 0, 0];
  const pos = geom.position;
  if (!pos) return [];
  const feats = [];
  const n = geom.featureCount || 1;
  for (let f = 0; f < n; f++) {
    const [a, b] = geom.faceRange ? [geom.faceRange[2 * f], geom.faceRange[2 * f + 1]] : [0, geom.vertexCount / 3 - 1];
    const pts = [];
    let zmin = Infinity;
    let zmax = -Infinity;
    for (let v = 3 * a; v <= 3 * b + 2 && v < geom.vertexCount; v++) {
      const x = c[0] + pos[3 * v];
      const y = c[1] + pos[3 * v + 1];
      const z = c[2] + pos[3 * v + 2];
      pts.push([x, y]);
      if (z < zmin) zmin = z;
      if (z > zmax) zmax = z;
    }
    const h = hull(pts);
    if (h.length < 3) continue;
    feats.push({ featureId: geom.featureId[f] ?? f, ring: [...h, h[0]], zmin, zmax });
  }
  return feats;
}
